// Funding-carry offline study — task S2 (`reports/loop/state.md`), the GO/NO-GO gate for the whole
// carry build. RESEARCH TOOLING (test/backtest/, off the production gate). Runs under `pnpm backtest`
// (not env-gated like the EDGE_DIAG diagnostic scan) — self-skips cleanly via `describe.skipIf` when
// either this study's own 7-symbol dataset or the PRIOR_TRIALS legacy dataset is absent (both are
// gitignored; a fresh CI checkout has neither, so the whole suite skips there). This is an
// HONESTY-CRITICAL study: the grid runs once, is reported as-is, and the spec asserts only mechanical
// integrity (every cell ran, no NaN) — the GO/NO-GO verdict is data, never an assertion, so a NO-GO
// result must not fail this suite. Writing the committed report is opt-in (CARRY_STUDY_WRITE=1, see
// the gate below) — a plain run never touches research/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { datasetHash, logTrials, paramsHash } from '../experiment-log';
import { expectedMaxSharpe, expectedMaxZ, winsorizedVariance } from '../stats';
import { PRIOR_TRIALS } from '../trial-registry';
import {
  allCells,
  carryDataAvailable,
  cellIsGo,
  evaluateCarryCell,
  harvestPriorSharpes,
  loadCarryFunding,
  loadCarryOhlcv,
  priorDataAvailable,
  runCell,
  SYMBOLS,
} from './carry-grid';
import type { Bar, FundingRow } from './carry-sim';
import { renderCarryReport, type CarryReportRow } from './report';

const SKIP = !carryDataAvailable() || !priorDataAvailable();
const REPORT_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'research',
  'studies',
  'carry-study-2026-07-10.md',
);

// Artifact-write gate (2026-07-31 incident, this file). `vitest run test/backtest/` was found to
// silently OVERWRITE the committed REPORT_PATH — the evidence behind the funding-carry sub-plan's
// settled NO-GO verdict — with numbers regenerated off whatever the local gitignored data cache
// currently held: funding rows per symbol had silently collapsed 3250 -> 31 for BTC/ETH/SOL/XRP
// (test/backtest/data/funding-{BTC,ETH,SOL,XRP}USDTUSDT.json, a truncated re-fetch), which moved V,
// SR0*, and the worst-outlier cell in the write. A suite run must never replace published evidence
// with weaker evidence invisibly. Mirrors test/features/common/config/openapi-snapshot.spec.ts's
// OPENAPI_WRITE idiom (env-flag-gated write vs. compare-only). Failure direction: this gate fails
// CLOSED for WRITING (no flag => REPORT_PATH is never touched, unconditionally) and must NEVER fail
// closed for TESTING — the grid's own mechanical-integrity assertions below run and must still pass
// identically whether or not the flag is set; only the filesystem write is conditional.
const CARRY_STUDY_WRITE = process.env['CARRY_STUDY_WRITE'] === '1';

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
    const V = winsorizedVariance(unionSharpes);
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

    if (CARRY_STUDY_WRITE) {
      mkdirSync(dirname(REPORT_PATH), { recursive: true });
      writeFileSync(REPORT_PATH, report);
      console.log(`carry-study report written to ${REPORT_PATH}`);
    } else {
      console.log(`carry-study: CARRY_STUDY_WRITE not set — skipped write to ${REPORT_PATH}`);
    }

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
