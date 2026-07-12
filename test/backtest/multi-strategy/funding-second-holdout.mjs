// Second, non-overlapping holdout validation of the Family A (funding) frontier — 2026-07-13.
// Re-tests the EXACT same grid (imported from funding-sweep.mjs, not redeclared, so it cannot drift)
// on a DIFFERENT, earlier, non-overlapping data window that contains a bull regime for the alts:
// 2023-10-01 -> 2024-06-30 (BTC 26,977 -> 72,900 -> 61,016 over this span — see
// reports/loop/nonprice-sweep-2026-07-12.md's addendum for the price check). The original sweep's
// data covered 2024-07-11 -> 2026-07-12; this window ends 11 days before that starts, so there is no
// overlap.
//
// THIS IS A VALIDATION RE-TEST OF ALREADY-REGISTERED CELLS ON NEW DATA, NOT A NEW TRIAL SET — it does
// not add to the honest-N multiple-testing pool the way a fresh, never-before-tried grid would; the
// parameters were already fixed by the 2026-07-12 sweep before this window was ever looked at.
//
// Methodology deviation (disclosed): there is no further train/holdout split within this window — the
// ENTIRE window IS the out-of-sample test, since the parameters under test were already selected on
// the original (later, disjoint) data. Walk-forward here means 3 equal sub-segments of THIS window.
//
// 4h is NOT re-tested: the 4h OHLCV cache only covers 2024-07-11 onward (fetched for the original
// sweep), so there is no cached 4h data in the 2023-10/2024-06 window. All 3 top frontier cells are
// 1h, so this does not affect the priority validation; noted as a data-coverage limitation, not a
// silent scope cut.
//
//   node test/backtest/multi-strategy/funding-second-holdout.mjs --out <file.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadOhlcv,
  simulateWithFunding,
  attachFundingToBars,
  annualizedSharpe,
  maxDrawdown,
  totalReturn,
} from './engine.mjs';
import {
  SYMBOLS as ORIGINAL_SYMBOLS,
  T_GRID,
  FEE_BPS,
  SMOOTH_HOLD_PAIRS,
  MODES,
  BASE_RULES,
  DIRS,
} from './funding-sweep.mjs';
import { loadFunding, fundingSignalSeries, fundingPositions, fundingGatedTrend } from './funding-signal.mjs';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('--out', null);

// ── Second holdout window (locked before running, non-overlapping bull regime) ───────────────────
const WINDOW_START = Date.parse('2023-10-01T00:00:00Z');
const WINDOW_END = Date.parse('2024-06-30T00:00:00Z');
const NEW_SYMBOLS = ['DOGEUSDTUSDT', 'AVAXUSDTUSDT']; // fresh, out-of-family generalization check
const SYMBOLS = [...ORIGINAL_SYMBOLS, ...NEW_SYMBOLS];
const WF_SEGMENTS = 3;

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

function windowSlice(bars, fundingRows) {
  const wBars = bars.filter((b) => b.t >= WINDOW_START && b.t <= WINDOW_END);
  const wFunding = fundingRows.filter((r) => r.timestamp >= WINDOW_START && r.timestamp <= WINDOW_END);
  return { wBars, wFunding };
}

// Whole-window score: no further train/holdout split (see file header) — the whole slice is the test.
function scoreWholeWindow(bars, positions, fundingMap, meta) {
  const sim = simulateWithFunding(bars, positions, FEE_BPS, fundingMap);
  const stats = annualizedSharpe(sim.netReturns, meta.tf);
  const tot = totalReturn(sim.netReturns);
  const longBars = positions.filter((p) => p === 1).length;
  const shortBars = positions.filter((p) => p === -1).length;
  return {
    ...meta,
    roundTrips: sim.roundTrips,
    winRate: sim.roundTrips > 0 ? sim.wins / sim.roundTrips : 0,
    totalReturnPct: tot * 100,
    netBpsPerRt: sim.roundTrips > 0 ? (tot / sim.roundTrips) * 10000 : 0,
    sharpe: stats.sharpe,
    skew: stats.skew,
    kurt: stats.kurt,
    maxDdPct: maxDrawdown(sim.netReturns) * 100,
    T: sim.netReturns.length,
    longBars,
    shortBars,
    wfConsistent: wfConsistent(sim.netReturns),
  };
}

const cells = [];

