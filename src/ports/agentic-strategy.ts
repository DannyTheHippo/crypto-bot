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
}

// Per-strategy position summary the host derives from the live PORTFOLIO_VIEW, handed to the
// agent alongside the market snapshot so it reasons over its own book, not just price action.
export interface AgentPositionSummary {
  readonly side: 'LONG' | 'FLAT';
  readonly qty: string; // exact decimal string; '0' when flat
  readonly avgEntry: string | null;
  readonly realizedPnl: string;
  readonly unrealizedPnlPct: number | null; // indicator-grade float, not money
  readonly openOrders: number;
  // W3.1 plan-mode only, LONG only (absent otherwise so legacy/flat payloads stay byte-identical):
  // whether plan-executor currently manages this position. The active plan is in-memory and does
  // not survive a restart, so `false` tells the model its position is UNMANAGED and it may re-arm
  // by attaching a plan to a 'hold' (see planModeSentences / the client's re-arm acceptance path) —
  // without this field the model cannot distinguish "managed, safety-cadence consult" from
  // "plan lost, I am being billed every bar", and the documented restart self-heal never happens.
  readonly managedPlan?: boolean;
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
  readonly action: 'long' | 'flat' | 'hold';
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
    readonly heldDuring: 'LONG' | 'FLAT';
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
  // B3: stays 'long' | 'flat' | 'hold' — widening this ripples into agentic.strategy.ts's
  // decision-history ring, the persisted agent_decisions journal, and the counterfactual-scoring.ts
  // calibration module (which would then need to decide how to treat 'short' rows — a semantic call
  // belonging to the carry sub-plan that actually wires shortsEnabled live, not to this flag-gated,
  // presently-unconsumed capability). AnthropicAgentClient casts its raw 'short' action down to this
  // narrow type at the single construction site (see its own comment) rather than widening the port.
  readonly action: 'long' | 'flat' | 'hold';
  readonly confidence: number;
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

// W3.1 plan-based trading: the executor-managed trade plan a 'long' decision carried, parsed off
// submit_plan's tool-use payload. Pct fields are STRINGS (not the raw schema numbers) so every
// downstream consumer — plan-executor.ts's Decimal compares, the strategy's in-memory plan state —
// stays on the money-safe Decimal→string path; only entryOffsetBps/entryValidityBars/maxHoldBars
// stay plain numbers (bar counts / bps offsets, never a money value themselves).
export interface AgentPlan {
  readonly entryOffsetBps: number;
  readonly stopLossPct: string;
  readonly takeProfitPct: string;
  readonly entryValidityBars: number;
  readonly maxHoldBars: number;
}

export interface AgentProposal {
  readonly signals: Signal[];
  readonly decision?: AgentDecisionMeta;
  // Present only when planMode is on AND the decision was a viable 'long' plan (absent on 'flat'/
  // 'hold', and absent when the plan was rejected by the fee-aware edge floor — see
  // anthropic-agent-client.ts's plan-rejection path, which returns signals: [] with no plan).
  readonly plan?: AgentPlan;
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

export interface AgentDecisionEntry {
  readonly strategyId: StrategyId;
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly triggerKind: 'candle' | 'ticker' | 'book' | 'exec';
  readonly basedOnSeq: bigint;
  readonly eventTime: EpochMs;
  readonly model: string;
  readonly action: 'long' | 'flat' | 'hold' | 'error';
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
}

export interface AgentDecisionRow extends AgentDecisionEntry {
  readonly id: string;
  readonly createdAt: EpochMs;
}

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
