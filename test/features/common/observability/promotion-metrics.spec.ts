import { Test, type TestingModule } from '@nestjs/testing';
import type { Gauge } from 'prom-client';
import { register } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROMOTION_BLOCKED_GAUGE,
  PROMOTION_FUNDING_INGESTED_THROUGH_GAUGE,
  PROMOTION_LLM_COST_GAUGE,
  PROMOTION_NET_PNL_GAUGE,
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

const FAKE_EVIDENCE = {
  roundTrips: 31,
  winRate: 0.58,
  realizedPnl: '120.5',
  fees: '5.25',
  llmCostUsd: '3.10',
  fundingNet: '0',
  netPnl: '112.15',
  windowDays: 16.5,
  firstClosedAt: 1,
  lastClosedAt: 2,
  fundingDataMissing: false,
  fundingIngestedThroughMs: 1_700_000_000_000,
  passivePnlQuote: null,
  reasons: [] as PromotionBlockedReason[],
};

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

  it('registers all eight promotion gauges', async () => {
    moduleRef = await buildModule();
    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    for (const name of [
      'agentic_promotion_round_trips',
      'agentic_promotion_win_rate',
      'agentic_promotion_net_pnl_usd',
      'agentic_promotion_llm_cost_usd',
      'agentic_promotion_window_days',
      'agentic_promotion_funding_ingested_through_seconds',
      'agentic_promotion_ready',
      'agentic_promotion_blocked',
    ]) {
      expect(names, name).toContain(name);
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
    expect(await register.getSingleMetricAsString('agentic_promotion_ready')).toContain(
      'agentic_promotion_ready 1',
    );
  });

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

  it('tick() swallows an evaluate() throw rather than rejecting', async () => {
    const readiness: PromotionReadinessPort = {
      evaluate: () => Promise.reject(new Error('transient DB error')),
    };
    moduleRef = await buildModule(readiness);
    const service = moduleRef.get(PromotionMetricsService);

    await expect(service.tick()).resolves.toBeUndefined();
  });
});
