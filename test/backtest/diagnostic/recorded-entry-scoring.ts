// Recorded-entry scoring — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Secondary to the rule-based bucket scan (run-scan.ts): scores the LLM agentic lane's ACTUAL entry
// timing (as journaled in agent_decisions) by replaying it through RecordedAgenticStrategy against the
// matching cached candle series — the real settlement path, not a toy equity walk. Optional and
// gated exactly like test/eval/agentic/recorded-rows.spec.ts (DATABASE_URL + DB_SUITE_ALLOW_RESET /
// _test-suffix gate) so this module never queries an unintended database, even read-only, and a
// caller without DATABASE_URL gets a structured skip rather than a thrown error (the diagnostic's
// runner is expected to skip gracefully, per its mandate).
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../src/database/schemas/trading';
import { AgentDecisionJournalAdapter } from '../../../src/database/repositories/strategy/agent-decision-journal.adapter';
import { runBacktest, type Bar } from '../harness';
import { RecordedAgenticStrategy, type RecordedRow } from '../strategies/recorded-agentic-strategy';
import { loadBars } from '../trial-registry';
import { sharpeStats, type SharpeStats } from '../stats';

// Reference series the recorded decisions are aligned against — matches TRADING_SYMBOL's default
// (src/config/environment/environment.config.ts) at the finest cached resolution this diagnostic has.
const REFERENCE_SYMBOL = 'BTCUSDT';
const REFERENCE_INTERVAL = '15m';
const DECISION_LIMIT = 2000;

function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

export type RecordedEntryScore =
  | { readonly skipped: true; readonly reason: string }
  | {
      readonly skipped: false;
      readonly rowsConsidered: number;
      readonly alignedRows: number;
      readonly trades: number;
      readonly expectancyBps: number | null;
      readonly stats: SharpeStats;
    };

// Aligns journaled decisions to bar indices by last-bar-at-or-before eventTime (the decision was made
// off that bar's close) — binary search over the ascending bar-timestamp array.
function alignRows(
  bars: readonly Bar[],
  decisions: readonly { readonly eventTime: number; readonly action: string }[],
): { rows: RecordedRow[]; aligned: number } {
  const timestamps = bars.map((b) => b[0]!);
  const rows: RecordedRow[] = bars.map(() => ({ action: 'hold' as const }));
  let aligned = 0;

  for (const d of decisions) {
    if (d.action !== 'long' && d.action !== 'flat' && d.action !== 'hold') continue; // excludes 'error'
    let lo = 0;
    let hi = timestamps.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timestamps[mid]! <= d.eventTime) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx >= 0) {
      rows[idx] = { action: d.action };
      aligned++;
    }
  }
  return { rows, aligned };
}

export async function scoreRecordedEntries(): Promise<RecordedEntryScore> {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) return { skipped: true, reason: 'no DATABASE_URL' };

  const resetAllowed = process.env['DB_SUITE_ALLOW_RESET'] === '1' || dbNameEndsWithTest(dbUrl);
  if (!resetAllowed) {
    return {
      skipped: true,
      reason: 'DATABASE_URL set but DB_SUITE_ALLOW_RESET/_test gate not met',
    };
  }

  const bars = loadBars(REFERENCE_INTERVAL, REFERENCE_SYMBOL);
  if (!bars)
    return { skipped: true, reason: `no cached ${REFERENCE_SYMBOL}-${REFERENCE_INTERVAL} series` };

  const pool = new Pool({ connectionString: dbUrl });
  try {
    const db = drizzle(pool, { schema });
    const journal = new AgentDecisionJournalAdapter(db);
    const decisions = await journal.recent(DECISION_LIMIT);
    if (decisions.length === 0) return { skipped: true, reason: 'agent_decisions is empty' };

    const { rows, aligned } = alignRows(bars, decisions);
    if (aligned === 0) {
      return { skipped: true, reason: 'no decision row aligned to the cached candle window' };
    }

    const result = runBacktest(bars, () => new RecordedAgenticStrategy(rows));
    const tradeReturns = result.closedRoundTrips.map((c) => {
      const denom = c.entryVwap !== null && c.boughtQty.gt(0) ? c.entryVwap.mul(c.boughtQty) : null;
      return denom !== null && denom.gt(0) ? c.realizedPnl.div(denom).toNumber() : 0;
    });
    const expectancyBps =
      tradeReturns.length > 0
        ? (tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length) * 1e4
        : null;

    return {
      skipped: false,
      rowsConsidered: decisions.length,
      alignedRows: aligned,
      trades: result.closedRoundTrips.length,
      expectancyBps,
      stats: sharpeStats(tradeReturns),
    };
  } finally {
    await pool.end();
  }
}
