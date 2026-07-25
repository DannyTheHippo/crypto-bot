import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

export interface ModeTransitionInsert {
  fromMode: string;
  toMode: string;
  actor: string;
  evidence: unknown;
  bootId: string;
}

@Injectable()
export class ModeTransitionRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(row: ModeTransitionInsert): Promise<void> {
    await requireDb(this.db).insert(schema.modeTransitions).values(row);
  }
}
