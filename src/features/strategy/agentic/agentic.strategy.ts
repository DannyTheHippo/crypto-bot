import Decimal from 'decimal.js';
import type { CandleEvent, CandleInterval } from '../../../domain/venue/types/market-events';
import type { Signal } from '../../../domain/strategy/types/signal';
import type { StrategyId, VenueId, SymbolId, EpochMs } from '../../../domain/common/types/ids';
import type { SubscriptionSpec } from '../../../domain/venue/types/subscription';
import type {
  OpenOrderSummary,
  PortfolioSnapshot,
  Position,
} from '../../../domain/trading/types/portfolio';
import type { Price } from '../../../domain/common/types/money';
import {
  toIndicatorNumber,
  price,
  roundToMoneyPrecision,
  roundToTick,
  roundToStep,
} from '../../../domain/common/types/money';
import { AGENTIC_MAX_STOP_LOSS_PCT } from '../../../domain/trading/risk/agentic-bounds';
import { plannedStopNotionalCap } from '../../../domain/trading/risk/planned-stop-risk';
import { splitSymbol } from '../../../domain/venue/types/symbol';
import { isModelAuthoredDecision } from '../../../domain/strategy/types/decide-rationale';
import { aggregateCandles } from '../../../domain/strategy/indicators/candle-aggregate';
import {
  emaFromNumbers,
  rsiFromNumbers,
  atrFromNumbers,
  pctChange,
} from '../../../domain/strategy/indicators/indicators';
import {
  AgentProposeError,
  type AsyncStrategy,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentContext,
  type AgentCrossSymbol,
  type AgentEdgePolicyBlock,
  type AgentTrackRecord,
  type AgentDecisionMeta,
  type AgentHtfIndicators,
  type AgentIndicators,
  type AgentPositionSummary,
  type AgentDecisionRecord,
  type AgentDecisionJournalPort,
  type AgentDecisionEntry,
  type AgentProposal,
  type EdgePolicyPort,
  type StrategyInitContext,
} from '../../../ports/strategy/agentic-strategy';
import { MAX_REASON_LEN, type LoggerLike } from './anthropic-agent-client';
import { buildMarketPayload } from './agent-prompt';
import { deriveRegimeTags } from './episodic-memory';
import type { RoundTripEvidencePort } from '../../../ports/trading/promotion';
import type { DerivativesFeedPort } from '../../../ports/venue/derivatives-feed';
import type { SentimentFeedPort } from '../../../ports/strategy/sentiment-feed';
import type { FearGreedFeedPort } from '../../../ports/strategy/fear-greed-feed';
import type { TradeFlowFeedPort } from '../../../ports/venue/trade-flow-feed';
import type { PositioningFeedPort } from '../../../ports/venue/positioning-feed';
import type { LiquidationFeedPort } from '../../../ports/venue/liquidation-feed';
import { evaluatePlan, type PlanExecutorAction, type PlanExecutorState } from './plan-executor';
import { CrossSymbolContextService } from './cross-symbol-context';
import {
  computeHoldReturnFraction,
  computeEqualWeightBasketReturnFraction,
  computeAlphaBps,
  BTC_BENCHMARK_SYMBOL,
  type BenchmarkCandle,
} from './benchmark-alpha';
import type { PriceHistoryStore } from './price-history-store';
import { positionKey } from '../../../domain/trading/risk/evaluate';
import type { PlanStop, PlanStopRegistryPort } from '../../../ports/trading/risk';
import type { ExecutionStorePort } from '../../../ports/trading/execution';
import type { AlgoOrderState, ExchangePort } from '../../../ports/venue/exchange';
import { clientOrderId } from '../../../domain/common/types/ids';
import {
  roleForDedupeKey,
  type RestingOrderRole,
} from '../../../domain/trading/oms/resting-order-role';

// binanceusdm (USD-M swap): mirrors position-sizer.service.ts's own local PERP_VENUE_ID convention
// (the eslint-plugin-boundaries wall forbids importing that feature's constant — features may only
// import their OWN feature, ports, domain, config, shared — so it is duplicated here, same as every
// other feature-local copy of this constant in this codebase).
const PERP_VENUE_ID = 'binanceusdm';

export interface AgenticStrategyParams {
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly interval: CandleInterval;
  readonly warmupBars: number;
  // Model id recorded on every journal entry — the client's own config carries the model it
  // actually calls; this is the strategy's account of it for the journal row. Optional (falls back
  // to DEFAULT_MODEL_ID) so existing callers that predate this field still compile.
  readonly model?: string;
  // W2.1 stale-entry sweep: a resting non-reduce-only order older than this many observed decide
  // cycles gets a CANCEL_OPEN (risk-reducing; routed by SignalSink to an order-cancel, never to the
  // gateway). Optional/absent/0 ⇒ disabled, so existing callers stay byte-identical.
  readonly entryTtlBars?: number;
  // W3.1 plan-based trading: the client returns managed trade plans (AgentProposal.plan) and this
  // strategy runs plan-executor.ts between LLM consults. Absent/false ⇒ legacy bar-by-bar behavior.
  readonly planMode?: boolean;
  // B2 (Design § Deleted scaffolding): retired planMaxQuietBars' fixed modulo cadence — the portfolio
  // schedule (nextConsultBars) now drives quiet-bar consult timing; wakeMovePct/fallbackConsultBars
  // below are the two remaining bar-level knobs (see evaluateConsultSchedule).
  // Wake-on-move threshold: a bar-close move of this fraction (or more) from the price at the last
  // consult forces an immediate consult regardless of the active schedule. Default 0.015 (1.5%).
  readonly wakeMovePct?: number;
  // Safety-net consult cadence (bars) used ONLY while no portfolio schedule is active (never
  // consulted yet, or the last schedule has been exhausted with nothing fresh set) — see
  // evaluateConsultSchedule's 'forced_fallback' branch. Default 16.
  readonly fallbackConsultBars?: number;
  // TTL (bars) on executor-emitted signals (plan exits, plan cancels, stale-entry sweeps). A
  // one-bar TTL races its own age — executor signals carry eventTime = the evaluated bar's close,
  // so any ≥2s of processing jitter expires a protective exit at the gateway (observed live
  // 2026-07-07: a max_hold exit died at age 902.2s vs ttl 900s). Default 2 bars.
  readonly planExitTtlBars?: number;
  // W6: sample the decide-time market payload every Nth plan-managed (quiet) bar (active.barsElapsed
  // % N === 0) so the offline replay harness (test/eval/agentic/recorded-rows.spec.ts) accrues
  // input_payload rows under plan mode, which otherwise journals inputPayload: null on every managed
  // bar (see recordQuietJournalEntry). Prescreen-skip quiet holds are never sampled — only
  // plan-managed bars. Default/0 ⇒ disabled, so existing callers stay byte-identical.
  readonly quietPayloadSampleBars?: number;
  // Push 3 P6 Unit 4 (#17 residual): when enabled AND deps.evidence is wired, decide() surfaces
  // {tripCount, winRate, meanNetBpsPerTrip, trailingWindowTrips} over the SAME trailing window/floor
  // the (B3-renamed) TRACK_RECORD_WINDOW_TRIPS/MIN_TRIPS consts below define onto the outgoing
  // AgentContext.trackRecord — a decide-side read of realized performance, never a
  // risk-modulating mechanism. Absent/false ⇒ never computed, never attached — byte-identical.
  readonly trackRecordEnabled?: boolean;
  // Cross-symbol relative-strength context (2026-07-12): when enabled AND deps.crossSymbolContext is
  // wired, buildContext records this symbol's trailing-return into the shared service and attaches
  // its basket ranking to the outgoing context (see cross-symbol-context.ts). Absent/false ⇒ never
  // recorded, never attached — byte-identical to pre-feature output. Inert without the shared dep.
  readonly crossSymbolEnabled?: boolean;
  // Trailing-return lookback (bars) used for the cross-symbol ranking. Default 20 (the winning
  // cross-sectional lookback from the 2026-07-12 multi-strategy search).
  readonly crossSymbolLookbackBars?: number;
  // AGENTIC_VENUE_TP: rests the plan's take-profit at the venue (a reduce-only EXIT_LONG with
  // exitStyle 'RESTING') instead of waiting for the executor's own close-price crossing check to
  // fire an IOC exit — better fill quality (the order can fill intrabar, at the exact TP price,
  // rather than only after a bar closes past it). Optional/absent ⇒ disabled, so existing callers
  // stay byte-identical (no RESTING signal, no venue-order cancels, plan-executor's own
  // stop/take_profit/max_hold price-crossing checks are the only exit path, same as today).
  readonly venueTpEnabled?: boolean;
  // Re-place threshold (bps) for the resting TP: when the resting SELL's own price has drifted from
  // the plan's current TP price by more than this many bps, it is cancelled this bar so the next bar
  // re-places it at the correct price (see manageVenueTp). Default 10.
  readonly venueTpReplaceDriftBps?: number;
  // Venue tick size for this symbol (DEFAULT_FILTERS row). The sizer rounds the TP hint UP to this
  // tick when pricing the resting order, so the drift comparison must use the tick-rounded
  // expectation — comparing against the raw hint reads the [0, tick) rounding bias as drift and
  // churns cancel/re-place forever on any symbol whose tick exceeds the threshold (review finding).
  // Absent ⇒ compare against the raw hint (test harnesses; fine-tick symbols).
  readonly venueTpTickSize?: string;
  // Venue LOT_SIZE step for this symbol (the SAME DEFAULT_FILTERS row the sizer rounds with). The
  // sizer sizes a reduce-only RESTING exit to roundToStep(position.qty, step, 'down'), so the resting
  // order's qty is structurally ≤ the position by the sub-step residue (position.qty mod step ∈
  // [0, step)) and can NEVER exactly equal the full-precision position.qty. The qty-reconciliation in
  // manageVenueTp must therefore compare against the step-rounded (sellable) qty, not the raw
  // position.qty — an exact-equality check reads the always-present dust residue as a mismatch and
  // churns cancel/re-place every managed bar (2026-07-15 loop fix: live DB showed LINK 12.03 vs
  // position 12.0396, SOL 1.924 vs 1.924173, etc.). Absent ⇒ compare against the raw qty (test
  // harnesses whose fixtures are already step-aligned).
  readonly venueTpStepSize?: string;
  // AGENTIC_VENUE_STOP (Push 3 P7d): rests the plan's protective stop at the venue (a reduce-only
  // exit with exitStyle 'RESTING_STOP') instead of relying solely on the executor's own bar-close
  // stop-price crossing to fire an IOC exit — SPOT rests a STOP_LOSS_LIMIT on the regular open-orders
  // rail (reconciled exactly like manageVenueTp, role 'vsl'); PERP rests a STOP_MARKET on the swap
  // algo/conditional rail instead (never visible in openOrders — reconciled via
  // AgenticStrategyDeps.algoOrders.fetchOpenAlgoOrders). Optional/absent ⇒ disabled, byte-identical
  // to pre-feature: no RESTING_STOP signal, no algo-rail calls, the executor's own bar-close
  // stop/take_profit/max_hold checks stay the only exit path for the stop leg, same as today.
  readonly venueStopEnabled?: boolean;
  // Re-place threshold (bps) for the resting stop — mirrors venueTpReplaceDriftBps. Default 10.
  readonly venueStopReplaceDriftBps?: number;
  // Venue tick size for this symbol — mirrors venueTpTickSize's own rationale (compares the resting
  // order's price against the tick-rounded expectation, not the raw hint, so the [0, tick) rounding
  // bias is never read as drift). Absent ⇒ compare against the raw (buffered, for spot) expectation.
  readonly venueStopTickSize?: string;
  // Venue LOT_SIZE step — mirrors venueTpStepSize's rationale for the protective stop's own qty
  // reconciliation (manageVenueStop). The reduce-only STOP order is sized to the step-rounded
  // position exactly as the TP is, so the same exact-equality dust churn applies (latent on the perp
  // algo rail until the first perp fill; a cancel/re-place there is an algo-endpoint round trip).
  // Absent ⇒ compare against the raw qty.
  readonly venueStopStepSize?: string;
  // Spot-only: the SAME buffer PositionSizerService applies past the trigger when it builds the
  // STOP_LOSS_LIMIT's limit leg (position-sizer.service.ts's isRestingStopExit branch) — the resting
  // order's own limitPrice is this buffered leg, never the raw trigger, so drift reconciliation must
  // compare against the SAME buffered expectation or every bar reads the buffer itself as permanent
  // drift and churns cancel/re-place forever. Absent ⇒ falls back to the sizer's own default (50).
  readonly stopLimitBufferBps?: number;
  // Force-fire threshold (bps), mirrors ports/trading/risk.ts's ProtectiveExitConfig.planStopForceBps: the
  // bar-close executor's own 'stop' exit stands down while a confirmed-resting venue stop should
  // still have room to fill on its own, UNLESS the close has already breached the plan's stop price
  // by more than this many bps — a resting venue stop should already have filled at a small breach,
  // so a wide miss means the venue-side order failed and the bar-close backstop must not defer
  // indefinitely. Independent of PLAN_STOP_WATCH_ENABLED (ProtectiveExitService's OWN 1s watcher,
  // which applies this SAME band on its own faster cadence — see tickPlanStop) — this is the
  // strategy's bar-close copy of that band, needed because AGENTIC_VENUE_STOP may be enabled with
  // the 1s watcher off. Default 30 (matches PLAN_STOP_FORCE_BPS's schema default).
  readonly planStopForceBps?: number;
  // Profitability Edge Program: mirrors the sizer's aggregate planned-stop cap so a plan-only
  // widening cannot increase risk without traversing PositionSizerService. Both are exact decimal
  // strings; absent/'0' disables the strategy-side guard for legacy/direct-construction callers.
  readonly maxPlannedStopRiskFraction?: string;
  readonly sizingEquityCap?: string;
}

// AGENTIC_VENUE_TP lifecycle events (see manageVenueTp / AgenticStrategyDeps.onVenueTp): 'placed' — no
// SELL was resting, one was placed; 'skipped_existing' — a correctly-priced SELL already rests
// (idempotent no-op, covers the restart re-arm case); 'skipped_inflight' — a placement was emitted
// this bar or last and its ack hasn't been observed yet, so re-placing would race a duplicate;
// 'cancel_for_exit' — a stop/max_hold exit cancelled the resting SELL ahead of its own full-size IOC
// exit; 'drift_cancel' — the resting SELL's price drifted past venueTpReplaceDriftBps and was
// cancelled for next-bar re-placement; 'qty_cancel' — the resting SELL's qty no longer matches the
// position (entry remainder filled after placement) and was cancelled for full-size re-placement;
// 'tp_race_hold' — the close crossed the TP while the SELL still rests (its own venue fill is the
// exit; an IOC here would collide with the base it locks), so the bar holds awaiting the fill;
// 'filled_flat' — the resting SELL filled at the venue (position went FLAT without this executor
// ever emitting the exit itself), clearing the plan with no signal.
export type VenueTpEvent =
  | 'placed'
  | 'skipped_existing'
  | 'skipped_inflight'
  | 'cancel_for_exit'
  | 'drift_cancel'
  | 'qty_cancel'
  | 'tp_race_hold'
  | 'orphan_cancel'
  | 'filled_flat';

// AGENTIC_VENUE_STOP lifecycle events (see manageVenueStop / AgenticStrategyDeps.onVenueStop) —
// mirrors VenueTpEvent's own set, minus 'tp_race_hold' (the stop's own venue fill racing a bar-close
// check is 'stood_down'/'force_fired' below, a distinct decision from the TP's race-hold) plus three
// stop-specific additions: 'stood_down' — the bar-close executor deferred a 'stop' exit to the
// confirmed-resting venue stop (breach within the force band); 'force_fired' — the SAME check found
// the breach past the force band and let the bar-close IOC exit proceed (the venue order evidently
// failed to fill on its own); 'reconcile_error' — the perp reconcile's fetchOpenAlgoOrders read
// threw (adapter/venue failure): the placement decision was skipped that bar, backstops stay armed
// (backlog #54 — a sustained rate on this event means the venue stop never rests on this venue).
// 'triggered' — Defect A commit-1 (2026-07-16 phantom perp position): a CONFIRMED-resting perp algo
// stop vanished from fetchOpenAlgoOrders and AgenticStrategyDeps.onAlgoStopGone confirmed it
// actually fired (venue algo-history rail, not a local guess) — recovery already ingested the fill
// onto the OMS, so this bar neither re-places the stop nor emits an exit signal (see
// manageVenueStopPerp's gone-branch).
// The three orphan-reconcile labels (2026-07-31 stale-non-terminal-algo-stop defect):
// reconcileOrphanedAlgoStop emitted NOTHING on any of its four outcomes, so a zero on 'orphan_cancel'
// was unreadable — it could equally mean "no orphan was ever matched" or "one was matched and the
// cancel threw into the bare catch every bar" (the live HYPE/USDT:USDT stop that sat ACKED ~11h across
// three boots was exactly that ambiguity). 'orphan_scan' — the no-active-plan scan reached its venue
// read (a non-zero value is the only proof this path runs at all); 'orphan_readopt' — branch (a)
// re-adopted a stop the CURRENT position still needs; 'orphan_cancel_failed' — branch (b) matched an
// orphan but cancelAlgoOrder threw. Branch (b)'s SUCCESS reuses 'orphan_cancel', the same event
// runActivePlan's position_closed branch already emits for the identical cleanup.
export type VenueStopEvent =
  | 'placed'
  | 'skipped_existing'
  | 'skipped_inflight'
  | 'cancel_for_exit'
  | 'drift_cancel'
  | 'qty_cancel'
  | 'orphan_cancel'
  | 'filled_flat'
  | 'stood_down'
  | 'force_fired'
  | 'reconcile_error'
  | 'triggered'
  | 'orphan_scan'
  | 'orphan_readopt'
  | 'orphan_cancel_failed';

// B2 (Design § Deleted scaffolding): supersedes prescreen.ts's PrescreenOutcome/PrescreenReason —
// see evaluateConsultSchedule below for what drives each value. 'consulted' is the organic
// on-schedule case (barsSinceConsult reached the portfolio's own nextConsultBars); the four
// 'forced_*' values are the schedule-independent overrides; 'skipped_scheduled' is the quiet bar.
export type ConsultGateOutcome =
  | 'consulted'
  | 'skipped_scheduled'
  | 'forced_fill'
  | 'forced_move'
  | 'forced_fallback'
  | 'forced_rearm';

interface ConsultScheduleState {
  readonly barsSinceConsult: number;
  readonly scheduledConsultBars: number | null;
  readonly lastConsultPrice: number | null;
}

interface ConsultScheduleArgs {
  readonly state: ConsultScheduleState;
  readonly isExecTrigger: boolean;
  readonly hasOpenPositionWithoutDirectives: boolean;
  // Last closed candle's close, indicator-float (never a money path — see prescreen.ts's own
  // retired header comment for the same discipline this function inherits). null when this bar
  // carries no basis candle yet (e.g. an early 'exec'/'ticker' trigger).
  readonly lastClose: number | null;
  readonly wakeMovePct: number;
  readonly fallbackConsultBars: number;
  // XA5 (A0 activation bundle): repeated-noop breaker engaged (see AgenticStrategy.noopSuppressed).
  // Optional: absent ⇒ false (never suppress — fail OPEN toward consulting). Bypassed by
  // forced_fill/forced_rearm above (a fill or lost directives always re-consult and clear it).
  readonly noopSuppressed?: boolean;
  // XA1 (A0 activation bundle): active-menu membership. false ⇒ this symbol never schedules,
  // wakes, or falls back into a consult — off-menu idle symbols previously recorded forced_*
  // gate outcomes every fallback cycle and then had their consult clock AND wake-on-move
  // baseline reset by the batching client's inert menu-hold, corrupting scheduler state while
  // never actually consulting (2026-07-20: 24 forced_fallback outcomes → 6 fragmented API
  // calls). forced_fill and forced_rearm bypass this on purpose (an executed fill or an
  // unmanaged open position must always consult — the scanner pins positioned symbols active,
  // this is defense in depth). Optional: absent ⇒ true (fail OPEN toward consulting — a broken
  // menu read must never silence the basket).
  readonly menuActive?: boolean;
}

// B2 (Design § Deleted scaffolding): prescreen.ts's deterministic quiet-market heuristic (vol
// expansion / breakout proximity) is retired outright — the portfolio schedule (nextConsultBars),
// wake-on-move, fill triggers, and the fallback cadence are now the ONLY consult-timing mechanism.
// Pure, dependency-free (no nest/ccxt/Date.now/process.env — same discipline prescreen.ts held).
// Priority order below is deliberate: an executed fill and a restart re-arm are unconditional
// (the host already bypassed cadence for the fill; a re-arm can never trust a stale schedule), the
// organic on-schedule case is checked before wake-on-move so a bar that was already due reports
// 'consulted' rather than 'forced_move', and the fallback branch is mutually exclusive with the
// on-schedule branch by construction (fallback only ever applies while scheduledConsultBars is
// null — a schedule and its own absence can never both be true).
export function evaluateConsultSchedule(args: ConsultScheduleArgs): ConsultGateOutcome {
  const {
    state,
    isExecTrigger,
    hasOpenPositionWithoutDirectives,
    lastClose,
    wakeMovePct,
    fallbackConsultBars,
  } = args;
  if (isExecTrigger) return 'forced_fill';
  if (hasOpenPositionWithoutDirectives) return 'forced_rearm';
  // XA1: off-menu symbols stay quiet (see ConsultScheduleArgs.menuActive). barsSinceConsult keeps
  // climbing while off-menu, so the moment the scanner promotes the symbol back onto the menu it
  // immediately trips the fallback branch below — a fresh consult on menu entry falls out for free.
  if (args.menuActive === false) return 'skipped_scheduled';
  // XA5: repeated-noop breaker engaged (a positioned symbol looped the same ineffective action) —
  // stay quiet until the position state changes. Same priority as the menu gate: below the
  // unconditional fill/re-arm overrides above (a fill or lost directives must always re-consult and
  // will clear the breaker), above the schedule so the stuck loop cannot keep re-firing.
  if (args.noopSuppressed === true) return 'skipped_scheduled';
  if (state.scheduledConsultBars !== null && state.barsSinceConsult >= state.scheduledConsultBars) {
    return 'consulted';
  }
  if (
    state.lastConsultPrice !== null &&
    lastClose !== null &&
    Number.isFinite(lastClose) &&
    Math.abs(lastClose - state.lastConsultPrice) / state.lastConsultPrice >= wakeMovePct
  ) {
    return 'forced_move';
  }
  if (state.scheduledConsultBars === null && state.barsSinceConsult >= fallbackConsultBars) {
    return 'forced_fallback';
  }
  return 'skipped_scheduled';
}

