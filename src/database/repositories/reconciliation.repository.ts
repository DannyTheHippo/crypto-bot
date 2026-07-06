import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';

export interface ReconciliationInsert {
  durationMs: number;
  openOrdersChecked: number;
  tradesChecked: number;
  balancesChecked: number;
  discrepancies: unknown;
  result: 'CLEAN' | 'MISMATCH' | 'HALT';
  mode: 'paper' | 'testnet' | 'live';
  runId: string;
  bootId: string;
}

@Injectable()
export class ReconciliationRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(row: ReconciliationInsert): Promise<void> {
    await requireDb(this.db).insert(schema.reconciliations).values(row);
  }
}
