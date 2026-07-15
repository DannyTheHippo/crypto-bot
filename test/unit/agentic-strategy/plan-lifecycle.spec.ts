import { describe, it, expect } from 'vitest';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type VenueTpEvent,
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
import type {
  OpenOrderSummary,
  Position,
  PortfolioSnapshot,
} from '../../../src/domain/types/portfolio';
import { price, qty } from '../../../src/domain/types/money';
import Decimal from 'decimal.js';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
  intentId,
} from '../../../src/domain/types/ids';
import { positionKey, type SymbolFilters } from '../../../src/domain/risk/evaluate';
import type { PlanStop, PlanStopRegistryPort } from '../../../src/ports/risk';
import type { ClockPort } from '../../../src/ports/clock';
import type { ExecutionStorePort } from '../../../src/ports/execution';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import { PositionSizerService } from '../../../src/features/trading/risk/position-sizer.service';

const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const STEP_MS = 900_000;
const BASE_TIME = 14_400_000 * 100_000;
const REG_KEY = positionKey(SID, V, SYM);

// Push 3 P2: trivial in-test double of PlanStopRegistryService (features/trading/risk) — mirrors the
// one in test/unit/risk/protective-exit.service.spec.ts.
function planStopRegistry(
  entries: ReadonlyMap<string, PlanStop> = new Map(),
): PlanStopRegistryPort {
  const stops = new Map(entries);
  return {
    set: (key, stop) => void stops.set(key, stop),
    clear: (key) => void stops.delete(key),
    get: (key) => stops.get(key),
    entries: () => stops,
  };
}

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

// Push II Phase 5 follow-on: the batch join key a batched proposal carried (AgentProposal.consultId)
// must reach the journal row the same way AgentProposal.plan does — pinned at the same strategy
// boundary (recordJournalEntry), not the DB adapter/schema (covered in test/db).
describe('AgenticStrategy journals the batch consultId (persistence)', () => {
  class ConsultIdClient implements AgentClientPort {
    constructor(private readonly consultId?: string) {}
    propose(): Promise<AgentProposal> {
      return Promise.resolve({
        signals: [],
        decision: { action: 'hold', confidence: 0.5, rationale: 'no edge' },
        ...(this.consultId ? { consultId: this.consultId } : {}),
      });
    }
  }

  it('journals the batch consultId when the proposal carried one', async () => {
    const client = new ConsultIdClient('consult-xyz');
    const entries: Array<{ consultId?: string | null }> = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        record: (e) => entries.push({ consultId: e.consultId }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.consultId).toBe('consult-xyz');
  });

  it('journals null for a decision from an unbatched (single-symbol) proposal', async () => {
    const client = new ConsultIdClient();
    const entries: Array<{ consultId?: string | null }> = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        record: (e) => entries.push({ consultId: e.consultId }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.consultId).toBeNull();
  });
});

// Push 3 P7c: minimal-but-full OrderIntent fixture — only source.dedupeKey is ever read
// (AgenticStrategy.roleForOrder), the rest is filler matching test/unit/risk/property.spec.ts's own
// convention for a throwaway intent literal.
const TEST_IID = intentId('0190abcd-1234-7abc-89ab-0123456789ab');
function intentWithDedupeKey(
  coid: OpenOrderSummary['clientOrderId'],
  dedupeKey: string,
): OrderIntent {
  return {
    intentId: TEST_IID,
    clientOrderId: coid,
    strategyId: SID,
    venue: V,
    symbol: SYM,
    side: 'SELL',
    type: 'LIMIT',
    qty: qty('0.001'),
    limitPrice: price('100'),
    timeInForce: 'GTC',
    reduceOnly: true,
    mode: 'paper',
    refPrice: price('100'),
    refSeq: 1n,
    createdAt: epochMs(0),
    expiresAt: epochMs(10_000),
    source: { dedupeKey, eventTime: epochMs(0), basedOnSeq: 1n, strength: 1 },
  };
}

