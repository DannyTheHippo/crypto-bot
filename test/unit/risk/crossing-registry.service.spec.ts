import { describe, it, expect } from 'vitest';
import { CrossingRegistryService } from '../../../src/modules/risk/crossing-registry.service';
import { price } from '../../../src/domain/types/money';
import { clientOrderId, strategyId, symbolId } from '../../../src/domain/types/ids';

const SYM = symbolId('BTC/USDT');
const A = strategyId('a');
const B = strategyId('b');

describe('CrossingRegistryService', () => {
  it('detects a cross against a sibling resting order, and clears on remove', () => {
    const reg = new CrossingRegistryService();
    const id = clientOrderId('cbp00000000000000070008000000000000abcd');
    reg.add(id, { strategyId: B, symbol: SYM, side: 'SELL', price: price('100') });

    expect(reg.wouldCross(A, SYM, 'BUY', price('100'))).toBe(true); // marketable buy crosses sibling sell
    expect(reg.wouldCross(A, SYM, 'BUY', price('99'))).toBe(false); // below the resting sell

    reg.remove(id);
    expect(reg.wouldCross(A, SYM, 'BUY', price('100'))).toBe(false); // registry now empty
  });
});
