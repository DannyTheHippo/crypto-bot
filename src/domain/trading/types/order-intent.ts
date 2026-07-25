import type { Price, Qty } from '../../common/types/money';
import type {
  StrategyId,
  VenueId,
  SymbolId,
  IntentId,
  ClientOrderId,
  EpochMs,
} from '../../common/types/ids';
import type { TradingMode } from './mode';
import type { Signal } from '../../strategy/types/signal';

export interface OrderIntent {
  readonly intentId: IntentId;
  readonly clientOrderId: ClientOrderId;
  readonly strategyId: StrategyId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  // STOP_LOSS_LIMIT/STOP_MARKET (Push 3 P7a): venue trigger-order variants. STOP_LOSS_LIMIT rests
  // on the regular spot order rail (ccxt unified type still 'limit'); STOP_MARKET is a swap-only
  // ALGO/conditional order (a separate rail — see CcxtExchangeAdapter.placeOrder). A trigger order
  // is always reduceOnly-intended at this layer but that is NOT hard-coupled here; enforcement is
  // Risk's job in a later phase.
  readonly type: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER' | 'STOP_LOSS_LIMIT' | 'STOP_MARKET';
  readonly qty: Qty;
  readonly limitPrice?: Price;
  // Trigger/stop price for STOP_LOSS_LIMIT/STOP_MARKET; absent for every other type.
  readonly triggerPrice?: Price;
  readonly timeInForce: 'GTC' | 'IOC' | 'FOK';
  readonly reduceOnly: boolean;
  readonly mode: TradingMode;
  readonly refPrice: Price;
  readonly refSeq: bigint;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly source: Pick<Signal, 'dedupeKey' | 'eventTime' | 'basedOnSeq' | 'strength'>;
}
