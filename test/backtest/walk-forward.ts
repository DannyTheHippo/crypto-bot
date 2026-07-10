// Walk-forward out-of-sample evaluation — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// A single IS/OOS split can be lucky on one regime. Walk-forward chops the series into several
// chronological OOS segments and requires the candidate to be positive on every one — a far harder
// bar that catches edges which only worked in one window.
//
// Two modes:
//   - anchored: each segment's lead-in is the entire history before it (train grows; warmupStart = 0).
//   - rolling:  each segment's lead-in is a fixed-length trailing window (warmupStart = oosStart − trainBars).
//
// NO LOOKAHEAD: the OOS measurement for a segment uses only bars strictly later than its lead-in. The
// lead-in is fed to the strategy ONLY to build indicator state — its PnL is excluded by the `score`
// closure baselining at series.oosStart (see cv.ts's ScoreFn doc; this module shares that contract).
import Decimal from 'decimal.js';
import type { Bar } from './harness';
import type { BarStrategy } from './strategy';
import type { ScoredSeries, ScoreFn } from './cv';

export type { ScoredSeries, ScoreFn } from './cv';

export type WfMode = 'anchored' | 'rolling';

export interface WfOpts {
  readonly segments?: number; // number of chronological OOS segments (default 4)
  readonly mode?: WfMode; // default 'anchored'
  readonly warmupBars?: number; // lead-in bars before the FIRST OOS segment (>= strategy warmup); default 100
  readonly trainBars?: number; // rolling-mode trailing lead-in length; default = warmupBars
  readonly startingCash?: string; // must match the score closure's baseline; default '5000'
}

export interface WfSegment {
  readonly index: number;
  readonly warmupStart: number; // inclusive index into the full dataset
  readonly oosStart: number; // inclusive — OOS measurement begins here
  readonly oosEnd: number; // exclusive
  readonly oosEquity: string; // score()'s return for this segment
}

export interface WfResult {
  readonly mode: WfMode;
  readonly segments: readonly WfSegment[];
  readonly positiveCount: number;
  readonly allPositive: boolean; // EVERY segment's OOS equity > startingCash — the gate's 4th condition
}

export function walkForward(
  bars: readonly Bar[],
  makeStrategy: () => BarStrategy,
  score: ScoreFn,
  opts: WfOpts = {},
): WfResult {
  const total = bars.length;
  const mode: WfMode = opts.mode ?? 'anchored';
  const warmupBars = Math.max(1, opts.warmupBars ?? 100);
  const trainBars = Math.max(1, opts.trainBars ?? warmupBars);
  const startingCash = new Decimal(opts.startingCash ?? '5000');

  const oosRegion = total - warmupBars;
  let segCount = Math.max(1, opts.segments ?? 4);
  let chunk = Math.floor(oosRegion / segCount);
  if (chunk < 1) {
    segCount = Math.max(1, oosRegion);
    chunk = Math.max(1, Math.floor(oosRegion / segCount));
  }

  const segments: WfSegment[] = [];
  for (let k = 0; k < segCount; k++) {
    const oosStart = warmupBars + k * chunk;
    const oosEnd = k === segCount - 1 ? total : warmupBars + (k + 1) * chunk;
    if (oosStart >= oosEnd) continue;
    const warmupStart = mode === 'anchored' ? 0 : Math.max(0, oosStart - trainBars);

    const series: ScoredSeries = {
      bars: bars.slice(warmupStart, oosEnd),
      oosStart: oosStart - warmupStart,
    };
    const oosEquity = score(makeStrategy(), series);

    segments.push({ index: k, warmupStart, oosStart, oosEnd, oosEquity });
  }

  const positiveCount = segments.filter((s) => new Decimal(s.oosEquity).gt(startingCash)).length;
  return {
    mode,
    segments,
    positiveCount,
    allPositive: segments.length > 0 && positiveCount === segments.length,
  };
}
