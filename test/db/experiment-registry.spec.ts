/**
 * DB integration — experiments registry (N1). Same guard as persistence.spec.ts (DB_SUITE_ALLOW_RESET
 * or a `_test`-suffixed DATABASE_URL).
 *
 * Deliberately does NOT run `DROP SCHEMA public CASCADE`: persistence.spec.ts owns that reset, and
 * a second file doing it too would race under Vitest's default fileParallelism. That race is not
 * just theoretical — an earlier version of this suite polled for the `experiments` table instead of
 * migrating, and intermittently observed the table vanish mid-run when persistence.spec.ts's reset
 * fired concurrently in a sibling worker. The `test:db` script therefore runs with
 * `--no-file-parallelism` (package.json), which serializes every file in test/db/ against the
 * others; given that guarantee, this file safely runs its own idempotent `migrate()` (no schema
 * drop) so it does not depend on execution order relative to persistence.spec.ts.
 *
 * Run unsandboxed:
 *   DB_SUITE_ALLOW_RESET=1 DATABASE_URL=postgres://cryptobot:cryptobot@127.0.0.1:5432/cryptobot_test pnpm test:db
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as path from 'path';
import * as schema from '../../src/database/schemas/trading';
import { ExperimentRepository } from '../../src/database/repositories/experiment.repository';
import { PRIOR_TRIAL_ROWS } from '../backtest/experiment-log';
import { PRIOR_TRIALS } from '../backtest/trial-registry';

const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

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

describe.skipIf(SKIP)('DB integration — experiments registry', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL! });
    db = drizzle(pool, { schema });
    // Idempotent — drizzle's migrator tracks applied migrations in its own bookkeeping table and
    // is a no-op for migrations already present. No schema drop here (see header comment).
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  }, 10_000);

  it('(a) experiments table exists with the expected append-only shape', async () => {
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'experiments'`,
    );
    expect(tables.rows).toHaveLength(1);

    const ident = await pool.query<{ is_identity: string }>(
      `SELECT is_identity FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'experiments' AND column_name = 'id'`,
    );
    expect(ident.rows[0]?.is_identity).toBe('YES');

    const idx = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'experiments'
         AND indexname = 'experiments_family_params_dataset_idx'`,
    );
    expect(idx.rows).toHaveLength(1);
  });

  // ── (b) idempotent 52-bucket backfill: skip when rows already exist for the family ──────────
  it('(b) backfills PRIOR_TRIALS rows for SeedEntryStrategy once, and is idempotent on re-run', async () => {
    const repo = new ExperimentRepository(db);
    const existing = await repo.countDistinctTrials('SeedEntryStrategy');
    if (existing === 0) {
      const rows = PRIOR_TRIAL_ROWS();
      for (const row of rows) {
        await repo.insert(row);
      }
    }
    const afterFirst = await repo.countDistinctTrials('SeedEntryStrategy');
    expect(afterFirst).toBeGreaterThan(0);

    // Re-running the "skip when rows exist" guard must not attempt a second backfill (idempotent
    // at the harness-invocation level — this suite itself is the only writer under test).
    const beforeSecondCheck = await repo.countDistinctTrials('SeedEntryStrategy');
    if (beforeSecondCheck === 0) {
      for (const row of PRIOR_TRIAL_ROWS()) await repo.insert(row);
    }
    const afterSecond = await repo.countDistinctTrials('SeedEntryStrategy');
    expect(afterSecond).toBe(afterFirst);
  });

  // ── (c) append-only: UPDATE/DELETE rejected ──────────────────────────────────────────────────
  it('(c) UPDATE on experiments raises exception', async () => {
    await pool.query(
      `INSERT INTO public.experiments (family, params_hash, dataset_hash, source, label)
       VALUES ('append-only-probe', 'ph', 'dh', 'human', 'probe')`,
    );
    await expect(
      pool.query(
        `UPDATE public.experiments SET label = 'tampered' WHERE family = 'append-only-probe'`,
      ),
    ).rejects.toThrow(/append-only|prohibited/i);
  });

  it('(c) DELETE on experiments raises exception', async () => {
    await expect(
      pool.query(`DELETE FROM public.experiments WHERE family = 'append-only-probe'`),
    ).rejects.toThrow(/append-only|prohibited/i);
  });

  it('(c) TRUNCATE on experiments raises exception', async () => {
    await expect(pool.query(`TRUNCATE public.experiments`)).rejects.toThrow(
      /append-only|prohibited/i,
    );
  });

  // ── (d) N-consistency: PRIOR_TRIALS covers at least every distinct trial logged so far ──────
  it('(d) PRIOR_TRIALS.length is at least the distinct trial count for SeedEntryStrategy', async () => {
    const repo = new ExperimentRepository(db);
    const distinct = await repo.countDistinctTrials('SeedEntryStrategy');
    expect(PRIOR_TRIALS.length).toBeGreaterThanOrEqual(distinct);
  });
});
