// Strategy families for the multi-strategy sweep (2026-07-12). Each family is a pure function
// bars → positions[], where positions[t] ∈ {-1,0,+1} is the desired position AFTER observing bar t's
// CLOSE (executed at bar t+1's open by the engine — no lookahead). A `dir` of 'ls' allows shorts
// (-1); 'long' clamps shorts to flat (max(0,·)), the spot-lane-legal variant. This is where the
// owner's "revisit shorts" happens: every trend/momentum family is run in BOTH modes so the value of
// the short leg is measured directly rather than assumed dead from the retired seed rule.

import { ema, rsi, atr, rollingMax, rollingMin, sma, stddev } from './engine.mjs';

const clampLong = (positions, dir) =>
  dir === 'long' ? positions.map((p) => (p === null ? null : Math.max(0, p))) : positions;

// Time-series momentum: sign of the trailing k-bar return. The single best-evidenced systematic
// crypto edge in the literature (web:crypto-edges rank 1). Stateless.
export function tsmom(bars, { lookback }, dir) {
  const c = bars.map((b) => b.c);
  const pos = c.map((_, t) => {
    if (t < lookback) return null;
    const r = c[t] / c[t - lookback] - 1;
    return r > 0 ? 1 : r < 0 ? -1 : 0;
  });
  return clampLong(pos, dir);
}

// Donchian channel breakout: long on a close above the trailing n-bar high, short/flat on a close
// below the trailing n-bar low; hold between. Classic trend-following.
export function donchian(bars, { n }, dir) {
  const c = bars.map((b) => b.c);
  const hi = rollingMax(
    bars.map((b) => b.h),
    n,
  );
  const lo = rollingMin(
    bars.map((b) => b.l),
    n,
  );
  const pos = new Array(bars.length).fill(null);
  let cur = 0;
  for (let t = 0; t < bars.length; t += 1) {
    if (hi[t] === null || lo[t] === null) {
      pos[t] = null;
      continue;
    }
    if (c[t] > hi[t]) cur = 1;
    else if (c[t] < lo[t]) cur = -1;
    pos[t] = cur;
  }
  return clampLong(pos, dir);
}

// EMA crossover: long above / short below. Sweep fast/slow.
export function emaCross(bars, { fast, slow }, dir) {
  const c = bars.map((b) => b.c);
  const ef = ema(c, fast);
  const es = ema(c, slow);
  const pos = c.map((_, t) => {
    if (t < slow) return null;
    return ef[t] > es[t] ? 1 : ef[t] < es[t] ? -1 : 0;
  });
  return clampLong(pos, dir);
}

// MACD: sign of (macd − signal), macd = ema(fast) − ema(slow).
export function macd(bars, { fast, slow, sig }, dir) {
  const c = bars.map((b) => b.c);
  const ef = ema(c, fast);
  const es = ema(c, slow);
  const macdLine = c.map((_, t) => ef[t] - es[t]);
  const signal = ema(macdLine, sig);
  const pos = c.map((_, t) => {
    if (t < slow + sig) return null;
    const d = macdLine[t] - signal[t];
    return d > 0 ? 1 : d < 0 ? -1 : 0;
  });
  return clampLong(pos, dir);
}

// RSI mean-reversion: enter long when oversold (<lo), short when overbought (>hi), exit to flat when
// RSI crosses back through 50. Stateful.
export function rsiReversion(bars, { period, lo, hi }, dir) {
  const c = bars.map((b) => b.c);
  const r = rsi(c, period);
  const pos = new Array(bars.length).fill(null);
  let cur = 0;
  for (let t = 0; t < bars.length; t += 1) {
    if (r[t] === null) {
      pos[t] = null;
      continue;
    }
    if (cur === 0) {
      if (r[t] < lo) cur = 1;
      else if (r[t] > hi) cur = -1;
    } else if (cur === 1 && r[t] >= 50) cur = 0;
    else if (cur === -1 && r[t] <= 50) cur = 0;
    pos[t] = cur;
  }
  return clampLong(pos, dir);
}

// Bollinger mean-reversion: long at/under the lower band, short at/over the upper band, exit at the
// mid (SMA). Stateful.
export function bollinger(bars, { period, k }, dir) {
  const c = bars.map((b) => b.c);
  const mid = sma(c, period);
  const sd = stddev(c, period);
  const pos = new Array(bars.length).fill(null);
  let cur = 0;
  for (let t = 0; t < bars.length; t += 1) {
    if (mid[t] === null || sd[t] === null) {
      pos[t] = null;
      continue;
    }
    const upper = mid[t] + k * sd[t];
    const lower = mid[t] - k * sd[t];
    if (cur === 0) {
      if (c[t] <= lower) cur = 1;
      else if (c[t] >= upper) cur = -1;
    } else if (cur === 1 && c[t] >= mid[t]) cur = 0;
    else if (cur === -1 && c[t] <= mid[t]) cur = 0;
    pos[t] = cur;
  }
  return clampLong(pos, dir);
}

// ATR volatility breakout: long when the close jumps more than k·ATR above the prior close, short on
// the symmetric downside break; hold otherwise (the prescreen's vol-expansion concept, as a strategy).
export function atrBreakout(bars, { period, k }, dir) {
  const c = bars.map((b) => b.c);
  const a = atr(bars, period);
  const pos = new Array(bars.length).fill(null);
  let cur = 0;
  for (let t = 1; t < bars.length; t += 1) {
    if (a[t] === null) {
      pos[t] = null;
      continue;
    }
    if (c[t] > c[t - 1] + k * a[t]) cur = 1;
    else if (c[t] < c[t - 1] - k * a[t]) cur = -1;
    pos[t] = cur;
  }
  return clampLong(pos, dir);
}

// The family registry: name → { fn, grid: [paramObj, ...] }. Grids are pre-registered here so the
// deflated-Sharpe honest-N count is exactly the number of trials actually run (no p-hacking by
// hidden extra trials).
export const FAMILIES = {
  tsmom: {
    fn: tsmom,
    grid: [8, 12, 20, 30, 50, 80].map((lookback) => ({ lookback })),
  },
  donchian: {
    fn: donchian,
    grid: [10, 20, 30, 55, 80].map((n) => ({ n })),
  },
  emaCross: {
    fn: emaCross,
    grid: [
      [9, 21],
      [12, 26],
      [20, 50],
      [50, 100],
      [50, 200],
    ].map(([fast, slow]) => ({ fast, slow })),
  },
  macd: {
    fn: macd,
    grid: [
      [12, 26, 9],
      [8, 21, 5],
      [20, 50, 9],
    ].map(([fast, slow, sig]) => ({ fast, slow, sig })),
  },
  rsiReversion: {
    fn: rsiReversion,
    grid: [
      [14, 30, 70],
      [14, 25, 75],
      [7, 20, 80],
      [21, 35, 65],
    ].map(([period, lo, hi]) => ({ period, lo, hi })),
  },
  bollinger: {
    fn: bollinger,
    grid: [
      [20, 2],
      [20, 2.5],
      [30, 2],
      [50, 2.5],
    ].map(([period, k]) => ({ period, k })),
  },
  atrBreakout: {
    fn: atrBreakout,
    grid: [
      [14, 1],
      [14, 1.5],
      [20, 2],
      [30, 2.5],
    ].map(([period, k]) => ({ period, k })),
  },
};

export function paramLabel(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}
