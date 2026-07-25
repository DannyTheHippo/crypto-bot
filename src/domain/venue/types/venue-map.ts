import type { SymbolId } from '../../common/types/ids';
import { venueId, type VenueId } from '../../common/types/ids';
import { splitSymbol } from './symbol';

// v3 spec §1.2: the single, canonical symbol→venue resolution. Pure (imports only domain types) —
// this is the one source every composition/config/execution site reads instead of a local
// `PERP_VENUE_ID` copy or the transitional `venueIdForSymbol` helpers (environment.config.ts,
// position-sizer.service.ts, execution.module.ts, app.module.ts's `primaryVenue`/`feedVenueConfig`).
export const SPOT_VENUE = 'binance';
export const PERP_VENUE = 'binanceusdm';

export const SPOT_VENUE_ID: VenueId = venueId(SPOT_VENUE);
export const PERP_VENUE_ID: VenueId = venueId(PERP_VENUE);

// A `:SETTLE`-suffixed symbol (ccxt's linear-swap form) is perp; everything else is spot. Throws
// only if splitSymbol itself throws (unparseable symbol) — callers already validate symbol shape
// upstream (TRADING_SYMBOLS zod parse), so this never needs its own try/catch.
export function venueForSymbol(symbol: SymbolId): VenueId {
  return splitSymbol(symbol).settle !== undefined ? PERP_VENUE_ID : SPOT_VENUE_ID;
}
