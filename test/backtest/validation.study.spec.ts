import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, runBacktest, BT_VENUE, BT_SYMBOL, type Bar, type Prepared } from './harness';
import { walkForward } from './walk-forward';
import { purgedKFold } from './cv';
import {
  normalCdf,
  normalInv,
  sharpeStats,
  tStat,
  expectedMaxZ,
  expectedMaxSharpe,
  psr,
  deflatedSharpe,
  minBTL,
  evaluateGate,
  type SharpeStats,
} from './stats';
import type { CandleInterval } from '../../src/domain/types/market-events';
import { EmaCrossStrategy } from '../../src/domain/strategy/ema-cross.strategy';
import { MeanReversionStrategy } from './mean-reversion.strategy';
import { strategyId } from '../../src/domain/types/ids';
import type { Strategy } from '../../src/domain/strategy/strategy';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const REPORT = join(HERE, '..', '..', 'reports', 'nightly', 'validation-study.md');

const INTERVALS: CandleInterval[] = ['1h', '15m', '5m', '1m'];
const FEE_BPS = 10; // VIP0 taker per side (conservative; ~20 bps round-trip)

// Re-declare the EXACT grids from study.spec.ts (40 EMA combos) and mean-reversion.study.spec.ts
// (12 mean-rev combos). These are the closed studies whose 160 + 48 = 208 trials seed the deflated-
// Sharpe selection penalty V/N. Hardcoded (not imported) because the studies keep them module-local.
const EMA_FASTS = [5, 8, 9, 12, 16, 20, 30];
const EMA_SLOWS = [21, 26, 34, 50, 100, 200];
const EMA_COMBOS = EMA_FASTS.flatMap((f) =>
  EMA_SLOWS.filter((s) => s > f).map((s) => ({ fast: f, slow: s })),
);
const MR_LOOKBACKS = [20, 50, 100];
const MR_ENTRY_ZS = [1.0, 1.5, 2.0, 2.5];
const MR_EXIT_Z = 0;
const MR_COMBOS = MR_LOOKBACKS.flatMap((lb) =>
  MR_ENTRY_ZS.map((ez) => ({ lookback: lb, entryZ: ez })),
);

const makeEma =
  (fast: number, slow: number, interval: CandleInterval): (() => Strategy) =>
  () =>
    new EmaCrossStrategy(strategyId('bt'), {
      fast,
      slow,
      symbol: BT_SYMBOL,
      venue: BT_VENUE,
      ttlMs: 30_000,
      interval,
    });

const makeMr =
  (lookback: number, entryZ: number, interval: CandleInterval): (() => Strategy) =>
  () =>
    new MeanReversionStrategy(strategyId('bt-mr'), {
      lookback,
      entryZ,
      exitZ: MR_EXIT_Z,
      symbol: BT_SYMBOL,
      venue: BT_VENUE,
      ttlMs: 30_000,
      interval,
    });

