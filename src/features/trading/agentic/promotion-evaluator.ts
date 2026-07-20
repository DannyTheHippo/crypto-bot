import Decimal from 'decimal.js';
import type { StrategyId } from '../../../domain/types/ids';
import type { PromotionStatsPort } from '../../../ports/promotion';
import type { AgentDecisionJournalPort, AgentDecisionRow } from '../../../ports/agentic-strategy';
import type { KillSwitchPort } from '../../../ports/risk';
import type { StrategyRegistryPort } from '../../../ports/strategy';
import { walkRoundTrips } from '../../../domain/risk/round-trips';
import type { LoggerLike } from './anthropic-agent-client';

// Same demo-evidence pin as promotion-readiness.service.ts / version-attribution-metrics.service.ts:
// the demo (testnet) fills ARE the live business case, so attribution + promotion are judged on them.
const DEMO_MODE = 'testnet' as const;
// Fallback recency window over the journal, used ONLY when the bound journal predates
// recentVersioned — matches version-attribution-metrics.service.ts's own fallback so the two
// attribution reads stay consistent. Cycles older than the window label 'unknown' and never
// promote (they can neither be the champion nor a candidate by number).
const DECISION_LOOKBACK_ROWS = 2000;
// Primary attribution read: versioned rows only, since the evidence epoch. Quiet/prescreen rows
// carry NULL versions, so the shared recent(2000) window shrank to ~3 days of wall-clock at
// 8-symbol journal volume — old trips leaked to 'unknown' and the symmetric attributed-trip
// floors became unreachable (2026-07-18; see AgentDecisionJournalPort.recentVersioned). The cap
// is a runaway guard (~months of versioned decides), over-cap drops oldest — same 'unknown'
// fail direction. The margin admits an entry decide preceding its epoch-bounded entry fill —
// at the deployed intraday timeframe (15m, entryValidityBars ≤ 8 ⇒ ~2h max rest) 24h has >12×
// headroom; a 4h/1d timeframe would need this margin re-derived.
const VERSIONED_LOOKBACK_CAP = 20_000;
const EPOCH_DECIDE_MARGIN_MS = 24 * 60 * 60 * 1000;

const NOOP_LOGGER: LoggerLike = { warn: () => undefined };

// Attributed auto-promotion (W5, owner decision 2026-07-08). The A/B router (PlaybookAbRoutingProvider,
// app.module.ts) routes AGENTIC_PLAYBOOK_AB_PCT of decides to the newest INACTIVE reflection candidate,
// so that candidate's own decides carry ITS version and its closed round trips attribute to it. This
// evaluator promotes the candidate to ACTIVE only once it has enough of its OWN attributed trips AND
// its mean net PnL/trip beats the champion's over the same window — replacing the retired count-only
// path (AGENTIC_AUTO_PROMOTE_MIN_TRADES), which promoted the first mint on LANE-WIDE trade count with
// zero candidate-specific evidence. LLM cost is lane-shared (not attributable per version), so it is
// deliberately excluded from the per-version comparison — this compares realized − fees only, the
// trading-edge signal the promotion is about.
//
// Every side effect re-checks its precondition at EXECUTION time (kill switch, lifecycle) like
// ReflectionService — a trigger that was safe when it fired may not be by the time the async run
// lands. The evaluator only ever PROPOSES a promotion the store records; it never touches the trading
// path directly, and (like reflection) is structurally incapable of ratcheting risk: a promoted
// playbook still flows through the same ValidatingPlaybook read side, Risk still sizes/vetoes, and
// the four live gates still bind.

// Local structural type for the read+promote side of the playbook store — mirrors app.module.ts's
// PlaybookStorePort / reflection.service.ts's ReflectionPlaybookStore exactly, without importing
// across the module boundary (the established convention — see PLAYBOOK_PROVIDER_OVERRIDE's comment).
export interface EvaluatorPlaybookStore {
  current(): Promise<{ readonly version: number; readonly content: string }>;
  // Unrouted active read (pin/promotion/seed precedence, NEVER an A/B candidate). The champion
  // identity MUST come from here: current() serves the candidate in ~AGENTIC_PLAYBOOK_AB_PCT% of
  // minute-buckets, and a champion misread as the candidate self-excludes every version from the
  // `version > champion` scan and silently no-ops the round (defect found 2026-07-12). Optional
  // (structural); evaluate() falls back to current() when the bound store predates active().
  active?(): Promise<{ readonly version: number; readonly content: string }>;
  append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ readonly version: number }>;
}

