// Funding-carry study grid — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Wires carry-sim.ts's pure state machine to real data (7 symbols x L x H x E = 126 cells), the
// chronological 70/30 holdout split, a walk-forward robustness check, and the step-D 4-part gate
// (stats.ts's evaluateGate) deflated over the UNION of this study's 126 trials and the pre-existing
// PRIOR_TRIALS registry (52 SeedEntryStrategy buckets, trial-registry.ts) — N = 178 total.
//
// PRIOR-TRIAL HARVEST: trial-registry.ts's harvest(specs, barsByInterval, feeBps) cross-products EVERY
// spec against EVERY interval in barsByInterval — it does not filter by spec.symbol/spec.interval. A
// single harvest(PRIOR_TRIALS, loadAllBars(...)) call would therefore run each of the 52 specs against
// unrelated symbols/intervals (SOLUSDT's k-grid against BTCUSDT bars, 5m/1m intervals no PRIOR_TRIALS
// entry uses, etc.) rather than reproducing the 52 registered trials. harvestPriorSharpes() below calls
// harvest() once per spec with a single-spec/single-interval map — the correct (spec.symbol,
// spec.interval) pairing — which is the only way to get exactly 52 honestly-paired results out of an
// unmodified harvest(). feeBps = FEE_BPS_VIP0 (10) with the 5bps adverse haircut harvest() hardcodes
// reproduces fill-models.ts's DEFAULT_FILL_CONFIG exactly (10bps taker + 5bps haircut per leg) — the
// same fill economics the original edge-diagnostic report used.
//
// SHARPE HETEROGENEITY (documented, not silent): harvest()'s HarvestedTrial.stats is the FULL-SAMPLE
// Sharpe (every trade, not holdout-only) — that is what the task spec names ("harvest(PRIOR_TRIALS,
// ...) outputs"). This study's own 126 cells contribute HOLDOUT-only Sharpes to the same union. The two
// halves of the N=178 pool are therefore not measured on identical bases; see the report's caveats. V
// is dominated by the 126 carry cells (71% of the pool), so this heterogeneity has limited leverage
// over the deflation benchmark — it matters only if a cell sits near the DSR boundary.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  simulateCarry,
  type Bar,
  type CarryCellParams,
  type CarryEpisode,
  type ExitRule,
  type FundingRow,
} from './carry-sim';
import { sharpeStats, evaluateGate, type SharpeStats, type GateResult } from '../stats';
import { PRIOR_TRIALS, loadBars, harvest, FEE_BPS_VIP0 } from '../trial-registry';
import type { CandleInterval } from '../../../src/domain/venue/types/market-events';
import type { Bar as HarnessBar } from '../harness';

export const SYMBOLS = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'AVAX', 'LINK'] as const;
export const L_GRID = [9, 21, 42] as const; // funding intervals: 3d, 7d, 14d
export const H_GRID = [0.05, 0.08, 0.12] as const; // annualized funding threshold
export const E_GRID: readonly ExitRule[] = ['flip', 'decay'];
export const TRAIN_FRACTION = 0.7;
export const WF_SEGMENTS = 4;
export const GO_MIN_HOLDOUT_EPISODES = 8;

const DATA = join(__dirname, '..', 'data');

export function carryDataPath(symbol: string, kind: 'ohlcv' | 'funding'): string {
  return kind === 'ohlcv'
    ? join(DATA, `ohlcv-${symbol}USDTUSDT-1h.json`)
    : join(DATA, `funding-${symbol}USDTUSDT.json`);
}

// This study's own 7-symbol dataset (ohlcv-<SYM>USDTUSDT-1h.json / funding-<SYM>USDTUSDT.json).
export function carryDataAvailable(): boolean {
  return SYMBOLS.every(
    (s) => existsSync(carryDataPath(s, 'ohlcv')) && existsSync(carryDataPath(s, 'funding')),
  );
}

// PRIOR_TRIALS' UNRELATED legacy data set (ohlcv-<SYMBOL>-<interval>.json, trial-registry.ts's
// loadBars). N=178 is only honest if all 52 are harvested — checked separately from
// carryDataAvailable() so a partial local dataset (carry data present, seed-entry data absent, or vice
// versa) self-skips the WHOLE suite rather than silently computing a deflation benchmark at N<178.
export function priorDataAvailable(): boolean {
  return PRIOR_TRIALS.every((spec) => loadBars(spec.interval, spec.symbol) !== null);
}

export function loadCarryFunding(symbol: string): FundingRow[] {
  return JSON.parse(readFileSync(carryDataPath(symbol, 'funding'), 'utf8')) as FundingRow[];
}

export function loadCarryOhlcv(symbol: string): Bar[] {
  return JSON.parse(readFileSync(carryDataPath(symbol, 'ohlcv'), 'utf8')) as Bar[];
}

export interface CarryCellSpec {
  readonly symbol: string;
  readonly params: CarryCellParams;
}

export function allCells(): CarryCellSpec[] {
  const out: CarryCellSpec[] = [];
  for (const symbol of SYMBOLS) {
    for (const entryLookback of L_GRID) {
      for (const entryThresholdAnnualized of H_GRID) {
        for (const exitRule of E_GRID) {
          out.push({ symbol, params: { entryLookback, entryThresholdAnnualized, exitRule } });
        }
      }
    }
  }
  return out;
}

export function cellLabel(cell: CarryCellSpec): string {
  const hPct = Math.round(cell.params.entryThresholdAnnualized * 100);
  return `${cell.symbol}-L${cell.params.entryLookback}-H${hPct}-${cell.params.exitRule}`;
}

function expectancyBps(returns: readonly number[]): number | null {
  if (returns.length === 0) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return mean * 1e4;
}

