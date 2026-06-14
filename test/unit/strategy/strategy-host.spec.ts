import { describe, it, expect } from 'vitest';
import { StrategyHost } from '../../../src/modules/strategy/strategy-host';
import { StrategyRegistry } from '../../../src/modules/strategy/strategy-registry';
import type { MarketStreamPort, FeedHealthPort } from '../../../src/ports/market-data';
import type { SignalSinkPort } from '../../../src/ports/strategy';
import type { Strategy, MarketView } from '../../../src/domain/strategy/strategy';
import type { MarketEvent, CandleEvent } from '../../../src/domain/types/market-events';
import type { Signal } from '../../../src/domain/types/signal';
import type { SubscriptionSpec } from '../../../src/domain/types/subscription';
import { strategyId, venueId, symbolId, epochMs, type StrategyId } from '../../../src/domain/types/ids';
import { price, qty } from '../../../src/domain/types/money';

const V = venueId('binance');
const S = symbolId('BTC/USDT');

function candle(seq: number, t: number): CandleEvent {
  return {
    kind: 'CANDLE', venue: V, symbol: S, channel: 'candle:1h', seq: BigInt(seq),
    eventTime: epochMs(t), ingestTime: epochMs(t + 1), interval: '1h',
    openTime: epochMs(t), closeTime: epochMs(t + 1), open: price('100'), high: price('100'),
    low: price('100'), close: price('100'), volume: qty('1'), closed: true,
  };
}

function ticker(seq: number, t: number): MarketEvent {
  return {
    kind: 'TICKER', venue: V, symbol: S, channel: 'ticker', seq: BigInt(seq),
    eventTime: epochMs(t), ingestTime: epochMs(t + 1), bid: price('99'), ask: price('101'), last: price('100'),
  };
}

function book(seq: number, t: number): MarketEvent {
  return {
    kind: 'ORDER_BOOK_SNAPSHOT', venue: V, symbol: S, channel: 'book', seq: BigInt(seq),
    eventTime: epochMs(t), ingestTime: epochMs(t + 1),
    bids: [{ price: price('99'), qty: qty('1') }], asks: [{ price: price('101'), qty: qty('1') }],
  };
}

function execReport(t: number) {
  return {
    reportId: `r${t}`, clientOrderId: 'cbp0000000000000007000800000000000000' as never,
    venue: V, symbol: S, eventTime: epochMs(t), ingestTime: epochMs(t), kind: 'ACK' as const, venueOrderId: 'v',
  };
}

function sig(kind: Signal['kind'], t: number): Signal {
  return {
    strategyId: strategyId('fake'), venue: V, symbol: S, kind, strength: 1,
    refPrice: price('100'), basedOnSeq: 1n, eventTime: epochMs(t), ttlMs: 1000,
    dedupeKey: `fake:${kind}:${t}`, reason: 'test',
  };
}

// Fake strategy with a mutable emission so host behaviour is fully controllable.
class FakeStrategy implements Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec = {
    venue: V,
    symbols: [S],
    channels: { candles: ['1h'], ticker: true, book: true },
  };
  readonly warmup = { interval: '1h' as const, bars: 2 };
  emit: Signal[] = [];
  tickEmit: Signal[] = [];
  bookEmit: Signal[] = [];
  execEmit: Signal[] = [];
  lastViewEventTime = 0;
  constructor(id: StrategyId) { this.id = id; }
  onInit(): void {}
  onCandle(_e: CandleEvent, v: MarketView): Signal[] {
    // Exercise the host-assembled MarketView so its accessors are covered.
    this.lastViewEventTime = v.eventTime;
    v.candles(S, '1h', 3);
    v.lastTicker(S);
    v.book(S);
    v.feed(S, 'candle:1h');
    v.random();
    void v.portfolio;
    return this.emit;
  }
  onTick(): Signal[] { return this.tickEmit; }
  onOrderBook(): Signal[] { return this.bookEmit; }
  onExecReport(): Signal[] { return this.execEmit; }
  onStop(): void {}
}

