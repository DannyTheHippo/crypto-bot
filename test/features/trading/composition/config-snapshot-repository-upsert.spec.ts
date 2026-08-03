import { describe, it, expect } from 'vitest';
import { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ConfigSnapshotRepository } from '../../../../src/database/repositories/trading/config-snapshot.repository';
import * as schema from '../../../../src/database/schemas/trading';

// No repository in this codebase has a mocked-drizzle unit spec today (repositories are otherwise
// exercised only by the env-gated test/db Postgres suite, out of scope here) — this is a minimal
// fake of the insert().values().onConflictDoUpdate() chain, just enough to capture the built
// config passed to onConflictDoUpdate without touching a real database.
function fakeDb() {
  const calls: { table: unknown; values: unknown; conflict: { target: unknown; set: unknown } }[] =
    [];
  const db = {
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: (conflict: { target: unknown; set: unknown }) => {
          calls.push({ table, values, conflict });
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: db as unknown as NodePgDatabase<typeof schema>, calls };
}

describe('ConfigSnapshotRepository.upsert', () => {
  // Reader (the sweep's W3 check, not this repo) selects `order by activated_at desc limit 1` to
  // find the CURRENTLY running config. onConflictDoNothing would leave a re-activated hash's
  // activated_at at its first-ever activation, so a deploy A -> B -> A would make the reader keep
  // returning B (not running) — a false drift alarm on a correct config. Bumping on conflict makes
  // "newest activated_at" == "currently running config" by construction.
  it('bumps activated_at to now() on conflict, targeted on the hash PK, rather than doing nothing', async () => {
    const { db, calls } = fakeDb();
    const repo = new ConfigSnapshotRepository(db);
    await repo.upsert({ hash: 'abc123', config: { agentic: { model: 'claude' } }, mode: 'paper' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe(schema.configSnapshots);
    expect(calls[0]!.values).toEqual({
      hash: 'abc123',
      config: { agentic: { model: 'claude' } },
      mode: 'paper',
    });
    expect(calls[0]!.conflict.target).toBe(schema.configSnapshots.hash);
    // set.activatedAt is a DB-computed now() — a JS Date here would bake in this process's clock
    // instead of the DB's, so it must be an SQL fragment, not a literal timestamp.
    expect(calls[0]!.conflict.set).toHaveProperty('activatedAt');
    expect((calls[0]!.conflict.set as { activatedAt: unknown }).activatedAt).toBeInstanceOf(SQL);
  });
});
