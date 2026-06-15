import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  classifyVenueOpenOrder,
  balanceWithinEpsilon,
  driftStrictlyGrowing,
} from '../../../src/domain/oms/reconcile';
import { encodeClientOrderId, intentId } from '../../../src/domain/types/ids';

const OUR_COID = encodeClientOrderId(intentId('0190abcd-1234-7abc-89ab-0123456789ab'), 'paper');
const D = (s: string) => new Decimal(s);

describe('classifyVenueOpenOrder (§6.4)', () => {
  it('a foreign id is FOREIGN regardless of local knowledge', () => {
    expect(classifyVenueOpenOrder('someoneElsesOrder', false)).toBe('FOREIGN');
    expect(classifyVenueOpenOrder('someoneElsesOrder', true)).toBe('FOREIGN');
  });
  it('our prefix, present locally, is KNOWN', () => {
    expect(classifyVenueOpenOrder(OUR_COID, true)).toBe('KNOWN');
  });
  it('our prefix, absent locally, is UNKNOWN_OURS (corruption ⇒ HALT)', () => {
    expect(classifyVenueOpenOrder(OUR_COID, false)).toBe('UNKNOWN_OURS');
  });
});

describe('balanceWithinEpsilon (§6.4)', () => {
  it('uses the absolute floor when the relative band is tiny', () => {
    expect(balanceWithinEpsilon(D('0'), D('0.000000005'), '0.00000001', '0.0001')).toBe(true);
  });
  it('uses the relative band when it dominates', () => {
    expect(balanceWithinEpsilon(D('100000'), D('100005'), '0.00000001', '0.0001')).toBe(true); // tol=10
    expect(balanceWithinEpsilon(D('100000'), D('100011'), '0.00000001', '0.0001')).toBe(false); // > tol
  });
});

describe('driftStrictlyGrowing (§6.4 monotone-leak escalation)', () => {
  it('needs at least `passes` samples', () => {
    expect(driftStrictlyGrowing([D('1'), D('2')], 3)).toBe(false);
  });
  it('is true only for a strictly increasing window', () => {
    expect(driftStrictlyGrowing([D('1'), D('2'), D('3')], 3)).toBe(true);
    expect(driftStrictlyGrowing([D('0'), D('1'), D('2'), D('3')], 3)).toBe(true); // last 3 grow
  });
  it('is false on a flat or shrinking step', () => {
    expect(driftStrictlyGrowing([D('1'), D('2'), D('2')], 3)).toBe(false); // flat
    expect(driftStrictlyGrowing([D('3'), D('2'), D('1')], 3)).toBe(false); // shrinking
  });
});
