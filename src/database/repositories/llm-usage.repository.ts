import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';

export interface LlmUsageInsert {
  kind: 'decide' | 'reflection';
  model: string;
  mode: 'paper' | 'testnet' | 'live';
  strategyId: string | null;
  inputTokens: number;
  outputTokens: number;
}

@Injectable()
export class LlmUsageRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(row: LlmUsageInsert): Promise<void> {
    await requireDb(this.db).insert(schema.llmUsage).values(row);
  }
}
