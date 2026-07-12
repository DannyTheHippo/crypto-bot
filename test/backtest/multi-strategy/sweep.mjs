// Multi-strategy sweep runner (2026-07-12). Runs every FAMILY × param × symbol × timeframe ×
// direction(long/long-short) × fee-level, computes honest out-of-sample statistics, and ranks the
// survivors. See engine.mjs's header for the fill model and the honest-N rationale.
//
//   node test/backtest/multi-strategy/sweep.mjs [--out <file.json>] [--min-rt N] [--holdout 0.3]
//
// Honest-N protocol:
//   - Each series is split by TIME: the first (1−holdout) fraction is the in-sample span (used only
//     to establish that a cell isn't purely fit to the tail), the last `holdout` fraction is the
//     out-of-sample span that ALL reported metrics come from.
//   - The trial universe for the deflated-Sharpe benchmark is EVERY cell run at a given fee level
//     (families × params × symbols × timeframes × directions). SR0* is computed once per fee level
//     from that trial set's winsorized Sharpe variance, then each cell is deflated against it.
//   - GATE (a cell is a "survivor"): holdout net bps/round-trip > 0 AND holdout round trips ≥ minRt
//     AND deflated Sharpe (probability the true Sharpe > SR0*) ≥ 0.95 AND all 3 walk-forward
//     sub-segments of the holdout share the sign of the holdout mean return.

import { writeFileSync } from 'node:fs';
import {
  loadOhlcv,
  simulate,
  annualizedSharpe,
  maxDrawdown,
  totalReturn,
  deflationBenchmark,
  deflatedSharpe,
  FEE_LEVELS_BPS,
} from './engine.mjs';
import { FAMILIES, paramLabel } from './strategies.mjs';

// Symbols × timeframes for which OHLCV is on disk (verified 2026-07-12). BTC/ETH have the full
// 15m→1d range; the alts have 15m/1h only, which is fine — the sweep just skips missing files.
const DATASETS = [
  ['BTCUSDT', ['15m', '1h', '4h', '1d']],
  ['ETHUSDT', ['15m', '1h', '4h', '1d']],
  ['SOLUSDT', ['15m', '1h']],
  ['XRPUSDT', ['15m', '1h']],
  ['LINKUSDT', ['15m', '1h']],
];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const OUT = arg('--out', null);
const MIN_RT = Number(arg('--min-rt', '20'));
const HOLDOUT = Number(arg('--holdout', '0.3'));
const DSR_GATE = 0.95;
const WF_SEGMENTS = 3;

function segSign(netReturns) {
  const m = netReturns.reduce((a, b) => a + b, 0) / Math.max(1, netReturns.length);
  return m > 0 ? 1 : m < 0 ? -1 : 0;
}

function walkForwardConsistent(holdoutReturns) {
  const whole = segSign(holdoutReturns);
  if (whole === 0) return false;
  const seg = Math.floor(holdoutReturns.length / WF_SEGMENTS);
  if (seg < 2) return false;
  for (let s = 0; s < WF_SEGMENTS; s += 1) {
    const slice = holdoutReturns.slice(s * seg, s === WF_SEGMENTS - 1 ? undefined : (s + 1) * seg);
    if (segSign(slice) !== whole) return false;
  }
  return true;
}

// ── Pass 1: run every cell, collect raw results grouped by fee level ─────────────────────────────
const cellsByFee = new Map(FEE_LEVELS_BPS.map((f) => [f, []]));
let totalCells = 0;

