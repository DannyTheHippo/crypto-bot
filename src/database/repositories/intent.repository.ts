import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';

export interface IntentInsert {
  intentId: string;
  clientOrderId: string;
  strategyId: string;
  venue: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  // Push 3 P7b: widened to the full OrderIntent['type'] union (STOP_LOSS_LIMIT/STOP_MARKET venue
  // trigger orders) — TS-level only; the underlying column is plain unconstrained text.
  type: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER' | 'STOP_LOSS_LIMIT' | 'STOP_MARKET';
  qty: string;
  limitPrice?: string;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  reduceOnly: boolean;
  refPrice: string;
  refSeq: bigint;
  createdAt: number;
  expiresAt: number;
  sourceDedupeKey: string;
  sourceEventTime: number;
  sourceBasedOnSeq: bigint;
  sourceStrength: string;
  signalId?: string;
  riskIntentHash?: string;
  riskHmac?: string;
  riskNonce?: string;
  riskApprovedAtMs?: number;
  riskLimitsVersion?: string;
  riskSnapshotSeq?: bigint;
  mode: 'paper' | 'testnet' | 'live';
  runId: string;
  bootId: string;
}

@Injectable()
export class IntentRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(intent: IntentInsert): Promise<void> {
    await requireDb(this.db).insert(schema.orderIntents).values(intent);
  }

  async findById(intentId: string) {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.orderIntents)
      .where(eq(schema.orderIntents.intentId, intentId));
    return rows[0] ?? null;
  }
}
