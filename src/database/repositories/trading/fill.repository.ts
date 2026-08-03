import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, sum } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

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

  // ON CONFLICT DO NOTHING on (mode, venue, symbol, venue_trade_id) UNIQUE — §6.6 fill idempotency,
  // mode-scoped since 0002_fills_mode_scoped_uidx.sql (see trading.schema.ts's fills header for the
  // paper-counter-reset collision that made mode load-bearing). The conflict target must name the
  // index columns exactly or Postgres cannot infer the arbiter and the insert throws.
  // Returns { inserted: true } on new row, { inserted: false } on duplicate (no-op).
  async insertIdempotent(fill: FillInsert): Promise<{ inserted: boolean }> {
    const rows = await requireDb(this.db)
      .insert(schema.fills)
      .values(fill)
      .onConflictDoNothing({
        target: [
          schema.fills.mode,
          schema.fills.venue,
          schema.fills.symbol,
          schema.fills.venueTradeId,
        ],
      })
      .returning({ fillId: schema.fills.fillId });
    return { inserted: rows.length > 0 };
  }

  // Mode-scoped for the same reason as the unique index above: an unscoped read would resolve a
  // PRIOR mode's row for a re-minted paper trade id and report it as this run's own fill — either a
  // spurious FILL_PAYLOAD_CONFLICT halt (saveFill's price/qty compare) or, via hasFill, a real fill
  // silently skipped by the trade axis's first filter.
  async fetchByTradeId(
    mode: FillInsert['mode'],
    venue: string,
    symbol: string,
    venueTradeId: string,
  ) {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.fills)
      .where(
        and(
          eq(schema.fills.mode, mode),
          eq(schema.fills.venue, venue),
          eq(schema.fills.symbol, symbol),
          eq(schema.fills.venueTradeId, venueTradeId),
        ),
      );
    return rows[0] ?? null;
  }

  // Authoritative filled total for one order — SUM over the idempotent fill journal, the source
  // the OMS cum cache is rebuilt from at recovery.
  async sumQtyByClientOrderId(clientOrderId: string): Promise<string> {
    const rows = await requireDb(this.db)
      .select({ total: sum(schema.fills.qty) })
      .from(schema.fills)
      .where(eq(schema.fills.clientOrderId, clientOrderId));
    return rows[0]?.total ?? '0';
  }
}
