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
import { price, qty } from '../../../../src/domain/common/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';

const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const STEP_MS = 900_000; // 15m
// Aligned to the h4 (4h = 14_400_000ms) bucket width so the first aggregated bucket is never a
// partial one — an unaligned base offset (e.g. Date.now()-derived) would silently eat up to
// factor-1 leading candles into a dropped partial bucket, undercounting closed HTF bars for a
// given fixture length.
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

function buildInput(candles: CandleEvent[]): AgentDecisionInput {
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(BASE_TIME),
    candles: new Map([[SYM, candles]]),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
  };
  return { strategyId: SID, trigger: { kind: 'candle', event: candle(0) }, snapshot };
}

class CapturingAgentClient implements AgentClientPort {
  readonly inputs: AgentDecisionInput[] = [];
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    this.inputs.push(input);
    return Promise.resolve({ signals: [] });
  }
}

function makeStrategy(warmupBars: number): {
  strategy: AgenticStrategy;
  client: CapturingAgentClient;
} {
  const client = new CapturingAgentClient();
  const params: AgenticStrategyParams = {
    symbol: SYM,
    venue: V,
    interval: '15m',
    warmupBars,
    model: 'test-model',
    // I1b (Design § Deleted scaffolding — B2 consult scheduler): a fresh, FLAT, non-exec-triggered
    // strategy now waits for evaluateConsultSchedule's fallback cadence before its very FIRST
    // consult (fallbackConsultBars, default 16) — every fixture in this file predates B2 and expects
    // its single decide() call to reach the client immediately, so fallbackConsultBars=1 makes bar 1
    // due on schedule (forced_fallback) without touching production scheduler semantics.
    fallbackConsultBars: 1,
  };
  return { strategy: new AgenticStrategy(SID, params, client), client };
}

describe('AgenticStrategy HTF warmup regression', () => {
  it('leaves both h1 and h4 null at the production-current 51-bar retained history', async () => {
    const { strategy, client } = makeStrategy(50);
    const candles = Array.from({ length: 51 }, (_, i) => candle(i));

    await strategy.decide(buildInput(candles));

    const htf = client.inputs[0]!.context!.htf!;
    expect(htf.h1).toBeNull();
    expect(htf.h4).toBeNull();
  });

  it('computes non-null h1 and h4 once 340 bars of history are retained', async () => {
    const { strategy, client } = makeStrategy(339);
    const candles = Array.from({ length: 340 }, (_, i) => candle(i));

    await strategy.decide(buildInput(candles));

    const htf = client.inputs[0]!.context!.htf!;
    expect(htf.h1).not.toBeNull();
    expect(htf.h4).not.toBeNull();
  });
});
