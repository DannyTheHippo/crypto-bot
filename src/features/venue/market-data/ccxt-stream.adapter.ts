import { Injectable, Inject } from '@nestjs/common';
import {
  pro as ccxtPro,
  Exchange,
  type Ticker,
  type Trade,
  type OHLCV,
  type OrderBook,
} from 'ccxt';
import type {
  ExchangeStreamPort,
  RawVenueEvent,
  RawUserEvent,
} from '../../../ports/venue/exchange-stream';
import type { SubscriptionSpec } from '../../../ports/venue/market-data';
import type { VenueId, SymbolId, EpochMs } from '../../../domain/common/types/ids';
import { epochMs } from '../../../domain/common/types/ids';
import type { ClockPort } from '../../../ports/common/clock';
import { CLOCK } from '../../../ports/common/clock';
import type { VenueConfig } from '../../../ports/common/app-config';
import type { ChannelHealth } from '../../../domain/venue/types/market-events';

// Staleness threshold before a stream is marked DEGRADED
const STALE_THRESHOLD_MS = 30_000;

// Watchdog: ccxt pro watch* futures resolve only when the venue pushes a message for that
// subscription — a server-side subscription silently dropped leaves the future pending FOREVER,
// which the supervised loops cannot see (they only act when the promise settles). Observed live
// 2026-07-16 16:00Z: all five spot candle channels went silent for 8h while the ticker channel on
// the same process kept flowing — no error, no log, no recovery. The only client-side lever that
// forces a resubscribe is closing the connection: close() rejects every pending watch future, and
// the supervised loops then re-watch (fresh subscription) through their normal error path.
// PINNED ccxt 4.5.58 caveat (observed live 2026-07-19, spot lane, after a ~10h host sleep): close()
// does not always leave a resubscribable instance. Under some conditions — here, close() racing
// venue-side dead sockets after a long OS sleep — the instance enters a TERMINAL closed-by-user
// state: every subsequent watch* call on it throws ExchangeClosedByUser forever, no matter how many
// times the loop re-watches. The 2026-07-16 assumption above ("re-watch through the normal error
// path" recovers it) is FALSIFIED for this state; a plain re-watch can never clear it. Recovery
// requires discarding the wedged instance and swapping in a freshly constructed one — see
// exchangeFactory / recreateExchange() below, wired from handleLoopError's ExchangeClosedByUser
// branch, not from the watchdog (the watchdog still only ever closes; see watchdogTick's comment).
// v2 (live escalation, 2026-07-19 same-day): the v1 recreation seam above shipped with NO gate of
// its own. Deployed into a venue penalty phase (persistent stalls/1008s), the watchdog kept firing
// close() on ITS OWN 120s cooldown, each close() minted a fresh round of ExchangeClosedByUser on
// every active watch call, and each of those triggered an (ungated) recreation — 36 recreations in
// ~35 minutes — until the spot lane hit "FATAL ERROR: Reached heap limit … JavaScript heap out of
// memory" at ~13:51Z and Docker restarted it. Two independent defects, both fixed below:
//   (1) no backoff on the RECREATION decision itself — every wedge, however frequent, recreated
//       immediately. Fixed by RecreationPolicy: an escalating cooldown (armed after every
//       successful recreation, doubling while wedges keep recurring, capped, reset after a
//       sustained healthy period) plus a hard cap on recreations per rolling window — see
//       DEFAULT_RECREATION_POLICY and doRecreateExchange().
//   (2) the stale instance was only ever best-effort close()'d, never hard-disposed. A wedged
//       instance's close() can itself reject or hang while its ws clients still hold a live socket
//       plus pingInterval/connectionTimer Node timers — those timers keep the client (and
//       everything it closes over) reachable from Node's timer list regardless of whether anything
//       else still references the stale exchange. 36 undisposed instances accumulating over 35
//       minutes is precisely the leak that exhausted the heap. Fixed by hardDisposeExchange()
//       below, which reaches past the public API into ccxt 4.5.58's internals (js/src/base/
//       Exchange.js `clients` map; js/src/base/ws/Client.js `clearConnectionTimeout`/
//       `clearPingInterval`; js/src/base/ws/WsClient.js `connection` — the underlying Node `ws`
//       socket) to force-clear the timers and terminate() the socket. Re-verify this reach-through
//       if the pinned ccxt version is ever bumped.
// Blast radius: exchange.close() is CONNECTION-WIDE (ccxt has no per-channel close) — one stalled
// channel forces every channel, healthy ones included, through the reject/re-watch cycle,
// repeating each cooldown until recovery; a persistent unrecoverable stall therefore degrades
// healthy channels too (the MarketStreamReconnectStorm alert is the human pull for that case).
// Coverage: every channel this adapter watches (ticker, trade, book, candle:*) is included — book
// was excluded until the 2026-07-17 review found the RiskEngine gates entries on 'book' channel
// health specifically (risk-engine.service.ts) with no other client-side recovery for a silently
// dead book subscription. Thresholds: all four channel types push every ~1-2s or faster on the
// liquid symbols this bot trades (book/trade updates are typically sub-second), so 180s of silence
// is ~90× the expected cadence — decisive for a dead subscription while cheap when wrong (a forced
// reconnect is a seconds-long data blip, bounded by the cooldown).
const WATCHDOG_CHECK_MS = 30_000;
const WATCHDOG_STALL_THRESHOLD_MS = 180_000;
// v3 soak finding (2026-07-21, first hours of the one-book demo boot): the demo venue's kline
// streams are TRADE-DRIVEN on thin symbols — APT/WIF/DOT/NEAR/OP spot candles sat 150-307s silent
// while their tickers stayed fresh and liquid symbols' candles ticked normally (the #54 lesson:
// probe the venue actually traded, not the documented prod shape). Under the single 180s threshold
// every such quiet spell read as a dead subscription and forced a CONNECTION-WIDE close(), whose
// resubscribe herd then tripped the demo ws inbound rate limit (1008) — a self-sustaining ~3.5-min
// storm cycle (269 loop errors/20 min observed live) that v2 never hit only because its perp lane
// carried 8 liquid symbols, not v3's 16-with-thin-tail. Candle channels therefore get a
// cadence-matched threshold: a full 15m bar of silence plus 5 min margin — a genuinely dead candle
// subscription (the 2026-07-16 8.2h stall class) is still caught in 20 min, while a thin symbol's
// quiet bar can never initiate the storm. This corrects a false premise for ONE channel type;
// book/ticker/trades keep the original 180s (their sub-second cadence assumption held on the live
// venue), so real stall detection is not weakened.
const WATCHDOG_CANDLE_STALL_THRESHOLD_MS = 1_200_000;
// Re-examined for the v2 escalation (see the header comment): CONFIRMED already global, not
// per-channel-group. watchdogTick() reads/writes ONE `lastForcedReconnectAt` field on the adapter
// and calls exchange.close() at most once per tick, after building a single `stalled` list across
// every (symbol,channel) key in `lastYieldAt` — there is no per-group cooldown state to fragment.
// The v2 recreation cooldown below is therefore the sole knob that needed to change; this constant
// and watchdogTick() are UNCHANGED (never weaken existing pacing/watchdog thresholds).
const WATCHDOG_RECONNECT_COOLDOWN_MS = 120_000;
// LIVE INCIDENT 2026-08-06: exchange.close() is a no-op on a never-connected instance (Exchange.js's
// `clients` map is empty, so close() has nothing to iterate and mints no ExchangeClosedByUser) — 222
// watchdog fires against a markets-wedged instance (see the pinned-ccxt-4.5.58 header comment)
// produced zero recreations, because the watchdog's only lever was close() and close() on THIS wedge
// class does nothing at all. After this many consecutive forced-reconnect ticks that still find the
// same channels stalled (i.e. the prior close()/reload attempts yielded no data), the watchdog
// escalates straight to instance recreation instead of repeating an inert close(). Small on purpose:
// each unit costs one WATCHDOG_RECONNECT_COOLDOWN_MS (120s) cycle, so 3 is ~6 minutes of confirmed
// silence before swapping the instance — long enough to rule out a slow-but-alive resubscribe,
// short enough to not repeat the 2026-08-06 6.25h wedge three more times over.
const WATCHDOG_ZERO_YIELD_ESCALATION_THRESHOLD = 3;

