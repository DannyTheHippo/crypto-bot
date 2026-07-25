import type { EpochMs, SymbolId, VenueId } from '../../domain/common/types/ids';
import type {
  CandleEvent,
  CandleInterval,
  ChannelHealth,
  MarketEvent,
} from '../../domain/venue/types/market-events';
import type { Price } from '../../domain/common/types/money';
import type { SubscriptionSpec } from '../../domain/venue/types/subscription';

// SubscriptionSpec is a pure domain descriptor; re-exported here for the many
// market-data consumers that import it alongside these tokens.
export type { SubscriptionSpec } from '../../domain/venue/types/subscription';

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
  // Write half of the risk mark. TeeingMarketStream calls this on every ticker/book event; RiskEngine
  // reads via getRefPrice. Required (not optional): a facade that implements getRefPrice but omits
  // this method compiles against a cast and then silently drops every mark — the 2026-07-23
  // zero-fills defect (VenueRoutingFeedHealth). Isolation noops no-op it.
  updateRefPrice(symbol: SymbolId, mid: Price, at: EpochMs): void;
  fetchCandles(
    venue: VenueId,
    symbol: SymbolId,
    interval: CandleInterval,
    n: number,
  ): Promise<readonly CandleEvent[]>;
  // v3 spec §1.3: the composition root's per-venue routing facade (VenueRoutingFeedHealth,
  // market-streams.module.ts) answers a symbol-less aggregate query — the worst channel health
  // across every channel it tracks on either venue. Optional (additive) so every existing
  // implementer (FeedHealthService, the risk/execution isolation noops, test fakes) keeps compiling
  // unchanged; only the routing facade implements it.
  worstHealth?(): ChannelHealth;
}

// Market-stream telemetry for the metrics pull loop — a SEPARATE token/port rather than an
// extension of FeedHealthPort, so the risk/execution modules' isolation noops (which implement
// FeedHealthPort) stay untouched. The composition root binds it to the live FeedHealthService when
// one exists (real runtime) and to an inert stub otherwise (test/ci); MetricsService consumes it
// @Optional, mirroring the derivatives-feed staleness pattern.
export const MARKET_STREAM_TELEMETRY = Symbol('MARKET_STREAM_TELEMETRY');

export interface MarketChannelAge {
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly channel: string;
  readonly ageSeconds: number;
  readonly health: ChannelHealth;
}

export interface MarketStreamTelemetryPort {
  channelAges(): readonly MarketChannelAge[];
  forcedReconnectCount(): number;
  // v3 §8: per-venue breakdown feeding the venue-labeled market_stream_forced_reconnects_total
  // counter (metrics.service.ts). Optional (additive) so every existing implementer keeps compiling
  // unchanged; VenueRoutingFeedHealth (market-streams.module.ts) is the only real implementer today
  // — metrics.service.ts's own aggregate call site is a separate integration left for the consumer
  // to pick up (out of this module's file scope).
  forcedReconnectCountByVenue?(): ReadonlyMap<VenueId, number>;
}
