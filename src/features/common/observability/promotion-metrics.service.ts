import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectMetric, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import Decimal from 'decimal.js';
import { Gauge } from 'prom-client';
import {
  PROMOTION_READINESS,
  type PromotionBlockedReason,
  type PromotionReadinessPort,
} from '../../../ports/trading/promotion';

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
export const PROMOTION_WIN_RATE_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_win_rate',
  help: 'Fraction of closed demo round trips with per-trip net (realized − fees) > 0 over the promotion evidence window (0..1)',
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
// G5 (research/studies/success-exit-2026-07-31.md §9, 2026-08-01): the readiness verdict's `reasons`
// array was previously never exported — every prior pass inferred the binding clause by hand from
// the five numeric gauges above, and that inference already produced one recorded wrong claim
// (entry-rate-rederivation-2026-07-30.md §9). One child per PromotionBlockedReason label, 1 while
// that reason is in the current evaluate() result, 0 otherwise. MEASUREMENT gate, not a permission
// gate: it only mirrors reasons the readiness service already computed and never feeds back into
// evaluate() — so it fails OPEN (a metrics-layer error here can only ever produce a stale/missing
// gauge, never block or alter a promotion verdict). See tick() below for the zero-seed and per-tick
// set that keep "absent" from ever being misread as "clear".
export const PROMOTION_BLOCKED_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_blocked',
  help: 'Which PromotionReadiness reasons are currently blocking the earned-live gate (1 = blocking, 0 = clear), by reason',
  labelNames: ['reason'],
});

// Exhaustive over PromotionBlockedReason (ports/trading/promotion.ts) via `satisfies Record<...,
// true>` — same convention as agent-metrics-recorder.service.ts's AGENT_VENUE_STOP_EVENT_KEYS. A
// ninth reason added to the union without a matching entry here fails typecheck, so the seed below
// can never silently miss a label.
const PROMOTION_BLOCKED_REASON_KEYS = {
  NO_STATS_SOURCE: true,
  UNRESOLVED_FILL: true,
  UNCONVERTIBLE_FEE_ASSET: true,
  INSUFFICIENT_ROUND_TRIPS: true,
  NON_POSITIVE_NET_PNL: true,
  INSUFFICIENT_WINDOW: true,
  FUNDING_DATA_MISSING: true,
  BELOW_PASSIVE_BENCHMARK: true,
} satisfies Record<PromotionBlockedReason, true>;
const ALL_PROMOTION_BLOCKED_REASONS = Object.keys(
  PROMOTION_BLOCKED_REASON_KEYS,
) as readonly PromotionBlockedReason[];

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
    @InjectMetric('agentic_promotion_win_rate')
    private readonly winRateGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_net_pnl_usd')
    private readonly netPnlGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_llm_cost_usd')
    private readonly llmCostGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_window_days')
    private readonly windowDaysGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_ready')
    private readonly readyGauge: Gauge<string>,
    @InjectMetric('agentic_promotion_blocked')
    private readonly blockedGauge: Gauge<string>,
    // @Optional: observability must not import mode-control; ModeControlModule is @Global and
    // exports PROMOTION_READINESS, so this binds when the composition root has loaded it and is
    // simply absent (no-op tick) in a standalone observability test harness.
    @Optional()
    @Inject(PROMOTION_READINESS)
    private readonly readiness?: PromotionReadinessPort,
  ) {
    // G5 zero-seed: materialise every reason label at CONSTRUCTION, not in tick() — so "absent" can
    // never be misread as "clear" even before the first tick runs, before PROMOTION_READINESS is
    // ever bound, or if every subsequent evaluate() throws. Measurement gate, fails OPEN: wrapped so
    // a prom-client error can never block boot (same convention as AgentMetricsRecorder's
    // constructor seeds).
    try {
      for (const reason of ALL_PROMOTION_BLOCKED_REASONS) {
        this.blockedGauge.labels({ reason }).set(0);
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  onModuleInit() {
    // Skip scheduling under test/ci: a 5-minute full-table DB scan has no unit-test value and
    // would otherwise leak a live interval into every suite that imports ObservabilityModule.
    if (isTestOrCiEnv()) return;
    // Sample once at boot so Overview gauges (esp. newly added ones) are not empty for the first
    // SAMPLE_INTERVAL_MS after a redeploy — setInterval alone would delay the first scrape.
    void this.tick();
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
      this.winRateGauge.set(evidence.winRate);
      this.netPnlGauge.set(new Decimal(evidence.netPnl).toNumber());
      this.llmCostGauge.set(new Decimal(evidence.llmCostUsd).toNumber());
      this.windowDaysGauge.set(evidence.windowDays);
      this.readyGauge.set(permitted ? 1 : 0);
      // G5: explicit 1/0 over the WHOLE closed set every tick (not just the reasons that fired) —
      // a reason that cleared since the last tick must drop to 0, not linger absent-from-this-tick
      // at its old value, and a reason never seen this process still reads its constructor-seeded 0
      // rather than nothing.
      for (const reason of ALL_PROMOTION_BLOCKED_REASONS) {
        this.blockedGauge.labels({ reason }).set(evidence.reasons.includes(reason) ? 1 : 0);
      }
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
