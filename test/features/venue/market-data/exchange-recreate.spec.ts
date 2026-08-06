import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExchangeClosedByUser, NetworkError, type Ticker, type Exchange } from 'ccxt';
import {
  CcxtExchangeStreamAdapter,
  type WatchSource,
  type ChannelStateTracker,
  type RecreationPolicy,
} from '../../../../src/features/venue/market-data/ccxt-stream.adapter';
import type { ClockPort } from '../../../../src/ports/common/clock';
import { venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';
import type { SubscriptionSpec } from '../../../../src/ports/venue/market-data';

const V = venueId('binance');
const LANE_COUNT = 4; // mirrors SUBSCRIBE_LANE_COUNT — keeps every first subscribe in round 1
const SYM = symbolId('BTC/USDT');
const unused = (): Promise<never> => Promise.reject(new Error('unused'));

// Regression for the 2026-07-19 live incident: a pinned-ccxt-4.5.58 close() left the shared ws
// exchange instance permanently throwing ExchangeClosedByUser on every watch* call — the supervised
// loops error-looped for 50+ minutes with zero market data until a container restart. The fix is a
// single-flight instance-recreation seam (exchangeFactory), triggered from handleLoopError.
//
// v2 regression, same day: deployed into a venue penalty phase, the v1 seam above recreated on
// EVERY wedge with no gate — 36 recreations in ~35 minutes, each leaving its stale instance's ws
// clients (sockets + keepalive timers) undisposed, OOM-crashing the spot lane. Specs (d)-(g) below
// cover the v2 hardening: an escalating recreation cooldown, a hard cap with a loud stop, and a
// hard-dispose of the stale instance that runs even when close() itself rejects.

function makeTracker(): {
  tracker: ChannelStateTracker;
  setHealth: ReturnType<typeof vi.fn>;
  recordForcedReconnect: ReturnType<typeof vi.fn>;
} {
  const setHealth = vi.fn();
  const recordForcedReconnect = vi.fn<() => void>();
  const tracker: ChannelStateTracker = {
    setHealth,
    recordEvent: vi.fn(),
    checkStaleness: vi.fn(),
    recordForcedReconnect,
  };
  return { tracker, setHealth, recordForcedReconnect };
}

// loadMarketsSpy defaults to a resolving fake — doRecreateExchange now awaits fresh.loadMarkets()
// eagerly, before the swap (see the adapter's header comment), so every existing recreation test's
// "healthy fresh instance" case needs a working loadMarkets by default. Spec (h) below overrides it
// to reject, proving the eager-load guard actually blocks a poisoned swap.
function fakeExchange(
  caps: Record<string, boolean>,
  closeSpy = vi.fn(() => Promise.resolve()),
  loadMarketsSpy: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve({})),
) {
  return {
    id: 'binance',
    has: caps,
    close: closeSpy,
    loadMarkets: loadMarketsSpy,
  } as unknown as Exchange;
}

/**
 * A WatchSource whose watchTicker never settles on its own — the caller drives every settlement
 * explicitly via the returned controller. This gives full, deterministic control over BOTH the
 * supervised loop's pacing (nothing advances until the test resolves/rejects it) and the fake
 * clock (advanced separately via vi.advanceTimersByTimeAsync), which is exactly what the v2
 * cooldown/escalation/cap specs need to drive without depending on real elapsed wall time.
 */
