import Decimal from 'decimal.js';

// Pure average-cost position accounting (§6.6, §8 Realized PnL). Increasing fills move
// the weighted-average entry; reducing fills realize PnL and leave avgEntry unchanged; a
// fill larger than the position flips it (close + reopen at the fill price). Fees always
// reduce realized PnL (quote-converted by the caller).
export interface PositionState {
  readonly signedQty: Decimal;
  readonly avgEntry: Decimal;
  readonly realizedPnl: Decimal;
}

export const FLAT: PositionState = { signedQty: new Decimal(0), avgEntry: new Decimal(0), realizedPnl: new Decimal(0) };

export function applyFillToPosition(
  pos: PositionState,
  side: 'BUY' | 'SELL',
  fillQty: Decimal,
  fillPrice: Decimal,
  feeQuote: Decimal,
): PositionState {
  const signed = side === 'BUY' ? fillQty : fillQty.neg();
  const oldQty = pos.signedQty;
  const newQty = oldQty.add(signed);
  let realized = pos.realizedPnl.sub(feeQuote);

  const increasing = oldQty.isZero() || oldQty.s === signed.s; // same sign (or opening from flat)

  if (increasing) {
    const absOld = oldQty.abs();
    const avgEntry = absOld.mul(pos.avgEntry).add(fillQty.mul(fillPrice)).div(absOld.add(fillQty));
    return { signedQty: newQty, avgEntry, realizedPnl: realized };
  }

  // Reducing or flipping: realize PnL on the closed quantity.
  const closeQty = Decimal.min(fillQty, oldQty.abs());
  const dir = oldQty.gt(0) ? 1 : -1; // long realizes (px − avg); short realizes (avg − px)
  realized = realized.add(fillPrice.sub(pos.avgEntry).mul(closeQty).mul(dir));

  if (newQty.isZero()) {
    return { signedQty: newQty, avgEntry: new Decimal(0), realizedPnl: realized }; // flat
  }
  if (fillQty.gt(oldQty.abs())) {
    return { signedQty: newQty, avgEntry: fillPrice, realizedPnl: realized }; // flipped: reopen at fill
  }
  return { signedQty: newQty, avgEntry: pos.avgEntry, realizedPnl: realized }; // partial reduce
}