// The one AgentMetricsRecorder method this service needs — shares the reflection-outcome counter so
// promotions are visible on the same series reflection exits use (see ReflectionMetricsRecorder).
export interface EvaluatorMetricsRecorder {
  recordReflectionOutcome?(outcome: string): void;
}

export interface PromotionEvaluatorConfig {
  // Candidate-attributed closed-trip floor before a candidate may auto-promote. 0 disables the
  // evaluator entirely (the legacy count-only path or manual promotion governs instead). Since
  // 2026-07-12 the floor is SYMMETRIC: the champion must also have this many attributed trips in
  // the same evidence window — previously one champion trip seated a comparison baseline.
  readonly minAttributedTrades: number;
  // Probability-of-superiority floor (Mann–Whitney: fraction of candidate-vs-champion trip pairs
  // the candidate wins, ties counted half). The prior bare mean-vs-mean comparison promoted on
  // pure noise at n=10 (~50% false-promote under the null); PoS >= ~0.70 cuts that to ~25-30%
  // while still resolving a genuinely better candidate in weeks at demo trade rates. Deliberately
  // NOT a significance test: any alpha<=0.05 rule at these n has single-digit power and would
  // stall the loop for quarters — honesty beyond this floor belongs to the offline verifier gate.
  readonly minPos: number;
  readonly dustNotional: string;
  // PROMOTION_EVIDENCE_EPOCH in ms — the SAME bound the earned-live gate applies. Unbounded, the
  // walk keeps epoch/wipe-straddling stray fills forever: a symbol group whose signedQty never
  // returns to dust stops attributing round trips entirely, starving the candidate-vs-champion
  // comparison (undefined ⇒ all-time, the pre-epoch behavior).
  readonly evidenceEpochMs?: number;
}

export interface PromotionEvaluatorDeps {
  readonly stats?: PromotionStatsPort;
  readonly journal?: AgentDecisionJournalPort;
  readonly playbookStore?: EvaluatorPlaybookStore;
  readonly recorder?: EvaluatorMetricsRecorder;
  // Absent ⇒ the corresponding safety precondition can't be confirmed, so evaluate fails CLOSED
  // (aborts) rather than assuming a missing dependency would have said yes — same stance as
  // ReflectionService's kill-switch/registry deps.
  readonly killSwitch?: KillSwitchPort;
  readonly registry?: StrategyRegistryPort;
  readonly logger?: LoggerLike;
  readonly nowFn?: () => number;
}

interface VersionStats {
  // Per-trip net (realized − fees) values — kept individually (not just a sum) so the verdict can
  // compute the pairwise probability-of-superiority alongside the mean.
  nets: Decimal[];
}

function meanOf(nets: readonly Decimal[]): Decimal {
  return nets.reduce((acc, n) => acc.plus(n), new Decimal(0)).div(nets.length);
}

// Mann–Whitney probability of superiority: P(candidate trip net > champion trip net), ties at 0.5.
// Deterministic (no bootstrap RNG), scale-free, and robust to the heavy-tailed per-trip PnL that
// makes a bare mean comparison promote on noise. Exported for tests.
export function probabilityOfSuperiority(
  candidate: readonly Decimal[],
  champion: readonly Decimal[],
): Decimal {
  let wins = new Decimal(0);
  for (const c of candidate) {
    for (const ch of champion) {
      const cmp = c.cmp(ch);
      if (cmp > 0) wins = wins.plus(1);
      else if (cmp === 0) wins = wins.plus('0.5');
    }
  }
  return wins.div(candidate.length * champion.length);
}

export class PromotionEvaluator {
  private readonly inert: boolean;
  private inFlight = false;

  constructor(
    private readonly cfg: PromotionEvaluatorConfig,
    private readonly deps: PromotionEvaluatorDeps,
  ) {
    this.inert =
      cfg.minAttributedTrades <= 0 ||
      deps.stats === undefined ||
      deps.journal === undefined ||
      deps.playbookStore === undefined;
  }

  // Synchronous and cheap by construction — NEVER awaited by the strategy (mirrors
  // ReflectionService.onClosedTrade): launches the async evaluate detached, wrapped so it can never
  // throw into the strategy's hot path.
  onClosedTrade(strategyId: StrategyId, count: number): void {
    void strategyId;
    void count;
    try {
      if (this.inert || this.inFlight) return;
      this.inFlight = true;
      void this.evaluate()
        .catch((err) => this.warn(`promotion-eval: run failed: ${errMsg(err)}`))
        .finally(() => {
          this.inFlight = false;
        });
    } catch (err) {
      this.warn(`promotion-eval: onClosedTrade failed unexpectedly: ${errMsg(err)}`);
    }
  }

