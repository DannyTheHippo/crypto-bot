import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CcxtExchangeStreamAdapter,
  type WatchSource,
  type ChannelStateTracker,
  type RecreationPolicy,
} from '../../../../src/features/venue/market-data/ccxt-stream.adapter';
import type { ClockPort } from '../../../../src/ports/common/clock';
import { venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';
import type { SubscriptionSpec } from '../../../../src/ports/venue/market-data';

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

    // Thin-venue storm regression (2026-07-21 v3 soak): demo klines are trade-driven on thin
    // symbols, so candle silence past the generic 180s threshold is NORMAL there and must NOT
    // trigger a connection-wide close.
    now = 400_000;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(recordForcedReconnect).not.toHaveBeenCalled();

    // Silence past the candle-specific 20-min threshold IS a dead subscription (the 2026-07-16
    // 8.2h stall class) — the watchdog must close.
    now = 1_300_000;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(recordForcedReconnect).toHaveBeenCalledTimes(1);

    // Cooldown: still stalled, but further ticks inside the cooldown window must not close again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Past the cooldown and still silent: the watchdog retries the reconnect.
    now = 2_600_000;
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

    // Candle channels carry the 20-min threshold (thin-venue storm fix, 2026-07-21).
    now = 1_300_000;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('close() failed'));

    // The rejection was contained: a later tick past the cooldown retries.
    now = 2_600_000;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(closeSpy).toHaveBeenCalledTimes(2);

    await iterator.return?.();
    void pendingNext;
  });

  // LIVE INCIDENT 2026-08-06: exchange.close() is a no-op on a never-connected instance (its
  // `clients` map is empty — nothing to close, no ExchangeClosedByUser minted). 222 watchdog fires
  // against exactly this wedge produced zero recreations, because the watchdog's only lever was
  // close(). After WATCHDOG_ZERO_YIELD_ESCALATION_THRESHOLD (3) consecutive forced-reconnect ticks
  // that still find the channel stalled, the watchdog must call recreateExchange() itself instead of
  // repeating an inert close().
  it('escalates to exchange recreation after 3 consecutive zero-yield forced reconnects — close() alone never recovers this wedge', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    // Never yields at all after loop start — the incident shape: close() cannot make a promise that
    // never settles resolve, no matter how many times it is called.
    const watchSource: WatchSource = {
      watchTicker: () => new Promise<never>(() => {}),
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };

    const staleClose = vi.fn(() => Promise.resolve());
    const stale = { id: 'binance', has: { watchTicker: true }, close: staleClose } as never;
    const freshLoadMarkets = vi.fn(() => Promise.resolve({}));
    const fresh = {
      id: 'binance',
      has: { watchTicker: true },
      close: vi.fn(() => Promise.resolve()),
      loadMarkets: freshLoadMarkets,
    } as never;
    const factory = vi.fn(() => fresh);
    const { tracker } = makeTracker();
    const error = vi.fn();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      { warn: vi.fn(), error },
      undefined,
      factory,
    );

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const pendingNext = iterator.next(); // never resolves — the channel never yields

    // Ticker carries the 180s stall threshold; the watchdog checks every 30s and re-forces at most
    // once per 120s cooldown.
    now = 200_000; // past the 180s threshold
    await vi.advanceTimersByTimeAsync(31_000); // tick #1: forces close() (1st consecutive zero-yield)
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();

    now = 340_000; // +140s, past the 120s cooldown
    await vi.advanceTimersByTimeAsync(31_000); // tick #2: forces close() again (2nd consecutive)
    expect(staleClose).toHaveBeenCalledTimes(2);
    expect(factory).not.toHaveBeenCalled();

    now = 480_000; // +140s, past cooldown again
    await vi.advanceTimersByTimeAsync(31_000); // tick #3: escalates to recreation instead of close()
    expect(factory).toHaveBeenCalledTimes(1);
    expect(freshLoadMarkets).toHaveBeenCalledTimes(1); // recreation's own eager-load guard still ran
    expect(error).toHaveBeenCalledWith(expect.stringContaining('consecutive forced'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('close() is inert'));
    // The stale instance is still close()'d once more here — but as part of the SUCCESSFUL
    // recreation's hard-dispose teardown, not as a repeated, independently-inert watchdog action.
    expect(staleClose).toHaveBeenCalledTimes(3);

    await iterator.return?.();
    void pendingNext;
  });

  it('resets the consecutive zero-yield counter once the channel yields again — a partial recovery does not carry over toward escalation', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    const resolvers: Array<(t: unknown) => void> = [];
    const watchTicker: WatchSource['watchTicker'] = () =>
      new Promise((resolve) => {
        resolvers.push(resolve as (t: unknown) => void);
      });
    const watchSource: WatchSource = {
      watchTicker,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };

    const stale = {
      id: 'binance',
      has: { watchTicker: true },
      close: vi.fn(() => Promise.resolve()),
    } as never;
    const factory = vi.fn(() => stale); // must never be reached — proves the reset held
    const { tracker } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      { warn: vi.fn(), error: vi.fn() },
      undefined,
      factory,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // Two consecutive forced reconnects — one shy of the 3-strike escalation threshold.
    now = 200_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #1: forces close (1 consecutive)
    now = 340_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #2: forces close (2 consecutive)
    expect(factory).not.toHaveBeenCalled();

    // The channel yields once (simulating a resubscribe that briefly worked) — resolve the
    // currently-pending watch call and let the loop's success path (noteYield, then an immediate
    // re-watch) settle before the next tick.
    const beforeLen = resolvers.length;
    resolvers[resolvers.length - 1]!({ timestamp: now });
    for (let i = 0; i < 50 && resolvers.length <= beforeLen; i++) await Promise.resolve();

    now = 480_000; // 140s later: the channel yielded at t=340_000, so it is NOT stalled at this tick
    await vi.advanceTimersByTimeAsync(31_000); // tick #3: stalled.length===0 — resets the counter
    expect(factory).not.toHaveBeenCalled();

    // Two MORE consecutive zero-yield reconnects from the freshly-reset counter — this would be the
    // 3rd/4th/5th strike on a NON-reset counter, but is only strike 1/2 post-reset, so it must NOT
    // escalate yet.
    now = 620_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #4: forces close (1 consecutive, post-reset)
    now = 760_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #5: forces close (2 consecutive, post-reset)
    expect(factory).not.toHaveBeenCalled(); // proves the reset actually happened, not a stale count

    now = 900_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #6: 3rd consecutive since the reset — escalates
    expect(factory).toHaveBeenCalledTimes(1);
  });

  // MUST-FIX 1 (2026-08-06 adversarial review): the escalation call carried NO .catch() — an outer
  // try/catch cannot see an async rejection, and doRecreateExchange has code AFTER its own internal
  // try/catch (recordForcedReconnect, the recreation-logged warn, hardDispose's client teardown,
  // logCapExhausted's error log) that can itself reject. src/main.ts registers
  // process.on('unhandledRejection', … process.exit(1)) — an uncaught rejection here would kill the
  // whole trading process from what is meant to be a recovery-only device.
  it('catches a rejecting escalated recreation — no unhandled rejection escapes, and the failure is logged (fail-open)', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    const watchSource: WatchSource = {
      watchTicker: () => new Promise<never>(() => {}), // never yields — the escalation shape
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };

    const stale = {
      id: 'binance',
      has: { watchTicker: true },
      close: vi.fn(() => Promise.resolve()),
    } as never;
    const fresh = {
      id: 'binance',
      has: { watchTicker: true },
      close: vi.fn(() => Promise.resolve()),
      loadMarkets: vi.fn(() => Promise.resolve({})),
    } as never;
    const factory = vi.fn(() => fresh);

    // Throws only on the 4th call: calls 1-3 are watchdogTick's own per-tick recordForcedReconnect
    // (ticks #1, #2, #3); the 4th is doRecreateExchange's POST-SWAP call (after `this.exchange =
    // fresh`), reached only once the escalation actually recreates — exactly the code path the review
    // demonstrated (a throw at that call site) surfaces an unhandled rejection when unguarded.
    let recordCalls = 0;
    const recordForcedReconnect = vi.fn(() => {
      recordCalls++;
      if (recordCalls === 4) throw new Error('post-swap boom (stateTracker.recordForcedReconnect)');
    });
    const tracker: ChannelStateTracker = {
      setHealth: vi.fn(),
      recordEvent: vi.fn(),
      checkStaleness: vi.fn(),
      recordForcedReconnect,
    };
    const warn = vi.fn();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      { warn, error: vi.fn() },
      undefined,
      factory,
    );

    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const pendingNext = iterator.next(); // never resolves — the channel never yields

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      now = 200_000;
      await vi.advanceTimersByTimeAsync(31_000); // tick #1: forces close()
      now = 340_000;
      await vi.advanceTimersByTimeAsync(31_000); // tick #2: forces close()
      now = 480_000;
      await vi.advanceTimersByTimeAsync(31_000); // tick #3: escalates — swap succeeds, then the
      // post-swap recordForcedReconnect call throws
      await vi.advanceTimersByTimeAsync(0); // drain any queued unhandledRejection dispatch
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandled).toHaveLength(0); // the fix's .catch() keeps this a fail-open warn, not a crash
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('escalated recreation failed'));

    await iterator.return?.();
    void pendingNext;
  });

  // MUST-FIX 2 (2026-08-06 adversarial review): the if/else made escalation and close() mutually
  // exclusive. recreateExchange() returns false WITHOUT acting in three cases (cap exhausted, cooldown
  // active, factory throw) — in all three the pre-fix tick performed no close(), no recreation, no
  // recovery action at all, strictly less than pre-escalation HEAD (which always closed).
  it('falls back to close() when a policy-declined escalation resolves false — a declined recreation must not leave the tick doing nothing', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    const watchSource: WatchSource = {
      watchTicker: () => new Promise<never>(() => {}), // never yields — the escalation shape
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };

    const staleClose = vi.fn(() => Promise.resolve());
    const stale = { id: 'binance', has: { watchTicker: true }, close: staleClose } as never;
    // Must never actually be reached: capPerWindow: 0 declines every recreation attempt before
    // factory() is ever called (isRecreateCapExhausted runs first in doRecreateExchange).
    const factory = vi.fn(() => stale);
    const { tracker } = makeTracker();
    const error = vi.fn();
    const cappedPolicy: RecreationPolicy = {
      cooldownInitialMs: 60_000,
      cooldownMaxMs: 600_000,
      cooldownMultiplier: 2,
      healthyResetMs: 900_000,
      capPerWindow: 0, // exhausted from the start — every recreation attempt is declined
      capWindowMs: 3_600_000,
    };
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      { warn: vi.fn(), error },
      undefined,
      factory,
      cappedPolicy,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const pendingNext = iterator.next();

    now = 200_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #1: forces close() (1st consecutive)
    now = 340_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #2: forces close() (2nd consecutive)
    expect(staleClose).toHaveBeenCalledTimes(2);

    now = 480_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #3: escalation threshold reached, but the
    // capped policy declines every attempt — must fall back to close() instead of doing nothing

    expect(factory).not.toHaveBeenCalled(); // the cap-exhausted check runs before factory() — DECLINED
    expect(staleClose).toHaveBeenCalledTimes(3); // additive fallback: close() still fired this tick
    expect(error).toHaveBeenCalledWith(expect.stringContaining('recreation cap exhausted'));

    await iterator.return?.();
    void pendingNext;
  });

  // MUST-FIX 3 (2026-08-06 adversarial review): the comment claimed "consecutive ticks that still
  // find the SAME channels stalled", but the code compared nothing across ticks — it incremented
  // whenever stalled.length > 0 and reset ONLY when stalled.length === 0. A single permanently-silent
  // channel (a delisted symbol, a thin-tier trade channel) then keeps stalled.length >= 1 forever,
  // latching the counter above threshold even while OTHER channels recover normally in between.
  it('a persistently-stalled book channel must not pin escalation mode while the ticker channel recovers in between', async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: ClockPort = { now: () => epochMs(now) };

    // book never yields at all — the chronic, genuinely-dead-subscription shape this file's header
    // comment documents (a connection-wide close() is the correct, repeatable lever for it).
    const watchOrderBook: WatchSource['watchOrderBook'] = () => new Promise<never>(() => {});
    // ticker is driven manually so its one recovery can be placed at an exact tick.
    const tickerResolvers: Array<(t: unknown) => void> = [];
    const watchTicker: WatchSource['watchTicker'] = () =>
      new Promise((resolve) => {
        tickerResolvers.push(resolve as (t: unknown) => void);
      });
    const watchSource: WatchSource = {
      watchTicker,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook,
    };

    const staleClose = vi.fn(() => Promise.resolve());
    const stale = {
      id: 'binance',
      has: { watchTicker: true, watchOrderBook: true },
      close: staleClose,
    } as never;
    // Must never be reached: proves the reset held (an un-fixed counter would escalate at tick #3).
    const factory = vi.fn(() => stale);
    const { tracker } = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      stale,
      V,
      tracker,
      { warn: vi.fn(), error: vi.fn() },
      undefined,
      factory,
    );
    const spec: SubscriptionSpec = {
      venue: V,
      symbols: [SYM],
      channels: { ticker: true, book: true },
    };
    adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // Both channels seeded at t=0; both past the 180s threshold by tick #1.
    now = 200_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #1: {book, ticker} stalled (1st ever) — close()
    now = 340_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #2: {book, ticker} again (same set) — close()
    expect(factory).not.toHaveBeenCalled();

    // Ticker recovers once, right after tick #2, at now=340_000.
    const beforeLen = tickerResolvers.length;
    tickerResolvers[tickerResolvers.length - 1]!({ timestamp: now });
    for (let i = 0; i < 50 && tickerResolvers.length <= beforeLen; i++) await Promise.resolve();

    // tick #3 would be the 3rd consecutive strike (and therefore ESCALATE) under the pre-fix "any
    // channel stalled" counting, because book alone still keeps stalled.length >= 1. With the fix,
    // {book, ticker} → {book} is a SHRUNK set (ticker recovered), so the streak resets instead.
    now = 480_000;
    await vi.advanceTimersByTimeAsync(31_000); // tick #3: {book} only — set changed, counter resets
    expect(factory).not.toHaveBeenCalled(); // proves the reset, not a stale/monotonic count
    expect(staleClose).toHaveBeenCalledTimes(3); // close() fired again for book — the correct lever
  });
});