function controlledWatchSource(): {
  watchSource: WatchSource;
  waitForCall: () => Promise<{ resolve: (t: Ticker) => void; reject: (e: unknown) => void }>;
} {
  let pending: { resolve: (t: Ticker) => void; reject: (e: unknown) => void } | null = null;
  const watchTicker: WatchSource['watchTicker'] = () =>
    new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  const waitForCall = async (): Promise<{
    resolve: (t: Ticker) => void;
    reject: (e: unknown) => void;
  }> => {
    // Bounded (not a `while` spin) so a real regression — the loop never re-calling watchTicker —
    // fails fast instead of hanging the worker (see the 2026-07-19 OOM postmortem in the sibling
    // spec above: an unbounded wait loop here is exactly that defect class).
    for (let i = 0; i < 50 && !pending; i++) await Promise.resolve();
    if (!pending) throw new Error('watchTicker was not called');
    const call = pending;
    pending = null;
    return call;
  };
  return {
    watchSource: { watchTicker, watchTrades: unused, watchOHLCV: unused, watchOrderBook: unused },
    waitForCall,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CcxtExchangeStreamAdapter exchange recreation (ExchangeClosedByUser wedge)', () => {
  it('recreates exactly once when N loops hit ExchangeClosedByUser simultaneously, and every loop resumes watching on the NEW instance', async () => {
    vi.useFakeTimers();
    const now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    const symbols = Array.from({ length: LANE_COUNT }, (_, i) => symbolId(`SYM${i}/USDT`));
    const staleClose = vi.fn(() => Promise.resolve());
    const staleExchange = fakeExchange({ watchTicker: true }, staleClose);
    const freshExchange = fakeExchange({ watchTicker: true });
    const factory = vi.fn(() => freshExchange);

    // Per-symbol call counting: call 1 (steady state) resolves at once; call 2 is the one every
    // loop is parked on when the wedge hits (collected below and rejected together, in one batch,
    // to mirror the incident shape — every loop failing in the same beat, not staggered); call 3
    // (post-recreation) resolves once, proving the herd landed on the new instance, then PARKS
    // forever (call 4+) — without this the loop free-runs on the synchronously-resolving fake and
    // the iterator's internal buffer grows unbounded once nothing is left to drain it (OOM).
    const callCounts = new Map<string, number>();
    const wedgeRejectors: Array<(err: unknown) => void> = [];
    const postRecreateExchanges: unknown[] = [];
    const watchTicker: WatchSource['watchTicker'] = (exchange, symbol) => {
      const n = (callCounts.get(symbol) ?? 0) + 1;
      callCounts.set(symbol, n);
      if (n === 1) return Promise.resolve({ symbol } as Ticker);
      if (n === 2) return new Promise<Ticker>((_, reject) => wedgeRejectors.push(reject));
      if (n === 3) {
        postRecreateExchanges.push(exchange);
        return Promise.resolve({ symbol } as Ticker);
      }
      return new Promise<never>(() => {}); // park: no runaway loop after the recovery is proven
    };
    const watchSource: WatchSource = {
      watchTicker,
      watchTrades: () => Promise.reject(new Error('unused')),
      watchOHLCV: () => Promise.reject(new Error('unused')),
      watchOrderBook: () => Promise.reject(new Error('unused')),
    };

    const { tracker, recordForcedReconnect } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      staleExchange,
      V,
      tracker,
      undefined,
      () => 0, // zero jitter: deterministic lane-pace assertions
      factory,
    );
    const spec: SubscriptionSpec = { venue: V, symbols, channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // Drain the N steady-state events — every loop's first watch resolves in round 1 (LANE_COUNT
    // acquirers, no wait), so no fake-timer advance is needed here.
    for (let i = 0; i < symbols.length; i++) await iterator.next();

    // Every loop is now parked on its second call; flush a bounded number of microtask ticks so all
    // N register before rejecting them together (single batch — the wedge lands on every loop at
    // once, per the incident). Bounded (not a `while` spin) so a real regression fails fast instead
    // of hanging the worker.
    for (let i = 0; i < 50 && wedgeRejectors.length < symbols.length; i++) await Promise.resolve();
    expect(wedgeRejectors).toHaveLength(symbols.length);
    for (const reject of wedgeRejectors) {
      reject(new ExchangeClosedByUser('binance closedByUser'));
    }

    // The re-watch after recreation still passes through the existing lane pacer (each loop is
    // reclaiming a lane it already used once this run), so it needs the pace wait to elapse.
    await vi.advanceTimersByTimeAsync(1_500);

    expect(factory).toHaveBeenCalledTimes(1); // single-flight: exactly one recreation, not N
    expect(staleClose).toHaveBeenCalledTimes(1); // best-effort close of the wedged instance
    expect(recordForcedReconnect).toHaveBeenCalledTimes(1);
    expect(postRecreateExchanges).toHaveLength(symbols.length);
    for (const ex of postRecreateExchanges) expect(ex).toBe(freshExchange); // re-watch landed on NEW instance

    await iterator.return?.();
  });

  it('recovers from the wedge with every channel watched again — no infinite error loop', async () => {
    vi.useFakeTimers();
    const now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    const staleExchange = fakeExchange({ watchTicker: true });
    const freshExchange = fakeExchange({ watchTicker: true });
    const factory = vi.fn(() => freshExchange);

    let n = 0;
    const watchSource: WatchSource = {
      watchTicker: () => {
        n++;
        if (n === 1) return Promise.resolve({ symbol: 'BTC/USDT' } as Ticker);
        if (n === 2) return Promise.reject(new ExchangeClosedByUser('binance closedByUser'));
        if (n === 3) return Promise.resolve({ symbol: 'BTC/USDT' } as Ticker); // resubscribed, LIVE again
        return new Promise<never>(() => {}); // park — no further churn
      },
      watchTrades: () => Promise.reject(new Error('unused')),
      watchOHLCV: () => Promise.reject(new Error('unused')),
      watchOrderBook: () => Promise.reject(new Error('unused')),
    };

    const { tracker, setHealth } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      staleExchange,
      V,
      tracker,
      undefined,
      () => 0,
      factory,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    const first = await iterator.next();
    if (first.done) throw new Error('expected a ticker event');

    const secondP = iterator.next();
    await vi.advanceTimersByTimeAsync(1_500); // lane-pace wait for the post-recreation re-watch
    const second = await secondP;
    if (second.done) throw new Error('expected the channel to resume yielding after recreation');
    expect(second.value.type).toBe('ticker');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(setHealth).toHaveBeenCalledWith(V, SYM, 'ticker', 'GAP'); // wedge detected → GAP
    // No DEGRADED classification for closedByUser — it takes the dedicated recreation branch, not
    // the generic transient/GAP fallback.
    expect(setHealth).not.toHaveBeenCalledWith(V, SYM, 'ticker', 'DEGRADED');

    await iterator.return?.();
  });

  it('a transient non-closedByUser error still follows the plain re-watch path (no recreation)', async () => {
    vi.useFakeTimers();
    const now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    const close = vi.fn(() => Promise.resolve());
    const exchange = fakeExchange({ watchTicker: true }, close);
    const factory = vi.fn(() => fakeExchange({ watchTicker: true }));

    let n = 0;
    const watchSource: WatchSource = {
      watchTicker: () => {
        n++;
        if (n === 1) return Promise.reject(new NetworkError('socket hiccup'));
        if (n === 2) return Promise.resolve({ symbol: 'BTC/USDT' } as Ticker);
        return new Promise<never>(() => {});
      },
      watchTrades: () => Promise.reject(new Error('unused')),
      watchOHLCV: () => Promise.reject(new Error('unused')),
      watchOrderBook: () => Promise.reject(new Error('unused')),
    };

    const { tracker, setHealth } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      exchange,
      V,
      tracker,
      undefined,
      () => 0,
      factory,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(2_000); // 1s backoff + the subscribe-gate slot
    const first = await pending;
    if (first.done) throw new Error('expected a ticker event');
    expect(first.value.type).toBe('ticker');

    expect(factory).not.toHaveBeenCalled(); // transient error never triggers recreation
    expect(close).not.toHaveBeenCalled();
    expect(setHealth).toHaveBeenCalledWith(V, SYM, 'ticker', 'DEGRADED'); // unchanged transient path

    await iterator.return?.();
  });
});

