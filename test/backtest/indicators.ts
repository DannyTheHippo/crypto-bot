// Research indicator library — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Pure number functions for the long-directional battery (Phase 1). Decimal→number crosses the same
// explicit boundary the production indicators use (toIndicatorNumber); values stay plain numbers and
// are never re-branded as Price/Qty. Each function recomputes from the passed window — strategies cap
// their rolling history at the lookback so the per-candle cost stays O(window). All return NaN until
// enough bars are available (callers gate on Number.isNaN, mirroring emaFromNumbers).
//
// If any candidate built on these clears the step-D gate and is promoted to src/domain/strategy/, the
// indicator it uses moves with it into src/domain/strategy/indicators.ts (the production indicator
// home) — these are deliberately written to be portable verbatim.
import { toIndicatorNumber } from '../../src/domain/common/types/money';
import type { Price } from '../../src/domain/common/types/money';

export { toIndicatorNumber };

export function pricesToNumbers(prices: readonly Price[]): number[] {
  return prices.map((p) => toIndicatorNumber(p));
}

export function sma(values: readonly number[], period: number): number {
  if (values.length < period) return NaN;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!;
  return sum / period;
}

// Population mean + std over the trailing `period` values (matches MeanReversionStrategy's window math).
export function rollingMeanStd(
  values: readonly number[],
  period: number,
): { mean: number; std: number } {
  if (values.length < period) return { mean: NaN, std: NaN };
  const w = values.slice(values.length - period);
  let sum = 0;
  for (const v of w) sum += v;
  const mean = sum / period;
  let sq = 0;
  for (const v of w) sq += (v - mean) * (v - mean);
  return { mean, std: Math.sqrt(sq / period) };
}

export function zscore(values: readonly number[], period: number): number {
  const { mean, std } = rollingMeanStd(values, period);
  if (!(std > 0)) return NaN;
  return (values[values.length - 1]! - mean) / std;
}

// Bollinger bands: SMA mid ± k·(population std) over `period`.
export function bollinger(
  values: readonly number[],
  period: number,
  k: number,
): { mid: number; upper: number; lower: number } {
  const { mean, std } = rollingMeanStd(values, period);
  if (Number.isNaN(mean)) return { mid: NaN, upper: NaN, lower: NaN };
  return { mid: mean, upper: mean + k * std, lower: mean - k * std };
}

// Donchian channel over the trailing `period` bars of the PASSED window (the caller decides whether to
// include the current bar; the breakout strategy passes the PRIOR bars so a new high is a true break).
export function donchian(
  highs: readonly number[],
  lows: readonly number[],
  period: number,
): { upper: number; lower: number } {
  if (highs.length < period || lows.length < period) return { upper: NaN, lower: NaN };
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = highs.length - period; i < highs.length; i++) if (highs[i]! > hi) hi = highs[i]!;
  for (let i = lows.length - period; i < lows.length; i++) if (lows[i]! < lo) lo = lows[i]!;
  return { upper: hi, lower: lo };
}

// Wilder's RSI over `values` (needs period+1 points). 100 when there are no down-moves in the window.
export function rsi(values: readonly number[], period: number): number {
  if (values.length < period + 1) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

// Wilder's ATR over parallel highs/lows/closes (needs period+1 points).
export function atr(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period: number,
): number {
  const n = highs.length;
  if (n < period + 1 || lows.length !== n || closes.length !== n) return NaN;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(highs[i]!, lows[i]!, closes[i - 1]!);
  let a = sum / period;
  for (let i = period + 1; i < n; i++) {
    a = (a * (period - 1) + trueRange(highs[i]!, lows[i]!, closes[i - 1]!)) / period;
  }
  return a;
}

// Wilder's ADX (+DI / −DI / ADX) over parallel highs/lows/closes. Needs ~2·period+1 bars (one period
// to seed the DI smoothing, a second to average DX into ADX). Returns NaN ADX until then.
export function adx(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period: number,
): { adx: number; plusDI: number; minusDI: number } {
  const n = highs.length;
  const nan = { adx: NaN, plusDI: NaN, minusDI: NaN };
  if (n < period + 1 || lows.length !== n || closes.length !== n) return nan;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i]! - highs[i - 1]!;
    const down = lows[i - 1]! - lows[i]!;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
    trs.push(trueRange(highs[i]!, lows[i]!, closes[i - 1]!));
  }
  if (trs.length < period) return nan;

  // Wilder running sums seeded over the first `period` deltas.
  let trS = 0;
  let pdmS = 0;
  let mdmS = 0;
  for (let i = 0; i < period; i++) {
    trS += trs[i]!;
    pdmS += plusDMs[i]!;
    mdmS += minusDMs[i]!;
  }
  const dxs: number[] = [];
  let plusDI = 0;
  let minusDI = 0;
  const pushDX = (): void => {
    plusDI = trS > 0 ? (100 * pdmS) / trS : 0;
    minusDI = trS > 0 ? (100 * mdmS) / trS : 0;
    const s = plusDI + minusDI;
    dxs.push(s > 0 ? (100 * Math.abs(plusDI - minusDI)) / s : 0);
  };
  pushDX();
  for (let i = period; i < trs.length; i++) {
    trS = trS - trS / period + trs[i]!;
    pdmS = pdmS - pdmS / period + plusDMs[i]!;
    mdmS = mdmS - mdmS / period + minusDMs[i]!;
    pushDX();
  }
  if (dxs.length < period) return { adx: NaN, plusDI, minusDI };
  let adxVal = 0;
  for (let i = 0; i < period; i++) adxVal += dxs[i]!;
  adxVal /= period;
  for (let i = period; i < dxs.length; i++) adxVal = (adxVal * (period - 1) + dxs[i]!) / period;
  return { adx: adxVal, plusDI, minusDI };
}

// Simple N-bar momentum: trailing return close[t]/close[t−period] − 1 (NaN until period+1 bars).
export function momentum(values: readonly number[], period: number): number {
  if (values.length < period + 1) return NaN;
  const last = values[values.length - 1]!;
  const prev = values[values.length - 1 - period]!;
  if (!(prev > 0)) return NaN;
  return last / prev - 1;
}