for (const [symbol, tfs] of DATASETS) {
  for (const tf of tfs) {
    let bars;
    try {
      bars = loadOhlcv(symbol, tf);
    } catch {
      continue; // missing data file — skip silently, DATASETS is a superset
    }
    const holdoutStart = Math.floor(bars.length * (1 - HOLDOUT));
    for (const [famName, fam] of Object.entries(FAMILIES)) {
      for (const params of fam.grid) {
        for (const dir of ['long', 'ls']) {
          const positions = fam.fn(bars, params, dir);
          for (const feeBps of FEE_LEVELS_BPS) {
            const sim = simulate(bars, positions, feeBps);
            // Holdout slice of the per-step returns (netReturns[i] is aligned to bar i).
            const holdoutReturns = sim.netReturns.slice(holdoutStart);
            // Re-count round trips / wins on the holdout only, by re-simulating the holdout window.
            const holdoutSim = simulate(
              bars.slice(holdoutStart),
              positions.slice(holdoutStart),
              feeBps,
            );
            const stats = annualizedSharpe(holdoutReturns, tf);
            const tot = totalReturn(holdoutReturns);
            const rt = holdoutSim.roundTrips;
            const netBpsPerRt = rt > 0 ? (tot / rt) * 10000 : 0;
            cellsByFee.get(feeBps).push({
              symbol,
              tf,
              family: famName,
              params: paramLabel(params),
              dir,
              feeBps,
              roundTrips: rt,
              winRate: rt > 0 ? holdoutSim.wins / rt : 0,
              totalReturnPct: tot * 100,
              netBpsPerRt,
              sharpe: stats.sharpe,
              skew: stats.skew,
              kurt: stats.kurt,
              maxDdPct: maxDrawdown(holdoutReturns) * 100,
              T: holdoutReturns.length,
              wfConsistent: walkForwardConsistent(holdoutReturns),
            });
            totalCells += 1;
          }
        }
      }
    }
  }
}

// ── Pass 2: deflate each cell against its fee level's trial set; gate survivors ──────────────────
const allScored = [];
const survivors = [];
for (const [feeBps, cells] of cellsByFee) {
  const trialSharpes = cells.map((c) => c.sharpe);
  const { sr0, variance, N } = deflationBenchmark(trialSharpes);
  for (const c of cells) {
    c.sr0 = sr0;
    c.dsr = deflatedSharpe(c.sharpe, sr0, c.tf, c.T, c.skew, c.kurt);
    c.passesDsr = c.dsr >= DSR_GATE;
    c.survivor = c.netBpsPerRt > 0 && c.roundTrips >= MIN_RT && c.passesDsr && c.wfConsistent;
    allScored.push(c);
    if (c.survivor) survivors.push(c);
  }
  // eslint-disable-next-line no-console
  console.log(
    `fee=${feeBps}bps: ${cells.length} cells, SR0*=${sr0.toFixed(3)} (var=${variance.toFixed(4)}, N=${N}), survivors=${cells.filter((c) => c.survivor).length}`,
  );
}

survivors.sort((a, b) => b.dsr - a.dsr || b.netBpsPerRt - a.netBpsPerRt);

// Best cell per fee level regardless of survival (to show how close the frontier gets).
const bestByFee = FEE_LEVELS_BPS.map((f) => {
  const cells = allScored
    .filter((c) => c.feeBps === f && c.roundTrips >= MIN_RT)
    .sort((a, b) => b.dsr - a.dsr || b.netBpsPerRt - a.netBpsPerRt);
  return cells[0] ?? null;
});

const fmt = (c) =>
  c
    ? `${c.family}(${c.params}) ${c.symbol} ${c.tf} ${c.dir} fee=${c.feeBps} | RT=${c.roundTrips} netBps/RT=${c.netBpsPerRt.toFixed(1)} Sharpe=${c.sharpe.toFixed(2)} DSR=${c.dsr.toFixed(3)} wf=${c.wfConsistent} maxDD=${c.maxDdPct.toFixed(1)}%`
    : '(none with enough round trips)';

// eslint-disable-next-line no-console
console.log(
  `\n=== SWEEP COMPLETE: ${totalCells} cells across ${FEE_LEVELS_BPS.length} fee levels ===`,
);
// eslint-disable-next-line no-console
console.log(
  `SURVIVORS (holdout net>0, RT≥${MIN_RT}, DSR≥${DSR_GATE}, walk-forward sign-consistent): ${survivors.length}`,
);
for (const c of survivors.slice(0, 25)) {
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${fmt(c)}`);
}
// eslint-disable-next-line no-console
console.log('\nBEST CELL PER FEE LEVEL (frontier, survivor or not):');
for (const c of bestByFee) {
  // eslint-disable-next-line no-console
  console.log(`  fee=${c?.feeBps ?? '?'}: ${fmt(c)}`);
}

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: { minRt: MIN_RT, holdout: HOLDOUT, dsrGate: DSR_GATE, feeLevels: FEE_LEVELS_BPS },
        datasets: DATASETS,
        totalCells,
        survivorCount: survivors.length,
        survivors: survivors.slice(0, 100),
        bestByFee,
      },
      null,
      1,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`\nwrote ${OUT}`);
}
