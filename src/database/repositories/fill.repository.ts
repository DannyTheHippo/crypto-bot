import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';

export interface FillInsert {
  venue: string;
  symbol: string;
  venueTradeId: string;
  intentId?: string;
  clientOrderId: string;
  price: string;
  qty: string;
  feeCcy?: string;
  feeAmount?: string;
  feeResolved?: boolean;
  liquidity: 'maker' | 'taker';
  venueTimestamp: number;
  source: 'ws' | 'rest_reconcile' | 'paper';
  mode: 'paper' | 'testnet' | 'live';
  runId: string;
  bootId: string;
}

@Injectable()
export class FillRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  // ON CONFLICT DO NOTHING on (venue, symbol, venue_trade_id) UNIQUE — §6.6 fill idempotency.
  // Returns { inserted: true } on new row, { inserted: false } on duplicate (no-op).
  async insertIdempotent(fill: FillInsert): Promise<{ inserted: boolean }> {
    const rows = await requireDb(this.db)
      .insert(schema.fills)
      .values(fill)
      .onConflictDoNothing({
        target: [schema.fills.venue, schema.fills.symbol, schema.fills.venueTradeId],
      })
      .returning({ fillId: schema.fills.fillId });
    return { inserted: rows.length > 0 };
  }

  async fetchByTradeId(venue: string, symbol: string, venueTradeId: string) {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.fills)
      .where(
        and(
          eq(schema.fills.venue, venue),
          eq(schema.fills.symbol, symbol),
          eq(schema.fills.venueTradeId, venueTradeId),
        ),
      );
    return rows[0] ?? null;
  }
}
