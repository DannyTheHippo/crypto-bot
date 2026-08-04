import { Test, type TestingModule } from '@nestjs/testing';
import { getToken } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';
import { register } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservabilityModule } from '../../../../src/features/common/observability/observability.module';
import {
  PROMOTION_BLOCKED_GAUGE,
  PROMOTION_FUNDING_INGESTED_THROUGH_GAUGE,
  PROMOTION_LLM_COST_COUNTED_THROUGH_GAUGE,
  PROMOTION_LLM_COST_GAUGE,
  PROMOTION_NET_PNL_GAUGE,
  PROMOTION_PASSIVE_BENCHMARK_PNL_GAUGE,
  PROMOTION_PASSIVE_BENCHMARK_STATE_GAUGE,
  PROMOTION_READY_GAUGE,
  PROMOTION_ROUND_TRIPS_GAUGE,
  PROMOTION_WIN_RATE_GAUGE,
  PROMOTION_WINDOW_DAYS_GAUGE,
  PromotionMetricsService,
} from '../../../../src/features/common/observability/promotion-metrics.service';
import {
  PROMOTION_READINESS,
  type PromotionBlockedReason,
  type PromotionReadinessPort,
} from '../../../../src/ports/trading/promotion';

// The full closed set G5's gauge zero-seeds — mirrors PROMOTION_BLOCKED_REASON_KEYS
// (promotion-metrics.service.ts) so a reason added there without being added here fails this file's
// own zero-seed assertion below, not just typecheck.
const ALL_REASONS: readonly PromotionBlockedReason[] = [
  'NO_STATS_SOURCE',
  'UNRESOLVED_FILL',
  'UNCONVERTIBLE_FEE_ASSET',
  'INSUFFICIENT_ROUND_TRIPS',
  'NON_POSITIVE_NET_PNL',
  'INSUFFICIENT_WINDOW',
  'FUNDING_DATA_MISSING',
  'BELOW_PASSIVE_BENCHMARK',
];

// Every gauge PromotionMetricsService publishes. Adding one to the service without adding it here
// leaves it unasserted by the registration tests below — which is the exact silence (#150, #152)
// this file exists to prevent.
const ALL_PROMOTION_GAUGE_NAMES = [
  'agentic_promotion_round_trips',
  'agentic_promotion_win_rate',
  'agentic_promotion_net_pnl_usd',
  'agentic_promotion_llm_cost_usd',
  'agentic_promotion_llm_cost_counted_through_seconds',
  'agentic_promotion_window_days',
  'agentic_promotion_funding_ingested_through_seconds',
  'agentic_promotion_passive_benchmark_state',
  'agentic_promotion_passive_benchmark_pnl_usd',
  'agentic_promotion_ready',
  'agentic_promotion_blocked',
] as const;

// Defect 152: the three states PromotionReadinessService's passivePnlQuote can carry — mirrors
// PASSIVE_BENCHMARK_STATE_KEYS (promotion-metrics.service.ts) for this file's zero-seed assertion.
const ALL_BENCHMARK_STATES = ['COMPUTED', 'REFUSED', 'UNAVAILABLE'] as const;

// The bound adapter's fail-closed CANNOT_COMPUTE sentinel (passive-benchmark.repository.ts) — a
// STRING, deliberately not null, and the reason a refusal is currently indistinguishable from a lost
// comparison on agentic_promotion_blocked alone.
const CANNOT_COMPUTE = 'Infinity';

const FAKE_EVIDENCE = {
  roundTrips: 31,
  winRate: 0.58,
  realizedPnl: '120.5',
  fees: '5.25',
  llmCostUsd: '3.10',
  llmCostCountedThroughMs: 1_700_000_500_000,
  fundingNet: '0',
  netPnl: '112.15',
  windowDays: 16.5,
  firstClosedAt: 1,
  lastClosedAt: 2,
  fundingDataMissing: false,
  fundingIngestedThroughMs: 1_700_000_000_000,
  passivePnlQuote: null as string | null,
  reasons: [] as PromotionBlockedReason[],
};

