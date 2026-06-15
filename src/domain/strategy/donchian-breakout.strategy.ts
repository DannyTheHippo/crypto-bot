import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
  CandleInterval,
} from '../types/market-events';
import type { ExecReport } from '../types/exec-report';
import type { Signal } from '../types/signal';
import type { StrategyId, VenueId, SymbolId } from '../types/ids';
import { toIndicatorNumber } from '../types/money';
import type { Strategy, MarketView, StrategyInitContext } from './strategy';
import type { SubscriptionSpec } from '../types/subscription';

// Donchian channel breakout — promoted from the Phase-1 research battery (test/backtest/) as the
// best-of-breed candidate, env-selectable via ACTIVE_STRATEGY=donchian-breakout.
//
// HONEST LABEL: this is an UNVALIDATED EXPERIMENT. It did NOT clear the step-D validation gate
// (deflated Sharpe / t-stat / MinBTL / walk-forward) — see reports/nightly/long-battery-study.md — and
// in fact underperformed the EMA-cross incumbent on the backtest. It is promoted only to exercise the
// strategy-selection capability on the testnet/demo bot; EMA-cross remains the documented default
// (ACTIVE_STRATEGY unset → ema-cross), and PROMOTION.md / the live gate stay untouched. Never run live.
//
// FORM: enter long when the close breaks ABOVE the highest high of the prior `entryLookback` bars (a
// channel breakout); exit when it breaks BELOW the lowest low of the prior `exitLookback` bars. Same
// purity contract as EmaCrossStrategy: pure, synchronous, eventTime-only, no Date / Math.random /
// process / network. State toggles only on this strategy's own emitted signals so ENTER/EXIT strictly
// alternate (no pyramiding), exactly the long-only lifecycle Risk + the position/PnL math assume.
export interface DonchianBreakoutParams {
  readonly entryLookback: number; // breakout window (prior bars) for entry
  readonly exitLookback: number; // breakdown window (prior bars) for exit
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly ttlMs: number;
  readonly interval?: CandleInterval; // optional for back-compat; defaults to 1h
}

export class DonchianBreakoutStrategy implements Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { interval: CandleInterval; bars: number };

  private readonly entryLookback: number;
  private readonly exitLookback: number;
  private readonly venue: VenueId;
  private readonly symbol: SymbolId;
  private readonly ttlMs: number;
  private readonly maxLen: number;

  // Bounded rolling high/low history (length capped so a new bar always leaves a full prior window).
  private highs: number[] = [];
  private lows: number[] = [];
  private inPosition = false;
  private crossIndex = 0;

  constructor(id: StrategyId, params: DonchianBreakoutParams) {
    this.id = id;
    this.entryLookback = params.entryLookback;
    this.exitLookback = params.exitLookback;
    this.venue = params.venue;
    this.symbol = params.symbol;
    this.ttlMs = params.ttlMs;
    this.maxLen = Math.max(params.entryLookback, params.exitLookback) + 1;
    const interval = params.interval ?? '1h';
    this.subscriptions = {
      venue: params.venue,
      symbols: [params.symbol],
      channels: { candles: [interval] },
    };
    this.warmup = { interval, bars: this.maxLen };
  }

  onInit(ctx: StrategyInitContext): void {
    void ctx;
  }

  onCandle(e: CandleEvent, view: MarketView): Signal[] {
    if (!e.closed) return [];
    if (e.symbol !== this.symbol) return [];
    void view;

    this.highs.push(toIndicatorNumber(e.high));
    this.lows.push(toIndicatorNumber(e.low));
    if (this.highs.length > this.maxLen) {
      this.highs.shift();
      this.lows.shift();
    }
    if (this.highs.length < this.maxLen) return [];

    // Prior window EXCLUDES the current bar, so a new extreme is a genuine break (no lookahead).
    const priorHighs = this.highs.slice(0, -1);
    const priorLows = this.lows.slice(0, -1);
    const upper = max(priorHighs.slice(-this.entryLookback));
    const lower = min(priorLows.slice(-this.exitLookback));
    const close = toIndicatorNumber(e.close);

    const signals: Signal[] = [];
    if (!this.inPosition && close > upper) {
      this.inPosition = true;
      this.crossIndex += 1;
      signals.push(this.signal(e, 'ENTER_LONG', 'breakout'));
    } else if (this.inPosition && close < lower) {
      this.inPosition = false;
      this.crossIndex += 1;
      signals.push(this.signal(e, 'EXIT_LONG', 'breakdown'));
    }
    return signals;
  }

  private signal(e: CandleEvent, kind: 'ENTER_LONG' | 'EXIT_LONG', tag: string): Signal {
    return {
      strategyId: this.id,
      venue: this.venue,
      symbol: this.symbol,
      kind,
      strength: 1,
      refPrice: e.close,
      basedOnSeq: e.seq,
      eventTime: e.eventTime,
      ttlMs: this.ttlMs,
      dedupeKey: `${this.id}:${this.symbol}:${tag}:${this.crossIndex}:${e.eventTime}`,
      reason: `Donchian ${tag}`,
    };
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
  onStop(): void {}
}

function max(xs: readonly number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  return m;
}
function min(xs: readonly number[]): number {
  let m = Infinity;
  for (const x of xs) if (x < m) m = x;
  return m;
}
