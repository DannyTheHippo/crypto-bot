import Decimal from 'decimal.js';
import {
  sumFeesQuote,
  type RoundTripFill,
  type ClosedRoundTrip,
} from '../../src/domain/trading/risk/round-trips';
import type { ExitReason, Side } from './exit-simulator';

// ── Restated cost basis + side-aware anchor for the exit-attribution study ────────────────────────
//
// Two measurement defects in `exit-attribution.spec.ts` are corrected here, and ONLY here — that
// spec's published cells are frozen and are reported beside the restatement, never replaced
// (`research/studies/exit-attribution-restated-2026-08-03.md`).
//
//   (a) COST BASIS. The frozen spec bills a flat `ROUND_TRIP_FEE='0.002'` — the binance SPOT
//       schedule (10 bps/leg, maker = taker), verified exact. The book is ~85% `binanceusdm` by
//       notional, which charges 2 bps maker / 4-5 bps taker per leg
//       (`research/studies/fee-floor-derivation-2026-07-31.md` § 2, 241 fills). `measureFeeSchedule`
//       re-derives the schedule from the SAME fills the study replays, so the cost model is measured
//       rather than asserted, and a schedule change would show up as a schedule change.
//   (b) ENTRY ANCHOR. `ClosedRoundTrip.entryVwap` is `cost / boughtQty` — the BUY-side VWAP
//       (`round-trips.ts:201`). On a SHORT trip the BUYs are the COVER, so `entryVwap` is the EXIT
//       price standing in as the entry anchor. `openingSideOf` / `anchorVwapOf` select by the sign
//       of the cycle's FIRST fill instead.
//
// The cycle-closure rule is NOT touched: `walkRoundTrips` stays the single source of when a cycle
// opens and closes, and nothing here re-derives it.
//
// TOY RESEARCH METRIC, same caveats as `exit-simulator.ts`: never a promotion input, never a money
// path (no Price/Qty is minted or moved). Decimal throughout regardless.

/** A fill row carrying the two columns the cost restatement needs beyond the walk's own inputs. */
export interface CostFill extends RoundTripFill {
  readonly venue: string;
  readonly liquidity: 'maker' | 'taker';
}

export type Liquidity = 'maker' | 'taker';

export interface FeeScheduleRow {
  readonly venue: string;
  readonly liquidity: Liquidity;
  readonly fills: number;
  readonly notional: Decimal;
  readonly feesQuote: Decimal;
  /** Notional-weighted fee fraction per leg (0.0002 = 2 bps). */
  readonly rate: Decimal;
}

export interface MeasuredFeeSchedule {
  readonly rows: readonly FeeScheduleRow[];
  /**
   * Notional-weighted per-leg fee fraction for one (venue, liquidity) channel, falling back to the
   * venue's blended rate when that channel carried no fills in the window. Null when the venue is
   * absent entirely — the caller EXCLUDES that trip rather than substituting a guess, so a venue this
   * book has never traded can never be priced by assumption.
   */
  rateFor(venue: string, liquidity: Liquidity): Decimal | null;
}

/**
 * Quote-unit fee for one fill, delegated to the production converter so the base-asset conversion
 * rule (base fees at that fill's own price, quote fees direct, anything else contributing zero and
 * flagged upstream) has exactly one implementation in the repo.
 */
export function feeQuoteOf(fill: RoundTripFill): Decimal {
  return sumFeesQuote([fill]);
}

