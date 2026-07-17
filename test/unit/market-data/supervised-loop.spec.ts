import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChecksumError, NetworkError } from 'ccxt';
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

const clock: ClockPort = { now: () => epochMs(0) };

// Minimal ccxt-shaped book; the adapter passes it through un-normalized.
function fakeBook() {
  return { timestamp: 1, bids: [[100, 1]], asks: [[101, 1]] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CcxtExchangeStreamAdapter supervised book loop', () => {
  it('recovers from a ChecksumError by marking GAP and resubscribing on the next iteration', async () => {
    // Fake timers so the staleness-watchdog setTimeout never becomes an open handle.
    vi.useFakeTimers();

    let calls = 0;
    const watchSource: WatchSource = {
      // eslint-disable-next-line @typescript-eslint/require-await
      watchTicker: async () => {
        throw new Error('unused');
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      watchTrades: async () => {
        throw new Error('unused');
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      watchOHLCV: async () => {
        throw new Error('unused');
      },
      watchOrderBook: async () => {
        calls++;
        if (calls === 1) throw new ChecksumError('orderbook checksum mismatch');
        if (calls === 2) return fakeBook() as never;
        return new Promise<never>(() => {}); // park: no runaway loop after recovery
      },
    };

    const setHealth = vi.fn();
    const recordEvent = vi.fn();
    const checkStaleness = vi.fn();
    const stateTracker: ChannelStateTracker = { setHealth, recordEvent, checkStaleness };

    const exchange = { id: 'binance', has: { watchOrderBook: true } } as never;
    const adapter = new CcxtExchangeStreamAdapter(clock, watchSource, exchange, V, stateTracker);

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // The post-error re-watch passes the subscribe gate (≤SUBSCRIBE_MIN_SPACING_MS wait) — pump
    // fake timers so the gated resubscribe actually runs.
    const firstP = iterator.next();
    await vi.advanceTimersByTimeAsync(2_000);
    const first = await firstP;

    if (first.done) throw new Error('expected a market event, got iterator done');
    expect(first.value.type).toBe('book'); // recovered: a real book event was delivered
    // First call threw checksum; the loop resubscribed and a later call yielded the book.
    expect(calls).toBeGreaterThanOrEqual(2);
    // ChecksumError path invalidates the book → GAP, never a silent drop.
    expect(setHealth).toHaveBeenCalledWith(V, SYM, 'book', 'GAP');
    // After recovery the channel records a fresh event (drives it back to LIVE).
    expect(recordEvent).toHaveBeenCalledWith(V, SYM, 'book');

    await iterator.return?.();
  });

  it('paces (re)subscriptions through the gate — no synchronized burst at boot or after a shared failure (2026-07-17 code-1008 livelock)', async () => {
    // 4 channels on one symbol: every first watch throws a transient NetworkError (the shape of a
    // venue 1008 close), every second watch parks. Pre-fix, the four initial watches fired in one
    // tick and the four retries fired in one tick 1s later — the lockstep burst Binance answers
    // with another 1008, forever. The gate must space BOTH batches ≥ SUBSCRIBE_MIN_SPACING_MS.
    vi.useFakeTimers();
    const calls: { ch: string; at: number }[] = [];
    const failOnceThenPark = (ch: string) => {
      let n = 0;
      return () => {
        calls.push({ ch, at: Date.now() });
        n += 1;
        if (n === 1)
          return Promise.reject(
            new NetworkError('connection closed by remote server, closing code 1008'),
          );
        return new Promise<never>(() => {});
      };
    };
    const watchSource: WatchSource = {
      watchTicker: failOnceThenPark('ticker'),
      watchTrades: failOnceThenPark('trade'),
      watchOHLCV: failOnceThenPark('candle'),
      watchOrderBook: failOnceThenPark('book'),
    };
    const stateTracker: ChannelStateTracker = {
      setHealth: vi.fn(),
      recordEvent: vi.fn(),
      checkStaleness: vi.fn(),
    };
    const exchange = {
      id: 'binance',
      has: { watchTicker: true, watchTrades: true, watchOHLCV: true, watchOrderBook: true },
    } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(
      timerClock,
      watchSource,
      exchange,
      V,
      stateTracker,
    );
    const spec: SubscriptionSpec = {
      venue: V,
      symbols: [SYM],
      channels: { ticker: true, trades: true, book: true, candles: ['15m'] },
    };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    await vi.advanceTimersByTimeAsync(15_000);
    await iterator.return?.();

    expect(calls).toHaveLength(8);
    const spacingOk = (batch: number[]): void => {
      const sorted = [...batch].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(349);
      }
    };
    const firsts = new Map<string, number>();
    const seconds: number[] = [];
    for (const c of calls) {
      if (firsts.has(c.ch)) seconds.push(c.at);
      else firsts.set(c.ch, c.at);
    }
    spacingOk([...firsts.values()]);
    spacingOk(seconds);
  });

  it('logs a loop error once per channel per interval — a persistent failure is visible, a tight loop does not flood', async () => {
    vi.useFakeTimers();
    let n = 0;
    const watchSource: WatchSource = {
      watchTicker: () => {
        throw new Error('unused');
      },
      watchTrades: () => {
        throw new Error('unused');
      },
      watchOHLCV: () => {
        throw new Error('unused');
      },
      watchOrderBook: () => {
        n += 1;
        if (n <= 2) return Promise.reject(new NetworkError('closing code 1008'));
        return new Promise<never>(() => {});
      },
    };
    const stateTracker: ChannelStateTracker = {
      setHealth: vi.fn(),
      recordEvent: vi.fn(),
      checkStaleness: vi.fn(),
    };
    const warn = vi.fn();
    const exchange = { id: 'binance', has: { watchOrderBook: true } } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(
      timerClock,
      watchSource,
      exchange,
      V,
      stateTracker,
      {
        warn,
        error: vi.fn(),
      },
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    await vi.advanceTimersByTimeAsync(10_000);
    await iterator.return?.();

    const errorLines = warn.mock.calls.filter(([m]) => String(m).includes('loop error'));
    expect(errorLines).toHaveLength(1);
    expect(String(errorLines[0]![0])).toContain('NetworkError');
  });

  it('fails fast when a required capability is missing', () => {
    const watchSource = {} as WatchSource;
    const stateTracker: ChannelStateTracker = {
      setHealth: vi.fn(),
      recordEvent: vi.fn(),
      checkStaleness: vi.fn(),
    };
    // Exchange lacks watchOrderBook capability.
    const exchange = { id: 'binance', has: {} } as never;
    const adapter = new CcxtExchangeStreamAdapter(clock, watchSource, exchange, V, stateTracker);
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { book: true } };
    expect(() => adapter.marketRaw(spec)[Symbol.asyncIterator]()).toThrow(/watchOrderBook/);
  });
});
