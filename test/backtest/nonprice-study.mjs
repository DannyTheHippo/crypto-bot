// Forward-return study for the non-price channels preregistered in
// research/studies/nonprice-channels-2026-07-27.md. Pure offline computation over cached series —
// no network, no LLM, no money path. Reports EVERY cell, winners and losers.
//
//   node test/backtest/nonprice-study.mjs
//
// Method, all fixed by the preregistration:
//   - 9 signals x 3 horizons (+1/+3/+7 daily bars) = 27 cells; Bonferroni alpha = 0.05/27 = 1.85e-3
//   - time-series terciles per asset, pooled across the channel's assets; spread = top - bottom
//   - 20 bps round-trip hurdle; a significant spread under the fee is a NEGATIVE result
//   - chronological split: first 60% in-sample, last 40% holdout, holdout read only for a cell that
//     already passed in-sample
//   - 7-day BLOCK bootstrap (2000 draws) for CIs and p-values: forward windows at h=3 and h=7
//     overlap, so naive i.i.d. standard errors would be meaningless

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const DAY = 86_400_000;
const HORIZONS = [1, 3, 7];
const Z_WINDOW = 90;
const N_BOOT = 2000;
const BLOCK_DAYS = 7;
const BONFERRONI = 0.05 / 27;
const FEE_BPS = 20;
const IN_SAMPLE_FRAC = 0.6;

// Wikipedia traffic floor, fixed in the preregistration before any return was joined.
const WIKI_ASSETS = ['BTC', 'ETH', 'SOL', 'DOGE', 'ZEC', 'LTC', 'ADA', 'BCH', 'UNI', 'LINK'];
const WIKI_EXCLUDED = ['AAVE', 'TRX', 'DOT', 'XRP', 'NEAR', 'AVAX'];

// ── deterministic RNG so a rerun reproduces the same bootstrap ────────────────
let seed = 20260727;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const mean = (a) => (a.length === 0 ? NaN : a.reduce((s, x) => s + x, 0) / a.length);

function dailyCloses(asset) {
  const path = join(DATA, `ohlcv-${asset}USDT-1d.json`);
  if (!existsSync(path)) return null;
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  const m = new Map();
  for (const r of rows) m.set(Math.floor(r[0] / DAY) * DAY, Number(r[4]));
  return m;
}

/** Trailing z-score: uses days strictly BEFORE i plus i itself, never anything after. */
function trailingZ(values, i, win) {
  const lo = Math.max(0, i - win + 1);
  const w = values.slice(lo, i + 1).filter((v) => Number.isFinite(v));
  if (w.length < Math.floor(win / 3)) return NaN;
  const mu = mean(w);
  const sd = Math.sqrt(mean(w.map((v) => (v - mu) ** 2)));
  return sd === 0 ? NaN : (w[w.length - 1] - mu) / sd;
}

/**
 * One observation per (asset, day): the signal known at that day's close, and the forward return
 * over the next h days. `lagDays` shifts the signal back for channels whose data is only PUBLISHED
 * after the day ends (Wikipedia) — using same-day views would be look-ahead.
 */
function buildObservations(assetSeries, closes, horizon, lagDays) {
  const days = [...assetSeries.keys()].sort((a, b) => a - b);
  const raw = days.map((d) => assetSeries.get(d));
  const obs = [];
  for (let i = 0; i < days.length; i += 1) {
    const si = i - lagDays;
    if (si < 0) continue;
    const day = days[i];
    const c0 = closes.get(day);
    const c1 = closes.get(day + horizon * DAY);
    if (!Number.isFinite(c0) || !Number.isFinite(c1) || c0 <= 0) continue;
    obs.push({ day, raw, si, fwdBps: ((c1 - c0) / c0) * 10_000 });
  }
  return obs;
}

