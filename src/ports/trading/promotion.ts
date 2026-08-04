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
  // Defect 150: watermark (max created_at) of the rows this fold covers, null when it covered none.
  // Replaying it as llmTokenTotals' asOfMs reproduces the exact same totals — without it a recorded
  // llmCostUsd cannot be re-derived at all, because the read's upper edge is "whenever the query
  // ran". Optional so the existing `{ perModel }` fakes stay valid — same convention as
  // fundingNetForMode's ingestedThroughMs below.
  readonly countedThroughMs?: number | null;
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
  //
  // Defect 150: asOfMs caps the read at created_at <= asOfMs for the audit re-derivation path — same
  // shape, and the same "no live caller" rule, as fundingNetForMode's asOfMs below: NARROWING a cost
  // window drops spend and so flatters netPnl, which is the wrong direction for a live-arming gate.
  // The live gate passes ONE argument (see the service's own call site) and must keep passing one.
  llmTokenTotals(sinceMs?: number, asOfMs?: number): Promise<LlmTokenTotals>;
  // ↓ see PassiveBenchmarkPort below for the benchmark half of the verdict.
  // Same fold, but WITHOUT the replay exclusion — every token that cost real money, including
  // `replay-<runId>` decide rows. Exists as a separate method rather than a boolean on
  // llmTokenTotals above precisely because that one feeds the live-arming promotion verdict: a
  // flag there could be passed the wrong way round and silently poison netPnl, whereas two named
  // methods make each caller's intent unmistakable. Use ONLY for spend caps (the daily cost
  // breaker), never for evidence. Optional so existing fakes stay valid — an implementation that
  // omits it leaves the breaker on the evidence-filtered query, i.e. today's behaviour.
  llmSpendTotalsAllSources?(sinceMs?: number): Promise<LlmTokenTotals>;
  // Epoch ms of the newest llm_usage kind='reflection' row, null when reflection has never run.
  // Optional so existing fakes/implementations remain valid; the reflection trigger seed treats an
  // absent method the same as "never reflected".
  latestReflectionAt?(): Promise<number | null>;
  // WATCH-V4-8: epoch ms of the newest agent_decisions row that produced an ACCEPTED decide, null
  // when the lane has never reached the model with a usable answer. prompt_hash and latency_ms are
  // written together and only by client code that has already parsed a response body
  // (agentic.strategy.ts's recordJournalEntry copies them straight off the proposal), so scheduled
  // skips, latched suppressions and thrown errors all carry ''/NULL and are excluded structurally
  // rather than by matching rationale text; the post-200 degrades DO carry both and are excluded by
  // their rationale tag instead (DEGRADED_DECIDE_RATIONALE_TAGS, domain/strategy/types) — a lane whose
  // every consult is schema-rejected is dead in the only sense that matters. Seeds
  // agent_last_success_timestamp_seconds so a redeploy cannot launder a standing lane outage into a
  // green board. Optional so existing fakes stay valid; an absent method leaves the gauge unseeded
  // (0 = "never", which the staleness alert reads as stale).
  lastSuccessfulDecideAt?(): Promise<number | null>;
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
    // Defect 143: caps the read at created_at <= asOfMs for the audit re-derivation path — no caller
    // yet in the tree; the live gate must never pass this. See the repository's own comment for why
    // narrowing the window flatters a book that pays funding.
    asOfMs?: number,
  ): Promise<{
    readonly netQuote: string;
    readonly hasRows: boolean;
    // Watermark (max created_at) of the rows this sum covers; optional so the existing
    // netQuote+hasRows fakes stay valid — same convention as llmSpendTotalsAllSources /
    // latestReflectionAt / lastSuccessfulDecideAt above. asOfMs is for AUDIT re-derivation only:
    // the live gate must never narrow the funding window on a book that pays funding.
    readonly ingestedThroughMs?: number | null;
  }>;
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

// The closed set of blocking-reason labels PromotionReadinessService can ever push into `reasons`
// below — the eight literal strings at notPermitted's one call site (NO_STATS_SOURCE) and
// evaluate()'s seven reasons.push call sites, and no others. Typed here (not left as plain
// `string[]`) so G5's zero-seeded `agentic_promotion_blocked{reason}` gauge
// (promotion-metrics.service.ts) can be built from a `satisfies Record<PromotionBlockedReason,
// true>` map: a ninth reason added to this union without a matching seed-map entry fails typecheck,
// the same exhaustiveness discipline agent-metrics-recorder.service.ts uses for AgentVenueStopEvent.
export type PromotionBlockedReason =
  | 'NO_STATS_SOURCE'
  | 'UNRESOLVED_FILL'
  | 'UNCONVERTIBLE_FEE_ASSET'
  | 'INSUFFICIENT_ROUND_TRIPS'
  | 'NON_POSITIVE_NET_PNL'
  | 'INSUFFICIENT_WINDOW'
  | 'FUNDING_DATA_MISSING'
  | 'BELOW_PASSIVE_BENCHMARK';

