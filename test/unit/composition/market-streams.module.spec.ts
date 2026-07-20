import { describe, it, expect, vi } from 'vitest';
import {
  worstChannelHealth,
  VenueRoutingFeedHealth,
  VenueRoutingPaperFeedSink,
  mergeAsyncIterables,
  MergedExchangeStream,
  buildVenueMdExchanges,
  buildExchangeStream,
} from '../../../src/features/trading/composition/market-streams.module';
import { buildVenueRegistry } from '../../../src/features/trading/composition/venue-registry.module';
import { CcxtExchangeStreamAdapter } from '../../../src/features/trading/market-data/ccxt-stream.adapter';
import type {
  FeedHealthPort,
  MarketChannelAge,
  MarketStreamTelemetryPort,
} from '../../../src/ports/market-data';
import type { ExchangePort } from '../../../src/ports/exchange';
import type { ChannelHealth, OrderLevel } from '../../../src/domain/types/market-events';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type { ClockPort } from '../../../src/ports/clock';
import Decimal from 'decimal.js';
import type { TypedConfigService } from '../../../src/config/environment/typed-config.service';

const V_SPOT = venueId('binance');
const V_PERP = venueId('binanceusdm');
const SYM_SPOT = symbolId('BTC/USDT');
const SYM_PERP = symbolId('BTC/USDT:USDT');
const clock: ClockPort = { now: () => epochMs(0) };
const unused = (): Promise<never> => Promise.reject(new Error('unused'));

function fakeConfig(symbols: readonly string[]): TypedConfigService {
  return {
    venues: [
      { id: 'binance', environment: 'demo' },
      { id: 'binanceusdm', environment: 'demo' },
    ],
    strategy: { symbols },
    venueCapitalSplit: { binance: '500', binanceusdm: '500' },
  } as unknown as TypedConfigService;
}

describe('worstChannelHealth', () => {
  it('answers GAP when no channel is tracked anywhere (fail-closed default, never a silent LIVE)', () => {
    expect(worstChannelHealth([])).toBe('GAP');
  });

  it('answers LIVE when every tracked channel is LIVE', () => {
    expect(worstChannelHealth(['LIVE', 'LIVE'])).toBe('LIVE');
  });

  it('answers the worst of a mixed set regardless of order', () => {
    expect(worstChannelHealth(['LIVE', 'DEGRADED'])).toBe('DEGRADED');
    expect(worstChannelHealth(['DEGRADED', 'GAP', 'LIVE'])).toBe('GAP');
    expect(worstChannelHealth(['GAP', 'LIVE'])).toBe('GAP');
  });
});

type FakeVenueFeedHealth = FeedHealthPort &
  MarketStreamTelemetryPort & { recordEvent: ReturnType<typeof vi.fn> };

function fakeVenueFeedHealth(ages: MarketChannelAge[], reconnects: number): FakeVenueFeedHealth {
  return {
    health: vi.fn((): ChannelHealth => 'LIVE'),
    getRefPrice: vi.fn(() => ({ mid: '100' as never, at: epochMs(1) })),
    fetchCandles: vi.fn(() => Promise.resolve([])),
    channelAges: vi.fn(() => ages),
    forcedReconnectCount: vi.fn(() => reconnects),
    recordEvent: vi.fn(),
  };
}

describe('VenueRoutingFeedHealth', () => {
  function facade() {
    const spot = fakeVenueFeedHealth(
      [{ venue: V_SPOT, symbol: SYM_SPOT, channel: 'book', ageSeconds: 1, health: 'LIVE' }],
      2,
    );
    const perp = fakeVenueFeedHealth(
      [{ venue: V_PERP, symbol: SYM_PERP, channel: 'book', ageSeconds: 1, health: 'DEGRADED' }],
      5,
    );
    const routing = new VenueRoutingFeedHealth(
      new Map([
        [V_SPOT, spot],
        [V_PERP, perp],
      ]),
    );
    return { routing, spot, perp };
  }

  it('dispatches health/getRefPrice/fetchCandles to the venue derived from the symbol (venueForSymbol), not the caller-supplied venue arg', async () => {
    const { routing, spot, perp } = facade();

    // Wrong venue argument on purpose — dispatch must still land on the perp instance because the
    // SYMBOL resolves there (venueForSymbol is the single source of truth, never the passed venue).
    routing.health(V_SPOT, SYM_PERP, 'book');
    routing.getRefPrice(SYM_PERP);
    await routing.fetchCandles(V_SPOT, SYM_PERP, '15m', 10);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() fakes carry no `this`; referencing them for call-count assertions is safe
    expect(perp.health).toHaveBeenCalledWith(V_PERP, SYM_PERP, 'book');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- same vi.fn() fake as above
    expect(spot.health).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- same vi.fn() fake as above
    expect(perp.getRefPrice).toHaveBeenCalledWith(SYM_PERP);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- same vi.fn() fake as above
    expect(perp.fetchCandles).toHaveBeenCalledWith(V_PERP, SYM_PERP, '15m', 10);
  });

  it('worstHealth() aggregates across every tracked channel on both venues (worst-of, no symbol)', () => {
    const { routing } = facade();
    expect(routing.worstHealth()).toBe('DEGRADED');
  });

  it('channelAges() concatenates both venues; forcedReconnectCount sums, forcedReconnectCountByVenue breaks out per venue', () => {
    const { routing } = facade();
    expect(routing.channelAges()).toHaveLength(2);
    expect(routing.forcedReconnectCount()).toBe(7);
    expect(routing.forcedReconnectCountByVenue()).toEqual(
      new Map([
        [V_SPOT, 2],
        [V_PERP, 5],
      ]),
    );
  });

  it('an unroutable symbol (registry gap) answers the safe defaults — GAP/undefined/[] — never throws', async () => {
    const spot = fakeVenueFeedHealth([], 0);
    const routing = new VenueRoutingFeedHealth(new Map([[V_SPOT, spot]]));
    expect(routing.health(V_SPOT, SYM_PERP, 'book')).toBe('GAP');
    expect(routing.getRefPrice(SYM_PERP)).toBeUndefined();
    await expect(routing.fetchCandles(V_SPOT, SYM_PERP, '15m', 10)).resolves.toEqual([]);
  });

  it('recordEvent dispatches to the resolved venue instance (parity with ChannelStateTracker; no production call site today)', () => {
    const { routing, perp } = facade();
    routing.recordEvent(V_SPOT, SYM_PERP, 'ticker');
    expect(perp.recordEvent).toHaveBeenCalledWith(V_PERP, SYM_PERP, 'ticker');
  });
});

