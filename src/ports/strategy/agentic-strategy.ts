import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
  CandleInterval,
} from '../domain/types/market-events';
import type { ExecReport } from '../domain/types/exec-report';
import type { Signal } from '../domain/types/signal';
import type { StrategyPortfolioView } from '../domain/types/portfolio';
import type { StrategyId, VenueId, SymbolId, EpochMs } from '../domain/types/ids';
import type { SubscriptionSpec } from '../domain/types/subscription';
import type { Price, Qty } from '../domain/types/money';
import type { DerivativesSnapshot } from './derivatives-feed';
import type { SentimentSnapshot } from './sentiment-feed';
import type { FearGreedSnapshot } from './fear-greed-feed';
import type { TradeFlowSnapshot } from './trade-flow-feed';
import type { PositioningSnapshot } from './positioning-feed';
import type { LiquidationSnapshot } from './liquidation-feed';

// ── StrategyInitContext ───────────────────────────────────────────────────────
//
// Passed once to AsyncStrategy.onInit; contains validated params plus per-symbol
// exchange constraints needed for order-hint construction.

export interface SymbolConstraints {
  readonly tickSize: Price;
  readonly lotStep: Qty;
  readonly minNotional: Price;
}

export interface StrategyInitContext {
  readonly params: Readonly<Record<string, unknown>>;
  readonly warmupCandles: ReadonlyMap<SymbolId, readonly CandleEvent[]>;
  readonly symbolConstraints: ReadonlyMap<SymbolId, SymbolConstraints>;
}

// ── The agentic (async) strategy lane ───────────────────────────────────────
//
// OWNER-AUTHORIZED, BOUNDED EXCEPTION to the strategy-determinism rule, for THIS lane only:
// an `AsyncStrategy` MAY be async and call an out-of-process LLM/agent at runtime, so it is NOT
// pure / synchronous / `eventTime`-only / seeded-RNG / replay-byte-identical. Everything else still
// binds exactly as for the pure lane: it only PROPOSES `Signal`s — Risk still sizes/vetoes them, the
// `eslint-plugin-boundaries` wall forbids it importing execution/adapter (Risk routing is the only
// path), and the paper-default + four live gates are unchanged. Because its live decisions are not
// historically reproducible it CANNOT be certified by the replay-based step-D gate: live access is
// EARNED, not assumed — assertAgenticLaneNotLive refuses a live boot unless the
// PromotionReadinessService verdict passes (>=30 closed demo round trips AND positive net-of-cost
// PnL over >=14 days), and the four-gate arming ceremony still binds on top. See
// docs/archive/nightly-improvement.md (historical step-D program) and CLAUDE.md rule 4.

// An immutable, point-in-time copy of market state handed to an agent at decide() time. Unlike the
// live host `MarketView`, every container here is COPIED at call time (arrays/maps cloned; the
// contained events are themselves immutable value objects), so a decision that resolves AFTER the
// host has mutated its state still observes exactly the snapshot it was called with — closing the
// post-await race a live view would expose.
export interface AgentMarketSnapshot {
  readonly eventTime: EpochMs;
  // Recent closed candles per subscribed symbol, oldest→newest (host-bounded copy).
  readonly candles: ReadonlyMap<SymbolId, readonly CandleEvent[]>;
  // Last seen ticker / book snapshot per symbol.
  readonly tickers: ReadonlyMap<SymbolId, TickerEvent>;
  readonly books: ReadonlyMap<SymbolId, OrderBookSnapshotEvent>;
  // Exec/fill reports accumulated since the previous decide (folded in, never dropped).
  readonly execReports: readonly ExecReport[];
  readonly portfolio: StrategyPortfolioView;
  // C1: latest polled derivatives-market context (funding rate, open interest, mark/index basis) for
  // the snapshot's symbol — absent unless DERIVATIVES_FEED_ENABLED is on AND a fresh poll landed
  // (see DerivativesFeedPort.latest). Optional so every existing caller/fixture that predates this
  // field stays byte-identical; threaded in by AgenticStrategy.decide() (agentic.strategy.ts), never
  // by the host's own buildSnapshot.
  readonly derivatives?: DerivativesSnapshot;
  // C4: latest polled sentiment/news headlines — absent unless SENTIMENT_FEED_ENABLED is on, a key
  // is configured, AND a fresh poll landed (see SentimentFeedPort.latest). Optional so every existing
  // caller/fixture that predates this field stays byte-identical; threaded in by
  // AgenticStrategy.decide() (agentic.strategy.ts), never by the host's own buildSnapshot.
  readonly sentiment?: SentimentSnapshot;
  // X3a: latest polled Crypto Fear & Greed Index reading — absent unless FEAR_GREED_FEED_ENABLED is
  // on AND a fresh poll landed (see FearGreedFeedPort.latest). Optional so every existing caller/
  // fixture that predates this field stays byte-identical; threaded in by AgenticStrategy.decide(),
  // never by the host's own buildSnapshot. Lane-wide (no symbol argument), same convention as
  // sentiment above.
  readonly fearGreed?: FearGreedSnapshot;
  // Trade-flow/CVD context (taker aggressor imbalance) — absent unless AGENTIC_TRADEFLOW_ENABLED is
  // on AND a fresh poll landed (see TradeFlowFeedPort.latest). Optional so every existing caller/
  // fixture that predates this field stays byte-identical; threaded in by AgenticStrategy.decide(),
  // never by the host's own buildSnapshot. Gated together with derivatives/crossSymbol/positioning
  // under the information-context A/B (see anthropic-agent-client.ts).
  readonly tradeFlow?: TradeFlowSnapshot;
  // Positioning context (global long/short account ratio) — absent unless AGENTIC_POSITIONING_ENABLED
  // is on AND a fresh poll landed (see PositioningFeedPort.latest). Same optionality/gating
  // convention as tradeFlow above.
  readonly positioning?: PositioningSnapshot;
  // #43 liquidation-order flow (Push 3 P6 Unit 2) — absent unless AGENTIC_LIQUIDATIONS_ENABLED is on
  // AND the WS stream is currently healthy (see LiquidationFeedPort.latest; a healthy stream with
  // zero events in its trailing window still supplies a snapshot — count: 0, never absent for that
  // reason). Same optionality/gating convention as tradeFlow above.
  readonly liquidation?: LiquidationSnapshot;
}