// Every resting SELL/BUY fixture in the two venue-TP describe blocks below represents the plan's OWN
// venue-TP order (this suite predates P7c's vtp/vsl role split) — resolving ANY clientOrderId to a
// legacy-shaped 'agentic:venue_tp_place' dedupeKey proves the "legacy compatibility is free" design:
// no fixture needed updating beyond wiring this store, the SAME dedupeKey shape manageVenueTp itself
// has stamped on every venue-TP placement since inception (see manageVenueTp's own dedupeKey).
function vtpOnlyIntentStore(): Pick<ExecutionStorePort, 'loadIntentByClientOrderId'> {
  return {
    loadIntentByClientOrderId: (coid) =>
      Promise.resolve(intentWithDedupeKey(coid, 'agentic:venue_tp_place:legacy-fixture')),
  };
}

// Push 3 P7c: two-resting-order discrimination — resolves EACH clientOrderId to its OWN dedupeKey so
// a single bar can carry a 'vtp' order and a 'vsl' order (P7d convention) simultaneously.
function roledIntentStore(
  roleByClientOrderId: ReadonlyMap<string, 'vtp' | 'vsl'>,
): Pick<ExecutionStorePort, 'loadIntentByClientOrderId'> {
  return {
    loadIntentByClientOrderId: (coid) => {
      const role = roleByClientOrderId.get(String(coid));
      if (role === undefined) return Promise.resolve(null);
      const marker = role === 'vtp' ? 'agentic:venue_tp_place' : 'agentic:venue_stop_place';
      return Promise.resolve(intentWithDedupeKey(coid, `${marker}:fixture`));
    },
  };
}

