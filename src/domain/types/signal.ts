import type { Price } from './money';
import type { StrategyId, VenueId, SymbolId, EpochMs } from './ids';

export interface Signal {
  readonly strategyId: StrategyId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly kind:
    | 'ENTER_LONG'
    | 'EXIT_LONG'
    | 'ENTER_SHORT'
    | 'EXIT_SHORT'
    | 'FLATTEN'
    | 'CANCEL_OPEN';
  readonly strength: number;
  // Only meaningful on kind CANCEL_OPEN: scopes the cancel to one side. Absent ⇒ cancel both sides
  // (today's behavior, unchanged) — see SignalSinkService.cancelOpenForSignal.
  readonly cancelSide?: 'BUY' | 'SELL';
  readonly limitPriceHint?: Price;
  // Passive-exit hint (plan-mode take-profit): a reduce-only exit signal with exitStyle 'RESTING'
  // rests at limitPriceHint (GTC) instead of crossing the spread; absent hint falls back to the
  // existing IOC crossing path — see PositionSizerService.size.
  readonly exitStyle?: 'RESTING';
  readonly refPrice: Price;
  readonly basedOnSeq: bigint;
  readonly eventTime: EpochMs;
  readonly ttlMs: number;
  readonly dedupeKey: string;
  readonly reason: string;
}
