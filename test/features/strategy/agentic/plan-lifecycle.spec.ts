import { describe, it, expect } from 'vitest';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type VenueTpEvent,
} from '../../../../src/features/strategy/agentic/agentic.strategy';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentDirectives,
  AgentMarketSnapshot,
  AgentPositionSummary,
  // AgentPlan: still the ONLY type AgentDecisionEntry.plan carries (ports/strategy/agentic-strategy.ts;
  // A3's own widening step, not B3's) — the journal-record fixtures below type against IT, not
  // AgentDirectives, even though the runtime value AgenticStrategy now passes is AgentDirectives-
  // shaped (see recordJournalEntry's `plan: proposal?.plan ?? null`).
  AgentPlan,
  AgentProposal,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { Signal } from '../../../../src/domain/strategy/types/signal';
import type { CandleEvent } from '../../../../src/domain/venue/types/market-events';
import type { ExecReport } from '../../../../src/domain/trading/types/exec-report';
import type {
  OpenOrderSummary,
  Position,
  PortfolioSnapshot,
} from '../../../../src/domain/trading/types/portfolio';
import { price, qty } from '../../../../src/domain/common/types/money';
import Decimal from 'decimal.js';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
  intentId,
} from '../../../../src/domain/common/types/ids';
import { positionKey, type SymbolFilters } from '../../../../src/domain/trading/risk/evaluate';
import type { PlanStop, PlanStopRegistryPort } from '../../../../src/ports/trading/risk';
import type { ClockPort } from '../../../../src/ports/common/clock';
import type { ExecutionStorePort } from '../../../../src/ports/trading/execution';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';
import { PositionSizerService } from '../../../../src/features/trading/risk/position-sizer.service';

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

// B2 (Design § Deleted scaffolding, already landed): evaluateConsultSchedule does NOT force a
// consult on a brand-new instance's very first candle bar the way the retired prescreen gate did —
// with no schedule/lastConsultPrice ever set, an ordinary candle trigger just waits for the fallback
// cadence (16 bars). consult-schedule.spec.ts's own fixtures seed bar 0 with an 'exec' trigger
// (forced_fill, schedule-independent) for exactly this reason — mirrored here by defaulting bar 0 to
// 'exec' so every "the LLM was consulted this bar" test in this file keeps its pre-B2 seeding
// behavior without touching each call site individually.
function execEvent(index: number): ExecReport {
  return {
    kind: 'ACK',
    reportId: `r${index}`,
    clientOrderId: clientOrderId('cbp0000000000000007000800000000000000'),
    venue: V,
    symbol: SYM,
    eventTime: epochMs(BASE_TIME + index * STEP_MS),
    ingestTime: epochMs(BASE_TIME + index * STEP_MS + 1),
    venueOrderId: `vo${index}`,
  };
}

function buildInput(
  index: number,
  opts: {
    close?: string;
    position?: Position;
    openOrders?: OpenOrderSummary[];
    trigger?: 'candle' | 'exec';
  } = {},
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
  const triggerKind = opts.trigger ?? (index === 0 ? 'exec' : 'candle');
  const trigger: AgentDecisionInput['trigger'] =
    triggerKind === 'exec'
      ? { kind: 'exec', event: execEvent(index) }
      : { kind: 'candle', event: candle(index) };
  return { strategyId: SID, trigger, snapshot };
}

function bookSnapshot(position: Position, inFlightIntents: OrderIntent[] = []): PortfolioSnapshot {
  return {
    positions: new Map([[REG_KEY, position]]),
    balances: new Map(),
    openOrders: [],
    inFlightIntents,
    equity: new Decimal('1000'),
    unrealized: new Decimal(0),
    startingCash: new Decimal('1000'),
    peakEquity: new Decimal('1000'),
    sodEquityUtc: new Decimal('1000'),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
  };
}

// B3: AgentDirectives (v2) replaces AgentPlan — sizeFraction/entryStyle are new required fields;
// everything else is a direct carry-over of the legacy PLAN fixture's own values.
const PLAN: AgentDirectives = {
  sizeFraction: '0.05',
  entryOffsetBps: 10,
  stopLossPct: '0.02',
  takeProfitPct: '0.03',
  entryValidityBars: 2,
  maxHoldBars: 8,
  entryStyle: 'maker',
};

// Returns an ENTER_LONG + directives on every call; counts calls so the tests can assert exactly
// when the LLM was (not) consulted while a plan is active. B3: the portfolio-scheduled consult
// cadence (evaluateConsultSchedule, B2) now comes from the CLIENT's own nextConsultBars, not a
// strategy param — nextConsultBars defaults to 4 here, matching the old planMaxQuietBars=4 default
// every test in this file was written against (B2's report flagged implicit-default drift, so this
// is pinned explicitly rather than left to evaluateConsultSchedule's own fallback default of 16).
class PlanningClient implements AgentClientPort {
  calls = 0;
  constructor(private readonly nextConsultBars = 4) {}
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
      nextConsultBars: this.nextConsultBars,
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
    // B2's own knobs, pinned explicitly (report-flagged implicit-default drift): the schedule
    // (PlanningClient's nextConsultBars) is what these tests exercise, never wake-on-move or the
    // fallback cadence — pinned generously out of reach so a deliberate TP/SL-crossing close price
    // (e.g. a >1.5% move) can never ALSO force an unplanned extra consult via 'forced_move'.
    wakeMovePct: 1,
    fallbackConsultBars: 1000,
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
    // nextConsultBars: 8 > the bars we drive, so no consult interrupts the quiet holds.
    const client = new PlanningClient(8);
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

  // B2 (already landed): the consult-schedule gate is UNIVERSAL — it governs quiet bars regardless
  // of planMode, so "flag off" no longer means "consult every bar" the way the retired prescreen
  // gate's own planMode-conditional bypass did. What planMode=false actually changes is that there
  // is no plan-executor to intercept a bar first — every 'exec' trigger (schedule-independent,
  // forced_fill) still reaches the LLM every time, which is what this test now pins.
  it('flag off: every exec-triggered bar still reaches the LLM (no plan-executor to intercept)', async () => {
    const client = new PlanningClient();
    const strategy = makeStrategy(client, false);
    await strategy.decide(buildInput(0, { trigger: 'exec' }));
    await strategy.decide(buildInput(1, { trigger: 'exec' }));
    await strategy.decide(buildInput(2, { trigger: 'exec' }));
    expect(client.calls).toBe(3);
  });
});

