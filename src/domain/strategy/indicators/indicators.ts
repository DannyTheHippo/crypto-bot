import { toIndicatorNumber } from '../../common/types/money';
import type { Price, Qty } from '../../common/types/money';

// ── EMA / SMA ─────────────────────────────────────────────────────────────────
//
// Decimal→number conversion is the explicit indicator boundary; values remain
// plain numbers throughout. They are never re-branded as Price/Qty.

export function smaFromNumbers(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Seed EMA using SMA over the first `period` values, then apply EMA multiplier.
// Returns NaN when the series is shorter than `period`.
export function emaFromNumbers(values: readonly number[], period: number): number {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let ema = smaFromNumbers(values.slice(0, period));
  for (let i = period; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
  }
  return ema;
}

// Convenience wrappers for Price-typed series: crosses the Decimal→number boundary
// once per call via toIndicatorNumber, keeping all indicator math in plain numbers.

export function emaFromPrices(prices: readonly Price[], period: number): number {
  return emaFromNumbers(
    prices.map((p) => toIndicatorNumber(p)),
    period,
  );
}

export function emaFromQtys(qtys: readonly Qty[], period: number): number {
  return emaFromNumbers(
    qtys.map((q) => toIndicatorNumber(q)),
    period,
  );
}

// ── RSI ───────────────────────────────────────────────────────────────────────

// Wilder's RSI. Seed avg gain/loss with a simple mean over the first `period`
// deltas, then Wilder-smooth the rest. Needs at least period+1 closes.
export function rsiFromNumbers(closes: readonly number[], period: number): number {
  if (closes.length < period + 1) return NaN;
  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) deltas.push(closes[i]! - closes[i - 1]!);

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i]!;
    if (d > 0) gainSum += d;
    else lossSum += -d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }

  if (avgLoss === 0) return 100; // guard division by zero: all-gain series
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── ATR ───────────────────────────────────────────────────────────────────────

// Wilder's ATR. True range accounts for gaps against the prior close; seed with
// a simple mean over the first `period` true ranges, then Wilder-smooth the rest.
export function atrFromNumbers(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period: number,
): number {
  if (highs.length !== lows.length || lows.length !== closes.length) return NaN;
  const n = highs.length;
  if (n < period + 1) return NaN;

  const trueRanges: number[] = [];
  for (let i = 1; i < n; i++) {
    const high = highs[i]!;
    const low = lows[i]!;
    const prevClose = closes[i - 1]!;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trueRanges[i]!;
  let atr = sum / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
  }
  return atr;
}

// ── Percent change ────────────────────────────────────────────────────────────

export function pctChange(values: readonly number[], lookback: number): number {
  if (values.length < lookback + 1) return NaN;
  const ref = values[values.length - 1 - lookback]!;
  if (ref === 0) return NaN; // guard division by zero
  const last = values[values.length - 1]!;
  return (last / ref - 1) * 100;
}
