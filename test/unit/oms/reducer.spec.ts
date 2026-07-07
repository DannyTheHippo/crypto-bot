import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  reduce,
  initialOrder,
  TransitionError,
  isOrderState,
  ORDER_STATES,
  type OrderRecord,
  type OrderState,
  type OrderEvent,
} from '../../../src/domain/oms/reducer';
import { clientOrderId } from '../../../src/domain/types/ids';

const COID = clientOrderId('cbp0190abcd123407abc89ab0123456789ab');

function rec(state: OrderState, over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    clientOrderId: COID,
    state,
    qty: new Decimal('10'),
    cumQty: new Decimal(0),
    stepSize: '0.001',
    attempt: 0,
    cancelWanted: false,
    ...over,
  };
}
const fill = (cum: string): OrderEvent => ({ type: 'FILL', cumQty: new Decimal(cum) });

describe('OMS reducer (§6.1)', () => {
  it('initialOrder starts NEW with zero cumQty', () => {
    const r = initialOrder(COID, new Decimal('10'), '0.001');
    expect(r.state).toBe('NEW');
    expect(r.cumQty.toFixed()).toBe('0');
  });

  it('isOrderState accepts every known state and rejects anything else', () => {
    for (const s of ORDER_STATES) expect(isOrderState(s)).toBe(true);
    expect(isOrderState('FILLED')).toBe(true);
    expect(isOrderState('NOT_A_STATE')).toBe(false);
    expect(isOrderState('')).toBe(false);
  });

  describe('NEW', () => {
    it('SUBMIT_SENT → SUBMITTING (persist before HTTP write)', () => {
      expect(reduce(rec('NEW'), { type: 'SUBMIT_SENT' }).state).toBe('SUBMITTING');
    });
    it('CANCEL_REQUESTED → CANCELED (never sent)', () => {
      expect(reduce(rec('NEW'), { type: 'CANCEL_REQUESTED' }).state).toBe('CANCELED');
    });
    it('illegal event throws', () => {
      expect(() => reduce(rec('NEW'), fill('1'))).toThrow(TransitionError);
    });
  });

  describe('SUBMITTING', () => {
    it('ACK → ACKED records venueOrderId', () => {
      const r = reduce(rec('SUBMITTING'), { type: 'ACK', venueOrderId: 'v1' });
      expect(r.state).toBe('ACKED');
      expect(r.venueOrderId).toBe('v1');
    });
    it('REJECT → REJECTED', () => {
      expect(reduce(rec('SUBMITTING'), { type: 'REJECT' }).state).toBe('REJECTED');
    });
    it('SUBMIT_FAILED_NOT_SENT → NEW (attempt++), and → REJECTED past 3', () => {
      expect(reduce(rec('SUBMITTING'), { type: 'SUBMIT_FAILED_NOT_SENT' }).state).toBe('NEW');
      expect(
        reduce(rec('SUBMITTING', { attempt: 3 }), { type: 'SUBMIT_FAILED_NOT_SENT' }).state,
      ).toBe('REJECTED');
    });
    it('SUBMIT_AMBIGUOUS → SUBMIT_UNKNOWN', () => {
      expect(reduce(rec('SUBMITTING'), { type: 'SUBMIT_AMBIGUOUS' }).state).toBe('SUBMIT_UNKNOWN');
    });
    it('FILL is an implicit ack (WS beat REST)', () => {
      expect(reduce(rec('SUBMITTING'), fill('5')).state).toBe('PARTIALLY_FILLED');
      expect(reduce(rec('SUBMITTING'), fill('10')).state).toBe('FILLED');
    });
    it('VENUE_CANCELED/EXPIRED terminal via implicit ack', () => {
      expect(reduce(rec('SUBMITTING'), { type: 'VENUE_CANCELED' }).state).toBe('CANCELED');
      expect(reduce(rec('SUBMITTING'), { type: 'VENUE_EXPIRED' }).state).toBe('EXPIRED');
    });
    it('CANCEL_REQUESTED sets cancelWanted, stays SUBMITTING', () => {
      const r = reduce(rec('SUBMITTING'), { type: 'CANCEL_REQUESTED' });
      expect(r.state).toBe('SUBMITTING');
      expect(r.cancelWanted).toBe(true);
    });
    it('illegal event throws', () => {
      expect(() => reduce(rec('SUBMITTING'), { type: 'CANCEL_ACK' })).toThrow(TransitionError);
    });
  });

  describe('SUBMIT_UNKNOWN', () => {
    it.each<[OrderEvent, OrderState]>([
      [{ type: 'ACK', venueOrderId: 'v' }, 'ACKED'],
      [fill('3'), 'PARTIALLY_FILLED'],
      [{ type: 'VENUE_CANCELED' }, 'CANCELED'],
      [{ type: 'VENUE_EXPIRED' }, 'EXPIRED'],
      [{ type: 'REJECT' }, 'REJECTED'],
      [{ type: 'QUERY_NOT_FOUND' }, 'NEW'],
      [{ type: 'QUERY_NOT_FOUND_EXPIRED' }, 'CANCELED'],
      [{ type: 'QUERY_INCONCLUSIVE' }, 'RECONCILE_REQUIRED'],
    ])('%o resolves to %s', (ev, next) => {
      expect(reduce(rec('SUBMIT_UNKNOWN'), ev).state).toBe(next);
    });
    it('distinguishes TTL-live not-found (→NEW, resubmit-eligible) from TTL-expired (→CANCELED)', () => {
      // The resolver, not the reducer, owns the TTL check: the reducer must keep these two
      // events distinct so a lapsed intent is never resubmitted on its deterministic id.
      expect(reduce(rec('SUBMIT_UNKNOWN'), { type: 'QUERY_NOT_FOUND' }).state).toBe('NEW');
      expect(reduce(rec('SUBMIT_UNKNOWN'), { type: 'QUERY_NOT_FOUND_EXPIRED' }).state).toBe(
        'CANCELED',
      );
    });
    it('illegal event throws', () => {
      expect(() => reduce(rec('SUBMIT_UNKNOWN'), { type: 'CANCEL_ACK' })).toThrow(TransitionError);
    });
  });

  describe('ACKED / PARTIALLY_FILLED', () => {
    for (const s of ['ACKED', 'PARTIALLY_FILLED'] as const) {
      it(`${s}: fill, stale-fill drop, cancel-requested, venue terminal, illegal`, () => {
        expect(reduce(rec(s, { cumQty: new Decimal('1') }), fill('5')).state).toBe(
          'PARTIALLY_FILLED',
        );
        expect(reduce(rec(s, { cumQty: new Decimal('5') }), fill('3')).cumQty.toFixed()).toBe('5'); // stale ≤ current dropped
        expect(reduce(rec(s), fill('10')).state).toBe('FILLED');
        expect(reduce(rec(s), { type: 'CANCEL_REQUESTED' }).state).toBe('CANCEL_PENDING');
        expect(reduce(rec(s), { type: 'VENUE_CANCELED' }).state).toBe('CANCELED');
        expect(reduce(rec(s), { type: 'VENUE_EXPIRED' }).state).toBe('EXPIRED');
        expect(() => reduce(rec(s), { type: 'CANCEL_ACK' })).toThrow(TransitionError);
      });
    }
  });

  describe('CANCEL_PENDING', () => {
    it('CANCEL_ACK → CANCELED', () => {
      expect(reduce(rec('CANCEL_PENDING'), { type: 'CANCEL_ACK' }).state).toBe('CANCELED');
    });
    it('fills win the cancel race (partial keeps pending, full → FILLED)', () => {
      expect(reduce(rec('CANCEL_PENDING'), fill('5')).state).toBe('CANCEL_PENDING');
      expect(reduce(rec('CANCEL_PENDING'), fill('10')).state).toBe('FILLED');
    });
    it('ambiguous cancel reject → CANCEL_UNKNOWN', () => {
      expect(reduce(rec('CANCEL_PENDING'), { type: 'CANCEL_REJECT_UNKNOWN' }).state).toBe(
        'CANCEL_UNKNOWN',
      );
    });
    it('venue terminals adopted via reconciliation confirm the cancel (2026-07-07 strand)', () => {
      expect(reduce(rec('CANCEL_PENDING'), { type: 'VENUE_CANCELED' }).state).toBe('CANCELED');
      expect(reduce(rec('CANCEL_PENDING'), { type: 'VENUE_EXPIRED' }).state).toBe('EXPIRED');
    });
    it('illegal event throws', () => {
      expect(() => reduce(rec('CANCEL_PENDING'), { type: 'ACK', venueOrderId: 'v' })).toThrow(
        TransitionError,
      );
    });
  });

  describe('CANCEL_UNKNOWN', () => {
    it('fill, cancel-ack, not-found/inconclusive → reconcile, illegal', () => {
      expect(reduce(rec('CANCEL_UNKNOWN'), fill('4')).state).toBe('CANCEL_UNKNOWN');
      expect(reduce(rec('CANCEL_UNKNOWN'), fill('10')).state).toBe('FILLED');
      expect(reduce(rec('CANCEL_UNKNOWN'), { type: 'CANCEL_ACK' }).state).toBe('CANCELED');
      expect(reduce(rec('CANCEL_UNKNOWN'), { type: 'QUERY_NOT_FOUND' }).state).toBe(
        'RECONCILE_REQUIRED',
      );
      expect(reduce(rec('CANCEL_UNKNOWN'), { type: 'QUERY_INCONCLUSIVE' }).state).toBe(
        'RECONCILE_REQUIRED',
      );
      expect(() => reduce(rec('CANCEL_UNKNOWN'), { type: 'SUBMIT_SENT' })).toThrow(TransitionError);
    });
    it('venue terminals adopted via reconciliation resolve a recovered pending cancel', () => {
      expect(reduce(rec('CANCEL_UNKNOWN'), { type: 'VENUE_CANCELED' }).state).toBe('CANCELED');
      expect(reduce(rec('CANCEL_UNKNOWN'), { type: 'VENUE_EXPIRED' }).state).toBe('EXPIRED');
    });
  });

  describe('RECONCILE_REQUIRED', () => {
    it('still ingests fills, freezes everything else', () => {
      expect(reduce(rec('RECONCILE_REQUIRED'), fill('2')).cumQty.toFixed()).toBe('2');
      expect(() => reduce(rec('RECONCILE_REQUIRED'), { type: 'ACK', venueOrderId: 'v' })).toThrow(
        TransitionError,
      );
    });
  });

  describe('terminals (late cross-channel events)', () => {
    it('FILLED absorbs more fill detail but stays FILLED; drops stale', () => {
      expect(reduce(rec('FILLED', { cumQty: new Decimal('9') }), fill('10')).state).toBe('FILLED');
      expect(reduce(rec('FILLED', { cumQty: new Decimal('10') }), fill('5')).state).toBe('FILLED'); // stale fill dropped
    });
    it('a CANCELED order receiving real fills is a contradiction → RECONCILE_REQUIRED', () => {
      expect(reduce(rec('CANCELED'), fill('10')).state).toBe('RECONCILE_REQUIRED');
    });
    it('duplicate terminal events are no-ops', () => {
      expect(reduce(rec('CANCELED'), { type: 'VENUE_CANCELED' }).state).toBe('CANCELED');
      expect(reduce(rec('EXPIRED'), { type: 'VENUE_EXPIRED' }).state).toBe('EXPIRED');
      expect(reduce(rec('REJECTED'), { type: 'REJECT' }).state).toBe('REJECTED');
    });
    it('a second cancel confirmation (gate REST fold + paper outbox report) is a no-op', () => {
      expect(reduce(rec('CANCELED'), { type: 'CANCEL_ACK' }).state).toBe('CANCELED');
    });
    it('a contradicting terminal event freezes to RECONCILE_REQUIRED', () => {
      expect(reduce(rec('FILLED'), { type: 'REJECT' }).state).toBe('RECONCILE_REQUIRED');
    });
  });

  describe('fill invariants (I4)', () => {
    it('treats the dust residual as fully filled', () => {
      expect(reduce(rec('ACKED'), fill('9.9999')).state).toBe('FILLED'); // residual 0.0001 < step 0.001
    });
    it('throws on a cumQty overflow beyond qty + one step', () => {
      expect(() => reduce(rec('ACKED'), fill('10.002'))).toThrow(TransitionError);
    });
  });
});
