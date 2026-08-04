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
  type EpochMs,
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
import {
  FEAR_GREED_FEED,
  type FearGreedFeedPort,
} from '../../../../src/ports/strategy/fear-greed-feed';
import {
  MARKET_STREAM_TELEMETRY,
  type MarketStreamTelemetryPort,
} from '../../../../src/ports/venue/market-data';
import {
  POSITIONING_FEED,
  type PositioningFeedPort,
} from '../../../../src/ports/venue/positioning-feed';
import {
  TRADE_FLOW_FEED,
  type TradeFlowFeedPort,
} from '../../../../src/ports/venue/trade-flow-feed';
import {
  LIQUIDATION_FEED,
  type LiquidationFeedPort,
} from '../../../../src/ports/venue/liquidation-feed';

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

// Pass 44 (2026-07-28): a counter that has never been incremented exports NO series at all, so
// "zero forced reconnects" and "telemetry unbound / metric renamed" were the same read — an empty
// instant vector. loop:sweep annotated probe_failed[wsRecreations] on every single sweep because of
// it, voiding a negative read (playbook §C.9) on the counter that caught both 2026-07-21 soak
// defects. The fix publishes each venue's child at its true zero on first sight.
const RECONNECTS: Map<ReturnType<typeof venueId>, number> = new Map([
  [venueId('binance'), 0],
  [venueId('binanceusdm'), 0],
]);
const FAKE_STREAM_TELEMETRY: MarketStreamTelemetryPort = {
  channelAges: () => [],
  forcedReconnectCount: () => [...RECONNECTS.values()].reduce((a, b) => a + b, 0),
  forcedReconnectCountByVenue: () => RECONNECTS,
};
@Global()
@Module({
  providers: [{ provide: MARKET_STREAM_TELEMETRY, useValue: FAKE_STREAM_TELEMETRY }],
  exports: [MARKET_STREAM_TELEMETRY],
})
class FakeStreamTelemetryBridgeModule {}

describe('MetricsService forced-reconnect sampling (v3 §8) — MARKET_STREAM_TELEMETRY present', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();
    RECONNECTS.set(venueId('binance'), 0);
    RECONNECTS.set(venueId('binanceusdm'), 0);
    vi.useFakeTimers();

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, FakeStreamTelemetryBridgeModule, ObservabilityModule],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
    // Leave the shared fixture as this suite found it — the next suite to bind it must not inherit
    // this one's counts.
    RECONNECTS.set(venueId('binance'), 0);
    RECONNECTS.set(venueId('binanceusdm'), 0);
  });

  it('publishes every venue at 0 on the first sample, so a quiet lane is a readable zero and not an empty vector', async () => {
    vi.advanceTimersByTime(5000);
    const metric = await register.getSingleMetricAsString('market_stream_forced_reconnects_total');
    expect(metric).toContain('venue="binance"} 0');
    expect(metric).toContain('venue="binanceusdm"} 0');
  });

  it('still applies the real delta once a venue actually forces a reconnect, without double-counting the zero seed', async () => {
    RECONNECTS.set(venueId('binanceusdm'), 3);
    vi.advanceTimersByTime(5000);
    let metric = await register.getSingleMetricAsString('market_stream_forced_reconnects_total');
    expect(metric).toContain('venue="binanceusdm"} 3');
    expect(metric).toContain('venue="binance"} 0');

    RECONNECTS.set(venueId('binanceusdm'), 5);
    vi.advanceTimersByTime(5000);
    metric = await register.getSingleMetricAsString('market_stream_forced_reconnects_total');
    expect(metric).toContain('venue="binanceusdm"} 5');
  });
});

