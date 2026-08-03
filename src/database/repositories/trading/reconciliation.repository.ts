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
  // 2026-07-29: the column defaults to now() and this field did not exist, so the store silently
  // dropped ReconciliationRow.ts and every row was stamped at INSERT time instead of at the instant
  // the pass measured. Identical in ordinary operation and different exactly when it matters — a slow
  // or retried write. Carried explicitly now so the audit row's clock is the pass's clock.
  ts: Date;
  durationMs: number;
  openOrdersChecked: number;
  tradesChecked: number;
  balancesChecked: number;
  discrepancies: unknown;
  // 'ERROR' (2026-08-03): a pass that threw before completing its axis chain. Plain unconstrained
  // `text` column with no DB CHECK (0000_v3_initial.sql), same TS-level-only enum convention as
  // signals.kind / agent_playbook_versions.source — so the new member needs no migration.
  result: 'CLEAN' | 'MISMATCH' | 'HALT' | 'ERROR';
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
