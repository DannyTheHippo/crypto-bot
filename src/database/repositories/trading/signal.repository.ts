import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

export interface SignalInsert {
  signalId: string;
  strategyId: string;
  venue: string;
  symbol: string;
  kind: string;
  strength: string;
  limitPriceHint?: string;
  refPrice: string;
  basedOnSeq: bigint;
  eventTime: number;
  ttlMs: number;
  dedupeKey: string;
  reason: string;
  outcome: string;
  intentId?: string;
  mode: 'paper' | 'testnet' | 'live';
  runId: string;
  bootId: string;
}

@Injectable()
export class SignalRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(signal: SignalInsert): Promise<void> {
    await requireDb(this.db).insert(schema.signals).values(signal);
  }
}
