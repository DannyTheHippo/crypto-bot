import { describe, it, expect } from 'vitest';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
  type VenueStopEvent,
  type VenueTpEvent,
} from '../../../src/features/trading/agentic/agentic.strategy';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentDirectives,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../src/ports/agentic-strategy';
import type { Signal } from '../../../src/domain/types/signal';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type { ExecReport } from '../../../src/domain/types/exec-report';
import type { OpenOrderSummary, Position } from '../../../src/domain/types/portfolio';
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
import { positionKey } from '../../../src/domain/risk/evaluate';
import type { PlanStop, PlanStopRegistryPort } from '../../../src/ports/risk';
import type { ExecutionStorePort } from '../../../src/ports/execution';
import type { AlgoOrderState } from '../../../src/ports/exchange';
import type { OrderIntent } from '../../../src/domain/types/order-intent';

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
    candle(i, symbol, venue, i === index ? opts.close ?? '100' : '100'),
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

  it('places a RESTING_STOP EXIT_LONG at entry × (1 − stopLossPct) on the fill-observation bar', async () => {
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, makeParams(), client);
    await strategy.decide(buildInput(0));

    const out = await strategy.decide(buildInput(1, { position: longPosition('100') }));
    expect(client.calls).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('EXIT_LONG');
    expect(out[0]!.exitStyle).toBe('RESTING_STOP');
    expect(out[0]!.triggerPriceHint!.toFixed()).toBe('98'); // 100 × (1 − 0.02) exactly
    expect(out[0]!.dedupeKey).toContain('venue_stop_place');
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
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // placed
    expect(registry.get(REG_KEY)?.venueStopResting).toBe(false); // not yet confirmed
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
    await strategy.decide(buildInput(1, { position: longPositionSubStep() })); // places STOP at 97.51
    events.length = 0;

    // Bar 2: the STOP_LOSS_LIMIT rests at the buffered leg 97.51, qty 0.00123 = roundToStep(0.0012345,
    // 0.00001, 'down'). The 0.0000045 residue is un-protectable dust (below one step), not a mismatch.
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
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // placed
    await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    ); // confirmed resting
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
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // placed
    await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    ); // confirmed resting
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
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // places both vtp+vsl
    tpEvents.length = 0;
    stopEvents.length = 0;

    // Bar 2: FLAT (the stop filled externally) — the TP, still resting, is the orphan to clean up.
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

  it('restart re-arm: the first managed bar after a bare-LONG re-arm places the resting stop off avgEntry, same site as a fresh fill', async () => {
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
    expect(second).toHaveLength(1);
    expect(second[0]!.exitStyle).toBe('RESTING_STOP');
    expect(second[0]!.triggerPriceHint!.toFixed()).toBe('98');
    expect(events).toEqual(['placed']);
    expect(registry.get(REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: false, // placed, not yet confirmed resting (no ack observed this bar)
    });
  });

  // Push 3 P7f fix 6 regression: a transient intent-store throw while classifying the resting SELL
  // must skip placement this bar (fail toward no-op), never read as "nothing resting" and place a
  // DUPLICATE stop next to the one already resting.
  it('fix 6: an intent-store throw during SPOT reconcile skips placement this bar (no duplicate stop)', async () => {
    const client = new PlanningClient();
    const throwingStore: Pick<ExecutionStorePort, 'loadIntentByClientOrderId'> = {
      loadIntentByClientOrderId: () => Promise.reject(new Error('db down')),
    };
    const strategy = new AgenticStrategy(SID, makeParams(), client, {
      intentStore: throwingStore,
    });
    await strategy.decide(buildInput(0));
    await strategy.decide(buildInput(1, { position: longPosition('100') })); // placed
    const out = await strategy.decide(
      buildInput(2, { position: longPosition('100'), openOrders: [restingSell('97.51')] }),
    );
    expect(out).toEqual([]); // skipped, NOT a second 'placed' RESTING_STOP signal
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
      // Bar 1 (placement) sees nothing resting yet; bar 2+ (reconcile) observes the ack — mirrors
      // the spot suite's own per-bar openOrders shape (buildInput's opts.openOrders), just modeled
      // as a call-counter since fetchOpenAlgoOrders takes no per-bar argument to vary by.
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve(fetchCalls === 1 ? [] : [resting]);
        },
      },
      planStopRegistry: registry,
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
    events.length = 0;

    const out = await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // confirmed
    expect(out).toEqual([]);
    expect(events).toEqual(['skipped_existing']);
    expect(registry.get(PERP_REG_KEY)).toEqual({
      side: 'LONG',
      stopPrice: '98',
      venueStopResting: true,
      algoId: resting.algoId,
    });
  });

  it('drift_cancel calls cancelAlgoOrder directly (no CANCEL_OPEN signal — the algo rail is never in openOrders)', async () => {
    const events: VenueStopEvent[] = [];
    const resting = algoOrder('90'); // far from the expected trigger 98 — genuine drift
    const cancelled: Array<{ algoId: string; symbol: string }> = [];
    let fetchCalls = 0;
    const client = new PlanningClient();
    const strategy = new AgenticStrategy(SID, perpParams(), client, {
      onVenueStop: (e) => events.push(e),
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          // Push 3 P7f fix 7b: bar 0 (no active plan yet) now also runs the orphaned-algo-stop
          // boot check, consuming call #1 (harmlessly — nothing resting, FLAT). manageVenueStopPerp's
          // own placement scan is therefore call #2 ("placed" bar), reconcile is call #3 ("drift" bar).
          return Promise.resolve(fetchCalls <= 2 ? [] : [resting]);
        },
        cancelAlgoOrder: (algoId, symbol) => {
          cancelled.push({ algoId, symbol: String(symbol) });
          return Promise.resolve();
        },
      },
      planStopRegistry: planStopRegistry(),
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
    events.length = 0;

    const out = await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // drift
    expect(out).toEqual([]); // no Signal — the cancel happened via the direct adapter call
    expect(events).toEqual(['drift_cancel']);
    expect(cancelled).toEqual([{ algoId: resting.algoId, symbol: String(PERP_SYM) }]);
  });

  it('qty_cancel calls cancelAlgoOrder directly', async () => {
    const events: VenueStopEvent[] = [];
    const resting = algoOrder('98', '0.0005'); // qty mismatch vs the 0.001 position
    const cancelled: string[] = [];
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
    });
    await strategy.decide(perpInput(0));
    await strategy.decide(perpInput(1, { position: perpLongPosition('100') })); // placed
    events.length = 0;

    const out = await strategy.decide(perpInput(2, { position: perpLongPosition('100') })); // qty mismatch
    expect(out).toEqual([]);
    expect(events).toEqual(['qty_cancel']);
    expect(cancelled).toEqual([resting.algoId]);
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
    // (a genuine ≥1-step uncovered slice) ⇒ qty_cancel via the direct cancelAlgoOrder call.
    const out = await strategy.decide(perpInput(2, { position: perpSubStep() }));
    expect(out).toEqual([]);
    expect(events).toEqual(['qty_cancel']);
    expect(cancelled).toEqual([resting.algoId]);
  });

  it('cancel-first on a max_hold exit cancels the resting algo stop by its registry algoId before the IOC exit', async () => {
    const resting = algoOrder('98');
    const cancelled: string[] = [];
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
    expect(stopEvents).toEqual(['reconcile_error']); // no 'placed' — placement decision skipped
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
            // Push 3 P7f fix 7b: bar 0 (no active plan yet) runs the orphaned-algo-stop boot check
            // first, consuming call #1 (harmlessly — nothing resting, FLAT). manageVenueStopPerp's
            // own placement scan is therefore call #2 (bar1: placed), call #3 confirms (bar2), and
            // call #4+ (bar3) is the vanish this describe block exists to exercise.
            if (fetchCalls <= 2) return Promise.resolve([]); // bar0 boot check + bar1: placed
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
      expect(events).toEqual(['triggered']);
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
      expect(events).toEqual(['placed']);
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
      expect(events).toEqual([]); // no 'placed' — this bar's placement decision was skipped
    });

    it('dep ABSENT: behavior is byte-identical to today (proceeds straight to re-placement)', async () => {
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
      expect(events).toEqual(['placed']); // same as the pre-feature "reconciles" test's own placed bar
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
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
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
  });

  it('branch (b) cancels the orphan when the position is FLAT (nothing left to protect)', async () => {
    const resting = algoOrder('97');
    const cancelled: string[] = [];
    const registry = planStopRegistry();
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => Promise.resolve([resting]),
        cancelAlgoOrder: (algoId) => {
          cancelled.push(algoId);
          return Promise.resolve();
        },
      },
      planStopRegistry: registry,
    });
    await strategy.decide(buildInput(0, { symbol: PERP_SYM, venue: PERP_V })); // no position ⇒ FLAT
    expect(cancelled).toEqual([resting.algoId]);
    expect(registry.get(PERP_REG_KEY)).toBeUndefined(); // never adopted — nothing to protect
  });

  it('no-ops once the registry already holds an entry for this key (avoids re-scanning every flat bar)', async () => {
    const resting = algoOrder('97');
    let fetchCalls = 0;
    const registry = planStopRegistry(
      new Map([
        [PERP_REG_KEY, { side: 'LONG', stopPrice: '97', venueStopResting: true, algoId: 'cached' }],
      ]),
    );
    const strategy = new AgenticStrategy(SID, perpParams(), new NoPlanClient(), {
      intentStore: roledIntentStore(new Map([[resting.clientAlgoId!, 'vsl']])),
      algoOrders: {
        fetchOpenAlgoOrders: () => {
          fetchCalls += 1;
          return Promise.resolve([resting]);
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
    expect(fetchCalls).toBe(0); // already-adopted guard short-circuits before the venue call
  });
});
