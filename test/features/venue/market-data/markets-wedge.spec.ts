import { describe, it, expect, vi, afterEach } from 'vitest';
import { NetworkError, type Exchange, type Ticker } from 'ccxt';
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
const LANE_COUNT = 4; // mirrors SUBSCRIBE_LANE_COUNT — keeps every first subscribe in round 1
const unused = (): Promise<never> => Promise.reject(new Error('unused'));

// Regression for the 2026-08-06 live incident (see the pinned-ccxt-4.5.58 header comment in
// ccxt-stream.adapter.ts): a markets load that fails during an outage leaves ccxt's marketsLoading
// permanently rejected (Exchange.js:891-903) — every subsequent watch* rejects instantly, zero
// network I/O, and the surfaced error is an ordinary NetworkError indistinguishable from a real,
// still-live outage. hasNoMarkets() detects the wedge structurally (the exchange's own market cache
// is empty); forceReloadMarkets() is the only escape (loadMarkets(true) re-enters the load ccxt's own
// guard would otherwise skip). Single-flighted and cooldown-gated so ~90 supervised loops sharing one
// wedged instance cost at most one exchangeInfo call per MARKETS_RELOAD_COOLDOWN_MS window, not one
// per failing loop.

function makeTracker(): ChannelStateTracker {
  return { setHealth: vi.fn(), recordEvent: vi.fn(), checkStaleness: vi.fn() };
}

