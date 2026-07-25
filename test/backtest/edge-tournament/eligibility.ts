import { ELIGIBILITY_LOOKBACK_DAYS } from './constants';
import type { DailySeries } from './types';

/** Symbol index is eligible at bar i only after ELIGIBILITY_LOOKBACK_DAYS closed observations. */
export function eligibleAtBar(series: DailySeries, barIndex: number): boolean {
  return barIndex >= ELIGIBILITY_LOOKBACK_DAYS && barIndex < series.closes.length;
}

export function eligibleSymbolsAtBar(
  bySymbol: ReadonlyMap<string, DailySeries>,
  barIndex: number,
  timestamps: readonly number[],
): string[] {
  const ts = timestamps[barIndex];
  if (ts === undefined) return [];
  const out: string[] = [];
  for (const [sym, series] of bySymbol) {
    const idx = series.timestamps.indexOf(ts);
    if (idx >= ELIGIBILITY_LOOKBACK_DAYS) out.push(sym);
  }
  return out.sort();
}

/** Total return over lookback using closes strictly before decision bar (no lookahead). */
export function trailingReturn(
  closes: readonly number[],
  endExclusive: number,
  lookback: number,
): number | null {
  const start = endExclusive - lookback;
  if (start < 0 || endExclusive >= closes.length) return null;
  const c0 = closes[start]!;
  const c1 = closes[endExclusive]!;
  if (!(c0 > 0) || !(c1 > 0)) return null;
  return c1 / c0 - 1;
}

/** Realized vol (population std of daily log returns) over lookback ending at endExclusive-1. */
export function trailingRealizedVol(
  closes: readonly number[],
  endExclusive: number,
  lookback: number,
): number | null {
  const start = endExclusive - lookback;
  if (start <= 0 || endExclusive > closes.length) return null;
  const rets: number[] = [];
  for (let i = start + 1; i < endExclusive; i += 1) {
    const p0 = closes[i - 1]!;
    const p1 = closes[i]!;
    if (!(p0 > 0) || !(p1 > 0)) return null;
    rets.push(Math.log(p1 / p0));
  }
  if (rets.length < lookback - 1) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let v = 0;
  for (const r of rets) v += (r - mean) ** 2;
  v /= rets.length;
  const std = Math.sqrt(v);
  return std > 0 ? std : null;
}

/** OLS beta of symbol vs BTC using calendar-aligned closes ending at decisionTs (inclusive close). */
export function trailingBetaAtTs(
  series: DailySeries,
  btc: DailySeries,
  decisionTs: number,
  lookback: number,
): number | null {
  const sIdx = series.timestamps.indexOf(decisionTs);
  const bIdx = btc.timestamps.indexOf(decisionTs);
  if (sIdx < lookback || bIdx < lookback) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = lookback - 1; k >= 0; k -= 1) {
    const ts1 = series.timestamps[sIdx - k]!;
    const ts0 = series.timestamps[sIdx - k - 1];
    if (ts0 === undefined) return null;
    const bi1 = btc.timestamps.indexOf(ts1);
    const bi0 = btc.timestamps.indexOf(ts0);
    if (bi1 < 0 || bi0 < 0) return null;
    const p0 = series.closes[sIdx - k - 1]!;
    const p1 = series.closes[sIdx - k]!;
    const b0 = btc.closes[bi0]!;
    const b1 = btc.closes[bi1]!;
    if (!(p0 > 0) || !(p1 > 0) || !(b0 > 0) || !(b1 > 0)) return null;
    xs.push(Math.log(b1 / b0));
    ys.push(Math.log(p1 / p0));
  }
  if (xs.length < lookback) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    varX += dx * dx;
  }
  cov /= xs.length;
  varX /= xs.length;
  if (!(varX > 0)) return null;
  return cov / varX;
}

/** OLS beta of symbol returns vs BTC returns over lookback ending at endExclusive-1 (index-aligned). */
export function trailingBeta(
  closes: readonly number[],
  btcCloses: readonly number[],
  endExclusive: number,
  lookback: number,
): number | null {
  const start = endExclusive - lookback;
  if (start <= 0 || endExclusive > closes.length || endExclusive > btcCloses.length) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = start + 1; i < endExclusive; i += 1) {
    const p0 = closes[i - 1]!;
    const p1 = closes[i]!;
    const b0 = btcCloses[i - 1]!;
    const b1 = btcCloses[i]!;
    if (!(p0 > 0) || !(p1 > 0) || !(b0 > 0) || !(b1 > 0)) return null;
    xs.push(Math.log(b1 / b0));
    ys.push(Math.log(p1 / p0));
  }
  if (xs.length < lookback - 1) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    varX += dx * dx;
  }
  cov /= xs.length;
  varX /= xs.length;
  if (!(varX > 0)) return null;
  return cov / varX;
}
