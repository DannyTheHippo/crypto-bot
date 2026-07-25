import { Logger } from '@nestjs/common';
import { epochMs, symbolId, type EpochMs, type SymbolId } from '../../../domain/common/types/ids';
import { toIndicatorNumber } from '../../../domain/common/types/money';
import { PERP_VENUE_ID } from '../../../domain/venue/types/venue-map';
import type { FeedHealthPort } from '../../../ports/venue/market-data';
import type {
  EdgePolicyCohortMember,
  EdgePolicyPort,
  EdgePolicySnapshot,
} from '../../../ports/strategy/agentic-strategy';
import { EDGE_POLICY_INACTIVE } from './disabled-edge-policy';
import type { EdgeCohortPinState } from './edge-cohort-pin-state';

/** Match tournament residual20-volbeta lookbacks (test/backtest/edge-tournament/constants.ts). */
const ELIGIBILITY_LOOKBACK_DAYS = 90;
const RETURN_LOOKBACK_DAYS = 20;
const BETA_LOOKBACK_DAYS = 60;
const TOP_N = 2;
const BOTTOM_N = 2;
const DAILY_FETCH_BARS = 120;
const REFRESH_EVERY_MS = 6 * 3_600_000;
const BTC_SYMBOL = 'BTC/USDT:USDT';
const MAX_SIZE_FRACTION = '0.10';

export interface DailyCloseSeries {
  readonly timestamps: readonly number[];
  readonly closes: readonly number[];
}

/** `atIdx` is the inclusive decision close index (tournament trailingReturn shape). */
export function trailingReturn(
  closes: readonly number[],
  atIdx: number,
  lookback: number,
): number | null {
  const start = atIdx - lookback;
  if (start < 0 || atIdx >= closes.length) return null;
  const c0 = closes[start]!;
  const c1 = closes[atIdx]!;
  if (!(c0 > 0) || !(c1 > 0)) return null;
  return c1 / c0 - 1;
}

export function trailingBetaAligned(
  series: DailyCloseSeries,
  btc: DailyCloseSeries,
  decisionTs: number,
  lookback: number,
): number | null {
  const sIdx = series.timestamps.indexOf(decisionTs);
  const bIdx = btc.timestamps.indexOf(decisionTs);
  if (sIdx < lookback || bIdx < lookback) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = lookback - 1; k >= 0; k -= 1) {
    const ts1 = series.timestamps[sIdx - k]!;
    const ts0 = series.timestamps[sIdx - k - 1];
    if (ts0 === undefined) return null;
    const bi1 = btc.timestamps.indexOf(ts1);
    const bi0 = btc.timestamps.indexOf(ts0);
    if (bi1 < 0 || bi0 < 0) return null;
    const px0 = series.closes[sIdx - k - 1]!;
    const px1 = series.closes[sIdx - k]!;
    const bx0 = btc.closes[bi0]!;
    const bx1 = btc.closes[bi1]!;
    if (!(px0 > 0) || !(px1 > 0) || !(bx0 > 0) || !(bx1 > 0)) return null;
    xs.push(Math.log(bx1 / bx0));
    ys.push(Math.log(px1 / px0));
  }
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - xMean;
    const dy = ys[i]! - yMean;
    cov += dx * dy;
    varX += dx * dx;
  }
  if (!(varX > 0)) return null;
  return cov / varX;
}

export function residualScoreAtTs(
  series: DailyCloseSeries,
  btc: DailyCloseSeries,
  decisionTs: number,
): number | null {
  const idx = series.timestamps.indexOf(decisionTs);
  const btcIdx = btc.timestamps.indexOf(decisionTs);
  if (idx < ELIGIBILITY_LOOKBACK_DAYS || btcIdx < 0) return null;
  const ret = trailingReturn(series.closes, idx, RETURN_LOOKBACK_DAYS);
  const beta = trailingBetaAligned(series, btc, decisionTs, BETA_LOOKBACK_DAYS);
  const btcRet = trailingReturn(btc.closes, btcIdx, RETURN_LOOKBACK_DAYS);
  if (ret === null || beta === null || btcRet === null) return null;
  return ret - beta * btcRet;
}

