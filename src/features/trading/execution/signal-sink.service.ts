import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { SIGNAL_GATEWAY, type SignalGatewayPort } from '../../../ports/risk';
import {
  PORTFOLIO_VIEW,
  EXECUTION_GATE,
  EXECUTION_STORE,
  type PortfolioViewPort,
  type ExecutionGatePort,
  type ExecutionStorePort,
} from '../../../ports/execution';
import {
  SIGNAL_JOURNAL,
  type SignalSinkPort,
  type SignalJournalPort,
} from '../../../ports/strategy';
import type { Signal } from '../../../domain/types/signal';
import type { ClientOrderId } from '../../../domain/types/ids';
import type { OpenOrderSummary } from '../../../domain/types/portfolio';
import { roleForDedupeKey, type RestingOrderRole } from '../../../domain/oms/resting-order-role';

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
  // per-SIGNAL, not per-SEQUENCE: two SEPARATE awaited recordSignal calls from one caller can still
  // have a third caller's signal chain interleave BETWEEN them — e.g. an agentic TP re-placement
  // slotting in after a cancel and re-locking the base before the paired exit submits. Defect B (#49)
  // fix: ProtectiveExitService.fire() and the agentic stop/max_hold path close this gap for their
  // own cancel-then-exit pairing by riding Signal.cancelBeforeSubmit — the cancel and the exit process
  // inside the SAME processSignal call (one chain entry), so nothing can interleave between them (see
  // processSignal below). The per-SIGNAL caveat above still applies to any caller that splits a
  // multi-step operation across separate recordSignal calls instead. Bounded: an entry is dropped
  // once its chain settles and no later call has re-chained onto it (see the
  // `this.chains.get(key) === tracked` check below).
  private readonly chains = new Map<string, Promise<void>>();
  private readonly log = new Logger(SignalSinkService.name);

  constructor(
    @Inject(SIGNAL_GATEWAY) private readonly gateway: SignalGatewayPort,
    @Inject(PORTFOLIO_VIEW) private readonly portfolio: PortfolioViewPort,
    @Inject(EXECUTION_GATE) private readonly gate: ExecutionGatePort,
    @Optional() @Inject(SIGNAL_JOURNAL) private readonly journal?: SignalJournalPort,
    @Optional() @InjectMetric('signals_rejected_total') private readonly rejects?: Counter<string>,
    // Push 3 P7c: resting-order role resolution for CANCEL_OPEN's cancelRole filter — narrowed to
    // the single read method it actually uses (see roleForOrder). @Optional so every pre-existing
    // direct-construction unit test keeps constructing without it; absent ⇒ every cancelRole lookup
    // resolves 'unknown', which never matches a requested role — a cancelRole-scoped signal becomes
    // a safe no-op (never a side-only cancel it didn't ask for) rather than a silent behavior change.
    @Optional()
    @Inject(EXECUTION_STORE)
    private readonly store?: Pick<ExecutionStorePort, 'loadIntentByClientOrderId'>,
  ) {}

  // Push 3 P7c: shared with AgenticStrategy's own roleForOrder (feature-boundary walls forbid
  // importing one from the other — both call the same pure domain/oms/resting-order-role.ts
  // classifier over their own store lookup). A store failure must never affect trading — fails open
  // to 'unknown', the same as an absent store or a foreign/undecodable order.
  private async roleForOrder(clientOrderId: ClientOrderId): Promise<RestingOrderRole> {
    // Called through the member expression (never destructured into a bare variable first) — a
    // destructured reference loses `this` when invoked, and InMemoryExecutionStore's real
    // implementation reads `this.intents` (a plain-object store double with an arrow-function
    // property, as most unit tests use, would not have surfaced this).
    if (!this.store?.loadIntentByClientOrderId) return 'unknown';
    try {
      const intent = await this.store.loadIntentByClientOrderId(clientOrderId);
      return intent ? roleForDedupeKey(intent.source.dedupeKey) : 'unknown';
    } catch {
      return 'unknown';
    }
  }

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

    // Defect B (#49): a resting venue TP/stop locks the base a full-size exit needs — cancel it
    // FIRST, inside this SAME processSignal call, so no other same-key signal (see the `chains`
    // comment above) can interleave and re-lock the base between the cancel ack and the exit
    // submit below. Failure direction: fails OPEN toward the protective action — a cancel
    // throw/timeout must never block the exit itself (this is a protective/S3 backstop path); if
    // the base is genuinely still locked the venue TERMINAL_REJECTs and the caller's own next
    // tick/bar retries (the exit is reduce-only-sized, so a stale resting order never doubles
    // exposure).
    if (signal.cancelBeforeSubmit) {
      try {
        const count = await this.cancelOrdersForSide(
          signal.strategyId,
          signal.symbol,
          signal.cancelBeforeSubmit.side,
        );
        // Journal under a derived dedupeKey: signalId is `${dedupeKey}:${eventTime}` (a PRIMARY
        // KEY), and this same signal gets its gateway-verdict row below — same key would collide
        // and silently drop the APPROVED+intentId row (adversarial review 2026-07-17). The `:cbe`
        // suffix keeps the cancel step as its own trail row, like the old separate-signal path.
        this.journal?.record(
          { ...signal, dedupeKey: `${signal.dedupeKey}:cbe` },
          `CANCEL_BEFORE_EXIT:${count}`,
        );
      } catch (err) {
        this.log.warn(
          `cancelBeforeSubmit failed ahead of ${signal.kind} for ${signal.strategyId}:${signal.symbol} — exit still submits: ${String(err)}`,
        );
      }
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
  // Push 3 P7c: signal.cancelRole further narrows a cancelSide match to one resting-order role
  // ('vtp'/'vsl', resolved via roleForOrder) — absent ⇒ every side-matching order cancels, BYTE-
  // IDENTICAL to pre-cancelRole behavior (see the CANCEL_OPEN spec pinning this). This is also the
  // deliberate no-role path a cancel-first ahead of a full-size exit takes, so it clears BOTH a
  // resting TP and a resting stop with the ONE signal (see ProtectiveExitService.fire /
  // AgenticStrategy's stop/max_hold exit branch).
  private async cancelOpenForSignal(signal: Signal): Promise<void> {
    const count = await this.cancelOrdersForSide(
      signal.strategyId,
      signal.symbol,
      signal.cancelSide,
      signal.cancelRole,
    );
    this.journal?.record(signal, `CANCEL_OPEN:${count}`);
  }

  // Shared cancel primitive behind both the standalone CANCEL_OPEN signal path above and the
  // compound cancelBeforeSubmit path in processSignal (Defect B #49) — side undefined ⇒ both sides
  // (today's CANCEL_OPEN default-scope behavior, unchanged); cancelBeforeSubmit always passes a
  // concrete side. Returns the cancelled count so each caller can journal its own outcome string.
  private async cancelOrdersForSide(
    strategyId: Signal['strategyId'],
    symbol: Signal['symbol'],
    side: 'BUY' | 'SELL' | undefined,
    cancelRole?: 'vtp' | 'vsl',
  ): Promise<number> {
    const bySide = this.portfolio
      .forStrategy(strategyId)
      .openOrders.filter((o) => o.symbol === symbol && (side === undefined || o.side === side));
    const toCancel: OpenOrderSummary[] = [];
    for (const o of bySide) {
      if (cancelRole === undefined || (await this.roleForOrder(o.clientOrderId)) === cancelRole) {
        toCancel.push(o);
      }
    }
    for (const o of toCancel) {
      await this.gate.cancel(o.clientOrderId, 'CANCEL_OPEN_SIGNAL');
    }
    return toCancel.length;
  }
}
