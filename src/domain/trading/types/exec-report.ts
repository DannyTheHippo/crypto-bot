import type { Price, Qty, FeeAmount } from '../../common/types/money';
import type { VenueId, SymbolId, ClientOrderId, EpochMs } from '../../common/types/ids';

// ── Common fields on every exec report ───────────────────────────────────────

interface ExecReportBase {
  readonly reportId: string;
  readonly clientOrderId: ClientOrderId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly eventTime: EpochMs;
  readonly ingestTime: EpochMs;
}

// ── Individual report shapes ──────────────────────────────────────────────────

export interface AckReport extends ExecReportBase {
  readonly kind: 'ACK';
  readonly venueOrderId: string;
}

export interface RejectReport extends ExecReportBase {
  readonly kind: 'REJECT';
  readonly reason: string;
  readonly code?: string;
}

export interface FillReport extends ExecReportBase {
  readonly kind: 'FILL';
  readonly venueTradeId: string;
  readonly price: Price;
  readonly qty: Qty;
  readonly fee: { readonly ccy: string; readonly amount: FeeAmount } | null;
  readonly liquidity: 'maker' | 'taker';
  readonly venueTimestamp: EpochMs;
}

export interface CancelAckReport extends ExecReportBase {
  readonly kind: 'CANCEL_ACK';
}

export interface ExpireReport extends ExecReportBase {
  readonly kind: 'EXPIRE';
}

// ── Discriminated union ──────────────────────────────────────────────────────

export type ExecReport = AckReport | RejectReport | FillReport | CancelAckReport | ExpireReport;

// ── FillRecord (§6.6) ────────────────────────────────────────────────────────

export interface FillRecord {
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly venueTradeId: string;
  readonly clientOrderId: ClientOrderId;
  readonly price: Price;
  readonly qty: Qty;
  readonly fee: { readonly ccy: string; readonly amount: FeeAmount } | null;
  readonly liquidity: 'maker' | 'taker';
  readonly venueTimestamp: EpochMs;
  readonly source: 'ws' | 'rest_reconcile' | 'paper';
}
