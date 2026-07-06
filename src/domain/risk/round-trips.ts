import Decimal from 'decimal.js';

// ── Round-trip walk over ordered fills ────────────────────────────────────────
//
// Extracted from PromotionReadinessService so BOTH consumers share one closure rule:
//   - the earned-live promotion verdict (mode-control), which needs realizedPnl + closedAt, and
//   - the reflection evidence feed (agentic lane), which needs the richer per-cycle fields
//     (VWAPs, per-cycle fees, holding window, decide-vs-fill slippage).
// The walk itself is a pure fold: signed base position per (strategyId, symbol); a cycle CLOSES
// when residual position notional (|signedQty| × the fill's own price) drops below dustNotional.
// Historical pre-IOC cycles carry dust remainders that would otherwise never close — the residual
// cost/proceeds fold directly into that cycle's realizedPnl at close (never carried forward).
// realizedPnl is GROSS of fees: the promotion verdict subtracts a cross-cycle fee sum
// (sumFeesQuote) once, so per-cycle feesQuote here is evidence-only and MUST NOT be re-subtracted
// into any verdict aggregate.

// One ordered fill row. Structurally compatible with ports/promotion's PromotionFillRow (domain
// may not import ports, so the shape is re-stated here); refPrice is the decide-time reference the
// intent was sized against — optional, used only for slippage evidence.
export interface RoundTripFill {
  readonly strategyId: string | null;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL' | null;
  readonly qty: string;
  readonly price: string;
  readonly fee: string | null;
  readonly feeAsset: string | null;
  readonly executedAt: number;
  readonly refPrice?: string | null;
}

export interface ClosedRoundTrip {
  readonly strategyId: string;
  readonly symbol: string;
  /** proceeds − cost at close, GROSS of fees (the caller owns any fee subtraction). */
  readonly realizedPnl: Decimal;
  /** Convertible fees paid inside this cycle, in quote units (quote fees + base fees × that
   *  fill's own price). Unconvertible assets are excluded here and flagged on the walk result. */
  readonly feesQuote: Decimal;
  readonly openedAt: number;
  readonly closedAt: number;
  /** Buy-side VWAP, null when the cycle contained no BUY fill (e.g. a dust-close on a stray SELL). */
  readonly entryVwap: Decimal | null;
  /** Sell-side VWAP, null when the cycle contained no SELL fill. */
  readonly exitVwap: Decimal | null;
  readonly boughtQty: Decimal;
  readonly soldQty: Decimal;
  /** Mean signed decide-vs-fill slippage in bps over the cycle's fills that carried a refPrice
   *  (+ = adverse: paid above ref on a BUY / sold below ref on a SELL); null when none did. */
  readonly meanSlippageBps: Decimal | null;
}

export interface RoundTripWalkResult {
  readonly cycles: ClosedRoundTrip[];
  readonly unconvertibleFeeAsset: boolean;
}

interface CycleState {
  signedQty: Decimal;
  cost: Decimal;
  proceeds: Decimal;
  boughtQty: Decimal;
  soldQty: Decimal;
  feesQuote: Decimal;
  slippageSum: Decimal;
  slippageCount: number;
  openedAt: number | null;
}

function freshCycle(): CycleState {
  return {
    signedQty: new Decimal(0),
    cost: new Decimal(0),
    proceeds: new Decimal(0),
    boughtQty: new Decimal(0),
    soldQty: new Decimal(0),
    feesQuote: new Decimal(0),
    slippageSum: new Decimal(0),
    slippageCount: 0,
    openedAt: null,
  };
}

// symbol is "BASE/QUOTE" (e.g. 'BTC/USDT'). split() always yields at least one element, so index 0
// is asserted rather than defaulted (a ?? fallback would be an unreachable branch under the
// 100%-branch glob).
function baseAssetOf(symbol: string): string {
  return symbol.split('/')[0]!;
}

function quoteAssetOf(symbol: string): string {
  return symbol.split('/')[1] ?? '';
}

// Only the base asset of the traded pair is convertible at a fill's own price; any other
// non-quote fee asset (e.g. BNB on a BTC/USDT fill) has no price reference in this walk and is
// reported via the unconvertibleFeeAsset flag instead of silently ignored.
function isBaseAsset(feeAsset: string, symbol: string): boolean {
  return feeAsset === baseAssetOf(symbol);
}

const BPS = new Decimal(10_000);

// Signed adverse slippage vs the decide-time reference: a BUY above ref and a SELL below ref both
// read positive. Fills without a usable (present, finite-positive) refPrice contribute nothing.
function slippageBps(side: 'BUY' | 'SELL', price: Decimal, refPrice: Decimal): Decimal {
  const raw = price.minus(refPrice).div(refPrice).mul(BPS);
  return side === 'BUY' ? raw : raw.neg();
}

