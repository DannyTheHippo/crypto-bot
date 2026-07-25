import { describe, it, expect, beforeAll } from 'vitest';
import Decimal from 'decimal.js';
import {
  applyFillToPosition,
  FLAT,
  type PositionState,
} from '../../../../src/domain/trading/oms/position';
import { setupDecimal } from '../../../../src/domain/common/types/money';

// avgEntry is rounded to the money type's 18-dp ceiling, which depends on the production Decimal
// config (precision 40); main.ts calls setupDecimal() at bootstrap. Existing cases here are
// precision-insensitive (exact integer/short-decimal averages).
beforeAll(() => setupDecimal());

const D = (s: string) => new Decimal(s);
const buy = (pos: PositionState, q: string, p: string, fee = '0') =>
  applyFillToPosition(pos, 'BUY', D(q), D(p), D(fee));
const sell = (pos: PositionState, q: string, p: string, fee = '0') =>
  applyFillToPosition(pos, 'SELL', D(q), D(p), D(fee));

describe('applyFillToPosition (average-cost, §6.6)', () => {
  it('opens a long from flat at the fill price', () => {
    const r = buy(FLAT, '2', '100');
    expect(r.signedQty.toFixed()).toBe('2');
    expect(r.avgEntry.toFixed()).toBe('100');
    expect(r.realizedPnl.toFixed()).toBe('0');
  });

  it('weights the average entry as the long grows', () => {
    const r = buy(buy(FLAT, '2', '100'), '2', '110');
    expect(r.signedQty.toFixed()).toBe('4');
    expect(r.avgEntry.toFixed()).toBe('105'); // (2×100 + 2×110)/4
  });

  it('realizes PnL on a partial reduce and keeps the entry', () => {
    const long = buy(FLAT, '4', '100');
    const r = sell(long, '1', '120');
    expect(r.signedQty.toFixed()).toBe('3');
    expect(r.avgEntry.toFixed()).toBe('100'); // unchanged
    expect(r.realizedPnl.toFixed()).toBe('20'); // (120−100)×1
  });

  it('closes to flat and zeroes the entry', () => {
    const r = sell(buy(FLAT, '2', '100'), '2', '110');
    expect(r.signedQty.toFixed()).toBe('0');
    expect(r.avgEntry.toFixed()).toBe('0');
    expect(r.realizedPnl.toFixed()).toBe('20'); // (110−100)×2
  });

  it('flips long→short, realizing the close and reopening at the fill', () => {
    const r = sell(buy(FLAT, '2', '100'), '5', '120');
    expect(r.signedQty.toFixed()).toBe('-3'); // 2 − 5
    expect(r.avgEntry.toFixed()).toBe('120'); // reopened short at fill
    expect(r.realizedPnl.toFixed()).toBe('40'); // closed 2 at (120−100)
  });

  it('realizes correctly when reducing a short (buy to cover)', () => {
    const short = sell(FLAT, '2', '100'); // open short
    expect(short.signedQty.toFixed()).toBe('-2');
    const r = buy(short, '1', '90'); // cover 1 cheaper → profit
    expect(r.signedQty.toFixed()).toBe('-1');
    expect(r.realizedPnl.toFixed()).toBe('10'); // (100−90)×1
  });

  it('grows a short (same-direction sell) and re-weights entry', () => {
    const r = sell(sell(FLAT, '2', '100'), '2', '90');
    expect(r.signedQty.toFixed()).toBe('-4');
    expect(r.avgEntry.toFixed()).toBe('95'); // (2×100 + 2×90)/4
  });

  it('subtracts fees from realized PnL', () => {
    const r = sell(buy(FLAT, '2', '100', '0.5'), '2', '110', '0.5');
    expect(r.realizedPnl.toFixed()).toBe('19'); // 20 − 0.5 − 0.5
  });

  it('rounds a non-terminating weighted-average entry to ≤18 dp (money-precision conformance)', () => {
    // Real live testnet BTC/USDT fills (#1 + #14): open 0.00156 @ 63965.66, add 0.00046 @ 64113.19.
    // The quotient is non-terminating (35 dp under precision 40); it is rounded HALF_EVEN to 18 dp.
    const r = buy(buy(FLAT, '0.00156', '63965.66'), '0.00046', '64113.19');
    expect(r.signedQty.toFixed()).toBe('0.00202');
    expect(r.avgEntry.toFixed()).toBe('63999.255940594059405941'); // exact (CLAUDE.md #1)
    expect((r.avgEntry.toFixed().split('.')[1] ?? '').length).toBeLessThanOrEqual(18);
  });
});
