import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { bookWalk, tradeThroughFill } from '../../../src/domain/paper/fill';
import { price, qty } from '../../../src/domain/types/money';
import type { OrderLevel } from '../../../src/domain/types/market-events';

const bps = new Decimal('10'); // 0.1%
const lvl = (p: string, q: string): OrderLevel => ({ price: price(p), qty: qty(q) });

describe('bookWalk (market order, §6.5)', () => {
  it('walks levels producing one taker fill each, with quote fees', () => {
    const fills = bookWalk(new Decimal('3'), [lvl('100', '2'), lvl('101', '5')], bps, 'quote', 'partial_then_reject_rest');
    expect(fills.map((f) => f.qty.toFixed())).toEqual(['2', '1']);
    expect(fills.map((f) => f.price.toFixed())).toEqual(['100', '101']);
    expect(fills.every((f) => f.liquidity === 'taker')).toBe(true);
    // fee on the first fill: 100×2 × 10/10000 = 0.2 quote, exact
    expect(fills[0]?.fee.amount.toFixed()).toBe('0.2');
  });

  it('bills base-currency fees on the filled quantity', () => {
    const fills = bookWalk(new Decimal('2'), [lvl('100', '5')], bps, 'base', 'partial_then_reject_rest');
    expect(fills[0]?.fee.ccy).toBe('base');
    expect(fills[0]?.fee.amount.toFixed()).toBe('0.002'); // 2 × 10/10000
  });

  it('rejects the remainder when depth is insufficient (partial_then_reject_rest)', () => {
    const fills = bookWalk(new Decimal('10'), [lvl('100', '3')], bps, 'quote', 'partial_then_reject_rest');
    expect(fills).toHaveLength(1);
    expect(fills[0]?.qty.toFixed()).toBe('3'); // 7 left unfilled
  });

  it('fills the remainder at the worst level when policy says so', () => {
    const fills = bookWalk(new Decimal('10'), [lvl('100', '3')], bps, 'quote', 'fill_at_worst_level');
    expect(fills).toHaveLength(2);
    expect(fills[1]?.price.toFixed()).toBe('100');
    expect(fills[1]?.qty.toFixed()).toBe('7');
  });

  it('returns nothing against an empty book even under fill_at_worst_level', () => {
    expect(bookWalk(new Decimal('5'), [], bps, 'quote', 'fill_at_worst_level')).toEqual([]);
  });

  it('stops once the order quantity is exhausted', () => {
    const fills = bookWalk(new Decimal('2'), [lvl('100', '2'), lvl('101', '5')], bps, 'quote', 'partial_then_reject_rest');
    expect(fills).toHaveLength(1);
  });
});

describe('tradeThroughFill (resting limit, §6.5)', () => {
  it('a resting BUY fills only from prints strictly below the limit, at the limit, maker', () => {
    const f = tradeThroughFill('BUY', price('100'), new Decimal('5'), { price: price('99'), qty: qty('2') }, bps, 'quote');
    expect(f).not.toBeNull();
    expect(f?.price.toFixed()).toBe('100'); // OUR limit, not the print price
    expect(f?.qty.toFixed()).toBe('2');
    expect(f?.liquidity).toBe('maker');
  });

  it('a print at or above the buy limit does not fill (back of the queue)', () => {
    expect(tradeThroughFill('BUY', price('100'), new Decimal('5'), { price: price('100'), qty: qty('2') }, bps, 'quote')).toBeNull();
  });

  it('a resting SELL fills only from prints strictly above the limit', () => {
    expect(tradeThroughFill('SELL', price('100'), new Decimal('5'), { price: price('101'), qty: qty('2') }, bps, 'quote')?.qty.toFixed()).toBe('2');
    expect(tradeThroughFill('SELL', price('100'), new Decimal('5'), { price: price('100'), qty: qty('2') }, bps, 'quote')).toBeNull();
  });

  it('caps the fill at the remaining quantity', () => {
    const f = tradeThroughFill('BUY', price('100'), new Decimal('1'), { price: price('99'), qty: qty('5') }, bps, 'quote');
    expect(f?.qty.toFixed()).toBe('1');
  });

  it('returns null when nothing remains to fill', () => {
    expect(tradeThroughFill('BUY', price('100'), new Decimal('0'), { price: price('99'), qty: qty('5') }, bps, 'quote')).toBeNull();
  });
});