// AGENTIC_VENUE_TP: venue-resting take-profit lifecycle for plan-mode longs (see agentic.strategy.ts's
// manageVenueTp/runActivePlan). PLAN here: avgEntry 100, takeProfitPct 0.03 ⇒ TP price 103 exactly;
// stopLossPct 0.02 ⇒ stop price 98 exactly. planMaxQuietBars is set well above every bar driven in
// these tests so the safety-consult cadence never interrupts venue-TP management.
describe('AgenticStrategy venue-resting take-profit lifecycle (AGENTIC_VENUE_TP)', () => {
  function venueTpParams(overrides: Partial<AgenticStrategyParams> = {}): AgenticStrategyParams {
    return {
      symbol: SYM,
      venue: V,
      interval: '15m',
      warmupBars: 5,
      model: 'test-model',
      planMode: true,
      planMaxQuietBars: 20,
      venueTpEnabled: true,
      ...overrides,
    };
  }

  function restingSell(limitPriceStr: string, qtyStr = '0.001'): OpenOrderSummary {
    return {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000002'),
      symbol: SYM,
      side: 'SELL',
      qty: qty(qtyStr),
      limitPrice: price(limitPriceStr),
    };
  }

  it('places a RESTING EXIT_LONG at the exact TP price on the fill-observation bar', async () => {
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, venueTpParams(), client);
    await strategy.decide(buildInput(0)); // consult → plan stored

    // Bar 1: position now shows LONG at avgEntry 100 — entry captured, close 100 → hold verdict,
    // no resting SELL yet ⇒ TP placement.
    const out = await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(client.calls).toBe(1); // still no LLM consult
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.exitStyle).toBe('RESTING');
    expect(out[0]!.limitPriceHint!.toFixed()).toBe('103'); // 100 × 1.03 exactly
    expect(out[0]!.strategyId).toBe(SID);
  });

  it('emits nothing once a correctly-priced SELL already rests (skipped_existing, idempotent)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places TP (events: ['placed'])
    events.length = 0;

    // Bar 2: the TP now rests at exactly 103 — no drift, no new signal.
    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('103')] }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
  });

  it('cancels the resting SELL (cancelSide SELL) BEFORE the IOC EXIT_LONG on a stop exit', async () => {
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, venueTpParams(), client);
    await strategy.decide(buildInput(0));

    // Bar 1: entry captured at 100, close breaches the stop (98) while a TP already rests at 103 —
    // the resting SELL must be cancelled before the full-size IOC exit (else it venue-rejects for
    // insufficient balance, the base qty being locked by the resting order).
    const out = await strategy.decide(
      buildInput(1, {
        close: '98',
        position: longPosition('100'),
        openOrders: [restingSell('103')],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelSide).toBe('SELL');
    // Push 3 P7c: deliberately NO cancelRole — a stop/max_hold cancel-first must clear BOTH a
    // resting TP and a resting protective stop with the ONE signal (SignalSinkService's
    // cancelOpenForSignal cancels every side-matching order when cancelRole is absent).
    expect(out[0]!.cancelRole).toBeUndefined();
    expect(out[1]!.kind).toBe('EXIT_LONG');
    expect(out[1]!.reason).toBe('plan exit: stop');
  });

  it('cancels the resting SELL when its price drifts beyond the replace-drift threshold', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places TP at 103
    events.length = 0;

    // Bar 2: a SELL rests at 104 instead of the plan's 103 — drift = |104-103|/103 × 10000 ≈ 97bps,
    // well past the default 10bps threshold ⇒ cancel for next-bar re-placement, no exit.
    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('104')] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelSide).toBe('SELL');
    // Push 3 P7c: manageVenueTp's own reconciliation cancels scope to cancelRole:'vtp' — it never
    // touches a coexisting resting protective stop (see the two-resting-SELLs discrimination test).
    expect(out[0]!.cancelRole).toBe('vtp');
    expect(out[0]!.reason).toContain('drifted');
    expect(events).toEqual(['drift_cancel']);
  });

  it('clears the plan with no signal when the resting TP fills between bars (position_closed)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
    });
    await strategy.decide(buildInput(0)); // consult 1 → plan stored
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places TP
    events.length = 0;

    // Bar 2: the venue TP filled — position is now FLAT (no `position` in this bar's snapshot) with
    // no resting orders. No exit signal (the position is already flat); the plan clears silently.
    const out = await strategy.decide(buildInput(2));
    expect(out).toEqual([]);
    expect(events).toEqual(['filled_flat']);
    expect(client.calls).toBe(1);

    // Bar 3: activePlan is now null — the next bar forces a fresh LLM consult (proves the plan was
    // actually cleared, not just silently skipped this one bar).
    await strategy.decide(buildInput(3));
    expect(client.calls).toBe(2);
  });

  it('flag off: never emits a RESTING exit or a SELL-scoped CANCEL_OPEN (byte-identical to pre-feature)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams({ venueTpEnabled: false }), client, {
      onVenueTp: (e) => events.push(e),
    });
    await strategy.decide(buildInput(0)); // consult → plan stored

    // Bar 1: LONG at avgEntry 100 — entry captured, close 100 → hold. With the flag off, no TP is
    // ever placed regardless of the absent resting SELL.
    const held = await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(held).toEqual([]);

    // Bar 2: entryValidityBars(2) reached with the position externally FLAT (no `position` this
    // bar) — plan-executor.ts now reports position_closed unconditionally, but the flag-off remap
    // in runActivePlan reproduces the EXACT pre-position_closed verdict for this state (no resting
    // BUY ⇒ plan_expired), so the plan clears with no signal — same observable output as before
    // this feature existed.
    const cleared = await strategy.decide(buildInput(2));
    expect(cleared).toEqual([]);

    // Bar 3: plan is gone — forces a fresh consult, same as the legacy plan_expired path.
    await strategy.decide(buildInput(3));
    expect(client.calls).toBe(2);

    expect(events).toEqual([]); // no venue-TP metric ever fires with the flag off
  });

  it('holds without an exit when the close crosses the TP while the SELL still rests (tp_race_hold)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));

    // Bar 1: close 104 ≥ TP 103 while the resting SELL is still observed open — its own venue fill
    // is the exit; an IOC here would collide with the base the resting order locks. No signal, plan
    // retained.
    const out = await strategy.decide(
      buildInput(1, {
        close: '104',
        position: longPosition('100'),
        openOrders: [restingSell('103')],
      }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['tp_race_hold']);

    // Bar 2: the fill lands (FLAT, no orders) — the retained plan clears via position_closed.
    events.length = 0;
    const cleared = await strategy.decide(buildInput(2));
    expect(cleared).toEqual([]);
    expect(events).toEqual(['filled_flat']);
    expect(client.calls).toBe(1); // never re-consulted through the race
  });

  it('cancels the resting SELL when its qty no longer matches the position (qty_cancel)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places TP
    events.length = 0;

    // Bar 2: the SELL rests at the correct price but sized to an earlier partial fill (0.0005 vs
    // the position's 0.001) — the growth slice is uncovered at the venue ⇒ cancel to re-size.
    const out = await strategy.decide(
      buildInput(2, {
        position: longPosition('100'),
        openOrders: [restingSell('103', '0.0005')],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelSide).toBe('SELL');
    expect(out[0]!.cancelRole).toBe('vtp');
    expect(out[0]!.reason).toContain('qty');
    expect(events).toEqual(['qty_cancel']);
  });

  // 2026-07-15 loop fix regression: the venue rounds a reduce-only SELL to the LOT_SIZE step, so the
  // resting qty is structurally ≤ the full-precision position by the sub-step dust residue and can
  // NEVER equal position.qty exactly. Before the fix the exact-equality qty check read that dust as a
  // mismatch and emitted qty_cancel every managed bar (live DB 2026-07-15: LINK 12.03 vs 12.0396).
  function longPositionSubStep(): Position {
    return {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      signedQty: new Decimal('0.0012345'), // roundToStep(_, 0.00001, 'down') = 0.00123 (sub-step dust)
      avgEntry: price('100'),
      realizedPnl: new Decimal(0),
    };
  }

  it('does NOT churn when the resting SELL is the step-rounded sellable qty (dust residue → skipped_existing)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(
      SID,
      venueTpParams({ venueTpStepSize: '0.00001' }), // BTC LOT_SIZE step
      client,
      { onVenueTp: (e) => events.push(e), intentStore: vtpOnlyIntentStore() },
    );
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPositionSubStep() })); // places TP at 103
    events.length = 0;

    // Bar 2: the SELL rests at 103, qty 0.00123 = roundToStep(0.0012345, 0.00001, 'down'). The 0.0000045
    // residue is un-sellable dust (below one step) — a correctly-sized order, NOT a mismatch to churn.
    const out = await strategy.decide(
      buildInput(2, {
        position: longPositionSubStep(),
        openOrders: [restingSell('103', '0.00123')],
      }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
  });

  it('still cancels on a real ≥1-step qty mismatch when a step is configured (qty_cancel)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(
      SID,
      venueTpParams({ venueTpStepSize: '0.00001' }),
      client,
      { onVenueTp: (e) => events.push(e), intentStore: vtpOnlyIntentStore() },
    );
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPositionSubStep() }));
    events.length = 0;

    // Bar 2: the SELL rests at 0.001 — short of the 0.00123 sellable by 23 steps (a genuine uncovered
    // growth slice), so the step-rounded comparison still fires qty_cancel.
    const out = await strategy.decide(
      buildInput(2, {
        position: longPositionSubStep(),
        openOrders: [restingSell('103', '0.001')],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelRole).toBe('vtp');
    expect(events).toEqual(['qty_cancel']);
  });

  it('suppresses a duplicate placement for one bar while the first is unacked (skipped_inflight), then re-places', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
    });
    await strategy.decide(buildInput(0));

    // Bar 1: no SELL ⇒ placed.
    const first = await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(first).toHaveLength(1);

    // Bar 2: STILL no SELL observed (ack in flight) ⇒ suppressed, no duplicate.
    const second = await strategy.decide(buildInput(2, { position: longPosition('100') }));
    expect(second).toEqual([]);

    // Bar 3: still nothing resting — the placement evidently died (veto/TTL) ⇒ re-place.
    const third = await strategy.decide(buildInput(3, { position: longPosition('100') }));
    expect(third).toHaveLength(1);
    expect(third[0]!.exitStyle).toBe('RESTING');

    expect(events).toEqual(['placed', 'skipped_inflight', 'placed']);
  });

  it('holds a TP-crossing close through the in-flight placement window too (no IOC racing the unacked SELL)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places TP (in flight)
    events.length = 0;

    // Bar 2: close 104 crosses the TP but the SELL is NOT yet observed in openOrders (ack in
    // flight) — the IOC exit would race the unacked resting order. Hold, same as the observed case.
    const out = await strategy.decide(
      buildInput(2, { close: '104', position: longPosition('100') }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['tp_race_hold']);

    // Bar 3: still no SELL and the window is over (placement died) — the normal exit fires.
    events.length = 0;
    const exit = await strategy.decide(
      buildInput(3, { close: '104', position: longPosition('100') }),
    );
    expect(exit).toHaveLength(1);
    expect(exit[0]!.kind).toBe('EXIT_LONG');
    expect(exit[0]!.reason).toBe('plan exit: take_profit');
    expect(events).toEqual([]);
  });

  it('cancels an orphaned resting SELL when the position closed externally (orphan_cancel)', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places TP
    events.length = 0;

    // Bar 2: FLAT (external flatten) while the SELL still rests — the reduce-only SELL is orphaned
    // (the BUY-only stale sweep never touches it) and could fill against a later re-entry at this
    // stale plan's TP. Cancel it; plan still clears.
    const out = await strategy.decide(buildInput(2, { openOrders: [restingSell('103')] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelSide).toBe('SELL');
    expect(out[0]!.cancelRole).toBe('vtp');
    expect(out[0]!.reason).toContain('orphaned');
    expect(events).toEqual(['filled_flat', 'orphan_cancel']);
  });

  it('does not read the [0, tick) rounding bias as drift when the venue tick is configured', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    // Entry 100.2 → raw TP hint 103.206; tick 0.5 ⇒ the sizer rests the SELL at 103.5 (rounded UP).
    // Raw-hint comparison would read that as ~28bps of permanent drift (> 10bps threshold) and
    // churn cancel/re-place forever; the tick-aware expectation sees 0bps.
    const strategy = new AgenticStrategy(SID, venueTpParams({ venueTpTickSize: '0.5' }), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100.2') })); // places TP
    events.length = 0;

    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100.2'), openOrders: [restingSell('103.5')] }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
  });

  it('two resting SELLs (vtp + vsl) reconcile independently — manageVenueTp only ever touches the vtp order', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const vtpOrder = restingSell('103'); // correctly priced/sized ⇒ would be skipped_existing alone
    // A second resting SELL, same symbol/side, WRONG price AND qty relative to the plan's TP — if
    // manageVenueTp were still role-agnostic (pre-P7c .find), it would non-deterministically pick
    // this one and drift/qty-cancel it. A distinct clientOrderId from vtpOrder's is required for the
    // role map to tell them apart.
    const vslOrder: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000009'),
      symbol: SYM,
      side: 'SELL',
      qty: qty('0.5'),
      limitPrice: price('50'),
    };
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: roledIntentStore(
        new Map([
          [String(vtpOrder.clientOrderId), 'vtp'],
          [String(vslOrder.clientOrderId), 'vsl'],
        ]),
      ),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places the vtp TP
    events.length = 0;

    const out = await strategy.decide(
      buildInput(2, {
        position: longPosition('100'),
        openOrders: [vslOrder, vtpOrder],
      }),
    );
    // No churn: the vtp order is correctly priced/sized (skipped_existing); the vsl order is a KNOWN
    // different role, never examined by manageVenueTp's drift/qty checks, so it never generates a
    // cancel even though its own price/qty would trip both thresholds if it were mistaken for the TP.
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
  });
});