function fakeExchange(
  markets: Record<string, unknown> | undefined,
  loadMarkets: ReturnType<typeof vi.fn>,
): Exchange {
  // hasNoMarkets() now reads exchange.symbols (kept in lockstep with exchange.markets by ccxt's own
  // setMarkets — see the adapter's hasNoMarkets header comment), so the fixture derives it the same
  // way ccxt does: undefined markets ⇒ undefined symbols (wedged), populated markets ⇒ their keys.
  const symbols = markets ? Object.keys(markets) : undefined;
  return {
    id: 'binance',
    has: { watchTicker: true },
    markets,
    symbols,
    loadMarkets,
  } as unknown as Exchange;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CcxtExchangeStreamAdapter markets-wedge recovery (loadMarkets(true) escape)', () => {
  it('single-flights loadMarkets(true) across many concurrent handleLoopError callers hitting the wedge in the same beat', async () => {
    vi.useFakeTimers();
    const clock: ClockPort = { now: () => epochMs(0) };
    const symbols = Array.from({ length: LANE_COUNT }, (_, i) => symbolId(`SYM${i}/USDT`));
    const loadMarkets = vi.fn(() => Promise.resolve({}));
    const exchange = fakeExchange(undefined, loadMarkets); // wedged: markets never populated

    let callCount = 0;
    const wedgeRejectors: Array<(err: unknown) => void> = [];
    const watchTicker: WatchSource['watchTicker'] = () => {
      callCount++;
      if (callCount <= symbols.length) {
        return new Promise<Ticker>((_, reject) => wedgeRejectors.push(reject));
      }
      return new Promise<never>(() => {}); // park after the first round is proven
    };
    const watchSource: WatchSource = {
      watchTicker,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };

    const tracker = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      exchange,
      V,
      tracker,
      undefined,
      () => 0,
    );
    const spec: SubscriptionSpec = { venue: V, symbols, channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // Every loop's first watch call is parked; flush a bounded number of microtask ticks so all N
    // register before rejecting them together — the wedge lands on every loop at once, per the
    // incident shape.
    for (let i = 0; i < 50 && wedgeRejectors.length < symbols.length; i++) await Promise.resolve();
    expect(wedgeRejectors).toHaveLength(symbols.length);
    for (const reject of wedgeRejectors) reject(new NetworkError('exchangeInfo fetch failed'));

    await vi.advanceTimersByTimeAsync(1_500); // the shared 1s channel backoff + subscribe-gate slot

    expect(loadMarkets).toHaveBeenCalledTimes(1); // single-flight: N concurrent callers, one reload
    expect(loadMarkets).toHaveBeenCalledWith(true);

    await iterator.return?.();
  });

  // SHOULD-FIX 4 (2026-08-06 adversarial review): the sibling "single-flights ..." test above cannot
  // fail from removing the single-flight guard alone — with the clock frozen at 0, the COOLDOWN check
  // alone already holds every concurrent caller to one loadMarkets() call, so deleting `if
  // (this.marketsReloadPromise) return this.marketsReloadPromise;` still leaves the whole suite
  // green. This test isolates the single-flight guard from the cooldown: TWO symbols, driven with
  // fully manual watch resolvers (decoupling this test's timing from the channel backoff schedule
  // entirely). Symbol A's failure starts the (never-resolved) first reload; the fake clock then
  // advances PAST MARKETS_RELOAD_COOLDOWN_MS; only THEN does symbol B fail, triggering a second,
  // independent handleLoopError call while A's reload is still in flight. Only the single-flight
  // guard — not the cooldown, which has by then elapsed — can be why B does not trigger a second
  // loadMarkets() call.
  it('single-flight (not the cooldown) blocks a second concurrent loadMarkets(true) call after the cooldown window has elapsed while the first attempt is still unresolved', async () => {
    vi.useFakeTimers();
    // Wall-clock-driven (mirrors the cooldown-expiry test below): clock.now() must actually advance
    // past MARKETS_RELOAD_COOLDOWN_MS for this test to isolate single-flight from the cooldown gate.
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    // Object-wrapped (not a bare `let`): TS's control-flow narrowing otherwise treats a bare `let`
    // reassigned only inside the Promise executor as staying `null` at every later read in this
    // function (it cannot prove the executor runs first), narrowing `resolveLoad?.()` to `never`.
    const loadState: { resolveLoad: (() => void) | null } = { resolveLoad: null };
    const loadMarkets = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          loadState.resolveLoad = () => resolve({});
        }),
    );
    const exchange = fakeExchange(undefined, loadMarkets); // wedged: markets never populated

    const symA = symbolId('AAA/USDT');
    const symB = symbolId('BBB/USDT');
    const pendingBySymbol = new Map<string, { reject: (e: unknown) => void }>();
    const watchTicker: WatchSource['watchTicker'] = (_exchange, symbol) =>
      new Promise<Ticker>((_resolve, reject) => {
        pendingBySymbol.set(symbol, { reject });
      });
    const watchSource: WatchSource = {
      watchTicker,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };
    const waitForPending = async (symbol: string): Promise<{ reject: (e: unknown) => void }> => {
      for (let i = 0; i < 50 && !pendingBySymbol.has(symbol); i++) await Promise.resolve();
      const pending = pendingBySymbol.get(symbol);
      if (!pending) throw new Error(`watchTicker for ${symbol} was not called`);
      pendingBySymbol.delete(symbol);
      return pending;
    };

    const tracker = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      timerClock,
      watchSource,
      exchange,
      V,
      tracker,
      undefined,
      () => 0,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [symA, symB], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    // A's failure starts the first, still-unresolved reload.
    (await waitForPending(symA)).reject(new NetworkError('exchangeInfo fetch failed'));
    for (let i = 0; i < 50 && loadMarkets.mock.calls.length < 1; i++) await Promise.resolve();
    expect(loadMarkets).toHaveBeenCalledTimes(1);

    // Advance PAST the 15s cooldown while that reload is still unresolved (resolveLoad untouched).
    await vi.advanceTimersByTimeAsync(20_000);

    // B's first call has sat parked the whole time; failing it now — well past the cooldown — is a
    // second, independent handleLoopError call concurrent with A's still-unresolved reload.
    (await waitForPending(symB)).reject(new NetworkError('exchangeInfo fetch failed'));
    await vi.advanceTimersByTimeAsync(500);

    expect(loadMarkets).toHaveBeenCalledTimes(1); // single-flight held, independent of cooldown state

    loadState.resolveLoad?.();
    await iterator.return?.();
  });

  it('does not attempt another loadMarkets(true) call inside the cooldown, but does after it expires', async () => {
    vi.useFakeTimers();
    // Wall-clock-driven (mirrors supervised-loop.spec.ts's lane-pace tests): clock.now() and the
    // channel backoff's setTimeout share the same time base, so the cooldown math never desyncs
    // from the fake-timer advances below.
    const timerClock: ClockPort = { now: () => epochMs(Date.now()) };
    const loadMarkets = vi.fn(() => Promise.resolve({}));
    const exchange = fakeExchange(undefined, loadMarkets);

    let n = 0;
    const watchTicker: WatchSource['watchTicker'] = () => {
      n++;
      if (n <= 6) return Promise.reject(new NetworkError('exchangeInfo fetch failed'));
      return new Promise<never>(() => {}); // park — bounded, nothing further to prove after (h)
    };
    const watchSource: WatchSource = {
      watchTicker,
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };
    const tracker = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      timerClock,
      watchSource,
      exchange,
      V,
      tracker,
      undefined,
      () => 0,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();
    const pendingNext = iterator.next(); // never resolves — every observed call rejects

    // Failure #1 fires the first reload at ~t=0. Cumulative channel backoff after failures 1-4
    // (1s+2s+4s+8s=15s) keeps failures 2-4 comfortably inside the 15s markets-reload cooldown.
    await vi.advanceTimersByTimeAsync(14_500);
    expect(loadMarkets).toHaveBeenCalledTimes(1); // cooldown held through failures 2-4

    // Failure #5 lands at cumulative ~15s — at/past the cooldown boundary measured from failure #1's
    // reload attempt. Stops short of failure #6 (cumulative ~31s), which would itself re-arm a THIRD
    // reload and muddy this specific assertion.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadMarkets).toHaveBeenCalledTimes(2); // cooldown expired: a second reload attempt fires

    await iterator.return?.();
    void pendingNext;
  });

  it('a populated markets object never triggers a reload — no false positives on an ordinary transient error', async () => {
    vi.useFakeTimers();
    const clock: ClockPort = { now: () => epochMs(0) };
    const loadMarkets = vi.fn(() => Promise.resolve({}));
    const exchange = fakeExchange({ 'BTC/USDT': {} }, loadMarkets); // healthy: markets populated

    let n = 0;
    const watchSource: WatchSource = {
      watchTicker: () => {
        n++;
        if (n === 1) return Promise.reject(new NetworkError('socket hiccup'));
        if (n === 2) return Promise.resolve({ symbol: SYM } as unknown as Ticker);
        return new Promise<never>(() => {});
      },
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };
    const tracker = makeTracker();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      exchange,
      V,
      tracker,
      undefined,
      () => 0,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(2_000); // 1s backoff + subscribe-gate slot
    const first = await pending;
    if (first.done) throw new Error('expected a ticker event');

    expect(loadMarkets).not.toHaveBeenCalled(); // populated markets ⇒ never a false-positive reload

    await iterator.return?.();
  });

  it('swallows a rejecting loadMarkets(true) — the loop keeps its normal DEGRADED/backoff path and eventually recovers (fail-open)', async () => {
    vi.useFakeTimers();
    const clock: ClockPort = { now: () => epochMs(0) };
    const loadMarkets = vi.fn(() => Promise.reject(new Error('exchangeInfo fetch failed')));
    const exchange = fakeExchange(undefined, loadMarkets); // still wedged: the reload itself fails too

    let n = 0;
    const watchSource: WatchSource = {
      watchTicker: () => {
        n++;
        if (n <= 2) return Promise.reject(new NetworkError('exchangeInfo fetch failed'));
        if (n === 3) return Promise.resolve({ symbol: SYM } as unknown as Ticker);
        return new Promise<never>(() => {}); // park: no runaway loop after recovery is proven
      },
      watchTrades: unused,
      watchOHLCV: unused,
      watchOrderBook: unused,
    };
    const tracker = makeTracker();
    const warn = vi.fn();
    const adapter = new CcxtExchangeStreamAdapter(
      clock,
      watchSource,
      exchange,
      V,
      tracker,
      { warn, error: vi.fn() },
      () => 0,
    );
    const spec: SubscriptionSpec = { venue: V, symbols: [SYM], channels: { ticker: true } };
    const iterator = adapter.marketRaw(spec)[Symbol.asyncIterator]();

    const pending = iterator.next();
    // Two failures: 1s + 2s channel backoff, plus the subscribe-gate slots — generous margin.
    await vi.advanceTimersByTimeAsync(6_000);
    const first = await pending;
    if (first.done) throw new Error('expected the loop to recover despite the reload failing');
    expect(first.value.type).toBe('ticker');

    expect(loadMarkets).toHaveBeenCalled(); // the reload was attempted
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('markets reload failed'));
    // Fail-open: a rejecting reload never propagates out of handleLoopError — the ordinary transient
    // error path (DEGRADED, backoff, retry) still ran to completion.

    await iterator.return?.();
  });
});
