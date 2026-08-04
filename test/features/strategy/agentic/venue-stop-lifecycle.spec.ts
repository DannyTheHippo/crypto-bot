import { describe, it, expect } from 'vitest';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
  type VenueStopEvent,
  type VenueTpEvent,
} from '../../../../src/features/strategy/agentic/agentic.strategy';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentDirectives,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { Signal } from '../../../../src/domain/strategy/types/signal';
import type { CandleEvent } from '../../../../src/domain/venue/types/market-events';
import type { ExecReport } from '../../../../src/domain/trading/types/exec-report';
import type { OpenOrderSummary, Position } from '../../../../src/domain/trading/types/portfolio';
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
import { positionKey } from '../../../../src/domain/trading/risk/evaluate';
import type { PlanStop, PlanStopRegistryPort } from '../../../../src/ports/trading/risk';
import type { ExecutionStorePort } from '../../../../src/ports/trading/execution';
import type { AlgoOrderState } from '../../../../src/ports/venue/exchange';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';

// Push 3 P7d: unit-level venue-resting protective stop lifecycle, mirroring
// plan-lifecycle.spec.ts's own "venue-resting take-profit lifecycle" describe blocks (helpers
// duplicated locally rather than exported — this file owns its own fixtures, same convention as
// every other feature-scoped spec in this suite).

const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const PERP_V = venueId('binanceusdm');
const PERP_SYM = symbolId('BTC/USDT:USDT');
const STEP_MS = 900_000;
const BASE_TIME = 14_400_000 * 100_000;
const REG_KEY = positionKey(SID, V, SYM);
const PERP_REG_KEY = positionKey(SID, PERP_V, PERP_SYM);

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

function candle(index: number, symbol = SYM, venue = V, close = '100'): CandleEvent {
  const t = BASE_TIME + index * STEP_MS;
  return {
    kind: 'CANDLE',
    venue,
    symbol,
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

function longPosition(avgEntry: string, symbol = SYM, venue = V): Position {
  return {
    strategyId: SID,
    venue,
    symbol,
    signedQty: new Decimal('0.001'),
    avgEntry: price(avgEntry),
    realizedPnl: new Decimal(0),
  };
}

// 2026-07-15 loop fix regression fixture: a position whose qty carries sub-step dust (0.0012345 —
// roundToStep 'down' to any of these venues' LOT_SIZE steps is strictly smaller), so a reduce-only
// stop resting at the step-rounded protectable qty can never equal position.qty exactly. Before the
// fix the exact-equality check read that residue as a mismatch and churned qty_cancel every bar.
function longPositionSubStep(symbol = SYM, venue = V): Position {
  return {
    strategyId: SID,
    venue,
    symbol,
    signedQty: new Decimal('0.0012345'),
    avgEntry: price('100'),
    realizedPnl: new Decimal(0),
  };
}

// B2 (Design § Deleted scaffolding, already landed): evaluateConsultSchedule does NOT force a
// consult on a brand-new instance's very first candle bar the way the retired prescreen gate did —
// mirrors plan-lifecycle.spec.ts's own buildInput fix: bar 0 defaults to an 'exec' trigger
// (forced_fill, schedule-independent) so every "the LLM was consulted this bar" assertion in this
// file keeps its pre-B2 seeding behavior without touching each call site.
function execEvent(index: number, symbol = SYM, venue = V): ExecReport {
  return {
    kind: 'ACK',
    reportId: `r${index}`,
    clientOrderId: clientOrderId('cbp0000000000000007000800000000000000'),
    venue,
    symbol,
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
    symbol?: ReturnType<typeof symbolId>;
    venue?: ReturnType<typeof venueId>;
    trigger?: 'candle' | 'exec';
  } = {},
): AgentDecisionInput {
  const symbol = opts.symbol ?? SYM;
  const venue = opts.venue ?? V;
  const candles = Array.from({ length: index + 1 }, (_, i) =>
    candle(i, symbol, venue, i === index ? (opts.close ?? '100') : '100'),
  );
  const positions = new Map<string, Position>();
  if (opts.position) positions.set(`${SID}|${venue}|${symbol}`, opts.position);
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(BASE_TIME + index * STEP_MS),
    candles: new Map([[symbol, candles]]),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions, openOrders: opts.openOrders ?? [] },
  };
  const triggerKind = opts.trigger ?? (index === 0 ? 'exec' : 'candle');
  const trigger: AgentDecisionInput['trigger'] =
    triggerKind === 'exec'
      ? { kind: 'exec', event: execEvent(index, symbol, venue) }
      : { kind: 'candle', event: candle(index, symbol, venue) };
  return { strategyId: SID, trigger, snapshot };
}

// stopLossPct '0.02' ⇒ LONG stop = entry × 0.98; takeProfitPct '0.03' ⇒ TP = entry × 1.03.
// B3: AgentDirectives (v2) replaces AgentPlan — sizeFraction/entryStyle are new required fields.
const PLAN: AgentDirectives = {
  sizeFraction: '0.05',
  entryOffsetBps: 10,
  stopLossPct: '0.02',
  takeProfitPct: '0.03',
  entryValidityBars: 2,
  maxHoldBars: 8,
  entryStyle: 'maker',
};

// nextConsultBars defaults to 4, matching plan-lifecycle.spec.ts's own default/rationale — the
// portfolio-scheduled consult cadence (evaluateConsultSchedule, B2) now comes from the CLIENT, not
// a strategy param.
class PlanningClient implements AgentClientPort {
  calls = 0;
  constructor(private readonly nextConsultBars = 4) {}
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    this.calls += 1;
    const signal: Signal = {
      strategyId: SID,
      venue: input.snapshot.candles.keys().next().value ? V : V,
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

const TEST_IID = intentId('0190abcd-1234-7abc-89ab-0123456789ab');
function intentWithDedupeKey(coid: string, dedupeKey: string): OrderIntent {
  return {
    intentId: TEST_IID,
    clientOrderId: clientOrderId(coid),
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

// Every fixture resolves to a 'vsl' role — mirrors plan-lifecycle.spec.ts's own vtpOnlyIntentStore.
function vslOnlyIntentStore(): Pick<ExecutionStorePort, 'loadIntentByClientOrderId'> {
  return {
    loadIntentByClientOrderId: (coid) =>
      Promise.resolve(intentWithDedupeKey(String(coid), 'agentic:venue_stop_place:fixture')),
  };
}

function roledIntentStore(
  roleByClientOrderId: ReadonlyMap<string, 'vtp' | 'vsl'>,
): Pick<ExecutionStorePort, 'loadIntentByClientOrderId'> {
  return {
    loadIntentByClientOrderId: (coid) => {
      const role = roleByClientOrderId.get(String(coid));
      if (role === undefined) return Promise.resolve(null);
      const marker = role === 'vtp' ? 'agentic:venue_tp_place' : 'agentic:venue_stop_place';
      return Promise.resolve(intentWithDedupeKey(String(coid), `${marker}:fixture`));
    },
  };
}

function restingSell(
  limitPriceStr: string,
  qtyStr = '0.001',
  coid = 'cbp00000000000000070008000000000000a1',
): OpenOrderSummary {
  return {
    clientOrderId: clientOrderId(coid),
    symbol: SYM,
    side: 'SELL',
    qty: qty(qtyStr),
    limitPrice: price(limitPriceStr),
  };
}

function algoOrder(
  triggerPriceStr: string,
  qtyStr = '0.001',
  clientAlgoId = 'cbp0perp0000000000070008000000000000a1',
  side: 'BUY' | 'SELL' = 'SELL',
): AlgoOrderState {
  return {
    algoId: `venue-algo-${clientAlgoId}`,
    clientAlgoId,
    symbol: PERP_SYM,
    side,
    type: 'STOP_MARKET',
    qty: qtyStr,
    triggerPrice: triggerPriceStr,
    status: 'NEW',
    reduceOnly: true,
  };
}

function makeParams(overrides: Partial<AgenticStrategyParams> = {}): AgenticStrategyParams {
  return {
    symbol: SYM,
    venue: V,
    interval: '15m',
    warmupBars: 5,
    model: 'test-model',
    planMode: true,
    venueStopEnabled: true,
    // B2's own knobs, pinned explicitly (mirrors plan-lifecycle.spec.ts's own rationale): the
    // schedule (PlanningClient's nextConsultBars) is what these tests exercise, never wake-on-move
    // or the fallback cadence — pinned generously out of reach so a deliberate TP/SL-crossing close
    // price can never ALSO force an unplanned extra consult via 'forced_move'.
    wakeMovePct: 1,
    fallbackConsultBars: 1000,
    ...overrides,
  };
}

describe('AgenticStrategy venue-resting protective stop lifecycle (AGENTIC_VENUE_STOP) — SPOT', () => {
  it('flag off: never emits a RESTING_STOP exit, never touches the registry venueStopResting flag (byte-identical to pre-feature)', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams({ venueStopEnabled: false }), client, {
      onVenueStop: (e) => events.push(e),
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));
    const out = await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(out).toEqual([]);
    expect(events).toEqual([]);
    expect(registry.get(REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: false,
    });
  });

  it('SPOT never places a resting stop, even on the fill-observation bar (2026-07-31 fix) — stands the registry down instead', async () => {
    // Confirmed defect (independent adversarial review, 2026-07-31): on spot, manageVenueTp's 'vtp'
    // and this loop's 'vsl' both size to 100% of the position and reduceOnly is dropped on spot
    // (ccxt-exchange.adapter.ts), so resting BOTH legs meant they contended for the same free base
    // and the loser terminal-rejected. This is the regression pin for its fix — see
    // manageVenueStopSpot's own header comment for the full rationale.
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      onVenueStop: (e) => events.push(e),
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));

    const out = await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(client.calls).toBe(1);
    expect(out).toEqual([]);
    expect(events).toEqual([]);
    expect(registry.get(REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: false,
    });
  });

  it('confirms resting (registry venueStopResting → true) once the ack is observed; skipped_existing at the buffered-leg expectation (never the raw trigger)', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: vslOnlyIntentStore(),
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // spot never places (2026-07-31 fix) — stands down
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(false); // never placed
    events.length = 0;

    // Default stopLimitBufferBps=50 (sizer's own default): trigger 98 × (1 − 0.005) = 97.51 exactly
    // — the resting order's OWN limitPrice, never the raw 98 trigger.
    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
    expect(registry.get(REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: true,
    });
  });

