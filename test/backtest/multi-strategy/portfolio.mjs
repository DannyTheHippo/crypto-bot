// Portfolio trend backtest (2026-07-12). The broad sweep (sweep.mjs) flagged Donchian long-short
// trend as the fee-surviving, walk-forward-consistent frontier family — but every single-symbol cell
// failed the 682-trial deflation. This tests the creative hypothesis the broad sweep could not: a
// DIVERSIFIED PORTFOLIO. A real trend fund runs a basket, not one symbol — idiosyncratic noise
// diversifies away and the portfolio Sharpe rises well above any single leg's, while the honest-N
// penalty here is realistic (a SMALL pre-registered grid, ~15 trials, not 682).
//
//   node test/backtest/multi-strategy/portfolio.mjs [--out <file.json>]
//
// Honest protocol (same discipline as sweep.mjs): last 30% is the out-of-sample holdout; ALL metrics
// come from it; deflated Sharpe uses the winsorized variance of THIS grid's trial Sharpes; a
// survivor needs holdout Sharpe deflating to DSR≥0.95 AND walk-forward sign-consistency across 3
// holdout sub-segments. SELECTION-BIAS CAVEAT stated in the output: Donchian was chosen because the
// broad sweep surfaced it, so a fully-clean confirmation is forward/paper — this is a strong lead,
// not a certified edge.

import { writeFileSync } from 'node:fs';
import {
  loadOhlcv,
  annualizedSharpe,
  maxDrawdown,
  totalReturn,
  deflationBenchmark,
  deflatedSharpe,
  simulate,
} from './engine.mjs';
import { donchian } from './strategies.mjs';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'LINKUSDT'];
const TFS = ['1h', '4h', '1d'];
const N_GRID = [10, 20, 30, 55, 80]; // pre-registered Donchian lookbacks
const FEES = [0, 3.6, 7.5, 10, 20]; // 3.6 = perp maker+BNB (long-short REQUIRES perps), 20 = spot taker
const HOLDOUT = 0.3;
const DSR_GATE = 0.95;
const WF_SEGMENTS = 3;
const MIN_RT = 30;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('--out', null);

// Align symbols on their common timestamp grid (Binance klines share a fixed grid per tf, so equal
// timestamps line up bar-for-bar). Returns { symbol → alignedBars } over the intersecting range.
function alignSymbols(tf) {
  const perSym = {};
  for (const s of SYMBOLS) {
    try {
      perSym[s] = loadOhlcv(s, tf);
    } catch {
      /* missing file — this symbol/tf simply isn't in the basket */
    }
  }
  const present = Object.keys(perSym);
  if (present.length < 2) return null;
  // Common [startTs, endTs] = max of starts, min of ends.
  const startTs = Math.max(...present.map((s) => perSym[s][0].t));
  const endTs = Math.min(...present.map((s) => perSym[s][perSym[s].length - 1].t));
  const aligned = {};
  let refLen = null;
  for (const s of present) {
    const sliced = perSym[s].filter((b) => b.t >= startTs && b.t <= endTs);
    aligned[s] = sliced;
    if (refLen === null) refLen = sliced.length;
    else if (sliced.length !== refLen) {
      // A gap in one symbol's history — fall back to intersect-by-timestamp.
      return alignByTimestamp(perSym, present);
    }
  }
  return { aligned, symbols: present };
}