  private warn(msg: string): void {
    (this.deps.logger ?? NOOP_LOGGER).warn(msg);
  }

  private async evaluate(): Promise<void> {
    const { stats, journal, playbookStore } = this.deps;
    // inert already guarantees these are set, but the checks keep the method self-contained and
    // narrow the types.
    if (!stats || !journal || !playbookStore) return;

    // Preconditions re-checked at execution time (see the class header). Kill switch must be
    // RUNNING and — when a registry is wired — at least one strategy ACTIVE; a fully drained lane
    // must not promote.
    const killState = this.deps.killSwitch?.state();
    if (killState !== 'RUNNING') {
      this.warn(`promotion-eval: kill switch is ${killState ?? 'unavailable'} — aborting`);
      return;
    }
    if (this.deps.registry) {
      const anyActive = this.deps.registry.states().some((s) => s.lifecycle === 'ACTIVE');
      if (!anyActive) {
        this.warn('promotion-eval: no ACTIVE strategy — aborting');
        return;
      }
    }

    // Same NaN guard shape as version-attribution-metrics.service.ts — createPromotionEvaluator
    // already sanitizes NaN→undefined, but a directly-constructed config must not slip a NaN bound
    // into the query (defensive symmetry between the two attribution reads).
    const epochMs =
      this.cfg.evidenceEpochMs === undefined || Number.isNaN(this.cfg.evidenceEpochMs)
        ? undefined
        : this.cfg.evidenceEpochMs;
    const decisionsRead =
      journal.recentVersioned !== undefined
        ? journal.recentVersioned(
            VERSIONED_LOOKBACK_CAP,
            epochMs === undefined ? undefined : epochMs - EPOCH_DECIDE_MARGIN_MS,
          )
        : journal.recent(DECISION_LOOKBACK_ROWS);
    const [fills, decisions, current] = await Promise.all([
      stats.fillsForMode(DEMO_MODE, this.cfg.evidenceEpochMs),
      decisionsRead,
      // Champion identity from the UNROUTED read — see EvaluatorPlaybookStore.active's comment.
      playbookStore.active?.() ?? playbookStore.current(),
    ]);
    const champion = current.version;

    const dust = new Decimal(this.cfg.dustNotional);
    const { cycles } = walkRoundTrips(fills, dust);

    // Per-version attributed per-trip nets. net = realized − fees (LLM cost excluded, see header).
    const byVersion = new Map<number, VersionStats>();
    for (const cycle of cycles) {
      const version = attributeVersion(decisions, cycle.strategyId, cycle.symbol, cycle.openedAt);
      if (version === null) continue; // 'unknown' — unattributable, never counts toward promotion
      const net = cycle.realizedPnl.minus(cycle.feesQuote);
      const prev = byVersion.get(version) ?? { nets: [] };
      prev.nets.push(net);
      byVersion.set(version, prev);
    }

    const championStats = byVersion.get(champion);
    // Symmetric evidence floor (2026-07-12): the champion needs the SAME attributed-trip floor the
    // candidate does — previously a single champion trip seated the baseline, so the comparison was
    // one noisy mean against one data point. Fail-safe toward NOT promoting.
    if (championStats === undefined || championStats.nets.length < this.cfg.minAttributedTrades) {
      const trips = championStats?.nets.length ?? 0;
      if (trips > 0) {
        this.warn(
          `promotion-eval: champion v${champion} has ${trips} attributed trips < symmetric floor ${this.cfg.minAttributedTrades} — holding`,
        );
      }
      return;
    }
    const championMean = meanOf(championStats.nets);

    // Candidate = a version strictly NEWER than the champion (a reflection mint bumps the version).
    // Pick the highest such candidate that clears the attributed-trip floor.
    let best: { version: number; nets: readonly Decimal[]; mean: Decimal } | null = null;
    for (const [version, s] of byVersion) {
      if (version <= champion) continue;
      if (s.nets.length < this.cfg.minAttributedTrades) continue;
      if (best === null || version > best.version) {
        best = { version, nets: s.nets, mean: meanOf(s.nets) };
      }
    }
    if (best === null) return; // no eligible candidate yet

    // Two-part verdict: the candidate's mean must beat the champion's AND the pairwise probability
    // of superiority must clear the configured floor — a heavy-tailed lucky trip can move a mean a
    // long way, but it cannot move rank statistics past ~0.70 on its own.
    const pos = probabilityOfSuperiority(best.nets, championStats.nets);
    if (best.mean.lte(championMean) || pos.lt(this.cfg.minPos)) {
      this.warn(
        `promotion-eval: candidate v${best.version} (mean net ${best.mean.toFixed(4)}, PoS ${pos.toFixed(3)} over ${best.nets.length}x${championStats.nets.length} pairs) does not clear champion v${champion} (mean ${championMean.toFixed(4)}, PoS floor ${this.cfg.minPos}) — holding`,
      );
      return;
    }

    try {
      const promoted = await playbookStore.append(
        `auto-promoted v${best.version} on attributed evidence: mean net/trip ${best.mean.toFixed(4)} > champion v${champion} ${championMean.toFixed(4)}, PoS ${pos.toFixed(3)} >= ${this.cfg.minPos} (n=${best.nets.length} vs ${championStats.nets.length})`,
        'promotion',
        best.version,
      );
      this.deps.recorder?.recordReflectionOutcome?.('auto_promoted');
      this.warn(
        `promotion-eval: auto-promoted playbook v${best.version} to ACTIVE (promotion row ${promoted.version})`,
      );
    } catch (err) {
      this.deps.recorder?.recordReflectionOutcome?.('promote_failed');
      this.warn(
        `promotion-eval: promotion append failed (candidate stays INACTIVE): ${errMsg(err)}`,
      );
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Newest journaled decision at-or-before the cycle's entry, matching (strategyId, symbol) and
// carrying a version, wins — a cycle's entry was decided under exactly one playbook version even if
// it closes after a promotion. Returns null for an unattributable cycle (no matching versioned row).
// Local copy of version-attribution-metrics.service.ts's attributeVersion (structural duplication
// across the observability boundary, same precedent this file's store type follows), returning a
// number|null rather than a 'unknown' string since this consumer compares versions numerically.
// Exported (X8) so version-pnl-digest.ts — same directory, no boundary to cross — imports this
// exact join rather than a fourth duplicate copy.
export function attributeVersion(
  rows: readonly AgentDecisionRow[],
  strategyId: string,
  symbol: string,
  entryAt: number,
): number | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (
      row.strategyId === strategyId &&
      row.symbol === symbol &&
      row.eventTime <= entryAt &&
      row.playbookVersion !== null
    ) {
      return row.playbookVersion;
    }
  }
  return null;
}

// Pure env→config+deps assembly mirroring createReflectionService: disabled (inert) whenever
// AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES is absent/0.
export function createPromotionEvaluator(
  env: Record<string, string | undefined>,
  deps: PromotionEvaluatorDeps,
): PromotionEvaluator {
  const minAttributedTrades = Math.max(
    0,
    new Decimal(env['AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES'] ?? 0).toNumber(),
  );
  // Probability-of-superiority floor (default 0.70; clamped to [0.5, 1] — below 0.5 would promote
  // candidates that LOSE most pairwise comparisons). Raw-env parsed like the other factory knobs;
  // a malformed value falls back to the default rather than failing boot (non-money, fail-safe
  // toward the stricter default).
  let minPos = 0.7;
  const minPosRaw = env['AGENTIC_PROMOTE_MIN_POS'];
  if (minPosRaw !== undefined && minPosRaw !== '') {
    try {
      minPos = Math.min(1, Math.max(0.5, new Decimal(minPosRaw).toNumber()));
    } catch {
      minPos = 0.7;
    }
  }
  const dustNotional = env['PROMOTION_DUST_NOTIONAL'] ?? '5';
  // Same parse as mode-control's readinessConfigProvider: schema-validated ISO instant (or absent
  // ⇒ all-time); an unparseable value from a raw-env context reads as undefined rather than NaN.
  const epochRaw = env['PROMOTION_EVIDENCE_EPOCH'];
  const epochParsed = epochRaw === undefined || epochRaw === '' ? NaN : Date.parse(epochRaw);
  const evidenceEpochMs = Number.isNaN(epochParsed) ? undefined : epochParsed;
  return new PromotionEvaluator(
    { minAttributedTrades, minPos, dustNotional, evidenceEpochMs },
    deps,
  );
}
