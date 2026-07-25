import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { SignalGatewayService } from '../../../src/features/trading/risk/signal-gateway.service';
import { KillSwitchService } from '../../../src/features/trading/risk/kill-switch.service';
import { PositionSizerService } from '../../../src/features/trading/risk/position-sizer.service';
import { RiskEngineService } from '../../../src/features/trading/risk/risk-engine.service';
import { RateBucketsService } from '../../../src/features/trading/risk/rate-buckets.service';
import { CrossingRegistryService } from '../../../src/features/trading/risk/crossing-registry.service';
import type { SizerDeps, RiskEngineDeps, RiskJournalPort } from '../../../src/ports/risk';
import type { FeedHealthPort } from '../../../src/ports/market-data';
import type { SymbolFilters } from '../../../src/domain/risk/evaluate';
import type { ClockPort } from '../../../src/ports/clock';
import type { Signal } from '../../../src/domain/types/signal';
import type { PortfolioSnapshot, Position } from '../../../src/domain/types/portfolio';
import type { PartialRiskLimits } from '../../../src/domain/risk/limits';
import { price } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const T = 1700000000000;
const clock: ClockPort = { now: () => epochMs(T) };
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const SID = strategyId('s');
const FILTERS: SymbolFilters = {
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  minNotional: '5',
};
const LIMITS: PartialRiskLimits = {
  maxBandBps: 100,
  maxPassiveExitBandBps: 1200,
  maxStopTriggerBandBps: 2000,
  stopLimitBufferBps: 50,
  maxOrderNotional: '1000000',
  maxDriftBps: 100,
  maxPositionPerSymbol: '1000',
  maxGrossExposure: '1000000',
  maxNetExposure: '1000000',
  maxDailyLoss: '5000',
  maxDrawdownPct: '0.5',
  staleMaxAgeMs: 5000,
};
const sizerDeps: SizerDeps = {
  baseNotional: '1000',
  mode: 'paper',
  filters: new Map([[String(SYM), FILTERS]]),
  randomBytes: (n) => new Uint8Array(n).fill(3),
};
const engineDeps: RiskEngineDeps = {
  key: Buffer.alloc(32, 1),
  limits: LIMITS,
  limitsVersion: 'v1',
  mode: 'paper',
  filters: new Map([[String(SYM), FILTERS]]),
  randomBytes: (n) => new Uint8Array(n).fill(3),
};
const feed: FeedHealthPort = {
  getRefPrice: () => ({ mid: price('100'), at: epochMs(T) }),
  updateRefPrice: () => undefined,
  health: () => 'LIVE',
  fetchCandles: () => Promise.resolve([]),
};

function signal(o: Partial<Signal> = {}): Signal {
  return {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    kind: 'ENTER_LONG',
    strength: 1,
    refPrice: price('100'),
    basedOnSeq: 1n,
    eventTime: epochMs(T),
    ttlMs: 5000,
    dedupeKey: 'k1',
    reason: 'r',
    ...o,
  };
}

function snapshot(): PortfolioSnapshot {
  return {
    positions: new Map<string, Position>(),
    balances: new Map(),
    openOrders: [],
    inFlightIntents: [],
    equity: new Decimal(10_000),
    unrealized: new Decimal(0),
    startingCash: new Decimal(10_000),
    peakEquity: new Decimal(10_000),
    sodEquityUtc: new Decimal(10_000),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
  };
}

function makeGateway() {
  const kill = new KillSwitchService();
  const journal: RiskJournalPort = { record: () => undefined };
  const engine = new RiskEngineService(
    clock,
    engineDeps,
    feed,
    kill,
    new RateBucketsService(clock),
    new CrossingRegistryService(),
    journal,
  );
  const sizer = new PositionSizerService(clock, sizerDeps);
  return { gateway: new SignalGatewayService(clock, kill, sizer, engine), kill };
}

