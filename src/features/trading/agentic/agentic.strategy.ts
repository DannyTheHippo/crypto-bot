import Decimal from 'decimal.js';
import type { CandleEvent, CandleInterval } from '../../../domain/types/market-events';
import type { Signal } from '../../../domain/types/signal';
import type { StrategyId, VenueId, SymbolId, EpochMs } from '../../../domain/types/ids';
import type { SubscriptionSpec } from '../../../domain/types/subscription';
import type { Position, OpenOrderSummary } from '../../../domain/types/portfolio';
import type { Price } from '../../../domain/types/money';
import {
  toIndicatorNumber,
  price,
  roundToMoneyPrecision,
  roundToTick,
  roundToStep,
} from '../../../domain/types/money';
import { splitSymbol } from '../../../domain/types/symbol';
import { aggregateCandles } from '../../../domain/indicators/candle-aggregate';
import {
  emaFromNumbers,
  rsiFromNumbers,
  atrFromNumbers,
  pctChange,
} from '../../../domain/indicators/indicators';
import {
  AgentProposeError,
  type AsyncStrategy,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentContext,
  type AgentCrossSymbol,
  type AgentTrackRecord,
  type AgentDecisionMeta,
  type AgentHtfIndicators,
  type AgentIndicators,
  type AgentPositionSummary,
  type AgentDecisionRecord,
  type AgentDecisionJournalPort,
  type AgentProposal,
  type StrategyInitContext,
} from '../../../ports/agentic-strategy';
import { MAX_REASON_LEN, type LoggerLike } from './anthropic-agent-client';
import { buildMarketPayload } from './agent-prompt';
import {
  evaluatePrescreen,
  type PrescreenOutcome,
  type PrescreenReason,
  type PrescreenThresholds,
} from './prescreen';
import type { RoundTripEvidencePort } from '../../../ports/promotion';
import type { DerivativesFeedPort } from '../../../ports/derivatives-feed';
import type { SentimentFeedPort } from '../../../ports/sentiment-feed';
import type { TradeFlowFeedPort } from '../../../ports/trade-flow-feed';
import type { PositioningFeedPort } from '../../../ports/positioning-feed';
import type { LiquidationFeedPort } from '../../../ports/liquidation-feed';
import { evaluatePlan, type PlanExecutorAction, type PlanExecutorState } from './plan-executor';
import { CrossSymbolContextService } from './cross-symbol-context';
import { positionKey } from '../../../domain/risk/evaluate';
import type { PlanStop, PlanStopRegistryPort } from '../../../ports/risk';
import type { ExecutionStorePort } from '../../../ports/execution';
import type { AlgoOrderState, ExchangePort } from '../../../ports/exchange';
import { clientOrderId } from '../../../domain/types/ids';
import { roleForDedupeKey, type RestingOrderRole } from '../../../domain/oms/resting-order-role';

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
  // Cost-floor pre-screen gate (see prescreen.ts): consulted before every LLM call unless disabled.
  // Optional/absent ⇒ disabled, so existing callers that predate this field stay byte-identical.
  readonly prescreenEnabled?: boolean;
  readonly prescreenThresholds?: PrescreenThresholds;
  // W2.1 stale-entry sweep: a resting non-reduce-only order older than this many observed decide
  // cycles gets a CANCEL_OPEN (risk-reducing; routed by SignalSink to an order-cancel, never to the
  // gateway). Optional/absent/0 ⇒ disabled, so existing callers stay byte-identical.
  readonly entryTtlBars?: number;
  // W3.1 plan-based trading: the client returns managed trade plans (AgentProposal.plan) and this
  // strategy runs plan-executor.ts between LLM consults. Absent/false ⇒ legacy bar-by-bar behavior.
  readonly planMode?: boolean;
  // Safety re-consult cadence (bars) while a plan is active without executor action. Default 16.
  readonly planMaxQuietBars?: number;
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
  // W4.2 expectancy-laddered strength modulation: scales ENTER_LONG strength by this strategy's
  // rolling realized net expectancy — reduction-only (see the class-level EXPECTANCY_LADDER_* consts
  // for the ladder). Optional/absent ⇒ disabled, so existing callers stay byte-identical. Also inert
  // without AgenticStrategyDeps.evidence — a true flag with no evidence port is a no-op, not an error.
  readonly expectancyLadderEnabled?: boolean;
  // Push 3 P6 Unit 4 (#17 residual): when enabled AND deps.evidence is wired, decide() surfaces
  // {tripCount, winRate, meanNetBpsPerTrip, trailingWindowTrips} over the SAME trailing window/floor
  // the expectancy ladder already uses (EXPECTANCY_LADDER_WINDOW_TRIPS/MIN_TRIPS below) onto the
  // outgoing AgentContext.trackRecord — a decide-side read of realized performance, never a second
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
  // Force-fire threshold (bps), mirrors ports/risk.ts's ProtectiveExitConfig.planStopForceBps: the
  // bar-close executor's own 'stop' exit stands down while a confirmed-resting venue stop should
  // still have room to fill on its own, UNLESS the close has already breached the plan's stop price
  // by more than this many bps — a resting venue stop should already have filled at a small breach,
  // so a wide miss means the venue-side order failed and the bar-close backstop must not defer
  // indefinitely. Independent of PLAN_STOP_WATCH_ENABLED (ProtectiveExitService's OWN 1s watcher,
  // which applies this SAME band on its own faster cadence — see tickPlanStop) — this is the
  // strategy's bar-close copy of that band, needed because AGENTIC_VENUE_STOP may be enabled with
  // the 1s watcher off. Default 30 (matches PLAN_STOP_FORCE_BPS's schema default).
  readonly planStopForceBps?: number;
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
// check is 'stood_down'/'force_fired' below, a distinct decision from the TP's race-hold) plus two
// stop-specific additions: 'stood_down' — the bar-close executor deferred a 'stop' exit to the
// confirmed-resting venue stop (breach within the force band); 'force_fired' — the SAME check found
// the breach past the force band and let the bar-close IOC exit proceed (the venue order evidently
// failed to fill on its own).
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
  | 'force_fired';

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
}