interface ActivePlanState {
  plan: NonNullable<AgentProposal['plan']>;
  entryPrice: string | null;
  barsElapsed: number;
  // Bar index of the last venue-TP placement whose ack hasn't been observed in openOrders yet —
  // suppresses a duplicate placement while the first is in flight (StrategyPortfolioView exposes
  // no in-flight intents, so openOrders alone cannot close this window). null once observed.
  venueTpPlacedAtBar: number | null;
  // Same in-flight suppression window, for the venue stop (AGENTIC_VENUE_STOP) — spot: ack observed
  // in openOrders; perp: ack observed as a matching row off fetchOpenAlgoOrders. null once observed.
  venueStopPlacedAtBar: number | null;
  // Scale-in fill detection (review finding, minor): the position qty captured at the moment a
  // same-side scale-in replaced the plan while ALREADY positioned — null outside a pending scale-in
  // window. runActivePlan compares the CURRENT position qty against this baseline each managed bar;
  // once they diverge, the add's resting order has filled and entryPrice re-anchors to the new
  // (VWAP-blended) avgEntry — see runActivePlan's capture-site comment for why entryPrice cannot
  // just be nulled at replace time the way a fresh FLAT->open entry is.
  pendingScaleInQty: string | null;
}

export interface AgenticStrategyDeps {
  readonly journal?: AgentDecisionJournalPort;
  // Fires once per detected LONG→FLAT or (Push II Phase 8) SHORT→FLAT round trip, with the running
  // closed-trade count. The promotion evaluator subscribes; the strategy itself takes no action
  // beyond counting and calling it.
  readonly onClosedTrade?: (count: number) => void;
  // B2: fires once per decide() call with the consult-schedule gate's outcome — mirrors the
  // onClosedTrade seam. Optional/no-op-defaulted so existing tests/callers stay valid. Supersedes
  // the retired onPrescreen seam (prescreen.ts, deleted) — see ConsultGateOutcome/
  // evaluateConsultSchedule for the six possible values.
  readonly onConsultGate?: (outcome: ConsultGateOutcome) => void;
  // XA1: active-menu membership read for the consult gate (see ConsultScheduleArgs.menuActive).
  // Structurally satisfied by UniverseScannerService; absent ⇒ every symbol treated as active
  // (fail OPEN toward consulting — same failure direction as the scanner's own warmup default).
  readonly menuGate?: { isActive(symbol: string): boolean };
  // computeTrackRecordContext's data source: realized (venue-fill-derived) closed round trips, the
  // same evidence feed the promotion gate reads (ports/trading/promotion.ts). Optional — absent means
  // trackRecordEnabled is inert even when true (no in-strategy fallback is computed, since the
  // strategy has no other access to realized fills). B3: previously also fed the now-deleted
  // expectancy ladder — trackRecord is this dep's only remaining consumer.
  readonly evidence?: RoundTripEvidencePort;
  // C1: read-only derivatives-market context (funding rate, open interest, mark/index basis),
  // consulted once per decide() and threaded onto the outgoing snapshot's `derivatives` field (see
  // buildContext's caller in decide()). Optional — absent means the prompt's derivatives block never
  // renders (byte-identical to pre-C1 output), same convention as `evidence` above.
  readonly derivativesFeed?: DerivativesFeedPort;
  // C4: read-only free news/sentiment headlines, consulted once per decide() and threaded onto the
  // outgoing snapshot's `sentiment` field (see buildContext's caller in decide()). Optional — absent
  // means the prompt's sentiment block never renders (byte-identical to pre-C4 output), same
  // convention as `derivativesFeed` above.
  readonly sentimentFeed?: SentimentFeedPort;
  // X3a: Crypto Fear & Greed Index reading, consulted once per decide() and threaded onto the
  // outgoing snapshot's `fearGreed` field. Optional — absent means the prompt's fearGreed block
  // never renders, same convention as `derivativesFeed` above. Lane-wide (no symbol argument), same
  // as `sentimentFeed`.
  readonly fearGreedFeed?: FearGreedFeedPort;
  // Trade-flow/CVD context (taker aggressor imbalance), consulted once per decide() and threaded
  // onto the outgoing snapshot's `tradeFlow` field. Optional — absent means the prompt's tradeFlow
  // block never renders, same convention as `derivativesFeed` above.
  readonly tradeFlowFeed?: TradeFlowFeedPort;
  // Positioning context (global long/short account ratio), consulted once per decide() and threaded
  // onto the outgoing snapshot's `positioning` field. Optional — absent means the prompt's
  // positioning block never renders, same convention as `derivativesFeed` above.
  readonly positioningFeed?: PositioningFeedPort;
  // #43 liquidation-order flow (Push 3 P6 Unit 2), consulted once per decide() and threaded onto the
  // outgoing snapshot's `liquidation` field. Optional — absent means the prompt's liquidation block
  // never renders, same convention as `derivativesFeed` above.
  readonly liquidationFeed?: LiquidationFeedPort;
  // Cross-symbol relative-strength context (2026-07-12): a SINGLE instance shared across every
  // agentic-N strategy (wired in app.module.ts's register factory), so each instance records its own
  // symbol's trailing return and reads the whole basket's ranking. Absent ⇒ crossSymbolEnabled is a
  // no-op (the ranking never attaches), the same convention as `evidence`/`derivativesFeed` above.
  readonly crossSymbolContext?: CrossSymbolContextService;
  // AGENTIC_VENUE_TP: fires once per manageVenueTp/position_closed observation with the lifecycle
  // event (see VenueTpEvent) — mirrors the onPrescreen seam above. Optional/no-op-defaulted; absent
  // means the venue-TP lane runs unobserved (no metric), never a behavior change.
  readonly onVenueTp?: (event: VenueTpEvent) => void;
  // Plan-stop watcher (Push 3 P2): shared with ProtectiveExitService (see app.module.ts's single
  // PLAN_STOP_REGISTRY provider) so its 1s tick can fire against THIS strategy's plan stop price
  // between bar closes. Populated the moment a plan's entry fills and cleared on every plan-clear
  // path (see clearPlan/setPlanStop below). Absent ⇒ no-op — byte-identical to pre-feature.
  readonly planStopRegistry?: PlanStopRegistryPort;
  readonly logger?: LoggerLike;
  // Push 3 P7c: resting-order role resolution (vtp/vsl) — narrowed to the single read method
  // manageVenueTp's reconciliation actually uses (see roleForOrder). Optional: absent (no DB wired
  // — paper/test boots without EXECUTION_STORE_OVERRIDE) resolves every order 'unknown', which
  // manageVenueTp/restingOrderForRole treat as "leave it alone, warn once" — never a blind cancel.
  readonly intentStore?: Pick<ExecutionStorePort, 'loadIntentByClientOrderId'>;
  // AGENTIC_VENUE_STOP: fires once per manageVenueStop/position_closed/force-band observation with
  // the lifecycle event (see VenueStopEvent) — mirrors onVenueTp above. Optional/no-op-defaulted;
  // absent means the venue-stop lane runs unobserved (no metric), never a behavior change.
  readonly onVenueStop?: (event: VenueStopEvent) => void;
  // 2026-07-24 fail-closed re-arm fallback: fires exactly once when the synthetic protective plan
  // is attached (see decide()'s branch below). Optional/no-op-defaulted — mirrors onVenueTp/onVenueStop.
  readonly onRearmFallback?: () => void;
  // Full-book snapshot for the plan-only stop-widen guard. Production wires the same PORTFOLIO_VIEW
  // the SignalSink/sizer consume; absent is safe only while maxPlannedStopRiskFraction is disabled.
  readonly bookSnapshot?: () => PortfolioSnapshot;
  // Push 3 P7d: the swap algo/conditional-order rail's round-trip primitives, narrowed off
  // ExchangePort (ports/venue/exchange.ts) — the ONLY port through which this strategy ever reaches the
  // algo rail (never the concrete adapter directly; eslint-plugin-boundaries allows importing
  // `ports/*` types from any feature, so this narrowing stays boundary-clean). Optional: absent (no
  // exchange port wired — paper/test boots, or a spot-only deployment where CcxtExchangeAdapter's
  // own venue-gated methods would answer empty/throw anyway) makes manageVenueStop's PERP branch a
  // no-op (byte-identical: never reached — a spot deployment never calls it, and a perp deployment
  // always wires the real adapter here). Both methods are themselves optional on ExchangePort (only
  // the swap-capable adapter implements them) — every call site guards with `?.`.
  readonly algoOrders?: Pick<ExchangePort, 'fetchOpenAlgoOrders' | 'cancelAlgoOrder'>;
  // Defect A commit-1 (2026-07-16 phantom perp position): the ONLY route back to
  // AlgoStopRecoveryService (features/trading/execution) — the eslint-plugin-boundaries wall forbids
  // this feature importing execution code directly, so app.module.ts wires this closure over the
  // real service. Consulted ONLY when a CONFIRMED-resting perp algo stop vanishes from
  // fetchOpenAlgoOrders (manageVenueStopPerp's gone-branch): asks the venue's algo-history rail
  // whether it triggered (folded onto the OMS already), was canceled/never-placed (nothing to
  // recover), or the answer was inconclusive. Return type mirrors
  // AlgoStopRecoveryService.AlgoRecoverOutcome verbatim (duplicated, not imported — same
  // boundary-crossing convention as VenueStopEvent's own mirror in agent-metrics-recorder.service.ts).
  // Optional: absent (spot lane, or a boot that doesn't wire it) leaves the gone-branch
  // byte-identical to pre-feature — see manageVenueStopPerp's own comment on this.
  readonly onAlgoStopGone?: (
    symbol: SymbolId,
  ) => Promise<'triggered' | 'canceled' | 'none' | 'unknown'>;
  // I1b (Design § Universe: scanner-gated active menu — the reported per-symbol ingestion gap):
  // fires once per decide() call that lands on an actual candle-close trigger, with this instance's
  // OWN closed-candle window — mirrors onVenueTp/onVenueStop's fire-and-forget seam convention.
  // Wired in app.module.ts to universe-scanner.service.ts's recordCandles (storage-only, no-ops
  // below its own warmup floor, never triggers a recompute itself — see that method's own comment).
  // Absent ⇒ byte-identical to pre-I1b (the scanner never sees this instance's candles; every
  // symbol stays unranked until a later wiring, same as before).
  readonly onCandleMetrics?: (symbol: SymbolId, candles: readonly CandleEvent[]) => void;
  // W3 Part 2 (Design § Learning & measurement stack): a SINGLE shared PriceHistoryStore instance
  // across every agentic-N strategy (same "one instance, many readers" convention as
  // crossSymbolContext above) — the multi-symbol candle source netVsEqualWeightBasketBps needs (see
  // BTC_BENCHMARK_SYMBOL's own comment on the gap this closes, and price-history-store.ts's header on
  // how it's fed). Consulted ONLY inside computeBenchmarkAlpha; absent ⇒
  // netVsEqualWeightBasketBps stays omitted, the same fail-open convention netVsBtcHoldBps already
  // uses when its own coverage guard fails.
  readonly priceHistory?: PriceHistoryStore;
  // Phase 4 (Profitability Edge Program): tournament-derived cohort/eligibility overlay — always
  // bound (DisabledEdgePolicy when flag-off). Optional on deps only for module-isolation tests;
  // absent ⇒ edge policy unwired, byte-identical to pre-feature.
  readonly edgePolicy?: EdgePolicyPort;
}

// B3 (Design § Enriched model inputs) widened this 10 -> 30 on the reasoning that a portfolio-
// scheduled consult cadence needed more rings to cover the same wall-clock span. It was narrowed to
// 12 on 2026-07-30 in the same pass that added the write-site filter below, justified by a payload
// audit that sampled 405 live ring lines and found 382 of them non-model rows.
//
// RE-MEASURED against agent_decisions 2026-07-30, because that audit sample was drawn DURING the
// provider-outage window where every consult latched ('client_latched:' / action 'error'), and the
// two changes interact — a cap counted in model-authored rows is not the same cap counted in mixed
// rows. What the live journal actually says (payload rows carry the rendered block verbatim, so
// these are measurements, not estimates):
//
//   - Line cost: 258 chars per rendered model-authored line (178 post-filter lines) vs 222 per
//     pre-filter line (2,389 lines, 07-21 → 07-30 11:00Z) — real decisions carry a rationale, the
//     dropped noise rows did not. A FULL ring therefore costs ~3.1k chars at 12 against ~6.7k at 30.
//   - Realized occupancy: the 30-cap almost never bound. Pre-filter rings averaged 14.8 lines /
//     3,275 chars, of which 86.8% (2,073 of 2,389) were already model-authored. The old ring
//     carried ~12.8 real decisions in steady state — so 12 is within one row of the self-consistency
//     window that was actually in use, and the block's token cost is flat, not halved.
//   - Wall clock, healthy regime (07-21 12:00Z → 07-26, median over 25 strategies): 3.11
//     model-authored rows/strategy/day and 4.22 consult rows/day ⇒ 12 model rows ≈ 3.9 days against
//     ≈ 7.1 days for 30 mixed rows. The window shortened, as intended.
//   - Wall clock, degraded regime (14d incl. the outage): 12 model rows spanned a MEDIAN 126h
//     against 42h for the last 30 consult rows — 3x LONGER, because model rows go scarce exactly
//     when noise rows go dense. renderDecisionLines labels entries "N decisions ago" with no
//     wall-clock cue, so during an outage the model reads week-old decisions as recent ones. Cost is
//     bounded either way (the cap is on rows, not on age); this is a fidelity caveat on the block's
//     framing, not a reason to shrink the cap.
//
// 12 CONFIRMED on those numbers.
const MAX_DECISION_HISTORY = 12;
const INDICATOR_WARMUP_CLOSES = 21;
const MAX_JOURNAL_RATIONALE_LEN = 2000;
// XA5 (A0 activation bundle): consecutive identical positioned-noop consults before the repeated-
// noop circuit breaker suppresses a symbol. 6 matches A0's spec (the Bug-B flat-loop burned ~55
// consults over 15h re-issuing an unexecuted close — 6 catches it in ~1.5h at the tightened
// 8-bar/2h fallback cadence while never tripping on a legitimately active symbol).
const NOOP_BREAKER_THRESHOLD = 6;
const NOOP_LOGGER: LoggerLike = { warn: () => undefined };

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

const HTF_TARGET_MS: Record<'h1' | 'h4', number> = { h1: 3_600_000, h4: 14_400_000 };
// Placeholder journal `model` value for callers that predate AgenticStrategyParams.model (e.g. the
// composition root's construction, wired for real by a later module-wiring task).
const DEFAULT_MODEL_ID = 'unknown';

// B3 (Design § Deleted scaffolding): W4.2's expectancy ladder is deleted outright (no strength
// rescaling anywhere in this strategy any more — sizing authority moved entirely to the model's own
// sizeFraction, C1). These three consts are RENAMED (not deleted) because computeTrackRecordContext
// below still feeds from the exact same trailing-window/floor definition — only the
// strength-modulating consumer (applyExpectancyLadder/computeExpectancyMultiplier) is gone.
// Mean netPnl (USD, Decimal-computed off the evidence port's decimal strings) over the last
// TRACK_RECORD_WINDOW_TRIPS CLOSED round trips for THIS strategyId; fewer than
// TRACK_RECORD_MIN_TRIPS ⇒ insufficient data ⇒ context omitted (see computeTrackRecordContext).
// RoundTripEvidencePort.recentRoundTrips is lane-wide, not strategyId-scoped (ports/trading/promotion.ts) —
// FETCH_LIMIT over-fetches so filtering down to this.id still has a chance of finding a full window
// in a multi-symbol deployment; the extra rows are discarded below.
const TRACK_RECORD_WINDOW_TRIPS = 15;
const TRACK_RECORD_FETCH_LIMIT = 60;
const TRACK_RECORD_MIN_TRIPS = 8;

// P4b (Design § Enriched model inputs — Track record + benchmark alpha). Candle history is siloed
// per-instance (cross-symbol-context.ts's header comment), so netVsBtcHoldBps is wired ONLY for the
// instance whose own symbol IS BTC_BENCHMARK_SYMBOL (benchmark-alpha.ts) — its siloed candle buffer
// genuinely holds real BTC closes, so this is real existing data, not an invented feed. Every other
// instance, and any window a BTC instance's buffer doesn't genuinely cover, resolves through the
// coverage guard to "omitted" (see computeBtcHoldAlpha). netVsEqualWeightBasketBps (W3 Part 2) draws
// instead on the shared PriceHistoryStore — see computeBasketHoldAlpha and
// AgentPortfolioBlock.correlation.btcBeta's OWN wiring (agent-portfolio-block.ts), which closes the
// identical gap that field's own header used to document.
// "Near" tolerance for the coverage guard: a benchmark candle within two bars of a window endpoint
// counts as covering it (a missed/delayed bar or a trip timestamp that lands a few seconds off a
// candle boundary must not flip real coverage into a false omission), but a buffer genuinely short
// of the window must still omit rather than silently compare a truncated span.
const BENCHMARK_COVERAGE_TOLERANCE_BARS = 2;

// Transport-reason gap fix (soak-flagged): mirrors anthropic-agent-client.ts's
// schemaRejectedRationale truncate pattern — a short single-line budget for the AgentProposeError
// detail persisted alongside kind/status (see recordErrorJournalEntry's own comment for why this
// message specifically is safe to persist).
const ERROR_JOURNAL_RATIONALE_DETAIL_MAX_LEN = 160;
function buildErrorJournalRationale(
  err: unknown,
  kind: string,
  status: number | undefined,
): string {
  const prefix = status !== undefined ? `${kind} (status ${status})` : kind;
  if (!(err instanceof AgentProposeError)) return prefix;
  const singleLine = err.message.replace(/\s*\n\s*/g, ' ').trim();
  const detail =
    singleLine.length > ERROR_JOURNAL_RATIONALE_DETAIL_MAX_LEN
      ? `${singleLine.slice(0, ERROR_JOURNAL_RATIONALE_DETAIL_MAX_LEN)}…`
      : singleLine;
  return `${prefix}: ${detail}`;
}

// Concrete agentic strategy: a thin in-process host-side shell that delegates each decision to the
// out-of-process agent client. It enriches the host's snapshot with computed indicators (own
// timeframe + aggregated HTF), the strategy's own position, and a rolling trail of its own past
// decisions before handing off — it still owns NO trading logic itself (Risk still sizes/vetoes
// every proposed signal). The agent's proposed signals flow through the Risk chokepoint (the host
// calls recordSignal); the host imposes the wall-clock timeout, so decide just enriches and
// delegates. Live access is EARNED via the promotion gate, never assumed (see ports/strategy/agentic-strategy.ts).
export class AgenticStrategy implements AsyncStrategy {
  readonly kind = 'agentic' as const;
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { readonly interval: CandleInterval; readonly bars: number };