/** Block bootstrap over 7-day blocks: p and CI for a tercile long-short spread. */
function blockBootstrap(rows) {
  if (rows.length < 30) return null;
  const byBlock = new Map();
  for (const r of rows) {
    const b = Math.floor(r.day / (BLOCK_DAYS * DAY));
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push(r);
  }
  const blocks = [...byBlock.values()];
  if (blocks.length < 8) return null;

  const spreadOf = (rs) => {
    const sorted = [...rs].sort((a, b) => a.sig - b.sig);
    const k = Math.floor(sorted.length / 3);
    if (k < 3) return NaN;
    return (
      mean(sorted.slice(-k).map((r) => r.fwdBps)) - mean(sorted.slice(0, k).map((r) => r.fwdBps))
    );
  };

  const observed = spreadOf(rows);
  if (!Number.isFinite(observed)) return null;

  const draws = [];
  for (let b = 0; b < N_BOOT; b += 1) {
    const picked = [];
    for (let i = 0; i < blocks.length; i += 1) picked.push(...blocks[(rand() * blocks.length) | 0]);
    const s = spreadOf(picked);
    if (Number.isFinite(s)) draws.push(s);
  }
  draws.sort((a, b) => a - b);
  const q = (p) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))];
  const negFrac = draws.filter((d) => d <= 0).length / draws.length;
  return {
    n: rows.length,
    blocks: blocks.length,
    spread: observed,
    lo: q(0.025),
    hi: q(0.975),
    p: 2 * Math.min(negFrac, 1 - negFrac),
  };
}

// ── signal builders ──────────────────────────────────────────────────────────
function wikiSignals() {
  const out = [];
  for (const asset of WIKI_ASSETS) {
    const path = join(DATA, `nonprice-wiki-${asset}.json`);
    const closes = dailyCloses(asset);
    if (!existsSync(path) || closes === null) continue;
    const { series } = JSON.parse(readFileSync(path, 'utf8'));
    const m = new Map(series.map((p) => [p.ts, Math.log(Math.max(1, p.views))]));
    out.push({ asset, series: m, closes });
  }
  return out;
}

function dvolSignals() {
  const out = [];
  for (const [ccy, asset] of [
    ['BTC', 'BTC'],
    ['ETH', 'ETH'],
  ]) {
    const path = join(DATA, `nonprice-dvol-${ccy}.json`);
    const closes = dailyCloses(asset);
    if (!existsSync(path) || closes === null) continue;
    const { series } = JSON.parse(readFileSync(path, 'utf8'));
    // hourly -> daily close: the last observation inside each UTC day
    const daily = new Map();
    for (const p of series) daily.set(Math.floor(p.ts / DAY) * DAY, p.close);
    out.push({ asset, series: daily, closes });
  }
  return out;
}

function gdeltSignals(key) {
  const path = join(DATA, `nonprice-gdelt-bitcoin.json`);
  if (!existsSync(path)) return [];
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const rows = j[key] ?? [];
  if (rows.length === 0) return [];
  // sub-daily -> daily mean
  const buckets = new Map();
  for (const p of rows) {
    const d = Math.floor(p.ts / DAY) * DAY;
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(p.value);
  }
  const daily = new Map([...buckets.entries()].map(([d, vs]) => [d, mean(vs)]));
  const out = [];
  for (const asset of ['BTC', 'ETH']) {
    const closes = dailyCloses(asset);
    if (closes !== null) out.push({ asset, series: daily, closes });
  }
  return out;
}

// ── cells ────────────────────────────────────────────────────────────────────
// `mode` z = trailing z-score of the level; d = 1-day change of the level.
const CELLS = [
  { id: 'tone_z', channel: 'GDELT', build: () => gdeltSignals('tone'), mode: 'z', lag: 0 },
  { id: 'tone_d', channel: 'GDELT', build: () => gdeltSignals('tone'), mode: 'd', lag: 0 },
  { id: 'vol_z', channel: 'GDELT', build: () => gdeltSignals('vol'), mode: 'z', lag: 0 },
  { id: 'vol_d', channel: 'GDELT', build: () => gdeltSignals('vol'), mode: 'd', lag: 0 },
  { id: 'views_z', channel: 'Wikipedia', build: wikiSignals, mode: 'z', lag: 1 },
  { id: 'views_d', channel: 'Wikipedia', build: wikiSignals, mode: 'd', lag: 1 },
  { id: 'dvol_z', channel: 'DVOL', build: dvolSignals, mode: 'z', lag: 0 },
  { id: 'dvol_d', channel: 'DVOL', build: dvolSignals, mode: 'd', lag: 0 },
  { id: 'vrp', channel: 'DVOL', build: dvolSignals, mode: 'vrp', lag: 0 },
];

