// Live-agentic BarStrategy — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Owns the ONE evaluatePlan orchestration path for the LLM-in-the-loop backtest (agentic-replay.ts's
// header explains why the two files split this way): plan lifecycle (resting-entry wait, fill
// detection, managed-exit checks) lives HERE, real domain settlement (fills/fees/PnL) and the async
// model call/$-budget ledger live in agentic-replay.ts, which drives this class. Never duplicate
// evaluatePlan's own stop/TP/max-hold logic outside plan-executor.ts — this class only sequences
// calls into it and reacts to its verdicts. That is what makes SHORTS free here: plan-executor.ts's
// SHORT arm (Push II Phase 8) already mirrors the stop/TP formulas, so this class contributes only
// the direction bookkeeping and the mirrored ENTRY-fill detection below.
//
// SYNC/ASYNC SEAM: decide() stays synchronous (BarStrategy's contract — see strategy.ts) and takes an
// OPTIONAL second parameter, a decision the caller already resolved out-of-band (the real model call
// is async; TypeScript happily assigns a function with an extra OPTIONAL parameter to a narrower
// interface type, since every BarStrategy-typed caller only ever supplies `ctx`). agentic-replay.ts's
// loop is the only caller that ever passes it: before calling decide() on a bar where `hasActivePlan`
// is false and the position is FLAT, it awaits the model call itself, validates the v3 submit_trade
// response and maps it through the fee/RR floors (mirroring anthropic-agent-client.ts — see that
// module's rejection path), and hands the already-floored MappedDecision in. A bar that needs no
// fresh decision (an active plan, or budget/decision-count exhaustion) calls decide(ctx) with no
// second argument.
//
// FILL MODEL (decided jointly with agentic-replay.ts, which prices every fill — this class only ever
// signals enter/exit + a DIRECTION, never a price):
//   - Maker entry: a resting order entryOffsetBps away from the close of the bar the plan was created
//     on, MIRRORED by direction — a LONG rests BELOW that close and fills on the first LATER bar
//     whose LOW crosses it; a SHORT rests ABOVE it and fills on the first later bar whose HIGH
//     crosses it. (Bar low/high is finer than a next-bar-open convention, and is the natural reading
//     of a resting limit order.) Detected HERE (this class tracks the resting price and the plan's
//     direction) since evaluatePlan orchestration needs to know a fill happened before it can switch
//     phases; PRICED by the caller via `pendingEntryPrice`.
//   - Taker entry: the v3 contract's entry.style 'taker' means "cross the spread for an immediate
//     fill", so it is modelled as filling on the PLAN BAR ITSELF at that bar's own close — the price
//     already known when the decision was made (no lookahead), and the same reference production's
//     own limitPriceHint is derived from. It never waits, and entryOffsetBps is ignored exactly as
//     the tool contract states.
//   - Exit (stop / take_profit / max_hold): evaluatePlan's verdict is a CLOSE-triggered check
//     (`close.lte(stopPrice)` for a long, `close.gte(stopPrice)` for a short — plan-executor.ts).
//     Filling a STOP or MAX_HOLD exit AT stopPrice would be optimistic (price already traded through
//     by the time a close confirms the breach) and would bias a live-gating verifier toward
//     overstating edge (CLAUDE.md rule 4: earned-live evidence must not be inflated), so
//     agentic-replay.ts fills those two reasons at the TRIGGERING BAR'S OWN CLOSE (ctx.markPrice) —
//     the same close evaluatePlan used to decide the exit, so no lookahead and no optimistic-fill
//     bias. A TAKE_PROFIT exit is the OPPOSITE case (Fix 3, 2026-07-22 fidelity pass): close has
//     already reached-or-passed takeProfitPrice by construction (the same close-triggered check, the
//     other direction), so filling AT close would book the OVERSHOOT as free edge — production RESTS
//     a limit TP at the venue (AGENTIC_VENUE_TP=true, .env.app:151), capping the real fill at
//     takeProfitPrice, so agentic-replay.ts fills a take-profit exit there instead: the PESSIMISTIC
//     (not optimistic) side of the same gap, matching that venue behaviour. See that module's
//     takeProfitFillPrice/activePlanDirectives for how the price/directive set cross this file
//     boundary — this class still never computes or returns a price itself, only bare enter/exit
//     signals; agentic-replay.ts owns pricing every fill (see file header's ORCHESTRATION SPLIT).
//
// hasRestingEntry is always TRUE while this class waits for a fill (never the hardcoded-false the
// original skeleton used): the backtest places the resting order deterministically the instant a plan
// is created, so there is no production-style submission lag to model.
//
// SINGLE-POSITION DISCIPLINE: this harness models one open position at a time. A same-side 'open_*'
// while positioned is a SCALE-IN and an opposite-side one is the v3 NO-FLIP case (agent-prompt.ts's
// TRADE_ACTION_DESCRIPTION: "an 'open_*' on the OPPOSITE side of an existing position is a no-op
// hold, never an accidental flip — close first"); NEITHER opens anything here — see applyDecision.
// 'adjust' (revise directives in place) is likewise not modelled: agentic-replay.ts only ever
// consults the model while FLAT and planless, so no directive set ever exists to revise.
import Decimal from 'decimal.js';
import {
  evaluatePlan,
  type PlanExecutorState,
} from '../../../src/features/trading/agentic/plan-executor';
import type { AgentDirectives } from '../../../src/ports/agentic-strategy';
import type { BarStrategy, BarContext, BacktestAction } from '../strategy';