  private readonly client: AgentClientPort;
  private readonly symbol: SymbolId;
  private readonly venue: VenueId;
  private readonly model: string;
  private readonly baseIntervalMs: number;
  private readonly journal?: AgentDecisionJournalPort;
  private readonly onClosedTrade?: (count: number) => void;
  private readonly onConsultGate?: (outcome: ConsultGateOutcome) => void;
  private readonly menuGate?: { isActive(symbol: string): boolean };
  private readonly logger: LoggerLike;
  private readonly entryTtlBars: number;
  private readonly planMode: boolean;
  private readonly wakeMovePct: number;
  private readonly fallbackConsultBars: number;
  // B2 consult-schedule state — tracked host-side regardless of planMode/activePlan (unlike
  // ActivePlanState, which only exists while a directive is armed): barsSinceConsult counts bars
  // since the last real consult (any trigger), reset to 0 the moment one happens; scheduledConsultBars
  // mirrors the most recent portfolio-level nextConsultBars (null ⇒ no schedule, the fallback cadence
  // governs); lastConsultPrice anchors the wake-on-move comparison. In-memory by design, same
  // convention as activePlan — a restart loses the schedule too, which is fine: a restart with an
  // open position ALWAYS forces an immediate re-arm consult (see evaluateConsultSchedule), which
  // re-establishes a fresh schedule on its very first real decision.
  private barsSinceConsult = 0;
  private scheduledConsultBars: number | null = null;
  private lastConsultPrice: number | null = null;
  private readonly planExitTtlBars: number;
  private readonly quietPayloadSampleBars: number;
  // W3.1 active managed plan — in-memory by design: a restart loses it, the position_open prescreen
  // then forces a consult, and the model re-arms by attaching a plan to its 'hold' (it sees no
  // `directives` key in the position summary, B3's replacement for managedPlan: false; the client
  // accepts a re-arm plan while LONG — see anthropic-agent-client.ts). Before that path existed
  // the "model issues a fresh plan"
  // self-heal was aspirational: the model had no signal the plan was gone and the client dropped
  // any plan outside long-from-flat, so restarts silently degraded positions to per-bar consults.
  private activePlan: ActivePlanState | null = null;
  // B3: the model's own persisted thesis (AgentDirectives.thesis) for the CURRENT activePlan's
  // lifetime — in-memory by design, same convention as activePlan itself (a restart loses both
  // together). Set whenever a directive-bearing decision supplies one; cleared through the SAME
  // clearPlan() choke point that drops activePlan. See buildContext's currentThesis rendering.
  private lastThesis: string | undefined;
  private readonly trackRecordEnabled: boolean;
  private readonly crossSymbolEnabled: boolean;
  private readonly crossSymbolLookbackBars: number;
  private readonly evidence?: RoundTripEvidencePort;
  private readonly derivativesFeed?: DerivativesFeedPort;
  private readonly sentimentFeed?: SentimentFeedPort;
  private readonly fearGreedFeed?: FearGreedFeedPort;
  private readonly tradeFlowFeed?: TradeFlowFeedPort;
  private readonly positioningFeed?: PositioningFeedPort;
  private readonly liquidationFeed?: LiquidationFeedPort;
  private readonly crossSymbolContext?: CrossSymbolContextService;
  private readonly edgePolicy?: EdgePolicyPort;
  // W3 Part 2 — see AgenticStrategyDeps.priceHistory's own comment.
  private readonly priceHistory?: PriceHistoryStore;
  private readonly venueTpEnabled: boolean;
  private readonly venueTpReplaceDriftBps: number;
  private readonly venueTpTickSize?: string;
  private readonly venueTpStepSize?: string;
  private readonly onVenueTp?: (event: VenueTpEvent) => void;
  // Plan-stop watcher (Push 3 P2) — see AgenticStrategyDeps.planStopRegistry's own comment.
  private readonly planStopRegistry?: PlanStopRegistryPort;
  // Push 3 P7c — see AgenticStrategyDeps.intentStore's own comment.
  private readonly intentStore?: Pick<ExecutionStorePort, 'loadIntentByClientOrderId'>;
  // Push 3 P7d — see AgenticStrategyParams'/AgenticStrategyDeps' own comments on each field.
  private readonly venueStopEnabled: boolean;
  private readonly venueStopReplaceDriftBps: number;
  private readonly venueStopTickSize?: string;
  private readonly venueStopStepSize?: string;
  private readonly stopLimitBufferBps: number;
  private readonly planStopForceBps: number;
  private readonly maxPlannedStopRiskFraction: string;
  private readonly sizingEquityCap?: string;
  private readonly onVenueStop?: (event: VenueStopEvent) => void;
  private readonly onRearmFallback?: () => void;
  private readonly bookSnapshot?: () => PortfolioSnapshot;
  private readonly algoOrders?: Pick<ExchangePort, 'fetchOpenAlgoOrders' | 'cancelAlgoOrder'>;
  // Defect A commit-1 — see AgenticStrategyDeps.onAlgoStopGone's own comment.
  private readonly onAlgoStopGone?: (
    symbol: SymbolId,
  ) => Promise<'triggered' | 'canceled' | 'none' | 'unknown'>;
  // I1b — see AgenticStrategyDeps.onCandleMetrics' own comment.
  private readonly onCandleMetrics?: (symbol: SymbolId, candles: readonly CandleEvent[]) => void;
  // Warn-once bookkeeping for an unknown-role resting order on the exit side (see roleForOrder /
  // restingOrderForRole) — pruned to the currently-open set each cycle, same convention as
  // entryFirstSeen/entryCancelRequestedAt below.
  private readonly unknownRoleWarned = new Set<string>();
  // W2.1 stale-entry sweep state. OpenOrderSummary carries no timestamps, so age is measured in
  // observed decide cycles: clientOrderId → the snapshot eventTime this strategy FIRST saw the order
  // resting. cancelRequestedAt records when a CANCEL_OPEN was emitted for an id so it isn't re-spammed
  // every bar, but re-arms after another TTL window (covers a lost/failed cancel). Both prune to the
  // currently-open set each cycle; in-memory by design — after a restart, ages restart at zero and a
  // still-resting order is swept AGENTIC_ENTRY_TTL_BARS later (this is also the organic cleanup path
  // for legacy resting orders recovered at boot).
  private readonly entryFirstSeen = new Map<string, EpochMs>();
  private readonly entryCancelRequestedAt = new Map<string, EpochMs>();
  // Venue minimum-notional for this symbol, captured in onInit. Used only to reclassify a sub-minimum
  // "dust" position as flat in the agent's view (see buildContext). null ⇒ unavailable ⇒ no
  // reclassification (fail safe to the prior LONG-when-any-qty behavior).
  private minNotional: Price | null = null;

  // Ring buffer of past MODEL-AUTHORED decisions, newest-last, capped — self-consistency context
  // handed to the agent each call (see the isModelAuthoredDecision gate at the single push site for
  // what is excluded and why). The client itself stays stateless; this trail lives host-side in the
  // strategy. Bound proof: MAX_DECISION_HISTORY caps this via the shift() right after that push, and
  // its ONLY consumer — `recentDecisions: [...this.history]` — is spread in full and rendered
  // unconditionally by agent-prompt.ts's renderDecisionLines (iterates recentDecisions.length, no
  // independent slice(-N)). No reader ever needs more than the cap already retains, so the cap is
  // the proven bound; this array can never grow past it.
  private readonly history: AgentDecisionRecord[] = [];
  // Combined (realized + unrealized) PnL at the time the most recently pushed, not-yet-annotated
  // history record was made — diffed against the next call's combined PnL to fill that record's
  // outcome.positionPnlDelta just before it is superseded by the new decision.
  private lastCombinedPnl: Decimal | null = null;
  // Push II Phase 8: widened to include 'SHORT' — a shorts-disabled deployment's position can never
  // actually be SHORT (buildContext/position-sizer never assign it), so this stays byte-identical.
  private lastPositionSide: 'LONG' | 'SHORT' | 'FLAT' | null = null;
  // XA5 (A0 activation bundle): repeated-noop circuit breaker state. Tracks consecutive consults
  // that emitted the SAME action while POSITIONED with NO change to position qty/side — the Bug-B
  // signature (a stuck 'close'/'flat' re-issued every bar because the exit could not execute burned
  // ~55 consults over 15h). A flat symbol holding is NOT a noop for this purpose (that is normal
  // quiet the scheduler already governs, and XA3 wants those consulting) — only a positioned symbol
  // repeating an ineffective action counts. On breach the symbol is suppressed until its position
  // state changes; cleared by any position delta, a fill, or a non-repeat action.
  private noopStreak = 0;
  private noopLastAction: string | null = null;
  private noopLastPosKey: string | null = null;
  private noopSuppressed = false;
  private closedTrades = 0;

  constructor(
    id: StrategyId,
    params: AgenticStrategyParams,
    client: AgentClientPort,
    deps: AgenticStrategyDeps = {},
  ) {
    this.id = id;
    this.client = client;
    this.symbol = params.symbol;
    this.venue = params.venue;
    this.model = params.model ?? DEFAULT_MODEL_ID;
    this.baseIntervalMs = INTERVAL_MS[params.interval];
    this.journal = deps.journal;
    this.onClosedTrade = deps.onClosedTrade;
    this.onConsultGate = deps.onConsultGate;
    this.menuGate = deps.menuGate;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.entryTtlBars = params.entryTtlBars ?? 0;
    this.planMode = params.planMode ?? false;
    this.wakeMovePct = params.wakeMovePct ?? 0.015;
    this.fallbackConsultBars = Math.max(1, params.fallbackConsultBars ?? 16);
    this.planExitTtlBars = Math.max(2, params.planExitTtlBars ?? 2);
    this.quietPayloadSampleBars = Math.max(0, params.quietPayloadSampleBars ?? 0);
    this.trackRecordEnabled = params.trackRecordEnabled ?? false;
    this.crossSymbolEnabled = params.crossSymbolEnabled ?? false;
    this.crossSymbolLookbackBars = Math.max(1, params.crossSymbolLookbackBars ?? 20);
    this.evidence = deps.evidence;
    this.derivativesFeed = deps.derivativesFeed;
    this.sentimentFeed = deps.sentimentFeed;
    this.fearGreedFeed = deps.fearGreedFeed;
    this.tradeFlowFeed = deps.tradeFlowFeed;
    this.positioningFeed = deps.positioningFeed;
    this.liquidationFeed = deps.liquidationFeed;
    this.crossSymbolContext = deps.crossSymbolContext;
    this.edgePolicy = deps.edgePolicy;
    this.priceHistory = deps.priceHistory;
    this.venueTpEnabled = params.venueTpEnabled ?? false;
    this.venueTpReplaceDriftBps = Math.max(0, params.venueTpReplaceDriftBps ?? 10);
    this.venueTpTickSize = params.venueTpTickSize;
    this.venueTpStepSize = params.venueTpStepSize;
    this.onVenueTp = deps.onVenueTp;
    this.planStopRegistry = deps.planStopRegistry;
    this.intentStore = deps.intentStore;
    this.venueStopEnabled = params.venueStopEnabled ?? false;
    this.venueStopReplaceDriftBps = Math.max(0, params.venueStopReplaceDriftBps ?? 10);
    this.venueStopTickSize = params.venueStopTickSize;
    this.venueStopStepSize = params.venueStopStepSize;
    this.stopLimitBufferBps = params.stopLimitBufferBps ?? 50;
    this.planStopForceBps = Math.max(0, params.planStopForceBps ?? 30);
    this.maxPlannedStopRiskFraction = params.maxPlannedStopRiskFraction ?? '0';
    this.sizingEquityCap = params.sizingEquityCap;
    this.onVenueStop = deps.onVenueStop;
    this.onRearmFallback = deps.onRearmFallback;
    this.bookSnapshot = deps.bookSnapshot;
    this.algoOrders = deps.algoOrders;
    this.onAlgoStopGone = deps.onAlgoStopGone;
    this.onCandleMetrics = deps.onCandleMetrics;
    this.subscriptions = {
      venue: params.venue,
      symbols: [params.symbol],
      channels: { candles: [params.interval] },
    };
    this.warmup = { interval: params.interval, bars: params.warmupBars };
  }

  onInit(ctx: StrategyInitContext): void {
    // Capture the venue minimum-notional for this symbol so buildContext can treat a sub-minimum
    // "dust" position as flat (see its own comment). Absent ⇒ null ⇒ no dust reclassification.
    this.minNotional = ctx.symbolConstraints.get(this.symbol)?.minNotional ?? null;
  }

  // Plan-stop watcher (Push 3 P2): the single choke point for dropping activePlan, so the plan-stop
  // registry (ProtectiveExitService's tick reads it) can never outlive the plan it describes. Every
  // `this.activePlan = null` site in this file routes through here instead of assigning directly.
  private clearPlan(): void {
    this.activePlan = null;
    // B3: the persisted thesis belongs to the plan's own lifetime — a cleared plan means a fresh
    // consult starts the next position cold, same as a restart.
    this.lastThesis = undefined;
    this.planStopRegistry?.clear(positionKey(this.id, this.venue, this.symbol));
  }

  // Populates the plan-stop registry whenever entryPrice (re)captures in runActivePlan — see that
  // call site's own comment, which covers a fresh entry fill, the restart re-arm, AND a same-side
  // scale-in's delayed fill (entryPrice re-anchoring off its pendingScaleInQty baseline) identically.
  // Mirrors plan-executor.ts's own stop-price
  // formula exactly (entry × (1∓stopLossPct), no additional rounding) so the watcher's crossing
  // check can never disagree with the executor's own bar-close check. venueStopResting is always
  // false here — no venue-side stop order exists yet at entry-fill time; manageVenueStop (Push 3
  // P7d, AGENTIC_VENUE_STOP) flips it true later, only once a placed stop is CONFIRMED resting.
  private setPlanStop(active: ActivePlanState, isShort: boolean): void {
    if (!this.planStopRegistry || active.entryPrice === null) return;
    const entry = new Decimal(active.entryPrice);
    const stopPrice = isShort
      ? entry.mul(new Decimal(1).plus(active.plan.stopLossPct))
      : entry.mul(new Decimal(1).minus(active.plan.stopLossPct));
    this.planStopRegistry.set(positionKey(this.id, this.venue, this.symbol), {
      side: isShort ? 'SHORT' : 'LONG',
      stopPrice: stopPrice.toFixed(),
      venueStopResting: false,
    });
  }

  async decide(rawInput: AgentDecisionInput): Promise<Signal[]> {
    // C1: thread fresh feed snapshots (derivatives, sentiment, trade-flow, positioning, liquidation)
    // onto the host-supplied snapshot before anything else reads `input` — every downstream use
    // (buildContext, staleEntryCancels, client.propose, the quiet-hold journal sample) sees the
    // same enriched snapshot. No-op (same object) when a feed isn't wired or has no fresh poll, so
    // that deployment stays byte-identical.
    const input = this.withLiquidation(
      this.withPositioning(
        this.withTradeFlow(this.withFearGreed(this.withSentiment(this.withDerivatives(rawInput)))),
      ),
    );
    // Deterministic and prescreen-independent: resting GTC entries otherwise rest forever (nothing
    // enforces expiresAt on ACKED orders — boot 10c8af0c recovered 55 of them). Computed first so
    // both the quiet-hold path and the LLM path return it.
    const staleCancels = this.staleEntryCancels(input);
    const context = this.buildContext(input);
    // Push 3 P7f fix 7b: boot/restart orphan check — see reconcileOrphanedAlgoStop's own header
    // comment. No-op unless planMode+venueStopEnabled+perp AND there is no active plan tracking this
    // reconcile already (the normal case, every bar with a live plan).
    if (this.planMode) await this.reconcileOrphanedAlgoStop(context);
    // Captured before trackClosedTrade advances lastPositionSide to THIS call's side — this is the
    // side the strategy was actually carrying while the PREVIOUS (still-unannotated) decision's
    // outcome accrued, which is what annotatePreviousOutcome needs to render "(held long)"/"(flat)"
    // against the right decision. null (never annotated before) is treated as FLAT — the strategy
    // starts flat.
    const heldDuringPrev = this.lastPositionSide ?? 'FLAT';
    this.trackClosedTrade(context.position.side);

    // B2: the single per-bar consult-schedule decision (Design § Deleted scaffolding) — computed
    // ONCE, before either branch below, so both the plan-managed quiet-bar path and the no-plan path
    // consult on exactly the SAME gate (see evaluateConsultSchedule's own header comment for the
    // priority order). barsSinceConsult increments every decide() call and resets to 0 the moment a
    // real consult happens (below); it is a strategy-level clock, distinct from ActivePlanState.
    // barsElapsed (the plan's OWN hold-duration clock, untouched here — B1/B3 territory).
    this.barsSinceConsult += 1;
    const gateCandles = input.snapshot.candles.get(this.symbol) ?? [];
    const gateLastCandle = gateCandles.length > 0 ? gateCandles[gateCandles.length - 1] : undefined;
    // I1b (Design § Universe): fire-and-forget, cheap (storage-only on the scanner side) — only on
    // an actual candle-close trigger, not every ticker/book/exec decide() call, so a busy tick stream
    // never re-derives the same ATR/volume metrics redundantly.
    if (input.trigger.kind === 'candle') this.onCandleMetrics?.(this.symbol, gateCandles);
    const gate = evaluateConsultSchedule({
      state: {
        barsSinceConsult: this.barsSinceConsult,
        scheduledConsultBars: this.scheduledConsultBars,
        lastConsultPrice: this.lastConsultPrice,
      },
      isExecTrigger: input.trigger.kind === 'exec',
      // Restart re-arm (Design bullet d): an open position this strategy is NOT currently managing
      // via activePlan — either a fresh restart (in-memory plan lost) or planMode is off entirely (no
      // directive concept at all, so any open position is "without directives" every bar — mirrors
      // prescreen.ts's own positionOpen⇒consult behavior for a non-plan-mode deployment).
      hasOpenPositionWithoutDirectives:
        (context.position.side === 'LONG' || context.position.side === 'SHORT') &&
        this.activePlan === null,
      lastClose: gateLastCandle ? toIndicatorNumber(gateLastCandle.close) : null,
      wakeMovePct: this.wakeMovePct,
      fallbackConsultBars: this.fallbackConsultBars,
      menuActive: this.menuGate?.isActive(String(this.symbol)) ?? true,
      noopSuppressed: this.noopSuppressed,
    });
    this.onConsultGate?.(gate);
    const consultNow = gate !== 'skipped_scheduled';

    // W3.1: an active plan is managed deterministically between consults — its OWN terminal verdicts
    // (stop/TP/max_hold exit, position_closed, cancel_entry/plan_expired) always run first and fully
    // own the bar when they fire, regardless of the gate above (a breach must never wait out a due
    // consult). Only the plan's 'hold' tail defers to the gate: null ⇒ fall through to a real consult
    // this bar (skipping venue-TP/stop reconciliation, same as the pre-B2 cadence-triggered
    // fallthrough); non-null ⇒ this bar stays quiet and fully managed (venue reconciliation runs).
    if (this.planMode && this.activePlan) {
      const planSignals = await this.runActivePlan(input, context, heldDuringPrev, consultNow);
      if (planSignals !== null) return [...staleCancels, ...planSignals];
    }

    if (!consultNow) {
      return [
        ...staleCancels,
        ...this.recordQuietHold(input, context, heldDuringPrev, this.consultScheduleRationale()),
      ];
    }

    // Push 3 P6 Unit 4: fetched HERE (not inside buildContext, which is synchronous) and only right
    // before the one call site that actually renders it to the model — the plan-managed/quiet-bar
    // paths above never reach this line, so a bar the LLM isn't even consulted on never spends
    // an extra evidence-port round trip on track-record context it would never send.
    const trackRecordCtx = await this.computeTrackRecordContext(gateCandles);
    const edgePolicyCtx = this.computeEdgePolicyContext(input.snapshot.eventTime);
    let proposal: AgentProposal;
    try {
      proposal = await this.client.propose({
        ...input,
        context: { ...context, ...trackRecordCtx, ...edgePolicyCtx },
      });
    } catch (err) {
      this.recordErrorJournalEntry(input, err);
      throw err;
    }
    proposal = this.enforcePlannedStopRiskOnPlanUpdate(proposal, context);

    // B3 (Design § Deleted scaffolding): the expectancy ladder is deleted — sizing/strength
    // authority lives entirely with the model's own sizeFraction (C1) now, so signals pass through
    // unmodified (no strength rescaling anywhere in this strategy).
    const signals = proposal.signals;
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const lastClose = lastCandle ? toIndicatorNumber(lastCandle.close) : NaN;

    // B2: this bar just consulted (any trigger reaches here — the gate above already returned early
    // otherwise) — reset the schedule clock, adopt the portfolio's freshly-returned nextConsultBars
    // (absent ⇒ no schedule; the fallback cadence governs until one is set again), and anchor the
    // wake-on-move baseline to THIS consult's own close.
    this.barsSinceConsult = 0;
    this.scheduledConsultBars = proposal.nextConsultBars ?? null;
    if (Number.isFinite(lastClose)) this.lastConsultPrice = lastClose;

    // decision is the client's own account when present; the stub client (and any client that
    // omits it) leaves this to a signal-inferred fallback so the decision trail stays populated.
    const decision = proposal.decision ?? this.inferStubDecision(signals);

    // XA5: repeated-noop breaker bookkeeping (runs on the consult that just happened). Only a
    // POSITIONED symbol repeating the SAME action with NO position-state change counts — a flat
    // hold is normal quiet, not a stuck loop. posKey folds side + signed qty so any fill or resize
    // resets the streak. On the Nth identical positioned noop the symbol is suppressed until its
    // position changes (see the gate above); the suppression is loud (alarm) because a stuck loop is
    // a defect, never expected steady state.
    this.updateNoopBreaker(context.position, decision.action);

    this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);

    // 2026-07-30: only rows the MODEL actually authored enter the ring. A latched no-call ('error'),
    // a post-200 degrade, and the off-menu/budget-exhausted pre-call short-circuits are lane-health
    // facts, not decisions — and the system prompt's own framing of this block ("the action/close/
    // reason YOU gave on a prior call") was false for every one of them. Share of ring lines they
    // held is regime-dependent (re-measured 2026-07-30, see MAX_DECISION_HISTORY): 382 of 405 during
    // the provider outage that prompted this filter, 13.2% across the healthy week before it. Nothing is lost: all of them are already persisted in agent_decisions.rationale
    // and metered by trading-runtime's outcomeForProposal. A 'plan_authoritative_close:' row IS
    // model-authored (the consult was healthy; the system overrode the exit) and still enters.
    // The journal write below is deliberately NOT filtered — the trail stays complete on disk.
    if (isModelAuthoredDecision(decision.action, decision.rationale)) {
      this.history.push({
        eventTime: input.snapshot.eventTime,
        action: decision.action,
        close: lastClose,
        // Truncated to the same bound the client itself applies to a fresh rationale (MAX_REASON_LEN)
        // before this re-enters a later prompt as recentDecisions — an un-truncated rationale (up to
        // MAX_JOURNAL_RATIONALE_LEN) would otherwise carry ~10x more unframed prior-model free text
        // into every subsequent call than the playbook's own DATA-framed block does.
        reason: decision.rationale.slice(0, MAX_REASON_LEN),
      });
      if (this.history.length > MAX_DECISION_HISTORY) this.history.shift();
    }

    this.recordJournalEntry(input, decision, proposal);