export interface PromotionReadinessEvidence {
  readonly roundTrips: number;
  // Fraction of closed demo round trips with per-trip net (realizedPnl − feesQuote) > 0 over the
  // same evidence window as roundTrips — 0 when roundTrips is 0. Durable (DB-walked); not a live
  // gate. Matches RoundTripEvidence.netPnl / trackRecord.winRate's win definition.
  readonly winRate: number;
  readonly realizedPnl: string;
  readonly fees: string;
  readonly llmCostUsd: string;
  // Defects 150/151: the two bounds of the read llmCostUsd covers — lower (the evidence epoch this
  // verdict ran under; null = all-time) and upper (watermark = max created_at of the rows counted;
  // null = none). Replaying them as llmTokenTotals(llmCostSinceMs, llmCostCountedThroughMs)
  // reproduces the exact llmCostUsd. Publishing BOTH is deliberate: the cost interval is NOT the
  // window windowDays measures — it is epoch-anchored like realizedPnl/fees/fundingNet, and cannot
  // be inferred from the window — so an unpublished lower bound left the largest cost term
  // unreproducible even after the upper one existed. Optional (existing verdict literals stay valid)
  // and evidence only: no reason keys off either.
  readonly llmCostSinceMs?: number | null;
  readonly llmCostCountedThroughMs?: number | null;
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
  // Defect 143: watermark (max created_at) of the funding rows this verdict's fundingNet covers.
  // Replaying it as fundingNetForMode's asOfMs reproduces the exact sum. Optional so the existing
  // verdict literals (livegate + metrics + routing specs) stay valid — same convention as
  // PromotionFillRow.refPrice above. Evidence only; no reason keys off it.
  readonly fundingIngestedThroughMs?: number | null;
  // What the passive equal-weight basket would have earned, in quote units, on the SAME capital over
  // the SAME window — or null when no benchmark port is bound or it could not be computed. Compared
  // against netPnl above to produce BELOW_PASSIVE_BENCHMARK. Null is not a failure: the gate simply
  // does not apply the benchmark clause, which is the pre-enable behavior (see PassiveBenchmarkPort).
  readonly passivePnlQuote: string | null;
  readonly reasons: PromotionBlockedReason[];
}

// The benchmark half of the promotion verdict (2026-07-27).
//
// WHY THIS EXISTS: the gate previously asked only for net-of-cost PnL > 0. That bar passes a
// strategy earning +3%/yr while the basket earns +12% — i.e. it certifies value destruction as
// success. Measured on this very lane: the bot lost ~4% of its book over a window in which the same
// 16 assets returned +0.39% equal-weight, and over 7 years every active strategy tested
// underperformed passive exposure (research/studies/horizon-and-baseline-2026-07-27.md, 24/24 cells
// negative). Beating zero is not evidence of skill; beating the alternative is.
//
// Implementations answer in QUOTE UNITS rather than as a return fraction so the capital assumption
// lives with the adapter that knows the book size, and the service stays a pure comparison.
export interface PassiveBenchmarkPort {
  /**
   * What an equal-weight buy-and-hold of the demo universe would have earned, in quote units, on the
   * same capital the strategy was sized against, over [fromMs, toMs].
   *
   * Returns null when it cannot be computed (no venue data, window too short, universe empty). Null
   * is a MEASUREMENT GAP, not a verdict: the readiness service drops the benchmark clause entirely
   * rather than guessing, exactly as it does for absent funding data.
   */
  passivePnlQuote(fromMs: number, toMs: number): Promise<string | null>;
}

export const PASSIVE_BENCHMARK = Symbol('PASSIVE_BENCHMARK');

export interface PromotionReadiness {
  readonly permitted: boolean;
  readonly evidence: PromotionReadinessEvidence;
}

export interface PromotionReadinessPort {
  // Re-evaluated on every call — computed fresh from the DB, never cached (mirrors
  // ModeControlPort.resolveMode's own "callers MUST NOT cache" contract).
  evaluate(): Promise<PromotionReadiness>;
}
