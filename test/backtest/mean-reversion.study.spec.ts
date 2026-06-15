import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, slice, runBacktest, BT_VENUE, BT_SYMBOL, type Bar, type BtResult } from './harness';
import type { CandleInterval } from '../../src/domain/types/market-events';
import { MeanReversionStrategy } from './mean-reversion.strategy';
import { strategyId } from '../../src/domain/types/ids';
import type { Strategy } from '../../src/domain/strategy/strategy';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const REPORT = join(HERE, '..', '..', 'reports', 'nightly', 'meanrev-study.md');

// Pre-registered grid (declared BEFORE seeing results — no post-hoc expansion). exitZ fixed at 0
// (revert to mean) — the canonical mean-reversion exit, NOT a tuned knob — to keep the trial count
// small and the deflated-Sharpe penalty honest.
const LOOKBACKS = [20, 50, 100];
const ENTRY_ZS = [1.0, 1.5, 2.0, 2.5];
const EXIT_Z = 0;
const COMBOS = LOOKBACKS.flatMap((lb) => ENTRY_ZS.map((ez) => ({ lookback: lb, entryZ: ez })));
const INTERVALS: CandleInterval[] = ['1h', '15m', '5m', '1m'];
const OOS_FRACTION = 0.3; // last 30% out-of-sample; first 70% in-sample (same split as the EMA study)
const FEE_BPS = 10; // taker per side (conservative); round-trip ~20 bps

// Trial accounting carried forward across the WHOLE research program (deflated Sharpe / multiple-
// testing correction is cumulative). EMA study = 160 (40 combos x 4 intervals). This study adds
// COMBOS.length x INTERVALS.length variants.
const N_PRIOR_EMA = 160;

const makeMr = (lookback: number, entryZ: number, interval: CandleInterval): (() => Strategy) =>
  () => new MeanReversionStrategy(strategyId('bt-mr'), {
    lookback, entryZ, exitZ: EXIT_Z, symbol: BT_SYMBOL, venue: BT_VENUE, ttlMs: 30_000, interval,
  });

interface Row { lookback: number; entryZ: number; is: BtResult; oos: BtResult; }

function studyInterval(interval: CandleInterval): { rows: Row[]; isBH: number; oosBH: number; bars: number; isN: number; oosN: number; posBoth0: number } | null {
  const file = join(DATA, `BTCUSDT-${interval}.json`);
  if (!existsSync(file)) return null;
  const bars = JSON.parse(readFileSync(file, 'utf8')) as Bar[];
  const prep = prepare(bars, interval);
  const splitAt = Math.floor(bars.length * (1 - OOS_FRACTION));
  const isP = slice(prep, 0, splitAt);
  const oosP = slice(prep, splitAt, bars.length);
  const rows: Row[] = COMBOS.map((c) => ({
    lookback: c.lookback, entryZ: c.entryZ,
    is: runBacktest(isP, makeMr(c.lookback, c.entryZ, interval), { feeBps: FEE_BPS }),
    oos: runBacktest(oosP, makeMr(c.lookback, c.entryZ, interval), { feeBps: FEE_BPS }),
  }));
  // Decisive robustness check (same as the EMA study): re-run at ZERO fees. If nothing is positive
  // in BOTH IS and OOS even with no transaction cost, the no-edge verdict is the strategy, not costs.
  const posBoth0 = COMBOS.filter((c) =>
    runBacktest(isP, makeMr(c.lookback, c.entryZ, interval), { feeBps: 0 }).returnPct > 0 &&
    runBacktest(oosP, makeMr(c.lookback, c.entryZ, interval), { feeBps: 0 }).returnPct > 0,
  ).length;
  return {
    rows,
    isBH: rows[0]?.is.buyHoldPct ?? 0,
    oosBH: rows[0]?.oos.buyHoldPct ?? 0,
    bars: bars.length, isN: splitAt, oosN: bars.length - splitAt, posBoth0,
  };
}

function fmt(n: number, d = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(d);
}

