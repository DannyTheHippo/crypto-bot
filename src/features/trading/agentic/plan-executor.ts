// ── Plan executor (W3.1) ─────────────────────────────────────────────────────
//
// Pure, dependency-free (no nest/ccxt/Date.now/process.env): manages a plan-mode trade PLAN
// deterministically between LLM consults, so the strategy stops asking the model every bar once it
// holds an active plan. All price comparisons are Decimal-on-strings — plan prices/pcts are money
// paths (CLAUDE.md rule 1), never plain-number math.
//
// `barsElapsed` is a SINGLE clock counted from plan creation (planStartedBar), used for BOTH the
// resting-entry validity window and the filled-position max-hold window — the spec brief states both
// thresholds against the same counter, not two independently-reset clocks. The strategy owns
// incrementing it every decide() cycle a plan stays active; this module only ever reads it.

import Decimal from 'decimal.js';
import type { AgentPlan } from '../../../ports/agentic-strategy';

export interface PlanExecutorState {
  readonly plan: AgentPlan;
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
  readonly positionSide: 'LONG' | 'FLAT';
  // Whether a resting (unfilled) BUY entry for this plan is currently open — derived by the caller
  // from portfolio.openOrders (same symbol+BUY filter staleEntryCancels uses).
  readonly hasRestingEntry: boolean;
}

export type PlanExecutorAction =
  | { readonly type: 'hold' }
  | { readonly type: 'exit'; readonly reason: 'stop' | 'take_profit' | 'max_hold' }
  | { readonly type: 'cancel_entry' }
  | { readonly type: 'plan_expired' };

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

  // FLAT: either a resting unfilled entry, or nothing resting yet (in-flight submission, or the
  // window has lapsed with no fill and no resting order at all).
  if (hasRestingEntry) {
    if (barsElapsed >= plan.entryValidityBars) return { type: 'cancel_entry' };
    return { type: 'hold' };
  }
  if (barsElapsed >= plan.entryValidityBars) return { type: 'plan_expired' };
  return { type: 'hold' };
}
