import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

export interface ReconciliationInsert {
  // v3 (consolidation spec §2): venue-scoped operational fact — ReconciliationService iterates
  // VENUE_REGISTRY and writes one row per venue pass, so venue is required (no lane-wide aggregate
  // row exists).
  venue: string;
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
