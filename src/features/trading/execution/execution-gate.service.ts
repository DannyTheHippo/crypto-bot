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
import {
  initialOrder,
  TERMINAL_ORDER_STATES,
  type OrderEvent,
  type OrderState,
} from '../../../domain/oms/reducer';
import { isAlgoRailIntent } from '../../../domain/oms/reconcile';
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
// Defect A commit-1 (REJECT venue-reason persistence): caps the raw AdapterError.message folded
// into the REJECT event/persisted reason — ccxt/venue exception text is unbounded and this is an
// audit field, not a truncation-sensitive money value.
const REJECT_MESSAGE_MAX_LEN = 160;

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
    // Push 3 P7f fix 1: an algo-rail order (triggerPrice + swap venue — isAlgoRailIntent) is
    // STRATEGY-managed (manageVenueStopPerp + the plan-stop registry), never regular-OMS-managed —
    // it must NOT join the local open-orders set. fetchOpenOrders/cancelOrder/fetchOrder (the
    // regular rail) can never see it (it lives on fetchOpenAlgoOrders instead), so a registered
    // algo order is invisible to CANCEL_OPEN's target scan and to reconciliation's venue-truth
    // sweep — CANCEL_OPEN would fetchOrder-404 a phantom cancel into a guaranteed false
    // CANCEL_UNKNOWN → RECONCILE_REQUIRED freeze (held reserve), and a HALTING drain would wait on
    // an order that can never confirm cancelled. addInFlight (above) still runs unconditionally —
    // the in-flight reservation is what fix 2's unknown-resolver sync() and the rule-5 60s
    // kill-switch watchdog both key off, and the order ROW/audit trail (orders.create/store.save*)
    // is unaffected — only THIS local open-orders registration is rail-split.
    const finalState = this.orders.get(coid)!.state;
    if (!TERMINAL_ORDER_STATES.has(finalState) && !isAlgoRailIntent(intent)) {
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
      // Boot-recovered orders carry no in-flight intent (it is in-memory), so the symbol falls
      // back to the recovered open-order summary. With neither there is no venue call and the
      // order stays CANCEL_PENDING for reconciliation to adopt venue truth.
      const intent = this.portfolio.inFlightIntent(clientOrderId);
      const symbol =
        intent?.symbol ??
        this.portfolio.snapshot().openOrders.find((o) => o.clientOrderId === clientOrderId)?.symbol;
      if (next.state !== 'CANCEL_PENDING' || symbol === undefined) return;
      try {
        await this.exchange.cancelOrder(clientOrderId, symbol);
      } catch {
        // Refusal or unknown outcome: degrade to CANCEL_UNKNOWN so the resolver's query loop
        // (same-boot orders) or reconciliation's venue-truth adoption (recovered orders) resolves
        // it — never assume the cancel landed. Guarded like the success fold below: a fill racing
        // the await may already have driven the order terminal and retired it (fills win) — a
        // cancel the venue refused because the order just filled is "too late", not an unknown,
        // and folding CANCEL_REJECT_UNKNOWN onto FILLED would freeze it to RECONCILE_REQUIRED in
        // the append-only journal (reviewer must-fix, 2026-07-07).
        if (this.orders.get(clientOrderId)!.state === 'CANCEL_PENDING') {
          const unknown = this.orders.apply(clientOrderId, { type: 'CANCEL_REJECT_UNKNOWN' });
          await this.persistEvent(
            clientOrderId,
            'cancel-unknown',
            { type: 'CANCEL_REJECT_UNKNOWN' },
            unknown.state,
            unknown.cumQty.toFixed(),
            reason,
          );
        }
        return;
      }
      // The REST success return IS the venue's cancel confirmation: outside paper no CANCEL_ACK
      // exec report ever arrives (no user stream), which stranded every demo-venue cancel in
      // CANCEL_PENDING until 2026-07-07. Re-read the state first — a fill may have raced during
      // the await and fills win the cancel race (a full fill is already terminal FILLED).
      if (this.orders.get(clientOrderId)!.state === 'CANCEL_PENDING') {
        const acked = this.orders.apply(clientOrderId, { type: 'CANCEL_ACK' });
        await this.persistEvent(
          clientOrderId,
          'cancel-ack',
          { type: 'CANCEL_ACK' },
          acked.state,
          acked.cumQty.toFixed(),
          reason,
        );
        this.portfolio.clearInFlight(clientOrderId);
        this.portfolio.closeOrder(clientOrderId);
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
      // Defect A commit-1 (REJECT venue-reason persistence): fold the adapter's own code/message
      // onto the REJECT event (additive — reduce() switches on event.type only, see reducer.ts) and
      // into persistEvent's `reason`, so order_events carries WHY the venue refused without an
      // operator cross-referencing a log line. err is guaranteed an AdapterError here — cls is only
      // ever 'TERMINAL_REJECT' when `err instanceof AdapterError` (see the ternary above).
      const rawMessage = err instanceof AdapterError ? err.message : String(err);
      const message =
        rawMessage.length > REJECT_MESSAGE_MAX_LEN
          ? rawMessage.slice(0, REJECT_MESSAGE_MAX_LEN)
          : rawMessage;
      const rejectEvent: OrderEvent = { type: 'REJECT', code, message };
      const rejected = this.orders.apply(coid, rejectEvent);
      await this.persistEvent(
        coid,
        'reject',
        rejectEvent,
        rejected.state,
        rejected.cumQty.toFixed(),
        `${code}:${message}`,
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
      // Push 3 P7a: forward the trigger price so STOP_LOSS_LIMIT/STOP_MARKET intents reach the
      // adapter mapping intact — otherwise the trigger silently drops on the real order path.
      triggerPrice: intent.triggerPrice?.toFixed(),
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
