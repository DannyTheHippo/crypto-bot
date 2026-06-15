import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
  CandleInterval,
} from '../types/market-events';
import type { ExecReport } from '../types/exec-report';
import type { Signal } from '../types/signal';
import type { StrategyId, VenueId, SymbolId } from '../types/ids';
import { emaFromNumbers } from './indicators';
import { toIndicatorNumber } from '../types/money';
import type { Strategy, MarketView, StrategyInitContext } from './strategy';
import type { SubscriptionSpec } from '../types/subscription';

export interface EmaCrossParams {
  readonly fast: number;
  readonly slow: number;
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly ttlMs: number;
  // Candle interval the cross is computed on. Optional for back-compat (defaults to 1h); the paper/
  // demo runtime configures a faster interval so crosses — and thus orders — are observable sooner.
  readonly interval?: CandleInterval;
}

export class EmaCrossStrategy implements Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { interval: CandleInterval; bars: number };

  private fast: number = 9;
  private slow: number = 21;
  private venue!: VenueId;
  private symbol!: SymbolId;
  private ttlMs: number = 30_000;

  // Incremental close-price history — appended on every closed candle.
  // Length is capped at `slow` to bound memory.
  private closes: number[] = [];
  private crossIndex = 0;

  // Tracks whether the last evaluated cross was bullish (fast > slow).
  // undefined before we have a full window.
  private lastBullish: boolean | undefined = undefined;

  constructor(id: StrategyId, params: EmaCrossParams) {
    this.id = id;
    this.fast = params.fast;
    this.slow = params.slow;
    this.venue = params.venue;
    this.symbol = params.symbol;
    this.ttlMs = params.ttlMs;
    const interval = params.interval ?? '1h';
    this.subscriptions = {
      venue: params.venue,
      symbols: [params.symbol],
      channels: { candles: [interval] },
    };
    this.warmup = { interval, bars: params.slow + 1 };
  }

  onInit(ctx: StrategyInitContext): void {
    // Params are already captured in constructor.
    // Warmup candles flow through onCandle during WARMUP so state builds naturally.
    void ctx;
  }

  onCandle(e: CandleEvent, view: MarketView): Signal[] {
    if (!e.closed) return [];
    if (e.symbol !== this.symbol) return [];

    void view;

    const closeNum = toIndicatorNumber(e.close);
    this.closes.push(closeNum);
    // Keep only what we need (slow period) so the array stays bounded.
    if (this.closes.length > this.slow + 1) {
      this.closes.shift();
    }

    if (this.closes.length < this.slow) return [];

    const fastEma = emaFromNumbers(this.closes, this.fast);
    const slowEma = emaFromNumbers(this.closes, this.slow);

    const bullish = fastEma > slowEma;

    if (this.lastBullish === undefined) {
      this.lastBullish = bullish;
      return [];
    }

    const signals: Signal[] = [];

    if (bullish && !this.lastBullish) {
      // Golden cross: fast crosses above slow.
      this.crossIndex += 1;
      const crossIdx = this.crossIndex;
      signals.push({
        strategyId: this.id,
        venue: this.venue,
        symbol: this.symbol,
        kind: 'ENTER_LONG',
        strength: 1,
        refPrice: e.close,
        basedOnSeq: e.seq,
        eventTime: e.eventTime,
        ttlMs: this.ttlMs,
        dedupeKey: `${this.id}:${this.symbol}:golden:${crossIdx}:${e.eventTime}`,
        reason: 'EMA golden cross',
      });
    } else if (!bullish && this.lastBullish) {
      // Death cross: fast crosses below slow.
      this.crossIndex += 1;
      const crossIdx = this.crossIndex;
      signals.push({
        strategyId: this.id,
        venue: this.venue,
        symbol: this.symbol,
        kind: 'EXIT_LONG',
        strength: 1,
        refPrice: e.close,
        basedOnSeq: e.seq,
        eventTime: e.eventTime,
        ttlMs: this.ttlMs,
        dedupeKey: `${this.id}:${this.symbol}:death:${crossIdx}:${e.eventTime}`,
        reason: 'EMA death cross',
      });
    }

    this.lastBullish = bullish;
    return signals;
  }

  // Candle-driven strategy: tick/book/exec handlers are intentionally inert in v1.
  onTick(e: TickerEvent, view: MarketView): Signal[] {
    void e;
    void view;
    return [];
  }

  onOrderBook(e: OrderBookSnapshotEvent, view: MarketView): Signal[] {
    void e;
    void view;
    return [];
  }

  onExecReport(r: ExecReport, view: MarketView): Signal[] {
    void r;
    void view;
    return [];
  }

  onStop(): void {
    // no cleanup needed
  }
}
