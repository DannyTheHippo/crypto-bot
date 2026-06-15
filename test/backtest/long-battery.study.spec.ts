import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, runBacktest, BT_VENUE, BT_SYMBOL, type Bar } from './harness';
import { walkForward } from './walk-forward';
import { evaluateGate, expectedMaxSharpe, expectedMaxZ } from './stats';
import {
  PRIOR_TRIALS,
  BATTERY_TRIALS,
  harvest,
  variance,
  loadAllPreps,
  FEE_BPS_VIP0,
  FEE_BPS_VIP0_BNB,
  type HarvestedTrial,
} from './trial-registry';
import {
  DonchianBreakoutStrategy,
  DualMomentumStrategy,
  VolRegimeTrendStrategy,
  AdxRegimeTrendStrategy,
} from './long-battery.strategies';
import { strategyId } from '../../src/domain/types/ids';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, '..', '..', 'reports', 'nightly', 'long-battery-study.md');
const common = { symbol: BT_SYMBOL, venue: BT_VENUE, ttlMs: 30_000, interval: '1h' as const };

// A rich synthetic series: a gentle high-price UPTREND (low coefficient-of-variation, persistent
// +DM so ADX climbs) then a DOWNTREND — enough for every candidate to enter and later exit.
function trendThenReverse(): Bar[] {
  const bars: Bar[] = [];
  let t = 0;
  const push = (c: number) => {
    bars.push([t * 3_600_000, c, c + 0.5, c - 0.5, c, 1]);
    t++;
  };
  // Slope (±2) exceeds the ±0.5 bar range so the close genuinely breaks prior highs/lows (Donchian
  // needs a real breakout), while CoV stays ~1% so the vol-regime gate still admits entries.
  for (let i = 0; i < 200; i++) push(1000 + i * 2); // uptrend 1000 -> 1398
  for (let i = 0; i < 150; i++) push(1398 - i * 2); // downtrend 1398 -> 1100
  return bars;
}

describe('long battery — every candidate actually trades', () => {
  const prep = prepare(trendThenReverse(), '1h');

  it('Donchian breakout completes a round-trip on a trend-then-reverse series', () => {
    const r = runBacktest(
      prep,
      () =>
        new DonchianBreakoutStrategy(strategyId('d'), {
          ...common,
          entryLookback: 20,
          exitLookback: 10,
        }),
      { feeBps: 0 },
    );
    expect(r.fills).toBeGreaterThanOrEqual(2);
    expect(r.trades).toBeGreaterThanOrEqual(1);
  });
  it('Dual-momentum completes a round-trip', () => {
    const r = runBacktest(
      prep,
      () =>
        new DualMomentumStrategy(strategyId('m'), {
          ...common,
          momLookback: 10,
          trendLen: 50,
          momThreshold: 0,
        }),
      { feeBps: 0 },
    );
    expect(r.fills).toBeGreaterThanOrEqual(2);
    expect(r.trades).toBeGreaterThanOrEqual(1);
  });
  it('Vol-regime trend completes a round-trip', () => {
    const r = runBacktest(
      prep,
      () =>
        new VolRegimeTrendStrategy(strategyId('v'), {
          ...common,
          fast: 9,
          slow: 21,
          volLookback: 20,
          volMaxPct: 4,
        }),
      { feeBps: 0 },
    );
    expect(r.fills).toBeGreaterThanOrEqual(2);
    expect(r.trades).toBeGreaterThanOrEqual(1);
  });
  it('ADX-regime trend completes a round-trip', () => {
    const r = runBacktest(
      prep,
      () =>
        new AdxRegimeTrendStrategy(strategyId('a'), {
          ...common,
          fast: 9,
          slow: 21,
          adxPeriod: 14,
          adxMin: 20,
        }),
      { feeBps: 0 },
    );
    expect(r.fills).toBeGreaterThanOrEqual(2);
    expect(r.trades).toBeGreaterThanOrEqual(1);
  });
});

