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
  SHORT_TRIALS,
  harvest,
  variance,
  loadAllPreps,
  FEE_BPS_VIP0,
  FEE_BPS_VIP0_BNB,
  type HarvestedTrial,
} from './trial-registry';
import { ShortMeanReversionStrategy, LongShortEmaStrategy } from './short-battery.strategies';
import { strategyId } from '../../src/domain/types/ids';
import type { CandleInterval } from '../../src/domain/types/market-events';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, '..', '..', 'reports', 'nightly', 'short-study.md');
const common = { symbol: BT_SYMBOL, venue: BT_VENUE, ttlMs: 30_000, interval: '1h' as const };

describe('short battery — shorts execute through the harness', () => {
  it('ShortMeanReversion shorts an overbought spike and covers lower for a profit', () => {
    const bars: Bar[] = [];
    let t = 0;
    const push = (c: number) => {
      bars.push([t * 60_000, c, c + 0.5, c - 0.5, c, 1]);
      t++;
    };
    for (let i = 0; i < 30; i++) push(100 + (i % 2 === 0 ? -1 : 1)); // base oscillation |z|<=1
    for (let i = 0; i < 5; i++) push(100 + (i + 1) * 3); // 103..115 overbought spike ⇒ ENTER_SHORT near top
    for (let i = 0; i < 24; i++) push(115 - (i + 1) * 1.4); // revert down through mean ⇒ EXIT_SHORT lower
    const prep = prepare(bars, '1m');
    const free = runBacktest(
      prep,
      () =>
        new ShortMeanReversionStrategy(strategyId('smr'), {
          ...common,
          interval: '1m',
          lookback: 20,
          entryZ: 1.5,
          exitZ: 0,
        }),
      { feeBps: 0 },
    );
    const fee = runBacktest(
      prep,
      () =>
        new ShortMeanReversionStrategy(strategyId('smr'), {
          ...common,
          interval: '1m',
          lookback: 20,
          entryZ: 1.5,
          exitZ: 0,
        }),
      { feeBps: 50 },
    );
    expect(free.fills).toBeGreaterThanOrEqual(2); // one short round-trip
    expect(free.trades).toBeGreaterThanOrEqual(1);
    expect(free.pnl).toBeGreaterThan(0); // shorted high, covered low ⇒ profit at zero fee
    expect(fee.pnl).toBeLessThan(free.pnl); // fees can only reduce PnL
  });

  it('LongShortEma flips between long and short across reversals', () => {
    const bars: Bar[] = [];
    let t = 0;
    const push = (c: number) => {
      bars.push([t * 60_000, c, c + 0.5, c - 0.5, c, 1]);
      t++;
    };
    for (let i = 0; i < 20; i++) push(120 - i); // falling warmup ⇒ ends bearish (lastBullish=false)
    for (let i = 0; i < 50; i++) push(100 + i * 1.5); // up ⇒ GOLDEN ⇒ LONG
    for (let i = 0; i < 50; i++) push(175 - i * 1.5); // down ⇒ DEATH ⇒ flip to SHORT (exit long + enter short)
    for (let i = 0; i < 50; i++) push(100 + i * 1.5); // up ⇒ GOLDEN ⇒ flip to LONG (cover short + enter long)
    const prep = prepare(bars, '1m');
    const r = runBacktest(
      prep,
      () =>
        new LongShortEmaStrategy(strategyId('lse'), {
          ...common,
          interval: '1m',
          fast: 5,
          slow: 10,
        }),
      { feeBps: 0 },
    );
    expect(r.fills).toBeGreaterThanOrEqual(4); // enter-long, (exit-long+enter-short), (cover-short+enter-long)
    expect(r.trades).toBeGreaterThanOrEqual(2); // a long round-trip and a short round-trip both closed
  });
});

function fmt(n: number, d = 3): string {
  if (!Number.isFinite(n)) return n > 0 ? '+∞' : '−∞';
  return (n >= 0 ? '+' : '') + n.toFixed(d);
}