  it('cancels the resting stop when its price genuinely drifts from the buffered-leg expectation (drift_cancel), and un-confirms the registry', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: vslOnlyIntentStore(),
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') }));
    events.length = 0;

    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('96')] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelSide).toBe('SELL');
    expect(out[0]!.cancelRole).toBe('vsl');
    expect(out[0]!.reason).toContain('drifted');
    expect(events).toEqual(['drift_cancel']);
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(false);
  });

  it('cancels the resting stop when its qty no longer matches the position (qty_cancel)', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: vslOnlyIntentStore(),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') }));
    events.length = 0;

    const out = await strategy.decide(
      buildInput(2, {
        position: longPosition('100'),
        openOrders: [restingSell('97.51', '0.0005')],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelRole).toBe('vsl');
    expect(out[0]!.reason).toContain('qty');
    expect(events).toEqual(['qty_cancel']);
  });

  it('does NOT churn a spot stop when its qty is the position step-rounded (dust residue → skipped_existing)', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(
      SID,
      makeParams({ venueStopStepSize: '0.00001' }), // BTC LOT_SIZE step
      client,
      { onVenueStop: (e) => events.push(e), intentStore: vslOnlyIntentStore() },
    );
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPositionSubStep() })); // spot never places (2026-07-31 fix) — stands down
    events.length = 0;

    // Bar 2: a STOP_LOSS_LIMIT already rests at the buffered leg 97.51 (e.g. seeded before this fix)
    // — qty 0.00123 = roundToStep(0.0012345, 0.00001, 'down'). The 0.0000045 residue is
    // un-protectable dust (below one step), not a mismatch.
    const out = await strategy.decide(
      buildInput(2, {
        position: longPositionSubStep(),
        openOrders: [restingSell('97.51', '0.00123')],
      }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
  });

  it('still cancels a spot stop on a real ≥1-step qty mismatch when a step is configured (qty_cancel)', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(
      SID,
      makeParams({ venueStopStepSize: '0.00001' }),
      client,
      { onVenueStop: (e) => events.push(e), intentStore: vslOnlyIntentStore() },
    );
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPositionSubStep() }));
    events.length = 0;

    // Resting 0.001 vs the 0.00123 protectable — a genuine uncovered slice (many steps), so the
    // step-rounded comparison still fires qty_cancel.
    const out = await strategy.decide(
      buildInput(2, {
        position: longPositionSubStep(),
        openOrders: [restingSell('97.51', '0.001')],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.cancelRole).toBe('vsl');
    expect(events).toEqual(['qty_cancel']);
  });

  it('stand-down: the bar-close stop exit defers to a CONFIRMED-resting venue stop while the breach stays within the force band (stood_down)', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams({ planStopForceBps: 30 }), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: vslOnlyIntentStore(),
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // spot never places (2026-07-31 fix) — stands down
    await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    ); // a stop already resting at the venue (e.g. seeded before this fix) is confirmed resting
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(true);
    events.length = 0;

    // close 97.9 breaches the stop (98) by ~10.2bps — within the 30bps force band.
    const out = await strategy.decide(
      buildInput(3, { close: '97.9', position: longPosition('100') }),
    );
    expect(out).toEqual([]);
    expect(events).toEqual(['stood_down']);
  });

  it('force-fire: a breach past the force band lets the bar-close IOC exit proceed, carrying cancelBeforeSubmit for both resting roles (force_fired, Defect B #49)', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams({ planStopForceBps: 30 }), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: vslOnlyIntentStore(),
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // spot never places (2026-07-31 fix) — stands down
    await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    ); // a stop already resting at the venue (e.g. seeded before this fix) is confirmed resting
    events.length = 0;

    // close 97 breaches the stop (98) by ~102bps — past the 30bps force band; the resting stop
    // (role-agnostic on the spot side scan) rides the exit's own cancelBeforeSubmit field — Defect
    // B (#49) fix: ONE signal, not a separate CANCEL_OPEN + exit pair.
    const out = await strategy.decide(
      buildInput(3, {
        close: '97',
        position: longPosition('100'),
        openOrders: [restingSell('97.51')],
      }),
    );
    expect(events).toEqual(['force_fired', 'cancel_for_exit']);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.cancelBeforeSubmit).toEqual({ side: 'SELL' }); // role-agnostic — clears vtp+vsl
    expect(out[0]!.reason).toBe('plan exit: stop');
  });

  // MUST-FIX 6 (2026-07-31 fix review): the force-band guard above (planStopForceBps) is declared
  // "FAILS OPEN — on spot, do not place, keep the bar-close software stop armed", but nothing
  // previously pinned that the guard only ever DEFERS when a stop is CONFIRMED resting
  // (registry venueStopResting true) — never when nothing rests at all. On spot post-fix,
  // venueStopResting is false whenever no legacy 'vsl' happens to be resting, so this is the common
  // case, not an edge case: the guard must let the bar-close exit through immediately.
  it('fails open at the guard: with NO venue stop resting (the spot norm post-2026-07-31 fix), a breach inside the force band still fires the plan exit — the defer only applies to a CONFIRMED-resting stop', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(SID, makeParams({ planStopForceBps: 30 }), client, {
      onVenueStop: (e) => events.push(e),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // no resting order — spot never places (2026-07-31 fix), stands down
    events.length = 0;

    // close 97.9 breaches the stop (98) by ~10.2bps — WITHIN the 30bps force band used by the
    // stand-down test above, but nothing rests server-side here, so the guard must not defer.
    const out = await strategy.decide(
      buildInput(2, { close: '97.9', position: longPosition('100') }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.reason).toBe('plan exit: stop');
    expect(events).not.toContain('stood_down');
  });

  it('cancel-first on a max_hold exit clears the resting stop even when AGENTIC_VENUE_TP is off (venueStopEnabled alone gates the cancel-first block, Defect B #49)', async () => {
    // nextConsultBars: 100 — the default schedule (4) would otherwise force a real re-consult well
    // before bar 8, replacing the plan with a fresh clock and starving the max_hold exit under test.
    const client = new PlanningClient(100);
    const strategy = new AgenticStrategy(SID, makeParams(), client);
    await strategy.decide(buildInput(0));
    // maxHoldBars=8: drive bars 1..8 without triggering stop/TP so max_hold fires on bar 8.
    for (let i = 1; i < 8; i++) {
      await strategy.decide(buildInput(i, { position: longPosition('100') }));
    }
    const out = await strategy.decide(
      buildInput(8, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    );
    // Defect B (#49) fix: ONE signal, not a separate CANCEL_OPEN + exit pair.
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.cancelBeforeSubmit).toEqual({ side: 'SELL' });
    expect(out[0]!.reason).toBe('plan exit: max_hold');
  });

  it('position_closed: the stop fills externally — the remaining orphaned vtp is cancelled (mirror image of the TP-fills path)', async () => {
    const client = new PlanningClient();
    const tpEvents: VenueTpEvent[] = [];
    const stopEvents: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(SID, { ...makeParams(), venueTpEnabled: true }, client, {
      onVenueTp: (e) => tpEvents.push(e),
      onVenueStop: (e) => stopEvents.push(e),
      intentStore: roledIntentStore(
        new Map([
          ['cbp00000000000000070008000000000000a1', 'vsl'],
          ['cbp00000000000000070008000000000000b2', 'vtp'],
        ]),
      ),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places vtp only — spot never places vsl (2026-07-31 fix)
    tpEvents.length = 0;
    stopEvents.length = 0;

    // Bar 2: FLAT (the stop filled externally — e.g. a legacy vsl resting from before this fix) —
    // the TP, still resting, is the orphan to clean up.
    const tpOrder = restingSell('103', '0.001', 'cbp00000000000000070008000000000000b2');
    const out = await strategy.decide(buildInput(2, { openOrders: [tpOrder] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelRole).toBe('vtp');
    expect(tpEvents).toEqual(['filled_flat', 'orphan_cancel']);
    expect(stopEvents).toEqual(['filled_flat']);
  });

  it('position_closed: the TP fills externally — the remaining orphaned vsl is cancelled', async () => {
    const client = new PlanningClient();
    const tpEvents: VenueTpEvent[] = [];
    const stopEvents: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(SID, { ...makeParams(), venueTpEnabled: true }, client, {
      onVenueTp: (e) => tpEvents.push(e),
      onVenueStop: (e) => stopEvents.push(e),
      intentStore: roledIntentStore(new Map([['cbp00000000000000070008000000000000a1', 'vsl']])),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') }));
    tpEvents.length = 0;
    stopEvents.length = 0;

    const stopOrder = restingSell('97.51', '0.001', 'cbp00000000000000070008000000000000a1');
    const out = await strategy.decide(buildInput(2, { openOrders: [stopOrder] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelRole).toBe('vsl');
    expect(stopEvents).toEqual(['filled_flat', 'orphan_cancel']);
  });

  it('restart re-arm: the first managed bar after a bare-LONG re-arm captures entryPrice/stopPrice but never places a venue stop on SPOT (2026-07-31 fix)', async () => {
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
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      onVenueStop: (e) => events.push(e),
      planStopRegistry: registry,
    });
    const held = longPosition('100');
    const first = await strategy.decide(buildInput(0, { position: held })); // re-arm, no signal
    expect(first).toEqual([]);
    // entryPrice is still null on the re-arm consult itself (decide()'s own bookkeeping never calls
    // setPlanStop — only runActivePlan's entry-fill-capture branch does, on the FIRST MANAGED bar).
    expect(registry.get(REG_KEY)).toBeUndefined();

    const second = await strategy.decide(buildInput(1, { position: held })); // first managed bar
    expect(second).toEqual([]); // SPOT never places — see manageVenueStopSpot's header comment
    expect(events).toEqual([]);
    expect(registry.get(REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: false, // never placed — setPlanStop still seeds side/stopPrice independently
    });
  });

  // Push 3 P7f fix 6 regression: a transient intent-store throw while classifying the resting SELL
  // must skip this bar's reconcile decision (fail toward no-op), never read as "nothing resting" —
  // still true post-2026-07-31 fix even though spot no longer places: an unverified read must not
  // let the stand-down branch flip venueStopResting false while a stop may genuinely rest server-side.
  it('fix 6: an intent-store throw during SPOT reconcile leaves a CONFIRMED-resting stop confirmed — the flag must not flip false on an unverified read', async () => {
    const client = new PlanningClient();
    const registry = planStopRegistry();
    let throwing = false;
    const store: Pick<ExecutionStorePort, 'loadIntentByClientOrderId'> = {
      loadIntentByClientOrderId: (coid) =>
        throwing
          ? Promise.reject(new Error('db down'))
          : Promise.resolve(intentWithDedupeKey(String(coid), 'agentic:venue_stop_place:fixture')),
    };
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      intentStore: store,
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // spot never places (2026-07-31 fix) — stands down

    // Bar 2: a clean read confirms the resting 'vsl' — venueStopResting flips true.
    await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    );
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(true);

    // Bar 3: the SAME resting order, but the store now throws classifying it — the store-error
    // branch must return [] WITHOUT touching setVenueStopResting, leaving the prior CONFIRMED
    // `true` in place. Removing the store-error early-return makes roleForOrderChecked's collapsed
    // 'unknown' fall through to the stand-down branch instead, flipping this false — verified by
    // temporarily deleting that branch locally: the assertion below fails as expected.
    throwing = true;
    const out = await strategy.decide(
      buildInput(3, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    );
    expect(out).toEqual([]); // skipped — store-error fail-toward-no-op, not a stand-down
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(true);
  });

  // 2026-07-31 fix regression coverage: the two roles used to be exercised in isolation on spot,
  // never together — the very gap that let the double-rest defect (both legs sizing to 100% of the
  // position, contending for the same free base) go unnoticed.
  it('a resting vtp (from manageVenueTp) never causes a placement — the loop stays role-scoped, standing the registry down', async () => {
    const client = new PlanningClient();
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      planStopRegistry: registry,
      intentStore: roledIntentStore(new Map([['cbp00000000000000070008000000000000b2', 'vtp']])),
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') }));

    // Bar 2: a 'vtp' rests at the FULL step-rounded qty (manageVenueTp's own resting order) — this
    // loop only matches role 'vsl', so it must never mistake the vtp for a stop to manage, and must
    // never place its own stop alongside it.
    const vtpOrder = restingSell('103', '0.001', 'cbp00000000000000070008000000000000b2');
    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [vtpOrder] }),
    );
    expect(out).toEqual([]);
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(false);
  });

  it('regression guard: a spot vsl already resting at the venue (seeded before this fix, never placed by this strategy instance) is still scanned, confirmed, and cancellable — never stranded', async () => {
    const client = new PlanningClient();
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: vslOnlyIntentStore(),
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0));

    // Bar 1: a 'vsl' already rests — this strategy instance never placed it (the stand-down branch
    // ran with no openOrders on every prior bar in the other tests above; here the FIRST bar this
    // instance ever sees a stop already resting server-side). manageVenueStopSpot must still find,
    // confirm, and manage it rather than treating a stop it didn't itself place as unmanaged.
    await strategy.decide(
      buildInput(1, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    );
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(true);
    events.length = 0;

    // Bar 2: it genuinely drifts — proves the cancel path (the only way to retire a pre-existing
    // resting stop now that placement is gone) still fires and un-confirms the registry.
    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('96')] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('CANCEL_OPEN');
    expect(out[0]!.cancelRole).toBe('vsl');
    expect(events).toEqual(['drift_cancel']);
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(false);
  });

  it('invariant: SPOT never emits two same-side reduce-only placements in one bar (the TP+STOP double-rest defect this fix retires)', async () => {
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, { ...makeParams(), venueTpEnabled: true }, client);
    await strategy.decide(buildInput(0));

    // Fill-observation bar, no resting orders yet: pre-fix this emitted BOTH a 'RESTING' TP and a
    // 'RESTING_STOP' stop, one SELL each against the same free base — exactly the contention
    // measured live (78% combined InsufficientFunds terminal-reject rate across both legs over one
    // week; vtp 86.6%/vsl 58.5% split by role — both artifacts of the two legs fighting over the
    // same balance, neither a property of either leg alone).
    const out = await strategy.decide(buildInput(1, { position: longPosition('100') }));
    const placements = out.filter(
      (s) =>
        (s.kind === 'EXIT_LONG' || s.kind === 'EXIT_SHORT') &&
        (s.exitStyle === 'RESTING' || s.exitStyle === 'RESTING_STOP'),
    );
    expect(placements).toHaveLength(1);
    expect(placements[0]!.exitStyle).toBe('RESTING'); // the TP only — the stop never places on spot
  });
});