// Push II Phase 8: SHORT mirror of the venue-TP suite above — resting TP is a reduce-only BUY
// (cover) instead of SELL, priced entry × (1 − takeProfitPct) instead of entry × (1 + takeProfitPct).
describe('AgenticStrategy venue-resting take-profit lifecycle — SHORT (Push II Phase 8)', () => {
  function venueTpParams(overrides: Partial<AgenticStrategyParams> = {}): AgenticStrategyParams {
    return {
      symbol: SYM,
      venue: V,
      interval: '15m',
      warmupBars: 5,
      model: 'test-model',
      planMode: true,
      planMaxQuietBars: 20,
      venueTpEnabled: true,
      ...overrides,
    };
  }

  function shortPosition(avgEntry: string): Position {
    return {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      signedQty: new Decimal('-0.001'),
      avgEntry: price(avgEntry),
      realizedPnl: new Decimal(0),
    };
  }

  function restingBuy(limitPriceStr: string, qtyStr = '0.001'): OpenOrderSummary {
    return {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000003'),
      symbol: SYM,
      side: 'BUY',
      qty: qty(qtyStr),
      limitPrice: price(limitPriceStr),
    };
  }

  const SHORT_PLAN: AgentPlan = {
    entryOffsetBps: 10,
    stopLossPct: '0.02',
    takeProfitPct: '0.03',
    entryValidityBars: 2,
    maxHoldBars: 8,
    direction: 'short',
  };

  // Returns an ENTER_SHORT + a direction:'short' plan on every call.
  class PlanningShortClient implements AgentClientPort {
    calls = 0;
    propose(input: AgentDecisionInput): Promise<AgentProposal> {
      this.calls += 1;
      const signal: Signal = {
        strategyId: SID,
        venue: V,
        symbol: SYM,
        kind: 'ENTER_SHORT',
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
        plan: SHORT_PLAN,
      });
    }
  }

  it('captures entryPrice on the first bar the position shows SHORT, then places a RESTING EXIT_SHORT at the TP price', async () => {
    const client = new PlanningShortClient();
    const strategy = new AgenticStrategy(SID, venueTpParams(), client);
    await strategy.decide(buildInput(0)); // consult → plan stored (direction 'short')

    // Bar 1: position now shows SHORT at avgEntry 100 — entry captured, close 100 → hold verdict,
    // no resting BUY yet ⇒ TP placement. entry 100 × (1 − 0.03) = 97 exactly.
    const out = await strategy.decide(buildInput(1, { position: shortPosition('100') }));
    expect(client.calls).toBe(1); // still no LLM consult
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_SHORT');
    expect(out[0]!.exitStyle).toBe('RESTING');
    expect(out[0]!.limitPriceHint!.toFixed()).toBe('97');
  });

  it('emits nothing once a correctly-priced BUY already rests (skipped_existing, idempotent)', async () => {
    const client = new PlanningShortClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: shortPosition('100') })); // places TP at 97
    events.length = 0;

    const out = await strategy.decide(
      buildInput(2, { position: shortPosition('100'), openOrders: [restingBuy('97')] }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
  });

  it('cancels the resting BUY (cancelSide BUY) BEFORE the IOC EXIT_SHORT on a stop exit', async () => {
    const client = new PlanningShortClient();
    const strategy = new AgenticStrategy(SID, venueTpParams(), client);
    await strategy.decide(buildInput(0));

    // Bar 1: entry captured at 100, close breaches the stop (102) while a TP already rests at 97 —
    // the resting BUY (cover) must be cancelled before the full-size IOC exit.
    const out = await strategy.decide(
      buildInput(1, {
        close: '102',
        position: shortPosition('100'),
        openOrders: [restingBuy('97')],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelSide).toBe('BUY');
    expect(out[0]!.cancelRole).toBeUndefined(); // role-agnostic: clears BOTH resting roles
    expect(out[1]!.kind).toBe('EXIT_SHORT');
    expect(out[1]!.reason).toBe('plan exit: stop');
  });

  it('holds without an exit when the close crosses the TP while the BUY still rests (tp_race_hold), then clears via position_closed', async () => {
    const client = new PlanningShortClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));

    // Bar 1: close 96 ≤ TP 97 while the resting BUY is still observed open — its own venue fill is
    // the exit; no signal, plan retained.
    const out = await strategy.decide(
      buildInput(1, {
        close: '96',
        position: shortPosition('100'),
        openOrders: [restingBuy('97')],
      }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['tp_race_hold']);

    // Bar 2: the fill lands (FLAT, no orders) — the retained plan clears via position_closed.
    events.length = 0;
    const cleared = await strategy.decide(buildInput(2));
    expect(cleared).toEqual([]);
    expect(events).toEqual(['filled_flat']);
  });

  it("cancels the outgoing SHORT plan's resting SELL entry when the model clears the plan (sweep side re-derivation orphan, review finding)", async () => {
    // The stale-entry sweep derives its side from the CURRENT plan direction, so an entry left
    // resting by a cleared/flipped SHORT plan would become unsweepable and could later fill into
    // an unmanaged SHORT. Reachable only when planMaxQuietBars < entryValidityBars (a cadence
    // consult lands inside the entry-validity window) — pinned here at quiet=1 vs validity=2.
    class ClearingShortClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'long', confidence: 0.8, rationale: 'r' },
            plan: SHORT_PLAN,
          });
        }
        return Promise.resolve({
          signals: [],
          decision: { action: 'flat', confidence: 0.8, rationale: 'done' },
        });
      }
    }
    const client = new ClearingShortClient();
    const strategy = new AgenticStrategy(SID, venueTpParams({ planMaxQuietBars: 1 }), client);
    await strategy.decide(buildInput(0)); // consult 1 → SHORT plan stored

    const sellEntry: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000004'),
      symbol: SYM,
      side: 'SELL',
      qty: qty('0.001'),
      limitPrice: price('100.1'),
    };
    // Bar 1: still FLAT, the SHORT entry rests within validity; the cadence consult (quiet=1)
    // clears the plan — the outgoing plan's SELL side must be cancelled in the same batch.
    const out = await strategy.decide(buildInput(1, { openOrders: [sellEntry] }));
    expect(client.calls).toBe(2);
    const cancel = out.find((s) => s.kind === 'CANCEL_OPEN');
    expect(cancel).toBeDefined();
    expect(cancel!.cancelSide).toBe('SELL');
    expect(cancel!.reason).toContain('outgoing');
  });
});