// Push-based market stream the test drives event-by-event.
function pushStream() {
  const queue: MarketEvent[] = [];
  let resolve: ((r: IteratorResult<MarketEvent>) => void) | null = null;
  let closed = false;
  const iterable: AsyncIterable<MarketEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<MarketEvent>> => {
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
        if (closed) return Promise.resolve({ value: undefined as unknown as MarketEvent, done: true });
        return new Promise((r) => (resolve = r));
      },
    }),
  };
  return {
    iterable,
    push(v: MarketEvent) {
      if (resolve) { const r = resolve; resolve = null; r({ value: v, done: false }); } else queue.push(v);
    },
    close() {
      closed = true;
      if (resolve) { const r = resolve; resolve = null; r({ value: undefined, done: true }); }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function feedHealth(warmup: CandleEvent[] = []): FeedHealthPort {
  return {
    health: () => 'LIVE',
    getRefPrice: () => undefined,
    fetchCandles: () => Promise.resolve(warmup),
  };
}

function makeHost(opts: {
  strategy: FakeStrategy;
  stream: AsyncIterable<MarketEvent>;
  sink: SignalSinkPort;
  warmup?: CandleEvent[];
  hrtimeFn?: () => bigint;
}): { host: StrategyHost; registry: StrategyRegistry; id: StrategyId } {
  const registry = new StrategyRegistry();
  const id = opts.strategy.id;
  registry.register('fake', () => opts.strategy);
  registry.enable(id, 'fake', {});
  const marketStream: MarketStreamPort = { subscribe: () => opts.stream };
  const host = new StrategyHost(marketStream, feedHealth(opts.warmup), opts.sink, registry, opts.hrtimeFn);
  return { host, registry, id };
}

describe('StrategyHost', () => {
  it('discards signals emitted during WARMUP replay and reaches ACTIVE', async () => {
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new FakeStrategy(strategyId('w'));
    strat.emit = [sig('ENTER_LONG', 1)]; // would emit on every warmup candle
    const stream = pushStream();
    const { host, registry, id } = makeHost({ strategy: strat, stream: stream.iterable, sink, warmup: [candle(0, 0), candle(1, 1)] });

    await host.start(); // warmup replays 2 candles — discarded
    stream.close();
    const got: Signal[] = [];
    for await (const s of host.signals()) got.push(s);

    expect(recorded).toEqual([]); // nothing persisted during warmup
    expect(got).toEqual([]);
    expect(registry.getLifecycle(id)).toBe('ACTIVE');
  });

  it('emits and persists signals once ACTIVE', async () => {
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new FakeStrategy(strategyId('a'));
    strat.emit = [sig('ENTER_LONG', 5)];
    const stream = pushStream();
    const { host } = makeHost({ strategy: strat, stream: stream.iterable, sink });

    await host.start();
    // Park a consumer first so the emitted signal is handed straight to the waiting
    // resolver (covers the immediate-handoff path, not just the buffer path).
    const iterator = host.signals()[Symbol.asyncIterator]();
    const pending = iterator.next();
    stream.push(candle(0, 5));
    const first = await pending;

    if (first.done) throw new Error('expected a signal');
    expect(first.value.kind).toBe('ENTER_LONG');
    expect(recorded.map((s) => s.kind)).toEqual(['ENTER_LONG']);
    stream.close();
  });

  it('auto-transitions to DRAINING after 3 consecutive hard CPU breaches', async () => {
    const sink: SignalSinkPort = { recordSignal: () => {} };
    const strat = new FakeStrategy(strategyId('cpu'));
    strat.emit = [];
    const stream = pushStream();
    // hrtime alternates 0 → 60ms per processItem call pair ⇒ every handler "takes" 60ms (> 50ms hard).
    let tog = false;
    const hrtimeFn = () => {
      tog = !tog;
      return tog ? 0n : 60_000_000n;
    };
    const { host, registry, id } = makeHost({ strategy: strat, stream: stream.iterable, sink, hrtimeFn });

    await host.start();
    for (let i = 0; i < 3; i++) {
      stream.push(candle(i, i));
      await tick();
    }
    stream.close();
    for await (const _ of host.signals()) void _;

    expect(registry.getLifecycle(id)).toBe('DRAINING');
  });

  it('while DRAINING, filters emissions to risk-reducing kinds only', async () => {
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new FakeStrategy(strategyId('drain'));
    const stream = pushStream();
    const { host, registry, id } = makeHost({ strategy: strat, stream: stream.iterable, sink });

    await host.start();
    registry.setLifecycle(id, 'DRAINING');

    strat.emit = [sig('ENTER_LONG', 1)]; // risk-INCREASING → filtered out
    stream.push(candle(0, 1));
    await tick();
    strat.emit = [sig('EXIT_LONG', 2)]; // risk-reducing → allowed
    stream.push(candle(1, 2));
    await tick();
    stream.close();

    const got: Signal[] = [];
    for await (const s of host.signals()) got.push(s);
    expect(got.map((s) => s.kind)).toEqual(['EXIT_LONG']);
    expect(recorded.map((s) => s.kind)).toEqual(['EXIT_LONG']);
  });

  it('routes ticker, book, and exec-report events to their handlers', async () => {
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new FakeStrategy(strategyId('multi'));
    strat.emit = [];
    strat.tickEmit = [sig('CANCEL_OPEN', 1)];
    strat.bookEmit = [];
    strat.execEmit = [sig('FLATTEN', 3)];
    const stream = pushStream();
    const { host, id } = makeHost({ strategy: strat, stream: stream.iterable, sink });

    await host.start();
    stream.push(ticker(1, 1));
    await tick();
    stream.push(book(2, 2));
    await tick();
    // A TRADE event is accepted by the host but not dispatched to strategies in v1.
    stream.push({
      kind: 'TRADE', venue: V, symbol: S, channel: 'trade', seq: 4n,
      eventTime: epochMs(4), ingestTime: epochMs(5), price: price('100'), qty: qty('1'), side: 'BUY', tradeId: 't',
    });
    await tick();
    host.enqueueExecReport(id, execReport(3)); // queued; drained on the next stream event
    stream.push(candle(3, 3));
    await tick();
    stream.close();

    const got: Signal[] = [];
    for await (const s of host.signals()) got.push(s);
    expect(got.map((s) => s.kind).sort()).toEqual(['CANCEL_OPEN', 'FLATTEN']);
  });

  it('conflates same-symbol ticker and book updates queued before a drain', async () => {
    const sink: SignalSinkPort = { recordSignal: () => {} };
    const strat = new FakeStrategy(strategyId('conf'));
    strat.tickEmit = [sig('CANCEL_OPEN', 9)];
    const stream = pushStream();
    const { host } = makeHost({ strategy: strat, stream: stream.iterable, sink });
    await host.start(); // populates the per-strategy runtime; the empty stream parks consumeEvents

    const internals = host as unknown as { routeEvent(e: MarketEvent): void; drainMailboxes(): void };
    internals.routeEvent(ticker(1, 1));
    internals.routeEvent(ticker(2, 2)); // same symbol → conflates onto the queued ticker
    internals.routeEvent(book(3, 3));
    internals.routeEvent(book(4, 4)); // same symbol → conflates onto the queued book
    internals.drainMailboxes();
    stream.close();

    const got: Signal[] = [];
    for await (const s of host.signals()) got.push(s);
    // Only one conflated ticker was processed → exactly one CANCEL_OPEN.
    expect(got.filter((s) => s.kind === 'CANCEL_OPEN')).toHaveLength(1);
  });

  it('stop() halts ACTIVE strategies and ends the signal stream', async () => {
    const sink: SignalSinkPort = { recordSignal: () => {} };
    const strat = new FakeStrategy(strategyId('stop'));
    const stream = pushStream();
    const { host, registry, id } = makeHost({ strategy: strat, stream: stream.iterable, sink });
    await host.start();
    // Park a consumer on signals() BEFORE stop() so stop() wakes the waiting resolver.
    const iterator = host.signals()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await host.stop();
    expect(registry.getLifecycle(id)).toBe('HALTED');
    const r = await pending;
    expect(r.done).toBe(true);
  });
});