function splitEpisodes(episodes: readonly CarryEpisode[]): {
  train: readonly CarryEpisode[];
  holdout: readonly CarryEpisode[];
} {
  // Episodes come out of simulateCarry in chronological entry order already — split by count is a
  // split by OPEN time (the task's stated split key).
  const splitIdx = Math.floor(episodes.length * TRAIN_FRACTION);
  return { train: episodes.slice(0, splitIdx), holdout: episodes.slice(splitIdx) };
}

// Walk-forward robustness check over the FULL per-cell episode series (train+holdout together, NOT
// holdout-only — holdout alone is too thin to sub-segment for most cells). Distinct in purpose from the
// 70/30 split: it asks whether the edge holds up across several chronological windows of the whole
// series, not just in the most recent slice. walk-forward.ts's BarStrategy/ScoreFn machinery does not
// fit a pre-computed episode-return series, so this is a simple anchored equal-count segmentation
// (documented here rather than silently reused where it does not apply). <2 episodes cannot be
// meaningfully segmented — conservatively fails (never throws).
export interface WfCarryResult {
  readonly allPositive: boolean;
  readonly segments: number;
}

export function walkForwardCarry(episodes: readonly CarryEpisode[]): WfCarryResult {
  if (episodes.length < 2) return { allPositive: false, segments: 0 };
  const segCount = Math.min(WF_SEGMENTS, episodes.length);
  const chunk = Math.floor(episodes.length / segCount);
  let allPositive = true;
  let counted = 0;
  for (let k = 0; k < segCount; k++) {
    const start = k * chunk;
    const end = k === segCount - 1 ? episodes.length : start + chunk;
    if (start >= end) continue;
    counted++;
    let sum = 0;
    for (let i = start; i < end; i++) sum += episodes[i]!.netReturn;
    if (!(sum > 0)) allPositive = false;
  }
  return { allPositive: counted > 0 && allPositive, segments: counted };
}

export interface CarryCellResult {
  readonly label: string;
  readonly symbol: string;
  readonly params: CarryCellParams;
  readonly totalEpisodes: number;
  readonly trainEpisodes: number;
  readonly holdoutEpisodes: number;
  readonly trainExpectancyBps: number | null;
  readonly holdoutExpectancyBps: number | null;
  readonly holdoutBasisLowExpectancyBps: number | null;
  readonly holdoutBasisHighExpectancyBps: number | null;
  readonly holdoutStats: SharpeStats;
  readonly wf: WfCarryResult;
}

export function runCell(
  cell: CarryCellSpec,
  funding: readonly FundingRow[],
  ohlcv: readonly Bar[],
): CarryCellResult {
  const episodes = simulateCarry(funding, ohlcv, cell.params);
  const { train, holdout } = splitEpisodes(episodes);
  const holdoutReturns = holdout.map((e) => e.netReturn);
  return {
    label: cellLabel(cell),
    symbol: cell.symbol,
    params: cell.params,
    totalEpisodes: episodes.length,
    trainEpisodes: train.length,
    holdoutEpisodes: holdout.length,
    trainExpectancyBps: expectancyBps(train.map((e) => e.netReturn)),
    holdoutExpectancyBps: expectancyBps(holdoutReturns),
    holdoutBasisLowExpectancyBps: expectancyBps(holdout.map((e) => e.netReturnBasisLow)),
    holdoutBasisHighExpectancyBps: expectancyBps(holdout.map((e) => e.netReturnBasisHigh)),
    holdoutStats: sharpeStats(holdoutReturns),
    wf: walkForwardCarry(episodes),
  };
}

export function evaluateCarryCell(result: CarryCellResult, V: number, N: number): GateResult {
  return evaluateGate({
    stats: result.holdoutStats,
    V,
    N,
    trades: result.holdoutEpisodes,
    wfSegmentsPositive: result.wf.allPositive,
  });
}

export function cellIsGo(result: CarryCellResult, gate: GateResult): boolean {
  return (
    gate.pass &&
    (result.holdoutExpectancyBps ?? -Infinity) > 0 &&
    result.holdoutEpisodes >= GO_MIN_HOLDOUT_EPISODES
  );
}

// See the file header's PRIOR-TRIAL HARVEST note: one harvest() call per spec, single-spec/single-
// interval map, to get the correct (spec.symbol, spec.interval) pairing out of a function that
// otherwise cross-products. Throws loudly (never silently drops) if any of the 52 is unresolvable or
// harvest() does not return exactly one record for it — a partial prior-trial harvest must never
// silently compute the deflation benchmark at N < 178.
export function harvestPriorSharpes(): number[] {
  const out: number[] = [];
  for (const spec of PRIOR_TRIALS) {
    const bars: HarnessBar[] | null = loadBars(spec.interval, spec.symbol);
    if (!bars) {
      throw new Error(
        `carry-study: missing PRIOR_TRIALS data for ${spec.label} (${spec.symbol} ${spec.interval}) — N=178 requires all 52 prior trials`,
      );
    }
    const barsByInterval = new Map<CandleInterval, HarnessBar[]>([[spec.interval, bars]]);
    const harvested = harvest([spec], barsByInterval, FEE_BPS_VIP0);
    if (harvested.length !== 1) {
      throw new Error(
        `carry-study: harvest() returned ${harvested.length} record(s) for ${spec.label}, expected exactly 1`,
      );
    }
    const sr = harvested[0]!.stats.sr;
    if (!Number.isFinite(sr)) {
      throw new Error(`carry-study: non-finite Sharpe for prior trial ${spec.label}`);
    }
    out.push(sr);
  }
  if (out.length !== PRIOR_TRIALS.length) {
    throw new Error(
      `carry-study: harvested ${out.length} prior Sharpes, expected ${PRIOR_TRIALS.length}`,
    );
  }
  return out;
}
