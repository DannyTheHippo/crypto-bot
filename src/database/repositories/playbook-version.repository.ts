import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';

export interface PlaybookVersionInsert {
  version: number;
  content: string;
  source: 'seed' | 'reflection' | 'promotion' | 'loop-candidate';
  parentVersion?: number;
}

export type PlaybookVersionDbRow = typeof schema.agentPlaybookVersions.$inferSelect;

@Injectable()
export class PlaybookVersionRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(row: PlaybookVersionInsert): Promise<void> {
    await requireDb(this.db).insert(schema.agentPlaybookVersions).values(row);
  }

  async findByVersion(version: number): Promise<PlaybookVersionDbRow | null> {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.agentPlaybookVersions)
      .where(eq(schema.agentPlaybookVersions.version, version))
      .limit(1);
    return rows[0] ?? null;
  }

  async findLatestBySource(
    source: 'seed' | 'reflection' | 'promotion',
  ): Promise<PlaybookVersionDbRow | null> {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.agentPlaybookVersions)
      .where(eq(schema.agentPlaybookVersions.source, source))
      // version is monotonic and unique — ordering by it directly gives "most recently appended"
      // without relying on wall-clock createdAt tiebreaks.
      .orderBy(desc(schema.agentPlaybookVersions.version))
      .limit(1);
    return rows[0] ?? null;
  }

  async maxVersion(): Promise<number> {
    const rows = await requireDb(this.db)
      .select({ version: schema.agentPlaybookVersions.version })
      .from(schema.agentPlaybookVersions)
      .orderBy(desc(schema.agentPlaybookVersions.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  async listVersions(limit: number): Promise<PlaybookVersionDbRow[]> {
    return requireDb(this.db)
      .select()
      .from(schema.agentPlaybookVersions)
      .orderBy(desc(schema.agentPlaybookVersions.version))
      .limit(limit);
  }
}
