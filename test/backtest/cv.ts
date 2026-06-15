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
// strategy's lookback, fed only to warm state — PnL excluded via the equity boundary, as walk-forward
// does), and embargoBars trims each fold's tail so the measured windows stay strictly disjoint.
import { slice, runBacktest, type Prepared, type BtOpts, type BtResult } from './harness';
import type { Strategy } from '../../src/domain/strategy/strategy';

export interface CvOpts extends BtOpts {
  readonly folds?: number; // K (default 5)
  readonly purgeBars?: number; // lead-in before each test fold (>= strategy lookback); default 100
  readonly embargoBars?: number; // bars trimmed from each fold's tail for disjointness; default 0
}

export interface CvFold {
  readonly index: number;
  readonly purgeStart: number; // inclusive index into the full dataset (lead-in begins)
  readonly testStart: number; // inclusive — OOS measurement begins here
  readonly testEnd: number; // exclusive (after embargo trim)
  readonly oosPnl: number;
  readonly oosReturnPct: number;
  readonly oosBars: number;
  readonly result: BtResult;
}

export interface CvResult {
  readonly folds: readonly CvFold[];
  readonly positiveCount: number;
  readonly allPositive: boolean;
  readonly meanReturnPct: number;
}

export function purgedKFold(
  prep: Prepared,
  makeStrategy: () => Strategy,
  opts: CvOpts = {},
): CvResult {
  const total = prep.events.length;
  const K = Math.max(2, opts.folds ?? 5);
  const purgeBars = Math.max(1, opts.purgeBars ?? 100);
  const embargoBars = Math.max(0, opts.embargoBars ?? 0);
  const startingCash = opts.startingCash ?? 5000;

  const foldSize = Math.floor(total / K);
  const folds: CvFold[] = [];
  for (let k = 0; k < K; k++) {
    const fStart = k * foldSize;
    const fEnd = k === K - 1 ? total : (k + 1) * foldSize;
    const testStart = fStart;
    const testEnd = Math.max(testStart + 1, fEnd - embargoBars); // trim tail for disjointness
    const purgeStart = Math.max(0, testStart - purgeBars);
    if (testStart >= testEnd) continue;

    const sliced = slice(prep, purgeStart, testEnd);
    const result = runBacktest(sliced, makeStrategy, { ...opts, recordSeries: true });
    const eq = result.equityCurve ?? [];
    const boundaryIdx = testStart - purgeStart;
    const eqBefore = boundaryIdx > 0 ? (eq[boundaryIdx - 1] ?? startingCash) : startingCash;
    const eqEnd = eq.length > 0 ? (eq[eq.length - 1] ?? eqBefore) : eqBefore;
    const oosPnl = eqEnd - eqBefore;

    folds.push({
      index: k,
      purgeStart,
      testStart,
      testEnd,
      oosPnl,
      oosReturnPct: (oosPnl / startingCash) * 100,
      oosBars: testEnd - testStart,
      result,
    });
  }

  const positiveCount = folds.filter((f) => f.oosPnl > 0).length;
  const meanReturnPct =
    folds.length > 0 ? folds.reduce((a, f) => a + f.oosReturnPct, 0) / folds.length : 0;
  return {
    folds,
    positiveCount,
    allPositive: folds.length > 0 && positiveCount === folds.length,
    meanReturnPct,
  };
}
