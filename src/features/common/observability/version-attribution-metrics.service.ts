import { Injectable, OnModuleInit, OnModuleDestroy, Optional, Inject } from '@nestjs/common';
import { InjectMetric, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import Decimal from 'decimal.js';
import { PROMOTION_STATS, type PromotionStatsPort } from '../../../ports/promotion';
import {
  AGENT_DECISION_JOURNAL,
  type AgentDecisionJournalPort,
  type AgentDecisionRow,
} from '../../../ports/agentic-strategy';
import { walkRoundTrips } from '../../../domain/risk/round-trips';
import { TypedConfigService } from '../../../config/environment/typed-config.service';

// Mirrors promotion-metrics.service.ts's own raw process.env boundary check.
function isTestOrCiEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' || process.env['NODE_ENV'] === 'ci' || !!process.env['CI']
  );
}

export const VERSION_NET_PNL_GAUGE = makeGaugeProvider({
  name: 'agentic_version_net_pnl_usd',
  help: 'Realized net PnL (per-cycle realized − per-cycle fees) attributed to the playbook version active at each round trip entry, USD',
  labelNames: ['version'],
});
export const VERSION_ROUND_TRIPS_GAUGE = makeGaugeProvider({
  name: 'agentic_version_round_trips',
  help: 'Closed demo round trips attributed to the playbook version active at entry',
  labelNames: ['version'],
});

// Same demo-evidence mode pin as promotion-readiness.service.ts / round-trip-evidence.reader.ts.
const DEMO_MODE = 'testnet' as const;
// Fallback recency window, used ONLY when the bound journal predates recentVersioned; cycles older
// than the window label version="unknown" rather than mis-attributing. The primary read is
// versioned-rows-only since the evidence epoch: quiet/prescreen rows carry NULL versions, so this
// shared row-count window shrank to ~3 days of wall-clock at 8-symbol journal volume and leaked
// old trips to 'unknown' (2026-07-18; see AgentDecisionJournalPort.recentVersioned). Cap/margin
// semantics mirror promotion-evaluator.ts's — the two attribution reads must stay consistent.
const DECISION_LOOKBACK_ROWS = 2000;
const VERSIONED_LOOKBACK_CAP = 20_000;
const EPOCH_DECIDE_MARGIN_MS = 24 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

// Stage-2's measurement lever: without per-version attribution, playbook promotions are judged
// blind. Attribution rule: a closed round trip belongs to the playbook version carried by the
// newest journaled decision for its (strategyId, symbol) at-or-before the cycle's entry fill —
// entries are decided under exactly one version even when the trip closes after a promotion.
@Injectable()
export class VersionAttributionMetricsService implements OnModuleInit, OnModuleDestroy {
  private sampleInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectMetric('agentic_version_net_pnl_usd')
    private readonly netPnlGauge: Gauge<string>,
    @InjectMetric('agentic_version_round_trips')
    private readonly roundTripsGauge: Gauge<string>,
    private readonly config: TypedConfigService,
    // Both @Optional for the same reason as PromotionMetricsService's readiness port: the global
    // composition bridge binds them at runtime (undefined under test/ci/no-DB → no-op ticks).
    @Optional()
    @Inject(PROMOTION_STATS)
    private readonly stats?: PromotionStatsPort,
    @Optional()
    @Inject(AGENT_DECISION_JOURNAL)
    private readonly journal?: AgentDecisionJournalPort,
  ) {}

  onModuleInit() {
    if (isTestOrCiEnv()) return;
    this.sampleInterval = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
  }

  async tick(): Promise<void> {
    if (this.stats === undefined || this.journal === undefined) return;
    try {
      // Same evidence epoch as the earned-live gate (mode-control's readinessConfigProvider parse):
      // unbounded, an epoch/wipe-straddling stray fill freezes a symbol group's walk permanently
      // once entry sizes drift, and that symbol's trips silently stop attributing to any version.
      const epoch = this.config.agentic.promotionEvidenceEpoch;
      const epochMs = epoch === undefined ? undefined : Date.parse(epoch);
      const journal = this.journal;
      const decisionsRead =
        journal.recentVersioned !== undefined
          ? journal.recentVersioned(
              VERSIONED_LOOKBACK_CAP,
              epochMs === undefined || Number.isNaN(epochMs)
                ? undefined
                : epochMs - EPOCH_DECIDE_MARGIN_MS,
            )
          : journal.recent(DECISION_LOOKBACK_ROWS);
      const [fills, decisions] = await Promise.all([
        this.stats.fillsForMode(DEMO_MODE, epochMs),
        decisionsRead,
      ]);
      const dust = new Decimal(this.config.agentic.promotionDustNotional);
      const { cycles } = walkRoundTrips(fills, dust);

      const netByVersion = new Map<string, Decimal>();
      const tripsByVersion = new Map<string, number>();
      for (const cycle of cycles) {
        const version = attributeVersion(decisions, cycle.strategyId, cycle.symbol, cycle.openedAt);
        // Gauge labels are strings; attributeVersion itself returns number|undefined (see its own
        // comment) so callers needing the numeric version — LiveVersionRewardSource below — never
        // round-trip through a string. This is the only place 'unknown' is minted.
        const label = version === undefined ? 'unknown' : String(version);
        const net = cycle.realizedPnl.minus(cycle.feesQuote);
        netByVersion.set(label, (netByVersion.get(label) ?? new Decimal(0)).plus(net));
        tripsByVersion.set(label, (tripsByVersion.get(label) ?? 0) + 1);
      }

      // reset() drops labels from versions that no longer attribute anything (e.g. after a DB
      // reset) — without it a stale series would keep reporting its last value forever.
      this.netPnlGauge.reset();
      this.roundTripsGauge.reset();
      for (const [version, net] of netByVersion) {
        this.netPnlGauge.set({ version }, net.toNumber());
      }
      for (const [version, trips] of tripsByVersion) {
        this.roundTripsGauge.set({ version }, trips);
      }
    } catch {
      // Fire-and-forget sampler: a transient DB error skips this tick, never crashes the timer.
    }
  }

  onModuleDestroy() {
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
  }
}

