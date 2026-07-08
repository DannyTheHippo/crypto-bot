import { Injectable, Inject, Optional } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  PROMOTION_STATS,
  PROMOTION_READINESS_CONFIG,
  type PromotionStatsPort,
  type PromotionReadinessConfig,
  type PromotionReadinessPort,
  type PromotionReadiness,
  type PerModelTokenTotals,
} from '../../../ports/promotion';
import { walkRoundTrips, sumFeesQuote } from '../../../domain/risk/round-trips';

const DEMO_MODE = 'testnet' as const;
const MIN_ROUND_TRIPS = 30;
const MIN_WINDOW_DAYS = 14;
const MTOK = new Decimal(1_000_000);
const DAY_MS = 24 * 60 * 60 * 1000;

// The round-trip walk + fee-conversion rules live in src/domain/risk/round-trips.ts (pure, shared
// with the agentic reflection-evidence feed) — this service owns only the VERDICT: which reasons
// gate `permitted`, the LLM cost math, and the evidence window. PromotionFillRow is structurally a
// domain RoundTripFill, so rows flow into the walk unchanged. The extraction is behavior-preserving:
// realizedPnl stays GROSS of fees per cycle, with the cross-cycle sumFeesQuote subtracted once here.
//
// mode-control is a 100%-branch coverage glob (vitest.config.ts) — every conditional here is
// exercised by promotion-readiness.service.spec.ts's fake-stats-port branch matrix.
@Injectable()
export class PromotionReadinessService implements PromotionReadinessPort {
  constructor(
    @Optional() @Inject(PROMOTION_STATS) private readonly stats: PromotionStatsPort | undefined,
    @Inject(PROMOTION_READINESS_CONFIG) private readonly cfg: PromotionReadinessConfig,
  ) {}

  async evaluate(): Promise<PromotionReadiness> {
    if (this.stats === undefined) {
      return notPermitted(['NO_STATS_SOURCE'], zeroEvidence());
    }

    // Evidence epoch (W4+W13, owner 2026-07-08): both stats reads and the window anchor gate on the
    // owner-declared instant so a post-fix configuration is judged on post-fix evidence, not the
    // sunk experimentation hole. Absent ⇒ all-time (both branches exercised under the 100% glob).
    // STRADDLE BOUND (reviewer 2026-07-08): fills are filtered by venue_timestamp >= epoch BEFORE the
    // walk, so a round trip that OPENED before the epoch and closed after loses its opening fill and
    // the boundary cycle's PnL/count can be mis-walked. This is bounded and NOT a false-permit path —
    // every surviving cycle has closedAt >= epoch, so neither the ≥30-round-trip floor nor the 14-day
    // window can be inflated, and the four live gates + bootId arming ceremony still bind behind the
    // verdict. Owner mitigation: declare the epoch at a FLAT-position instant (both strategies were
    // dust-flat at the 2026-07-08 deploy), which removes any straddle entirely.
    const epochMs = this.cfg.evidenceEpochMs;
    const [fills, tokenTotals] = await Promise.all([
      this.stats.fillsForMode(DEMO_MODE, epochMs),
      this.stats.llmTokenTotals(epochMs),
    ]);

    const dustNotional = new Decimal(this.cfg.dustNotional);
    const { cycles, unconvertibleFeeAsset } = walkRoundTrips(fills, dustNotional);
    const hasUnresolvedFill = fills.some((f) => f.strategyId === null || f.side === null);

    const realizedPnl = cycles.reduce((sum, c) => sum.plus(c.realizedPnl), new Decimal(0));
    const fees = sumFeesQuote(fills);
    const llmCostUsd = this.llmCostUsd(tokenTotals);
    const netPnl = realizedPnl.minus(fees).minus(llmCostUsd);

    const firstClosedAt = cycles.length > 0 ? Math.min(...cycles.map((c) => c.closedAt)) : null;
    const lastClosedAt = cycles.length > 0 ? Math.max(...cycles.map((c) => c.closedAt)) : null;
    // Keyed off cycles.length (not first/last null-checks): first/last are null together or set
    // together, so a null-check pair would carry an unreachable mixed branch under the 100% glob.
    // The window START anchors at max(firstClosedAt, epoch): a partial first day inside the epoch
    // must not inflate the measured window (an epoch set after firstClosedAt would otherwise let a
    // pre-epoch trade widen it). windowStart falls to firstClosedAt when the epoch is unset or older.
    const windowStart =
      firstClosedAt !== null && epochMs !== undefined
        ? Math.max(firstClosedAt, epochMs)
        : firstClosedAt;
    const windowDays =
      cycles.length > 0 && windowStart !== null ? (lastClosedAt! - windowStart) / DAY_MS : 0;

    const reasons: string[] = [];
    if (hasUnresolvedFill) reasons.push('UNRESOLVED_FILL');
    if (unconvertibleFeeAsset) reasons.push('UNCONVERTIBLE_FEE_ASSET');
    if (cycles.length < MIN_ROUND_TRIPS) reasons.push('INSUFFICIENT_ROUND_TRIPS');
    if (netPnl.lte(0)) reasons.push('NON_POSITIVE_NET_PNL');
    if (windowDays < MIN_WINDOW_DAYS) reasons.push('INSUFFICIENT_WINDOW');

    const evidence = {
      roundTrips: cycles.length,
      realizedPnl: realizedPnl.toFixed(),
      fees: fees.toFixed(),
      llmCostUsd: llmCostUsd.toFixed(),
      netPnl: netPnl.toFixed(),
      windowDays,
      firstClosedAt,
      lastClosedAt,
      reasons,
    };

    return reasons.length === 0 ? { permitted: true, evidence } : { permitted: false, evidence };
  }

