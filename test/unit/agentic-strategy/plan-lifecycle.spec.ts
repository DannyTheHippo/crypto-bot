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

function makeParams(planMode = true): AgenticStrategyParams {
  return {
    symbol: SYM,
    venue: V,
    interval: '15m',
    warmupBars: 5,
    model: 'test-model',
    planMode,
    planMaxQuietBars: 4,
  };
}

function makeStrategy(client: AgentClientPort, planMode = true): AgenticStrategy {
  return new AgenticStrategy(SID, makeParams(planMode), client);
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

  it('executor exit signals carry a multi-bar TTL, never one bar (gateway TTL race regression)', async () => {
    // Live 2026-07-07: a max_hold plan exit was GATEWAY_REJECTED:EXPIRED at age 902.2s vs
    // ttl 900s — executor signals anchor eventTime to the evaluated bar's close, so a one-bar
    // TTL loses the race against its own age on any ≥2s jitter. Default planExitTtlBars = 2.
    const client = new PlanningClient();
    const strategy = makeStrategy(client);
    await strategy.decide(buildInput(0));
    const out = await strategy.decide(
      buildInput(1, { close: '98', position: longPosition('100') }),
    );
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.ttlMs).toBe(2 * STEP_MS);
  });

  it('planExitTtlBars below the 2-bar floor is clamped up, never trusted', async () => {
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(
      SID,
      {
        symbol: SYM,
        venue: V,
        interval: '15m',
        warmupBars: 5,
        model: 'test-model',
        planMode: true,
        planMaxQuietBars: 4,
        planExitTtlBars: 1,
      },
      client,
    );
    await strategy.decide(buildInput(0));
    const out = await strategy.decide(
      buildInput(1, { close: '98', position: longPosition('100') }),
    );
    expect(out[0]!.ttlMs).toBe(2 * STEP_MS);
  });

  it('samples the market payload every Nth managed bar (W6) — others stay null', async () => {
    const client = new PlanningClient();
    const entries: Array<{ has: boolean }> = [];
    const strategy = new AgenticStrategy(
      SID,
      {
        symbol: SYM,
        venue: V,
        interval: '15m',
        warmupBars: 5,
        model: 'test-model',
        planMode: true,
        planMaxQuietBars: 8, // > the bars we drive, so no consult interrupts the quiet holds
        quietPayloadSampleBars: 2,
      },
      client,
      {
        journal: {
          record: (e) => entries.push({ has: e.inputPayload !== null }),
          recent: () => Promise.resolve([]),
        },
      },
    );
    await strategy.decide(buildInput(0)); // consult → plan stored (records a decide entry)
    entries.length = 0; // ignore the initial consult journal; measure only managed quiet bars
    // Bars 1..3 hold the position at entry (close 100 = avgEntry, no TP/SL) → managed quiet holds.
    for (let i = 1; i <= 3; i++) {
      await strategy.decide(buildInput(i, { close: '100', position: longPosition('100') }));
    }
    // barsElapsed 1,2,3 → sample on 2 only (barsElapsed % 2 === 0): [null, payload, null].
    expect(entries.map((e) => e.has)).toEqual([false, true, false]);
  });

  it('never samples a managed-bar payload when quietPayloadSampleBars is 0 (default, byte-identical)', async () => {
    const client = new PlanningClient();
    const entries: Array<{ has: boolean }> = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        record: (e) => entries.push({ has: e.inputPayload !== null }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0));
    entries.length = 0;
    for (let i = 1; i <= 3; i++) {
      await strategy.decide(buildInput(i, { close: '100', position: longPosition('100') }));
    }
    expect(entries.every((e) => !e.has)).toBe(true);
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

// The active plan is in-memory and lost on restart, leaving an open position consulted every bar.
// The model sees that state as position.managedPlan === false and re-attaches management by
// returning a plan with its 'hold' (the client's re-arm acceptance path) — these tests pin the
// strategy half: the context flag rendering and the arm-without-signal lifecycle.
describe('AgenticStrategy plan re-arm on an open position (restart self-heal)', () => {
  // hold+plan on the first consult (the re-arm), plain hold afterwards; captures every context the
  // LLM was actually shown so the managedPlan flag can be asserted per consult.
  class RearmingClient implements AgentClientPort {
    calls = 0;
    readonly seenManagedPlan: Array<boolean | undefined> = [];
    propose(input: AgentDecisionInput): Promise<AgentProposal> {
      this.calls += 1;
      this.seenManagedPlan.push(input.context?.position.managedPlan);
      return Promise.resolve({
        signals: [],
        decision: { action: 'hold', confidence: 0.5, rationale: 'r' },
        ...(this.calls === 1 ? { plan: PLAN } : {}),
      });
    }
  }

  it('re-arms from a bare LONG (managedPlan false → hold+plan → deterministic bars → TP exit off avgEntry)', async () => {
    const client = new RearmingClient();
    const strategy = makeStrategy(client);
    const held = longPosition('100');

    // Post-restart shape: LONG position, no active plan → forced consult, flagged unmanaged.
    const first = await strategy.decide(buildInput(0, { position: held }));
    expect(client.calls).toBe(1);
    expect(client.seenManagedPlan[0]).toBe(false);
    expect(first).toEqual([]); // re-arm carries no signal — no double entry, no exit

    // Next quiet bar: plan-executor manages, LLM not consulted, entry anchored to avgEntry.
    const second = await strategy.decide(buildInput(1, { position: held }));
    expect(client.calls).toBe(1);
    expect(second).toEqual([]);

    // Anchor discriminator: avgEntry-anchored TP = 100 × 1.03 = 103, while a (wrong)
    // entryOffsetBps-anchored TP would be 99.9 × 1.03 = 102.897 — a 102.95 close exits only
    // under the wrong anchoring, so it must still HOLD here.
    const between = await strategy.decide(buildInput(2, { close: '102.95', position: held }));
    expect(between).toEqual([]);

    const third = await strategy.decide(buildInput(3, { close: '103', position: held }));
    expect(client.calls).toBe(1);
    expect(third).toHaveLength(1);
    expect(third[0]!.kind).toBe('EXIT_LONG');
    expect(third[0]!.reason).toBe('plan exit: take_profit');
  });

  it('reports managedPlan true on the safety-cadence consult of a re-armed plan', async () => {
    const client = new RearmingClient();
    const strategy = makeStrategy(client); // planMaxQuietBars = 4
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held })); // consult 1: bare → re-arm
    await strategy.decide(buildInput(1, { position: held })); // bars 1-3 managed
    await strategy.decide(buildInput(2, { position: held }));
    await strategy.decide(buildInput(3, { position: held }));
    await strategy.decide(buildInput(4, { position: held })); // barsElapsed=4 → safety consult
    expect(client.calls).toBe(2);
    expect(client.seenManagedPlan).toEqual([false, true]);
  });

  it('renders no managedPlan field outside plan mode (legacy payloads stay byte-identical)', async () => {
    const client = new RearmingClient();
    const strategy = makeStrategy(client, false);
    await strategy.decide(buildInput(0, { position: longPosition('100') }));
    expect(client.seenManagedPlan).toEqual([undefined]);
  });

  it('renders no managedPlan field while FLAT (plan mode on)', async () => {
    const client = new RearmingClient();
    const strategy = makeStrategy(client);
    await strategy.decide(buildInput(0));
    expect(client.seenManagedPlan).toEqual([undefined]);
  });
});

