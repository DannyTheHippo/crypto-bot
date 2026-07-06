import { Injectable, OnModuleInit, OnModuleDestroy, Optional, Inject } from '@nestjs/common';
import { InjectMetric, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import Decimal from 'decimal.js';
import { PROMOTION_READINESS, type PromotionReadinessPort } from '../../ports/promotion';

// Mirrors config.module.ts's own isTestOrCi check (no AppConfig field carries this — it's a raw
// process.env boundary check, same as that module and app-config.schema.ts's isTestOrCiEnv).
function isTestOrCiEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' || process.env['NODE_ENV'] === 'ci' || !!process.env['CI']
  );
}

export const PROMOTION_ROUND_TRIPS_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_round_trips',
  help: 'Closed demo round trips counted toward the earned-live promotion gate',
});
export const PROMOTION_NET_PNL_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_net_pnl_usd',
  help: 'Net-of-cost PnL (realized − fees − LLM spend) over the promotion evidence window, USD',
});
export const PROMOTION_LLM_COST_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_llm_cost_usd',
  help: 'LLM spend (decide + reflection tokens, priced) counted against promotion evidence, USD',
});
export const PROMOTION_WINDOW_DAYS_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_window_days',
  help: 'Span (days) between the first and last closed demo round trip in the evidence set',
});
export const PROMOTION_READY_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_ready',
  help: 'Earned-live promotion verdict (1 = permitted, 0 = not permitted)',
});

// Its own slower interval: evaluate() runs full-table DB scans over fills/agent_decisions/
// llm_usage — sampling it in MetricsService's 5s loop would hammer the DB for no benefit (the
// evidence window is measured in days, not seconds).
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class PromotionMetricsService implements OnModuleInit, OnModuleDestroy {
  private sampleInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectMetric('agentic_promotion_round_trips')
    private readonly roundTripsGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_net_pnl_usd')
    private readonly netPnlGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_llm_cost_usd')
    private readonly llmCostGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_window_days')
    private readonly windowDaysGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_ready')
    private readonly readyGauge: Gauge<string>,
    // @Optional: observability must not import mode-control; ModeControlModule is @Global and
    // exports PROMOTION_READINESS, so this binds when the composition root has loaded it and is
    // simply absent (no-op tick) in a standalone observability test harness.
    @Optional()
    @Inject(PROMOTION_READINESS)
    private readonly readiness?: PromotionReadinessPort,
  ) {}

  onModuleInit() {
    // Skip scheduling under test/ci: a 5-minute full-table DB scan has no unit-test value and
    // would otherwise leak a live interval into every suite that imports ObservabilityModule.
    if (isTestOrCiEnv()) return;
    this.sampleInterval = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
  }

  // Extracted so the interval callback never awaits directly (a rejected promise inside a bare
  // setInterval callback becomes an unhandled rejection, not a skipped tick) and so tests can
  // invoke + await a single tick deterministically.
  async tick(): Promise<void> {
    if (this.readiness === undefined) return;
    try {
      const { permitted, evidence } = await this.readiness.evaluate();
      this.roundTripsGauge.set(evidence.roundTrips);
      this.netPnlGauge.set(new Decimal(evidence.netPnl).toNumber());
      this.llmCostGauge.set(new Decimal(evidence.llmCostUsd).toNumber());
      this.windowDaysGauge.set(evidence.windowDays);
      this.readyGauge.set(permitted ? 1 : 0);
    } catch {
      // Fire-and-forget: an evaluate() throw (e.g. a transient DB error) skips this tick rather
      // than crashing the timer or the process.
    }
  }

  onModuleDestroy() {
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
  }
}
