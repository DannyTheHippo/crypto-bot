// Optional eval dataset: scores REAL recorded agent_decisions rows from a live/staging database,
// when one is available. Read-only (no schema reset, no migration) — deliberately gentler than
// test/db/persistence.spec.ts, but mirrors its gate exactly (DATABASE_URL + the same
// DB_SUITE_ALLOW_RESET/_test-suffix opt-in) so this suite never silently queries an unintended
// database, even read-only. Skips entirely without both, so `pnpm eval:agentic` without
// DATABASE_URL exits 0.
import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../src/database/schemas/trading';
import { AgentDecisionJournalAdapter } from '../../../src/database/repositories/agent-decision-journal.adapter';
import {
  scoreRows,
  type ScoringRow,
} from '../../../src/features/trading/agentic/counterfactual-scoring';

const DB_URL = process.env['DATABASE_URL'];

function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

const resetAllowed =
  process.env['DB_SUITE_ALLOW_RESET'] === '1' || (!!DB_URL && dbNameEndsWithTest(DB_URL));

const SKIP = !DB_URL || !resetAllowed;

describe.skipIf(SKIP)(
  'agentic eval — recorded agent_decisions rows (optional, requires DATABASE_URL + db-test gate)',
  () => {
    it('scores real recorded rows into scorecards without throwing', async () => {
      const pool = new Pool({ connectionString: DB_URL! });
      try {
        const db = drizzle(pool, { schema });
        const journal = new AgentDecisionJournalAdapter(db);
        const rows: readonly ScoringRow[] = await journal.recent(500);

        const scorecards = scoreRows(rows);
        expect(Array.isArray(scorecards)).toBe(true);
        for (const card of scorecards) {
          expect(card.rowCount).toBeGreaterThan(0);
          expect(card.horizonStats).toHaveLength(3);
        }
      } finally {
        await pool.end();
      }
    });
  },
);
