// Walk-forward out-of-sample evaluation — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// A single 70/30 IS/OOS split (what study.spec / mean-reversion.study do) can be lucky on one regime.
// Walk-forward chops the series into several chronological OOS segments and requires the candidate to
// be POSITIVE on every one — a far harder bar that catches edges which only worked in one window.
//
// Two modes:
//   - anchored: each segment's lead-in is the entire history before it (train grows; warmupStart = 0).
//   - rolling:  each segment's lead-in is a fixed-length trailing window (warmupStart = oosStart − trainBars).
//
// NO LOOKAHEAD: the OOS measurement for a segment uses only bars strictly later than its lead-in. The
// lead-in is fed to the strategy ONLY to build indicator state (EMA seed, rolling z-score window) — its
// PnL is EXCLUDED by baselining the segment's PnL at the equity-curve value just before the OOS bars
// begin. The harness still fills at the next-bar open, so a lead-in bar can never fill on a later price.
import { slice, runBacktest, type Prepared, type BtOpts, type BtResult } from './harness';
import type { Strategy } from '../../src/domain/strategy/strategy';

export type WfMode = 'anchored' | 'rolling';

export interface WfOpts extends BtOpts {
  readonly segments?: number; // number of chronological OOS segments (default 4)
  readonly mode?: WfMode; // default 'anchored'
  readonly warmupBars?: number; // lead-in bars before the FIRST OOS segment (>= strategy warmup); default 100
  readonly trainBars?: number; // rolling-mode trailing lead-in length; default = warmupBars
}

export interface WfSegment {
  readonly index: number;
  readonly warmupStart: number; // inclusive index into the full dataset
  readonly oosStart: number; // inclusive — OOS measurement begins here
  readonly oosEnd: number; // exclusive
  readonly oosPnl: number; // equity(oosEnd-1) − equity(oosStart-1): pure OOS-window equity change
  readonly oosReturnPct: number; // oosPnl / startingCash * 100
  readonly oosBars: number;
  readonly result: BtResult; // full backtest over [warmupStart, oosEnd) — incl. lead-in (informational)
}

export interface WfResult {
  readonly mode: WfMode;
  readonly segments: readonly WfSegment[];
  readonly positiveCount: number;
  readonly allPositive: boolean; // EVERY segment's OOS PnL > 0 — the gate's 4th condition
}

// Drives a fresh strategy per segment over [warmupStart, oosEnd), then derives the OOS-window PnL from
// the recorded equity curve so the lead-in contributes nothing to the segment's verdict.
export function walkForward(
  prep: Prepared,
  makeStrategy: () => Strategy,
  opts: WfOpts = {},
): WfResult {
  const total = prep.events.length;
  const mode: WfMode = opts.mode ?? 'anchored';
  const warmupBars = Math.max(1, opts.warmupBars ?? 100);
  const trainBars = Math.max(1, opts.trainBars ?? warmupBars);
  const startingCash = opts.startingCash ?? 5000;

  // The OOS region is everything after the initial lead-in; split it into `segments` equal chunks.
  const oosRegion = total - warmupBars;
  let segCount = Math.max(1, opts.segments ?? 4);
  let chunk = Math.floor(oosRegion / segCount);
  if (chunk < 1) {
    // Not enough data for the requested split — fall back to as many 1-bar-min segments as fit.
    segCount = Math.max(1, oosRegion);
    chunk = Math.max(1, Math.floor(oosRegion / segCount));
  }

  const segments: WfSegment[] = [];
  for (let k = 0; k < segCount; k++) {
    const oosStart = warmupBars + k * chunk;
    const oosEnd = k === segCount - 1 ? total : warmupBars + (k + 1) * chunk;
    if (oosStart >= oosEnd) continue;
    const warmupStart = mode === 'anchored' ? 0 : Math.max(0, oosStart - trainBars);

    const sliced = slice(prep, warmupStart, oosEnd);
    const result = runBacktest(sliced, makeStrategy, { ...opts, recordSeries: true });
    const eq = result.equityCurve ?? [];
    const boundaryIdx = oosStart - warmupStart; // first OOS bar within the slice
    // Equity just before OOS begins (lead-in fully applied); startingCash if OOS starts at slice head.
    const eqBefore = boundaryIdx > 0 ? (eq[boundaryIdx - 1] ?? startingCash) : startingCash;
    const eqEnd = eq.length > 0 ? (eq[eq.length - 1] ?? eqBefore) : eqBefore;
    const oosPnl = eqEnd - eqBefore;

    segments.push({
      index: k,
      warmupStart,
      oosStart,
      oosEnd,
      oosPnl,
      oosReturnPct: (oosPnl / startingCash) * 100,
      oosBars: oosEnd - oosStart,
      result,
    });
  }

  const positiveCount = segments.filter((s) => s.oosPnl > 0).length;
  return {
    mode,
    segments,
    positiveCount,
    allPositive: segments.length > 0 && positiveCount === segments.length,
  };
}