export function rankResidualCohort(bySymbol: ReadonlyMap<string, DailyCloseSeries>): {
  readonly members: readonly EdgePolicyCohortMember[];
  readonly longs: readonly string[];
  readonly shorts: readonly string[];
  readonly decisionTs: number;
} | null {
  const btc = bySymbol.get(BTC_SYMBOL);
  if (!btc || btc.timestamps.length < ELIGIBILITY_LOOKBACK_DAYS) return null;
  const decisionTs = btc.timestamps[btc.timestamps.length - 1]!;

  const scored: { sym: string; score: number }[] = [];
  for (const [sym, series] of bySymbol) {
    const score = residualScoreAtTs(series, btc, decisionTs);
    if (score === null) continue;
    scored.push({ sym, score });
  }
  if (scored.length < TOP_N + BOTTOM_N) return null;
  scored.sort((a, b) => b.score - a.score || a.sym.localeCompare(b.sym));
  const longs = scored.slice(0, TOP_N).map((x) => x.sym);
  const shorts = scored.slice(-BOTTOM_N).map((x) => x.sym);
  const members: EdgePolicyCohortMember[] = [
    ...longs.map((sym, i) => {
      const row = scored.find((s) => s.sym === sym)!;
      return { symbol: sym, score: String(row.score), rank: i + 1 };
    }),
    ...shorts.map((sym, i) => {
      const row = scored.find((s) => s.sym === sym)!;
      return { symbol: sym, score: String(row.score), rank: TOP_N + i + 1 };
    }),
  ];
  return { members, longs, shorts, decisionTs };
}

export interface ResidualVolbetaEdgePolicyDeps {
  readonly feedHealth: FeedHealthPort;
  readonly symbols: readonly string[];
  readonly now: () => EpochMs;
  readonly pinState: EdgeCohortPinState;
  readonly logger?: { warn(msg: string): void; log?(msg: string): void };
}

/**
 * Live residual20-volbeta EdgePolicy — daily OHLCV via FEED_HEALTH, fail-closed until cohort ready.
 * Owner-directed demo deploy (tournament gate failed on DD/concentration).
 */
export class ResidualVolbetaEdgePolicy implements EdgePolicyPort {
  private readonly log: { warn(msg: string): void; log?(msg: string): void };
  private members: readonly EdgePolicyCohortMember[] = [];
  private longs = new Set<string>();
  private shorts = new Set<string>();
  private asOfMs: EpochMs | null = null;
  private lastRefreshMs = 0;
  private refreshInFlight: Promise<void> | null = null;

  constructor(private readonly deps: ResidualVolbetaEdgePolicyDeps) {
    this.log = deps.logger ?? {
      warn: (m) => Logger.warn(m, 'ResidualVolbetaEdgePolicy'),
      log: (m) => Logger.log(m, 'ResidualVolbetaEdgePolicy'),
    };
    void this.refresh();
  }

  snapshot(args: { readonly symbol: SymbolId; readonly eventTime: EpochMs }): EdgePolicySnapshot {
    void this.maybeKickRefresh(args.eventTime);
    if (!this.asOfMs || this.members.length < TOP_N + BOTTOM_N) {
      return EDGE_POLICY_INACTIVE;
    }
    const sym = String(args.symbol);
    return {
      active: true,
      familyId: 'residual20-volbeta',
      cohort: { asOfMs: this.asOfMs, members: this.members },
      sideEligibility: {
        long: this.longs.has(sym),
        short: this.shorts.has(sym),
      },
      maxSizeFraction: MAX_SIZE_FRACTION,
    };
  }

  private maybeKickRefresh(now: EpochMs): void {
    if (this.refreshInFlight) return;
    if (now - this.lastRefreshMs < REFRESH_EVERY_MS && this.asOfMs) return;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.runRefresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async runRefresh(): Promise<void> {
    try {
      const next = new Map<string, DailyCloseSeries>();
      const perps = this.deps.symbols.filter((s) => s.includes(':'));
      for (const sym of perps) {
        try {
          const bars = await this.deps.feedHealth.fetchCandles(
            PERP_VENUE_ID,
            symbolId(sym),
            '1d',
            DAILY_FETCH_BARS,
          );
          const timestamps: number[] = [];
          const closes: number[] = [];
          for (const b of bars) {
            if (!b.closed) continue;
            timestamps.push(b.eventTime);
            closes.push(toIndicatorNumber(b.close));
          }
          if (closes.length >= ELIGIBILITY_LOOKBACK_DAYS) {
            next.set(sym, { timestamps, closes });
          }
        } catch (err) {
          this.log.warn(
            `daily fetch failed for ${sym}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const ranked = rankResidualCohort(next);
      this.lastRefreshMs = this.deps.now();
      if (!ranked) {
        this.members = [];
        this.longs = new Set();
        this.shorts = new Set();
        this.asOfMs = null;
        this.deps.pinState.clear();
        this.log.warn('residual20-volbeta cohort unavailable — EdgePolicy inactive');
        return;
      }

      this.members = ranked.members;
      this.longs = new Set(ranked.longs);
      this.shorts = new Set(ranked.shorts);
      this.asOfMs = epochMs(ranked.decisionTs);
      this.deps.pinState.set([...ranked.longs, ...ranked.shorts]);
      this.log.log?.(
        `residual20-volbeta cohort ready longs=${ranked.longs.join(',')} shorts=${ranked.shorts.join(',')}`,
      );
    } finally {
      /* refreshInFlight cleared by refresh() */
    }
  }
}
