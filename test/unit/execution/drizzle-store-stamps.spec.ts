import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Decimal from 'decimal.js';
import { DrizzleExecutionStore } from '../../../src/database/repositories/drizzle-execution-store';
import type * as schema from '../../../src/database/schemas/trading';
import type { PersistedOrderEvent } from '../../../src/ports/execution';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import type { ApprovalProof } from '../../../src/domain/types/risk-decision';
import { price, qty } from '../../../src/domain/types/money';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
  type ClientOrderId,
} from '../../../src/domain/types/ids';

// Backlog #40: the appendOrderEvent chokepoint stamps submittedAt/ackedAt/firstFillAt (journal-time
// wall clock, the W7 terminalAt convention) keyed on the EVENT type — the repository's COALESCE
// write makes them first-write-wins at the SQL layer (exercised by the db suite; this spec pins the
// mapping the chokepoint sends).
describe('DrizzleExecutionStore.appendOrderEvent lifecycle stamps (#40)', () => {
  const T = 1_752_000_000_000;
  let updateStateCalls: Array<[string, string, string, Record<string, unknown> | undefined]>;
  let store: DrizzleExecutionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    updateStateCalls = [];
    store = new DrizzleExecutionStore({} as NodePgDatabase<typeof schema>, {
      mode: 'testnet',
      runId: 'run-test',
      bootId: 'boot-test',
    });
    // The store constructs its repositories internally from `db`; patch the private `orders`
    // field with a capturing fake — the only seam short of a live database.
    (store as unknown as { orders: unknown }).orders = {
      findByClientOrderId: () => Promise.resolve({ intentId: 'i1' }),
      appendEvent: () => Promise.resolve({ inserted: true }),
      updateState: (...args: [string, string, string, Record<string, unknown> | undefined]) => {
        updateStateCalls.push(args);
        return Promise.resolve();
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function ev(over: Partial<PersistedOrderEvent>): PersistedOrderEvent {
    return {
      clientOrderId: 'cbt-test-1' as ClientOrderId,
      dedupeKey: 'k',
      event: { type: 'SUBMIT_SENT' },
      derivedState: 'SUBMITTING',
      cumQty: '0',
      ...over,
    };
  }

  it('SUBMIT_SENT stamps submittedAt only', async () => {
    await store.appendOrderEvent(
      ev({ event: { type: 'SUBMIT_SENT' }, derivedState: 'SUBMITTING' }),
    );
    const extra = updateStateCalls[0]![3]!;
    expect(extra.submittedAt).toBe(T);
    expect(extra.ackedAt).toBeUndefined();
    expect(extra.firstFillAt).toBeUndefined();
    expect(extra.terminalAt).toBeUndefined();
  });

  it('ACK stamps ackedAt only', async () => {
    await store.appendOrderEvent(
      ev({ event: { type: 'ACK', venueOrderId: 'v1' }, derivedState: 'ACKED', venueOrderId: 'v1' }),
    );
    const extra = updateStateCalls[0]![3]!;
    expect(extra.ackedAt).toBe(T);
    expect(extra.submittedAt).toBeUndefined();
    expect(extra.firstFillAt).toBeUndefined();
  });

  it('a partial FILL stamps firstFillAt without terminalAt; a full FILL stamps both', async () => {
    await store.appendOrderEvent(
      ev({
        event: { type: 'FILL', cumQty: new Decimal('0.5') },
        derivedState: 'PARTIALLY_FILLED',
        cumQty: '0.5',
      }),
    );
    const partial = updateStateCalls[0]![3]!;
    expect(partial.firstFillAt).toBe(T);
    expect(partial.terminalAt).toBeUndefined();

    await store.appendOrderEvent(
      ev({
        dedupeKey: 'k2',
        event: { type: 'FILL', cumQty: new Decimal('1') },
        derivedState: 'FILLED',
        cumQty: '1',
      }),
    );
    const full = updateStateCalls[1]![3]!;
    expect(full.firstFillAt).toBe(T);
    expect(full.terminalAt).toBe(T);
  });

  it('a cancel terminal stamps terminalAt but none of the lifecycle stamps', async () => {
    await store.appendOrderEvent(
      ev({ event: { type: 'VENUE_CANCELED' }, derivedState: 'CANCELED' }),
    );
    const extra = updateStateCalls[0]![3]!;
    expect(extra.terminalAt).toBe(T);
    expect(extra.submittedAt).toBeUndefined();
    expect(extra.ackedAt).toBeUndefined();
    expect(extra.firstFillAt).toBeUndefined();
  });
});

// Push 3 P7b: persistedOrderType() now passes STOP_LOSS_LIMIT/STOP_MARKET through unchanged
// (order_intents.type/orders.type are plain unconstrained text — verified against
// drizzle/0000_initial.sql — so no migration was needed, only the TS-level IntentInsert/OrderInsert
// widening).
describe('DrizzleExecutionStore trigger-order persistence pass-through (Push 3 P7b)', () => {
  const IID = intentId('0190abcd-1234-7abc-89ab-0123456789ab');
  const proof: ApprovalProof = {
    intentHash: 'h',
    hmac: 'm',
    nonce: 'n',
    approvedAtMs: epochMs(1),
    ttlMs: 1000,
    limitsVersion: 'v1',
    snapshotSeq: 1n,
  };

  function makeIntent(o: Partial<OrderIntent> = {}): OrderIntent {
    return {
      intentId: IID,
      clientOrderId: encodeClientOrderId(IID, 'paper'),
      strategyId: strategyId('s1'),
      venue: venueId('binance'),
      symbol: symbolId('BTC/USDT'),
      side: 'SELL',
      type: 'LIMIT',
      qty: qty('1'),
      timeInForce: 'GTC',
      reduceOnly: true,
      mode: 'paper',
      refPrice: price('100'),
      refSeq: 1n,
      createdAt: epochMs(0),
      expiresAt: epochMs(10_000),
      source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 1n, strength: 1 },
      ...o,
    };
  }

  function storeWithCapturedIntent(): {
    store: DrizzleExecutionStore;
    captured: () => Record<string, unknown> | undefined;
  } {
    const store = new DrizzleExecutionStore({} as NodePgDatabase<typeof schema>, {
      mode: 'paper',
      runId: 'run-test',
      bootId: 'boot-test',
    });
    let captured: Record<string, unknown> | undefined;
    (store as unknown as { intents: unknown }).intents = {
      insert: (row: Record<string, unknown>) => {
        captured = row;
        return Promise.resolve();
      },
    };
    return { store, captured: () => captured };
  }

  function storeWithCapturedOrder(): {
    store: DrizzleExecutionStore;
    captured: () => Record<string, unknown> | undefined;
  } {
    const store = new DrizzleExecutionStore({} as NodePgDatabase<typeof schema>, {
      mode: 'paper',
      runId: 'run-test',
      bootId: 'boot-test',
    });
    let captured: Record<string, unknown> | undefined;
    (store as unknown as { orders: unknown }).orders = {
      insert: (row: Record<string, unknown>) => {
        captured = row;
        return Promise.resolve();
      },
    };
    return { store, captured: () => captured };
  }

  it('saveIntent persists a STOP_MARKET trigger intent (perp) without throwing', async () => {
    const { store, captured } = storeWithCapturedIntent();
    await store.saveIntent(
      makeIntent({ type: 'STOP_MARKET', triggerPrice: price('95'), limitPrice: undefined }),
      proof,
    );
    expect(captured()?.['type']).toBe('STOP_MARKET');
  });

  it('saveIntent persists a STOP_LOSS_LIMIT trigger intent (spot) without throwing', async () => {
    const { store, captured } = storeWithCapturedIntent();
    await store.saveIntent(
      makeIntent({
        type: 'STOP_LOSS_LIMIT',
        triggerPrice: price('95'),
        limitPrice: price('94.53'),
      }),
      proof,
    );
    expect(captured()?.['type']).toBe('STOP_LOSS_LIMIT');
  });

  it('saveNewOrder persists a STOP_LOSS_LIMIT trigger order without throwing', async () => {
    const { store, captured } = storeWithCapturedOrder();
    await store.saveNewOrder(
      {
        clientOrderId: encodeClientOrderId(IID, 'paper'),
        state: 'NEW',
        qty: qty('1'),
        cumQty: new Decimal(0),
        stepSize: '0.001',
        attempt: 0,
        cancelWanted: false,
      },
      makeIntent({
        type: 'STOP_LOSS_LIMIT',
        triggerPrice: price('95'),
        limitPrice: price('94.53'),
      }),
    );
    expect(captured()?.['type']).toBe('STOP_LOSS_LIMIT');
  });

  it('still persists ordinary LIMIT intents byte-identically (no trigger fields)', async () => {
    const { store, captured } = storeWithCapturedIntent();
    await store.saveIntent(makeIntent({ type: 'LIMIT', limitPrice: price('100') }), proof);
    expect(captured()?.['type']).toBe('LIMIT');
  });
});
