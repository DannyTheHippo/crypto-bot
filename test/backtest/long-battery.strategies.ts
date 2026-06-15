// Long-directional candidate battery — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// PRE-REGISTERED set of genuinely-different long-only edge hypotheses (declared BEFORE seeing results;
// see long-battery.study.spec.ts for the grids and trial accounting). Each is a real Strategy: pure,
// synchronous, eventTime-only, no Date / Math.random / process / network — identical purity contract
// to EmaCrossStrategy and MeanReversionStrategy, so a survivor moves verbatim to src/domain/strategy/.
//
// All four reuse a small state-machine base (LongCandleStrategy) that mirrors the ENTER/EXIT
// alternation discipline of EmaCrossStrategy.lastBullish / MeanReversionStrategy.inPosition: a
// candidate's signal() returns its raw 'enter' | 'exit' intent and the base gates it by position state
// so ENTER/EXIT strictly alternate (no pyramiding, no double-exit), exactly the lifecycle the harness
// sizing and the long-only position/PnL math assume.
import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
  CandleInterval,
} from '../../src/domain/types/market-events';
import type { ExecReport } from '../../src/domain/types/exec-report';
import type { Signal } from '../../src/domain/types/signal';
import type { StrategyId, VenueId, SymbolId } from '../../src/domain/types/ids';
import type { Strategy, MarketView, StrategyInitContext } from '../../src/domain/strategy/strategy';
import type { SubscriptionSpec } from '../../src/domain/types/subscription';
import { emaFromNumbers } from '../../src/domain/strategy/indicators';
import { toIndicatorNumber, sma, rollingMeanStd, donchian, adx, momentum } from './indicators';

export interface CommonParams {
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly ttlMs: number;
  readonly interval: CandleInterval;
}

type Intent = 'enter' | 'exit' | null;