// rows arrive oldest→newest (the journal port's documented ordering); the newest at-or-before
// match wins, so iterate backwards and take the first hit carrying a version. Exported (numeric,
// not the gauge's string label) so LiveVersionRewardSource below shares this exact attribution
// rule rather than re-deriving its own.
export function attributeVersion(
  rows: readonly AgentDecisionRow[],
  strategyId: string,
  symbol: string,
  entryAt: number,
): number | undefined {
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
  return undefined;
}

// ── #46 (Thompson multi-candidate A/B routing): per-version reward read ────────────────────────

// Same shape LiveVersionRewardSource.rewardsByVersion() returns per candidate version — netPnlUsd
// stays a decimal string (exact) until PlaybookAbRoutingProvider's Gaussian draw needs a float; see
// that class's own decision-record comment for why the draw, not this read, is where exactness ends.
export interface VersionRewardSample {
  readonly netPnlUsd: string;
  readonly trips: number;
}

export interface VersionRewardSource {
  rewardsByVersion(): Promise<ReadonlyMap<number, VersionRewardSample>>;
}

// On-demand (uncached, unlike the gauge sampler above — no setInterval, no test/CI no-op gate)
// read for the Thompson router: reuses the SAME walkRoundTrips + attributeVersion attribution
// VersionAttributionMetricsService.tick() uses for agentic_version_net_pnl_usd/
// agentic_version_round_trips, so there is exactly one net-PnL-per-version computation in the
// codebase — the router never re-walks fills itself (see agentic-bridge.module.ts's own comment
// on why that constraint holds).
export class LiveVersionRewardSource implements VersionRewardSource {
  constructor(
    private readonly stats: PromotionStatsPort,
    private readonly journal: AgentDecisionJournalPort,
    private readonly dustNotional: string,
    private readonly epochMs?: number,
  ) {}

  async rewardsByVersion(): Promise<ReadonlyMap<number, VersionRewardSample>> {
    const decisionsRead =
      this.journal.recentVersioned !== undefined
        ? this.journal.recentVersioned(
            VERSIONED_LOOKBACK_CAP,
            this.epochMs === undefined ? undefined : this.epochMs - EPOCH_DECIDE_MARGIN_MS,
          )
        : this.journal.recent(DECISION_LOOKBACK_ROWS);
    const [fills, decisions] = await Promise.all([
      this.stats.fillsForMode(DEMO_MODE, this.epochMs),
      decisionsRead,
    ]);
    const dust = new Decimal(this.dustNotional);
    const { cycles } = walkRoundTrips(fills, dust);

    const netByVersion = new Map<number, Decimal>();
    const tripsByVersion = new Map<number, number>();
    for (const cycle of cycles) {
      const version = attributeVersion(decisions, cycle.strategyId, cycle.symbol, cycle.openedAt);
      if (version === undefined) continue; // unattributed — no candidate can claim this reward
      const net = cycle.realizedPnl.minus(cycle.feesQuote);
      netByVersion.set(version, (netByVersion.get(version) ?? new Decimal(0)).plus(net));
      tripsByVersion.set(version, (tripsByVersion.get(version) ?? 0) + 1);
    }

    const result = new Map<number, VersionRewardSample>();
    for (const [version, trips] of tripsByVersion) {
      result.set(version, {
        netPnlUsd: (netByVersion.get(version) ?? new Decimal(0)).toFixed(),
        trips,
      });
    }
    return result;
  }
}
