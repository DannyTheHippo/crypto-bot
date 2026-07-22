import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { InMemoryExecutionStore } from '../../../src/features/trading/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import { makeIntent, makeFill, SID, V, SYM } from './helpers';
import type { ApprovalProof } from '../../../src/domain/types/risk-decision';
import { clientOrderId, epochMs, venueId } from '../../../src/domain/types/ids';
import { price, qty } from '../../../src/domain/types/money';
import type { Position } from '../../../src/domain/types/portfolio';

const proof: ApprovalProof = {
  intentHash: 'h',
  hmac: 'm',
  nonce: 'n',
  approvedAtMs: epochMs(1),
  ttlMs: 2000,
  limitsVersion: 'v1',
  snapshotSeq: 1n,
};

const SAMPLE = {
  ts: epochMs(1),
  equity: '100',
  cash: '100',
  unrealized: '0',
  peak: '100',
  sessionDateUtc: '2023-11-14',
};

const POS: Position = {
  strategyId: SID,
  venue: V,
  symbol: SYM,
  signedQty: new Decimal('1'),
  avgEntry: price('100'),
  realizedPnl: new Decimal('0'),
};

describe('InMemoryExecutionStore', () => {
  it('records intent + NEW order and exposes the state for the write-ahead pin', async () => {
    const store = new InMemoryExecutionStore();
    const intent = makeIntent();
    const rec = initialOrder(intent.clientOrderId, new Decimal('1'), '0.001');
    await store.saveIntent(intent, proof);
    await store.saveNewOrder(rec, intent);
    expect(store.stateOf(intent.clientOrderId)).toBe('NEW');
    expect(store.intents.has(intent.clientOrderId)).toBe(true);
  });

  it('appendOrderEvent updates state + carries venueOrderId; duplicate dedupeKey is a no-op', async () => {
    const store = new InMemoryExecutionStore();
    const intent = makeIntent();
    const rec = initialOrder(intent.clientOrderId, new Decimal('1'), '0.001');
    await store.saveNewOrder(rec, intent);

    const first = await store.appendOrderEvent({
      clientOrderId: intent.clientOrderId,
      dedupeKey: 'submit',
      event: { type: 'SUBMIT_SENT' },
      derivedState: 'SUBMITTING',
      cumQty: '0',
    });
    expect(first).toEqual({ applied: true });

    const acked = await store.appendOrderEvent({
      clientOrderId: intent.clientOrderId,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: 'v9' },
      derivedState: 'ACKED',
      cumQty: '0',
      venueOrderId: 'v9',
    });
    expect(acked).toEqual({ applied: true });
    expect(store.stateOf(intent.clientOrderId)).toBe('ACKED');
    expect(store.orders.get(intent.clientOrderId)?.venueOrderId).toBe('v9');

    const dup = await store.appendOrderEvent({
      clientOrderId: intent.clientOrderId,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: 'v9' },
      derivedState: 'RECONCILE_REQUIRED',
      cumQty: '0',
    });
    expect(dup).toEqual({ applied: false });
    expect(store.stateOf(intent.clientOrderId)).toBe('ACKED'); // unchanged by the dropped duplicate
  });

  it('saveFill is idempotent on (venue, symbol, tradeId); savePortfolioSample accumulates', async () => {
    const store = new InMemoryExecutionStore();
    const fill = makeFill();
    expect(await store.saveFill(fill, 'i1')).toEqual({ inserted: true, conflict: false });
    expect(await store.saveFill(fill, 'i1')).toEqual({ inserted: false, conflict: false }); // same payload — benign dup
    await store.savePortfolioSample(SAMPLE, [POS]);
    expect(store.equity).toHaveLength(1);
    expect(store.fills.size).toBe(1);
  });

  it('savePortfolioSample: loadRecoverySnapshot returns the stashed sample and positions', async () => {
    const store = new InMemoryExecutionStore();

    // Before any save: latest is null, positions is empty
    const empty = await store.loadRecoverySnapshot();
    expect(empty.latest).toBeNull();
    expect(empty.positions).toHaveLength(0);
    expect(empty.sodEquity).toBeNull();

    // After a save: latest and positions are returned
    await store.savePortfolioSample(SAMPLE, [POS]);
    const snap = await store.loadRecoverySnapshot();
    expect(snap.latest).toEqual(SAMPLE);
    expect(snap.sodEquity).toBeNull();
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.signedQty.toFixed()).toBe('1');
    expect(snap.positions[0]!.avgEntry.toFixed()).toBe('100');
  });

  it('loadOpenOrders always returns empty array', async () => {
    const store = new InMemoryExecutionStore();
    expect(await store.loadOpenOrders()).toEqual([]);
  });

  it('saveFill flags a same-tradeId, different-payload conflict (§6.6 I3)', async () => {
    const store = new InMemoryExecutionStore();
    await store.saveFill(makeFill({ qty: qty('1') }), 'i1');
    const conflicting = await store.saveFill(makeFill({ qty: qty('2') }), 'i1'); // same tradeId, different qty
    expect(conflicting).toEqual({ inserted: false, conflict: true });
    expect(store.fills.size).toBe(1); // the conflicting record is never written
  });

  // Defect A commit-1 (REJECT venue-reason persistence, 2026-07-16): the in-memory store pushes the
  // whole PersistedOrderEvent verbatim (never a serialized/stripped payload like the drizzle store),
  // so REJECT code/message and ev.reason already round-trip with no code change here — this pins
  // that as a regression, not an assumption.
  it('appendOrderEvent round-trips REJECT code/message and reason verbatim', async () => {
    const store = new InMemoryExecutionStore();
    const intent = makeIntent();
    const rec = initialOrder(intent.clientOrderId, new Decimal('1'), '0.001');
    await store.saveNewOrder(rec, intent);

    await store.appendOrderEvent({
      clientOrderId: intent.clientOrderId,
      dedupeKey: 'reject',
      event: { type: 'REJECT', code: '-2022', message: 'ReduceOnly Order is rejected' },
      derivedState: 'REJECTED',
      cumQty: '0',
      reason: '-2022:ReduceOnly Order is rejected',
    });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]!.event).toEqual({
      type: 'REJECT',
      code: '-2022',
      message: 'ReduceOnly Order is rejected',
    });
    expect(store.events[0]!.reason).toBe('-2022:ReduceOnly Order is rejected');
  });

  it('appendOrderEvent for an order whose saveNewOrder never landed carries qty 0, not undefined', async () => {
    // Write-ahead ordering means the orders row normally exists first; a crash between the two
    // writes leaves this shape, and the row must still be readable (qty falls back to '0').
    const store = new InMemoryExecutionStore();
    const intent = makeIntent();
    await store.appendOrderEvent({
      clientOrderId: intent.clientOrderId,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: 'v9' },
      derivedState: 'ACKED',
      cumQty: '0',
      venueOrderId: 'v9',
    });
    expect(store.orders.get(intent.clientOrderId)?.qty).toBe('0');
    expect(store.stateOf(intent.clientOrderId)).toBe('ACKED');
  });

  it('loadFilledQty sums only the fills carrying that clientOrderId', async () => {
    const store = new InMemoryExecutionStore();
    const mine = makeFill().clientOrderId;
    const foreign = clientOrderId('cbp' + '7'.repeat(32));
    await store.saveFill(makeFill({ venueTradeId: 't1', qty: qty('1.5') }), 'i1');
    await store.saveFill(makeFill({ venueTradeId: 't2', qty: qty('2.25') }), 'i1');
    // A second order's fill shares the table — it must never leak into the first order's total.
    await store.saveFill(
      makeFill({ venueTradeId: 't3', clientOrderId: foreign, qty: qty('9') }),
      'i2',
    );

    expect(await store.loadFilledQty(mine)).toBe('3.75'); // exact string, never toBeCloseTo
    expect(await store.loadFilledQty(foreign)).toBe('9');
    // An order with no fills at all still answers a well-formed zero (the resubmit-eligibility
    // check reads this before any fill can exist).
    expect(await store.loadFilledQty(clientOrderId('cbp' + '8'.repeat(32)))).toBe('0');
  });

  it('loadOrderByVenueOrderId reconstructs the durable record, skipping rows that do not match', async () => {
    const store = new InMemoryExecutionStore();
    // Seeded FIRST so the scan has to walk past a same-venue row with a different venueOrderId.
    const otherIntent = makeIntent({ clientOrderId: clientOrderId('cbp' + '1'.repeat(32)) });
    await store.saveNewOrder(
      initialOrder(otherIntent.clientOrderId, new Decimal('1'), '0.001'),
      otherIntent,
    );
    await store.appendOrderEvent({
      clientOrderId: otherIntent.clientOrderId,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: 'v1' },
      derivedState: 'ACKED',
      cumQty: '0',
      venueOrderId: 'v1',
    });

    const intent = makeIntent();
    await store.saveNewOrder(initialOrder(intent.clientOrderId, new Decimal('1'), '0.001'), intent);
    await store.appendOrderEvent({
      clientOrderId: intent.clientOrderId,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: 'v9' },
      derivedState: 'ACKED',
      cumQty: '0',
      venueOrderId: 'v9',
    });
    await store.appendOrderEvent({
      clientOrderId: intent.clientOrderId,
      dedupeKey: 'fill',
      event: { type: 'FILL', cumQty: new Decimal('0.4') },
      derivedState: 'PARTIALLY_FILLED',
      cumQty: '0.4',
    });

    const found = await store.loadOrderByVenueOrderId(V, 'v9');
    expect(found?.clientOrderId).toBe(intent.clientOrderId);
    expect(found?.state).toBe('PARTIALLY_FILLED');
    expect(found?.qty.toFixed()).toBe('1'); // exact strings — the caller folds a missed fill onto this
    expect(found?.cumQty.toFixed()).toBe('0.4');
    expect(found?.venueOrderId).toBe('v9');
    // Synthesized fields, same convention as DrizzleExecutionStore's rowToOrderRecord.
    expect(found?.stepSize).toBe('0.00000001');
    expect(found?.attempt).toBe(0);
    expect(found?.cancelWanted).toBe(false);

    // The key is (venue, venueOrderId): the same id on another venue is a different order.
    expect(await store.loadOrderByVenueOrderId(venueId('binanceusdm'), 'v9')).toBeNull();
    expect(await store.loadOrderByVenueOrderId(V, 'nope')).toBeNull();
  });

  it('hasFill answers on the full (venue, symbol, tradeId) idempotency key', async () => {
    const store = new InMemoryExecutionStore();
    await store.saveFill(makeFill({ venueTradeId: 't1' }), 'i1');
    expect(await store.hasFill(V, SYM, 't1')).toBe(true);
    expect(await store.hasFill(V, SYM, 't2')).toBe(false);
    expect(await store.hasFill(venueId('binanceusdm'), SYM, 't1')).toBe(false);
  });

  it('loadIntentByClientOrderId round-trips the saved intent and answers null for an unknown order', async () => {
    const store = new InMemoryExecutionStore();
    const intent = makeIntent();
    await store.saveIntent(intent, proof);
    const loaded = await store.loadIntentByClientOrderId(intent.clientOrderId);
    expect(loaded?.intentId).toBe(intent.intentId);
    expect(loaded?.source.dedupeKey).toBe('k'); // the field resting-order-role classification reads
    expect(await store.loadIntentByClientOrderId(clientOrderId('cbp' + '2'.repeat(32)))).toBeNull();
  });

  it('saveReconciliation accumulates rows', async () => {
    const store = new InMemoryExecutionStore();
    await store.saveReconciliation({
      ts: epochMs(1),
      venue: 'binance',
      mismatches: 0,
      halted: false,
      detail: 'clean',
    });
    expect(store.reconciliations).toHaveLength(1);
  });
});
