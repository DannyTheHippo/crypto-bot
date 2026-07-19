import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CcxtExchangeStreamAdapter,
  type WatchSource,
  type ChannelStateTracker,
} from '../../../src/features/trading/market-data/ccxt-stream.adapter';
import type { ClockPort } from '../../../src/ports/clock';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type { SubscriptionSpec } from '../../../src/ports/market-data';

const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

// Regression for the 2026-07-16 silent candle stall: ccxt's watch* future never settles when the
// venue drops a subscription server-side, so the supervised loop parks forever with no error. The
// watchdog must detect silence on ANY watched channel (ticker, trade, book, candle:*) and force
// exchange.close() so the loops resubscribe.

const unused = (): Promise<never> => Promise.reject(new Error('unused'));

function makeTracker(): {
  tracker: ChannelStateTracker;
  recordForcedReconnect: ReturnType<typeof vi.fn>;
} {
  const recordForcedReconnect = vi.fn<() => void>();
  const tracker: ChannelStateTracker = {
    setHealth: vi.fn(),
    recordEvent: vi.fn(),
    checkStaleness: vi.fn(),
    recordForcedReconnect,
  };
  return { tracker, recordForcedReconnect };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CcxtExchangeStreamAdapter stall watchdog', () => {
  it('forces exchange.close() when a candle channel goes silent past the stall threshold', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    let candleCalls = 0;
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOrderBook: unused,
      watchOHLCV: async () => {
        candleCalls++;
        if (candleCalls === 1) return [[1000, 1, 2, 0.5, 1.5, 10]] as never;
        return new Promise<never>(() => {}); // the incident shape: pending forever, no error
      },
    };

    const closeSpy = vi.fn(() => Promise.resolve());
    const exchange = { id: 'binance', has: { watchOHLCV: true }, close: closeSpy } as never;
    const { tracker, recordForcedReconnect } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(clock, watchSource, exchange, V, tracker);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { candles: ['15m'] } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('expected a candle event');
    expect(first.value.type).toBe('candle');

    // Silence: the channel last yielded at t=0; jump past the 180s stall threshold and let the
    // 30s watchdog interval fire.
    now = 200_000;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(recordForcedReconnect).toHaveBeenCalledTimes(1);

    // Cooldown: still stalled, but further ticks inside the cooldown window must not close again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Past the cooldown and still silent: the watchdog retries the reconnect.
    now = 400_000;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(closeSpy).toHaveBeenCalledTimes(2);

    await iterator.return?.();
  });

  it('never reconnects while a core channel keeps yielding (no spurious data-path degradation)', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    // A healthy stream: the first watch resolves at once (fake timers are frozen while the test
    // awaits the first event), every later one after a short fake delay, forever.
    let calls = 0;
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOrderBook: unused,
      watchOHLCV: () => {
        calls++;
        if (calls === 1) return Promise.resolve([[1000, 1, 2, 0.5, 1.5, 10]] as never);
        return new Promise((resolve) => {
          setTimeout(() => resolve([[1000, 1, 2, 0.5, 1.5, 10]] as never), 1_000);
        });
      },
    };

    const closeSpy = vi.fn(() => Promise.resolve());
    const exchange = { id: 'binance', has: { watchOHLCV: true }, close: closeSpy } as never;
    const { tracker, recordForcedReconnect } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(clock, watchSource, exchange, V, tracker);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { candles: ['15m'] } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    await iterator.next();

    // Walk wall-clock and event-clock together well past the stall threshold; the channel yields
    // every fake-second inside each advance, so the watchdog must stay quiet.
    for (let i = 0; i < 21; i++) {
      now += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(closeSpy).not.toHaveBeenCalled();
    expect(recordForcedReconnect).not.toHaveBeenCalled();

    await iterator.return?.();
  });

  // Regression for the 2026-07-17 review: book/trade were excluded from the watchdog's stall check
  // (only ticker/candle:* counted), yet the RiskEngine gates entries on 'book' channel health
  // specifically (risk-engine.service.ts) — a silently dead book (or trade) subscription had no
  // client-side recovery at all. Every channel this adapter watches must now trip the watchdog.
  it('forces exchange.close() when a book channel goes silent past the stall threshold', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    let bookCalls = 0;
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: async () => {
        bookCalls++;
        if (bookCalls === 1) return { timestamp: 1, bids: [[100, 1]], asks: [[101, 1]] } as never;
        return new Promise<never>(() => {}); // the incident shape: pending forever, no error
      },
    };

    const closeSpy = vi.fn(() => Promise.resolve());
    const exchange = { id: 'binance', has: { watchOrderBook: true }, close: closeSpy } as never;
    const { tracker, recordForcedReconnect } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(clock, watchSource, exchange, V, tracker);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    await iterator.next();

    now = 400_000;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(recordForcedReconnect).toHaveBeenCalledTimes(1);

    await iterator.return?.();
  });

  it('forces exchange.close() when a trade channel goes silent past the stall threshold', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    let tradeCalls = 0;
    const watchSource: WatchSource = {
      watchTicker: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
      watchTrades: async () => {
        tradeCalls++;
        // A non-empty first result so iterator.next() below actually resolves (an empty array
        // pushes no event and would hang the test, not exercise the watchdog).
        if (tradeCalls === 1) return [{ timestamp: 1, price: 100, amount: 1 }] as never;
        return new Promise<never>(() => {}); // the incident shape: pending forever, no error
      },
    };

    const closeSpy = vi.fn(() => Promise.resolve());
    const exchange = { id: 'binance', has: { watchTrades: true }, close: closeSpy } as never;
    const { tracker, recordForcedReconnect } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(clock, watchSource, exchange, V, tracker);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { trades: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    await iterator.next();

    now = 400_000;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(recordForcedReconnect).toHaveBeenCalledTimes(1);

    await iterator.return?.();
  });

  it('fails open: a rejecting close() is swallowed and the watchdog keeps retrying', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    const watchSource: WatchSource = {
      watchTicker: unused,
      watchTrades: unused,
      watchOrderBook: unused,
      // Never yields at all — the seeded loop-start timestamp alone must trip the watchdog.
      watchOHLCV: () => new Promise<never>(() => {}),
    };

    const closeSpy = vi.fn(() => Promise.reject(new Error('socket already gone')));
    const exchange = { id: 'binance', has: { watchOHLCV: true }, close: closeSpy } as never;
    const { tracker } = makeTracker();
    const warn = vi.fn();
    const adapter = new CcxtExchangeStreamAdapter(clock, watchSource, exchange, V, tracker, {
      warn,
      error: vi.fn(),
    });

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { candles: ['15m'] } };
    // Start the loops without awaiting a first event (there will never be one).
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const pendingNext = iterator.next();

    now = 200_000;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('close() failed'));

    // The rejection was contained: a later tick past the cooldown retries.
    now = 400_000;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(closeSpy).toHaveBeenCalledTimes(2);

    await iterator.return?.();
    void pendingNext;
  });
});