// Push 3 P2 (plan-aware stop watcher, flag-off): AgenticStrategy populates the plan-stop registry
// (ports/risk.ts's PlanStopRegistryPort) the moment a plan's entry fills, and clears it through the
// SAME clearPlan() choke point every `this.activePlan = null` site now routes through. The registry
// itself is inert here (its consumer, ProtectiveExitService, gates on PLAN_STOP_WATCH_ENABLED) — these
// tests pin the strategy-side bookkeeping only.
describe('AgenticStrategy plan-stop registry bookkeeping (Push 3 P2)', () => {
  it('sets the registry with the exact Decimal stop price on the entry-fill bar (LONG)', async () => {
    const client = new PlanningClient();
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0)); // plan stored — entryPrice still null, no registry entry
    expect(registry.get(REG_KEY)).toBeUndefined();

    // Bar 1: position now shows LONG at avgEntry 100 — entry captured. PLAN.stopLossPct = '0.02' ⇒
    // 100 × (1 − 0.02) = 98 exactly (mirrors plan-executor.ts:66's own formula).
    await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(registry.get(REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: false,
    });
  });

  it('clears the registry on a plan exit (stop/take-profit/max_hold clear site)', async () => {
    const client = new PlanningClient();
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(registry.get(REG_KEY)).toBeDefined();

    // Bar 2: close 103.5 ≥ 100×1.03 → TP exit clears the plan (and the registry with it).
    await strategy.decide(buildInput(2, { close: '103.5', position: longPosition('100') }));
    expect(registry.get(REG_KEY)).toBeUndefined();
  });

  it('clears the registry on cancel_entry/plan_expired (an unfilled entry lapsing — a no-op clear, since it was never set)', async () => {
    const client = new PlanningClient();
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      planStopRegistry: registry,
    });
    const restingEntry: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000005'),
      symbol: SYM,
      side: 'BUY',
      qty: qty('0.001'),
    };
    await strategy.decide(buildInput(0)); // plan stored (validity 2 bars), entry never fills
    await strategy.decide(buildInput(1, { openOrders: [restingEntry] }));
    await strategy.decide(buildInput(2, { openOrders: [restingEntry] })); // lapses → clearPlan()
    expect(registry.get(REG_KEY)).toBeUndefined();
  });

  it("clears the registry when the LLM returns an explicit 'flat' decision (decide()'s own clear site)", async () => {
    class FlatAfterPlanClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'long', confidence: 0.8, rationale: 'r' },
            plan: PLAN,
          });
        }
        return Promise.resolve({
          signals: [],
          decision: { action: 'flat', confidence: 0.8, rationale: 'done' },
        });
      }
    }
    const client = new FlatAfterPlanClient();
    const registry = planStopRegistry();
    // planMaxQuietBars=1 forces a re-consult on the very next managed bar (after entryPrice is
    // captured), reaching decide()'s own 'flat' bookkeeping site rather than runActivePlan's.
    const strategy = new AgenticStrategy(SID, { ...makeParams(), planMaxQuietBars: 1 }, client, {
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0)); // plan stored
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // entry captured, then re-consult → flat
    expect(client.calls).toBe(2);
    expect(registry.get(REG_KEY)).toBeUndefined();
  });

  it('clears the registry when the venue take-profit fills externally (position_closed clear site, AGENTIC_VENUE_TP)', async () => {
    const client = new PlanningClient();
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(
      SID,
      {
        symbol: SYM,
        venue: V,
        interval: '15m',
        warmupBars: 5,
        model: 'test-model',
        planMode: true,
        planMaxQuietBars: 20,
        venueTpEnabled: true,
      },
      client,
      { planStopRegistry: registry },
    );
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places TP, registry set
    expect(registry.get(REG_KEY)).toBeDefined();

    // Bar 2: the venue TP filled between bars — position_closed clears the plan (no `position` this
    // bar, no resting orders).
    await strategy.decide(buildInput(2));
    expect(registry.get(REG_KEY)).toBeUndefined();
  });

  it('sets the registry on the boot re-arm path (same entry-fill-capture site — no separate restore code exists)', async () => {
    class RearmingClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'r' },
          ...(this.calls === 1 ? { plan: PLAN } : {}),
        });
      }
    }
    const client = new RearmingClient();
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      planStopRegistry: registry,
    });
    const held = longPosition('100');

    // Post-restart shape: LONG position, no active plan → forced consult (the re-arm). entryPrice is
    // still null at this point — same as a fresh plan — so no registry entry yet.
    await strategy.decide(buildInput(0, { position: held }));
    expect(registry.get(REG_KEY)).toBeUndefined();

    // Next bar: plan-executor manages, entry anchored to avgEntry — the SAME capture site as a fresh
    // entry fill sets the registry.
    await strategy.decide(buildInput(1, { position: held }));
    expect(registry.get(REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: false,
    });
  });
});