function alignByTimestamp(perSym, present) {
  const tsSets = present.map((s) => new Set(perSym[s].map((b) => b.t)));
  const common = [...tsSets[0]]
    .filter((t) => tsSets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const commonSet = new Set(common);
  const aligned = {};
  for (const s of present) aligned[s] = perSym[s].filter((b) => commonSet.has(b.t));
  return { aligned, symbols: present };
}

function segSign(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  return m > 0 ? 1 : m < 0 ? -1 : 0;
}
function walkForwardConsistent(returns) {
  const whole = segSign(returns);
  if (whole === 0) return false;
  const seg = Math.floor(returns.length / WF_SEGMENTS);
  if (seg < 2) return false;
  for (let i = 0; i < WF_SEGMENTS; i += 1) {
    const slice = returns.slice(i * seg, i === WF_SEGMENTS - 1 ? undefined : (i + 1) * seg);
    if (segSign(slice) !== whole) return false;
  }
  return true;
}

// ── Run the pre-registered grid: {tf × n × fee} × {long-only, long-short} portfolios ─────────────
const cells = [];
for (const tf of TFS) {
  const al = alignSymbols(tf);
  if (!al) continue;
  const { aligned, symbols } = al;
  const holdoutStart = Math.floor(aligned[symbols[0]].length * (1 - HOLDOUT));
  for (const n of N_GRID) {
    for (const dir of ['long', 'ls']) {
      // Per-symbol position + net-return streams, then equal-weight the returns bar-for-bar.
      const perSymReturns = symbols.map((s) => {
        const positions = donchian(aligned[s], { n }, dir);
        return { s, positions, bars: aligned[s] };
      });
      for (const fee of FEES) {
        const sims = perSymReturns.map(({ positions, bars }) => simulate(bars, positions, fee));
        const len = Math.min(...sims.map((sim) => sim.netReturns.length));
        // Equal-weight portfolio: 1/K of capital per symbol (a flat symbol contributes 0).
        const portReturns = [];
        for (let i = 0; i < len; i += 1) {
          let sum = 0;
          for (const sim of sims) sum += sim.netReturns[i];
          portReturns.push(sum / sims.length);
        }
        const holdout = portReturns.slice(holdoutStart);
        const stats = annualizedSharpe(holdout, tf);
        // Round trips across the basket over the holdout = sum of per-symbol holdout round trips.
        const holdoutRt = perSymReturns
          .map(
            ({ positions, bars }) =>
              simulate(bars.slice(holdoutStart), positions.slice(holdoutStart), fee).roundTrips,
          )
          .reduce((a, b) => a + b, 0);
        cells.push({
          tf,
          n,
          dir,
          fee,
          symbols: symbols.length,
          roundTrips: holdoutRt,
          totalReturnPct: totalReturn(holdout) * 100,
          netBpsPerRt: holdoutRt > 0 ? (totalReturn(holdout) / holdoutRt) * 10000 : 0,
          sharpe: stats.sharpe,
          skew: stats.skew,
          kurt: stats.kurt,
          maxDdPct: maxDrawdown(holdout) * 100,
          T: holdout.length,
          wfConsistent: walkForwardConsistent(holdout),
        });
      }
    }
  }
}

// Deflate per fee level (the trial set is this grid at that fee — small, so SR0* is realistic).
const survivors = [];
for (const fee of FEES) {
  const feeCells = cells.filter((c) => c.fee === fee);
  const { sr0, variance, N } = deflationBenchmark(feeCells.map((c) => c.sharpe));
  for (const c of feeCells) {
    c.sr0 = sr0;
    c.dsr = deflatedSharpe(c.sharpe, sr0, c.tf, c.T, c.skew, c.kurt);
    c.survivor = c.netBpsPerRt > 0 && c.roundTrips >= MIN_RT && c.dsr >= DSR_GATE && c.wfConsistent;
    if (c.survivor) survivors.push(c);
  }
  // eslint-disable-next-line no-console
  console.log(
    `fee=${fee}bps: ${feeCells.length} portfolio cells, SR0*=${sr0.toFixed(3)} (var=${variance.toFixed(4)}, N=${N}), survivors=${feeCells.filter((c) => c.survivor).length}`,
  );
}

const fmt = (c) =>
  `donchian(n=${c.n}) ${c.dir} ${c.tf} ${c.symbols}-sym fee=${c.fee} | RT=${c.roundTrips} netBps/RT=${c.netBpsPerRt.toFixed(1)} totRet=${c.totalReturnPct.toFixed(1)}% Sharpe=${c.sharpe.toFixed(2)} DSR=${c.dsr.toFixed(3)} wf=${c.wfConsistent} maxDD=${c.maxDdPct.toFixed(1)}%`;

const ranked = [...cells].sort((a, b) => b.dsr - a.dsr || b.sharpe - a.sharpe);
survivors.sort((a, b) => b.dsr - a.dsr || b.sharpe - a.sharpe);

// eslint-disable-next-line no-console
console.log(
  `\n=== PORTFOLIO TREND: ${cells.length} cells; SURVIVORS (DSR≥${DSR_GATE}, wf-consistent, net>0, RT≥${MIN_RT}): ${survivors.length} ===`,
);
for (const c of survivors.slice(0, 20)) {
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${fmt(c)}`);
}
// eslint-disable-next-line no-console
console.log('\nTOP 12 BY DEFLATED SHARPE (survivor or not):');
for (const c of ranked.slice(0, 12)) {
  // eslint-disable-next-line no-console
  console.log(`  ${c.survivor ? '✓' : ' '} ${fmt(c)}`);
}

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: 'SELECTION-BIAS CAVEAT: Donchian was chosen because sweep.mjs surfaced it as the frontier family; a fully-clean confirmation is forward/paper. This is a strong lead, not a certified edge.',
        config: {
          symbols: SYMBOLS,
          tfs: TFS,
          nGrid: N_GRID,
          fees: FEES,
          holdout: HOLDOUT,
          dsrGate: DSR_GATE,
          minRt: MIN_RT,
        },
        cells: ranked,
        survivorCount: survivors.length,
        survivors,
      },
      null,
      1,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`\nwrote ${OUT}`);
}
