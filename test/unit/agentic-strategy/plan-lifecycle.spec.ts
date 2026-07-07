import { describe, it, expect } from 'vitest';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
} from '../../../src/features/trading/agentic/agentic.strategy';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentPlan,
  AgentProposal,
} from '../../../src/ports/agentic-strategy';
import type { Signal } from '../../../src/domain/types/signal';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type { OpenOrderSummary, Position } from '../../../src/domain/types/portfolio';
import { price, qty } from '../../../src/domain/types/money';
import Decimal from 'decimal.js';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
} from '../../../src/domain/types/ids';

const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const STEP_MS = 900_000;
const BASE_TIME = 14_400_000 * 100_000;

function candle(index: number, close = '100'): CandleEvent {
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
    open: price(close),
    high: price(close),
    low: price(close),
    close: price(close),
    volume: qty('1'),
    closed: true,
  };
}

function longPosition(avgEntry: string): Position {
  return {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    signedQty: new Decimal('0.001'),
    avgEntry: price(avgEntry),
    realizedPnl: new Decimal(0),
  };
}

function buildInput(
  index: number,
  opts: { close?: string; position?: Position; openOrders?: OpenOrderSummary[] } = {},
): AgentDecisionInput {
  const candles = Array.from({ length: index + 1 }, (_, i) =>
    candle(i, i === index ? (opts.close ?? '100') : '100'),
  );
  const positions = new Map<string, Position>();
  if (opts.position) positions.set(`${SID}|${V}|${SYM}`, opts.position);
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(BASE_TIME + index * STEP_MS),
    candles: new Map([[SYM, candles]]),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions, openOrders: opts.openOrders ?? [] },
  };
  return { strategyId: SID, trigger: { kind: 'candle', event: candle(index) }, snapshot };
}

const PLAN: AgentPlan = {
  entryOffsetBps: 10,
  stopLossPct: '0.02',
  takeProfitPct: '0.03',
  entryValidityBars: 2,
  maxHoldBars: 8,
};

// Returns an ENTER_LONG + plan on every call; counts calls so the tests can assert exactly when the
// LLM was (not) consulted while a plan is active.
class PlanningClient implements AgentClientPort {
  calls = 0;
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    this.calls += 1;
    const signal: Signal = {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      kind: 'ENTER_LONG',
      strength: 0.8,
      refPrice: price('100'),
      basedOnSeq: 1n,
      eventTime: input.snapshot.eventTime,
      ttlMs: 120_000,
      dedupeKey: `k${this.calls}`,
      reason: 'r',
    };
    return Promise.resolve({
      signals: [signal],
      decision: { action: 'long', confidence: 0.8, rationale: 'r' },
      plan: PLAN,
    });
  }
}

function makeStrategy(client: AgentClientPort, planMode = true): AgenticStrategy {
  const params: AgenticStrategyParams = {
    symbol: SYM,
    venue: V,
    interval: '15m',
    warmupBars: 5,
    model: 'test-model',
    planMode,
    planMaxQuietBars: 4,
  };
  return new AgenticStrategy(SID, params, client);
}

describe('AgenticStrategy plan lifecycle (W3.1)', () => {
  it('stores a returned plan and stops consulting the LLM on quiet bars', async () => {
    const client = new PlanningClient();
    const strategy = makeStrategy(client);
    const restingEntry: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000001'),
      symbol: SYM,
      side: 'BUY',
      qty: qty('0.001'),
    };

    await strategy.decide(buildInput(0)); // consult → plan stored
    expect(client.calls).toBe(1);
    // Bar 1: plan active, resting entry within validity — deterministic hold, NO LLM call.
    const quiet = await strategy.decide(buildInput(1, { openOrders: [restingEntry] }));
    expect(client.calls).toBe(1);
    expect(quiet).toEqual([]);
  });

  it('exits via take-profit deterministically and clears the plan', async () => {
    const client = new PlanningClient();
    const strategy = makeStrategy(client);
    await strategy.decide(buildInput(0)); // plan stored

    // Bar 1: position LONG at 100 — entry captured, close 100 → hold, no LLM.
    await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(client.calls).toBe(1);
    // Bar 2: close 103.5 ≥ 100×1.03 → TP exit, still no LLM.
    const out = await strategy.decide(
      buildInput(2, { close: '103.5', position: longPosition('100') }),
    );
    expect(client.calls).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.reason).toBe('plan exit: take_profit');
  });

  it('exits via stop-loss when close breaches entry×(1−stopLossPct)', async () => {
    const client = new PlanningClient();
    const strategy = makeStrategy(client);
    await strategy.decide(buildInput(0));
    const out = await strategy.decide(
      buildInput(1, { close: '98', position: longPosition('100') }),
    );
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.reason).toBe('plan exit: stop');
  });

  it('cancels an unfilled entry after entryValidityBars and clears the plan', async () => {
    const client = new PlanningClient();
    const strategy = makeStrategy(client);
    const restingEntry: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000001'),
      symbol: SYM,
      side: 'BUY',
      qty: qty('0.001'),
    };
    await strategy.decide(buildInput(0)); // plan stored (validity 2 bars)
    await strategy.decide(buildInput(1, { openOrders: [restingEntry] })); // bar 1: hold
    const out = await strategy.decide(buildInput(2, { openOrders: [restingEntry] })); // bar 2: lapse

    expect(client.calls).toBe(1);
    const cancel = out.find((s) => s.kind === 'CANCEL_OPEN' && s.reason.includes('plan cleared'));
    expect(cancel).toBeDefined();
  });

  it('re-consults the LLM on the safety cadence while a plan is active', async () => {
    const client = new PlanningClient();
    const strategy = makeStrategy(client); // planMaxQuietBars = 4
    await strategy.decide(buildInput(0)); // consult 1, plan stored
    const held = longPosition('100');
    await strategy.decide(buildInput(1, { position: held })); // bars 1-3: quiet
    await strategy.decide(buildInput(2, { position: held }));
    await strategy.decide(buildInput(3, { position: held }));
    expect(client.calls).toBe(1);
    await strategy.decide(buildInput(4, { position: held })); // bar 4: barsElapsed=4 → re-consult
    expect(client.calls).toBe(2);
  });

  it('flag off keeps consulting the LLM every bar (legacy behavior)', async () => {
    const client = new PlanningClient();
    const strategy = makeStrategy(client, false);
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1));
    await strategy.decide(buildInput(2));
    expect(client.calls).toBe(3);
  });
});
