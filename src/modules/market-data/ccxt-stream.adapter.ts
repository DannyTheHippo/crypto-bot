import { Injectable, Inject } from '@nestjs/common';
import {
  pro as ccxtPro,
  Exchange,
  type Ticker,
  type Trade,
  type OHLCV,
  type OrderBook,
} from 'ccxt';
import type { ExchangeStreamPort, RawVenueEvent, RawUserEvent } from '../../ports/exchange-stream';
import type { SubscriptionSpec } from '../../ports/market-data';
import type { VenueId, SymbolId } from '../../domain/types/ids';
import { epochMs } from '../../domain/types/ids';
import type { ClockPort } from '../../ports/clock';
import { CLOCK } from '../../ports/clock';
import type { VenueConfig } from '../../ports/app-config';
import type { ChannelHealth } from '../../domain/types/market-events';

// Staleness threshold before a stream is marked DEGRADED
const STALE_THRESHOLD_MS = 30_000;

export interface ChannelStateTracker {
  setHealth(venue: VenueId, symbol: SymbolId, channel: string, health: ChannelHealth): void;
  recordEvent(venue: VenueId, symbol: SymbolId, channel: string): void;
  checkStaleness(venue: VenueId, symbol: SymbolId, channel: string, thresholdMs: number): void;
}

/**
 * Injectable abstraction over ccxt's watch* calls.
 * A real implementation delegates to the ccxt exchange; tests inject a fake.
 * Decoupling watch from the adapter is what makes supervised-loop testing offline.
 */
export interface WatchSource {
  watchTicker(exchange: Exchange, symbol: string): Promise<Ticker>;
  watchTrades(exchange: Exchange, symbol: string): Promise<Trade[]>;
  watchOHLCV(exchange: Exchange, symbol: string, timeframe: string): Promise<OHLCV[]>;
  watchOrderBook(exchange: Exchange, symbol: string): Promise<OrderBook>;
}

export const WATCH_SOURCE = Symbol('WATCH_SOURCE');

/** Real WatchSource: delegates directly to ccxt pro watch* methods. */
@Injectable()
export class RealWatchSource implements WatchSource {
  async watchTicker(exchange: Exchange, symbol: string): Promise<Ticker> {
    return (exchange as unknown as { watchTicker(s: string): Promise<Ticker> }).watchTicker(symbol);
  }
  async watchTrades(exchange: Exchange, symbol: string): Promise<Trade[]> {
    return (exchange as unknown as { watchTrades(s: string): Promise<Trade[]> }).watchTrades(
      symbol,
    );
  }
  async watchOHLCV(exchange: Exchange, symbol: string, timeframe: string): Promise<OHLCV[]> {
    return (
      exchange as unknown as { watchOHLCV(s: string, tf: string): Promise<OHLCV[]> }
    ).watchOHLCV(symbol, timeframe);
  }
  async watchOrderBook(exchange: Exchange, symbol: string): Promise<OrderBook> {
    return (
      exchange as unknown as { watchOrderBook(s: string): Promise<OrderBook> }
    ).watchOrderBook(symbol);
  }
}

/**
 * Builds a ccxt pro exchange instance for the given venue config.
 * Applies environment mode: setSandboxMode (testnet), enableDemoTrading (demo),
 * or neither (live). Paper mode does not construct a network client; callers
 * should guard on venueConfig.environment === 'paper'.
 */
export function buildCcxtExchange(venueConfig: VenueConfig): Exchange {
  const ProExchanges = ccxtPro as unknown as Record<string, new (opts: object) => Exchange>;
  const Ctor = ProExchanges[venueConfig.id];
  if (!Ctor) {
    throw new Error(`ccxt.pro has no exchange named "${venueConfig.id}"`);
  }

  const opts: Record<string, unknown> = {
    number: String,
    enableRateLimit: true,
  };

  if (venueConfig.baseUrlOverride) {
    opts['urls'] = { api: { public: venueConfig.baseUrlOverride } };
  }

  const exchange = new Ctor(opts);

  if (venueConfig.environment === 'testnet') {
    (exchange as unknown as { setSandboxMode(v: boolean): void }).setSandboxMode(true);
  } else if (venueConfig.environment === 'demo') {
    (exchange as unknown as { enableDemoTrading(v: boolean): void }).enableDemoTrading(true);
  }
  // live: no modification; paper: caller should not invoke network methods

  return exchange;
}

