import { describe, it, expect } from 'vitest';
import {
  sma,
  rollingMeanStd,
  zscore,
  bollinger,
  donchian,
  rsi,
  atr,
  adx,
  momentum,
} from './indicators';

// Research indicators validated against hand-checked / closed-form inputs. A silent Wilder-smoothing or
// off-by-one bug here would invalidate the entire long-battery verdict, so each is pinned.
describe('research indicators — known inputs', () => {
  it('sma / rollingMeanStd / zscore', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBeCloseTo(3, 12);
    expect(sma([1, 2], 5)).toBeNaN(); // not enough data
    expect(sma([9, 9, 1, 2, 3, 4, 5], 5)).toBeCloseTo(3, 12); // trailing window only
    const { mean, std } = rollingMeanStd([1, 2, 3, 4, 5], 5);
    expect(mean).toBeCloseTo(3, 12);
    expect(std).toBeCloseTo(Math.SQRT2, 12); // population std of [1..5]
    // z of the last point: (5−3)/√2
    expect(zscore([1, 2, 3, 4, 5], 5)).toBeCloseTo((5 - 3) / Math.SQRT2, 12);
  });

  it('bollinger bands sit symmetric around the SMA mid', () => {
    const b = bollinger([1, 2, 3, 4, 5], 5, 2);
    expect(b.mid).toBeCloseTo(3, 12);
    expect(b.upper).toBeCloseTo(3 + 2 * Math.SQRT2, 12);
    expect(b.lower).toBeCloseTo(3 - 2 * Math.SQRT2, 12);
  });

  it('donchian channel is the window max/min', () => {
    const highs = [10, 12, 11, 15, 13];
    const lows = [8, 9, 7, 10, 9];
    const d = donchian(highs, lows, 4); // last 4 bars
    expect(d.upper).toBe(15);
    expect(d.lower).toBe(7);
    expect(donchian([1, 2], [1, 2], 5).upper).toBeNaN();
  });

  it('RSI: 100 for a pure uptrend, 0 for a pure downtrend, ~50 for symmetric oscillation', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(up, 14)).toBe(100); // no down-moves
    expect(rsi(down, 14)).toBe(0); // no up-moves
    const osc: number[] = [];
    for (let i = 0; i < 60; i++) osc.push(100 + (i % 2 === 0 ? -1 : 1)); // alternating ±, equal magnitudes
    const r = rsi(osc, 14);
    expect(r).toBeGreaterThan(45); // symmetric oscillation ⇒ near the 50 midline (Wilder tilts to the last move)
    expect(r).toBeLessThan(55);
    expect(rsi([1, 2], 14)).toBeNaN();
  });

  it('ATR equals the constant true range of a steady series', () => {
    // high=c+1, low=c−1, close=c, c rising by 1 ⇒ TR = max(2, 2, 0) = 2 every bar ⇒ ATR = 2.
    const n = 40;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = 100 + i;
      highs.push(c + 1);
      lows.push(c - 1);
      closes.push(c);
    }
    expect(atr(highs, lows, closes, 14)).toBeCloseTo(2, 10);
    expect(atr([1], [1], [1], 14)).toBeNaN();
  });

  it('ADX: high with +DI dominant in a clean uptrend, bounded [0,100]', () => {
    const n = 80;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = 100 + i * 2; // persistent uptrend
      highs.push(c + 0.5);
      lows.push(c - 0.5);
      closes.push(c);
    }
    const a = adx(highs, lows, closes, 14);
    expect(a.adx).toBeGreaterThan(20);
    expect(a.adx).toBeLessThanOrEqual(100);
    expect(a.plusDI).toBeGreaterThan(a.minusDI); // up-trend ⇒ +DI dominates
    expect(adx([1, 2, 3], [1, 2, 3], [1, 2, 3], 14).adx).toBeNaN();
  });

  it('momentum is the trailing return', () => {
    expect(momentum([100, 100, 110], 2)).toBeCloseTo(0.1, 12); // 110/100 − 1
    expect(momentum([100, 90], 2)).toBeNaN();
  });
});
