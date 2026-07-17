import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import {
  EXCHANGE_PORT,
  type ExchangePort,
  type AlgoOrderHistoryView,
  type VenueFill,
} from '../../../ports/exchange';
import { EXECUTION_STORE, type ExecutionStorePort } from '../../../ports/execution';
import { reduce, type OrderEvent } from '../../../domain/oms/reducer';
import { isAlgoRailIntent } from '../../../domain/oms/reconcile';
import { clientOrderId, type ClientOrderId, type SymbolId } from '../../../domain/types/ids';
import { price, qty, feeAmount } from '../../../domain/types/money';
import type { OrderIntent } from '../../../domain/types/order-intent';
import type { FillRecord } from '../../../domain/types/exec-report';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';
import { FillIngestorService } from './fill-ingestor.service';

export type AlgoRecoverOutcome = 'triggered' | 'canceled' | 'none' | 'unknown';

// Defect A commit-1 (2026-07-16 phantom perp position): a venue-fired STOP_MARKET spawns a market
// order whose clientOrderId is venue-generated — decodeClientOrderId can't map it, so the fill never
// reaches the OMS through the regular fill path and the local book strands a phantom position. This
// service is the recovery primitive: per algo-rail in-flight intent, ask the venue's algo-history
// rail (never the regular order/trade rail, which has no visibility into it — Push 3 P7a) what
// happened, and fold the answer under the STOP INTENT's OWN local clientOrderId so
// decodeClientOrderId succeeds downstream. Not wired to any caller yet (a later dispatch adds the
// poller hook, the reconciliation position axis, and strategy wiring) — sweep() is dead code until
// then, exercised only by this file's own unit tests.
@Injectable()
export class AlgoStopRecoveryService {
  private readonly log = new Logger('AlgoStopRecovery');

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXCHANGE_PORT) private readonly exchange: ExchangePort,
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    private readonly orders: OrderBookService,
    private readonly portfolio: PortfolioStateService,
    private readonly ingestor: FillIngestorService,
  ) {}

  // True iff a non-terminal order record's in-flight intent rides the algo rail for this symbol —
  // the same isAlgoRailIntent predicate execution-gate/unknown-resolver/boot-recovery already share
  // (domain/oms/reconcile.ts), so this can never classify a rail differently than they do.
  hasLiveAlgoIntent(symbol: SymbolId): boolean {
    return this.liveAlgoIntents(symbol).length > 0;
  }

  private liveAlgoIntents(symbol: SymbolId): readonly OrderIntent[] {
    return this.portfolio
      .snapshot()
      .inFlightIntents.filter((intent) => isAlgoRailIntent(intent) && intent.symbol === symbol);
  }

  // Per-symbol recovery pass. Aggregation priority when a symbol carries more than one live algo
  // intent (rare — normally exactly one resting stop): triggered > canceled > unknown > none, so a
  // single triggered/canceled stop is never masked by a sibling that is still resting.
  async recoverSymbol(symbol: SymbolId): Promise<AlgoRecoverOutcome> {
    const liveIntents = this.liveAlgoIntents(symbol);
    if (liveIntents.length === 0) return 'none';

    let sawTriggered = false;
    let sawCanceled = false;
    let sawUnknown = false;
    for (const intent of liveIntents) {
      let outcome: AlgoRecoverOutcome;
      try {
        outcome = await this.recoverIntent(intent, symbol);
      } catch (err) {
        // Fail OPEN: a per-intent throw never aborts the sweep or folds anything — retried next
        // sweep, exactly like the undefined/UNKNOWN/RESTING branches inside recoverIntent.
        this.log.warn(
          `algo-stop recovery: ${intent.clientOrderId} threw (${err instanceof Error ? err.message : String(err)}) — treated as unknown, retried next sweep`,
        );
        outcome = 'unknown';
      }
      if (outcome === 'triggered') sawTriggered = true;
      else if (outcome === 'canceled') sawCanceled = true;
      else if (outcome === 'unknown') sawUnknown = true;
    }
    if (sawTriggered) return 'triggered';
    if (sawCanceled) return 'canceled';
    if (sawUnknown) return 'unknown';
    return 'none';
  }

  private async recoverIntent(intent: OrderIntent, symbol: SymbolId): Promise<AlgoRecoverOutcome> {
    const clientAlgoId = intent.clientOrderId;

    // Still resting on the algo rail — never touch a live stop.
    const openAlgo = await this.exchange.fetchOpenAlgoOrders?.(symbol);
    if (openAlgo?.some((o) => o.clientAlgoId === clientAlgoId)) return 'none';

    const view = await this.exchange.fetchAlgoOrderStatus?.(clientAlgoId, symbol, intent.createdAt);
    if (view === undefined || view.status === 'UNKNOWN' || view.status === 'RESTING') {
      // Fail OPEN: no fold here — retried next sweep. The position-recon axis (later dispatch) is
      // the fail-closed backstop for a stop that never resolves through this path.
      return 'unknown';
    }

    if (view.status === 'CANCELED' || view.status === 'EXPIRED') {
      await this.foldVenueTerminal(intent, view);
      return 'canceled';
    }

    return this.recoverTriggeredFill(intent, symbol, view);
  }

  // Journal-before-commit (I1), then commit only if the journal accepted the row, then retire the
  // order from in-flight/open — the identical fold shape reconciliation.service.ts's own `fold` uses
  // for venue-adopted terminals, reused here under the algo-history dedupe key instead of
  // `reconcile:{event.type}` (a different venue source, so it needs its own dedupe namespace).
  private async foldVenueTerminal(intent: OrderIntent, view: AlgoOrderHistoryView): Promise<void> {
    const coid = intent.clientOrderId;
    const rec = this.orders.get(coid);
    if (rec === undefined) return; // no local order row to fold onto — write-ahead makes this rare
    const event: OrderEvent =
      view.status === 'CANCELED' ? { type: 'VENUE_CANCELED' } : { type: 'VENUE_EXPIRED' };
    const next = reduce(rec, event);
    const { applied } = await this.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey: `algo-hist:${view.status}:${view.algoId}`,
      event,
      derivedState: next.state,
      cumQty: next.cumQty.toFixed(),
    });
    if (!applied) return;
    this.orders.commit(next);
    this.portfolio.clearInFlight(coid);
    this.portfolio.closeOrder(coid);
  }

  // TRIGGERED: the algo rail fired and spawned a regular-rail market order. fetchMyTrades is the
  // ONLY source for that order's fills (the algo-history row itself carries no price/qty-per-trade
  // detail); we select the trade(s) belonging to the spawned order and ingest each under the STOP
  // INTENT's LOCAL clientOrderId (never the venue-generated spawned id) so decodeClientOrderId and
  // the portfolio's in-flight lookup both succeed downstream.
  private async recoverTriggeredFill(
    intent: OrderIntent,
    symbol: SymbolId,
    view: AlgoOrderHistoryView,
  ): Promise<AlgoRecoverOutcome> {
    const trades = await this.exchange.fetchMyTrades(symbol, intent.createdAt);
    const candidates = this.selectTriggeredTrades(trades, view);
    if (candidates.length === 0) return 'unknown';

    const coid = intent.clientOrderId;
    for (const t of candidates) {
      const rec = this.orders.get(coid);
      // No local row, or already terminal (a prior sweep already retired it) — nothing left to
      // fold; the loop still drains remaining candidates so a later partial isn't skipped by an
      // early exit, but ingest is a no-op without a live record to fold onto.
      if (rec === undefined) continue;
      await this.ingestor.ingest(
        rec,
        this.toFillRecord(t, coid),
        `algo-trig:${t.venueTradeId}`,
        `venue_stop_filled:algoId=${view.algoId}`,
      );
    }
    return 'triggered';
  }

  private selectTriggeredTrades(
    trades: readonly VenueFill[],
    view: AlgoOrderHistoryView,
  ): readonly VenueFill[] {
    // No spawnedOrderId in the venue's answer ⇒ no POSITIVE identification of the spawned order's
    // fills is possible. On a shared wallet, inferring ownership by exclusion can fold a foreign
    // fill onto our intent (adversarial review 2026-07-17) — so return nothing: recovery reports
    // 'unknown' and the debounced position-drift axis HALTs if the divergence persists. A HALT
    // beats a guessed fold on the money path (rule 6 posture).
    if (view.spawnedOrderId === undefined) return [];
    // VenueFill.clientOrderId carries the VENUE order id on this trade shape (see
    // demo-fill-poller's own MATCHING comment) — match it against the spawned order id.
    const spawnedId = clientOrderId(view.spawnedOrderId);
    return trades.filter((t) => t.clientOrderId === spawnedId);
  }

  private toFillRecord(t: VenueFill, coid: ClientOrderId): FillRecord {
    return {
      venue: t.venue,
      symbol: t.symbol,
      venueTradeId: t.venueTradeId,
      clientOrderId: coid,
      price: price(t.price),
      qty: qty(t.qty),
      fee: t.fee ? { ccy: t.fee.ccy, amount: feeAmount(t.fee.amount) } : null,
      liquidity: t.liquidity,
      venueTimestamp: t.venueTimestamp,
      source: 'rest_reconcile',
    };
  }

  // Sweep every symbol with a live algo intent; a per-symbol throw never aborts the others (fail
  // OPEN, mirrors DemoFillPollerService's own per-symbol tolerance).
  async sweep(symbols: readonly SymbolId[]): Promise<void> {
    for (const symbol of symbols) {
      try {
        await this.recoverSymbol(symbol);
      } catch (err) {
        this.log.warn(
          `algo-stop recovery: sweep of ${symbol} threw (${err instanceof Error ? err.message : String(err)}) — skipped, retried next sweep`,
        );
      }
    }
  }
}
