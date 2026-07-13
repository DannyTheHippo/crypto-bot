import { describe, it, expect } from 'vitest';
import {
  evaluatePlan,
  type PlanExecutorInput,
  type PlanExecutorState,
} from '../../../src/features/trading/agentic/plan-executor';
import type { AgentPlan } from '../../../src/ports/agentic-strategy';

const PLAN: AgentPlan = {
  entryOffsetBps: 10,
  stopLossPct: '0.02',
  takeProfitPct: '0.04',
  entryValidityBars: 4,
  maxHoldBars: 20,
};

function state(over: Partial<PlanExecutorState> = {}): PlanExecutorState {
  return {
    plan: PLAN,
    entryPrice: null,
    planStartedBar: 0,
    barsElapsed: 0,
    ...over,
  };
}

function input(over: Partial<PlanExecutorInput> = {}): PlanExecutorInput {
  return {
    state: state(),
    closePrice: '100',
    positionSide: 'FLAT',
    hasRestingEntry: false,
    ...over,
  };
}

describe('evaluatePlan — LONG position (entry filled)', () => {
  it('holds when close is strictly between the stop and take-profit prices, under maxHoldBars', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 5 }),
        closePrice: '101',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'hold' });
  });

  it('exits on stop when close is strictly below entry × (1 − stopLossPct)', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        closePrice: '97.99',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'stop' });
  });

  it('exits on stop at the exact boundary (close === entry × (1 − stopLossPct)) — boundary equality triggers', () => {
    // entry 100, stopLossPct 0.02 ⇒ stop price exactly 98.
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        closePrice: '98',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'stop' });
  });

  it('exits on take_profit when close is strictly above entry × (1 + takeProfitPct)', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        closePrice: '104.01',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'take_profit' });
  });

  it('exits on take_profit at the exact boundary (close === entry × (1 + takeProfitPct)) — boundary equality triggers', () => {
    // entry 100, takeProfitPct 0.04 ⇒ take-profit price exactly 104.
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        closePrice: '104',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'take_profit' });
  });

  it('exits on max_hold at the exact boundary (barsElapsed === maxHoldBars), stop/take-profit not hit', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 20 }),
        closePrice: '101',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'max_hold' });
  });

  it('holds one bar short of the max_hold boundary', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 19 }),
        closePrice: '101',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'hold' });
  });

  it('prioritizes stop over max_hold when both would trigger on the same bar', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 20 }),
        closePrice: '97',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'stop' });
  });

  it('prioritizes take_profit over max_hold when both would trigger on the same bar', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 20 }),
        closePrice: '105',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'take_profit' });
  });

  it('holds rather than fabricating an exit when entryPrice is null on a LONG position (invariant guard)', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: null, barsElapsed: 999 }),
        closePrice: '1',
        positionSide: 'LONG',
      }),
    );
    expect(result).toEqual({ type: 'hold' });
  });

  it('computes the stop/take-profit boundary with exact Decimal precision off a non-round entry price', () => {
    // entry 63965.66, stopLossPct 0.02 ⇒ stop price exactly 62686.3468 (63965.66 × 0.98).
    const plan: AgentPlan = { ...PLAN, stopLossPct: '0.02', takeProfitPct: '0.05' };
    const belowStop = evaluatePlan(
      input({
        state: state({ plan, entryPrice: '63965.66', barsElapsed: 1 }),
        closePrice: '62686.3467',
        positionSide: 'LONG',
      }),
    );
    expect(belowStop).toEqual({ type: 'exit', reason: 'stop' });

    const atStopExact = evaluatePlan(
      input({
        state: state({ plan, entryPrice: '63965.66', barsElapsed: 1 }),
        closePrice: '62686.3468',
        positionSide: 'LONG',
      }),
    );
    expect(atStopExact).toEqual({ type: 'exit', reason: 'stop' });

    const aboveStop = evaluatePlan(
      input({
        state: state({ plan, entryPrice: '63965.66', barsElapsed: 1 }),
        closePrice: '62686.3469',
        positionSide: 'LONG',
      }),
    );
    expect(aboveStop).toEqual({ type: 'hold' });
  });
});