describe('AgenticStrategy venue-resting protective stop lifecycle (AGENTIC_VENUE_STOP) — PERP (unit-mocked adapter)', () => {
  function perpParams(overrides: Partial<AgenticStrategyParams> = {}): AgenticStrategyParams {
    return {
      symbol: PERP_SYM,
      venue: PERP_V,
      interval: '15m',
      warmupBars: 5,
      model: 'test-model',
      planMode: true,
      venueStopEnabled: true,
      ...overrides,
    };
  }

  function perpLongPosition(avgEntry: string): Position {
    return longPosition(avgEntry, PERP_SYM, PERP_V);
  }

  function perpInput(
    index: number,
    opts: { close?: string; position?: Position } = {},
  ): AgentDecisionInput {
    return buildInput(index, { ...opts, symbol: PERP_SYM, venue: PERP_V });
  }

  it('places the SAME RESTING_STOP signal shape as spot (PositionSizerService branches STOP_MARKET off venue/symbol, not the strategy)', async () => {
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      algoOrders: { fetchOpenAlgoOrders: () => Promise.resolve([]) },
    });
    await strategy.decide(perpInput(0));
    const out = await strategy.decide(perpInput(1, { position: perpLongPosition('100') }));
    expect(out).toHaveLength(1);
    expect(out[0]!.exitStyle).toBe('RESTING_STOP');
    expect(out[0]!.triggerPriceHint!.toFixed()).toBe('98');
  });

  it('reconciles via fetchOpenAlgoOrders: a matching resting algo order confirms the registry (algoId captured) — skipped_existing', async () => {
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const resting = algoOrder('98');
    let fetchCalls = 0;
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      // One read per bar since #147 — the orphan sweep does it and manageVenueStopPerp reuses that
      // same list, so the counter below numbers BARS, not consumers: call #1 is bar 0 (FLAT, nothing
      // resting), every later call is one managed bar observing the ack. Modeled as a call-counter
      // since fetchOpenAlgoOrders takes no per-bar argument to vary by, mirroring the spot suite's
      // own per-bar openOrders shape (buildInput's opts.openOrders).
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
      },
      planStopRegistry: registry,
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // first managed bar
    events.length = 0;

    const out = await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // confirmed
    expect(out).toEqual([]);
    expect(events).toEqual(['orphan_scan', 'skipped_existing']);
    expect(registry.get(PERP_REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: true,
      algoId: resting.algoId,
    });
  });

  it('drift_cancel calls cancelAlgoOrder directly (no CANCEL_OPEN signal — the algo rail is never in openOrders), journals the cancel, and re-places within the same bar', async () => {
    const events: VenueStopEvent[] = [];
    const resting = algoOrder('90'); // far from the expected trigger 98 — genuine drift
    const cancelled: Array<{ algoId: string; symbol: string }> = [];
    const goneCalls: Array<ReturnType<typeof symbolId>> = [];
    let fetchCalls = 0;
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          // Push 3 P7f fix 7b + #147: the orphaned-algo-stop sweep runs on EVERY bar (bar 0
          // harmlessly — nothing resting, FLAT) and hands its list to manageVenueStopPerp, so this
          // counter numbers bars: #1 bar 0, #2 the "placed" bar, #3 the "drift" bar.
          return Promise.resolve(fetchCalls <= 2 ? [] : [resting]);
        },
        cancelAlgoOrder: (algoId, symbol) => {
          cancelled.push({ algoId, symbol: String(symbol) });
          return Promise.resolve();
        },
      },
      // 2026-07-31: the live BTC/USDT:USDT stop this path cancelled at 22:45Z stayed non-terminal in
      // our book because the cancel was never journaled — the fold seam closes that.
      onAlgoStopGone: (symbol) => {
        goneCalls.push(symbol);
        return Promise.resolve('canceled');
      },
      planStopRegistry: planStopRegistry(),
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
    events.length = 0;

    // #148 (2026-08-04): the cancel still goes through the direct adapter call (no CANCEL_OPEN can
    // reach the algo rail), but the re-placement no longer waits for the next managed bar — that
    // deferral left the position with no venue stop for a full bar interval (live: STOP_MARKETs
    // VENUE_CANCELED 08:30:37/44Z, nothing resting again until 08:45, watcher backstop off). The
    // cancel above is confirmed, so the fresh stop is emitted in this same decide() call.
    const out = await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // drift
    expect(out).toHaveLength(1);
    expect(out[0]!.exitStyle).toBe('RESTING_STOP');
    expect(out[0]!.triggerPriceHint!.toFixed()).toBe('98'); // re-derived, not the stale 90
    // 'orphan_scan' leads every managed perp bar since #147 — the sweep reaches its venue read on
    // this bar too; 'drift_cancel' then 'placed' remain the same-bar self-heal under test.
    expect(events).toEqual(['orphan_scan', 'drift_cancel', 'placed']);
    expect(cancelled).toEqual([{ algoId: resting.algoId, symbol: String(PERP_SYM) }]);
    expect(goneCalls).toEqual([PERP_SYM]);
  });

  // Cancelling a protective stop is irreversible-adjacent: with the cancel's own outcome unknown,
  // a same-bar placement could leave TWO stops resting for one position. The self-heal above is
  // therefore gated on a CONFIRMED cancel and fails toward no-op otherwise.
  it('does NOT re-place within the bar when the drift cancel itself throws (unconfirmed cancel)', async () => {
    const events: VenueStopEvent[] = [];
    const resting = algoOrder('90');
    let fetchCalls = 0;
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls <= 2 ? [] : [resting]);
        },
        cancelAlgoOrder: () => Promise.reject(new Error('venue rejected the cancel')),
      },
      planStopRegistry: planStopRegistry(),
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
    events.length = 0;

    const out = await strategy.decide(perpInput(2, { position: perpLongPosition('100') }));
    expect(out).toEqual([]);
    expect(events).toEqual(['orphan_scan', 'drift_cancel']); // no 'placed' — the drifted stop may still rest
  });

  it('qty_cancel calls cancelAlgoOrder directly, journals the cancel, and re-places within the same bar', async () => {
    const events: VenueStopEvent[] = [];
    const resting = algoOrder('98', '0.0005'); // qty mismatch vs the 0.001 position
    const cancelled: string[] = [];
    const goneCalls: Array<ReturnType<typeof symbolId>> = [];
    let fetchCalls = 0;
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      onAlgoStopGone: (symbol) => {
        goneCalls.push(symbol);
        return Promise.resolve('canceled');
      },
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
    events.length = 0;

    const out = await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // qty mismatch
    // Re-sized within the same bar (#148) — the correctly-sized stop replaces the mismatched one
    // here rather than leaving the position uncovered until the next managed bar.
    expect(out).toHaveLength(1);
    expect(out[0]!.exitStyle).toBe('RESTING_STOP');
    expect(events).toEqual(['qty_cancel', 'placed']);
    expect(cancelled).toEqual([resting.algoId]);
    expect(goneCalls).toEqual([PERP_SYM]);
  });

  it('does NOT churn a perp algo stop when its qty is the position step-rounded (dust residue → skipped_existing)', async () => {
    const events: VenueStopEvent[] = [];
    // Perp LOT_SIZE step 0.001 → roundToStep(0.0012345, 0.001, 'down') = 0.001, the algo stop's qty.
    const resting = algoOrder('98', '0.001');
    const cancelled: string[] = [];
    let fetchCalls = 0;
    const client = new PlanningClient();
    const perpSubStep = () => longPositionSubStep(PERP_SYM, PERP_V);
    const strategy = new AgenticStrategy(SID, perpParams({ venueStopStepSize: '0.001' }), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpSubStep() })); // placed
    events.length = 0;

    const out = await strategy.decide(perpInput(2, { position: perpSubStep() })); // reconcile
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
    expect(cancelled).toEqual([]); // the dust residue must NOT trigger a cancelAlgoOrder round trip
  });

  it('still cancels a perp algo stop on a real ≥1-step qty mismatch when a step is configured (qty_cancel)', async () => {
    const events: VenueStopEvent[] = [];
    const resting = algoOrder('98', '0.001'); // 0.001 vs the 0.00123 protectable — genuine mismatch
    const cancelled: string[] = [];
    let fetchCalls = 0;
    const client = new PlanningClient();
    const perpSubStep = () => longPositionSubStep(PERP_SYM, PERP_V);
    const strategy = new AgenticStrategy(SID, perpParams({ venueStopStepSize: '0.0001' }), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpSubStep() })); // placed
    events.length = 0;

    // Step 0.0001 → roundToStep(0.0012345, 0.0001, 'down') = 0.0012 protectable, vs the 0.001 resting
    // (a genuine ≥1-step uncovered slice) ⇒ qty_cancel via the direct cancelAlgoOrder call, then the
    // same-bar re-place (#148) instead of a bar with nothing protecting the position.
    const out = await strategy.decide(perpInput(2, { position: perpSubStep() }));
    expect(out).toHaveLength(1);
    expect(out[0]!.exitStyle).toBe('RESTING_STOP');
    expect(events).toEqual(['qty_cancel', 'placed']);
    expect(cancelled).toEqual([resting.algoId]);
  });

  it('cancel-first on a max_hold exit cancels the resting algo stop by its registry algoId before the IOC exit, and journals the cancel', async () => {
    const resting = algoOrder('98');
    const cancelled: string[] = [];
    const goneCalls: Array<ReturnType<typeof symbolId>> = [];
    const registry = planStopRegistry();
    let fetchCalls = 0;
    // nextConsultBars: 100 — see the SPOT max_hold test's own rationale above.
    const client = new PlanningClient(100);
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      onAlgoStopGone: (symbol) => {
        goneCalls.push(symbol);
        return Promise.resolve('canceled');
      },
      planStopRegistry: registry,
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
    await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // confirmed, algoId cached
    expect(registry.get(PERP_REG_KEY)?.algoId).toBe(resting.algoId);

    // PLAN.maxHoldBars = 8: barsElapsed is 2 after the bar above, so 6 more bars reach 8 exactly —
    // 5 quiet holds (barsElapsed 3..7) then the explicit assertion call at barsElapsed 8.
    for (let i = 3; i < 8; i++) {
      await strategy.decide(perpInput(i, { position: perpLongPosition('100') }));
    }
    const out = await strategy.decide(perpInput(8, { position: perpLongPosition('100') }));
    expect(cancelled).toEqual([resting.algoId]); // cancelled by the registry's cached algoId
    expect(goneCalls).toEqual([PERP_SYM]); // and journaled, so the local order can reach terminal
    expect(out).toHaveLength(1); // no CANCEL_OPEN Signal on the algo rail — exit only
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.reason).toBe('plan exit: max_hold');
  });

  it('on-demand fallback: cancels via a fresh fetchOpenAlgoOrders lookup when max_hold fires on the very first managed bar, before any reconcile bar ever ran (algoId never cached)', async () => {
    // A 1-bar max-hold plan: barsElapsed reaches 1 (>= maxHoldBars) on the SAME bar
    // runActivePlan captures entryPrice and calls setPlanStop — the 'exit' verdict short-circuits
    // before ever reaching the hold-branch's manageVenueStop call, so the registry only ever holds
    // what setPlanStop itself wrote (venueStopResting: false, no algoId) — exactly the "the stop may
    // genuinely be resting at the venue but this strategy's own bookkeeping never confirmed it"
    // case cancelPerpAlgoStopIfResting's fallback exists for.
    const shortPlan: AgentDirectives = { ...PLAN, maxHoldBars: 1 };
    class ShortPlanClient implements AgentClientPort {
      calls = 0;
      propose(input: AgentDecisionInput): Promise<AgentProposal> {
        this.calls += 1;
        const signal: Signal = {
          strategyId: SID,
          venue: PERP_V,
          symbol: PERP_SYM,
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
          plan: shortPlan,
        });
      }
    }
    const resting = algoOrder('98');
    const cancelled: string[] = [];
    let fetchCalls = 0;
    const client = new ShortPlanClient();
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          // Push 3 P7f fix 7b: bar 0 (no active plan yet, FLAT) also runs the orphaned-algo-stop
          // boot check first — it must see nothing resting yet (call #1) so it does not cancel this
          // fixture's order a bar early; the fallback lookup inside cancelPerpAlgoStopIfResting is
          // the real call #2, which is when this test intends the resting order to first appear.
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      planStopRegistry: registry,
    });
    await strategy.decide(perpInput(0));
    const out = await strategy.decide(perpInput(1, { position: perpLongPosition('100') }));
    expect(fetchCalls).toBeGreaterThan(0); // the fallback scan ran
    expect(cancelled).toEqual([resting.algoId]);
    expect(out).toHaveLength(1); // no CANCEL_OPEN Signal on the algo rail — exit only
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.reason).toBe('plan exit: max_hold');
  });

  // Push 3 P7f fix 5 regression: the SAME on-demand fallback scenario as above, but
  // fetchOpenAlgoOrders REJECTS instead of resolving. Before the fix, that throw propagated out of
  // cancelPerpAlgoStopIfResting (the only call in that method not under try/catch), past the
  // already-torn-down plan (clearPlan() runs before the cancel-first block), losing the exit Signal
  // entirely — a naked position with no crossed exit and no resting stop. The fix wraps the fallback
  // lookup so this method can never throw; the timed-out (max_hold) exit must still return exactly
  // one EXIT signal after the (failed, swallowed) cancel attempt.
  it('fix 5: a max_hold exit still emits exactly one EXIT signal when the fallback fetchOpenAlgoOrders lookup rejects', async () => {
    const shortPlan: AgentDirectives = { ...PLAN, maxHoldBars: 1 };
    class ShortPlanClient implements AgentClientPort {
      calls = 0;
      propose(input: AgentDecisionInput): Promise<AgentProposal> {
        this.calls += 1;
        const signal: Signal = {
          strategyId: SID,
          venue: PERP_V,
          symbol: PERP_SYM,
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
          plan: shortPlan,
        });
      }
    }
    const client = new ShortPlanClient();
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.reject(new Error('network down')),
      },
      planStopRegistry: registry,
    });
    await strategy.decide(perpInput(0));
    const out = await strategy.decide(perpInput(1, { position: perpLongPosition('100') }));
    expect(out).toHaveLength(1); // the exit Signal was NOT dropped by the rejected fallback lookup
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.reason).toBe('plan exit: max_hold');
  });

  // 2026-07-31 (adversarial review S3): the cancel-first path is the ONE place where a signal is at
  // stake behind the fold seam — cancelPerpAlgoStopIfResting runs BETWEEN the algo cancel and the
  // caller's exit-Signal construction, after clearPlan() has already torn down the registry. That is
  // the exact geometry P7f fix 5 above documents ("leaving a naked position with no crossed exit and
  // no resting stop"), so the journal call must be as incapable of costing the exit as the fallback
  // lookup now is. Passes trivially while the call is `void`-ed — which is the point: an `await`
  // reintroduced here would fail this test instead of silently re-breaking the contract.
  it('S3: a max_hold exit still emits exactly one EXIT signal when the onAlgoStopGone journal seam rejects', async () => {
    const shortPlan: AgentDirectives = { ...PLAN, maxHoldBars: 1 };
    class ShortPlanClient implements AgentClientPort {
      calls = 0;
      propose(input: AgentDecisionInput): Promise<AgentProposal> {
        this.calls += 1;
        const signal: Signal = {
          strategyId: SID,
          venue: PERP_V,
          symbol: PERP_SYM,
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
          plan: shortPlan,
        });
      }
    }
    const resting = algoOrder('98');
    const cancelled: string[] = [];
    let fetchCalls = 0;
    const strategy = new AgenticStrategy(SID, perpParams(), new ShortPlanClient(), {
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        // Bar 0's orphan boot check must see nothing (call #1); the cancel-first fallback lookup is
        // call #2 — same shape as the on-demand fallback test above.
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      onAlgoStopGone: () => Promise.reject(new Error('recovery sweep exploded')),
      planStopRegistry: planStopRegistry(),
    });
    await strategy.decide(perpInput(0));
    const out = await strategy.decide(perpInput(1, { position: perpLongPosition('100') }));
    expect(cancelled).toEqual([resting.algoId]); // the venue cancel still happened
    expect(out).toHaveLength(1); // and the exit Signal was NOT dropped by the rejected journal
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.reason).toBe('plan exit: max_hold');
  });

  // Push 3 P7f fix 6 regression: a transient intent-store throw while classifying a candidate must
  // read as "cannot tell" (skip placement this bar), never as "nothing resting" (which would place a
  // DUPLICATE stop next to one already resting server-side).
  it('fix 6: an intent-store throw during PERP reconcile skips placement this bar (no duplicate stop)', async () => {
    const resting = algoOrder('98');
    const throwingStore: Pick<ExecutionStorePort, 'loadIntentByClientOrderId'> = {
      loadIntentByClientOrderId: () => Promise.reject(new Error('db down')),
    };
    let fetchCalls = 0;
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      intentStore: throwingStore,
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
      },
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
    const out = await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // reconcile bar — store throws
    expect(out).toEqual([]); // skipped, NOT a second 'placed' signal
  });

  // Backlog #54 (FLAG 1) regression: a fetchOpenAlgoOrders rejection during the PERP managed-bar
  // reconcile must stay INSIDE manageVenueStopPerp. Before the fix it propagated out of decide(),
  // discarding the venue-TP signal manageVenueTp had already built on the SAME bar (metric'd
  // 'placed', never emitted — 0 venue-TP intents ever on the perp lane) and feeding auto-DRAIN.
  // Live signature: demo-fapi answers the raw openAlgoOrders GET with a bare array, so the
  // adapter's `{ orders }` destructure throws on EVERY call (probe 2026-07-16; the adapter-shape
  // fix itself is owner-gated — exchange adapters are outside loop autonomy).
  it('#54: a fetchOpenAlgoOrders rejection during PERP reconcile resolves decide() — venue-TP signal survives, reconcile_error emitted, stop placement skipped', async () => {
    const stopEvents: VenueStopEvent[] = [];
    const tpEvents: VenueTpEvent[] = [];
    const registry = planStopRegistry();
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, perpParams({ venueTpEnabled: true }), client, {
      onVenueStop: (e) => stopEvents.push(e),
      onVenueTp: (e) => tpEvents.push(e),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.reject(new Error('adapter shape throw')),
      },
      planStopRegistry: registry,
    });
    await strategy.decide(perpInput(0));
    const out = await strategy.decide(perpInput(1, { position: perpLongPosition('100') }));
    expect(out).toHaveLength(1); // the TP placement — NOT discarded by the stop reconcile throw
    expect(out[0]!.exitStyle).toBe('RESTING');
    expect(out[0]!.limitPriceHint!.toFixed()).toBe('103');
    expect(tpEvents).toContain('placed');
    // Two, not one, since 2026-07-31: bar 0 (no active plan yet) runs the orphan scan, whose OWN
    // fetchOpenAlgoOrders read hits the same rejection and now says so instead of returning silently;
    // bar 1 is the managed-bar reconcile this regression was written for. No 'placed' either bar —
    // both placement decisions were skipped.
    expect(stopEvents).toEqual(['reconcile_error', 'reconcile_error']);
    // The registry's stand-down flag is untouched by the failed read (set at plan attach, never
    // flipped by an unverified reconcile) — the watcher/force-band backstops stay armed.
    expect(registry.get(PERP_REG_KEY)?.venueStopResting).not.toBe(true);
  });

  // Defect A commit-1 (2026-07-16 phantom perp position): AgenticStrategyDeps.onAlgoStopGone —
  // consulted ONLY when a CONFIRMED-resting perp algo stop vanishes from fetchOpenAlgoOrders. Every
  // test in this block runs the same 3-bar setup: bar1 places, bar2 confirms resting (registry
  // venueStopResting: true), bar3 the stop vanishes (fetchOpenAlgoOrders → []).
  describe('onAlgoStopGone (Defect A commit-1 phantom perp position recovery)', () => {
    function threeBarVanishSetup(
      deps: Pick<AgenticStrategyDeps, 'onVenueStop' | 'onAlgoStopGone'>,
    ) {
      const resting = algoOrder('98');
      let fetchCalls = 0;
      const registry = planStopRegistry();
      const client = new PlanningClient();
      const strategy = new AgenticStrategy(SID, perpParams(), client, {
        ...deps,
        intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
        algoOrders: {
          fetchOpenAlgoOrders: () => {
            fetchCalls += 1;
            // Push 3 P7f fix 7b + #147: one read per BAR — the orphan sweep performs it (bar 0
            // harmlessly, nothing resting while FLAT) and manageVenueStopPerp reuses the same list.
            // #1 bar0, #2 bar1 (placed), #3 bar2 (confirmed), #4+ bar3 — the vanish this describe
            // block exists to exercise.
            if (fetchCalls <= 2) return Promise.resolve([]); // bar0 sweep + bar1: placed
            if (fetchCalls === 3) return Promise.resolve([resting]); // bar2: confirmed resting
            return Promise.resolve([]); // bar3+: vanished
          },
        },
        planStopRegistry: registry,
      });
      return { strategy, registry };
    }

    it('"triggered": no re-placement, no exit signal, journals "triggered" — recovery already ingested the fill', async () => {
      const events: VenueStopEvent[] = [];
      const goneCalls: Array<ReturnType<typeof symbolId>> = [];
      const { strategy, registry } = threeBarVanishSetup({
        onVenueStop: (e) => events.push(e),
        onAlgoStopGone: (symbol) => {
          goneCalls.push(symbol);
          return Promise.resolve('triggered');
        },
      });
      await strategy.decide(perpInput(0));
      await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
      await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // confirmed resting
      expect(registry.get(PERP_REG_KEY)?.venueStopResting).toBe(true);
      events.length = 0;

      const out = await strategy.decide(perpInput(3, { position: perpLongPosition('100') })); // vanished
      expect(out).toEqual([]);
      expect(events).toEqual(['orphan_scan', 'triggered']);
      expect(goneCalls).toEqual([PERP_SYM]);
      expect(registry.get(PERP_REG_KEY)?.venueStopResting).toBe(false);
    });

    it('"canceled": nothing to recover — the existing re-place logic proceeds unchanged', async () => {
      const events: VenueStopEvent[] = [];
      const { strategy, registry } = threeBarVanishSetup({
        onVenueStop: (e) => events.push(e),
        onAlgoStopGone: () => Promise.resolve('canceled'),
      });
      await strategy.decide(perpInput(0));
      await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
      await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // confirmed resting
      events.length = 0;

      const out = await strategy.decide(perpInput(3, { position: perpLongPosition('100') })); // vanished
      expect(out).toHaveLength(1);
      expect(out[0]!.exitStyle).toBe('RESTING_STOP');
      expect(events).toEqual(['orphan_scan', 'placed']);
      expect(registry.get(PERP_REG_KEY)?.venueStopResting).toBe(false); // placed, not yet re-confirmed
    });

    it('"unknown": this bar\'s placement is skipped (fail-toward-no-op) — no placement, no exit signal', async () => {
      const events: VenueStopEvent[] = [];
      const { strategy } = threeBarVanishSetup({
        onVenueStop: (e) => events.push(e),
        onAlgoStopGone: () => Promise.resolve('unknown'),
      });
      await strategy.decide(perpInput(0));
      await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
      await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // confirmed resting
      events.length = 0;

      const out = await strategy.decide(perpInput(3, { position: perpLongPosition('100') })); // vanished
      expect(out).toEqual([]);
      // Only the sweep's own read label — no 'placed', this bar's placement decision was skipped.
      expect(events).toEqual(['orphan_scan']);
    });

    // Named for what it pins, not for a byte-comparison: the emitted sequence is no longer identical
    // to the pre-feature one (#147 prepends the sweep's own 'orphan_scan' to every managed perp bar).
    // The subject is the absent-dep fallback — with no onAlgoStopGone wired there is no recovery
    // consult and no skip, so the vanish falls straight through to re-placement.
    it('dep ABSENT: the vanish is never consulted — the re-placement path runs unchanged', async () => {
      const events: VenueStopEvent[] = [];
      const { strategy, registry } = threeBarVanishSetup({
        onVenueStop: (e) => events.push(e),
        // onAlgoStopGone intentionally omitted.
      });
      await strategy.decide(perpInput(0));
      await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
      await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // confirmed resting
      events.length = 0;

      const out = await strategy.decide(perpInput(3, { position: perpLongPosition('100') })); // vanished
      expect(out).toHaveLength(1);
      expect(out[0]!.exitStyle).toBe('RESTING_STOP');
      expect(out[0]!.triggerPriceHint!.toFixed()).toBe('98');
      expect(events).toEqual(['orphan_scan', 'placed']); // re-placed, with no 'triggered'/skip in between
      expect(registry.get(PERP_REG_KEY)?.venueStopResting).toBe(false);
    });
  });
});

