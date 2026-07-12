// Family B sweep: Fear & Greed sentiment (2026-07-12 non-price search). Pre-registered grid — see
// reports/loop/nonprice-sweep-2026-07-12.md for the rationale behind every reduction from the task
// brief (variant (ii) fixes the base cross-sectional rule to the exact frontier cell
// candidates/cross-sectional-2026-07-12.json identified, k=20/m=2/h=6/dir=ls, plus a k=10 robustness
// check, rather than re-sweeping the full 320-cell base grid).
// Dumps RAW per-cell metrics only (no gate/DSR here) — gating uses a pooled honest-N benchmark
// computed once across both non-price families by nonprice-gate.mjs.
//
//   node test/backtest/multi-strategy/fng-sweep.mjs --out <file.json>

import { writeFileSync } from 'node:fs';
import { loadOhlcv, simulate, annualizedSharpe, maxDrawdown, totalReturn } from './engine.mjs';
import {
  loadFng,
  alignFngToBars,
  fngContrarianPositions,
  fngMomentumPositions,
  gateWeights,
} from './fng-signal.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('--out', null);

// ── Pre-registered grid (locked before running) ───────────────────────────────────────────────────
// (i)/(iii) trade each major individually against the perp price series (shorts require perps);
// (ii) reuses cross-sectional.mjs's SPOT universe (its exact prior setup) with an F&G regime gate.
const SYMBOLS_PERP = ['BTCUSDTUSDT', 'ETHUSDTUSDT', 'SOLUSDTUSDT', 'XRPUSDTUSDT', 'LINKUSDTUSDT'];
const SYMBOLS_SPOT = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'LINKUSDT'];
const FEE_BPS = 3.6; // perp maker + BNB, same rationale as funding-sweep.mjs
const HOLDOUT = 0.3;
const WF_SEGMENTS = 3;

const LO_GRID = [15, 20, 25];
const HI_GRID = [75, 80, 85];
const HOLD_GRID = [5, 10, 'reversion'];
const DELTA_GRID = [1, 3, 5];

// Variant (ii): the exact frontier cell (k=20) plus one robustness param (k=10), both from
// candidates/cross-sectional-2026-07-12.json's top-ranked cells; m/h/dir held fixed at that cell's
// values (m=2 top/bottom, h=6-bar rebalance, dir='ls').
const GATE_K_GRID = [10, 20];
const GATE_M = 2;
const GATE_H = 6;
const GATE_DIR = 'ls';
const GATE_BANDS = [
  { name: 'baseline', lo: 0, hi: 100 },
  { name: 'fear-only', lo: 0, hi: 40 },
  { name: 'greed-only', lo: 60, hi: 100 },
  { name: 'extreme-fear', lo: 0, hi: 25 },
  { name: 'extreme-greed', lo: 75, hi: 100 },
  { name: 'neutral', lo: 30, hi: 70 },
];

function segSign(a) {
  const m = a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return m > 0 ? 1 : m < 0 ? -1 : 0;
}
function wfConsistent(r) {
  const whole = segSign(r);
  if (whole === 0) return false;
  const seg = Math.floor(r.length / WF_SEGMENTS);
  if (seg < 2) return false;
  for (let i = 0; i < WF_SEGMENTS; i += 1) {
    const slice = r.slice(i * seg, i === WF_SEGMENTS - 1 ? undefined : (i + 1) * seg);
    if (segSign(slice) !== whole) return false;
  }
  return true;
}

function scoreSingleSymbol(bars, positions, meta) {
  const holdoutStart = Math.floor(bars.length * (1 - HOLDOUT));
  const sim = simulate(bars, positions, FEE_BPS);
  const holdoutReturns = sim.netReturns.slice(holdoutStart);
  const holdoutSim = simulate(bars.slice(holdoutStart), positions.slice(holdoutStart), FEE_BPS);
  const stats = annualizedSharpe(holdoutReturns, '1d');
  const tot = totalReturn(holdoutReturns);
  const rt = holdoutSim.roundTrips;
  return {
    ...meta,
    roundTrips: rt,
    winRate: rt > 0 ? holdoutSim.wins / rt : 0,
    totalReturnPct: tot * 100,
    netBpsPerRt: rt > 0 ? (tot / rt) * 10000 : 0,
    sharpe: stats.sharpe,
    skew: stats.skew,
    kurt: stats.kurt,
    maxDdPct: maxDrawdown(holdoutReturns) * 100,
    T: holdoutReturns.length,
    wfConsistent: wfConsistent(holdoutReturns),
  };
}

const cells = [];
const fngRows = loadFng();

// ── Variants (i) contrarian, (iii) momentum: per-symbol, perp daily bars ─────────────────────────
for (const symbol of SYMBOLS_PERP) {
  let bars;
  try {
    bars = loadOhlcv(symbol, '1d');
  } catch {
    continue;
  }
  const fng = alignFngToBars(bars, fngRows);

  for (const lo of LO_GRID) {
    for (const hi of HI_GRID) {
      for (const hold of HOLD_GRID) {
        const positions = fngContrarianPositions(bars, fng, { lo, hi, hold });
        cells.push(
          scoreSingleSymbol(bars, positions, {
            variant: 'contrarian',
            symbol,
            tf: '1d',
            lo,
            hi,
            hold: String(hold),
            feeBps: FEE_BPS,
          }),
        );
      }
    }
  }

  for (const deltaN of DELTA_GRID) {
    for (const hold of HOLD_GRID) {
      const positions = fngMomentumPositions(bars, fng, { deltaN, hold });
      cells.push(
        scoreSingleSymbol(bars, positions, {
          variant: 'momentum',
          symbol,
          tf: '1d',
          deltaN,
          hold: String(hold),
          feeBps: FEE_BPS,
        }),
      );
    }
  }
}