// Own module init, because "first sight" is only first sight once: MetricsService can start AFTER
// reconnects have accumulated (module init order, or telemetry rebuilt underneath it), and the zero
// seed must land on the real total rather than adding to it or masking it.
describe('MetricsService forced-reconnect sampling — venue first seen with a non-zero total', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();
    RECONNECTS.set(venueId('binance'), 7);
    RECONNECTS.set(venueId('binanceusdm'), 0);
    vi.useFakeTimers();

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, FakeStreamTelemetryBridgeModule, ObservabilityModule],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
    RECONNECTS.set(venueId('binance'), 0);
    RECONNECTS.set(venueId('binanceusdm'), 0);
  });

  it('lands on the accumulated total exactly once — not 0, and not total + the seed', async () => {
    vi.advanceTimersByTime(5000);
    const metric = await register.getSingleMetricAsString('market_stream_forced_reconnects_total');
    expect(metric).toContain('venue="binance"} 7');
    expect(metric).toContain('venue="binanceusdm"} 0');
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

// Context-feed + liquidation-feed health sampling: four feeds enabled in production (fear-greed /
// positioning / trade-flow / liquidation) whose ports already declared lastSuccessfulPollAt /
// pollErrorCount / streamHealthy / reconnectCount accessors but had no MetricsService reader wired to
// them at all — same mutable-state-object fake convention as FAKE_STREAM_TELEMETRY above, with a
// throwOnStaleness escape hatch per feed to exercise the fail-open guard.
type ContextFeedState = {
  lastSuccessfulPollAt: EpochMs | null;
  pollErrorCount: number;
  throwOnStaleness: boolean;
};
const fearGreedState: ContextFeedState = {
  lastSuccessfulPollAt: null,
  pollErrorCount: 0,
  throwOnStaleness: false,
};
const positioningState: ContextFeedState = {
  lastSuccessfulPollAt: null,
  pollErrorCount: 0,
  throwOnStaleness: false,
};
const tradeFlowState: ContextFeedState = {
  lastSuccessfulPollAt: null,
  pollErrorCount: 0,
  throwOnStaleness: false,
};
function resetContextFeedStates(): void {
  for (const s of [fearGreedState, positioningState, tradeFlowState]) {
    s.lastSuccessfulPollAt = null;
    s.pollErrorCount = 0;
    s.throwOnStaleness = false;
  }
}
const FAKE_FEAR_GREED_FEED: FearGreedFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => {
    if (fearGreedState.throwOnStaleness) throw new Error('fear-greed port exploded');
    return fearGreedState.lastSuccessfulPollAt;
  },
  pollErrorCount: () => fearGreedState.pollErrorCount,
};
const FAKE_POSITIONING_FEED: PositioningFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => {
    if (positioningState.throwOnStaleness) throw new Error('positioning port exploded');
    return positioningState.lastSuccessfulPollAt;
  },
  pollErrorCount: () => positioningState.pollErrorCount,
};
const FAKE_TRADE_FLOW_FEED: TradeFlowFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => {
    if (tradeFlowState.throwOnStaleness) throw new Error('trade-flow port exploded');
    return tradeFlowState.lastSuccessfulPollAt;
  },
  pollErrorCount: () => tradeFlowState.pollErrorCount,
};
const liquidationState = { streamHealthy: false, reconnectCount: 0 };
const FAKE_LIQUIDATION_FEED: LiquidationFeedPort = {
  latest: () => null,
  streamHealthy: () => liquidationState.streamHealthy,
  reconnectCount: () => liquidationState.reconnectCount,
};
@Global()
@Module({
  providers: [
    { provide: FEAR_GREED_FEED, useValue: FAKE_FEAR_GREED_FEED },
    { provide: POSITIONING_FEED, useValue: FAKE_POSITIONING_FEED },
    { provide: TRADE_FLOW_FEED, useValue: FAKE_TRADE_FLOW_FEED },
    { provide: LIQUIDATION_FEED, useValue: FAKE_LIQUIDATION_FEED },
  ],
  exports: [FEAR_GREED_FEED, POSITIONING_FEED, TRADE_FLOW_FEED, LIQUIDATION_FEED],
})
class FakeContextFeedsBridgeModule {}

