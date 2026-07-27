// Long-only overlay study — Amendment 3 of research/studies/horizon-and-baseline-2026-07-27.md.
// Pure offline computation over cached daily bars; no network, no LLM, no money path.
//
//   node test/backtest/longonly-study.mjs
//
// WHY THIS FAMILY EXISTS: the main run found every market-neutral long-short cell negative, and
// diagnosed the cause — the return was BETA, and long-short strips it out by construction. That
// implies a different question this program has never asked: can an overlay that KEEPS the beta beat
// simply holding it? Timing and tilting are not market-neutral selection.
//
// `lo_all` is a SANITY ARM, not a hypothesis: it is the benchmark, so its excess must read ~0. A
// non-zero reading means the harness is wrong and the whole run is void.

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
const HORIZONS = [7, 30];
const FEES_BPS = { taker: 20, maker: 4 };
const BONFERRONI = 0.05 / 8;
const N_BOOT = 2000;
const MIN_PERIODS = 12;

let seed = 20260727;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const mean = (a) => (a.length === 0 ? NaN : a.reduce((s, x) => s + x, 0) / a.length);

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
function trailing(a, d, n, fn) {
  const i = days.indexOf(d);
  if (i < n) return null;
  return fn(i);
}
const mom = (a, d, n) => trailing(a, d, n, (i) => ret(a, days[i - n], d));
const ma = (a, d, n) =>
  trailing(a, d, n, (i) => {
    const vs = [];
    for (let k = i - n; k < i; k += 1) {
      const c = px(a, days[k]);
      if (c > 0) vs.push(c);
    }
    return vs.length < n / 2 ? null : mean(vs);
  });
const vol = (a, d, n) =>
  trailing(a, d, n, (i) => {
    const rs = [];
    for (let k = i - n; k < i; k += 1) {
      const r = ret(a, days[k], days[k + 1]);
      if (r !== null) rs.push(Math.log(1 + r));
    }
    if (rs.length < n / 2) return null;
    const mu = mean(rs);
    return Math.sqrt(mean(rs.map((x) => (x - mu) ** 2)));
  });

/** Each returns a weight map over `avail` summing to <= 1; the remainder is cash. */
const SIGNALS = {
  lo_all: (avail) => Object.fromEntries(avail.map((a) => [a, 1 / avail.length])),
  lo_top3: (avail, d) => {
    const scored = avail.map((a) => ({ a, s: mom(a, d, 30) })).filter((x) => x.s !== null);
    if (scored.length < 3) return {};
    scored.sort((x, y) => y.s - x.s);
    const k = Math.max(1, Math.floor(scored.length / 3));
    const top = scored.slice(0, k);
    return Object.fromEntries(top.map((x) => [x.a, 1 / top.length]));
  },
  lo_trend: (avail, d) => {
    // Equal-weight sizing across the WHOLE universe, but only the above-MA names are held — so the
    // overlay expresses itself as cash, not as concentration into survivors.
    const w = {};
    for (const a of avail) {
      const m = ma(a, d, 50);
      const c = px(a, d);
      if (m !== null && c > 0 && c > m) w[a] = 1 / avail.length;
    }
    return w;
  },
  lo_btc_regime: (avail, d) => {
    const m = ma('BTC', d, 50);
    const c = px('BTC', d);
    if (m === null || !(c > 0) || c <= m) return {};
    return Object.fromEntries(avail.map((a) => [a, 1 / avail.length]));
  },
  lo_voltarget: (avail, d) => {
    const inv = avail.map((a) => ({ a, v: vol(a, d, 30) })).filter((x) => x.v !== null && x.v > 0);
    if (inv.length === 0) return {};
    const tot = inv.reduce((s, x) => s + 1 / x.v, 0);
    return Object.fromEntries(inv.map((x) => [x.a, 1 / x.v / tot]));
  },
};