// B3 (Design § Model-owned exits, § New tool contract action mapping): the v2 directive lifecycle —
// adjust-in-place, scale-in, thesis persistence, and the deletion of the expectancy ladder's strength
// rescaling. The legacy suites above already pin the "client mapping unfinished" defensive fallback
// (plan present + non-adjust/close action ⇒ wholesale replace); these pin the NEW branches directly.
describe('AgenticStrategy v2 directive lifecycle (B3)', () => {
  it('adjust merges the revised directive set in place — barsElapsed is never reset, and the moved stop takes effect immediately', async () => {
    class AdjustingClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
            plan: PLAN, // stopLossPct '0.02' -> stop 98; maxHoldBars 8
            nextConsultBars: 2,
          });
        }
        // Bar 2's consult: widen the stop to 0.05 (stop 95) — the old 98 level must stop firing, and
        // maxHoldBars (untouched by this adjust) must keep counting from barsElapsed, not restart.
        return Promise.resolve({
          signals: [],
          decision: { action: 'adjust', confidence: 0.8, rationale: 'widen stop' },
          plan: { ...PLAN, stopLossPct: '0.05' },
          nextConsultBars: 100, // don't interrupt the remaining quiet bars below
        });
      }
    }
    const client = new AdjustingClient();
    const strategy = makeStrategy(client);
    await strategy.decide(buildInput(0)); // open_long -> plan stored, barsElapsed 0
    const held = longPosition('100');
    await strategy.decide(buildInput(1, { position: held })); // entry captured, barsElapsed 1
    // Bar 2: schedule (2) reached -> real consult -> adjust merges stop 0.05 in place.
    await strategy.decide(buildInput(2, { position: held }));
    expect(client.calls).toBe(2);

    // Bar 3: close 97 is BELOW the OLD stop (98) but ABOVE the NEW one (95) — holds only if the
    // merge actually took effect (a no-op/ignored adjust would still be sitting on stop 98 and exit).
    const bar3 = await strategy.decide(buildInput(3, { close: '97', position: held }));
    expect(bar3).toEqual([]);

    // Bars 4-7: flat holds. maxHoldBars=8 was NOT touched by the adjust — bar 8 must be exactly
    // where max_hold fires (barsElapsed counted 1,2,3,4,5,6,7,8 continuously through the adjust at
    // bar 2; a clock reset there would instead fire at bar 2+8=10, or not yet at bar 8).
    for (let i = 4; i <= 7; i++) {
      const out = await strategy.decide(buildInput(i, { position: held }));
      expect(out).toEqual([]);
    }
    const maxHoldExit = await strategy.decide(buildInput(8, { position: held }));
    expect(client.calls).toBe(2); // still no extra LLM consult — deterministically enforced
    expect(maxHoldExit).toHaveLength(1);
    expect(maxHoldExit[0]!.reason).toBe('plan exit: max_hold');
  });

  it('rejects a stop-widening adjust when aggregate planned-stop risk already exceeds the cap', async () => {
    // Held cost notional = 3 × 100 = 300. Cap at stop 0.05 = 1000 × 0.01 / 0.05 = 200 ⇒ reject.
    const heavy = {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      signedQty: new Decimal('3'),
      avgEntry: price('100'),
      realizedPnl: new Decimal(0),
    };
    class WidenClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
            plan: PLAN,
            nextConsultBars: 2,
          });
        }
        return Promise.resolve({
          signals: [],
          decision: { action: 'adjust', confidence: 0.8, rationale: 'widen stop' },
          plan: { ...PLAN, stopLossPct: '0.05' },
          nextConsultBars: 100,
        });
      }
    }
    const client = new WidenClient();
    const strategy = new AgenticStrategy(
      SID,
      {
        ...makeParams(),
        maxPlannedStopRiskFraction: '0.01',
        sizingEquityCap: '1000',
      },
      client,
      { bookSnapshot: () => bookSnapshot(heavy) },
    );
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: heavy }));
    await strategy.decide(buildInput(2, { position: heavy }));
    expect(client.calls).toBe(2);
    // Rejected widen must keep the prior stop (0.02 → 98). Close 97 would hold under 0.05.
    const stillOldStop = await strategy.decide(buildInput(3, { close: '97', position: heavy }));
    expect(stillOldStop).toHaveLength(1);
    expect(stillOldStop[0]!.reason).toBe('plan exit: stop');
  });

  it('allows a stop-widening adjust when aggregate planned-stop risk still fits under the cap', async () => {
    // Held cost notional = 0.001 × 100 = 0.1. Cap at stop 0.05 = 200 ⇒ allow.
    class WidenOkClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
            plan: PLAN,
            nextConsultBars: 2,
          });
        }
        return Promise.resolve({
          signals: [],
          decision: { action: 'adjust', confidence: 0.8, rationale: 'widen stop' },
          plan: { ...PLAN, stopLossPct: '0.05' },
          nextConsultBars: 100,
        });
      }
    }
    const held = longPosition('100');
    const client = new WidenOkClient();
    const strategy = new AgenticStrategy(
      SID,
      {
        ...makeParams(),
        maxPlannedStopRiskFraction: '0.01',
        sizingEquityCap: '1000',
      },
      client,
      { bookSnapshot: () => bookSnapshot(held) },
    );
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: held }));
    await strategy.decide(buildInput(2, { position: held }));
    const underNewStop = await strategy.decide(buildInput(3, { close: '97', position: held }));
    expect(underNewStop).toEqual([]);
  });

  it('a same-side open_long while positioned (scale-in) replaces the plan with a fresh clock', async () => {
    class ScaleInClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
            plan: { ...PLAN, maxHoldBars: 20 }, // long-lived so it never fires before the scale-in
            nextConsultBars: 3,
          });
        }
        // Bar 3: scale-in — same-side open_long with a SHORT maxHoldBars; the fresh clock must be
        // what governs, not the outgoing plan's already-elapsed bars.
        return Promise.resolve({
          signals: [],
          decision: { action: 'open_long', confidence: 0.8, rationale: 'scale in' },
          plan: { ...PLAN, maxHoldBars: 2, sizeFraction: '0.03' },
          nextConsultBars: 100,
        });
      }
    }
    const client = new ScaleInClient();
    const strategy = makeStrategy(client);
    await strategy.decide(buildInput(0)); // open_long -> plan stored (maxHoldBars 20), barsElapsed 0
    const held = longPosition('100');
    await strategy.decide(buildInput(1, { position: held })); // entry captured, barsElapsed 1
    await strategy.decide(buildInput(2, { position: held })); // barsElapsed 2, still quiet
    // Bar 3: schedule (3) reached -> consult -> scale-in replaces the plan (fresh clock, maxHoldBars 2).
    await strategy.decide(buildInput(3, { position: held }));
    expect(client.calls).toBe(2);
    // Bar 4: fresh clock's barsElapsed=1 (NOT the outgoing plan's 4) -> well short of maxHoldBars 2.
    const bar4 = await strategy.decide(buildInput(4, { position: held }));
    expect(bar4).toEqual([]);
    // Bar 5: fresh clock's barsElapsed=2 -> hits the NEW plan's maxHoldBars (2) exactly. A carried-over
    // clock would either have already exited at bar 3 (old 3 >= new maxHoldBars 2) or exit late.
    const bar5 = await strategy.decide(buildInput(5, { position: held }));
    expect(client.calls).toBe(2);
    expect(bar5).toHaveLength(1);
    expect(bar5[0]!.reason).toBe('plan exit: max_hold');
  });

  it('a delayed scale-in fill re-anchors entryPrice (and stop) to the POST-fill avg entry, not the frozen pre-scale-in one (review finding, minor)', async () => {
    class ScaleInFillClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
            plan: { ...PLAN, maxHoldBars: 20, stopLossPct: '0.02' },
            nextConsultBars: 3,
          });
        }
        // Bar 3: scale-in with a WIDER stopLossPct (0.05) — the add rests as an unfilled maker
        // order for two more bars before it fills.
        return Promise.resolve({
          signals: [],
          decision: { action: 'open_long', confidence: 0.8, rationale: 'scale in' },
          plan: { ...PLAN, maxHoldBars: 20, stopLossPct: '0.05', sizeFraction: '0.08' },
          nextConsultBars: 100,
        });
      }
    }
    const client = new ScaleInFillClient();
    const strategy = makeStrategy(client);
    await strategy.decide(buildInput(0)); // open_long -> plan stored, barsElapsed 0
    const preScaleIn = longPosition('100'); // qty 0.001
    await strategy.decide(buildInput(1, { position: preScaleIn })); // entry captured at 100
    await strategy.decide(buildInput(2, { position: preScaleIn })); // still quiet
    // Bar 3: schedule (3) reached -> consult -> scale-in decided while the add is STILL a resting
    // (unfilled) maker order — the position is byte-identical to preScaleIn at this exact bar.
    await strategy.decide(buildInput(3, { position: preScaleIn }));
    expect(client.calls).toBe(2);
    // Bar 4: the add STILL hasn't filled (qty unchanged from the scale-in's own baseline) — entry
    // stays anchored at the OLD 100, protecting off the new stopLossPct (0.05 -> stop 95). Close 100
    // holds either way, so this bar only proves no premature/erroring re-anchor.
    const bar4 = await strategy.decide(buildInput(4, { position: preScaleIn }));
    expect(bar4).toEqual([]);
    // Bar 5: the add FILLS — position now shows the blended post-fill avgEntry 110 at a larger qty.
    // Correct re-anchor: entry 110 x (1-0.05) = stop 104.5 -> close 102 breaches it (EXIT).
    // The pre-fix bug froze entryPrice at 100 on bar 4's premature capture -> stop 95 -> close 102
    // would NOT breach it (a false hold), which is exactly the stale-anchor defect this test pins.
    const postFill: Position = {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      signedQty: new Decimal('0.0025'),
      avgEntry: price('110'),
      realizedPnl: new Decimal(0),
    };
    const bar5 = await strategy.decide(buildInput(5, { close: '102', position: postFill }));
    expect(client.calls).toBe(2); // still no extra LLM consult
    expect(bar5).toHaveLength(1);
    expect(bar5[0]!.kind).toBe('EXIT_LONG');
    expect(bar5[0]!.reason).toBe('plan exit: stop');
  });

  it('thesis persists onto the position summary as currentThesis and rides the journal row via plan_json', async () => {
    const journalEntries: Array<{ plan?: AgentDirectives | null }> = [];
    const seenTheses: Array<string | undefined> = [];
    const THESIS = 'BTC breaking out of a range on rising volume.';
    class ThesisClient implements AgentClientPort {
      calls = 0;
      propose(input: AgentDecisionInput): Promise<AgentProposal> {
        this.calls += 1;
        seenTheses.push(input.context?.position.currentThesis);
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
            plan: { ...PLAN, thesis: THESIS },
            nextConsultBars: 1,
          });
        }
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'r' },
          nextConsultBars: 100,
        });
      }
    }
    const client = new ThesisClient();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        // AgentDecisionEntry.plan is still typed AgentPlan|null (A3's own widening step, not B3's) —
        // the runtime value AgenticStrategy actually passes is already AgentDirectives-shaped.
        record: (e) => journalEntries.push({ plan: e.plan as AgentDirectives | null }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0)); // bar 0: FLAT — no position, no currentThesis to render
    expect(seenTheses[0]).toBeUndefined();
    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0]!.plan?.thesis).toBe(THESIS);

    const held = longPosition('100');
    // Bar 1: entry captured; schedule (1) reached -> real consult THIS bar, which renders the
    // persisted thesis back as currentThesis (fed back verbatim, per AgentDirectives.thesis's own
    // comment) — buildContext runs before runActivePlan increments barsElapsed, but lastThesis is a
    // strategy-level field independent of that clock, so it renders regardless.
    await strategy.decide(buildInput(1, { position: held }));
    expect(client.calls).toBe(2);
    expect(seenTheses[1]).toBe(THESIS);
  });

  it('a moved takeProfitPct on adjust replaces the stale resting venue-TP order on the next managed bar', async () => {
    class AdjustTpClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
            plan: PLAN, // takeProfitPct '0.03' -> TP 103
            nextConsultBars: 2,
          });
        }
        return Promise.resolve({
          signals: [],
          decision: { action: 'adjust', confidence: 0.8, rationale: 'widen TP' },
          plan: { ...PLAN, takeProfitPct: '0.05' }, // TP moves to 105
          nextConsultBars: 100,
        });
      }
    }
    const client = new AdjustTpClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, { ...makeParams(), venueTpEnabled: true }, client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0)); // open_long -> plan stored (TP 103)
    const held = longPosition('100');
    const placed = await strategy.decide(buildInput(1, { position: held })); // entry captured, TP placed
    expect(placed).toHaveLength(1);
    expect(placed[0]!.limitPriceHint!.toFixed()).toBe('103');
    events.length = 0;

    const restingSell103: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000006'),
      symbol: SYM,
      side: 'SELL',
      qty: qty('0.001'),
      limitPrice: price('103'),
    };
    // Bar 2: the adjust consult itself — verdict is 'hold' before the fallthrough, so manageVenueTp
    // never runs this bar; the stale 103 order is untouched here (see the drift_cancel bar below).
    const adjustBar = await strategy.decide(
      buildInput(2, { position: held, openOrders: [restingSell103] }),
    );
    expect(client.calls).toBe(2);
    expect(adjustBar).toEqual([]);

    // Bar 3: managed quiet bar — manageVenueTp compares the resting 103 SELL against the ADJUSTED
    // plan's new TP (105). #148 (2026-08-04): the stale order is cancelled and the re-priced one
    // submitted in the SAME chain entry, so the adjusted TP is resting from this bar on rather than
    // leaving the position with no venue take-profit until the next managed bar.
    const driftBar = await strategy.decide(
      buildInput(3, { position: held, openOrders: [restingSell103] }),
    );
    expect(driftBar).toHaveLength(1);
    expect(driftBar[0]!.kind).toBe('EXIT_LONG');
    expect(driftBar[0]!.exitStyle).toBe('RESTING');
    expect(driftBar[0]!.limitPriceHint!.toFixed()).toBe('105');
    expect(driftBar[0]!.cancelBeforeSubmit).toEqual({ side: 'SELL' });
    // Both labels: the compound entry cancels AND places, and 'placed' is the only counter
    // evidencing this rail places anything at all.
    expect(events).toEqual(['drift_cancel', 'placed']);
  });

  it('adjust with partialCloseFraction shrinks the position; the stale full-size venue TP qty_cancels then re-places', async () => {
    class PartialCloseClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
            plan: PLAN,
            nextConsultBars: 2,
          });
        }
        // The CLIENT (A1) is what actually emits the reduce-only EXIT off partialCloseFraction; this
        // test only pins the venue-TP reconciliation's reaction to the resulting smaller position, so
        // `signals` stays empty here — the partial fill is simulated directly on the fixture below.
        return Promise.resolve({
          signals: [],
          decision: { action: 'adjust', confidence: 0.8, rationale: 'partial close' },
          plan: { ...PLAN, partialCloseFraction: '0.5' },
          nextConsultBars: 100,
        });
      }
    }
    const client = new PartialCloseClient();
    const events: VenueTpEvent[] = [];
    const strategy = new AgenticStrategy(SID, { ...makeParams(), venueTpEnabled: true }, client, {
      onVenueTp: (e) => events.push(e),
      intentStore: vtpOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));
    const fullPosition = longPosition('100'); // qty 0.001
    const placed = await strategy.decide(buildInput(1, { position: fullPosition }));
    expect(placed[0]!.limitPriceHint!.toFixed()).toBe('103');
    events.length = 0;

    const restingSellFull: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000007'),
      symbol: SYM,
      side: 'SELL',
      qty: qty('0.001'),
      limitPrice: price('103'),
    };
    // Bar 2: the adjust consult (position still full-size — the partial fill lands between bars,
    // same as any venue fill).
    await strategy.decide(buildInput(2, { position: fullPosition, openOrders: [restingSellFull] }));
    expect(client.calls).toBe(2);

    const halfPosition: Position = {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      signedQty: new Decimal('0.0005'),
      avgEntry: price('100'),
      realizedPnl: new Decimal(0),
    };
    // Bar 3: the partial close filled — position now HALF size. The resting full-size 103 SELL no
    // longer matches (it would lock base the reduced position doesn't have) -> qty_cancel.
    const qtyCancelBar = await strategy.decide(
      buildInput(3, { position: halfPosition, openOrders: [restingSellFull] }),
    );
    expect(qtyCancelBar).toHaveLength(1);
    expect(qtyCancelBar[0]!.kind).toBe('CANCEL_OPEN');
    expect(events).toEqual(['qty_cancel']);

    // Bar 4: nothing rests -> re-placed, sized off the (now half-size) position.
    const replaced = await strategy.decide(buildInput(4, { position: halfPosition }));
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.kind).toBe('EXIT_LONG');
    expect(replaced[0]!.exitStyle).toBe('RESTING');
  });

  it("never rescales signal.strength (expectancy ladder deleted — sizing authority is the model's own sizeFraction)", async () => {
    class StrengthClient implements AgentClientPort {
      propose(input: AgentDecisionInput): Promise<AgentProposal> {
        const signal: Signal = {
          strategyId: SID,
          venue: V,
          symbol: SYM,
          kind: 'ENTER_LONG',
          strength: 0.37,
          refPrice: price('100'),
          basedOnSeq: 1n,
          eventTime: input.snapshot.eventTime,
          ttlMs: 120_000,
          dedupeKey: 'k1',
          reason: 'r',
        };
        return Promise.resolve({
          signals: [signal],
          decision: { action: 'open_long', confidence: 0.8, rationale: 'r' },
        });
      }
    }
    const strategy = new AgenticStrategy(SID, makeParams(false), new StrengthClient());
    const out = await strategy.decide(buildInput(0));
    expect(out).toHaveLength(1);
    expect(out[0]!.strength).toBe(0.37);
  });
});