// (Re)subscribe pacing: Binance closes a WS connection receiving >5 inbound messages/second with
// code 1008 (policy violation). Every supervised loop (re)subscribes through one exchange, and an
// exchange.close() — watchdog-forced or venue-initiated — rejects ALL pending watch futures at
// once: with a fixed, shared backoff the herd re-SUBSCRIBEs in lockstep, trips the limit, gets
// 1008-closed, and repeats forever (observed live 2026-07-17: at 8 symbols × 4 channels every
// candle re-watch 1008-looped indefinitely while a lone subscription recovered in ~2s — the 5→8
// universe expansion crossed the cliff; boot-time initial subscription bursts the same way).
// A single global FIFO queue at 350ms (~2.86msg/s, 43% under the 5/s cliff) fixed the livelock but
// serializes recovery through one gate: M simultaneous drops took M×350ms, so a connection-wide
// drop across the 24-symbol universe (~96 subscriptions at ~4 channels/symbol) pushed the queue
// tail past the RiskEngine's staleMaxAgeMs=5000ms freshness window — a universe-wide STALE_DATA
// entry blackout that gets linearly worse as the universe grows (2026-07-17 CONFIRMED cluster-D-ws
// finding #1). Bounded-concurrency lanes trade queue depth for a still-conservative higher
// aggregate cap: SUBSCRIBE_LANE_COUNT independent paced lanes, each internally spaced
// SUBSCRIBE_LANE_SPACING_MS apart (least-loaded-lane assignment — ties break to the lowest index,
// so up to SUBSCRIBE_LANE_COUNT simultaneous acquirers fan out to distinct lanes before any lane
// repeats), cap the aggregate rate at SUBSCRIBE_LANE_COUNT / SUBSCRIBE_LANE_SPACING_MS = 4/s — 20%
// under the 5/s cliff (down from the single-queue design's 43% margin; a deliberate, bounded trade
// of some safety margin for materially faster recovery). M simultaneous drops now converge in
// ceil(M/SUBSCRIBE_LANE_COUNT) rounds of SUBSCRIBE_LANE_SPACING_MS instead of M rounds of 350ms —
// e.g. a full 96-subscription connection-wide storm drops from ~33.6s to ~24s. Only a loop's first
// watch and the first watch after an error pass the gate — steady-state yields are unpaced.
const SUBSCRIBE_LANE_COUNT = 4;
const SUBSCRIBE_LANE_SPACING_MS = 1000;
// Small randomized top-up added to an already-paced wait (a lane reused inside its own cadence) —
// never to an immediately-free lane, which is a one-off event, not a recurring cadence. The lane
// math above already guarantees the aggregate rate never exceeds
// SUBSCRIBE_LANE_COUNT/SUBSCRIBE_LANE_SPACING_MS, but under real timer slop (setTimeout is a floor,
// not a guarantee) a perfectly exact cadence repeating forever is the same lockstep shape f9b7d56
// fought, just at a lower amplitude — jitter decorrelates it. Only ever ADDS delay on top of the
// computed wait, so the per-lane floor (SUBSCRIBE_LANE_SPACING_MS) is never violated downward.
// Injectable (subscribeJitterFn) so tests can zero it for deterministic timing assertions.
const SUBSCRIBE_JITTER_MAX_MS = 100;
// A supervised loop's error path was fully silent (health-tracker-only) — the 1008 livelock above
// and the 2026-07-16 candle stall were both invisible until probed from outside the process. One
// line per channel per interval keeps a persistent failure observable without a tight error loop
// flooding the log.
const LOOP_ERROR_LOG_INTERVAL_MS = 60_000;

// See hasNoMarkets()/forceReloadMarkets() below and the pinned-ccxt-4.5.58 header comment (LIVE
// INCIDENT 2026-08-06). Single-flighted across every concurrent handleLoopError caller AND
// cooldown-gated on top: with ~90 supervised loops sharing one exchange instance, every one of them
// can land on the wedge in the same beat, and exchangeInfo is weight-20 on binance spot — an
// uncooled reload attempt per wedged loop-error would be a self-inflicted 418 ban, trading one outage
// for a worse one.
const MARKETS_RELOAD_COOLDOWN_MS = 15_000;

// Per-(symbol,channel) retry backoff, replacing the old fixed 1000ms. The fixed delay meant ~90
// loops retried an instantly-rejecting cached promise every second for the full 6.25h of the
// 2026-08-06 wedge — loud in log volume, silent in meaning (every line said the same thing). Doubling
// from a 1s base, capped at 60s, still recovers a genuinely transient blip in one retry (first wait is
// unchanged at 1s) while a channel stuck failing for minutes backs off to a sane ceiling instead of
// hammering the venue at 1/s the whole time. Reset to the base on the channel's next successful yield
// (noteYield) — a recovered channel does not inherit its pre-recovery backoff.
const CHANNEL_BACKOFF_BASE_MS = 1_000;
const CHANNEL_BACKOFF_CAP_MS = 60_000;

/**
 * Governs how often the wedged-instance recreation seam (see the pinned-ccxt-4.5.58 header
 * comment) may fire. Injectable (last constructor param) so tests can shrink it to exercise
 * escalation/cap-exhaustion in milliseconds of simulated time instead of the ~65 real-world minutes
 * DEFAULT_RECREATION_POLICY implies; production always uses the default.
 */
export interface RecreationPolicy {
  /** Cooldown armed after the first recreation of a fresh incident. */
  cooldownInitialMs: number;
  /** Ceiling the escalating cooldown never exceeds. */
  cooldownMaxMs: number;
  /** Escalation factor applied each time a wedge recurs inside the "recent" window below. */
  cooldownMultiplier: number;
  /** A gap at least this long since the last recreation counts as "recovered" — the next wedge
   *  resets to cooldownInitialMs instead of escalating further. Kept STRICTLY ABOVE cooldownMaxMs
   *  so that merely waiting out the worst-case escalated cooldown never itself looks like recovery
   *  (that equality would oscillate: escalate to the ceiling, wait exactly that long, reset,
   *  re-escalate, forever). */
  healthyResetMs: number;
  /** Hard cap on successful recreations inside the rolling capWindowMs. Past it, recreation stops
   *  entirely (plain backoff, level-50 log) regardless of cooldown state — the container
   *  healthcheck/restart-policy is the final rung, never a silent leak. */
  capPerWindow: number;
  capWindowMs: number;
}

// 2026-07-19 live incident (see header comment): 36 recreations in ~35 minutes with no gate at all.
// This schedule's steady-state ceiling (60s → 600s doubling) already self-limits to ~6-8
// recreations/hour once ramped, well under the cap — the cap is a backstop for cases the cooldown
// alone doesn't cover (e.g. repeated fresh incidents each just past healthyResetMs apart), not the
// primary defense; the escalating cooldown is.
const DEFAULT_RECREATION_POLICY: RecreationPolicy = {
  cooldownInitialMs: 60_000, // 60s
  cooldownMaxMs: 600_000, // 10 min
  cooldownMultiplier: 2,
  healthyResetMs: 900_000, // 15 min — strictly > cooldownMaxMs, see the field comment above
  capPerWindow: 10,
  capWindowMs: 3_600_000, // 1h rolling window
};

export interface ChannelStateTracker {
  setHealth(venue: VenueId, symbol: SymbolId, channel: string, health: ChannelHealth): void;
  recordEvent(venue: VenueId, symbol: SymbolId, channel: string): void;
  checkStaleness(venue: VenueId, symbol: SymbolId, channel: string, thresholdMs: number): void;
  // Optional so existing fakes keep compiling; the real FeedHealthService implements it and the
  // metrics pull loop exports it (market_stream_forced_reconnects_total).
  recordForcedReconnect?(): void;
  // XA6: removes a channel's health/age entry entirely — a tier-parked channel (see
  // ChannelTierResolver) must vanish from channelAges()/staleness gauges rather than sit forever as
  // an aging DEGRADED entry that reads like a defect. Optional for the same fake-compat reason.
  clearChannel?(venue: VenueId, symbol: SymbolId, channel: string): void;
}

/** Minimal logger surface so the adapter stays constructible without Nest (tests, factories). */
export interface StreamAdapterLogger {
  warn(message: string): void;
  error(message: string): void;
  // Optional routine-info level (Nest's Logger has it; test fakes may omit it). XA6 tier
  // transitions log here — they are expected daily events, not warnings.
  log?(message: string): void;
}

