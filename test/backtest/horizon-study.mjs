// Horizon + passive-baseline study, preregistered in
// research/studies/horizon-and-baseline-2026-07-27.md. Pure offline computation over cached daily
// bars — no network, no LLM, no money path. Reports EVERY cell at BOTH fee levels.
//
//   node test/backtest/horizon-study.mjs
//
// Scope note: this deliberately tests 7/30/90-DAY horizons. The settled price-TA verdict
// (4,562 trials, zero survivors, do-not-repeat) covers 15m-1d and its own closing note names
// multi-day cross-sectional momentum as the untested frontier. No cell here is inside 1d.
//
// The bar is EXCESS RETURN OVER THE EQUAL-WEIGHT BASKET, not positivity — a strategy that beats
// zero while trailing the basket is destroying value, and the promotion gate's current
// "net-of-cost > 0" would pass it.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const DAY = 86_400_000;
const ASSETS = [
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'LINK',
  'AAVE',
  'NEAR',
  'ZEC',
  'DOGE',
  'ADA',
  'AVAX',
  'LTC',
  'UNI',
  'BCH',
  'DOT',
  'TRX',
];
const HORIZONS = [7, 30, 90];
const FEES_BPS = { taker: 20, maker: 4 };
const BONFERRONI = 0.05 / 12;
const N_BOOT = 2000;
const MIN_PERIODS = 12;

let seed = 20260727;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const mean = (a) => (a.length === 0 ? NaN : a.reduce((s, x) => s + x, 0) / a.length);

// ── load ─────────────────────────────────────────────────────────────────────
const closes = new Map();
for (const a of ASSETS) {
  const p = join(DATA, `ohlcv-${a}USDT-1d.json`);
  if (!existsSync(p)) continue;
  const m = new Map();
  for (const r of JSON.parse(readFileSync(p, 'utf8')))
    m.set(Math.floor(r[0] / DAY) * DAY, Number(r[4]));
  closes.set(a, m);
}
const days = [...(closes.get('BTC') ?? new Map()).keys()].sort((x, y) => x - y);

const px = (a, d) => closes.get(a)?.get(d);
const ret = (a, d0, d1) => {
  const c0 = px(a, d0);
  const c1 = px(a, d1);
  return c0 > 0 && c1 > 0 ? (c1 - c0) / c0 : null;
};

function realizedVol(a, d, lookback) {
  const i = days.indexOf(d);
  if (i < lookback) return null;
  const rs = [];
  for (let k = i - lookback; k < i; k += 1) {
    const r = ret(a, days[k], days[k + 1]);
    if (r !== null) rs.push(Math.log(1 + r));
  }
  if (rs.length < lookback / 2) return null;
  const mu = mean(rs);
  return Math.sqrt(mean(rs.map((x) => (x - mu) ** 2)));
}

function movingAvg(a, d, lookback) {
  const i = days.indexOf(d);
  if (i < lookback) return null;
  const vs = [];
  for (let k = i - lookback; k < i; k += 1) {
    const c = px(a, days[k]);
    if (c > 0) vs.push(c);
  }
  return vs.length < lookback / 2 ? null : mean(vs);
}

// ── signals: score at rebalance day d, using ONLY trailing data ──────────────
const SIGNALS = {
  xs_mom30: (a, d) => {
    const i = days.indexOf(d);
    return i < 30 ? null : ret(a, days[i - 30], d);
  },
  xs_rev7: (a, d) => {
    const i = days.indexOf(d);
    const r = i < 7 ? null : ret(a, days[i - 7], d);
    return r === null ? null : -r;
  },
  xs_momvol: (a, d) => {
    const i = days.indexOf(d);
    if (i < 30) return null;
    const r = ret(a, days[i - 30], d);
    const v = realizedVol(a, d, 30);
    return r === null || v === null || v === 0 ? null : r / v;
  },
  ts_mom50: (a, d) => {
    const ma = movingAvg(a, d, 50);
    const c = px(a, d);
    return ma === null || !(c > 0) ? null : c / ma - 1;
  },
};

/**
 * Walk non-overlapping rebalance periods. At each, score the universe, long the top tercile and
 * short the bottom, equal-weighted; charge fees on turnover (both legs enter and exit each period,
 * so one full round trip of the gross book per period). Returns per-period net returns for the
 * strategy and for the equal-weight basket over the identical periods.
 */
function runSignal(name, horizon, feeBps) {
  const scoreOf = SIGNALS[name];
  const stratRets = [];
  const baseRets = [];
  const periods = [];
  const start = 50; // longest lookback (ts_mom50) so every signal is defined from the same day
  for (let i = start; i + horizon < days.length; i += horizon) {
    const d0 = days[i];
    const d1 = days[i + horizon];
    const scored = [];
    for (const a of ASSETS) {
      const s = scoreOf(a, d0);
      const r = ret(a, d0, d1);
      if (s !== null && Number.isFinite(s) && r !== null) scored.push({ a, s, r });
    }
    if (scored.length < 6) continue;
    scored.sort((x, y) => x.s - y.s);
    const k = Math.floor(scored.length / 3);
    if (k < 2) continue;
    const shorts = scored.slice(0, k);
    const longs = scored.slice(-k);
    // Long-short, gross exposure 1.0 (0.5 each side). Fees charged on the full gross book per period.
    const gross = 0.5 * mean(longs.map((x) => x.r)) - 0.5 * mean(shorts.map((x) => x.r));
    stratRets.push(gross - feeBps / 10_000);
    baseRets.push(mean(scored.map((x) => x.r)));
    periods.push(d0);
  }
  return { stratRets, baseRets, periods };
}

