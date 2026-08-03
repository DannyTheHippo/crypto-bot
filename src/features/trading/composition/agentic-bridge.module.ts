import { Global, Logger, Module } from '@nestjs/common';
import path from 'node:path';
import Decimal from 'decimal.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { DRIZZLE_DB } from '../../../database/database.tokens';
import type * as schema from '../../../database/schemas/trading';
import { PersistenceModule } from '../../../database/database.module';
import { AgentDecisionJournalAdapter } from '../../../database/repositories/strategy/agent-decision-journal.adapter';
import { InMemoryAgentDecisionJournal } from '../../../database/repositories/strategy/in-memory-agent-decision-journal';
import { LlmUsageSinkAdapter } from '../../../database/repositories/common/llm-usage-sink.adapter';
import { InMemoryLlmUsageSink } from '../../../database/repositories/common/in-memory-llm-usage-sink';
import { PromotionStatsRepository } from '../../../database/repositories/trading/promotion-stats.repository';
import { PassiveBenchmarkRepository } from '../../../database/repositories/trading/passive-benchmark.repository';
import {
  PlaybookStoreAdapter,
  type PlaybookVersionEntry,
} from '../../../database/repositories/strategy/playbook-store.adapter';
import { InMemoryPlaybookStore } from '../../../database/repositories/strategy/in-memory-playbook-store';
import { ObservabilityModule } from '../../common/observability/observability.module';
import { AgentMetricsRecorder } from '../../common/observability/agent-metrics-recorder.service';
import { RiskModule } from '../risk/risk.module';
import { ExecutionModule } from '../execution/execution.module';
import {
  AgenticStrategyModule,
  AGENT_LLM_BUDGET,
  PLAYBOOK_PROVIDER_OVERRIDE,
  AGENT_TRADING_PROFILE_OVERRIDE,
  ACTIVE_MENU_GATE_OVERRIDE,
  PAYLOAD_EXTRAS_PROVIDER_OVERRIDE,
  REFLECTION_METRICS_RECORDER_OVERRIDE,
  SEED_PLAYBOOK_V3,
} from '../../strategy/agentic/agentic-strategy.module';
import type { DailyLlmBudget } from '../../strategy/agentic/agent-budget';
import { buildAgentPortfolioBlock } from '../../strategy/agentic/agent-portfolio-block';
import { loadMacroCalendar, filterUpcoming } from '../../strategy/agentic/macro-calendar';
import { ExecQualityService } from '../../strategy/agentic/exec-quality.service';
import { PriceHistoryStore } from '../../strategy/agentic/price-history-store';
import { validatePlaybook } from '../../strategy/agentic/playbook-validator';
import { UniverseScannerService } from '../../strategy/agentic/universe-scanner.service';
import { RoundTripEvidenceReader } from '../../strategy/agentic/round-trip-evidence.reader';
import { EDGE_POLICY_OVERRIDE } from '../../strategy/agentic/disabled-edge-policy';
import { EdgeCohortPinState } from '../../strategy/agentic/edge-cohort-pin-state';
import { ResidualVolbetaEdgePolicy } from '../../strategy/agentic/residual-volbeta-edge-policy';
import { FEED_HEALTH, type FeedHealthPort } from '../../../ports/venue/market-data';
import {
  LiveVersionRewardSource,
  type VersionRewardSource,
} from '../../common/observability/version-attribution-metrics.service';
import { FUNDING_INGEST } from './context-feeds.module';
import type { FundingIngestService } from '../../venue/exchange/funding-ingest.service';
import {
  AGENT_DECISION_JOURNAL,
  LLM_USAGE_SINK,
  type AgentDecisionJournalPort,
  type AgentTradingProfile,
  type EdgePolicyPort,
  type LlmUsageSink,
  type PlaybookProvider,
  type SymbolConstraints,
} from '../../../ports/strategy/agentic-strategy';
import {
  PASSIVE_BENCHMARK,
  PROMOTION_STATS,
  REFLECTION_EVIDENCE,
  type PassiveBenchmarkPort,
  type PromotionStatsPort,
  type RoundTripEvidencePort,
} from '../../../ports/trading/promotion';
import {
  PORTFOLIO_VIEW,
  EXEC_QUALITY_SINK_OVERRIDE,
  type PortfolioViewPort,
  type ExecQualitySinkPort,
} from '../../../ports/trading/execution';
import { RISK_LIMITS } from '../../../ports/trading/risk';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import type { PartialRiskLimits } from '../../../domain/trading/risk/limits';
import type { SymbolFilters } from '../../../domain/trading/risk/evaluate';
import { DEFAULT_FILTERS } from '../../../domain/trading/risk/default-filters';
import { price, qty } from '../../../domain/common/types/money';
import type { PortfolioSnapshot } from '../../../domain/trading/types/portfolio';
import { symbolId, type VenueId } from '../../../domain/common/types/ids';

// v3 spec §1.3: AgenticBridgeModule replaces AgenticCompositionBridgeModule (pure code motion out of
// app.module.ts) — same twelve tokens, with two v3 deltas: PLAYBOOK_PROVIDER_OVERRIDE's validator
// capabilities are fixed open (perp symbols exist in every v3 boot — see its own factory comment) and
// PAYLOAD_EXTRAS_PROVIDER_OVERRIDE gains per-venue free cash (§6.4/#10bc handoff, see that token's own
// comment below).

