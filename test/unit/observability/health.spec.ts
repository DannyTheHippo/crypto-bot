import { Global, Module } from '@nestjs/common';
import { HealthCheckService } from '@nestjs/terminus';
import { Test, type TestingModule } from '@nestjs/testing';
import { register } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../src/app.module';
import { AppConfigModule } from '../../../src/config/config.module';
import { HealthController } from '../../../src/modules/observability/health.controller';
import { MetricsService } from '../../../src/modules/observability/metrics.service';
import { ObservabilityModule } from '../../../src/modules/observability/observability.module';
import { STRATEGY_REGISTRY, type StrategyRegistryPort } from '../../../src/ports/strategy';
import { strategyId } from '../../../src/domain/types/ids';

describe('Health endpoints (unit — no HTTP)', () => {
  let moduleRef: TestingModule;
  let healthController: HealthController;
  let metricsService: MetricsService;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';

    register.clear();

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await moduleRef.init();

    healthController = moduleRef.get(HealthController);
    metricsService = moduleRef.get(MetricsService);
  });

  afterAll(async () => {
    await moduleRef.close();
    register.clear();
  });

  it('live() returns status ok', async () => {
    const result = await healthController.live();
    expect(result.status).toBe('ok');
  });

  it('ready() returns status ok with effectiveMode paper and killSwitchState RUNNING', async () => {
    const result = await healthController.ready();
    expect(result.status).toBe('ok');
    const details = result.info as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    const configDetail = details?.['config'] as Record<string, unknown> | undefined;
    expect(configDetail?.['effectiveMode']).toBe('paper');
    expect(configDetail?.['killSwitchState']).toBe('RUNNING');
  });

  it('ready() config detail includes "strategies" — STRATEGY_REGISTRY is bridged into global scope (G3c)', async () => {
    const result = await healthController.ready();
    const details = result.info as Record<string, unknown> | undefined;
    const configDetail = details?.['config'] as Record<string, unknown> | undefined;
    // Under test/ci, AppModule's onApplicationBootstrap (which registers the agentic strategy) never
    // fires — so the bridged registry is present but empty, not absent.
    expect(configDetail?.['strategies']).toEqual({});
  });

  it('ready() result.info contains a "database" key when DbHealthBridgeModule is active', async () => {
    const result = await healthController.ready();
    const info = result.info as Record<string, unknown> | undefined;
    expect(info).toBeDefined();
    // DB_HEALTH is wired via DbHealthBridgeModule; pool is null (no DATABASE_URL in test),
    // so indicator returns status 'up' with detail 'not_configured'.
    expect(info?.['database']).toBeDefined();
    const dbInfo = info?.['database'] as Record<string, unknown> | undefined;
    expect(dbInfo?.['status']).toBe('up');
  });

  it('Prometheus registry contains event_loop and mode_info metrics', async () => {
    const metricNames = (await register.getMetricsAsJSON()).map((m) => m.name);
    expect(metricNames.some((n) => n.includes('event_loop'))).toBe(true);
    expect(metricNames.some((n) => n.includes('mode_info'))).toBe(true);
    expect(metricsService).toBeDefined();
  });

  it('HealthCheckService is wired', () => {
    const hcs = moduleRef.get(HealthCheckService);
    expect(hcs).toBeDefined();
  });
});

describe('Health endpoints — without DbHealthBridgeModule (DB_HEALTH absent)', () => {
  let moduleRef: TestingModule;
  let healthController: HealthController;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';

    register.clear();

    // Build without the global DbHealthBridgeModule so DB_HEALTH is not in scope.
    // HealthController receives null via @Optional() @Inject(DB_HEALTH) and skips
    // the database check — the 'database' key must be absent from result.info.
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, ObservabilityModule],
    }).compile();

    await moduleRef.init();

    healthController = moduleRef.get(HealthController);
  });

  afterAll(async () => {
    await moduleRef.close();
    register.clear();
  });

  it('ready() does NOT contain a "database" key when bridge is absent', async () => {
    const result = await healthController.ready();
    expect(result.status).toBe('ok');
    const info = result.info as Record<string, unknown> | undefined;
    expect(info?.['database']).toBeUndefined();
  });
});

// Simulates the real G3c StrategyRegistryBridgeModule (app.module.ts) with a fake registry carrying
// non-trivial state (multiple strategies, a drain reason) — exercising the per-strategy health detail
// in isolation from AppModule's own (empty-under-test) registry. Same bridge-module pattern AppModule
// uses for DB_HEALTH/PORTFOLIO_VIEW.
const FAKE_REGISTRY: StrategyRegistryPort = {
  register: () => undefined,
  enable: () => undefined,
  disable: () => undefined,
  states: () => [
    { id: strategyId('agentic-1'), lifecycle: 'ACTIVE' },
    { id: strategyId('agentic-2'), lifecycle: 'DRAINING' },
  ],
  getDrainReason: (id) => (id === strategyId('agentic-2') ? 'AUTO' : undefined),
};
@Global()
@Module({
  providers: [{ provide: STRATEGY_REGISTRY, useValue: FAKE_REGISTRY }],
  exports: [STRATEGY_REGISTRY],
})
class FakeStrategyRegistryBridgeModule {}

describe('Health endpoints — with STRATEGY_REGISTRY bridged (fake)', () => {
  let moduleRef: TestingModule;
  let healthController: HealthController;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';

    register.clear();

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, FakeStrategyRegistryBridgeModule, ObservabilityModule],
    }).compile();

    await moduleRef.init();

    healthController = moduleRef.get(HealthController);
  });

  afterAll(async () => {
    await moduleRef.close();
    register.clear();
  });

  it('ready() config detail includes per-strategy lifecycle, with drainReason only where set', async () => {
    const result = await healthController.ready();
    expect(result.status).toBe('ok');
    const configDetail = (result.info as Record<string, unknown> | undefined)?.['config'] as
      | Record<string, unknown>
      | undefined;
    expect(configDetail?.['killSwitchState']).toBe('RUNNING'); // unrelated detail stays present
    expect(configDetail?.['strategies']).toEqual({
      'agentic-1': { lifecycle: 'ACTIVE' },
      'agentic-2': { lifecycle: 'DRAINING', drainReason: 'AUTO' },
    });
  });
});
