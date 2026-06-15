// Short-horizon mean-reversion strategy — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// HYPOTHESIS (rung 2, a genuinely different edge class from the closed EMA-cross trend-follower):
// on short horizons, BTC/USDT price moves driven by transient liquidity demand (a burst of market
// orders sweeping the book) tend to PARTIALLY REVERT as liquidity providers are compensated — the
// "overreaction / liquidity-provision" premium. A trend-follower (EMA-cross) buys strength and was
// proven edgeless; the complementary bet is to buy transient WEAKNESS and exit on reversion.
//
// FORM: z-score reversion. z = (close - mean) / stddev over a rolling `lookback` window.
//   - ENTER_LONG when flat and z <= -entryZ   (price entryZ std-devs BELOW the mean — oversold)
//   - EXIT_LONG  when long and z >= exitZ      (reverted up to/through the mean)
// A binary armed/flat state machine yields clean ENTER/EXIT alternation (enter-when-flat), exactly
// the lifecycle the long-only position/PnL code and the harness sizing assume — and the same
// transition-emission discipline EmaCrossStrategy uses with `lastBullish`.
//
// PURITY: implements the real Strategy interface — pure, synchronous, eventTime-only, no Date /
// Math.random / process / network. If this hypothesis were ever to clear the step-D validation
// standard, this class moves verbatim to src/domain/strategy/; nothing here is reimplemented
// accounting (PnL settles through the real applyFillToPosition via the harness).
import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
  CandleInterval,
} from '../../src/domain/types/market-events';
import type { ExecReport } from '../../src/domain/types/exec-report';
import type { Signal } from '../../src/domain/types/signal';
import type { StrategyId, VenueId, SymbolId } from '../../src/domain/types/ids';
import { toIndicatorNumber } from '../../src/domain/types/money';
import type { Strategy, MarketView, StrategyInitContext } from '../../src/domain/strategy/strategy';
import type { SubscriptionSpec } from '../../src/domain/types/subscription';

export interface MeanReversionParams {
  readonly lookback: number; // rolling window for mean + stddev
  readonly entryZ: number; // enter long when z <= -entryZ
  readonly exitZ: number; // exit long when z >= exitZ (0 = revert to mean)
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly ttlMs: number;
  readonly interval: CandleInterval;
}

export class MeanReversionStrategy implements Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { interval: CandleInterval; bars: number };

  private readonly lookback: number;
  private readonly entryZ: number;
  private readonly exitZ: number;
  private readonly venue: VenueId;
  private readonly symbol: SymbolId;
  private readonly ttlMs: number;

  // Bounded rolling close history (length capped at `lookback`).
  private closes: number[] = [];
  // Intended position state — toggled only on this strategy's own emitted signals, so ENTER/EXIT
  // strictly alternate (no pyramiding, no double-exit). Mirrors EmaCrossStrategy's lastBullish gate.
  private inPosition = false;
  private crossIndex = 0;

  constructor(id: StrategyId, params: MeanReversionParams) {
    this.id = id;
    this.lookback = params.lookback;
    this.entryZ = params.entryZ;
    this.exitZ = params.exitZ;
    this.venue = params.venue;
    this.symbol = params.symbol;
    this.ttlMs = params.ttlMs;
    this.subscriptions = {
      venue: params.venue,
      symbols: [params.symbol],
      channels: { candles: [params.interval] },
    };
    this.warmup = { interval: params.interval, bars: params.lookback + 1 };
  }

  onInit(ctx: StrategyInitContext): void {
    void ctx; // params captured in constructor; warmup candles flow through onCandle
  }

  onCandle(e: CandleEvent, view: MarketView): Signal[] {
    if (!e.closed) return [];
    if (e.symbol !== this.symbol) return [];
    void view;

    const closeNum = toIndicatorNumber(e.close);
    this.closes.push(closeNum);
    if (this.closes.length > this.lookback) this.closes.shift();

    // Need a full window to compute a stable mean/stddev.
    if (this.closes.length < this.lookback) return [];

    let sum = 0;
    for (const c of this.closes) sum += c;
    const mean = sum / this.closes.length;
    let sq = 0;
    for (const c of this.closes) sq += (c - mean) * (c - mean);
    const stddev = Math.sqrt(sq / this.closes.length); // population stddev
    if (!(stddev > 0)) return []; // flat window — no dispersion, no signal (guards div-by-zero)

    const z = (closeNum - mean) / stddev;
    const signals: Signal[] = [];

    if (!this.inPosition && z <= -this.entryZ) {
      this.inPosition = true;
      this.crossIndex += 1;
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
        dedupeKey: `${this.id}:${this.symbol}:mr-enter:${this.crossIndex}:${e.eventTime}`,
        reason: 'mean-reversion oversold entry',
      });
    } else if (this.inPosition && z >= this.exitZ) {
      this.inPosition = false;
      this.crossIndex += 1;
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
        dedupeKey: `${this.id}:${this.symbol}:mr-exit:${this.crossIndex}:${e.eventTime}`,
        reason: 'mean-reversion reverted exit',
      });
    }

    return signals;
  }

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