  // Σ over models of (in×rateIn + out×rateOut + cacheRead×rateCacheRead + cacheCreation×rateCacheWrite)
  // / 1M — each model priced at its OWN rates (W4+W13). All Decimal-on-strings (rates are decimal
  // strings from config). An empty perModel list yields 0 (no LLM calls in the window).
  private llmCostUsd(tokenTotals: { perModel: readonly PerModelTokenTotals[] }): Decimal {
    return tokenTotals.perModel.reduce((sum, m) => {
      const r = this.ratesFor(m.model);
      const cost = new Decimal(m.inputTokens)
        .div(MTOK)
        .mul(r.input)
        .plus(new Decimal(m.outputTokens).div(MTOK).mul(r.output))
        .plus(new Decimal(m.cacheReadTokens).div(MTOK).mul(r.cacheRead))
        .plus(new Decimal(m.cacheCreationTokens).div(MTOK).mul(r.cacheWrite));
      return sum.plus(cost);
    }, new Decimal(0));
  }

  // Rate resolution order: the model's own entry in tokenPrices → the flat default-model rates
  // (used both when tokenPrices is absent and for the default model itself, which the caller is
  // expected to also list, but the default covers it either way) → for an UNKNOWN model when a
  // tokenPrices map IS configured, the MOST EXPENSIVE rate per component across every configured
  // rate set (defaults + all mapped models). Fail-closed: a cost row naming a model the operator
  // never priced can only ever OVER-count, never silently under-count, inside a live-arming gate.
  private ratesFor(model: string): {
    input: Decimal;
    output: Decimal;
    cacheRead: Decimal;
    cacheWrite: Decimal;
  } {
    const defaults = {
      input: new Decimal(this.cfg.tokenPriceInputPerMtok),
      output: new Decimal(this.cfg.tokenPriceOutputPerMtok),
      cacheRead: new Decimal(this.cfg.tokenPriceCacheReadPerMtok ?? '0'),
      cacheWrite: new Decimal(this.cfg.tokenPriceCacheWritePerMtok ?? '0'),
    };
    const map = this.cfg.tokenPrices;
    if (map === undefined) return defaults;
    const entry = map[model];
    if (entry !== undefined) {
      return {
        input: new Decimal(entry.inputPerMtok),
        output: new Decimal(entry.outputPerMtok),
        cacheRead: new Decimal(entry.cacheReadPerMtok),
        cacheWrite: new Decimal(entry.cacheWritePerMtok),
      };
    }
    const pools = [
      defaults,
      ...Object.values(map).map((e) => ({
        input: new Decimal(e.inputPerMtok),
        output: new Decimal(e.outputPerMtok),
        cacheRead: new Decimal(e.cacheReadPerMtok),
        cacheWrite: new Decimal(e.cacheWritePerMtok),
      })),
    ];
    return {
      input: Decimal.max(...pools.map((p) => p.input)),
      output: Decimal.max(...pools.map((p) => p.output)),
      cacheRead: Decimal.max(...pools.map((p) => p.cacheRead)),
      cacheWrite: Decimal.max(...pools.map((p) => p.cacheWrite)),
    };
  }
}

function zeroEvidence() {
  return {
    roundTrips: 0,
    realizedPnl: '0',
    fees: '0',
    llmCostUsd: '0',
    netPnl: '0',
    windowDays: 0,
    firstClosedAt: null,
    lastClosedAt: null,
  };
}

function notPermitted(
  reasons: string[],
  evidence: Omit<PromotionReadiness['evidence'], 'reasons'>,
): PromotionReadiness {
  return { permitted: false, evidence: { ...evidence, reasons } };
}
