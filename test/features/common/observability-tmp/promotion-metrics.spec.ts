import { Test, type TestingModule } from '@nestjs/testing';
import type { Gauge } from 'prom-client';
import { register } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROMOTION_LLM_COST_GAUGE,
  PROMOTION_NET_PNL_GAUGE,
  PROMOTION_READY_GAUGE,
  PROMOTION_ROUND_TRIPS_GAUGE,
  PROMOTION_WIN_RATE_GAUGE,
  PROMOTION_WINDOW_DAYS_GAUGE,
  PromotionMetricsService,
} from '../../../src/features/common/observability/promotion-metrics.service';
import { PROMOTION_READINESS, type PromotionReadinessPort } from '../../../src/ports/promotion';

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
  reasons: [] as string[],
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
      PROMOTION_READY_GAUGE,
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

  it('registers all six promotion gauges', async () => {
    moduleRef = await buildModule();
    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    for (const name of [
      'agentic_promotion_round_trips',
      'agentic_promotion_win_rate',
      'agentic_promotion_net_pnl_usd',
      'agentic_promotion_llm_cost_usd',
      'agentic_promotion_window_days',
      'agentic_promotion_ready',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('tick() sets all six gauges from a permitted verdict', async () => {
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
    expect(await register.getSingleMetricAsString('agentic_promotion_ready')).toContain(
      'agentic_promotion_ready 1',
    );
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
