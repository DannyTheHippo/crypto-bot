import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { SIGNAL_GATEWAY, type SignalGatewayPort } from '../../../ports/risk';
import {
  PORTFOLIO_VIEW,
  EXECUTION_GATE,
  type PortfolioViewPort,
  type ExecutionGatePort,
} from '../../../ports/execution';
import {
  SIGNAL_JOURNAL,
  type SignalSinkPort,
  type SignalJournalPort,
} from '../../../ports/strategy';
import type { Signal } from '../../../domain/types/signal';

// Front-door rejection counter: signals dropped at the gateway (kill-switch/TTL/dedupe) or sizer
// (below-min / no-ref / no-position) before reaching the RiskEngine. These were only journaled to
// the signals table; this exposes them to Prometheus so rejection rates/reasons are graphable over
// time (the risk-engine and execution-gate stages already have their own counters). @Optional so
// the direct-construction unit tests (which omit it) cover the metric-absent branch.
export const SIGNAL_REJECTIONS_COUNTER = makeCounterProvider({
  name: 'signals_rejected_total',
  help: 'Signals rejected before risk evaluation, by front-door stage and reason',
  labelNames: ['stage', 'reason'] as const,
});

// The Strategy→Risk→Execution loop orchestrator (§2, full paper loop). Bound to SIGNAL_SINK,
// so the StrategyHost writes every non-discarded signal straight here: the gateway sizes/vetoes
// against a fresh portfolio snapshot, and an APPROVED/RESIZED decision goes to the execution
// gate. Strategies reach a venue ONLY through this path — never the adapter directly.
@Injectable()
export class SignalSinkService implements SignalSinkPort {
  // Per-(strategyId,symbol) tail promise. Every recordSignal for the same key chains onto the prior
  // one, so individual signals for a key process strictly in arrival order (a cancel recorded before
  // an exit fully completes — venue ack included — before the exit submits). NOTE the guarantee is
  // per-SIGNAL, not per-SEQUENCE: two awaited recordSignal calls from one caller (protective-exit's
  // cancel-then-exit) can have a third caller's signal chain BETWEEN them — e.g. an agentic TP
  // re-placement slotting in after the cancel re-locks base and the exit venue-rejects
  // (TERMINAL_REJECT, retried next protective tick — self-healing, review-assessed). Bounded: an
  // entry is dropped once its chain settles and no later call has re-chained onto it (see the
  // `this.chains.get(key) === tracked` check below).
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(SIGNAL_GATEWAY) private readonly gateway: SignalGatewayPort,
    @Inject(PORTFOLIO_VIEW) private readonly portfolio: PortfolioViewPort,
    @Inject(EXECUTION_GATE) private readonly gate: ExecutionGatePort,
    @Optional() @Inject(SIGNAL_JOURNAL) private readonly journal?: SignalJournalPort,
    @Optional() @InjectMetric('signals_rejected_total') private readonly rejects?: Counter<string>,
  ) {}

  recordSignal(signal: Signal): Promise<void> {
    const key = `${signal.strategyId}:${signal.symbol}`;
    const prior = this.chains.get(key) ?? Promise.resolve();
    const next = prior.then(() => this.processSignal(signal));
    // Stored in the map, never rejects — a rejection here would otherwise wedge every later call
    // queued on this key. The caller's own `next` still rejects/resolves on this signal's outcome.
    const tracked = next.catch(() => undefined);
    this.chains.set(key, tracked);
    void tracked.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    return next;
  }

  private async processSignal(signal: Signal): Promise<void> {
    // CANCEL_OPEN never reaches the gateway/sizer: position-sizer.service.ts maps it to null (no
    // sizing to do), which the gateway would otherwise pass through only to have it land as a benign
    // NO_POSITION reject — noise, not a decision. It is risk-reducing-only (cancel, never place), so
    // it is handled here directly against the execution layer's existing per-order cancel path.
    if (signal.kind === 'CANCEL_OPEN') {
      await this.cancelOpenForSignal(signal);
      return;
    }

    const outcome = this.gateway.accept(signal, this.portfolio.snapshot());
    if (outcome.status !== 'DECIDED') {
      this.journal?.record(signal, `${outcome.status}:${outcome.reason}`);
      this.rejects?.inc({ stage: outcome.status, reason: outcome.reason });
      return;
    }
    const decision = outcome.decision;
    if (decision.verdict === 'APPROVED' || decision.verdict === 'RESIZED') {
      this.journal?.record(signal, decision.verdict, decision.approved.intent.intentId);
      await this.gate.submit(decision.approved);
      return;
    }
    this.journal?.record(signal, decision.verdict); // REJECTED by risk
  }

  // Cancels only the signal's OWN strategy's open orders for the signal's OWN symbol, via
  // ExecutionGatePort.cancel — the same per-order primitive flattenAll/cancelAllFor loop over, so no
  // new venue call is introduced. cancelAllFor(strategyId) is not reused as-is: it is whole-strategy
  // (all symbols), and CANCEL_OPEN is scoped to one symbol only — using it here would risk cancelling
  // the strategy's resting orders on OTHER symbols. Idempotent: no matching open orders ⇒ no-op.
  // signal.cancelSide narrows the cancel to one side (e.g. the S3 protective-exit path clears a
  // resting SELL before its own exit); absent ⇒ both sides, byte-identical to pre-cancelSide behavior.
  private async cancelOpenForSignal(signal: Signal): Promise<void> {
    const toCancel = this.portfolio
      .forStrategy(signal.strategyId)
      .openOrders.filter(
        (o) =>
          o.symbol === signal.symbol &&
          (signal.cancelSide === undefined || o.side === signal.cancelSide),
      );
    for (const o of toCancel) {
      await this.gate.cancel(o.clientOrderId, 'CANCEL_OPEN_SIGNAL');
    }
    this.journal?.record(signal, `CANCEL_OPEN:${toCancel.length}`);
  }
}