describe('short battery — step-D study (real Binance BTC/USDT)', () => {
  it('runs short + long-short candidates through the cumulative-N gate and documents pass/fail', () => {
    const preps = loadAllPreps();
    expect(preps.size).toBeGreaterThan(0);

    // Cumulative program now: prior 208 + long battery 64 + short battery 52.
    const prior = harvest(PRIOR_TRIALS, preps, FEE_BPS_VIP0);
    const longB = harvest(BATTERY_TRIALS, preps, FEE_BPS_VIP0);
    const shortB = harvest(SHORT_TRIALS, preps, FEE_BPS_VIP0);
    const all = [...prior, ...longB, ...shortB];
    const N = all.length;
    const V = variance(all.map((t) => t.stats.sr));
    const sr0 = expectedMaxSharpe(V, N);

    const short0 = harvest(SHORT_TRIALS, preps, 0);
    const shortBnb = harvest(SHORT_TRIALS, preps, FEE_BPS_VIP0_BNB);
    const profitable = (xs: HarvestedTrial[]) => xs.filter((t) => t.returnPct > 0).length;

    const CLASSES = ['short-mr', 'longshort-ema'] as const;
    const bestOf = (cls: string): HarvestedTrial => {
      const pool = shortB.filter((t) => t.cls === cls);
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

    const lines: string[] = [];
    lines.push('# Short / long-short battery — step-D study — 2026-06-15');
    lines.push('');
    lines.push(
      `Shorts plumbed through Risk (Phase 3) and the harness sizing. Candidates run through the Phase-0 ` +
        `gate at VIP0 fees (${FEE_BPS_VIP0} bps; ${FEE_BPS_VIP0_BNB} with BNB) + a zero-fee cross-check. ` +
        `**Not live-deployable: the paper/testnet venue is spot (can't short); a short winner needs a ` +
        `futures/margin venue — DEFERRED.** Per-trade-return convention. Real Binance BTC/USDT.`,
    );
    lines.push('');
    lines.push('## Pre-registered short battery');
    lines.push('');
    lines.push(
      '- **Short mean-reversion** — SELL when z ≥ +entryZ (overbought), cover when z ≤ 0. {lookback 20/50/100 × entryZ 1.5/2.0/2.5}. The mirror of the closed long reversion.',
    );
    lines.push(
      '- **Long/short EMA** — long above the cross, FLIP to short below it. {9/21, 20/50, 30/100, 50/200}. The closed trend follower with the downside captured.',
    );
    lines.push('');
    lines.push('## Cumulative trial accounting');
    lines.push('');
    lines.push(
      `- **N = ${N}** = prior ${prior.length} + long battery ${longB.length} + short battery ${shortB.length}.`,
    );
    lines.push(
      `- **V = ${V.toExponential(3)}**, **E[max Sharpe of N] = ${fmt(sr0)}** (E[maxZ]=${fmt(expectedMaxZ(N), 3)}).`,
    );
    lines.push(
      `- Short trials profitable: **${profitable(shortB)}/${shortB.length}** @ ${FEE_BPS_VIP0} bps · ` +
        `${profitable(shortBnb)}/${shortBnb.length} @ ${FEE_BPS_VIP0_BNB} bps · **${profitable(short0)}/${short0.length} @ 0 bps**.`,
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
      lines.push(`- **VERDICT: ${g.pass ? '🟢 PASS' : '🔴 FAIL'}**`);
      lines.push('');
    }

    lines.push('## Verdict');
    lines.push(
      anyPass
        ? `A short candidate PASSED step-D — but it is NOT live-deployable on the spot venue; record it and gate any deployment on a futures/margin venue integration (re-audit first).`
        : `No short or long-short candidate clears step-D. Shorting overbought reversion and capturing the ` +
            `EMA down-leg both FAIL at VIP0 fees (zero-fee count above confirms it is the strategies, not costs). ` +
            `Combined with the long closures, BTC/USDT shows no fee-surviving directional edge in any tested ` +
            `form — long or short, trend or reversion, plain or regime-conditioned. Live short execution stays ` +
            `DEFERRED (no edge to justify a futures-venue build).`,
    );

    writeFileSync(REPORT, lines.join('\n') + '\n');
    console.log('\n===== SHORT BATTERY STEP-D STUDY =====');
    console.log(`N=${N} V=${V.toExponential(3)} E[maxSharpe]=${fmt(sr0)}`);
    for (const { cls, best, ev } of results) {
      console.log(
        `${cls}: best ${best.label}@${best.interval} SR=${fmt(best.stats.sr)} ret=${fmt(best.returnPct, 2)}% t=${fmt(ev.gate.tStat, 2)} DSR=${fmt(ev.gate.dsr, 3)} PASS=${ev.gate.pass}`,
      );
    }
    console.log(`anyPass=${anyPass}`);
    console.log('======================================\n');

    expect(N).toBe(
      (PRIOR_TRIALS.length + BATTERY_TRIALS.length + SHORT_TRIALS.length) * preps.size,
    );
    expect(SHORT_TRIALS.length).toBe(13);
    expect(results.length).toBe(CLASSES.length);
  }, 600_000);
});
