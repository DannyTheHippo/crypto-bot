import type {
  MarketEvent,
  CandleEvent,
  CandleInterval,
  ChannelHealth,
} from '../domain/types/market-events';
import type { Price } from '../domain/types/money';
import type { VenueId, SymbolId, EpochMs } from '../domain/types/ids';
import type { SubscriptionSpec } from '../domain/types/subscription';

// SubscriptionSpec is a pure domain descriptor; re-exported here for the many
// market-data consumers that import it alongside these tokens.
export type { SubscriptionSpec } from '../domain/types/subscription';

export const MARKET_STREAM = Symbol('MARKET_STREAM');
export const FEED_HEALTH = Symbol('FEED_HEALTH');
// The composition root's single live FeedHealth instance (ccxt-backed, populated by the running
// market-data feed). Risk/Execution self-provide a noop FEED_HEALTH for isolation; when this global
// is present (a real paper/demo runtime, never under test/ci) their FEED_HEALTH factories prefer it
// so the RiskEngine's mark and the EquitySampler's equity read the same live ref-prices the strategy
// host sees. @Optional everywhere it is consumed — absent ⇒ noop, so module boot tests are unaffected.
export const REAL_FEED_HEALTH = Symbol('REAL_FEED_HEALTH');

export interface MarketStreamPort {
  subscribe(spec: SubscriptionSpec): AsyncIterable<MarketEvent>;
}

export interface FeedHealthPort {
  health(venue: VenueId, symbol: SymbolId, channel: string): ChannelHealth;
  getRefPrice(symbol: SymbolId): { mid: Price; at: EpochMs } | undefined;
  fetchCandles(
    venue: VenueId,
    symbol: SymbolId,
    interval: CandleInterval,
    n: number,
  ): Promise<readonly CandleEvent[]>;
}