function run(name, horizon, feeBps) {
  const build = SIGNALS[name];
  const stratRets = [];
  const baseRets = [];
  let prev = {};
  for (let i = 50; i + horizon < days.length; i += horizon) {
    const d0 = days[i];
    const d1 = days[i + horizon];
    const avail = ASSETS.filter((a) => px(a, d0) > 0 && ret(a, d0, d1) !== null);
    if (avail.length < 6) continue;
    const w = build(avail, d0);
    // Turnover across the union of held names; one-way cost is half the round-trip tier.
    let turnover = 0;
    for (const a of new Set([...Object.keys(w), ...Object.keys(prev)])) {
      turnover += Math.abs((w[a] ?? 0) - (prev[a] ?? 0));
    }
    const gross = Object.entries(w).reduce((s, [a, wt]) => s + wt * ret(a, d0, d1), 0);
    stratRets.push(gross - (feeBps / 2 / 10_000) * turnover);
    baseRets.push(mean(avail.map((a) => ret(a, d0, d1))));
    prev = w;
  }
  return { stratRets, baseRets };
}

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

const compound = (rets) => rets.reduce((acc, r) => acc * (1 + r), 1) - 1;
const pct = (x) => (x * 100).toFixed(2);

console.log('Long-only overlay study — Amendment 3 of horizon-and-baseline-2026-07-27.md');
console.log(
  `window ${new Date(days[50]).toISOString().slice(0, 10)} -> ${new Date(days[days.length - 1]).toISOString().slice(0, 10)}`,
);
console.log(
  `Bonferroni alpha=${BONFERRONI.toExponential(2)} over 8 scored cells (lo_all is a sanity arm)\n`,
);
console.log(
  'signal         h   n   fee    strat/prd  basket/prd  EXCESS/prd   95% CI            p       halves         COMPOUNDED      verdict',
);
console.log('-'.repeat(132));

const passes = [];
for (const name of Object.keys(SIGNALS)) {
  for (const h of HORIZONS) {
    for (const [tier, feeBps] of Object.entries(FEES_BPS)) {
      const { stratRets, baseRets } = run(name, h, feeBps);
      const st = bootstrapExcess(stratRets, baseRets);
      if (st === null) {
        console.log(`${name.padEnd(14)} ${String(h).padEnd(3)} —   ${tier} too few periods`);
        continue;
      }
      let verdict;
      if (name === 'lo_all') {
        // The sanity arm holds the benchmark's own weights, so its GROSS return must equal the
        // benchmark exactly — but it still pays turnover fees the benchmark does not. So the
        // correct check is "identical up to fee drag, and drag can only be negative", not
        // "identical". (Recorded because the first run asserted |excess| < 1e-9 and flagged
        // SANITY-FAIL: the assertion was mis-specified, the harness was right. Confirmed by the
        // drag scaling with the tier — taker 1448.56% vs maker 1451.21% against a 1451.87%
        // benchmark.)
        const dragBound = feeBps / 10_000;
        verdict = st.excess <= 0 && Math.abs(st.excess) < dragBound ? 'SANITY-OK' : 'SANITY-FAIL';
      } else if (st.n < MIN_PERIODS) verdict = 'DESCRIPTIVE (n<12)';
      else if (st.excess <= 0) verdict = 'FAIL';
      else if (st.p >= BONFERRONI) verdict = 'FAIL-p';
      else if (st.firstHalf <= 0 || st.secondHalf <= 0) verdict = 'FAIL-halves';
      else verdict = tier === 'taker' ? 'PASS' : 'FEE-TIER-DEPENDENT';
      if (verdict === 'PASS') passes.push(`${name}@h${h}`);
      console.log(
        `${name.padEnd(14)} ${String(h).padEnd(3)} ${String(st.n).padEnd(3)} ${tier.padEnd(6)} ` +
          `${pct(mean(stratRets)).padStart(8)}%  ${pct(mean(baseRets)).padStart(9)}%  ` +
          `${pct(st.excess).padStart(9)}%  [${pct(st.lo).padStart(6)},${pct(st.hi).padStart(6)}] ` +
          `${st.p.toFixed(4).padStart(6)}  ${pct(st.firstHalf).padStart(6)}/${pct(st.secondHalf).padStart(6)}  ` +
          `${pct(compound(stratRets)).padStart(8)}%vs${pct(compound(baseRets)).padStart(8)}%  ${verdict}`,
      );
    }
  }
}
console.log('-'.repeat(132));
console.log(
  passes.length === 0
    ? '\nVERDICT: NO LONG-ONLY OVERLAY BEATS HOLDING at the live fee tier.'
    : `\nVERDICT: ${passes.length} cell(s) beat holding: ${passes.join(', ')}`,
);
