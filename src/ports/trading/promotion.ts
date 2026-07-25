import type { TradingMode } from '../../domain/trading/types/mode';

// ── Tokens ────────────────────────────────────────────────────────────────────

export const PROMOTION_READINESS = Symbol('PROMOTION_READINESS');
export const PROMOTION_STATS = Symbol('PROMOTION_STATS');
export const PROMOTION_READINESS_CONFIG = Symbol('PROMOTION_READINESS_CONFIG');

// Decimal-string knobs the cost math + dust-closure rule need — mirrors ModeControlConfig's own
// "derived from validated AppConfig at boot" pattern so the service takes a plain DI-injected
// value object instead of ConfigService directly (keeps its unit tests config-free).
export interface PromotionReadinessConfig {
  // Default-model rates (decimal strings): used for the model === AGENTIC_MODEL rows, and as the
  // fallback whenever tokenPrices is absent. Cache rates (W4+W13) were priced $0 before this.
  readonly tokenPriceInputPerMtok: string;
  readonly tokenPriceOutputPerMtok: string;
  readonly tokenPriceCacheReadPerMtok?: string;
  readonly tokenPriceCacheWritePerMtok?: string;
  readonly dustNotional: string;
  // Per-model rate override map (mirrors AppConfig.agentic.tokenPrices — decimal strings). When set,
  // a model present in cost rows but ABSENT here (and ≠ the default-model rate set) prices at the
  // MOST EXPENSIVE configured rates per component — fail-closed, never silently under-pricing an
  // unrecognized model inside a live-arming gate.
  readonly tokenPrices?: Readonly<
    Record<
      string,
      {
        readonly inputPerMtok: string;
        readonly outputPerMtok: string;
        readonly cacheReadPerMtok: string;
        readonly cacheWritePerMtok: string;
      }
    >
  >;
  // Owner-declared evidence epoch (ms). When set, the gate evaluates round trips + LLM cost + window
  // only from this instant forward — so a post-fix configuration is judged on post-fix evidence, not
  // the sunk experimentation hole. Absent ⇒ all-time (byte-identical legacy behavior).
  readonly evidenceEpochMs?: number;
  // P5b: true when the deployment is perp-capable AND plan-mode shorts are enabled (composition
  // root: config.venues[0].id === 'binanceusdm' && config.agentic.shortsEnabled) — funding accrues
  // on any perp position, but this flag is scoped to the concrete condition this pass targets
  // (perp + shorts). Gates ONLY the fundingDataMissing evidence flag below; never enters `reasons`
  // (measurement gate fails OPEN — see PromotionReadinessService.evaluate's own comment). Default
  // false ⇒ byte-identical (no flag ever raised on a spot-only deployment).
  readonly fundingDataExpected?: boolean;
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

// Per-model token totals across BOTH LLM call sites: agent_decisions (decide path) and llm_usage
// (reflection path). Grouped by model (W4+W13) so a lane running a cheap decide model + a pricier
// reflection model is costed at each model's own rates — flat pricing under-counted the pricier
// path. Cache tokens included (priced $0 before W4+W13). Rows with no tokens (e.g. prescreen HOLD
// journal rows, model='prescreen') contribute zeros and are harmless.
export interface PerModelTokenTotals {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface LlmTokenTotals {
  readonly perModel: readonly PerModelTokenTotals[];
}

// What PromotionReadinessService's round-trip walk + LLM-cost math need from the DB — nothing more.
// Crosses the features/trading/mode-control ↔ database boundary; the composition root is the only
// place allowed to bind a concrete (Drizzle-backed) implementation to this port (rule 2's boundary
// wall — mode-control may not import database directly).
export interface PromotionStatsPort {
  // Ordered oldest→newest (executedAt, then insertion order for ties) fills for the given mode —
  // the round-trip walk depends on this ordering to track signed position correctly. sinceMs, when
  // set, filters to fills executed at/after that instant (evidence-epoch gating); absent ⇒ all-time.
  fillsForMode(mode: TradingMode, sinceMs?: number): Promise<readonly PromotionFillRow[]>;
  // Per-model token totals across the full history (not mode-scoped — agent_decisions carries no
  // mode column; see promotion-readiness.service.ts's own comment on why over-counting cost here is
  // the fail-closed direction). sinceMs filters to rows created at/after that instant; absent ⇒
  // all-time.
  llmTokenTotals(sinceMs?: number): Promise<LlmTokenTotals>;
  // Epoch ms of the newest llm_usage kind='reflection' row, null when reflection has never run.
  // Optional so existing fakes/implementations remain valid; the reflection trigger seed treats an
  // absent method the same as "never reflected".
  latestReflectionAt?(): Promise<number | null>;
  // P5b: Σ funding_payments.amount_quote for mode (sinceMs-scoped like fillsForMode; absent ⇒
  // all-time) — POSITIVE = received, NEGATIVE = paid (see VenueFundingPayment's sign-convention
  // comment, ports/venue/exchange.ts), ADDED directly into the promotion net. hasRows distinguishes
  // "zero net because payments cancelled out" from "zero net because nothing was ever ingested" —
  // PromotionReadinessService uses it for the fail-open missing-data flag. Optional so existing
  // fakes/implementations remain valid; absent ⇒ treated as no funding data (netQuote '0',
  // hasRows false).
  fundingNetForMode?(
    mode: TradingMode,
    sinceMs?: number,
  ): Promise<{ readonly netQuote: string; readonly hasRows: boolean }>;
}

// ── Realized round-trip evidence (reflection lane) ──────────────────────────

export const REFLECTION_EVIDENCE = Symbol('REFLECTION_EVIDENCE');

// One CLOSED demo round trip, walked from venue fills with the same dust-closure rule the
// promotion verdict uses (src/domain/trading/risk/round-trips.ts) — realized venue truth, in contrast to
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
  // Fraction of closed demo round trips with per-trip net (realizedPnl − feesQuote) > 0 over the
  // same evidence window as roundTrips — 0 when roundTrips is 0. Durable (DB-walked); not a live
  // gate. Matches RoundTripEvidence.netPnl / trackRecord.winRate's win definition.
  readonly winRate: number;
  readonly realizedPnl: string;
  readonly fees: string;
  readonly llmCostUsd: string;
  // P5b: Σ funding_payments.amount_quote over the same mode/window as the fills walk — '0' when no
  // stats-port funding method is bound, no rows are in-window, or funding data was never expected.
  // ALREADY folded into netPnl below (netPnl = realizedPnl − fees − llmCostUsd + fundingNet).
  readonly fundingNet: string;
  readonly netPnl: string;
  readonly windowDays: number;
  readonly firstClosedAt: number | null;
  readonly lastClosedAt: number | null;
  // P5b: true when funding data was EXPECTED (config.fundingDataExpected) but zero funding rows
  // exist in-window — a visible measurement-gap signal, deliberately OUTSIDE `reasons` so it never
  // blocks promotion (fail-open; see PromotionReadinessConfig.fundingDataExpected's own comment).
  readonly fundingDataMissing: boolean;
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