// ── XA6: per-symbol channel tiering ──────────────────────────────────────────
// The spot lane idled at ~118% CPU / 1.5GiB on ~96 subscriptions (24 symbols × 4 channels), with
// churn events brushing the RiskEngine's 5s staleness veto exactly when re-consults fire (A0,
// 2026-07-20). Only active-menu + positioned symbols can ever be consulted or enter (the batching
// client's ActiveMenuGate and the scanner's position pin guarantee both), so only they need the
// heavy channels: `book` (a risk-mark input — RiskEngineService takes the best of book/ticker
// health, not book alone; the old book-only entry gate was repealed 2026-07-22, see
// risk-engine.service.ts's own header comment and reports/loop/LOG.md) and `trades`
// (paper-sim fills). Every symbol keeps `candles` (strategy warmup + the scanner's OWN ranking
// metrics — deriveScanMetrics reads the streamed 15m window, so rankings populate without any REST
// path) and `ticker` (ref price). The resolver is late-bound (setChannelTierResolver) because the
// scanner lives in the agentic composition layer, which this adapter must not import.
//
// Lifecycle: a gated loop checks the resolver each iteration. While LITE it PARKS — no watch call,
// its watchdog key and health entry are removed (a parked channel must never trip the connection-
// wide forced-reconnect close() or read as a stale-feed defect) — and re-checks every tierPollMs.
// On promotion it re-seeds and re-subscribes through the normal paced gate. On demotion it parks at
// the next yield; the venue-side subscription (ccxt has no per-channel close) lingers only until
// the next connection cycle. Failure direction: this is an EFFICIENCY gate — it fails OPEN to full
// tier (resolver absent, throwing, or scanner not yet ranked ⇒ subscribe everything); a broken
// tier decision must never starve the data path.
export interface ChannelTierResolver {
  /** true ⇒ the symbol gets the full channel set; false ⇒ candles+ticker only. */
  fullChannels(symbol: SymbolId): boolean;
}

/** How often a parked loop re-checks the tier resolver for promotion. */
const TIER_PARK_POLL_MS = 30_000;

/**
 * Injectable abstraction over ccxt's watch* calls.
 * A real implementation delegates to the ccxt exchange; tests inject a fake.
 * Decoupling watch from the adapter is what makes supervised-loop testing offline.
 */
export interface WatchSource {
  watchTicker(exchange: Exchange, symbol: string): Promise<Ticker>;
  watchTrades(exchange: Exchange, symbol: string): Promise<Trade[]>;
  watchOHLCV(exchange: Exchange, symbol: string, timeframe: string): Promise<OHLCV[]>;
  watchOrderBook(exchange: Exchange, symbol: string): Promise<OrderBook>;
}

export const WATCH_SOURCE = Symbol('WATCH_SOURCE');

/** Real WatchSource: delegates directly to ccxt pro watch* methods. */
@Injectable()
export class RealWatchSource implements WatchSource {
  async watchTicker(exchange: Exchange, symbol: string): Promise<Ticker> {
    return (exchange as unknown as { watchTicker(s: string): Promise<Ticker> }).watchTicker(symbol);
  }
  async watchTrades(exchange: Exchange, symbol: string): Promise<Trade[]> {
    return (exchange as unknown as { watchTrades(s: string): Promise<Trade[]> }).watchTrades(
      symbol,
    );
  }
  async watchOHLCV(exchange: Exchange, symbol: string, timeframe: string): Promise<OHLCV[]> {
    return (
      exchange as unknown as { watchOHLCV(s: string, tf: string): Promise<OHLCV[]> }
    ).watchOHLCV(symbol, timeframe);
  }
  async watchOrderBook(exchange: Exchange, symbol: string): Promise<OrderBook> {
    return (
      exchange as unknown as { watchOrderBook(s: string): Promise<OrderBook> }
    ).watchOrderBook(symbol);
  }
}

/**
 * Builds a ccxt pro exchange instance for the given venue config.
 * Applies environment mode: setSandboxMode (testnet), enableDemoTrading (demo),
 * or neither (live). Paper mode does not construct a network client; callers
 * should guard on venueConfig.environment === 'paper'.
 */
export function buildCcxtExchange(venueConfig: VenueConfig): Exchange {
  const ProExchanges = ccxtPro as unknown as Record<string, new (opts: object) => Exchange>;
  const Ctor = ProExchanges[venueConfig.id];
  if (!Ctor) {
    throw new Error(`ccxt.pro has no exchange named "${venueConfig.id}"`);
  }

  // XA6: depth updates slowed from ccxt's 100ms default (pinned ccxt 4.5.58 binance pro reads
  // options.watchOrderBookRate VERBATIM into the <symbol>@depth@<rate>ms stream name with no
  // validation — js/src/pro/binance.js:145/702/716). This is the MARKET-DATA instance only
  // (public, keyless): its book consumers are the risk mark (tee reads bids[0]/asks[0] into a
  // mid) and 'book' channel health (5s staleness veto) — top-of-book at these rates is ample, and
  // the 100ms diff firehose across the active menu was the dominant spot CPU load pre-XA6.
  //
  // PER-VENUE rate (v3 soak defect #2, 2026-07-21): Binance FUTURES stream servers serve only
  // @depth@100ms/250ms/500ms — an unknown suffix like @depth@1000ms is ACCEPTED at subscribe and
  // then never sent a single frame. Probe-verified against the demo venue (#54 pattern, A/B on
  // demo binanceusdm BTC book: rate 1000 ⇒ 1 yield/30s — the REST snapshot only; rate 500 ⇒
  // 50 yields/30s). v2 never hit this because the XA6 option shipped on the spot lane only; v3's
  // unified builder applied it to both venues, silently starving every perp book and feeding the
  // watchdog storm. Spot keeps 1000ms (valid there, empirically flowing); futures gets 500ms —
  // the slowest speed the futures ws actually serves, preserving XA6's load intent (5x calmer
  // than the 100ms default). Re-verify both against the venue if the pinned ccxt is bumped.
  const watchOrderBookRate = venueConfig.id === 'binanceusdm' ? 500 : 1000;

  const opts: Record<string, unknown> = {
    number: String,
    enableRateLimit: true,
    //
    // OHLCVLimit / tradesLimit: pinned ccxt 4.5.58's per-exchange in-memory caches for watchOHLCV/
    // watchTrades default to 1000 entries EACH, per symbol+timeframe/per symbol respectively —
    // verified against the installed package: js/src/pro/binance.js:148 (`'tradesLimit': 1000` in
    // binance's own `describe().options`), :150 (`'OHLCVLimit': 1000`), consumed at :1451
    // (`this.safeInteger(this.options, 'tradesLimit', 1000)` inside handleTrades) and :1692
    // (`this.safeInteger(this.options, 'OHLCVLimit', 1000)` inside handleOHLCV) — an `options` key
    // set here overrides the exchange's own describe() default via ccxt's deep-extend constructor
    // merge. Lowered to 400 candles (ample for every interval this bot warms up/trades on) and 100
    // trades (this instance's trade channel feeds only the paper-fill simulator, which never needs
    // more than a handful of recent prints) — same per-symbol-per-channel unbounded-cache memory
    // concern as the order-book bound above (normalize.ts's MARKET_BOOK_MAX_LEVELS), just on ccxt's
    // own internal cache instead of this codebase's normalized event. Re-verify these key spellings/
    // defaults if the pinned ccxt version is ever bumped.
    options: { watchOrderBookRate, OHLCVLimit: 400, tradesLimit: 100 },
  };

  if (venueConfig.baseUrlOverride) {
    opts['urls'] = { api: { public: venueConfig.baseUrlOverride } };
  }

  const exchange = new Ctor(opts);

  if (venueConfig.environment === 'testnet') {
    (exchange as unknown as { setSandboxMode(v: boolean): void }).setSandboxMode(true);
  } else if (venueConfig.environment === 'demo') {
    (exchange as unknown as { enableDemoTrading(v: boolean): void }).enableDemoTrading(true);
  }
  // live: no modification; paper: caller should not invoke network methods

  // ccxt's `has` capability map UNDER-REPORTS inherited pro-streaming methods for derived Binance
  // futures exchanges: binanceusdm extends binance and inherits its working watch* implementations,
  // but binanceusdm.describe() leaves has.watchTicker/watchOHLCV/watchOrderBook/watchTrades
  // undefined — so assertCapabilities (which correctly trusts `has`) false-negatives and refuses to
  // stream a venue that in fact streams fine. Empirically verified 2026-07-14 against
  // demo-fapi.binance.com: all four return live data (ticker last, a 15m bar, a 1000-level book, a
  // trade). Reflect that verified truth so the capability gate matches reality; every other venue's
  // `has` is trusted as-is (no blanket widening of the assertion). Re-verify if the pinned ccxt
  // 4.5.58 is bumped (the metadata may be corrected upstream, making this a harmless no-op).
  if (venueConfig.id === 'binanceusdm') {
    exchange.has = {
      ...exchange.has,
      watchTicker: true,
      watchOHLCV: true,
      watchOrderBook: true,
      watchTrades: true,
    };
  }

  return exchange;
}

/**
 * Checks that the exchange has all capabilities required for the subscription spec.
 * Throws on a missing REQUIRED capability — fail-fast at startup.
 */