// Per-strategy position summary the host derives from the live PORTFOLIO_VIEW, handed to the
// agent alongside the market snapshot so it reasons over its own book, not just price action.
export interface AgentPositionSummary {
  // Push II Phase 8: widened to include 'SHORT' — plan-mode shorts (AGENTIC_SHORTS_ENABLED, perp-
  // capable venue only) key their bookkeeping off THIS field, never off AgentDecisionMeta.action
  // (which stays 'long' | 'flat' | 'hold' — see that type's own comment on why action itself is not
  // widened). A deployment with shorts disabled can never populate 'SHORT' here, so this stays
  // byte-identical for every existing (long-only) caller.
  readonly side: 'LONG' | 'SHORT' | 'FLAT';
  readonly qty: string; // exact decimal string; '0' when flat
  readonly avgEntry: string | null;
  readonly realizedPnl: string;
  readonly unrealizedPnlPct: number | null; // indicator-grade float, not money
  readonly openOrders: number;
  // B3 (rich decision contract, Design § Model-owned exits): replaces managedPlan — mirrors
  // agent-prompt.ts's TradeContractDirectives shape (minus thesis, rendered separately below) so the
  // wiring step (I1) is a straight passthrough into BuildMarketPayloadExtras. Plan-mode only, and
  // only while actually positioned (absent otherwise — legacy/flat payloads stay byte-identical).
  // The active plan is in-memory and does not survive a restart: an ABSENT `directives` while
  // positioned is the model's cue that its position is UNMANAGED (the plan was lost) and it may
  // re-arm by attaching directives to a 'hold' (the client's re-arm acceptance path) — this replaces
  // managedPlan's old explicit `false` with the same "nothing enforced" signal conveyed by omission,
  // matching every other v2 block's omit-entirely convention.
  readonly directives?: {
    readonly entryStyle: 'maker' | 'taker';
    readonly stopLossPct: string;
    readonly takeProfitPct: string;
    readonly maxHoldBars: number;
  };
  // Bars elapsed under the CURRENT directive set (plan-executor.ts's single barsElapsed clock,
  // never reset by 'adjust' — see ActivePlanState) and bars remaining before maxHoldBars forces an
  // exit (maxHoldBars - barsHeld, floored at 0). Present exactly when `directives` is.
  readonly barsHeld?: number;
  readonly barsUntilForcedExit?: number;
  // The model's own persisted thesis (AgentDirectives.thesis) from its last directive-bearing
  // decision on this position, fed back verbatim so it can revise or confirm its own prior
  // reasoning rather than starting cold each consult. Present exactly when `directives` is AND a
  // thesis has been supplied on some prior directive for the CURRENT plan's lifetime.
  readonly currentThesis?: string;
}

// Host-computed technical indicators over the closed-candle history — the agent gets these
// pre-derived rather than raw candles + its own math, so every call reasons over the same numbers.
export interface AgentIndicators {
  readonly lastClose: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly rsi14: number;
  readonly atr14: number;
  readonly ret1: number;
  readonly ret5: number;
  readonly ret20: number;
}

export interface AgentDecisionRecord {
  readonly eventTime: EpochMs;
  // B2: widened to the SAME v2 action vocabulary as AgentDecisionMeta.action (see that field's own
  // comment) — this ring is populated directly from decision.action (agentic.strategy.ts's decide()),
  // so it must accept whatever that field accepts. Purely a type-surface widen: this ring's own
  // rendering (agent-prompt.ts's recentDecisions block) is unchanged by B2 — giving v2 actions their
  // own rendering treatment is directive-lifecycle territory (B3). v3: 'error' ADDITIVE too, mirroring
  // AgentDecisionMeta.action's own v3 widen (a capability-violation degrade's decision.action flows
  // straight into this ring exactly like every other decision).
  readonly action:
    | 'open_long'
    | 'open_short'
    | 'close'
    | 'adjust'
    | 'hold'
    | 'long'
    | 'flat'
    | 'error';
  readonly close: number;
  readonly reason: string;
  // Forward-looking outcome of THIS decision, filled in later (once price has moved / the position
  // has been marked) — never on the row itself at write time. priceMovePct is indicator-grade float,
  // null when the close backing the move was non-finite or the prior close was non-finite/<= 0 (kept
  // null rather than NaN so it round-trips through JSON honestly and renders "n/a" instead of "NaN%").
  // positionPnlDelta is an exact decimal string (money path). heldDuring records the position side
  // the strategy was actually carrying while this decision's outcome accrued, so "+2%" can be told
  // apart from "+2% while flat" — otherwise inaction and a held win read identically to the model.
  readonly outcome?: {
    readonly priceMovePct: number | null;
    readonly positionPnlDelta: string;
    // Widened alongside AgentPositionSummary.side above (Push II Phase 8) — a shorts-disabled
    // deployment's position side can never actually be 'SHORT', so this stays byte-identical there.
    readonly heldDuring: 'LONG' | 'SHORT' | 'FLAT';
  };
}

// Higher-timeframe indicator snapshot the host derives by aggregating the base-interval candle
// history (see domain/indicators/candle-aggregate.ts) — longer-horizon trend/momentum context
// alongside the strategy's own timeframe.
export interface AgentHtfIndicators {
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly rsi14: number;
}

// Enrichment the host attaches on top of the raw AgentMarketSnapshot: indicators, the strategy's
// own position, and a short rolling trail of its own past decisions (self-consistency context).
// Cross-symbol relative-strength ranking of this symbol within the traded basket (see
// cross-symbol-context.ts). All return figures are percentage strings (reference-grade context, not
// a money path). Absent when fewer than 2 symbols have fresh recorded returns.
export interface AgentCrossSymbol {
  readonly rank: number; // 1 = strongest of `of`
  readonly of: number;
  readonly ownReturnPct: string;
  readonly strongest: { readonly symbol: string; readonly returnPct: string };
  readonly weakest: { readonly symbol: string; readonly returnPct: string };
}

