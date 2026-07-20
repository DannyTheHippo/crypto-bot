import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OrderBook, Ticker } from 'ccxt';
import {
  CcxtExchangeStreamAdapter,
  type WatchSource,
  type ChannelStateTracker,
  type ChannelTierResolver,
} from '../../../src/features/trading/market-data/ccxt-stream.adapter';
import { FeedHealthService } from '../../../src/features/trading/market-data/feed-health.service';
import type { ClockPort } from '../../../src/ports/clock';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type { SubscriptionSpec } from '../../../src/ports/market-data';

// XA6 (A0 activation bundle): per-symbol channel tiering. Heavy channels (book, trades) run only
// for full-tier (active-menu + positioned) symbols; lite symbols park those loops — no watch call,
// no watchdog registration, no health entry — and resume on promotion. The resolver seam fails OPEN
// to full tier: an efficiency gate must never starve the data path.

const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

const unused = (): Promise<never> => Promise.reject(new Error('unused'));
const parkForever = (): Promise<never> => new Promise<never>(() => {});

function fakeBook(): OrderBook {
  return { timestamp: 1, bids: [[100, 1]], asks: [[101, 1]] } as unknown as OrderBook;
}

function tracker() {
  const t = {
    setHealth: vi.fn(),
    recordEvent: vi.fn(),
    checkStaleness: vi.fn(),
    clearChannel: vi.fn(),
  };
  return t as ChannelStateTracker & typeof t;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CcxtExchangeStreamAdapter channel tiering (XA6)', () => {
  it('a lite symbol never subscribes book/trades, keeps ticker, and never registers with the watchdog', async () => {
    vi.useFakeTimers();
    const watchOrderBook = vi.fn(parkForever);
    const watchTrades = vi.fn(parkForever);
    let tickerCalls = 0;
    const watchSource: WatchSource = {
      watchTicker: () => {
        tickerCalls += 1;
        if (tickerCalls === 1) return Promise.resolve({ timestamp: 1 } as Ticker);
        return parkForever();
      },
      watchTrades,
      watchOHLCV: unused,
      watchOrderBook,
    };
    const st = tracker();
    const close = vi.fn(() => Promise.resolve());
    const exchange = {
      id: 'binance',
      has: { watchTicker: true, watchTrades: true, watchOrderBook: true },
      close,
    } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(timerClock, watchSource, exchange, V, st);
    adapter.setChannelTierResolver({ fullChannels: () => false }, 1_000);

    const spec: SubscriptionSpec = {
      venue: V,
      symbols: [SYM],
      channels: { ticker: true, trades: true, book: true },
    };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('expected a ticker event');
    expect(first.value.type).toBe('ticker');

    // Past the 180s watchdog stall threshold + several watchdog ticks: parked channels must be
    // invisible to the stall scan — the ticker keeps its own key fresh only until it parks on the
    // pending promise, so prune assertion targets close() (the connection-wide blast radius).
    await vi.advanceTimersByTimeAsync(400_000);

    expect(watchOrderBook).not.toHaveBeenCalled();
    expect(watchTrades).not.toHaveBeenCalled();
    // Neither gated channel ever seeded a health entry (lite channels are invisible, not GAP-forever).
    expect(st.setHealth).not.toHaveBeenCalledWith(V, SYM, 'book', expect.anything());
    expect(st.setHealth).not.toHaveBeenCalledWith(V, SYM, 'trade', expect.anything());
    await iterator.return?.();
  });

  it('watchdog never force-closes on account of parked channels while live channels stay fresh', async () => {
    vi.useFakeTimers();
    let tickerResolve = true;
    const watchSource: WatchSource = {
      // Ticker yields continuously (fresh), book/trades parked by the lite tier.
      watchTicker: () =>
        tickerResolve
          ? new Promise<Ticker>((res) => setTimeout(() => res({ timestamp: 1 } as Ticker), 1_000))
          : parkForever(),
      watchTrades: vi.fn(parkForever),
      watchOHLCV: unused,
      watchOrderBook: vi.fn(parkForever),
    };
    const st = tracker();
    const close = vi.fn(() => Promise.resolve());
    const exchange = {
      id: 'binance',
      has: { watchTicker: true, watchTrades: true, watchOrderBook: true },
      close,
    } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(timerClock, watchSource, exchange, V, st);
    adapter.setChannelTierResolver({ fullChannels: () => false }, 1_000);

    const spec: SubscriptionSpec = {
      venue: V,
      symbols: [SYM],
      channels: { ticker: true, trades: true, book: true },
    };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    void iterator.next();
    // Well past stall threshold: pre-fix, the seeded-but-parked book/trade keys would trip the
    // watchdog every cooldown and close() the whole connection — the regression this pins against.
    await vi.advanceTimersByTimeAsync(600_000);
    tickerResolve = false;

    expect(close).not.toHaveBeenCalled();
    await iterator.return?.();
  });

  it('promotion resumes a parked book loop: seeds health and subscribes within one poll tick', async () => {
    vi.useFakeTimers();
    let full = false;
    const watchOrderBook = vi.fn((): Promise<OrderBook> => {
      if (watchOrderBook.mock.calls.length === 1) return Promise.resolve(fakeBook());
      return parkForever();
    });
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook,
    };
    const st = tracker();
    const exchange = { id: 'binance', has: { watchOrderBook: true } } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(timerClock, watchSource, exchange, V, st);
    const resolver: ChannelTierResolver = { fullChannels: () => full };
    adapter.setChannelTierResolver(resolver, 1_000);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const firstP = iterator.next();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchOrderBook).not.toHaveBeenCalled();

    full = true; // promoted into the active menu
    await vi.advanceTimersByTimeAsync(2_000);

    expect(watchOrderBook).toHaveBeenCalled();
    // Resume re-seeds the channel (watchdog + health registration) before subscribing.
    expect(st.setHealth).toHaveBeenCalledWith(V, SYM, 'book', 'GAP');
    const first = await firstP;
    if (first.done) throw new Error('expected a book event');
    expect(first.value.type).toBe('book');
    expect(st.recordEvent).toHaveBeenCalledWith(V, SYM, 'book');
    await iterator.return?.();
  });

  it('demotion parks at the next yield: clears the health entry and stops watching', async () => {
    vi.useFakeTimers();
    let full = true;
    const watchOrderBook = vi.fn(
      (): Promise<OrderBook> =>
        new Promise<OrderBook>((res) => setTimeout(() => res(fakeBook()), 500)),
    );
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook,
    };
    const st = tracker();
    const exchange = { id: 'binance', has: { watchOrderBook: true } } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(timerClock, watchSource, exchange, V, st);
    adapter.setChannelTierResolver({ fullChannels: () => full }, 1_000);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    void iterator.next();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(watchOrderBook.mock.calls.length).toBeGreaterThanOrEqual(1);

    full = false; // demoted out of the menu
    await vi.advanceTimersByTimeAsync(2_000);
    const callsAtPark = watchOrderBook.mock.calls.length;
    expect(st.clearChannel).toHaveBeenCalledWith(V, SYM, 'book');

    // Long after demotion: no further subscriptions.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(watchOrderBook.mock.calls.length).toBe(callsAtPark);
    await iterator.return?.();
  });

  it('demotion fires exactly one paced venue-side unWatchOrderBook for the demoted symbol', async () => {
    vi.useFakeTimers();
    let full = true;
    const watchOrderBook = vi.fn(
      (): Promise<OrderBook> =>
        new Promise<OrderBook>((res) => setTimeout(() => res(fakeBook()), 500)),
    );
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook,
    };
    const st = tracker();
    const unWatchOrderBook = vi.fn(() => Promise.resolve());
    const exchange = { id: 'binance', has: { watchOrderBook: true }, unWatchOrderBook } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(timerClock, watchSource, exchange, V, st);
    adapter.setChannelTierResolver({ fullChannels: () => full }, 1_000);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    void iterator.next();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(watchOrderBook.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Never unsubscribed while the symbol was full tier.
    expect(unWatchOrderBook).not.toHaveBeenCalled();

    full = false; // demoted out of the menu
    await vi.advanceTimersByTimeAsync(2_000);

    // Exactly one demotion-time unsubscribe, routed (fire-and-forget) through the paced gate.
    expect(unWatchOrderBook).toHaveBeenCalledTimes(1);
    expect(unWatchOrderBook).toHaveBeenCalledWith(SYM);
    expect(st.clearChannel).toHaveBeenCalledWith(V, SYM, 'book');

    // Parked cleanly: no re-subscribe, and the unsubscribe does not repeat while parked.
    const callsAtPark = watchOrderBook.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(watchOrderBook.mock.calls.length).toBe(callsAtPark);
    expect(unWatchOrderBook).toHaveBeenCalledTimes(1);
    await iterator.return?.();
  });

  it('a throwing unWatchOrderBook is swallowed: the loop still parks and warns', async () => {
    vi.useFakeTimers();
    let full = true;
    const watchOrderBook = vi.fn(
      (): Promise<OrderBook> =>
        new Promise<OrderBook>((res) => setTimeout(() => res(fakeBook()), 500)),
    );
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook,
    };
    const st = tracker();
    const warn = vi.fn();
    const unWatchOrderBook = vi.fn(() => Promise.reject(new Error('unwatch boom')));
    const exchange = { id: 'binance', has: { watchOrderBook: true }, unWatchOrderBook } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(timerClock, watchSource, exchange, V, st, {
      warn,
      error: vi.fn(),
    });
    adapter.setChannelTierResolver({ fullChannels: () => full }, 1_000);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    void iterator.next();

    await vi.advanceTimersByTimeAsync(2_000);
    full = false; // demoted; the venue-side unsubscribe will throw
    await vi.advanceTimersByTimeAsync(2_000);

    expect(unWatchOrderBook).toHaveBeenCalledTimes(1);
    // Fail-open: parked despite the throw, one warn naming the failed unwatch, nothing crashes.
    expect(st.clearChannel).toHaveBeenCalledWith(V, SYM, 'book');
    const unwatchWarns = warn.mock.calls.filter(([m]) => String(m).includes('unwatch'));
    expect(unwatchWarns.length).toBeGreaterThanOrEqual(1);

    const callsAtPark = watchOrderBook.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(watchOrderBook.mock.calls.length).toBe(callsAtPark);
    await iterator.return?.();
  });

  it('initial lite park (never subscribed) does not call unWatchOrderBook', async () => {
    vi.useFakeTimers();
    const watchOrderBook = vi.fn(parkForever);
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook,
    };
    const st = tracker();
    const unWatchOrderBook = vi.fn(() => Promise.resolve());
    const exchange = { id: 'binance', has: { watchOrderBook: true }, unWatchOrderBook } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(timerClock, watchSource, exchange, V, st);
    adapter.setChannelTierResolver({ fullChannels: () => false }, 1_000);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    void iterator.next();

    // A symbol lite from boot was never subscribed, so there is nothing to unsubscribe: the
    // park transition is null→true (not false→true) and must not touch unWatchOrderBook.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(watchOrderBook).not.toHaveBeenCalled();
    expect(unWatchOrderBook).not.toHaveBeenCalled();
    await iterator.return?.();
  });

  it('a throwing resolver fails OPEN to full tier and warns once per interval', async () => {
    vi.useFakeTimers();
    const watchOrderBook = vi.fn((): Promise<OrderBook> => {
      if (watchOrderBook.mock.calls.length === 1) return Promise.resolve(fakeBook());
      return parkForever();
    });
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook,
    };
    const st = tracker();
    const warn = vi.fn();
    const exchange = { id: 'binance', has: { watchOrderBook: true } } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(timerClock, watchSource, exchange, V, st, {
      warn,
      error: vi.fn(),
    });
    adapter.setChannelTierResolver(
      {
        fullChannels: () => {
          throw new Error('resolver exploded');
        },
      },
      1_000,
    );

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const firstP = iterator.next();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(watchOrderBook).toHaveBeenCalled();
    const first = await firstP;
    if (first.done) throw new Error('expected a book event');
    expect(first.value.type).toBe('book');
    const tierWarns = warn.mock.calls.filter(([m]) => String(m).includes('tier resolver threw'));
    expect(tierWarns).toHaveLength(1);
    await iterator.return?.();
  });
});