// Composition-root shape for the write side of the playbook store (append/listVersions) — neither
// PlaybookStoreAdapter nor InMemoryPlaybookStore share a formal port for it yet (reflection/promotion
// needs one); both classes already satisfy this shape structurally, so this is just the type
// PLAYBOOK_PROVIDER_OVERRIDE's binding below is typed against, without a premature port addition to
// ports/strategy/agentic-strategy.ts.
interface PlaybookStorePort extends PlaybookProvider {
  append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ version: number }>;
  listVersions(limit: number): Promise<readonly PlaybookVersionEntry[]>;
}

// W4.1 live champion/candidate A/B: when a newer INACTIVE reflection-minted candidate exists, route a
// deterministic percentage of current() calls to its content instead of the resolved ACTIVE version,
// so per-version PnL attribution (agent_decisions.playbookVersion / agentic_version_net_pnl_usd{version})
// accrues candidate evidence BEFORE promotion. Playbook content is inert advisory prose — no state
// crosses versions — and whatever this returns still passes through ValidatingPlaybookProvider (the
// outer wrap below) exactly as ACTIVE does, so routing is safe by construction.
//
// Determinism: PlaybookProvider.current() (ports/strategy/agentic-strategy.ts) takes no per-call argument — no
// strategyId/basedOnSeq reaches this layer, and threading either through AGENT_CLIENT/agent-prompt just
// to key routing would be new plumbing this task deliberately avoids. Routing is therefore keyed off
// wall-clock: a UTC-minute bucket (`floor(Date.now() / 60_000) % 100`) compared against `pct`. Every
// current() call within the same UTC minute makes the same routing decision (no flip-flopping between
// two consecutive decides moments apart), while the bucket cycles through all 100 values over ~100
// minutes, approximating the requested percentage over any window longer than that. Not cached across
// calls (unlike PlaybookStoreAdapter/InMemoryPlaybookStore's own resolved-active cache) — each call
// re-derives its bucket off the live clock and re-reads listVersions, so a freshly minted candidate or
// a promotion is picked up on the very next call, never stale.
//
// Exported (like the sibling ValidatingPlaybookProvider) so its own unit spec can import and
// exercise it directly against a fake PlaybookStorePort — same precedent as MetricsWrappingAgentClient
// (trading-runtime.module.ts), which agent-decide-outcome.spec.ts imports from that module the same way.
//
// N2: 'loop-candidate' rows (scripts/playbook-candidate.mjs — the loop-side injection path) route
// exactly like 'reflection' rows here — same INACTIVE-until-promoted shape, same "newest wins above
// active" precedence, same local structural gate below. promotion/seed never route (they ARE, or
// resolve to, the active version already).
//
// 'reflection' is HISTORICAL-ONLY as of 2026-07-30: reflection.service.ts, the only writer of that
// source value, was deleted (research/studies/entry-rate-rederivation-2026-07-30.md). It stays in
// this set because the READ side still routes rows already in the DB — v9 is a live
// source='reflection' candidate currently taking 40% of decides, and dropping the value here would
// stop routing those decides instantly. Remove only once no unresolved 'reflection' row remains.
const CANDIDATE_SOURCES = new Set<PlaybookVersionEntry['source']>(['reflection', 'loop-candidate']);

// #46 (Thompson multi-candidate A/B routing) — decision record, pre-registered per
// change-discipline: this changes a LIVE routing path but is behavior-preserving at current data.
//
// Scheme: one Gaussian-Thompson draw per current() routing decision, over every INACTIVE candidate
// version (not just the newest). Reward = attributed net PnL per closed trip under that version
// (realized − fees), read via VersionRewardSource.rewardsByVersion() — the SAME walkRoundTrips +
// attributeVersion computation VersionAttributionMetricsService's agentic_version_net_pnl_usd /
// agentic_version_round_trips gauges already use (version-attribution-metrics.service.ts). This
// router never re-walks fills itself — it adds NO new net-PnL-per-version computation beyond the
// gauge's (the promotion-evaluator keeps its own explicitly-labelled duplicate for a different
// purpose). Posterior: mean = netPnlUsd/trips (sample mean); variance =
// THOMPSON_PRIOR_VARIANCE_USD2/trips. A TRUE sample variance would need each individual trip's PnL,
// which rewardsByVersion() does not expose (only the sum + count) — computing it here would mean
// re-walking fills a second time, exactly what this router must not do. A fixed prior variance
// scaled by 1/n is the honest posterior given that data shape: it still shrinks (more confident) as
// trips accumulate, it just can't reflect the actual spread of individual trip outcomes.
//
// K = THOMPSON_MIN_TRIPS: the minimum closed-trip count before a candidate's mean is trusted at
// all — small enough to activate within a fresh candidate's first few round trips, large enough
// that one lucky/unlucky trip can't seed the posterior. Named const, not inlined.
//
// Cold-start / behavior-preserving fallback (THE safety property): Thompson activates ONLY when
// >= THOMPSON_MIN_CANDIDATES inactive candidate versions each clear K trips. Below that —
// including today's DB state (1 candidate version, 0 closed trips) — selectCandidate() falls back
// to the pre-#46 newest-wins rule unchanged, so current() stays byte-identical to pre-#46 behavior.
// See playbook-ab-routing.spec.ts's Thompson-fallback cases for the proof.
//
// LIVE-ENABLE TRIGGER: this scheme only ever affects routing once >= 2 candidates coexist with
// >= K attributed-reward trips each — until then it is a no-op. No further action is required to
// "turn it on"; it activates itself the moment that evidence exists, same as the newest-wins rule
// it replaces.
export class PlaybookAbRoutingProvider implements PlaybookStorePort {
  private static readonly BUCKET_MS = 60_000;
  private static readonly THOMPSON_MIN_CANDIDATES = 2;
  private static readonly THOMPSON_MIN_TRIPS = 3;
  private static readonly THOMPSON_PRIOR_VARIANCE_USD2 = 100; // ($10)^2 — deliberately wide prior

