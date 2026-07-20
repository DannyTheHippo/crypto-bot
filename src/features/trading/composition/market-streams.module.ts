import { Global, Logger, Module } from '@nestjs/common';
import type { Exchange } from 'ccxt';
import Decimal from 'decimal.js';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { CLOCK, SystemClock, type ClockPort } from '../../../ports/clock';
import {
  EXCHANGE_STREAM,
  type ExchangeStreamPort,
  type RawUserEvent,
  type RawVenueEvent,
} from '../../../ports/exchange-stream';
import {
  FEED_HEALTH,
  MARKET_STREAM,
  MARKET_STREAM_TELEMETRY,
  REAL_FEED_HEALTH,
  type FeedHealthPort,
  type MarketChannelAge,
  type MarketStreamPort,
  type MarketStreamTelemetryPort,
  type SubscriptionSpec,
} from '../../../ports/market-data';
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue-registry';
import { VENUE_EXCHANGE_PORTS, type ExchangePort } from '../../../ports/exchange';
import type { VenueConfig, VenueEnvironment } from '../../../ports/app-config';
import type { VenueId, SymbolId, EpochMs } from '../../../domain/types/ids';
import { venueForSymbol } from '../../../domain/types/venue-map';
import type {
  ChannelHealth,
  CandleEvent,
  CandleInterval,
  OrderLevel,
} from '../../../domain/types/market-events';
import type { Price } from '../../../domain/types/money';
import {
  CcxtExchangeStreamAdapter,
  RealWatchSource,
  WATCH_SOURCE,
  buildCcxtExchange,
  type WatchSource,
  type ChannelTierResolver,
  type StreamAdapterLogger,
} from '../market-data/ccxt-stream.adapter';
import {
  FeedHealthServiceWithBackfill,
  type OhlcvSource,
} from '../market-data/feed-health.service';
import { MarketDataService } from '../market-data/market-data.service';
import {
  TeeingMarketStream,
  type PaperFeedSink,
  type RefPriceSink,
} from '../market-data/teeing-market-stream';

// v3 spec §1.3: MarketStreamsModule is MarketFeedModule's stream half, moved out of app.module.ts
// and made venue-plural. CLOCK/WATCH_SOURCE are unchanged (lane-wide singletons); everything else
// that used to assume ONE venue (MD_EXCHANGE, the single CcxtExchangeStreamAdapter, FeedHealthService)
// becomes a per-venue map plus a routing facade over it — same shape as ExchangeAdaptersModule's
// VENUE_EXCHANGE_PORTS/EXCHANGE_PORT pair.
// v3-final(#5b): retire the MarketFeedModule copies once the final AppModule assembly drops the old
// inline module — duplicate @Global() bindings of CLOCK/WATCH_SOURCE across both modules are harmless
// until then (identical SystemClock/RealWatchSource classes either way).

export const VENUE_MD_EXCHANGES = Symbol('VENUE_MD_EXCHANGES');
export const VENUE_FEED_HEALTH = Symbol('VENUE_FEED_HEALTH');

function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}

// Market data is public; default to live streams (realistic depth) regardless of trading mode —
// moved verbatim from app.module.ts's retired feedVenueConfig(), now keyed per registry descriptor
// instead of primaryVenue()-only.
export function feedVenueConfig(descriptor: VenueRuntimeDescriptor): VenueConfig {
  const environment = (process.env['FEED_ENV'] as VenueEnvironment | undefined) ?? 'live';
  return { id: descriptor.config.id, environment };
}

// Under test/ci this answers an empty map — no network client is ever constructed (mirrors the
// retired MD_EXCHANGE's own isTestEnv() short-circuit) — and every downstream provider below
// degrades to its NOOP shape by construction (an empty per-venue map, not a special-cased branch).
export function buildVenueMdExchanges(
  registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
): ReadonlyMap<VenueId, Exchange> {
  const exchanges = new Map<VenueId, Exchange>();
  if (isTestEnv()) return exchanges;
  for (const descriptor of registry.values()) {
    exchanges.set(descriptor.venue, buildCcxtExchange(feedVenueConfig(descriptor)));
  }
  return exchanges;
}

const NOOP_STREAM: ExchangeStreamPort = {
  marketRaw: (): AsyncIterable<RawVenueEvent> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined as never, done: true }),
    }),
  }),
  userEvents: (): AsyncIterable<RawUserEvent> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined as never, done: true }),
    }),
  }),
};