/** Bootstrap the mean EXCESS return (strategy minus basket) over non-overlapping periods. */
function bootstrapExcess(stratRets, baseRets) {
  const ex = stratRets.map((s, i) => s - baseRets[i]);
  if (ex.length < 4) return null;
  const observed = mean(ex);
  const draws = [];
  for (let b = 0; b < N_BOOT; b += 1) {
    const pick = [];
    for (let i = 0; i < ex.length; i += 1) pick.push(ex[(rand() * ex.length) | 0]);
    draws.push(mean(pick));
  }
  draws.sort((a, b) => a - b);
  const negFrac = draws.filter((d) => d <= 0).length / draws.length;
  return {
    n: ex.length,
    excess: observed,
    lo: draws[Math.floor(0.025 * draws.length)],
    hi: draws[Math.floor(0.975 * draws.length)],
    p: 2 * Math.min(negFrac, 1 - negFrac),
    firstHalf: mean(ex.slice(0, Math.floor(ex.length / 2))),
    secondHalf: mean(ex.slice(Math.floor(ex.length / 2))),
  };
}

// ── benchmarks over the full cached window ───────────────────────────────────
const d0 = days[50];
const dN = days[days.length - 1];
const ewFull = mean(ASSETS.map((a) => ret(a, d0, dN)).filter((r) => r !== null));
const btcFull = ret('BTC', d0, dN);
const iso = (d) => new Date(d).toISOString().slice(0, 10);

console.log('Horizon + passive-baseline study — preregistered');
console.log('research/studies/horizon-and-baseline-2026-07-27.md');
console.log(`window ${iso(d0)} -> ${iso(dN)} (${days.length} daily bars, ${ASSETS.length} assets)`);
console.log(
  `BENCHMARKS over window: equal-weight buy&hold ${(ewFull * 100).toFixed(1)}% | ` +
    `BTC buy&hold ${(btcFull * 100).toFixed(1)}%`,
);
console.log(
  `Bonferroni alpha=${BONFERRONI.toExponential(2)} over 12 cells | min periods ${MIN_PERIODS}\n`,
);
// Compounded terminal return over the realized sequence. The per-period arithmetic means below are
// what the pass rule is stated in, but they are NOT comparable to the buy-and-hold header figure: a
// REBALANCED equal-weight basket and a BUY-AND-HOLD basket are different portfolios, and the gap
// between them is large in a dispersed market. Over the 2019-2026 window the rebalanced basket
// compounds to ~+1,295% against +697% buy-and-hold; over the earlier 400-bar window the sign of the
// gap ran the other way. Neither is a bug — they are different strategies — which is exactly why
// compounded terminal return is reported alongside, purely DESCRIPTIVELY. The frozen pass rule is
// stated in per-period excess and is unchanged.
const compound = (rets) => rets.reduce((acc, r) => acc * (1 + r), 1) - 1;

console.log(
  'signal      h   n   fee    strat/period  basket/period  EXCESS/period   95% CI            p       halves        COMPOUNDED     verdict',
);
console.log('-'.repeat(140));

const passes = [];
for (const name of Object.keys(SIGNALS)) {
  for (const h of HORIZONS) {
    for (const [tier, feeBps] of Object.entries(FEES_BPS)) {
      const { stratRets, baseRets } = runSignal(name, h, feeBps);
      const st = bootstrapExcess(stratRets, baseRets);
      if (st === null) {
        console.log(
          `${name.padEnd(11)} ${String(h).padEnd(3)} —   ${tier.padEnd(6)} too few periods`,
        );
        continue;
      }
      const pct = (x) => (x * 100).toFixed(2);
      let verdict;
      if (st.n < MIN_PERIODS) verdict = 'DESCRIPTIVE (n<12)';
      else if (st.excess <= 0) verdict = 'FAIL';
      else if (st.p >= BONFERRONI) verdict = 'FAIL-p';
      else if (st.firstHalf <= 0 || st.secondHalf <= 0) verdict = 'FAIL-halves';
      else verdict = tier === 'taker' ? 'PASS' : 'FEE-TIER-DEPENDENT';
      if (verdict === 'PASS') passes.push(`${name}@h${h}`);
      const compStrat = compound(stratRets);
      const compBase = compound(baseRets);
      console.log(
        `${name.padEnd(11)} ${String(h).padEnd(3)} ${String(st.n).padEnd(3)} ${tier.padEnd(6)} ` +
          `${pct(mean(stratRets)).padStart(11)}%  ${pct(mean(baseRets)).padStart(12)}%  ` +
          `${pct(st.excess).padStart(12)}%  [${pct(st.lo).padStart(6)},${pct(st.hi).padStart(6)}] ` +
          `${st.p.toFixed(4).padStart(6)}  ${pct(st.firstHalf).padStart(6)}/${pct(st.secondHalf).padStart(6)}  ` +
          `${pct(compStrat).padStart(7)}%vs${pct(compBase).padStart(7)}%  ${verdict}`,
      );
    }
  }
}
console.log('-'.repeat(122));
console.log(
  passes.length === 0
    ? '\nVERDICT: NO CELL BEATS THE PASSIVE BASKET at the live fee tier.'
    : `\nVERDICT: ${passes.length} cell(s) beat the basket: ${passes.join(', ')}`,
);
