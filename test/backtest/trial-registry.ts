// Cumulative trial registry — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// The deflated Sharpe ratio deflates by the TOTAL number of strategy variants ever tried on this data
// (the multiple-testing breadth) and by the variance of their Sharpe ratios. This module is the single
// honest home for that accounting: every closed study's grid + every new candidate battery, as a flat
// list of trial specs. A study harvests all of them, takes N = count and V = variance of the per-trade
// Sharpes, and any candidate must clear the False-Strategy-Theorem benchmark computed from that N/V.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, runBacktest, BT_VENUE, BT_SYMBOL, type Bar, type Prepared } from './harness';
import { sharpeStats, type SharpeStats } from './stats';
import type { CandleInterval } from '../../src/domain/types/market-events';
import { EmaCrossStrategy } from '../../src/domain/strategy/ema-cross.strategy';
import { MeanReversionStrategy } from './mean-reversion.strategy';
import {
  DonchianBreakoutStrategy,
  DualMomentumStrategy,
  VolRegimeTrendStrategy,
  AdxRegimeTrendStrategy,
} from './long-battery.strategies';
import { ShortMeanReversionStrategy, LongShortEmaStrategy } from './short-battery.strategies';
import { strategyId } from './../../src/domain/types/ids';
import type { Strategy } from '../../src/domain/strategy/strategy';

export const INTERVALS: CandleInterval[] = ['1h', '15m', '5m', '1m'];
export const FEE_BPS_VIP0 = 10; // Binance spot VIP0 taker per side (conservative)
export const FEE_BPS_VIP0_BNB = 7.5; // VIP0 with the 25% BNB discount (no maker rebate at this tier)

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');

const common = { symbol: BT_SYMBOL, venue: BT_VENUE, ttlMs: 30_000 };

export interface TrialSpec {
  readonly cls: string; // strategy family
  readonly label: string; // param signature
  readonly make: (interval: CandleInterval) => () => Strategy;
}

// ── Closed study #1: EMA-cross (40 combos × intervals = 160) ──────────────────
const EMA_FASTS = [5, 8, 9, 12, 16, 20, 30];
const EMA_SLOWS = [21, 26, 34, 50, 100, 200];
export const EMA_COMBOS = EMA_FASTS.flatMap((f) =>
  EMA_SLOWS.filter((s) => s > f).map((s) => ({ fast: f, slow: s })),
);
export const EMA_TRIALS: TrialSpec[] = EMA_COMBOS.map((c) => ({
  cls: 'ema',
  label: `${c.fast}/${c.slow}`,
  make: (interval) => () =>
    new EmaCrossStrategy(strategyId('bt'), { ...common, fast: c.fast, slow: c.slow, interval }),
}));

// ── Closed study #2: short-horizon z-score mean-reversion (12 combos × intervals = 48) ─
const MR_LOOKBACKS = [20, 50, 100];
const MR_ENTRY_ZS = [1.0, 1.5, 2.0, 2.5];
export const MR_COMBOS = MR_LOOKBACKS.flatMap((lb) =>
  MR_ENTRY_ZS.map((ez) => ({ lookback: lb, entryZ: ez })),
);
export const MR_TRIALS: TrialSpec[] = MR_COMBOS.map((c) => ({
  cls: 'meanrev',
  label: `${c.lookback}/${c.entryZ.toFixed(1)}`,
  make: (interval) => () =>
    new MeanReversionStrategy(strategyId('bt-mr'), {
      ...common,
      lookback: c.lookback,
      entryZ: c.entryZ,
      exitZ: 0,
      interval,
    }),
}));

// ── Phase 1 battery: pre-registered long candidates (16 combos × intervals = 64) ──────
const DONCHIAN_COMBOS = [
  { entryLookback: 20, exitLookback: 10 },
  { entryLookback: 20, exitLookback: 20 },
  { entryLookback: 55, exitLookback: 10 },
  { entryLookback: 55, exitLookback: 20 },
];
const DUALMOM_COMBOS = [
  { momLookback: 10, trendLen: 50 },
  { momLookback: 10, trendLen: 100 },
  { momLookback: 20, trendLen: 50 },
  { momLookback: 20, trendLen: 100 },
];
const VOLREGIME_COMBOS = [
  { fast: 9, slow: 21, volMaxPct: 2 },
  { fast: 9, slow: 21, volMaxPct: 4 },
  { fast: 20, slow: 50, volMaxPct: 2 },
  { fast: 20, slow: 50, volMaxPct: 4 },
];
const ADXREGIME_COMBOS = [
  { fast: 9, slow: 21, adxMin: 20 },
  { fast: 9, slow: 21, adxMin: 25 },
  { fast: 20, slow: 50, adxMin: 20 },
  { fast: 20, slow: 50, adxMin: 25 },
];

