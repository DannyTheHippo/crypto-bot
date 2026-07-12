// Cross-sectional momentum (2026-07-12). The one literature-endorsed family the sweep/portfolio
// runs did NOT cover: relative strength across the basket (long the strongest, short the weakest),
// as opposed to each symbol's own absolute trend. web:crypto-edges flags cross-sectional crypto
// momentum as having documented alpha — concentrated in illiquid small caps, but worth testing on
// the 5 LIQUID majors where slippage is lowest. Same honest protocol as sweep.mjs (30% holdout,
// winsorized deflated Sharpe, walk-forward sign-consistency).
//
//   node test/backtest/multi-strategy/cross-sectional.mjs [--out <f>]

import { writeFileSync } from 'node:fs';
import {
  loadOhlcv,
  annualizedSharpe,
  maxDrawdown,
  totalReturn,
  deflationBenchmark,
  deflatedSharpe,
} from './engine.mjs';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'LINKUSDT'];
const TFS = ['4h', '1d']; // higher TF: all 5 aligned, less noise
const K_GRID = [10, 20, 30, 55, 80]; // ranking lookback
const M_GRID = [1, 2]; // long top-m / short bottom-m
const REBAL = [1, 6]; // rebalance every bar vs every 6 bars (turnover control)
const FEES = [0, 3.6, 7.5, 20];
const HOLDOUT = 0.3;
const DSR_GATE = 0.95;
const WF_SEGMENTS = 3;
const MIN_RT = 30;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('--out', null);