describe('CcxtExchangeStreamAdapter v2 recreation cooldown/cap (2026-07-19 venue-penalty escalation)', () => {
  // A small, injected RecreationPolicy (see the constructor's last param) — production always uses
  // DEFAULT_RECREATION_POLICY (60s→10min real-world cooldowns); these specs shrink it so escalation
  // and cap-exhaustion are exercised deterministically in a handful of simulated seconds, not the
  // ~65 real-world minutes the default schedule implies.
  const POLICY: RecreationPolicy = {
    cooldownInitialMs: 5_000,
    cooldownMaxMs: 20_000,
    cooldownMultiplier: 2,
    healthyResetMs: 30_000, // strictly > cooldownMaxMs, mirrors DEFAULT_RECREATION_POLICY's own gap
    capPerWindow: 10,
    capWindowMs: 60_000,
  };
  // Generously covers subscribeSlot's lane-pacing wait (<=SUBSCRIBE_LANE_SPACING_MS=1000ms with
  // zero jitter) plus, where applicable, the fixed 1s backoff — a single symbol/channel loop always
  // reuses the same lane, so the settle needed after ANY error path (blocked or a successful
  // recreation) never exceeds roughly 2000ms. Used to let the loop reach its NEXT parked watchTicker
  // call before the test inspects/drives it again; extra idle time beyond that is harmless (the loop
  // just sits parked on the controlled promise — see controlledWatchSource — until the test acts).
  const SETTLE_MS = 2_000;

  it('(d) honors the recreation cooldown — a second wedge inside the window does not recreate', async () => {
    vi.useFakeTimers();
    const clock: ClockPort = { now: () => epochMs(Date.now()) };

    const fresh1 = fakeExchange({ watchTicker: true });
    const factory = vi.fn(() => fresh1);
    const { watchSource, waitForCall } = controlledWatchSource();
    const { tracker } = makeTracker();
    const stale = fakeExchange({ watchTicker: true });
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      undefined,
      () => 0,
      factory,
      POLICY,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // Steady-state first call, then the wedge.
    (await waitForCall()).resolve({ symbol: SYM } as unknown as Ticker);
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser')); // wedge #1
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(factory).toHaveBeenCalledTimes(1); // allowed: no cooldown was active yet

    // Second wedge, well inside the 5s cooldown just armed by recreation #1 (elapsed ~SETTLE_MS
    // (2000ms), far short of cooldownInitialMs (5000ms)).
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser')); // wedge #2
    await vi.advanceTimersByTimeAsync(SETTLE_MS); // let the blocked path's backoff+re-pace settle
    expect(factory).toHaveBeenCalledTimes(1); // still 1: cooldown blocked the recreation attempt
  });

  it('(e) escalates the cooldown while wedges keep recurring, then resets after a healthy gap', async () => {
    vi.useFakeTimers();
    const clock: ClockPort = { now: () => epochMs(Date.now()) };

    // A dedicated, wider-spaced policy than POLICY above — the escalation/reset proof needs three
    // clearly distinguishable boundaries (flat-if-broken vs. escalated vs. reset) with comfortable
    // margins around each, worked out precisely in the elapsed-ms comments below.
    const policy: RecreationPolicy = {
      cooldownInitialMs: 10_000,
      cooldownMaxMs: 40_000,
      cooldownMultiplier: 2,
      healthyResetMs: 60_000, // strictly > cooldownMaxMs
      capPerWindow: 100, // effectively unlimited — this spec isolates escalation, not the cap
      capWindowMs: 3_600_000,
    };
    let factoryCalls = 0;
    const factory = vi.fn(() => {
      factoryCalls += 1;
      return fakeExchange({ watchTicker: true });
    });
    const { watchSource, waitForCall } = controlledWatchSource();
    const { tracker } = makeTracker();
    const stale = fakeExchange({ watchTicker: true });
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      undefined,
      () => 0,
      factory,
      policy,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // E = elapsed ms since the adapter started, tracked in the comments below. Date.now() only
    // moves via the explicit vi.advanceTimersByTimeAsync calls (waitForCall()'s microtask polling
    // never advances the fake clock) — every reject() below fires at exactly the E value the
    // PRECEDING advance landed on (no advance happens between positioning and rejecting), so each
    // wedge is evaluated at a precisely known, deliberately chosen point in the schedule.
    (await waitForCall()).resolve({ symbol: SYM } as unknown as Ticker); // E=0

    // E=0: recreation #1 (no prior recreation, so no escalation check — straight to cooldownInitialMs).
    // cooldown = 10000. nextRecreateAllowedAt (B1) = 10000.
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser'));
    await vi.advanceTimersByTimeAsync(4_000); // E=4000 — settles the post-recreate re-pace
    expect(factoryCalls).toBe(1);

    // E=4000 (< B1=10000): still inside the base cooldown.
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser')); // blocked
    await vi.advanceTimersByTimeAsync(11_000); // E=15000 — settles the blocked path's backoff+re-pace
    expect(factoryCalls).toBe(1); // confirms the E=4000 wedge above was indeed blocked

    // E=15000 (> B1=10000): recreation #2. gap since recreation #1 (15000) < healthyResetMs (60000)
    // → ESCALATE: cooldown = min(10000*2, 40000) = 20000. B2 = 15000+20000 = 35000.
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser'));
    await vi.advanceTimersByTimeAsync(9_000); // E=24000 — settles the post-recreate re-pace
    expect(factoryCalls).toBe(2);

    // E=24000 → advance to E=28000: past the FLAT boundary a non-escalating implementation would
    // use (15000+10000=25000 — proves a flat cooldown would have wrongly allowed this) but still
    // comfortably short of the REAL escalated boundary B2=35000.
    await vi.advanceTimersByTimeAsync(4_000); // E=28000
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser')); // blocked
    await vi.advanceTimersByTimeAsync(9_000); // E=37000 — settles the blocked backoff+re-pace, past B2
    expect(factoryCalls).toBe(2); // proves escalation: the E=28000 wedge was blocked, not allowed

    // E=37000 (> B2=35000): recreation #3. gap since recreation #2 (15000) = 22000 < healthyResetMs
    // (60000) → ESCALATES AGAIN: cooldown = min(20000*2, 40000) = 40000 (capped). B3 = 77000.
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser'));
    await vi.advanceTimersByTimeAsync(4_000); // E=41000 — settles the post-recreate re-pace
    expect(factoryCalls).toBe(3);

    // Sustained healthy gap: strictly longer than healthyResetMs (60000) since recreation #3
    // (E=37000) needs E > 97000. Advance to E=110000 (margin ~13000; also well past B3=77000, so
    // this reject would be ALLOWED even without a reset — the reset itself is proven by the NEXT
    // check, not this one).
    await vi.advanceTimersByTimeAsync(69_000); // E=110000
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser'));
    await vi.advanceTimersByTimeAsync(4_000); // E=114000 — settles the post-recreate re-pace
    expect(factoryCalls).toBe(4); // recreation #4. gap since #3 (73000) >= healthyResetMs (60000) →
    // RESET: cooldown = cooldownInitialMs = 10000. B4 = 110000+10000 = 120000.

    // Discriminate RESET (B4=120000) from "kept escalating, capped at 40000" (110000+40000=150000):
    // E=135000 sits with ~15000ms margin on each side of the two candidate boundaries.
    await vi.advanceTimersByTimeAsync(21_000); // E=135000
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser'));
    await vi.advanceTimersByTimeAsync(4_000); // E=139000 — settle, tidy but not load-bearing here
    expect(factoryCalls).toBe(5); // recreation #5 only happens if the cooldown actually reset to 10000
  });

  it('(f) stops recreating and logs level-50 once the rolling-window cap is exhausted', async () => {
    vi.useFakeTimers();
    const clock: ClockPort = { now: () => epochMs(Date.now()) };
    const capPolicy: RecreationPolicy = {
      cooldownInitialMs: 500,
      cooldownMaxMs: 500,
      cooldownMultiplier: 1, // flat cooldown: isolates the CAP from escalation timing
      healthyResetMs: 100_000,
      capPerWindow: 2,
      capWindowMs: 60_000,
    };
    let factoryCalls = 0;
    const factory = vi.fn(() => {
      factoryCalls += 1;
      return fakeExchange({ watchTicker: true });
    });
    const { watchSource, waitForCall } = controlledWatchSource();
    const { tracker } = makeTracker();
    const stale = fakeExchange({ watchTicker: true });
    const error = vi.fn();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      { warn: vi.fn(), error },
      () => 0,
      factory,
      capPolicy,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // SETTLE_MS (2000ms) alone already exceeds capPolicy's flat 500ms cooldown, so every settle
    // advance below also clears the cooldown gate on its own — isolating what's actually under
    // test here (the CAP) from cooldown timing entirely.
    (await waitForCall()).resolve({ symbol: SYM } as unknown as Ticker);
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser')); // recreation #1
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(factoryCalls).toBe(1);

    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser')); // recreation #2
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(factoryCalls).toBe(2); // capPerWindow reached (2)

    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser')); // 3rd wedge
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(factoryCalls).toBe(2); // BLOCKED: cap exhausted, not a cooldown wait

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('market-stream recreation cap exhausted'),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('awaiting healthcheck restart'));
  });

  it('(g) hard-disposes the stale instance (clears client timers, terminates the socket) even when close() rejects', async () => {
    vi.useFakeTimers();
    const clock: ClockPort = { now: () => epochMs(Date.now()) };

    const clearConnectionTimeout = vi.fn();
    const clearPingInterval = vi.fn();
    const terminate = vi.fn();
    // Shape mirrors ccxt 4.5.58's internals: Exchange.clients is a Record<url, Client>; Client
    // exposes clearConnectionTimeout()/clearPingInterval() (js/src/base/ws/Client.js) and holds the
    // underlying Node `ws` socket at .connection (js/src/base/ws/WsClient.js) — see
    // hardDisposeExchange()'s header comment in the adapter for the exact reach-through.
    const staleClient = {
      clearConnectionTimeout,
      clearPingInterval,
      connection: { terminate },
    };
    const stale = {
      id: 'binance',
      has: { watchTicker: true },
      close: vi.fn(() => Promise.reject(new Error('socket already gone'))), // close() itself rejects
      clients: { 'wss://stream.binance.com/ws': staleClient },
    } as unknown as Exchange;
    const fresh = fakeExchange({ watchTicker: true });
    const factory = vi.fn(() => fresh);
    const { watchSource, waitForCall } = controlledWatchSource();
    const { tracker } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      { warn: vi.fn(), error: vi.fn() },
      () => 0,
      factory,
      POLICY,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    adapter.marketRaw(spec)[Symbol.asyncIterator]();

    (await waitForCall()).resolve({ symbol: SYM } as unknown as Ticker);
    (await waitForCall()).reject(new ExchangeClosedByUser('binance closedByUser'));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(clearConnectionTimeout).toHaveBeenCalledTimes(1);
    expect(clearPingInterval).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect((stale as unknown as { clients: unknown }).clients).toEqual({}); // references dropped
  });

  // LIVE INCIDENT 2026-08-06 (see the adapter's hasNoMarkets header comment): a fresh instance can
  // wedge on its OWN implicit lazy loadMarkets() just as easily as the one it replaced. Swapping it
  // in anyway would hand every supervised loop a poisoned instance immediately after "recovering".
  // doRecreateExchange now awaits fresh.loadMarkets() eagerly, inside the same try as factory(), and
  // never swaps if that rejects — the stale instance is kept, and the very next attempt (paced by
  // the unchanged cooldown/cap) gets a genuinely new instance instead.
  it('(h) does not swap in a freshly-constructed instance whose eager loadMarkets() rejects — the stale instance is kept', async () => {
    vi.useFakeTimers();
    const clock: ClockPort = { now: () => epochMs(Date.now()) };

    const stale = fakeExchange({ watchTicker: true });
    const badFreshLoadMarkets = vi.fn(() => Promise.reject(new Error('exchangeInfo fetch failed')));
    const badFresh = fakeExchange(
      { watchTicker: true },
      vi.fn(() => Promise.resolve()),
      badFreshLoadMarkets,
    );
    const factory = vi.fn(() => badFresh);
    const { tracker } = makeTracker();
    const warn = vi.fn();

    const seenExchanges: unknown[] = [];
    let n = 0;
    const watchSource: WatchSource = {
      watchTicker: (exchange) => {
        seenExchanges.push(exchange);
        n++;
        if (n === 1) return Promise.resolve({ symbol: SYM } as unknown as Ticker);
        if (n === 2) return Promise.reject(new ExchangeClosedByUser('binance closedByUser'));
        if (n === 3) return Promise.resolve({ symbol: SYM } as unknown as Ticker); // retry after the failed recreation attempt
        return new Promise<never>(() => {}); // park — no runaway loop after the assertion is proven
      },
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      { warn, error: vi.fn() },
      () => 0,
      factory,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    const first = await iterator.next();
    if (first.done) throw new Error('expected a ticker event');

    const secondP = iterator.next(); // triggers the wedge, then the failed recreation attempt
    await vi.advanceTimersByTimeAsync(2_000); // 1s backoff (recreation failed) + subscribe-gate slot
    const second = await secondP;
    if (second.done) throw new Error('expected the channel to recover via retry, not recreation');

    expect(factory).toHaveBeenCalledTimes(1); // one attempt, not a retry loop inside doRecreateExchange
    expect(badFreshLoadMarkets).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recreate failed'));
    expect(seenExchanges[2]).toBe(stale); // call #3 (the post-failure retry) landed on the ORIGINAL instance
    expect(seenExchanges).not.toContain(badFresh); // the poisoned instance was never handed to a loop

    await iterator.return?.();
  });
});
