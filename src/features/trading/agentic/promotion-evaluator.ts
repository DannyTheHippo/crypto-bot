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
// Recency window over the journal — matches version-attribution-metrics.service.ts's own lookback so
// the two attribution reads stay consistent. Cycles older than the window label 'unknown' and never
// promote (they can neither be the champion nor a candidate by number).
const DECISION_LOOKBACK_ROWS = 2000;

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
  // evaluator entirely (the legacy count-only path or manual promotion governs instead).
  readonly minAttributedTrades: number;
  readonly dustNotional: string;
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
  trips: number;
  netSum: Decimal;
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

    const [fills, decisions, current] = await Promise.all([
      stats.fillsForMode(DEMO_MODE),
      journal.recent(DECISION_LOOKBACK_ROWS),
      playbookStore.current(),
    ]);
    const champion = current.version;

    const dust = new Decimal(this.cfg.dustNotional);
    const { cycles } = walkRoundTrips(fills, dust);

    // Per-version attributed {trips, netSum}. net = realized − fees (LLM cost excluded, see header).
    const byVersion = new Map<number, VersionStats>();
    for (const cycle of cycles) {
      const version = attributeVersion(decisions, cycle.strategyId, cycle.symbol, cycle.openedAt);
      if (version === null) continue; // 'unknown' — unattributable, never counts toward promotion
      const net = cycle.realizedPnl.minus(cycle.feesQuote);
      const prev = byVersion.get(version) ?? { trips: 0, netSum: new Decimal(0) };
      byVersion.set(version, { trips: prev.trips + 1, netSum: prev.netSum.plus(net) });
    }

    const championStats = byVersion.get(champion);
    // No champion evidence in-window ⇒ no basis to compare a candidate against; hold off (fail-safe
    // toward NOT promoting).
    if (championStats === undefined || championStats.trips === 0) return;
    const championMean = championStats.netSum.div(championStats.trips);

    // Candidate = a version strictly NEWER than the champion (a reflection mint bumps the version).
    // Pick the highest such candidate that clears the attributed-trip floor.
    let best: { version: number; mean: Decimal } | null = null;
    for (const [version, s] of byVersion) {
      if (version <= champion) continue;
      if (s.trips < this.cfg.minAttributedTrades) continue;
      if (best === null || version > best.version) {
        best = { version, mean: s.netSum.div(s.trips) };
      }
    }
    if (best === null) return; // no eligible candidate yet

    if (best.mean.lte(championMean)) {
      this.warn(
        `promotion-eval: candidate v${best.version} mean net ${best.mean.toFixed(4)} does not beat champion v${champion} ${championMean.toFixed(4)} — holding`,
      );
      return;
    }

    try {
      const promoted = await playbookStore.append(
        `auto-promoted v${best.version} on attributed evidence: mean net/trip ${best.mean.toFixed(4)} > champion v${champion} ${championMean.toFixed(4)}`,
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
function attributeVersion(
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
  const dustNotional = env['PROMOTION_DUST_NOTIONAL'] ?? '5';
  return new PromotionEvaluator({ minAttributedTrades, dustNotional }, deps);
}