function alignByTimestamp(tf) {
  const perSym = {};
  for (const s of SYMBOLS) {
    try {
      perSym[s] = loadOhlcv(s, tf);
    } catch {
      /* skip missing */
    }
  }
  const present = Object.keys(perSym);
  if (present.length < 3) return null;
  const tsSets = present.map((s) => new Set(perSym[s].map((b) => b.t)));
  const common = [...tsSets[0]]
    .filter((t) => tsSets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned = {};
  for (const s of present) aligned[s] = perSym[s].filter((b) => cs.has(b.t));
  return { aligned, symbols: present, len: common.length };
}

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

const cells = [];
for (const tf of TFS) {
  const al = alignByTimestamp(tf);
  if (!al) continue;
  const { aligned, symbols, len } = al;
  const K = symbols.length;
  const opens = symbols.map((s) => aligned[s].map((b) => b.o));
  const closes = symbols.map((s) => aligned[s].map((b) => b.c));
  const holdoutStart = Math.floor(len * (1 - HOLDOUT));

  for (const k of K_GRID) {
    for (const m of M_GRID) {
      if (2 * m > K) continue;
      for (const dir of ['long', 'ls']) {
        for (const h of REBAL) {
          for (const fee of FEES) {
            const feeLeg = fee / 2 / 10000;
            const stepReturns = [];
            let weights = new Array(K).fill(0);
            let roundTrips = 0;
            let wins = 0;
            // Walk bars: at t compute ranks from closes[..t], hold weights until open[t+1]→open[t+2].
            for (let t = k; t < len - 2; t += 1) {
              // Rebalance only every h bars (relative to k start) — turnover control.
              if ((t - k) % h === 0) {
                const rets = symbols.map((_, si) => closes[si][t] / closes[si][t - k] - 1);
                const order = rets.map((r, si) => ({ r, si })).sort((a, b) => b.r - a.r);
                const newW = new Array(K).fill(0);
                for (let j = 0; j < m; j += 1) newW[order[j].si] = 1 / m; // top-m long
                if (dir === 'ls') for (let j = 0; j < m; j += 1) newW[order[K - 1 - j].si] = -1 / m;
                // Turnover cost on weight changes.
                let turnover = 0;
                for (let si = 0; si < K; si += 1) turnover += Math.abs(newW[si] - weights[si]);
                // Count a round trip per name whose sign flips or closes (approx: turnover/2 units).
                roundTrips += Math.round(turnover); // each unit of |Δw| ~ one leg; ~2 legs per RT
                weights = newW;
                stepReturns.push({ tIdx: t, turnoverCost: turnover * feeLeg });
              } else {
                stepReturns.push({ tIdx: t, turnoverCost: 0 });
              }
            }
            // Realize per-step portfolio returns over open[t+1]→open[t+2].
            const net = [];
            let curW = new Array(K).fill(0);
            let wi = 0;
            for (let t = k; t < len - 2; t += 1) {
              // Recompute weights deterministically the same way (kept in stepReturns order).
              if ((t - k) % h === 0) {
                const rets = symbols.map((_, si) => closes[si][t] / closes[si][t - k] - 1);
                const order = rets.map((r, si) => ({ r, si })).sort((a, b) => b.r - a.r);
                curW = new Array(K).fill(0);
                for (let j = 0; j < m; j += 1) curW[order[j].si] = 1 / m;
                if (dir === 'ls') for (let j = 0; j < m; j += 1) curW[order[K - 1 - j].si] = -1 / m;
              }
              let gross = 0;
              for (let si = 0; si < K; si += 1) {
                const on = opens[si][t + 1];
                const oa = opens[si][t + 2];
                if (on > 0 && Number.isFinite(oa)) gross += curW[si] * (oa / on - 1);
              }
              net.push(gross - stepReturns[wi].turnoverCost);
              wi += 1;
            }
            const holdout = net.slice(holdoutStart);
            const stats = annualizedSharpe(holdout, tf);
            const tot = totalReturn(holdout);
            // Approximate holdout round trips ∝ holdout fraction of total (turnover is ~uniform).
            const holdoutRt = Math.round(roundTrips * HOLDOUT);
            void wins;
            cells.push({
              tf,
              k,
              m,
              h,
              dir,
              fee,
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
    }
  }
}

const survivors = [];
for (const fee of FEES) {
  const fc = cells.filter((c) => c.fee === fee);
  const { sr0, variance, N } = deflationBenchmark(fc.map((c) => c.sharpe));
  for (const c of fc) {
    c.sr0 = sr0;
    c.dsr = deflatedSharpe(c.sharpe, sr0, c.tf, c.T, c.skew, c.kurt);
    c.survivor = c.netBpsPerRt > 0 && c.roundTrips >= MIN_RT && c.dsr >= DSR_GATE && c.wfConsistent;
    if (c.survivor) survivors.push(c);
  }
  // eslint-disable-next-line no-console
  console.log(
    `fee=${fee}bps: ${fc.length} cells, SR0*=${sr0.toFixed(3)} (var=${variance.toFixed(4)}, N=${N}), survivors=${fc.filter((c) => c.survivor).length}`,
  );
}

const fmt = (c) =>
  `xsec k=${c.k} top${c.m} rebal=${c.h} ${c.dir} ${c.tf} fee=${c.fee} | RT=${c.roundTrips} netBps/RT=${c.netBpsPerRt.toFixed(1)} totRet=${c.totalReturnPct.toFixed(1)}% Sharpe=${c.sharpe.toFixed(2)} DSR=${c.dsr.toFixed(3)} wf=${c.wfConsistent} maxDD=${c.maxDdPct.toFixed(1)}%`;

const ranked = [...cells].sort((a, b) => b.dsr - a.dsr || b.sharpe - a.sharpe);
survivors.sort((a, b) => b.dsr - a.dsr || b.sharpe - a.sharpe);
// eslint-disable-next-line no-console
console.log(`\n=== CROSS-SECTIONAL: ${cells.length} cells; SURVIVORS: ${survivors.length} ===`);
for (const c of survivors.slice(0, 15)) console.log(`  ✓ ${fmt(c)}`); // eslint-disable-line no-console
// eslint-disable-next-line no-console
console.log('\nTOP 10 BY DEFLATED SHARPE:');
for (const c of ranked.slice(0, 10)) console.log(`  ${c.survivor ? '✓' : ' '} ${fmt(c)}`); // eslint-disable-line no-console

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: { SYMBOLS, TFS, K_GRID, M_GRID, REBAL, FEES },
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
