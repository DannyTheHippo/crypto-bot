// Self-contained multi-strategy backtest engine (2026-07-12, Fable session).
//
// WHY THIS EXISTS: the program's "no directional edge" verdict rested entirely on ONE entry rule
// (the retired seed: EMA9/21 + RSI14 + ATR selectivity) failing across 52 buckets. That is far too
// narrow a search to conclude the strategy space is empty. This engine widens the search enormously —
// many strategy FAMILIES (trend, momentum, mean-reversion, volatility, cross-sectional), LONG and
// SHORT (the owner asked to revisit shorts), across every symbol/timeframe with data on disk, at
// EVERY realistic fee level (from 0bps FDUSD-maker to 20bps spot-taker) — and gates every cell with
// honest out-of-sample statistics (walk-forward holdout + winsorized deflated Sharpe).
//
// DELIBERATELY STANDALONE: pure ESM, no imports from src/ or the TS backtest tree, so it neither
// collides with concurrent edits to test/backtest/{stats,trial-registry}.ts nor needs the vitest
// transform. It reuses the on-disk OHLCV cache (test/backtest/data/ohlcv-<SYM>-<TF>.json, the
// standard [openTime,o,h,l,c,v] array fetch-data.mjs writes).
//
// FILL MODEL (no lookahead, deliberately conservative — documented so results aren't over-trusted):
//   - signal s[t] ∈ {-1,0,+1} is computed from CLOSED bars 0..t only.
//   - the position is executed at the NEXT bar's OPEN (open[t+1]) — you cannot trade the close you
//     just observed — and marked to the following open (open[t+2]).
//   - per-step net return r = s[t]·(open[t+2]/open[t+1] − 1) − |s[t] − s[t−1]|·feeLegFraction.
//     Turnover |Δs| charges one leg per unit position change (a flat→long is one leg, a long→short
//     is two), which is exactly how maker/taker fees accrue.
// This is a research metric (bar-open fills, no intrabar path, no slippage beyond the fee) — it seeds
// and screens, it never certifies. The honest-N gate below is what keeps a lucky cell from being
// mistaken for edge.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export const BARS_PER_YEAR = { '15m': 35040, '1h': 8760, '4h': 2190, '1d': 365 };

// Round-trip fee levels (bps) grounded in the 2026-07-12 fee research (web:binance-fees):
//   0    = FDUSD maker-only pairs (both legs 0)
//   3.6  = USDT-M futures maker+maker with BNB discount (1.8/leg) — requires perps (shorts)
//   7.5  = spot maker+maker with BNB, ONE leg (illustrative half) ... see FEE_LEVELS comment
//   15   = spot maker+maker + BNB round trip
//   20   = spot taker+taker, no discount (the demo venue's actual flat charge, measured)
export const FEE_LEVELS_BPS = [0, 3.6, 7.5, 10, 15, 20];

