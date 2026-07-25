import { describe, it, expect, vi, afterEach } from 'vitest';
import { NetworkError } from 'ccxt';
import {
  CcxtExchangeStreamAdapter,
  RealWatchSource,
  buildCcxtExchange,
  type WatchSource,
  type ChannelStateTracker,
} from '../../../src/features/trading/market-data/ccxt-stream.adapter';
import type { ClockPort } from '../../../src/ports/clock';
import type { SubscriptionSpec } from '../../../src/ports/market-data';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');
const clock: ClockPort = { now: () => epochMs(0) };

const FULL_CAPS = { watchTicker: true, watchTrades: true, watchOHLCV: true, watchOrderBook: true };

function tracker() {
  const setHealth = vi.fn();
  const recordEvent = vi.fn();
  const checkStaleness = vi.fn();
  const st: ChannelStateTracker = { setHealth, recordEvent, checkStaleness };
  return { st, setHealth, recordEvent, checkStaleness };
}

function adapterWith(
  ws: WatchSource,
  st: ChannelStateTracker,
  caps: Record<string, boolean> = FULL_CAPS,
) {
  const exchange = { id: 'binance', has: caps } as never;
  return new CcxtExchangeStreamAdapter(clock, ws, exchange, V, st);
}

// A WatchSource where a single channel yields one payload then parks (no runaway loop).
function onceThenPark(channel: keyof WatchSource, payload: unknown): WatchSource {
  const reject = () => Promise.reject(new Error('unused channel'));
  const base: Record<string, () => Promise<unknown>> = {
    watchTicker: reject,
    watchTrades: reject,
    watchOHLCV: reject,
    watchOrderBook: reject,
  };
  let n = 0;
  base[channel] = () => {
    n++;
    if (n === 1) return Promise.resolve(payload);
    return new Promise(() => {}); // park
  };
  return base as unknown as WatchSource;
}

afterEach(() => vi.useRealTimers());

describe('RealWatchSource delegates to the ccxt exchange', () => {
  it('forwards each watch* call to the matching ccxt method', async () => {
    const ex = {
      watchTicker: vi.fn().mockResolvedValue({ last: '1' }),
      watchTrades: vi.fn().mockResolvedValue([]),
      watchOHLCV: vi.fn().mockResolvedValue([]),
      watchOrderBook: vi.fn().mockResolvedValue({}),
    } as never;
    const ws = new RealWatchSource();
    await ws.watchTicker(ex, 'BTC/USDT');
    await ws.watchTrades(ex, 'BTC/USDT');
    await ws.watchOHLCV(ex, 'BTC/USDT', '1m');
    await ws.watchOrderBook(ex, 'BTC/USDT');
    const calls = ex as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(calls['watchTicker']).toHaveBeenCalledWith('BTC/USDT');
    expect(calls['watchOHLCV']).toHaveBeenCalledWith('BTC/USDT', '1m');
    expect(calls['watchOrderBook']).toHaveBeenCalledWith('BTC/USDT');
  });
});

describe('buildCcxtExchange', () => {
  it('throws for an unknown venue id', () => {
    expect(() => buildCcxtExchange({ id: 'definitelynotavenue', environment: 'live' })).toThrow(
      /no exchange named/,
    );
  });

  it('constructs a live binance client (string numerics)', () => {
    const ex = buildCcxtExchange({ id: 'binance', environment: 'live' });
    expect(ex.id).toBe('binance');
  });

  it('accepts a baseUrlOverride without throwing', () => {
    const ex = buildCcxtExchange({
      id: 'binance',
      environment: 'live',
      baseUrlOverride: 'https://example.test/api',
    });
    expect(ex.id).toBe('binance');
  });

  // Verified against the pinned ccxt 4.5.58 package: js/src/pro/binance.js:148/150 default
  // tradesLimit/OHLCVLimit to 1000 each; this constructor overrides both to bound the per-symbol
  // watchTrades/watchOHLCV caches (see buildCcxtExchange's own comment).
  it('caps the ccxt pro watchTrades/watchOHLCV in-memory caches (tradesLimit/OHLCVLimit)', () => {
    const ex = buildCcxtExchange({ id: 'binance', environment: 'live' });
    const options = (ex as unknown as { options: Record<string, unknown> }).options;
    expect(options['OHLCVLimit']).toBe(400);
    expect(options['tradesLimit']).toBe(100);
    expect(options['watchOrderBookRate']).toBe(1000);
  });
});

