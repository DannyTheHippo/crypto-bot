import type { VenueId, SymbolId, EpochMs } from '../../domain/common/types/ids';
import type { SubscriptionSpec } from './market-data';

export const EXCHANGE_STREAM = Symbol('EXCHANGE_STREAM');

/**
 * Raw market event from the venue, before normalization.
 * Money fields are strings (ccxt number: String mode).
 * Order book levels carry floats (ccxt stores them unconditionally as floats)
 * — treat as reference-grade, not exact.
 */
export interface RawVenueEvent {
  readonly type: 'ticker' | 'trade' | 'candle' | 'book';
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly timestamp: EpochMs | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly raw: any;
}

/**
 * Raw private/user event from the venue (order updates, fills, balance changes).
 * Money fields are strings (ccxt number: String mode).
 * Consumed exclusively by ExecutionModule (Phase 7).
 */
export interface RawUserEvent {
  readonly type: 'order' | 'trade' | 'balance';
  readonly venue: VenueId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly raw: any;
}

export interface ExchangeStreamPort {
  marketRaw(spec: SubscriptionSpec): AsyncIterable<RawVenueEvent>;
  /**
   * Private user-data stream (order fills, balance updates).
   * TODO(Phase 7): implement Binance WS-API userDataStream.subscribe; this returns a
   * never-resolving empty iterable in Phase 2 to satisfy the port contract.
   */
  userEvents(): AsyncIterable<RawUserEvent>;
}
