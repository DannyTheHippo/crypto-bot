import Decimal from 'decimal.js';
import { price as makePrice, qty as makeQty, feeAmount, type Price, type Qty, type FeeAmount } from '../types/money';
import type { OrderLevel } from '../types/market-events';

// Pure paper-fill model (§6.5). Deterministic over its inputs; latency/PRNG live in the
// adapter. Two regimes: book-walk for market orders, trade-through for resting limits.
export type FeeCcy = 'quote' | 'base';
export type InsufficientDepthPolicy = 'partial_then_reject_rest' | 'fill_at_worst_level';

export interface SimFill {
  readonly price: Price;
  readonly qty: Qty;
  readonly fee: { readonly ccy: string; readonly amount: FeeAmount };
  readonly liquidity: 'maker' | 'taker';
}

function makeFill(
  p: Decimal, q: Decimal, feeBps: Decimal, feeCcy: FeeCcy, liquidity: 'maker' | 'taker',
): SimFill {
  // base-currency fee bills the filled quantity; quote bills the notional.
  const base = feeCcy === 'base' ? q : p.mul(q);
  return {
    price: makePrice(p),
    qty: makeQty(q),
    fee: { ccy: feeCcy, amount: feeAmount(base.mul(feeBps).div(10_000)) },
    liquidity,
  };
}

// Market order: consume L2 levels (caller pre-sorts best-first for the side) producing one
// fill per level (exercises partial-fill paths). On insufficient depth, either reject the
// remainder or fill it at the worst consumed level (self-impact is NOT modelled — §6.5 box).
export function bookWalk(
  orderQty: Decimal,
  levels: readonly OrderLevel[],
  feeBps: Decimal,
  feeCcy: FeeCcy,
  policy: InsufficientDepthPolicy,
): SimFill[] {
  const fills: SimFill[] = [];
  let remaining = orderQty;
  let lastPrice: Decimal | undefined;
  for (const lvl of levels) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, lvl.qty);
    fills.push(makeFill(lvl.price, take, feeBps, feeCcy, 'taker'));
    remaining = remaining.sub(take);
    lastPrice = lvl.price;
  }
  if (remaining.gt(0) && policy === 'fill_at_worst_level' && lastPrice !== undefined) {
    fills.push(makeFill(lastPrice, remaining, feeBps, feeCcy, 'taker'));
  }
  return fills;
}

// Resting limit: a buy fills only from prints strictly BELOW its limit (sell: strictly
// above), at OUR limit price, maker liquidity — touching the limit never fills (we'd be at
// the back of the queue). Returns null when the print does not trade through.
export function tradeThroughFill(
  side: 'BUY' | 'SELL',
  limitPrice: Price,
  remainingQty: Decimal,
  print: { readonly price: Price; readonly qty: Qty },
  feeBps: Decimal,
  feeCcy: FeeCcy,
): SimFill | null {
  const crosses = side === 'BUY' ? print.price.lt(limitPrice) : print.price.gt(limitPrice);
  if (!crosses) return null;
  const fillQty = Decimal.min(remainingQty, print.qty);
  if (fillQty.lte(0)) return null;
  return makeFill(limitPrice, fillQty, feeBps, feeCcy, 'maker');
}