// The active plan is in-memory and lost on restart, leaving an open position consulted every bar.
// B3: the model sees that state as an ABSENT position.directives key (replaces managedPlan===false)
// and re-attaches management by returning directives with its 'hold' (the client's re-arm
// acceptance path) — these tests pin the strategy half: the directives-key rendering and the
// arm-without-signal lifecycle.
describe('AgenticStrategy plan re-arm on an open position (restart self-heal)', () => {
  // hold+directives on the first consult (the re-arm), plain hold afterwards; captures every
  // context the LLM was actually shown so directives' presence/absence can be asserted per consult.
  // nextConsultBars: 4 on the re-arm response sustains the safety cadence for the second test below
  // (mirrors PlanningClient's own default/rationale).
  class RearmingClient implements AgentClientPort {
    calls = 0;
    readonly seenDirectives: Array<AgentPositionSummary['directives']> = [];
    propose(input: AgentDecisionInput): Promise<AgentProposal> {
      this.calls += 1;
      this.seenDirectives.push(input.context?.position.directives);
      return Promise.resolve({
        signals: [],
        decision: { action: 'hold', confidence: 0.5, rationale: 'r' },
        ...(this.calls === 1 ? { plan: PLAN, nextConsultBars: 4 } : {}),
      });
    }
  }

  it('re-arms from a bare LONG (no directives → hold+directives → deterministic bars → TP exit off avgEntry)', async () => {
    const client = new RearmingClient();
    const strategy = makeStrategy(client);
    const held = longPosition('100');

    // Post-restart shape: LONG position, no active plan → forced consult, flagged unmanaged.
    const first = await strategy.decide(buildInput(0, { position: held }));
    expect(client.calls).toBe(1);
    expect(client.seenDirectives[0]).toBeUndefined();
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

  it('reports directives present on the safety-cadence consult of a re-armed plan', async () => {
    const client = new RearmingClient();
    const strategy = makeStrategy(client); // schedule = 4 (RearmingClient's own nextConsultBars)
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held })); // consult 1: bare → re-arm
    await strategy.decide(buildInput(1, { position: held })); // bars 1-3 managed
    await strategy.decide(buildInput(2, { position: held }));
    await strategy.decide(buildInput(3, { position: held }));
    await strategy.decide(buildInput(4, { position: held })); // barsElapsed=4 → safety consult
    expect(client.calls).toBe(2);
    expect(client.seenDirectives.map((d) => d !== undefined)).toEqual([false, true]);
  });

  it('renders no directives key outside plan mode (legacy payloads stay byte-identical)', async () => {
    const client = new RearmingClient();
    const strategy = makeStrategy(client, false);
    await strategy.decide(buildInput(0, { position: longPosition('100') }));
    expect(client.seenDirectives).toEqual([undefined]);
  });

  it('renders no directives key while FLAT (plan mode on)', async () => {
    const client = new RearmingClient();
    const strategy = makeStrategy(client);
    await strategy.decide(buildInput(0));
    expect(client.seenDirectives).toEqual([undefined]);
  });

  // 2026-07-24: model returned bare hold/adjust on forced_rearm (client plan undefined) — without
  // this fallback, activePlan stays null forever, manageVenueStop never runs, positions stay naked.
  it('attaches a synthetic protective plan when a positioned consult returns hold without directives', async () => {
    class BareHoldClient implements AgentClientPort {
      propose(): Promise<AgentProposal> {
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'bare hold' },
        });
      }
    }
    let rearmFallbackCalls = 0;
    const strategy = new AgenticStrategy(SID, makeParams(), new BareHoldClient(), {
      onRearmFallback: () => {
        rearmFallbackCalls += 1;
      },
    });
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held })); // consult: bare hold → fallback
    expect(rearmFallbackCalls).toBe(1);
    // Next quiet bar: plan-executor manages (LLM not consulted); entry anchors to avgEntry.
    const quiet = await strategy.decide(buildInput(1, { position: held }));
    expect(rearmFallbackCalls).toBe(1);
    expect(quiet).toEqual([]);
    // Fallback takeProfitPct 0.02 → TP at 102 off avgEntry 100.
    const atTp = await strategy.decide(buildInput(2, { close: '102', position: held }));
    expect(atTp).toHaveLength(1);
    expect(atTp[0]!.kind).toBe('EXIT_LONG');
    expect(atTp[0]!.reason).toBe('plan exit: take_profit');
  });

  // 2026-08-04 (#149): the synthetic 0.02 TP above is geometry the model never authored — a 2.5:1
  // adverse pair against the 0.05 stop, and ~1500bps of phantom drift against a correctly-priced
  // resting order, which manageVenueTp then cancels. When the position's own TP still rests at the
  // venue, the re-arm re-derives the pct from THAT price instead (venueTpPrice inverted against
  // avgEntry), so the recovered plan matches the exit the venue is actually holding.
  it('re-derives the re-armed takeProfitPct from the resting venue TP order rather than the synthetic 0.02', async () => {
    class BareHoldClient implements AgentClientPort {
      propose(): Promise<AgentProposal> {
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'bare hold' },
        });
      }
    }
    const restingTp: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000009'),
      symbol: SYM,
      side: 'SELL',
      qty: qty('0.001'),
      limitPrice: price('103.5'), // 100 × 1.035 — the model's own 0.035 TP, still resting
    };
    const strategy = new AgenticStrategy(SID, makeParams(), new BareHoldClient(), {
      intentStore: roledIntentStore(new Map([[String(restingTp.clientOrderId), 'vtp']])),
    });
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held, openOrders: [restingTp] }));

    // Close 102 is where the SYNTHETIC 0.02 would have taken profit — the re-derived 0.035 holds.
    const belowDerivedTp = await strategy.decide(
      buildInput(1, { close: '102', position: held, openOrders: [restingTp] }),
    );
    expect(belowDerivedTp).toEqual([]);

    const atDerivedTp = await strategy.decide(
      buildInput(2, { close: '103.5', position: held, openOrders: [restingTp] }),
    );
    expect(atDerivedTp).toHaveLength(1);
    expect(atDerivedTp[0]!.reason).toBe('plan exit: take_profit');
  });

  it('ignores a resting TP whose implied pct falls outside the decision contract and keeps the synthetic fallback', async () => {
    class BareHoldClient implements AgentClientPort {
      propose(): Promise<AgentProposal> {
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'bare hold' },
        });
      }
    }
    // 130 off avgEntry 100 implies a 0.30 TP — past DECISION_V2_BOUNDS.takeProfitPct.max (0.2), so
    // this order cannot be recovered model geometry (a stale order from a long-gone entry, or a
    // foreign one). Discarded rather than clamped: the synthetic 0.02 stands and exits at 102.
    const staleTp: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000010'),
      symbol: SYM,
      side: 'SELL',
      qty: qty('0.001'),
      limitPrice: price('130'),
    };
    const strategy = new AgenticStrategy(SID, makeParams(), new BareHoldClient(), {
      intentStore: roledIntentStore(new Map([[String(staleTp.clientOrderId), 'vtp']])),
    });
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held, openOrders: [staleTp] }));
    const atSyntheticTp = await strategy.decide(
      buildInput(1, { close: '102', position: held, openOrders: [staleTp] }),
    );
    expect(atSyntheticTp).toHaveLength(1);
    expect(atSyntheticTp[0]!.reason).toBe('plan exit: take_profit');
  });

  it('does not emit onRearmFallback when hold+directives re-arm attaches a model plan', async () => {
    let rearmFallbackCalls = 0;
    const strategy = new AgenticStrategy(SID, makeParams(), new RearmingClient(), {
      onRearmFallback: () => {
        rearmFallbackCalls += 1;
      },
    });
    await strategy.decide(buildInput(0, { position: longPosition('100') }));
    expect(rearmFallbackCalls).toBe(0);
  });

  // Backlog #149 (CLOCK half, 2026-08-10): rearmExitGeometry previously hardcoded barsElapsed: 0,
  // restarting the maxHoldBars clock on every re-arm no matter how long the position had really been
  // open. With a durable open-time source wired, 94 real bars already elapsed at re-arm + the fixed
  // maxHoldBars: 96 need only 2 more quiet bars to fire max_hold — proof the recovered clock, not a
  // fresh one, is driving the exit.
  it('reconstructs barsElapsed from the durable open-time source on a re-arm (max_hold fires early)', async () => {
    class BareHoldClient implements AgentClientPort {
      propose(): Promise<AgentProposal> {
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'bare hold' },
        });
      }
    }
    const openedAt = BASE_TIME - 94 * STEP_MS; // 94 real bars already elapsed at re-arm time
    const strategy = new AgenticStrategy(SID, makeParams(), new BareHoldClient(), {
      openPositionOpenedAt: () => Promise.resolve(openedAt),
    });
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held })); // re-arm: barsElapsed seeded to 94
    const quiet = await strategy.decide(buildInput(1, { position: held })); // 95 — still below 96
    expect(quiet).toEqual([]);
    const out = await strategy.decide(buildInput(2, { position: held })); // 96 — max_hold fires
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.reason).toBe('plan exit: max_hold');
  });

  // Fail-open pin: absent closure ⇒ barsElapsed starts at 0 on the re-arm, byte-identical to
  // pre-#149 — the same 3 bars stay far short of maxHoldBars 96, so no max_hold exit fires.
  it('fails open to barsElapsed 0 on a re-arm when openPositionOpenedAt is absent (byte-identical to pre-#149)', async () => {
    class BareHoldClient implements AgentClientPort {
      propose(): Promise<AgentProposal> {
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'bare hold' },
        });
      }
    }
    const strategy = new AgenticStrategy(SID, makeParams(), new BareHoldClient());
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held })); // re-arm: barsElapsed 0 (no closure)
    const bar1 = await strategy.decide(buildInput(1, { position: held }));
    expect(bar1).toEqual([]);
    const bar2 = await strategy.decide(buildInput(2, { position: held }));
    expect(bar2).toEqual([]); // nowhere near maxHoldBars 96
  });

  // Fail-open pin, second answer shape: a wired closure that itself resolves null (flat / no
  // matching fills) must degrade identically to an absent closure, never throw or widen the re-arm.
  it('fails open to barsElapsed 0 on a re-arm when openPositionOpenedAt resolves null', async () => {
    class BareHoldClient implements AgentClientPort {
      propose(): Promise<AgentProposal> {
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'bare hold' },
        });
      }
    }
    const strategy = new AgenticStrategy(SID, makeParams(), new BareHoldClient(), {
      openPositionOpenedAt: () => Promise.resolve(null),
    });
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held }));
    const bar1 = await strategy.decide(buildInput(1, { position: held }));
    expect(bar1).toEqual([]);
    const bar2 = await strategy.decide(buildInput(2, { position: held }));
    expect(bar2).toEqual([]);
  });

  // Fail-open pin, third answer shape: the closure wraps a live DB read that can genuinely reject
  // (transient PG error) — a rejection must degrade the SAME as absent/null, never propagate out of
  // decide() and abort the re-arm branch (which would lose that bar's protective plan entirely).
  it('fails open to barsElapsed 0 on a re-arm when openPositionOpenedAt rejects', async () => {
    class BareHoldClient implements AgentClientPort {
      propose(): Promise<AgentProposal> {
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'bare hold' },
        });
      }
    }
    const strategy = new AgenticStrategy(SID, makeParams(), new BareHoldClient(), {
      openPositionOpenedAt: () => Promise.reject(new Error('db down')),
    });
    const held = longPosition('100');
    await strategy.decide(buildInput(0, { position: held }));
    const bar1 = await strategy.decide(buildInput(1, { position: held }));
    expect(bar1).toEqual([]);
    const bar2 = await strategy.decide(buildInput(2, { position: held }));
    expect(bar2).toEqual([]);
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

