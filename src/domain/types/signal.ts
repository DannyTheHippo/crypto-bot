import type { Price } from './money';
import type { StrategyId, VenueId, SymbolId, EpochMs } from './ids';

export interface Signal {
  readonly strategyId: StrategyId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly kind: 'ENTER_LONG' | 'EXIT_LONG' | 'FLATTEN' | 'CANCEL_OPEN';
  readonly strength: number;
  readonly limitPriceHint?: Price;
  readonly refPrice: Price;
  readonly basedOnSeq: bigint;
  readonly eventTime: EpochMs;
  readonly ttlMs: number;
  readonly dedupeKey: string;
  readonly reason: string;
}