export interface AgenticStrategyDeps {
  readonly journal?: AgentDecisionJournalPort;
  // Fires once per detected LONG→FLAT or (Push II Phase 8) SHORT→FLAT round trip, with the running
  // closed-trade count. A later reflection task subscribes; the strategy itself takes no action
  // beyond counting and calling it.
  readonly onClosedTrade?: (count: number) => void;
  // Fires once per decide() call when the prescreen gate is enabled, with its outcome — mirrors the
  // onClosedTrade seam. Optional/no-op-defaulted so existing tests/callers stay valid. `reason` is
  // the finer PrescreenReason behind the outcome (absent for 'failopen_error': evaluatePrescreen
  // itself threw, so no reason was ever computed).
  readonly onPrescreen?: (outcome: PrescreenOutcome, reason?: PrescreenReason) => void;
  // W4.2 expectancy-laddered strength modulation's data source: realized (venue-fill-derived) closed
  // round trips, the same evidence feed the reflection lane reads (ports/promotion.ts). Optional —
  // absent means the ladder is inert even when expectancyLadderEnabled is true (see that param's own
  // comment); no in-strategy fallback is computed, since the strategy has no other access to
  // realized fills.
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
  // Push 3 P7d: the swap algo/conditional-order rail's round-trip primitives, narrowed off
  // ExchangePort (ports/exchange.ts) — the ONLY port through which this strategy ever reaches the
  // algo rail (never the concrete adapter directly; eslint-plugin-boundaries allows importing
  // `ports/*` types from any feature, so this narrowing stays boundary-clean). Optional: absent (no
  // exchange port wired — paper/test boots, or a spot-only deployment where CcxtExchangeAdapter's
  // own venue-gated methods would answer empty/throw anyway) makes manageVenueStop's PERP branch a
  // no-op (byte-identical: never reached — a spot deployment never calls it, and a perp deployment
  // always wires the real adapter here). Both methods are themselves optional on ExchangePort (only
  // the swap-capable adapter implements them) — every call site guards with `?.`.
  readonly algoOrders?: Pick<ExchangePort, 'fetchOpenAlgoOrders' | 'cancelAlgoOrder'>;
}