  constructor(
    private readonly inner: PlaybookStorePort,
    private readonly pct: number,
    // P1: capability-aware denylist (playbook-validator.ts) — defaults {} (both false, byte-identical
    // spot-strict pre-P1 behavior) so every existing construction site/spec stays unaffected. The
    // composition root below passes the lane's real capabilities so a perp candidate carrying
    // legitimate shorts/leverage prose isn't rejected here before it ever reaches
    // ValidatingPlaybookProvider/AnthropicAgentClient's own (identically-flagged) re-validation.
    private readonly capabilities: { shortsAllowed?: boolean; leverageAllowed?: boolean } = {},
    // #46: optional reward read for Thompson sampling — see the class-level decision-record comment
    // above. Undefined preserves the pre-#46 newest-wins path byte-for-byte, so every existing
    // construction site/spec that doesn't pass one (including the composition root under
    // test/ci/no-DB, where PROMOTION_STATS itself is undefined) stays unaffected.
    private readonly rewardSource?: VersionRewardSource,
    // Injectable so unit tests are deterministic (the Box-Muller draws below consume this) — never
    // Math.random() at module scope, only as this constructor's default parameter value, evaluated
    // once per real (non-test) construction (composition root below never overrides it).
    private readonly rng: () => number = Math.random,
  ) {}

  async current(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    const active = await this.inner.current();
    if (this.pct <= 0) return active; // default/disabled — skip the listVersions round trip entirely

    const bucket = Math.floor(Date.now() / PlaybookAbRoutingProvider.BUCKET_MS) % 100;
    if (bucket >= this.pct) return active;

    const candidate = await this.selectCandidate(active.version);
    if (!candidate) return active;

    // Local structural gate: an invalid candidate falls back to ACTIVE rather than ever being
    // surfaced (and journaled) as the served version — ValidatingPlaybookProvider still re-validates
    // ACTIVE and candidate content identically regardless; this pre-check just keeps a rejected
    // candidate from being the thing that lands in agent_decisions.playbook_version.
    const validation = validatePlaybook(candidate.content, this.capabilities);
    if (!validation.ok) return active;

    // `source` intentionally omitted (not undefined) — this resolution outcome is neither
    // pin/promotion/seed; PlaybookProvider.current()'s own doc calls that "omitted by providers that
    // don't track it".
    return { version: candidate.version, content: candidate.content };
  }

  // The unrouted read (PlaybookProvider.active): the inner store has no routing layer, so its own
  // current() IS the pin/promotion/seed resolution.
  active(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    return this.inner.current();
  }

  // #46: all INACTIVE rows (source in CANDIDATE_SOURCES) with version > the resolved active
  // version — the candidate pool Thompson sampling (or its newest-wins fallback) chooses from. A
  // cap of 50 rows matches InMemoryPlaybookStore.MAX_VERSIONS, so both backings are scanned in full.
  private async selectCandidate(activeVersion: number): Promise<PlaybookVersionEntry | undefined> {
    const versions = await this.inner.listVersions(50);
    const candidates = versions.filter(
      (row) => CANDIDATE_SOURCES.has(row.source) && row.version > activeVersion,
    );
    if (candidates.length === 0) return undefined;

    // Cold-start fallback (see class-level decision-record comment): no reward source bound, or
    // fewer than two candidates exist at all — newest-wins, byte-identical to pre-#46.
    if (
      this.rewardSource === undefined ||
      candidates.length < PlaybookAbRoutingProvider.THOMPSON_MIN_CANDIDATES
    ) {
      return newestOf(candidates);
    }

    // Fail OPEN: this reward read is a DB-backed measurement (journal + fills + round-trip walk) that
    // selects a playbook version, never a safety veto — a transient failure must degrade to the
    // newest-wins fallback the class doc promises, NEVER throw out of current() (which would degrade
    // the whole consult to an error journal row). Trip counts ARE the reward data, so the read
    // necessarily precedes the K-eligibility gate whenever >=2 candidates exist; fail-open wrapping,
    // not read-avoidance, is what keeps the promise.
    try {
      const rewards = await this.rewardSource.rewardsByVersion();
      const eligible = candidates.filter(
        (row) =>
          (rewards.get(row.version)?.trips ?? 0) >= PlaybookAbRoutingProvider.THOMPSON_MIN_TRIPS,
      );
      // Fewer than two candidates have cleared K trips — Thompson stays a no-op; fall back.
      if (eligible.length < PlaybookAbRoutingProvider.THOMPSON_MIN_CANDIDATES) {
        return newestOf(candidates);
      }

      let best: PlaybookVersionEntry | undefined;
      let bestDraw = -Infinity;
      for (const row of eligible) {
        const sample = rewards.get(row.version)!; // eligible ⇒ present, filtered above
        const mean = new Decimal(sample.netPnlUsd).div(sample.trips).toNumber();
        const variance = PlaybookAbRoutingProvider.THOMPSON_PRIOR_VARIANCE_USD2 / sample.trips;
        const draw = sampleGaussian(this.rng, mean, variance);
        if (draw > bestDraw) {
          bestDraw = draw;
          best = row;
        }
      }
      return best;
    } catch {
      return newestOf(candidates);
    }
  }

