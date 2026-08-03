import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Decimal from 'decimal.js';
import { DrizzleExecutionStore } from '../../../../src/database/repositories/trading/drizzle-execution-store';
import type * as schema from '../../../../src/database/schemas/trading';
import type {
  PersistedOrderEvent,
  ReconciliationRow,
  EquitySample,
} from '../../../../src/ports/trading/execution';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';
import type { ApprovalProof } from '../../../../src/domain/trading/types/risk-decision';
import { reduce } from '../../../../src/domain/trading/oms/reducer';
import { price, qty } from '../../../../src/domain/common/types/money';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
  type ClientOrderId,
} from '../../../../src/domain/common/types/ids';

// A second intent id for the recovery/fill fixtures below, distinct from the trigger-order block's
// own IID so neither can quietly reuse the other's clientOrderId.
const IID2 = intentId('0190abcd-1234-7abc-89ab-0123456789ac');

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

// Defect A commit-1 (REJECT venue-reason persistence, 2026-07-16): appendOrderEvent's `payload`
// merges the serialized event with ev.reason (additive JSONB fields, NEW rows only — see
// serializeEvent/appendOrderEvent's own comments). Captures the payload sent to orders.appendEvent
// directly (updateState's own extra-stamps map, pinned above, carries no payload/reason).
describe('DrizzleExecutionStore.appendOrderEvent payload serialization (Defect A commit-1)', () => {
  let appendCalls: Array<{ payload: unknown }>;
  let store: DrizzleExecutionStore;

  beforeEach(() => {
    appendCalls = [];
    store = new DrizzleExecutionStore({} as NodePgDatabase<typeof schema>, {
      mode: 'testnet',
      runId: 'run-test',
      bootId: 'boot-test',
    });
    (store as unknown as { orders: unknown }).orders = {
      findByClientOrderId: () => Promise.resolve({ intentId: 'i1' }),
      appendEvent: (args: { payload: unknown }) => {
        appendCalls.push(args);
        return Promise.resolve({ inserted: true });
      },
      updateState: () => Promise.resolve(),
    };
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

  it('a REJECT with code/message round-trips both into the payload', async () => {
    await store.appendOrderEvent(
      ev({
        event: { type: 'REJECT', code: '-2022', message: 'ReduceOnly Order is rejected' },
        derivedState: 'REJECTED',
      }),
    );
    expect(appendCalls[0]!.payload).toEqual({
      type: 'REJECT',
      code: '-2022',
      message: 'ReduceOnly Order is rejected',
    });
  });

  it('a bare REJECT (no code/message) serializes byte-identically to before this feature', async () => {
    await store.appendOrderEvent(ev({ event: { type: 'REJECT' }, derivedState: 'REJECTED' }));
    expect(appendCalls[0]!.payload).toEqual({ type: 'REJECT' });
  });

  it('ev.reason merges into the payload when present', async () => {
    await store.appendOrderEvent(
      ev({
        event: { type: 'REJECT', code: '-2022', message: 'ReduceOnly Order is rejected' },
        derivedState: 'REJECTED',
        reason: '-2022:ReduceOnly Order is rejected',
      }),
    );
    expect(appendCalls[0]!.payload).toEqual({
      type: 'REJECT',
      code: '-2022',
      message: 'ReduceOnly Order is rejected',
      reason: '-2022:ReduceOnly Order is rejected',
    });
  });

  it('an event with no reason serializes byte-identically to before (no reason key)', async () => {
    await store.appendOrderEvent(
      ev({ event: { type: 'VENUE_CANCELED' }, derivedState: 'CANCELED' }),
    );
    expect(appendCalls[0]!.payload).toEqual({ type: 'VENUE_CANCELED' });
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
    // v3 (consolidation spec §2): trigger_price is now a real column — saveIntent forwards it.
    expect(captured()?.['triggerPrice']).toBe('95');
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
    expect(captured()?.['triggerPrice']).toBe('95');
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
    expect(captured()?.['triggerPrice']).toBeUndefined();
  });
});

// 2026-08-03: an errored pass — one that threw before finishing its axis chain — was persisted as
// result='CLEAN' whenever it happened to carry zero mismatches, with the truth only in the
// `PASS_ERROR:` detail string. The verdict column now carries it.
describe('DrizzleExecutionStore.saveReconciliation result mapping', () => {
  function storeWithCapturedRecon(): {
    store: DrizzleExecutionStore;
    captured: () => Record<string, unknown> | undefined;
  } {
    const store = new DrizzleExecutionStore({} as NodePgDatabase<typeof schema>, {
      mode: 'paper',
      runId: 'run-test',
      bootId: 'boot-test',
    });
    let captured: Record<string, unknown> | undefined;
    (store as unknown as { reconciliations: unknown }).reconciliations = {
      insert: (row: Record<string, unknown>) => {
        captured = row;
        return Promise.resolve();
      },
    };
    return { store, captured: () => captured };
  }

  const row = (over: Partial<ReconciliationRow> = {}): ReconciliationRow => ({
    ts: epochMs(1_800_000_000_000),
    venue: 'binance',
    mismatches: 0,
    halted: false,
    passError: false,
    detail: 'clean',
    durationMs: 10,
    openOrdersChecked: 1,
    tradesChecked: 1,
    balancesChecked: 1,
    ...over,
  });

  it('a pass that threw with ZERO mismatches persists ERROR, never CLEAN', async () => {
    const { store, captured } = storeWithCapturedRecon();
    await store.saveReconciliation(row({ passError: true, detail: 'PASS_ERROR:Error:db down' }));
    expect(captured()?.['result']).toBe('ERROR');
  });

  it('passError outranks halted — an errored pass is never reported as a completed HALT', async () => {
    const { store, captured } = storeWithCapturedRecon();
    await store.saveReconciliation(row({ passError: true, halted: true, mismatches: 3 }));
    expect(captured()?.['result']).toBe('ERROR');
  });

  it.each<[Partial<ReconciliationRow>, string]>([
    [{ halted: true, mismatches: 1 }, 'HALT'],
    [{ mismatches: 2 }, 'MISMATCH'],
    [{}, 'CLEAN'],
  ])('maps the pre-existing verdicts unchanged (%o → %s)', async (over, expected) => {
    const { store, captured } = storeWithCapturedRecon();
    await store.saveReconciliation(row(over));
    expect(captured()?.['result']).toBe(expected);
  });
});

// The reducer's dust rule is `residual < stepSize ⇒ FILLED`, so a recovered order carrying a
// synthesized flat '0.00000001' step needed an exact-to-the-satoshi fill to leave PARTIALLY_FILLED
// while a live order on the same symbol dust-completed normally — stranded forever, starving the
// clean reconcile stamp. The step now comes from the same DEFAULT_FILTERS table the sizer reads.
describe('DrizzleExecutionStore recovered-order stepSize (rowToOrderRecord)', () => {
  function storeWithOrderRow(row: Record<string, unknown>): DrizzleExecutionStore {
    const store = new DrizzleExecutionStore({} as NodePgDatabase<typeof schema>, {
      mode: 'paper',
      runId: 'run-test',
      bootId: 'boot-test',
    });
    (store as unknown as { orders: unknown }).orders = {
      findByClientOrderId: () => Promise.resolve(row),
    };
    return store;
  }

  const orderRow = (symbol: string) => ({
    clientOrderId: 'cbp' + 'a'.repeat(32),
    state: 'ACKED',
    qty: '1',
    cumQty: '0',
    venueOrderId: 'v1',
    symbol,
    venue: 'binance',
  });

  it('resolves the venue stepSize for a known symbol', async () => {
    const store = storeWithOrderRow(orderRow('BTC/USDT'));
    const rec = await store.loadOrderByClientOrderId(
      venueId('binance'),
      encodeClientOrderId(IID2, 'paper'),
    );
    expect(rec?.stepSize).toBe('0.00001'); // DEFAULT_FILTERS BTC/USDT LOT_SIZE
  });

  it('a recovered order whose residual sits under the venue step folds FILLED (it did not before)', async () => {
    const store = storeWithOrderRow(orderRow('BTC/USDT'));
    const rec = (await store.loadOrderByClientOrderId(
      venueId('binance'),
      encodeClientOrderId(IID2, 'paper'),
    ))!;
    // residual 0.000005 < step 0.00001 ⇒ dust ⇒ FILLED. Under the old flat '0.00000001' the same
    // fold left the order PARTIALLY_FILLED, which is the stranding this fix removes.
    expect(reduce(rec, { type: 'FILL', cumQty: new Decimal('0.999995') }).state).toBe('FILLED');
    expect(
      reduce({ ...rec, stepSize: '0.00000001' }, { type: 'FILL', cumQty: new Decimal('0.999995') })
        .state,
    ).toBe('PARTIALLY_FILLED');
  });

  it('a symbol outside DEFAULT_FILTERS keeps the fine fallback step', async () => {
    const store = storeWithOrderRow(orderRow('NOTLISTED/USDT'));
    const rec = await store.loadOrderByClientOrderId(
      venueId('binance'),
      encodeClientOrderId(IID2, 'paper'),
    );
    expect(rec?.stepSize).toBe('0.00000001');
  });
});

// (mode, venue, symbol, venue_trade_id) — 0002_fills_mode_scoped_uidx.sql. The DB-level guarantee
// is pinned in test/db/persistence.spec.ts (f1); these pin that the store actually SCOPES its two
// read paths by this run's mode rather than asking the unscoped question.
describe('DrizzleExecutionStore fill lookups are mode-scoped', () => {
  function storeWithCapturedFillReads(mode: 'paper' | 'testnet' | 'live'): {
    store: DrizzleExecutionStore;
    reads: unknown[][];
  } {
    const store = new DrizzleExecutionStore({} as NodePgDatabase<typeof schema>, {
      mode,
      runId: 'run-test',
      bootId: 'boot-test',
    });
    const reads: unknown[][] = [];
    (store as unknown as { fills: unknown }).fills = {
      fetchByTradeId: (...args: unknown[]) => {
        reads.push(args);
        return Promise.resolve(null);
      },
      insertIdempotent: () => Promise.resolve({ inserted: true }),
    };
    return { store, reads };
  }

  it('hasFill asks only about THIS run mode', async () => {
    const { store, reads } = storeWithCapturedFillReads('testnet');
    await store.hasFill(venueId('binance'), symbolId('BTC/USDT'), 'paper-trade-1');
    expect(reads[0]).toEqual(['testnet', 'binance', 'BTC/USDT', 'paper-trade-1']);
  });

  it('saveFill checks the existing row within THIS run mode', async () => {
    const { store, reads } = storeWithCapturedFillReads('paper');
    await store.saveFill(
      {
        venue: venueId('binance'),
        symbol: symbolId('BTC/USDT'),
        venueTradeId: 'paper-trade-1',
        clientOrderId: encodeClientOrderId(IID2, 'paper'),
        price: price('100'),
        qty: qty('1'),
        fee: null,
        liquidity: 'taker',
        venueTimestamp: epochMs(1),
        source: 'paper',
      },
      '',
    );
    expect(reads[0]).toEqual(['paper', 'binance', 'BTC/USDT', 'paper-trade-1']);
  });
});

// equity_curve.gap_annotation existed from 0000_v3_initial.sql with no writer at all; the sampler's
// MARK_FALLBACK provenance is its first one (see EquitySample.gapAnnotation).
describe('DrizzleExecutionStore.savePortfolioSample gap annotation', () => {
  function storeWithCapturedEquity(): {
    store: DrizzleExecutionStore;
    captured: () => Record<string, unknown> | undefined;
  } {
    let captured: Record<string, unknown> | undefined;
    const tx = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          captured ??= row; // the equity_curve insert is the first write in the transaction
          return Promise.resolve();
        },
      }),
    };
    const db = {
      transaction: (fn: (t: unknown) => Promise<void>) => fn(tx),
    } as unknown as NodePgDatabase<typeof schema>;
    const store = new DrizzleExecutionStore(db, {
      mode: 'paper',
      runId: 'run-test',
      bootId: 'boot-test',
    });
    (store as unknown as { positions: unknown }).positions = {
      replaceAll: () => Promise.resolve(),
    };
    return { store, captured: () => captured };
  }

  const sample = (over: Partial<EquitySample> = {}): EquitySample => ({
    ts: epochMs(1_800_000_000_000),
    equity: '100000',
    cash: '100000',
    unrealized: '0',
    peak: '100000',
    sessionDateUtc: '2027-01-15',
    ...over,
  });

  it('forwards the sampler annotation verbatim', async () => {
    const { store, captured } = storeWithCapturedEquity();
    await store.savePortfolioSample(sample({ gapAnnotation: 'MARK_FALLBACK:BTC/USDT' }), []);
    expect(captured()?.['gapAnnotation']).toBe('MARK_FALLBACK:BTC/USDT');
  });

  it('leaves the column null when every position had a live mark', async () => {
    const { store, captured } = storeWithCapturedEquity();
    await store.savePortfolioSample(sample(), []);
    expect(captured()?.['gapAnnotation']).toBeUndefined();
  });
});