describe('supervised channel loops deliver normalized raw events', () => {
  it('ticker loop', async () => {
    vi.useFakeTimers();
    const { st, recordEvent } = tracker();
    const ws = onceThenPark('watchTicker', { timestamp: 1, bid: '1', ask: '2', last: '1.5' });
    const it = adapterWith(ws, st)
      .marketRaw({ venue: V, symbols: [S], channels: { ticker: true } })
      [Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done) throw new Error('no event');
    expect(first.value.type).toBe('ticker');
    expect(recordEvent).toHaveBeenCalledWith(V, S, 'ticker');
    await it.return?.();
  });

  it('trades loop (one raw event per trade in the batch)', async () => {
    vi.useFakeTimers();
    const { st } = tracker();
    const ws = onceThenPark('watchTrades', [
      { timestamp: 1, price: '100', amount: '1', side: 'buy', id: 'a' },
    ]);
    const it = adapterWith(ws, st)
      .marketRaw({ venue: V, symbols: [S], channels: { trades: true } })
      [Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done) throw new Error('no event');
    expect(first.value.type).toBe('trade');
    await it.return?.();
  });

  it('candle loop', async () => {
    vi.useFakeTimers();
    const { st } = tracker();
    const ws = onceThenPark('watchOHLCV', [[60000, '100', '110', '90', '105', '10', true]]);
    const it = adapterWith(ws, st)
      .marketRaw({ venue: V, symbols: [S], channels: { candles: ['1m'] } })
      [Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done) throw new Error('no event');
    expect(first.value.type).toBe('candle');
    await it.return?.();
  });

  it('marks GAP and backs off on a non-transient error, then resumes', async () => {
    vi.useFakeTimers();
    const { st, setHealth } = tracker();
    let n = 0;
    const ws: WatchSource = {
      watchTrades: () => {
        n++;
        if (n === 1) return Promise.reject(new Error('unmapped failure')); // not transient, not checksum
        if (n === 2)
          return Promise.resolve([
            { timestamp: 2, price: '1', amount: '1', side: 'buy', id: 'a' },
          ] as never);
        return new Promise<never>(() => {});
      },
      watchTicker: () => Promise.reject(new Error('unused')),
      watchOHLCV: () => Promise.reject(new Error('unused')),
      watchOrderBook: () => Promise.reject(new Error('unused')),
    };
    const it = adapterWith(ws, st)
      .marketRaw({ venue: V, symbols: [S], channels: { trades: true } })
      [Symbol.asyncIterator]();
    const pending = it.next();
    await vi.advanceTimersByTimeAsync(2000); // 1s backoff + the subscribe-gate slot
    const first = await pending;
    if (first.done) throw new Error('no event');
    expect(first.value.type).toBe('trade');
    expect(setHealth).toHaveBeenCalledWith(V, S, 'trade', 'GAP'); // unknown error → GAP
    await it.return?.();
  });

  it('breaks out of a loop when stopped during an error (no further retries)', async () => {
    vi.useFakeTimers();
    const { st } = tracker();
    const holder: { adapter?: CcxtExchangeStreamAdapter } = {};
    const ws: WatchSource = {
      watchTicker: () => {
        holder.adapter?.stop(); // stop mid-flight, then fail
        return Promise.reject(new Error('post-stop'));
      },
      watchTrades: () => Promise.reject(new Error('unused')),
      watchOHLCV: () => Promise.reject(new Error('unused')),
      watchOrderBook: () => Promise.reject(new Error('unused')),
    };
    holder.adapter = adapterWith(ws, st);
    const it = holder.adapter
      .marketRaw({ venue: V, symbols: [S], channels: { ticker: true } })
      [Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.done).toBe(true); // loop broke, stream finished — no DEGRADED/GAP retry churn
  });

  it('recovers from a transient NetworkError after backoff (DEGRADED then resume)', async () => {
    vi.useFakeTimers();
    const { st, setHealth } = tracker();
    let n = 0;
    const ws: WatchSource = {
      watchTicker: () => {
        n++;
        if (n === 1) return Promise.reject(new NetworkError('socket hiccup'));
        if (n === 2)
          return Promise.resolve({ timestamp: 2, bid: '1', ask: '2', last: '1.5' } as never);
        return new Promise<never>(() => {});
      },
      watchTrades: () => Promise.reject(new Error('unused')),
      watchOHLCV: () => Promise.reject(new Error('unused')),
      watchOrderBook: () => Promise.reject(new Error('unused')),
    };
    const it = adapterWith(ws, st)
      .marketRaw({ venue: V, symbols: [S], channels: { ticker: true } })
      [Symbol.asyncIterator]();
    const pending = it.next();
    await vi.advanceTimersByTimeAsync(2000); // 1s backoff + the subscribe-gate slot, then resume
    const first = await pending;
    if (first.done) throw new Error('no event');
    expect(first.value.type).toBe('ticker');
    expect(setHealth).toHaveBeenCalledWith(V, S, 'ticker', 'DEGRADED'); // transient → DEGRADED
    await it.return?.();
  });
});

describe('capability fail-fast', () => {
  const cases: Array<[string, SubscriptionSpec['channels']]> = [
    ['watchTicker', { ticker: true }],
    ['watchTrades', { trades: true }],
    ['watchOHLCV', { candles: ['1m'] }],
    ['watchOrderBook', { book: true }],
  ];
  for (const [method, channels] of cases) {
    it(`refuses to start when ${method} is unavailable`, () => {
      const adapter = adapterWith({} as WatchSource, tracker(), {}); // no capabilities
      expect(() =>
        adapter.marketRaw({ venue: V, symbols: [S], channels })[Symbol.asyncIterator](),
      ).toThrow(new RegExp(method));
    });
  }
});
