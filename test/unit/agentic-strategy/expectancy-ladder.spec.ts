import { describe, it, expect } from 'vitest';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
} from '../../../src/features/trading/agentic/agentic.strategy';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../src/ports/agentic-strategy';
import type { RoundTripEvidence, RoundTripEvidencePort } from '../../../src/ports/promotion';
import type { Signal } from '../../../src/domain/types/signal';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import { price, qty } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const T = 14_400_000 * 100_000;

function candle(index: number): CandleEvent {
  const t = T + index * 900_000;
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: SYM,
    channel: 'candle:15m',
    seq: BigInt(index + 1),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '15m',
    openTime: epochMs(t),
    closeTime: epochMs(t + 900_000),
    open: price('100'),
    high: price('100'),
    low: price('100'),
    close: price('100'),
    volume: qty('1'),
    closed: true,
  };
}

function buildInput(): AgentDecisionInput {
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(T),
    candles: new Map([[SYM, [candle(0)]]]),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
  };
  return { strategyId: SID, trigger: { kind: 'candle', event: candle(0) }, snapshot };
}

function enterLong(strength: number): Signal {
  return {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    kind: 'ENTER_LONG',
    strength,
    refPrice: price('100'),
    basedOnSeq: 1n,
    eventTime: epochMs(T),
    ttlMs: 120_000,
    dedupeKey: 'k1',
    reason: 'r',
  };
}

class FixedClient implements AgentClientPort {
  constructor(private readonly signals: Signal[]) {}
  propose(_input: AgentDecisionInput): Promise<AgentProposal> {
    void _input;
    return Promise.resolve({ signals: this.signals });
  }
}

function trip(netPnl: string): RoundTripEvidence {
  return {
    strategyId: SID,
    symbol: SYM,
    openedAt: T,
    closedAt: T + 1,
    holdingMs: 1,
    entryVwap: '100',
    exitVwap: '100',
    boughtQty: '1',
    realizedPnl: netPnl,
    feesQuote: '0',
    netPnl,
    meanSlippageBps: null,
  };
}

function makeStrategy(
  signals: Signal[],
  trips: RoundTripEvidence[] | Error,
  enabled = true,
): AgenticStrategy {
  const params: AgenticStrategyParams = {
    symbol: SYM,
    venue: V,
    interval: '15m',
    warmupBars: 5,
    model: 'test-model',
    expectancyLadderEnabled: enabled,
  };
  const evidence: RoundTripEvidencePort = {
    recentRoundTrips: () =>
      trips instanceof Error ? Promise.reject(trips) : Promise.resolve(trips),
    reflectionSeed: () =>
      Promise.resolve({
        closedTradesTotal: 0,
        closedSinceLastReflection: 0,
        lastReflectionAt: null,
      }),
  };
  const deps: AgenticStrategyDeps = { evidence };
  return new AgenticStrategy(SID, params, new FixedClient(signals), deps);
}

describe('AgenticStrategy expectancy ladder (W4.2)', () => {
  it('leaves strength unchanged when the flag is off', async () => {
    const strategy = makeStrategy([enterLong(0.8)], [trip('-5'), trip('-5')], false);
    const out = await strategy.decide(buildInput());
    expect(out[0]!.strength).toBe(0.8);
  });

  it('leaves strength unchanged with insufficient data (<8 own closed trips)', async () => {
    const strategy = makeStrategy(
      [enterLong(0.8)],
      Array.from({ length: 7 }, () => trip('-5')),
    );
    const out = await strategy.decide(buildInput());
    expect(out[0]!.strength).toBe(0.8);
  });

  it('leaves strength unchanged when rolling expectancy is non-negative', async () => {
    const strategy = makeStrategy(
      [enterLong(0.8)],
      Array.from({ length: 10 }, () => trip('0.5')),
    );
    const out = await strategy.decide(buildInput());
    expect(out[0]!.strength).toBe(0.8);
  });

  it('scales by 0.7 when mean net PnL is slightly negative (≥ -0.10 USD)', async () => {
    const strategy = makeStrategy(
      [enterLong(0.8)],
      Array.from({ length: 10 }, () => trip('-0.05')),
    );
    const out = await strategy.decide(buildInput());
    // 0.8 × 0.7 = 0.56 exactly (binary-exact operands are not money — strength is a plain ratio).
    expect(out[0]!.strength).toBeGreaterThan(0.559);
    expect(out[0]!.strength).toBeLessThan(0.561);
  });

  it('scales by 0.4 when mean net PnL is clearly negative, flooring at MIN strength', async () => {
    const strategy = makeStrategy(
      [enterLong(0.2)],
      Array.from({ length: 10 }, () => trip('-5')),
    );
    const out = await strategy.decide(buildInput());
    // 0.2 × 0.4 = 0.08 → floored at the 0.1 minimum the client itself enforces.
    expect(out[0]!.strength).toBe(0.1);
  });

  it('never scales non-ENTER_LONG signals', async () => {
    const exit: Signal = { ...enterLong(1), kind: 'EXIT_LONG' };
    const strategy = makeStrategy(
      [exit],
      Array.from({ length: 10 }, () => trip('-5')),
    );
    const out = await strategy.decide(buildInput());
    expect(out[0]!.strength).toBe(1);
  });

  it('fails open to full strength when the evidence port throws', async () => {
    const strategy = makeStrategy([enterLong(0.8)], new Error('db down'));
    const out = await strategy.decide(buildInput());
    expect(out[0]!.strength).toBe(0.8);
  });
});
