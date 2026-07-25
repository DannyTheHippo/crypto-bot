import type { VenueId, SymbolId } from '../../common/types/ids';
import type { CandleInterval } from './market-events';

// A market-data subscription descriptor. Pure data — lives in the domain so both
// the Strategy interface (domain) and the MarketData ports can reference it
// without the domain importing ports (which the boundary wall forbids).
export interface SubscriptionSpec {
  readonly venue: VenueId;
  readonly symbols: readonly SymbolId[];
  readonly channels: {
    readonly ticker?: boolean;
    readonly trades?: boolean;
    readonly candles?: readonly CandleInterval[];
    readonly book?: boolean;
  };
}
