import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

export interface RiskDecisionInsert {
  intentId: string;
  verdict: 'APPROVED' | 'RESIZED' | 'REJECTED';
  reasons: string[];
  limitsVersion: string;
  snapshotSeq: bigint;
  inputsHash: string;
  mode: 'paper' | 'testnet' | 'live';
  runId: string;
  bootId: string;
}

@Injectable()
export class RiskDecisionRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(decision: RiskDecisionInsert): Promise<void> {
    await requireDb(this.db).insert(schema.riskDecisions).values(decision);
  }
}
