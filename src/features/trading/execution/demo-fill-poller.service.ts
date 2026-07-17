import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { EXCHANGE_PORT, type ExchangePort, type VenueFill } from '../../../ports/exchange';
import type { SymbolId, EpochMs, ClientOrderId } from '../../../domain/types/ids';
import { price, qty, feeAmount } from '../../../domain/types/money';
import type { OrderRecord } from '../../../domain/oms/reducer';
import type { FillRecord } from '../../../domain/types/exec-report';
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
@Injectable()
export class DemoFillPollerService {
  private since: EpochMs = 0 as EpochMs;
  private readonly log = new Logger('DemoFillPoller');

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXCHANGE_PORT) private readonly exchange: ExchangePort,
    private readonly orders: OrderBookService,
    private readonly ingestor: FillIngestorService,
    private readonly recovery: AlgoStopRecoveryService,
  ) {}

  // Anchor the sweep window at boot so the first poll never re-ingests historical demo trades.
  init(): void {
    this.since = this.clock.now();
  }

  async poll(symbols: readonly SymbolId[]): Promise<{ ingested: number; skippedUnknown: number }> {
    const byVenueId = new Map<string, OrderRecord>();
    for (const rec of this.orders.all()) {
      if (rec.venueOrderId !== undefined) byVenueId.set(rec.venueOrderId, rec);
    }

    let ingested = 0;
    let skippedUnknown = 0;
    // Advance the sweep watermark to the newest trade seen this poll, so the next fetchMyTrades only
    // pulls trades at/after it instead of re-pulling every post-boot trade each cycle (unbounded work
    // growth). Non-skipping: fetchMyTrades(since) returns ALL trades with ts ≥ since, so every trade
    // ≤ maxTs was already in this fetch; the boundary trade re-fetches inclusively and the ingestor
    // dedupes it on venueTradeId. Includes skipped (foreign/pre-boot) trades — all have ts ≤ now,
    // while our not-yet-placed fills carry future ts, so the watermark can never outrun an own fill.
    let maxTs = this.since;
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
    for (const symbol of symbols) {
      const fills = await this.exchange.fetchMyTrades(symbol, this.since);
      for (const f of fills) {
        if (f.venueTimestamp > maxTs) maxTs = f.venueTimestamp;
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
        const rec = this.orders.get(matched.clientOrderId) ?? matched;
        const { applied } = await this.ingestor.ingest(
          rec,
          this.toFillRecord(f, rec.clientOrderId),
          `poll:${f.venueTradeId}`,
        );
        if (applied) ingested += 1;
      }
    }
    this.since = maxTs;
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
