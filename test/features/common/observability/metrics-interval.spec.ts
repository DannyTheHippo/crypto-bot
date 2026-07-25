import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { register } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../../../src/app.module';
import { AppConfigModule } from '../../../../src/config/config.module';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import {
  clientOrderId,
  epochMs,
  intentId,
  strategyId,
  symbolId,
  venueId,
} from '../../../../src/domain/common/types/ids';
import { price, qty } from '../../../../src/domain/common/types/money';
import { EventLoopHealthIndicator } from '../../../../src/features/common/observability/event-loop-health.indicator';
import { MetricsService } from '../../../../src/features/common/observability/metrics.service';
import { ObservabilityModule } from '../../../../src/features/common/observability/observability.module';
import { PORTFOLIO_VIEW, type PortfolioViewPort } from '../../../../src/ports/trading/execution';
import { MODE_CONTROL, type ModeControlPort } from '../../../../src/ports/trading/mode-control';
import {
  STRATEGY_REGISTRY,
  type StrategyRegistryPort,
} from '../../../../src/ports/strategy/strategy';

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
      'unrealized_pnl_usdt',
      'starting_cash_usdt',
      'open_orders',
      'in_flight_intents',
    ]) {
      expect(register.getSingleMetric(name), `${name} registered`).toBeDefined();
      expect(exposition, `${name} present in /metrics exposition`).toContain(name);
    }
  });

  it('exposes the §8 fill-fold profitability metrics registered by ExecutionModule', async () => {
    const exposition = await register.metrics();
    for (const name of ['fees_paid_total', 'round_trips_total', 'trade_pnl_usdt']) {
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

// v3 §8/§6.1: a standalone PORTFOLIO_VIEW binding (same convention as FakeStrategyRegistryBridgeModule
// above) carrying one spot position/order and one perp in-flight intent, so the venue-labeled gauges
// (position_*, open_orders, in_flight_intents, venue_capital_headroom_usdt) can be exercised without
// depending on AppModule's real composition root.
const BTC_SPOT = symbolId('BTC/USDT');
const ETH_PERP = symbolId('ETH/USDT:USDT');
const FAKE_PORTFOLIO: PortfolioViewPort = {
  snapshot: () => ({
    positions: new Map([
      [
        'binance:BTC/USDT',
        {
          strategyId: strategyId('agentic'),
          venue: venueId('binance'),
          symbol: BTC_SPOT,
          signedQty: new Decimal('2'),
          avgEntry: price('100'),
          realizedPnl: new Decimal('3'),
        },
      ],
      [
        'binanceusdm:ETH/USDT:USDT',
        {
          strategyId: strategyId('agentic'),
          venue: venueId('binanceusdm'),
          symbol: ETH_PERP,
          signedQty: new Decimal('-1'),
          avgEntry: price('50'),
          realizedPnl: new Decimal('-1'),
        },
      ],
    ]),
    balances: new Map(),
    openOrders: [
      {
        clientOrderId: clientOrderId('cbp0000000000000000000000000000000'),
        symbol: BTC_SPOT,
        side: 'BUY',
        qty: qty('1'),
      },
    ],
    inFlightIntents: [
      {
        intentId: intentId('0190abcd-1234-7abc-89ab-0123456789ab'),
        clientOrderId: clientOrderId('cbp0000000000000000000000000000001'),
        strategyId: strategyId('agentic'),
        venue: venueId('binanceusdm'),
        symbol: ETH_PERP,
        side: 'BUY',
        type: 'LIMIT' as const,
        qty: qty('1'),
        limitPrice: price('60'),
        timeInForce: 'GTC' as const,
        reduceOnly: false,
        mode: 'paper' as const,
        refPrice: price('60'),
        refSeq: 1n,
        createdAt: epochMs(0),
        expiresAt: epochMs(1_700_000_010_000),
        source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 1n, strength: 1 },
      },
    ],
    equity: new Decimal(0),
    unrealized: new Decimal(0),
    startingCash: new Decimal(0),
    peakEquity: new Decimal(0),
    sodEquityUtc: new Decimal(0),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 0n,
  }),
  forStrategy: () => ({
    strategyId: strategyId('agentic'),
    positions: new Map(),
    openOrders: [],
  }),
};
@Global()
@Module({
  providers: [{ provide: PORTFOLIO_VIEW, useValue: FAKE_PORTFOLIO }],
  exports: [PORTFOLIO_VIEW],
})
class FakePortfolioViewBridgeModule {}

describe('MetricsService venue-labeled sampling (v3 §8/§6.1) — PORTFOLIO_VIEW present', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();
    vi.useFakeTimers();

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, FakePortfolioViewBridgeModule, ObservabilityModule],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
  });

  it('labels realized_pnl_usdt/position_qty/position_notional_usdt with venue', async () => {
    vi.advanceTimersByTime(5000);
    const notional = await register.getSingleMetricAsString('position_notional_usdt');
    expect(notional).toContain('venue="binance",strategy="agentic",symbol="BTC/USDT"} 200');
    expect(notional).toContain('venue="binanceusdm",strategy="agentic",symbol="ETH/USDT:USDT"} 50');
  });

  it('counts open_orders/in_flight_intents per venue (openOrders via venueForSymbol, intents via .venue)', async () => {
    const openOrders = await register.getSingleMetricAsString('open_orders');
    expect(openOrders).toContain('venue="binance"} 1');
    const inFlight = await register.getSingleMetricAsString('in_flight_intents');
    expect(inFlight).toContain('venue="binanceusdm"} 1');
  });

  it('computes venue_capital_headroom_usdt = venueCap − open notional − reserved notional (spec §6.1)', async () => {
    const headroom = await register.getSingleMetricAsString('venue_capital_headroom_usdt');
    // default VENUE_CAPITAL_SPLIT is {"binance":"500","binanceusdm":"500"}; binance open=200,
    // reserved=0 ⇒ 300; binanceusdm open=50, reserved=1×60=60 ⇒ 390.
    expect(headroom).toContain('venue="binance"} 300');
    expect(headroom).toContain('venue="binanceusdm"} 390');
  });

  it('venue_free_cash_usdt stays registered but carries no series — PortfolioSnapshot.venueBalances is a pending-integration field (workstream #8) this fake snapshot does not carry', async () => {
    expect(register.getSingleMetric('venue_free_cash_usdt'), 'registered').toBeDefined();
    const metric = await register.getSingleMetricAsString('venue_free_cash_usdt');
    expect(metric).not.toContain('venue=');
  });
});

