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
// historically reproducible it CANNOT be certified by the replay-based step-D gate: it is permanently
// EXPERIMENT-ONLY (testnet/paper), never a "validated edge", never promoted to live. See
// docs/planning/nighly-improvement.md → Determinism pre-flight carve-out and CLAUDE.md rule 4.

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
  // has been marked) — never on the row itself at write time. priceMovePct is indicator-grade float;
  // positionPnlDelta is an exact decimal string (money path).
  readonly outcome?: { readonly priceMovePct: number; readonly positionPnlDelta: string };
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
  readonly action: 'long' | 'flat' | 'hold';
  readonly confidence: number;
  readonly rationale: string;
}

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentProposal {
  readonly signals: Signal[];
  readonly decision?: AgentDecisionMeta;
  readonly usage?: AgentUsage;
  // Wall-clock duration of the HTTP call, client-measured; absent when no call was made.
  readonly latencyMs?: number;
  // Version of the playbook the client composed into the prompt, and a hash of the prompt's
  // composition (template version + playbook content + tool schema + model id) — telemetry for
  // the decision journal, absent whenever no call was made (same convention as latencyMs).
  readonly playbookVersion?: number;
  readonly promptHash?: string;
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
  readonly latencyMs: number | null;
  readonly playbookVersion: number | null;
  readonly promptHash: string;
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
  recent(limit: number): Promise<readonly AgentDecisionRow[]>;
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
}