/**
 * Checks that the exchange has all capabilities required for the subscription spec.
 * Throws on a missing REQUIRED capability — fail-fast at startup.
 */
function assertCapabilities(exchange: Exchange, spec: SubscriptionSpec): void {
  const has = exchange.has as Record<string, boolean | string | undefined>;

  if (spec.channels.ticker && !has['watchTicker']) {
    throw new Error(
      `Venue "${exchange.id}" does not support watchTicker (required for ticker channel)`,
    );
  }
  if (spec.channels.trades && !has['watchTrades']) {
    throw new Error(
      `Venue "${exchange.id}" does not support watchTrades (required for trades channel)`,
    );
  }
  if (spec.channels.book && !has['watchOrderBook']) {
    throw new Error(
      `Venue "${exchange.id}" does not support watchOrderBook (required for book channel)`,
    );
  }
  if (spec.channels.candles?.length && !has['watchOHLCV']) {
    throw new Error(
      `Venue "${exchange.id}" does not support watchOHLCV (required for candles channel)`,
    );
  }
}

/** Transient error: restart the watch loop iteration. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // ccxt ChecksumError is treated specially (invalidate + resubscribe), not just transient
  if (err.constructor?.name === 'ChecksumError') return false;
  const transientNames = [
    'NetworkError',
    'DDoSProtection',
    'RateLimitExceeded',
    'ExchangeNotAvailable',
    'OnMaintenance',
    'RequestTimeout',
    'BadResponse',
    'InvalidNonce',
  ];
  return transientNames.some((n) => err.constructor?.name === n || err.message.includes(n));
}

function isChecksumError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.constructor?.name === 'ChecksumError';
}

// ── CcxtExchangeStreamAdapter ────────────────────────────────────────────────

@Injectable()
export class CcxtExchangeStreamAdapter implements ExchangeStreamPort {
  private running = true;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(WATCH_SOURCE) private readonly watchSource: WatchSource,
    private readonly exchange: Exchange,
    private readonly venueId: VenueId,
    private readonly stateTracker: ChannelStateTracker,
  ) {}

  stop(): void {
    this.running = false;
  }

  /**
   * Returns an AsyncIterable of raw venue events for the subscription spec.
   * Each channel (ticker, trades, candles, book) per symbol runs in a supervised
   * for(;;) loop that catches transient errors and continues; ChecksumError
   * invalidates the local book and resubscribes on next iteration.
   */
  marketRaw(spec: SubscriptionSpec): AsyncIterable<RawVenueEvent> {
    assertCapabilities(this.exchange, spec);

    // Arrow-bound so `this` refers to the adapter inside the iterator (no this-alias).
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<RawVenueEvent> => {
        const buffer: RawVenueEvent[] = [];
        let resolveNext: ((v: IteratorResult<RawVenueEvent>) => void) | null = null;
        let done = false;

        const push = (ev: RawVenueEvent): void => {
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ value: ev, done: false });
          } else {
            buffer.push(ev);
          }
        };

        const finish = (): void => {
          done = true;
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ value: undefined, done: true });
          }
        };

        // Start supervised loops for each symbol × channel
        const loops: Promise<void>[] = [];

        for (const symbol of spec.symbols) {
          if (spec.channels.ticker) {
            loops.push(this.runTickerLoop(push, symbol));
          }
          if (spec.channels.trades) {
            loops.push(this.runTradesLoop(push, symbol));
          }
          if (spec.channels.book) {
            loops.push(this.runBookLoop(push, symbol));
          }
          for (const interval of spec.channels.candles ?? []) {
            loops.push(this.runCandleLoop(push, symbol, interval));
          }
        }

        Promise.all(loops).then(
          () => finish(),
          () => finish(),
        );

        return {
          next: (): Promise<IteratorResult<RawVenueEvent>> => {
            if (buffer.length > 0) {
              return Promise.resolve({ value: buffer.shift()!, done: false });
            }
            if (done) {
              return Promise.resolve({ value: undefined as unknown as RawVenueEvent, done: true });
            }
            return new Promise<IteratorResult<RawVenueEvent>>((res) => {
              resolveNext = res;
            });
          },
          return: (): Promise<IteratorResult<RawVenueEvent>> => {
            this.stop();
            return Promise.resolve({ value: undefined as unknown as RawVenueEvent, done: true });
          },
        };
      },
    };
  }

  // ── Supervised channel loops ─────────────────────────────────────────────

  private async runTickerLoop(push: (ev: RawVenueEvent) => void, symbol: SymbolId): Promise<void> {
    const channel = 'ticker';
    while (this.running) {
      try {
        const ticker = await this.watchSource.watchTicker(this.exchange, symbol);
        const ts = typeof ticker.timestamp === 'number' ? epochMs(ticker.timestamp) : undefined;
        push({ type: 'ticker', venue: this.venueId, symbol, timestamp: ts, raw: ticker });
        this.stateTracker.recordEvent(this.venueId, symbol, channel);
        this.scheduleStaleCheck(symbol, channel);
      } catch (err) {
        if (!this.running) break;
        await this.handleLoopError(err, symbol, channel);
      }
    }
  }

  private async runTradesLoop(push: (ev: RawVenueEvent) => void, symbol: SymbolId): Promise<void> {
    const channel = 'trade';
    while (this.running) {
      try {
        const trades = await this.watchSource.watchTrades(this.exchange, symbol);
        for (const trade of trades) {
          const ts = typeof trade.timestamp === 'number' ? epochMs(trade.timestamp) : undefined;
          push({ type: 'trade', venue: this.venueId, symbol, timestamp: ts, raw: trade });
        }
        this.stateTracker.recordEvent(this.venueId, symbol, channel);
        this.scheduleStaleCheck(symbol, channel);
      } catch (err) {
        if (!this.running) break;
        await this.handleLoopError(err, symbol, channel);
      }
    }
  }

  private async runCandleLoop(
    push: (ev: RawVenueEvent) => void,
    symbol: SymbolId,
    interval: string,
  ): Promise<void> {
    const channel = `candle:${interval}`;
    while (this.running) {
      try {
        const bars = await this.watchSource.watchOHLCV(this.exchange, symbol, interval);
        for (const bar of bars) {
          const ts = typeof bar[0] === 'number' ? epochMs(bar[0]) : undefined;
          push({ type: 'candle', venue: this.venueId, symbol, timestamp: ts, raw: bar });
        }
        this.stateTracker.recordEvent(this.venueId, symbol, channel);
        this.scheduleStaleCheck(symbol, channel);
      } catch (err) {
        if (!this.running) break;
        await this.handleLoopError(err, symbol, channel);
      }
    }
  }

  private async runBookLoop(push: (ev: RawVenueEvent) => void, symbol: SymbolId): Promise<void> {
    const channel = 'book';
    while (this.running) {
      try {
        const book = await this.watchSource.watchOrderBook(this.exchange, symbol);
        const ts = typeof book.timestamp === 'number' ? epochMs(book.timestamp) : undefined;
        push({ type: 'book', venue: this.venueId, symbol, timestamp: ts, raw: book });
        this.stateTracker.recordEvent(this.venueId, symbol, channel);
        this.scheduleStaleCheck(symbol, channel);
      } catch (err) {
        if (!this.running) break;
        await this.handleLoopError(err, symbol, channel);
      }
    }
  }

  // Single error policy for every supervised loop (one place, one set of branches):
  //   - book + ChecksumError → GAP, no backoff (ccxt dropped the book; resubscribe at once)
  //   - transient (network/rate/maintenance) → DEGRADED, backoff before retry
  //   - anything else → GAP, backoff (never tight-loop on an unknown error)
  private async handleLoopError(err: unknown, symbol: SymbolId, channel: string): Promise<void> {
    if (channel === 'book' && isChecksumError(err)) {
      this.stateTracker.setHealth(this.venueId, symbol, channel, 'GAP');
      return;
    }
    this.stateTracker.setHealth(
      this.venueId,
      symbol,
      channel,
      isTransient(err) ? 'DEGRADED' : 'GAP',
    );
    await this.backoff();
  }

  private scheduleStaleCheck(symbol: SymbolId, channel: string): void {
    setTimeout(() => {
      if (!this.running) return;
      this.stateTracker.checkStaleness(this.venueId, symbol, channel, STALE_THRESHOLD_MS);
    }, STALE_THRESHOLD_MS);
  }

  private async backoff(): Promise<void> {
    await new Promise<void>((res) => setTimeout(res, 1000));
  }

  /**
   * User-data stream (order fills, balance updates).
   * TODO(Phase 7): implement Binance WS-API userDataStream.subscribe.
   * Returns an empty async iterable that never yields — satisfies the port contract.
   */
  // An empty async generator satisfies the port; Phase 7 implements the real stream.
  async *userEvents(): AsyncIterable<RawUserEvent> {
    // Intentionally empty — Phase 7 implements private user-data streams.
  }
}
