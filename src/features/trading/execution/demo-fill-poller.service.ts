import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import {
  EXCHANGE_PORT,
  VENUE_EXCHANGE_PORTS,
  type ExchangePort,
  type VenueFill,
} from '../../../ports/venue/exchange';
import {
  EXECUTION_STORE,
  VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS,
  type ExecutionStorePort,
} from '../../../ports/trading/execution';
import type { SymbolId, EpochMs, ClientOrderId, VenueId } from '../../../domain/common/types/ids';
import { price, qty, feeAmount } from '../../../domain/common/types/money';
import type { OrderRecord } from '../../../domain/trading/oms/reducer';
import type { FillRecord } from '../../../domain/trading/types/exec-report';
import { OrderBookService } from './order-book.service';
import { FillIngestorService } from './fill-ingestor.service';
import { AlgoStopRecoveryService } from './algo-stop-recovery.service';

// Demo/testnet fill discovery without the WS user stream (deferred). The CcxtExchangeAdapter places
// orders on the venue but does not push fills to the outbox; this poller sweeps fetchMyTrades since
// boot and routes each of OUR fills through the shared FillIngestor (idempotent on venueTradeId), so
// a resting demo order that fills lands in the portfolio.
//
// MATCHING: ccxt's unified trade carries `order` = the VENUE order id (Binance has no clientOrderId
// on myTrades), which normalizeTrade surfaces as VenueFill.clientOrderId. So a fill is matched to a
// local order by the venueOrderId recorded on the ACK — NOT by the cb-prefix clientOrderId (that
// check would reject our own fills, whose field holds a numeric venue id). The fill is then ingested
// under the LOCAL clientOrderId so the OMS/portfolio key is correct.
//
// It is deliberately NARROWER than the full ReconciliationService: against a SHARED real demo account
// the in-memory portfolio cannot mirror pre-existing multi-asset balances, so reconciliation's
// balance axis would HALT spuriously — the reconciliation logic stays intact and tested, but the
// testnet runtime drives this fill-only path. The boot checkpoint bounds the sweep to post-boot
// trades so historical demo fills are not re-ingested; a fill with no matching local order is counted
// and skipped, never a halt.
//
// v3 §1.5: poll(venue, symbols) — one call per venue, each symbol tracking its OWN sweep watermark
// off the shared boot anchor (a spot-heavy poll advancing the watermark must never starve the perp
// venue's own since-window, and vice versa; per-symbol keying carries that same isolation down to
// each symbol — see the watermark key below). The exchange port for `venue` is resolved from
// VENUE_EXCHANGE_PORTS when present; the single EXCHANGE_PORT injection is the fallback (matched by
// .venue) so pre-existing single-venue construction (this file's own spec, module-isolation boots)
// is unaffected when the venue map is absent.

// How far BEFORE the stored high-water mark each sweep re-reads. Same magnitude as
// ReconciliationService's own trade-sweep overlap (ReconConfig.overlapMs in execution.module.ts's
// DEFAULT_RECON_CONFIG, applied at reconciliation.service.ts:1235).
//
// WHY 300s, stated no wider than the evidence supports: the 2026-08-11 recovery below bounds the
// observed venue visibility lag at ~42.5s, which is a floor on what the window must cover, not a
// measurement of what it should be. The binding constraint is the other end — any overlap at or below
// VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS (60_000) would re-expose the future-stamp pin this file already
// clamps for, since a trade stamped up to a minute ahead can sit inside the window it defines. So the
// defensible range STARTS above 60s; 300s takes ~7x headroom over the worst lag actually seen, at a
// steady-state cost measured at zero extra REST calls (the page is fetched either way) and, at
// observed density, ~18 extra rows and indexed SELECTs per symbol per poll. It is not a deploy knob:
// the poller injects no config, and widening its constructor for one constant buys nothing.
//
// FAILURE DIRECTION — this is a recovery/healing read, so it fails OPEN toward re-reading MORE. The
// routine cost of an over-wide window is nil: a re-read trade is filtered by hasFill below, or (with
// no store bound) deduped by FillIngestor on venueTradeId — no fold, no journal, no double count.
//
// The real worst case is NOT harmless re-reading, and saying so would repeat the exact error this
// change exists to correct. It is LOSS OF FORWARD PROGRESS: the venue answers fetchMyTrades with a
// bounded page (VENUE_TRADE_PAGE_LIMIT below), oldest-first from `since`, so if the overlap window
// ALONE holds a full page, every returned row sits at or below the mark, the watermark writes back
// unchanged, and the next poll issues the identical request forever — no trade past the mark is ever
// seen again. Pre-fix that was structurally impossible (`since` was the frontier, so the page always
// started there and the mark always advanced off the last row); the overlap is what makes progress
// conditional, so the overlap is what has to carry the guard for it — see the saturation check in
// poll(), which restores a frontier read for one poll whenever that shape is observed.
//
// The window is otherwise bounded on both ends — floored (never read before boot, nor past the
// lookback floor below) and anchored to a high-water mark the write guard keeps monotone — so "more"
// can never become unbounded re-read growth. NOT self-sufficient across a restart, and not claimed to
// be: init() re-anchors bootAnchor and clears sinceByKey, so a pre-restart trade first revealed
// post-restart is below the new anchor and unreachable to this poller at ANY overlap width.
// Reconciliation's cold-checkpoint lookback floor is what covers that case.
export const SWEEP_OVERLAP_MS = 300_000;

