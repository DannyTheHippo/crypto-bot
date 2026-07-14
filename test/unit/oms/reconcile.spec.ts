import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  classifyVenueOpenOrder,
  balanceWithinEpsilon,
  driftStrictlyGrowing,
  isAlgoRailIntent,
} from '../../../src/domain/oms/reconcile';
import { encodeClientOrderId, intentId, venueId, symbolId } from '../../../src/domain/types/ids';
import { price } from '../../../src/domain/types/money';

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

// Push 3 P7f fixes 1-3: the shared perp/algo-rail discriminator all three execution-feature fixes
// key off — reused so their gating can never drift from each other.
describe('isAlgoRailIntent (Push 3 P7f fixes 1-3)', () => {
  const SPOT_V = venueId('binance');
  const PERP_V = venueId('binanceusdm');
  const SPOT_SYM = symbolId('BTC/USDT');
  const PERP_SYM = symbolId('BTC/USDT:USDT');

  it('true for a perp venue + triggerPrice (STOP_MARKET)', () => {
    expect(isAlgoRailIntent({ venue: PERP_V, symbol: SPOT_SYM, triggerPrice: price('90') })).toBe(
      true,
    );
  });

  it('true for a settle-suffixed symbol + triggerPrice, regardless of the venue id', () => {
    expect(isAlgoRailIntent({ venue: SPOT_V, symbol: PERP_SYM, triggerPrice: price('90') })).toBe(
      true,
    );
  });

  it('false without a triggerPrice, even on a perp venue (a regular perp LIMIT/MARKET order)', () => {
    expect(isAlgoRailIntent({ venue: PERP_V, symbol: PERP_SYM, triggerPrice: undefined })).toBe(
      false,
    );
  });

  it('false for a SPOT STOP_LOSS_LIMIT (triggerPrice present, but neither venue nor symbol is perp — regular rail, not algo)', () => {
    expect(isAlgoRailIntent({ venue: SPOT_V, symbol: SPOT_SYM, triggerPrice: price('90') })).toBe(
      false,
    );
  });
});