// Push II Phase 8: SHORT arm, mirrored off the LONG suite above — stop ABOVE entry, take-profit
// BELOW entry, maxHoldBars unchanged (direction-agnostic).
describe('evaluatePlan — SHORT position (entry filled)', () => {
  it('holds when close is strictly between the take-profit and stop prices, under maxHoldBars', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 5 }),
        closePrice: '99',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'hold' });
  });

  it('exits on stop when close is strictly above entry × (1 + stopLossPct)', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        closePrice: '102.01',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'stop' });
  });

  it('exits on stop at the exact boundary (close === entry × (1 + stopLossPct)) — boundary equality triggers', () => {
    // entry 100, stopLossPct 0.02 ⇒ stop price exactly 102.
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        closePrice: '102',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'stop' });
  });

  it('exits on take_profit when close is strictly below entry × (1 − takeProfitPct)', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        closePrice: '95.99',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'take_profit' });
  });

  it('exits on take_profit at the exact boundary (close === entry × (1 − takeProfitPct)) — boundary equality triggers', () => {
    // entry 100, takeProfitPct 0.04 ⇒ take-profit price exactly 96.
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        closePrice: '96',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'take_profit' });
  });

  it('exits on max_hold at the exact boundary (barsElapsed === maxHoldBars), stop/take-profit not hit', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 20 }),
        closePrice: '99',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'max_hold' });
  });

  it('prioritizes stop over max_hold when both would trigger on the same bar', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 20 }),
        closePrice: '103',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'stop' });
  });

  it('prioritizes take_profit over max_hold when both would trigger on the same bar', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 20 }),
        closePrice: '95',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'exit', reason: 'take_profit' });
  });

  it('holds rather than fabricating an exit when entryPrice is null on a SHORT position (invariant guard)', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: null, barsElapsed: 999 }),
        closePrice: '1',
        positionSide: 'SHORT',
      }),
    );
    expect(result).toEqual({ type: 'hold' });
  });

  it('computes the stop/take-profit boundary with exact Decimal precision off a non-round entry price', () => {
    // entry 63965.66, stopLossPct 0.02 ⇒ stop price exactly 65245 (approx: 63965.66 × 1.02 = 65244.9732).
    const plan: AgentPlan = { ...PLAN, stopLossPct: '0.02', takeProfitPct: '0.05' };
    const belowStop = evaluatePlan(
      input({
        state: state({ plan, entryPrice: '63965.66', barsElapsed: 1 }),
        closePrice: '65244.9731',
        positionSide: 'SHORT',
      }),
    );
    expect(belowStop).toEqual({ type: 'hold' });

    const atStopExact = evaluatePlan(
      input({
        state: state({ plan, entryPrice: '63965.66', barsElapsed: 1 }),
        closePrice: '65244.9732',
        positionSide: 'SHORT',
      }),
    );
    expect(atStopExact).toEqual({ type: 'exit', reason: 'stop' });

    const aboveStop = evaluatePlan(
      input({
        state: state({ plan, entryPrice: '63965.66', barsElapsed: 1 }),
        closePrice: '65244.9733',
        positionSide: 'SHORT',
      }),
    );
    expect(aboveStop).toEqual({ type: 'exit', reason: 'stop' });
  });
});