// Push 3 P6 Unit 4 (#17 residual): the strategy's own realized decide-side track record over a
// trailing window of CLOSED round trips — the same window/floor the renamed TRACK_RECORD_* consts
// define (agentic.strategy.ts — B3 deleted the expectancy ladder outright; these consts were renamed,
// not removed), surfaced as read-only context rather than a second risk-modulating mechanism. Present
// only when AGENTIC_TRACK_RECORD_ENABLED is on, a RoundTripEvidencePort is wired, and enough trips
// exist.
export interface AgentTrackRecord {
  readonly tripCount: number;
  readonly winRate: number; // 0..1, fraction of tripCount with netPnl > 0
  readonly meanNetBpsPerTrip: number; // mean of netPnl / (entryVwap * boughtQty) * 10_000
  readonly trailingWindowTrips: number; // the configured window size, not necessarily === tripCount
  // P4 (Design § Learning & measurement stack): the lane's cumulative net-of-cost bps over the SAME
  // trailing window (the SUM of trip bps, not meanNetBpsPerTrip's per-trip average — a per-trip mean
  // isn't comparable to a single buy-and-hold return spanning the whole window) MINUS a simple
  // buy-and-hold return of BTC / an equal-weight basket over that window, in bps — alpha, not just
  // return. Pure math lives in benchmark-alpha.ts (computeHoldReturnFraction/
  // computeEqualWeightBasketReturnFraction/computeAlphaBps), independently tested there. Optional and
  // independently absent: each field is populated ONLY when the caller had a window-aligned benchmark
  // candle series — a single agentic instance's own streamed candle buffer is siloed to its own
  // symbol (see cross-symbol-context.ts's header comment), so basket alpha needs cross-symbol candle
  // access no instance has today, and BTC alpha is only directly available to a BTC-symbol instance's
  // own buffer. P4b (agentic.strategy.ts's computeTrackRecordContext/computeBenchmarkAlpha) wires
  // netVsBtcHoldBps from exactly that BTC-symbol-instance buffer, coverage-guarded against the trip
  // window's endpoints; netVsEqualWeightBasketBps still has no genuine source (same gap
  // AgentPortfolioBlock.correlation's btcBeta carries) and stays unpopulated until a real
  // multi-symbol history store exists — inventing one was out of this change's scope. Never populate
  // either field with a partial/mismatched-window figure — omitted beats wrong, same fail-open
  // convention this whole interface already uses.
  readonly netVsBtcHoldBps?: number;
  readonly netVsEqualWeightBasketBps?: number;
}

// S2 (rich decision contract, Design § Enriched model inputs): the portfolio/budget/calendar block
// shapes — RELOCATED here from agent-prompt.ts (S1 defined them locally under these SAME field names,
// with an explicit comment that their "eventual home is src/ports/agentic-strategy.ts, owned by a
// LATER step (S2)"; agent-prompt.ts now imports them from here instead of defining them, so the two
// modules can never drift). One position entry per open book position (batch-wide, not per-symbol).
export interface AgentPortfolioPosition {
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly qty: string;
  readonly notional: string;
}

// v3 spec §6.4: one entry per venue in the fixed capital split — mirrors
// position-sizer.service.ts's applyVenueHeadroomClamp/venueOpenNotional/venueReservedNotional
// arithmetic (that file's helpers are private; agent-portfolio-block.ts reimplements them locally
// rather than exporting solely for this payload-rendering consumer). Display-grade decimal strings
// only, same convention as SymbolCapabilities.venueFreeCash above — never a zod-enforced bound.
export interface AgentPortfolioVenue {
  readonly venue: string;
  readonly freeCash: string;
  readonly capitalShare: string;
  readonly headroom: string;
}

// Portfolio-level book state, rendered once per batch payload (absent on a single-symbol consult).
export interface AgentPortfolioBlock {
  readonly cappedEquity: string;
  readonly freeQuote: string;
  readonly grossExposure: string;
  readonly positions: readonly AgentPortfolioPosition[];
  // Absent when too little basket-wide return history exists to compute a beta yet.
  readonly correlation?: {
    readonly btcBeta: number;
    readonly summary: string;
  };
  // v3 spec §6.4: absent when the caller supplied no venueCapitalShare or the snapshot carries no
  // venueBalances yet — fail-open, same "omitted beats wrong" convention correlation above uses.
  readonly perVenue?: readonly AgentPortfolioVenue[];
}

// Remaining daily LLM budget + approx cost per consult (agent-budget.ts snapshot).
export interface AgentBudgetBlock {
  readonly remainingCallsToday: number;
  readonly remainingTokensToday: number;
  readonly remainingUsdToday: string;
  readonly approxCostPerConsultUsd: string;
}

// One scheduled macro event (data/macro-calendar.json), next-72h window only.
export interface AgentCalendarEvent {
  readonly name: string;
  readonly atMs: number;
  readonly importance: 'high' | 'medium';
}

export interface AgentContext {
  readonly indicators: AgentIndicators | null; // null while candle history < 21 closes
  readonly position: AgentPositionSummary;
  readonly recentDecisions: readonly AgentDecisionRecord[]; // newest-last, max 10
  // Absent when the strategy's own interval can't fold evenly into 1h/4h buckets; each half is
  // independently null while its own aggregated closed-candle history is under warmup.
  readonly htf?: {
    readonly h1: AgentHtfIndicators | null;
    readonly h4: AgentHtfIndicators | null;
  };
  // Cross-symbol relative-strength ranking (present only when AGENTIC_CROSS_SYMBOL_ENABLED and ≥2
  // symbols have fresh returns). The client may still withhold it under the information-context A/B
  // control arm — see anthropic-agent-client.ts.
  readonly crossSymbol?: AgentCrossSymbol | null;
  // Push 3 P6 Unit 4: present only when AGENTIC_TRACK_RECORD_ENABLED is on AND enough trips exist —
  // see AgentTrackRecord's own comment. Absent ⇒ byte-identical to pre-feature output.
  readonly trackRecord?: AgentTrackRecord;
  // S2 (Design § Enriched model inputs): rendered once per batch payload by agent-prompt.ts's
  // buildMarketPayload (BuildMarketPayloadExtras.portfolio) — wiring the actual provider into this
  // field is I1's job; the shape lands here now so S1's renderer and every later step converge on
  // ONE type. Absent ⇒ no `portfolio` key in the rendered payload (byte-identical to pre-S1/S2).
  readonly portfolio?: AgentPortfolioBlock;
  // See AgentPortfolioBlock's own comment — same absent-omits-key convention, wired by I1.
  readonly budget?: AgentBudgetBlock;
  // Next-72h scheduled macro events (data/macro-calendar.json, seeded at I2). Absent ⇒ no `calendar`
  // key.
  readonly calendar?: readonly AgentCalendarEvent[];
  // Rolling-window execution-quality digest string (maker fill rate, missed-entry cost, post-fill
  // drift — exec-quality.service.ts, P5). Absent ⇒ no `execQuality` key.
  readonly execQuality?: string;
  // Phase 4 (Profitability Edge Program): tournament-derived cohort/eligibility context — present
  // ONLY when EdgePolicyPort returns an active snapshot (AGENTIC_EDGE_POLICY_ENABLED + a registered
  // winner implementation). Absent ⇒ byte-identical to pre-feature output.
  readonly edgePolicy?: AgentEdgePolicyBlock;
}

