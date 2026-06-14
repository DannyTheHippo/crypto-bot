import { describe, it, expect } from 'vitest';
import { StrategyRegistry } from '../../../src/modules/strategy/strategy-registry';
import { EmaCrossStrategy } from '../../../src/domain/strategy/ema-cross.strategy';
import type { EmaCrossParams } from '../../../src/domain/strategy/ema-cross.strategy';
import { strategyId, venueId, symbolId } from '../../../src/domain/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');
const params: EmaCrossParams = { fast: 3, slow: 5, symbol: S, venue: V, ttlMs: 1000 };

function freshRegistry(): StrategyRegistry {
  const r = new StrategyRegistry();
  r.register('ema', (id, p) => new EmaCrossStrategy(id, p as EmaCrossParams));
  return r;
}

describe('StrategyRegistry', () => {
  it('enables a registered type into LOADING', () => {
    const r = freshRegistry();
    const id = strategyId('s1');
    r.enable(id, 'ema', params);
    expect(r.states()).toEqual([{ id, lifecycle: 'LOADING' }]);
    expect(r.getStrategy(id)).toBeInstanceOf(EmaCrossStrategy);
    expect(r.getLifecycle(id)).toBe('LOADING');
  });

  it('throws on an unknown strategy type', () => {
    const r = freshRegistry();
    expect(() => r.enable(strategyId('x'), 'nope', params)).toThrow(/Unknown strategy type/);
  });

  it('disable moves to DRAINING with the chosen drain policy (default keep-position)', () => {
    const r = freshRegistry();
    const id = strategyId('s2');
    r.enable(id, 'ema', params);
    r.disable(id);
    expect(r.getLifecycle(id)).toBe('DRAINING');
    r.disable(strategyId('absent')); // no-op, must not throw
  });

  it('setLifecycle transitions and allActive lists ACTIVE/DRAINING', () => {
    const r = freshRegistry();
    const a = strategyId('a');
    const b = strategyId('b');
    r.enable(a, 'ema', params);
    r.enable(b, 'ema', params);
    r.setLifecycle(a, 'ACTIVE');
    r.setLifecycle(b, 'HALTED');
    expect(r.allActive()).toEqual([a]);
    r.setLifecycle(strategyId('ghost'), 'ACTIVE'); // unknown id no-op
    expect(r.getLifecycle(strategyId('ghost'))).toBeUndefined();
  });
});
