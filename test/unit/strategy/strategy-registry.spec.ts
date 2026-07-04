import { describe, it, expect } from 'vitest';
import { StrategyRegistry } from '../../../src/modules/strategy/strategy-registry';
import { AgenticStrategy } from '../../../src/modules/agentic-strategy/agentic.strategy';
import { StubAgentClient } from '../../../src/modules/agentic-strategy/agent-client.adapter';
import type { AgenticStrategyParams } from '../../../src/modules/agentic-strategy/agentic.strategy';
import { strategyId, venueId, symbolId } from '../../../src/domain/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');
const params: AgenticStrategyParams = { symbol: S, venue: V, interval: '1m', warmupBars: 2 };

function freshRegistry(): StrategyRegistry {
  const r = new StrategyRegistry();
  r.register(
    'agentic',
    (id, p) => new AgenticStrategy(id, p as AgenticStrategyParams, new StubAgentClient()),
  );
  return r;
}

describe('StrategyRegistry', () => {
  it('enables a registered type into LOADING', () => {
    const r = freshRegistry();
    const id = strategyId('s1');
    r.enable(id, 'agentic', params);
    expect(r.states()).toEqual([{ id, lifecycle: 'LOADING' }]);
    expect(r.getStrategy(id)).toBeInstanceOf(AgenticStrategy);
    expect(r.getLifecycle(id)).toBe('LOADING');
  });

  it('throws on an unknown strategy type', () => {
    const r = freshRegistry();
    expect(() => r.enable(strategyId('x'), 'nope', params)).toThrow(/Unknown strategy type/);
  });

  it('disable moves to DRAINING with the chosen drain policy (default keep-position) and stamps drainReason OPERATOR', () => {
    const r = freshRegistry();
    const id = strategyId('s2');
    r.enable(id, 'agentic', params);
    r.disable(id);
    expect(r.getLifecycle(id)).toBe('DRAINING');
    expect(r.getDrainReason(id)).toBe('OPERATOR');
    r.disable(strategyId('absent')); // no-op, must not throw
  });

  it('setLifecycle transitions and allActive lists ACTIVE/DRAINING', () => {
    const r = freshRegistry();
    const a = strategyId('a');
    const b = strategyId('b');
    r.enable(a, 'agentic', params);
    r.enable(b, 'agentic', params);
    r.setLifecycle(a, 'ACTIVE');
    r.setLifecycle(b, 'HALTED');
    expect(r.allActive()).toEqual([a]);
    r.setLifecycle(strategyId('ghost'), 'ACTIVE'); // unknown id no-op
    expect(r.getLifecycle(strategyId('ghost'))).toBeUndefined();
  });

  it('getDrainReason is undefined for an entry that has never drained', () => {
    const r = freshRegistry();
    const id = strategyId('s3');
    r.enable(id, 'agentic', params);
    expect(r.getDrainReason(id)).toBeUndefined();
  });

  it('setLifecycle(id, "DRAINING", "AUTO") stamps an AUTO drainReason, and recovering to ACTIVE clears it', () => {
    const r = freshRegistry();
    const id = strategyId('s4');
    r.enable(id, 'agentic', params);
    r.setLifecycle(id, 'ACTIVE');
    r.setLifecycle(id, 'DRAINING', 'AUTO');
    expect(r.getLifecycle(id)).toBe('DRAINING');
    expect(r.getDrainReason(id)).toBe('AUTO');

    r.setLifecycle(id, 'ACTIVE');
    expect(r.getDrainReason(id)).toBeUndefined();
  });

  it('an OPERATOR drainReason survives a plain setLifecycle("DRAINING") call made without a reason', () => {
    const r = freshRegistry();
    const id = strategyId('s5');
    r.enable(id, 'agentic', params);
    r.disable(id); // drainReason: OPERATOR
    r.setLifecycle(id, 'DRAINING'); // no reason passed — must not clear the existing OPERATOR stamp
    expect(r.getDrainReason(id)).toBe('OPERATOR');
  });

  it('an OPERATOR drainReason survives an explicit setLifecycle("DRAINING", "AUTO") call — AUTO never downgrades OPERATOR', () => {
    const r = freshRegistry();
    const id = strategyId('s6');
    r.enable(id, 'agentic', params);
    r.disable(id); // drainReason: OPERATOR
    r.setLifecycle(id, 'DRAINING', 'AUTO'); // explicit AUTO must not win over the existing OPERATOR stamp
    expect(r.getDrainReason(id)).toBe('OPERATOR');
  });
});
