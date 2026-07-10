// Live-agentic BarStrategy — SKELETON (test/backtest/, off the production gate).
//
// The real Anthropic client is async and out-of-process (an HTTP call per decision), which does not
// fit BarStrategy's synchronous decide() contract. Real client wiring is deferred to C-validate (an
// async pre-fetch pass over the bar series, or a batched harness variant) — this pass wires the
// PLAN LIFECYCLE against the REAL production plan-executor (src/features/trading/agentic/
// plan-executor.ts's evaluatePlan, read-only import) around a synchronous stand-in `decideFn`, so the
// budget + fail-closed-to-fallback machinery is built and tested now, ready for the real callback to
// be dropped in later without touching this class.
//
// hasRestingEntry is hardcoded false: the backtest harness fills unconditionally at the next bar's
// open (no resting-order book model), so plan-executor's "unfilled resting entry" branch never
// applies here — a FLAT position with an active plan and no fill by entryValidityBars is always
// plan_expired, never cancel_entry. This is a known simplification of the skeleton, not a production
// plan-executor change (that module is imported read-only and unmodified).
import {
  evaluatePlan,
  type PlanExecutorState,
} from '../../../src/features/trading/agentic/plan-executor';
import type { AgentPlan } from '../../../src/ports/agentic-strategy';
import type { BarStrategy, BarContext, BacktestAction } from '../strategy';

export type LiveDecideFn = (ctx: BarContext) => {
  readonly action: 'long' | 'flat' | 'hold';
  readonly plan?: AgentPlan;
};

export interface LiveAgenticBudget {
  readonly maxDecisions: number;
  // Decimal string spend cap — ACCEPTED BUT NOT YET ENFORCED: no real client means no per-call cost
  // to sum against it. Enforced once C-validate wires actual token/dollar reporting from the client.
  readonly maxUsd: string;
}

export class LiveAgenticStrategy implements BarStrategy {
  private decisionsUsed = 0;
  private plan: PlanExecutorState | null = null;

  constructor(
    private readonly decideFn: LiveDecideFn,
    private readonly budget: LiveAgenticBudget,
    private readonly fallback: BarStrategy,
  ) {}

  decide(ctx: BarContext): BacktestAction {
    const positionSide: 'LONG' | 'FLAT' = ctx.position.signedQty.gt(0) ? 'LONG' : 'FLAT';

    if (this.plan !== null) {
      const entryPrice = positionSide === 'LONG' ? ctx.position.avgEntry.toFixed() : null;
      const result = evaluatePlan({
        state: { ...this.plan, entryPrice },
        closePrice: ctx.markPrice,
        positionSide,
        hasRestingEntry: false, // see file header
      });
      if (result.type === 'exit') {
        this.plan = null;
        return { type: 'exit', reason: result.reason };
      }
      if (result.type === 'plan_expired' || result.type === 'cancel_entry') {
        this.plan = null;
        return { type: 'hold' };
      }
      this.plan = { ...this.plan, entryPrice, barsElapsed: this.plan.barsElapsed + 1 };
      return { type: 'hold' };
    }

    // No active plan: propose a new one, budget permitting. Exhausted budget fails closed to the
    // fallback strategy — never silently keeps calling decideFn past the cap.
    if (this.decisionsUsed >= this.budget.maxDecisions) return this.fallback.decide(ctx);
    this.decisionsUsed++;
    const decision = this.decideFn(ctx);
    if (decision.action === 'long' && decision.plan) {
      this.plan = {
        plan: decision.plan,
        entryPrice: null,
        planStartedBar: ctx.barIndex,
        barsElapsed: 0,
      };
      return { type: 'enter', side: 'LONG' };
    }
    return { type: 'hold' };
  }
}