export const BATTERY_TRIALS: TrialSpec[] = [
  ...DONCHIAN_COMBOS.map((c) => ({
    cls: 'donchian',
    label: `${c.entryLookback}/${c.exitLookback}`,
    make: (interval: CandleInterval) => () =>
      new DonchianBreakoutStrategy(strategyId('bt-don'), { ...common, ...c, interval }),
  })),
  ...DUALMOM_COMBOS.map((c) => ({
    cls: 'dualmom',
    label: `mom${c.momLookback}/trend${c.trendLen}`,
    make: (interval: CandleInterval) => () =>
      new DualMomentumStrategy(strategyId('bt-dm'), {
        ...common,
        ...c,
        momThreshold: 0,
        interval,
      }),
  })),
  ...VOLREGIME_COMBOS.map((c) => ({
    cls: 'volregime',
    label: `${c.fast}/${c.slow}/vol${c.volMaxPct}`,
    make: (interval: CandleInterval) => () =>
      new VolRegimeTrendStrategy(strategyId('bt-vr'), {
        ...common,
        ...c,
        volLookback: 20,
        interval,
      }),
  })),
  ...ADXREGIME_COMBOS.map((c) => ({
    cls: 'adxregime',
    label: `${c.fast}/${c.slow}/adx${c.adxMin}`,
    make: (interval: CandleInterval) => () =>
      new AdxRegimeTrendStrategy(strategyId('bt-adx'), {
        ...common,
        ...c,
        adxPeriod: 14,
        interval,
      }),
  })),
];

// ── Phase 3 short / long-short battery (13 combos × intervals = 52) ───────────
const SHORT_MR_COMBOS = [20, 50, 100].flatMap((lb) =>
  [1.5, 2.0, 2.5].map((ez) => ({ lookback: lb, entryZ: ez })),
);
const LONG_SHORT_EMA_COMBOS = [
  { fast: 9, slow: 21 },
  { fast: 20, slow: 50 },
  { fast: 30, slow: 100 },
  { fast: 50, slow: 200 },
];
export const SHORT_TRIALS: TrialSpec[] = [
  ...SHORT_MR_COMBOS.map((c) => ({
    cls: 'short-mr',
    label: `${c.lookback}/${c.entryZ.toFixed(1)}`,
    make: (interval: CandleInterval) => () =>
      new ShortMeanReversionStrategy(strategyId('bt-smr'), {
        ...common,
        ...c,
        exitZ: 0,
        interval,
      }),
  })),
  ...LONG_SHORT_EMA_COMBOS.map((c) => ({
    cls: 'longshort-ema',
    label: `${c.fast}/${c.slow}`,
    make: (interval: CandleInterval) => () =>
      new LongShortEmaStrategy(strategyId('bt-lse'), { ...common, ...c, interval }),
  })),
];

// Prior closed research program (EMA + mean-rev): the trials whose count + SR variance already deflate
// any new candidate. Later phases add BATTERY_TRIALS / SHORT_TRIALS on top.
export const PRIOR_TRIALS: TrialSpec[] = [...EMA_TRIALS, ...MR_TRIALS];

export function loadPrep(interval: CandleInterval): Prepared | null {
  const file = join(DATA, `BTCUSDT-${interval}.json`);
  if (!existsSync(file)) return null;
  return prepare(JSON.parse(readFileSync(file, 'utf8')) as Bar[], interval);
}

export function loadAllPreps(
  intervals: readonly CandleInterval[] = INTERVALS,
): Map<CandleInterval, Prepared> {
  const m = new Map<CandleInterval, Prepared>();
  for (const iv of intervals) {
    const p = loadPrep(iv);
    if (p) m.set(iv, p);
  }
  return m;
}

export interface HarvestedTrial {
  readonly cls: string;
  readonly label: string;
  readonly interval: CandleInterval;
  readonly make: () => Strategy;
  readonly stats: SharpeStats;
  readonly trades: number;
  readonly returnPct: number;
}

// Run every (spec × interval) full-sample backtest at the given fee and return per-trial per-trade
// Sharpe stats — the raw material for V (variance of the SRs) and N (count).
export function harvest(
  specs: readonly TrialSpec[],
  preps: Map<CandleInterval, Prepared>,
  feeBps: number,
): HarvestedTrial[] {
  const out: HarvestedTrial[] = [];
  for (const [interval, prep] of preps) {
    for (const spec of specs) {
      const make = spec.make(interval);
      const r = runBacktest(prep, make, { feeBps, recordSeries: true });
      out.push({
        cls: spec.cls,
        label: spec.label,
        interval,
        make,
        stats: sharpeStats(r.tradeReturns ?? []),
        trades: r.trades,
        returnPct: r.returnPct,
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