// ── Edge policy (Phase 4 scaffolding, flag-off by default) ────────────────────
//
// Generic fail-closed seam for a post-tournament systematic edge family. Production calculators
// land in a later phase — see test/backtest/edge-tournament/ and DisabledEdgePolicy below.

/** Frozen trial ids from edge-tournament preregistration (2026-07-24). */
export const EDGE_POLICY_TRIAL_FAMILY_IDS = [
  'xsec20-ew',
  'xsec20-volbeta',
  'residual20-volbeta',
  'news1d-asymmetric',
  'funding-dispersion-3d',
  'xsec20-volbeta-macro',
] as const;

export type EdgePolicyTrialFamilyId = (typeof EDGE_POLICY_TRIAL_FAMILY_IDS)[number];
export type EdgePolicyFamilyId = EdgePolicyTrialFamilyId | 'none';

export interface EdgePolicyCohortMember {
  readonly symbol: string;
  readonly score: string; // exact decimal string — indicator-grade ranking input, not money
  readonly rank: number; // 1 = highest score in cohort
}

export interface EdgePolicyCohortSnapshot {
  readonly asOfMs: EpochMs;
  readonly members: readonly EdgePolicyCohortMember[];
}

export interface EdgePolicySideEligibility {
  readonly long: boolean;
  readonly short: boolean;
}

export interface EdgePolicyInactiveSnapshot {
  readonly active: false;
  readonly familyId: 'none';
}

export interface EdgePolicyActiveSnapshot {
  readonly active: true;
  readonly familyId: EdgePolicyTrialFamilyId;
  readonly cohort: EdgePolicyCohortSnapshot;
  readonly sideEligibility: EdgePolicySideEligibility;
  /** Upper bound on sizeFraction for eligible entries — exact decimal string (0..1). */
  readonly maxSizeFraction: string;
}

export type EdgePolicySnapshot = EdgePolicyInactiveSnapshot | EdgePolicyActiveSnapshot;

/** Rendered decide-side block — passthrough of the active snapshot fields the prompt consumes. */
export interface AgentEdgePolicyBlock {
  readonly familyId: EdgePolicyTrialFamilyId;
  readonly cohort: EdgePolicyCohortSnapshot;
  readonly sideEligibility: EdgePolicySideEligibility;
  readonly maxSizeFraction: string;
}

export const EDGE_POLICY = Symbol('EDGE_POLICY');

export interface EdgePolicyPort {
  snapshot(args: { readonly symbol: SymbolId; readonly eventTime: EpochMs }): EdgePolicySnapshot;
}

// What woke the agent, plus the snapshot it reasons over.
export interface AgentDecisionInput {
  readonly strategyId: StrategyId;
  readonly trigger:
    | { readonly kind: 'candle'; readonly event: CandleEvent }
    | { readonly kind: 'ticker'; readonly event: TickerEvent }
    | { readonly kind: 'book'; readonly event: OrderBookSnapshotEvent }
    | { readonly kind: 'exec'; readonly event: ExecReport };
  readonly snapshot: AgentMarketSnapshot;
  readonly context?: AgentContext; // optional — the strategy enriches, the host does not
}

// The async strategy contract — the only lane the host runs. `decide` replaces the four
// synchronous handlers with one async entry point; it returns proposed `Signal`s (Risk still
// gates them).
export interface AsyncStrategy {
  readonly kind: 'agentic';
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { readonly interval: CandleInterval; readonly bars: number };
  onInit(ctx: StrategyInitContext): void;
  decide(input: AgentDecisionInput): Promise<Signal[]>;
  onStop(): void;
}

// ── Out-of-process agent client ──────────────────────────────────────────────
//
// The seam to a real LLM/agent process. The concrete adapter (agent-client.adapter.ts) calls an
// endpoint; the default binding is an inert stub that returns { signals: [] } so a
// deployed-but-unwired agent proposes nothing (fail-safe). The client's proposed `Signal`s are the
// only thing Risk ever acts on — decision/usage/latencyMs are telemetry the host journals/reports,
// never a second trading input.
export const AGENT_CLIENT = Symbol('AGENT_CLIENT');

// The agent's own account of the decision behind the (possibly empty) Signal[] — the schema-validated
// tool-use payload, verbatim. Always populated by the real client on a successful call; absent from
// the stub and from a degraded/short-circuited call (there was no call to account for).
export interface AgentDecisionMeta {
  // S2 (rich decision contract, Design § New tool contract): widened to the v2 action vocabulary —
  // 'open_long'/'open_short'/'close'/'adjust'/'hold' — ADDITIVE to the legacy 'long'/'flat' literals,
  // never a replacement of them: historical journal rows and every fixture/replay path pinned to the
  // legacy tool (test/eval/agentic/*, entry-rate-floor.ts, candidate-backtest.ts until they migrate in
  // their own steps) still type-check unchanged. A caller reasoning over a specific decision still
  // narrows with `===`/a switch; nothing here forces a downstream exhaustive-switch rewrite by itself.
  // v3 (consolidation spec §4.3): 'error' ADDITIVE too — the ONE value the client itself constructs
  // (never the strategy's own recordErrorJournalEntry) to signal a named capability-violation degrade
  // (e.g. an 'open_short' on a capabilities.shorts=false symbol): signals stays [] (a hold), and this
  // action flows straight through toJournalAction (agentic.strategy.ts) into the journal's action
  // column unchanged, so the violation is never silently absorbed into an ordinary 'hold' row.
  readonly action:
    | 'open_long'
    | 'open_short'
    | 'close'
    | 'adjust'
    | 'hold'
    | 'long'
    | 'flat'
    | 'error';
  // S2: v2 conviction rides entirely in AgentDirectives.sizeFraction — there is no separate
  // confidence field on the v2 tool response (see agent-prompt.ts's sizeFraction description). null
  // is what a v2-served decision now carries here; number is the legacy 0..1 confidence value every
  // pre-v2 caller/fixture still supplies.
  readonly confidence: number | null;
  readonly rationale: string;
}

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  // W2.4 prompt-cache experiment (falsifiability note lives on anthropic-agent-client.ts's request
  // builder): tokens written to/read from the ephemeral cache on this call, per the Anthropic
  // response envelope's usage object. Optional/absent whenever the response carries neither field
  // (a non-Anthropic stub client, or an envelope that predates this field) — never defaulted to 0,
  // so "absent" and "confirmed zero" stay distinguishable to a later cost/hit-rate analysis.
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

