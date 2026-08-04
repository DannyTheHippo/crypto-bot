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
// Defect 150 (2026-08-04): llmCostUsd is the largest cost term in netPnl and its read had no upper
// bound at all — the top edge was "whenever the query ran" — so a recorded verdict's cost could not
// be re-derived afterwards even in principle. This publishes the watermark the sum actually covers;
// replaying it as llmTokenTotals' asOfMs, together with the window the verdict publishes, reproduces
// the exact llmCostUsd. Same seconds convention and same 0 = no rows sentinel as the funding
// watermark below (the promotion evidence epoch itself postdates 1970, so 0 is never a real instant).
export const PROMOTION_LLM_COST_COUNTED_THROUGH_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_llm_cost_counted_through_seconds',
  help: 'Unix time of the newest LLM cost row (created_at) covered by the current promotion verdict llmCostUsd; 0 = no rows',
});
export const PROMOTION_WINDOW_DAYS_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_window_days',
  help: 'Span (days) between the first and last closed demo round trip in the evidence set',
});
// Defect 143 (2026-08-04): fundingNet is truncated at whatever the hourly poller had written by
// read time (see PromotionStatsRepository.fundingNetForMode's own comment) — this gauge publishes
// the watermark so the truncation is visible instead of silent; its distance from now() is the
// ingest lag the last verdict could not see. 0 = no funding rows ingested yet (never conflated with
// a real epoch — the promotion evidence epoch itself postdates 1970).
export const PROMOTION_FUNDING_INGESTED_THROUGH_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_funding_ingested_through_seconds',
  help: 'Unix time of the newest funding_payments row (created_at) covered by the current promotion verdict fundingNet; 0 = no rows',
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
// Defect 152 (2026-08-04): the reason label above cannot say WHY it fired. The bound benchmark
// adapter returns its fail-closed CANNOT_COMPUTE sentinel — the STRING 'Infinity'
// (passive-benchmark.repository.ts), not null — whenever it cannot price the window, and
// netPnl.lte(Infinity) is unconditionally true, so a REFUSAL and a genuine lost-to-the-basket
// comparison publish an identical `BELOW_PASSIVE_BENCHMARK 1`. null is a THIRD state (no port bound,
// or no window to price), where the clause is dropped and can never block. Computability is
// therefore NOT `passivePnlQuote === null`: that predicate reports a refusal as a successful
// comparison, i.e. the exact confusion this gauge exists to remove.
export const PROMOTION_PASSIVE_BENCHMARK_STATE_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_passive_benchmark_state',
  help: 'Passive-benchmark measurement state behind the current promotion verdict: COMPUTED, REFUSED (fail-closed CANNOT_COMPUTE sentinel) or UNAVAILABLE (no port bound / no window) — 1 = current state',
  labelNames: ['state'],
});
// The bar netPnl had to clear, published so the reason series is DERIVABLE from outside:
// agentic_promotion_net_pnl_usd <= this ⟺ BELOW_PASSIVE_BENCHMARK is blocking, in every state the
// bound port can produce. +Inf (REFUSED) is an unbeatable bar and -Inf (UNAVAILABLE) is no bar at
// all, which is exactly what the readiness service's own `passivePnlQuote !== null &&
// netPnl.lte(...)` computes; both render as valid Prometheus. Meaningful as a QUANTITY only while
// state="COMPUTED" is 1 — before the first tick this reads its unlabeled-gauge default 0, which the
// state gauge (all three labels still 0) is what distinguishes from a genuine benchmark of zero.
export const PROMOTION_PASSIVE_BENCHMARK_PNL_GAUGE = makeGaugeProvider({
  name: 'agentic_promotion_passive_benchmark_pnl_usd',
  help: 'Passive equal-weight basket PnL over the promotion evidence window, USD — the bar netPnl must exceed; +Inf = benchmark refused (fail-closed), -Inf = no benchmark clause applied',
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

// Closed set, same discipline as the reason keys above: the constructor seed below iterates it, so a
// fourth state cannot be added without also being seeded.
const PASSIVE_BENCHMARK_STATE_KEYS = { COMPUTED: true, REFUSED: true, UNAVAILABLE: true } as const;
type PassiveBenchmarkState = keyof typeof PASSIVE_BENCHMARK_STATE_KEYS;
const ALL_PASSIVE_BENCHMARK_STATES = Object.keys(
  PASSIVE_BENCHMARK_STATE_KEYS,
) as readonly PassiveBenchmarkState[];

// Pure so the mapping is testable without DI. Reads the verdict's own passivePnlQuote exactly as
// PromotionReadinessService.evaluate does — see PROMOTION_PASSIVE_BENCHMARK_STATE_GAUGE above for why
// null means "no clause applied", not "could not compute".
export function passiveBenchmarkReading(passivePnlQuote: string | null): {
  readonly state: PassiveBenchmarkState;
  readonly bar: number;
} {
  if (passivePnlQuote === null) return { state: 'UNAVAILABLE', bar: Number.NEGATIVE_INFINITY };
  const bar = new Decimal(passivePnlQuote).toNumber();
  // Non-finite is the 'Infinity' sentinel, plus — defensively — a NaN some future port could return:
  // prom-client renders NaN as the literal `Nan`, which is INVALID exposition and would break the
  // whole /metrics scrape, so it is normalised onto the fail-closed +Inf instead of published raw.
  if (!Number.isFinite(bar)) return { state: 'REFUSED', bar: Number.POSITIVE_INFINITY };
  return { state: 'COMPUTED', bar };
}

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
    // @Optional for the same reason as the funding watermark below: these are measurement surfaces
    // and MUST fail OPEN — an unresolved metrics provider degrades to a no-op set(), never a DI
    // failure that would block the boot of the very thing it measures. Registration in
    // observability.module.ts is what makes them actually emit; the spec asserts that separately,
    // because an UNREGISTERED gauge publishes nothing and says nothing about it.
    @Optional()
    @InjectMetric('agentic_promotion_llm_cost_counted_through_seconds')
    private readonly llmCostCountedThroughGauge: Gauge<string> | undefined,
    @Optional()
    @InjectMetric('agentic_promotion_passive_benchmark_state')
    private readonly passiveBenchmarkStateGauge: Gauge<string> | undefined,
    @Optional()
    @InjectMetric('agentic_promotion_passive_benchmark_pnl_usd')
    private readonly passiveBenchmarkPnlGauge: Gauge<string> | undefined,
    // @Optional: the provider (PROMOTION_FUNDING_INGESTED_THROUGH_GAUGE) is registered by the
    // composition root alongside the other ten promotion gauges (observability.module.ts); optional
    // here so a caller that has not yet wired the provider degrades to a no-op set() rather than a
    // DI resolution failure at boot (same defensive shape as the readiness port below).
    @Optional()
    @InjectMetric('agentic_promotion_funding_ingested_through_seconds')
    private readonly fundingIngestedThroughGauge: Gauge<string> | undefined,
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
      // Defect 152: same seed for the same reason — a labelled gauge emits NO child series until one
      // is set, so without this the benchmark state would be invisible rather than "not yet sampled"
      // until the first tick. All three at 0 is the honest reading of "no verdict sampled yet", and
      // is distinguishable from every post-tick state (which always has exactly one child at 1).
      for (const state of ALL_PASSIVE_BENCHMARK_STATES) {
        this.passiveBenchmarkStateGauge?.labels({ state }).set(0);
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
      // Defect 150: published in the same synchronous burst as the cost it bounds — a watermark from
      // a different sample than its own cost figure would not re-derive that figure.
      this.llmCostCountedThroughGauge?.set(
        evidence.llmCostCountedThroughMs === null || evidence.llmCostCountedThroughMs === undefined
          ? 0
          : evidence.llmCostCountedThroughMs / 1000,
      );
      this.windowDaysGauge.set(evidence.windowDays);
      // Defect 143: same synchronous tick as every other gauge here (loop-sweep-core.mjs depends on
      // the same-sample invariant across this burst) — publishes the truncation instead of leaving
      // it silent.
      this.fundingIngestedThroughGauge?.set(
        evidence.fundingIngestedThroughMs === null ||
          evidence.fundingIngestedThroughMs === undefined
          ? 0
          : evidence.fundingIngestedThroughMs / 1000,
      );
      // Defect 152: state and bar set together in the same burst, so one scrape can never pair a
      // COMPUTED state with a refusal's bar — the pair is only readable as a pair.
      const benchmark = passiveBenchmarkReading(evidence.passivePnlQuote);
      this.passiveBenchmarkPnlGauge?.set(benchmark.bar);
      for (const state of ALL_PASSIVE_BENCHMARK_STATES) {
        this.passiveBenchmarkStateGauge?.labels({ state }).set(state === benchmark.state ? 1 : 0);
      }
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
