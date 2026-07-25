import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import type { FundingPaymentRow, FundingPaymentsPort } from '../../../ports/venue/funding-payments';
import type { TradingMode } from '../../../domain/trading/types/mode';
import type { SymbolId, VenueId } from '../../../domain/common/types/ids';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

// P5b writer + cursor-read side of funding_payments (0013_funding_payments.sql). Mirrors
// FillRepository's insertIdempotent (venue, symbol, venue_trade_id ⇒ venue, symbol,
// venue_payment_id) — ON CONFLICT DO NOTHING makes a re-poll overlapping the previous window's
// tail always safe to replay verbatim.
@Injectable()
export class FundingPaymentsRepository implements FundingPaymentsPort {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async record(rows: readonly FundingPaymentRow[]): Promise<void> {
    if (rows.length === 0) return;
    await requireDb(this.db)
      .insert(schema.fundingPayments)
      .values(
        rows.map((r) => ({
          venue: String(r.venue),
          symbol: String(r.symbol),
          venuePaymentId: r.venuePaymentId,
          amountQuote: r.amountQuote,
          fundingTime: r.fundingTime,
          mode: r.mode,
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.fundingPayments.venue,
          schema.fundingPayments.symbol,
          schema.fundingPayments.venuePaymentId,
        ],
      });
  }

  async latestFundingTimeMs(
    venue: VenueId,
    symbol: SymbolId,
    mode: TradingMode,
  ): Promise<number | null> {
    const rows = await requireDb(this.db)
      .select({ fundingTime: schema.fundingPayments.fundingTime })
      .from(schema.fundingPayments)
      .where(
        and(
          eq(schema.fundingPayments.venue, String(venue)),
          eq(schema.fundingPayments.symbol, String(symbol)),
          eq(schema.fundingPayments.mode, mode),
        ),
      )
      .orderBy(desc(schema.fundingPayments.fundingTime))
      .limit(1);
    return rows[0]?.fundingTime ?? null;
  }
}