// One FeedHealthServiceWithBackfill per registry venue, scoped implicitly to that venue's own
// symbols (nothing else ever calls setHealth/recordEvent on it — only its own venue's
// CcxtExchangeStreamAdapter, wired as its stateTracker below). exchangeStream is NOOP_STREAM (never
// the real EXCHANGE_STREAM) to avoid a circular DI edge: EXCHANGE_STREAM's own factory needs these
// instances as each adapter's ChannelStateTracker, so they must not depend on EXCHANGE_STREAM back —
// same reasoning app.module.ts's retired REAL_FEED_HEALTH factory documented.
export function buildVenueFeedHealth(
  clock: ClockPort,
  registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
  exchanges: ReadonlyMap<VenueId, Exchange>,
): ReadonlyMap<VenueId, FeedHealthServiceWithBackfill> {
  const services = new Map<VenueId, FeedHealthServiceWithBackfill>();
  for (const descriptor of registry.values()) {
    const exchange = exchanges.get(descriptor.venue);
    if (!exchange) continue; // test/ci: no network client, no backfill service either
    services.set(
      descriptor.venue,
      new FeedHealthServiceWithBackfill(
        clock,
        NOOP_STREAM,
        exchange satisfies OhlcvSource,
        feedVenueConfig(descriptor),
      ),
    );
  }
  return services;
}

const HEALTH_RANK: Record<ChannelHealth, number> = { LIVE: 0, DEGRADED: 1, GAP: 2 };

// Exported (pure) so the ranking itself is unit-testable without constructing the facade.
export function worstChannelHealth(healths: readonly ChannelHealth[]): ChannelHealth {
  // No channel tracked anywhere yet matches FeedHealthService's own default for an unknown key: GAP,
  // never a silently-optimistic LIVE.
  if (healths.length === 0) return 'GAP';
  let worst: ChannelHealth = 'LIVE';
  for (const h of healths) {
    if (HEALTH_RANK[h] > HEALTH_RANK[worst]) worst = h;
  }
  return worst;
}

type VenueFeedHealth = FeedHealthPort & MarketStreamTelemetryPort;

// v3 spec §1.3: the symbol-routing FeedHealth facade. Every FeedHealthPort method that carries a
// symbol dispatches on venueForSymbol(symbol) — the single source of truth for venue routing (never
// the caller-supplied `venue` argument, mirroring VenueRoutingExchangeAdapter's own portForSymbol
// convention) — so a stale/wrong venue argument can never mis-route a health read. Unroutable symbols
// (a registry gap) answer the same safe defaults FeedHealthService uses for an unknown key (GAP /
// undefined / []) rather than throwing: this is a read-only health signal, not a money-moving
// dispatch, so it fails toward "treat as unhealthy/unknown", never toward a hard crash.
export class VenueRoutingFeedHealth implements VenueFeedHealth {
  constructor(private readonly perVenue: ReadonlyMap<VenueId, VenueFeedHealth>) {}

  private forSymbol(symbol: SymbolId): VenueFeedHealth | undefined {
    return this.perVenue.get(venueForSymbol(symbol));
  }

  health(venue: VenueId, symbol: SymbolId, channel: string): ChannelHealth {
    return this.forSymbol(symbol)?.health(venueForSymbol(symbol), symbol, channel) ?? 'GAP';
  }

  // The "no symbol" aggregate query (ports/market-data.ts's optional FeedHealthPort member) — worst
  // channel health across every channel either venue currently tracks.
  worstHealth(): ChannelHealth {
    return worstChannelHealth(
      [...this.perVenue.values()].flatMap((svc) => svc.channelAges().map((a) => a.health)),
    );
  }

  getRefPrice(symbol: SymbolId): { mid: Price; at: EpochMs } | undefined {
    return this.forSymbol(symbol)?.getRefPrice(symbol);
  }

  fetchCandles(
    venue: VenueId,
    symbol: SymbolId,
    interval: CandleInterval,
    n: number,
  ): Promise<readonly CandleEvent[]> {
    const svc = this.forSymbol(symbol);
    return svc
      ? svc.fetchCandles(venueForSymbol(symbol), symbol, interval, n)
      : Promise.resolve([]);
  }

