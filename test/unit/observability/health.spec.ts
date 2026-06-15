import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { HealthCheckService } from '@nestjs/terminus';
import { register } from 'prom-client';
import { AppModule } from '../../../src/app.module';
import { HealthController } from '../../../src/modules/observability/health.controller';
import { MetricsService } from '../../../src/modules/observability/metrics.service';
import { ObservabilityModule } from '../../../src/modules/observability/observability.module';
import { AppConfigModule } from '../../../src/modules/config/config.module';

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