// Rolling floor under `since`, mirroring reconciliation.service.ts's MAX_TRADE_LOOKBACK_MS (:1213)
// and its use at :1228-1231. NOT interchangeable with bootAnchor, which is static: on a perp symbol
// that stays quiet for more than a week, `since` would go >7d stale and ccxt derives an endTime IN
// THE PAST from it — node_modules/ccxt/js/src/binance.js:8261-8266 sets
// endTime = min(startTime + 7d, now) whenever (now - startTime) >= 7d, endTime is absent and
// market['linear'] (ccxt-exchange.adapter.ts:215 passes neither `limit` nor `endTime`, so the branch
// is live for every perp symbol). The venue then answers with silence, nothing throws, the watermark
// never moves, and that symbol goes permanently blind until restart. 6 days, deliberately inside the
// 7-day cap for the reason reconciliation.service.ts:1202-1207 spells out: at exactly 7d the derived
// endTime lands on a `now` computed a round trip earlier, and any skew truncates the newest trades.
//
// FAILURE DIRECTION — a detection floor, so it fails toward sweeping MORE: it only ever RAISES a
// `since` the venue would answer with silence, never lowers one, and a fresh watermark keeps its
// narrow window untouched (it loses the Math.max).
const MAX_TRADE_LOOKBACK_MS = 6 * 86_400_000;

// Binance's default myTrades page size. ccxt-exchange.adapter.ts:215 calls fetchMyTrades with
// `limit` undefined, so ccxt omits request['limit'] and the venue applies its own default, filling
// the page oldest-first from `since` — which is what makes a saturated overlap window able to hide
// the frontier entirely (see SWEEP_OVERLAP_MS's failure direction). Compared with `>=` because a
// venue is free to answer with less, never with more.
const VENUE_TRADE_PAGE_LIMIT = 500;

