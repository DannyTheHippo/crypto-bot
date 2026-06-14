/**
 * DB integration — runtime persistence adapters wired by the composition root.
 * Requires a live PostgreSQL 16 at DATABASE_URL (same guard as persistence.spec.ts).
 *
 * The Drizzle execution-store / outbox / journal repositories are already exercised by
 * persistence.spec.ts. This suite covers the genuinely-new runtime behavior the override
 * adapters add on top of those repos: the pg_advisory single-writer lock (§1/§6), which has
 * no in-memory analogue beyond a same-process guard.
 *
 * Run unsandboxed:
 *   DB_SUITE_ALLOW_RESET=1 DATABASE_URL=postgres://cryptobot:cryptobot@127.0.0.1:5432/cryptobot_test pnpm test:db
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgAdvisoryInstanceLock } from '../../src/modules/persistence/repositories/pg-advisory-instance-lock';

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

describe.skipIf(SKIP)('DB integration — PgAdvisoryInstanceLock (single-writer interlock)', () => {
  let pool: Pool;

  beforeAll(() => {
    // max >= 2 so two locks can hold distinct sessions concurrently — the whole point of the test.
    pool = new Pool({ connectionString: DB_URL!, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  }, 10_000);

  it('a second instance contending for the same (venue,key) is refused', async () => {
    const first = new PgAdvisoryInstanceLock(pool);
    const second = new PgAdvisoryInstanceLock(pool);

    await first.acquire('binance', 'fp-shared');
    await expect(second.acquire('binance', 'fp-shared')).rejects.toThrow(/contention/i);

    // Releasing the first frees the key; the second can then acquire it.
    await first.release();
    await expect(second.acquire('binance', 'fp-shared')).resolves.toBeUndefined();
    await second.release();
  });

  it('locks on distinct keys do not contend', async () => {
    const a = new PgAdvisoryInstanceLock(pool);
    const b = new PgAdvisoryInstanceLock(pool);
    await a.acquire('binance', 'fp-a');
    await expect(b.acquire('binance', 'fp-b')).resolves.toBeUndefined();
    await a.release();
    await b.release();
  });

  it('a single instance refuses to hold two locks at once', async () => {
    const lock = new PgAdvisoryInstanceLock(pool);
    await lock.acquire('binance', 'fp-1');
    await expect(lock.acquire('binance', 'fp-2')).rejects.toThrow(/already held/i);
    await lock.release();
  });
});
