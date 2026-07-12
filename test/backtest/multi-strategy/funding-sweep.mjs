// Family A sweep: funding-conditioned direction (2026-07-12 non-price search). Pre-registered grid —
// see reports/loop/nonprice-sweep-2026-07-12.md for the rationale behind every reduction from the
// task brief's raw cross-product (paired smoothing/hold instead of a full 3x3, one fee level).
// Dumps RAW per-cell metrics only (no gate/DSR here) — gating uses a pooled honest-N benchmark
// computed once across both non-price families by nonprice-gate.mjs.
//
//   node test/backtest/multi-strategy/funding-sweep.mjs --out <file.json>

import { writeFileSync } from 'node:fs';
import {
  loadOhlcv,
  simulateWithFunding,
  attachFundingToBars,
  annualizedSharpe,
  maxDrawdown,
  totalReturn,
} from './engine.mjs';
import { donchian, tsmom } from './strategies.mjs';
import { loadFunding, fundingSignalSeries, fundingPositions, fundingGatedTrend } from './funding-signal.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('--out', null);

// ── Pre-registered grid (locked before running) ───────────────────────────────────────────────────
const SYMBOLS = ['BTCUSDTUSDT', 'ETHUSDTUSDT', 'SOLUSDTUSDT', 'XRPUSDTUSDT', 'LINKUSDTUSDT'];
const TFS = ['1h', '4h'];
const T_GRID = [0.05, 0.1, 0.2]; // annualized funding threshold
const FEE_BPS = 3.6; // perp maker + BNB — the only venue that can hold the short leg
const HOLDOUT = 0.3;
const WF_SEGMENTS = 3;

// Variants (i)/(ii): smoothing and hold are PAIRED, not fully crossed (3x3=9 -> 3), to keep the grid
// in the low hundreds per the task's pre-registration cap. Pairing rationale: a 1-event (noisiest)
// smoothed signal reacts fastest, so paired with the fastest exit ('flip'); a 9-event (smoothest,
// slowest) signal is paired with the longest fixed hold (24 bars) — the pairing spans fast<->slow
// consistently rather than crossing every combination.
const SMOOTH_HOLD_PAIRS = [
  { smooth: 1, hold: 'flip' },
  { smooth: 3, hold: 8 },
  { smooth: 9, hold: 24 },
];
const MODES = ['contrarian', 'momentum'];

// Variant (iii): funding-extreme gate over a plain trend rule. Two base rules (both long/long-short
// capable), T grid shared with (i)/(ii), dir swept since the base rule itself is directional.
const BASE_RULES = [
  { kind: 'donchian', fn: donchian, params: { n: 20 } },
  { kind: 'tsmom', fn: tsmom, params: { lookback: 20 } },
];
const DIRS = ['long', 'ls'];

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

function scoreCell(bars, positions, fundingMap, meta) {
  const holdoutStart = Math.floor(bars.length * (1 - HOLDOUT));
  const sim = simulateWithFunding(bars, positions, FEE_BPS, fundingMap);
  const holdoutReturns = sim.netReturns.slice(holdoutStart);
  const holdoutSim = simulateWithFunding(
    bars.slice(holdoutStart),
    positions.slice(holdoutStart),
    FEE_BPS,
    // Funding indices are absolute to the FULL bars array; re-key them relative to the holdout slice.
    new Map([...fundingMap].map(([k, v]) => [k - holdoutStart, v]).filter(([k]) => k >= 0)),
  );
  const stats = annualizedSharpe(holdoutReturns, meta.tf);
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

for (const symbol of SYMBOLS) {
  for (const tf of TFS) {
    let bars;
    let fundingRows;
    try {
      bars = loadOhlcv(symbol, tf);
      fundingRows = loadFunding(symbol);
    } catch {
      continue; // missing cache for this symbol/tf combo
    }
    const fundingMap = attachFundingToBars(bars, fundingRows);

    // Variants (i) contrarian, (ii) momentum.
    for (const { smooth, hold } of SMOOTH_HOLD_PAIRS) {
      const signal = fundingSignalSeries(bars, fundingMap, smooth);
      for (const mode of MODES) {
        for (const T of T_GRID) {
          const positions = fundingPositions(bars, signal, { T, mode, hold });
          cells.push(
            scoreCell(bars, positions, fundingMap, {
              variant: mode,
              symbol,
              tf,
              thresholdAnnualized: T,
              smooth,
              hold: String(hold),
              feeBps: FEE_BPS,
            }),
          );
        }
      }
    }

    // Variant (iii) funding-extreme gate over a plain trend rule.
    const gateSmoothN = 3; // fixed mid-smoothing for the gate signal (not swept — a veto, not a bet)
    const gateSignal = fundingSignalSeries(bars, fundingMap, gateSmoothN);
    for (const rule of BASE_RULES) {
      for (const dir of DIRS) {
        const basePositions = rule.fn(bars, rule.params, dir);
        for (const T of T_GRID) {
          const positions = fundingGatedTrend(basePositions, gateSignal, T);
          cells.push(
            scoreCell(bars, positions, fundingMap, {
              variant: 'gate',
              baseRule: `${rule.kind}(${Object.values(rule.params).join(',')})`,
              dir,
              symbol,
              tf,
              thresholdAnnualized: T,
              feeBps: FEE_BPS,
            }),
          );
        }
      }
    }
  }
}

// eslint-disable-next-line no-console
console.log(`Family A (funding): ${cells.length} cells`);
const byVariant = new Map();
for (const c of cells) byVariant.set(c.variant, (byVariant.get(c.variant) ?? 0) + 1);
for (const [v, n] of byVariant) console.log(`  ${v}: ${n} cells`); // eslint-disable-line no-console

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        family: 'funding',
        config: {
          symbols: SYMBOLS,
          tfs: TFS,
          tGrid: T_GRID,
          smoothHoldPairs: SMOOTH_HOLD_PAIRS,
          modes: MODES,
          baseRules: BASE_RULES.map((r) => ({ kind: r.kind, params: r.params })),
          dirs: DIRS,
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
