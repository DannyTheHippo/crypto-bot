// Edge diagnostic — env-gated (EDGE_DIAG=1), RESEARCH TOOLING (test/backtest/, off the production
// gate). Self-skips by default so `pnpm backtest` stays fast; `EDGE_DIAG=1 pnpm backtest` runs the
// full 52-bucket scan (run-scan.ts) plus the optional recorded-entry scoring
// (recorded-entry-scoring.ts) and writes a JSON summary to EDGE_DIAG_OUTPUT (default: a temp file
// under os.tmpdir(), path logged) — the source material for reports/loop/edge-diagnostic-2026-07-10.md.
// Written to a file rather than console.log: vitest's default reporter drops stdout for passing
// tests, and this scan is expected to pass. This spec is a SMOKE/SHAPE gate on the scan (every bucket
// resolves, stats are well-formed); it is not itself the report.
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEdgeScan } from './run-scan';
import { scoreRecordedEntries } from './recorded-entry-scoring';
import { deflatedSharpe } from '../stats';

const SKIP = process.env['EDGE_DIAG'] !== '1';
const OUTPUT_PATH =
  process.env['EDGE_DIAG_OUTPUT'] ?? join(tmpdir(), 'edge-diagnostic-result.json');

describe.skipIf(SKIP)('edge diagnostic: 52-bucket SeedEntryStrategy scan (EDGE_DIAG=1)', () => {
  // 52 full-series backtests (up to 70k bars each) plus an optional DB round trip — well past
  // vitest's 5s default.
  it('scans every registered bucket and produces well-formed holdout stats', async () => {
    const report = runEdgeScan();

    expect(report.buckets.length).toBe(52);
    expect(report.N).toBe(52);
    for (const b of report.buckets) {
      expect(Number.isFinite(b.holdoutStats.n)).toBe(true);
      expect(b.holdoutTrades).toBe(b.holdoutStats.n);
      expect(b.trainTrades).toBeGreaterThanOrEqual(0);
    }

    const recorded = await scoreRecordedEntries();

    const payload = {
      N: report.N,
      V: report.V,
      expectedMaxZ: report.expectedMaxZ,
      expectedMaxSharpeNull: report.expectedMaxSharpeNull,
      seamCount: report.seams.length,
      seams: report.seams.map((s) => s.label),
      buckets: report.buckets.map((b) => ({
        label: b.label,
        symbol: b.symbol,
        interval: b.interval,
        k: b.kMultiple,
        totalBars: b.totalBars,
        trainTrades: b.trainTrades,
        holdoutTrades: b.holdoutTrades,
        trainExpectancyBps: b.trainExpectancyBps,
        holdoutExpectancyBps: b.holdoutExpectancyBps,
        holdoutSharpe: b.holdoutStats.sr,
        holdoutDsr: deflatedSharpe(b.holdoutStats, report.V, report.N),
      })),
      recorded,
    };
    writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
    console.log(`edge-diagnostic result written to ${OUTPUT_PATH}`);

    // Documents intent: an empty seam list is a valid (NO-GO) outcome, not a test failure.
    expect(report.seams.length).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
