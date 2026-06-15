import { Test, type TestingModule } from '@nestjs/testing';
import { register } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../../src/app.module';
import { EventLoopHealthIndicator } from '../../../src/modules/observability/event-loop-health.indicator';
import { MetricsService } from '../../../src/modules/observability/metrics.service';

describe('EventLoopHealthIndicator.getMonitor() and MetricsService interval', () => {
  let moduleRef: TestingModule;
  let indicator: EventLoopHealthIndicator;
  let metricsService: MetricsService;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();

    vi.useFakeTimers();

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();

    indicator = moduleRef.get(EventLoopHealthIndicator);
    metricsService = moduleRef.get(MetricsService);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
  });

  it('getMonitor() returns a non-null histogram after onModuleInit', () => {
    const mon = indicator.getMonitor();
    expect(mon).not.toBeNull();
  });

  it('interval callback executes without error when fake timer advances 5s', () => {
    // Advance clock so the setInterval callback in MetricsService fires
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(metricsService).toBeDefined();
  });

  it('emits the §8 trading gauges (pulled from PortfolioSnapshot) after a sample tick', async () => {
    vi.advanceTimersByTime(5000); // fire the loop so the portfolio-pull block runs
    const exposition = await register.metrics();
    for (const name of [
      'equity_usdt',
      'cash_usdt',
      'peak_equity_usdt',
      'day_pnl_usdt',
      'drawdown_ratio',
      'open_orders',
      'in_flight_intents',
    ]) {
      expect(register.getSingleMetric(name), `${name} registered`).toBeDefined();
      expect(exposition, `${name} present in /metrics exposition`).toContain(name);
    }
  });

  it('getMonitor() returns null after onModuleDestroy', async () => {
    await moduleRef.close();
    expect(indicator.getMonitor()).toBeNull();
    // Re-open for afterAll cleanup (moduleRef.close() is idempotent)
  });
});