abstract class LongCandleStrategy implements Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { interval: CandleInterval; bars: number };

  protected readonly venue: VenueId;
  protected readonly symbol: SymbolId;
  protected readonly ttlMs: number;

  protected closes: number[] = [];
  protected highs: number[] = [];
  protected lows: number[] = [];
  private readonly maxHist: number;
  private inPosition = false;
  private crossIndex = 0;

  protected constructor(id: StrategyId, p: CommonParams, warmupBars: number, maxHist: number) {
    this.id = id;
    this.venue = p.venue;
    this.symbol = p.symbol;
    this.ttlMs = p.ttlMs;
    this.maxHist = maxHist;
    this.subscriptions = {
      venue: p.venue,
      symbols: [p.symbol],
      channels: { candles: [p.interval] },
    };
    this.warmup = { interval: p.interval, bars: warmupBars };
  }

  protected abstract readonly tag: string; // dedupeKey discriminator
  protected abstract decide(): Intent; // raw signal on the current bounded window

  onInit(ctx: StrategyInitContext): void {
    void ctx;
  }

  onCandle(e: CandleEvent, view: MarketView): Signal[] {
    if (!e.closed) return [];
    if (e.symbol !== this.symbol) return [];
    void view;

    this.closes.push(toIndicatorNumber(e.close));
    this.highs.push(toIndicatorNumber(e.high));
    this.lows.push(toIndicatorNumber(e.low));
    if (this.closes.length > this.maxHist) {
      this.closes.shift();
      this.highs.shift();
      this.lows.shift();
    }

    const intent = this.decide();
    if (intent === 'enter' && !this.inPosition) {
      this.inPosition = true;
      this.crossIndex += 1;
      return [this.signal(e, 'ENTER_LONG')];
    }
    if (intent === 'exit' && this.inPosition) {
      this.inPosition = false;
      this.crossIndex += 1;
      return [this.signal(e, 'EXIT_LONG')];
    }
    return [];
  }

  private signal(e: CandleEvent, kind: 'ENTER_LONG' | 'EXIT_LONG'): Signal {
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
      dedupeKey: `${this.id}:${this.symbol}:${this.tag}:${this.crossIndex}:${e.eventTime}`,
      reason: `${this.tag} ${kind}`,
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

// ── 1. Donchian channel breakout ─────────────────────────────────────────────
// Enter long when the close breaks ABOVE the highest high of the prior `entryLookback` bars; exit when
// it breaks BELOW the lowest low of the prior `exitLookback` bars. The classic turtle breakout — a
// pure price-channel edge, no moving average (genuinely different from EMA-cross).
export interface DonchianParams extends CommonParams {
  readonly entryLookback: number;
  readonly exitLookback: number;
}
export class DonchianBreakoutStrategy extends LongCandleStrategy {
  protected readonly tag = 'donchian';
  private readonly entryLookback: number;
  private readonly exitLookback: number;
  constructor(id: StrategyId, p: DonchianParams) {
    super(
      id,
      p,
      Math.max(p.entryLookback, p.exitLookback) + 1,
      Math.max(p.entryLookback, p.exitLookback) + 2,
    );
    this.entryLookback = p.entryLookback;
    this.exitLookback = p.exitLookback;
  }
  protected decide(): Intent {
    const need = Math.max(this.entryLookback, this.exitLookback) + 1;
    if (this.closes.length < need) return null;
    const priorHighs = this.highs.slice(0, -1); // exclude current bar so a new high is a true break
    const priorLows = this.lows.slice(0, -1);
    const close = this.closes[this.closes.length - 1]!;
    const up = donchian(priorHighs, priorLows, this.entryLookback).upper;
    const lo = donchian(priorHighs, priorLows, this.exitLookback).lower;
    if (close > up) return 'enter';
    if (close < lo) return 'exit';
    return null;
  }
}

// ── 2. Dual-timeframe momentum ───────────────────────────────────────────────
// Trend filter (slow SMA) + entry trigger (N-bar momentum). Enter when price is above the slow SMA
// (uptrend) AND trailing momentum is positive past a threshold; exit when the trend breaks (price below
// SMA) or momentum turns negative. Two horizons gate one another — distinct from a single EMA cross.
export interface DualMomentumParams extends CommonParams {
  readonly momLookback: number;
  readonly trendLen: number;
  readonly momThreshold: number; // fixed at 0 in the grid (any positive momentum) — not a tuned knob
}
export class DualMomentumStrategy extends LongCandleStrategy {
  protected readonly tag = 'dualmom';
  private readonly momLookback: number;
  private readonly trendLen: number;
  private readonly momThreshold: number;
  constructor(id: StrategyId, p: DualMomentumParams) {
    super(id, p, Math.max(p.momLookback, p.trendLen) + 1, Math.max(p.momLookback, p.trendLen) + 2);
    this.momLookback = p.momLookback;
    this.trendLen = p.trendLen;
    this.momThreshold = p.momThreshold;
  }
  protected decide(): Intent {
    if (this.closes.length < Math.max(this.momLookback, this.trendLen) + 1) return null;
    const close = this.closes[this.closes.length - 1]!;
    const trend = sma(this.closes, this.trendLen);
    const mom = momentum(this.closes, this.momLookback);
    if (Number.isNaN(trend) || Number.isNaN(mom)) return null;
    const trendUp = close > trend;
    if (trendUp && mom > this.momThreshold) return 'enter';
    if (!trendUp || mom < 0) return 'exit';
    return null;
  }
}

// ── 3. Volatility-regime-gated trend ─────────────────────────────────────────
// EMA-cross trend core, but entries are GATED to a tolerable volatility regime (coefficient of
// variation below a ceiling) to dodge high-vol whipsaw. NOTE: the harness sizes at a fixed notional and
// ignores signal.strength, so this tests a vol-REGIME GATE, not inverse-volatility position SIZING —
// the literal "vol-target sizing" needs per-signal sizing the harness deliberately does not model. Exit
// on trend reversal regardless of vol.
export interface VolRegimeParams extends CommonParams {
  readonly fast: number;
  readonly slow: number;
  readonly volLookback: number;
  readonly volMaxPct: number; // enter only when trailing CoV% <= this ceiling
}
export class VolRegimeTrendStrategy extends LongCandleStrategy {
  protected readonly tag = 'volregime';
  private readonly fast: number;
  private readonly slow: number;
  private readonly volLookback: number;
  private readonly volMaxPct: number;
  constructor(id: StrategyId, p: VolRegimeParams) {
    super(id, p, Math.max(p.slow, p.volLookback) + 1, Math.max(p.slow, p.volLookback) + 2);
    this.fast = p.fast;
    this.slow = p.slow;
    this.volLookback = p.volLookback;
    this.volMaxPct = p.volMaxPct;
  }
  protected decide(): Intent {
    if (this.closes.length < this.slow) return null;
    const bullish = emaFromNumbers(this.closes, this.fast) > emaFromNumbers(this.closes, this.slow);
    if (!bullish) return 'exit';
    const { mean, std } = rollingMeanStd(this.closes, this.volLookback);
    if (Number.isNaN(mean) || !(mean > 0)) return null;
    const covPct = (std / mean) * 100;
    if (covPct <= this.volMaxPct) return 'enter';
    return null;
  }
}

// ── 4. ADX-regime-filtered trend ─────────────────────────────────────────────
// EMA-cross trend core, but entries require a TRENDING regime (Wilder ADX >= adxMin) — the hypothesis
// that the (edgeless) trend signal only pays inside genuine trends. Exit on trend reversal regardless
// of ADX.
export interface AdxRegimeParams extends CommonParams {
  readonly fast: number;
  readonly slow: number;
  readonly adxPeriod: number;
  readonly adxMin: number;
}
export class AdxRegimeTrendStrategy extends LongCandleStrategy {
  protected readonly tag = 'adxregime';
  private readonly fast: number;
  private readonly slow: number;
  private readonly adxPeriod: number;
  private readonly adxMin: number;
  constructor(id: StrategyId, p: AdxRegimeParams) {
    super(id, p, Math.max(p.slow, 2 * p.adxPeriod) + 1, Math.max(p.slow, 2 * p.adxPeriod) + 2);
    this.fast = p.fast;
    this.slow = p.slow;
    this.adxPeriod = p.adxPeriod;
    this.adxMin = p.adxMin;
  }
  protected decide(): Intent {
    if (this.closes.length < this.slow) return null;
    const bullish = emaFromNumbers(this.closes, this.fast) > emaFromNumbers(this.closes, this.slow);
    if (!bullish) return 'exit';
    const { adx: adxVal } = adx(this.highs, this.lows, this.closes, this.adxPeriod);
    if (Number.isNaN(adxVal)) return null;
    if (adxVal >= this.adxMin) return 'enter';
    return null;
  }
}