// S2 (rich decision contract, Design § New tool contract): the v2 tool response's parsed directive
// set — supersedes AgentPlan (below) as what AgentProposal.plan actually carries once S3/A1 wire the
// v2 client path; AgentPlan itself is KEPT (not deleted) because it is still the live wire type for
// every legacy (non-v2) submit_plan/submit_portfolio caller and fixture (test/eval/agentic/*,
// entry-rate-floor.ts, candidate-backtest.ts) until their own migration steps land. Pct fields stay
// STRINGS (money-safe Decimal→string path, same discipline as AgentPlan); entryOffsetBps/
// entryValidityBars/maxHoldBars stay plain numbers (bar counts / bps offsets, never money);
// sizeFraction is also a STRING (money-adjacent — it multiplies capped equity into a notional
// downstream, see position-sizer.service.ts's C1 step) despite being conceptually closer to a plain
// fraction than a price.
export interface AgentDirectives {
  // Conviction channel replacing AgentDecisionMeta.confidence on the v2 path — required on
  // 'open_long'/'open_short' (including a scale-in), meaningless otherwise. See DECISION_V2_BOUNDS
  // (agent-prompt.ts) for the enforced [0.005, lane-max] range.
  readonly sizeFraction: string;
  readonly stopLossPct: string;
  readonly takeProfitPct: string;
  // 'adjust'-only, optional: fraction of the current position to close now. Absent on every
  // 'open_*'/'hold' directive set.
  readonly partialCloseFraction?: string;
  readonly entryOffsetBps: number;
  readonly entryValidityBars: number;
  readonly maxHoldBars: number;
  // 'maker' rests a passive limit order entryOffsetBps from the last close; 'taker' crosses the
  // spread immediately (the sizer degrades LIMIT_MAKER→LIMIT naturally — see position-sizer.service.
  // ts). Required (unlike AgentPlan, which had no pricing-style concept at all).
  readonly entryStyle: 'maker' | 'taker';
  // Mirrors AgentPlan.direction's semantics exactly (absent ⇒ 'long'; ignored on a same-side re-arm,
  // where the position's own side wins) — see that field's own comment for the full rationale.
  readonly direction?: 'long' | 'short';
  // The model's current reasoning for this position/decision, ≤300 chars (DECISION_V2_BOUNDS.
  // thesisMaxLen) — optional on 'open_*'/'adjust'; persisted and fed back at the next consult as
  // AgentContext... currentThesis (see agent-prompt.ts's BuildMarketPayloadExtras.currentThesis).
  readonly thesis?: string;
}

// W3.1 plan-based trading: the executor-managed trade plan a 'long' decision carried, parsed off
// submit_plan's tool-use payload. Pct fields are STRINGS (not the raw schema numbers) so every
// downstream consumer — plan-executor.ts's Decimal compares, the strategy's in-memory plan state —
// stays on the money-safe Decimal→string path; only entryOffsetBps/entryValidityBars/maxHoldBars
// stay plain numbers (bar counts / bps offsets, never a money value themselves).
// LEGACY (pre-S2): kept exported, unmodified, for every caller/fixture still on the legacy
// submit_plan/submit_portfolio wire shape — see AgentDirectives above for the v2 replacement.
export interface AgentPlan {
  readonly entryOffsetBps: number;
  readonly stopLossPct: string;
  readonly takeProfitPct: string;
  readonly entryValidityBars: number;
  readonly maxHoldBars: number;
  // Push II Phase 8 (plan-mode shorts): which side a NEW entry opens — 'short' rests a SELL entry
  // (stop ABOVE fill, take-profit BELOW fill; mirrored math, see plan-executor.ts). Absent means
  // 'long' (the pre-Phase-8 default) — every deployment with AGENTIC_SHORTS_ENABLED off (or a plan
  // minted before this field existed) never sees anything but 'long'/undefined here, so long-side
  // plan behavior stays byte-identical. Ignored on a re-arm (hold+plan while already positioned):
  // the position's OWN side wins there, never a value the model could use to flip direction
  // mid-position (see anthropic-agent-client.ts's rearm handling).
  readonly direction?: 'long' | 'short';
}