function assertCapabilities(exchange: Exchange, spec: SubscriptionSpec): void {
  const has = exchange.has as Record<string, boolean | string | undefined>;

  if (spec.channels.ticker && !has['watchTicker']) {
    throw new Error(
      `Venue "${exchange.id}" does not support watchTicker (required for ticker channel)`,
    );
  }
  if (spec.channels.trades && !has['watchTrades']) {
    throw new Error(
      `Venue "${exchange.id}" does not support watchTrades (required for trades channel)`,
    );
  }
  if (spec.channels.book && !has['watchOrderBook']) {
    throw new Error(
      `Venue "${exchange.id}" does not support watchOrderBook (required for book channel)`,
    );
  }
  if (spec.channels.candles?.length && !has['watchOHLCV']) {
    throw new Error(
      `Venue "${exchange.id}" does not support watchOHLCV (required for candles channel)`,
    );
  }
}

/** Transient error: restart the watch loop iteration. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // ccxt ChecksumError is treated specially (invalidate + resubscribe), not just transient
  if (err.constructor?.name === 'ChecksumError') return false;
  const transientNames = [
    'NetworkError',
    'DDoSProtection',
    'RateLimitExceeded',
    'ExchangeNotAvailable',
    'OnMaintenance',
    'RequestTimeout',
    'BadResponse',
    'InvalidNonce',
  ];
  return transientNames.some((n) => err.constructor?.name === n || err.message.includes(n));
}

function isChecksumError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.constructor?.name === 'ChecksumError';
}

// See the pinned-ccxt-4.5.58 header comment above: a wedged instance throws this on EVERY watch*
// call, forever — matched by constructor name (the real ccxt error) or message substring (fakes in
// tests, and belt-and-suspenders against a future ccxt release renaming/wrapping the class).
function isClosedByUser(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.constructor?.name === 'ExchangeClosedByUser' || err.message.includes('closedByUser');
}

// ROOT CAUSE (LIVE INCIDENT 2026-08-06, 6.25h wedge, spot lane): pinned ccxt 4.5.58 memoises a
// REJECTED markets-load promise and never clears it. Exchange.js:891-903 — `loadMarkets(reload)`
// assigns `this.marketsLoading = this.loadMarketsHelper(reload, params).then(ok, err => {
// this.reloadingMarkets = false; throw error; })`; the rejection handler (:897-899) resets ONLY
// `reloadingMarkets`, never `marketsLoading` — that field is cleared to undefined exactly once, in
// the constructor (:135). Every ccxt-pro watch* starts with `await this.loadMarkets()` at
// reload=false (js/src/pro/binance.js:1848), so one failed load makes every LATER watch* return the
// SAME already-rejected promise forever: instant rejection, zero network I/O, and (because
// loadMarketsHelper only reaches setMarkets on success) `this.markets` never populates. Detected
// STRUCTURALLY here (the market cache is empty) rather than by matching the surfaced error's
// message — the surfaced error is an ordinary NetworkError indistinguishable from a real, still-live
// outage, and message-matching would silently stop working the moment ccxt rewords it. Re-verify
// these line numbers if the pinned ccxt version is ever bumped (bumping it already requires the
// sandbox-URL + error-classifier regression tests per root CLAUDE.md).
// Reads `exchange.symbols` (kept in lockstep with `exchange.markets` by ccxt's own setMarkets —
// verified against the installed package: Exchange.js:3472 assigns `this.markets` immediately before
// :3475 derives `this.symbols = Object.keys(...)` from that same assignment) rather than `.markets`
// itself for two reasons: it is O(1) — `.length` on an already-materialized array, vs. allocating a
// fresh ~3000-entry key array on Binance spot on EVERY non-checksum loop error (this file's own v2
// header records an OOM in this lane); and it needs no cast — `symbols: Strings` (`string[] |
// undefined`) is declared PUBLIC API on Exchange.d.ts, unlike the ws-internals reach-throughs
// elsewhere in this file that ccxt does not declare at all.
function hasNoMarkets(exchange: Exchange): boolean {
  return !exchange.symbols || exchange.symbols.length === 0;
}

// ── CcxtExchangeStreamAdapter ────────────────────────────────────────────────

@Injectable()
export class CcxtExchangeStreamAdapter implements ExchangeStreamPort {
  private running = true;
  // Per-(symbol,channel) last successful yield, seeded at loop start so a subscription that never
  // delivers a single event still trips the watchdog. Adapter-local on purpose: FeedHealthService's
  // channel map serves consumers; this map serves only the recovery decision.
  private readonly lastYieldAt = new Map<string, EpochMs>();
  // Per-(symbol,channel) exponential retry backoff — see CHANNEL_BACKOFF_BASE_MS/CAP_MS. Absent key
  // means "at base" (never failed, or reset by a successful yield).
  private readonly channelBackoffMs = new Map<string, number>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastForcedReconnectAt = 0;
  // Watchdog escalation counter — see WATCHDOG_ZERO_YIELD_ESCALATION_THRESHOLD.
  private consecutiveZeroYieldReconnects = 0;
  // The exact (symbol,channel) key set that was stalled at the last tick that found any stall — see
  // watchdogTick's "same channels" comment. Empty means "no stall streak in progress".
  private lastStalledKeys: Set<string> = new Set();
  // Single-flight + cooldown state for the markets-wedge escape (see hasNoMarkets/forceReloadMarkets
  // and MARKETS_RELOAD_COOLDOWN_MS). Mirrors the recreatePromise/nextRecreateAllowedAt shape below
  // for the same reason: N concurrent handleLoopError callers must share one in-flight reload.
  private marketsReloadPromise: Promise<void> | null = null;
  private lastMarketsReloadAttemptAt = -Infinity;
  // One next-available-slot clock per lane (see SUBSCRIBE_LANE_COUNT). Index i's slot advances only
  // when lane i is claimed, so least-loaded-lane selection in subscribeSlot() naturally round-robins.
  private readonly laneNextSlotAt: number[] = new Array<number>(SUBSCRIBE_LANE_COUNT).fill(0);
  private readonly lastErrorLogAt = new Map<string, number>();
  // Single-flight guard for exchange recreation (see recreateExchange()): every supervised loop
  // shares one exchange instance, so N loops hitting ExchangeClosedByUser in the same beat must
  // trigger exactly one swap, not N races. null when no recreation is in flight. The cooldown/cap
  // gate (v2) lives INSIDE doRecreateExchange (not in handleLoopError, before calling in) precisely
  // so that concurrent joiners of an in-flight recreation never re-evaluate — and potentially
  // mis-gate against — a cooldown the first caller just armed synchronously.
  private recreatePromise: Promise<boolean> | null = null;
  // v2 recreation cooldown/cap state — see RecreationPolicy and doRecreateExchange().
  private recreateCooldownMs: number;
  private nextRecreateAllowedAt = 0;
  private lastRecreateAt = 0;
  // Successful-recreation timestamps within the rolling capWindowMs; pruned lazily on each check.
  private readonly recreateHistory: number[] = [];
  private capExhaustedLoggedAt = -Infinity;
  // XA6 tier state — see ChannelTierResolver above. null resolver = everything full tier.
  private tierResolver: ChannelTierResolver | null = null;
  private tierPollMs: number = TIER_PARK_POLL_MS;
  private tierResolverWarnedAt = -Infinity;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(WATCH_SOURCE) private readonly watchSource: WatchSource,
    // Mutable (not readonly): recreateExchange() swaps this in place after a closedByUser wedge.
    // Every supervised loop reads `this.exchange` at call time (never captures a local), so a swap
    // is picked up by the very next watch* call on every loop, not just the one that detected it.
    private exchange: Exchange,
    private readonly venueId: VenueId,
    private readonly stateTracker: ChannelStateTracker,
    private readonly logger?: StreamAdapterLogger,
    // Defaults to real jitter in production; tests inject a zero (or fixed) function for
    // deterministic timing assertions. See SUBSCRIBE_JITTER_MAX_MS for why this exists.
    private readonly subscribeJitterFn: () => number = () =>
      Math.random() * SUBSCRIBE_JITTER_MAX_MS,
    // Recreation seam for the pinned-ccxt-4.5.58 closedByUser wedge (see header comment). Optional
    // and appended last so every existing call site (production and tests) keeps compiling
    // unchanged; omitting it just means closedByUser errors fall through to the ordinary
    // transient/GAP + backoff path (unrecoverable, same as before this fix — never a hard failure).
    private readonly exchangeFactory?: () => Exchange,
    // v2: tunable recreation cooldown/cap (see RecreationPolicy). Optional, appended last;
    // production always takes the default, tests shrink it for fast, deterministic escalation/cap
    // coverage. Also appended last for the same call-site-compatibility reason as exchangeFactory.
    private readonly recreationPolicy: RecreationPolicy = DEFAULT_RECREATION_POLICY,
  ) {
    this.recreateCooldownMs = recreationPolicy.cooldownInitialMs;
  }

  stop(): void {
    this.running = false;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  // XA6: late-binding seam — the composition root wires the scanner-backed resolver here after DI
  // resolves both sides (the adapter is constructed in the market-data layer, the scanner in the
  // agentic layer; neither may import the other). pollMs is injectable for tests only.
  setChannelTierResolver(resolver: ChannelTierResolver, pollMs: number = TIER_PARK_POLL_MS): void {
    this.tierResolver = resolver;
    this.tierPollMs = pollMs;
  }

  // Fails OPEN to full tier (see the ChannelTierResolver header comment): a throwing resolver is
  // rate-limit-logged and treated as "subscribe everything" — never as a reason to park.
  private isFullTier(symbol: SymbolId): boolean {
    if (!this.tierResolver) return true;
    try {
      return this.tierResolver.fullChannels(symbol);
    } catch (err) {
      const now = this.clock.now();
      if (now - this.tierResolverWarnedAt >= LOOP_ERROR_LOG_INTERVAL_MS) {
        this.tierResolverWarnedAt = now;
        this.logger?.warn(
          `market-stream tier resolver threw (fail-open, all symbols full tier): ${String(err)}`,
        );
      }
      return true;
    }
  }

  // Deregisters a parked channel from BOTH observers: the watchdog's lastYieldAt map (a parked
  // channel silent >180s must never force a connection-wide close()) and the health tracker's
  // age/staleness view (a deliberately-off channel is not a stale feed).
  private parkChannel(symbol: SymbolId, channel: string): void {
    this.lastYieldAt.delete(`${symbol}|${channel}`);
    this.stateTracker.clearChannel?.(this.venueId, symbol, channel);
    this.logger?.log?.(
      `market-stream tier: ${symbol}|${channel} parked (lite tier — non-menu symbol; ` +
        `resumes on promotion within ${this.tierPollMs}ms)`,
    );
  }

  private parkWait(): Promise<void> {
    return new Promise<void>((res) => setTimeout(res, this.tierPollMs));
  }

  // Demotion-time venue-side unsubscribe: merely parking the loop stops CONSUMING, but ccxt keeps
  // parsing every inbound message for the still-live venue subscription until the next connection
  // cycle (Binance recycles ws at ~24h) — the CPU the tier exists to reclaim. ccxt 4.5.58 binance
  // declares unWatchOrderBook/unWatchTrades (verified in the installed package); the UNSUBSCRIBE
  // frame is outbound control traffic, so it passes the SAME paced subscribe gate as a subscribe —
  // a demotion wave must never trip the 5 msg/s 1008 cliff. Fail-OPEN: absent capability, a throw,
  // or a never-subscribed instance (post-recreation) all reduce to plain parking — the subscription
  // then lapses at the natural connection cycle instead, exactly the pre-unwatch behavior.
  private async unwatchChannel(symbol: SymbolId, channel: string): Promise<void> {
    try {
      const ex = this.exchange as unknown as {
        unWatchOrderBook?: (s: string) => Promise<unknown>;
        unWatchTrades?: (s: string) => Promise<unknown>;
      };
      if (channel === 'book' && typeof ex.unWatchOrderBook === 'function') {
        await this.subscribeSlot();
        if (!this.running) return;
        await ex.unWatchOrderBook(symbol);
      } else if (channel === 'trade' && typeof ex.unWatchTrades === 'function') {
        await this.subscribeSlot();
        if (!this.running) return;
        await ex.unWatchTrades(symbol);
      }
    } catch (err) {
      this.logger?.warn(
        `market-stream tier: unwatch ${symbol}|${channel} failed (fail-open, parked anyway; ` +
          `subscription lapses at the next connection cycle): ${String(err)}`,
      );
    }
  }

  /**
   * Returns an AsyncIterable of raw venue events for the subscription spec.
   * Each channel (ticker, trades, candles, book) per symbol runs in a supervised
   * for(;;) loop that catches transient errors and continues; ChecksumError
   * invalidates the local book and resubscribes on next iteration.
   */
  marketRaw(spec: SubscriptionSpec): AsyncIterable<RawVenueEvent> {
    assertCapabilities(this.exchange, spec);

    // Arrow-bound so `this` refers to the adapter inside the iterator (no this-alias).
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<RawVenueEvent> => {
        const buffer: RawVenueEvent[] = [];
        let resolveNext: ((v: IteratorResult<RawVenueEvent>) => void) | null = null;
        let done = false;

        const push = (ev: RawVenueEvent): void => {
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ value: ev, done: false });
          } else {
            buffer.push(ev);
          }
        };

        const finish = (): void => {
          done = true;
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ value: undefined, done: true });
          }
        };

        // Start supervised loops for each symbol × channel
        const loops: Promise<void>[] = [];

        for (const symbol of spec.symbols) {
          if (spec.channels.ticker) {
            loops.push(this.runTickerLoop(push, symbol));
          }
          if (spec.channels.trades) {
            loops.push(this.runTradesLoop(push, symbol));
          }
          if (spec.channels.book) {
            loops.push(this.runBookLoop(push, symbol));
          }
          for (const interval of spec.channels.candles ?? []) {
            loops.push(this.runCandleLoop(push, symbol, interval));
          }
        }

        this.startWatchdog();

        Promise.all(loops).then(
          () => finish(),
          () => finish(),
        );

        return {
          next: (): Promise<IteratorResult<RawVenueEvent>> => {
            if (buffer.length > 0) {
              return Promise.resolve({ value: buffer.shift()!, done: false });
            }
            if (done) {
              return Promise.resolve({ value: undefined as unknown as RawVenueEvent, done: true });
            }
            return new Promise<IteratorResult<RawVenueEvent>>((res) => {
              resolveNext = res;
            });
          },
          return: (): Promise<IteratorResult<RawVenueEvent>> => {
            this.stop();
            return Promise.resolve({ value: undefined as unknown as RawVenueEvent, done: true });
          },
        };
      },
    };
  }

  // ── Supervised channel loops ─────────────────────────────────────────────

  private async runTickerLoop(push: (ev: RawVenueEvent) => void, symbol: SymbolId): Promise<void> {
    const channel = 'ticker';
    this.seedChannel(symbol, channel);
    let needsSlot = true;
    while (this.running) {
      try {
        if (needsSlot) {
          await this.subscribeSlot();
          if (!this.running) break;
          needsSlot = false;
        }
        const ticker = await this.watchSource.watchTicker(this.exchange, symbol);
        const ts = typeof ticker.timestamp === 'number' ? epochMs(ticker.timestamp) : undefined;
        push({ type: 'ticker', venue: this.venueId, symbol, timestamp: ts, raw: ticker });
        this.noteYield(symbol, channel);
        this.stateTracker.recordEvent(this.venueId, symbol, channel);
        this.scheduleStaleCheck(symbol, channel);
      } catch (err) {
        if (!this.running) break;
        needsSlot = true;
        await this.handleLoopError(err, symbol, channel);
      }
    }
  }

  private async runTradesLoop(push: (ev: RawVenueEvent) => void, symbol: SymbolId): Promise<void> {
    const channel = 'trade';
    // XA6 tier-gated channel: seeding moves INSIDE the loop (on resume) so a lite symbol never
    // registers with the watchdog/health tracker at all. parked === null means "no state yet"
    // (first iteration decides without logging a transition that never happened).
    let parked: boolean | null = null;
    let needsSlot = true;
    while (this.running) {
      try {
        if (!this.isFullTier(symbol)) {
          if (parked !== true) {
            if (parked === false) {
              this.parkChannel(symbol, channel);
              // Fire-and-forget: the venue-side unsubscribe is paced and fail-open (see the
              // helper); parking must not wait on it.
              void this.unwatchChannel(symbol, channel);
            }
            parked = true;
          }
          needsSlot = true;
          await this.parkWait();
          continue;
        }
        if (parked !== false) {
          this.seedChannel(symbol, channel);
          if (parked === true) {
            this.logger?.log?.(`market-stream tier: ${symbol}|${channel} resumed (full tier)`);
          }
          parked = false;
        }
        if (needsSlot) {
          await this.subscribeSlot();
          if (!this.running) break;
          needsSlot = false;
        }
        const trades = await this.watchSource.watchTrades(this.exchange, symbol);
        for (const trade of trades) {
          const ts = typeof trade.timestamp === 'number' ? epochMs(trade.timestamp) : undefined;
          push({ type: 'trade', venue: this.venueId, symbol, timestamp: ts, raw: trade });
        }
        this.noteYield(symbol, channel);
        this.stateTracker.recordEvent(this.venueId, symbol, channel);
        this.scheduleStaleCheck(symbol, channel);
      } catch (err) {
        if (!this.running) break;
        needsSlot = true;
        await this.handleLoopError(err, symbol, channel);
      }
    }
  }

  private async runCandleLoop(
    push: (ev: RawVenueEvent) => void,
    symbol: SymbolId,
    interval: string,
  ): Promise<void> {
    const channel = `candle:${interval}`;
    this.seedChannel(symbol, channel);
    let needsSlot = true;
    while (this.running) {
      try {
        if (needsSlot) {
          await this.subscribeSlot();
          if (!this.running) break;
          needsSlot = false;
        }
        const bars = await this.watchSource.watchOHLCV(this.exchange, symbol, interval);
        for (const bar of bars) {
          const ts = typeof bar[0] === 'number' ? epochMs(bar[0]) : undefined;
          push({ type: 'candle', venue: this.venueId, symbol, timestamp: ts, raw: bar });
        }
        this.noteYield(symbol, channel);
        this.stateTracker.recordEvent(this.venueId, symbol, channel);
        this.scheduleStaleCheck(symbol, channel);
      } catch (err) {
        if (!this.running) break;
        needsSlot = true;
        await this.handleLoopError(err, symbol, channel);
      }
    }
  }

  private async runBookLoop(push: (ev: RawVenueEvent) => void, symbol: SymbolId): Promise<void> {
    const channel = 'book';
    // XA6 tier-gated channel — same park/resume shape as runTradesLoop (see its comment). Parking
    // book only drops the heavy per-symbol subscription itself: feed.health('book') answers GAP once
    // parked, but RiskEngineService no longer gates entry on book alone (that invariant was repealed
    // 2026-07-22 — see risk-engine.service.ts's own header comment) — it takes the best of
    // book/ticker, and ticker stays subscribed regardless of tier, so a lite symbol's mark health is
    // unaffected by parking. The "don't enter off-menu" rule now lives in batching-agent-client.ts's
    // off-menu block instead; promotion here still re-subscribes book and the first snapshot
    // restores LIVE for it.
    let parked: boolean | null = null;
    let needsSlot = true;
    while (this.running) {
      try {
        if (!this.isFullTier(symbol)) {
          if (parked !== true) {
            if (parked === false) {
              this.parkChannel(symbol, channel);
              // Fire-and-forget: the venue-side unsubscribe is paced and fail-open (see the
              // helper); parking must not wait on it.
              void this.unwatchChannel(symbol, channel);
            }
            parked = true;
          }
          needsSlot = true;
          await this.parkWait();
          continue;
        }
        if (parked !== false) {
          this.seedChannel(symbol, channel);
          if (parked === true) {
            this.logger?.log?.(`market-stream tier: ${symbol}|${channel} resumed (full tier)`);
          }
          parked = false;
        }
        if (needsSlot) {
          await this.subscribeSlot();
          if (!this.running) break;
          needsSlot = false;
        }
        const book = await this.watchSource.watchOrderBook(this.exchange, symbol);
        const ts = typeof book.timestamp === 'number' ? epochMs(book.timestamp) : undefined;
        push({ type: 'book', venue: this.venueId, symbol, timestamp: ts, raw: book });
        this.noteYield(symbol, channel);
        this.stateTracker.recordEvent(this.venueId, symbol, channel);
        this.scheduleStaleCheck(symbol, channel);
      } catch (err) {
        if (!this.running) break;
        needsSlot = true;
        await this.handleLoopError(err, symbol, channel);
      }
    }
  }

  // Single error policy for every supervised loop (one place, one set of branches):
  //   - book + ChecksumError → GAP, no backoff (ccxt dropped the book; resubscribe at once —
  //     though the resubscribe still passes the subscribe gate like every other re-entry)
  //   - ExchangeClosedByUser (wedged instance, factory wired) → GAP, attempt recreation (no extra
  //     backoff on a SUCCESSFUL swap — subscribeSlot's lane pacing already gates the resubscribe
  //     herd). recreateExchange() returns false — and this branch backs off like any other failure
  //     — for THREE reasons, not just "the factory threw": a cooldown still active (v2: breaks the
  //     watchdog→close→closedByUser→recreate storm under venue penalty), the rolling-window cap
  //     exhausted (v2: loud level-50 stop, container healthcheck is the final rung), or the factory
  //     itself failing. All three are fail-open — never a hard failure, the wedge just persists.
  //   - transient (network/rate/maintenance) → DEGRADED, backoff before retry
  //   - anything else → GAP, backoff (never tight-loop on an unknown error)
  // Every branch logs (rate-limited per channel) BEFORE classifying — see
  // LOOP_ERROR_LOG_INTERVAL_MS for why silence here is not an option.
  private async handleLoopError(err: unknown, symbol: SymbolId, channel: string): Promise<void> {
    const key = `${symbol}|${channel}`;
    const now = this.clock.now();
    if (now - (this.lastErrorLogAt.get(key) ?? -Infinity) >= LOOP_ERROR_LOG_INTERVAL_MS) {
      this.lastErrorLogAt.set(key, now);
      this.logger?.warn(
        `market-stream ${key} loop error (resubscribing): ${
          err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)
        }`,
      );
    }
    if (channel === 'book' && isChecksumError(err)) {
      this.stateTracker.setHealth(this.venueId, symbol, channel, 'GAP');
      return;
    }
    if (isClosedByUser(err) && this.exchangeFactory) {
      this.stateTracker.setHealth(this.venueId, symbol, channel, 'GAP');
      const recreated = await this.recreateExchange(this.exchangeFactory);
      if (!recreated) await this.backoff(key);
      return;
    }
    // Markets-wedge escape (see hasNoMarkets's header comment): every watch* on a wedged instance
    // surfaces as an ordinary NetworkError, indistinguishable from a real outage, from THIS point
    // in the branching — so the check is structural (the market cache itself), not keyed to a
    // particular error class, and runs before the health state below is decided. CAVEAT (2026-08-06
    // adversarial review): this is unreachable from the closedByUser branch above whenever
    // recreateExchange resolves true (its eager loadMarkets already covers that path — duplicating it
    // here would just double the exchangeInfo call), but NOT when it resolves false (cooldown active,
    // cap exhausted, or the factory itself threw — see doRecreateExchange's three false-returning
    // cases) — that branch `return`s unconditionally, so a markets-wedge coinciding with a DECLINED
    // recreation goes unchecked for this one iteration. Fail-open, not fail-silent: the wedge, if
    // real, resurfaces on the channel's very next handleLoopError call (no state is lost), so the
    // cost is one extra retry cycle, never a missed recovery.
    if (hasNoMarkets(this.exchange)) {
      await this.forceReloadMarkets();
    }
    this.stateTracker.setHealth(
      this.venueId,
      symbol,
      channel,
      isTransient(err) ? 'DEGRADED' : 'GAP',
    );
    await this.backoff(key);
  }

  // Single-flight swap of the wedged exchange instance for a fresh one. Every concurrent caller
  // (one per loop hitting ExchangeClosedByUser in the same beat) awaits the SAME in-flight promise
  // — exactly one factory() call and one close() of the stale instance, regardless of how many
  // loops failed simultaneously. Returns true iff the swap happened; false means the factory itself
  // failed (fail-open: this method never throws — a broken factory must not crash the market-data
  // stream it is meant to recover, the wedge just persists and the caller backs off instead).
  private recreateExchange(factory: () => Exchange): Promise<boolean> {
    if (!this.recreatePromise) {
      this.recreatePromise = this.doRecreateExchange(factory).finally(() => {
        this.recreatePromise = null;
      });
    }
    return this.recreatePromise;
  }

  // The v2 cooldown/cap gate lives HERE (inside the single-flight body), not in handleLoopError
  // before calling recreateExchange(). Both checks below run synchronously, before the first
  // await, so every concurrent caller that joins this SAME in-flight promise (see
  // recreateExchange()) is bound by the one decision made for the whole batch — a caller that
  // arrives one microtask later must never re-evaluate (and potentially mis-gate against) a
  // cooldown this call is in the middle of arming.
  private async doRecreateExchange(factory: () => Exchange): Promise<boolean> {
    const now = this.clock.now();
    if (this.isRecreateCapExhausted(now)) {
      this.logCapExhausted(now);
      return false;
    }
    if (now < this.nextRecreateAllowedAt) {
      // Cooldown active: a wedge recurring inside the window is the SAME incident continuing (e.g.
      // a venue penalty phase), not a fresh trigger — plain backoff, no recreation attempt. This is
      // what breaks the watchdog→close()→closedByUser→recreate storm (see the v2 header comment).
      // The per-channel rate-limited warn in handleLoopError already covers "log once per interval"
      // visibility for this path; no separate log needed here.
      return false;
    }

    const stale = this.exchange;
    let fresh: Exchange;
    try {
      fresh = factory();
      // Eager markets load, still inside this try, BEFORE the swap below — see hasNoMarkets's
      // header comment (LIVE INCIDENT 2026-08-06). If the implicit lazy load a supervised loop's
      // first watch* would trigger lands inside a still-live outage, ccxt memoises the rejection
      // FOREVER and this brand-new instance is wedged before it ever serves a single event.
      // Loading eagerly means a failed load costs only the swap we don't make — `this.exchange`
      // stays on `stale`, which the existing recovery paths already know how to keep retrying —
      // instead of silently handing every loop a poisoned "fresh" instance. NOT sufficient alone:
      // a `fresh` instance that loads fine here can still wedge on its OWN first lazy load if the
      // same outage is still live a beat later — hasNoMarkets/forceReloadMarkets in
      // handleLoopError is the general cure for that case; this is only the recreation-time guard.
      // No cast: loadMarkets(reload?, params?) is declared PUBLIC API on Exchange.d.ts.
      await fresh.loadMarkets();
    } catch (err) {
      this.logger?.warn(
        `market-stream exchange recreate failed (fail-open, still wedged): ${String(err)}`,
      );
      return false;
    }
    this.exchange = fresh;
    this.stateTracker.recordForcedReconnect?.();

    // Escalating cooldown: iff the previous recreation was recent (a RECURRING wedge), double the
    // cooldown up to the ceiling; otherwise this is a fresh, independent incident and starts back
    // at the base cooldown. See RecreationPolicy.healthyResetMs for why it is strictly above
    // cooldownMaxMs (avoids an oscillation right at the ceiling).
    if (
      this.lastRecreateAt > 0 &&
      now - this.lastRecreateAt < this.recreationPolicy.healthyResetMs
    ) {
      this.recreateCooldownMs = Math.min(
        this.recreateCooldownMs * this.recreationPolicy.cooldownMultiplier,
        this.recreationPolicy.cooldownMaxMs,
      );
    } else {
      this.recreateCooldownMs = this.recreationPolicy.cooldownInitialMs;
    }
    this.lastRecreateAt = now;
    this.nextRecreateAllowedAt = now + this.recreateCooldownMs;
    this.recreateHistory.push(now);

    this.logger?.warn(
      'market-stream exchange recreated after closedByUser wedge (ccxt 4.5.58 pinned close() ' +
        `terminal-state defect — see ccxt-stream.adapter.ts header comment, 2026-07-19); next ` +
        `recreation gated for ${this.recreateCooldownMs}ms`,
    );

    // Best-effort: the stale instance is already dead (that is why we are here); its close() may
    // itself throw or hang — either way, swallow it and move on to the hard-dispose below, which is
    // what actually matters (v2: 2026-07-19 venue-penalty incident — close() alone was not enough).
    try {
      await (stale as unknown as { close(): Promise<void> }).close();
    } catch {
      // already dead; nothing to do
    }
    // Runs regardless of whether close() above succeeded, rejected, or hung — a wedged instance's
    // leak (see the v2 header comment) is in its ws clients' timers/socket, not in the close()
    // handshake, so disposal cannot be conditioned on close() having "worked".
    this.hardDisposeExchange(stale);
    return true;
  }

  // PINNED ccxt 4.5.58 internals — reaches past the public API on purpose (js/src/base/Exchange.js
  // `clients` map keyed by ws url; js/src/base/ws/Client.js `clearConnectionTimeout()` /
  // `clearPingInterval()`; js/src/base/ws/WsClient.js `connection`, the underlying Node `ws`
  // socket). A wedged instance's close() can reject or hang while its clients still hold a live
  // socket plus pingInterval/connectionTimer Node timers — those timers keep the client (and
  // everything it closes over) reachable from Node's timer list regardless of whether anything else
  // still references the stale exchange. 36 undisposed instances over ~35 minutes during the
  // 2026-07-19 venue-penalty incident is exactly this leak, and it OOM-crashed the spot lane.
  // Fails OPEN per client: one client that throws mid-teardown must never block tearing down the
  // rest. Re-verify this reach-through if the pinned ccxt version is ever bumped.
  private hardDisposeExchange(stale: Exchange): void {
    const clients = (stale as unknown as { clients?: Record<string, unknown> }).clients ?? {};
    for (const client of Object.values(clients)) {
      try {
        const c = client as {
          clearConnectionTimeout?: () => void;
          clearPingInterval?: () => void;
          connection?: { terminate?: () => void };
        };
        c.clearConnectionTimeout?.();
        c.clearPingInterval?.();
        c.connection?.terminate?.();
      } catch (err) {
        this.logger?.warn(
          `market-stream hard-dispose: one client failed to tear down (fail-open): ${String(err)}`,
        );
      }
    }
    (stale as unknown as { clients: Record<string, unknown> }).clients = {};
  }

  // Prunes the rolling window in place, then answers whether the cap is (still) exhausted. Fails
  // OPEN in direction of the RECREATION decision (returning true — "exhausted" — is the CONSERVATIVE
  // answer here: it stops recreating, which is safe; the market-data stream itself is never blocked
  // by this check, only the recreation attempt is).
  private isRecreateCapExhausted(now: number): boolean {
    const cutoff = now - this.recreationPolicy.capWindowMs;
    while (this.recreateHistory.length > 0 && this.recreateHistory[0]! < cutoff) {
      this.recreateHistory.shift();
    }
    return this.recreateHistory.length >= this.recreationPolicy.capPerWindow;
  }

  // Level-50 (StreamAdapterLogger.error — see the pino level table): loud and rate-limited (reuses
  // LOOP_ERROR_LOG_INTERVAL_MS so a stuck-wedged loop retrying every beat doesn't flood the log).
  // Never silent — per the v2 requirement, recreation-cap exhaustion must fail loudly, not leak
  // quietly; the container healthcheck/restart-policy is the intended next rung.
  private logCapExhausted(now: number): void {
    if (now - this.capExhaustedLoggedAt < LOOP_ERROR_LOG_INTERVAL_MS) return;
    this.capExhaustedLoggedAt = now;
    this.logger?.error(
      'market-stream recreation cap exhausted — venue likely penalty-boxing; awaiting healthcheck restart',
    );
  }

  // The markets-wedge escape (see hasNoMarkets's header comment, LIVE INCIDENT 2026-08-06).
  // loadMarkets(true) is the only way out: the guard in ccxt's loadMarkets is
  // `(reload && !this.reloadingMarkets) || !this.marketsLoading` — the wedge's own rejection
  // handler already reset reloadingMarkets to false, so reload=true re-enters loadMarketsHelper
  // instead of returning the memoised rejection reload=false would. Single-flighted (every
  // concurrent handleLoopError caller shares one in-flight reload, mirroring recreateExchange's
  // shape above) AND cooldown-gated (MARKETS_RELOAD_COOLDOWN_MS): unlike recreateExchange this has
  // no per-incident escalation, because a reload is cheap to retry on a fixed cadence and — unlike
  // recreating the whole instance — carries no ws-teardown cost to pace against. Fails OPEN: a
  // failing reload just leaves the wedge for the next round; it must NEVER throw into the calling
  // supervised loop, which is why the promise itself never rejects.
  private forceReloadMarkets(): Promise<void> {
    if (this.marketsReloadPromise) return this.marketsReloadPromise;
    const now = this.clock.now();
    if (now - this.lastMarketsReloadAttemptAt < MARKETS_RELOAD_COOLDOWN_MS) {
      return Promise.resolve();
    }
    this.lastMarketsReloadAttemptAt = now;
    this.marketsReloadPromise = (async (): Promise<void> => {
      try {
        // No cast: loadMarkets(reload?, params?) is declared PUBLIC API on Exchange.d.ts.
        await this.exchange.loadMarkets(true);
      } catch (err) {
        this.logger?.warn(
          `market-stream markets reload failed (fail-open, wedge persists): ${String(err)}`,
        );
      }
    })().finally(() => {
      this.marketsReloadPromise = null;
    });
    return this.marketsReloadPromise;
  }

  // See SUBSCRIBE_LANE_COUNT / SUBSCRIBE_LANE_SPACING_MS. Bounded-concurrency token bucket: the
  // least-loaded lane's slot is claimed synchronously before any await, so concurrent acquirers
  // fan out deterministically (ties break to the lowest lane index); the wait itself runs on wall
  // timers. Fails delayed-never-dropped: the gate only ever awaits a timer, never rejects — a
  // subscription is postponed, at most, never abandoned. The production CLOCK is wall-aligned
  // (SystemClock), so clock.now() and setTimeout share a time base; specs that freeze the clock at
  // 0 still see real gate waits.
  private async subscribeSlot(): Promise<void> {
    const now = this.clock.now();
    let lane = 0;
    for (let i = 1; i < this.laneNextSlotAt.length; i++) {
      if (this.laneNextSlotAt[i]! < this.laneNextSlotAt[lane]!) lane = i;
    }
    const at = Math.max(now, this.laneNextSlotAt[lane]!);
    this.laneNextSlotAt[lane] = at + SUBSCRIBE_LANE_SPACING_MS;
    // Jitter only tops up an ALREADY-paced wait (a lane reused inside its own cadence) — an
    // immediately-free lane (wait 0, e.g. every loop's very first subscribe, or the first
    // SUBSCRIBE_LANE_COUNT acquirers after a shared drop) is a one-off event, not the recurring
    // metronome jitter exists to decorrelate, so it stays instant.
    const baseWait = at - now;
    const wait = baseWait > 0 ? baseWait + this.subscribeJitterFn() : 0;
    if (wait > 0) await new Promise<void>((res) => setTimeout(res, wait));
  }

  private scheduleStaleCheck(symbol: SymbolId, channel: string): void {
    setTimeout(() => {
      if (!this.running) return;
      this.stateTracker.checkStaleness(this.venueId, symbol, channel, STALE_THRESHOLD_MS);
    }, STALE_THRESHOLD_MS);
  }

  private noteYield(symbol: SymbolId, channel: string): void {
    this.lastYieldAt.set(`${symbol}|${channel}`, this.clock.now());
    // A recovered channel does not inherit its pre-recovery backoff — see CHANNEL_BACKOFF_BASE_MS.
    this.channelBackoffMs.delete(`${symbol}|${channel}`);
  }

  // Loop-start registration: anchors the watchdog clock AND creates the tracker's channel entry so
  // a subscription that never delivers a single event is still visible to channelAges()/the
  // staleness gauge (recordEvent alone would only register it on its first successful yield). GAP
  // matches the tracker's default answer for unknown channels, so health readers see no change.
  private seedChannel(symbol: SymbolId, channel: string): void {
    this.noteYield(symbol, channel);
    this.stateTracker.setHealth(this.venueId, symbol, channel, 'GAP');
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.watchdogTick(), WATCHDOG_CHECK_MS);
  }

  // Fails OPEN: the watchdog is a recovery-only device — a broken watchdog must never block or
  // degrade the data path it guards, so every failure inside it is swallowed (logged at warn). Its
  // default action is exchange.close(), which the supervised loops already recover from (pending
  // watch futures reject → handleLoopError → backoff → re-watch = fresh subscription in the common
  // case, or → recreateExchange() in the pinned-ccxt-4.5.58 closedByUser-wedge case — see the header
  // comment). Escalation (below) is the one exception to "close() only, never recreate directly":
  // LIVE INCIDENT 2026-08-06 found close() itself can be a no-op (a never-connected instance's
  // `clients` map is empty, so close() has nothing to close and mints no ExchangeClosedByUser —
  // handleLoopError's recreation branch is then never reached, because it is only ever entered FROM
  // that error). 222 watchdog fires against exactly this wedge produced zero recreations. After
  // WATCHDOG_ZERO_YIELD_ESCALATION_THRESHOLD consecutive ticks that still find the same channels
  // stalled (proof the prior close()/reload attempts yielded no data), the watchdog calls
  // recreateExchange() itself instead of repeating an inert close(). Escalation and close() are
  // ADDITIVE, not exclusive (2026-08-06 adversarial review): recreateExchange() resolves false
  // without acting whenever the existing gated RecreationPolicy declines (cooldown active, cap
  // exhausted, or the factory itself threw — see doRecreateExchange), and a declined escalation must
  // never leave the tick doing strictly nothing — that would be worse than the pre-escalation
  // behavior, which always closed. So a declined recreation falls back to the same close() the
  // else-branch below uses; only a SUCCESSFUL recreation skips it (the swap already forced every
  // pending watch future to reject, so closing the brand-new instance right after would be
  // counter-productive). The whole chain is wrapped in .catch(): doRecreateExchange has code after
  // its own internal try/catch (recordForcedReconnect, the recreation-logged warn, hardDispose's
  // client teardown, logCapExhausted's error log) that can itself reject, and this call sits inside a
  // fire-and-forget `void` — an uncaught rejection here would be an unhandledRejection at the process
  // level (main.ts's handler exits the process), turning a recovery device into a crash vector.
  private watchdogTick(): void {
    try {
      if (!this.running) return;
      const now = this.clock.now();
      if (now - this.lastForcedReconnectAt < WATCHDOG_RECONNECT_COOLDOWN_MS) return;
      const stalled: string[] = [];
      for (const [key, at] of this.lastYieldAt) {
        // Key shape is `${symbol}|${channel}` (noteYield); symbols never contain '|', so the
        // '|candle' probe can only match the channel part.
        const threshold = key.includes('|candle')
          ? WATCHDOG_CANDLE_STALL_THRESHOLD_MS
          : WATCHDOG_STALL_THRESHOLD_MS;
        if (now - at > threshold) stalled.push(key);
      }
      if (stalled.length === 0) {
        this.consecutiveZeroYieldReconnects = 0;
        this.lastStalledKeys = new Set();
        return;
      }
      this.lastForcedReconnectAt = now;
      this.stateTracker.recordForcedReconnect?.();
      // Counts consecutive ticks that find the EXACT SAME channel set stalled, not just "any channel
      // stalled" (2026-08-06 adversarial review): a single permanently-silent (symbol,channel) — a
      // delisted symbol, a thin-tier trade channel — would otherwise keep stalled.length >= 1 on
      // every tick forever, latching the counter above threshold and pinning the watchdog in
      // escalation mode even while every OTHER channel is healthy and recovering normally. Any change
      // in the stalled set (a channel newly joining OR a previously-stalled channel recovering) means
      // this is not "the same incident continuing" and restarts the streak at 1.
      const currentStalled = new Set(stalled);
      const sameChannelsAsLastTick =
        currentStalled.size === this.lastStalledKeys.size &&
        [...currentStalled].every((k) => this.lastStalledKeys.has(k));
      this.consecutiveZeroYieldReconnects = sameChannelsAsLastTick
        ? this.consecutiveZeroYieldReconnects + 1
        : 1;
      this.lastStalledKeys = currentStalled;
      this.logger?.error(
        `market-stream watchdog: channel(s) past stall threshold (${WATCHDOG_STALL_THRESHOLD_MS}ms; ` +
          `candle ${WATCHDOG_CANDLE_STALL_THRESHOLD_MS}ms), forcing reconnect via ` +
          `exchange.close(): ${stalled.join(', ')}`,
      );
      const closeStale = (): Promise<void> =>
        Promise.resolve((this.exchange as unknown as { close(): Promise<void> }).close()).catch(
          (err: unknown) => {
            this.logger?.warn(`market-stream watchdog: close() failed (fail-open): ${String(err)}`);
          },
        );
      if (
        this.consecutiveZeroYieldReconnects >= WATCHDOG_ZERO_YIELD_ESCALATION_THRESHOLD &&
        this.exchangeFactory
      ) {
        this.logger?.error(
          `market-stream watchdog: ${this.consecutiveZeroYieldReconnects} consecutive forced ` +
            `reconnects yielded no data — exchange.close() is inert on this wedge (a ` +
            `never-connected instance has no clients to close, see the pinned-ccxt-4.5.58 header ` +
            `comment), escalating to instance recreation`,
        );
        void this.recreateExchange(this.exchangeFactory)
          .then((recreated) => (recreated ? undefined : closeStale()))
          .catch((err: unknown) => {
            this.logger?.warn(
              `market-stream watchdog: escalated recreation failed (fail-open): ${String(err)}`,
            );
          });
      } else {
        void closeStale();
      }
    } catch (err) {
      this.logger?.warn(`market-stream watchdog: tick failed (fail-open): ${String(err)}`);
    }
  }

  private async backoff(key: string): Promise<void> {
    const current = this.channelBackoffMs.get(key) ?? CHANNEL_BACKOFF_BASE_MS;
    const wait = Math.min(current, CHANNEL_BACKOFF_CAP_MS);
    this.channelBackoffMs.set(key, Math.min(current * 2, CHANNEL_BACKOFF_CAP_MS));
    await new Promise<void>((res) => setTimeout(res, wait));
  }

  /**
   * User-data stream (order fills, balance updates).
   * TODO(Phase 7): implement Binance WS-API userDataStream.subscribe.
   * Returns an empty async iterable that never yields — satisfies the port contract.
   */
  // An empty async generator satisfies the port; Phase 7 implements the real stream.
  async *userEvents(): AsyncIterable<RawUserEvent> {
    // Intentionally empty — Phase 7 implements private user-data streams.
  }
}