describe('SignalGatewayService', () => {
  it('sizes and decides a valid signal', () => {
    const { gateway } = makeGateway();
    const r = gateway.accept(signal(), snapshot());
    expect(r.status).toBe('DECIDED');
    if (r.status === 'DECIDED') expect(r.decision.verdict).toBe('APPROVED');
  });

  it('fast-fails when the kill switch is engaged', () => {
    const { gateway, kill } = makeGateway();
    kill.engage('test', false);
    expect(gateway.accept(signal(), snapshot())).toEqual({
      status: 'GATEWAY_REJECTED',
      reason: 'KILL_SWITCH',
    });
  });

  it('drops an expired signal', () => {
    const { gateway } = makeGateway();
    const r = gateway.accept(signal({ eventTime: epochMs(T - 10_000), ttlMs: 1000 }), snapshot());
    expect(r).toEqual({ status: 'GATEWAY_REJECTED', reason: 'EXPIRED' });
  });

  it('drops a duplicate dedupeKey', () => {
    const { gateway } = makeGateway();
    gateway.accept(signal(), snapshot());
    expect(gateway.accept(signal(), snapshot())).toEqual({
      status: 'GATEWAY_REJECTED',
      reason: 'DUPLICATE',
    });
  });

  it('surfaces a sizing rejection (no filters for the symbol)', () => {
    const { gateway } = makeGateway();
    const r = gateway.accept(signal({ symbol: symbolId('ETH/USDT'), dedupeKey: 'k2' }), snapshot());
    expect(r).toEqual({ status: 'SIZING_REJECTED', reason: 'NO_REF_PRICE' });
  });

  it('surfaces INVALID_STOP_RISK when the planned-stop cap is enabled and stopLossPct is invalid', () => {
    const kill = new KillSwitchService();
    const journal: RiskJournalPort = { record: () => undefined };
    const engine = new RiskEngineService(
      clock,
      engineDeps,
      feed,
      kill,
      new RateBucketsService(clock),
      new CrossingRegistryService(),
      journal,
    );
    const sizer = new PositionSizerService(clock, {
      ...sizerDeps,
      maxPlannedStopRiskFraction: '0.01',
    });
    const gateway = new SignalGatewayService(clock, kill, sizer, engine);
    const r = gateway.accept(signal({ stopLossPct: '0', dedupeKey: 'invalid-stop' }), snapshot());
    expect(r).toEqual({ status: 'SIZING_REJECTED', reason: 'INVALID_STOP_RISK' });
  });

  it('evicts dedupe keys past their TTL window while retaining live ones (bounded memory)', () => {
    let t = T;
    const mclock: ClockPort = { now: () => epochMs(t) };
    const kill = new KillSwitchService();
    const journal: RiskJournalPort = { record: () => undefined };
    const engine = new RiskEngineService(
      mclock,
      engineDeps,
      feed,
      kill,
      new RateBucketsService(mclock),
      new CrossingRegistryService(),
      journal,
    );
    const sizer = new PositionSizerService(mclock, sizerDeps);
    const gateway = new SignalGatewayService(mclock, kill, sizer, engine);

    // Two distinct keys accepted at T: one short-lived, one long-lived.
    gateway.accept(signal({ dedupeKey: 'short', eventTime: epochMs(T), ttlMs: 1000 }), snapshot());
    gateway.accept(signal({ dedupeKey: 'long', eventTime: epochMs(T), ttlMs: 60_000 }), snapshot());
    expect(gateway.pendingDedupeCount).toBe(2);

    // Advance past 'short' expiry but within 'long': a fresh accept evicts 'short' (now > expiry)
    // and retains 'long' (now <= expiry) — both eviction branches in one call.
    t = T + 5000;
    gateway.accept(
      signal({ dedupeKey: 'fresh', eventTime: epochMs(T + 5000), ttlMs: 5000 }),
      snapshot(),
    );
    expect(gateway.pendingDedupeCount).toBe(2); // 'short' gone, 'long' + 'fresh' retained

    // Retention proof: 'long' replayed inside its window is still rejected as a duplicate.
    expect(
      gateway.accept(
        signal({ dedupeKey: 'long', eventTime: epochMs(T), ttlMs: 60_000 }),
        snapshot(),
      ),
    ).toEqual({ status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' });
  });
});
