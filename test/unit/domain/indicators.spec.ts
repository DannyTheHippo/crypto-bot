import { describe, it, expect } from 'vitest';
import {
  smaFromNumbers,
  emaFromNumbers,
  emaFromPrices,
  rsiFromNumbers,
  atrFromNumbers,
  pctChange,
} from '../../../src/domain/indicators/indicators';
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

describe('rsiFromNumbers', () => {
  it('is exactly 100 for a strictly increasing series', () => {
    const closes = Array.from({ length: 17 }, (_, i) => i + 1);
    expect(rsiFromNumbers(closes, 14)).toBe(100);
  });

  it('is exactly 0 for a strictly decreasing series', () => {
    const closes = Array.from({ length: 17 }, (_, i) => 17 - i);
    expect(rsiFromNumbers(closes, 14)).toBe(0);
  });

  it('returns NaN with fewer than period+1 closes', () => {
    expect(Number.isNaN(rsiFromNumbers([1, 2, 3], 14))).toBe(true);
  });

  it('is exactly 50 for alternating equal-magnitude deltas (7 gains, 7 losses)', () => {
    // period 14, 15 closes: deltas alternate +1,-1,... so seed avgGain = avgLoss = 0.5 — both
    // exactly representable, so RS = 1 and RSI = 50 with no float error.
    const closes = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100];
    expect(rsiFromNumbers(closes, 14)).toBe(50);
  });
});

describe('atrFromNumbers', () => {
  it('equals the constant range when there are no gaps', () => {
    const n = 15;
    const highs = Array(n).fill(105);
    const lows = Array(n).fill(95);
    const closes = Array(n).fill(100);
    expect(atrFromNumbers(highs, lows, closes, 14)).toBe(10);
  });

  it('returns NaN for mismatched array lengths', () => {
    expect(Number.isNaN(atrFromNumbers([1, 2], [1], [1, 2], 1))).toBe(true);
  });

  it('returns NaN for too-short input', () => {
    expect(Number.isNaN(atrFromNumbers([1, 2], [1, 2], [1, 2], 14))).toBe(true);
  });
});

describe('pctChange', () => {
  it('computes the percent change over the lookback', () => {
    // 150/100 − 1 = 0.5 exactly in binary floating point, so the result is float-exact.
    expect(pctChange([100, 150], 1)).toBe(50);
  });

  it('returns NaN when lookback is at least the series length', () => {
    expect(Number.isNaN(pctChange([100, 110], 2))).toBe(true);
  });

  it('returns NaN when the reference value is 0', () => {
    expect(Number.isNaN(pctChange([0, 50], 1))).toBe(true);
  });
});
