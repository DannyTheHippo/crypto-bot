// Fill-price model — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Pure decimal-on-string fill economics shared by harness.ts's taker-next-open sim: the taker fee
// (both legs, symmetric bps of notional) and an adverse haircut applied to the FILL PRICE itself.
// The haircut is SIDE-based (BUY pays more / SELL receives less), not position-based — this is what
// makes it correct for shorts automatically: a SHORT entry is a SELL (receives less, same rule as a
// LONG exit) and a SHORT exit/cover is a BUY (pays more, same rule as a LONG entry) — no special
// short-casing needed. Mirrors the toy-equity haircut convention in
// src/features/strategy/agentic/counterfactual-scoring.ts (TOY_TAKER_FEE_BPS / TOY_ADVERSE_HAIRCUT_BPS,
// 10bps taker + 5bps haircut), independently re-derived on Decimal here since this module runs
// against arbitrary bar arrays rather than ScoringRow (that module's dependency, not reused directly).
//
// NOTE: the prior MAKER_RESTING resting-limit-order model (pinned against the retired
// src/domain/strategy/strategy.ts Strategy port) is dropped in this re-fit — it is incompatible with
// the new BarStrategy port's next-bar-open-only fill semantics and was not requested by the rebuild
// plan (which asks only for taker fee + directional adverse haircut). Re-add if a maker-economics
// study is scoped again.
import Decimal from 'decimal.js';

export interface FillConfig {
  readonly takerFeeBps: string;
  readonly adverseHaircutBps: string;
}

export const DEFAULT_FILL_CONFIG: FillConfig = { takerFeeBps: '10', adverseHaircutBps: '5' };

const BPS = new Decimal('10000');

// BUY pays MORE than the raw reference price; SELL receives LESS.
export function effectiveFillPrice(
  side: 'BUY' | 'SELL',
  rawPrice: Decimal,
  haircutBps: Decimal,
): Decimal {
  const h = haircutBps.div(BPS);
  return side === 'BUY' ? rawPrice.mul(new Decimal(1).add(h)) : rawPrice.mul(new Decimal(1).sub(h));
}

// Taker fee charged on the fill's own (already haircut-adjusted) notional — matches the production
// convention (fee is on the executed price, not some pre-slippage reference).
export function takerFeeQuote(fillPrice: Decimal, qty: Decimal, feeBps: Decimal): Decimal {
  return fillPrice.mul(qty).mul(feeBps.div(BPS));
}