const MAX_DECISION_HISTORY = 10;
const INDICATOR_WARMUP_CLOSES = 21;
const MAX_JOURNAL_RATIONALE_LEN = 2000;
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

// W4.2 expectancy-laddered strength modulation. Mean netPnl (USD, Decimal-computed off the evidence
// port's decimal strings) over the last EXPECTANCY_LADDER_WINDOW_TRIPS CLOSED round trips for THIS
// strategyId; fewer than EXPECTANCY_LADDER_MIN_TRIPS ⇒ insufficient data ⇒ full strength.
// RoundTripEvidencePort.recentRoundTrips is lane-wide, not strategyId-scoped (ports/promotion.ts) —
// FETCH_LIMIT over-fetches so filtering down to this.id still has a chance of finding a full window
// in a multi-symbol deployment; the extra rows are discarded below.
const EXPECTANCY_LADDER_WINDOW_TRIPS = 15;
const EXPECTANCY_LADDER_FETCH_LIMIT = 60;
const EXPECTANCY_LADDER_MIN_TRIPS = 8;
// Ladder: mean >= 0 (flat or profitable) -> full strength; mean >= this floor (losing, but only
// slightly) -> 0.7x; else (clearly negative) -> 0.4x. Reduction-only by construction — no branch
// ever exceeds 1.0, so this can only shrink downstream sized notional, never grow it.
const EXPECTANCY_LADDER_SLIGHT_NEGATIVE_FLOOR_USD = '-0.10';
const EXPECTANCY_LADDER_MULTIPLIER_FULL = 1;
const EXPECTANCY_LADDER_MULTIPLIER_SLIGHT_NEGATIVE = 0.7;
const EXPECTANCY_LADDER_MULTIPLIER_NEGATIVE = 0.4;
// Mirrors AnthropicAgentClient's own MIN_STRENGTH floor (anthropic-agent-client.ts) — the ladder must
// never scale a signal's strength below the floor the client itself already enforces on confidence.
const MIN_SIGNAL_STRENGTH = 0.1;

