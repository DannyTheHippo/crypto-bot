import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

export interface ConfigSnapshotInsert {
  hash: string;
  config: unknown;
  mode: 'paper' | 'testnet' | 'live';
}

@Injectable()
export class ConfigSnapshotRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  // Bumps activated_at to now() on a re-activation of an already-seen hash, rather than leaving the
  // row at its first-ever activation time. The sweep's W3 reader selects `order by activated_at desc
  // limit 1` to find the CURRENTLY running config, so deploying A -> B -> A must leave A's
  // activated_at newest-first — onConflictDoNothing would instead leave A's original activation in
  // the past, so the reader would keep returning B (not running) and raise a false drift alarm on a
  // correct config. This deliberately trades away "first activation time" for "current activation
  // correctness": config_snapshots is a measurement table describing what is running now, not an
  // append-only evidence ledger of every activation that ever happened.
  async upsert(snapshot: ConfigSnapshotInsert): Promise<void> {
    await requireDb(this.db)
      .insert(schema.configSnapshots)
      .values(snapshot)
      .onConflictDoUpdate({
        target: schema.configSnapshots.hash,
        set: { activatedAt: sql`now()` },
      });
  }
}