    // B3 (Design § Model-owned exits, § New tool contract action mapping) plan bookkeeping, branched
    // on the proposal's own action + whether directives were returned at all:
    //  - action 'adjust' while an activePlan is already active: MERGE the revised directive set IN
    //    PLACE — entryPrice/barsElapsed/venue in-flight markers are ActivePlanState fields, untouched
    //    by reassigning only `.plan`. direction is PINNED from the prior plan (never re-derived from
    //    the new directive set — AgentDirectives.direction's own header comment: "ignored on a
    //    same-side re-arm, where the position's own side wins"), and setPlanStop re-runs only when
    //    stopLossPct actually changed (the registry price must track the current directive without
    //    spamming redundant writes on an unrelated adjust, e.g. a takeProfitPct-only revision).
    //  - directives present otherwise (a fresh open_long/open_short from FLAT, a same-side scale-in
    //    while already positioned, the legacy 'long' tool, or the restart re-arm — hold+directives
    //    while already positioned with no in-memory plan): REPLACES the plan wholesale with a fresh
    //    clock (barsElapsed: 0). entryPrice: a fresh FLAT->open or a restart re-arm has no pending
    //    fill to protect, so it starts null and captures on the next managed bar as before. A
    //    same-side scale-in (prior !== null, already LONG/SHORT) is different: the add's own fill can
    //    lag bars behind this decision (a resting maker order), so nulling entryPrice here would let
    //    runActivePlan capture the PRE-scale-in avgEntry on the very next bar and freeze there
    //    forever once the add later fills (review finding, minor). Instead the prior entryPrice
    //    carries forward (protection stays anchored to the still-accurate old entry) and
    //    pendingScaleInQty records the pre-fill qty baseline — runActivePlan re-anchors to the
    //    post-fill avgEntry once the qty actually moves off that baseline.
    //  - directives absent AND action is 'close' (v2) or 'flat' (legacy): the exit signal above
    //    already closes the position the plan was managing — clearPlan() drops the directive state.
    //  - 'hold'/any other inert case with no directives: activePlan (and lastThesis) untouched.
    // Client-mapping defensiveness (A1 lands separately): branches key off decision.action + whether
    // proposal.plan is present, never off action alone — a client that hasn't finished the v2
    // action mapping yet (still emitting the pre-B3 "plan present ⇒ always replace" shape) degrades
    // to the same wholesale-replace branch this file always took, never a compile or runtime error.
    const orphanEntryCancels: Signal[] = [];
    if (this.planMode) {
      const prior = this.activePlan;
      if (proposal.plan) {
        if (decision.action === 'adjust' && this.activePlan) {
          const merged = { ...proposal.plan, direction: this.activePlan.plan.direction };
          const stopChanged = this.activePlan.plan.stopLossPct !== merged.stopLossPct;
          this.activePlan = { ...this.activePlan, plan: merged };
          if (stopChanged) this.setPlanStop(this.activePlan, merged.direction === 'short');
        } else {
          const isScaleIn = prior !== null && context.position.side !== 'FLAT';
          this.activePlan = {
            plan: proposal.plan,
            entryPrice: isScaleIn ? prior.entryPrice : null,
            barsElapsed: 0,
            venueTpPlacedAtBar: null,
            venueStopPlacedAtBar: null,
            pendingScaleInQty: isScaleIn ? context.position.qty : null,
          };
        }
        if (proposal.plan.thesis !== undefined) this.lastThesis = proposal.plan.thesis;
      } else if (decision.action === 'flat' || decision.action === 'close') {
        this.clearPlan();
      }
      // Review finding (shorts round 2): the stale-entry sweep derives its side from the CURRENT
      // plan direction, so a cleared/direction-flipped plan whose entry still rests (only possible
      // with planMaxQuietBars < entryValidityBars — unreachable at deployed defaults 16 vs max 8)
      // would leave that entry unsweepable and it could later fill into an unmanaged position.
      // Cancel the outgoing plan's own entry side at the moment of clear/flip, FLAT only (a
      // non-FLAT position means the entry filled — the exit paths own those orders).
      const priorDirection = prior?.plan.direction === 'short' ? 'short' : 'long';
      const newDirection =
        this.activePlan?.plan.direction === 'short' ? 'short' : ('long' as const);
      if (
        prior !== null &&
        (this.activePlan === null || priorDirection !== newDirection) &&
        context.position.side === 'FLAT'
      ) {
        const priorEntrySide: 'BUY' | 'SELL' = priorDirection === 'short' ? 'SELL' : 'BUY';
        const lastCandle = (input.snapshot.candles.get(this.symbol) ?? []).at(-1);
        if (lastCandle && this.restingOrderForSide(input, priorEntrySide)) {
          orphanEntryCancels.push(
            this.buildCancelOpenSignal(
              input,
              lastCandle,
              priorEntrySide,
              `plan ${this.activePlan === null ? 'cleared' : 'direction flipped'}: cancel the outgoing plan's resting ${priorEntrySide} entry`,
            ),
          );
        }
      }
    }

    // Fail-closed re-arm fallback (2026-07-24): a restart leaves activePlan null; forced_rearm
    // consults every bar until directives attach. The v2 rewrite dropped the client's hold→plan
    // branch, and even with that restored the model still sometimes returns a bare hold/adjust.
    // Leaving the position unmanaged forever burns LLM spend and skips venue-stop placement
    // (manageVenueStop only runs inside runActivePlan). Attach a conservative protective plan so
    // the next quiet bar places the resting stop; the model can revise via 'adjust' on a later
    // consult. Never synthesize on close/flat (those clear). Never overwrite a plan just attached.
    if (
      this.planMode &&
      this.activePlan === null &&
      (context.position.side === 'LONG' || context.position.side === 'SHORT') &&
      decision.action !== 'close' &&
      decision.action !== 'flat'
    ) {
      const isShort = context.position.side === 'SHORT';
      this.activePlan = {
        plan: {
          sizeFraction: '0.01',
          stopLossPct: AGENTIC_MAX_STOP_LOSS_PCT,
          takeProfitPct: '0.02',
          entryOffsetBps: 0,
          entryValidityBars: 1,
          maxHoldBars: 96,
          entryStyle: 'maker',
          direction: isShort ? 'short' : 'long',
          thesis:
            '[rearm-fallback] synthetic protective plan — model returned no directives while positioned',
        },
        entryPrice: null,
        barsElapsed: 0,
        venueTpPlacedAtBar: null,
        venueStopPlacedAtBar: null,
        pendingScaleInQty: null,
      };
      this.logger.warn(
        `re-arm fallback: ${this.symbol} positioned ${context.position.side} but consult returned ${decision.action} without directives — attaching protective defaults (stop=${AGENTIC_MAX_STOP_LOSS_PCT})`,
      );
      this.onRearmFallback?.();
    }