describe('MetricsService context-feed + liquidation-feed sampling — feed ports present', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    register.clear();
    resetContextFeedStates();
    liquidationState.streamHealthy = false;
    liquidationState.reconnectCount = 0;
    vi.useFakeTimers();

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, FakeContextFeedsBridgeModule, ObservabilityModule],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await moduleRef.close();
    register.clear();
    resetContextFeedStates();
    liquidationState.streamHealthy = false;
    liquidationState.reconnectCount = 0;
  });

  it('zero-seeds every {feed} child at construction, before any sample tick has run', async () => {
    // No vi.advanceTimersByTime yet — module.init() ran the constructor (the zero-seed) but the 5s
    // setInterval callback has not fired once. Absent-vs-real-zero is exactly what this proves.
    const staleness = await register.getSingleMetricAsString('context_feed_staleness_seconds');
    expect(staleness).toContain('feed="fear_greed"} -1');
    expect(staleness).toContain('feed="positioning"} -1');
    expect(staleness).toContain('feed="trade_flow"} -1');
    const errors = await register.getSingleMetricAsString('context_feed_poll_errors_total');
    expect(errors).toContain('feed="fear_greed"} 0');
    expect(errors).toContain('feed="positioning"} 0');
    expect(errors).toContain('feed="trade_flow"} 0');
    expect(register.getSingleMetric('liquidation_stream_healthy'), 'registered').toBeDefined();
    expect(register.getSingleMetric('liquidation_reconnects_total'), 'registered').toBeDefined();
  });

  it('reports the -1 sentinel (not 0, not absent) for a feed whose lastSuccessfulPollAt() is null', async () => {
    vi.advanceTimersByTime(5000);
    const staleness = await register.getSingleMetricAsString('context_feed_staleness_seconds');
    expect(staleness).toContain('feed="fear_greed"} -1');
    expect(staleness).toContain('feed="positioning"} -1');
    expect(staleness).toContain('feed="trade_flow"} -1');
  });

  it('raises context_feed_poll_errors_total by exactly the delta when pollErrorCount() advances', async () => {
    positioningState.pollErrorCount = 3;
    vi.advanceTimersByTime(5000);
    let errors = await register.getSingleMetricAsString('context_feed_poll_errors_total');
    expect(errors).toContain('feed="positioning"} 3');

    positioningState.pollErrorCount = 5; // +2 this tick, not an absolute set to 5-then-3-again
    vi.advanceTimersByTime(5000);
    errors = await register.getSingleMetricAsString('context_feed_poll_errors_total');
    expect(errors).toContain('feed="positioning"} 5');
  });

  it('a throwing accessor on one feed does not prevent the other feeds from being sampled in the same tick', async () => {
    positioningState.throwOnStaleness = true;
    fearGreedState.lastSuccessfulPollAt = epochMs(Date.now() - 30_000);
    tradeFlowState.pollErrorCount = 7;

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();

    const staleness = await register.getSingleMetricAsString('context_feed_staleness_seconds');
    const fearGreedLine = staleness.split('\n').find((line) => line.includes('feed="fear_greed"'));
    expect(
      fearGreedLine,
      'fear_greed sampled despite positioning throwing the same tick',
    ).toBeDefined();
    expect(Number(fearGreedLine?.trim().split(' ').pop())).toBeGreaterThan(0);

    const errors = await register.getSingleMetricAsString('context_feed_poll_errors_total');
    expect(errors, 'trade_flow sampled despite positioning throwing the same tick').toContain(
      'feed="trade_flow"} 7',
    );

    positioningState.throwOnStaleness = false;
  });

  it('samples liquidation_stream_healthy and liquidation_reconnects_total (delta) from the WS port', async () => {
    liquidationState.streamHealthy = true;
    liquidationState.reconnectCount = 2;
    vi.advanceTimersByTime(5000);
    let healthy = await register.getSingleMetricAsString('liquidation_stream_healthy');
    expect(healthy).toContain('liquidation_stream_healthy 1');
    let reconnects = await register.getSingleMetricAsString('liquidation_reconnects_total');
    expect(reconnects).toContain('liquidation_reconnects_total 2');

    liquidationState.streamHealthy = false;
    liquidationState.reconnectCount = 5;
    vi.advanceTimersByTime(5000);
    healthy = await register.getSingleMetricAsString('liquidation_stream_healthy');
    expect(healthy).toContain('liquidation_stream_healthy 0');
    reconnects = await register.getSingleMetricAsString('liquidation_reconnects_total');
    expect(reconnects).toContain('liquidation_reconnects_total 5');
  });
});