// The v3 submit_trade action vocabulary, verbatim (agent-prompt.ts's buildTradeTool action enum) —
// re-stated as a type alias rather than imported because the production enum lives inside a JSON
// tool-schema literal, not an exported TS union.
export type TradeAction = 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold';

export type PositionDirection = 'LONG' | 'SHORT';

// A v3 submit_trade decision already validated against tradeDecisionSchema AND mapped through the
// harness's fee/RR floors (agentic-replay.ts's callModel/applyFloors) — `directives` present iff the
// action opens a position AND the directive set cleared every floor; a floor-rejected, capability-
// rejected, schema-invalid, or non-opening response arrives here as a plain `{ action: 'hold', ... }`,
// matching anthropic-agent-client.ts's own "rejected ⇒ degrade to hold, no plan" mapping. There is no
// `confidence` field: v3 replaced it with AgentDirectives.sizeFraction (the conviction channel).
export interface MappedDecision {
  readonly action: TradeAction;
  readonly rationale: string;
  readonly directives?: AgentDirectives;
}

// Retained for offline/standalone use of this class outside agentic-replay.ts (e.g. a future sync
// harness variant, or a unit test driving it without the async plumbing) — mirrors the ORIGINAL
// skeleton's LiveDecideFn shape, on the v3 vocabulary. agentic-replay.ts itself never constructs one
// of these; it always resolves decisions asynchronously and passes them to decide()'s 2nd parameter.
export type LiveDecideFnSync = (ctx: BarContext) => {
  readonly action: TradeAction;
  readonly directives?: AgentDirectives;
};

// $ budget enforcement lives in the CALLER (agentic-replay.ts), which is the only module that knows
// real API costs (it reads usage off the response and prices it from the per-model rate table) — see
// that module's header. maxDecisions is a coarse, price-independent safety ceiling on call COUNT,
// kept as a defensive backstop against a pathological loop even if the rate table or $ math is ever
// wrong; it is deliberately set high enough by the runner that maxUsd is what actually binds.
export interface LiveAgenticBudget {
  readonly maxDecisions: number;
}

// Signed position → side. Shared by this class and (structurally) by agentic-replay.ts's own
// settlement branch; a `.gt(0)`-only test would silently read every SHORT as FLAT.
function sideOf(signedQty: Decimal): PositionDirection | 'FLAT' {
  if (signedQty.gt(0)) return 'LONG';
  if (signedQty.lt(0)) return 'SHORT';
  return 'FLAT';
}