// Groups ordered fills by (strategyId, symbol) and walks each group's own fills in the SAME
// relative (already-executedAt-ordered) sequence they arrive in — Map insertion order preserves
// per-group relative order because the input is globally ordered oldest→newest. Null-join fills
// (unresolved intentId ⇒ strategyId/side null) are excluded from the walk entirely; the promotion
// caller reports them via its separate UNRESOLVED_FILL reason rather than corrupting a position
// walk that has no side/strategyId to attribute the fill to.
export function walkRoundTrips(
  fills: readonly RoundTripFill[],
  dustNotional: Decimal,
): RoundTripWalkResult {
  const groups = new Map<string, { strategyId: string; symbol: string; rows: RoundTripFill[] }>();
  const cycles: ClosedRoundTrip[] = [];
  let unconvertibleFeeAsset = false;

  for (const fill of fills) {
    if (fill.strategyId === null || fill.side === null) continue;
    const key = `${fill.strategyId} ${fill.symbol}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { strategyId: fill.strategyId, symbol: fill.symbol, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(fill);
  }

  for (const { strategyId, symbol, rows } of groups.values()) {
    let cycle = freshCycle();
    for (const fill of rows) {
      const qty = new Decimal(fill.qty);
      const price = new Decimal(fill.price);
      const notional = qty.mul(price);
      if (cycle.openedAt === null) cycle.openedAt = fill.executedAt;
      if (fill.side === 'BUY') {
        cycle.signedQty = cycle.signedQty.plus(qty);
        cycle.cost = cycle.cost.plus(notional);
        cycle.boughtQty = cycle.boughtQty.plus(qty);
      } else {
        cycle.signedQty = cycle.signedQty.minus(qty);
        cycle.proceeds = cycle.proceeds.plus(notional);
        cycle.soldQty = cycle.soldQty.plus(qty);
      }

      if (fill.fee !== null && fill.feeAsset !== null) {
        if (isBaseAsset(fill.feeAsset, fill.symbol)) {
          cycle.feesQuote = cycle.feesQuote.plus(new Decimal(fill.fee).mul(price));
        } else if (fill.feeAsset === quoteAssetOf(fill.symbol)) {
          cycle.feesQuote = cycle.feesQuote.plus(new Decimal(fill.fee));
        } else {
          unconvertibleFeeAsset = true;
        }
      }

      if (fill.refPrice !== undefined && fill.refPrice !== null) {
        const ref = new Decimal(fill.refPrice);
        if (ref.gt(0)) {
          // fill.side is narrowed non-null by the grouping filter above.
          cycle.slippageSum = cycle.slippageSum.plus(slippageBps(fill.side!, price, ref));
          cycle.slippageCount += 1;
        }
      }

      const residualNotional = cycle.signedQty.abs().mul(price);
      if (residualNotional.lt(dustNotional)) {
        cycles.push({
          strategyId,
          symbol,
          realizedPnl: cycle.proceeds.minus(cycle.cost),
          feesQuote: cycle.feesQuote,
          // Narrowed to number: every iteration assigns it before this point when null.
          openedAt: cycle.openedAt,
          closedAt: fill.executedAt,
          entryVwap: cycle.boughtQty.gt(0) ? cycle.cost.div(cycle.boughtQty) : null,
          exitVwap: cycle.soldQty.gt(0) ? cycle.proceeds.div(cycle.soldQty) : null,
          boughtQty: cycle.boughtQty,
          soldQty: cycle.soldQty,
          meanSlippageBps:
            cycle.slippageCount > 0 ? cycle.slippageSum.div(cycle.slippageCount) : null,
        });
        cycle = freshCycle();
      }
    }
  }

  return { cycles, unconvertibleFeeAsset };
}

// Cross-cycle fee sum in quote units: quote-asset fees subtract directly, base-asset fees convert
// at that fill's own price. Any other fee asset is NOT summed — walkRoundTrips flags it via
// unconvertibleFeeAsset, which the promotion verdict treats as fail-closed, so silently treating
// it as zero here is the documented "subtract nothing but add the reason" rule rather than a
// double-counted gap. Includes open-cycle fills deliberately (matches the historical verdict).
export function sumFeesQuote(fills: readonly RoundTripFill[]): Decimal {
  let total = new Decimal(0);
  for (const fill of fills) {
    if (fill.fee === null || fill.feeAsset === null) continue;
    const fee = new Decimal(fill.fee);
    if (isBaseAsset(fill.feeAsset, fill.symbol)) {
      total = total.plus(fee.mul(new Decimal(fill.price)));
    } else if (fill.feeAsset === quoteAssetOf(fill.symbol)) {
      total = total.plus(fee);
    }
  }
  return total;
}