describe('evaluatePlan — FLAT position (resting or unfilled entry)', () => {
  it('holds while a resting entry is younger than entryValidityBars', () => {
    const result = evaluatePlan(
      input({
        state: state({ barsElapsed: 3 }),
        positionSide: 'FLAT',
        hasRestingEntry: true,
      }),
    );
    expect(result).toEqual({ type: 'hold' });
  });

  it('cancels the resting entry at the exact entryValidityBars boundary', () => {
    const result = evaluatePlan(
      input({
        state: state({ barsElapsed: 4 }),
        positionSide: 'FLAT',
        hasRestingEntry: true,
      }),
    );
    expect(result).toEqual({ type: 'cancel_entry' });
  });

  it('cancels the resting entry past the entryValidityBars boundary', () => {
    const result = evaluatePlan(
      input({
        state: state({ barsElapsed: 9 }),
        positionSide: 'FLAT',
        hasRestingEntry: true,
      }),
    );
    expect(result).toEqual({ type: 'cancel_entry' });
  });

  it('holds while no resting entry exists yet and entryValidityBars has not elapsed (in-flight submission)', () => {
    const result = evaluatePlan(
      input({
        state: state({ barsElapsed: 3 }),
        positionSide: 'FLAT',
        hasRestingEntry: false,
      }),
    );
    expect(result).toEqual({ type: 'hold' });
  });

  it('expires the plan at the exact entryValidityBars boundary when no resting entry exists (never filled, never seen resting)', () => {
    const result = evaluatePlan(
      input({
        state: state({ barsElapsed: 4 }),
        positionSide: 'FLAT',
        hasRestingEntry: false,
      }),
    );
    expect(result).toEqual({ type: 'plan_expired' });
  });

  it('expires the plan past the entryValidityBars boundary with no resting entry', () => {
    const result = evaluatePlan(
      input({
        state: state({ barsElapsed: 100 }),
        positionSide: 'FLAT',
        hasRestingEntry: false,
      }),
    );
    expect(result).toEqual({ type: 'plan_expired' });
  });
});

// AGENTIC_VENUE_TP: FLAT + a previously-captured entryPrice means the entry HAD filled and the
// position is now gone (the resting venue TP filled between bars, or an external flatten) — distinct
// from the never-filled-entry FLAT branches above (entryPrice still null there), which must stay
// reachable exactly as before whenever entryPrice is null.
describe('evaluatePlan — FLAT position with a previously-captured entryPrice (position_closed)', () => {
  it('reports position_closed once the entry has filled and the position is now flat', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 5 }),
        positionSide: 'FLAT',
        hasRestingEntry: false,
      }),
    );
    expect(result).toEqual({ type: 'position_closed' });
  });

  it('reports position_closed regardless of hasRestingEntry once entryPrice is captured', () => {
    // A resting entry is orthogonal here — entryPrice non-null means the ORIGINAL entry already
    // filled; a coincidentally-resting order (e.g. a fresh unrelated signal) must not mask the
    // closed-position verdict.
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 1 }),
        positionSide: 'FLAT',
        hasRestingEntry: true,
      }),
    );
    expect(result).toEqual({ type: 'position_closed' });
  });

  it('reports position_closed regardless of barsElapsed vs entryValidityBars once entryPrice is captured', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: '100', barsElapsed: 0 }),
        positionSide: 'FLAT',
        hasRestingEntry: false,
      }),
    );
    expect(result).toEqual({ type: 'position_closed' });
  });

  it('never-filled-entry FLAT paths (entryPrice null) stay unchanged: still holds within validity', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: null, barsElapsed: 3 }),
        positionSide: 'FLAT',
        hasRestingEntry: true,
      }),
    );
    expect(result).toEqual({ type: 'hold' });
  });

  it('never-filled-entry FLAT paths (entryPrice null) stay unchanged: still cancel_entry at the boundary', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: null, barsElapsed: 4 }),
        positionSide: 'FLAT',
        hasRestingEntry: true,
      }),
    );
    expect(result).toEqual({ type: 'cancel_entry' });
  });

  it('never-filled-entry FLAT paths (entryPrice null) stay unchanged: still plan_expired past the boundary with no resting entry', () => {
    const result = evaluatePlan(
      input({
        state: state({ entryPrice: null, barsElapsed: 100 }),
        positionSide: 'FLAT',
        hasRestingEntry: false,
      }),
    );
    expect(result).toEqual({ type: 'plan_expired' });
  });
});