export class LiveAgenticStrategy implements BarStrategy {
  private decisionsUsedCount = 0;
  private plan: PlanExecutorState | null = null;
  // The resting entry's limit price, set the bar a plan is created and cleared on fill/cancel/expiry.
  // Derived from the SAME formula anthropic-agent-client.ts uses for a maker entry's limitPriceHint,
  // mirrored by direction (see this file's fill-model header), at 8 decimal places.
  private restingEntryPrice: Decimal | null = null;
  // Which side the ACTIVE plan opens/manages. Kept alongside the plan (not derived from the position)
  // because it must already be known while the position is still FLAT — that is exactly the window
  // where the mirrored fill-detection test (low-cross vs high-cross) has to pick a direction.
  private planDirection: PositionDirection = 'LONG';

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

  // The currently-resting (or just-crossed) entry's limit price as a decimal string, or null when
  // there is none to fill against. Read by agentic-replay.ts ONLY on a bar where decide() returned
  // {type:'enter'} — that is the one moment the caller needs a price to settle against (see this
  // file's header fill model). The action's own `side` tells the caller BUY-to-open vs SELL-to-open.
  get pendingEntryPrice(): string | null {
    return this.restingEntryPrice ? this.restingEntryPrice.toFixed() : null;
  }

  // The ACTIVE plan's directive set (sizeFraction/takeProfitPct/etc.), or null when no plan is armed.
  // Fix 1/Fix 3 (2026-07-22 fidelity pass): agentic-replay.ts reads this BEFORE calling decide() —
  // never after — because a successful exit clears `this.plan` synchronously inside that same call
  // (decideManagingPosition sets it to null before returning), so a post-decide read would already be
  // too late to recover the directives that governed the bar. This class still never computes or
  // returns a PRICE itself (see this file's header) — it only exposes the directive VALUES the caller
  // needs to price sizeFraction-based notional and a take-profit fill.
  get activePlanDirectives(): AgentDirectives | null {
    return this.plan ? this.plan.plan : null;
  }

  decide(ctx: BarContext, resolved?: MappedDecision): BacktestAction {
    const positionSide = sideOf(ctx.position.signedQty);

    if (this.plan !== null) {
      return positionSide === 'FLAT'
        ? this.decideWaitingForFill(ctx)
        : this.decideManagingPosition(ctx, positionSide);
    }

    // A caller-resolved decision is applied even while positioned — that is the only path on which
    // the v3 no-flip / scale-in refusals in applyDecision are reachable at all (agentic-replay.ts's
    // own loop consults only while FLAT, but this class must still refuse rather than flip if a
    // future caller consults mid-position).
    if (resolved !== undefined) return this.applyDecision(ctx, resolved, positionSide);

    if (positionSide !== 'FLAT') {
      // An open position with no tracked plan cannot arise from this class's own transitions (every
      // entry is plan-created and cleared only on exit) — fail safe to hold rather than blind-exit a
      // position this instance never opened (e.g. a caller wiring bug).
      return { type: 'hold' };
    }

    // No fresh decision was fetched for this bar — either the caller decided none was necessary
    // (already covered by the branches above, so unreachable in practice on a FLAT/no-plan bar
    // driven by agentic-replay.ts) or the decision/$ budget is exhausted. maxDecisions is this
    // class's own price-independent ceiling; the $ ceiling lives in the caller and manifests here
    // the same way — the caller simply stops passing `resolved`.
    if (this.decisionsUsedCount >= this.budget.maxDecisions) return this.fallback.decide(ctx);
    if (this.decideFn) {
      const decision = this.decideFn(ctx);
      return this.applyDecision(
        ctx,
        {
          action: decision.action,
          rationale: 'sync decideFn stand-in',
          ...(decision.directives ? { directives: decision.directives } : {}),
        },
        positionSide,
      );
    }
    return { type: 'hold' };
  }

