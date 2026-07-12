// Pooled honest-N gate for the non-price sweep (2026-07-12). Combines Family A (funding) + Family B
// (F&G) raw cells, computes ONE winsorized-Sharpe deflation benchmark from THIS session's new cells,
// with N fed as the full program-wide trial count (PRIOR_PRICE_TRIALS + this session's new cells) —
// see reports/loop/nonprice-sweep-2026-07-12.md's methodology section for why this pooling choice
// (not a per-family / per-fee split) was made, and engine.mjs's deflationBenchmark header for the
// totalN mechanics.
//
//   node test/backtest/multi-strategy/nonprice-gate.mjs --out <file.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { deflationBenchmark, deflatedSharpe } from './engine.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('--out', null);
const FUNDING_IN = arg('--funding', null);
const FNG_IN = arg('--fng', null);

// Prior price-based search corpus, VERIFIED against the on-disk candidate JSONs (not the task
// brief's arithmetic, which double-counted the cross-sectional cells — see the report's Methodology
// section): 4,092 single-cell + 150 portfolio + 320 cross-sectional = 4,562.
const PRIOR_PRICE_TRIALS = 4092 + 150 + 320;
const DSR_GATE = 0.95;
const MIN_RT = 20;

const fundingData = JSON.parse(readFileSync(FUNDING_IN, 'utf8'));
const fngData = JSON.parse(readFileSync(FNG_IN, 'utf8'));
const allCells = [
  ...fundingData.cells.map((c) => ({ ...c, family: 'funding' })),
  ...fngData.cells.map((c) => ({ ...c, family: 'fng' })),
];

const totalN = PRIOR_PRICE_TRIALS + allCells.length;
const { sr0, variance, N } = deflationBenchmark(
  allCells.map((c) => c.sharpe),
  3,
  totalN,
);

const survivors = [];
for (const c of allCells) {
  c.sr0 = sr0;
  c.dsr = deflatedSharpe(c.sharpe, sr0, c.tf, c.T, c.skew, c.kurt);
  c.passesDsr = c.dsr >= DSR_GATE;
  c.survivor = c.netBpsPerRt > 0 && c.roundTrips >= MIN_RT && c.passesDsr && c.wfConsistent;
  if (c.survivor) survivors.push(c);
}

const ranked = [...allCells].sort((a, b) => b.dsr - a.dsr || b.sharpe - a.sharpe);
survivors.sort((a, b) => b.dsr - a.dsr || b.sharpe - a.sharpe);

// eslint-disable-next-line no-console
console.log(
  `Pooled honest-N: prior=${PRIOR_PRICE_TRIALS} + new=${allCells.length} = ${totalN}; SR0*=${sr0.toFixed(3)} (var=${variance.toFixed(4)}, N=${N})`,
);
// eslint-disable-next-line no-console
console.log(
  `SURVIVORS (holdout net>0, RT>=${MIN_RT}, DSR>=${DSR_GATE}, walk-forward sign-consistent): ${survivors.length}`,
);
// eslint-disable-next-line no-console
console.log('\nTOP 10 BY DEFLATED SHARPE (survivor or not):');
for (const c of ranked.slice(0, 10)) {
  // eslint-disable-next-line no-console
  console.log(
    `  ${c.survivor ? '✓' : ' '} [${c.family}/${c.variant}] ${JSON.stringify(c).slice(0, 200)}`,
  );
}

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: { priorPriceTrials: PRIOR_PRICE_TRIALS, dsrGate: DSR_GATE, minRt: MIN_RT },
        totalCells: allCells.length,
        totalN,
        sr0,
        variance,
        survivorCount: survivors.length,
        survivors,
        top25: ranked.slice(0, 25),
      },
      null,
      1,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`\nwrote ${OUT}`);
}