describe('buildCcxtExchange watchOrderBookRate (XA6)', () => {
  it('the market-data exchange pins depth updates to 1000ms (options.watchOrderBookRate)', async () => {
    const { buildCcxtExchange } =
      await import('../../../src/features/trading/market-data/ccxt-stream.adapter');
    const ex = buildCcxtExchange({
      id: 'binance',
      environment: 'paper',
      baseUrlOverride: undefined,
    } as never);
    expect((ex.options as Record<string, unknown>)['watchOrderBookRate']).toBe(1000);
  });
});

describe('FeedHealthService.clearChannel (XA6)', () => {
  it('removes the channel from ages and reverts health to the GAP default', () => {
    const clock: ClockPort = { now: () => epochMs(1_000) };
    const svc = new FeedHealthService(clock, {
      marketRaw: () => {
        throw new Error('unused');
      },
      userEvents: () => {
        throw new Error('unused');
      },
    });
    svc.recordEvent(V, SYM, 'book');
    expect(svc.health(V, SYM, 'book')).toBe('LIVE');
    expect(svc.channelAges()).toHaveLength(1);

    svc.clearChannel(V, SYM, 'book');
    expect(svc.channelAges()).toHaveLength(0);
    expect(svc.health(V, SYM, 'book')).toBe('GAP');
  });
});