for (const symbol of SYMBOLS) {
  let fullBars;
  let fullFunding;
  try {
    fullBars = loadOhlcv(symbol, '1h');
    fullFunding = loadFunding(symbol);
  } catch {
    continue;
  }
  const { wBars, wFunding } = windowSlice(fullBars, fullFunding);
  if (wBars.length < 100) continue; // insufficient data in this window for this symbol
  const fundingMap = attachFundingToBars(wBars, wFunding);

  for (const { smooth, hold } of SMOOTH_HOLD_PAIRS) {
    const signal = fundingSignalSeries(wBars, fundingMap, smooth);
    for (const mode of MODES) {
      for (const T of T_GRID) {
        const positions = fundingPositions(wBars, signal, { T, mode, hold });
        cells.push(
          scoreWholeWindow(wBars, positions, fundingMap, {
            variant: mode,
            symbol,
            tf: '1h',
            thresholdAnnualized: T,
            smooth,
            hold: String(hold),
            feeBps: FEE_BPS,
            newSymbol: NEW_SYMBOLS.includes(symbol),
          }),
        );
      }
    }
  }

  const gateSmoothN = 3;
  const gateSignal = fundingSignalSeries(wBars, fundingMap, gateSmoothN);
  for (const rule of BASE_RULES) {
    for (const dir of DIRS) {
      const basePositions = rule.fn(wBars, rule.params, dir);
      for (const T of T_GRID) {
        const positions = fundingGatedTrend(basePositions, gateSignal, T);
        cells.push(
          scoreWholeWindow(wBars, positions, fundingMap, {
            variant: 'gate',
            baseRule: `${rule.kind}(${Object.values(rule.params).join(',')})`,
            dir,
            symbol,
            tf: '1h',
            thresholdAnnualized: T,
            feeBps: FEE_BPS,
            newSymbol: NEW_SYMBOLS.includes(symbol),
          }),
        );
      }
    }
  }
}

// eslint-disable-next-line no-console
console.log(
  `Second holdout (${new Date(WINDOW_START).toISOString().slice(0, 10)} -> ${new Date(WINDOW_END).toISOString().slice(0, 10)}): ${cells.length} cells`,
);

// ── Join against the original (candidates/nonprice-funding-2026-07-12.json) for the 5 family symbols
const ORIGINAL_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'candidates', 'nonprice-funding-2026-07-12.json');
let originalCells = [];
try {
  originalCells = JSON.parse(readFileSync(ORIGINAL_JSON, 'utf8')).cells;
} catch {
  console.warn('original candidate JSON not found — skipping join'); // eslint-disable-line no-console
}

function cellKey(c) {
  return c.variant === 'gate'
    ? `gate|${c.symbol}|${c.tf}|${c.baseRule}|${c.dir}|${c.thresholdAnnualized}`
    : `${c.variant}|${c.symbol}|${c.tf}|${c.thresholdAnnualized}|${c.smooth}|${c.hold}`;
}
const originalByKey = new Map(originalCells.map((c) => [cellKey(c), c]));

const joined = [];
for (const c of cells) {
  const orig = originalByKey.get(cellKey(c));
  if (!orig) continue;
  const signSame = Math.sign(orig.sharpe) === Math.sign(c.sharpe) && orig.sharpe > 0;
  joined.push({
    key: cellKey(c),
    originalSharpe: orig.sharpe,
    originalNetBpsPerRt: orig.netBpsPerRt,
    originalWf: orig.wfConsistent,
    secondSharpe: c.sharpe,
    secondNetBpsPerRt: c.netBpsPerRt,
    secondWf: c.wfConsistent,
    secondRoundTrips: c.roundTrips,
    signSame,
    verdict: signSame && c.sharpe > 0.5 ? 'SURVIVED' : signSame ? 'WEAKENED' : 'KILLED',
  });
}
joined.sort((a, b) => b.originalSharpe - a.originalSharpe);

// eslint-disable-next-line no-console
console.log(`Joined ${joined.length} cells against the original sweep. Top 10 by original Sharpe:`);
for (const j of joined.slice(0, 10)) {
  // eslint-disable-next-line no-console
  console.log(
    `  ${j.key} | orig sharpe=${j.originalSharpe.toFixed(3)} wf=${j.originalWf} -> second sharpe=${j.secondSharpe.toFixed(3)} wf=${j.secondWf} rt=${j.secondRoundTrips} | ${j.verdict}`,
  );
}

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        window: {
          start: new Date(WINDOW_START).toISOString(),
          end: new Date(WINDOW_END).toISOString(),
          regime: 'bull (BTC 26,977 -> 72,900 -> 61,016 over this span)',
        },
        note: 'Validation re-test of already-registered cells on new data — not new honest-N trials.',
        config: { symbols: SYMBOLS, newSymbols: NEW_SYMBOLS, tGrid: T_GRID, feeBps: FEE_BPS },
        totalCells: cells.length,
        cells,
        joinedVsOriginal: joined,
      },
      null,
      1,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUT}`);
}
