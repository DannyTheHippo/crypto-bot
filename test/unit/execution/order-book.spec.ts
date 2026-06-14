import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { OrderBookService } from '../../../src/modules/execution/order-book.service';
import { initialOrder } from '../../../src/domain/oms/reducer';
import { intentId } from '../../../src/domain/types/ids';
import { makeIntent } from './helpers';

const coid = makeIntent().clientOrderId;
const other = makeIntent({ intentId: intentId('0190abcd-1234-7abc-89ab-0123456789ff') }).clientOrderId;

describe('OrderBookService', () => {
  it('creates, reads, and folds events through the reducer', () => {
    const ob = new OrderBookService();
    ob.create(initialOrder(coid, new Decimal('1'), '0.001'));
    expect(ob.get(coid)?.state).toBe('NEW');
    expect(ob.apply(coid, { type: 'SUBMIT_SENT' }).state).toBe('SUBMITTING');
    expect(ob.all()).toHaveLength(1);
  });

  it('throws when applying an event to an unknown order', () => {
    const ob = new OrderBookService();
    expect(() => ob.apply(coid, { type: 'SUBMIT_SENT' })).toThrow(/unknown order/);
  });

  it('commit stores an already-reduced record', () => {
    const ob = new OrderBookService();
    ob.commit(initialOrder(coid, new Decimal('1'), '0.001'));
    expect(ob.get(coid)?.state).toBe('NEW');
  });

  it('setVenueOrderId records once, ignores when already set, and is a no-op for unknown orders', () => {
    const ob = new OrderBookService();
    ob.create(initialOrder(coid, new Decimal('1'), '0.001'));
    ob.setVenueOrderId(coid, 'v1');
    expect(ob.get(coid)?.venueOrderId).toBe('v1');
    ob.setVenueOrderId(coid, 'v2'); // already set → unchanged
    expect(ob.get(coid)?.venueOrderId).toBe('v1');
    ob.setVenueOrderId(other, 'vx'); // unknown → no throw, no entry
    expect(ob.get(other)).toBeUndefined();
  });
});