describe('VenueRoutingPaperFeedSink', () => {
  function fakePaperPort(venue: string, ingest: boolean): ExchangePort {
    const base = {
      venue: venueId(venue),
      capabilities: {
        clientOrderId: true,
        fetchOrderByClientId: true,
        wsUserStream: true,
        stp: false,
        sandbox: true,
      },
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      fetchOrder: vi.fn(),
      fetchOpenOrders: vi.fn(),
      fetchBalances: vi.fn(),
      fetchMyTrades: vi.fn(),
      validateCredentials: vi.fn(),
    };
    if (!ingest) return base;
    return {
      ...base,
      ingestBook: vi.fn(),
      ingestTrade: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangePort;
  }

  it('routes ingestBook/ingestTrade to the ingest-capable port resolved from the symbol', async () => {
    const spot = fakePaperPort('binance', true);
    const perp = fakePaperPort('binanceusdm', false); // demo/testnet perp: no ingest capability
    const sink = new VenueRoutingPaperFeedSink(
      new Map([
        [V_SPOT, spot],
        [V_PERP, perp],
      ]),
    );
    const level: OrderLevel = { price: '100' as never, qty: '1' as never };

    sink.ingestBook(SYM_SPOT, [level], [level]);
    await sink.ingestTrade(SYM_SPOT, { price: new Decimal(1), qty: new Decimal(1) });
    // Perp symbol resolves to the non-ingest-capable port — no-ops without throwing.
    sink.ingestBook(SYM_PERP, [level], [level]);

    expect(
      (spot as unknown as { ingestBook: ReturnType<typeof vi.fn> }).ingestBook,
    ).toHaveBeenCalledWith(SYM_SPOT, [level], [level]);
    expect(
      (spot as unknown as { ingestTrade: ReturnType<typeof vi.fn> }).ingestTrade,
    ).toHaveBeenCalledTimes(1);
  });
});

describe('mergeAsyncIterables (failure isolation)', () => {
  // eslint-disable-next-line @typescript-eslint/require-await -- generator must stay async to match AsyncIterable<number>
  async function* gen(values: number[]): AsyncGenerator<number> {
    for (const v of values) yield v;
  }
  // eslint-disable-next-line @typescript-eslint/require-await -- generator must stay async to match AsyncIterable<number>
  async function* throwing(): AsyncGenerator<number> {
    throw new Error('venue B exploded');
  }

  it('interleaves values from every source', async () => {
    const merged = mergeAsyncIterables(
      [
        { venue: V_SPOT, iterable: gen([1, 2]) },
        { venue: V_PERP, iterable: gen([10, 20]) },
      ],
      vi.fn(),
    );
    const seen: number[] = [];
    for await (const v of merged) seen.push(v);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 10, 20]);
  });

  it('isolates a throwing source — the other source keeps flowing and the merge still terminates cleanly', async () => {
    const onSourceError = vi.fn();
    const merged = mergeAsyncIterables(
      [
        { venue: V_SPOT, iterable: gen([1, 2, 3]) },
        { venue: V_PERP, iterable: throwing() },
      ],
      onSourceError,
    );
    const seen: number[] = [];
    for await (const v of merged) seen.push(v);

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(onSourceError).toHaveBeenCalledWith(V_PERP, expect.any(Error));
  });

  it('an empty source list is already-done', async () => {
    const merged = mergeAsyncIterables([], vi.fn());
    const iterator = merged[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

describe('MergedExchangeStream', () => {
  function fakeAdapter(venue: string, symbol: string): CcxtExchangeStreamAdapter {
    const v = venueId(venue);
    const sym = symbolId(symbol);
    return {
      marketRaw: vi.fn(() => ({
        // eslint-disable-next-line @typescript-eslint/require-await -- mirrors a real supervised loop's yield-then-park shape
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'ticker', venue: v, symbol: sym, timestamp: undefined, raw: {} };
        },
      })),
      userEvents: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined as never, done: true }),
        }),
      })),
      setChannelTierResolver: vi.fn(),
    } as unknown as CcxtExchangeStreamAdapter;
  }

  it('partitions the spec by venueForSymbol and only sends each symbol to its own venue adapter', async () => {
    const spot = fakeAdapter('binance', 'BTC/USDT');
    const perp = fakeAdapter('binanceusdm', 'BTC/USDT:USDT');
    const merged = new MergedExchangeStream(
      new Map([
        [V_SPOT, spot],
        [V_PERP, perp],
      ]),
    );

    const stream = merged.marketRaw({
      venue: V_SPOT,
      symbols: [SYM_SPOT, SYM_PERP],
      channels: { ticker: true },
    });
    const events: unknown[] = [];
    for await (const ev of stream) events.push(ev);

    expect(events).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() fakes carry no `this`; referencing them for call assertions is safe
    expect(spot.marketRaw).toHaveBeenCalledWith(
      expect.objectContaining({ venue: V_SPOT, symbols: [SYM_SPOT] }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- same vi.fn() fake as above
    expect(perp.marketRaw).toHaveBeenCalledWith(
      expect.objectContaining({ venue: V_PERP, symbols: [SYM_PERP] }),
    );
  });

  it('never invokes an adapter for a venue not represented in the requested symbols', async () => {
    const spot = fakeAdapter('binance', 'BTC/USDT');
    const perp = fakeAdapter('binanceusdm', 'BTC/USDT:USDT');
    const merged = new MergedExchangeStream(
      new Map([
        [V_SPOT, spot],
        [V_PERP, perp],
      ]),
    );

    const stream = merged.marketRaw({
      venue: V_SPOT,
      symbols: [SYM_SPOT],
      channels: { ticker: true },
    });
    for await (const ev of stream) {
      void ev; // drain
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() fakes carry no `this`; referencing them for call assertions is safe
    expect(perp.marketRaw).not.toHaveBeenCalled();
  });

  it('setChannelTierResolver forwards the SAME resolver to every underlying venue adapter (XA6)', () => {
    const spot = fakeAdapter('binance', 'BTC/USDT');
    const perp = fakeAdapter('binanceusdm', 'BTC/USDT:USDT');
    const merged = new MergedExchangeStream(
      new Map([
        [V_SPOT, spot],
        [V_PERP, perp],
      ]),
    );
    const resolver = { fullChannels: () => true };

    merged.setChannelTierResolver(resolver, 5_000);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() fakes carry no `this`; referencing them for call assertions is safe
    expect(spot.setChannelTierResolver).toHaveBeenCalledWith(resolver, 5_000);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- same vi.fn() fake as above
    expect(perp.setChannelTierResolver).toHaveBeenCalledWith(resolver, 5_000);
  });

  it('userEvents merges every venue adapter and completes cleanly when all are empty', async () => {
    const spot = fakeAdapter('binance', 'BTC/USDT');
    const perp = fakeAdapter('binanceusdm', 'BTC/USDT:USDT');
    const merged = new MergedExchangeStream(
      new Map([
        [V_SPOT, spot],
        [V_PERP, perp],
      ]),
    );
    const seen: unknown[] = [];
    for await (const ev of merged.userEvents()) seen.push(ev);
    expect(seen).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() fakes carry no `this`; referencing them for call assertions is safe
    expect(spot.userEvents).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- same vi.fn() fake as above
    expect(perp.userEvents).toHaveBeenCalled();
  });
});

describe('buildVenueMdExchanges / buildExchangeStream (test/ci short-circuit)', () => {
  it('constructs no network client under test/ci and EXCHANGE_STREAM degrades to an already-done stream', async () => {
    const prevNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'test';
    try {
      const registry = buildVenueRegistry(fakeConfig(['BTC/USDT', 'BTC/USDT:USDT']));
      const exchanges = buildVenueMdExchanges(registry);
      expect(exchanges.size).toBe(0);

      const stream = buildExchangeStream(
        clock,
        { watchTicker: unused, watchTrades: unused, watchOHLCV: unused, watchOrderBook: unused },
        registry,
        new Map(),
        exchanges,
      );
      const iterator = stream
        .marketRaw({ venue: V_SPOT, symbols: [], channels: {} })
        [Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    } finally {
      process.env['NODE_ENV'] = prevNodeEnv;
    }
  });
});