// W1.3 follow-on: the accepted plan a decision carried must reach the journal row (persistence
// unlock for offline replay through the settlement backtest harness) — these pin the mapping at
// the strategy boundary (recordJournalEntry), not the DB adapter/schema (covered in test/db).
describe('AgenticStrategy journals the accepted plan (persistence)', () => {
  // Plain hold, no plan — the client-omits-decision negative case for the journal mapping below.
  class FlatHoldClient implements AgentClientPort {
    propose(): Promise<AgentProposal> {
      return Promise.resolve({
        signals: [],
        decision: { action: 'hold', confidence: 0.5, rationale: 'no edge' },
      });
    }
  }

  // hold+plan on a bare LONG position — the re-arm acceptance path (see the
  // 'AgenticStrategy plan re-arm on an open position' describe block above for the full lifecycle).
  class ReArmOnceClient implements AgentClientPort {
    propose(): Promise<AgentProposal> {
      return Promise.resolve({
        signals: [],
        decision: { action: 'hold', confidence: 0.5, rationale: 'r' },
        plan: PLAN,
      });
    }
  }

  it('journals the accepted plan fields on a fresh long-with-plan entry', async () => {
    const client = new PlanningClient();
    const entries: Array<{ plan?: AgentPlan | null }> = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        record: (e) => entries.push({ plan: e.plan }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.plan).toEqual(PLAN);
  });

  it('journals null for a plan-less hold decision', async () => {
    const client = new FlatHoldClient();
    const entries: Array<{ plan?: AgentPlan | null }> = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        record: (e) => entries.push({ plan: e.plan }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.plan).toBeNull();
  });

  it('journals the accepted plan on the restart re-arm consult (hold+plan while LONG)', async () => {
    const client = new ReArmOnceClient();
    const entries: Array<{ plan?: AgentPlan | null }> = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        record: (e) => entries.push({ plan: e.plan }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0, { position: longPosition('100') })); // bare LONG → re-arm
    expect(entries).toHaveLength(1);
    expect(entries[0]!.plan).toEqual(PLAN);
  });
});
