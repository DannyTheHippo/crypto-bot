// Perpetual funding settlement — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// payment = −signedQty × markPrice × fundingRate, from the POSITION HOLDER's perspective: a positive
// fundingRate charges a long position (payment negative) and credits a short one (payment positive) —
// standard perp convention (longs pay shorts when funding > 0). All Decimal, no float.
import Decimal from 'decimal.js';

export function fundingPayment(
  signedQty: Decimal,
  markPrice: Decimal,
  fundingRate: Decimal,
): Decimal {
  return signedQty.neg().mul(markPrice).mul(fundingRate);
}
