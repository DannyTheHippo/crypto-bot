// Live-agentic BarStrategy — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Owns the ONE evaluatePlan orchestration path for the LLM-in-the-loop backtest (agentic-replay.ts's
// header explains why the two files split this way): plan lifecycle (resting-entry wait, fill
// detection, managed-exit checks) lives HERE, real domain settlement (fills/fees/PnL) and the async
// model call/$-budget ledger live in agentic-replay.ts, which drives this class. Never duplicate
// evaluatePlan's own stop/TP/max-hold logic outside plan-executor.ts — this class only sequences calls
// into it and reacts to its verdicts.
//
// SYNC/ASYNC SEAM: decide() stays synchronous (BarStrategy's contract — see strategy.ts) and takes an
// OPTIONAL second parameter, a decision the caller already resolved out-of-band (the real Anthropic
// call is async; TypeScript happily assigns a function with an extra OPTIONAL parameter to a narrower
// interface type, since every BarStrategy-typed caller only ever supplies `ctx`). agentic-replay.ts's
// loop is the only caller that ever passes it: before calling decide() on a bar where `hasActivePlan`
// is false and the position is FLAT, it awaits the model call itself, maps the raw response through
// the fee/RR/knob floors (mirroring anthropic-agent-client.ts — see that module's plan-rejection
// path), and hands the already-floored MappedDecision in. A bar that needs no fresh decision (an
// active plan, or budget/decision-count exhaustion) calls decide(ctx) with no second argument.
//
// FILL MODEL (decided jointly with agentic-replay.ts, which prices every fill — this class only ever
// signals enter/exit, never a price):
//   - Entry: a resting order at entryOffsetBps below (positive) or above (negative) the close of the
//     bar the plan was created on. It fills the first LATER bar whose LOW crosses that price (finer
//     than a next-bar-open convention, and the natural reading of "resting limit order" — see this
//     file's own fill-detection code below). Detected HERE (this class tracks the resting price) since
//     evaluatePlan orchestration needs to know a fill happened before it can switch phases; PRICED by
//     the caller via `pendingEntryPrice`.
//   - Exit (stop / take_profit / max_hold): evaluatePlan's own verdict is a CLOSE-triggered check
//     (`close.lte(stopPrice)` etc. — plan-executor.ts). Filling AT stopPrice/takeProfitPrice would be
//     optimistic (price already traded through by the time a close confirms the breach) and would bias
//     a live-gating verifier toward overstating edge (CLAUDE.md rule 4: earned-live evidence must not
//     be inflated). agentic-replay.ts therefore fills every exit at the TRIGGERING BAR'S OWN CLOSE
//     (ctx.markPrice) — the same close evaluatePlan used to decide the exit, so no lookahead and no
//     optimistic-fill bias, symmetric with harness.ts's non-optimistic settlement discipline.
//
// hasRestingEntry is always TRUE while this class waits for a fill (never the hardcoded-false the
// original skeleton used): the backtest places the resting order deterministically the instant a plan
// is created, so there is no production-style submission lag to model. Re-arm (attaching a plan to a
// 'hold' while already LONG, the restart self-heal path — see agent-prompt.ts's managedPlan sentence)
// is OUT OF SCOPE: a backtest run has no in-process restart, so every LONG position stays continuously
// managed by the plan that opened it; MappedDecision therefore never carries a plan on 'hold'.
import Decimal from 'decimal.js';
import {
  evaluatePlan,
  type PlanExecutorState,
} from '../../../src/features/trading/agentic/plan-executor';
import type { AgentPlan } from '../../../src/ports/agentic-strategy';
import type { BarStrategy, BarContext, BacktestAction } from '../strategy';

// A decision already mapped through the live client's fee/RR/knob floors (agentic-replay.ts's
// callModel) — `plan` present iff action === 'long' AND the plan cleared every floor; a
// floor-rejected or non-'long' response arrives here as plain `{ action: 'hold', ... }`, matching
// anthropic-agent-client.ts's own "rejected ⇒ downgrade to hold, no plan" mapping.
export interface MappedDecision {
  readonly action: 'long' | 'flat' | 'hold';
  readonly confidence: number;
  readonly rationale: string;
  readonly plan?: AgentPlan;
}

// Retained for offline/standalone use of this class outside agentic-replay.ts (e.g. a future sync
// harness variant, or a unit test driving it without the async plumbing) — mirrors the ORIGINAL
// skeleton's LiveDecideFn shape. agentic-replay.ts itself never constructs one of these; it always
// resolves decisions asynchronously and passes them straight to decide()'s second parameter.
export type LiveDecideFnSync = (ctx: BarContext) => {
  readonly action: 'long' | 'flat' | 'hold';
  readonly plan?: AgentPlan;
};

// $ budget enforcement lives in the CALLER (agentic-replay.ts), which is the only module that knows
// real API costs (it reads AgentUsage off the response and prices it from the rates table) — see that
// module's header. maxDecisions is a coarse, price-independent safety ceiling on call COUNT, kept as a
// defensive backstop against a pathological loop even if the rates table or $ math is ever wrong; it
// is deliberately set high enough by the runner that maxUsd is what actually binds in practice.
export interface LiveAgenticBudget {
  readonly maxDecisions: number;
}

export class LiveAgenticStrategy implements BarStrategy {
  private decisionsUsedCount = 0;
  private plan: PlanExecutorState | null = null;
  // The resting entry's limit price, set the bar a plan is created and cleared on fill/cancel/expiry.
  // Computed once, from the SAME formula anthropic-agent-client.ts uses to derive limitPriceHint for a
  // plan-mode entry: close·(1 − entryOffsetBps/10000), 8 decimal places.
  private restingEntryPrice: Decimal | null = null;