export function loadOhlcv(symbolNoSlash, tf) {
  const path = join(DATA_DIR, `ohlcv-${symbolNoSlash}-${tf}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  // Rows are [openTime, open, high, low, close, volume]; keep numbers (research metric, not money path).
  return raw.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
}

// ── Indicators (pure, no-lookahead: each index i uses only bars 0..i) ───────────────────────────
export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    prev = prev === null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1];
    const gain = Math.max(0, ch);
    const loss = Math.max(0, -ch);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function atr(bars, period) {
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 1; i < bars.length; i += 1) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
    if (i <= period) {
      prev = prev === null ? tr : prev + tr;
      if (i === period) {
        prev /= period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}

export function rollingMax(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i += 1) {
    let m = -Infinity;
    for (let j = i - period; j < i; j += 1) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

export function rollingMin(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i += 1) {
    let m = Infinity;
    for (let j = i - period; j < i; j += 1) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function stddev(values, period) {
  const out = new Array(values.length).fill(null);
  const m = sma(values, period);
  for (let i = period - 1; i < values.length; i += 1) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j += 1) s += (values[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

// ── Backtest one position series over one bar array at one fee level ─────────────────────────────
// positions[t] = desired position ∈ {-1,0,+1} AFTER observing bar t's close (null ⇒ treat as flat,
// used during warmup). Returns a per-step net-return array aligned so netReturns[i] is the return
// realized over (open[i+1] → open[i+2]) with turnover cost charged at open[i+1].
export function simulate(bars, positions, feeBps) {
  const feeLeg = feeBps / 2 / 10000; // per-leg fraction of a round-trip
  const netReturns = [];
  let prevPos = 0;
  let roundTrips = 0;
  let wins = 0;
  let entries = 0;
  // Track per-trade P&L to count wins / round trips honestly (a round trip = a return to flat or a flip).
  let tradeEntryEquityIdx = null;
  let tradeSideAtEntry = 0;
  let tradeGross = 0;
  for (let i = 0; i < bars.length - 2; i += 1) {
    const pos = positions[i] ?? 0;
    const openNext = bars[i + 1].o;
    const openAfter = bars[i + 2].o;
    if (!Number.isFinite(openNext) || !Number.isFinite(openAfter) || openNext <= 0) {
      netReturns.push(0);
      continue;
    }
    const gross = pos * (openAfter / openNext - 1);
    const turnover = Math.abs(pos - prevPos);
    const cost = turnover * feeLeg;
    netReturns.push(gross - cost);

    // Round-trip bookkeeping: a trade opens when we go from flat to non-flat or flip sign.
    if (pos !== prevPos) {
      if (prevPos !== 0) {
        // closing (or flipping out of) a position → one completed round trip
        roundTrips += 1;
        if (tradeGross - 2 * feeLeg > 0) wins += 1; // net of a round trip's two legs
        tradeGross = 0;
      }
      if (pos !== 0) {
        entries += 1;
        tradeSideAtEntry = pos;
        tradeGross = 0;
      }
    }
    if (pos !== 0) tradeGross += pos * (openAfter / openNext - 1);
    prevPos = pos;
    void tradeEntryEquityIdx;
    void tradeSideAtEntry;
  }
  return { netReturns, roundTrips, wins, entries };
}

export function annualizedSharpe(netReturns, tf) {
  const n = netReturns.length;
  if (n < 2) return { sharpe: 0, mean: 0, std: 0, skew: 0, kurt: 3 };
  const mean = netReturns.reduce((a, b) => a + b, 0) / n;
  let v = 0;
  let s3 = 0;
  let s4 = 0;
  for (const r of netReturns) {
    const d = r - mean;
    v += d * d;
    s3 += d * d * d;
    s4 += d * d * d * d;
  }
  v /= n;
  const std = Math.sqrt(v);
  const skew = std > 0 ? s3 / n / std ** 3 : 0;
  const kurt = std > 0 ? s4 / n / std ** 4 : 3;
  const perStep = std > 0 ? mean / std : 0;
  const sharpe = perStep * Math.sqrt(BARS_PER_YEAR[tf]);
  return { sharpe, mean, std, skew, kurt };
}

export function maxDrawdown(netReturns) {
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of netReturns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

export function totalReturn(netReturns) {
  let eq = 1;
  for (const r of netReturns) eq *= 1 + r;
  return eq - 1;
}

// ── Deflated Sharpe Ratio (Bailey & López de Prado 2014), with winsorized cross-trial variance ──
// V is estimated from ALL trial Sharpes; winsorizing (clip |SR|≤cap) prevents thin-sample outliers
// from inflating SR0* to an unpassable value — the exact degeneracy the 2026-07-10 carry study hit
// (SR0*=140.41 from 10 cells with |SR|>10). Returns SR0 (the deflation benchmark) for a trial set.
const EULER_GAMMA = 0.5772156649;

function normInv(p) {
  // Acklam's rational approximation of the inverse standard normal CDF.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 via erf.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// SR0*: expected maximum Sharpe under the null across N independent trials with per-trial SR
// variance V. Winsorize the trial SR set before estimating V.
export function deflationBenchmark(trialSharpes, winsorCap = 3) {
  const clipped = trialSharpes.map((s) => Math.max(-winsorCap, Math.min(winsorCap, s)));
  const n = clipped.length;
  const mean = clipped.reduce((a, b) => a + b, 0) / n;
  const v = clipped.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const sqrtV = Math.sqrt(v);
  const N = Math.max(2, n);
  const z1 = normInv(1 - 1 / N);
  const z2 = normInv(1 - 1 / (N * Math.E));
  const sr0 = sqrtV * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2);
  return { sr0, variance: v, N };
}

// DSR for one cell: probability its (annualized) Sharpe exceeds the deflation benchmark, adjusting
// for sample length T, skew, and kurtosis of the return stream. sr and sr0 are ANNUALIZED; convert
// to per-step consistently by dividing both by sqrt(barsPerYear) (the ratio is scale-free but the
// T-scaling wants per-step). Returns a probability in [0,1].
export function deflatedSharpe(srAnnual, sr0Annual, tf, T, skew, kurt) {
  const scale = Math.sqrt(BARS_PER_YEAR[tf]);
  const sr = srAnnual / scale; // per-step
  const sr0 = sr0Annual / scale;
  if (T < 4) return 0;
  const denom = Math.sqrt(Math.max(1e-9, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  const z = ((sr - sr0) * Math.sqrt(T - 1)) / denom;
  return normCdf(z);
}
