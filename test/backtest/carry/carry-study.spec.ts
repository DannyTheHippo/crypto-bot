// Funding-carry offline study — task S2 (`reports/loop/state.md`), the GO/NO-GO gate for the whole
// carry build. RESEARCH TOOLING (test/backtest/, off the production gate). Runs under `pnpm backtest`
// (not env-gated like the EDGE_DIAG diagnostic scan) — self-skips cleanly via `describe.skipIf` when
// either this study's own 7-symbol dataset or the PRIOR_TRIALS legacy dataset is absent (both are
// gitignored; a fresh CI checkout has neither, so the whole suite skips there). This is an
// HONESTY-CRITICAL study: the grid runs once, is reported as-is, and the spec asserts only mechanical
// integrity (every cell ran, no NaN, the report got written) — the GO/NO-GO verdict is data, never an
// assertion, so a NO-GO result must not fail this suite.
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  allCells,
  runCell,
  evaluateCarryCell,
  cellIsGo,
  carryDataAvailable,
  priorDataAvailable,
  loadCarryFunding,
  loadCarryOhlcv,
  harvestPriorSharpes,
  SYMBOLS,
} from './carry-grid';
import type { Bar, FundingRow } from './carry-sim';
import { variance, PRIOR_TRIALS } from '../trial-registry';
import { logTrials, paramsHash, datasetHash } from '../experiment-log';
import { expectedMaxZ, expectedMaxSharpe } from '../stats';
import { renderCarryReport, type CarryReportRow } from './report';

const SKIP = !carryDataAvailable() || !priorDataAvailable();
const REPORT_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'reports',
  'loop',
  'carry-study-2026-07-10.md',
);

function formatTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

describe.skipIf(SKIP)('funding-carry offline study (task S2, carry-build GO/NO-GO gate)', () => {
  // 126 lightweight state-machine passes (a few thousand funding intervals each) plus 52 full-series
  // SeedEntryStrategy backtests (up to 70k bars each, the same cost as the EDGE_DIAG=1 scan) — budget
  // generously, well past vitest's 5s default.
  it('runs the 126-cell grid, deflates over the N=178 union, and writes the report', async () => {
    // Load each symbol's data exactly once (7 symbols, not 18x each via the 126-cell loop).
    const dataBySymbol = new Map<string, { funding: FundingRow[]; ohlcv: Bar[] }>();
    for (const symbol of SYMBOLS) {
      dataBySymbol.set(symbol, {
        funding: loadCarryFunding(symbol),
        ohlcv: loadCarryOhlcv(symbol),
      });
    }

    const cells = allCells();
    expect(cells.length).toBe(126);

    const results = cells.map((cell) => {
      const data = dataBySymbol.get(cell.symbol)!;
      return runCell(cell, data.funding, data.ohlcv);
    });

    for (const r of results) {
      expect(Number.isFinite(r.holdoutStats.sr)).toBe(true);
      expect(Number.isFinite(r.holdoutStats.mean)).toBe(true);
      expect(Number.isFinite(r.holdoutStats.std)).toBe(true);
      expect(r.trainEpisodes + r.holdoutEpisodes).toBe(r.totalEpisodes);
    }

    // See carry-grid.ts's PRIOR-TRIAL HARVEST note: throws loudly on any partial/mismatched harvest
    // rather than silently computing N < 178.
    const priorSharpes = harvestPriorSharpes();
    expect(priorSharpes.length).toBe(PRIOR_TRIALS.length);
    expect(priorSharpes.length).toBe(52);
    for (const sr of priorSharpes) expect(Number.isFinite(sr)).toBe(true);

    const unionSharpes = [...results.map((r) => r.holdoutStats.sr), ...priorSharpes];
    expect(unionSharpes.length).toBe(178);
    const N = unionSharpes.length;
    const V = variance(unionSharpes);
    expect(Number.isFinite(V)).toBe(true);
    expect(V).toBeGreaterThanOrEqual(0);

    const rows: CarryReportRow[] = results.map((result) => {
      const gate = evaluateCarryCell(result, V, N);
      expect(Number.isFinite(gate.tStat)).toBe(true);
      expect(Number.isFinite(gate.dsr)).toBe(true);
      return { result, gate, go: cellIsGo(result, gate) };
    });
    expect(rows.length).toBe(126);

    const zMax = expectedMaxZ(N);
    const srNull = expectedMaxSharpe(V, N);
    expect(Number.isFinite(zMax)).toBe(true);
    expect(Number.isFinite(srNull)).toBe(true);

    const btc = dataBySymbol.get('BTC')!;
    const report = renderCarryReport({
      rows,
      N,
      priorCount: priorSharpes.length,
      priorSrMin: Math.min(...priorSharpes),
      priorSrMax: Math.max(...priorSharpes),
      V,
      expectedMaxZ: zMax,
      expectedMaxSharpeNull: srNull,
      dataRangeStart: formatTs(btc.ohlcv[0]![0]!),
      dataRangeEnd: formatTs(btc.ohlcv[btc.ohlcv.length - 1]![0]!),
      ohlcvBars: btc.ohlcv.length,
      fundingRows: btc.funding.length,
    });

    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, report);
    console.log(`carry-study report written to ${REPORT_PATH}`);

    // Honest-N ledger (registration discipline, trial-registry.ts header): every cell of this grid
    // — winners and losers alike — is written to the append-only experiments table. logTrials is a
    // gated no-op without DATABASE_URL, so the suite stays green offline.
    await logTrials(
      rows.map(({ result, gate, go }) => {
        const funding = dataBySymbol.get(result.symbol)!.funding;
        return {
          family: 'carry-conditional',
          paramsHash: paramsHash({
            entryLookback: result.params.entryLookback,
            entryThresholdAnnualized: result.params.entryThresholdAnnualized,
            exitRule: result.params.exitRule,
            costPerEpisodePct: 0.24,
          }),
          datasetHash: datasetHash({
            symbol: result.symbol,
            interval: '1h',
            rowCount: funding.length,
            firstTs: funding[0]!.timestamp,
            lastTs: funding[funding.length - 1]!.timestamp,
          }),
          source: 'study' as const,
          label: result.label,
          metrics: {
            totalEpisodes: result.totalEpisodes,
            holdoutEpisodes: result.holdoutEpisodes,
            holdoutExpectancyBps: result.holdoutExpectancyBps,
            holdoutSharpe: result.holdoutStats.sr,
            dsr: gate.dsr,
            tStat: gate.tStat,
            go,
          },
        };
      }),
    );

    // Mechanical integrity only — the GO/NO-GO verdict is data, not an assertion. Both outcomes are
    // valid results of this suite.
    const goCount = rows.filter((r) => r.go).length;
    expect(goCount).toBeGreaterThanOrEqual(0);
  }, 180_000);
});
