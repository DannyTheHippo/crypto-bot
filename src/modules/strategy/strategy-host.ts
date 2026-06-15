import { Injectable, Inject } from '@nestjs/common';
import type { StrategyId, EpochMs } from '../../domain/types/ids';
import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
  ChannelHealth,
  CandleInterval,
} from '../../domain/types/market-events';
import type { MarketEvent } from '../../domain/types/market-events';
import type { ExecReport } from '../../domain/types/exec-report';
import type { Signal } from '../../domain/types/signal';
import type { StrategyPortfolioView } from '../../domain/types/portfolio';
import { strategyId, venueId, symbolId } from '../../domain/types/ids';
import { mulberry32 } from '../../domain/strategy/prng';
import type { MarketView } from '../../domain/strategy/strategy';
import type { MarketStreamPort, FeedHealthPort } from '../../ports/market-data';
import { MARKET_STREAM, FEED_HEALTH } from '../../ports/market-data';
import type { StrategyHostPort, SignalSinkPort } from '../../ports/strategy';
import { SIGNAL_SINK } from '../../ports/strategy';
import type { StrategyState } from '../../ports/strategy';
import { StrategyRegistry } from './strategy-registry';

// CPU budget per handler call: 10 ms soft, 50 ms hard. Compared in nanoseconds as
// bigints — Number() is banned on these paths and hrtime.bigint() is nanoseconds.
const CPU_SOFT_NS = 10_000_000n;
const CPU_HARD_NS = 50_000_000n;
// Consecutive hard-breach count before auto-DRAINING.
const MAX_CONSECUTIVE_HARD = 3;

// Risk-reducing signal kinds: allowed while DRAINING. EXIT_SHORT (covering a short) reduces risk like
// EXIT_LONG; ENTER_SHORT (opening a short) ADDS risk and is intentionally excluded.
const RISK_REDUCING = new Set<Signal['kind']>([
  'EXIT_LONG',
  'EXIT_SHORT',
  'FLATTEN',
  'CANCEL_OPEN',
]);

// A mailbox item with a priority weight.
// Priority order (high→low): execReports(3) > closedCandles(2) > trades(1) > book/ticker(0)
interface MailboxItem {
  kind: 'candle' | 'ticker' | 'book' | 'exec';
  priority: number;
  event: CandleEvent | TickerEvent | OrderBookSnapshotEvent | ExecReport;
}

// Per-strategy runtime state kept by the host.
interface StrategyRuntime {
  mailbox: MailboxItem[];
  consecutiveHardBreaches: number;
  // Per-symbol candle history (bounded at warmup.bars + 1).
  candleHistory: Map<string, CandleEvent[]>;
  // Per-symbol last ticker.
  tickers: Map<string, TickerEvent>;
  // Per-symbol last book snapshot.
  books: Map<string, OrderBookSnapshotEvent>;
  // PRNG factory with fixed seed per strategy instance.
  prng: () => number;
}

@Injectable()
export class StrategyHost implements StrategyHostPort {
  private readonly runtimes = new Map<StrategyId, StrategyRuntime>();
  // Signal channel: signals produced during ACTIVE/DRAINING are pushed here.
  private readonly signalQueue: Signal[] = [];
  private signalDone = false;
  private signalResolvers: Array<(value: IteratorResult<Signal>) => void> = [];

  // hrtime injected for testability: returns nanoseconds as bigint.
  private readonly hrtimeFn: () => bigint;

  constructor(
    @Inject(MARKET_STREAM) private readonly marketStream: MarketStreamPort,
    @Inject(FEED_HEALTH) private readonly feedHealth: FeedHealthPort,
    @Inject(SIGNAL_SINK) private readonly signalSink: SignalSinkPort,
    private readonly registry: StrategyRegistry,
    hrtimeFn?: () => bigint,
  ) {
    this.hrtimeFn = hrtimeFn ?? (() => process.hrtime.bigint());
  }

  async start(): Promise<void> {
    // Walk all strategies in LOADING; run warmup then transition to ACTIVE.
    for (const { id, lifecycle } of this.registry.states()) {
      if (lifecycle !== 'LOADING') continue;
      await this.initStrategy(id);
    }

    // Consume market events in the background.
    void this.consumeEvents();
  }

  stop(): Promise<void> {
    // Drain all ACTIVE strategies.
    for (const { id, lifecycle } of this.registry.states()) {
      if (lifecycle === 'ACTIVE') {
        const strategy = this.registry.getStrategy(id);
        if (strategy) strategy.onStop();
        this.registry.setLifecycle(id, 'HALTED');
      }
    }
    this.signalDone = true;
    // Wake any waiting consumer.
    for (const resolve of this.signalResolvers) {
      resolve({ value: undefined, done: true });
    }
    this.signalResolvers = [];
    return Promise.resolve();
  }

