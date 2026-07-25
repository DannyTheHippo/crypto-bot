import Decimal from 'decimal.js';

// ── Benchmark alpha for the track-record block (P4, Design § Learning & measurement stack) ──────
//
// Pure math only — no candle-store access, no DB, no LLM client. The caller supplies an
// already-windowed candle series (oldest→newest, spanning the SAME evidence window as the lane's
// own realized return) and this module turns it into a buy-and-hold return fraction, then a signed
// alpha in bps against the lane's own CUMULATIVE net-of-cost bps over that window (the SUM of trip
// bps, not computeTrackRecordContext's meanNetBpsPerTrip average — a per-trip mean isn't comparable
// to a single buy-and-hold return spanning the whole window; see agentic.strategy.ts's own
// computeTrackRecordContext for the caller-side sum it threads in here).
//
// Sign convention: POSITIVE alpha means the lane beat the benchmark; NEGATIVE means the benchmark
// (simply holding) would have done better — same sign convention as counterfactual-scoring.ts's
// directionalEdge/regret lines elsewhere in this lane, so a human or the model reading multiple
// digests never has to remember two different conventions.
//
// Money-path note: candle closes arrive here as decimal STRINGS already minted by
// domain/common/types/money.ts's price() upstream. Decimal carries every intermediate step; the final bps
// figure is rounded to a whole number via toDecimalPlaces(0) before toNumber(), matching
// computeTrackRecordContext's own meanNetBpsPerTrip convention (a plain number field — reference-
// grade prompt/scoreboard context, never a money path itself, same caveat as
// counterfactual-scoring.ts's module header).
//
// Coverage note: this module has no notion of "the trip window" itself — exactly like
// counterfactual-scoring.ts's forwardReturn() takes pre-scoped rows, the caller's contract is to
// supply candles already scoped to the comparison window. A caller whose buffered candle history
// does not actually reach back to the window's start should not call this with a truncated series —
// computeHoldReturnFraction has no way to detect that and would silently return a return over a
// SHORTER window than intended.

export interface BenchmarkCandle {
  readonly eventTime: number;
  readonly close: string;
}

// Canonical benchmark symbol for BOTH consumers that need one: agentic.strategy.ts's own
// netVsBtcHoldBps (a BTC-symbol instance's siloed candle buffer) and W3 Part 2's
// computeBasketBtcBeta below (the shared PriceHistoryStore's BTC series). Defined once here so the
// two can never drift onto different benchmark symbols.
export const BTC_BENCHMARK_SYMBOL = 'BTC/USDT';

const BPS = new Decimal(10_000);

/**
 * Buy-and-hold return fraction from the FIRST to the LAST candle in the given (already-windowed,
 * oldest→newest) series. Returns null when fewer than 2 candles are supplied or the first close is
 * zero (division floor) — never a garbage fraction.
 */
export function computeHoldReturnFraction(candles: readonly BenchmarkCandle[]): Decimal | null {
  if (candles.length < 2) return null;
  const first = new Decimal(candles[0]!.close);
  const last = new Decimal(candles[candles.length - 1]!.close);
  if (first.isZero()) return null;
  return last.minus(first).div(first);
}

/**
 * Equal-weight basket return: the mean of each symbol's own computeHoldReturnFraction, over
 * whichever symbols have a defined return (symbols with too few candles are excluded, not zeroed).
 * Null when no symbol has a defined return.
 */
export function computeEqualWeightBasketReturnFraction(
  perSymbolCandles: ReadonlyMap<string, readonly BenchmarkCandle[]>,
): Decimal | null {
  const returns: Decimal[] = [];
  for (const candles of perSymbolCandles.values()) {
    const r = computeHoldReturnFraction(candles);
    if (r !== null) returns.push(r);
  }
  if (returns.length === 0) return null;
  const sum = returns.reduce((acc, r) => acc.plus(r), new Decimal(0));
  return sum.div(returns.length);
}

/**
 * Signed alpha in bps: the lane's own CUMULATIVE net-of-cost bps over the window (the SUM of trip
 * bps — see this module's header) MINUS the benchmark's buy-and-hold return over the same window,
 * also expressed in bps. Positive = the lane beat the benchmark; negative = the benchmark (doing
 * nothing but holding) would have outperformed it. Rounded to a whole bps.
 */
export function computeAlphaBps(laneCumulativeNetBps: number, benchmarkReturn: Decimal): number {
  return new Decimal(laneCumulativeNetBps)
    .minus(benchmarkReturn.mul(BPS))
    .toDecimalPlaces(0)
    .toNumber();
}

// ── W3 Part 2: basket-vs-BTC beta (AgentPortfolioBlock.correlation.btcBeta) ───────────────────────
//
// Standard asset-beta definition: cov(basketReturns, btcReturns) / var(btcReturns), computed on
// PER-BAR returns (not the single whole-window hold return computeHoldReturnFraction produces above
// — a beta needs a return SERIES to compute covariance/variance over, not one endpoint-to-endpoint
// figure). Bars are aligned by eventTime; a bar missing from either side of a pair is excluded from
// BOTH — beta needs paired observations, never an imputed value.

