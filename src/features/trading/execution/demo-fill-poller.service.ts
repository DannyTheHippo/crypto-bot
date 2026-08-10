import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import {
  EXCHANGE_PORT,
  VENUE_EXCHANGE_PORTS,
  type ExchangePort,
  type VenueFill,
} from '../../../ports/venue/exchange';
import { VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS } from '../../../ports/trading/execution';
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
@Injectable()
export class DemoFillPollerService {
  private bootAnchor: EpochMs = 0 as EpochMs;
  // Keyed `${venue}|${symbol}` — matches reconcileTrades in reconciliation.service.ts.
  private readonly sinceByKey = new Map<string, EpochMs>();
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
  ) {}

  // Anchor the sweep window at boot so the first poll never re-ingests historical demo trades.
  init(): void {
    this.bootAnchor = this.clock.now();
    this.sinceByKey.clear();
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
      const since = this.sinceByKey.get(key) ?? this.bootAnchor;
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
      // only pulls trades at/after it instead of re-pulling every post-boot trade each cycle
      // (unbounded work growth). Non-skipping: fetchMyTrades(since) returns ALL trades with ts ≥
      // since, so every trade ≤ maxTs was already in this fetch; the boundary trade re-fetches
      // inclusively and the ingestor dedupes it on venueTradeId. Includes skipped (foreign/pre-boot)
      // trades — all have ts ≤ now, while our not-yet-placed fills carry future ts, so the watermark
      // can never outrun an own fill.
      //
      // CLAMPED to now + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS (see that constant): the "all have ts ≤
      // now" premise above is the venue's promise, not ours to assume — one unbounded-future stamp
      // would otherwise pin this watermark past every real trade permanently. The trade itself still
      // ingests.
      let maxTs = since;
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
        if (applied) ingested += 1;
      }
      this.sinceByKey.set(key, maxTs);
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