  signals(): AsyncIterable<Signal> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Signal> => ({
        next: (): Promise<IteratorResult<Signal>> => {
          if (this.signalQueue.length > 0) {
            return Promise.resolve({ value: this.signalQueue.shift()!, done: false });
          }
          if (this.signalDone) {
            return Promise.resolve({ value: undefined as unknown as Signal, done: true });
          }
          return new Promise<IteratorResult<Signal>>((resolve) => {
            this.signalResolvers.push(resolve);
          });
        },
      }),
    };
  }

  private async initStrategy(id: StrategyId): Promise<void> {
    const strategy = this.registry.getStrategy(id);
    if (!strategy) return;

    const runtime: StrategyRuntime = {
      mailbox: [],
      consecutiveHardBreaches: 0,
      candleHistory: new Map(),
      tickers: new Map(),
      books: new Map(),
      prng: mulberry32(this.seedFromId(id)),
    };
    this.runtimes.set(id, runtime);

    // Transition to WARMUP.
    this.registry.setLifecycle(id, 'WARMUP');

    // Call onInit with empty warmup map (history populated via candles during warmup).
    strategy.onInit({
      params: {},
      warmupCandles: new Map(),
      symbolConstraints: new Map(),
    });

    // Replay historical candles for warmup (signals discarded).
    const spec = strategy.subscriptions;
    const { interval, bars } = strategy.warmup;
    for (const symbol of spec.symbols) {
      let candles: CandleEvent[] = [];
      try {
        candles = [...(await this.feedHealth.fetchCandles(spec.venue, symbol, interval, bars))];
      } catch {
        // Warmup backfill failure is non-fatal: strategy proceeds with empty history.
      }
      const hist = runtime.candleHistory.get(symbol) ?? [];
      for (const c of candles) {
        hist.push(c);
        if (hist.length > bars + 1) hist.shift();
        // Build a minimal MarketView for warmup; signals are discarded.
        const view = this.buildView(runtime, c.eventTime, strategy.subscriptions.venue);
        strategy.onCandle(c, view); // signals discarded
      }
      runtime.candleHistory.set(symbol, hist);
    }

    this.registry.setLifecycle(id, 'ACTIVE');
  }

  private async consumeEvents(): Promise<void> {
    const sub = this.registry.states()[0];
    if (!sub) return;
    const strategy = this.registry.getStrategy(sub.id);
    if (!strategy) return;

    const stream = this.marketStream.subscribe(strategy.subscriptions);
    for await (const event of stream) {
      this.routeEvent(event);
      this.drainMailboxes();
    }

    this.signalDone = true;
    for (const resolve of this.signalResolvers) {
      resolve({ value: undefined, done: true });
    }
    this.signalResolvers = [];
  }

  private routeEvent(event: MarketEvent): void {
    for (const [id, runtime] of this.runtimes) {
      const lifecycle = this.registry.getLifecycle(id);
      if (!lifecycle || lifecycle === 'HALTED' || lifecycle === 'UNLOADED') continue;

      switch (event.kind) {
        case 'CANDLE':
          runtime.mailbox.push({ kind: 'candle', priority: 2, event });
          break;
        case 'TICKER':
          // Conflate: replace any existing ticker for this symbol.
          const tickIdx = runtime.mailbox.findLastIndex(
            (m) => m.kind === 'ticker' && (m.event as TickerEvent).symbol === event.symbol,
          );
          if (tickIdx >= 0) {
            runtime.mailbox.splice(tickIdx, 1);
          }
          runtime.mailbox.push({ kind: 'ticker', priority: 0, event });
          break;
        case 'ORDER_BOOK_SNAPSHOT':
          const bookIdx = runtime.mailbox.findLastIndex(
            (m) => m.kind === 'book' && (m.event as OrderBookSnapshotEvent).symbol === event.symbol,
          );
          if (bookIdx >= 0) {
            runtime.mailbox.splice(bookIdx, 1);
          }
          runtime.mailbox.push({ kind: 'book', priority: 0, event });
          break;
        case 'TRADE':
          // Trades not individually dispatched to strategies in this implementation.
          break;
      }
    }
  }

  enqueueExecReport(stratId: StrategyId, report: ExecReport): void {
    const runtime = this.runtimes.get(stratId);
    if (!runtime) return;
    runtime.mailbox.push({ kind: 'exec', priority: 3, event: report });
  }

  private drainMailboxes(): void {
    for (const [id, runtime] of this.runtimes) {
      const lifecycle = this.registry.getLifecycle(id);
      if (!lifecycle || lifecycle === 'HALTED' || lifecycle === 'UNLOADED') continue;

      // Sort by descending priority before processing.
      runtime.mailbox.sort((a, b) => b.priority - a.priority);

      const items = runtime.mailbox.splice(0);
      for (const item of items) {
        this.processItem(id, runtime, item, lifecycle);
        if (this.registry.getLifecycle(id) === 'HALTED') break;
      }
    }
  }

  private processItem(
    id: StrategyId,
    runtime: StrategyRuntime,
    item: MailboxItem,
    lifecycle: StrategyState['lifecycle'],
  ): void {
    const strategy = this.registry.getStrategy(id);
    if (!strategy) return;

    const start = this.hrtimeFn();
    let signals: Signal[] = [];

    switch (item.kind) {
      case 'candle': {
        const e = item.event as CandleEvent;
        // Update history before calling handler.
        const hist = runtime.candleHistory.get(e.symbol) ?? [];
        hist.push(e);
        if (hist.length > strategy.warmup.bars + 1) hist.shift();
        runtime.candleHistory.set(e.symbol, hist);
        const view = this.buildView(runtime, e.eventTime, strategy.subscriptions.venue);
        signals = strategy.onCandle(e, view);
        break;
      }
      case 'ticker': {
        const e = item.event as TickerEvent;
        runtime.tickers.set(e.symbol, e);
        const view = this.buildView(runtime, e.eventTime, strategy.subscriptions.venue);
        signals = strategy.onTick(e, view);
        break;
      }
      case 'book': {
        const e = item.event as OrderBookSnapshotEvent;
        runtime.books.set(e.symbol, e);
        const view = this.buildView(runtime, e.eventTime, strategy.subscriptions.venue);
        signals = strategy.onOrderBook(e, view);
        break;
      }
      case 'exec': {
        const r = item.event as ExecReport;
        const view = this.buildView(runtime, r.eventTime, strategy.subscriptions.venue);
        signals = strategy.onExecReport(r, view);
        break;
      }
    }

    const elapsedNs = this.hrtimeFn() - start;

    if (elapsedNs > CPU_HARD_NS) {
      runtime.consecutiveHardBreaches += 1;
      if (runtime.consecutiveHardBreaches >= MAX_CONSECUTIVE_HARD) {
        this.registry.setLifecycle(id, 'DRAINING');
        return;
      }
    } else if (elapsedNs <= CPU_SOFT_NS) {
      runtime.consecutiveHardBreaches = 0;
    }

    // Discard signals during WARMUP; filter to risk-reducing during DRAINING.
    if (lifecycle === 'WARMUP') return;

    for (const sig of signals) {
      if (lifecycle === 'DRAINING' && !RISK_REDUCING.has(sig.kind)) continue;
      void this.signalSink.recordSignal(sig);
      this.pushSignal(sig);
    }
  }

  private pushSignal(sig: Signal): void {
    if (this.signalResolvers.length > 0) {
      const resolve = this.signalResolvers.shift()!;
      resolve({ value: sig, done: false });
    } else {
      this.signalQueue.push(sig);
    }
  }

  private buildView(runtime: StrategyRuntime, eventTime: EpochMs, venue: string): MarketView {
    const feedHealth = this.feedHealth; // captured: the view's feed() must reach the host's port
    const portfolio: StrategyPortfolioView = {
      // Phase 3: strategies are long/flat with no attributed book yet — Phase 5 wires
      // the real per-strategy sub-account. The view deliberately exposes no balances/equity.
      strategyId: strategyId(''),
      positions: new Map(),
      openOrders: [],
    };
    return {
      eventTime,
      candles(symbol: string, interval: CandleInterval, n: number): readonly CandleEvent[] {
        const hist = runtime.candleHistory.get(symbol) ?? [];
        return hist.filter((c) => c.interval === interval).slice(-n);
      },
      lastTicker: (symbol: string): TickerEvent | undefined => runtime.tickers.get(symbol),
      book: (symbol: string): OrderBookSnapshotEvent | undefined => runtime.books.get(symbol),
      feed: (sym: string, channel: string): ChannelHealth =>
        feedHealth.health(venueId(venue), symbolId(sym), channel),
      portfolio,
      random: runtime.prng,
    };
  }

  private seedFromId(id: StrategyId): number {
    // Derive a numeric seed from the strategy ID string for PRNG reproducibility.
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = (Math.imul(31, h) + id.charCodeAt(i)) >>> 0;
    }
    return h;
  }
}