  constructor(
    private readonly decideFn: LiveDecideFnSync | undefined,
    private readonly budget: LiveAgenticBudget,
    private readonly fallback: BarStrategy,
  ) {}

  // Read by agentic-replay.ts BEFORE calling decide() on a FLAT bar, to decide whether a fresh model
  // consult is needed this bar at all (no active plan) — never duplicated inline by the caller.
  get hasActivePlan(): boolean {
    return this.plan !== null;
  }

  get decisionsUsed(): number {
    return this.decisionsUsedCount;
  }

  // The currently-resting entry's limit price (decimal string), or null when there is none to fill
  // against. Read by agentic-replay.ts ONLY on a bar where decide() returned {type:'enter'} — that is
  // the one moment the caller needs a price to settle against (see this file's header fill model).
  get pendingEntryPrice(): string | null {
    return this.restingEntryPrice ? this.restingEntryPrice.toFixed() : null;
  }

  decide(ctx: BarContext, resolved?: MappedDecision): BacktestAction {
    const positionSide: 'LONG' | 'FLAT' = ctx.position.signedQty.gt(0) ? 'LONG' : 'FLAT';

    if (this.plan !== null) {
      return positionSide === 'FLAT'
        ? this.decideWaitingForFill(ctx)
        : this.decideManagingPosition(ctx);
    }

    if (positionSide === 'LONG') {
      // A LONG position with no tracked plan cannot arise from this class's own transitions (every
      // entry is plan-created and cleared only on exit) — fail safe to hold rather than blind-exit a
      // position this instance never opened (e.g. a caller wiring bug). No re-arm path (see header).
      return { type: 'hold' };
    }

    if (resolved === undefined) {
      // No fresh decision was fetched for this bar — either the caller decided none was necessary
      // (already covered by the branches above, so unreachable in practice on a FLAT/no-plan bar
      // driven by agentic-replay.ts) or the decision/$ budget is exhausted. maxDecisions is this
      // class's own price-independent ceiling; the $ ceiling lives in the caller and manifests here
      // the same way — the caller simply stops passing `resolved`.
      if (this.decisionsUsedCount >= this.budget.maxDecisions) return this.fallback.decide(ctx);
      if (this.decideFn) {
        const decision = this.decideFn(ctx);
        return this.applyDecision(ctx, {
          action: decision.action,
          confidence: 1,
          rationale: 'sync decideFn stand-in',
          plan: decision.plan,
        });
      }
      return { type: 'hold' };
    }

    return this.applyDecision(ctx, resolved);
  }

  private applyDecision(ctx: BarContext, resolved: MappedDecision): BacktestAction {
    this.decisionsUsedCount += 1;
    if (resolved.action !== 'long' || !resolved.plan) return { type: 'hold' };

    const lastClose = ctx.closes[ctx.closes.length - 1];
    if (lastClose === undefined) return { type: 'hold' };
    this.restingEntryPrice = new Decimal(lastClose)
      .mul(new Decimal(1).minus(new Decimal(resolved.plan.entryOffsetBps).div(10_000)))
      .toDecimalPlaces(8);
    this.plan = {
      plan: resolved.plan,
      entryPrice: null,
      planStartedBar: ctx.barIndex,
      barsElapsed: 0,
    };
    // The plan is created but not yet filled — an 'enter' is only ever returned from
    // decideWaitingForFill, the first bar the resting price is actually crossed (see header).
    return { type: 'hold' };
  }

  // FLAT with an active plan: either the resting entry fills THIS bar (a later bar's low crosses the
  // resting price — see header) or evaluatePlan governs the wait (cancel on expiry, else hold).
  private decideWaitingForFill(ctx: BarContext): BacktestAction {
    const plan = this.plan!;
    const lastLow = ctx.lows[ctx.lows.length - 1];
    const filled =
      lastLow !== undefined &&
      this.restingEntryPrice !== null &&
      new Decimal(lastLow).lte(this.restingEntryPrice);

    if (filled) {
      // Single clock: barsElapsed still ticks on the fill bar itself (plan-executor.ts's own doc).
      this.plan = { ...plan, barsElapsed: plan.barsElapsed + 1 };
      return { type: 'enter', side: 'LONG' };
    }

    const result = evaluatePlan({
      state: plan,
      closePrice: ctx.markPrice,
      positionSide: 'FLAT',
      // Always true while waiting: the backtest places the resting order the instant the plan is
      // created (see header) — there is no submission-lag window to model as `false`.
      hasRestingEntry: true,
    });
    if (result.type === 'cancel_entry' || result.type === 'plan_expired') {
      this.plan = null;
      this.restingEntryPrice = null;
      return { type: 'hold' };
    }
    this.plan = { ...plan, barsElapsed: plan.barsElapsed + 1 };
    return { type: 'hold' };
  }

  // LONG with an active plan: evaluatePlan governs stop/take-profit/max-hold; a live-caller-supplied
  // exit reason maps to a fill the CALLER prices at the triggering bar's close (see header — never
  // stopPrice/takeProfitPrice, which would be an optimistic fill).
  private decideManagingPosition(ctx: BarContext): BacktestAction {
    const plan = this.plan!;
    const entryPrice = ctx.position.avgEntry.toFixed();
    const result = evaluatePlan({
      state: { ...plan, entryPrice },
      closePrice: ctx.markPrice,
      positionSide: 'LONG',
      hasRestingEntry: false,
    });
    if (result.type === 'exit') {
      this.plan = null;
      this.restingEntryPrice = null;
      return { type: 'exit', reason: result.reason };
    }
    this.plan = { ...plan, barsElapsed: plan.barsElapsed + 1 };
    return { type: 'hold' };
  }
}
