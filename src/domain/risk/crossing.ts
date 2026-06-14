import type { Price } from '../types/money';
import type { StrategyId, SymbolId } from '../types/ids';

// A resting order in the symbol-level open-interest registry (incl. in-flight).
export interface RestingOrder {
  readonly strategyId: StrategyId;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly price: Price;
}

export interface CrossingProbe {
  readonly strategyId: StrategyId;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly limitPrice: Price | undefined;
}

// X1: would this intent execute against a SIBLING strategy's resting order?
// A marketable buy (limit ≥ a sibling's resting sell) or sell (limit ≤ a sibling's
// resting buy) on the same symbol crosses. Self-orders never count (that's just the
// strategy's own book). A market intent (no limit) cannot be range-checked → treated
// as crossing if any opposing sibling rests (conservative).
export function wouldCross(probe: CrossingProbe, resting: readonly RestingOrder[]): boolean {
  for (const r of resting) {
    if (r.symbol !== probe.symbol) continue;
    if (r.strategyId === probe.strategyId) continue;
    if (probe.side === 'BUY' && r.side === 'SELL') {
      if (probe.limitPrice === undefined || probe.limitPrice.gte(r.price)) return true;
    } else if (probe.side === 'SELL' && r.side === 'BUY') {
      if (probe.limitPrice === undefined || probe.limitPrice.lte(r.price)) return true;
    }
  }
  return false;
}
