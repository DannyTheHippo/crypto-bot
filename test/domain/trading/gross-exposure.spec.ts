import { describe, it, expect } from 'vitest';
import {
  timeWeightedAvgGrossExposure,
  type GrossExposureFill,
} from '../../../src/domain/trading/risk/gross-exposure';

function fill(over: Partial<GrossExposureFill> = {}): GrossExposureFill {
  return {
    symbol: 'BTC/USDT',
    side: 'BUY',
    qty: '1',
    price: '100',
    executedAt: 0,
    ...over,
  };
}

describe('domain/risk timeWeightedAvgGrossExposure', () => {
  it('a zero-or-negative-width window is degenerate and returns null', () => {
    expect(timeWeightedAvgGrossExposure([fill()], 1_000, 1_000)).toBeNull();
    expect(timeWeightedAvgGrossExposure([fill()], 1_000, 500)).toBeNull();
  });

  it('no fills at all folds to a legitimate zero (the book was flat throughout)', () => {
    const avg = timeWeightedAvgGrossExposure([], 0, 1_000);
    expect(avg!.toFixed()).toBe('0');
  });

  it('a position opened before the window and held constant averages to its own notional', () => {
    // BUY 1 @ 100 at t=-1 (before the window) → held flat at notional 100 for the entire [0,1000].
    const avg = timeWeightedAvgGrossExposure(
      [fill({ executedAt: -1, qty: '1', price: '100' })],
      0,
      1_000,
    );
    expect(avg!.toFixed()).toBe('100');
  });

  it('a position opened mid-window is weighted only over the time it was actually held', () => {
    // Flat for [0,40), then notional 50 (qty 10 @ 5) for [40,100).
    // weighted = 0*40 + 50*60 = 3000; avg = 3000/100 = 30.
    const avg = timeWeightedAvgGrossExposure(
      [fill({ executedAt: 40, qty: '10', price: '5' })],
      0,
      100,
    );
    expect(avg!.toFixed()).toBe('30');
  });

  it('gross sums notional across symbols independently', () => {
    // Both opened before the window and held flat throughout: BTC 1×100=100, ETH 2×50=100 → 200.
    const avg = timeWeightedAvgGrossExposure(
      [
        fill({ symbol: 'BTC/USDT', executedAt: -1, qty: '1', price: '100' }),
        fill({ symbol: 'ETH/USDT', executedAt: -1, qty: '2', price: '50' }),
      ],
      0,
      100,
    );
    expect(avg!.toFixed()).toBe('200');
  });

  it('an unresolved-join fill (side null) is skipped — the position it belongs to is unchanged', () => {
    const withNullSide = timeWeightedAvgGrossExposure(
      [
        fill({ executedAt: -1, qty: '1', price: '100' }),
        fill({ executedAt: 50, side: null, qty: '5', price: '999' }),
      ],
      0,
      100,
    );
    // Same as the constant-position case above: the null-side row contributes nothing.
    expect(withNullSide!.toFixed()).toBe('100');
  });

  it('a fill landing exactly on fromMs opens the position with the window, adding no lead-in slice', () => {
    // executedAt === fromMs: the seed loop (strictly-before) skips it, and the cursor has not moved,
    // so no zero-exposure slice is credited before it. Notional 100 (2 @ 50) for the whole [0,100).
    const avg = timeWeightedAvgGrossExposure(
      [fill({ executedAt: 0, qty: '2', price: '50' })],
      0,
      100,
    );
    expect(avg!.toFixed()).toBe('100');
  });

  it('two fills sharing one instant are folded into a single time step, not double-weighted', () => {
    // Both at t=50: the first advances the cursor to 50, the second finds executedAt === cursor and
    // contributes no second slice. Flat for [0,50), then 200 (two 1 @ 100 lots) for [50,100).
    // weighted = 0*50 + 200*50 = 10000; avg = 100.
    const avg = timeWeightedAvgGrossExposure(
      [
        fill({ executedAt: 50, qty: '1', price: '100' }),
        fill({ executedAt: 50, qty: '1', price: '100' }),
      ],
      0,
      100,
    );
    expect(avg!.toFixed()).toBe('100');
  });

  it('a reduce-then-flip mid-window is walked through the same avg-cost accounting the OMS uses', () => {
    // BUY 2 @ 100 before the window → notional 200 for [0,50).
    // SELL 3 @ 120 at t=50 flips short 1 @ 120 (reopened at the fill price) → notional 120 for [50,100).
    // weighted = 200*50 + 120*50 = 16000; avg = 160.
    const avg = timeWeightedAvgGrossExposure(
      [
        fill({ executedAt: -1, side: 'BUY', qty: '2', price: '100' }),
        fill({ executedAt: 50, side: 'SELL', qty: '3', price: '120' }),
      ],
      0,
      100,
    );
    expect(avg!.toFixed()).toBe('160');
  });
});
