import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { InMemoryExecutionStore } from '../../../src/features/trading/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import { makeIntent, makeFill, SID, V, SYM } from './helpers';
import type { ApprovalProof } from '../../../src/domain/types/risk-decision';
import { epochMs } from '../../../src/domain/types/ids';
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
