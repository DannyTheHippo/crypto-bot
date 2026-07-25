import type { DailySeries, NewsObservation, OhlcvBar } from './types';

export function ohlcvToDailySeries(symbol: string, bars: readonly OhlcvBar[]): DailySeries {
  const timestamps: number[] = [];
  const opens: number[] = [];
  const closes: number[] = [];
  for (const b of bars) {
    timestamps.push(b[0]);
    opens.push(b[1]);
    closes.push(b[4]);
  }
  return { symbol, timestamps, opens, closes };
}

/** Intersect timestamps present in every series; ascending. */
export function alignDailyTimestamps(bySymbol: ReadonlyMap<string, DailySeries>): number[] {
  const symbols = [...bySymbol.keys()].sort();
  if (symbols.length === 0) return [];
  let common = new Set(bySymbol.get(symbols[0]!)!.timestamps);
  for (let i = 1; i < symbols.length; i += 1) {
    const ts = bySymbol.get(symbols[i]!)!.timestamps;
    const next = new Set<number>();
    for (const t of ts) if (common.has(t)) next.add(t);
    common = next;
  }
  return [...common].sort((a, b) => a - b);
}

/**
 * Trading calendar for dynamic eligibility: use the anchor series (BTC) timestamps.
 * Missing history on other symbols makes them ineligible that day — never truncates the axis.
 */
export function tradingCalendarTimestamps(
  bySymbol: ReadonlyMap<string, DailySeries>,
  anchorSymbol = 'BTC/USDT:USDT',
): number[] {
  const anchor = bySymbol.get(anchorSymbol);
  if (!anchor) return [];
  return [...anchor.timestamps].sort((a, b) => a - b);
}

export function sliceAligned(
  bySymbol: ReadonlyMap<string, DailySeries>,
  timestamps: readonly number[],
): Map<string, DailySeries> {
  const out = new Map<string, DailySeries>();
  for (const [sym, series] of bySymbol) {
    const idxByTs = new Map(series.timestamps.map((t, i) => [t, i] as const));
    const tsOut: number[] = [];
    const oOut: number[] = [];
    const cOut: number[] = [];
    for (const t of timestamps) {
      const i = idxByTs.get(t);
      if (i === undefined) break;
      tsOut.push(t);
      oOut.push(series.opens[i]!);
      cOut.push(series.closes[i]!);
    }
    out.set(sym, { symbol: sym, timestamps: tsOut, opens: oOut, closes: cOut });
  }
  return out;
}

/** Strict backward join: latest news observation with publishedMs <= decisionMs. */
export function newsToneAt(news: readonly NewsObservation[], decisionMs: number): string | null {
  let best: NewsObservation | null = null;
  for (const n of news) {
    if (n.publishedMs <= decisionMs && (!best || n.publishedMs >= best.publishedMs)) best = n;
  }
  return best?.toneZ ?? null;
}

/** Rolling z-score of tone using observations strictly before decision day (no lookahead). */
export function rollingNewsZ(
  news: readonly NewsObservation[],
  decisionMs: number,
  lookbackDays: number,
): number | null {
  const windowStart = decisionMs - lookbackDays * 86_400_000;
  const values: number[] = [];
  for (const n of news) {
    if (n.publishedMs < decisionMs && n.publishedMs >= windowStart) {
      values.push(Number(n.toneZ));
    }
  }
  if (values.length < lookbackDays / 3) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let v = 0;
  for (const x of values) v += (x - mean) ** 2;
  v /= values.length;
  const std = Math.sqrt(v);
  if (!(std > 0)) return null;
  const tone = newsToneAt(news, decisionMs);
  if (tone === null) return null;
  return (Number(tone) - mean) / std;
}

/** Decision at bar t uses closes/opens through t; fill at open[t+1]. */
export function assertNoSameBarFill(decisionIndex: number, fillIndex: number): void {
  if (fillIndex <= decisionIndex) {
    throw new Error(`lookahead: fillIndex ${fillIndex} must follow decisionIndex ${decisionIndex}`);
  }
}
