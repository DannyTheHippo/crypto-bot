import Decimal from 'decimal.js';
import { baseAssetOf, clusterBootstrap, makeRand } from './live-frame';

// ── Break-even bar composition (R1) ───────────────────────────────────────────
//
// Study: research/studies/break-even-bar-derivation-2026-08-04.md.
//
// Pure arithmetic for the three terms of a per-round-trip break-even bar: venue fees, execution
// slippage, and amortized LLM spend. No I/O — break-even-bar.spec.ts supplies the rows.
//
// Two conventions are load-bearing and are stated once here rather than at each call site:
//
//  - **Everything is per ROUND TRIP against ONE-WAY notional.** A cycle's one-way notional is
//    `turnover / 2` where turnover is the sum of every member fill's `qty x price` (both legs).
//    Dividing a cycle's WHOLE fee bill by its one-way notional yields the round-trip rate exactly,
//    with no `x2` leg approximation — the two legs of a real cycle differ in notional by the price
//    move, and the legs are not equally split between maker and taker.
//  - **The cluster bootstrap resamples BASE ASSETS**, not symbol strings and not cycles, reusing
//    `clusterBootstrap` from live-frame.ts rather than restating it. Spot `BTC/USDT` and perp
//    `BTC/USDT:USDT` are near-collinear, so they are one draw.
//
// The bootstrap operates on `number`, matching live-frame.ts and frame-audit.spec.ts: a resampling
// mean over 20k draws is a statistic, not a money quantity, and no money value is ever reconstituted
// from it. Every money figure on the path in and out stays Decimal-on-strings.

export const BPS = new Decimal(10_000);

/** Frozen for this study. Distinct from frame-audit's 20260803 so the two studies' draws differ. */
export const BOOTSTRAP_SEED = 20260731;
export const N_BOOT = 20_000;

/** Power floors. Below EITHER, a cell is RECORDED, NOT EVIDENCE. */
export const MIN_CLUSTERS = 5;
export const MIN_OBS = 12;

/** A closed cycle reduced to the quantities the bar needs. */
export interface CycleCost {
  readonly symbol: string;
  readonly venue: string;
  /** turnover / 2 — the notional a per-round-trip bps rate is quoted against. */
  readonly oneWayNotional: Decimal;
  /** Convertible fees paid inside this cycle, quote units (ClosedRoundTrip.feesQuote). */
  readonly feesQuote: Decimal;
  /** Signed execution slippage cost in quote units over this cycle's REF-FRESH legs only
   *  (+ = adverse). Legs whose ref price is stale contribute zero — see `slipLegs`. */
  readonly slipQuote: Decimal;
  /** Legs that carried a usable (fresh) ref price, of `legs` total. */
  readonly slipLegs: number;
  readonly legs: number;
}

export function feeBps(c: CycleCost): Decimal {
  return c.oneWayNotional.lte(0) ? new Decimal(0) : c.feesQuote.div(c.oneWayNotional).mul(BPS);
}

export function slipBps(c: CycleCost): Decimal {
  return c.oneWayNotional.lte(0) ? new Decimal(0) : c.slipQuote.div(c.oneWayNotional).mul(BPS);
}

/** The GROSS term: fees + slippage, per round trip, against one-way notional. */
export function grossCostBps(c: CycleCost): Decimal {
  return feeBps(c).plus(slipBps(c));
}

/**
 * Notional-weighted mean of a bps series — the book's realised rate, as distinct from the mean of
 * per-cycle rates (which weights a $23 cycle equally with a $136 one). Both are reported; neither
 * is a substitute for the other. Null on an empty or zero-notional series.
 */
export function notionalWeightedBps(
  rows: readonly { readonly notional: Decimal; readonly bps: Decimal }[],
): Decimal | null {
  const denom = rows.reduce((s, r) => s.plus(r.notional), new Decimal(0));
  if (denom.lte(0)) return null;
  return rows.reduce((s, r) => s.plus(r.bps.mul(r.notional)), new Decimal(0)).div(denom);
}

/** Σ fees ÷ Σ one-way notional — the book rate, computed from totals rather than from per-cycle
 *  rates, so it is exact rather than an average of ratios. */
export function bookRateBps(numerator: Decimal, oneWayTotal: Decimal): Decimal | null {
  return oneWayTotal.lte(0) ? null : numerator.div(oneWayTotal).mul(BPS);
}

export interface ClusterCi {
  readonly n: number;
  readonly clusters: number;
  readonly mean: number;
  readonly ciLo: number;
  readonly ciHi: number;
  /** True ⇒ the cell is RECORDED, NOT EVIDENCE (n < MIN_OBS or clusters < MIN_CLUSTERS). */
  readonly underpowered: boolean;
}

/**
 * Cluster bootstrap CI over base assets.
 *
 * Failure direction: this is a MEASUREMENT gate, so it fails OPEN — an underpowered sample is
 * reported with `underpowered: true` and its CI printed, never suppressed and never thrown on. A
 * measurement that refuses to report cannot be checked; a measurement that reports its own power
 * label can. Nothing here gates a permission or an irreversible action.
 */
export function clusterCi(
  obs: readonly { readonly symbol: string; readonly value: number }[],
): ClusterCi {
  const clusters = new Set(obs.map((o) => baseAssetOf(o.symbol))).size;
  const mean = obs.length === 0 ? NaN : obs.reduce((s, o) => s + o.value, 0) / obs.length;
  const draws = clusterBootstrap(obs, makeRand(BOOTSTRAP_SEED), N_BOOT);
  const ciLo = draws.length > 0 ? draws[Math.floor(0.025 * draws.length)]! : NaN;
  const ciHi = draws.length > 0 ? draws[Math.floor(0.975 * draws.length)]! : NaN;
  return {
    n: obs.length,
    clusters,
    mean,
    ciLo,
    ciHi,
    underpowered: obs.length < MIN_OBS || clusters < MIN_CLUSTERS,
  };
}

/**
 * The LLM term: a BOOK-LEVEL scalar divided by a contested trip count, expressed against the
 * one-way notional those trips actually turned over.
 *
 * `llmBpsPerTrip = llmCostUsd / Σ(one-way notional over the counted trips) x 10000`, which is
 * algebraically (llmCostUsd / trips) / (mean one-way notional) x 10000 — stated in the Σ form
 * because that is the form with no rounding step in the middle.
 *
 * It deliberately has NO confidence interval. There is no sampling here: one book-level number
 * divided by one count. The honest uncertainty is the RANGE across denominator choices, which the
 * caller supplies by calling this once per candidate trip count.
 */
export function llmBpsPerTrip(llmCostUsd: Decimal, oneWayNotionalTotal: Decimal): Decimal | null {
  return oneWayNotionalTotal.lte(0) ? null : llmCostUsd.div(oneWayNotionalTotal).mul(BPS);
}

export interface Bars {
  /** Venue fees + slippage. What "beats venue cost" actually requires. */
  readonly grossBarBps: Decimal;
  /** grossBar + LLM/trip at the declared notional and cadence. What the book must earn to pay for
   *  itself, inference included. */
  readonly allInBarBps: Decimal;
}

export function breakEvenBars(grossBps: Decimal, llmBps: Decimal): Bars {
  return { grossBarBps: grossBps, allInBarBps: grossBps.plus(llmBps) };
}

export function meanDecimal(xs: readonly Decimal[]): Decimal | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s.plus(x), new Decimal(0)).div(xs.length);
}

export function medianDecimal(xs: readonly Decimal[]): Decimal | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? s[mid - 1]!.plus(s[mid]!).div(2) : s[mid]!;
}