// I1 (WATCH-V4-12 follow-on): Anthropic's own stop_reason must reach the journal row the same way
// AgentProposal.consultId does — pinned at the same strategy boundary (recordJournalEntry), never a
// call-site-specific mapping.
describe('AgenticStrategy journals the stopReason (persistence)', () => {
  class StopReasonClient implements AgentClientPort {
    constructor(private readonly stopReason?: string) {}
    propose(): Promise<AgentProposal> {
      return Promise.resolve({
        signals: [],
        decision: { action: 'hold', confidence: 0.5, rationale: 'no edge' },
        ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      });
    }
  }

  it('journals the stop_reason the proposal carried', async () => {
    const client = new StopReasonClient('tool_use');
    const entries: Array<{ stopReason?: string | null }> = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        record: (e) => entries.push({ stopReason: e.stopReason }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.stopReason).toBe('tool_use');
  });

  it('journals null when the proposal carried no stopReason (no client call attempted)', async () => {
    const client = new StopReasonClient();
    const entries: Array<{ stopReason?: string | null }> = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      journal: {
        record: (e) => entries.push({ stopReason: e.stopReason }),
        recent: () => Promise.resolve([]),
      },
    });
    await strategy.decide(buildInput(0));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.stopReason).toBeNull();
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
// stopLossPct 0.02 ⇒ stop price 98 exactly. PlanningClient's default nextConsultBars=4 stays well
// above every bar driven in these tests, so the safety-consult cadence never interrupts venue-TP
// management.
describe('AgenticStrategy venue-resting take-profit lifecycle (AGENTIC_VENUE_TP)', () => {
  function venueTpParams(overrides: Partial<AgenticStrategyParams> = {}): AgenticStrategyParams {
    return {
      symbol: SYM,
      venue: V,
      interval: '15m',
      warmupBars: 5,
      model: 'test-model',
      planMode: true,
      venueTpEnabled: true,
      // Pinned per makeParams' own rationale — wake-on-move must never fire off a deliberate
      // TP/SL-crossing close price in these tests.
      wakeMovePct: 1,
      fallbackConsultBars: 1000,
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

  it('carries cancelBeforeSubmit (side SELL) on the IOC EXIT_LONG when a resting SELL TP is present on a stop exit (Defect B #49)', async () => {
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, venueTpParams(), client);
    await strategy.decide(buildInput(0));

    // Bar 1: entry captured at 100, close breaches the stop (98) while a TP already rests at 103 —
    // the resting SELL must be cancelled before the full-size IOC exit (else it venue-rejects for
    // insufficient balance, the base qty being locked by the resting order). Defect B (#49) fix:
    // the cancel and the exit are now ONE compound signal, not a separate CANCEL_OPEN + exit pair.
    const out = await strategy.decide(
      buildInput(1, {
        close: '98',
        position: longPosition('100'),
        openOrders: [restingSell('103')],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    // Deliberately no cancelRole inside cancelBeforeSubmit — a stop/max_hold cancel-first must
    // clear BOTH a resting TP and a resting protective stop with the ONE signal (SignalSinkService
    // cancels every side-matching order when cancelRole is absent).
    expect(out[0]!.cancelBeforeSubmit).toEqual({ side: 'SELL' });
    expect(out[0]!.reason).toBe('plan exit: stop');
  });

  it('replaces the resting SELL in one chain entry when its price drifts beyond the replace-drift threshold', async () => {
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
    // well past the default 10bps threshold. #148 (2026-08-04): a bare CANCEL_OPEN here deferred the
    // re-placement to the next managed bar, leaving the position with NO resting take-profit in
    // between (live: ~15min naked on 2026-08-04, watcher backstop off) — the cancel now rides the
    // replacement's own cancelBeforeSubmit so both land in one SignalSinkService chain entry.
    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('104')] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.exitStyle).toBe('RESTING');
    expect(out[0]!.limitPriceHint!.toFixed()).toBe('103'); // re-priced to the plan TP, same bar
    expect(out[0]!.cancelBeforeSubmit).toEqual({ side: 'SELL' });
    expect(out[0]!.reason).toContain('drifted');
    // The replacement counts as a placement — same 'placed' the fresh-placement branch and the perp
    // stop's own same-bar re-place emit; without it ~36% of live TP placements were uncounted.
    expect(events).toEqual(['drift_cancel', 'placed']);
  });

  // cancelBeforeSubmit is side-scoped with no role filter (SignalSinkService.cancelOrdersForSide),
  // so the compound replace above would sweep a coexisting resting protective stop along with the
  // drifted TP. Cancelling a stop the live position still needs is strictly worse than re-placing
  // the TP a bar later, so the replace FAILS CLOSED back to the role-scoped bare cancel whenever
  // anything else rests on this side.
  it('falls back to the role-scoped bare cancel on drift when a vsl order coexists on the TP side', async () => {
    const client = new PlanningClient();
    const events: VenueTpEvent[] = [];
    const driftedTp = restingSell('104');
    const vslOrder: OpenOrderSummary = {
      clientOrderId: clientOrderId('cbp0000000000000007000800000000000011'),
      symbol: SYM,
      side: 'SELL',
      qty: qty('0.001'),
      limitPrice: price('98'),
    };
    const strategy = new AgenticStrategy(SID, venueTpParams(), client, {
      onVenueTp: (e) => events.push(e),
      intentStore: roledIntentStore(
        new Map([
          [String(driftedTp.clientOrderId), 'vtp'],
          [String(vslOrder.clientOrderId), 'vsl'],
        ]),
      ),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places TP at 103
    events.length = 0;

    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [driftedTp, vslOrder] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelSide).toBe('SELL');
    expect(out[0]!.cancelRole).toBe('vtp'); // the resting stop is never swept by a TP re-price
    expect(out[0]!.cancelBeforeSubmit).toBeUndefined();
    expect(events).toEqual(['drift_cancel']);
  });

  it('clears the plan with no signal when the resting TP fills between bars (position_closed)', async () => {
    // B2: a cleared plan while FLAT does NOT force an immediate re-consult the way an open position
    // without directives does (evaluateConsultSchedule's hasOpenPositionWithoutDirectives only fires
    // while LONG/SHORT) — nextConsultBars=3 makes the ordinary schedule land exactly on bar 3, so
    // "the plan was actually cleared, not silently stuck" is still provable via a real consult there.
    const client = new PlanningClient(3);
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

    // Bar 3: schedule (3) reached — the next bar forces a fresh LLM consult (proves the plan was
    // actually cleared, not just silently skipped this one bar).
    await strategy.decide(buildInput(3));
    expect(client.calls).toBe(2);
  });

  it('flag off: never emits a RESTING exit or a SELL-scoped CANCEL_OPEN (byte-identical to pre-feature)', async () => {
    // See the schedule-reaches-bar-3 rationale above.
    const client = new PlanningClient(3);
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

    // Bar 3: schedule (3) reached — forces a fresh consult, proving the plan is genuinely gone.
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
      venueTpEnabled: true,
      // Pinned per makeParams' own rationale — wake-on-move must never fire off a deliberate
      // TP/SL-crossing close price in these tests.
      wakeMovePct: 1,
      fallbackConsultBars: 1000,
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

  const SHORT_PLAN: AgentDirectives = {
    sizeFraction: '0.05',
    entryOffsetBps: 10,
    stopLossPct: '0.02',
    takeProfitPct: '0.03',
    entryValidityBars: 2,
    maxHoldBars: 8,
    entryStyle: 'maker',
    direction: 'short',
  };

  // Returns an ENTER_SHORT + a direction:'short' plan on every call. nextConsultBars defaults to 4
  // (mirrors PlanningClient's own default/rationale above).
  class PlanningShortClient implements AgentClientPort {
    calls = 0;
    constructor(private readonly nextConsultBars = 4) {}
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
        nextConsultBars: this.nextConsultBars,
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

  it('carries cancelBeforeSubmit (side BUY) on the IOC EXIT_SHORT when a resting BUY TP is present on a stop exit (Defect B #49)', async () => {
    const client = new PlanningShortClient();
    const strategy = new AgenticStrategy(SID, venueTpParams(), client);
    await strategy.decide(buildInput(0));

    // Bar 1: entry captured at 100, close breaches the stop (102) while a TP already rests at 97 —
    // the resting BUY (cover) must be cancelled before the full-size IOC exit. Defect B (#49) fix:
    // ONE compound signal, not a separate CANCEL_OPEN + exit pair.
    const out = await strategy.decide(
      buildInput(1, {
        close: '102',
        position: shortPosition('100'),
        openOrders: [restingBuy('97')],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_SHORT');
    expect(out[0]!.cancelBeforeSubmit).toEqual({ side: 'BUY' }); // role-agnostic: clears BOTH roles
    expect(out[0]!.reason).toBe('plan exit: stop');
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
    // an unmanaged SHORT. Reachable only when the schedule < entryValidityBars (a cadence consult
    // lands inside the entry-validity window) — pinned here via nextConsultBars=1 vs validity=2.
    class ClearingShortClient implements AgentClientPort {
      calls = 0;
      propose(): Promise<AgentProposal> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.resolve({
            signals: [],
            decision: { action: 'long', confidence: 0.8, rationale: 'r' },
            plan: SHORT_PLAN,
            nextConsultBars: 1,
          });
        }
        return Promise.resolve({
          signals: [],
          decision: { action: 'flat', confidence: 0.8, rationale: 'done' },
        });
      }
    }
    const client = new ClearingShortClient();
    const strategy = new AgenticStrategy(SID, venueTpParams(), client);
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
// (ports/trading/risk.ts's PlanStopRegistryPort) the moment a plan's entry fills, and clears it through the
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
            nextConsultBars: 1,
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
    // nextConsultBars: 1 forces a re-consult on the very next managed bar (after entryPrice is
    // captured), reaching decide()'s own 'flat' bookkeeping site rather than runActivePlan's.
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
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

// XA5 fix: updateNoopBreaker must never advance on a degrade row — a `client_latched`/
// `budget_exhausted:`/`off_menu:`/`schema_rejected:` (etc.) decision is lane-health noise, not the
// model repeating itself, and once positioned there is no forced_rearm rescue (that branch requires
// activePlan === null — see evaluateConsultSchedule's own header comment — and a managed position
// always has one). Gated on the same isModelAuthoredDecision filter the decision-history ring already
// uses (agentic.strategy.ts's own decide()).
describe('AgenticStrategy repeated-noop breaker (XA5) is gated on model-authored decisions', () => {
  // Bar 0 opens the plan for real (open_long + directives); every later call repeats the SAME
  // scripted decision while the position stays unchanged, so posKey/action never vary — the only
  // thing that can differ between the two tests below is whether that repeated row counts. Pinned
  // nextConsultBars: 1 keeps every bar nominally due for a fresh consult regardless of the breaker,
  // isolating the breaker's own suppression as the only thing that could stop a further LLM call.
  class RepeatingClient implements AgentClientPort {
    calls = 0;
    constructor(private readonly repeated: { action: 'hold' | 'error'; rationale: string }) {}
    propose(): Promise<AgentProposal> {
      this.calls += 1;
      if (this.calls === 1) {
        return Promise.resolve({
          signals: [],
          decision: { action: 'open_long', confidence: 0.8, rationale: 'enter' },
          plan: PLAN,
          nextConsultBars: 1,
        });
      }
      return Promise.resolve({
        signals: [],
        decision: {
          ...this.repeated,
          confidence: this.repeated.action === 'error' ? null : 0.5,
        },
        nextConsultBars: 1,
      });
    }
  }

  it('six consecutive client_latched degrade rows while positioned do NOT engage the breaker', async () => {
    const client = new RepeatingClient({
      action: 'error',
      rationale: 'client_latched: cause=fatal_400',
    });
    const strategy = makeStrategy(client);
    const held = longPosition('100');

    await strategy.decide(buildInput(0)); // open_long -> plan stored
    for (let i = 1; i <= 6; i++) {
      await strategy.decide(buildInput(i, { position: held })); // 6x identical client_latched row
    }
    const callsSoFar = client.calls;
    await strategy.decide(buildInput(7, { position: held }));
    // A wrongly-engaged breaker would suppress this bar (skipped_scheduled) despite nextConsultBars:1
    // pinning it due — the call count must still climb.
    expect(client.calls).toBe(callsSoFar + 1);
  });

  it('six consecutive genuinely model-authored identical holds while positioned DO engage the breaker', async () => {
    const client = new RepeatingClient({ action: 'hold', rationale: 'chop, no edge' });
    const strategy = makeStrategy(client);
    const held = longPosition('100');

    await strategy.decide(buildInput(0));
    for (let i = 1; i <= 6; i++) {
      await strategy.decide(buildInput(i, { position: held })); // 6x identical model-authored hold
    }
    const callsSoFar = client.calls;
    await strategy.decide(buildInput(7, { position: held }));
    // The breaker engaged on the 6th identical model-authored hold — this bar is suppressed even
    // though nextConsultBars: 1 keeps it nominally due.
    expect(client.calls).toBe(callsSoFar);
  });
});