  private applyDecision(
    ctx: BarContext,
    resolved: MappedDecision,
    positionSide: PositionDirection | 'FLAT',
  ): BacktestAction {
    this.decisionsUsedCount += 1;
    if (resolved.action !== 'open_long' && resolved.action !== 'open_short') {
      // 'close'/'adjust'/'hold' with no plan and (by the caller's own consult rule) no position:
      // nothing to close, nothing to revise. See the single-position note in this file's header.
      return { type: 'hold' };
    }
    const wanted: PositionDirection = resolved.action === 'open_short' ? 'SHORT' : 'LONG';
    if (positionSide !== 'FLAT') {
      // NO-FLIP (v3, agent-prompt.ts's TRADE_ACTION_DESCRIPTION) when `wanted` is the opposite side,
      // and un-modelled SCALE-IN when it is the same side — both are a no-op hold here, and neither
      // arms a plan, so the existing position keeps being managed by the plan that opened it.
      return { type: 'hold' };
    }
    if (!resolved.directives) return { type: 'hold' };

    const lastClose = ctx.closes[ctx.closes.length - 1];
    if (lastClose === undefined) return { type: 'hold' };
    const close = new Decimal(lastClose);
    const directives = resolved.directives;
    const taker = directives.entryStyle === 'taker';
    // Mirrored maker offset: positive entryOffsetBps is the PASSIVE direction for both sides — below
    // the close for a long, above it for a short (a negative value is the aggressive side of each).
    // A taker entry ignores offsetBps entirely (tool contract) and rests at the close itself.
    const offsetFraction = new Decimal(directives.entryOffsetBps).div(10_000);
    const restingPrice = taker
      ? close
      : wanted === 'SHORT'
        ? close.mul(new Decimal(1).plus(offsetFraction))
        : close.mul(new Decimal(1).minus(offsetFraction));
    this.restingEntryPrice = restingPrice.toDecimalPlaces(8);
    this.planDirection = wanted;
    this.plan = {
      plan: directives,
      entryPrice: null,
      planStartedBar: ctx.barIndex,
      barsElapsed: taker ? 1 : 0,
    };
    // Maker: the plan is created but not yet filled — an 'enter' is only ever returned from
    // decideWaitingForFill, the first bar the resting price is actually crossed (see header).
    // Taker: fills immediately on this bar; barsElapsed is pre-ticked to 1 above for the same
    // single-clock reason decideWaitingForFill ticks it on its own fill bar (plan-executor.ts's doc).
    return taker ? { type: 'enter', side: wanted } : { type: 'hold' };
  }

  // FLAT with an active plan: either the resting entry fills THIS bar (a later bar's low crosses a
  // LONG's resting price / high crosses a SHORT's — the mirrored test, see header) or evaluatePlan
  // governs the wait (cancel on expiry, else hold).
  private decideWaitingForFill(ctx: BarContext): BacktestAction {
    const plan = this.plan!;
    const resting = this.restingEntryPrice;
    const lastLow = ctx.lows[ctx.lows.length - 1];
    const lastHigh = ctx.highs[ctx.highs.length - 1];
    const filled =
      resting !== null &&
      (this.planDirection === 'SHORT'
        ? lastHigh !== undefined && new Decimal(lastHigh).gte(resting)
        : lastLow !== undefined && new Decimal(lastLow).lte(resting));

    if (filled) {
      // Single clock: barsElapsed still ticks on the fill bar itself (plan-executor.ts's own doc).
      this.plan = { ...plan, barsElapsed: plan.barsElapsed + 1 };
      return { type: 'enter', side: this.planDirection };
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

  // POSITIONED with an active plan: evaluatePlan governs stop/take-profit/max-hold, keyed off the
  // position's ACTUAL side (its SHORT arm mirrors the stop/TP formulas — never re-derived here). The
  // exit reason maps to a fill the CALLER prices at the triggering bar's close (see header — never
  // stopPrice/takeProfitPrice, which would be an optimistic fill in either direction).
  private decideManagingPosition(ctx: BarContext, positionSide: PositionDirection): BacktestAction {
    const plan = this.plan!;
    const entryPrice = ctx.position.avgEntry.toFixed();
    const result = evaluatePlan({
      state: { ...plan, entryPrice },
      closePrice: ctx.markPrice,
      positionSide,
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
