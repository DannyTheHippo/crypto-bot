// ── Plan executor (W3.1; S2/B1 retype to AgentDirectives) ───────────────────
//
// Pure, dependency-free (no nest/ccxt/Date.now/process.env): enforces the model's CURRENT directive
// set deterministically between LLM consults, so the strategy stops asking the model every bar once
// it holds an active plan. All price comparisons are Decimal-on-strings — directive prices/pcts are
// money paths (CLAUDE.md rule 1), never plain-number math.
//
// `barsElapsed` is a SINGLE clock counted from plan creation (planStartedBar), used for BOTH the
// resting-entry validity window and the filled-position max-hold window — the spec brief states both
// thresholds against the same counter, not two independently-reset clocks. The strategy owns
// incrementing it every decide() cycle a plan stays active; this module only ever reads it.
//
// B1: `state.plan` is MUTABLE across evaluations — an `adjust` directive (Design § New tool contract)
// replaces it in place with the model's revised stop/TP/maxHold, and every stop/TP/max_hold check
// below always reads the CURRENT directive set, never the one in force when the position was opened.
// The single barsElapsed clock is never reset by an `adjust` (it enforces elapsed real time, not the
// model's latest intent); it restarts only on a new entry/scale-in, which is the strategy's decision
// (agentic.strategy.ts), not this module's.

import Decimal from 'decimal.js';
import type { AgentDirectives } from '../../../ports/strategy/agentic-strategy';

export interface PlanExecutorState {
  readonly plan: AgentDirectives;
  // Average fill price once the entry has filled (position flipped LONG); null while the entry is
  // still resting/unfilled — see agentic.strategy.ts's plan-lifecycle comment for who sets this.
  readonly entryPrice: string | null;
  readonly planStartedBar: number;
  // Bars elapsed since planStartedBar — the strategy's own counter, incremented once per decide()
  // cycle the plan stays active (see PlanExecutorState's header comment on the single-clock design).
  readonly barsElapsed: number;
}

export interface PlanExecutorInput {
  readonly state: PlanExecutorState;
  // Last closed candle's close, as an exact decimal string.
  readonly closePrice: string;
  // Push II Phase 8: widened to include 'SHORT' — plan-mode shorts key their exit-arm formulas off
  // this (mirrored: stop ABOVE / take-profit BELOW entry, vs. LONG's stop BELOW / take-profit
  // ABOVE). A shorts-disabled deployment's position side can never actually be 'SHORT', so the LONG
  // arm below stays byte-identical there.
  readonly positionSide: 'LONG' | 'SHORT' | 'FLAT';
  // Whether a resting (unfilled) entry for this plan is currently open — a BUY for a LONG plan, a
  // SELL for a SHORT plan (mirrored; derived by the caller from portfolio.openOrders, same
  // side-per-direction filter staleEntryCancels uses).
  readonly hasRestingEntry: boolean;
}

export type PlanExecutorAction =
  | { readonly type: 'hold' }
  | { readonly type: 'exit'; readonly reason: 'stop' | 'take_profit' | 'max_hold' }
  | { readonly type: 'cancel_entry' }
  | { readonly type: 'plan_expired' }
  // AGENTIC_VENUE_TP: the entry HAD filled (entryPrice was captured) and the position is now FLAT —
  // the resting venue take-profit filled between bars (or an external flatten). Distinct from the
  // never-filled-entry FLAT branches below (entryPrice still null there); checked first so a filled
  // entry's disappearance is never misread as a lapsed/cancelled unfilled entry.
  | { readonly type: 'position_closed' };

export function evaluatePlan(input: PlanExecutorInput): PlanExecutorAction {
  const { state, closePrice, positionSide, hasRestingEntry } = input;
  const { plan, entryPrice, barsElapsed } = state;
  const close = new Decimal(closePrice);

  if (positionSide === 'LONG') {
    // entryPrice is an invariant non-null once filled (the strategy sets it on the fill-observing
    // bar before the executor ever runs against a LONG position). A null here means that invariant
    // was violated (e.g. mid-transition); fail safe to hold rather than guess an exit off a
    // fabricated entry price.
    if (entryPrice === null) return { type: 'hold' };

    const entry = new Decimal(entryPrice);
    const stopPrice = entry.mul(new Decimal(1).minus(plan.stopLossPct));
    const takeProfitPrice = entry.mul(new Decimal(1).plus(plan.takeProfitPct));

    if (close.lte(stopPrice)) return { type: 'exit', reason: 'stop' };
    if (close.gte(takeProfitPrice)) return { type: 'exit', reason: 'take_profit' };
    if (barsElapsed >= plan.maxHoldBars) return { type: 'exit', reason: 'max_hold' };
    return { type: 'hold' };
  }

  // Push II Phase 8: SHORT arm, mirrored off the LONG arm above — stop fires ABOVE entry (close
  // crossing UP), take-profit fires BELOW entry (close crossing DOWN); maxHoldBars is unchanged
  // (direction-agnostic — a duration cap, not a price level).
  if (positionSide === 'SHORT') {
    // Same invariant as the LONG arm above: entryPrice is non-null once filled.
    if (entryPrice === null) return { type: 'hold' };

    const entry = new Decimal(entryPrice);
    const stopPrice = entry.mul(new Decimal(1).plus(plan.stopLossPct));
    const takeProfitPrice = entry.mul(new Decimal(1).minus(plan.takeProfitPct));

    if (close.gte(stopPrice)) return { type: 'exit', reason: 'stop' };
    if (close.lte(takeProfitPrice)) return { type: 'exit', reason: 'take_profit' };
    if (barsElapsed >= plan.maxHoldBars) return { type: 'exit', reason: 'max_hold' };
    return { type: 'hold' };
  }

  // FLAT with a previously-captured entry price: the position that was LONG or SHORT is gone
  // without this executor ever having emitted the exit itself — checked before the never-filled-
  // entry branches below (entryPrice null there).
  if (entryPrice !== null) return { type: 'position_closed' };

  // FLAT, entry never filled: either a resting unfilled entry, or nothing resting yet (in-flight
  // submission, or the window has lapsed with no fill and no resting order at all).
  if (hasRestingEntry) {
    if (barsElapsed >= plan.entryValidityBars) return { type: 'cancel_entry' };
    return { type: 'hold' };
  }
  if (barsElapsed >= plan.entryValidityBars) return { type: 'plan_expired' };
  return { type: 'hold' };
}