// ─────────────────────────────────────────────────────────────────────────────
// stats.ts validated against KNOWN closed-form inputs. The deflated-Sharpe formula is subtle, so
// every estimator is pinned to a value computable by hand / from a textbook normal table.
// ─────────────────────────────────────────────────────────────────────────────
describe('validation stats — known inputs', () => {
  it('normalCdf matches the standard normal table', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959963985)).toBeCloseTo(0.975, 4); // the 97.5th percentile
    expect(normalCdf(-1.959963985)).toBeCloseTo(0.025, 4);
    expect(normalCdf(2.326347874)).toBeCloseTo(0.99, 4); // the 99th percentile
    expect(normalCdf(100)).toBeCloseTo(1, 6);
    expect(normalCdf(-100)).toBeCloseTo(0, 6);
  });

  it('normalInv inverts normalCdf and matches known quantiles', () => {
    expect(normalInv(0.5)).toBeCloseTo(0, 6);
    expect(normalInv(0.975)).toBeCloseTo(1.959963985, 4);
    expect(normalInv(0.025)).toBeCloseTo(-1.959963985, 4);
    expect(normalInv(0.99)).toBeCloseTo(2.326347874, 4);
    // round-trip through the CDF
    for (const p of [0.01, 0.1, 0.3, 0.6, 0.9, 0.995]) {
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 4);
    }
  });

  it('sharpeStats computes mean/std/sr/skew/kurt on a hand-checked series', () => {
    // [1,2,3,4,5]: mean 3, population var 2 (std √2), sr 3/√2, skew 0 (symmetric), kurt 6.8/4 = 1.7
    const s = sharpeStats([1, 2, 3, 4, 5]);
    expect(s.n).toBe(5);
    expect(s.mean).toBeCloseTo(3, 10);
    expect(s.std).toBeCloseTo(Math.SQRT2, 10);
    expect(s.sr).toBeCloseTo(3 / Math.SQRT2, 10);
    expect(s.skew).toBeCloseTo(0, 10);
    expect(s.kurt).toBeCloseTo(1.7, 10);
    expect(tStat(s)).toBeCloseTo((3 / Math.SQRT2) * Math.sqrt(5), 10);
  });

  it('expectedMaxZ grows with the number of trials and is positive', () => {
    expect(expectedMaxZ(2)).toBeGreaterThan(0);
    expect(expectedMaxZ(10)).toBeGreaterThan(expectedMaxZ(2));
    expect(expectedMaxZ(100)).toBeGreaterThan(expectedMaxZ(10));
    expect(expectedMaxZ(1000)).toBeGreaterThan(expectedMaxZ(100));
    // N=208 (this research program) ≈ 2.78 (hand-computed from the table)
    expect(expectedMaxZ(208)).toBeCloseTo(2.78, 1);
    // √V scaling
    expect(expectedMaxSharpe(0.04, 208)).toBeCloseTo(0.2 * expectedMaxZ(208), 10);
  });

  it('psr is 0.5 at the observed SR and monotonic in the benchmark', () => {
    const s = sharpeStats([0.01, -0.005, 0.02, 0.0, 0.015, -0.01, 0.03, 0.005]);
    expect(psr(s, s.sr)).toBeCloseTo(0.5, 6); // benchmark = observed ⇒ even odds (A&S erf ~1e-9 at x=0)
    expect(psr(s, s.sr - 0.5)).toBeGreaterThan(psr(s, s.sr)); // easier benchmark ⇒ higher PSR
    expect(psr(s, s.sr + 0.5)).toBeLessThan(psr(s, s.sr));
    const d = deflatedSharpe(s, 0.04, 208);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
  });

  it('psr FAILS CLOSED when the variance term leaves its domain (no false ACCEPT)', () => {
    // High SR + strong positive skew drives 1 − skew·SR + ((kurt−1)/4)·SR² negative — the exact overfit
    // profile the gate must reject. A clamped denominator would explode the z-arg to PSR→1 (false accept);
    // fail-closed must return 0 so DSR stays < 0.95.
    const degenerate: SharpeStats = { n: 200, mean: 0.6, std: 1, sr: 0.6, skew: 3, kurt: 3 };
    expect(1 - 3 * 0.6 + ((3 - 1) / 4) * 0.6 * 0.6).toBeLessThan(0); // variance term is indeed negative
    expect(psr(degenerate, 0.4)).toBe(0); // refuses to certify, not PSR→1
    expect(deflatedSharpe(degenerate, 0.001, 5)).toBe(0);
  });

  it('minBTL shrinks as the edge grows and is infinite for a non-positive SR', () => {
    expect(minBTL(208, 0.5)).toBeLessThan(minBTL(208, 0.25));
    expect(Number.isFinite(minBTL(208, 0.5))).toBe(true);
    expect(minBTL(208, 0)).toBe(Infinity);
    expect(minBTL(208, -0.1)).toBe(Infinity);
  });

  it('evaluateGate PASSES a clean strong synthetic edge and FAILS a zero-edge one', () => {
    // Strong edge: 200 trades, per-trade SR = 3 (mean 0.015 / std 0.005), tiny selection (V small, N small).
    const strong: number[] = [];
    for (let i = 0; i < 200; i++) strong.push(i % 2 === 0 ? 0.02 : 0.01);
    const win = evaluateGate({
      stats: sharpeStats(strong),
      V: 0.001,
      N: 10,
      trades: strong.length,
      wfSegmentsPositive: true,
    });
    expect(win.pass).toBe(true);
    expect(win.tStatPass).toBe(true);
    expect(win.dsrPass).toBe(true);
    expect(win.lengthPass).toBe(true);

    // Zero edge: symmetric around 0 ⇒ SR ≈ 0 ⇒ every condition fails.
    const flat: number[] = [];
    for (let i = 0; i < 200; i++) flat.push(i % 2 === 0 ? 0.01 : -0.01);
    const lose = evaluateGate({
      stats: sharpeStats(flat),
      V: 0.04,
      N: 208,
      trades: flat.length,
      wfSegmentsPositive: true,
    });
    expect(lose.pass).toBe(false);
    expect(lose.tStatPass).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// walk-forward and purged K-fold structural invariants on a deterministic synthetic series (no
// data-file dependency): segment geometry, lead-in exclusion, and disjointness.
// ─────────────────────────────────────────────────────────────────────────────
describe('walk-forward & cross-validation tooling', () => {
  // Deterministic trending+oscillating series so the EMA strategy actually trades across segments.
  const syntheticBars = (): Bar[] => {
    const bars: Bar[] = [];
    for (let i = 0; i < 1200; i++) {
      const c = 100 + i * 0.05 + 10 * Math.sin(i / 15); // drift + cycles
      bars.push([i * 3_600_000, c, c + 0.5, c - 0.5, c, 1]);
    }
    return bars;
  };
  const prep = prepare(syntheticBars(), '1h');
  const make = makeEma(9, 21, '1h');

  it('anchored walk-forward: contiguous non-overlapping OOS segments, full lead-in', () => {
    const wf = walkForward(prep, make, {
      feeBps: FEE_BPS,
      segments: 4,
      mode: 'anchored',
      warmupBars: 50,
    });
    expect(wf.segments.length).toBe(4);
    expect(wf.mode).toBe('anchored');
    for (let k = 0; k < wf.segments.length; k++) {
      const s = wf.segments[k]!;
      expect(s.warmupStart).toBe(0); // anchored ⇒ lead-in is the entire prior history
      expect(s.oosEnd).toBeGreaterThan(s.oosStart);
      expect(Number.isFinite(s.oosPnl)).toBe(true);
      if (k > 0) expect(s.oosStart).toBe(wf.segments[k - 1]!.oosEnd); // contiguous, no gaps/overlaps
    }
    expect(wf.segments[0]!.oosStart).toBe(50); // OOS begins right after the warmup lead-in
    expect(wf.allPositive).toBe(wf.positiveCount === wf.segments.length);
  });

  it('rolling walk-forward: each segment uses a fixed trailing lead-in', () => {
    const wf = walkForward(prep, make, {
      feeBps: FEE_BPS,
      segments: 3,
      mode: 'rolling',
      warmupBars: 50,
      trainBars: 80,
    });
    expect(wf.mode).toBe('rolling');
    for (const s of wf.segments) {
      // rolling lead-in is min(trainBars, history-before-OOS) bars before the OOS start
      expect(s.warmupStart).toBe(Math.max(0, s.oosStart - 80));
    }
  });

  it('purged K-fold: K disjoint test windows with a finite mean return', () => {
    const cv = purgedKFold(prep, make, {
      feeBps: FEE_BPS,
      folds: 5,
      purgeBars: 50,
      embargoBars: 5,
    });
    expect(cv.folds.length).toBe(5);
    for (let k = 0; k < cv.folds.length; k++) {
      const f = cv.folds[k]!;
      expect(f.testEnd).toBeGreaterThan(f.testStart);
      expect(f.purgeStart).toBeLessThanOrEqual(f.testStart);
      expect(Number.isFinite(f.oosReturnPct)).toBe(true);
      if (k > 0) expect(f.testStart).toBeGreaterThanOrEqual(cv.folds[k - 1]!.testEnd); // disjoint (embargo gap)
    }
    expect(Number.isFinite(cv.meanReturnPct)).toBe(true);
    expect(cv.allPositive).toBe(cv.positiveCount === cv.folds.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The step-D study: harvest V from all 208 closed trials, then confirm the best EMA and the best
// mean-reversion candidate BOTH still FAIL the 4-part gate (agreement with the two prior closures).
// ─────────────────────────────────────────────────────────────────────────────
interface Trial {
  cls: 'ema' | 'meanrev';
  label: string;
  interval: CandleInterval;
  make: () => Strategy;
  stats: SharpeStats;
  trades: number;
}

function loadPrep(interval: CandleInterval): Prepared | null {
  const file = join(DATA, `BTCUSDT-${interval}.json`);
  if (!existsSync(file)) return null;
  const bars = JSON.parse(readFileSync(file, 'utf8')) as Bar[];
  return prepare(bars, interval);
}

function fullSampleStats(
  prep: Prepared,
  make: () => Strategy,
): { stats: SharpeStats; trades: number } {
  const r = runBacktest(prep, make, { feeBps: FEE_BPS, recordSeries: true });
  return { stats: sharpeStats(r.tradeReturns ?? []), trades: r.trades };
}

function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1); // sample variance of the trial SRs
}

function fmt(n: number, d = 3): string {
  if (!Number.isFinite(n)) return n > 0 ? '+∞' : '−∞';
  return (n >= 0 ? '+' : '') + n.toFixed(d);
}

describe('step-D validation study (real Binance BTC/USDT)', () => {
  it('harvests V across all 208 trials and confirms EMA + mean-rev FAIL the 4-part gate', () => {
    const preps = new Map<CandleInterval, Prepared>();
    for (const iv of INTERVALS) {
      const p = loadPrep(iv);
      if (p) preps.set(iv, p);
    }
    expect(preps.size).toBeGreaterThan(0);

    // Harvest every trial's full-sample per-trade Sharpe (the SR distribution feeding V).
    const trials: Trial[] = [];
    for (const [iv, prep] of preps) {
      for (const c of EMA_COMBOS) {
        const make = makeEma(c.fast, c.slow, iv);
        const { stats, trades } = fullSampleStats(prep, make);
        trials.push({
          cls: 'ema',
          label: `${c.fast}/${c.slow}`,
          interval: iv,
          make,
          stats,
          trades,
        });
      }
      for (const c of MR_COMBOS) {
        const make = makeMr(c.lookback, c.entryZ, iv);
        const { stats, trades } = fullSampleStats(prep, make);
        trials.push({
          cls: 'meanrev',
          label: `${c.lookback}/${c.entryZ.toFixed(1)}`,
          interval: iv,
          make,
          stats,
          trades,
        });
      }
    }

    const srs = trials.map((t) => t.stats.sr);
    const N = trials.length; // total trial count = the multiple-testing breadth
    const V = variance(srs); // cross-trial SR variance
    const sr0 = expectedMaxSharpe(V, N); // False-Strategy-Theorem benchmark

    // Best candidate per class = the one with the highest per-trade SR (the trial most likely to pass).
    // Selecting the in-sample best and THEN deflating by N is exactly what the DSR corrects for.
    const bestOf = (cls: 'ema' | 'meanrev'): Trial =>
      trials
        .filter((t) => t.cls === cls && t.trades >= 2)
        .sort((a, b) => b.stats.sr - a.stats.sr)[0] ??
      trials.filter((t) => t.cls === cls).sort((a, b) => b.stats.sr - a.stats.sr)[0]!;

    const evaluate = (t: Trial) => {
      const prep = preps.get(t.interval)!;
      const wf = walkForward(prep, t.make, {
        feeBps: FEE_BPS,
        segments: 4,
        mode: 'anchored',
        warmupBars: 200, // >= the largest lookback (slow 200 / lookback 100) so every segment is warmed
      });
      const gate = evaluateGate({
        stats: t.stats,
        V,
        N,
        trades: t.trades,
        wfSegmentsPositive: wf.allPositive,
      });
      return { gate, wf };
    };

    const bestEma = bestOf('ema');
    const bestMr = bestOf('meanrev');
    const emaEval = evaluate(bestEma);
    const mrEval = evaluate(bestMr);

    // ── Report ────────────────────────────────────────────────────────────────
    const lines: string[] = [];
    lines.push('# Step-D validation study — 2026-06-15');
    lines.push('');
    lines.push(
      `The validation harness that certifies a "winner": **deflated Sharpe (DSR)**, **t-statistic**, ` +
        `**MinBTL**, and **walk-forward**. Per-trade-return convention (no annualization across the four ` +
        `heterogeneous intervals). Real Binance BTC/USDT OHLCV, fee ${FEE_BPS} bps/side (VIP0 taker). ` +
        `Formulas per Bailey & López de Prado (2012, 2014) — see test/backtest/stats.ts.`,
    );
    lines.push('');
    lines.push('## The 4-part gate (ALL must hold for a validated winner)');
    lines.push('');
    lines.push('1. **t-stat > 3.0** — mean per-trade return robustly non-zero.');
    lines.push(
      '2. **DSR > 0.95** — Sharpe significant AFTER multiple-testing deflation across the program.',
    );
    lines.push('3. **trades ≥ MinBTL** — sample long enough for the claimed Sharpe.');
    lines.push(
      '4. **Walk-forward OOS positive in EVERY segment** (4 anchored segments, lead-in excluded).',
    );
    lines.push('');
    lines.push('## Selection penalty (harvested from the closed studies)');
    lines.push('');
    lines.push(
      `- **N = ${N} trials** (EMA ${EMA_COMBOS.length}×${preps.size} + mean-rev ${MR_COMBOS.length}×${preps.size}) — ` +
        `the full multiple-testing breadth of the research program so far.`,
    );
    lines.push(
      `- **V = ${V.toExponential(3)}** — variance of the ${N} trial per-trade Sharpe ratios.`,
    );
    lines.push(
      `- **E[max Sharpe of N] = ${fmt(sr0)}** = √V · E[maxZ_${N}] (E[maxZ]=${fmt(expectedMaxZ(N), 3)}). ` +
        `Any single candidate must beat this benchmark just to not be the luckiest of ${N} coin-flips.`,
    );
    lines.push('');
    lines.push(
      `> **Caveats (honest framing).** (a) V pools per-trade Sharpes across 4 candle intervals × 2 ` +
        `strategy classes whose trade counts differ by ~10× — the False Strategy Theorem assumes ` +
        `comparable draws, so this V is an approximation; the direction is CONSERVATIVE (more dispersion ` +
        `⇒ higher benchmark ⇒ harder to pass), so it cannot manufacture the FAIL verdict. (b) With ` +
        `trades = n, condition 1 (t>3.0) strictly implies condition 3 (trades ≥ MinBTL) at N=${N} ` +
        `(E[maxZ]=${fmt(expectedMaxZ(N), 2)} < 3.0), so MinBTL adds no rejection power here — it is kept ` +
        `because the relation flips once N grows enough that E[maxZ] > 3.0.`,
    );
    lines.push('');

    const section = (
      title: string,
      t: Trial,
      ev: { gate: ReturnType<typeof evaluateGate>; wf: ReturnType<typeof walkForward> },
    ) => {
      const g = ev.gate;
      lines.push(`## ${title}: best candidate ${t.label} @ ${t.interval}`);
      lines.push('');
      lines.push(
        `- per-trade SR ${fmt(t.stats.sr)} · trades ${t.trades} · skew ${fmt(t.stats.skew, 2)} · kurt ${fmt(t.stats.kurt, 2)}`,
      );
      lines.push(`- **t-stat ${fmt(g.tStat, 2)}** (>3.0? ${g.tStatPass ? '✅' : '❌'})`);
      lines.push(`- **DSR ${fmt(g.dsr, 4)}** (>0.95? ${g.dsrPass ? '✅' : '❌'})`);
      lines.push(
        `- **MinBTL ${fmt(g.minBTL, 1)} trades** vs ${t.trades} realized (≥? ${g.lengthPass ? '✅' : '❌'})`,
      );
      lines.push(
        `- **Walk-forward** ${ev.wf.positiveCount}/${ev.wf.segments.length} segments positive ` +
          `[${ev.wf.segments.map((s) => fmt(s.oosReturnPct, 1)).join(', ')}]% (all positive? ${g.wfPass ? '✅' : '❌'})`,
      );
      lines.push(`- **VERDICT: ${g.pass ? '🟢 PASS (validated winner)' : '🔴 FAIL'}**`);
      lines.push('');
    };

    section('EMA-cross', bestEma, emaEval);
    section('Mean-reversion', bestMr, mrEval);

    lines.push('## Verdict');
    const bothFail = !emaEval.gate.pass && !mrEval.gate.pass;
    lines.push(
      bothFail
        ? `Both the best EMA-cross and the best mean-reversion candidate **FAIL** the step-D gate — in full ` +
            `agreement with the two prior closures (160-config EMA + 48-config mean-rev). The validation ` +
            `tooling is calibrated: it rejects the strategies already known to be edgeless, while a clean ` +
            `synthetic edge passes the unit-test gate. No candidate from the closed studies is a winner.`
        : `UNEXPECTED: a closed-study candidate passed the step-D gate — re-audit before trusting (this ` +
            `contradicts the two prior closures and most likely indicates a tooling defect).`,
    );

    writeFileSync(REPORT, lines.join('\n') + '\n');
    console.log('\n===== STEP-D VALIDATION STUDY =====');
    console.log(`N=${N} V=${V.toExponential(3)} E[maxSharpe]=${fmt(sr0)}`);
    console.log(
      `EMA best ${bestEma.label}@${bestEma.interval}: t=${fmt(emaEval.gate.tStat, 2)} DSR=${fmt(emaEval.gate.dsr, 3)} PASS=${emaEval.gate.pass}`,
    );
    console.log(
      `MR  best ${bestMr.label}@${bestMr.interval}: t=${fmt(mrEval.gate.tStat, 2)} DSR=${fmt(mrEval.gate.dsr, 3)} PASS=${mrEval.gate.pass}`,
    );
    console.log('===================================\n');

    // The whole point: the certifier must AGREE with the prior closures.
    expect(N).toBe((EMA_COMBOS.length + MR_COMBOS.length) * preps.size);
    expect(emaEval.gate.pass).toBe(false);
    expect(mrEval.gate.pass).toBe(false);
  }, 600_000);
});
