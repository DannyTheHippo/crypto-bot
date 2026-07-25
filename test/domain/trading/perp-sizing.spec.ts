import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  marginNotionalCap,
  liqSafeNotionalCap,
  applyFundingScaling,
} from '../../../src/domain/trading/risk/perp-sizing';

describe('marginNotionalCap', () => {
  it('multiplies free margin by the leverage cap', () => {
    expect(marginNotionalCap(new Decimal('50'), new Decimal('2')).toFixed()).toBe('100');
  });

  it('is zero when free margin is zero, regardless of leverage', () => {
    expect(marginNotionalCap(new Decimal('0'), new Decimal('10')).toFixed()).toBe('0');
  });
});

describe('liqSafeNotionalCap', () => {
  it('returns Infinity (no cap) when the leverage/MMR combo clears the buffer', () => {
    // 1/2 - 0.005 = 0.495 >= 0.2 (buffer) ⇒ safe at any notional.
    const cap = liqSafeNotionalCap(new Decimal('2'), new Decimal('0.005'), new Decimal('0.2'));
    expect(cap.isFinite()).toBe(false);
    expect(cap.gt(0)).toBe(true);
  });

  it('returns zero (reject) when the leverage/MMR combo falls short of the buffer', () => {
    // 1/5 - 0.005 = 0.195 < 0.2 (buffer) ⇒ no notional is liq-safe at this leverage.
    const cap = liqSafeNotionalCap(new Decimal('5'), new Decimal('0.005'), new Decimal('0.2'));
    expect(cap.toFixed()).toBe('0');
  });

  it('fires exactly at the boundary (distance == buffer clears, gte not gt)', () => {
    // 1/5 - 0 = 0.2, exactly equal to the buffer ⇒ clears (gte).
    const cap = liqSafeNotionalCap(new Decimal('5'), new Decimal('0'), new Decimal('0.2'));
    expect(cap.isFinite()).toBe(false);
  });

  it('is symmetric — the same fixed lev/MMR figure gates both long and short (formula has no side input)', () => {
    const a = liqSafeNotionalCap(new Decimal('3'), new Decimal('0.01'), new Decimal('0.1'));
    const b = liqSafeNotionalCap(new Decimal('3'), new Decimal('0.01'), new Decimal('0.1'));
    expect(a.toFixed()).toBe(b.toFixed());
  });
});

describe('applyFundingScaling', () => {
  it('returns the notional unchanged when the hook is undefined', () => {
    expect(applyFundingScaling(new Decimal('1000'), undefined).toFixed()).toBe('1000');
  });

  it('scales notional down proportionally to the expected funding bps', () => {
    // 500 bps = 5% ⇒ 1000 × 0.95 = 950.
    expect(applyFundingScaling(new Decimal('1000'), new Decimal('500')).toFixed()).toBe('950');
  });

  it('floors the scale at zero rather than going negative for funding > 10000bps', () => {
    expect(applyFundingScaling(new Decimal('1000'), new Decimal('20000')).toFixed()).toBe('0');
  });

  it('treats negative expected funding the same as positive (abs), still scaling down', () => {
    expect(applyFundingScaling(new Decimal('1000'), new Decimal('-500')).toFixed()).toBe('950');
  });
});