export interface AgentProposal {
  readonly signals: Signal[];
  readonly decision?: AgentDecisionMeta;
  // S2: retyped to AgentDirectives (the v2 directive set) — the property NAME stays `plan` (the
  // journal column stays plan_json; see AgentDecisionEntry.plan and A3's schema-widening step), only
  // the SHAPE changes. Every legacy (pre-v2) construction site that still builds an AgentPlan-shaped
  // value here is expected to fail typecheck until it migrates to AgentDirectives in its own step
  // (A1: anthropic-agent-client.ts's acceptedPlan; B3: agentic.strategy.ts's ActivePlan bookkeeping)
  // — a plain retype was chosen over a `AgentDirectives | AgentPlan` union because every intended v2
  // reader (plan-executor.ts's B1 step, the payload renderers) needs ONE shape to reason over, and a
  // union would let a stale AgentPlan value silently keep flowing through the v2 path instead of
  // surfacing as the compile error that routes each caller to its owning migration step.
  // Present only when the decision carried a viable open/adjust directive set (absent on 'hold'/
  // 'close', and absent when directives were rejected by the fee-aware edge floor — see
  // anthropic-agent-client.ts's rejection path, which returns signals: [] with no plan).
  readonly plan?: AgentDirectives;
  // S2 (Design § New tool contract): portfolio-level — ONE value applies to every proposal born from
  // the SAME batched submit_portfolio call (per-symbol scheduling would desync the basket and
  // collapse batching — see the Design table's own note), stamped identically on every element the
  // way consultId already is (see that field's own comment). Absent on the single-symbol propose()
  // path (no portfolio schedule to stamp) and on any pre-v2 batch response.
  readonly nextConsultBars?: number;
  readonly usage?: AgentUsage;
  // Wall-clock duration of the HTTP call, client-measured; absent when no call was made.
  readonly latencyMs?: number;
  // Version of the playbook the client composed into the prompt, and a hash of the prompt's
  // composition (template version + playbook content + tool schema + model id) — telemetry for
  // the decision journal, absent whenever no call was made (same convention as latencyMs).
  readonly playbookVersion?: number;
  readonly promptHash?: string;
  // The rendered market-context JSON (candles/ticker/book/indicators/position/recentDecisions) the
  // client sent — see agent-prompt.ts's buildMarketPayload — WITHOUT the playbook block or system
  // prompt, so a stored row can never carry playbook content. Absent whenever no call was made (same
  // convention as latencyMs/promptHash); persisted for offline prompt-variant replay (W1.3).
  readonly inputPayload?: string;
  // Batch-attribution join key (Push II Phase 5 follow-on): proposeBatch mints ONE id per batch
  // and stamps it on every proposal in that batch (including degraded-to-hold elements — the row
  // still belongs to the batch), so offline cost/attribution analytics can join the N per-symbol
  // journal rows born from one batched call back together. Absent on the single-symbol propose()
  // path — no batch, no join key.
  readonly consultId?: string;
  // Push 3 P8a-prep: TREATMENT truth per axis, stamped by AnthropicAgentClient.prepareDecideContext
  // on every proposal it returns (see anthropic-agent-client.ts's write sites for the polarity
  // conversion). infoArm = NOT infoContextControlArm (true = the extra-information bundle was
  // PRESENT); thinkingArm passes ctx.thinkingArm through unchanged (already treatment-truth
  // polarity — true = adaptive thinking on). Absent only when no client call was attempted at all
  // (the pre-ctx `degraded`/no-market-data stubs) — same absent-when-no-call convention as
  // promptHash/latencyMs.
  readonly infoArm?: boolean;
  readonly thinkingArm?: boolean;
}

export interface AgentClientPort {
  propose(input: AgentDecisionInput): Promise<AgentProposal>;
}

// Thrown by AgentClientPort implementations in place of a bare Error, so callers can branch on
// retryability without string-matching a message. FATAL means the request/credential itself is bad
// (retrying changes nothing — e.g. a bad API key); RETRYABLE covers transient transport/rate-limit
// failures a single bounded retry may recover from.
export class AgentProposeError extends Error {
  constructor(
    message: string,
    readonly kind: 'RETRYABLE' | 'FATAL',
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AgentProposeError';
  }
}

// Per-strategy venue/sizing facts the agent needs to reason about cost and order construction —
// distinct from SymbolConstraints (venue-imposed rounding rules), this is the strategy's own
// commercial profile (fee tier, target clip size).
export interface AgentTradingProfile {
  readonly makerBps: string;
  readonly takerBps: string;
  readonly baseNotional: string;
  readonly maxOrderNotional: string;
  readonly constraints: SymbolConstraints;
  // P5 compounding sizing: present only when SIZER_EQUITY_FRACTION > 0 — PositionSizerService then
  // sizes entries off equity × fraction × confidence instead of baseNotional × confidence. Absent
  // keeps the prompt's legacy baseNotional sizing sentence byte-identical to pre-P5.
  readonly equityFraction?: string;
  // §S3 bot-side protective backstop (ProtectiveExitService): present only when the corresponding
  // PROTECT_*_PCT knob is > 0, so the prompt sentence and the service's active enforcement can never
  // disagree. Absent keeps the prompt byte-identical to pre-S3.
  readonly protectStopLossPct?: string;
  readonly protectTrailingPct?: string;
}

// ── Agent decision journal ────────────────────────────────────────────────────
//
// Persists every agent decision (mapped to a signal or not) for offline analysis — mirrors
// SIGNAL_JOURNAL's conventions (see SignalJournalPort in ports/strategy.ts): record is sync
// fire-and-forget, an analysis artifact rather than a safety interlock. The underlying table
// (agent_decisions) is a PLAIN insert-only row, not append-only-hardened — that REVOKE/trigger
// treatment is scoped to audit_log/order_events only (CLAUDE.md rule 6). A decision's forward
// return/PnL is NEVER written back onto its own row — it only ever shows up as context on a LATER
// row (see AgentDecisionRecord.outcome for the in-memory equivalent).
export const AGENT_DECISION_JOURNAL = Symbol('AGENT_DECISION_JOURNAL');

// R2 (episodic memory): the compact regime fingerprint derived at decide() time from features the
// market payload ALREADY carries — trend from the EMA fast/slow spread, a volatility bucket from
// ATR/price, the funding sign when a derivatives snapshot rode in, and the UTC session bucket from
// eventTime. Derivation is a pure spec-pinned function (features/trading/agentic/episodic-memory.ts's
// deriveRegimeTags), called on BOTH the write side (agentic.strategy.ts stamps it on every journaled
// row) and the read side (anthropic-agent-client.ts derives the same tags to retrieve matching past
// setups), so a stored tag and a query tag can never drift. Persisted INSIDE plan_json's jsonb (no new
// column — plan_json is unconstrained jsonb, see trading.schema.ts) so a LATER consult in the same
// regime can retrieve its own history by tag equality. funding is optional: absent whenever no
// derivatives snapshot was present (spot lane, or a stale/disabled feed) — matched only when present.
export interface RegimeTags {
  readonly trend: 'up' | 'down' | 'flat';
  readonly vol: 'low' | 'mid' | 'high';
  readonly funding?: 'positive' | 'negative' | 'flat';
  readonly session: 'asia' | 'eu' | 'us';
}

