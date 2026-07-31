import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import {
  EXCHANGE_PORT,
  type ExchangePort,
  type AlgoOrderHistoryView,
  type VenueFill,
} from '../../../ports/venue/exchange';
import { EXECUTION_STORE, type ExecutionStorePort } from '../../../ports/trading/execution';
import {
  reduce,
  TERMINAL_ORDER_STATES,
  type OrderEvent,
} from '../../../domain/trading/oms/reducer';
import { isAlgoRailIntent } from '../../../domain/trading/oms/reconcile';
import { clientOrderId, type ClientOrderId, type SymbolId } from '../../../domain/common/types/ids';
import { price, qty, feeAmount } from '../../../domain/common/types/money';
import type { OrderIntent } from '../../../domain/trading/types/order-intent';
import type { FillRecord } from '../../../domain/trading/types/exec-report';
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
  // (domain/trading/oms/reconcile.ts), so this can never classify a rail differently than they do. SYNC
  // (in-flight map only) for callers that cannot await — kept byte-identical; hasAlgoAnchor below is
  // the async superset that also reaches a post-restart, store-only anchor. DemoFillPollerService no
  // longer calls this (it awaits hasAlgoAnchor instead, to reach the same anchor recoverSymbol
  // does) — kept for any future sync-only caller; not dead code, just currently unreferenced outside
  // this file's own tests.
  hasLiveAlgoIntent(symbol: SymbolId): boolean {
    return this.liveAlgoIntents(symbol).length > 0;
  }

  private liveAlgoIntents(symbol: SymbolId): readonly OrderIntent[] {
    return this.portfolio
      .snapshot()
      .inFlightIntents.filter((intent) => isAlgoRailIntent(intent) && intent.symbol === symbol);
  }

  // Async superset of hasLiveAlgoIntent for callers that can await (the poller hook) — true iff
  // candidateAlgoIntents finds an anchor through EITHER source (in-flight or store-rehydrated).
  async hasAlgoAnchor(symbol: SymbolId): Promise<boolean> {
    return (await this.candidateAlgoIntents(symbol)).length > 0;
  }

  // The recovery anchor. P7f(3) boot-recovery seeds every non-terminal order's RECORD into
  // OrderBookService on restart, but does not always rehydrate its intent into the in-flight map
  // (a boot with a persisted order_intents row loadable rehydrates it; one without does not) — so
  // liveAlgoIntents (in-flight only) structurally misses an algo-rail stop that survived a restart,
  // exactly the live phantom's geometry (a HALT's cancel-in-flight race can also leave a resting
  // stop's order NON-terminal with its intent already cleared from in-flight). This widens the
  // anchor to every non-terminal order record, resolving each one's intent from whichever source
  // still has it — in-flight first (the common, same-boot case — free, no I/O), the persisted
  // write-ahead store second (the P7c primitive boot-recovery itself uses to rehydrate). A record
  // whose intent resolves from NEITHER source contributes nothing (we cannot even confirm its
  // symbol) — fail OPEN, dropped from every symbol's candidate set, never surfaced as a false
  // 'unknown'.
  //
  // Discriminator: isAlgoRailIntent (domain/trading/oms/reconcile.ts) gates on intent.triggerPrice, which
  // the Drizzle store never persists (order_intents carries no trigger_price column) or restores
  // (loadIntentForRecovery omits it) — a pre-existing gap out of this change's scope to close via
  // migration. A store-rehydrated intent's triggerPrice is therefore always undefined, so
  // isAlgoRailIntent would silently return false for every DB-backed candidate, defeating this exact
  // path in the demo/live lane it targets. type==='STOP_MARKET' is the schema-safe equivalent:
  // position-sizer.service.ts sets it iff isPerpSignal (spot's trigger variant is STOP_LOSS_LIMIT,
  // never STOP_MARKET) — the same semantic content, sourced from a column the store actually
  // restores (drizzle-execution-store.ts:374 `type: r.type`). On a swap venue this is byte-identical
  // to isAlgoRailIntent's own verdict, so the in-flight (already-triggerPrice-bearing) path is
  // unaffected either way.
  private async candidateAlgoIntents(symbol: SymbolId): Promise<readonly OrderIntent[]> {
    const out: OrderIntent[] = [];
    for (const rec of this.orders.all()) {
      if (TERMINAL_ORDER_STATES.has(rec.state)) continue;
      const intent =
        this.portfolio.inFlightIntent(rec.clientOrderId) ??
        (await this.store.loadIntentByClientOrderId?.(rec.clientOrderId)) ??
        undefined;
      if (intent === undefined || intent.symbol !== symbol || intent.type !== 'STOP_MARKET') {
        continue;
      }
      out.push(intent);
    }
    return out;
  }

  // Per-symbol recovery pass. Aggregation priority when a symbol carries more than one live algo
  // intent (rare — normally exactly one resting stop): triggered > canceled > unknown > none, so a
  // single triggered/canceled stop is never masked by a sibling that is still resting.
  async recoverSymbol(symbol: SymbolId): Promise<AlgoRecoverOutcome> {
    const liveIntents = await this.candidateAlgoIntents(symbol);
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

    // WATCH-V4-10 (2026-07-31): a REJECTED conditional is terminal at the venue with NO fill of its
    // own — the observed shape is a reduce-only stop firing after its position already closed
    // ("Reduce only reject"; demo-fapi algoId 1000000150396877 triggered 4m after HYPE went flat).
    // Before this branch REJECTED normalized to UNKNOWN and fell into the fail-OPEN return above, so
    // nothing could ever retire it and the order sat ACKED across four boots — the WATCH's defect.
    //
    // Failure direction, deliberately SPLIT because this is the money path:
    //   - no spawnedOrderId  ⇒ the venue never created a regular-rail order, so there is provably no
    //     fill to lose. Fold terminal (fail CLOSED on the strand: the order is retired, exposure
    //     released, and the reduce-only stop stops shadowing a position it no longer belongs to).
    //   - spawnedOrderId set ⇒ some quantity MAY have executed before the rejection. Retiring here
    //     would discard that fill from position/cash forever, so fall through to the TRIGGERED path,
    //     which ingests only what fetchMyTrades can positively prove and returns 'unknown' (retry
    //     next sweep, never a guessed fold) when it can prove nothing. Never trade a possible lost
    //     fill for a tidier order book.
    if (view.status === 'REJECTED' && view.spawnedOrderId === undefined) {
      await this.foldVenueTerminal(intent, view);
      return 'canceled';
    }

    return this.recoverTriggeredFill(intent, symbol, view);
  }

  // Journal-before-commit (I1), then commit only if the journal accepted the row, then retire the
  // order from in-flight/open — the identical fold shape reconciliation.service.ts's own `fold` uses
  // for venue-adopted terminals, reused here under the algo-history dedupe key instead of
  // `reconcile:{event.type}` (a different venue source, so it needs its own dedupe namespace).
  //
  // Event mapping: CANCELED ⇒ VENUE_CANCELED, everything else this is called with (EXPIRED, and
  // WATCH-V4-10's REJECTED) ⇒ VENUE_EXPIRED. REJECT is deliberately NOT used — the reducer accepts it
  // only from SUBMITTING/SUBMIT_UNKNOWN, and these orders are ACKED (the venue accepted the
  // conditional; only the order it later spawned was rejected). VENUE_EXPIRED is the honest, legal
  // ACKED-terminal fold for "it ended without filling".
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
    const rec0 = this.orders.get(coid);
    // Absent, or already terminal (a race outside this pass already retired it before the fold
    // started) — nothing to fold onto through the normal reducer path. Fail OPEN: no mutation,
    // retried next sweep; the drift axis stays the fail-closed backstop for a resolution this path
    // cannot complete. Checked ONCE, before the loop — a fold WITHIN this loop legitimately reaching
    // FILLED (multiple trades covering one sweep) must still accept the next trade's fill detail
    // (reduceTerminal's own documented FILLED+FILL fold), so this is not re-checked per iteration.
    if (rec0 === undefined || TERMINAL_ORDER_STATES.has(rec0.state)) return 'unknown';

    // Re-establish the in-flight reservation FillIngestorService.ingest folds position/cash off of
    // (portfolio.inFlightIntent) — a no-op overwrite when intent is already the SAME in-flight
    // object (byte-identical regression for the ordinary same-boot path), and the ONLY way a
    // store-rehydrated (post-restart) intent's fill reaches the portfolio: candidateAlgoIntents can
    // find the intent even when boot recovery never rehydrated it into the in-flight map, but the
    // fold itself still keys off that map. No new state semantics — this is the SAME addInFlight
    // execution-gate/boot-recovery already use for a freshly-placed or freshly-recovered order.
    // wasInFlight records whether WE own this registration, so the cleanup below only ever retires
    // what this call added — an intent already in-flight before we got here (the ordinary same-boot
    // path) is left exactly as its owner (execution-gate / a live sweep) put it.
    const wasInFlight = this.portfolio.inFlightIntent(coid) !== undefined;
    this.portfolio.addInFlight(intent);
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
    const recAfter = this.orders.get(coid);
    // Every candidate this pass was a duplicate (saveFill inserted:false — already ingested through
    // some other path) or otherwise didn't fold: cumQty never advanced past rec0's. The reservation
    // WE added above would otherwise strand an in-flight intent nothing will ever clear (ingest only
    // clears on a TERMINAL fold) — the halt-coordinator treats a stray in-flight registration as
    // symbol-busy, blocking HALT flatten until the next boot. Only unwind what we own; a real,
    // still-progressing fold (cumQty advanced, non-terminal) legitimately stays in-flight for the
    // next sweep, unchanged from before this fix.
    if (
      !wasInFlight &&
      recAfter !== undefined &&
      !TERMINAL_ORDER_STATES.has(recAfter.state) &&
      recAfter.cumQty.eq(rec0.cumQty)
    ) {
      this.portfolio.clearInFlight(coid);
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