  // Not part of FeedHealthPort — kept for parity with the per-venue ChannelStateTracker surface
  // (no production call site reaches the AGGREGATE facade for this today: each venue's own
  // CcxtExchangeStreamAdapter is wired directly against its OWN FeedHealthServiceWithBackfill
  // instance, never through this facade — see buildExchangeStream below).
  recordEvent(venue: VenueId, symbol: SymbolId, channel: string): void {
    void venue;
    (
      this.forSymbol(symbol) as
        | { recordEvent?(v: VenueId, s: SymbolId, c: string): void }
        | undefined
    )?.recordEvent?.(venueForSymbol(symbol), symbol, channel);
  }

  channelAges(): readonly MarketChannelAge[] {
    return [...this.perVenue.values()].flatMap((svc) => svc.channelAges());
  }

  forcedReconnectCount(): number {
    let total = 0;
    for (const svc of this.perVenue.values()) total += svc.forcedReconnectCount();
    return total;
  }

  forcedReconnectCountByVenue(): ReadonlyMap<VenueId, number> {
    return new Map(
      [...this.perVenue.entries()].map(([venue, svc]) => [venue, svc.forcedReconnectCount()]),
    );
  }
}

// One consumption loop per source, isolated: a source ending (its own supervised loops all stopped —
// the normal shutdown path) or throwing (a defect that escaped its own error handling) is logged via
// onSourceError and counted toward completion, but NEVER propagated to the other sources or to the
// merged consumer. The WATCH-R8-7 lesson generalizes directly to a two-venue merge: one venue going
// dark must never look like — or cause — the whole market-data stream going dark. Iterator handles
// (not `for await`) are retained so the merged stream's own return() can forward shutdown to every
// underlying supervised loop; a merge that never breaks out of `for await` would otherwise leak every
// venue's watchdog/timers forever. Exported (pure, no ccxt/DI dependency) so the isolation semantics
// are unit-testable with plain fake sources — CcxtExchangeStreamAdapter's own supervised loops never
// let an error escape their AsyncIterable by design (every run*Loop catches its own errors and keeps
// looping), so a fault-injection test needs a source that CAN throw, independent of that adapter.
export function mergeAsyncIterables<T>(
  sources: readonly { readonly venue: VenueId; readonly iterable: AsyncIterable<T> }[],
  onSourceError: (venue: VenueId, err: unknown) => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      const buffer: T[] = [];
      let resolveNext: ((v: IteratorResult<T>) => void) | null = null;
      let finished = sources.length === 0;
      let doneCount = 0;

      const push = (ev: T): void => {
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: ev, done: false });
        } else {
          buffer.push(ev);
        }
      };

      const finishIfAllDone = (): void => {
        if (finished || doneCount < sources.length) return;
        finished = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: undefined, done: true });
        }
      };

      const iterators = sources.map((s) => s.iterable[Symbol.asyncIterator]());

      sources.forEach((s, i) => {
        const iterator = iterators[i]!;
        void (async () => {
          try {
            for (;;) {
              const result = await iterator.next();
              if (result.done) break;
              push(result.value);
            }
          } catch (err) {
            onSourceError(s.venue, err);
          } finally {
            doneCount += 1;
            finishIfAllDone();
          }
        })();
      });

      return {
        next: (): Promise<IteratorResult<T>> => {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift() as T, done: false });
          }
          if (finished) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<T>>((res) => {
            resolveNext = res;
          });
        },
        return: (): Promise<IteratorResult<T>> => {
          finished = true;
          for (const iterator of iterators) {
            void iterator.return?.();
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

// v3 spec §1.3: interleaves both venues' CcxtExchangeStreamAdapters. spec.symbols is partitioned by
// venueForSymbol into one sub-spec per venue (spec.venue itself is not trusted for routing — no
// adapter reads its own spec.venue either, see ccxt-stream.adapter.ts's runXLoop methods, which always
// tag events with the adapter's OWN constructor-bound venueId); each venue's adapter only ever sees
// its own symbols. XA6 tiering forwards to every underlying adapter through one call so the
// composition-root caller (TradingRuntimeService, v3-final #5b) keeps the exact one-call-site shape
// app.module.ts used pre-v3 (instanceof MergedExchangeStream replaces instanceof
// CcxtExchangeStreamAdapter; same resolver reaches both venues).
export class MergedExchangeStream implements ExchangeStreamPort {
  constructor(
    private readonly adapters: ReadonlyMap<VenueId, CcxtExchangeStreamAdapter>,
    private readonly logger?: StreamAdapterLogger,
  ) {}

  setChannelTierResolver(resolver: ChannelTierResolver, pollMs?: number): void {
    for (const adapter of this.adapters.values()) {
      adapter.setChannelTierResolver(resolver, pollMs);
    }
  }

  private partitionSpec(spec: SubscriptionSpec): Map<VenueId, SubscriptionSpec> {
    const bySymbol = new Map<VenueId, SymbolId[]>();
    for (const symbol of spec.symbols) {
      const venue = venueForSymbol(symbol);
      const list = bySymbol.get(venue) ?? [];
      list.push(symbol);
      bySymbol.set(venue, list);
    }
    const result = new Map<VenueId, SubscriptionSpec>();
    for (const [venue, symbols] of bySymbol) {
      result.set(venue, { ...spec, venue, symbols });
    }
    return result;
  }

  marketRaw(spec: SubscriptionSpec): AsyncIterable<RawVenueEvent> {
    const perVenueSpecs = this.partitionSpec(spec);
    const sources: { venue: VenueId; iterable: AsyncIterable<RawVenueEvent> }[] = [];
    for (const [venue, subSpec] of perVenueSpecs) {
      const adapter = this.adapters.get(venue);
      if (adapter) {
        sources.push({ venue, iterable: adapter.marketRaw(subSpec) });
      } else {
        this.logger?.warn(
          `market-stream merge: no adapter registered for venue "${venue}" — its ` +
            `${subSpec.symbols.length} symbol(s) get no market data`,
        );
      }
    }
    return mergeAsyncIterables(sources, (venue, err) => this.logSourceError(venue, err));
  }

  userEvents(): AsyncIterable<RawUserEvent> {
    const sources = [...this.adapters.entries()].map(([venue, adapter]) => ({
      venue,
      iterable: adapter.userEvents(),
    }));
    return mergeAsyncIterables(sources, (venue, err) => this.logSourceError(venue, err));
  }

  private logSourceError(venue: VenueId, err: unknown): void {
    this.logger?.warn(
      `market-stream merge: venue "${venue}" source ended on an escaped error (isolated — the ` +
        `other venue's stream keeps flowing; WATCH-R8-7 lesson applied to a two-venue merge): ${
          err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)
        }`,
    );
  }
}

export function buildExchangeStream(
  clock: ClockPort,
  watchSource: WatchSource,
  registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
  feedHealthByVenue: ReadonlyMap<VenueId, FeedHealthServiceWithBackfill>,
  exchanges: ReadonlyMap<VenueId, Exchange>,
): ExchangeStreamPort {
  if (exchanges.size === 0) return NOOP_STREAM; // test/ci — see buildVenueMdExchanges
  const adapters = new Map<VenueId, CcxtExchangeStreamAdapter>();
  for (const descriptor of registry.values()) {
    const exchange = exchanges.get(descriptor.venue);
    const tracker = feedHealthByVenue.get(descriptor.venue);
    if (!exchange || !tracker) continue; // built 1:1 with exchanges above; defensive only
    adapters.set(
      descriptor.venue,
      new CcxtExchangeStreamAdapter(
        clock,
        watchSource,
        exchange,
        descriptor.venue,
        tracker,
        new Logger(`MarketStreamWatchdog:${descriptor.venue}`),
        undefined, // subscribeJitterFn: keep the production default
        // Recreation seam for the pinned-ccxt-4.5.58 closedByUser wedge (ccxt-stream.adapter.ts
        // header comment) — reuses the SAME venue-config construction buildVenueMdExchanges did.
        () => buildCcxtExchange(feedVenueConfig(descriptor)),
      ),
    );
  }
  return adapters.size > 0
    ? new MergedExchangeStream(adapters, new Logger('MarketStreamMerge'))
    : NOOP_STREAM;
}

function hasIngest(port: ExchangePort): port is ExchangePort & PaperFeedSink {
  return typeof (port as unknown as { ingestBook?: unknown }).ingestBook === 'function';
}

// §1.3: "paper feed sink resolves per event venue via the VENUE_EXCHANGE_PORTS paper adapters when
// present". TeeingMarketStream already threads ev.symbol into every ingestBook/ingestTrade call
// (teeing-market-stream.ts's observe()); this just routes that symbol to the right venue's paper
// adapter, mirroring VenueRoutingExchangeAdapter's portForSymbol convention. A venue with no
// ingest-capable port (demo/testnet/live) simply no-ops for that venue's symbols — exactly the
// single-venue behavior hasIngest already gated on.
export class VenueRoutingPaperFeedSink implements PaperFeedSink {
  constructor(private readonly ports: ReadonlyMap<VenueId, ExchangePort>) {}

  private portFor(symbol: SymbolId): (ExchangePort & PaperFeedSink) | undefined {
    const port = this.ports.get(venueForSymbol(symbol));
    return port && hasIngest(port) ? port : undefined;
  }

  ingestBook(symbol: SymbolId, bids: readonly OrderLevel[], asks: readonly OrderLevel[]): void {
    this.portFor(symbol)?.ingestBook(symbol, bids, asks);
  }

  async ingestTrade(symbol: SymbolId, print: { price: Decimal; qty: Decimal }): Promise<void> {
    await this.portFor(symbol)?.ingestTrade(symbol, print);
  }
}

export function buildMarketStream(
  exchangeStream: ExchangeStreamPort,
  clock: ClockPort,
  feedHealth: FeedHealthPort,
  ports: ReadonlyMap<VenueId, ExchangePort>,
  config: TypedConfigService,
): MarketStreamPort {
  const inner = new MarketDataService(exchangeStream, clock, {
    bandBps: config.marketData.bookBandBps,
    maxLevels: config.marketData.bookMaxLevels,
  });
  // Paper sim needs book/trade ingestion to fill; demo/testnet/live venues fill their own orders, so
  // a venue's paperFeed routing is absent unless AT LEAST ONE registered port is ingest-capable
  // (structural check, same convention as the retired single-venue hasIngest gate).
  const anyPaper = [...ports.values()].some(hasIngest);
  const paperFeed = anyPaper ? new VenueRoutingPaperFeedSink(ports) : undefined;
  return new TeeingMarketStream(
    inner,
    feedHealth as unknown as RefPriceSink,
    { ticker: true, book: true, ...(paperFeed !== undefined ? { trades: true } : {}) },
    paperFeed,
  );
}

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: WATCH_SOURCE, useClass: RealWatchSource },
    {
      provide: VENUE_MD_EXCHANGES,
      useFactory: buildVenueMdExchanges,
      inject: [VENUE_REGISTRY],
    },
    {
      provide: VENUE_FEED_HEALTH,
      useFactory: buildVenueFeedHealth,
      inject: [CLOCK, VENUE_REGISTRY, VENUE_MD_EXCHANGES],
    },
    {
      provide: REAL_FEED_HEALTH,
      useFactory: (perVenue: ReadonlyMap<VenueId, FeedHealthServiceWithBackfill>): FeedHealthPort =>
        new VenueRoutingFeedHealth(perVenue),
      inject: [VENUE_FEED_HEALTH],
    },
    { provide: FEED_HEALTH, useExisting: REAL_FEED_HEALTH },
    {
      provide: MARKET_STREAM_TELEMETRY,
      useFactory: (real: FeedHealthPort): MarketStreamTelemetryPort =>
        real as unknown as MarketStreamTelemetryPort,
      inject: [REAL_FEED_HEALTH],
    },
    {
      provide: EXCHANGE_STREAM,
      useFactory: buildExchangeStream,
      inject: [CLOCK, WATCH_SOURCE, VENUE_REGISTRY, VENUE_FEED_HEALTH, VENUE_MD_EXCHANGES],
    },
    {
      provide: MARKET_STREAM,
      useFactory: buildMarketStream,
      inject: [EXCHANGE_STREAM, CLOCK, REAL_FEED_HEALTH, VENUE_EXCHANGE_PORTS, TypedConfigService],
    },
  ],
  exports: [
    CLOCK,
    WATCH_SOURCE,
    VENUE_MD_EXCHANGES,
    VENUE_FEED_HEALTH,
    REAL_FEED_HEALTH,
    FEED_HEALTH,
    MARKET_STREAM_TELEMETRY,
    EXCHANGE_STREAM,
    MARKET_STREAM,
  ],
})
export class MarketStreamsModule {}
