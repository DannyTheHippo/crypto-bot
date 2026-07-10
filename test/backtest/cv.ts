// Purged + embargoed K-fold cross-validation — OPTIONAL RESEARCH TOOLING (test/backtest/, off gate).
//
// Complements walk-forward: instead of contiguous chronological segments, it carves the series into K
// disjoint test folds and reports the distribution of per-fold OOS returns (how many folds are
// positive, the mean fold return). A robust edge should be positive across MOST folds, not just the
// chronological tail.
//
// PURGE / EMBARGO (López de Prado, "Advances in Financial ML", ch. 7): with a fitted model the purge
// removes training rows whose labels overlap the test window and the embargo drops rows just after it.
// Here every fold runs a FRESH strategy with FIXED params (no per-fold fitting), so cross-fold label
// leakage is structurally impossible; purgeBars instead serves as the indicator lead-in (≥ the
// strategy's lookback, fed only to warm state), and embargoBars trims each fold's tail so the measured
// windows stay strictly disjoint.
//
// RE-FIT (rebuild): the old cv.ts scored a fold via harness.ts's Prepared/runBacktest directly, coupled
// to the retired Strategy port. This version decouples the fold/purge/embargo bookkeeping (kept
// near-as-is) from scoring: the caller supplies a `score` closure — (strategy, series) => OOS-only
// equity, as a decimal string, already baselined at series.oosStart so any lead-in PnL is excluded (the
// caller typically wraps harness.runBacktest and reads its equityCurve at the oosStart boundary, same
// derivation the pre-rebuild version did inline). `startingCash` here is used ONLY to classify a fold's
// oosEquity as positive/negative and MUST match whatever baseline the score closure used.
import Decimal from 'decimal.js';
import type { Bar } from './harness';
import type { BarStrategy } from './strategy';

export interface ScoredSeries {
  readonly bars: readonly Bar[]; // purge lead-in + OOS bars, chronological
  readonly oosStart: number; // index into `bars` where OOS measurement begins
}
export type ScoreFn = (strategy: BarStrategy, series: ScoredSeries) => string;

export interface CvOpts {
  readonly folds?: number; // K (default 5)
  readonly purgeBars?: number; // lead-in before each test fold (>= strategy lookback); default 100
  readonly embargoBars?: number; // bars trimmed from each fold's tail for disjointness; default 0
  readonly startingCash?: string; // must match the score closure's baseline; default '5000'
}

export interface CvFold {
  readonly index: number;
  readonly purgeStart: number; // inclusive index into the full dataset (lead-in begins)
  readonly testStart: number; // inclusive — OOS measurement begins here
  readonly testEnd: number; // exclusive (after embargo trim)
  readonly oosEquity: string; // score()'s return for this fold
}

export interface CvResult {
  readonly folds: readonly CvFold[];
  readonly positiveCount: number;
  readonly allPositive: boolean;
}

export function purgedKFold(
  bars: readonly Bar[],
  makeStrategy: () => BarStrategy,
  score: ScoreFn,
  opts: CvOpts = {},
): CvResult {
  const total = bars.length;
  const K = Math.max(2, opts.folds ?? 5);
  const purgeBars = Math.max(1, opts.purgeBars ?? 100);
  const embargoBars = Math.max(0, opts.embargoBars ?? 0);
  const startingCash = new Decimal(opts.startingCash ?? '5000');

  const foldSize = Math.floor(total / K);
  const folds: CvFold[] = [];
  for (let k = 0; k < K; k++) {
    const fStart = k * foldSize;
    const fEnd = k === K - 1 ? total : (k + 1) * foldSize;
    const testStart = fStart;
    const testEnd = Math.max(testStart + 1, fEnd - embargoBars); // trim tail for disjointness
    const purgeStart = Math.max(0, testStart - purgeBars);
    if (testStart >= testEnd) continue;

    const series: ScoredSeries = {
      bars: bars.slice(purgeStart, testEnd),
      oosStart: testStart - purgeStart,
    };
    const oosEquity = score(makeStrategy(), series);

    folds.push({ index: k, purgeStart, testStart, testEnd, oosEquity });
  }

  const positiveCount = folds.filter((f) => new Decimal(f.oosEquity).gt(startingCash)).length;
  return {
    folds,
    positiveCount,
    allPositive: folds.length > 0 && positiveCount === folds.length,
  };
}
