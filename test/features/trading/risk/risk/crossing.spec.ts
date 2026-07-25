import { describe, it, expect } from 'vitest';
import {
  wouldCross,
  type RestingOrder,
  type CrossingProbe,
} from '../../../src/domain/risk/crossing';
import { price } from '../../../src/domain/types/money';
import { strategyId, symbolId } from '../../../src/domain/types/ids';

const SYM = symbolId('BTC/USDT');
const OTHER = symbolId('ETH/USDT');
const A = strategyId('a');
const B = strategyId('b');

function rest(side: 'BUY' | 'SELL', p: string, strat = B, symbol = SYM): RestingOrder {
  return { strategyId: strat, symbol, side, price: price(p) };
}
function probe(side: 'BUY' | 'SELL', limit: string | undefined, strat = A): CrossingProbe {
  return {
    strategyId: strat,
    symbol: SYM,
    side,
    limitPrice: limit === undefined ? undefined : price(limit),
  };
}

describe('wouldCross (§5 X1)', () => {
  it('a BUY crosses a sibling resting SELL at or below the limit', () => {
    expect(wouldCross(probe('BUY', '100'), [rest('SELL', '100')])).toBe(true);
    expect(wouldCross(probe('BUY', '100'), [rest('SELL', '101')])).toBe(false);
  });
  it('a SELL crosses a sibling resting BUY at or above the limit', () => {
    expect(wouldCross(probe('SELL', '100'), [rest('BUY', '100')])).toBe(true);
    expect(wouldCross(probe('SELL', '100'), [rest('BUY', '99')])).toBe(false);
  });
  it('a market intent (no limit) crosses any opposing sibling', () => {
    expect(wouldCross(probe('BUY', undefined), [rest('SELL', '999')])).toBe(true);
    expect(wouldCross(probe('SELL', undefined), [rest('BUY', '1')])).toBe(true);
  });
  it('ignores other symbols, self orders, and same-side rests', () => {
    expect(wouldCross(probe('BUY', '100'), [rest('SELL', '50', B, OTHER)])).toBe(false); // other symbol
    expect(wouldCross(probe('BUY', '100'), [rest('SELL', '50', A)])).toBe(false); // self
    expect(wouldCross(probe('BUY', '100'), [rest('BUY', '50')])).toBe(false); // same side
    expect(wouldCross(probe('BUY', '100'), [])).toBe(false); // empty book
  });
});