  append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ version: number }> {
    return this.inner.append(content, source, parentVersion);
  }

  listVersions(limit: number): Promise<readonly PlaybookVersionEntry[]> {
    return this.inner.listVersions(limit);
  }
}

// Pre-#46 "newest wins" rule, factored out so both the Thompson path's cold-start fallback and the
// no-reward-source path call the exact same tie-break (never two independently-drifting copies).
function newestOf(rows: readonly PlaybookVersionEntry[]): PlaybookVersionEntry | undefined {
  let latest: PlaybookVersionEntry | undefined;
  for (const row of rows) {
    if (latest === undefined || row.version > latest.version) latest = row;
  }
  return latest;
}

// Box-Muller transform off the injected uniform rng — see PlaybookAbRoutingProvider's own rng
// param comment for why this never calls Math.random() directly.
function sampleGaussian(rng: () => number, mean: number, variance: number): number {
  const u1 = Math.max(rng(), Number.EPSILON); // avoid log(0)
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * Math.sqrt(variance);
}

// Composition-root tripwire wrapping the resolved playbook store's READ side only: the playbook is
// untrusted, previously-model-authored content (see playbook-validator.ts's header comment).
// AnthropicAgentClient re-validates on every call regardless (defense in depth); this wrapper
// additionally surfaces a rejection to Prometheus (recordValidatorRejection) and guarantees the LLM
// always receives SOME playbook (SEED_PLAYBOOK_V3) rather than the client's own tripwire, which
// silently composes no playbook at all. append/listVersions pass through unvalidated — validation
// only gates what reaches the LLM prompt, never the store's write side (reflection/promotion write
// raw content).
export class ValidatingPlaybookProvider implements PlaybookStorePort {
  constructor(
    private readonly inner: PlaybookStorePort,
    private readonly recorder: AgentMetricsRecorder,
    // P1: see PlaybookAbRoutingProvider's identical param — same default, same rationale.
    private readonly capabilities: { shortsAllowed?: boolean; leverageAllowed?: boolean } = {},
  ) {}

  async current(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    return this.validated(this.inner.current());
  }

  // Forwards the unrouted active read through the SAME validation as current() — the boot info
  // stamp must never surface unvalidated content either. Falls back to inner.current() when the
  // inner chain has no routing layer (active absent ⇒ current already is the active read).
  async active(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    return this.validated(this.inner.active?.() ?? this.inner.current());
  }

  private async validated(
    read: Promise<{ version: number; content: string; source?: 'pin' | 'promotion' | 'seed' }>,
  ): Promise<{ version: number; content: string; source?: 'pin' | 'promotion' | 'seed' }> {
    const stored = await read;
    const validation = validatePlaybook(stored.content, this.capabilities);
    if (!validation.ok) {
      this.recorder.recordValidatorRejection(
        validation.bannedTokenHit ?? false,
        validation.bannedToken,
      );
      // v3: one lineage — the unified seed folds both venue-classes' prose (spec §1.3); the
      // per-lane seed selection is retired with the lane model itself.
      return { ...SEED_PLAYBOOK_V3, source: 'seed' };
    }
    return stored;
  }

  append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ version: number }> {
    return this.inner.append(content, source, parentVersion);
  }

  listVersions(limit: number): Promise<readonly PlaybookVersionEntry[]> {
    return this.inner.listVersions(limit);
  }
}

// SymbolFilters (venue rounding rules Risk/Execution enforce, see domain/trading/risk/default-filters.ts) →
// SymbolConstraints (the agentic port's own name for the identical shape). Exported for
// trading-runtime.module.ts's STRATEGY_HOST factory (constraintsFor), which needs the SAME lookup the
// trading profile below reads — never a second, independently-drifting copy.
export function symbolConstraintsFor(symbol: string): SymbolConstraints | undefined {
  const filters: SymbolFilters | undefined = DEFAULT_FILTERS.get(symbol);
  if (!filters) return undefined;
  return {
    tickSize: price(filters.tickSize),
    lotStep: qty(filters.stepSize),
    minNotional: price(filters.minNotional),
  };
}