@Injectable()
export class DemoFillPollerService {
  private bootAnchor: EpochMs = 0 as EpochMs;
  // Keyed `${venue}|${symbol}` — matches reconcileTrades in reconciliation.service.ts.
  private readonly sinceByKey = new Map<string, EpochMs>();
  // Keys whose NEXT poll reads from the frontier instead of the overlap — the forward-progress
  // escape hatch, armed by the saturation check in poll() and consumed there on the next pass.
  private readonly skipOverlapOnce = new Set<string>();
  private readonly log = new Logger('DemoFillPoller');

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXCHANGE_PORT) private readonly exchange: ExchangePort,
    private readonly orders: OrderBookService,
    private readonly ingestor: FillIngestorService,
    private readonly recovery: AlgoStopRecoveryService,
    @Optional()
    @Inject(VENUE_EXCHANGE_PORTS)
    private readonly venuePorts?: ReadonlyMap<VenueId, ExchangePort>,
    // Appended last, after every pre-existing constructor param, so no positional construction site
    // (this file's own spec, test/paper/demo-loop.spec.ts, module-isolation boot specs) needs
    // updating — @Optional, the same convention as ReconciliationService's own counters.
    @Optional()
    @InjectMetric('demo_fill_poller_overlap_recovered_total')
    private readonly overlapRecoveredCounter?: Counter<string>,
    // Read-only, for the already-ingested pre-filter below — the overlap re-presents each trade to
    // every poll inside the window, and without this filter each one re-enters FillIngestor.saveFill
    // (a write, and the payload-comparison path whose `conflict` engages the KILL SWITCH) ~30 times
    // instead of once. @Optional and appended last: absent, the poll behaves exactly as before.
    @Optional()
    @Inject(EXECUTION_STORE)
    private readonly store?: ExecutionStorePort,
  ) {}

  // Anchor the sweep window at boot so the first poll never re-ingests historical demo trades.
  init(): void {
    this.bootAnchor = this.clock.now();
    this.sinceByKey.clear();
    this.skipOverlapOnce.clear();
  }

  async poll(
    venue: VenueId,
    symbols: readonly SymbolId[],
  ): Promise<{ ingested: number; skippedUnknown: number }> {
    const exchange =
      this.venuePorts?.get(venue) ?? (venue === this.exchange.venue ? this.exchange : undefined);
    if (exchange === undefined) {
      this.log.error(`no exchange port available for venue "${venue}" — skipping this poll`);
      return { ingested: 0, skippedUnknown: 0 };
    }
    const byVenueId = new Map<string, OrderRecord>();
    for (const rec of this.orders.all()) {
      if (rec.venueOrderId !== undefined) byVenueId.set(rec.venueOrderId, rec);
    }

    let ingested = 0;
    let skippedUnknown = 0;
    // Defect A commit-1: a fill matching no local order, on a symbol carrying an algo-rail anchor,
    // is the phantom-position signature (a venue-fired stop's spawned market order is
    // venue-generated and unmappable by clientOrderId — see this class's own MATCHING comment).
    // hasAlgoAnchor does store I/O (candidateAlgoIntents scans every non-terminal order, resolving
    // each one's intent) — NOT cheap, so it is computed ONCE PER SYMBOL here, before the fill loop,
    // rather than once per unmatched fill (a busy shared-wallet symbol can see many unmatched fills
    // in one poll). Wrapped fail OPEN per symbol: a store hiccup must never abort the poll — treated
    // as not-anchored THIS pass only, matching this file's existing per-symbol tolerance (the
    // recoverSymbol throw-catch below).
    const anchoredSymbols = new Set<SymbolId>();
    for (const symbol of symbols) {
      try {
        if (await this.recovery.hasAlgoAnchor(symbol)) anchoredSymbols.add(symbol);
      } catch (err) {
        this.log.warn(
          `algo-stop anchor check for ${symbol} threw (${err instanceof Error ? err.message : String(err)}) — treated as not-anchored this poll`,
        );
      }
    }
    const algoSuspects = new Set<SymbolId>();
    // LIVE INCIDENT 2026-08-05/06: binanceusdm's userTrades endpoint threw ExchangeNotAvailable on
    // ~29% of calls for ~10.7h; with fetchMyTrades unguarded here, ANY one symbol's throw aborted
    // this whole venue poll — including the algoSuspects -> recovery.recoverSymbol() loop below,
    // this poller's only periodic trigger for AlgoStopRecoveryService — so a venue-fired stop's fill
    // went un-ingested for hours while the position sat phantom. Per-symbol isolation mirrors the
    // anchoredSymbols loop directly above and ReconciliationService.reconcileTrades' own catch, which
    // survived the identical outage. Fail OPEN on the poll itself: one symbol's outage must never
    // starve every other symbol's fills or recovery pass.
    // WATERMARK KEY: `${venue}|${symbol}` (matches reconcileTrades in reconciliation.service.ts), not
    // per-venue — a per-venue watermark lets one persistently-failing symbol pin every other symbol's
    // `since` at its own failure point, and the resulting unbounded re-read window silently truncates
    // at either of two venue-side ceilings that never throw: Binance's myTrades page default of 500
    // rows (ccxt-exchange.adapter.ts:215 calls fetchMyTrades with no explicit `limit`), and the perp
    // endpoint's 7-day `endTime` window, which ccxt derives client-side and returns EMPTY once `since`
    // is more than 7 days stale (reconciliation.service.ts's #54 pattern). Per-symbol keying bounds
    // the hold to the symbol that is actually broken.
    for (const symbol of symbols) {
      const key = `${venue}|${symbol}`;
      // READ-SIDE OVERLAP, WRITE-SIDE HIGH-WATER: the fetch starts SWEEP_OVERLAP_MS before the stored
      // mark (mirroring reconciliation.service.ts:1235's
      // `Math.max(checkpoint - cfg.overlapMs, lookbackFloor)` — both operands, floor included), while
      // `highWater` remains the mark this poll started from. Floored at bootAnchor so the overlap can
      // never pull the sweep into pre-boot history the boot checkpoint exists to exclude, and at the
      // rolling lookback floor so a long-quiet symbol's `since` can never go stale enough for ccxt to
      // derive a past endTime from it (see MAX_TRADE_LOOKBACK_MS).
      const highWater = this.sinceByKey.get(key) ?? this.bootAnchor;
      // Dropped to 0 for exactly one poll when the previous one saturated its page inside the overlap
      // window (see the saturation check below) — consumed on read, so the window is back next poll.
      const overlap = this.skipOverlapOnce.delete(key) ? 0 : SWEEP_OVERLAP_MS;
      const floor = Math.max(this.bootAnchor, this.clock.now() - MAX_TRADE_LOOKBACK_MS);
      const since = Math.max(highWater - overlap, floor) as EpochMs;
      // Seeded at 0 on every polled key: prom-client materialises a labeled child only when touched,
      // so a key whose overlap has never recovered anything would otherwise export NO series — an
      // empty vector indistinguishable from unbound telemetry, which makes a later "this series reads
      // 0" a void read rather than a real negative (the Pass 47/49/50 defect in
      // reconciliation.service.ts / recovery-coordinator.service.ts). Bounded at one series per polled
      // (venue, symbol): the labels come from the loop variables, never from f.symbol.
      this.countOverlapRecovered(venue, symbol, 0);
      let fills: readonly VenueFill[];
      try {
        fills = await exchange.fetchMyTrades(symbol, since);
      } catch (err) {
        this.log.warn(
          `fetchMyTrades for ${symbol} on venue "${venue}" threw (${err instanceof Error ? err.message : String(err)}) — skipping this symbol, retried next poll`,
        );
        continue; // this symbol's watermark is untouched; every other symbol's key advances independently
      }
      // Advance THIS symbol's watermark to the newest trade seen this poll, so the next fetchMyTrades
      // only pulls trades at/after it (minus the overlap above) instead of re-pulling every post-boot
      // trade each cycle (unbounded work growth). Includes skipped (foreign/pre-boot) trades — all
      // have ts ≤ now, while our not-yet-placed fills carry future ts, so the watermark can never
      // outrun an own fill.
      //
      // THE VENUE IS SKIP-CAPABLE, measured. This block used to claim fetchMyTrades(since) returns
      // ALL trades with ts ≥ since, making a bare watermark non-skipping. FALSIFIED 2026-08-11 on
      // binanceusdm KAITO/USDT:USDT (intent 019ff277-34bd-7b21-a378-dd4d0bf7a4d4): at 20:15:47.418Z
      // one fetch returned trade 56287002 (ts 1786479340803) while WITHHOLDING already-executed
      // trades 56286996–56287001 (ts 1786479338135–1786479340419) that matched the same predicate.
      // The watermark advanced past all six, and the next four polls journalled nothing for them —
      // they were recovered 42s later only by ReconciliationService's independent 300s overlap. That
      // is a second service's configuration, not an interlock this one owns; hence the read-side
      // overlap above. Re-reading is free of side effects because the hasFill pre-filter below (and
      // FillIngestor's own venueTradeId dedupe behind it) folds the boundary trade — and every trade
      // the overlap re-covers — at most once.
      //
      // SEEDED FROM highWater, NOT `since`: `since` is the overlap-REDUCED read position, so seeding
      // from it would write back a lower mark on any poll that returns nothing newer, and the read
      // window would walk backwards by the overlap every cycle — exactly the unbounded re-read growth
      // the watermark exists to prevent.
      //
      // CLAMPED to now + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS (see that constant): the "all have ts ≤
      // now" premise above is the venue's promise, not ours to assume — one unbounded-future stamp
      // would otherwise pin this watermark past every real trade permanently. The trade itself still
      // ingests.
      let maxTs = highWater;
      let clampedTrades = 0;
      let clampedSample: string | undefined;
      for (const f of fills) {
        const ceiling = (this.clock.now() + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS) as EpochMs;
        if (f.venueTimestamp > ceiling) {
          clampedTrades += 1;
          clampedSample ??= `${f.symbol} trade ${f.venueTradeId} ts=${f.venueTimestamp}`;
        }
        const advanceTo = Math.min(f.venueTimestamp, ceiling) as EpochMs;
        if (advanceTo > maxTs) maxTs = advanceTo;
        const matched = byVenueId.get(f.clientOrderId); // f.clientOrderId holds the venue order id (ccxt trade.order)
        if (matched === undefined) {
          skippedUnknown += 1; // a fill with no matching local order (foreign or pre-boot) — never halt here
          if (anchoredSymbols.has(symbol)) algoSuspects.add(symbol);
          continue;
        }
        // Already-ingested pre-filter, mirroring reconciliation.service.ts:1318's own FIRST FILTER and
        // for the same reason: an overlap window re-presents a settled trade to every poll it spans
        // (~30 at a 10s cadence over 300s), and each re-submission would otherwise run saveFill's
        // payload comparison, whose `conflict` arm engages the kill switch. Placed AFTER the
        // byVenueId match, not before it like the reconciler's: an UNMATCHED trade must keep its
        // exact pre-existing path (skippedUnknown + the Defect A algo-suspect trigger above), which a
        // first-position filter would silently suppress once reconciliation had backfilled the fill.
        // Fails OPEN — no store bound, or a store that throws, falls through to ingest(), which is
        // itself idempotent; a filter outage must cost a query, never a fill.
        if (await this.alreadyIngested(f)) continue;
        // Fold from the LIVE book record, never the per-poll snapshot: the snapshot goes stale
        // the moment an earlier fill in this same loop advances the order (2026-07-11: three
        // partials of one order in one poll each folded from cumQty 0, journaling non-monotone
        // FILL events and regressing the book — the venue-FILLED order stranded non-terminal).
        /* v8 ignore next -- the `?? matched` arm is unreachable: OrderBookService keys every record by its own clientOrderId and exposes no delete, so a record returned by all() is always resolvable by get() */
        const rec = this.orders.get(matched.clientOrderId) ?? matched;
        const { applied } = await this.ingestor.ingest(
          rec,
          this.toFillRecord(f, rec.clientOrderId),
          `poll:${f.venueTradeId}`,
        );
        if (applied) {
          ingested += 1;
          // A trade folded from BELOW the mark this poll started from is one the pre-overlap read
          // could never have fetched again, so a non-zero reading means exactly one thing: this
          // overlap recovered a fill the bare watermark had already skipped past. Zero is the
          // expected steady state and a real negative (see the seed above), not evidence of nothing
          // happening. Gated on `applied` so the routine boundary/overlap re-read (already ingested,
          // filtered or deduped) never inflates it.
          if (f.venueTimestamp < highWater) this.countOverlapRecovered(venue, symbol, 1);
        }
      }
      // FORWARD-PROGRESS GUARD. A page returned at/over the venue's ceiling with nothing above the
      // mark means the overlap window ALONE filled the response, so the frontier was never in it —
      // repeat that read and the cursor is wedged for good (SWEEP_OVERLAP_MS's failure direction
      // spells out the shape). Keyed on the SYMPTOM, not on an assumed truncation direction: whether
      // the venue keeps the oldest or the newest rows, "full page, nothing new" is the same wedge and
      // this fires either way; if truncation keeps the newest, maxTs advances and this is silently a
      // no-op. Next poll reads from the frontier instead — FAILS toward the pre-fix behaviour
      // (unconditional progress) for exactly one poll, never toward silence: worst case that one poll
      // sees a narrower window, and the poll after it restores the full overlap behind the new mark.
      // Error level, not warn: the observed peak is 18 rows per (venue, symbol) per 5 minutes, 3.6% of
      // the ceiling, so reaching it at all is a venue-shape event and not routine load.
      //
      // `overlap > 0` first, so the log cannot assert a cause that was not in play: a page already
      // read from the frontier that STILL saturates with nothing new means ≥500 trades share one
      // millisecond, which no cursor-by-timestamp can page past (reconciliation.service.ts has the
      // same floor) — dropping an overlap that is already zero would fix nothing and claim otherwise.
      if (overlap > 0 && fills.length >= VENUE_TRADE_PAGE_LIMIT && maxTs === highWater) {
        this.skipOverlapOnce.add(key);
        this.log.error(
          `venue "${venue}" symbol ${symbol} returned a full ${fills.length}-row page with no trade past ` +
            `watermark ${highWater} — the ${overlap}ms overlap window saturated the page; next poll reads from the watermark`,
        );
      }
      // Guarded, mirroring reconciliation.service.ts:1257: the poller is driven by a bare 10s
      // setInterval with no skipIfBusy (trading-runtime.module.ts), so a poll stalled on one symbol
      // can be overtaken by the next and finish last with a STALER maxTs. An unconditional set would
      // let that write move the mark backwards — harmless in direction (a wider re-read the ingestor
      // dedupes) but it would falsify the monotonicity this file's comments rely on.
      if (maxTs > (this.sinceByKey.get(key) ?? 0)) this.sinceByKey.set(key, maxTs);
      // A venue-stamped future trade is a venue data-integrity event, not routine — logged at error.
      // One line per (venue, symbol) sweep, not per trade: a venue emitting the wrong time UNIT
      // stamps every trade in the batch, and a per-trade line would turn the incident into a log
      // flood that buries itself.
      if (clampedTrades > 0) {
        this.log.error(
          `venue "${venue}" symbol ${symbol} returned ${clampedTrades} trade(s) stamped beyond now+${VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS}ms — ` +
            `sweep watermark clamped to ${maxTs}, fills still ingested (e.g. ${clampedSample})`,
        );
      }
    }
    // Recovered against the intent's OWN createdAt lookback, never this poller's `since` watermark
    // (just advanced above) — the watermark can already sit past the trigger trade, exactly the
    // live phantom's geometry. Fail OPEN: a throw here is retried next poll, never breaks this one.
    for (const symbol of algoSuspects) {
      try {
        await this.recovery.recoverSymbol(symbol);
      } catch (err) {
        this.log.warn(
          `algo-stop recovery: ${symbol} threw (${err instanceof Error ? err.message : String(err)}) — retried next poll`,
        );
      }
    }
    return { ingested, skippedUnknown };
  }

  // Fails OPEN in both arms — no store bound (module-isolation and direct-construction fixtures) or a
  // store that throws answers "not ingested", and the trade goes to the ingestor, which dedupes on
  // venueTradeId anyway. This filter exists to spare the write path, never to gate it.
  private async alreadyIngested(f: VenueFill): Promise<boolean> {
    if (this.store === undefined) return false;
    try {
      return await this.store.hasFill(f.venue, f.symbol, f.venueTradeId);
    } catch (err) {
      this.log.warn(
        `hasFill lookup for trade ${f.venueTradeId} threw (${err instanceof Error ? err.message : String(err)}) — ingesting anyway, the ingestor dedupes`,
      );
      return false;
    }
  }

  private countOverlapRecovered(venue: VenueId, symbol: SymbolId, by: number): void {
    try {
      this.overlapRecoveredCounter?.inc({ venue, symbol }, by);
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  private toFillRecord(f: VenueFill, coid: ClientOrderId): FillRecord {
    return {
      venue: f.venue,
      symbol: f.symbol,
      venueTradeId: f.venueTradeId,
      clientOrderId: coid,
      price: price(f.price),
      qty: qty(f.qty),
      fee: f.fee ? { ccy: f.fee.ccy, amount: feeAmount(f.fee.amount) } : null,
      liquidity: f.liquidity,
      venueTimestamp: f.venueTimestamp,
      source: 'rest_reconcile',
    };
  }
}

// §8-style visibility mirror (RECON_MISMATCH_COUNTER/RECOVERY_AUTO_RESUME_COUNTER's own convention: a
// counter defined next to its owning service, NOT in features/common/observability — execution cannot
// import that feature, eslint-plugin-boundaries' features/*/* wall). Registers to the default
// prom-client registry that /metrics scrapes; @Optional above so a directly-constructed unit test need
// not supply it. A non-zero series is a fill the pre-overlap cursor would have lost outright, so this
// is an expected-POSITIVE signal on the demo venues, not an error counter — it stays 0 only while the
// venue never withholds an older trade (the 2026-08-11 KAITO shape). The pass that shipped this fix
// files the WATCH row that reads it; this comment describes the series, and deliberately does not
// assert a reader it cannot see from here.
export const DEMO_FILL_OVERLAP_RECOVERED_COUNTER = makeCounterProvider({
  name: 'demo_fill_poller_overlap_recovered_total',
  help: 'Fills ingested by the sweep overlap from BELOW the poll-start high-water mark — trades the bare watermark had already skipped (2026-08-11 KAITO incident)',
  labelNames: ['venue', 'symbol'] as const,
});
