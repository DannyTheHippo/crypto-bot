import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChecksumError } from 'ccxt';
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

    const first = await iterator.next();

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