// ── Variant (ii): F&G regime gate over the prior cross-sectional momentum frontier ───────────────
function alignByTimestamp(symbols) {
  const perSym = {};
  for (const s of symbols) {
    try {
      perSym[s] = loadOhlcv(s, '1d');
    } catch {
      /* skip missing */
    }
  }
  const present = Object.keys(perSym);
  const tsSets = present.map((s) => new Set(perSym[s].map((b) => b.t)));
  const common = [...tsSets[0]]
    .filter((t) => tsSets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned = {};
  for (const s of present) aligned[s] = perSym[s].filter((b) => cs.has(b.t));
  return { aligned, symbols: present, len: common.length };
}

const gateAl = alignByTimestamp(SYMBOLS_SPOT);
if (gateAl && gateAl.symbols.length >= 3) {
  const { aligned, symbols, len } = gateAl;
  const K = symbols.length;
  const opens = symbols.map((s) => aligned[s].map((b) => b.o));
  const closes = symbols.map((s) => aligned[s].map((b) => b.c));
  const refBars = aligned[symbols[0]];
  const fngAligned = alignFngToBars(refBars, fngRows);
  const holdoutStart = Math.floor(len * (1 - HOLDOUT));

  for (const k of GATE_K_GRID) {
    for (const band of GATE_BANDS) {
      const feeLeg = FEE_BPS / 2 / 10000;
      let weights = new Array(K).fill(0);
      let roundTrips = 0;
      const net = [];
      for (let t = k; t < len - 2; t += 1) {
        let turnoverCost = 0;
        if ((t - k) % GATE_H === 0) {
          const rets = symbols.map((_, si) => closes[si][t] / closes[si][t - k] - 1);
          const order = rets.map((r, si) => ({ r, si })).sort((a, b) => b.r - a.r);
          let newW = new Array(K).fill(0);
          for (let j = 0; j < GATE_M; j += 1) newW[order[j].si] = 1 / GATE_M;
          if (GATE_DIR === 'ls') {
            for (let j = 0; j < GATE_M; j += 1) newW[order[K - 1 - j].si] = -1 / GATE_M;
          }
          newW = gateWeights(newW, fngAligned[t], band.lo, band.hi);
          let turnover = 0;
          for (let si = 0; si < K; si += 1) turnover += Math.abs(newW[si] - weights[si]);
          roundTrips += Math.round(turnover);
          turnoverCost = turnover * feeLeg;
          weights = newW;
        }
        let gross = 0;
        for (let si = 0; si < K; si += 1) {
          const on = opens[si][t + 1];
          const oa = opens[si][t + 2];
          if (on > 0 && Number.isFinite(oa)) gross += weights[si] * (oa / on - 1);
        }
        net.push(gross - turnoverCost);
      }
      const holdout = net.slice(holdoutStart); // same offset convention as cross-sectional.mjs
      const stats = annualizedSharpe(holdout, '1d');
      const tot = totalReturn(holdout);
      const holdoutRt = Math.round(roundTrips * HOLDOUT);
      cells.push({
        variant: 'gate',
        band: band.name,
        bandLo: band.lo,
        bandHi: band.hi,
        tf: '1d',
        k,
        m: GATE_M,
        h: GATE_H,
        dir: GATE_DIR,
        feeBps: FEE_BPS,
        roundTrips: holdoutRt,
        totalReturnPct: tot * 100,
        netBpsPerRt: holdoutRt > 0 ? (tot / holdoutRt) * 10000 : 0,
        sharpe: stats.sharpe,
        skew: stats.skew,
        kurt: stats.kurt,
        maxDdPct: maxDrawdown(holdout) * 100,
        T: holdout.length,
        wfConsistent: wfConsistent(holdout),
      });
    }
  }
}

// eslint-disable-next-line no-console
console.log(`Family B (F&G): ${cells.length} cells`);
const byVariant = new Map();
for (const c of cells) byVariant.set(c.variant, (byVariant.get(c.variant) ?? 0) + 1);
for (const [v, n] of byVariant) console.log(`  ${v}: ${n} cells`); // eslint-disable-line no-console

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        family: 'fng',
        config: {
          symbolsPerp: SYMBOLS_PERP,
          symbolsSpot: SYMBOLS_SPOT,
          loGrid: LO_GRID,
          hiGrid: HI_GRID,
          holdGrid: HOLD_GRID,
          deltaGrid: DELTA_GRID,
          gateKGrid: GATE_K_GRID,
          gateM: GATE_M,
          gateH: GATE_H,
          gateDir: GATE_DIR,
          gateBands: GATE_BANDS,
          feeBps: FEE_BPS,
          holdout: HOLDOUT,
        },
        cells,
      },
      null,
      1,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUT}`);
}