// Push 3 P2: if the plan-stop watcher (ProtectiveExitService) fires an exit that flattens the
// position between bars, the plan-executor's own bar-close exit attempt for the SAME plan has
// nothing left to reduce — this pins the existing sizer invariant the watcher relies on rather than
// duplicating a position (position-sizer.service.ts:118's NO_POSITION branch).
describe('Plan-stop watcher — sizer interaction on a double-fire (Push 3 P2)', () => {
  it('sizes a bar-close exit against an already-flattened position as NO_POSITION, not a duplicate reduce', () => {
    const clock: ClockPort = { now: () => epochMs(BASE_TIME) };
    const filters: SymbolFilters = {
      tickSize: '0.01',
      stepSize: '0.0001',
      minQty: '0.0001',
      minNotional: '5',
    };
    const sizer = new PositionSizerService(clock, {
      baseNotional: '100',
      mode: 'paper',
      filters: new Map([[String(SYM), filters]]),
      randomBytes: (n) => new Uint8Array(n),
    });
    const exitSignal: Signal = {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      kind: 'EXIT_LONG',
      strength: 1,
      refPrice: price('100'),
      basedOnSeq: 1n,
      eventTime: epochMs(BASE_TIME),
      ttlMs: 60_000,
      dedupeKey: 'plan-exit-after-watcher',
      reason: 'plan exit: stop',
    };
    // The watcher already flattened this position (no entry under this key in `positions`).
    const snapshot: PortfolioSnapshot = {
      positions: new Map(),
      balances: new Map(),
      openOrders: [],
      inFlightIntents: [],
      equity: new Decimal('100000'),
      unrealized: new Decimal('0'),
      startingCash: new Decimal('100000'),
      peakEquity: new Decimal('100000'),
      sodEquityUtc: new Decimal('100000'),
      reconcileStatus: 'CLEAN',
      snapshotSeq: 1n,
    };
    expect(sizer.size(exitSignal, snapshot)).toEqual({ ok: false, reason: 'NO_POSITION' });
  });
});
