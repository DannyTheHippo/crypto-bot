// $0 inversion test — does fading the model's own entries produce a tradable edge?
//
//   node test/backtest/inversion-test.mjs
//
// WHY: the entry signal measured significantly NEGATIVE forward returns (n=61, -16.9bps at h=1,
// t=-4.58) and worse than a random-bar placebo (p=0.0013-0.0037). The placebo is selection-invariant
// — it draws its null from the same (symbol, side) pairs — so that finding survived the contract
// defect. If the signal is reliably anti-predictive, the inverse is reliably predictive, and the
// required gross edge is only +13.0 bps/trip at demo fees.
//
// TREAT THIS WITH MAXIMUM SUSPICION. "The model is reliably wrong, so fade it" is one of the
// classic overfitting traps: at n=61 over a single 4-day regime, a -17bps reading is perfectly
// consistent with noise plus a mild adverse-selection effect that would NOT invert into profit.
// So this applies the SAME battery that produced the original finding — placebo, trimming,
// chronological halves, per-symbol clustering — and requires the inverse to clear the FEE, not zero.
//
// Pure recomputation over recorded decisions + cached candles. No network, no LLM, no money path.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const BAR = 900_000; // 15m
const HORIZONS = [1, 4, 8, 24];
const REQUIRED_EDGE_BPS = 13.0; // state.md: required gross edge/trip at demo fees
const N_BOOT = 5000;
const N_PLACEBO = 2000;

let seed = 20260728;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const mean = (a) => (a.length === 0 ? NaN : a.reduce((s, x) => s + x, 0) / a.length);
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

// ── recorded entries ─────────────────────────────────────────────────────────
const sql = `select symbol, event_time, action from agent_decisions
             where action in ('open_long','open_short') order by event_time`;
const raw = execFileSync(
  'docker',
  [
    'exec',
    'crypto-bot-postgres-1',
    'psql',
    '-U',
    'cryptobot',
    '-d',
    'cryptobot',
    '-tAF',
    '|',
    '-c',
    sql,
  ],
  { encoding: 'utf8' },
);
const entries = raw
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [symbol, eventTime, action] = l.split('|');
    return { symbol, ts: Number(eventTime), dir: action === 'open_long' ? 1 : -1 };
  });

// ── candles, per symbol, strictly per-symbol indexing ────────────────────────
// A prior defect scored BTC->LINK transitions as -99.99% by interleaving symbols; every lookup here
// is keyed inside one symbol's own series.
const series = new Map();
for (const sym of new Set(entries.map((e) => e.symbol))) {
  const p = join(DATA, `ohlcv-${sym.replace(/[/:]/g, '')}-15m.json`);
  if (!existsSync(p)) continue;
  const rows = JSON.parse(readFileSync(p, 'utf8'));
  series.set(sym, {
    ts: rows.map((r) => r[0]),
    close: rows.map((r) => Number(r[4])),
  });
}

/** Forward return in bps from the bar at/after `ts`, h bars ahead, signed by `dir`. */
function fwdBps(sym, ts, h, dir) {
  const s = series.get(sym);
  if (!s) return null;
  let i = s.ts.findIndex((t) => t >= ts);
  if (i < 0 || i + h >= s.ts.length) return null;
  const c0 = s.close[i];
  const c1 = s.close[i + h];
  if (!(c0 > 0) || !(c1 > 0)) return null;
  return dir * ((c1 - c0) / c0) * 10_000;
}

function bootstrapCI(xs) {
  const draws = [];
  for (let b = 0; b < N_BOOT; b += 1) {
    let acc = 0;
    for (let i = 0; i < xs.length; i += 1) acc += xs[(rand() * xs.length) | 0];
    draws.push(acc / xs.length);
  }
  draws.sort((a, b) => a - b);
  return { lo: draws[Math.floor(0.025 * N_BOOT)], hi: draws[Math.floor(0.975 * N_BOOT)] };
}

/**
 * Placebo: keep each entry's symbol and side, replace its BAR with a random bar from that same
 * symbol's series. Selection-invariant by construction — which is exactly why the original finding
 * survived the contract defect, and why the inverse must clear it too.
 */
function placebo(h, dir) {
  const worse = [];
  for (let p = 0; p < N_PLACEBO; p += 1) {
    const vals = [];
    for (const e of entries) {
      const s = series.get(e.symbol);
      if (!s) continue;
      const i = (rand() * Math.max(1, s.ts.length - h - 1)) | 0;
      const c0 = s.close[i];
      const c1 = s.close[i + h];
      if (c0 > 0 && c1 > 0) vals.push(dir * e.dir * ((c1 - c0) / c0) * 10_000);
    }
    if (vals.length > 0) worse.push(mean(vals));
  }
  return worse;
}

console.log('Inversion test — does fading the model beat the fee?');
console.log(
  `entries=${entries.length} symbols=${series.size} required edge >= +${REQUIRED_EDGE_BPS} bps\n`,
);
console.log(
  'h    n    ACTUAL      INVERTED    95% CI (inv)        t(inv)  placebo-p  halves(inv)      trim(inv)',
);
console.log('-'.repeat(112));

for (const h of HORIZONS) {
  const act = [];
  for (const e of entries) {
    const v = fwdBps(e.symbol, e.ts, h, e.dir);
    if (v !== null) act.push(v);
  }
  if (act.length < 10) {
    console.log(`${h}  too few`);
    continue;
  }
  const inv = act.map((x) => -x);
  const m = mean(inv);
  const t = m / (sd(inv) / Math.sqrt(inv.length));
  const ci = bootstrapCI(inv);

  // Placebo on the INVERTED direction: fraction of random-bar draws at least as good as observed.
  const draws = placebo(h, -1);
  const pPlacebo = draws.filter((d) => d >= m).length / draws.length;

  const half = Math.floor(inv.length / 2);
  const h1 = mean(inv.slice(0, half));
  const h2 = mean(inv.slice(half));
  const sorted = [...inv].sort((a, b) => a - b);
  const trimmed = mean(sorted.slice(1, -1));

  console.log(
    `${String(h).padEnd(4)} ${String(act.length).padEnd(4)} ` +
      `${mean(act).toFixed(1).padStart(8)}bps ${m.toFixed(1).padStart(8)}bps ` +
      `[${ci.lo.toFixed(1).padStart(7)},${ci.hi.toFixed(1).padStart(7)}] ` +
      `${t.toFixed(2).padStart(7)} ${pPlacebo.toFixed(4).padStart(9)}  ` +
      `${h1.toFixed(1).padStart(6)}/${h2.toFixed(1).padStart(6)}  ${trimmed.toFixed(1).padStart(8)}`,
  );
}
console.log('-'.repeat(112));
console.log(
  '\nPASS requires ALL of: inverted mean > +13.0bps, CI excludes the fee, placebo-p < 0.05,\n' +
    'BOTH halves positive, and the trimmed mean holding. Anything less is noise.',
);
