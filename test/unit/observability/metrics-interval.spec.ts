import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { register } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../../src/app.module';
import { AppConfigModule } from '../../../src/modules/config/config.module';
import { EventLoopHealthIndicator } from '../../../src/modules/observability/event-loop-health.indicator';
import { MetricsService } from '../../../src/modules/observability/metrics.service';
import { ObservabilityModule } from '../../../src/modules/observability/observability.module';
import { STRATEGY_REGISTRY, type StrategyRegistryPort } from '../../../src/ports/strategy';
import { strategyId } from '../../../src/domain/types/ids';

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

  it('strategy_lifecycle is registered but carries no series — STRATEGY_REGISTRY is bridged globally (StrategyRegistryBridgeModule) but empty under test/ci since no strategy is registered', async () => {
    expect(register.getSingleMetric('strategy_lifecycle'), 'registered').toBeDefined();
    const metric = await register.getSingleMetricAsString('strategy_lifecycle');
    expect(metric).not.toContain('strategy=');
  });
});

// A standalone @Global STRATEGY_REGISTRY binding for a minimal test module (below) that doesn't
// import the full AppModule, so the strategy_lifecycle sampling branch can be exercised against a
// populated registry — AppModule's own StrategyRegistryBridgeModule is the real equivalent, already
// wired at the composition root; this fake is only for this smaller test harness.
const FAKE_REGISTRY: StrategyRegistryPort = {
  register: () => undefined,
  enable: () => undefined,
  disable: () => undefined,
  states: () => [
    { id: strategyId('agentic-1'), lifecycle: 'ACTIVE' },
    { id: strategyId('agentic-2'), lifecycle: 'DRAINING' },
  ],
};
@Global()
@Module({
  providers: [{ provide: STRATEGY_REGISTRY, useValue: FAKE_REGISTRY }],
  exports: [STRATEGY_REGISTRY],
})
class FakeStrategyRegistryBridgeModule {}

describe('MetricsService strategy_lifecycle sampling — STRATEGY_REGISTRY present', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();
    vi.useFakeTimers();

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, FakeStrategyRegistryBridgeModule, ObservabilityModule],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
  });

  it('sets strategy_lifecycle{strategy,state}=1 for the current state and 0 for every other lifecycle state', async () => {
    vi.advanceTimersByTime(5000);
    const metric = await register.getSingleMetricAsString('strategy_lifecycle');
    expect(metric).toContain('strategy="agentic-1",state="ACTIVE"} 1');
    expect(metric).toContain('strategy="agentic-1",state="DRAINING"} 0');
    expect(metric).toContain('strategy="agentic-1",state="HALTED"} 0');
    expect(metric).toContain('strategy="agentic-2",state="DRAINING"} 1');
    expect(metric).toContain('strategy="agentic-2",state="ACTIVE"} 0');
  });
});
