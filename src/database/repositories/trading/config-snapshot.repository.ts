import { Inject, Injectable } from '@nestjs/common';
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

  async upsert(snapshot: ConfigSnapshotInsert): Promise<void> {
    await requireDb(this.db).insert(schema.configSnapshots).values(snapshot).onConflictDoNothing();
  }
}