export interface AgentDecisionEntry {
  readonly strategyId: StrategyId;
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly triggerKind: 'candle' | 'ticker' | 'book' | 'exec';
  readonly basedOnSeq: bigint;
  readonly eventTime: EpochMs;
  readonly model: string;
  // v3 (consolidation spec §2/§9): narrowed to the rich-tool-contract-only vocabulary, matching the
  // fresh v3 `agent_decisions.action` DB column exactly (trading.schema.ts) — a greenfield DB never
  // carries a legacy 'long'/'flat' row, so no back-compat literal is needed here. 'error' has no
  // AgentDecisionMeta counterpart: it marks a decide()-path exception, stamped by
  // recordErrorJournalEntry, never a value the client itself returns.
  readonly action: 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold' | 'error';
  readonly confidence: number | null;
  readonly rationale: string;
  readonly refPrice: string | null;
  readonly close: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  // Cache-token analytics (#27 true-spend accounting), mirroring AgentUsage's field semantics:
  // absent/null when the response carried neither field — never defaulted to 0, so "absent" and
  // "confirmed zero" stay distinguishable to cost analysis. Optional so pre-#27 writers compile.
  readonly cacheReadInputTokens?: number | null;
  readonly cacheCreationInputTokens?: number | null;
  readonly latencyMs: number | null;
  readonly playbookVersion: number | null;
  readonly promptHash: string;
  // See AgentProposal.inputPayload — null when no call was made (e.g. the error/quiet-hold paths).
  readonly inputPayload: string | null;
  // See AgentProposal.plan — the accepted plan-mode trade plan this decision carried, verbatim (no
  // money-path conversion — pct fields stay the strings AgentPlan already carries); null/absent on
  // every decision that carried no accepted plan (flat/hold-without-plan/error). Optional so
  // pre-this-column writers and fixtures compile; absent and null both map to a NULL column.
  readonly plan?: AgentPlan | null;
  // See AgentProposal.consultId — the batch join key this decision's proposal carried; null/absent
  // on every non-batched decision. Optional so pre-this-column writers and fixtures compile; absent
  // and null both map to a NULL column.
  readonly consultId?: string | null;
  // S2: see AgentProposal.nextConsultBars — the portfolio-level consult-schedule value this
  // decision's proposal carried, forwarded verbatim; null/absent on every non-batched or pre-v2
  // decision. Optional so pre-this-column writers and fixtures compile; absent and null both map to
  // a NULL column. No new DB column: rides in plan_json alongside the rest of the directive set
  // (A3 threads the actual persistence — see trading.schema.ts's plan_json $type widening).
  readonly nextConsultBars?: number | null;
  // v3 (consolidation spec §2/§9): info_arm/thinking_arm are DELETED (the retired derivatives-control
  // A/B factorial — the playbook champion/candidate A/B is NOT retired and is attributed via
  // consultId + playbookVersion, never an arm flag). AgentProposal.infoArm/thinkingArm (the client's
  // own A/B treatment-truth telemetry) are unaffected — only this journal-row mirror is removed, since
  // the v3 agent_decisions table carries no info_arm/thinking_arm columns to persist them into
  // (trading.schema.ts).
  // R2 (episodic memory): the regime fingerprint this decision was made in — see RegimeTags. Optional
  // so every pre-R2 writer/fixture compiles; absent and null both persist no tags (the row is simply
  // never retrievable as a "similar past setup", a fail-open miss, never a wrong match). Rides inside
  // plan_json's jsonb alongside the directive set / schedule (agent-decision-journal.adapter.ts's
  // buildPlanJson), so no new DB column — same no-migration convention as nextConsultBars.
  readonly regimeTags?: RegimeTags | null;
}

export interface AgentDecisionRow extends AgentDecisionEntry {
  readonly id: string;
  readonly createdAt: EpochMs;
}

// R2 (episodic memory): one retrieved past setup for the consult's "similar past setups" block — a
// journal row whose regimeTags matched the CURRENT regime, paired with the price move that FOLLOWED
// it (the row's own close → that strategy's next decision close). The forward outcome is joined at
// READ time, never stored on the row (CLAUDE.md: a decision's forward return is never written back
// onto its own row — see AGENT_DECISION_JOURNAL's own comment). synthetic marks a replay-<runId> row
// (case-based practice, labeled as such in the rendered line, never blended into live evidence).
export interface SimilarSetupRow {
  readonly eventTime: EpochMs;
  readonly synthetic: boolean;
  readonly action: AgentDecisionRow['action'];
  readonly close: string | null;
  // priceMovePct is indicator-grade float, null when no later decision exists yet for that strategy or
  // either close was non-finite/<= 0 (same null-not-NaN honesty as AgentDecisionRecord.outcome).
  readonly priceMovePct: number | null;
}

// R1 historical-replay harness: every synthetic (replay-simulated) decision is journaled with a
// strategyId carrying THIS prefix (`replay-<runId>`), so a synthetic row is distinguishable from a
// real lane row inside the SHARED agent_decisions journal by string prefix alone. The prefix is the
// exclusion key three ways: (1) the lane-wide recent() read (mint-floor corpus) and llmTokenTotals
// (epoch cost) filter it OUT so synthetic runs never poison the entry-rate floor or a lane's 14-day
// breaker budget; (2) the per-strategy recent(realStrategyId) reads exclude it by construction (a
// real strategyId never carries this prefix); (3) recentSynthetic() filters it IN, the ONLY read that
// surfaces synthetic experience — and only when reflection has opted in (default OFF).
export const REPLAY_STRATEGY_ID_PREFIX = 'replay-';

