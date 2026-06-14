import { describe, it, expect } from 'vitest';
import { smaFromNumbers, emaFromNumbers, emaFromPrices } from '../../../src/domain/strategy/indicators';
import { price } from '../../../src/domain/types/money';

describe('smaFromNumbers', () => {
  it('averages the series', () => {
    expect(smaFromNumbers([2, 4, 6, 8])).toBe(5);
  });
  it('returns 0 for an empty series', () => {
    expect(smaFromNumbers([])).toBe(0);
  });
});

describe('emaFromNumbers', () => {
  it('seeds with SMA(period) then applies the EMA multiplier (hand-computed)', () => {
    // period 2 over [2,4,6,8]: seed=SMA([2,4])=3, k=2/3
    //   i=2: 6*2/3 + 3*1/3 = 5
    //   i=3: 8*2/3 + 5*1/3 = 7
    expect(emaFromNumbers([2, 4, 6, 8], 2)).toBe(7);
  });

  it('returns NaN when the series is shorter than the period', () => {
    expect(Number.isNaN(emaFromNumbers([1, 2], 3))).toBe(true);
  });

  it('equals the constant value for a flat series', () => {
    expect(emaFromNumbers([10, 10, 10, 10, 10], 3)).toBe(10);
  });
});

describe('emaFromPrices', () => {
  it('crosses the Decimal→number boundary once and matches the numeric EMA', () => {
    const prices = [price('2'), price('4'), price('6'), price('8')];
    expect(emaFromPrices(prices, 2)).toBe(7);
  });
});