// Reads the numeric sample off a single-series gauge's exposition text. Number() is correct here and
// is NOT a money-path violation: a Prometheus gauge value is a float by construction (prom-client
// only accepts numbers), so this parses a float back as a float — it never touches the decimal
// strings the verdict itself carries. +Inf/-Inf are Prometheus' own spellings and Number() rejects
// them, so they are mapped explicitly.
function gaugeValue(exposition: string): number {
  const line =
    exposition
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .at(-1) ?? '';
  const raw = line.slice(line.lastIndexOf(' ') + 1);
  if (raw === '+Inf') return Number.POSITIVE_INFINITY;
  if (raw === '-Inf') return Number.NEGATIVE_INFINITY;
  return Number(raw);
}

async function buildModule(readiness?: PromotionReadinessPort): Promise<TestingModule> {
  register.clear();
  return Test.createTestingModule({
    providers: [
      PROMOTION_ROUND_TRIPS_GAUGE,
      PROMOTION_WIN_RATE_GAUGE,
      PROMOTION_NET_PNL_GAUGE,
      PROMOTION_LLM_COST_GAUGE,
      PROMOTION_WINDOW_DAYS_GAUGE,
      PROMOTION_FUNDING_INGESTED_THROUGH_GAUGE,
      PROMOTION_LLM_COST_COUNTED_THROUGH_GAUGE,
      PROMOTION_PASSIVE_BENCHMARK_STATE_GAUGE,
      PROMOTION_PASSIVE_BENCHMARK_PNL_GAUGE,
      PROMOTION_READY_GAUGE,
      PROMOTION_BLOCKED_GAUGE,
      PromotionMetricsService,
      ...(readiness ? [{ provide: PROMOTION_READINESS, useValue: readiness }] : []),
    ],
  }).compile();
}

