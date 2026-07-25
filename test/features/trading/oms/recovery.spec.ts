import { describe, it, expect } from 'vitest';
import { recoveryEventFor, isUnresolved } from '../../../../src/domain/trading/oms/recovery';
import type { OrderState } from '../../../../src/domain/trading/oms/reducer';

describe('recoveryEventFor (§6.1 crash recovery, I1)', () => {
  it('degrades SUBMITTING to the SUBMIT_UNKNOWN path', () => {
    expect(recoveryEventFor('SUBMITTING')).toEqual({ type: 'SUBMIT_AMBIGUOUS' });
  });
  it('degrades CANCEL_PENDING to the CANCEL_UNKNOWN path', () => {
    expect(recoveryEventFor('CANCEL_PENDING')).toEqual({ type: 'CANCEL_REJECT_UNKNOWN' });
  });
  it('leaves durable states untouched (no degrade to an optimistic state)', () => {
    for (const s of [
      'NEW',
      'ACKED',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCELED',
      'REJECTED',
      'EXPIRED',
      'SUBMIT_UNKNOWN',
      'CANCEL_UNKNOWN',
      'RECONCILE_REQUIRED',
    ] as OrderState[]) {
      expect(recoveryEventFor(s)).toBeUndefined();
    }
  });
});

describe('isUnresolved (live-arming gate)', () => {
  it('is true for the unknown + frozen states', () => {
    expect(isUnresolved('SUBMIT_UNKNOWN')).toBe(true);
    expect(isUnresolved('CANCEL_UNKNOWN')).toBe(true);
    expect(isUnresolved('RECONCILE_REQUIRED')).toBe(true);
  });
  it('is false for normal lifecycle + terminal states', () => {
    for (const s of [
      'NEW',
      'SUBMITTING',
      'ACKED',
      'PARTIALLY_FILLED',
      'CANCEL_PENDING',
      'FILLED',
      'CANCELED',
      'REJECTED',
      'EXPIRED',
    ] as OrderState[]) {
      expect(isUnresolved(s)).toBe(false);
    }
  });
});
