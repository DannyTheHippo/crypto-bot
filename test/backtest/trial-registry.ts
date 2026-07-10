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
import { SeedEntryStrategy, type SeedEntryConfig } from './strategies/seed-entry-strategy';

export const INTERVALS: CandleInterval[] = ['1h', '15m', '5m', '1m'];
export const FEE_BPS_VIP0 = 10; // Binance spot VIP0 taker per side (conservative)
export const FEE_BPS_VIP0_BNB = 7.5; // VIP0 with the 25% BNB discount (no maker rebate at this tier)

const DATA = join(__dirname, 'data');

export interface TrialSpec {
  readonly cls: string; // strategy family
  readonly label: string; // param signature
  // Data-file symbol prefix this trial ran against (e.g. 'BTCUSDT') — the deflation accounting is
  // honest only if every symbol x interval x param combination ever tried is present, not just
  // BTCUSDT; loadBars(interval, symbol) resolves the matching cached series.
  readonly symbol: string;
  // The bucket's own interval — explicit (not just implied by which key of harvest()'s
  // barsByInterval a caller iterates) so a 1:1 bucket study can resolve its single series directly.
  readonly interval: CandleInterval;
  readonly make: (interval: CandleInterval) => () => BarStrategy;
}

// PRIOR_TRIALS: the edge-diagnostic 52-bucket SeedEntryStrategy grid (reports/loop/
// edge-diagnostic-2026-07-10.md) — {BTC,ETH} x {15m,1h,4h,1d} x k{1,1.5,2,3} (32) plus
// {SOL,DOGE,XRP,AVAX,LINK} x 15m x k{1,1.5,2,3} (20). See strategies/seed-entry-strategy.ts for the
// rule; maxHoldBars is fixed at 20 across every bucket (not swept — see the report's method section).
const SEED_ENTRY_MAX_HOLD_BARS = 20;
const SEED_ENTRY_K_GRID = [1, 1.5, 2, 3] as const;
const SEED_ENTRY_MAJORS = ['BTCUSDT', 'ETHUSDT'] as const;
const SEED_ENTRY_MAJOR_INTERVALS: CandleInterval[] = ['15m', '1h', '4h', '1d'];
const SEED_ENTRY_ALTS = ['SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'AVAXUSDT', 'LINKUSDT'] as const;

function makeSeedEntry(kMultiple: number): (interval: CandleInterval) => () => BarStrategy {
  const cfg: SeedEntryConfig = { maxHoldBars: SEED_ENTRY_MAX_HOLD_BARS, kMultiple };
  return () => () => new SeedEntryStrategy(cfg);
}

function seedEntryTrials(): TrialSpec[] {
  const out: TrialSpec[] = [];
  for (const symbol of SEED_ENTRY_MAJORS) {
    for (const interval of SEED_ENTRY_MAJOR_INTERVALS) {
      for (const k of SEED_ENTRY_K_GRID) {
        out.push({
          cls: 'SeedEntryStrategy',
          label: `${symbol}-${interval}-k${k}`,
          symbol,
          interval,
          make: makeSeedEntry(k),
        });
      }
    }
  }
  for (const symbol of SEED_ENTRY_ALTS) {
    for (const k of SEED_ENTRY_K_GRID) {
      out.push({
        cls: 'SeedEntryStrategy',
        label: `${symbol}-15m-k${k}`,
        symbol,
        interval: '15m',
        make: makeSeedEntry(k),
      });
    }
  }
  return out;
}

export const PRIOR_TRIALS: TrialSpec[] = seedEntryTrials();

export function loadBars(interval: CandleInterval, symbol = 'BTCUSDT'): Bar[] | null {
  const extended = join(DATA, `ohlcv-${symbol}-${interval}.json`);
  if (existsSync(extended)) return JSON.parse(readFileSync(extended, 'utf8')) as Bar[];
  const legacy = join(DATA, `${symbol}-${interval}.json`);
  if (!existsSync(legacy)) return null;
  return JSON.parse(readFileSync(legacy, 'utf8')) as Bar[];
}

export function loadAllBars(
  intervals: readonly CandleInterval[] = INTERVALS,
  symbol = 'BTCUSDT',
): Map<CandleInterval, Bar[]> {
  const m = new Map<CandleInterval, Bar[]>();
  for (const iv of intervals) {
    const b = loadBars(iv, symbol);
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
