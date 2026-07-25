// Deterministic synthetic fixtures for edge-tournament unit tests — no network, no gitignored caches.
import type { DailySeries, NewsObservation, OhlcvBar, VenueFundingSeries } from '../types';
import { toBinanceUsdmSymbol, UNIVERSE_BASE } from '../constants';

const DAY_MS = 86_400_000;

export function makeDailyBars(
  startMs: number,
  days: number,
  startPrice: number,
  dailyDrift: number,
): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  let px = startPrice;
  for (let i = 0; i < days; i += 1) {
    const t = startMs + i * DAY_MS;
    const o = px;
    px = px * (1 + dailyDrift + Math.sin(i / 7) * 0.002);
    const c = px;
    bars.push([t, o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c, 1000]);
  }
  return bars;
}

export function fixtureDailyMap(
  days = 130,
  startMs = Date.parse('2024-01-01T00:00:00.000Z'),
): Map<string, DailySeries> {
  const out = new Map<string, DailySeries>();
  const drifts: Record<string, number> = {
    BTC: 0.001,
    ETH: 0.0008,
    SOL: 0.0015,
    LINK: -0.0005,
    AVAX: -0.001,
    XRP: 0.0003,
  };
  for (const base of UNIVERSE_BASE) {
    const sym = toBinanceUsdmSymbol(base);
    const bars = makeDailyBars(startMs, days, 100 + base.length, drifts[base] ?? 0.0002);
    out.set(sym, {
      symbol: sym,
      timestamps: bars.map((b) => b[0]),
      opens: bars.map((b) => b[1]),
      closes: bars.map((b) => b[4]),
    });
  }
  return out;
}

export function fixtureNews(startMs: number, days: number): NewsObservation[] {
  const rows: NewsObservation[] = [];
  for (let i = 0; i < days; i += 1) {
    rows.push({
      publishedMs: startMs + i * DAY_MS,
      toneZ: String(-3 + (i % 40) * 0.15),
    });
  }
  return rows;
}

export function fixtureFundingVenueSeries(
  venue: 'binanceusdm' | 'bybit' | 'okx',
  symbol: string,
  startMs: number,
  settlements: number,
  baseRate: string,
): VenueFundingSeries {
  const rows = [];
  for (let i = 0; i < settlements; i += 1) {
    const offset = venue === 'binanceusdm' ? '0' : venue === 'bybit' ? '0.00001' : '0.00002';
    rows.push({
      timestamp: startMs + i * 8 * 3_600_000,
      fundingRate: String(Number(baseRate) + Number(offset) + i * 0.000001),
    });
  }
  return { venue, symbol, settlements: rows };
}

export function fixtureNewsExtreme(startMs: number, days: number): NewsObservation[] {
  const rows = fixtureNews(startMs, days);
  const out = [...rows];
  out[95] = { publishedMs: startMs + 95 * DAY_MS, toneZ: '-5' };
  out[96] = { publishedMs: startMs + 96 * DAY_MS, toneZ: '5' };
  return out;
}

export function appendFutureBar(series: DailySeries, extraDays = 5): DailySeries {
  const lastTs = series.timestamps[series.timestamps.length - 1]!;
  const lastClose = series.closes[series.closes.length - 1]!;
  const timestamps = [...series.timestamps];
  const opens = [...series.opens];
  const closes = [...series.closes];
  for (let i = 1; i <= extraDays; i += 1) {
    const t = lastTs + i * DAY_MS;
    const o = lastClose * (1 + 0.001 * i);
    timestamps.push(t);
    opens.push(o);
    closes.push(o * 1.002);
  }
  return { symbol: series.symbol, timestamps, opens, closes };
}