// Push 3 P7f fix 7b: process-restart (or any bar with no in-memory activePlan) can strand a
// resting perp algo stop — nothing in the normal reconcile flow scans for it while activePlan is
// null. Both branches are unit-mocked here: re-adopt (a real position still needs the stop) and
// cancel-if-flat (the position it protected is already gone).
describe('AgenticStrategy — orphaned perp algo stop reconcile on boot/no-active-plan (fix 7b)', () => {
  function perpParams(overrides: Partial<AgenticStrategyParams> = {}): AgenticStrategyParams {
    return {
      symbol: PERP_SYM,
      venue: PERP_V,
      interval: '15m',
      warmupBars: 5,
      model: 'test-model',
      planMode: true,
      venueStopEnabled: true,
      ...overrides,
    };
  }

  // Never attaches a plan — activePlan stays null across every decide() call, mirroring a restart
  // that wiped in-memory plan state but hasn't yet had the model re-attach one.
  class NoPlanClient implements AgentClientPort {
    propose(): Promise<AgentProposal> {
      return Promise.resolve({
        signals: [],
        decision: { action: 'hold', confidence: 0.5, rationale: 'r' },
      });
    }
  }

  it('branch (a) re-adopts a lane-owned resting stop into the registry when the position is LONG/SHORT', async () => {
    const resting = algoOrder('97'); // the venue's OWN resting trigger — adopted verbatim
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: { fetchOpenAlgoOrders: () => Promise.resolve([resting]) },
      planStopRegistry: registry,
    });
    await strategy.decide(
      buildInput(0, {
        position: longPosition('100', PERP_SYM, PERP_V),
        symbol: PERP_SYM,
        venue: PERP_V,
      }),
    );
    expect(registry.get(PERP_REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '97',
      venueStopResting: true,
      algoId: resting.algoId,
    });
    // 2026-07-31: every exit of this function is now labelled — 'orphan_scan' proves the scan
    // reached the venue read at all, 'orphan_readopt' names which branch it took.
    expect(events).toEqual(['orphan_scan', 'orphan_readopt']);
  });

  it('branch (b) cancels the orphan when the position is FLAT (nothing left to protect), journals the cancel, and labels both', async () => {
    const resting = algoOrder('97');
    const cancelled: string[] = [];
    const events: VenueStopEvent[] = [];
    const goneCalls: Array<ReturnType<typeof symbolId>> = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.resolve([resting]),
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      // 2026-07-31 stale-non-terminal-algo-stop defect: without this the venue cancel is never
      // journaled, the local order row stays non-terminal, and its intent keeps the symbol BUSY in
      // HaltCoordinatorService.driveFlattening until the next boot.
      onAlgoStopGone: (symbol) => {
        goneCalls.push(symbol);
        return Promise.resolve('canceled');
      },
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0, { symbol: PERP_SYM, venue: PERP_V })); // no position ⇒ FLAT
    expect(cancelled).toEqual([resting.algoId]);
    expect(goneCalls).toEqual([PERP_SYM]); // the fold seam ran on the successful cancel
    expect(events).toEqual(['orphan_scan', 'orphan_cancel']);
    expect(registry.get(PERP_REG_KEY)).toBeUndefined(); // never adopted — nothing to protect
  });

  // The label that makes a zero on 'orphan_cancel' readable: before this, a matched orphan whose
  // cancel threw every bar was indistinguishable from no orphan ever being matched (the live
  // HYPE/USDT:USDT stop that sat ACKED ~11h across three boots).
  it('branch (b) emits orphan_cancel_failed and does NOT journal when cancelAlgoOrder throws', async () => {
    const resting = algoOrder('97');
    const events: VenueStopEvent[] = [];
    const goneCalls: Array<ReturnType<typeof symbolId>> = [];
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.resolve([resting]),
        cancelAlgoOrder: () => Promise.reject(new Error('venue rejected the cancel')),
      },
      onAlgoStopGone: (symbol) => {
        goneCalls.push(symbol);
        return Promise.resolve('canceled');
      },
      planStopRegistry: planStopRegistry(),
    });
    const out = await strategy.decide(buildInput(0, { symbol: PERP_SYM, venue: PERP_V }));
    expect(out).toEqual([]); // FAILS OPEN — the swallowed cancel never blocks the bar
    expect(events).toEqual(['orphan_scan', 'orphan_cancel_failed']);
    expect(goneCalls).toEqual([]); // nothing was cancelled at the venue ⇒ nothing to fold
  });

  it('emits reconcile_error when the orphan scan’s own fetchOpenAlgoOrders read throws', async () => {
    const events: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      algoOrders: { fetchOpenAlgoOrders: () => Promise.reject(new Error('adapter shape throw')) },
      planStopRegistry: planStopRegistry(),
    });
    const out = await strategy.decide(buildInput(0, { symbol: PERP_SYM, venue: PERP_V }));
    expect(out).toEqual([]);
    expect(events).toEqual(['reconcile_error']); // no 'orphan_scan' — the read never returned
  });

  // FAIL-OPEN contract for the fold seam: journalAlgoStopCanceled swallows, so a recovery-service
  // throw can never propagate out of decide() and cost the bar its signals.
  it('a throwing onAlgoStopGone never propagates out of decide() (fail-open cleanup seam)', async () => {
    const resting = algoOrder('97');
    const events: VenueStopEvent[] = [];
    const cancelled: string[] = [];
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.resolve([resting]),
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      onAlgoStopGone: () => Promise.reject(new Error('recovery sweep exploded')),
      planStopRegistry: planStopRegistry(),
    });
    const out = await strategy.decide(buildInput(0, { symbol: PERP_SYM, venue: PERP_V }));
    expect(out).toEqual([]); // resolved, not rejected
    expect(cancelled).toEqual([resting.algoId]);
    // The cancel still counts as a cancel — the fold failure leaves the order non-terminal for the
    // next recovery sweep to retry, it never rewrites this bar's outcome.
    expect(events).toEqual(['orphan_scan', 'orphan_cancel']);
  });

  // #147 (2026-08-04) inverts what this slot used to pin. The old contract — "a registry entry for
  // this key ⇒ never read the venue again" — is the defect itself: once ANY entry existed the sweep
  // short-circuited for the life of the plan, so a SECOND orphan on the same symbol was structurally
  // unreachable. Four reduce-only STOP_MARKETs sat ACKED with no order_event for four days across
  // ~37 boots behind exactly that guard. The registry entry is now evidence used to decide WHICH
  // candidate is current, never a reason to skip the read.
  it('#147: reads the venue even with a registry entry present, and cancels only the candidate the confirmed algoId contradicts', async () => {
    const confirmed = algoOrder('97'); // the stop this position is actually relying on
    const stale = algoOrder('93', '0.001', 'cbp0perp00000000000700080000000000s2');
    let fetchCalls = 0;
    const events: VenueStopEvent[] = [];
    const cancelled: string[] = [];
    const goneCalls: Array<ReturnType<typeof symbolId>> = [];
    const registry = planStopRegistry(
      new Map([
        [
          PERP_REG_KEY,
          { side: 'LONG', stopPrice: '97', venueStopResting: true, algoId: confirmed.algoId },
        ],
      ]),
    );
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(
        new Map([
          [confirmed.clientAlgoId!, 'vsl'],
          [stale.clientAlgoId!, 'vsl'],
        ]),
      ),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve([confirmed, stale]);
        },
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      onAlgoStopGone: (symbol) => {
        goneCalls.push(symbol);
        return Promise.resolve('canceled');
      },
      planStopRegistry: registry,
    });
    await strategy.decide(
      buildInput(0, {
        position: longPosition('100', PERP_SYM, PERP_V),
        symbol: PERP_SYM,
        venue: PERP_V,
      }),
    );
    expect(fetchCalls).toBe(1); // the entry no longer short-circuits the read
    expect(events).toEqual(['orphan_scan', 'orphan_cancel']);
    // FAILS CLOSED: the only cancellable candidate is one the registry's CONFIRMED algoId positively
    // contradicts — the confirmed stop itself is never touched while the position is open.
    expect(cancelled).toEqual([stale.algoId]);
    expect(goneCalls).toEqual([PERP_SYM]); // symbol-scoped fold, one call for the whole sweep
    expect(registry.get(PERP_REG_KEY)?.algoId).toBe(confirmed.algoId);
  });

  // The other half of the old name's concern ("avoids re-scanning every flat bar") — answered by
  // reuse rather than by skipping: the sweep hands its list to manageVenueStopPerp, so widening it
  // to every managed bar costs ONE venue round trip per bar, not two. Each fetchOpenAlgoOrders
  // carries ccxt's 10s default timeout under decide()'s own AGENTIC_TIMEOUT_MS + 2s wall-clock
  // backstop, so a second read on the same symbol in the same bar is what would actually hurt.
  it('#147 cost: two consumers, ONE venue read per managed bar — manageVenueStopPerp reuses the sweep’s list', async () => {
    const resting = algoOrder('98'); // at the plan's own derived stop — confirms, never churns
    let fetchCalls = 0;
    const events: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(SID, perpParams(), new PlanningClient(), {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
      },
      planStopRegistry: planStopRegistry(),
    });
    await strategy.decide(buildInput(0, { symbol: PERP_SYM, venue: PERP_V })); // FLAT, sweep only
    expect(fetchCalls).toBe(1);
    expect(events).toEqual(['orphan_scan']);
    events.length = 0;

    // A managed bar: the sweep runs AND manageVenueStopPerp reconciles the same symbol — both labels
    // prove both ran, off a single read.
    await strategy.decide(
      buildInput(1, {
        position: longPosition('100', PERP_SYM, PERP_V),
        symbol: PERP_SYM,
        venue: PERP_V,
      }),
    );
    expect(events).toEqual(['orphan_scan', 'skipped_existing']);
    expect(fetchCalls).toBe(2); // 1 (bar 0) + 1 — not 3
  });

  // The four REFUSAL branches. The prior attempt at this sweep shipped a stop-killing bug, and until
  // these existed the whole refusal side was unpinned: flipping the confirmed-algoId test or dropping
  // the lone-candidate guard cancelled every genuine stop on every positioned perp symbol with the
  // suite still green. Each spec below names the mutation it exists to fail on.
  it('refusal: a LONE candidate is never cancelled while positioned, and a registry entry never re-adopts over the plan stop', async () => {
    // Mutations this fails on: dropping the `=== 'vsl'` role filter (the foreign 'vtp' algo order
    // becomes a second candidate and the confirmed-algoId branch cancels it), and relaxing the
    // re-adopt's `registryEntry === undefined` precondition (the venue's 97 trigger would overwrite
    // the plan's own 99 stop price, splitting the watcher's crossing check from the executor's).
    const confirmed = algoOrder('97');
    const foreignTp = algoOrder('105', '0.001', 'cbp0perp00000000000700080000000000t1');
    const cancelled: string[] = [];
    const events: VenueStopEvent[] = [];
    const registry = planStopRegistry(
      new Map([
        [
          PERP_REG_KEY,
          { side: 'LONG', stopPrice: '99', venueStopResting: true, algoId: confirmed.algoId },
        ],
      ]),
    );
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(
        new Map([
          [confirmed.clientAlgoId!, 'vsl'],
          [foreignTp.clientAlgoId!, 'vtp'],
        ]),
      ),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.resolve([confirmed, foreignTp]),
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      planStopRegistry: registry,
    });
    await strategy.decide(
      buildInput(0, {
        position: longPosition('100', PERP_SYM, PERP_V),
        symbol: PERP_SYM,
        venue: PERP_V,
      }),
    );
    expect(cancelled).toEqual([]);
    expect(events).toEqual(['orphan_scan']);
    expect(registry.get(PERP_REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '99',
      venueStopResting: true,
      algoId: confirmed.algoId,
    });
  });

  it('refusal: two candidates with NO confirmed algoId in the registry — nothing is cancelled, the refusal is logged', async () => {
    // Mutation this fails on: deleting the `expectedAlgoId === undefined || !vslOrders.some(...)`
    // refusal, which drops straight into the cancel loop where nothing equals `undefined` — BOTH
    // stops go, including the one the open position is relying on.
    const first = algoOrder('97');
    const second = algoOrder('93', '0.001', 'cbp0perp00000000000700080000000000s2');
    const cancelled: string[] = [];
    const events: VenueStopEvent[] = [];
    const warnings: string[] = [];
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      logger: { warn: (m) => warnings.push(m) },
      intentStore: roledIntentStore(
        new Map([
          [first.clientAlgoId!, 'vsl'],
          [second.clientAlgoId!, 'vsl'],
        ]),
      ),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.resolve([first, second]),
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      // venueStopResting/algoId absent: no placement of this plan's stop was ever observed resting,
      // so the registry holds no fact that could say WHICH of the two is current.
      planStopRegistry: planStopRegistry(
        new Map([[PERP_REG_KEY, { side: 'LONG', stopPrice: '97', venueStopResting: false }]]),
      ),
    });
    await strategy.decide(
      buildInput(0, {
        position: longPosition('100', PERP_SYM, PERP_V),
        symbol: PERP_SYM,
        venue: PERP_V,
      }),
    );
    expect(cancelled).toEqual([]);
    expect(events).toEqual(['orphan_scan']);
    expect(warnings.some((m) => m.includes('none matching a confirmed algoId'))).toBe(true);
  });

  it('refusal: two candidates and a confirmed algoId naming neither — leaves all resting', async () => {
    // Mutation this fails on: inverting `!vslOrders.some((o) => o.algoId === expectedAlgoId)` to
    // `vslOrders.some(...)`. With the confirmed stop absent from the venue's answer the inverted
    // test falls through to the cancel loop, where nothing matches the skip condition and every
    // candidate — the position's only remaining protection — is cancelled.
    const first = algoOrder('97');
    const second = algoOrder('93', '0.001', 'cbp0perp00000000000700080000000000s3');
    const cancelled: string[] = [];
    const events: VenueStopEvent[] = [];
    const warnings: string[] = [];
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      logger: { warn: (m) => warnings.push(m) },
      intentStore: roledIntentStore(
        new Map([
          [first.clientAlgoId!, 'vsl'],
          [second.clientAlgoId!, 'vsl'],
        ]),
      ),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.resolve([first, second]),
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      planStopRegistry: planStopRegistry(
        new Map([
          [
            PERP_REG_KEY,
            {
              side: 'LONG',
              stopPrice: '97',
              venueStopResting: true,
              // A third order, absent from the venue's answer this bar (cancelled/filled elsewhere,
              // or a read that came back partial) — evidence about NEITHER candidate.
              algoId: 'venue-algo-not-in-this-answer',
            },
          ],
        ]),
      ),
    });
    await strategy.decide(
      buildInput(0, {
        position: longPosition('100', PERP_SYM, PERP_V),
        symbol: PERP_SYM,
        venue: PERP_V,
      }),
    );
    expect(cancelled).toEqual([]);
    expect(events).toEqual(['orphan_scan']);
    expect(warnings.some((m) => m.includes('leaving all resting'))).toBe(true);
  });

  it('refusal: a DUST position (reported FLAT to the agent) keeps its resting stop — reduce-only perp stops are minNotional-exempt', async () => {
    // Mutation this fails on: gating the FLAT branch on context.position.side instead of the raw
    // position row. buildContext reclassifies a sub-minNotional holding as FLAT so the model stops
    // proposing un-executable exits, but evaluate.ts's minNotionalExempt lets a reduce-only PERP
    // stop through at any size — so the dust IS protectable and cancelling its stop strands it (no
    // path re-places one: manageVenueStop needs a LONG/SHORT side).
    const resting = algoOrder('97');
    const cancelled: string[] = [];
    const events: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.resolve([resting]),
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      planStopRegistry: planStopRegistry(),
    });
    // 0.001 @ 100 = $0.10 against a $50 minimum ⇒ dust.
    strategy.onInit({
      params: {},
      warmupCandles: new Map(),
      symbolConstraints: new Map([
        [PERP_SYM, { tickSize: price('0.01'), lotStep: qty('0.0001'), minNotional: price('50') }],
      ]),
    });
    await strategy.decide(
      buildInput(0, {
        position: longPosition('100', PERP_SYM, PERP_V),
        symbol: PERP_SYM,
        venue: PERP_V,
      }),
    );
    expect(cancelled).toEqual([]);
    expect(events).toEqual(['orphan_scan']);
  });

  it("refusal: the sweep's read throws on a managed bar — manageVenueStopPerp no-ops off 'read-failed' rather than retrying the read", async () => {
    // Mutation this fails on: dropping the 'read-failed' early return in manageVenueStopPerp, which
    // spends a SECOND 10s-timeout read inside the same bar and — when that one answers empty — can
    // place a duplicate stop beside one the failed read simply could not see.
    let fetchCalls = 0;
    const events: VenueStopEvent[] = [];
    const strategy = new AgenticStrategy(SID, perpParams(), new PlanningClient(), {
      onVenueStop: (e) => events.push(e),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.reject(new Error('adapter shape throw'));
        },
      },
      planStopRegistry: planStopRegistry(),
    });
    await strategy.decide(buildInput(0, { symbol: PERP_SYM, venue: PERP_V })); // FLAT, sweep only
    expect(fetchCalls).toBe(1);
    events.length = 0;

    const out = await strategy.decide(
      buildInput(1, {
        position: longPosition('100', PERP_SYM, PERP_V),
        symbol: PERP_SYM,
        venue: PERP_V,
      }),
    );
    expect(out).toEqual([]);
    expect(fetchCalls).toBe(2); // one read for the bar, not one per consumer
    expect(events).toEqual(['reconcile_error']); // no 'placed' — the decision is skipped, not guessed
  });
});