export function measureFeeSchedule(fills: readonly CostFill[]): MeasuredFeeSchedule {
  const acc = new Map<string, { notional: Decimal; feesQuote: Decimal; fills: number }>();
  const bump = (key: string, notional: Decimal, fee: Decimal): void => {
    const cur = acc.get(key) ?? { notional: new Decimal(0), feesQuote: new Decimal(0), fills: 0 };
    acc.set(key, {
      notional: cur.notional.plus(notional),
      feesQuote: cur.feesQuote.plus(fee),
      fills: cur.fills + 1,
    });
  };

  for (const f of fills) {
    const notional = new Decimal(f.qty).mul(f.price);
    const fee = feeQuoteOf(f);
    bump(`${f.venue}|${f.liquidity}`, notional, fee);
    bump(`${f.venue}|*`, notional, fee);
  }

  const rows: FeeScheduleRow[] = [];
  for (const [key, v] of [...acc.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [venue, liquidity] = key.split('|');
    if (liquidity === '*') continue;
    rows.push({
      venue: venue!,
      liquidity: liquidity as Liquidity,
      fills: v.fills,
      notional: v.notional,
      feesQuote: v.feesQuote,
      rate: v.notional.gt(0) ? v.feesQuote.div(v.notional) : new Decimal(0),
    });
  }

  const rateOf = (key: string): Decimal | null => {
    const v = acc.get(key);
    if (v === undefined || v.notional.lte(0)) return null;
    return v.feesQuote.div(v.notional);
  };

  return {
    rows,
    rateFor: (venue, liquidity) => rateOf(`${venue}|${liquidity}`) ?? rateOf(`${venue}|*`),
  };
}

/**
 * The direction the cycle OPENED in — the sign of its first fill's signed qty. This is the ground
 * truth of which leg is the entry; the matched `agent_decisions` label is a separate claim and the
 * study reports disagreements rather than assuming they cannot happen.
 */
export function openingSideOf(members: readonly RoundTripFill[]): Side | null {
  for (const f of members) {
    if (f.side === 'BUY') return 'long';
    if (f.side === 'SELL') return 'short';
  }
  return null;
}

/** VWAP of the cycle's OPENING leg: BUY-side for a long, SELL-side for a short (defect (b)). */
export function anchorVwapOf(cycle: ClosedRoundTrip, side: Side): Decimal | null {
  return side === 'long' ? cycle.entryVwap : cycle.exitVwap;
}

/** Quantity opened, matching `anchorVwapOf`'s leg, so `anchor x qty` is the real opening notional. */
export function openingQtyOf(cycle: ClosedRoundTrip, side: Side): Decimal {
  return side === 'long' ? cycle.boughtQty : cycle.soldQty;
}

/**
 * Measured fee fraction of the cycle's own OPENING leg: quote-converted fees on that leg divided by
 * that leg's notional. Null when the leg is absent or zero-notional — the caller excludes rather
 * than defaulting, because a zero here would silently understate the trip's cost.
 */
export function openingLegFeeRate(
  members: readonly CostFill[],
  side: Side,
): { readonly rate: Decimal; readonly notional: Decimal } | null {
  const wanted = side === 'long' ? 'BUY' : 'SELL';
  let notional = new Decimal(0);
  let fees = new Decimal(0);
  for (const f of members) {
    if (f.side !== wanted) continue;
    notional = notional.plus(new Decimal(f.qty).mul(f.price));
    fees = fees.plus(feeQuoteOf(f));
  }
  if (notional.lte(0)) return null;
  return { rate: fees.div(notional), notional };
}

/**
 * Liquidity of a COUNTERFACTUAL exit leg, by the mechanism that closed it.
 *
 * Grounded in the book rather than assumed: all 13 recorded `STOP_MARKET` / `STOP_LOSS_LIMIT`
 * reduce-only fills are TAKER (100%), so a stop crosses. A venue take-profit is a limit RESTING
 * above (long) / below (short) the market and is hit, i.e. MAKER by construction. A `maxHoldBars`
 * flatten is a time-triggered close that crosses, so TAKER. The take-profit=maker choice is the one
 * modelling judgement here, and the study reports an all-taker sensitivity beside it.
 */
export function exitLegLiquidity(reason: ExitReason): Liquidity {
  return reason === 'take_profit' ? 'maker' : 'taker';
}

export type CostModel =
  | { readonly kind: 'flat'; readonly roundTrip: Decimal }
  | { readonly kind: 'measured'; readonly entryRate: Decimal; readonly exitRate: Decimal };

/**
 * Signed net return of one simulated round trip, as a fraction of the OPENING notional.
 *
 * `flat` reproduces `exit-simulator.ts`'s own arithmetic byte-for-byte (`gross - roundTrip`) so the
 * control pass is the frozen spec's number, not an approximation of it. `measured` bills the
 * opening leg its own recorded rate and the replaced exit leg the venue's measured rate scaled by
 * `exitPrice / entryPrice` — the exit leg's notional is the exit price, not the entry price, and at
 * the return magnitudes in this book that scaling is worth a fraction of a bp but costs nothing.
 */
export function netReturnOf(input: {
  readonly side: Side;
  readonly entryPrice: Decimal;
  readonly exitPrice: Decimal;
  readonly cost: CostModel;
}): Decimal {
  const { side, entryPrice, exitPrice, cost } = input;
  const gross =
    side === 'long'
      ? exitPrice.minus(entryPrice).div(entryPrice)
      : entryPrice.minus(exitPrice).div(entryPrice);
  if (cost.kind === 'flat') return gross.minus(cost.roundTrip);
  return gross.minus(cost.entryRate).minus(cost.exitRate.mul(exitPrice).div(entryPrice));
}