describe('PromotionMetricsService', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    await moduleRef.close();
    register.clear();
  });

  it('registers all eleven promotion gauges', async () => {
    moduleRef = await buildModule();
    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    for (const name of ALL_PROMOTION_GAUGE_NAMES) {
      expect(names, name).toContain(name);
    }
  });

  // THE registration trap, and the reason this spec asserts against ObservabilityModule rather than
  // against buildModule's own provider list: every gauge here is DECLARED in
  // promotion-metrics.service.ts, but a declared-and-unregistered gauge emits no series at all on
  // /metrics — silently, with the service's set() calls succeeding as no-ops (they are @Optional).
  // buildModule above lists the providers itself, so it can only ever prove that a registered gauge
  // registers; it cannot catch the composition root forgetting one. This reads the real module's
  // provider metadata instead, which is what the running process actually loads.
  it('registers every promotion gauge in ObservabilityModule itself, not merely in this spec', async () => {
    moduleRef = await buildModule();
    const providers = (Reflect.getMetadata('providers', ObservabilityModule) ?? []) as unknown[];
    // Guards the assertion below against a Nest metadata-key change quietly emptying it — the
    // "test that guarded nothing" failure mode from the #143 review.
    expect(providers.length).toBeGreaterThan(0);
    const registered = new Set(
      providers
        .filter(
          (p): p is { provide: string } =>
            typeof (p as { provide?: unknown })?.provide === 'string',
        )
        .map((p) => p.provide),
    );
    for (const name of ALL_PROMOTION_GAUGE_NAMES) {
      expect(registered, name).toContain(getToken(name));
    }
  });

  // G5: the whole point of the zero-seed is that this holds true at construction — BEFORE tick() has
  // ever run and even when PROMOTION_READINESS is never bound — so "absent" can never be misread as
  // "clear" for any of the eight reason labels.
  it('zero-seeds agentic_promotion_blocked for every PromotionBlockedReason at construction, before any tick', async () => {
    moduleRef = await buildModule();
    const metric = await register.getSingleMetricAsString('agentic_promotion_blocked');
    for (const reason of ALL_REASONS) {
      expect(metric, reason).toContain(`reason="${reason}"} 0`);
    }
  });

  // Defect 152: a labelled gauge emits no child series at all until one is set, so without the
  // constructor seed the benchmark state would be ABSENT rather than "not sampled yet" for the first
  // SAMPLE_INTERVAL_MS after every redeploy. All three at 0 is distinguishable from every post-tick
  // reading, which always carries exactly one label at 1.
  it('zero-seeds agentic_promotion_passive_benchmark_state for every state at construction, before any tick', async () => {
    moduleRef = await buildModule();
    const metric = await register.getSingleMetricAsString(
      'agentic_promotion_passive_benchmark_state',
    );
    for (const state of ALL_BENCHMARK_STATES) {
      expect(metric, state).toContain(`state="${state}"} 0`);
    }
  });

  it('tick() sets all six numeric gauges from a permitted verdict', async () => {
    const readiness: PromotionReadinessPort = {
      evaluate: () => Promise.resolve({ permitted: true, evidence: FAKE_EVIDENCE }),
    };
    moduleRef = await buildModule(readiness);
    const service = moduleRef.get(PromotionMetricsService);

    await service.tick();

    expect(await register.getSingleMetricAsString('agentic_promotion_round_trips')).toContain(
      'agentic_promotion_round_trips 31',
    );
    expect(await register.getSingleMetricAsString('agentic_promotion_win_rate')).toContain(
      'agentic_promotion_win_rate 0.58',
    );
    expect(await register.getSingleMetricAsString('agentic_promotion_net_pnl_usd')).toContain(
      'agentic_promotion_net_pnl_usd 112.15',
    );
    expect(await register.getSingleMetricAsString('agentic_promotion_llm_cost_usd')).toContain(
      'agentic_promotion_llm_cost_usd 3.1',
    );
    expect(await register.getSingleMetricAsString('agentic_promotion_window_days')).toContain(
      'agentic_promotion_window_days 16.5',
    );
    expect(
      await register.getSingleMetricAsString('agentic_promotion_funding_ingested_through_seconds'),
    ).toContain('agentic_promotion_funding_ingested_through_seconds 1700000000');
    // Defect 150: seconds, like the funding watermark beside it — 1_700_000_500_000 ms / 1000.
    expect(
      await register.getSingleMetricAsString('agentic_promotion_llm_cost_counted_through_seconds'),
    ).toContain('agentic_promotion_llm_cost_counted_through_seconds 1700000500');
    expect(await register.getSingleMetricAsString('agentic_promotion_ready')).toContain(
      'agentic_promotion_ready 1',
    );
  });

  // Defect 150: the `?? 0` branch — a verdict whose cost read covered no rows must publish 0, never a
  // stale prior value (100%-branch glob, vitest.config.ts). Both null and undefined reach it: the
  // field is optional on PromotionReadinessEvidence, so a verdict literal predating it omits it.
  it.each<[string, number | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
  ])(
    'tick() sets the llm-cost-counted-through gauge to 0 when the watermark is %s',
    async (_label, watermark) => {
      const readiness: PromotionReadinessPort = {
        evaluate: () =>
          Promise.resolve({
            permitted: true,
            evidence: { ...FAKE_EVIDENCE, llmCostCountedThroughMs: watermark },
          }),
      };
      moduleRef = await buildModule(readiness);

      await moduleRef.get(PromotionMetricsService).tick();

      expect(
        await register.getSingleMetricAsString(
          'agentic_promotion_llm_cost_counted_through_seconds',
        ),
      ).toContain('agentic_promotion_llm_cost_counted_through_seconds 0');
    },
  );

  // Defect 143: the watermark gauge's `?? 0` branch — a verdict with no funding rows ingested must
  // read 0, never a stale prior value or an absent series (100%-branch glob, vitest.config.ts).
  it('tick() sets the funding-ingested-through gauge to 0 when the verdict carries no watermark', async () => {
    const readiness: PromotionReadinessPort = {
      evaluate: () =>
        Promise.resolve({
          permitted: true,
          evidence: { ...FAKE_EVIDENCE, fundingIngestedThroughMs: null },
        }),
    };
    moduleRef = await buildModule(readiness);
    const service = moduleRef.get(PromotionMetricsService);

    await service.tick();

    expect(
      await register.getSingleMetricAsString('agentic_promotion_funding_ingested_through_seconds'),
    ).toContain('agentic_promotion_funding_ingested_through_seconds 0');
  });

  it('tick() sets agentic_promotion_ready=0 for a not-permitted verdict', async () => {
    const readiness: PromotionReadinessPort = {
      evaluate: () =>
        Promise.resolve({
          permitted: false,
          evidence: { ...FAKE_EVIDENCE, reasons: ['INSUFFICIENT_ROUND_TRIPS'] },
        }),
    };
    moduleRef = await buildModule(readiness);
    const service = moduleRef.get(PromotionMetricsService);

    await service.tick();

    expect(await register.getSingleMetricAsString('agentic_promotion_ready')).toContain(
      'agentic_promotion_ready 0',
    );
  });

  // G5: a blocking reason reads 1, every other reason (including ones that never fire in this repo's
  // fixed 8-member set, e.g. NO_STATS_SOURCE here) reads 0 — never absent.
  it('tick() sets exactly the firing reasons to 1 and every other reason to 0', async () => {
    const readiness: PromotionReadinessPort = {
      evaluate: () =>
        Promise.resolve({
          permitted: false,
          evidence: {
            ...FAKE_EVIDENCE,
            reasons: ['INSUFFICIENT_ROUND_TRIPS', 'BELOW_PASSIVE_BENCHMARK'],
          },
        }),
    };
    moduleRef = await buildModule(readiness);
    const service = moduleRef.get(PromotionMetricsService);

    await service.tick();

    const metric = await register.getSingleMetricAsString('agentic_promotion_blocked');
    for (const reason of ALL_REASONS) {
      const expectFiring =
        reason === 'INSUFFICIENT_ROUND_TRIPS' || reason === 'BELOW_PASSIVE_BENCHMARK';
      expect(metric, reason).toContain(`reason="${reason}"} ${expectFiring ? 1 : 0}`);
    }
  });

  // A reason that fired on tick N and cleared by tick N+1 must drop back to 0, not linger at its
  // stale value — proves the per-tick set is unconditional over the whole closed set, not additive.
  it('tick() clears a reason back to 0 once it stops firing on a later tick', async () => {
    let reasons: PromotionBlockedReason[] = ['NON_POSITIVE_NET_PNL'];
    const readiness: PromotionReadinessPort = {
      evaluate: () =>
        Promise.resolve({ permitted: false, evidence: { ...FAKE_EVIDENCE, reasons } }),
    };
    moduleRef = await buildModule(readiness);
    const service = moduleRef.get(PromotionMetricsService);

    await service.tick();
    expect(await register.getSingleMetricAsString('agentic_promotion_blocked')).toContain(
      'reason="NON_POSITIVE_NET_PNL"} 1',
    );

    reasons = [];
    await service.tick();
    expect(await register.getSingleMetricAsString('agentic_promotion_blocked')).toContain(
      'reason="NON_POSITIVE_NET_PNL"} 0',
    );
  });

  it('tick() is a no-op when PROMOTION_READINESS is absent', async () => {
    moduleRef = await buildModule();
    const service = moduleRef.get(PromotionMetricsService);
    const gauge = moduleRef.get<Gauge<string>>('PROM_METRIC_AGENTIC_PROMOTION_READY');
    const setSpy = vi.spyOn(gauge, 'set');

    await expect(service.tick()).resolves.toBeUndefined();

    expect(setSpy).not.toHaveBeenCalled();
  });

  // Defect 152, THE deliverable: a refusal and a genuine lost-to-the-basket comparison publish the
  // IDENTICAL agentic_promotion_blocked reason series, because the adapter's CANNOT_COMPUTE sentinel
  // is a string that netPnl always compares below. This asserts both halves — that the old series
  // really cannot tell them apart (so the fix is not solving a non-problem), and that the two new
  // series can.
  it('distinguishes a benchmark REFUSAL from a computed benchmark the book lost to, which agentic_promotion_blocked alone cannot', async () => {
    const readAt = async (passivePnlQuote: string | null) => {
      const readiness: PromotionReadinessPort = {
        evaluate: () =>
          Promise.resolve({
            permitted: false,
            evidence: {
              ...FAKE_EVIDENCE,
              passivePnlQuote,
              reasons: ['BELOW_PASSIVE_BENCHMARK'] as PromotionBlockedReason[],
            },
          }),
      };
      moduleRef = await buildModule(readiness);
      await moduleRef.get(PromotionMetricsService).tick();
      const out = {
        blocked: await register.getSingleMetricAsString('agentic_promotion_blocked'),
        state: await register.getSingleMetricAsString('agentic_promotion_passive_benchmark_state'),
        bar: await register.getSingleMetricAsString('agentic_promotion_passive_benchmark_pnl_usd'),
      };
      // Not closed here: buildModule's register.clear() is what isolates the two readings, and
      // afterEach closes the last module — closing mid-test would double-close it.
      return out;
    };

    const refused = await readAt(CANNOT_COMPUTE);
    const lost = await readAt('200');

    // The pre-existing series is byte-identical across the two — the defect, pinned.
    expect(refused.blocked).toContain('reason="BELOW_PASSIVE_BENCHMARK"} 1');
    expect(lost.blocked).toContain('reason="BELOW_PASSIVE_BENCHMARK"} 1');

    expect(refused.state).toContain('state="REFUSED"} 1');
    expect(refused.state).toContain('state="COMPUTED"} 0');
    expect(refused.bar).toContain('agentic_promotion_passive_benchmark_pnl_usd +Inf');

    expect(lost.state).toContain('state="COMPUTED"} 1');
    expect(lost.state).toContain('state="REFUSED"} 0');
    expect(lost.bar).toContain('agentic_promotion_passive_benchmark_pnl_usd 200');
  });

  // The third state, which is neither: no benchmark port bound (or no window to price), where
  // PromotionReadinessService drops the clause entirely so it can never block. -Inf is "no bar", the
  // only value for which the derivability invariant below holds in this state.
  it('publishes UNAVAILABLE and a -Inf bar when the verdict carries no benchmark at all', async () => {
    const readiness: PromotionReadinessPort = {
      evaluate: () => Promise.resolve({ permitted: true, evidence: FAKE_EVIDENCE }),
    };
    moduleRef = await buildModule(readiness);

    await moduleRef.get(PromotionMetricsService).tick();

    const state = await register.getSingleMetricAsString(
      'agentic_promotion_passive_benchmark_state',
    );
    expect(state).toContain('state="UNAVAILABLE"} 1');
    expect(state).toContain('state="COMPUTED"} 0');
    expect(state).toContain('state="REFUSED"} 0');
    expect(
      await register.getSingleMetricAsString('agentic_promotion_passive_benchmark_pnl_usd'),
    ).toContain('agentic_promotion_passive_benchmark_pnl_usd -Inf');
  });

  // What makes the pair legible without reading source: the blocking decision is REPRODUCIBLE from
  // the published numbers alone, in all three states — netPnl <= bar exactly when the reason blocks.
  // Mirrors PromotionReadinessService's `passivePnlQuote !== null && netPnl.lte(passivePnlQuote)`.
  it.each<[string, string | null, boolean]>([
    ['UNAVAILABLE', null, false],
    ['REFUSED', CANNOT_COMPUTE, true],
    ['COMPUTED, lost', '200', true],
    ['COMPUTED, beaten', '10', false],
  ])(
    'publishes a bar that reproduces the BELOW_PASSIVE_BENCHMARK decision (%s)',
    async (_label, passivePnlQuote, blocks) => {
      const readiness: PromotionReadinessPort = {
        evaluate: () =>
          Promise.resolve({
            permitted: !blocks,
            evidence: {
              ...FAKE_EVIDENCE,
              passivePnlQuote,
              reasons: blocks ? ['BELOW_PASSIVE_BENCHMARK'] : [],
            },
          }),
      };
      moduleRef = await buildModule(readiness);

      await moduleRef.get(PromotionMetricsService).tick();

      const netPnl = gaugeValue(
        await register.getSingleMetricAsString('agentic_promotion_net_pnl_usd'),
      );
      const bar = gaugeValue(
        await register.getSingleMetricAsString('agentic_promotion_passive_benchmark_pnl_usd'),
      );
      expect(netPnl <= bar).toBe(blocks);
      expect(await register.getSingleMetricAsString('agentic_promotion_blocked')).toContain(
        `reason="BELOW_PASSIVE_BENCHMARK"} ${blocks ? 1 : 0}`,
      );
    },
  );

  // The atomicity invariant every gauge here depends on: ONE evaluate(), and no await anywhere
  // between the sets, so a single scrape always represents one coherent evaluation (the sweep's
  // promotion_evidence annotation voids the whole tuple otherwise). Mechanically: a microtask queued
  // from inside the first set() can only run before a later set() if the burst suspends — so a stray
  // await between two sets is exactly what makes `setsAfterSuspension` non-zero.
  it('tick() sets every gauge in one synchronous burst off a single evaluate()', async () => {
    let evaluateCalls = 0;
    const readiness: PromotionReadinessPort = {
      evaluate: () => {
        evaluateCalls++;
        return Promise.resolve({
          permitted: false,
          evidence: {
            ...FAKE_EVIDENCE,
            passivePnlQuote: '200',
            reasons: ['BELOW_PASSIVE_BENCHMARK'] as PromotionBlockedReason[],
          },
        });
      },
    };
    moduleRef = await buildModule(readiness);

    let suspended = false;
    let setsAfterSuspension = 0;
    const touched = new Set<string>();
    for (const name of ALL_PROMOTION_GAUGE_NAMES) {
      const gauge = moduleRef.get<Gauge<string>>(getToken(name));
      // Calls through, so the value assertions below still read real gauge state — a mock that
      // swallowed the set would make tick() succeed vacuously and prove nothing. The labelled gauges
      // are covered too: prom-client's labels() binds `this.set` at call time, so it resolves to this
      // instance spy rather than the prototype method.
      const original = gauge.set.bind(gauge) as (...args: unknown[]) => void;
      vi.spyOn(gauge, 'set').mockImplementation((...args: unknown[]) => {
        touched.add(name);
        if (suspended) setsAfterSuspension++;
        queueMicrotask(() => (suspended = true));
        original(...args);
      });
    }

    await moduleRef.get(PromotionMetricsService).tick();

    expect(evaluateCalls).toBe(1);
    // Every gauge participated — otherwise "no suspension" would be vacuously true for the ones that
    // never ran, which is exactly how an unset gauge hides.
    expect([...touched].sort()).toEqual([...ALL_PROMOTION_GAUGE_NAMES].sort());
    expect(setsAfterSuspension).toBe(0);
    // The burst really wrote through, so tick() did not silently fail into its own catch.
    expect(await register.getSingleMetricAsString('agentic_promotion_ready')).toContain(
      'agentic_promotion_ready 0',
    );
  });

  it('tick() swallows an evaluate() throw rather than rejecting', async () => {
    const readiness: PromotionReadinessPort = {
      evaluate: () => Promise.reject(new Error('transient DB error')),
    };
    moduleRef = await buildModule(readiness);
    const service = moduleRef.get(PromotionMetricsService);

    await expect(service.tick()).resolves.toBeUndefined();
  });
});