    return [...staleCancels, ...orphanEntryCancels, ...signals];
  }

  // The sizer owns entry risk, but an in-place plan update emits no Signal and therefore never
  // reaches it. Reject only stop widenings on an already-managed position; equal/tighter stops and
  // restart re-arms remain unchanged. The full-book snapshot is the same source the sizer uses, so
  // held + in-flight cost-notional cannot diverge between the two guards.
  private enforcePlannedStopRiskOnPlanUpdate(
    proposal: AgentProposal,
    context: AgentContext,
  ): AgentProposal {
    if (
      proposal.plan === undefined ||
      this.activePlan === null ||
      context.position.side === 'FLAT'
    ) {
      return proposal;
    }

    try {
      const fraction = new Decimal(this.maxPlannedStopRiskFraction);
      if (fraction.isZero()) return proposal;
      if (!fraction.isFinite() || fraction.lt(0)) {
        return this.rejectPlannedStopRiskUpdate(proposal, 'invalid configured risk fraction');
      }

      const priorStop = new Decimal(this.activePlan.plan.stopLossPct);
      const nextStop = new Decimal(proposal.plan.stopLossPct);
      if (!priorStop.isFinite() || !nextStop.isFinite() || nextStop.lte(0)) {
        return this.rejectPlannedStopRiskUpdate(proposal, 'invalid proposed stop');
      }
      if (nextStop.lte(priorStop)) return proposal;

      const snapshot = this.bookSnapshot?.();
      if (snapshot === undefined) {
        return this.rejectPlannedStopRiskUpdate(proposal, 'book snapshot unavailable');
      }
      const pos = snapshot.positions.get(positionKey(this.id, this.venue, this.symbol));
      if (pos === undefined || pos.signedQty.isZero()) {
        return this.rejectPlannedStopRiskUpdate(proposal, 'attributed position unavailable');
      }

      const cap = this.sizingEquityCap;
      let cappedEquity = snapshot.equity;
      if (cap !== undefined) {
        const parsedCap = new Decimal(cap);
        if (!parsedCap.isFinite() || parsedCap.lt(0)) {
          return this.rejectPlannedStopRiskUpdate(proposal, 'invalid sizing equity cap');
        }
        if (parsedCap.gt(0)) cappedEquity = Decimal.min(cappedEquity, parsedCap);
      }
      if (!cappedEquity.isFinite() || cappedEquity.lte(0)) {
        return this.rejectPlannedStopRiskUpdate(proposal, 'invalid capped equity');
      }

      const entrySide: 'BUY' | 'SELL' = pos.signedQty.isNegative() ? 'SELL' : 'BUY';
      let consumed = pos.signedQty.abs().mul(pos.avgEntry);
      for (const intent of snapshot.inFlightIntents) {
        if (
          intent.reduceOnly ||
          intent.strategyId !== this.id ||
          intent.venue !== this.venue ||
          intent.symbol !== this.symbol ||
          intent.side !== entrySide
        ) {
          continue;
        }
        // Deliberate over-reservation on partial fills: the filled leg is already in `pos`, while
        // the original in-flight qty remains counted here. This can only reject/under-size.
        consumed = consumed.add(intent.qty.mul(intent.limitPrice ?? intent.refPrice));
      }

      const maxNotional = plannedStopNotionalCap(cappedEquity, fraction, nextStop);
      return consumed.lte(maxNotional)
        ? proposal
        : this.rejectPlannedStopRiskUpdate(
            proposal,
            `widened stop implies ${consumed.toFixed()} notional above ${maxNotional.toFixed()} cap`,
          );
    } catch {
      return this.rejectPlannedStopRiskUpdate(proposal, 'unparseable planned-stop inputs');
    }
  }

  private rejectPlannedStopRiskUpdate(proposal: AgentProposal, reason: string): AgentProposal {
    this.logger.warn(`planned-stop risk: rejected plan update for ${this.symbol} — ${reason}`);
    return {
      ...proposal,
      signals: [],
      plan: undefined,
      decision: {
        action: 'hold',
        confidence: null,
        rationale:
          `[rejected: planned stop risk cap] ${proposal.decision?.rationale ?? reason}`.slice(
            0,
            MAX_REASON_LEN,
          ),
      },
    };
  }

  // W3.1 per-bar management of the active plan. Non-null return = this bar is fully handled without
  // an LLM call; null = fall through to the normal consult path. B2: consultNow is the SAME
  // consult-schedule gate decide() already computed for this bar (evaluateConsultSchedule) — this
  // method's own terminal verdicts (exit/position_closed/cancel_entry/plan_expired) always run
  // first regardless of it; only the 'hold' tail below defers to it.
  private async runActivePlan(
    input: AgentDecisionInput,
    context: AgentContext,
    heldDuringPrev: 'LONG' | 'SHORT' | 'FLAT',
    consultNow: boolean,
  ): Promise<Signal[] | null> {
    const active = this.activePlan!;
    active.barsElapsed += 1;
    // Push II Phase 8: which side this plan manages — 'short' rests a SELL entry / manages a SHORT
    // position; absent (or 'long') is the pre-Phase-8 default. Never re-derived from context.position
    // mid-plan (a re-arm keeps the position's own side, never the model's plan.direction — see
    // anthropic-agent-client.ts's rearm handling), so this reads the STORED plan's own direction only.
    const isShort = active.plan.direction === 'short';
    const entrySide: 'BUY' | 'SELL' = isShort ? 'SELL' : 'BUY';
    const tpSide: 'BUY' | 'SELL' = isShort ? 'BUY' : 'SELL';

    // Capture the realized entry price on the first bar the position shows the plan's managed side
    // (LONG or SHORT) — the executor's stop/TP levels anchor to the actual average fill, not the
    // plan's intended offset price. This is ALSO the boot re-arm site: a restart loses activePlan
    // in-memory, the model re-attaches one via 'hold'+plan while already LONG/SHORT (entryPrice:
    // null — see the decide() bookkeeping above), and the re-armed plan reaches this exact branch on
    // its first managed bar, same as a fresh entry fill — there is no separate restore path.
    // Same site re-anchors a same-side SCALE-IN too (review finding, minor): decide() carries the
    // PRIOR entryPrice forward instead of nulling it (pendingScaleInQty non-null there), so the plan
    // stays protected off the old anchor while the add's maker order is still resting. Once the
    // position's qty actually diverges from that pre-fill baseline — the add has filled — this
    // re-captures entryPrice from the SAME authoritative source (context.position.avgEntry, already
    // VWAP-blended by the fill path) rather than freezing on the stale pre-scale-in value forever.
    const scaleInFilled =
      active.pendingScaleInQty !== null && context.position.qty !== active.pendingScaleInQty;
    if (
      (context.position.side === 'LONG' || context.position.side === 'SHORT') &&
      (active.entryPrice === null || scaleInFilled)
    ) {
      active.entryPrice = context.position.avgEntry;
      active.pendingScaleInQty = null;
      this.setPlanStop(active, isShort);
    }

    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    if (!lastCandle) return null; // no basis bar — let the normal path decide

    // Push II Phase 8: mirrored — a SHORT plan's resting (unfilled) entry is a SELL, not a BUY.
    const hasRestingEntry = input.snapshot.portfolio.openOrders.some(
      (o) => o.symbol === this.symbol && o.side === entrySide,
    );
    const state: PlanExecutorState = {
      plan: active.plan,
      entryPrice: active.entryPrice,
      planStartedBar: 0,
      barsElapsed: active.barsElapsed,
    };
    const rawVerdict = evaluatePlan({
      state,
      closePrice: lastCandle.close.toFixed(),
      positionSide: context.position.side,
      hasRestingEntry,
    });
    // AGENTIC_VENUE_TP/AGENTIC_VENUE_STOP off: byte-identical to the pre-position_closed
    // evaluatePlan, which never inspected entryPrice in the FLAT branch — an
    // externally-flattened-while-active-plan bar (the only way FLAT+entryPrice!==null arises
    // without a resting venue TP/stop) fell through to the ordinary resting-entry/expiry checks
    // instead. plan-executor.ts stays a pure, flag-unaware function (see its own header comment), so
    // the remap lives here rather than there. Push 3 P7d: a venue-stop-only deployment (TP off, stop
    // on) needs the SAME unmapped 'position_closed' path — the stop can fill externally too — so the
    // remap only fires when NEITHER venue-resting mechanism is enabled.
    const verdict: PlanExecutorAction =
      rawVerdict.type === 'position_closed' && !this.venueTpEnabled && !this.venueStopEnabled
        ? active.barsElapsed >= active.plan.entryValidityBars
          ? hasRestingEntry
            ? { type: 'cancel_entry' }
            : { type: 'plan_expired' }
          : { type: 'hold' }
        : rawVerdict;

    const lastClose = toIndicatorNumber(lastCandle.close);

    if (verdict.type === 'position_closed') {
      // Only reachable when venueTpEnabled or venueStopEnabled (see the remap above) — one of the
      // resting venue orders filled between bars (or an external flatten while they were in place),
      // so the position is already FLAT: no exit signal to emit, just clear the plan. Which one
      // actually filled is never inspected — both roles are checked and whichever still rests is
      // cancelled as an orphan (this is the "TP fills → cancel resting stop" / "stop fills → cancel
      // resting TP" mirror pair, Push 3 P7d — position_closed is the single site both directions
      // share, since the caller has no way to tell which venue order was the one that filled).
      // Captured BEFORE clearPlan() below (which deletes the registry row outright) — the perp
      // algo-cancel further down needs to read what the registry held for THIS plan.
      const stopEntry = this.planStopRegistry?.get(positionKey(this.id, this.venue, this.symbol));
      this.clearPlan();
      this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);
      this.recordQuietJournalEntry(
        input,
        'venue_resting_fill: a resting venue order closed the position — plan cleared',
        'plan-executor',
      );
      if (this.venueTpEnabled) this.onVenueTp?.('filled_flat');
      if (this.venueStopEnabled) this.onVenueStop?.('filled_flat');

      // External-flatten orphan (review nice-to-have, extended Push 3 P7d to both roles): if the
      // position closed WITHOUT one of the resting orders filling, that order still rests (SELL for
      // a LONG plan, BUY for a SHORT plan — mirrored, same side for both roles) — the entry-only
      // stale sweep never touches it and it could fill against a later re-entry at this stale plan's
      // price. Risk-reducing cancel, role-scoped so each check only ever touches its own order.
      const cleanupSignals: Signal[] = [];
      if (this.venueTpEnabled && (await this.restingOrderForRole(input, tpSide, 'vtp'))) {
        this.onVenueTp?.('orphan_cancel');
        cleanupSignals.push(
          this.buildCancelOpenSignal(
            input,
            lastCandle,
            tpSide,
            `venue take-profit: position closed externally — cancel the orphaned resting ${tpSide}`,
            'vtp',
          ),
        );
      }
      if (this.venueStopEnabled) {
        if (this.isPerpVenue()) {
          await this.cancelPerpAlgoStopIfResting(stopEntry, tpSide, 'orphan_cancel');
        } else if (await this.restingOrderForRole(input, tpSide, 'vsl')) {
          this.onVenueStop?.('orphan_cancel');
          cleanupSignals.push(
            this.buildCancelOpenSignal(
              input,
              lastCandle,
              tpSide,
              `venue stop: position closed externally — cancel the orphaned resting ${tpSide}`,
              'vsl',
            ),
          );
        }
      }
      return cleanupSignals;
    }
    if (verdict.type === 'exit') {
      // AGENTIC_VENUE_TP take_profit race (review finding): the close crossed the TP while the
      // resting TP order (SELL for LONG, BUY for SHORT) is still observed open — that order is
      // marketable at this close, so its own venue fill IS the exit; a full-size IOC here would
      // collide with the base/margin it locks and venue-reject. The same hold applies through the
      // one-bar in-flight placement window (second review finding): a TP emitted last bar may not
      // be acked into openOrders yet, and the IOC would race it — mirror manageVenueTp's own
      // suppression window. Next bar observes either FLAT (position_closed journals the fill) or,
      // with nothing resting and the window closed, the normal exit path fires. Stop/max_hold never
      // enter here (they cancel-first below).
      if (this.venueTpEnabled && verdict.reason === 'take_profit') {
        const inFlightTp =
          active.venueTpPlacedAtBar !== null && active.barsElapsed <= active.venueTpPlacedAtBar + 1;
        // Push 3 P7c: role-scoped to 'vtp' — this hold is specifically about the TP's OWN fill
        // racing the bar-close evaluation, so a resting order that resolves to a different role
        // must not suppress this bar's exit on its account.
        if ((await this.restingOrderForRole(input, tpSide, 'vtp')) || inFlightTp) {
          this.onVenueTp?.('tp_race_hold');
          this.recordQuietJournalEntry(
            input,
            `plan hold: close crossed the TP while the venue ${tpSide} rests or is in flight — awaiting its fill`,
            'plan-executor',
          );
          return [];
        }
      }
      // Captured BEFORE clearPlan() below (which deletes the registry entry outright) — both the
      // force-band check and the perp algo-cancel further down need to read what the registry held
      // for THIS plan, and a post-clearPlan read would always see undefined.
      const key = positionKey(this.id, this.venue, this.symbol);
      const stopEntry = this.planStopRegistry?.get(key);
      // AGENTIC_VENUE_STOP force-band (Push 3 P7d): the bar-close executor's own 'stop' exit stands
      // down while a CONFIRMED-resting venue stop (registry venueStopResting true) should still have
      // room to fill on its own — the SAME force-band ProtectiveExitService's 1s watcher already
      // applies (tickPlanStop, ports/trading/risk.ts's planStopForceBps), just on this strategy's coarser
      // bar-close cadence. Failure direction: standing down is the measurement/veto-only side of this
      // decision (the venue stop is still live and expected to fill), so it fails OPEN toward
      // deferring; the force-fire branch below is the fail-safe that never defers indefinitely — a
      // breach past the band means the venue order evidently failed, so the bar-close IOC proceeds
      // exactly as it would with the flag off. Independent of PLAN_STOP_WATCH_ENABLED: a deployment
      // may run AGENTIC_VENUE_STOP with the 1s watcher off, and this is then the ONLY gap backstop.
      if (this.venueStopEnabled && verdict.reason === 'stop' && stopEntry?.venueStopResting) {
        const stopPriceDec = new Decimal(stopEntry.stopPrice);
        const breachBps = new Decimal(lastCandle.close.toFixed())
          .minus(stopPriceDec)
          .abs()
          .div(stopPriceDec)
          .mul(10_000);
        if (breachBps.lte(this.planStopForceBps)) {
          this.onVenueStop?.('stood_down');
          this.recordQuietJournalEntry(
            input,
            `plan hold: close breached the plan stop by ${breachBps.toFixed(1)}bps, within the ${this.planStopForceBps}bps force band — deferring to the resting venue stop`,
            'plan-executor',
          );
          return [];
        }
        this.onVenueStop?.('force_fired');
      }
      this.clearPlan();
      this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);
      this.recordQuietJournalEntry(input, `plan exit: ${verdict.reason}`, 'plan-executor');
      // AGENTIC_VENUE_TP/AGENTIC_VENUE_STOP: a resting TP/stop order locks the base/margin at the
      // venue — cancel it BEFORE this full-size IOC exit, else the exit venue-rejects for
      // insufficient balance. Stop/max_hold only: a take_profit crossing this close-price check
      // while a TP still rests is the venue order's own fill path racing this bar's evaluation, not
      // a case this cancel-first guard targets (out of the explicit brief scope for this feature).
      // Push 3 P7c/P7d: deliberately ROLE-AGNOSTIC on the SPOT open-orders rail
      // (restingOrderForSide, not restingOrderForRole) — a full-size exit is blocked by ANY resting
      // reduce-only order on this side, TP or protective stop alike. Defect B (#49) fix: rather than
      // a separate CANCEL_OPEN signal ahead of the exit (a two-recordSignal pairing that left an
      // interleave window for a third same-key signal — e.g. a TP re-placement — to slot in between
      // and re-lock the base), the cancel rides the exit signal's own cancelBeforeSubmit field
      // (role-agnostic — SignalSinkService clears every side-matching order in the SAME chain entry
      // as the exit submit, both roles cleared before it, no interleave possible). PERP: a resting
      // venue STOP_MARKET lives on the algo rail, never in openOrders, so the side-scan below can
      // never see it — cancelPerpAlgoStopIfResting reaches it directly off `stopEntry` (captured
      // above, BEFORE clearPlan() deleted the registry row), best-effort (see that method's own
      // comment), unchanged by this fix.
      const cancelFirstEligible =
        (this.venueTpEnabled || this.venueStopEnabled) &&
        (verdict.reason === 'stop' || verdict.reason === 'max_hold');
      const restingExit = cancelFirstEligible ? this.restingOrderForSide(input, tpSide) : undefined;
      if (restingExit) {
        this.onVenueTp?.('cancel_for_exit');
        if (this.venueStopEnabled) this.onVenueStop?.('cancel_for_exit');
      }
      if (cancelFirstEligible && this.venueStopEnabled && this.isPerpVenue()) {
        await this.cancelPerpAlgoStopIfResting(stopEntry, tpSide, 'cancel_for_exit');
      }
      const exitSignal: Signal = {
        strategyId: this.id,
        venue: this.venue,
        symbol: this.symbol,
        kind: isShort ? 'EXIT_SHORT' : 'EXIT_LONG',
        strength: 1,
        ...(restingExit ? { cancelBeforeSubmit: { side: tpSide } } : {}),
        refPrice: lastCandle.close,
        basedOnSeq: lastCandle.seq,
        eventTime: input.snapshot.eventTime,
        // planExitTtlBars × interval, never one bar: this EXIT faces the gateway TTL check and
        // its age is already ≈ one bar at emission (eventTime anchors to the evaluated close).
        ttlMs: this.planExitTtlBars * this.baseIntervalMs,
        dedupeKey: `${this.id}:${this.symbol}:agentic:plan_exit:${input.snapshot.eventTime}`,
        reason: `plan exit: ${verdict.reason}`,
      };
      return [exitSignal];
    }
    if (verdict.type === 'cancel_entry' || verdict.type === 'plan_expired') {
      this.clearPlan();
      this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);
      this.recordQuietJournalEntry(input, `plan cleared: ${verdict.type}`, 'plan-executor');
      if (verdict.type === 'cancel_entry') {
        return [
          {
            strategyId: this.id,
            venue: this.venue,
            symbol: this.symbol,
            kind: 'CANCEL_OPEN',
            strength: 1,
            refPrice: lastCandle.close,
            basedOnSeq: lastCandle.seq,
            eventTime: input.snapshot.eventTime,
            ttlMs: this.planExitTtlBars * this.baseIntervalMs,
            dedupeKey: `${this.id}:${this.symbol}:agentic:plan_cancel:${input.snapshot.eventTime}`,
            reason: 'plan cleared: entry validity lapsed — cancel-open sweep',
          },
        ];
      }
      return [];
    }

    // hold: B2's consult-schedule gate (decide()'s own evaluateConsultSchedule call) decides whether
    // this bar stays quiet — a due schedule/wake-move/fallback/fill falls through to a real consult,
    // else this bar is a deterministic no-call hold.
    if (consultNow) return null;
    this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);
    // W6: sample the SAME market payload a real consult would journal on every Nth managed bar, so
    // the offline replay harness accrues rows while plan mode manages the position (which otherwise
    // journals inputPayload: null on every managed bar). buildMarketPayload(input) is byte-identical
    // to the client's own inputPayload (anthropic-agent-client.ts). 0 ⇒ never sample (unchanged).
    const sampledPayload =
      this.quietPayloadSampleBars > 0 && active.barsElapsed % this.quietPayloadSampleBars === 0
        ? buildMarketPayload(input)
        : null;
    this.recordQuietJournalEntry(
      input,
      `plan active — deterministic hold (${this.consultScheduleRationale()})`,
      'plan-executor',
      sampledPayload,
    );
    // AGENTIC_VENUE_TP: idempotent per-bar reconciliation of the resting take-profit (place if
    // missing, cancel-to-re-place on drift). No-op ([]) whenever the flag is off, position isn't
    // LONG/SHORT, or the resting order is already correctly priced — see manageVenueTp.
    const tpSignals = await this.manageVenueTp(input, context, active, lastCandle, isShort, tpSide);
    // AGENTIC_VENUE_STOP (Push 3 P7d): the SAME idempotent per-bar reconciliation, for the
    // protective stop — independent of manageVenueTp above (a deployment may run either, both, or
    // neither), so both are always attempted and their signals concatenated. tpSide doubles as the
    // stop's own exit side (the reduce-only exit side is identical for both roles — SELL for LONG,
    // BUY for SHORT).
    const stopSignals = await this.manageVenueStop(
      input,
      context,
      active,
      lastCandle,
      isShort,
      tpSide,
    );
    return [...tpSignals, ...stopSignals];
  }

  // AGENTIC_VENUE_TP: places or reconciles the plan's resting take-profit at the venue instead of
  // waiting for the executor's own close-price crossing to fire an IOC exit. Idempotent by
  // construction: a correctly-priced resting TP order is a no-op (skipped_existing), so a restart
  // re-arm (which loses only this in-memory bookkeeping, never the venue order itself) simply
  // re-observes the existing order on its next managed bar and does nothing. Push II Phase 8:
  // mirrored for SHORT — the resting TP is a reduce-only BUY (cover) instead of a SELL, priced
  // entry × (1 − takeProfitPct) instead of entry × (1 + takeProfitPct).
  private async manageVenueTp(
    input: AgentDecisionInput,
    context: AgentContext,
    active: ActivePlanState,
    lastCandle: CandleEvent,
    isShort: boolean,
    tpSide: 'BUY' | 'SELL',
  ): Promise<Signal[]> {
    if (!this.venueTpEnabled) return [];
    if (
      (context.position.side !== 'LONG' && context.position.side !== 'SHORT') ||
      active.entryPrice === null
    ) {
      return [];
    }

    const currentTp = this.venueTpPrice(active.entryPrice, active.plan.takeProfitPct, isShort);
    // Push 3 P7c: role-scoped — this reconciliation loop owns ONLY the 'vtp'-role resting order. A
    // 'vsl' (future P7d) or otherwise-unknown order resting on the same side is not this loop's to
    // place/drift/qty-reconcile against (restingOrderForRole warns once and leaves it alone).
    const restingTp = await this.restingOrderForRole(input, tpSide, 'vtp');

    if (!restingTp) {
      // In-flight suppression (review finding): a placement emitted on bar N may not be acked into
      // openOrders when bar N+1 evaluates, and a second placement would duplicate the reduce-only
      // order. One bar of suppression bounds the duplicate window; a placement that died unacked
      // (risk veto, TTL) re-places on bar N+2 rather than being suppressed forever.
      if (
        active.venueTpPlacedAtBar !== null &&
        active.barsElapsed <= active.venueTpPlacedAtBar + 1
      ) {
        this.onVenueTp?.('skipped_inflight');
        return [];
      }
      active.venueTpPlacedAtBar = active.barsElapsed;
      this.onVenueTp?.('placed');
      return [
        {
          strategyId: this.id,
          venue: this.venue,
          symbol: this.symbol,
          kind: isShort ? 'EXIT_SHORT' : 'EXIT_LONG',
          strength: 1,
          refPrice: lastCandle.close,
          exitStyle: 'RESTING',
          limitPriceHint: currentTp,
          basedOnSeq: lastCandle.seq,
          eventTime: input.snapshot.eventTime,
          ttlMs: this.planExitTtlBars * this.baseIntervalMs,
          dedupeKey: `${this.id}:${this.symbol}:agentic:venue_tp_place:${input.snapshot.eventTime}`,
          reason: 'venue take-profit: resting exit placed',
        },
      ];
    }

    // The ack is observed — the in-flight suppression window is closed.
    active.venueTpPlacedAtBar = null;

    // No price on the resting order ⇒ drift cannot be assessed; treat as fine rather than guessing
    // a cancel off no information.
    if (restingTp.limitPrice === undefined) {
      this.onVenueTp?.('skipped_existing');
      return [];
    }

    // Drift compares against the tick-rounded EXPECTED resting price, not the raw hint: the sizer
    // rounds the hint to the venue tick in the order's own conservative direction (UP for a SELL
    // TP, DOWN for a SHORT's BUY cover — position-sizer.service.ts's isRestingExit branch), so a
    // raw-hint or wrong-direction comparison reads that [0, tick) bias as permanent drift and
    // churns cancel/re-place on any symbol whose tick exceeds the threshold (review findings). No
    // tick configured ⇒ raw hint (test harnesses; fine-tick symbols).
    const expectedTp = this.venueTpTickSize
      ? roundToTick(currentTp, this.venueTpTickSize, isShort ? 'down' : 'up')
      : currentTp;
    const driftBps = restingTp.limitPrice.minus(expectedTp).abs().div(expectedTp).mul(10_000);
    if (driftBps.gt(this.venueTpReplaceDriftBps)) {
      this.onVenueTp?.('drift_cancel');
      return [
        this.buildCancelOpenSignal(
          input,
          lastCandle,
          tpSide,
          `venue take-profit: resting ${tpSide} drifted ${driftBps.toFixed(1)}bps from the plan TP — cancel to re-place`,
          'vtp',
        ),
      ];
    }

    // Qty reconciliation (review finding): the TP was sized to the position at placement; an entry
    // remainder filling AFTERWARD grows the position while the resting order stays at the old size,
    // leaving the growth slice uncovered at the venue. Compare against the STEP-ROUNDED sellable qty,
    // NOT the raw position.qty: the sizer rests roundToStep(position.qty, step, 'down'), so the resting
    // order is structurally short by the sub-step residue (position.qty mod step ∈ [0, step)) and a
    // raw-equality check reads that permanent dust as a mismatch, churning cancel/re-place every
    // managed bar (2026-07-15 loop fix — live DB: LINK 12.03 vs position 12.0396, etc.). A no-change
    // bar reaches step-granular equality (skipped_existing); a real ≥1-step position move re-sizes via
    // cancel/re-place — an entry remainder growing the position, or a partial TP fill shrinking it
    // (OpenOrderSummary.qty stays the ORIGINAL intent size until cancelled, so the shrunk position
    // trips this branch, never a raw-dust churn).
    const sellableQty = this.venueTpStepSize
      ? roundToStep(new Decimal(context.position.qty), this.venueTpStepSize, 'down')
      : new Decimal(context.position.qty);
    if (!restingTp.qty.eq(sellableQty)) {
      this.onVenueTp?.('qty_cancel');
      return [
        this.buildCancelOpenSignal(
          input,
          lastCandle,
          tpSide,
          `venue take-profit: resting ${tpSide} qty ${restingTp.qty.toFixed()} != sellable ${sellableQty.toFixed()} — cancel to re-size`,
          'vtp',
        ),
      ];
    }

    this.onVenueTp?.('skipped_existing');
    return [];
  }

  // entry × (1 + takeProfitPct) for LONG, entry × (1 − takeProfitPct) for SHORT (mirrored), rounded
  // to the 18dp money-precision ceiling BEFORE minting a Price (same overflow rationale as
  // roundToTick's own header comment — a multiplication-derived price can exceed 18 places). This is
  // a HINT: PositionSizerService tick-rounds it to the venue's real tick when it prices the resting
  // order (position-sizer.service.ts), so no tick size is needed here.
  private venueTpPrice(entryPrice: string, takeProfitPct: string, isShort: boolean): Price {
    const raw = new Decimal(entryPrice).mul(
      isShort ? new Decimal(1).minus(takeProfitPct) : new Decimal(1).plus(takeProfitPct),
    );
    return price(roundToMoneyPrecision(raw).toFixed());
  }

  // AGENTIC_VENUE_STOP (Push 3 P7d): dispatches to the venue-appropriate reconciliation loop — SPOT
  // only MANAGES an already-resting STOP_LOSS_LIMIT on the regular open-orders rail (2026-07-31 fix:
  // it never places a new one — see manageVenueStopSpot's own header comment for why); PERP rests a
  // STOP_MARKET on the swap algo/conditional rail instead, which never appears in openOrders (see
  // AlgoOrderState's own header comment in ports/venue/exchange.ts), so reconciliation there goes
  // through AgenticStrategyDeps.algoOrders.fetchOpenAlgoOrders. No-op ([]) whenever the flag is off,
  // position isn't LONG/SHORT, or the resting order is already correctly priced/sized.
  private async manageVenueStop(
    input: AgentDecisionInput,
    context: AgentContext,
    active: ActivePlanState,
    lastCandle: CandleEvent,
    isShort: boolean,
    stopSide: 'BUY' | 'SELL',
  ): Promise<Signal[]> {
    if (!this.venueStopEnabled) return [];
    if (
      (context.position.side !== 'LONG' && context.position.side !== 'SHORT') ||
      active.entryPrice === null
    ) {
      return [];
    }

    const key = positionKey(this.id, this.venue, this.symbol);
    // entry × (1 − stopLossPct) for LONG, entry × (1 + stopLossPct) for SHORT — the SAME formula
    // setPlanStop already seeds the registry with, so the placement hint and the watcher's own
    // crossing check can never disagree.
    const currentStop = this.venueStopPrice(active.entryPrice, active.plan.stopLossPct, isShort);

    return this.isPerpVenue()
      ? await this.manageVenueStopPerp(
          input,
          active,
          lastCandle,
          stopSide,
          currentStop,
          context,
          key,
        )
      : await this.manageVenueStopSpot(
          input,
          active,
          lastCandle,
          stopSide,
          currentStop,
          context,
          key,
        );
  }

  // entry × (1 − stopLossPct) for LONG, entry × (1 + stopLossPct) for SHORT (mirrored) — the exact
  // inverse of venueTpPrice's own formula (the stop sits on the OPPOSITE side of entry from the TP).
  // Unlike the TP price, this value never changes for the life of a plan (stopLossPct/entryPrice are
  // both fixed once the entry fills), so — unlike manageVenueTp's drift check, which mostly guards
  // against [0, tick) rounding bias — a genuine drift here would only ever be an external anomaly.
  private venueStopPrice(entryPrice: string, stopLossPct: string, isShort: boolean): Price {
    const raw = new Decimal(entryPrice).mul(
      isShort ? new Decimal(1).plus(stopLossPct) : new Decimal(1).minus(stopLossPct),
    );
    return price(roundToMoneyPrecision(raw).toFixed());
  }

  // SPOT reconciliation: MANAGE-ONLY, never place. Confirmed defect (independent adversarial review,
  // 2026-07-31): on spot, both manageVenueTp's 'vtp' and this loop's 'vsl' size to 100% of the
  // position and reduceOnly is dropped on spot (ccxt-exchange.adapter.ts), so the two legs contend
  // for the SAME free base balance and the loser always terminal-rejects. The 7-day binance
  // reduce_only SELL rejection rate was 78% COMBINED across both legs (122/154, InsufficientFunds);
  // split by role it was vtp 86.6% (97/112) and vsl 58.5% (24/41) over the same window — both
  // per-role rates are artifacts of the two legs fighting over the same balance, not a property of
  // either leg alone, and neither predicts the post-fix rate: once only one leg is placed it has the
  // base to itself. (An earlier version of this comment attributed the 78% combined figure to the
  // stop leg alone and read it as a reason to drop the stop — the split above does not support that;
  // the actual justification is below.) Dropping the spot STOP_LOSS_LIMIT is NOT because it fails to
  // fill: every spot stop that ever reached its trigger over the same measured week filled at or
  // inside the trigger, zero partials, zero non-fills (ZEC/BTC/SOL/AAVE, 2026-07-25 through 07-31) —
  // a fill-failure argument was considered against that 4/4 record and dropped. The real trade is
  // narrower: resting a venue stop stands the bar-close software stop DOWN (runActivePlan's
  // venueStopResting guard), so keeping the stop leg trades a race the TP leg already covers for a
  // choice between one control and one control (venue stop vs. software stop), not two controls and
  // one — not worth making just to win that race. So below: if nothing rests, stand down
  // (setVenueStopResting(key, false)) and return — FAILS OPEN, never place. If a 'vsl' IS
  // already resting (e.g. from before this fix, or a manual/legacy order), the drift/qty/cancel
  // reconciliation below still runs unchanged — a resting stop is scanned, drift-managed and
  // cancellable, never stranded. The drift EXPECTATION mirrors manageVenueTp's own place/drift/qty
  // loop with one structural difference: a resting STOP_LOSS_LIMIT's own OpenOrderSummary.limitPrice
  // is the BUFFERED limit leg PositionSizerService built past the trigger (position-sizer.service.ts's
  // isRestingStopExit branch), never the raw trigger — comparing against the raw trigger would read
  // the buffer itself (default 50bps) as permanent drift and churn cancel/re-place forever, so
  // spotStopExpectedLimit replicates the sizer's own buffer formula before comparing.
  private async manageVenueStopSpot(
    input: AgentDecisionInput,
    active: ActivePlanState,
    lastCandle: CandleEvent,
    stopSide: 'BUY' | 'SELL',
    currentStop: Price,
    context: AgentContext,
    key: string,
  ): Promise<Signal[]> {
    // Push 3 P7f fix 6: scans inline (rather than restingOrderForRole) so a STORE-ERROR on any
    // candidate is visible below — restingOrderForRole's own collapsed 'unknown' would read a
    // store throw identically to "no stop rests here", standing venueStopResting down while a
    // legacy 'vsl' may genuinely still rest server-side. See roleForOrderChecked's own header comment.
    const stopCandidates = input.snapshot.portfolio.openOrders.filter(
      (o) => o.symbol === this.symbol && o.side === stopSide,
    );
    let restingVsl: OpenOrderSummary | undefined;
    let storeError = false;
    for (const o of stopCandidates) {
      const checked = await this.roleForOrderChecked(o.clientOrderId);
      if (checked.storeError) storeError = true;
      if (checked.role === 'vsl') {
        restingVsl = o;
        break;
      }
      if (checked.role === 'unknown' && !checked.storeError) this.warnUnknownRoleOnce(o, input);
    }

    if (!restingVsl && storeError) {
      // Fail-toward-no-op: a transient store failure proves nothing about whether a legacy stop
      // already rests — skip this bar's reconcile decision (retry next bar) rather than guess.
      // Deliberately does NOT touch setVenueStopResting: an unverified flip either way would
      // corrupt the bar-close force-band/watcher's own read of whether a stop is CONFIRMED resting
      // (CLAUDE.md fail-direction: leaving it at its last-known value, never optimistically
      // flipping it, is the safe direction).
      this.logger.warn(
        `venue-stop reconcile: intent-store lookup failed for ${this.symbol} — skipping this bar's reconcile decision, venueStopResting left unchanged`,
      );
      return [];
    }

    if (!restingVsl) {
      // 2026-07-31 fix: no placement on spot (see this function's header comment for the full
      // rationale) — confirm-before-flag DOWN so the watcher never believes a venue stop rests when
      // none does, and let the bar-close software stop stay the sole armed protective control.
      this.setVenueStopResting(key, false);
      return [];
    }

    active.venueStopPlacedAtBar = null;
    this.setVenueStopResting(key, true);

    if (restingVsl.limitPrice === undefined) {
      this.onVenueStop?.('skipped_existing');
      return [];
    }

    const expectedLimit = this.spotStopExpectedLimit(currentStop, stopSide);
    const driftBps = restingVsl.limitPrice
      .minus(expectedLimit)
      .abs()
      .div(expectedLimit)
      .mul(10_000);
    if (driftBps.gt(this.venueStopReplaceDriftBps)) {
      this.setVenueStopResting(key, false);
      this.onVenueStop?.('drift_cancel');
      return [
        this.buildCancelOpenSignal(
          input,
          lastCandle,
          stopSide,
          `venue stop: resting ${stopSide} drifted ${driftBps.toFixed(1)}bps from the expected buffered leg — cancel to re-place`,
          'vsl',
        ),
      ];
    }

    // Step-rounded reconciliation, identical rationale to manageVenueTp's qty check (see there): the
    // reduce-only STOP_LOSS_LIMIT is sized to roundToStep(position.qty, step, 'down'), so a raw
    // position.qty comparison reads the permanent sub-step dust residue as a mismatch and churns
    // cancel/re-place every managed bar.
    const protectableQty = this.venueStopStepSize
      ? roundToStep(new Decimal(context.position.qty), this.venueStopStepSize, 'down')
      : new Decimal(context.position.qty);
    if (!restingVsl.qty.eq(protectableQty)) {
      this.setVenueStopResting(key, false);
      this.onVenueStop?.('qty_cancel');
      return [
        this.buildCancelOpenSignal(
          input,
          lastCandle,
          stopSide,
          `venue stop: resting ${stopSide} qty ${restingVsl.qty.toFixed()} != protectable ${protectableQty.toFixed()} — cancel to re-size`,
          'vsl',
        ),
      ];
    }

    this.onVenueStop?.('skipped_existing');
    return [];
  }

  // PERP reconciliation: the algo rail has no open-orders visibility, so this scans
  // fetchOpenAlgoOrders instead — role resolution reuses roleForOrder UNCHANGED (AlgoOrderState's
  // clientAlgoId is the same OMS clientOrderId string minted at placement, see
  // ccxt-exchange.adapter.ts's own comment on the STOP_MARKET mapping), just applied to a different
  // order list. Drift compares AlgoOrderState.triggerPrice directly (a STOP_MARKET carries no
  // buffered limit leg — position-sizer.service.ts's isRestingStopExit branch), so no buffer
  // replication is needed here (unlike the spot leg above).
  private async manageVenueStopPerp(
    input: AgentDecisionInput,
    active: ActivePlanState,
    lastCandle: CandleEvent,
    stopSide: 'BUY' | 'SELL',
    currentStop: Price,
    context: AgentContext,
    key: string,
  ): Promise<Signal[]> {
    // Backlog #54 (FLAG 1): this read was the ONE throw-capable algo call on the managed-bar hot
    // path not under try/catch — its rejection propagated out of decide(), discarding the venue-TP
    // signal manageVenueTp had already built on the SAME bar (metric'd 'placed', never emitted) and
    // feeding onDecideFailure's auto-DRAIN, every managed perp bar. Same fail-toward-no-op direction
    // as the storeError branch below: skip this bar's placement decision (a blind placement could
    // duplicate a stop this read failed to see), never touch setVenueStopResting (an unverified flip
    // either way corrupts the watcher/force-band stand-down read), and surface loudly via the
    // 'reconcile_error' lifecycle event. Executor bar-close + S3 backstops stay armed throughout —
    // the position is never naked on this path. Mirrors P7f fix 5's swallow in
    // cancelPerpAlgoStopIfResting's fallback lookup, which documented this exact bug class.
    let open: readonly AlgoOrderState[];
    try {
      open = (await this.algoOrders?.fetchOpenAlgoOrders?.(this.symbol)) ?? [];
    } catch (err) {
      this.onVenueStop?.('reconcile_error');
      this.logger.warn(
        `venue-stop reconcile: fetchOpenAlgoOrders failed for ${this.symbol} (perp) — skipping this bar's placement decision: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
    let restingAlgo: AlgoOrderState | undefined;
    // Push 3 P7f fix 6: same STORE-ERROR distinction as manageVenueStopSpot above — a transient
    // intent-store throw while classifying a candidate must not read as "nothing resting" (see
    // roleForOrderChecked's own header comment for the duplicate-stop this prevents).
    let storeError = false;
    for (const o of open) {
      if (o.side !== stopSide || o.clientAlgoId === undefined) continue;
      const checked = await this.roleForOrderChecked(clientOrderId(o.clientAlgoId));
      if (checked.storeError) storeError = true;
      if (checked.role === 'vsl') {
        restingAlgo = o;
        break;
      }
    }

    if (!restingAlgo && storeError) {
      // Fail-toward-no-op — see manageVenueStopSpot's own comment on the failure direction (never
      // touches setVenueStopResting either, for the same reason).
      this.logger.warn(
        `venue-stop reconcile: intent-store lookup failed for ${this.symbol} (perp) — skipping this bar's placement decision to avoid a duplicate stop`,
      );
      return [];
    }

    if (!restingAlgo) {
      // Defect A commit-1 (2026-07-16 phantom perp position): a vanished algo stop may have
      // TRIGGERED (spawned a market order whose fill never reached the OMS through the regular fill
      // path — decodeClientOrderId can't map the venue-generated spawned id — stranding a phantom
      // position) rather than simply cancelled/never-placed. Only worth asking when this strategy
      // had CONFIRMED it resting last bar (registry venueStopResting true) — an unconfirmed vanish
      // has nothing new to recover, and the flag is about to flip false below, so a later bar would
      // never re-ask anyway; this avoids hammering the venue algo-history rail on every quiet bar.
      // Captured BEFORE the flip, which would otherwise always read false.
      const wasResting = this.planStopRegistry?.get(key)?.venueStopResting === true;
      this.setVenueStopResting(key, false);
      // Dep absent (spot lane, or a boot that doesn't wire it) ⇒ this whole branch is skipped and
      // the placement logic below runs exactly as it did before this feature — regression-pinned.
      if (wasResting && this.onAlgoStopGone) {
        const verdict = await this.onAlgoStopGone(this.symbol);
        if (verdict === 'triggered') {
          // Recovery already ingested the fill under the stop intent's own clientOrderId — the
          // position is flat at the OMS NOW, so this bar must neither re-place the stop (nothing
          // left to protect) nor emit an exit signal (nothing left to exit; a signal here would
          // race the fill already booked). The NEXT bar's position_closed branch (~747) observes
          // the position gone and runs the SAME plan-clear/orphan-TP cleanup a normal venue fill
          // already gets.
          this.onVenueStop?.('triggered');
          return [];
        }
        if (verdict === 'unknown') {
          // Fail-toward-no-op — same direction as the reconcile_error/store-error branches above:
          // an inconclusive venue answer must not risk placing a DUPLICATE stop next to one that
          // may still be resolving server-side. Skip only this bar's placement decision; the
          // bar-close executor and ProtectiveExitService's 1s watcher stay armed as backstops.
          return [];
        }
        // 'canceled' | 'none' — nothing to recover; the existing re-place logic below proceeds
        // unchanged.
      }
      if (
        active.venueStopPlacedAtBar !== null &&
        active.barsElapsed <= active.venueStopPlacedAtBar + 1
      ) {
        this.onVenueStop?.('skipped_inflight');
        return [];
      }
      active.venueStopPlacedAtBar = active.barsElapsed;
      this.onVenueStop?.('placed');
      return [this.buildVenueStopSignal(input, lastCandle, stopSide, currentStop)];
    }

    active.venueStopPlacedAtBar = null;
    this.setVenueStopResting(key, true, restingAlgo.algoId);

    const expectedTrigger = this.venueStopTickSize
      ? roundToTick(currentStop, this.venueStopTickSize, stopSide === 'SELL' ? 'down' : 'up')
      : currentStop;
    const driftBps = new Decimal(restingAlgo.triggerPrice)
      .minus(expectedTrigger)
      .abs()
      .div(expectedTrigger)
      .mul(10_000);
    if (driftBps.gt(this.venueStopReplaceDriftBps)) {
      this.setVenueStopResting(key, false);
      this.onVenueStop?.('drift_cancel');
      try {
        await this.algoOrders!.cancelAlgoOrder!(restingAlgo.algoId, this.symbol);
        // Fire-and-forget by contract (see journalAlgoStopCanceled) — this catch can therefore only
        // ever be the cancel itself.
        void this.journalAlgoStopCanceled();
      } catch {
        // Best-effort — see cancelPerpAlgoStopIfResting's own comment on the failure direction. The
        // next reconcile bar re-observes the (still-drifted) order and retries.
      }
      return [];
    }

    // Step-rounded reconciliation, identical rationale to manageVenueTp's qty check: the reduce-only
    // stop is sized to roundToStep(position.qty, step, 'down'), so comparing against the raw
    // full-precision position.qty reads the permanent sub-step dust as a mismatch and churns
    // cancel/re-place — here an algo-endpoint cancelAlgoOrder round trip — every managed bar.
    const protectableQty = this.venueStopStepSize
      ? roundToStep(new Decimal(context.position.qty), this.venueStopStepSize, 'down')
      : new Decimal(context.position.qty);
    if (!new Decimal(restingAlgo.qty).eq(protectableQty)) {
      this.setVenueStopResting(key, false);
      this.onVenueStop?.('qty_cancel');
      try {
        await this.algoOrders!.cancelAlgoOrder!(restingAlgo.algoId, this.symbol);
        void this.journalAlgoStopCanceled(); // fire-and-forget, same as the drift branch above
      } catch {
        // Best-effort, same as the drift branch above — reachable only from the cancel.
      }
      return [];
    }

    this.onVenueStop?.('skipped_existing');
    return [];
  }

  // Spot-only: replicates PositionSizerService's own STOP_LOSS_LIMIT buffer formula (trigger ×
  // (1∓bufferBps), tick-rounded the SAME conservative direction the sizer uses) so the drift check
  // compares the resting order's actual limitPrice against what the sizer would ACTUALLY place, not
  // the raw trigger — see manageVenueStopSpot's own header comment.
  private spotStopExpectedLimit(trigger: Price, stopSide: 'BUY' | 'SELL'): Price {
    const buffer = new Decimal(this.stopLimitBufferBps).div(10_000);
    const rawLeg =
      stopSide === 'SELL' ? trigger.mul(new Decimal(1).sub(buffer)) : trigger.mul(buffer.add(1));
    const rounded = roundToMoneyPrecision(rawLeg);
    return this.venueStopTickSize
      ? roundToTick(rounded, this.venueStopTickSize, stopSide === 'SELL' ? 'down' : 'up')
      : price(rounded.toFixed());
  }

  // Confirm-before-flag (never optimistic at signal-emission time): the plan-stop registry is a
  // SHARED signal ProtectiveExitService's 1s watcher and this strategy's own bar-close force-band
  // both stand down on, so a premature true would leave the position with NO protective backstop if
  // the placement never actually landed. `set()` replaces the whole entry, so this always reads
  // current first — a plan that has since cleared (registry entry gone) has nothing to update.
  private setVenueStopResting(key: string, resting: boolean, algoId?: string): void {
    if (!this.planStopRegistry) return;
    const current = this.planStopRegistry.get(key);
    if (!current) return;
    this.planStopRegistry.set(key, {
      ...current,
      venueStopResting: resting,
      algoId: resting ? algoId : undefined,
    });
  }

  private isPerpVenue(): boolean {
    return String(this.venue) === PERP_VENUE_ID || splitSymbol(this.symbol).settle !== undefined;
  }

  // Push 3 P7f fix 7b: process-restart (or any bar with no in-memory activePlan) can strand a
  // resting perp algo stop — manageVenueStopPerp's own per-bar reconcile only runs INSIDE
  // runActivePlan, which requires `this.activePlan` (wiped in-memory by a restart); the plan-stop
  // registry is wiped right along with it (it lives in the SAME process). A restart that happens
  // while a perp stop is genuinely resting therefore leaves it unobserved by EITHER this strategy
  // OR ProtectiveExitService's registry-driven watcher (empty registry ⇒ nothing to watch) until the
  // model re-attaches a plan on its next consult — a multi-bar protection gap. This runs every bar
  // with no active plan (cheap early-outs below make it a no-op once nothing is stranded), covering
  // BOTH outcomes: the stop still protects a real position (re-adopt) or the position is already
  // gone (cancel the orphan) — never left resting unrecognized either way.
  private async reconcileOrphanedAlgoStop(context: AgentContext): Promise<void> {
    if (this.activePlan !== null) return; // manageVenueStopPerp's own reconcile already owns this bar
    if (!this.venueStopEnabled || !this.isPerpVenue()) return;
    if (!this.algoOrders?.fetchOpenAlgoOrders || !this.planStopRegistry) return;
    const key = positionKey(this.id, this.venue, this.symbol);
    if (this.planStopRegistry.get(key) !== undefined) return; // already adopted this session

    let open: readonly AlgoOrderState[];
    try {
      open = await this.algoOrders.fetchOpenAlgoOrders(this.symbol);
    } catch {
      // Measurement-only emit, FAILS OPEN (onVenueStop is no-op-defaulted and its own recorder
      // swallows) — the read failure itself is the behavior, unchanged: retried next bar, same
      // failure direction as the rest of this lane. Same label manageVenueStopPerp's identical
      // fetch failure already emits, so both rails' read failures land on one series.
      this.onVenueStop?.('reconcile_error');
      return;
    }
    // Every guard above is satisfied and the venue answered: this is the only evidence the
    // no-active-plan reconcile path executes at all. Without it a zero on the labels below is
    // indistinguishable from the path never running.
    this.onVenueStop?.('orphan_scan');
    let ours: AlgoOrderState | undefined;
    for (const o of open) {
      if (o.clientAlgoId === undefined) continue;
      if ((await this.roleForOrder(clientOrderId(o.clientAlgoId))) === 'vsl') {
        ours = o;
        break;
      }
    }
    if (ours === undefined) return; // nothing stranded

    if (context.position.side === 'LONG' || context.position.side === 'SHORT') {
      // Branch (a) — re-adopt: it IS our stop for the CURRENT position (preferred per the finding —
      // cancelling and re-placing would leave a real gap the re-adopt avoids entirely). Seeded off
      // the resting order's OWN triggerPrice, never a re-derived entry×(1∓stopLossPct) — there is no
      // active plan to re-derive that from post-restart, and the venue's own resting price is the
      // more accurate truth anyway. Immediately unblocks ProtectiveExitService's watcher/force-band,
      // without waiting for the model's next consult to re-attach a plan.
      this.planStopRegistry.set(key, {
        side: context.position.side,
        stopPrice: ours.triggerPrice,
        venueStopResting: true,
        algoId: ours.algoId,
      });
      this.onVenueStop?.('orphan_readopt');
      return;
    }

    // Branch (b) — flat: the position this stop protected is gone (closed some other way while this
    // strategy had no active plan tracking it) — a genuine orphan with nothing left to protect.
    // Best-effort cancel, same fail-safe direction as cancelPerpAlgoStopIfResting (never blocks
    // decide(); a cancel failure here is retried on a later bar since nothing was adopted).
    if (!this.algoOrders.cancelAlgoOrder) return;
    try {
      await this.algoOrders.cancelAlgoOrder(ours.algoId, this.symbol);
    } catch {
      // Best-effort — see cancelPerpAlgoStopIfResting's own comment on the failure direction. The
      // emit is what makes the swallow readable: without it a zero on 'orphan_cancel' cannot
      // distinguish "never matched" from "matched and the cancel threw". Returns rather than falling
      // through, so ONE cancel can never emit both this label and the success label below.
      this.onVenueStop?.('orphan_cancel_failed');
      return;
    }
    // Outside the try deliberately: the two labels are mutually exclusive by construction, not by
    // the recorder happening to swallow its own throws.
    this.onVenueStop?.('orphan_cancel');
    void this.journalAlgoStopCanceled();
  }

  // Shared placement-signal shape for both rails — PositionSizerService's isRestingStopExit branch
  // (position-sizer.service.ts) is what actually decides STOP_MARKET (perp) vs STOP_LOSS_LIMIT
  // (spot) off signal.venue/symbol, so this strategy never needs to encode that choice itself.
  private buildVenueStopSignal(
    input: AgentDecisionInput,
    lastCandle: CandleEvent,
    stopSide: 'BUY' | 'SELL',
    triggerPrice: Price,
  ): Signal {
    return {
      strategyId: this.id,
      venue: this.venue,
      symbol: this.symbol,
      kind: stopSide === 'SELL' ? 'EXIT_LONG' : 'EXIT_SHORT',
      strength: 1,
      refPrice: lastCandle.close,
      exitStyle: 'RESTING_STOP',
      triggerPriceHint: triggerPrice,
      basedOnSeq: lastCandle.seq,
      eventTime: input.snapshot.eventTime,
      ttlMs: this.planExitTtlBars * this.baseIntervalMs,
      dedupeKey: `${this.id}:${this.symbol}:agentic:venue_stop_place:${input.snapshot.eventTime}`,
      reason: 'venue stop: resting protective stop placed',
    };
  }

  // Perp cancel-first helper (Push 3 P7d): a resting STOP_MARKET lives on the algo rail, so unlike
  // the spot vtp/vsl cancel (a CANCEL_OPEN Signal through SignalSinkService's normal chokepoint) this
  // calls AgenticStrategyDeps.algoOrders.cancelAlgoOrder DIRECTLY — there is no Signal kind that
  // reaches the algo rail (CANCEL_OPEN only ever scans portfolio.openOrders). Best-effort by design:
  // a cancel failure here must never block the caller's own risk-reducing action (the cancel-first
  // ahead of an exit, or the orphan cleanup on position_closed) — reduceOnly already bounds the
  // downside of a duplicate reduction, so swallowing and letting the next reconcile bar retry is the
  // correct failure direction, mirroring ProtectiveExitService.fire()'s own best-effort algo-cancel.
  // `entry` is a SNAPSHOT the caller reads BEFORE clearPlan() (both call sites clear the plan, and
  // with it the registry row, ahead of this call — reading the registry itself here would always see
  // undefined). Prefers the snapshot's own algoId (populated by a prior confirmed-resting reconcile
  // bar); falls back to an on-demand fetchOpenAlgoOrders lookup for the case where the OTHER venue
  // order (e.g. the TP) fills before any reconcile bar had a chance to confirm/cache this one — a
  // placement may be genuinely resting at the venue even though this strategy's own bookkeeping never
  // observed the ack, so the fallback runs regardless of the snapshot's `venueStopResting` flag.
  private async cancelPerpAlgoStopIfResting(
    entry: PlanStop | undefined,
    stopSide: 'BUY' | 'SELL',
    event: VenueStopEvent,
  ): Promise<void> {
    if (!this.algoOrders?.cancelAlgoOrder || entry === undefined) return;

    let algoId = entry.algoId;
    if (algoId === undefined) {
      // Push 3 P7f fix 5: the fallback lookup itself must be as best-effort as the cancel below —
      // this was the one throw-capable call in this method NOT under try/catch (roleForOrder
      // swallows internally). A network hiccup here used to propagate OUT of this method, past both
      // call sites (the position_closed orphan cleanup and the stop/max_hold cancel-first ahead of
      // the timed-out plan exit), after clearPlan() had already torn down the registry row — the
      // exit Signal already built by the caller was then never returned (the whole runActivePlan
      // call rejected instead), leaving a naked position with no crossed exit and no resting stop.
      // Swallowed here so this method can never throw, honoring its own "best-effort" header comment.
      try {
        const open = (await this.algoOrders.fetchOpenAlgoOrders?.(this.symbol)) ?? [];
        for (const o of open) {
          if (o.side !== stopSide || o.clientAlgoId === undefined) continue;
          if ((await this.roleForOrder(clientOrderId(o.clientAlgoId))) === 'vsl') {
            algoId = o.algoId;
            break;
          }
        }
      } catch {
        // Best-effort — see this method's own header comment on the failure direction.
      }
    }
    if (algoId === undefined) return;

    try {
      await this.algoOrders.cancelAlgoOrder(algoId, this.symbol);
      this.onVenueStop?.(event);
      // NOT awaited (see journalAlgoStopCanceled): this method's 'cancel_for_exit' call site runs
      // BETWEEN the cancel and the caller's exit-Signal construction, with the position already
      // unprotected on the algo rail — awaiting a multi-round-trip venue sweep here would withhold
      // that exit for as long as the venue stays slow. Also keeps this catch attributable to the
      // cancel alone.
      void this.journalAlgoStopCanceled();
    } catch {
      // Best-effort — see this method's own header comment on the failure direction.
    }
  }

  // 2026-07-31 stale-non-terminal-algo-stop defect: a cancel this strategy issues on the algo rail is
  // invisible to the OMS — no exec report ever arrives for it, so the local order row stays
  // non-terminal, its intent stays registered in inFlightIntents (boot-recovery.service.ts), and
  // HaltCoordinatorService.driveFlattening reads that registration as a BUSY symbol
  // (halt-coordinator.service.ts) — blocking a HALT flatten until the next boot. A live BTC/USDT:USDT
  // SELL STOP_MARKET cancelled at the venue by the drift_cancel path stayed non-terminal in our book
  // for exactly this reason. AgenticStrategyDeps.onAlgoStopGone is the ONLY route back to
  // AlgoStopRecoveryService (eslint-plugin-boundaries forbids this feature importing execution): it
  // reads the venue's own algo-history rail and APPENDS the CANCELED fold — never an UPDATE or DELETE,
  // order_events is append-only. Cleanup/measurement seam ⇒ FAILS OPEN, on BOTH axes: a throw is
  // swallowed here, AND every call site starts this with `void` rather than awaiting it, because
  // failing open on exceptions but not on latency is not failing open at all. What is behind the
  // seam is a multi-round-trip venue sweep (recoverSymbol → a store lookup per non-terminal order,
  // then fetchOpenAlgoOrders + the algo-history reads per candidate) against an exchange client with
  // no configured timeout, so ccxt's 10s default applies PER CALL; the callers that would await it
  // are (1) the cancel-first path, which holds a risk-reducing exit Signal it must not delay while
  // the position sits unprotected, and (2) reconcileOrphanedAlgoStop, which runs inside a 2s
  // non-LLM decide() budget whose overrun drops the whole bar's result and trips auto-DRAIN. No
  // call site reads the verdict, so nothing is lost by not waiting. Never rejects (the catch below
  // is total), so a bare `void` cannot leak an unhandled rejection. The one asymmetry deliberately
  // preserved: a failed FOLD leaves the order non-terminal (foldVenueTerminal's own
  // `if (!applied) return`), so the next recovery sweep retries rather than this path resurrecting
  // anything.
  private async journalAlgoStopCanceled(): Promise<void> {
    if (!this.onAlgoStopGone) return;
    try {
      await this.onAlgoStopGone(this.symbol);
    } catch {
      // FAILS OPEN — see this method's own header comment on the failure direction.
    }
  }

  // Push II Phase 8: generalized from restingSellOrder — a LONG plan's resting TP is a SELL, a
  // SHORT plan's is a BUY (mirrored); the entry-validity sweep above and the stale-entry sweep below
  // pass their own side explicitly rather than assuming SELL.
  private restingOrderForSide(
    input: AgentDecisionInput,
    side: 'BUY' | 'SELL',
  ): OpenOrderSummary | undefined {
    return input.snapshot.portfolio.openOrders.find(
      (o) => o.symbol === this.symbol && o.side === side,
    );
  }

  // Push 3 P7c: role classification for an open order — decodes to the persisted intent (via
  // intentStore) and reads roleForDedupeKey off its own source.dedupeKey. A store failure, an
  // absent intentStore (no DB wired), or a lookup miss (foreign/undecodable clientOrderId) all
  // resolve 'unknown' — fail OPEN to "don't touch it", never a guess (this is a reconciliation
  // helper, not a safety gate: CLAUDE.md's fail-direction rule for measurement/veto-only paths).
  private async roleForOrder(
    clientOrderId: OpenOrderSummary['clientOrderId'],
  ): Promise<RestingOrderRole> {
    return (await this.roleForOrderChecked(clientOrderId)).role;
  }

  // Push 3 P7f fix 6: roleForOrder's own store-lookup, split out so a caller making a PLACEMENT
  // decision (manageVenueStopSpot/manageVenueStopPerp's own "is a stop already resting?" scan) can
  // distinguish a genuine transient STORE-ERROR from a genuine role miss/absence — both collapse to
  // 'unknown' in roleForOrder above (correct for its own callers: the TP race-hold/orphan checks
  // and warnUnknownRoleOnce, which fail OPEN to "leave it alone" either way, a measurement/veto-only
  // read). The venue-stop reconcile loop is different: "nothing resolves to vsl" there does not
  // mean "leave it alone", it means "place a new stop" — and a false negative caused by a store
  // throw (not a genuine absence) would place a DUPLICATE stop next to one already resting. See
  // this method's own callers for the skip-this-bar fail direction that distinction enables.
  private async roleForOrderChecked(
    clientOrderId: OpenOrderSummary['clientOrderId'],
  ): Promise<{ role: RestingOrderRole; storeError: boolean }> {
    // Called through the member expression (never destructured into a bare variable first) — a
    // destructured reference loses `this` when invoked, and a real ExecutionStorePort
    // implementation reads its own instance state (see signal-sink.service.ts's own roleForOrder,
    // which hit exactly this bug against InMemoryExecutionStore).
    if (!this.intentStore?.loadIntentByClientOrderId) return { role: 'unknown', storeError: false };
    try {
      const intent = await this.intentStore.loadIntentByClientOrderId(clientOrderId);
      return {
        role: intent ? roleForDedupeKey(intent.source.dedupeKey) : 'unknown',
        storeError: false,
      };
    } catch {
      return { role: 'unknown', storeError: true };
    }
  }

  // Push 3 P7c: restingOrderForSide, narrowed to ONE resting-order role — manageVenueTp's own
  // reconciliation (place/drift/qty/orphan) and the tp-race/orphan checks above must never mistake
  // a resting protective stop (P7d's 'vsl') for the take-profit they own, or vice versa. Any
  // side-matching order that resolves to a DIFFERENT role (or 'unknown') is left alone — warned
  // once so a genuinely stale/misclassified order is still visible, but never blindly cancelled;
  // the existing stale-entry sweep is the backstop for orders that are actually abandoned.
  private async restingOrderForRole(
    input: AgentDecisionInput,
    side: 'BUY' | 'SELL',
    role: 'vtp' | 'vsl',
  ): Promise<OpenOrderSummary | undefined> {
    const candidates = input.snapshot.portfolio.openOrders.filter(
      (o) => o.symbol === this.symbol && o.side === side,
    );
    for (const o of candidates) {
      const found = await this.roleForOrder(o.clientOrderId);
      if (found === role) return o;
      if (found === 'unknown') this.warnUnknownRoleOnce(o, input);
    }
    return undefined;
  }

  // XA5 (A0 activation bundle): repeated-noop circuit breaker bookkeeping. `position` is THIS
  // consult's position view; `action` the model's action. A noop = a positioned symbol emitting the
  // SAME action as last consult with NO change to position side/qty. emittedSignal is deliberately
  // NOT part of the condition: the Bug-B loop DID emit a close signal every bar — it just never
  // executed, so the position never changed; keying on "signal emitted" would have missed exactly
  // the case this guards. Suppressing a stably-held position's redundant holds is also a budget win
  // (plan-executor still enforces stops/TP deterministically between consults). On the
  // NOOP_BREAKER_THRESHOLD-th consecutive identical positioned noop the symbol is suppressed until
  // its position changes (see evaluateConsultSchedule's noopSuppressed branch). Fail-safe: a flat
  // book or any position delta (posKey folds side + signed qty) resets it; a fill/re-arm overrides.
  private updateNoopBreaker(
    position: { side: 'LONG' | 'SHORT' | 'FLAT'; qty: string },
    action: string,
  ): void {
    const positioned = position.side === 'LONG' || position.side === 'SHORT';
    const posKey = `${position.side}:${position.qty}`;
    if (!positioned || posKey !== this.noopLastPosKey) {
      if (this.noopSuppressed) {
        this.logger.warn(`XA5 repeated-noop breaker CLEARED for ${this.symbol} (position changed)`);
      }
      this.noopStreak = positioned ? 1 : 0;
      this.noopLastAction = action;
      this.noopLastPosKey = posKey;
      this.noopSuppressed = false;
      return;
    }
    if (action === this.noopLastAction) {
      this.noopStreak += 1;
    } else {
      this.noopStreak = 1;
      this.noopLastAction = action;
    }
    if (this.noopStreak >= NOOP_BREAKER_THRESHOLD && !this.noopSuppressed) {
      this.noopSuppressed = true;
      this.logger.warn(
        `XA5 repeated-noop breaker ENGAGED for ${this.symbol}: action "${action}" repeated ` +
          `${this.noopStreak}x while positioned (${posKey}) with no state change — suppressing ` +
          `consults until the position changes (a fill/re-arm always overrides)`,
      );
    }
  }

  private warnUnknownRoleOnce(order: OpenOrderSummary, input: AgentDecisionInput): void {
    const openIds = new Set(
      input.snapshot.portfolio.openOrders.map((o) => String(o.clientOrderId)),
    );
    for (const id of [...this.unknownRoleWarned]) {
      if (!openIds.has(id)) this.unknownRoleWarned.delete(id);
    }
    const id = String(order.clientOrderId);
    if (this.unknownRoleWarned.has(id)) return;
    this.unknownRoleWarned.add(id);
    this.logger.warn(
      `unknown-role resting ${order.side} order ${id} on ${this.symbol} — leaving it for the stale sweep`,
    );
  }

  private buildCancelOpenSignal(
    input: AgentDecisionInput,
    lastCandle: CandleEvent,
    cancelSide: 'BUY' | 'SELL',
    reason: string,
    // Push 3 P7c: absent ⇒ side-only cancel (today's behavior — used by the entry-side sweeps and
    // the stop/max_hold cancel-first, which must clear every resting role on this side). 'vtp'/
    // 'vsl' narrows to that one role's own resting order (manageVenueTp's own reconciliation).
    cancelRole?: 'vtp' | 'vsl',
  ): Signal {
    return {
      strategyId: this.id,
      venue: this.venue,
      symbol: this.symbol,
      kind: 'CANCEL_OPEN',
      cancelSide,
      ...(cancelRole ? { cancelRole } : {}),
      strength: 1,
      refPrice: lastCandle.close,
      basedOnSeq: lastCandle.seq,
      eventTime: input.snapshot.eventTime,
      ttlMs: this.planExitTtlBars * this.baseIntervalMs,
      dedupeKey: `${this.id}:${this.symbol}:agentic:venue_tp_cancel:${input.snapshot.eventTime}`,
      reason,
    };
  }

  // W2.1 stale-entry sweep — runs every decide cycle, prescreen-skipped ones included. Emits
  // CANCEL_OPEN for this strategy's own resting entry orders whose observed resting age (event-time
  // since first sighting) exceeds entryTtlBars × the base interval: risk-reducing by construction
  // (never places orders), exempt from the entry cap and the DRAINING filter (strategy-host
  // RISK_REDUCING), intercepted by SignalSink before the gateway. Reduce-only exits are IOC and
  // never rest, so only entries are swept. Push II Phase 8: the entry side is BUY for a LONG plan,
  // SELL for a SHORT plan — keyed off the ACTIVE plan's own direction (the only state that knows
  // which side a currently-resting entry could be); absent an active plan (legacy/no-plan bars) it
  // defaults to BUY, byte-identical to pre-Phase-8.
  private staleEntryCancels(input: AgentDecisionInput): Signal[] {
    if (this.entryTtlBars <= 0) return [];
    const entrySide: 'BUY' | 'SELL' = this.activePlan?.plan.direction === 'short' ? 'SELL' : 'BUY';
    const open = input.snapshot.portfolio.openOrders.filter(
      (o) => o.symbol === this.symbol && o.side === entrySide,
    );
    const openIds = new Set<string>(open.map((o) => o.clientOrderId as string));
    for (const id of [...this.entryFirstSeen.keys()]) {
      if (!openIds.has(id)) this.entryFirstSeen.delete(id);
    }
    for (const id of [...this.entryCancelRequestedAt.keys()]) {
      if (!openIds.has(id)) this.entryCancelRequestedAt.delete(id);
    }

    // Ref price resolved BEFORE any id is marked cancel-requested: a no-price bail must not burn
    // the request slot and silently suppress the sweep for a TTL window (reviewer note).
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const ticker = input.snapshot.tickers.get(this.symbol);
    const refPrice = lastCandle?.close ?? ticker?.last;
    if (refPrice === undefined) return [];

    const now = input.snapshot.eventTime;
    const ttlMs = this.entryTtlBars * this.baseIntervalMs;
    let staleFound = false;
    for (const o of open) {
      const id = o.clientOrderId as string;
      const firstSeen = this.entryFirstSeen.get(id);
      if (firstSeen === undefined) {
        this.entryFirstSeen.set(id, now);
        continue;
      }
      if (now - firstSeen < ttlMs) continue;
      // Already requested: re-arm only after another full TTL window (covers a lost/failed cancel
      // without re-spamming every bar while the venue works the first one).
      const requestedAt = this.entryCancelRequestedAt.get(id);
      if (requestedAt !== undefined && now - requestedAt < ttlMs) continue;
      this.entryCancelRequestedAt.set(id, now);
      staleFound = true;
    }
    if (!staleFound) return [];

    return [
      {
        strategyId: this.id,
        venue: this.venue,
        symbol: this.symbol,
        kind: 'CANCEL_OPEN',
        // The sweep detects one entry side only (filter above) — scope the cancel to match, else it
        // would also take out a resting venue-TP order on the OPPOSITE side sharing the symbol
        // (review finding, extended by Push II Phase 8 to the SHORT-plan SELL-entry case).
        cancelSide: entrySide,
        strength: 1,
        refPrice,
        // Never consumed by Risk (SignalSink intercepts CANCEL_OPEN before the gateway), so the
        // seq only needs to be a plausible provenance marker.
        basedOnSeq: lastCandle?.seq ?? ticker?.seq ?? 0n,
        eventTime: now,
        ttlMs: this.planExitTtlBars * this.baseIntervalMs,
        dedupeKey: `${this.id}:${this.symbol}:agentic:cancel_open:${now}`,
        reason: `stale entry: resting > ${this.entryTtlBars} bars — cancel-open sweep`,
      },
    ];
  }

  // B2 (Design § Deleted scaffolding): renders the SAME "bars until next consult" fact the gate
  // itself just computed, for a quiet-hold journal row — mirrors prescreen's own quiet-hold rationale
  // convention (a short, machine-parseable prefix) but names the schedule instead of a heuristic
  // reason, since the schedule IS the reason a v2-gated bar stays quiet.
  private consultScheduleRationale(): string {
    const target = this.scheduledConsultBars ?? this.fallbackConsultBars;
    const remaining = Math.max(target - this.barsSinceConsult, 0);
    return `scheduled: next consult in ${remaining} bars`;
  }

  // Push 3 P6 Unit 4 (#17 residual): surfaces {tripCount, winRate, meanNetBpsPerTrip,
  // trailingWindowTrips} over the trailing window/floor TRACK_RECORD_WINDOW_TRIPS/MIN_TRIPS define
  // above (B3: renamed from the now-deleted expectancy ladder's own consts, same definition) —
  // decide-side read-only context, never a risk-modulating mechanism. Disabled, no evidence port
  // wired, insufficient trips, or any failure all resolve to {} (the omit-entirely convention
  // buildCrossSymbolContext already uses) — never a populated key with garbage data.
  //
  // `candles` (P4b): this instance's OWN siloed buffer, passed in by decide() — the only benchmark
  // source computeBenchmarkAlpha below can honestly draw on (see BTC_BENCHMARK_SYMBOL's own comment).
  private computeEdgePolicyContext(eventTime: EpochMs): { edgePolicy?: AgentEdgePolicyBlock } {
    if (!this.edgePolicy) return {};
    const snap = this.edgePolicy.snapshot({ symbol: this.symbol, eventTime });
    if (!snap.active) return {};
    return {
      edgePolicy: {
        familyId: snap.familyId,
        cohort: snap.cohort,
        sideEligibility: snap.sideEligibility,
        maxSizeFraction: snap.maxSizeFraction,
      },
    };
  }

  private async computeTrackRecordContext(
    candles: readonly CandleEvent[],
  ): Promise<{ trackRecord?: AgentTrackRecord }> {
    if (!this.trackRecordEnabled || !this.evidence) return {};
    try {
      const trips = await this.evidence.recentRoundTrips(TRACK_RECORD_FETCH_LIMIT);
      const mine = trips.filter((t) => t.strategyId === this.id).slice(-TRACK_RECORD_WINDOW_TRIPS);
      if (mine.length < TRACK_RECORD_MIN_TRIPS) return {};

      let wins = 0;
      let bpsSum = new Decimal(0);
      let bpsCount = 0;
      for (const t of mine) {
        if (new Decimal(t.netPnl).gt(0)) wins += 1;
        if (t.entryVwap !== null) {
          const notional = new Decimal(t.entryVwap).mul(t.boughtQty);
          if (notional.gt(0)) {
            bpsSum = bpsSum.plus(new Decimal(t.netPnl).div(notional).mul(10_000));
            bpsCount += 1;
          }
        }
      }
      // P4b: the SAME evidence window the trips above cover — first trip's entry to last trip's
      // exit (NOT "to now": the trips only sum realized outcomes through the last close, and
      // comparing against a longer benchmark span than the trades actually ran over would overstate
      // or understate alpha against a period the lane wasn't even measured over).
      const windowStartMs = mine[0]!.openedAt;
      const windowEndMs = mine[mine.length - 1]!.closedAt;
      const benchmarkAlpha = this.computeBenchmarkAlpha(
        candles,
        windowStartMs,
        windowEndMs,
        bpsSum.toNumber(),
      );

      return {
        trackRecord: {
          tripCount: mine.length,
          winRate: wins / mine.length,
          meanNetBpsPerTrip: bpsCount > 0 ? bpsSum.div(bpsCount).toNumber() : 0,
          trailingWindowTrips: TRACK_RECORD_WINDOW_TRIPS,
          ...benchmarkAlpha,
        },
      };
    } catch (err) {
      this.logger.warn(
        `track-record context failed, omitting: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  }

  // P4b/W3 Part 2 (Design § Enriched model inputs — Track record + benchmark alpha): orchestrates
  // BOTH benchmark-alpha fields, each independently omitted on its own coverage/source failure —
  // never a partial-window figure smuggled onto either.
  private computeBenchmarkAlpha(
    candles: readonly CandleEvent[],
    windowStartMs: number,
    windowEndMs: number,
    laneCumulativeNetBps: number,
  ): { netVsBtcHoldBps?: number; netVsEqualWeightBasketBps?: number } {
    return {
      ...this.computeBtcHoldAlpha(candles, windowStartMs, windowEndMs, laneCumulativeNetBps),
      ...this.computeBasketHoldAlpha(windowStartMs, windowEndMs, laneCumulativeNetBps),
    };
  }

  // netVsBtcHoldBps only, and only when THIS instance's own symbol IS the benchmark symbol (its
  // siloed candle buffer genuinely holds real BTC closes — see BTC_BENCHMARK_SYMBOL's module
  // comment). Coverage guard (fail-open measurement, never a partial-window figure): the candle
  // nearest the window start must be within BENCHMARK_COVERAGE_TOLERANCE_BARS bars of windowStartMs,
  // and the candle nearest the window end within the same tolerance of windowEndMs — otherwise
  // omitted.
  private computeBtcHoldAlpha(
    candles: readonly CandleEvent[],
    windowStartMs: number,
    windowEndMs: number,
    laneCumulativeNetBps: number,
  ): { netVsBtcHoldBps?: number } {
    if (String(this.symbol) !== BTC_BENCHMARK_SYMBOL) return {};
    const scoped = candles.filter(
      (c) => c.eventTime >= windowStartMs && c.eventTime <= windowEndMs,
    );
    if (!this.coversWindow(scoped, windowStartMs, windowEndMs)) return {};
    const benchmarkReturn = computeHoldReturnFraction(
      scoped.map((c) => ({ eventTime: c.eventTime, close: c.close.toFixed() })),
    );
    if (benchmarkReturn === null) return {};
    return { netVsBtcHoldBps: computeAlphaBps(laneCumulativeNetBps, benchmarkReturn) };
  }

  // W3 Part 2: netVsEqualWeightBasketBps off the shared PriceHistoryStore (AgenticStrategyDeps
  // .priceHistory) — the multi-symbol source BTC_BENCHMARK_SYMBOL's own comment documented as
  // missing. EACH symbol's series is independently window-scoped and coverage-guarded with the SAME
  // tolerance rule computeBtcHoldAlpha uses; a symbol whose series does not genuinely cover the
  // window is EXCLUDED from the basket (computeEqualWeightBasketReturnFraction's own contract: a
  // missing return is dropped, never zeroed), so a partial basket can still produce an honest figure
  // as long as at least one symbol covers the window. Absent dep, or zero covered symbols ⇒ omitted.
  private computeBasketHoldAlpha(
    windowStartMs: number,
    windowEndMs: number,
    laneCumulativeNetBps: number,
  ): { netVsEqualWeightBasketBps?: number } {
    if (this.priceHistory === undefined) return {};
    const perSymbolCandles = new Map<string, readonly BenchmarkCandle[]>();
    for (const symbol of this.priceHistory.symbols()) {
      const series = this.priceHistory.seriesFor(symbol);
      const scoped = series.filter(
        (c) => c.eventTime >= windowStartMs && c.eventTime <= windowEndMs,
      );
      if (!this.coversWindow(scoped, windowStartMs, windowEndMs)) continue;
      perSymbolCandles.set(symbol, scoped);
    }
    const basketReturn = computeEqualWeightBasketReturnFraction(perSymbolCandles);
    if (basketReturn === null) return {};
    return { netVsEqualWeightBasketBps: computeAlphaBps(laneCumulativeNetBps, basketReturn) };
  }

  // Shared coverage guard: fewer than 2 scoped candles, or the nearest candle to either window
  // endpoint further than BENCHMARK_COVERAGE_TOLERANCE_BARS bars away, means the series does not
  // genuinely cover [windowStartMs, windowEndMs] — false ⇒ the caller must omit rather than compare a
  // truncated span (see this module's own header comment on that hazard).
  private coversWindow(
    scoped: readonly { eventTime: number }[],
    windowStartMs: number,
    windowEndMs: number,
  ): boolean {
    if (scoped.length < 2) return false;
    const toleranceMs = BENCHMARK_COVERAGE_TOLERANCE_BARS * this.baseIntervalMs;
    const first = scoped[0]!;
    const last = scoped[scoped.length - 1]!;
    return (
      first.eventTime - windowStartMs <= toleranceMs && windowEndMs - last.eventTime <= toleranceMs
    );
  }

  // Deterministic HOLD path taken when the B2 consult-schedule gate skips the LLM call entirely: no
  // client call, no token/decide counters (MetricsWrappingAgentClient never runs), an honest journal
  // row naming the schedule reason under the SAME distinct 'prescreen' model tag the retired gate
  // used (kept verbatim — counterfactual-scoring.ts's exposure walk filters on `model === 'prescreen'`
  // to skip these rows; renaming it is that consumer's own call, not this step's), and the same
  // empty-signal result shape decide() returns for any other HOLD. Unlike a real decision, this skip
  // is NOT pushed into the history ring: the ring is rendered to the LLM as its own prior decisions
  // (agent-prompt.ts), and a quiet skip was never seen or reasoned about by the model — presenting it
  // as such would fabricate a decision the agent never made. annotatePreviousOutcome still runs
  // unconditionally so the last REAL decision's outcome (price move, PnL delta) keeps accruing
  // through the quiet period.
  private recordQuietHold(
    input: AgentDecisionInput,
    context: AgentContext,
    heldDuringPrev: 'LONG' | 'SHORT' | 'FLAT',
    reason: string,
  ): Signal[] {
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const lastClose = lastCandle ? toIndicatorNumber(lastCandle.close) : NaN;
    const rationale = `${reason} — LLM not consulted`;

    this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);

    this.recordQuietJournalEntry(input, rationale);

    return [];
  }

  onStop(): void {
    this.history.length = 0;
    this.lastCombinedPnl = null;
    this.lastPositionSide = null;
  }

  // C1: merges a fresh derivatives-feed snapshot onto the host-supplied snapshot when the port is
  // wired and a fresh poll exists; otherwise returns `input` UNCHANGED (same object reference), so a
  // deployment without the feed wired (or a stale/absent poll) stays byte-identical all the way
  // through buildMarketPayload.
  private withDerivatives(input: AgentDecisionInput): AgentDecisionInput {
    const derivatives = this.derivativesFeed?.latest(this.symbol) ?? undefined;
    if (!derivatives) return input;
    return { ...input, snapshot: { ...input.snapshot, derivatives } };
  }

  // C4: merges a fresh sentiment-feed snapshot onto the host-supplied snapshot when the port is
  // wired and a fresh poll exists; otherwise returns `input` UNCHANGED (same object reference), so a
  // deployment without the feed wired (or a stale/absent poll) stays byte-identical all the way
  // through buildMarketPayload. No symbol argument (see SentimentFeedPort's own header comment).
  private withSentiment(input: AgentDecisionInput): AgentDecisionInput {
    const sentiment = this.sentimentFeed?.latest() ?? undefined;
    if (!sentiment) return input;
    return { ...input, snapshot: { ...input.snapshot, sentiment } };
  }

  // X3a: same merge-if-fresh convention as withSentiment above. No symbol argument (lane-wide, see
  // FearGreedFeedPort's own header comment).
  private withFearGreed(input: AgentDecisionInput): AgentDecisionInput {
    const fearGreed = this.fearGreedFeed?.latest() ?? undefined;
    if (!fearGreed) return input;
    return { ...input, snapshot: { ...input.snapshot, fearGreed } };
  }

  // Trade-flow/CVD: same merge-if-fresh convention as withDerivatives above.
  private withTradeFlow(input: AgentDecisionInput): AgentDecisionInput {
    const tradeFlow = this.tradeFlowFeed?.latest(this.symbol) ?? undefined;
    if (!tradeFlow) return input;
    return { ...input, snapshot: { ...input.snapshot, tradeFlow } };
  }

  // Positioning (global long/short ratio): same merge-if-fresh convention as withDerivatives above.
  private withPositioning(input: AgentDecisionInput): AgentDecisionInput {
    const positioning = this.positioningFeed?.latest(this.symbol) ?? undefined;
    if (!positioning) return input;
    return { ...input, snapshot: { ...input.snapshot, positioning } };
  }

  // #43 liquidation-order flow: same merge-if-fresh convention as withDerivatives above — `latest`
  // answers null while the stream is unhealthy (never started, or currently erroring/reconnecting),
  // NOT merely because the trailing window has zero events (see LiquidationFeedPort's own comment).
  private withLiquidation(input: AgentDecisionInput): AgentDecisionInput {
    const liquidation = this.liquidationFeed?.latest(this.symbol) ?? undefined;
    if (!liquidation) return input;
    return { ...input, snapshot: { ...input.snapshot, liquidation } };
  }

  // Computed indicators (own timeframe + HTF) + own position + decision trail, over the host's
  // immutable snapshot copy.
  private buildContext(input: AgentDecisionInput): AgentContext {
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const closes = candles.map((c) => toIndicatorNumber(c.close));
    const highs = candles.map((c) => toIndicatorNumber(c.high));
    const lows = candles.map((c) => toIndicatorNumber(c.low));
    const lastClose = closes.length > 0 ? closes[closes.length - 1]! : null;

    const indicators: AgentIndicators | null =
      closes.length < INDICATOR_WARMUP_CLOSES
        ? null
        : {
            lastClose: closes[closes.length - 1]!,
            emaFast: emaFromNumbers(closes, 9),
            emaSlow: emaFromNumbers(closes, 21),
            rsi14: rsiFromNumbers(closes, 14),
            atr14: atrFromNumbers(highs, lows, closes, 14),
            ret1: pctChange(closes, 1),
            ret5: pctChange(closes, 5),
            ret20: pctChange(closes, 20),
          };

    const openOrders = input.snapshot.portfolio.openOrders.length;
    // applyFillToPortfolio deletes a position once signedQty hits zero (portfolio-state.service.ts),
    // so a matched entry always carries a real avgEntry — there is no separate "flat position
    // record" to special-case. Push II Phase 8: widened from a LONG-only (signedQty > 0) search to
    // any non-zero signedQty — a shorts-disabled deployment can never actually populate a negative
    // signedQty (no strategy path emits ENTER_SHORT), so this stays byte-identical there.
    let held: Position | undefined;
    let heldSide: 'LONG' | 'SHORT' | undefined;
    for (const p of input.snapshot.portfolio.positions.values()) {
      if (p.symbol === this.symbol && !p.signedQty.isZero()) {
        held = p;
        heldSide = p.signedQty.gt(0) ? 'LONG' : 'SHORT';
        break;
      }
    }

    // A held position whose notional is below the venue minimum is DUST: a reduce-only exit sized to
    // that sub-minNotional qty is rejected BELOW_MINIMUM by the sizer, so it can never be closed.
    // Surfacing it as LONG/SHORT only makes the agent spam un-executable exits (and never reach
    // flat, which also starves round-trip accounting). Treat it as FLAT so the agent holds or
    // re-enters — a fresh entry absorbs the dust into a tradable position. minNotional comes from
    // onInit; null ⇒ skip the reclassification. Decimal comparison only — no float on the money
    // path. abs(): notional is direction-agnostic (a short's signedQty is negative).
    const heldIsDust =
      held !== undefined &&
      this.minNotional !== null &&
      held.signedQty.abs().mul(held.avgEntry).lt(this.minNotional);

    const position: AgentPositionSummary =
      held !== undefined && !heldIsDust
        ? {
            side: heldSide!,
            // qty is always a positive MAGNITUDE regardless of side (never the raw signed value) —
            // direction is conveyed entirely via `side`, so the model never has to interpret a
            // negative "quantity".
            qty: held.signedQty.abs().toFixed(),
            avgEntry: held.avgEntry.toFixed(),
            realizedPnl: held.realizedPnl.toFixed(),
            // Mirrored for SHORT: profit is positive when price FALLS below avgEntry, i.e. the
            // negation of the LONG formula.
            unrealizedPnlPct:
              lastClose === null
                ? null
                : heldSide === 'LONG'
                  ? (lastClose / toIndicatorNumber(held.avgEntry) - 1) * 100
                  : (1 - lastClose / toIndicatorNumber(held.avgEntry)) * 100,
            openOrders,
            // B3: replaces managedPlan — plan-mode only (absent otherwise — legacy payloads stay
            // byte-identical), and only while an activePlan actually exists. Its ABSENCE while
            // positioned is the model's cue that the plan was lost (restart) and it may re-arm via
            // hold+directives (see AgentPositionSummary.directives's own comment).
            ...(this.planMode && this.activePlan
              ? {
                  directives: {
                    entryStyle: this.activePlan.plan.entryStyle,
                    stopLossPct: this.activePlan.plan.stopLossPct,
                    takeProfitPct: this.activePlan.plan.takeProfitPct,
                    maxHoldBars: this.activePlan.plan.maxHoldBars,
                  },
                  barsHeld: this.activePlan.barsElapsed,
                  barsUntilForcedExit: Math.max(
                    0,
                    this.activePlan.plan.maxHoldBars - this.activePlan.barsElapsed,
                  ),
                  ...(this.lastThesis !== undefined ? { currentThesis: this.lastThesis } : {}),
                }
              : {}),
          }
        : {
            side: 'FLAT',
            qty: '0',
            avgEntry: null,
            realizedPnl: '0',
            unrealizedPnlPct: null,
            openOrders,
          };

    return {
      indicators,
      position,
      recentDecisions: [...this.history],
      htf: this.buildHtfContext(candles),
      ...this.buildCrossSymbolContext(candles, input.snapshot.eventTime),
    };
  }

  // Cross-symbol relative-strength ranking (2026-07-12). When enabled AND the shared service is
  // wired AND enough candles exist for the lookback, record THIS symbol's trailing return into the
  // shared basket and attach its ranking to the context. Returns {} otherwise, so a disabled/
  // unwired/warming instance stays byte-identical (no crossSymbol key). Decimal-computed off the
  // reference-grade candle closes — a ranking signal, never a money-path value.
  private buildCrossSymbolContext(
    candles: readonly CandleEvent[],
    eventTime: EpochMs,
  ): { crossSymbol?: AgentCrossSymbol | null } {
    if (!this.crossSymbolEnabled || this.crossSymbolContext === undefined) return {};
    const n = this.crossSymbolLookbackBars;
    if (candles.length <= n) return {};
    const nowClose = new Decimal(candles[candles.length - 1]!.close.toFixed());
    const pastClose = new Decimal(candles[candles.length - 1 - n]!.close.toFixed());
    if (pastClose.lte(0)) return {};
    const ret = nowClose.div(pastClose).minus(1);
    // EpochMs is a branded number — assignable to the service's plain-number clock directly.
    this.crossSymbolContext.record(String(this.symbol), ret, eventTime);
    return { crossSymbol: this.crossSymbolContext.rank(String(this.symbol), eventTime) };
  }

  private buildHtfContext(candles: readonly CandleEvent[]): AgentContext['htf'] {
    return {
      h1: this.buildHtfIndicators(candles, HTF_TARGET_MS.h1),
      h4: this.buildHtfIndicators(candles, HTF_TARGET_MS.h4),
    };
  }

  // factor is only meaningful when the target timeframe folds evenly into whole base-interval
  // buckets and by more than 1 bar (factor === 1 would just be the strategy's own timeframe again).
  private buildHtfIndicators(
    candles: readonly CandleEvent[],
    targetMs: number,
  ): AgentHtfIndicators | null {
    const factor = targetMs / this.baseIntervalMs;
    if (!Number.isInteger(factor) || factor < 2) return null;

    const htfCandles = aggregateCandles(candles, factor, this.baseIntervalMs).filter(
      (c) => c.closed,
    );
    if (htfCandles.length < INDICATOR_WARMUP_CLOSES) return null;

    const closes = htfCandles.map((c) => toIndicatorNumber(c.close));
    return {
      emaFast: emaFromNumbers(closes, 9),
      emaSlow: emaFromNumbers(closes, 21),
      rsi14: rsiFromNumbers(closes, 14),
    };
  }

  // Stub-only fallback: no client-supplied decision to draw confidence/rationale from (the no-op
  // StubAgentClient, or any client that omits `decision`), so just enough is inferred from the
  // mapped signals to keep the decision trail and journal populated.
  private inferStubDecision(signals: readonly Signal[]): AgentDecisionMeta {
    let action: AgentDecisionMeta['action'] = 'hold';
    if (signals.some((s) => s.kind === 'ENTER_LONG')) action = 'long';
    else if (signals.some((s) => s.kind === 'EXIT_LONG' || s.kind === 'FLATTEN')) action = 'flat';
    return { action, confidence: 0, rationale: '' };
  }

  // Fills in the outcome of the PREVIOUS (still-unannotated) history record before this call's
  // decision supersedes it as the ring's tail — priceMovePct off the two decisions' close prices,
  // positionPnlDelta off the exact combined-PnL delta since that decision was made, heldDuring off
  // the position side that was current as of THAT prior decision (lastPositionSide has already been
  // advanced to the CURRENT call's side by trackClosedTrade before decide() reaches here, so it is
  // captured up front, ahead of that advance, by the caller).
  private annotatePreviousOutcome(
    currentClose: number,
    position: AgentPositionSummary,
    lastCandle: CandleEvent | undefined,
    heldDuring: 'LONG' | 'SHORT' | 'FLAT',
  ): void {
    const currentCombinedPnl = this.computeCombinedPnl(position, lastCandle?.close);
    if (this.lastCombinedPnl !== null && this.history.length > 0) {
      const prev = this.history[this.history.length - 1]!;
      // NaN/non-finite guard: an undercandled call seeds close as NaN (see decide()), and prev.close
      // <= 0 makes the percentage move meaningless — either poisons the prompt as a literal "NaN%".
      // Left null (not omitted) so the outcome is still recorded for positionPnlDelta/heldDuring.
      const priceMovePct =
        Number.isFinite(currentClose) && Number.isFinite(prev.close) && prev.close > 0
          ? ((currentClose - prev.close) / prev.close) * 100
          : null;
      const positionPnlDelta = currentCombinedPnl.minus(this.lastCombinedPnl).toFixed();
      this.history[this.history.length - 1] = {
        ...prev,
        outcome: { priceMovePct, positionPnlDelta, heldDuring },
      };
    }
    this.lastCombinedPnl = currentCombinedPnl;
  }

  private computeCombinedPnl(
    position: AgentPositionSummary,
    closePrice: Price | undefined,
  ): Decimal {
    const realized = new Decimal(position.realizedPnl);
    if ((position.side !== 'LONG' && position.side !== 'SHORT') || closePrice === undefined) {
      return realized;
    }
    // avgEntry is always non-null on a LONG/SHORT summary (buildContext's held invariant above).
    // qty is always a positive MAGNITUDE regardless of side (see buildContext's own comment) — the
    // sign of the unrealized PnL comes from which direction closePrice moved relative to avgEntry,
    // mirrored between the two sides (Push II Phase 8: SHORT profits when price FALLS).
    const entry = new Decimal(position.avgEntry!);
    const qty = new Decimal(position.qty);
    const unrealized =
      position.side === 'LONG'
        ? closePrice.minus(entry).times(qty)
        : entry.minus(closePrice).times(qty);
    return realized.plus(unrealized);
  }

  private trackClosedTrade(side: 'LONG' | 'SHORT' | 'FLAT'): void {
    // Push II Phase 8: counts a SHORT→FLAT round trip too (reflection/promotion evidence reads
    // "closed round trips" direction-agnostically) — a shorts-disabled deployment's side can never
    // actually be SHORT, so this stays byte-identical there.
    if (
      (this.lastPositionSide === 'LONG' || this.lastPositionSide === 'SHORT') &&
      side === 'FLAT'
    ) {
      this.closedTrades += 1;
      this.onClosedTrade?.(this.closedTrades);
    }
    this.lastPositionSide = side;
  }

  // basedOnSeq/refPrice for the journal ride on whichever market-data point is freshest, mirroring
  // AnthropicAgentClient's own convention (ticker preferred, else the last closed candle); an
  // 'exec' trigger and a symbol with neither yet fall back to a neutral 0n/null.
  private deriveMarketBasis(input: AgentDecisionInput): {
    readonly basedOnSeq: bigint;
    readonly refPrice: Price | null;
  } {
    const ticker = input.snapshot.tickers.get(this.symbol);
    if (ticker) return { basedOnSeq: ticker.seq, refPrice: ticker.last };
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    if (lastCandle) return { basedOnSeq: lastCandle.seq, refPrice: lastCandle.close };
    return { basedOnSeq: 0n, refPrice: null };
  }

  // proposal is absent only for the prescreen quiet-HOLD path (recordQuietHold) — no client call was
  // ever made, so there is no usage/latency/playbook telemetry to map through; those fields fall back
  // to the same null/'' the client-omits-decision stub path already uses.
  // R2 (episodic memory): the compact regime fingerprint this decision was made in, stamped on EVERY
  // journaled row (decide/quiet/error) so a later consult can retrieve its own past setups by tag
  // equality. Pure derivation from features the payload already carries (indicators + funding sign +
  // eventTime) — the SAME fields the client derives its retrieval query from, so a stored tag and a
  // query tag can never drift. null (⇒ untagged, a fail-open retrieval miss) while indicators are
  // under warmup.
  private regimeTagsFor(input: AgentDecisionInput): ReturnType<typeof deriveRegimeTags> {
    return deriveRegimeTags({
      indicators: input.context?.indicators ?? null,
      fundingRate: input.snapshot.derivatives?.fundingRate ?? null,
      eventTime: input.snapshot.eventTime,
    });
  }

  // v3 (consolidation spec §2/§9): AgentDecisionEntry.action narrowed to the rich-tool-contract-only
  // vocabulary (the fresh v3 agent_decisions DB column carries no legacy literal — trading.schema.ts),
  // but AgentDecisionMeta.action (out of this pass's scope) still widens to the legacy 'long'/'flat'
  // pair for the StubAgentClient fallback path (inferStubDecision above) — the ONE live source of a
  // legacy-shaped decision left in this lane. Map at the journal-write boundary rather than deleting
  // the stub path: 'long' -> 'open_long' (opens/holds a long, same as the legacy tool's semantics),
  // 'flat' -> 'close' (closes any open position) — the same mapping counterfactual-scoring.ts's own
  // header comment documents for reading legacy rows, applied here on the WRITE side so a v3 journal
  // row can never carry the legacy literal in the first place.
  private toJournalAction(action: AgentDecisionMeta['action']): AgentDecisionEntry['action'] {
    if (action === 'long') return 'open_long';
    if (action === 'flat') return 'close';
    return action;
  }

  private recordJournalEntry(
    input: AgentDecisionInput,
    decision: AgentDecisionMeta,
    proposal?: AgentProposal,
  ): void {
    if (!this.journal) return;
    const { basedOnSeq, refPrice } = this.deriveMarketBasis(input);
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    try {
      this.journal.record({
        strategyId: this.id,
        symbol: this.symbol,
        venue: this.venue,
        triggerKind: input.trigger.kind,
        basedOnSeq,
        eventTime: input.snapshot.eventTime,
        model: this.model,
        action: this.toJournalAction(decision.action),
        confidence: decision.confidence,
        rationale: decision.rationale.slice(0, MAX_JOURNAL_RATIONALE_LEN),
        refPrice: refPrice ? refPrice.toFixed() : null,
        close: lastCandle ? lastCandle.close.toFixed() : null,
        inputTokens: proposal?.usage?.inputTokens ?? null,
        outputTokens: proposal?.usage?.outputTokens ?? null,
        cacheReadInputTokens: proposal?.usage?.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: proposal?.usage?.cacheCreationInputTokens ?? null,
        latencyMs: proposal?.latencyMs ?? null,
        playbookVersion: proposal?.playbookVersion ?? null,
        promptHash: proposal?.promptHash ?? '',
        inputPayload: proposal?.inputPayload ?? null,
        // W3.1 follow-on: the accepted plan this decision carried (fresh entry AND restart re-arm —
        // this is the single call site for both, see the plan-bookkeeping block right after this
        // call), for offline replay through the settlement backtest harness. Null on every
        // 'flat'/'hold'-without-plan decision.
        plan: proposal?.plan ?? null,
        // Batch-attribution join key (Push II Phase 5 follow-on) — see AgentProposal.consultId.
        // Null on every non-batched decision.
        consultId: proposal?.consultId ?? null,
        // I1b (Design § New tool contract): the portfolio-level schedule value this decision's
        // proposal carried — see AgentDecisionEntry.nextConsultBars' own comment (rides in plan_json,
        // no new column). Null on every non-batched or pre-v2 decision.
        nextConsultBars: proposal?.nextConsultBars ?? null,
        // v3 (consolidation spec §2/§9): info_arm/thinking_arm dropped — see AgentDecisionEntry's own
        // comment (ports/strategy/agentic-strategy.ts). proposal.infoArm/thinkingArm (the client's own A/B
        // treatment-truth telemetry) still exist and are unaffected; they are simply no longer
        // forwarded to the journal, since the v3 agent_decisions table has no columns for them.
        // R2: regime fingerprint for episodic-memory retrieval — see regimeTagsFor.
        regimeTags: this.regimeTagsFor(input),
      });
    } catch {
      // A journal failure must never affect trading — it's an analysis artifact, not a safety
      // interlock (see AGENT_DECISION_JOURNAL doc in ports/strategy/agentic-strategy.ts).
    }
  }

  private recordErrorJournalEntry(input: AgentDecisionInput, err: unknown): void {
    if (!this.journal) return;
    const { basedOnSeq, refPrice } = this.deriveMarketBasis(input);
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const kind = err instanceof AgentProposeError ? err.kind : 'RETRYABLE';
    const status = err instanceof AgentProposeError ? err.status : undefined;
    try {
      this.journal.record({
        strategyId: this.id,
        symbol: this.symbol,
        venue: this.venue,
        triggerKind: input.trigger.kind,
        basedOnSeq,
        eventTime: input.snapshot.eventTime,
        model: this.model,
        action: 'error',
        confidence: null,
        // Reverses the earlier privacy-conservative kind/status-only rationale (soak-flagged gap):
        // AgentProposeError.message is CLIENT-CONSTRUCTED (anthropic-agent-client.ts builds it from
        // its own fetch/HTTP-layer diagnostics). It is key-free — the api-key is a request HEADER,
        // never in the request body or in a transport-error string. The HTTP-status path DOES embed up
        // to ~500 chars of the Anthropic *error response body*, but that body is provider-side error
        // text (asserted credential-free at the construction site), never the prompt/request body — so
        // persisting a truncated slice here is safe and is the honest "why did this decide error"
        // trail instead of a bare kind. A bare Error (non-AgentProposeError rejection, e.g. a
        // strategy-internal throw) carries NO such guarantee — its .message may echo arbitrary
        // internal state — so that path stays kind-only, unchanged.
        rationale: buildErrorJournalRationale(err, kind, status),
        refPrice: refPrice ? refPrice.toFixed() : null,
        close: lastCandle ? lastCandle.close.toFixed() : null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        playbookVersion: null,
        promptHash: '',
        inputPayload: null,
        // R2: tag error rows too — the regime is still knowable from the input, so a later consult can
        // learn "in this regime a decide errored" alongside its real decisions.
        regimeTags: this.regimeTagsFor(input),
      });
    } catch {
      // See recordJournalEntry — a journal failure must never affect trading.
    }
  }

  // model is 'prescreen' (not this.model) — an honest account that no LLM call was made for this
  // row, distinguishable at a glance from every client-sourced decision on the same strategyId.
  private recordQuietJournalEntry(
    input: AgentDecisionInput,
    rationale: string,
    model: 'prescreen' | 'plan-executor' = 'prescreen',
    // W6: sampled market payload on a plan-managed quiet bar (see quietPayloadSampleBars) — absent
    // callers (prescreen quiet holds, unsampled quiet bars) keep the pre-W6 null, byte-identical.
    inputPayload: string | null = null,
  ): void {
    if (!this.journal) return;
    const { basedOnSeq, refPrice } = this.deriveMarketBasis(input);
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    try {
      this.journal.record({
        strategyId: this.id,
        symbol: this.symbol,
        venue: this.venue,
        triggerKind: input.trigger.kind,
        basedOnSeq,
        eventTime: input.snapshot.eventTime,
        model,
        action: 'hold',
        confidence: null,
        rationale: rationale.slice(0, MAX_JOURNAL_RATIONALE_LEN),
        refPrice: refPrice ? refPrice.toFixed() : null,
        close: lastCandle ? lastCandle.close.toFixed() : null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        playbookVersion: null,
        promptHash: '',
        inputPayload,
        // R2: quiet/prescreen holds are tagged too — a regime in which the lane repeatedly held is
        // itself case-based context worth surfacing.
        regimeTags: this.regimeTagsFor(input),
      });
    } catch {
      // See recordJournalEntry — a journal failure must never affect trading.
    }
  }
}
