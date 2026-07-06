import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  InjectMetric,
  makeCounterProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { Counter, Histogram } from 'prom-client';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { RISK_SIGNING_KEY } from '../../../ports/risk';
import { MODE_CONTROL, type ModeControlPort } from '../../../ports/mode-control';
import {
  EXCHANGE_PORT,
  AdapterError,
  type ExchangePort,
  type ExchangeAck,
  type PlaceOrderRequest,
} from '../../../ports/exchange';
import {
  EXECUTION_STORE,
  EXEC_RUN_CONTEXT,
  EXEC_FILTERS,
  type ExecutionGatePort,
  type ExecutionStorePort,
  type SubmitAck,
  type ExecRunContext,
  type ExecFilters,
} from '../../../ports/execution';
import { verifyApproval } from '../../../domain/risk/proof';
import { initialOrder, type OrderEvent, type OrderState } from '../../../domain/oms/reducer';
import type { RiskApprovedIntent } from '../../../domain/types/risk-decision';
import type { OrderIntent } from '../../../domain/types/order-intent';
import type { OpenOrderSummary } from '../../../domain/types/portfolio';
import type { ClientOrderId, StrategyId } from '../../../domain/types/ids';
import { NonceLedgerService } from './nonce-ledger.service';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';

// §8 orders_total — outcome counter incremented on every submit() result (SUBMITTED/REJECTED/UNKNOWN).
// @Optional so existing direct-construction unit tests (which omit this param) still compile; the
// counter === undefined branch is covered by those tests.
export const ORDERS_COUNTER = makeCounterProvider({
  name: 'orders_total',
  help: 'Orders submitted through the execution gate, by outcome',
  labelNames: ['outcome'] as const,
});

// §8 orders_rejected_total — incremented on REJECTED outcomes. `stage` is the rejection origin
// (oms = our pre-network gate reject: mode/proof/nonce; exchange = venue TERMINAL_REJECT). Risk-stage
// vetoes are counted by risk_rejections_total in RiskModule (eslint-boundaries forbids features/trading/risk
// importing features/trading/execution, so the taxonomy's risk stage lives in a sibling metric by design).
export const ORDERS_REJECTED_COUNTER = makeCounterProvider({
  name: 'orders_rejected_total',
  help: 'Orders rejected by the execution gate or venue, by stage and reason code',
  labelNames: ['stage', 'code'] as const,
});

// §8 fill-rate numerator/denominator (submitted side) + submit→ack latency. Quantities cross the
// prometheus boundary as numbers (the only sanctioned .toNumber() site). @Optional throughout so the
// direct-construction unit tests cover the metric-absent branch.
export const ORDERS_SUBMITTED_COUNTER = makeCounterProvider({
  name: 'orders_submitted_total',
  help: 'Orders successfully submitted to a venue, by type and time-in-force',
  labelNames: ['type', 'tif'] as const,
});

export const ORDERS_SUBMITTED_QTY_COUNTER = makeCounterProvider({
  name: 'orders_submitted_qty_total',
  help: 'Total submitted quantity, by type and time-in-force (fill-rate denominator)',
  labelNames: ['type', 'tif'] as const,
});

