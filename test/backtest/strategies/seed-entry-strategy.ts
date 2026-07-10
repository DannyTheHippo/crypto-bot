// Seed-entry BarStrategy — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Mirrors the deployed seed playbook's LONG-only entry EXACTLY: EMA9 > EMA21, RSI14 in (50,70), and
// the crossing/confirming close no more than 2 bars stale — plus an expected-move selectivity overlay
// (ATR14-derived expected move over the hold horizon must clear k times the round-trip fee hurdle).
// Exit is a fixed maxHoldBars cap or the opposite EMA cross; deliberately no richer exit logic — the
// diagnostic's mandate (reports/loop/edge-diagnostic-2026-07-10.md) is to keep the rule this simple.
//
// All indicator state is maintained INCREMENTALLY (O(1) amortized per bar) rather than recomputed from
// ctx.closes on every call (as RuleStrategy's EMA-cross does) — the diagnostic sweeps 52 buckets over
// series up to 70k bars, where an O(n) recompute per decide() call would be O(n^2) over a full run.
// Each incremental tracker reproduces its src/domain/indicators/indicators.ts sibling's seed-then-smooth
// shape exactly (SMA seed over the first `period` values, then one incremental update per new bar).
import type { BarStrategy, BarContext, BacktestAction } from '../strategy';

const FAST_PERIOD = 9;
const SLOW_PERIOD = 21;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const FRESHNESS_BARS = 2; // the confirming EMA cross must be this many bars old or fresher
export const ROUND_TRIP_FEE_HURDLE_BPS = 20; // 10bps taker x 2 legs — k's unit (task-fixed, not derived)

export interface SeedEntryConfig {
  readonly maxHoldBars: number;
  // Selectivity threshold: enter only when expectedMoveBps >= kMultiple * ROUND_TRIP_FEE_HURDLE_BPS.
  readonly kMultiple: number;
  readonly sizeHint?: string;
}

class IncrementalEma {
  private seedSum = 0;
  private seedCount = 0;
  private readonly k: number;
  value: number | null = null;

  constructor(private readonly period: number) {
    this.k = 2 / (period + 1);
  }

  push(close: number): void {
    if (this.value === null) {
      this.seedSum += close;
      this.seedCount++;
      if (this.seedCount === this.period) this.value = this.seedSum / this.period;
      return;
    }
    this.value = close * this.k + this.value * (1 - this.k);
  }
}

class IncrementalRsi {
  private prevClose: number | null = null;
  private seedGainSum = 0;
  private seedLossSum = 0;
  private deltaCount = 0;
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  value: number | null = null;

  constructor(private readonly period: number) {}

  push(close: number): void {
    if (this.prevClose === null) {
      this.prevClose = close;
      return;
    }
    const delta = close - this.prevClose;
    this.prevClose = close;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;

    if (this.avgGain === null || this.avgLoss === null) {
      this.seedGainSum += gain;
      this.seedLossSum += loss;
      this.deltaCount++;
      if (this.deltaCount === this.period) {
        this.avgGain = this.seedGainSum / this.period;
        this.avgLoss = this.seedLossSum / this.period;
        this.value = this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
      }
      return;
    }
    this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
    this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    this.value = this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
  }
}

class IncrementalAtr {
  private prevClose: number | null = null;
  private seedSum = 0;
  private trCount = 0;
  private avg: number | null = null;
  value: number | null = null;

  constructor(private readonly period: number) {}

  push(high: number, low: number, close: number): void {
    if (this.prevClose === null) {
      this.prevClose = close;
      return;
    }
    const tr = Math.max(
      high - low,
      Math.abs(high - this.prevClose),
      Math.abs(low - this.prevClose),
    );
    this.prevClose = close;

    if (this.avg === null) {
      this.seedSum += tr;
      this.trCount++;
      if (this.trCount === this.period) {
        this.avg = this.seedSum / this.period;
        this.value = this.avg;
      }
      return;
    }
    this.avg = (this.avg * (this.period - 1) + tr) / this.period;
    this.value = this.avg;
  }
}

export class SeedEntryStrategy implements BarStrategy {
  private readonly fastEma = new IncrementalEma(FAST_PERIOD);
  private readonly slowEma = new IncrementalEma(SLOW_PERIOD);
  private readonly rsi = new IncrementalRsi(RSI_PERIOD);
  private readonly atr = new IncrementalAtr(ATR_PERIOD);
  private barsSinceCrossUp = Infinity;
  private entryBarIndex: number | null = null;

  constructor(private readonly cfg: SeedEntryConfig) {}

  decide(ctx: BarContext): BacktestAction {
    const close = Number(ctx.closes[ctx.closes.length - 1]);
    const high = Number(ctx.highs[ctx.highs.length - 1]);
    const low = Number(ctx.lows[ctx.lows.length - 1]);

    const priorFast = this.fastEma.value;
    const priorSlow = this.slowEma.value;

    this.fastEma.push(close);
    this.slowEma.push(close);
    this.rsi.push(close);
    this.atr.push(high, low, close);

    const fast = this.fastEma.value;
    const slow = this.slowEma.value;

    const crossedUp =
      priorFast !== null && priorSlow !== null && fast !== null && slow !== null
        ? priorFast <= priorSlow && fast > slow
        : false;
    const crossedDown =
      priorFast !== null && priorSlow !== null && fast !== null && slow !== null
        ? priorFast >= priorSlow && fast < slow
        : false;

    if (crossedUp) this.barsSinceCrossUp = 0;
    else if (fast !== null && slow !== null && fast > slow) this.barsSinceCrossUp += 1;
    else this.barsSinceCrossUp = Infinity;

    const inPosition = !ctx.position.signedQty.isZero();

    if (inPosition) {
      if (
        this.entryBarIndex !== null &&
        ctx.barIndex - this.entryBarIndex >= this.cfg.maxHoldBars
      ) {
        this.entryBarIndex = null;
        return { type: 'exit', reason: 'max_hold_bars' };
      }
      if (crossedDown) {
        this.entryBarIndex = null;
        return { type: 'exit', reason: 'ema_cross_down' };
      }
      return { type: 'hold' };
    }

    this.entryBarIndex = null; // covers the unfilled-enter edge case (nextOpen null / below minNotional)
    const rsiValue = this.rsi.value;
    const atrValue = this.atr.value;
    if (fast === null || slow === null || rsiValue === null || atrValue === null) {
      return { type: 'hold' };
    }

    const bullish = fast > slow;
    const rsiInRange = rsiValue > 50 && rsiValue < 70;
    const fresh = this.barsSinceCrossUp <= FRESHNESS_BARS;
    if (!(bullish && rsiInRange && fresh)) return { type: 'hold' };

    const expectedMoveBps = (atrValue / close) * Math.sqrt(this.cfg.maxHoldBars) * 1e4;
    const hurdleBps = this.cfg.kMultiple * ROUND_TRIP_FEE_HURDLE_BPS;
    if (expectedMoveBps < hurdleBps) return { type: 'hold' };

    this.entryBarIndex = ctx.barIndex;
    return { type: 'enter', side: 'LONG', sizeHint: this.cfg.sizeHint };
  }
}