function rowsFor(cell, horizon) {
  const rows = [];
  for (const { asset, series, closes } of cell.build()) {
    const obs = buildObservations(series, closes, horizon, cell.lag);
    for (const o of obs) {
      const { raw, si } = o;
      let sig;
      if (cell.mode === 'z') sig = trailingZ(raw, si, Z_WINDOW);
      else if (cell.mode === 'd') sig = si > 0 ? raw[si] - raw[si - 1] : NaN;
      else {
        // vrp: implied (DVOL, annualised %) minus trailing 30d realized vol of the same asset,
        // annualised the same way — the classic variance-risk-premium construction.
        const days = [...closes.keys()].sort((a, b) => a - b);
        const idx = days.indexOf(o.day);
        if (idx < 31) sig = NaN;
        else {
          const rets = [];
          for (let k = idx - 30; k < idx; k += 1) {
            const a = closes.get(days[k]);
            const b = closes.get(days[k + 1]);
            if (a > 0 && b > 0) rets.push(Math.log(b / a));
          }
          const mu = mean(rets);
          const rv = Math.sqrt(mean(rets.map((r) => (r - mu) ** 2))) * Math.sqrt(365) * 100;
          sig = Number.isFinite(raw[si]) ? raw[si] - rv : NaN;
        }
      }
      if (Number.isFinite(sig)) rows.push({ asset, day: o.day, sig, fwdBps: o.fwdBps });
    }
  }
  return rows.sort((a, b) => a.day - b.day);
}

// ── run ──────────────────────────────────────────────────────────────────────
console.log(
  'Non-price channel study — preregistered research/studies/nonprice-channels-2026-07-27.md',
);
console.log(`Bonferroni alpha=${BONFERRONI.toExponential(2)} over 27 cells | hurdle ${FEE_BPS}bps`);
console.log(`Wikipedia excluded on the traffic floor: ${WIKI_EXCLUDED.join(', ')}\n`);
console.log(
  'channel     signal    h   n     blk  IS-spread    95% CI              p        holdout    verdict',
);
console.log('-'.repeat(104));

const passed = [];
for (const cell of CELLS) {
  for (const h of HORIZONS) {
    const all = rowsFor(cell, h);
    if (all.length < 60) {
      console.log(
        `${cell.channel.padEnd(11)} ${cell.id.padEnd(9)} ${String(h).padEnd(3)} ${String(all.length).padEnd(5)} ` +
          `-    NO DATA`,
      );
      continue;
    }
    const cut = all[Math.floor(all.length * IN_SAMPLE_FRAC)].day;
    const inSample = all.filter((r) => r.day <= cut);
    const holdout = all.filter((r) => r.day > cut);

    const is = blockBootstrap(inSample);
    if (is === null) {
      console.log(
        `${cell.channel.padEnd(11)} ${cell.id.padEnd(9)} ${String(h).padEnd(3)} — too few blocks`,
      );
      continue;
    }
    const clearsFee = Math.abs(is.spread) > FEE_BPS;
    const clearsP = is.p < BONFERRONI;
    let holdoutTxt = '—';
    let verdict = 'FAIL';
    if (clearsFee && clearsP) {
      const ho = blockBootstrap(holdout);
      if (ho !== null) {
        holdoutTxt = `${ho.spread.toFixed(1)}bps`;
        const sameSign = Math.sign(ho.spread) === Math.sign(is.spread);
        verdict = sameSign && Math.abs(ho.spread) > FEE_BPS ? 'PASS' : 'FAIL-HOLDOUT';
      }
    }
    if (verdict === 'PASS') passed.push({ cell: cell.id, h });
    console.log(
      `${cell.channel.padEnd(11)} ${cell.id.padEnd(9)} ${String(h).padEnd(3)} ` +
        `${String(is.n).padEnd(5)} ${String(is.blocks).padEnd(4)} ` +
        `${is.spread.toFixed(1).padStart(9)}bps [${is.lo.toFixed(0).padStart(6)},${is.hi.toFixed(0).padStart(6)}] ` +
        `${is.p.toFixed(4).padStart(7)}  ${holdoutTxt.padStart(9)}  ${verdict}`,
    );
  }
}

console.log('-'.repeat(104));
console.log(
  passed.length === 0
    ? '\nVERDICT: NO CHANNEL PASSES. Zero cells cleared fee + Bonferroni + holdout.'
    : `\nVERDICT: ${passed.length} cell(s) passed: ${passed.map((p) => `${p.cell}@h${p.h}`).join(', ')}`,
);