// The agentic lane's own commercial profile (folded into its system prompt — see
// AnthropicAgentClientConfig.profile), built from the SAME sources Risk/paper fees use rather than a
// second, independently-tunable copy: maxOrderNotional is read live off RISK_LIMITS (RiskModule's
// config-overlaid DEFAULT_LIMITS, exported for exactly this single-source-of-truth read — see
// LimitsCompleteModule); baseNotional is the SAME validated AppConfig.risk.baseNotional risk.module.ts's
// sizer reads (passed in by the factory below, so prompt and sizer can never drift); maker/takerBps
// mirror the paper fee schedule (§1.5) — the actual fee schedule the paper adapter charges, not a
// hardcoded guess. equityFraction is the SAME validated AppConfig.risk.equityFraction risk.module.ts's
// sizer reads (P5 compounding sizing) — set on the profile only when > 0 so the prompt sentence and
// the sizer's active path can never disagree.
function agentTradingProfileFor(
  symbol: string,
  limits: PartialRiskLimits,
  baseNotional: string,
  equityFraction: string,
  protectStopLossPct: string,
  protectTrailingPct: string,
): AgentTradingProfile {
  return {
    makerBps: '10',
    takerBps: '10',
    baseNotional,
    maxOrderNotional: limits.maxOrderNotional ?? '100000',
    constraints: symbolConstraintsFor(symbol) ?? {
      tickSize: price('0.01'),
      lotStep: qty('0.0001'),
      minNotional: price('10'),
    },
    // Only set when compounding sizing is actually active — an always-present '0' would flip the
    // prompt's sizing sentence for every unconfigured deployment (the disabled-path prompt must stay
    // byte-identical to pre-P5).
    ...(new Decimal(equityFraction).gt(0) ? { equityFraction } : {}),
    // §S3: same latitude as equityFraction above — only set when the corresponding knob is active, so
    // the disabled-path prompt stays byte-identical to pre-S3.
    ...(new Decimal(protectStopLossPct).gt(0) ? { protectStopLossPct } : {}),
    ...(new Decimal(protectTrailingPct).gt(0) ? { protectTrailingPct } : {}),
  };
}

// v3 spec §6.4/#10bc handoff: one entry per venue carrying a live balance snapshot — the client's
// capabilitiesFor (anthropic-agent-client.ts) reads this map per symbol via venueForSymbol to
// populate SymbolCapabilities.venueFreeCash. Kept as a flat map (never re-derived from
// buildAgentPortfolioBlock's own perVenue array) because perVenue is gated on venueCapitalShare being
// configured (§6.4's "omitted beats wrong" convention) while the client's per-symbol free-cash read
// must stay populated whenever the balance snapshot itself exists, split or not.
export function buildVenueFreeCash(
  venueBalances: PortfolioSnapshot['venueBalances'],
): ReadonlyMap<VenueId, string> | undefined {
  if (venueBalances === undefined) return undefined;
  const result = new Map<VenueId, string>();
  for (const [venue, balances] of venueBalances) {
    result.set(venue, (balances.get('USDT')?.free ?? new Decimal(0)).toFixed());
  }
  return result;
}

// The ACTIVE_MENU_GATE_OVERRIDE pin predicate, factored out (like symbolConstraintsFor/
// buildVenueFreeCash/agentTradingProfileFor above) so the full precedence — edge-cohort
// short-circuit, then position, then in-flight-intent/resting-order — is directly unit-testable
// without a Nest bootstrap. Order is load-bearing: edge cohort first (cheapest, no snapshot read),
// then position, then in-flight/resting orders.
//
// In-flight intents (S1, 2026-08-03 review): a PRE-EXISTING gap, unrelated to dust accounting — an
// entry intent submitted but not yet reflected in snap.openOrders (the window between submit and
// the order-open event) had NO pin at all before this fix: no position row exists yet (the fill
// hasn't landed) and no open-order row exists yet either (the venue hasn't acked it), so a symbol
// could drop off the active menu mid-entry. Closing it here mirrors the resting-order clause
// (same "don't strand a symbol the book is already committed to" rule) rather than inventing a
// second convention.
export function buildMenuPinPredicate(
  edgePins: EdgeCohortPinState,
  portfolio: PortfolioViewPort,
): (symbol: string) => boolean {
  return (symbol) => {
    if (edgePins.has(symbol)) return true;
    const snap = portfolio.snapshot();
    for (const p of snap.positions.values()) {
      if (String(p.symbol) === symbol && !p.signedQty.isZero()) return true;
    }
    return (
      snap.openOrders.some((o) => String(o.symbol) === symbol) ||
      snap.inFlightIntents.some((i) => String(i.symbol) === symbol)
    );
  };
}

function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}

