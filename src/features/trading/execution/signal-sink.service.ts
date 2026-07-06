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
  constructor(
    @Inject(SIGNAL_GATEWAY) private readonly gateway: SignalGatewayPort,
    @Inject(PORTFOLIO_VIEW) private readonly portfolio: PortfolioViewPort,
    @Inject(EXECUTION_GATE) private readonly gate: ExecutionGatePort,
    @Optional() @Inject(SIGNAL_JOURNAL) private readonly journal?: SignalJournalPort,
    @Optional() @InjectMetric('signals_rejected_total') private readonly rejects?: Counter<string>,
  ) {}

  async recordSignal(signal: Signal): Promise<void> {
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
}
