// Short / long-short candidate battery — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Phase 3 enables shorts in the harness (ENTER_SHORT=open SELL, EXIT_SHORT=cover BUY). These candidates
// test whether the SHORT side carries an edge the long-only studies couldn't reach:
//   - ShortMeanReversion: the mirror of the closed long z-score reversion — SELL overbought spikes,
//     cover on reversion. (Does shorting transient strength pay where buying transient weakness didn't?)
//   - LongShortEma: the closed EMA-cross with the downside captured — long above the cross, FLIP to
//     short below it. (Does harvesting the down-leg rescue the edgeless long-only trend follower?)
//
// Pure, synchronous, eventTime-only (same contract as the production strategies). NOT live-deployable:
// the paper/testnet venue is spot and throws on a SELL-to-open — shorts are research-only until a
// futures/margin venue exists (deferred per the plan). The risk engine + position math already support
// shorts (Phase 3 plumbing), so these run end-to-end through the harness sizing.
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
import { toIndicatorNumber, rollingMeanStd } from './indicators';

interface Common {
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly ttlMs: number;
  readonly interval: CandleInterval;
}

function signal(
  base: { id: StrategyId; venue: VenueId; symbol: SymbolId; ttlMs: number },
  e: CandleEvent,
  kind: Signal['kind'],
  tag: string,
  idx: number,
): Signal {
  return {
    strategyId: base.id,
    venue: base.venue,
    symbol: base.symbol,
    kind,
    strength: 1,
    refPrice: e.close,
    basedOnSeq: e.seq,
    eventTime: e.eventTime,
    ttlMs: base.ttlMs,
    dedupeKey: `${base.id}:${base.symbol}:${tag}:${idx}:${e.eventTime}`,
    reason: `${tag} ${kind}`,
  };
}

// ── Short-side z-score mean reversion (mirror of the closed long version) ──────
export interface ShortMrParams extends Common {
  readonly lookback: number;
  readonly entryZ: number; // ENTER_SHORT when z >= +entryZ (overbought)
  readonly exitZ: number; // EXIT_SHORT when z <= exitZ (reverted; 0 = back to mean)
}
export class ShortMeanReversionStrategy implements Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { interval: CandleInterval; bars: number };
  private readonly p: ShortMrParams;
  private closes: number[] = [];
  private inShort = false;
  private idx = 0;

  constructor(id: StrategyId, p: ShortMrParams) {
    this.id = id;
    this.p = p;
    this.subscriptions = {
      venue: p.venue,
      symbols: [p.symbol],
      channels: { candles: [p.interval] },
    };
    this.warmup = { interval: p.interval, bars: p.lookback + 1 };
  }
  onInit(ctx: StrategyInitContext): void {
    void ctx;
  }
  onCandle(e: CandleEvent, view: MarketView): Signal[] {
    if (!e.closed || e.symbol !== this.p.symbol) return [];
    void view;
    this.closes.push(toIndicatorNumber(e.close));
    if (this.closes.length > this.p.lookback) this.closes.shift();
    if (this.closes.length < this.p.lookback) return [];
    const { mean, std } = rollingMeanStd(this.closes, this.p.lookback);
    if (!(std > 0)) return [];
    const z = (this.closes[this.closes.length - 1]! - mean) / std;
    if (!this.inShort && z >= this.p.entryZ) {
      this.inShort = true;
      this.idx += 1;
      return [signal(this, e, 'ENTER_SHORT', 'short-mr-enter', this.idx)];
    }
    if (this.inShort && z <= this.p.exitZ) {
      this.inShort = false;
      this.idx += 1;
      return [signal(this, e, 'EXIT_SHORT', 'short-mr-exit', this.idx)];
    }
    return [];
  }
  onTick(): Signal[] {
    return [];
  }
  onOrderBook(): Signal[] {
    return [];
  }
  onExecReport(): Signal[] {
    return [];
  }
  onStop(): void {}
}

// ── Long/short EMA cross (the closed trend follower, downside captured) ────────
export interface LongShortEmaParams extends Common {
  readonly fast: number;
  readonly slow: number;
}
export class LongShortEmaStrategy implements Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { interval: CandleInterval; bars: number };
  private readonly p: LongShortEmaParams;
  private closes: number[] = [];
  private lastBullish: boolean | undefined = undefined;
  private state: 'flat' | 'long' | 'short' = 'flat';
  private idx = 0;

  constructor(id: StrategyId, p: LongShortEmaParams) {
    this.id = id;
    this.p = p;
    this.subscriptions = {
      venue: p.venue,
      symbols: [p.symbol],
      channels: { candles: [p.interval] },
    };
    this.warmup = { interval: p.interval, bars: p.slow + 1 };
  }
  onInit(ctx: StrategyInitContext): void {
    void ctx;
  }
  onCandle(e: CandleEvent, view: MarketView): Signal[] {
    if (!e.closed || e.symbol !== this.p.symbol) return [];
    void view;
    this.closes.push(toIndicatorNumber(e.close));
    if (this.closes.length > this.p.slow + 1) this.closes.shift();
    if (this.closes.length < this.p.slow) return [];
    const bullish =
      emaFromNumbers(this.closes, this.p.fast) > emaFromNumbers(this.closes, this.p.slow);
    if (this.lastBullish === undefined) {
      this.lastBullish = bullish;
      return [];
    }
    const out: Signal[] = [];
    if (bullish && !this.lastBullish) {
      // Golden cross → reach LONG: cover any short first, then open long.
      if (this.state === 'short') {
        this.idx += 1;
        out.push(signal(this, e, 'EXIT_SHORT', 'ls-cover', this.idx));
      }
      this.idx += 1;
      out.push(signal(this, e, 'ENTER_LONG', 'ls-long', this.idx));
      this.state = 'long';
    } else if (!bullish && this.lastBullish) {
      // Death cross → reach SHORT: exit any long first, then open short.
      if (this.state === 'long') {
        this.idx += 1;
        out.push(signal(this, e, 'EXIT_LONG', 'ls-exit', this.idx));
      }
      this.idx += 1;
      out.push(signal(this, e, 'ENTER_SHORT', 'ls-short', this.idx));
      this.state = 'short';
    }
    this.lastBullish = bullish;
    return out;
  }
  onTick(): Signal[] {
    return [];
  }
  onOrderBook(): Signal[] {
    return [];
  }
  onExecReport(): Signal[] {
    return [];
  }
  onStop(): void {}
}