/**
 * Median spacing between consecutive candles' eventTime — the series' inferred bar interval.
 * PriceHistoryStore.recordWindow accumulates candles ACROSS calls (unlike a per-window
 * recompute), so a stored series can develop a cross-call gap (universe churn, a restart, or
 * prolonged DRAINING for one symbol) where array-adjacent candles are NOT time-adjacent. The
 * median (not mean) is used because it stays put under a single outlier gap — the gap transition
 * itself never dominates a series otherwise regularly spaced. Null when fewer than 2 candles.
 */
function inferBarIntervalMs(candles: readonly BenchmarkCandle[]): number | null {
  if (candles.length < 2) return null;
  const diffs = candles
    .slice(1)
    .map((c, i) => c.eventTime - candles[i]!.eventTime)
    .sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2 === 0 ? (diffs[mid - 1]! + diffs[mid]!) / 2 : diffs[mid]!;
}

/**
 * Per-bar return series for one symbol: (close[i] - close[i-1]) / close[i-1], keyed by candles[i]'s
 * eventTime. A transition whose prior close is zero is skipped (division floor, same convention as
 * computeHoldReturnFraction). A transition that does NOT span exactly one inferred bar interval —
 * i.e. a cross-call gap in the stored series — is also skipped: array-adjacency is not time-
 * adjacency, and folding a multi-interval jump in as if it were a single bar's move would mislabel
 * it as a single-bar return and misalign it against the counterpart series in
 * computeBasketBtcBeta's pairing below.
 */
function perBarReturns(candles: readonly BenchmarkCandle[]): Map<number, Decimal> {
  const out = new Map<number, Decimal>();
  const interval = inferBarIntervalMs(candles);
  if (interval === null) return out;
  for (let i = 1; i < candles.length; i++) {
    const prevCandle = candles[i - 1]!;
    const curCandle = candles[i]!;
    if (curCandle.eventTime - prevCandle.eventTime !== interval) continue;
    const prev = new Decimal(prevCandle.close);
    if (prev.isZero()) continue;
    const cur = new Decimal(curCandle.close);
    out.set(curCandle.eventTime, cur.minus(prev).div(prev));
  }
  return out;
}

/**
 * Beta of an equal-weight basket's per-bar returns against BTC's own per-bar returns. The basket
 * return at a given bar is the mean of each symbol's OWN return at that bar, over whichever symbols
 * have one (a symbol missing a bar is excluded from that bar's mean only, never imputed — mirrors
 * computeEqualWeightBasketReturnFraction's own per-symbol exclusion rule). Null when fewer than 2
 * paired (basket, btc) bars remain, or BTC's return variance is exactly zero (beta is undefined
 * against a benchmark that never moved) — never a partial/degenerate figure. Rounded to 4dp (bps-
 * level precision is meaningless for a unitless ratio; 4dp matches the ~0.0001 granularity a
 * portfolio-block reader can act on).
 */
export function computeBasketBtcBeta(
  perSymbolCandles: ReadonlyMap<string, readonly BenchmarkCandle[]>,
  btcCandles: readonly BenchmarkCandle[],
): number | null {
  const btcReturns = perBarReturns(btcCandles);
  if (btcReturns.size < 2) return null;

  const perSymbolReturns = [...perSymbolCandles.values()].map((c) => perBarReturns(c));
  const basketReturns = new Map<number, Decimal>();
  for (const eventTime of btcReturns.keys()) {
    const atBar = perSymbolReturns
      .map((r) => r.get(eventTime))
      .filter((r): r is Decimal => r !== undefined);
    if (atBar.length === 0) continue;
    const sum = atBar.reduce((acc, r) => acc.plus(r), new Decimal(0));
    basketReturns.set(eventTime, sum.div(atBar.length));
  }

  const pairs: Array<{ readonly basket: Decimal; readonly btc: Decimal }> = [];
  for (const [eventTime, btc] of btcReturns) {
    const basket = basketReturns.get(eventTime);
    if (basket !== undefined) pairs.push({ basket, btc });
  }
  if (pairs.length < 2) return null;

  const n = new Decimal(pairs.length);
  const meanBtc = pairs.reduce((acc, p) => acc.plus(p.btc), new Decimal(0)).div(n);
  const meanBasket = pairs.reduce((acc, p) => acc.plus(p.basket), new Decimal(0)).div(n);
  let cov = new Decimal(0);
  let varBtc = new Decimal(0);
  for (const p of pairs) {
    const dBtc = p.btc.minus(meanBtc);
    const dBasket = p.basket.minus(meanBasket);
    cov = cov.plus(dBtc.mul(dBasket));
    varBtc = varBtc.plus(dBtc.mul(dBtc));
  }
  if (varBtc.isZero()) return null;
  return cov.div(varBtc).toDecimalPlaces(4).toNumber();
}
