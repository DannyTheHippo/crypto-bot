// Edge-diagnostic bucket scanner — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Runs the full trial-registry.ts PRIOR_TRIALS grid (52 SeedEntryStrategy buckets:
// {BTC,ETH}x{15m,1h,4h,1d}xk{1,1.5,2,3} + {SOL,DOGE,XRP,AVAX,LINK}x15mxk{1,1.5,2,3}) and reports
// train/holdout expectancy + holdout Sharpe per bucket. See reports/loop/edge-diagnostic-2026-07-10.md
// for the method writeup and verdict.
//
// TRAIN/HOLDOUT SPLIT: chronological 70/30 by TIME (not walk-forward). A single full-series backtest
// runs ONE fresh strategy instance start-to-finish (indicators warm up continuously from bar 0 — no
// mid-series cold-start), then each closed round trip is bucketed into train/holdout by whether its
// OPEN time falls before/after the 70% split timestamp. This is safe against lookahead because the
// rule under test has NO fitted parameters (k and maxHoldBars are fixed constants per bucket, not
// estimated from data) — there is nothing for a single continuous run to leak across the split that a
// walk-forward re-run with fresh state would prevent. walk-forward.ts's anchored/rolling machinery
// exists for a DIFFERENT purpose (multiple OOS segments to catch a regime-specific fluke); this study
// uses one 70/30 split per the task's bucket-count budget (52 total backtests, not 52 x segments).
import Decimal from 'decimal.js';
import { runBacktest } from '../harness';
import { PRIOR_TRIALS, loadBars, type TrialSpec } from '../trial-registry';
import {
  sharpeStats,
  deflatedSharpe,
  expectedMaxSharpe,
  expectedMaxZ,
  winsorizedVariance,
  type SharpeStats,
} from '../stats';

const TRAIN_FRACTION = 0.7;
const HOLDOUT_MIN_TRADES = 20;
const HOLDOUT_MIN_DSR = 0.95;

export interface BucketResult {
  readonly label: string;
  readonly symbol: string;
  readonly interval: string;
  readonly kMultiple: number;
  readonly totalBars: number;
  readonly splitBarIndex: number;
  readonly trainTrades: number;
  readonly holdoutTrades: number;
  readonly trainExpectancyBps: number | null;
  readonly holdoutExpectancyBps: number | null;
  readonly holdoutStats: SharpeStats;
}

export interface ScanReport {
  readonly buckets: readonly BucketResult[];
  readonly N: number; // PRIOR_TRIALS.length — the full registered-trial count
  readonly V: number; // cross-bucket variance of holdout per-trade Sharpe
  readonly expectedMaxZ: number; // E[max Z_N] — dimensionless null benchmark
  readonly expectedMaxSharpeNull: number; // sqrt(V) x E[max Z_N] — in this study's SR units
  readonly seams: readonly (BucketResult & { readonly dsr: number })[];
}

function labelToKMultiple(label: string): number {
  const m = /-k([0-9.]+)$/.exec(label);
  if (!m) throw new Error(`cannot parse kMultiple from trial label: ${label}`);
  return Number(m[1]);
}

function tradeReturn(c: {
  readonly realizedPnl: Decimal;
  readonly entryVwap: Decimal | null;
  readonly boughtQty: Decimal;
}): number {
  const denom = c.entryVwap !== null && c.boughtQty.gt(0) ? c.entryVwap.mul(c.boughtQty) : null;
  return denom !== null && denom.gt(0) ? c.realizedPnl.div(denom).toNumber() : 0;
}

function expectancyBps(returns: readonly number[]): number | null {
  if (returns.length === 0) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return mean * 1e4;
}

export function runBucket(spec: TrialSpec): BucketResult | null {
  const bars = loadBars(spec.interval, spec.symbol);
  if (!bars || bars.length === 0) return null;

  const splitBarIndex = Math.floor(bars.length * TRAIN_FRACTION);
  const splitTs = bars[Math.min(splitBarIndex, bars.length - 1)]![0]!;

  const result = runBacktest(bars, spec.make(spec.interval));
  const trainReturns: number[] = [];
  const holdoutReturns: number[] = [];
  for (const c of result.closedRoundTrips) {
    const r = tradeReturn(c);
    if (c.openedAt < splitTs) trainReturns.push(r);
    else holdoutReturns.push(r);
  }

  return {
    label: spec.label,
    symbol: spec.symbol,
    interval: spec.interval,
    kMultiple: labelToKMultiple(spec.label),
    totalBars: bars.length,
    splitBarIndex,
    trainTrades: trainReturns.length,
    holdoutTrades: holdoutReturns.length,
    trainExpectancyBps: expectancyBps(trainReturns),
    holdoutExpectancyBps: expectancyBps(holdoutReturns),
    holdoutStats: sharpeStats(holdoutReturns),
  };
}

export function runEdgeScan(): ScanReport {
  const buckets: BucketResult[] = [];
  for (const spec of PRIOR_TRIALS) {
    const r = runBucket(spec);
    if (r) buckets.push(r);
  }

  const N = PRIOR_TRIALS.length;
  const V = winsorizedVariance(buckets.map((b) => b.holdoutStats.sr));
  const zMax = expectedMaxZ(N);
  const srMaxNull = expectedMaxSharpe(V, N);

  const seams = buckets
    .map((b) => ({ ...b, dsr: deflatedSharpe(b.holdoutStats, V, N) }))
    .filter(
      (b) =>
        (b.holdoutExpectancyBps ?? -Infinity) > 0 &&
        b.holdoutTrades >= HOLDOUT_MIN_TRADES &&
        b.dsr > HOLDOUT_MIN_DSR,
    );

  return { buckets, N, V, expectedMaxZ: zMax, expectedMaxSharpeNull: srMaxNull, seams };
}