export interface AgentDecisionJournalPort {
  record(entry: AgentDecisionEntry): void;
  // Ordering: oldest→newest, matching AgentContext.recentDecisions' "newest-last" convention above
  // — both DB (AgentDecisionJournalAdapter) and in-memory (InMemoryAgentDecisionJournal)
  // implementations return the same order, including the same tiebreak (insertion order) when two
  // rows share an eventTime.
  // Multi-symbol (P7): strategyId scopes the read to one instance's rows — a mixed-strategy window
  // would corrupt the reflection loop's single-instrument position walks (each instance trades one
  // symbol). Absent ⇒ the historical unscoped read.
  recent(limit: number, strategyId?: string): Promise<readonly AgentDecisionRow[]>;
  // Lifetime decide/entry counts for ONE playbook version — the abstention lapse's evidence base.
  // A recent(N) row-count window shrinks in wall-clock terms as the traded universe grows, and a
  // candidate's early entries scrolling past it misclassified a TRADING candidate as abstaining
  // (v2, 2026-07-17: its 4 longs sat just beyond the 400-row horizon after the 5→8 expansion).
  // decides counts real-LLM rows only (model 'claude…', mirroring ReflectionService's filter),
  // entries the 'open_long'/'open_short' subset (v3 §2/§9 vocabulary), both over the version's WHOLE
  // journal. Optional so pre-this-method
  // fakes compile; absent ⇒ callers must NOT abstention-lapse (fail toward preserving the
  // candidate — orphaning is destructive, squatting is bounded by the age lapse).
  versionEntryStats?(version: number): Promise<{ decides: number; entries: number }>;
  // Versioned rows only (playbookVersion !== null) at-or-after sinceMs (absent ⇒ no time bound),
  // oldest→newest like recent(), capped to the NEWEST `limit` rows. The attribution evidence base
  // (promotion evaluator + version-attribution metrics): quiet/prescreen rows carry NULL versions,
  // so sharing recent(N)'s row-count window with them shrinks attribution's wall-clock reach as
  // the traded universe grows — at 8-symbol volume (~620 rows/day, ~1/3 versioned) recent(2000)
  // covered ~3 days, clipped the evidence epoch, and made the promotion evaluator's symmetric
  // attributed-trip floors unreachable (2026-07-18, same window-shrink class as versionEntryStats'
  // 2026-07-17 note above). Over-cap drops oldest-first — the failure direction stays "label old
  // trips unknown", never mis-attribute. Optional so pre-this-method fakes compile; absent ⇒
  // callers fall back to recent() (the historical window).
  recentVersioned?(limit: number, sinceMs?: number): Promise<readonly AgentDecisionRow[]>;
  // R1 synthetic-experience read: the newest `limit` rows whose strategyId carries
  // REPLAY_STRATEGY_ID_PREFIX (replay-simulated decisions), oldest→newest like recent(). This is the
  // ONE read that surfaces synthetic rows — every other read excludes them (see the prefix's own
  // comment). Reflection consumes it only under an explicit opt-in (ReflectionServiceDeps
  // .syntheticExperience, default OFF); rendered lines are labeled synthetic, never blended with live
  // evidence. Optional so pre-this-method fakes compile; absent ⇒ the synthetic digest is omitted.
  recentSynthetic?(limit: number): Promise<readonly AgentDecisionRow[]>;
  // R2 episodic-memory retrieval: the newest `limit` rows whose persisted regimeTags equal `tags`
  // (trend/vol/session always matched; funding matched only when the query carries it), oldest→newest
  // like recent() is not required — this read returns NEWEST-first (recency-weighted retrieval), each
  // row paired with the forward price move that followed it (joined at read time — the outcome is
  // never stored on the row). LANE-WIDE and DELIBERATELY INCLUSIVE of replay-<runId> synthetic rows
  // (case-based practice is exactly what retrieval should surface — labeled synthetic in the render),
  // unlike every other lane-wide read which excludes them. Optional so pre-this-method fakes compile;
  // absent ⇒ the similarSetups block is omitted entirely (fail-open measurement — a missing retrieval
  // never blocks or alters a decision).
  recentSimilarSetups?(tags: RegimeTags, limit: number): Promise<readonly SimilarSetupRow[]>;
}

// ── LLM usage sink ────────────────────────────────────────────────────────────
//
// Persists reflection-path LLM token usage (llm_usage table) for offline cost analysis — decide-path
// usage is ALREADY captured per call on agent_decisions.input_tokens/output_tokens, so this sink's
// CURRENT writers are the reflection loop only; recording decide-path usage here too would double
// count against agent_decisions when a later PnL computation UNIONs the two sources. Same convention
// as AGENT_DECISION_JOURNAL: record is sync fire-and-forget, an analysis artifact rather than a safety
// interlock — the composition root binds a DB-backed adapter when the persistence path is active, else
// the token resolves to undefined and the @Optional consumer simply skips recording. mode is stamped
// by the adapter at construction (mirrors SignalJournalAdapter's ExecRunContext), not carried on the
// entry — a caller like ReflectionService has no natural access to the run's trading mode.
export const LLM_USAGE_SINK = Symbol('LLM_USAGE_SINK');

export interface LlmUsageEntry {
  readonly kind: 'decide' | 'reflection';
  readonly model: string;
  readonly strategyId?: StrategyId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  // Cache-token analytics (#27) — same absent-vs-zero semantics as AgentUsage's cache fields.
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

export interface LlmUsageSink {
  record(entry: LlmUsageEntry): void;
}

// ── Playbook provider ─────────────────────────────────────────────────────────
//
// Seam for the agent's versioned strategy playbook (system-prompt content beyond the fixed rules in
// buildSystemPrompt). Only the shape lands here; a later task adds the persisted store adapter.
export const PLAYBOOK_PROVIDER = Symbol('PLAYBOOK_PROVIDER');

export interface PlaybookProvider {
  // source (additive, optional) is how current() resolved the returned version — 'pin' (operator
  // override), 'promotion' (a promotion row's parentVersion target), or 'seed' — surfaced for boot
  // activation logging (§G4b); omitted by providers that don't track it (e.g. the fixed seed stub).
  current(): Promise<{
    readonly version: number;
    readonly content: string;
    readonly source?: 'pin' | 'promotion' | 'seed';
  }>;
  // Active-only read: like current() but NEVER routed to an A/B candidate — pin/promotion/seed
  // precedence only. The boot "active playbook" log + agentic_playbook_info gauge must read this,
  // not current(): with a live candidate and AGENTIC_PLAYBOOK_AB_PCT>0, a boot landing in a
  // candidate minute-bucket would otherwise stamp the INACTIVE candidate's version as active
  // (observed live 2026-07-11, first boot after the first reflection mint). Optional: implemented
  // by the composition-root routing chain; absent on providers with no routing layer, where
  // current() already IS the active read — callers fall back accordingly.
  active?(): Promise<{
    readonly version: number;
    readonly content: string;
    readonly source?: 'pin' | 'promotion' | 'seed';
  }>;
}