function fmt(n: number, d = 3): string {
  if (!Number.isFinite(n)) return n > 0 ? '+∞' : '−∞';
  return (n >= 0 ? '+' : '') + n.toFixed(d);
}

describe('long battery — step-D study (real Binance BTC/USDT)', () => {
  it('runs the pre-registered battery through the cumulative-N gate and documents pass/fail', () => {
    const preps = loadAllPreps();
    expect(preps.size).toBeGreaterThan(0);

    // Cumulative research program: prior closed trials (EMA 160 + mean-rev 48) + this battery (64).
    const prior = harvest(PRIOR_TRIALS, preps, FEE_BPS_VIP0);
    const battery = harvest(BATTERY_TRIALS, preps, FEE_BPS_VIP0);
    const all = [...prior, ...battery];
    const N = all.length;
    const V = variance(all.map((t) => t.stats.sr));
    const sr0 = expectedMaxSharpe(V, N);

    // Robustness cross-check: how many battery trials are even profitable at ZERO fees / at the BNB tier.
    const battery0 = harvest(BATTERY_TRIALS, preps, 0);
    const batteryBnb = harvest(BATTERY_TRIALS, preps, FEE_BPS_VIP0_BNB);
    const profitable = (xs: HarvestedTrial[]) => xs.filter((t) => t.returnPct > 0).length;

    const CLASSES = ['donchian', 'dualmom', 'volregime', 'adxregime'] as const;
    const bestOf = (cls: string): HarvestedTrial => {
      const pool = battery.filter((t) => t.cls === cls);
      const withTrades = pool.filter((t) => t.trades >= 2);
      return (withTrades.length ? withTrades : pool).sort((a, b) => b.stats.sr - a.stats.sr)[0]!;
    };

    const evaluate = (t: HarvestedTrial) => {
      const wf = walkForward(preps.get(t.interval)!, t.make, {
        feeBps: FEE_BPS_VIP0,
        segments: 4,
        mode: 'anchored',
        warmupBars: 200,
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

    const results = CLASSES.map((cls) => {
      const best = bestOf(cls);
      return { cls, best, ev: evaluate(best) };
    });
    const anyPass = results.some((r) => r.ev.gate.pass);

    // ── Report ────────────────────────────────────────────────────────────────
    const lines: string[] = [];
    lines.push('# Long-directional battery — step-D study — 2026-06-15');
    lines.push('');
    lines.push(
      `Pre-registered long-only candidates run through the Phase-0 validation gate (deflated Sharpe, ` +
        `t-stat, MinBTL, walk-forward) at Binance spot VIP0 fees (${FEE_BPS_VIP0} bps/side; ${FEE_BPS_VIP0_BNB} bps ` +
        `with the BNB discount) + a zero-fee cross-check. Per-trade-return convention. Real Binance BTC/USDT.`,
    );
    lines.push('');
    lines.push('## Pre-registered battery (declared before results)');
    lines.push('');
    lines.push(
      '- **Donchian breakout** — close breaks prior-N-bar high; exit on prior-M-bar low. {20/10, 20/20, 55/10, 55/20}.',
    );
    lines.push(
      '- **Dual-timeframe momentum** — slow-SMA trend filter + N-bar momentum trigger. {mom10/20 × trend50/100}, threshold 0.',
    );
    lines.push(
      '- **Vol-regime trend** — EMA-cross gated to a low coefficient-of-variation regime (gate, not inverse-vol sizing — harness is fixed-notional). {9/21,20/50 × vol≤2%,4%}.',
    );
    lines.push(
      '- **ADX-regime trend** — EMA-cross gated to a trending regime (Wilder ADX ≥ adxMin). {9/21,20/50 × adx20,25}.',
    );
    lines.push('');
    lines.push('## Cumulative trial accounting (the DSR deflation penalty)');
    lines.push('');
    lines.push(
      `- **N = ${N}** = prior ${prior.length} (EMA 160 + mean-rev 48) + battery ${battery.length} (16 combos × ${preps.size} intervals). ` +
        `The honesty tax: every variant ever tried widens the selection the DSR must beat.`,
    );
    lines.push(
      `- **V = ${V.toExponential(3)}**, **E[max Sharpe of N] = ${fmt(sr0)}** (E[maxZ]=${fmt(expectedMaxZ(N), 3)}).`,
    );
    lines.push(
      `- Battery trials profitable: **${profitable(battery)}/${battery.length}** @ ${FEE_BPS_VIP0} bps · ` +
        `${profitable(batteryBnb)}/${batteryBnb.length} @ ${FEE_BPS_VIP0_BNB} bps · ` +
        `**${profitable(battery0)}/${battery0.length} @ 0 bps** (zero-fee: profitability is the strategy, not costs).`,
    );
    lines.push('');

    for (const { cls, best, ev } of results) {
      const g = ev.gate;
      lines.push(`## ${cls}: best candidate ${best.label} @ ${best.interval}`);
      lines.push('');
      lines.push(
        `- per-trade SR ${fmt(best.stats.sr)} · trades ${best.trades} · full-sample ret ${fmt(best.returnPct, 2)}% · skew ${fmt(best.stats.skew, 2)} · kurt ${fmt(best.stats.kurt, 2)}`,
      );
      lines.push(
        `- t-stat ${fmt(g.tStat, 2)} (>3.0? ${g.tStatPass ? '✅' : '❌'}) · DSR ${fmt(g.dsr, 4)} (>0.95? ${g.dsrPass ? '✅' : '❌'})`,
      );
      lines.push(
        `- MinBTL ${fmt(g.minBTL, 1)} vs ${best.trades} trades (≥? ${g.lengthPass ? '✅' : '❌'}) · WF ${ev.wf.positiveCount}/${ev.wf.segments.length} positive [${ev.wf.segments.map((s) => fmt(s.oosReturnPct, 1)).join(', ')}]% (${g.wfPass ? '✅' : '❌'})`,
      );
      lines.push(`- **VERDICT: ${g.pass ? '🟢 PASS — VALIDATED WINNER CANDIDATE' : '🔴 FAIL'}**`);
      lines.push('');
    }

    lines.push('## Verdict');
    lines.push(
      anyPass
        ? `A candidate PASSED the step-D gate — promote it to a genuine winner in Phase 4 (re-audit the verdict adversarially first).`
        : `No pre-registered long candidate clears the step-D gate. Channel breakout, dual-timeframe momentum, ` +
            `vol-regime-gated trend, and ADX-regime-gated trend all FAIL at VIP0 fees — and the zero-fee count above ` +
            `shows it is the strategies, not transaction costs. This extends the EMA + mean-rev closures: trend and ` +
            `reversion, plain or regime-conditioned, show no fee-surviving long edge on BTC/USDT. The least-bad ` +
            `candidate is recorded for the Phase-4 best-of-breed experiment (deployed labeled UNVALIDATED, never to live).`,
    );

    writeFileSync(REPORT, lines.join('\n') + '\n');
    console.log('\n===== LONG BATTERY STEP-D STUDY =====');
    console.log(`N=${N} V=${V.toExponential(3)} E[maxSharpe]=${fmt(sr0)}`);
    for (const { cls, best, ev } of results) {
      console.log(
        `${cls}: best ${best.label}@${best.interval} SR=${fmt(best.stats.sr)} ret=${fmt(best.returnPct, 2)}% t=${fmt(ev.gate.tStat, 2)} DSR=${fmt(ev.gate.dsr, 3)} PASS=${ev.gate.pass}`,
      );
    }
    console.log(`anyPass=${anyPass}`);
    console.log('=====================================\n');

    // Structural assertions (the verdict itself is data-driven, logged not asserted):
    expect(N).toBe((PRIOR_TRIALS.length + BATTERY_TRIALS.length) * preps.size);
    expect(PRIOR_TRIALS.length).toBe(52); // EMA 40 + mean-rev 12 (drift guard on the closed grids)
    expect(BATTERY_TRIALS.length).toBe(16);
    expect(results.length).toBe(CLASSES.length);
  }, 600_000);
});
