import { describe, it, expect } from 'vitest';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
} from '../../../../src/features/strategy/agentic/agentic.strategy';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { CandleEvent } from '../../../../src/domain/venue/types/market-events';
import type { OpenOrderSummary } from '../../../../src/domain/trading/types/portfolio';
import { price, qty } from '../../../../src/domain/common/types/money';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
} from '../../../../src/domain/common/types/ids';

const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const OTHER_SYM = symbolId('ETH/USDT');
const STEP_MS = 900_000; // 15m
const BASE_TIME = 14_400_000 * 100_000;

function candle(index: number): CandleEvent {
  const t = BASE_TIME + index * STEP_MS;
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
    closeTime: epochMs(t + STEP_MS),
    open: price('100'),
    high: price('100'),
    low: price('100'),
    close: price('100'),
    volume: qty('1'),
    closed: true,
  };
}

function order(id: string, over: Partial<OpenOrderSummary> = {}): OpenOrderSummary {
  return {
    clientOrderId: clientOrderId(id),
    symbol: SYM,
    side: 'BUY',
    qty: qty('0.001'),
    ...over,
  };
}

// One decide cycle at bar `index` with the given open orders visible in the snapshot.
function buildInput(index: number, openOrders: OpenOrderSummary[]): AgentDecisionInput {
  const candles = Array.from({ length: index + 1 }, (_, i) => candle(i));
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(BASE_TIME + index * STEP_MS),
    candles: new Map([[SYM, candles]]),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders },
  };
  return { strategyId: SID, trigger: { kind: 'candle', event: candle(index) }, snapshot };
}

class StubClient implements AgentClientPort {
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    void input;
    return Promise.resolve({ signals: [] });
  }
}

function makeStrategy(entryTtlBars: number): AgenticStrategy {
  const params: AgenticStrategyParams = {
    symbol: SYM,
    venue: V,
    interval: '15m',
    warmupBars: 5,
    model: 'test-model',
    entryTtlBars,
  };
  return new AgenticStrategy(SID, params, new StubClient());
}

const COID = 'cbp0000000000000007000800000000000001';
const COID2 = 'cbp0000000000000007000800000000000002';

describe('AgenticStrategy stale-entry sweep (W2.1)', () => {
  it('emits CANCEL_OPEN once a resting BUY has been observed for entryTtlBars cycles, not before', async () => {
    const strategy = makeStrategy(2);
    const resting = [order(COID)];

    // Bar 0: first sighting — no age yet. Bar 1: 1 bar old. Bar 2: 2 bars old ⇒ stale.
    expect(await strategy.decide(buildInput(0, resting))).toEqual([]);
    expect(await strategy.decide(buildInput(1, resting))).toEqual([]);
    const signals = await strategy.decide(buildInput(2, resting));

    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('CANCEL_OPEN');
    expect(signals[0]!.symbol).toBe(SYM);
    expect(signals[0]!.strategyId).toBe(SID);
    // BUY-scoped to match the sweep's own BUY-only detection — an unscoped cancel would also take
    // out a resting venue-TP SELL sharing the symbol (review finding).
    expect(signals[0]!.cancelSide).toBe('BUY');
  });

  it('suppresses re-emission on the next bar, then re-arms after another full TTL window', async () => {
    const strategy = makeStrategy(2);
    const resting = [order(COID)];

    await strategy.decide(buildInput(0, resting));
    await strategy.decide(buildInput(1, resting));
    expect(await strategy.decide(buildInput(2, resting))).toHaveLength(1); // first sweep
    expect(await strategy.decide(buildInput(3, resting))).toEqual([]); // in-flight: suppressed
    expect(await strategy.decide(buildInput(4, resting))).toHaveLength(1); // TTL again: re-armed
  });

  it('ignores other symbols and SELL-side orders; forgets orders that disappear', async () => {
    const strategy = makeStrategy(1);
    const foreign = [order(COID, { symbol: OTHER_SYM }), order(COID2, { side: 'SELL' })];

    expect(await strategy.decide(buildInput(0, foreign))).toEqual([]);
    expect(await strategy.decide(buildInput(1, foreign))).toEqual([]);

    // A tracked order that fills/cancels (disappears) is pruned; re-appearing restarts its age.
    const strategy2 = makeStrategy(2);
    await strategy2.decide(buildInput(0, [order(COID)]));
    await strategy2.decide(buildInput(1, [])); // gone — pruned
    await strategy2.decide(buildInput(2, [order(COID)])); // back: age restarts
    expect(await strategy2.decide(buildInput(3, [order(COID)]))).toEqual([]); // only 1 bar old
    expect(await strategy2.decide(buildInput(4, [order(COID)]))).toHaveLength(1);
  });

  it('0 disables the sweep entirely', async () => {
    const strategy = makeStrategy(0);
    const resting = [order(COID)];
    for (let bar = 0; bar < 5; bar += 1) {
      expect(await strategy.decide(buildInput(bar, resting))).toEqual([]);
    }
  });
});
