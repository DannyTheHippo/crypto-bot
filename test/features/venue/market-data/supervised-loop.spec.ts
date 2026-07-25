import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChecksumError, NetworkError, type Ticker } from 'ccxt';
import {
  CcxtExchangeStreamAdapter,
  type WatchSource,
  type ChannelStateTracker,
} from '../../../../src/features/venue/market-data/ccxt-stream.adapter';
import type { ClockPort } from '../../../../src/ports/common/clock';
import { venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';
import type { SubscriptionSpec } from '../../../../src/ports/venue/market-data';

const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

const clock: ClockPort = { now: () => epochMs(0) };

// Minimal ccxt-shaped book; the adapter passes it through un-normalized.
function fakeBook() {
  return { timestamp: 1, bids: [[100, 1]], asks: [[101, 1]] };
}

const unused = (): Promise<never> => Promise.reject(new Error('unused'));

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

  // Bounded-concurrency lanes (2026-07-18 fix for the 2026-07-17 recovery-storm defect): the
  // pre-fix gate was a single global FIFO (SUBSCRIBE_MIN_SPACING_MS=350ms) that serialized every
  // (re)subscribe — M simultaneous drops recovered in M×350ms, and a connection-wide drop across
  // the 24-symbol universe (~96 subscriptions) pushed the queue tail past the RiskEngine's 5s
  // freshness gate, blacking out new entries universe-wide. The fix fans concurrent acquirers out
  // across SUBSCRIBE_LANE_COUNT (4) independently-paced lanes (SUBSCRIBE_LANE_SPACING_MS=1000ms
  // each), still safely under the venue's 5msg/s 1008 cliff (aggregate 4/s). Every (symbol,channel)
  // loop's FIRST watch passes through the identical subscribeSlot() gate as a post-error resubscribe
  // (same code, same lanes), so M concurrent initial subscribes exercise exactly the mechanism a
  // synchronized connection-wide drop would.
  it('recovers M ≥ N simultaneous subscribe requests in ceil(M/N) rounds of the lane pace, not M rounds', async () => {
    vi.useFakeTimers();
    // vi.useFakeTimers() freezes the fake clock at the current REAL wall time, not epoch 0 — anchor
    // every assertion to that baseline rather than assuming Date.now() starts at 0.
    const t0 = Date.now();
    const LANE_COUNT = 4; // mirrors SUBSCRIBE_LANE_COUNT
    const PACE_MS = 1000; // mirrors SUBSCRIBE_LANE_SPACING_MS
    const M = 8; // 2×LANE_COUNT: pre-fix this was 8 distinct 350ms-spaced rounds
    const symbols = Array.from({ length: M }, (_, i) => symbolId(`SYM${i}/USDT`));
    const callTimes = new Map<string, number>();
    const watchSource: WatchSource = {
      watchTicker: (_exchange, symbol) => {
        if (!callTimes.has(symbol)) {
          callTimes.set(symbol, Date.now());
          return Promise.resolve({} as Ticker);
        }
        return new Promise<never>(() => {}); // park after the recorded first subscribe
      },
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };
    const stateTracker: ChannelStateTracker = {
      setHealth: vi.fn(),
      recordEvent: vi.fn(),
      checkStaleness: vi.fn(),
    };
    const exchange = { id: 'binance', has: { watchTicker: true } } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(
      timerClock,
      watchSource,
      exchange,
      V,
      stateTracker,
      undefined,
      () => 0, // zero jitter: deterministic round boundaries for this assertion
    );
    const spec: SubscriptionSpec = { venue: V, symbols, channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    await vi.advanceTimersByTimeAsync(PACE_MS * Math.ceil(M / LANE_COUNT) + 500);
    await iterator.return?.();

    expect(callTimes.size).toBe(M);
    const rounds = new Map<number, number>();
    for (const t of callTimes.values()) rounds.set(t, (rounds.get(t) ?? 0) + 1);

    // The fix's claim: ceil(M/N) rounds, not M — pre-fix this would be 8 distinct timestamps 350ms
    // apart; post-fix it is 2 rounds, LANE_COUNT wide, PACE_MS apart.
    expect(rounds.size).toBe(Math.ceil(M / LANE_COUNT));
    const sortedTimes = [...rounds.keys()].sort((a, b) => a - b);
    for (const t of sortedTimes) expect(rounds.get(t)).toBe(LANE_COUNT);
    expect(sortedTimes[0]).toBe(t0);
    expect(sortedTimes[1]! - sortedTimes[0]!).toBe(PACE_MS);
  });

  it('never starts two (re)subscribes on the same lane inside SUBSCRIBE_LANE_SPACING_MS, even with jitter added on top', async () => {
    vi.useFakeTimers();
    const LANE_COUNT = 4;
    const PACE_MS = 1000;
    const M = LANE_COUNT + 1; // forces exactly one lane to be reused, isolating the floor
    const symbols = Array.from({ length: M }, (_, i) => symbolId(`SYM${i}/USDT`));
    const callTimes: number[] = [];
    const watchSource: WatchSource = {
      watchTicker: () => {
        callTimes.push(Date.now());
        return new Promise<never>(() => {});
      },
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };
    const stateTracker: ChannelStateTracker = {
      setHealth: vi.fn(),
      recordEvent: vi.fn(),
      checkStaleness: vi.fn(),
    };
    const exchange = { id: 'binance', has: { watchTicker: true } } as never;
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const adapter = new CcxtExchangeStreamAdapter(
      timerClock,
      watchSource,
      exchange,
      V,
      stateTracker,
      undefined,
      () => 50, // fixed nonzero jitter — the floor must hold on top of it, never under it
    );
    const spec: SubscriptionSpec = { venue: V, symbols, channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    await vi.advanceTimersByTimeAsync(3_000);
    await iterator.return?.();

    const sorted = [...callTimes].sort((a, b) => a - b);
    expect(sorted).toHaveLength(M);
    // The first LANE_COUNT starts share round 1; the (LANE_COUNT+1)-th reuses a lane and must wait
    // at least the full pace beyond that lane's round-1 claim, jitter or not.
    expect(sorted[LANE_COUNT]! - sorted[0]!).toBeGreaterThanOrEqual(PACE_MS);
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
