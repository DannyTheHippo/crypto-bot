import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';

// Structural mirror of FundingSinkPort's FundingEventPayload (features/venue/exchange/
// paper-perp.adapter.ts). Declared here rather than imported because the boundaries wall forbids
// database/ → features/*; the branded ids/EpochMs the adapter passes widen to these base types, so
// the class satisfies FundingSinkPort structurally where the composition root binds it.
export interface FundingEventInsert {
  readonly mode: 'paper' | 'testnet' | 'live';
  readonly strategyId: string;
  readonly venue: string;
  readonly symbol: string;
  readonly fundingRate: string;
  readonly markPrice: string;
  readonly signedQty: string;
  readonly paymentQuote: string;
  readonly fundingTime: number;
}

// Drizzle-backed FUNDING_SINK: the writer funding_events never had. INSERT-ONLY by design — the
// table carries the append-only REVOKE + immutable trigger (drizzle/0001_v3_append_only_hardening.sql,
// hard rule 6), so an UPDATE/DELETE would be rejected at the DB and this class offers no such method.
@Injectable()
export class FundingEventsRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  // Money crosses as the exact NUMERIC(38,18) strings the adapter computed (numericMoney passes them
  // through verbatim) — never a float, never re-parsed. fundingTime arrives as epoch ms and is
  // handed to the timestamptz column as a Date.
  async record(row: FundingEventInsert): Promise<void> {
    await requireDb(this.db)
      .insert(schema.fundingEvents)
      .values({
        strategyId: row.strategyId,
        venue: row.venue,
        symbol: row.symbol,
        fundingRate: row.fundingRate,
        markPrice: row.markPrice,
        signedQty: row.signedQty,
        paymentQuote: row.paymentQuote,
        fundingTime: new Date(row.fundingTime),
        mode: row.mode,
      });
  }
}
