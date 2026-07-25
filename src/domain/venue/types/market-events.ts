import type { Price, Qty } from '../../common/types/money';
import type { VenueId, SymbolId, EpochMs } from '../../common/types/ids';

// ── Shared envelope ──────────────────────────────────────────────────────────

interface EventEnvelope {
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly channel: string;
  readonly seq: bigint;
  readonly eventTime: EpochMs;
  readonly ingestTime: EpochMs;
  readonly gapBefore?: boolean;
  readonly stale?: boolean;
  readonly conflatedCount?: number;
  readonly eventTimeSynthetic?: boolean;
}

// ── CandleInterval ───────────────────────────────────────────────────────────

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

// ── ChannelHealth ────────────────────────────────────────────────────────────

export type ChannelHealth = 'LIVE' | 'DEGRADED' | 'GAP';

// ── Event types ──────────────────────────────────────────────────────────────

export interface TickerEvent extends EventEnvelope {
  readonly kind: 'TICKER';
  readonly bid: Price;
  readonly ask: Price;
  readonly last: Price;
}

export interface TradeEvent extends EventEnvelope {
  readonly kind: 'TRADE';
  readonly price: Price;
  readonly qty: Qty;
  readonly side: 'BUY' | 'SELL';
  readonly tradeId: string;
}

export interface CandleEvent extends EventEnvelope {
  readonly kind: 'CANDLE';
  readonly interval: CandleInterval;
  readonly openTime: EpochMs;
  readonly closeTime: EpochMs;
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
  readonly volume: Qty;
  readonly closed: boolean;
}

export interface OrderLevel {
  readonly price: Price;
  readonly qty: Qty;
}

export interface OrderBookSnapshotEvent extends EventEnvelope {
  readonly kind: 'ORDER_BOOK_SNAPSHOT';
  readonly bids: readonly OrderLevel[];
  readonly asks: readonly OrderLevel[];
}

// ── Discriminated union ──────────────────────────────────────────────────────

export type MarketEvent = TickerEvent | TradeEvent | CandleEvent | OrderBookSnapshotEvent;
