import type { Price, Qty } from './money';
import type { StrategyId, VenueId, SymbolId, IntentId, ClientOrderId, EpochMs } from './ids';
import type { TradingMode } from './mode';
import type { Signal } from './signal';

export interface OrderIntent {
  readonly intentId: IntentId;
  readonly clientOrderId: ClientOrderId;
  readonly strategyId: StrategyId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly type: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER';
  readonly qty: Qty;
  readonly limitPrice?: Price;
  readonly timeInForce: 'GTC' | 'IOC' | 'FOK';
  readonly reduceOnly: boolean;
  readonly mode: TradingMode;
  readonly refPrice: Price;
  readonly refSeq: bigint;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly source: Pick<Signal, 'dedupeKey' | 'eventTime' | 'basedOnSeq' | 'strength'>;
}
