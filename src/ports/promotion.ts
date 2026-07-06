import type { TradingMode } from '../domain/types/mode';

// ── Tokens ────────────────────────────────────────────────────────────────────

export const PROMOTION_READINESS = Symbol('PROMOTION_READINESS');
export const PROMOTION_STATS = Symbol('PROMOTION_STATS');
export const PROMOTION_READINESS_CONFIG = Symbol('PROMOTION_READINESS_CONFIG');

// Decimal-string knobs the cost math + dust-closure rule need — mirrors ModeControlConfig's own
// "derived from validated AppConfig at boot" pattern so the service takes a plain DI-injected
// value object instead of ConfigService directly (keeps its unit tests config-free).
export interface PromotionReadinessConfig {
  readonly tokenPriceInputPerMtok: string;
  readonly tokenPriceOutputPerMtok: string;
  readonly dustNotional: string;
}

// ── PromotionStatsPort ───────────────────────────────────────────────────────

// One ordered fill row, joined against order_intents for the fields fills itself lacks
// (strategyId, side) — see promotion-stats.repository.ts's own comment for why the join is
// load-bearing. A fill whose intentId cannot be resolved to an order_intents row is represented
// with strategyId/side both null so PromotionReadinessService can fail-closed on it rather than
// silently mis-attributing it to a position it never joined into.
export interface PromotionFillRow {
  readonly strategyId: string | null;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL' | null;
  readonly qty: string;
  readonly price: string;
  readonly fee: string | null;
  readonly feeAsset: string | null;
  readonly executedAt: number;
  // The decide-time reference price the intent was sized against (order_intents.ref_price via the
  // same LEFT JOIN — null when the intent is unresolved). Evidence-only: feeds the reflection
  // lane's decide-vs-fill slippage digest; the promotion verdict ignores it.
  readonly refPrice?: string | null;
}

// Sum of input/output tokens across BOTH LLM call sites: agent_decisions (decide path) and
// llm_usage (reflection path, added in commit 8b6842c). Kept as a single aggregate — see
// llmTokenTotals' own doc comment for why a per-model breakdown isn't needed by the cost math.
export interface LlmTokenTotals {
  readonly decideInputTokens: number;
  readonly decideOutputTokens: number;
  readonly reflectionInputTokens: number;
  readonly reflectionOutputTokens: number;
}

// What PromotionReadinessService's round-trip walk + LLM-cost math need from the DB — nothing more.
// Crosses the features/trading/mode-control ↔ database boundary; the composition root is the only
// place allowed to bind a concrete (Drizzle-backed) implementation to this port (rule 2's boundary
// wall — mode-control may not import database directly).
export interface PromotionStatsPort {
  // Ordered oldest→newest (executedAt, then insertion order for ties) fills for the given mode —
  // the round-trip walk depends on this ordering to track signed position correctly.
  fillsForMode(mode: TradingMode): Promise<readonly PromotionFillRow[]>;
  // Aggregate token totals across the full history (not mode-scoped — agent_decisions carries no
  // mode column; see promotion-readiness.service.ts's own comment on why over-counting cost here is
  // the fail-closed direction).
  llmTokenTotals(): Promise<LlmTokenTotals>;
  // Epoch ms of the newest llm_usage kind='reflection' row, null when reflection has never run.
  // Optional so existing fakes/implementations remain valid; the reflection trigger seed treats an
  // absent method the same as "never reflected".
  latestReflectionAt?(): Promise<number | null>;
}

// ── Realized round-trip evidence (reflection lane) ──────────────────────────

export const REFLECTION_EVIDENCE = Symbol('REFLECTION_EVIDENCE');

// One CLOSED demo round trip, walked from venue fills with the same dust-closure rule the
// promotion verdict uses (src/domain/risk/round-trips.ts) — realized venue truth, in contrast to
// the journal-reconstructed t+1 close-price proxies reflection otherwise learns from. All money
// fields are decimal strings; netPnl = realizedPnl (gross) − feesQuote (convertible fees only —
// an unconvertible fee asset is the promotion verdict's concern, not this evidence feed's).
export interface RoundTripEvidence {
  readonly strategyId: string;
  readonly symbol: string;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly holdingMs: number;
  readonly entryVwap: string | null;
  readonly exitVwap: string | null;
  readonly boughtQty: string;
  readonly realizedPnl: string;
  readonly feesQuote: string;
  readonly netPnl: string;
  readonly meanSlippageBps: string | null;
}

// Durable trigger state for the reflection loop. The in-process trade counters reset on every
// redeploy, which starved reflection to zero firings for days — this seed lets the service resume
// its cadence from DB truth: how many demo round trips have closed in total, how many since the
// last reflection attempt actually reached the API, and when that attempt was.
export interface ReflectionTriggerSeed {
  readonly closedTradesTotal: number;
  readonly closedSinceLastReflection: number;
  readonly lastReflectionAt: number | null;
}

// Optional composition-root bridge into the agentic lane (same boundary story as
// PromotionStatsPort above): DB-backed when persistence is configured, absent under test/ci —
// reflection treats the evidence as additive and proceeds without it.
// Multi-symbol (P7): reflectionSeed(strategyId) scopes the trigger seed to one instance's closed
// trips (per-strategy trigger counters); absent ⇒ lane-wide totals. recentRoundTrips stays
// lane-wide — the playbook is lane-global, so reflection deliberately sees every symbol's realized
// outcomes (rows carry strategyId/symbol for attribution).
export interface RoundTripEvidencePort {
  recentRoundTrips(limit: number): Promise<readonly RoundTripEvidence[]>;
  reflectionSeed(strategyId?: string): Promise<ReflectionTriggerSeed>;
}

// ── PromotionReadiness verdict ───────────────────────────────────────────────

export interface PromotionReadinessEvidence {
  readonly roundTrips: number;
  readonly realizedPnl: string;
  readonly fees: string;
  readonly llmCostUsd: string;
  readonly netPnl: string;
  readonly windowDays: number;
  readonly firstClosedAt: number | null;
  readonly lastClosedAt: number | null;
  readonly reasons: string[];
}

export interface PromotionReadiness {
  readonly permitted: boolean;
  readonly evidence: PromotionReadinessEvidence;
}

export interface PromotionReadinessPort {
  // Re-evaluated on every call — computed fresh from the DB, never cached (mirrors
  // ModeControlPort.resolveMode's own "callers MUST NOT cache" contract).
  evaluate(): Promise<PromotionReadiness>;
}
