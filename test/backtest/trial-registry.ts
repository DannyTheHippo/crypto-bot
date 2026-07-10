// Cumulative trial registry — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// The deflated Sharpe ratio deflates by the TOTAL number of strategy variants ever tried on this data
// (the multiple-testing breadth) and by the variance of their Sharpe ratios. This module is the single
// honest home for that accounting: every closed study's grid + every new candidate battery, as a flat
// list of trial specs. A study harvests all of them, takes N = count and V = variance of the per-trade
// Sharpes, and any candidate must clear the False-Strategy-Theorem benchmark computed from that N/V.
//
// RE-FIT (rebuild): the prior EMA-cross / mean-reversion / long-battery / short-battery TrialSpec
// arrays (EMA_TRIALS, MR_TRIALS, BATTERY_TRIALS, SHORT_TRIALS, PRIOR_TRIALS) depended directly on the
// concrete strategy classes retired with src/domain/strategy/* (owner decision 2026-07-03) — they are
// NOT recovered (see the rebuild plan's explicit exclusion list). Only the pure bookkeeping
// (TrialSpec shape, loadBars/loadAllBars, harvest, variance) survives, re-typed against BarStrategy.
// PRIOR_TRIALS starts EMPTY: any new BarStrategy family MUST append its full parameter grid here
// before a candidate from that family is deflated-Sharpe-gated — the gate is only honest if N counts
// every combination ever tried, not just the survivors.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runBacktest, type Bar } from './harness';
import type { SharpeStats } from './stats';
import type { CandleInterval } from '../../src/domain/types/market-events';
import type { BarStrategy } from './strategy';

export const INTERVALS: CandleInterval[] = ['1h', '15m', '5m', '1m'];
export const FEE_BPS_VIP0 = 10; // Binance spot VIP0 taker per side (conservative)
export const FEE_BPS_VIP0_BNB = 7.5; // VIP0 with the 25% BNB discount (no maker rebate at this tier)

const DATA = join(__dirname, 'data');

export interface TrialSpec {
  readonly cls: string; // strategy family
  readonly label: string; // param signature
  readonly make: (interval: CandleInterval) => () => BarStrategy;
}

export const PRIOR_TRIALS: TrialSpec[] = [];

export function loadBars(interval: CandleInterval): Bar[] | null {
  const file = join(DATA, `BTCUSDT-${interval}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as Bar[];
}

export function loadAllBars(
  intervals: readonly CandleInterval[] = INTERVALS,
): Map<CandleInterval, Bar[]> {
  const m = new Map<CandleInterval, Bar[]>();
  for (const iv of intervals) {
    const b = loadBars(iv);
    if (b) m.set(iv, b);
  }
  return m;
}

export interface HarvestedTrial {
  readonly cls: string;
  readonly label: string;
  readonly interval: CandleInterval;
  readonly stats: SharpeStats;
  readonly trades: number;
}

// Runs every (spec × interval) full-sample backtest at the given fee and returns per-trial per-trade
// Sharpe stats — the raw material for V (variance of the SRs) and N (count).
export function harvest(
  specs: readonly TrialSpec[],
  barsByInterval: Map<CandleInterval, Bar[]>,
  feeBps: number,
): HarvestedTrial[] {
  const out: HarvestedTrial[] = [];
  for (const [interval, bars] of barsByInterval) {
    for (const spec of specs) {
      const make = spec.make(interval);
      const r = runBacktest(bars, make, {
        fill: { takerFeeBps: String(feeBps), adverseHaircutBps: '5' },
      });
      out.push({
        cls: spec.cls,
        label: spec.label,
        interval,
        stats: r.stats,
        trades: r.closedRoundTrips.length,
      });
    }
  }
  return out;
}

export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
}
