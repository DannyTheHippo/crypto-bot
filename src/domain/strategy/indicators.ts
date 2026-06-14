import { toIndicatorNumber } from '../types/money';
import type { Price, Qty } from '../types/money';

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
