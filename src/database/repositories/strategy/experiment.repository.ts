import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

export interface ExperimentInsert {
  family: string;
  paramsHash: string;
  datasetHash: string;
  source: 'loop' | 'reflection' | 'human' | 'study';
  label?: string;
  metrics?: unknown;
}

export type ExperimentDbRow = typeof schema.experiments.$inferSelect;

@Injectable()
export class ExperimentRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(row: ExperimentInsert): Promise<void> {
    await requireDb(this.db).insert(schema.experiments).values(row);
  }

  // Counts distinct (family, params_hash, dataset_hash) triples for a family — the honest N for
  // the deflated-Sharpe multiple-testing gate (a family re-run at the same params/dataset does not
  // inflate N; a genuinely new params or dataset combination does).
  async countDistinctTrials(family: string): Promise<number> {
    const db = requireDb(this.db);
    // ::int keeps the driver returning a JS number (COUNT's bare int8 arrives as a string).
    const result = await db.execute<{ count: number }>(sql`
      SELECT COUNT(DISTINCT (${schema.experiments.paramsHash}, ${schema.experiments.datasetHash}))::int AS count
      FROM ${schema.experiments}
      WHERE ${schema.experiments.family} = ${family}
    `);
    return result.rows[0]?.count ?? 0;
  }

  async listByFamily(family: string, limit: number): Promise<ExperimentDbRow[]> {
    return requireDb(this.db)
      .select()
      .from(schema.experiments)
      .where(eq(schema.experiments.family, family))
      .orderBy(desc(schema.experiments.id))
      .limit(limit);
  }
}