// mode_info: `requested` is always env requestedMode; `effective` tracks resolveMode() when
// MODE_CONTROL is bound (arming-aware), else boot configMode. AppConfigModule uses
// skipProcessEnv under test, so these suites stub TypedConfigService.mode to exercise the
// live→paper honesty case (requestedMode=live, configMode=paper) without leaking host env.
const MODE_STUB = {
  requestedMode: 'live' as const,
  configMode: 'paper' as const,
  sandboxEnv: 'demo' as const,
  downgrades: ['NODE_ENV/CI override: forced paper (was "live")'],
};
const mutableEffective: { value: 'paper' | 'live' } = { value: 'paper' };
const FAKE_MODE_CONTROL: ModeControlPort = {
  resolveMode: () => ({
    // ModeControlConfig.requested is configMode in production — deliberately NOT used for the
    // mode_info.requested label (see MetricsService.sampleModeInfo).
    requested: 'paper',
    effective: mutableEffective.value,
    downgrades: mutableEffective.value === 'paper' ? ['NOT_ARMED'] : [],
  }),
  armLive: () => ({ ok: false, reason: 'PRECONDITION' }),
  disarm: () => undefined,
  assertCanTrade: () => undefined,
};
@Global()
@Module({
  providers: [{ provide: MODE_CONTROL, useValue: FAKE_MODE_CONTROL }],
  exports: [MODE_CONTROL],
})
class FakeModeControlBridgeModule {}

function stubMode(moduleRef: TestingModule): void {
  const cfg = moduleRef.get(TypedConfigService);
  Object.defineProperty(cfg, 'mode', { configurable: true, get: () => MODE_STUB });
}

describe('MetricsService mode_info sampling — MODE_CONTROL present', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();
    vi.useFakeTimers();
    mutableEffective.value = 'paper';

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, FakeModeControlBridgeModule, ObservabilityModule],
    }).compile();
    stubMode(moduleRef);
    await moduleRef.init();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
  });

  it('keeps requested=requestedMode and resamples effective from resolveMode()', async () => {
    let metric = await register.getSingleMetricAsString('mode_info');
    // requestedMode=live (stub), effective=paper (fake resolveMode / not armed) — not configMode-as-requested.
    expect(metric).toContain('requested="live",effective="paper"} 1');

    mutableEffective.value = 'live';
    vi.advanceTimersByTime(5000);

    metric = await register.getSingleMetricAsString('mode_info');
    expect(metric).toContain('requested="live",effective="live"} 1');
    expect(metric).not.toContain('effective="paper"} 1');
  });
});

describe('MetricsService mode_info sampling — MODE_CONTROL unbound fallback', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();
    vi.useFakeTimers();

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, ObservabilityModule],
    }).compile();
    stubMode(moduleRef);
    await moduleRef.init();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
  });

  it('falls back to requestedMode + configMode when MODE_CONTROL is absent', async () => {
    vi.advanceTimersByTime(5000);
    const metric = await register.getSingleMetricAsString('mode_info');
    expect(metric).toContain('requested="live",effective="paper"} 1');
  });
});