// Concrete agentic strategy: a thin in-process host-side shell that delegates each decision to the
// out-of-process agent client. It enriches the host's snapshot with computed indicators (own
// timeframe + aggregated HTF), the strategy's own position, and a rolling trail of its own past
// decisions before handing off — it still owns NO trading logic itself (Risk still sizes/vetoes
// every proposed signal). The agent's proposed signals flow through the Risk chokepoint (the host
// calls recordSignal); the host imposes the wall-clock timeout, so decide just enriches and
// delegates. Live access is EARNED via the promotion gate, never assumed (see ports/agentic-strategy.ts).
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
  private readonly onPrescreen?: (outcome: PrescreenOutcome, reason?: PrescreenReason) => void;
  private readonly logger: LoggerLike;
  private readonly prescreenEnabled: boolean;
  private readonly prescreenThresholds?: PrescreenThresholds;
  private readonly entryTtlBars: number;
  private readonly planMode: boolean;
  private readonly planMaxQuietBars: number;
  private readonly planExitTtlBars: number;
  private readonly quietPayloadSampleBars: number;
  // W3.1 active managed plan — in-memory by design: a restart loses it, the position_open prescreen
  // then forces a consult, and the model re-arms by attaching a plan to its 'hold' (it sees
  // managedPlan: false in the position summary; the client accepts a re-arm plan while LONG —
  // see anthropic-agent-client.ts). Before that path existed the "model issues a fresh plan"
  // self-heal was aspirational: the model had no signal the plan was gone and the client dropped
  // any plan outside long-from-flat, so restarts silently degraded positions to per-bar consults.
  private activePlan: ActivePlanState | null = null;
  private readonly expectancyLadderEnabled: boolean;
  private readonly trackRecordEnabled: boolean;
  private readonly crossSymbolEnabled: boolean;
  private readonly crossSymbolLookbackBars: number;
  private readonly evidence?: RoundTripEvidencePort;
  private readonly derivativesFeed?: DerivativesFeedPort;
  private readonly sentimentFeed?: SentimentFeedPort;
  private readonly tradeFlowFeed?: TradeFlowFeedPort;
  private readonly positioningFeed?: PositioningFeedPort;
  private readonly liquidationFeed?: LiquidationFeedPort;
  private readonly crossSymbolContext?: CrossSymbolContextService;
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
  private readonly onVenueStop?: (event: VenueStopEvent) => void;
  private readonly algoOrders?: Pick<ExchangePort, 'fetchOpenAlgoOrders' | 'cancelAlgoOrder'>;
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

  // Ring buffer of past decisions, newest-last, capped — self-consistency context handed to the
  // agent each call. The client itself stays stateless; this trail lives host-side in the strategy.
  private readonly history: AgentDecisionRecord[] = [];
  // Combined (realized + unrealized) PnL at the time the most recently pushed, not-yet-annotated
  // history record was made — diffed against the next call's combined PnL to fill that record's
  // outcome.positionPnlDelta just before it is superseded by the new decision.
  private lastCombinedPnl: Decimal | null = null;
  // Push II Phase 8: widened to include 'SHORT' — a shorts-disabled deployment's position can never
  // actually be SHORT (buildContext/position-sizer never assign it), so this stays byte-identical.
  private lastPositionSide: 'LONG' | 'SHORT' | 'FLAT' | null = null;
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
    this.onPrescreen = deps.onPrescreen;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.prescreenEnabled = params.prescreenEnabled ?? false;
    this.prescreenThresholds = params.prescreenThresholds;
    this.entryTtlBars = params.entryTtlBars ?? 0;
    this.planMode = params.planMode ?? false;
    this.planMaxQuietBars = params.planMaxQuietBars ?? 16;
    this.planExitTtlBars = Math.max(2, params.planExitTtlBars ?? 2);
    this.quietPayloadSampleBars = Math.max(0, params.quietPayloadSampleBars ?? 0);
    this.expectancyLadderEnabled = params.expectancyLadderEnabled ?? false;
    this.trackRecordEnabled = params.trackRecordEnabled ?? false;
    this.crossSymbolEnabled = params.crossSymbolEnabled ?? false;
    this.crossSymbolLookbackBars = Math.max(1, params.crossSymbolLookbackBars ?? 20);
    this.evidence = deps.evidence;
    this.derivativesFeed = deps.derivativesFeed;
    this.sentimentFeed = deps.sentimentFeed;
    this.tradeFlowFeed = deps.tradeFlowFeed;
    this.positioningFeed = deps.positioningFeed;
    this.liquidationFeed = deps.liquidationFeed;
    this.crossSymbolContext = deps.crossSymbolContext;
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
    this.onVenueStop = deps.onVenueStop;
    this.algoOrders = deps.algoOrders;
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
    this.planStopRegistry?.clear(positionKey(this.id, this.venue, this.symbol));
  }

  // Populates the plan-stop registry the moment a plan's entry fills (entryPrice transitions
  // null → non-null in runActivePlan — see that call site's own comment, which covers BOTH a fresh
  // entry fill and the restart re-arm case identically). Mirrors plan-executor.ts's own stop-price
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
      this.withPositioning(this.withTradeFlow(this.withSentiment(this.withDerivatives(rawInput)))),
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

    // W3.1: an active plan is managed deterministically — the LLM is consulted only on the safety
    // cadence (planMaxQuietBars) or once the plan clears. Returns null to fall through to a consult.
    if (this.planMode && this.activePlan) {
      const planSignals = await this.runActivePlan(input, context, heldDuringPrev);
      if (planSignals !== null) return [...staleCancels, ...planSignals];
    }

    const prescreenReason = this.evaluatePrescreenGate(input, context);
    if (prescreenReason !== null) {
      return [
        ...staleCancels,
        ...this.recordQuietHold(input, context, heldDuringPrev, prescreenReason),
      ];
    }

    // Push 3 P6 Unit 4: fetched HERE (not inside buildContext, which is synchronous) and only right
    // before the one call site that actually renders it to the model — the plan-managed/prescreen-
    // quiet paths above never reach this line, so a bar the LLM isn't even consulted on never spends
    // an extra evidence-port round trip on track-record context it would never send.
    const trackRecordCtx = await this.computeTrackRecordContext();
    let proposal: AgentProposal;
    try {
      proposal = await this.client.propose({
        ...input,
        context: { ...context, ...trackRecordCtx },
      });
    } catch (err) {
      this.recordErrorJournalEntry(input, err);
      throw err;
    }

    const signals = await this.applyExpectancyLadder(proposal.signals);
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const lastClose = lastCandle ? toIndicatorNumber(lastCandle.close) : NaN;

    // decision is the client's own account when present; the stub client (and any client that
    // omits it) leaves this to a signal-inferred fallback so the decision trail stays populated.
    const decision = proposal.decision ?? this.inferStubDecision(signals);

    this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);

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

    this.recordJournalEntry(input, decision, proposal);

    // W3.1 plan bookkeeping: a returned plan REPLACES any active one (fresh clock); an explicit
    // 'flat' clears it (the exit signal above closes the position the plan was managing). A plan
    // returned on 'hold' while LONG is the restart re-arm (entryPrice: null here — the first
    // managed bar anchors it to the position's real avgEntry, see runActivePlan).
    const orphanEntryCancels: Signal[] = [];
    if (this.planMode) {
      const prior = this.activePlan;
      if (proposal.plan) {
        this.activePlan = {
          plan: proposal.plan,
          entryPrice: null,
          barsElapsed: 0,
          venueTpPlacedAtBar: null,
          venueStopPlacedAtBar: null,
        };
      } else if (decision.action === 'flat') {
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

    return [...staleCancels, ...orphanEntryCancels, ...signals];
  }

  // W3.1 per-bar management of the active plan. Non-null return = this bar is fully handled without
  // an LLM call; null = fall through to the normal consult path (safety re-consult cadence).
  private async runActivePlan(
    input: AgentDecisionInput,
    context: AgentContext,
    heldDuringPrev: 'LONG' | 'SHORT' | 'FLAT',
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
    if (
      (context.position.side === 'LONG' || context.position.side === 'SHORT') &&
      active.entryPrice === null
    ) {
      active.entryPrice = context.position.avgEntry;
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
      // applies (tickPlanStop, ports/risk.ts's planStopForceBps), just on this strategy's coarser
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
      const exitSignal: Signal = {
        strategyId: this.id,
        venue: this.venue,
        symbol: this.symbol,
        kind: isShort ? 'EXIT_SHORT' : 'EXIT_LONG',
        strength: 1,
        refPrice: lastCandle.close,
        basedOnSeq: lastCandle.seq,
        eventTime: input.snapshot.eventTime,
        // planExitTtlBars × interval, never one bar: this EXIT faces the gateway TTL check and
        // its age is already ≈ one bar at emission (eventTime anchors to the evaluated close).
        ttlMs: this.planExitTtlBars * this.baseIntervalMs,
        dedupeKey: `${this.id}:${this.symbol}:agentic:plan_exit:${input.snapshot.eventTime}`,
        reason: `plan exit: ${verdict.reason}`,
      };
      // AGENTIC_VENUE_TP/AGENTIC_VENUE_STOP: a resting TP/stop order locks the base/margin at the
      // venue — cancel it BEFORE this full-size IOC exit, else the exit venue-rejects for
      // insufficient balance. Stop/max_hold only: a take_profit crossing this close-price check
      // while a TP still rests is the venue order's own fill path racing this bar's evaluation, not
      // a case this cancel-first guard targets (out of the explicit brief scope for this feature).
      // Push 3 P7c/P7d: deliberately ROLE-AGNOSTIC on the SPOT open-orders rail
      // (restingOrderForSide, not restingOrderForRole) — a full-size exit is blocked by ANY resting
      // reduce-only order on this side, TP or protective stop alike, and the CANCEL_OPEN below
      // carries no cancelRole so SignalSinkService's cancelOpenForSignal cancels every side-matching
      // order in one signal (both roles cleared before the exit submits). PERP: a resting venue
      // STOP_MARKET lives on the algo rail, never in openOrders, so the side-scan above can never
      // see it — cancelPerpAlgoStopIfResting reaches it directly off `stopEntry` (captured above,
      // BEFORE clearPlan() deleted the registry row), best-effort (see that method's own comment).
      if (
        (this.venueTpEnabled || this.venueStopEnabled) &&
        (verdict.reason === 'stop' || verdict.reason === 'max_hold')
      ) {
        const cancelSignals: Signal[] = [];
        const restingExit = this.restingOrderForSide(input, tpSide);
        if (restingExit) {
          this.onVenueTp?.('cancel_for_exit');
          if (this.venueStopEnabled) this.onVenueStop?.('cancel_for_exit');
          cancelSignals.push(
            this.buildCancelOpenSignal(
              input,
              lastCandle,
              tpSide,
              `venue take-profit/stop: cancel resting ${tpSide} ahead of full-size exit`,
            ),
          );
        }
        if (this.venueStopEnabled && this.isPerpVenue()) {
          await this.cancelPerpAlgoStopIfResting(stopEntry, tpSide, 'cancel_for_exit');
        }
        if (cancelSignals.length > 0) return [...cancelSignals, exitSignal];
      }
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

    // hold: consult only on the safety cadence, else this bar is a deterministic no-call hold.
    if (active.barsElapsed % this.planMaxQuietBars === 0) return null;
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
      'plan active — deterministic hold',
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
  // rests a STOP_LOSS_LIMIT on the regular open-orders rail (mirrors manageVenueTp almost exactly);
  // PERP rests a STOP_MARKET on the swap algo/conditional rail instead, which never appears in
  // openOrders (see AlgoOrderState's own header comment in ports/exchange.ts), so reconciliation
  // there goes through AgenticStrategyDeps.algoOrders.fetchOpenAlgoOrders. No-op ([]) whenever the
  // flag is off, position isn't LONG/SHORT, or the resting order is already correctly priced/sized.
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

  // SPOT reconciliation: mirrors manageVenueTp's own place/drift/qty loop, role-scoped to 'vsl' via
  // restingOrderForRole. The one structural difference is the drift EXPECTATION: a resting
  // STOP_LOSS_LIMIT's own OpenOrderSummary.limitPrice is the BUFFERED limit leg PositionSizerService
  // built past the trigger (position-sizer.service.ts's isRestingStopExit branch), never the raw
  // trigger — comparing against the raw trigger would read the buffer itself (default 50bps) as
  // permanent drift and churn cancel/re-place forever, so spotStopExpectedLimit replicates the
  // sizer's own buffer formula before comparing.
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
    // candidate is visible to the placement decision below — restingOrderForRole's own collapsed
    // 'unknown' would read a store throw identically to "no stop rests here", placing a DUPLICATE
    // next to one already resting server-side. See roleForOrderChecked's own header comment.
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
      // Fail-toward-no-op: a transient store failure proves nothing about whether a stop already
      // rests — SKIP placement this bar (retry next bar) rather than risk placing a duplicate.
      // Deliberately does NOT touch setVenueStopResting: an unverified `true` here would falsely
      // stand down the bar-close force-band/watcher backstop (CLAUDE.md fail-direction: leaving it
      // at its last-known value, never optimistically flipping it, is the safe direction).
      this.logger.warn(
        `venue-stop reconcile: intent-store lookup failed for ${this.symbol} — skipping this bar's placement decision to avoid a duplicate stop`,
      );
      return [];
    }

    if (!restingVsl) {
      // Confirm-before-flag, mirrored on the way DOWN too: a reconcile bar that finds nothing
      // resting (filled, cancelled, or never acked) must never leave the registry claiming a stop is
      // resting — the watcher's stand-down/force-band decision reads this flag directly.
      this.setVenueStopResting(key, false);
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
    const open = (await this.algoOrders?.fetchOpenAlgoOrders?.(this.symbol)) ?? [];
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
      this.setVenueStopResting(key, false);
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
      } catch {
        // Best-effort, same as the drift branch above.
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
      return; // best-effort — retried next bar, same failure direction as the rest of this lane
    }
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
      // Best-effort — see cancelPerpAlgoStopIfResting's own comment on the failure direction.
    }
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
    } catch {
      // Best-effort — see this method's own header comment on the failure direction.
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

  // Cost-floor gate (see prescreen.ts). Disabled ⇒ null unconditionally: no counter, no evaluation,
  // unchanged behavior. Enabled ⇒ evaluated over the same candle window buildContext already read for
  // this call, reusing its dust-aware LONG/FLAT classification (context.position.side) rather than
  // re-deriving position-open from the raw portfolio. Returns the quiet reason string when the LLM
  // call should be skipped, else null (either "consult" or the gate itself failed open on an error).
  private evaluatePrescreenGate(input: AgentDecisionInput, context: AgentContext): string | null {
    if (!this.prescreenEnabled || !this.prescreenThresholds) return null;

    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    try {
      const result = evaluatePrescreen({
        closes: candles.map((c) => toIndicatorNumber(c.close)),
        highs: candles.map((c) => toIndicatorNumber(c.high)),
        lows: candles.map((c) => toIndicatorNumber(c.low)),
        // Push II Phase 8: position-open is direction-agnostic — a shorts-disabled deployment's side
        // can never actually be 'SHORT', so this stays byte-identical there.
        positionOpen: context.position.side === 'LONG' || context.position.side === 'SHORT',
        thresholds: this.prescreenThresholds,
      });
      if (result.consult) {
        this.onPrescreen?.('called', result.reason);
        return null;
      }
      this.onPrescreen?.('skipped_quiet', result.reason);
      return result.reason;
    } catch (err) {
      this.logger.warn(
        `prescreen evaluation failed, failing open to the LLM: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.onPrescreen?.('failopen_error');
      return null;
    }
  }

  // W4.2 expectancy-laddered strength modulation. Disabled, no evidence port wired, or no ENTER_LONG
  // signal present ⇒ returns signals unchanged with no DB round trip. Other signal kinds (EXIT_LONG,
  // CANCEL_OPEN, etc.) are never touched — only ENTER_LONG strength is reduction-scaled.
  private async applyExpectancyLadder(signals: readonly Signal[]): Promise<Signal[]> {
    if (!this.expectancyLadderEnabled || !this.evidence) return [...signals];
    if (!signals.some((s) => s.kind === 'ENTER_LONG')) return [...signals];

    const multiplier = await this.computeExpectancyMultiplier();
    if (multiplier === EXPECTANCY_LADDER_MULTIPLIER_FULL) return [...signals];

    return signals.map((s) =>
      s.kind === 'ENTER_LONG'
        ? { ...s, strength: Math.max(MIN_SIGNAL_STRENGTH, s.strength * multiplier) }
        : s,
    );
  }

  // Fetches the evidence port's lane-wide recent round trips, filters to this strategy's own closed
  // trips, and maps the trailing window's mean net PnL onto the ladder. Any failure (including too
  // little data) fails open to full strength — the ladder is risk-reducing, so its own errors must
  // never risk-increase by mistake in the other direction.
  private async computeExpectancyMultiplier(): Promise<number> {
    if (!this.evidence) return EXPECTANCY_LADDER_MULTIPLIER_FULL;
    try {
      const trips = await this.evidence.recentRoundTrips(EXPECTANCY_LADDER_FETCH_LIMIT);
      const mine = trips
        .filter((t) => t.strategyId === this.id)
        .slice(-EXPECTANCY_LADDER_WINDOW_TRIPS);
      if (mine.length < EXPECTANCY_LADDER_MIN_TRIPS) return EXPECTANCY_LADDER_MULTIPLIER_FULL;

      const sum = mine.reduce((acc, t) => acc.plus(t.netPnl), new Decimal(0));
      const mean = sum.div(mine.length);
      if (mean.gte(0)) return EXPECTANCY_LADDER_MULTIPLIER_FULL;
      if (mean.gte(EXPECTANCY_LADDER_SLIGHT_NEGATIVE_FLOOR_USD)) {
        return EXPECTANCY_LADDER_MULTIPLIER_SLIGHT_NEGATIVE;
      }
      return EXPECTANCY_LADDER_MULTIPLIER_NEGATIVE;
    } catch (err) {
      this.logger.warn(
        `expectancy-ladder evaluation failed, defaulting to full strength: ${err instanceof Error ? err.message : String(err)}`,
      );
      return EXPECTANCY_LADDER_MULTIPLIER_FULL;
    }
  }

  // Push 3 P6 Unit 4 (#17 residual): surfaces {tripCount, winRate, meanNetBpsPerTrip,
  // trailingWindowTrips} over the SAME trailing window/floor the expectancy ladder computes from
  // (EXPECTANCY_LADDER_WINDOW_TRIPS/MIN_TRIPS above) — decide-side read-only context, never a second
  // risk-modulating mechanism. Disabled, no evidence port wired, insufficient trips, or any failure
  // all resolve to {} (the omit-entirely convention buildCrossSymbolContext already uses) — never a
  // populated key with garbage data.
  private async computeTrackRecordContext(): Promise<{ trackRecord?: AgentTrackRecord }> {
    if (!this.trackRecordEnabled || !this.evidence) return {};
    try {
      const trips = await this.evidence.recentRoundTrips(EXPECTANCY_LADDER_FETCH_LIMIT);
      const mine = trips
        .filter((t) => t.strategyId === this.id)
        .slice(-EXPECTANCY_LADDER_WINDOW_TRIPS);
      if (mine.length < EXPECTANCY_LADDER_MIN_TRIPS) return {};

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
      return {
        trackRecord: {
          tripCount: mine.length,
          winRate: wins / mine.length,
          meanNetBpsPerTrip: bpsCount > 0 ? bpsSum.div(bpsCount).toNumber() : 0,
          trailingWindowTrips: EXPECTANCY_LADDER_WINDOW_TRIPS,
        },
      };
    } catch (err) {
      this.logger.warn(
        `track-record context failed, omitting: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  }

  // Deterministic HOLD path taken when the prescreen gate skips the LLM call entirely: no client
  // call, no token/decide counters (MetricsWrappingAgentClient never runs), an honest journal row
  // naming the prescreen reason under a distinct 'prescreen' model tag, and the same empty-signal
  // result shape decide() returns for any other HOLD. Unlike a real decision, this skip is NOT pushed
  // into the history ring: the ring is rendered to the LLM as its own prior decisions (agent-prompt.ts),
  // and a prescreen skip was never seen or reasoned about by the model — presenting it as such would
  // fabricate a decision the agent never made. annotatePreviousOutcome still runs unconditionally so
  // the last REAL decision's outcome (price move, PnL delta) keeps accruing through the quiet period.
  private recordQuietHold(
    input: AgentDecisionInput,
    context: AgentContext,
    heldDuringPrev: 'LONG' | 'SHORT' | 'FLAT',
    reason: string,
  ): Signal[] {
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const lastClose = lastCandle ? toIndicatorNumber(lastCandle.close) : NaN;
    const rationale = `prescreen: ${reason} — LLM not consulted`;

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
            // Plan-mode only (absent otherwise — legacy payloads stay byte-identical): lets the
            // model see whether plan-executor is managing this position. false ⇒ the plan was lost
            // (restart) and the model may re-arm via hold+plan (see AgentPositionSummary).
            ...(this.planMode ? { managedPlan: this.activePlan !== null } : {}),
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
        action: decision.action,
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
        // Factorial-cell truth (migration 0012): treatment polarity — info_arm true = info bundle
        // PRESENT, thinking_arm true = adaptive thinking ON. Null when no LLM call was attempted
        // (quiet/prescreen rows never carry a proposal).
        infoArm: proposal?.infoArm ?? null,
        thinkingArm: proposal?.thinkingArm ?? null,
      });
    } catch {
      // A journal failure must never affect trading — it's an analysis artifact, not a safety
      // interlock (see AGENT_DECISION_JOURNAL doc in ports/agentic-strategy.ts).
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
        // Never the underlying message: it may echo transport detail beyond kind/status. Never the
        // key, never the response body.
        rationale: status !== undefined ? `${kind} (status ${status})` : kind,
        refPrice: refPrice ? refPrice.toFixed() : null,
        close: lastCandle ? lastCandle.close.toFixed() : null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        playbookVersion: null,
        promptHash: '',
        inputPayload: null,
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
      });
    } catch {
      // See recordJournalEntry — a journal failure must never affect trading.
    }
  }
}
