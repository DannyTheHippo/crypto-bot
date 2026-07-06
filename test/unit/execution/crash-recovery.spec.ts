import { describe, it, expect } from 'vitest';
import { CrashRecoveryService } from '../../../src/features/trading/execution/crash-recovery.service';
import { InMemoryInstanceLock } from '../../../src/features/trading/execution/in-memory-instance-lock';
import { OrderBookService } from '../../../src/features/trading/execution/order-book.service';
import { InMemoryExecutionStore } from '../../../src/features/trading/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import { makeIntent } from './helpers';
import { encodeClientOrderId, intentId } from '../../../src/domain/types/ids';

function build() {
  const store = new InMemoryExecutionStore();
  const orders = new OrderBookService();
  const recovery = new CrashRecoveryService(store, orders);
  return { store, orders, recovery };
}

const coidB = encodeClientOrderId(intentId('0190bbbb-1234-7abc-89ab-0123456789ab'), 'paper');

describe('CrashRecoveryService (§6.1)', () => {
  it('degrades SUBMITTING → SUBMIT_UNKNOWN and CANCEL_PENDING → CANCEL_UNKNOWN, leaving others', async () => {
    const ctx = build();
    const submitting = makeIntent().clientOrderId;
    ctx.orders.create(initialOrder(submitting, makeIntent().qty, '0.001'));
    ctx.orders.apply(submitting, { type: 'SUBMIT_SENT' }); // SUBMITTING

    ctx.orders.create(initialOrder(coidB, makeIntent().qty, '0.001'));
    ctx.orders.apply(coidB, { type: 'SUBMIT_SENT' });
    ctx.orders.apply(coidB, { type: 'ACK', venueOrderId: 'v' });
    ctx.orders.apply(coidB, { type: 'CANCEL_REQUESTED' }); // CANCEL_PENDING

    const degraded = await ctx.recovery.recoverOnBoot();

    expect(ctx.orders.get(submitting)?.state).toBe('SUBMIT_UNKNOWN');
    expect(ctx.orders.get(coidB)?.state).toBe('CANCEL_UNKNOWN');
    expect(degraded).toHaveLength(2);
    expect(ctx.store.events.map((e) => e.derivedState).sort()).toEqual([
      'CANCEL_UNKNOWN',
      'SUBMIT_UNKNOWN',
    ]);
  });

  it('leaves a terminal/acked order untouched and reports no degrade', async () => {
    const ctx = build();
    const coid = makeIntent().clientOrderId;
    ctx.orders.create(initialOrder(coid, makeIntent().qty, '0.001'));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
    ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v' }); // ACKED — durable, not degraded
    const degraded = await ctx.recovery.recoverOnBoot();
    expect(degraded).toHaveLength(0);
    expect(ctx.orders.get(coid)?.state).toBe('ACKED');
  });

  it('does not re-degrade when the recovery event is already journaled (idempotent re-run)', async () => {
    const ctx = build();
    const coid = makeIntent().clientOrderId;
    ctx.orders.create(initialOrder(coid, makeIntent().qty, '0.001'));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' }); // SUBMITTING
    await ctx.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey: 'recover:SUBMIT_AMBIGUOUS',
      event: { type: 'SUBMIT_AMBIGUOUS' },
      derivedState: 'SUBMIT_UNKNOWN',
      cumQty: '0',
    });
    const degraded = await ctx.recovery.recoverOnBoot();
    expect(degraded).toHaveLength(0); // journal already had it — commit skipped
    expect(ctx.orders.get(coid)?.state).toBe('SUBMITTING'); // not committed in memory
  });

  it('hasUnresolvedOrders reflects the live-arming gate', async () => {
    const ctx = build();
    expect(ctx.recovery.hasUnresolvedOrders()).toBe(false); // empty book
    const coid = makeIntent().clientOrderId;
    ctx.orders.create(initialOrder(coid, makeIntent().qty, '0.001'));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
    await ctx.recovery.recoverOnBoot(); // → SUBMIT_UNKNOWN
    expect(ctx.recovery.hasUnresolvedOrders()).toBe(true);
  });
});

describe('InMemoryInstanceLock (§1 single-writer guard)', () => {
  it('acquires a free key and rejects a second acquire (double bootstrap)', async () => {
    const lock = new InMemoryInstanceLock();
    await lock.acquire('binance', 'fp-1');
    await expect(lock.acquire('binance', 'fp-1')).rejects.toThrow(/already held/);
  });

  it('allows re-acquire after release', async () => {
    const lock = new InMemoryInstanceLock();
    await lock.acquire('binance', 'fp-1');
    await lock.release();
    await expect(lock.acquire('binance', 'fp-2')).resolves.toBeUndefined();
  });
});