describe('mean-reversion backtest — sanity', () => {
  it('buys an oversold dip then sells the reversion at a profit; fees strictly reduce PnL', () => {
    // Build a window with mild dispersion (a ±1 oscillation: z stays within ±1, BELOW the 1.5 entry
    // threshold so the base does not trigger), then a sharp DIP (z << -1.5 => ENTER at next open near
    // the bottom), then a recovery back up through the mean (z >= 0 => EXIT). Bought low, sold higher
    // => positive at zero fee; fees can only reduce it.
    const bars: Bar[] = [];
    let t = 0;
    const push = (c: number) => { bars.push([t * 60_000, c, c + 0.5, c - 0.5, c, 1]); t++; };
    for (let i = 0; i < 30; i++) push(100 + (i % 2 === 0 ? -1 : 1)); // oscillate ~99/101 (mean~100, stddev~1, |z|<=1)
    for (let i = 0; i < 5; i++) push(97 - i * 3); // 97 -> 85 (sharp oversold dip => ENTER near bottom)
    for (let i = 0; i < 24; i++) push(85 + (i + 1) * 1.5); // 86.5 -> 121 (reverts up through mean => EXIT above entry)
    const prep = prepare(bars, '1m');
    const free = runBacktest(prep, makeMr(20, 1.5, '1m'), { feeBps: 0 });
    const fee = runBacktest(prep, makeMr(20, 1.5, '1m'), { feeBps: 50 });
    expect(free.fills).toBeGreaterThanOrEqual(2); // at least one full round-trip (buy + sell)
    expect(free.trades).toBeGreaterThanOrEqual(1);
    expect(free.pnl).toBeGreaterThan(0); // bought the dip, sold the reversion => profit at zero fee
    expect(fee.pnl).toBeLessThan(free.pnl); // fees can only reduce PnL
    expect(free.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it('does not pyramid: ENTER and EXIT strictly alternate (fills are even on a clean round-trip set)', () => {
    // Two separate dip-and-revert cycles must produce exactly two round-trips (4 fills), never a
    // pyramided position from repeated ENTER while already long.
    const bars: Bar[] = [];
    let t = 0;
    const push = (c: number) => { bars.push([t * 60_000, c, c + 0.5, c - 0.5, c, 1]); t++; };
    const cycle = () => {
      for (let i = 0; i < 25; i++) push(100 + (i % 2 === 0 ? -1 : 1)); // base: |z|<=1, no trigger at entryZ 1.5
      for (let i = 0; i < 5; i++) push(97 - i * 3); // dip => ENTER
      for (let i = 0; i < 18; i++) push(85 + (i + 1) * 1.5); // recovery => EXIT
    };
    cycle(); cycle();
    const prep = prepare(bars, '1m');
    const r = runBacktest(prep, makeMr(20, 1.5, '1m'), { feeBps: 0 });
    expect(r.fills % 2).toBe(0); // every entry is closed by an exit — no dangling pyramided lot
    expect(r.trades).toBeGreaterThanOrEqual(2);
  });
});

describe('mean-reversion out-of-sample study (real Binance BTC/USDT)', () => {
  it('runs the grid across intervals, splits IS/OOS, and writes the report', () => {
    const nThisStudy = COMBOS.length * INTERVALS.length;
    const nCumulative = N_PRIOR_EMA + nThisStudy;
    const lines: string[] = [];
    lines.push('# Short-horizon mean-reversion out-of-sample study — 2026-06-15');
    lines.push('');
    lines.push(`Real Binance BTC/USDT OHLCV (same cached datasets as the EMA study). Fee = ${FEE_BPS} bps/side ` +
      `(taker, conservative; ~${FEE_BPS * 2} bps round-trip). Fills at NEXT-bar open (no lookahead). ` +
      `Sizing = baseNotional 1000 / price, exits full; PnL on a 5000 base. IS = first ${(1 - OOS_FRACTION) * 100}%, ` +
      `OOS = last ${OOS_FRACTION * 100}% (chronological). Strategy = MeanReversionStrategy (z-score reversion: ` +
      `ENTER_LONG when z <= -entryZ, EXIT_LONG when z >= ${EXIT_Z}); PnL math is the production applyFillToPosition, ` +
      `driven through the SAME generalized harness that reproduces the EMA verdict byte-for-byte.`);
    lines.push('');
    lines.push(`> **Hypothesis:** short-horizon liquidity-provision / overreaction reversal — buy transient weakness ` +
      `(close ${'>='}entryZ std-devs below a rolling mean), exit on reversion to the mean. This is the COMPLEMENT of ` +
      `the trend-following EMA-cross (proven edgeless), a genuinely different edge class. **Pre-registered grid:** ` +
      `lookback {${LOOKBACKS.join(', ')}} x entryZ {${ENTRY_ZS.join(', ')}} = ${COMBOS.length} combos, exitZ fixed ` +
      `at ${EXIT_Z} (canonical revert-to-mean, NOT tuned). **Trial accounting:** ${nThisStudy} variants this study; ` +
      `cumulative research-program N = ${N_PRIOR_EMA} (EMA) + ${nThisStudy} = ${nCumulative} (for the deflated-Sharpe / ` +
      `multiple-testing correction that any eventual deployment must clear).`);
    lines.push('');

    let anyRobust = false;
    const summary: string[] = [];
    let totalPosBoth = 0;
    let totalPosBoth0 = 0;

    for (const interval of INTERVALS) {
      const r = studyInterval(interval);
      if (!r) { lines.push(`## ${interval}: no data`); continue; }
      const byIs = [...r.rows].sort((a, b) => b.is.returnPct - a.is.returnPct);
      const byOos = [...r.rows].sort((a, b) => b.oos.returnPct - a.oos.returnPct);
      const isBest = byIs[0];
      const oosBest = byOos[0];
      if (!isBest || !oosBest) { lines.push(`## ${interval}: no combos`); continue; }
      const posIs = r.rows.filter((x) => x.is.returnPct > 0).length;
      const posOos = r.rows.filter((x) => x.oos.returnPct > 0).length;
      const posBoth = r.rows.filter((x) => x.is.returnPct > 0 && x.oos.returnPct > 0).length;
      totalPosBoth += posBoth;
      totalPosBoth0 += r.posBoth0;
      const isBestSurvives = isBest.oos.returnPct > 0;
      if (isBestSurvives && isBest.is.returnPct > 0) anyRobust = true;

      lines.push(`## ${interval} — ${r.bars} bars (IS ${r.isN} / OOS ${r.oosN})`);
      lines.push(`Buy&hold: IS ${fmt(r.isBH)}% · OOS ${fmt(r.oosBH)}%`);
      lines.push('');
      lines.push('| lookback/entryZ | IS ret% | IS trades | IS win% | OOS ret% | OOS trades | OOS win% |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const row of byIs) {
        lines.push(`| ${row.lookback}/${row.entryZ.toFixed(1)} | ${fmt(row.is.returnPct)} | ${row.is.trades} | ${(row.is.winRate * 100).toFixed(0)} | ` +
          `${fmt(row.oos.returnPct)} | ${row.oos.trades} | ${(row.oos.winRate * 100).toFixed(0)} |`);
      }
      lines.push('');
      lines.push(`- **IS-best** ${isBest.lookback}/${isBest.entryZ.toFixed(1)}: IS ${fmt(isBest.is.returnPct)}% → **OOS ${fmt(isBest.oos.returnPct)}%** ` +
        `(${isBestSurvives ? 'survives OOS' : 'FAILS OOS'})`);
      lines.push(`- Best OOS combo ${oosBest.lookback}/${oosBest.entryZ.toFixed(1)}: OOS ${fmt(oosBest.oos.returnPct)}% (its IS ${fmt(oosBest.is.returnPct)}%)`);
      lines.push(`- Positive: IS ${posIs}/${r.rows.length} · OOS ${posOos}/${r.rows.length} · **BOTH ${posBoth}/${r.rows.length}** · ` +
        `**BOTH @ 0 bps (no fees): ${r.posBoth0}/${r.rows.length}**`);
      lines.push('');

      summary.push(`${interval}: IS-best ${isBest.lookback}/${isBest.entryZ.toFixed(1)} IS ${fmt(isBest.is.returnPct)}% → OOS ${fmt(isBest.oos.returnPct)}% ` +
        `[${isBestSurvives ? 'survives' : 'fails'}]; positive-both ${posBoth}/${r.rows.length} (0bps ${r.posBoth0}/${r.rows.length}); B&H OOS ${fmt(r.oosBH)}%`);
    }

    lines.push('## Verdict');
    lines.push(anyRobust
      ? `At least one IS-best parameter set is ALSO positive out-of-sample. This is a LEAD, not a deployable edge: ` +
        `it must still clear the step-D validation standard (walk-forward across regimes, purged+embargoed CV, ` +
        `deflated Sharpe at cumulative N=${nCumulative}, t-stat ~3.0, MinBTL) before any production change. Treat ` +
        `with caution (single 70/30 split, fee-sensitive). See per-interval detail; escalate to full validation next pass.`
      : `NO interval's in-sample-best parameter set is positive out-of-sample (IS-best survives OOS: ${anyRobust}). ` +
        `Across all intervals, ${totalPosBoth}/${nThisStudy} variants are positive in BOTH IS and OOS at ${FEE_BPS} bps, ` +
        `and **${totalPosBoth0}/${nThisStudy} even at ZERO fees** — so a near-zero count is the STRATEGY, not transaction ` +
        `costs. Short-horizon z-score mean-reversion shows **no robust, fee-surviving edge** on BTC/USDT across the tested ` +
        `intervals/params, the same verdict class as the EMA-cross trend-follower. This CLOSES the plain z-score ` +
        `mean-reversion hypothesis; re-tuning the same form on this data would be overfitting (forbidden by step D).`);
    lines.push('');
    lines.push('### Console summary');
    for (const s of summary) lines.push(`- ${s}`);

    const md = lines.join('\n');
    writeFileSync(REPORT, md + '\n');
    console.log('\n===== MEAN-REVERSION STUDY SUMMARY =====');
    console.log(`anyRobust(IS-best survives OOS & positive): ${anyRobust}`);
    console.log(`positive-both total: ${totalPosBoth}/${nThisStudy} (@${FEE_BPS}bps), ${totalPosBoth0}/${nThisStudy} (@0bps)`);
    for (const s of summary) console.log('  ' + s);
    console.log('========================================\n');

    expect(summary.length).toBeGreaterThan(0);
  }, 600_000);
});