// v3 spec §1.3: AgenticCompositionBridgeModule's twelve tokens, moved verbatim except the two deltas
// documented above PAYLOAD_EXTRAS_PROVIDER_OVERRIDE/PLAYBOOK_PROVIDER_OVERRIDE below. RiskModule is
// needed for RISK_LIMITS (the trading profile), ExecutionModule for CLOCK — PAYLOAD_EXTRAS_PROVIDER_
// OVERRIDE's factory injects both directly (I1b) but this module never imported either exporter
// (PORTFOLIO_VIEW already reaches here via the global PortfolioViewBridgeModule, which is why only
// these two were missing).
@Global()
@Module({
  imports: [
    PersistenceModule,
    ObservabilityModule,
    RiskModule,
    AgenticStrategyModule,
    ExecutionModule,
  ],
  providers: [
    {
      provide: AGENT_DECISION_JOURNAL,
      useFactory: (db: NodePgDatabase<typeof schema> | null): AgentDecisionJournalPort =>
        isTestEnv() || db === null
          ? new InMemoryAgentDecisionJournal()
          : new AgentDecisionJournalAdapter(db),
      inject: [DRIZZLE_DB],
    },
    {
      // DB-backed LLM_USAGE_SINK: persisted reflection-path token usage to llm_usage for offline cost
      // analysis (P2a) — ReflectionService injected this @Optional, so undefined (paper/no-DB/test)
      // simply skipped recording. ReflectionService was deleted (9a63edf); llm_usage is vestigial by
      // design now (no live writer) — its 69 historical rows are already correctly folded into the
      // promotion cost figure. In-memory (array-backed, not a bare no-op — see its own comment) under
      // test/ci or no-DB, mirroring AGENT_DECISION_JOURNAL's own fallback convention above.
      provide: LLM_USAGE_SINK,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): LlmUsageSink =>
        isTestEnv() || db === null
          ? new InMemoryLlmUsageSink()
          : new LlmUsageSinkAdapter(db, config.mode.configMode),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      // Bound under its own token (not directly to PLAYBOOK_PROVIDER, which AgenticStrategyModule owns)
      // so the write side (append/listVersions) stays reachable for reflection/promotion (G4a/G4b)
      // alongside the validated read side AgenticStrategyModule's PLAYBOOK_PROVIDER factory consumes
      // via PLAYBOOK_PROVIDER_OVERRIDE (see that token's own comment).
      provide: PLAYBOOK_PROVIDER_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
        recorder: AgentMetricsRecorder,
        stats: PromotionStatsPort | undefined,
        journal: AgentDecisionJournalPort,
      ): PlaybookStorePort => {
        const pin = config.agentic.playbookPin;
        // v3 (spec §1.3): perp symbols exist in every v3 boot, so validator capabilities are fixed
        // open — per-symbol shorts/leverage gating moved to the client's capability zod layer; the
        // lane-selector convention (shortsEnabled doubling as perp marker) is retired.
        const capabilities = {
          shortsAllowed: true,
          leverageAllowed: true,
        };
        const seed = SEED_PLAYBOOK_V3;
        const store =
          isTestEnv() || db === null
            ? new InMemoryPlaybookStore(seed, pin)
            : new PlaybookStoreAdapter(db, seed, pin);
        // #46: same undefined-under-test/ci/no-DB gate as PROMOTION_STATS itself (stats undefined
        // ⇒ no reward source bound ⇒ PlaybookAbRoutingProvider's cold-start fallback, never Thompson).
        const rewardSource: VersionRewardSource | undefined =
          stats === undefined
            ? undefined
            : new LiveVersionRewardSource(
                stats,
                journal,
                config.agentic.promotionDustNotional,
                config.agentic.promotionEvidenceEpoch === undefined
                  ? undefined
                  : Date.parse(config.agentic.promotionEvidenceEpoch),
              );
        // W4.1/#46: A/B router sits INSIDE the validating wrap, so candidate content faces the exact
        // same read-side validation as ACTIVE. pct=0 (default) short-circuits to the plain store.
        const routed = new PlaybookAbRoutingProvider(
          store,
          config.agentic.playbookAbPct,
          capabilities,
          rewardSource,
        );
        return new ValidatingPlaybookProvider(routed, recorder, capabilities);
      },
      inject: [
        DRIZZLE_DB,
        TypedConfigService,
        AgentMetricsRecorder,
        PROMOTION_STATS,
        AGENT_DECISION_JOURNAL,
      ],
    },
    {
      // The shared client's STATIC profile: fees/sizing/backstop are symbol-independent; the
      // constraints here are only the fallback — the client resolves per-symbol constraints per
      // decide (constraintsFor, agentic-strategy.module.ts), so the first configured symbol is
      // just the fallback anchor.
      provide: AGENT_TRADING_PROFILE_OVERRIDE,
      useFactory: (limits: PartialRiskLimits, config: TypedConfigService): AgentTradingProfile =>
        agentTradingProfileFor(
          config.strategy.symbols[0]!,
          limits,
          config.risk.baseNotional,
          config.risk.equityFraction,
          config.risk.protectStopLossPct,
          config.risk.protectTrailingPct,
        ),
      inject: [RISK_LIMITS, TypedConfigService],
    },
    {
      // I1 (Design § Universe): ONE shared UniverseScannerService, bound here (not a field
      // initializer on TradingRuntimeService) so both the batching client's ActiveMenuGate
      // (agentic-strategy.module.ts's AGENT_CLIENT factory, via this SAME token) and
      // TradingRuntimeService's own recompute-cadence/pin-provider wiring share the exact same
      // instance — never two independently-drifting scanners. isPinned reads the live PORTFOLIO_VIEW
      // snapshot: a symbol carrying an open position, a resting order, or an in-flight entry intent
      // (S1, 2026-08-03 review) is always active, never orphaned from consults — see
      // buildMenuPinPredicate's own comment (below, ACTIVE_MENU_GATE_OVERRIDE) for the full
      // precedence.
      provide: EdgeCohortPinState,
      useFactory: (): EdgeCohortPinState => new EdgeCohortPinState(),
    },
    {
      // Owner-directed demo: residual20-volbeta despite tournament DD/concentration gate fail.
      // Absent/other families ⇒ undefined ⇒ createEdgePolicyPort stays fail-closed DisabledEdgePolicy.
      provide: EDGE_POLICY_OVERRIDE,
      useFactory: (
        config: TypedConfigService,
        feed: FeedHealthPort | undefined,
        clock: ClockPort,
        pinState: EdgeCohortPinState,
      ): EdgePolicyPort | undefined => {
        if (config.agentic.edgePolicyFamily !== 'residual20-volbeta') return undefined;
        if (!feed) {
          Logger.warn(
            'EDGE_POLICY_OVERRIDE: FEED_HEALTH absent — residual20-volbeta unbound',
            'AgenticBridge',
          );
          return undefined;
        }
        return new ResidualVolbetaEdgePolicy({
          feedHealth: feed,
          symbols: config.strategy.symbols,
          now: () => clock.now(),
          pinState,
          logger: {
            warn: (m) => Logger.warn(m, 'ResidualVolbetaEdgePolicy'),
            log: (m) => Logger.log(m, 'ResidualVolbetaEdgePolicy'),
          },
        });
      },
      inject: [
        TypedConfigService,
        { token: FEED_HEALTH, optional: true },
        CLOCK,
        EdgeCohortPinState,
      ],
    },
    {
      provide: ACTIVE_MENU_GATE_OVERRIDE,
      useFactory: (
        config: TypedConfigService,
        portfolio: PortfolioViewPort,
        recorder: AgentMetricsRecorder,
        edgePins: EdgeCohortPinState,
      ): UniverseScannerService =>
        new UniverseScannerService({
          basket: config.strategy.symbols,
          menuSize: config.agentic.activeMenuSize,
          isPinned: buildMenuPinPredicate(edgePins, portfolio),
          logger: { log: (msg) => Logger.log(msg, 'UniverseScanner') },
          // W1 (Grafana rebuild): adapts the recorder's methods to UniverseScannerMetricsLike —
          // this module never imports features/common/observability's boundaries wall the other
          // way, so the adaptation lives here at the composition root.
          metrics: {
            setActiveMenu: (symbols) => recorder.setActiveMenu(symbols),
            recordMenuChurn: (menuIn, menuOut) => recorder.recordMenuChurn(menuIn, menuOut),
          },
        }),
      inject: [TypedConfigService, PORTFOLIO_VIEW, AgentMetricsRecorder, EdgeCohortPinState],
    },
    {
      // P5 (Design § Learning & measurement stack): ONE shared ExecQualityService instance, exported
      // so a later step can also thread it into ReflectionService's deps. W3 Part 1 wired the
      // production entry-attempt feed (fill-ingestor.service.ts's recordExecQualityFill +
      // exec-report-consumer.service.ts's recordExecQualityUnfilled, bridged in via
      // EXEC_QUALITY_SINK_OVERRIDE below) — digest() now populates once ≥5 attempts land. The no-op
      // priceLookup remains: PriceHistoryStore (below) is an AT-OR-AFTER-a-timestamp series lookup,
      // not the point query ExecQualityPriceLookup's contract needs.
      provide: ExecQualityService,
      useFactory: (): ExecQualityService =>
        new ExecQualityService({ priceLookup: () => undefined }),
    },
    {
      // W3 Part 2 (Design § Learning & measurement stack): ONE shared PriceHistoryStore instance,
      // same "@Global()-provided singleton" convention as ExecQualityService above. Written by
      // TradingRuntimeService's onCandleMetrics closure (AgenticStrategyDeps.priceHistory — every
      // agentic-N instance's own candle window), read back by PAYLOAD_EXTRAS_PROVIDER_OVERRIDE below
      // (correlation.btcBeta) and by AgenticStrategyDeps.priceHistory itself
      // (netVsEqualWeightBasketBps).
      provide: PriceHistoryStore,
      useFactory: (): PriceHistoryStore => new PriceHistoryStore(),
    },
    {
      // W3 Part 1: composition-root bridge for the exec-quality fan-out (ports/trading/execution.ts's
      // EXEC_QUALITY_SINK_OVERRIDE — mirrors EXEC_OUTBOX_OVERRIDE's Global-module override pattern).
      // ExecutionModule cannot import ExecQualityService directly (boundaries forbid execution →
      // agentic), so this @Global() module — which already owns the ExecQualityService instance —
      // supplies the adapter ExecutionModule's own EXEC_QUALITY_SINK provider optionally injects.
      provide: EXEC_QUALITY_SINK_OVERRIDE,
      useFactory: (execQuality: ExecQualityService): ExecQualitySinkPort => ({
        recordEntryAttempt: (attempt) => execQuality.recordEntryAttempt(attempt),
      }),
      inject: [ExecQualityService],
    },
    {
      // I1b (Design § Enriched model inputs): the composition-root closure AnthropicAgentClientConfig.
      // payloadExtrasProvider calls at most once per decide()/batch (buildAgentPortfolioBlock off the
      // SAME PORTFOLIO_VIEW snapshot + equityCap the sizer caps sizing equity with,
      // DailyLlmBudget.budgetBlock(), filterUpcoming off a SEPARATE loadMacroCalendar read —
      // TradingRuntimeService loads its own copy for the boot log; both are tolerant/boot-cost-only
      // reads of the same static repo file, never re-read per call).
      //
      // v3 §6.4/#10bc: buildAgentPortfolioBlock now also takes config.venueCapitalSplit (renders the
      // perVenue freeCash/headroom array), and the extras object gains a top-level venueFreeCash map
      // (buildVenueFreeCash, above) — the client's capabilitiesFor (anthropic-agent-client.ts) reads
      // THIS map per symbol to populate SymbolCapabilities.venueFreeCash, never the perVenue array
      // (which is gated on the split being configured). Everything else verbatim.
      provide: PAYLOAD_EXTRAS_PROVIDER_OVERRIDE,
      useFactory: (
        portfolio: PortfolioViewPort,
        config: TypedConfigService,
        budget: DailyLlmBudget,
        clock: ClockPort,
        execQuality: ExecQualityService,
        priceHistory: PriceHistoryStore,
        fundingIngest?: FundingIngestService,
      ) => {
        const macroCalendar = loadMacroCalendar(
          path.join(process.cwd(), 'data', 'macro-calendar.json'),
          {
            warn: (m) => Logger.warn(m, 'MacroCalendar'),
          },
        );
        return () => {
          const snapshot = portfolio.snapshot();
          return {
            // W3 Part 2: correlation.btcBeta populates off the SAME shared PriceHistoryStore
            // netVsEqualWeightBasketBps reads — see buildAgentPortfolioBlock's own comment.
            portfolio: buildAgentPortfolioBlock(
              snapshot,
              config.risk.equityCap,
              priceHistory,
              config.venueCapitalSplit,
            ),
            budget: budget.budgetBlock(),
            calendar: filterUpcoming(macroCalendar, clock.now()),
            // P5: undefined (omitted by buildMarketPayload's own extras.execQuality convention) until
            // ExecQualityService has enough recorded attempts — see this token's own provider comment.
            execQuality: execQuality.digest(),
            // P5b: undefined (FUNDING_INGEST unbound — off-flag, spot venue, or no DB) until the
            // poller has completed at least one poll for the configured symbol.
            fundingAccrualQuote: fundingIngest?.cumulativeAccrualQuote(
              symbolId(config.strategy.symbol),
            ),
            // v3 §6.4/#10bc: per-venue free cash the client keys per symbol via venueForSymbol.
            venueFreeCash: buildVenueFreeCash(snapshot.venueBalances),
          };
        };
      },
      inject: [
        PORTFOLIO_VIEW,
        TypedConfigService,
        AGENT_LLM_BUDGET,
        CLOCK,
        ExecQualityService,
        PriceHistoryStore,
        { token: FUNDING_INGEST, optional: true },
      ],
    },
    // G4a: lets ReflectionService (features/strategy/agentic, which cannot import
    // features/common/observability — the boundary wall) record validator-rejection tripwires
    // through its own LOCAL structural type rather than the concrete class. Same useExisting pattern
    // the DB_HEALTH/PORTFOLIO_VIEW bridges use.
    { provide: REFLECTION_METRICS_RECORDER_OVERRIDE, useExisting: AgentMetricsRecorder },
    {
      // PROMOTION_STATS (earned-live evidence source): DB-backed only — there is deliberately NO
      // in-memory fallback, because PromotionReadinessService treats an absent stats source as the
      // fail-closed NO_STATS_SOURCE verdict (a bot without durable fills has no promotion evidence
      // by definition). undefined under test/ci/no-DB, mirroring the *_OVERRIDE convention.
      provide: PROMOTION_STATS,
      useFactory: (db: NodePgDatabase<typeof schema> | null): PromotionStatsPort | undefined =>
        isTestEnv() || db === null ? undefined : new PromotionStatsRepository(db),
      inject: [DRIZZLE_DB],
    },
    {
      // PASSIVE_BENCHMARK (2026-08-01, G4 — research/studies/success-exit-2026-07-31.md § 6): the
      // benchmark half of the earned-live verdict. Same DB-only, undefined-under-test/ci/no-DB shape
      // as PROMOTION_STATS above — @Optional() at the consumer (PromotionReadinessService) means an
      // absent binding here leaves the clause dark (byte-identical pre-2026-08-01 behavior), never a
      // false permit. AppConfig.strategy.symbols (TRADING_SYMBOLS) is passed as a plain array so the
      // repository itself stays ConfigService-free.
      provide: PASSIVE_BENCHMARK,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): PassiveBenchmarkPort | undefined =>
        isTestEnv() || db === null
          ? undefined
          : new PassiveBenchmarkRepository(db, config.strategy.symbols),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      // Realized round-trip evidence + durable trigger seed for ReflectionService — a pure reader
      // over the same PROMOTION_STATS binding (one fills-walk closure rule for the promotion
      // verdict AND the learning loop). DB-only like PROMOTION_STATS itself: undefined under
      // test/ci/no-DB, where reflection degrades to journal proxies and in-memory triggers.
      provide: REFLECTION_EVIDENCE,
      useFactory: (
        stats: PromotionStatsPort | undefined,
        config: TypedConfigService,
      ): RoundTripEvidencePort | undefined =>
        stats === undefined
          ? undefined
          : new RoundTripEvidenceReader(
              stats,
              config.agentic.promotionDustNotional,
              // Same PROMOTION_EVIDENCE_EPOCH parse as mode-control's readinessConfigProvider — the
              // reflection evidence walk must share the gate's fill window or straddle strays
              // freeze it (see RoundTripEvidenceReader's ctor comment).
              config.agentic.promotionEvidenceEpoch === undefined
                ? undefined
                : Date.parse(config.agentic.promotionEvidenceEpoch),
            ),
      inject: [PROMOTION_STATS, TypedConfigService],
    },
  ],
  exports: [
    AGENT_DECISION_JOURNAL,
    PLAYBOOK_PROVIDER_OVERRIDE,
    AGENT_TRADING_PROFILE_OVERRIDE,
    ACTIVE_MENU_GATE_OVERRIDE,
    PAYLOAD_EXTRAS_PROVIDER_OVERRIDE,
    REFLECTION_METRICS_RECORDER_OVERRIDE,
    ExecQualityService,
    EXEC_QUALITY_SINK_OVERRIDE,
    PriceHistoryStore,
    LLM_USAGE_SINK,
    PROMOTION_STATS,
    PASSIVE_BENCHMARK,
    REFLECTION_EVIDENCE,
    EDGE_POLICY_OVERRIDE,
    EdgeCohortPinState,
  ],
})
export class AgenticBridgeModule {}