export const ORDER_SUBMIT_LATENCY = makeHistogramProvider({
  name: 'order_submit_latency_seconds',
  help: 'Submit→ack latency in seconds, by venue and order type (§8)',
  labelNames: ['venue', 'type'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const DEFAULT_STEP = '0.00000001';
const TERMINAL_ORDER_STATES: ReadonlySet<OrderState> = new Set([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

// EXECUTION_GATE (§2.4): the sole entry from Risk to a venue. A failed proof refuses before
// any persistence or network call (the order-authorization chokepoint). The write-ahead
// ordering is load-bearing: the order is durably SUBMITTING BEFORE placeOrder, so a crash
// mid-network degrades to SUBMIT_UNKNOWN → query-before-resubmit, never a blind resubmit on
// the deterministic clientOrderId (§6.2 double-exposure).
@Injectable()
export class ExecutionGateService implements ExecutionGatePort {
  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(RISK_SIGNING_KEY) private readonly key: Buffer | string,
    @Inject(EXEC_RUN_CONTEXT) private readonly ctx: ExecRunContext,
    @Inject(EXEC_FILTERS) private readonly filters: ExecFilters,
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    @Inject(EXCHANGE_PORT) private readonly exchange: ExchangePort,
    @Inject(MODE_CONTROL) private readonly modeControl: ModeControlPort,
    private readonly nonces: NonceLedgerService,
    private readonly orders: OrderBookService,
    private readonly portfolio: PortfolioStateService,
    @Optional() @InjectMetric('orders_total') private readonly ordersCounter?: Counter<string>,
    @Optional()
    @InjectMetric('orders_rejected_total')
    private readonly ordersRejectedCounter?: Counter<string>,
    @Optional()
    @InjectMetric('orders_submitted_total')
    private readonly submittedCounter?: Counter<string>,
    @Optional()
    @InjectMetric('orders_submitted_qty_total')
    private readonly submittedQtyCounter?: Counter<string>,
    @Optional()
    @InjectMetric('order_submit_latency_seconds')
    private readonly submitLatency?: Histogram<string>,
  ) {}

  async submit(approved: RiskApprovedIntent): Promise<SubmitAck> {
    const start = this.clock.now();
    const ack = await this.doSubmit(approved);
    this.ordersCounter?.inc({ outcome: ack.outcome });
    if (ack.outcome === 'SUBMITTED') {
      const { type, timeInForce, venue, qty } = approved.intent;
      this.submittedCounter?.inc({ type, tif: timeInForce });
      this.submittedQtyCounter?.inc({ type, tif: timeInForce }, qty.toNumber()); // export boundary
      this.submitLatency?.observe({ venue, type }, (this.clock.now() - start) / 1000);
    }
    return ack; // REJECTED outcomes increment orders_rejected_total{stage,code} at their reject site
  }

  // Centralizes orders_rejected_total emission so the rejection stage (oms vs exchange) is recorded
  // at the site that knows it, rather than re-derived from the reason string in submit().
  private reject(
    coid: ClientOrderId,
    code: string,
    stage: 'oms' | 'exchange',
    state?: OrderState,
  ): SubmitAck {
    this.ordersRejectedCounter?.inc({ stage, code });
    return state !== undefined
      ? { clientOrderId: coid, outcome: 'REJECTED', state, reason: code }
      : { clientOrderId: coid, outcome: 'REJECTED', reason: code };
  }

  private async doSubmit(approved: RiskApprovedIntent): Promise<SubmitAck> {
    const { intent, proof } = approved;
    const coid = intent.clientOrderId;
    const now = this.clock.now();

    // §10: a live-stamped intent on a process never authorised for live (boot config ≠ live, which
    // includes every CI/test run) is a forgery or a bug — refuse LOUDLY (throws ModeViolationError,
    // audited by ModeControl), never a quiet SubmitAck. This is the per-submission half of the four
    // live gates; the live adapter is also absent from the object graph in that case.
    this.modeControl.assertCanTrade(intent.mode, intent.intentId);

    // §10.2 per-order mode assert against the CURRENT effective mode (re-resolved each submission):
    // a stale cross-mode intent, or an intent stamped under live that a mid-run downgrade has since
    // dropped to paper, is rejected (not thrown — an operational downgrade, handled gracefully).
    if (intent.mode !== this.modeControl.resolveMode().effective) {
      return this.reject(coid, 'MODE_MISMATCH', 'oms');
    }

    // Verify the proof BEFORE persistence/network. record() burns the nonce only after OK so a
    // forged/expired attempt never blocks a legitimate retry.
    const seen = this.nonces.has(proof.nonce, now);
    const verdict = verifyApproval(approved, this.key, now, seen);
    if (verdict !== 'OK') {
      return this.reject(coid, verdict, 'oms');
    }
    this.nonces.record(proof.nonce, proof.approvedAtMs, proof.ttlMs);

    // Write-ahead: intent + NEW order, then SUBMITTING — all durable before the network call.
    const recNew = initialOrder(coid, intent.qty, this.stepSize(intent.symbol));
    await this.store.saveIntent(intent, proof);
    await this.store.saveNewOrder(recNew, intent);
    this.orders.create(recNew);
    this.portfolio.addInFlight(intent);

    const submitting = this.orders.apply(coid, { type: 'SUBMIT_SENT' });
    await this.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey: 'submit',
      event: { type: 'SUBMIT_SENT' },
      derivedState: submitting.state,
      cumQty: submitting.cumQty.toFixed(),
    });

    let ack: ExchangeAck;
    try {
      ack = await this.exchange.placeOrder(this.toPlaceRequest(intent));
    } catch (err) {
      return this.onPlaceError(coid, err);
    }

    // A fill report may have implicitly acked the order during the await (WS beat REST). Only
    // fold ACK while still SUBMITTING; otherwise record the venueOrderId as metadata
    // (PARTIALLY_FILLED + ACK is an illegal transition by design).
    const current = this.orders.get(coid)!;
    if (current.state === 'SUBMITTING') {
      const acked = this.orders.apply(coid, { type: 'ACK', venueOrderId: ack.venueOrderId });
      await this.store.appendOrderEvent({
        clientOrderId: coid,
        dedupeKey: 'ack',
        event: { type: 'ACK', venueOrderId: ack.venueOrderId },
        derivedState: acked.state,
        cumQty: acked.cumQty.toFixed(),
        venueOrderId: ack.venueOrderId,
      });
    } else {
      this.orders.setVenueOrderId(coid, ack.venueOrderId);
    }
    // A fill delivered during placeOrder (auto-notify: WS beat REST) may have already run the order
    // to a terminal state and retired it (the consumer's FillIngestor clears in-flight + closes the
    // order on terminal). Re-registering it as open would strand a phantom open order no cancel can
    // clear — and a later HALTING drain would never see openOrders empty, forcing a needless
    // cancel-timeout → HALTED_DEGRADED. Only a still-live order joins the open set.
    const finalState = this.orders.get(coid)!.state;
    if (!TERMINAL_ORDER_STATES.has(finalState)) {
      this.portfolio.openOrder(intent.strategyId, this.toOpenSummary(intent));
    }
    return {
      clientOrderId: coid,
      outcome: 'SUBMITTED',
      state: finalState,
      venueOrderId: ack.venueOrderId,
    };
  }

  async cancel(clientOrderId: ClientOrderId, reason: string): Promise<void> {
    const rec = this.orders.get(clientOrderId);
    if (rec === undefined) return;

    if (rec.state === 'NEW') {
      const canceled = this.orders.apply(clientOrderId, { type: 'CANCEL_REQUESTED' }); // local-only
      await this.persistEvent(
        clientOrderId,
        'cancel-local',
        { type: 'CANCEL_REQUESTED' },
        canceled.state,
        canceled.cumQty.toFixed(),
        reason,
      );
      this.portfolio.clearInFlight(clientOrderId);
      this.portfolio.closeOrder(clientOrderId);
      return;
    }

    if (rec.state === 'ACKED' || rec.state === 'PARTIALLY_FILLED' || rec.state === 'SUBMITTING') {
      const next = this.orders.apply(clientOrderId, { type: 'CANCEL_REQUESTED' }); // CANCEL_PENDING or cancelWanted
      await this.persistEvent(
        clientOrderId,
        'cancel-req',
        { type: 'CANCEL_REQUESTED' },
        next.state,
        next.cumQty.toFixed(),
        reason,
      );
      const intent = this.portfolio.inFlightIntent(clientOrderId);
      if (next.state === 'CANCEL_PENDING' && intent !== undefined) {
        try {
          await this.exchange.cancelOrder(clientOrderId, intent.symbol);
        } catch {
          // Cancel ambiguity (CANCEL_UNKNOWN) and its query loop are Phase 6; the CANCEL_ACK
          // otherwise arrives through the outbox and the consumer folds it to CANCELED.
        }
      }
    }
  }

  async cancelAllFor(strategyId: StrategyId): Promise<void> {
    for (const o of this.portfolio.forStrategy(strategyId).openOrders) {
      await this.cancel(o.clientOrderId, 'STRATEGY_DRAIN');
    }
  }

  async flattenAll(reason: string): Promise<void> {
    // Always-allowed risk-reducing action: cancel every known open order. Position flattening
    // is expressed as reduce-only intents through Risk's flatten carve-out (Phase 6).
    for (const o of this.portfolio.snapshot().openOrders) {
      await this.cancel(o.clientOrderId, reason);
    }
  }

  private async onPlaceError(coid: ClientOrderId, err: unknown): Promise<SubmitAck> {
    const cls = err instanceof AdapterError ? err.errorClass : 'OUTCOME_AMBIGUOUS';
    const code = err instanceof AdapterError ? err.code : 'UNKNOWN';
    if (cls === 'TERMINAL_REJECT') {
      const rejected = this.orders.apply(coid, { type: 'REJECT' });
      await this.persistEvent(
        coid,
        'reject',
        { type: 'REJECT' },
        rejected.state,
        rejected.cumQty.toFixed(),
      );
      this.portfolio.clearInFlight(coid);
      return this.reject(coid, code, 'exchange', rejected.state);
    }
    // Everything else is ambiguous: the order may have landed. SUBMIT_UNKNOWN starts a query
    // loop (Phase 6); worst-case exposure stays reserved (in-flight intent retained).
    const unknown = this.orders.apply(coid, { type: 'SUBMIT_AMBIGUOUS' });
    await this.persistEvent(
      coid,
      'submit-ambiguous',
      { type: 'SUBMIT_AMBIGUOUS' },
      unknown.state,
      unknown.cumQty.toFixed(),
    );
    return { clientOrderId: coid, outcome: 'UNKNOWN', state: unknown.state, reason: code };
  }

  private async persistEvent(
    clientOrderId: ClientOrderId,
    dedupeKey: string,
    event: OrderEvent,
    derivedState: OrderState,
    cumQty: string,
    reason?: string,
  ): Promise<void> {
    await this.store.appendOrderEvent({
      clientOrderId,
      dedupeKey,
      event,
      derivedState,
      cumQty,
      reason,
    });
  }

  private stepSize(symbol: OrderIntent['symbol']): string {
    return this.filters.get(symbol)?.stepSize ?? DEFAULT_STEP;
  }

  private toPlaceRequest(intent: OrderIntent): PlaceOrderRequest {
    return {
      clientOrderId: intent.clientOrderId,
      symbol: intent.symbol,
      side: intent.side,
      type: intent.type,
      qty: intent.qty.toFixed(),
      limitPrice: intent.limitPrice?.toFixed(),
      timeInForce: intent.timeInForce,
      reduceOnly: intent.reduceOnly,
    };
  }

  private toOpenSummary(intent: OrderIntent): OpenOrderSummary {
    return {
      clientOrderId: intent.clientOrderId,
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.qty,
      limitPrice: intent.limitPrice,
    };
  }
}
