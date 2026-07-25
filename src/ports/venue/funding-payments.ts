import type { EpochMs, SymbolId, VenueId } from '../../domain/common/types/ids';
import type { TradingMode } from '../../domain/trading/types/mode';

// P5b: crosses the features/venue/exchange (funding-ingest.service.ts) ↔ database boundary —
// mirrors PROMOTION_STATS's own port-file-local token convention (ports/trading/promotion.ts).
export const FUNDING_PAYMENTS = Symbol('FUNDING_PAYMENTS');

// One row ready for idempotent insert — the DB-facing shape of ExchangePort's VenueFundingPayment
// (ports/venue/exchange.ts) plus the mode stamp promotion nets on.
export interface FundingPaymentRow {
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly venuePaymentId: string;
  readonly amountQuote: string;
  readonly fundingTime: EpochMs;
  readonly mode: TradingMode;
}

// Writer + cursor-read side (funding-ingest.service.ts). DB-only, no in-memory fallback — durability
// is load-bearing here (promotion math must survive a redeploy), so an absent binding means the
// poller simply never starts (composition-root gate), not a degraded in-memory substitute.
export interface FundingPaymentsPort {
  // Idempotent bulk insert — ON CONFLICT (venue, symbol, venue_payment_id) DO NOTHING, so a re-poll
  // overlapping the previous window's tail is always safe to replay verbatim.
  record(rows: readonly FundingPaymentRow[]): Promise<void>;
  // Newest persisted funding_time for (venue, symbol, mode), null when nothing has ever been
  // ingested — the poller's since-cursor: resume from here + 1ms rather than re-walking all history
  // every poll.
  latestFundingTimeMs(venue: VenueId, symbol: SymbolId, mode: TradingMode): Promise<number | null>;
}
