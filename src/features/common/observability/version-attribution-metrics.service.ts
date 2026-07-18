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
        const net = cycle.realizedPnl.minus(cycle.feesQuote);
        netByVersion.set(version, (netByVersion.get(version) ?? new Decimal(0)).plus(net));
        tripsByVersion.set(version, (tripsByVersion.get(version) ?? 0) + 1);
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
// match wins, so iterate backwards and take the first hit carrying a version.
function attributeVersion(
  rows: readonly AgentDecisionRow[],
  strategyId: string,
  symbol: string,
  entryAt: number,
): string {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (
      row.strategyId === strategyId &&
      row.symbol === symbol &&
      row.eventTime <= entryAt &&
      row.playbookVersion !== null
    ) {
      return String(row.playbookVersion);
    }
  }
  return 'unknown';
}
