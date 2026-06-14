import Decimal from 'decimal.js';
import { applyFillToPosition, type PositionState } from './position';

// Pure money fold for one fill onto a (position, quote-cash) ledger, resolving the three
// §6.6 fee regimes. Kept separate from applyFillToPosition (which only knows quote-denominated
// fees) so the base- and third-asset paths are exercised exactly and the accounting is auditable.
//
//  • quote fee  — paid from quote cash AND charged to realized PnL (one cost, two ledgers,
//                 not double-counted: cash tracks the flow, realizedPnl tracks the P&L line).
//  • base fee   — deducted from the base actually retained ⇒ position holds NET base while the
//                 cost basis stays GROSS (avgEntry already weighted on the gross fill). This is
//                 the "unsellable dust" case; getting it wrong shows up as balance drift.
//  • third-asset fee (e.g. BNB) — never touches the position or quote cash; recorded per asset
//                 for balance reconciliation. PnL reporting converts at mark elsewhere (estimate).

export interface FillMoneyInput {
  readonly side: 'BUY' | 'SELL';
  readonly fillQty: Decimal;
  readonly fillPrice: Decimal;
  readonly fee: { readonly ccy: string; readonly amount: Decimal } | null;
  readonly baseAsset: string;
  readonly quoteAsset: string;
}

export interface PortfolioFillResult {
  readonly position: PositionState;
  readonly cashDelta: Decimal; // signed quote-asset balance change (buy spends, sell receives)
  readonly feeLedger: { readonly asset: string; readonly amount: Decimal } | null; // third-asset only
}

export function applyFillToPortfolio(pos: PositionState, input: FillMoneyInput): PortfolioFillResult {
  const { side, fillQty, fillPrice, fee, baseAsset, quoteAsset } = input;
  const notional = fillPrice.mul(fillQty);

  // Trade-level quote flow, gross of base/third-asset fees.
  let cashDelta = side === 'BUY' ? notional.neg() : notional;

  let quoteFee = new Decimal(0);
  let baseFee = new Decimal(0);
  let feeLedger: { readonly asset: string; readonly amount: Decimal } | null = null;
  if (fee !== null) {
    if (fee.ccy === quoteAsset) quoteFee = fee.amount;
    else if (fee.ccy === baseAsset) baseFee = fee.amount;
    else feeLedger = { asset: fee.ccy, amount: fee.amount };
  }

  cashDelta = cashDelta.sub(quoteFee);
  let position = applyFillToPosition(pos, side, fillQty, fillPrice, quoteFee);

  // Base fee shaves the retained base without disturbing the gross-weighted cost basis.
  if (baseFee.gt(0)) {
    position = { ...position, signedQty: position.signedQty.sub(baseFee) };
  }

  return { position, cashDelta, feeLedger };
}
