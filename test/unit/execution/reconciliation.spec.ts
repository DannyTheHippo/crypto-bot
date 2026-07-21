import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import type { Counter, Gauge } from 'prom-client';
import { ReconciliationService } from '../../../src/features/trading/execution/reconciliation.service';
import { OrderBookService } from '../../../src/features/trading/execution/order-book.service';
import { PortfolioStateService } from '../../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/features/trading/execution/fee-ledger.service';
import { EquitySamplerService } from '../../../src/features/trading/execution/equity-sampler.service';
import { FillIngestorService } from '../../../src/features/trading/execution/fill-ingestor.service';
import { InMemoryExecutionStore } from '../../../src/features/trading/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import type {
  ExchangePort,
  ExchangeOrderState,
  VenueFill,
  VenuePosition,
} from '../../../src/ports/exchange';
import type { ReconConfig } from '../../../src/ports/execution';
import type { VenueRuntimeDescriptor } from '../../../src/ports/venue-registry';
import {
  encodeClientOrderId,
  intentId,
  epochMs,
  venueId,
  type VenueId,
} from '../../../src/domain/types/ids';
import { price, qty } from '../../../src/domain/types/money';
import { makeIntent, makeFill, fixedFeed, killSwitchStub, SYM, V, T } from './helpers';

const CFG: ReconConfig = {
  epsAbs: '0.00000001',
  epsRel: '0.0001',
  overlapMs: 300_000,
  driftPasses: 3,
  balanceAxis: true,
  sweepSymbols: [],
};
const OTHER_COID = encodeClientOrderId(intentId('0190ffff-1234-7abc-89ab-0123456789ab'), 'paper');

interface ExchangeScript {
  openOrders?: ExchangeOrderState[];
  openOrdersThrow?: boolean;
  fetchOrder?: () => ExchangeOrderState;
  trades?: VenueFill[];
  tradesThrow?: boolean;
  balances?: () => Map<string, { free: string; locked: string }>;
  balancesThrow?: boolean;
  // Absent (both undefined) leaves ExchangePort.fetchPositions undefined, matching a spot/paper
  // adapter — the position axis must skip entirely, exactly the pre-Defect-A behavior.
  positions?: () => VenuePosition[];
  positionsThrow?: boolean;
}

function build(
  script: ExchangeScript = {},
  mismatchCounter?: Counter<string>,
  runsCounter?: Counter<string>,
  lastSuccessGauge?: Gauge<string>,
  cfgOver: Partial<ReconConfig> = {},
) {
  let nowMs = T;
  const clock = { now: () => epochMs(nowMs) };
  const store = new InMemoryExecutionStore();
  const orders = new OrderBookService();
  const portfolio = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
  const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), clock, store);
  const { ks, engages } = killSwitchStub();
  const ingestor = new FillIngestorService(store, ks, orders, portfolio, sampler);

  const exchange: ExchangePort = {
    venue: V,
    capabilities: {
      clientOrderId: true,
      fetchOrderByClientId: true,
      wsUserStream: true,
      stp: false,
      sandbox: true,
    },
    placeOrder: () => Promise.reject(new Error('unused')),
    cancelOrder: () => Promise.reject(new Error('unused')),
    fetchOrder: () =>
      Promise.resolve(
        (
          script.fetchOrder ??
          (() => {
            throw new Error('no fetchOrder');
          })
        )(),
      ),
    fetchOpenOrders: () =>
      script.openOrdersThrow
        ? Promise.reject(new Error('open orders down'))
        : Promise.resolve(script.openOrders ?? []),
    fetchBalances: () =>
      script.balancesThrow
        ? Promise.reject(new Error('balances down'))
        : Promise.resolve(
            script.balances
              ? script.balances()
              : new Map([['USDT', { free: '100000', locked: '0' }]]),
          ),
    fetchMyTrades: () =>
      script.tradesThrow
        ? Promise.reject(new Error('trades down'))
        : Promise.resolve(script.trades ?? []),
    validateCredentials: () => Promise.reject(new Error('unused')),
    ...(script.positions !== undefined || script.positionsThrow
      ? {
          fetchPositions: () =>
            script.positionsThrow
              ? Promise.reject(new Error('positions down'))
              : Promise.resolve(script.positions!()),
        }
      : {}),
  };

  const recon = new ReconciliationService(
    clock,
    exchange,
    store,
    ks,
    { ...CFG, ...cfgOver },
    orders,
    portfolio,
    ingestor,
    mismatchCounter,
    runsCounter,
    lastSuccessGauge,
  );
  return {
    store,
    orders,
    portfolio,
    recon,
    engages,
    setNow: (t: number) => {
      nowMs = t;
    },
  };
}

type Ctx = ReturnType<typeof build>;

function seedOpenOrder(
  ctx: Ctx,
  coid = makeIntent().clientOrderId,
  over: Partial<ReturnType<typeof makeIntent>> = {},
  venueOrderId = 'v1',
) {
  const intent = makeIntent({ clientOrderId: coid, ...over });
  ctx.orders.create(initialOrder(coid, intent.qty, '0.001'));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  ctx.orders.apply(coid, { type: 'ACK', venueOrderId });
  ctx.portfolio.addInFlight(intent);
  ctx.portfolio.openOrder(intent.strategyId, {
    clientOrderId: coid,
    symbol: SYM,
    side: 'BUY',
    qty: intent.qty,
    limitPrice: price('100'),
  });
  return coid;
}

const venueOrder = (coid: string, status: ExchangeOrderState['status']): ExchangeOrderState => ({
  clientOrderId: coid as ExchangeOrderState['clientOrderId'],
  venueOrderId: 'v1',
  symbol: SYM,
  status,
  cumQty: '0',
  qty: '1',
});

const trade = (coid: string, tradeId: string): VenueFill => ({
  venue: V,
  symbol: SYM,
  venueTradeId: tradeId,
  clientOrderId: coid as VenueFill['clientOrderId'],
  price: '100',
  qty: '1',
  fee: null,
  liquidity: 'taker',
  venueTimestamp: epochMs(T),
});

describe('ReconciliationService (§6.4)', () => {
  it("sweeps a held position's symbol and stays clean when the venue ledger agrees", async () => {
    const intent = makeIntent(); // BUY 1 BTC @ 100
    const ctx = build({
      balances: () =>
        new Map([
          ['USDT', { free: '99900', locked: '0' }],
          ['BTC', { free: '1', locked: '0' }],
        ]),
    });
    ctx.portfolio.applyFill(intent, makeFill({ qty: intent.qty, price: intent.refPrice })); // creates the position
    const r = await ctx.recon.reconcile();
    expect(r).toEqual({ mismatches: 0, halted: false }); // position symbol swept, balances agree
  });

  it('increments reconciliation_mismatch_total with the mismatch class label (#24): a foreign open order counts as foreign_open_order', async () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    // A foreign venue open order is a WARN mismatch (count 1) — a deterministic non-zero pass.
    // SYM is in the configured sweep set (no local state yet — the per-symbol sweep must still run).
    const ctx = build(
      { openOrders: [venueOrder('someoneElseOrder', 'open')] },
      counter,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBeGreaterThan(0);
    expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      { class: 'foreign_open_order' },
      r.mismatches,
    ]);
  });

  it('records reconciliation_runs_total{venue,result} and stamps last-success only on a clean pass', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const lastSuccess = { set: vi.fn() } as unknown as Gauge<string>;
    const incCalls = (runs.inc as ReturnType<typeof vi.fn>).mock.calls;
    const setCalls = (lastSuccess.set as ReturnType<typeof vi.fn>).mock.calls;

    // clean pass → result 'clean', gauge set to clock-now/1000
    const clean = build({}, undefined, runs, lastSuccess);
    await clean.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ venue: V, result: 'clean' }]);
    expect(setCalls.at(-1)).toEqual([T / 1000]);

    // mismatch pass (foreign open order) → result 'mismatch', no new gauge set
    const setCountAfterClean = setCalls.length;
    const mismatch = build(
      { openOrders: [venueOrder('someoneElseOrder', 'open')] },
      undefined,
      runs,
      lastSuccess,
      { sweepSymbols: [SYM] },
    );
    await mismatch.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ venue: V, result: 'mismatch' }]);
    expect(setCalls.length).toBe(setCountAfterClean); // gauge unchanged on a non-clean pass

    // halt pass (our-prefix unknown open) → result 'halt'
    const halt = build(
      { openOrders: [venueOrder(OTHER_COID, 'open')] },
      undefined,
      runs,
      lastSuccess,
      { sweepSymbols: [SYM] },
    );
    await halt.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ venue: V, result: 'halt' }]);
  });

  it('a clean pass: no mismatches, not halted, one reconciliations row', async () => {
    const ctx = build();
    const r = await ctx.recon.reconcile();
    expect(r).toEqual({ mismatches: 0, halted: false });
    expect(ctx.store.reconciliations).toHaveLength(1);
    expect(ctx.store.reconciliations[0]!.detail).toBe('clean');
    expect(ctx.engages).toHaveLength(0);
  });

  it('a foreign venue open order is a WARN mismatch, not a halt', async () => {
    const ctx = build(
      { openOrders: [venueOrder('someoneElseOrder', 'open')] },
      undefined,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
  });

  it('our-prefix venue open order unknown locally HALTs (no auto-cancel)', async () => {
    const ctx = build(
      { openOrders: [venueOrder(OTHER_COID, 'open')] },
      undefined,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages[0]!.flatten).toBe(false); // HALT, never auto-flatten
    expect(ctx.engages[0]!.reason).toContain('UNKNOWN_OURS_OPEN');
  });

  it('labels a halting class and a benign class separately on one pass (#24): unknown_ours_open + foreign_open_order', async () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(
      { openOrders: [venueOrder(OTHER_COID, 'open'), venueOrder('someoneElseOrder', 'open')] },
      counter,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(2);
    const calls = (counter.inc as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toContainEqual([{ class: 'unknown_ours_open' }, 1]);
    expect(calls).toContainEqual([{ class: 'foreign_open_order' }, 1]);
  });

  it('labels a failed per-symbol sweep as sweep_failure (#24)', async () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build({ openOrdersThrow: true }, counter);
    seedOpenOrder(ctx);
    await ctx.recon.reconcile();
    expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      { class: 'sweep_failure' },
      1,
    ]);
  });

  it('a failed per-symbol open-order sweep is a WARN mismatch and skips terminal adoption', async () => {
    const ctx = build({ openOrdersThrow: true });
    const coid = seedOpenOrder(ctx); // SYM has local state → swept → the sweep fails
    const r = await ctx.recon.reconcile();
    // Exactly the sweep-failure mismatch: adoptTerminal must NOT run (its fetchOrder stub would
    // throw and add a second mismatch if it did).
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // absence ≠ venue truth when the fetch failed
  });

  it('balanceAxis=false skips the balances axis entirely (shared demo account)', async () => {
    const ctx = build(
      { balances: () => new Map([['USDT', { free: '90000', locked: '0' }]]) }, // would be BALANCE_DRIFT
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    const r = await ctx.recon.reconcile();
    expect(r).toEqual({ mismatches: 0, halted: false });
    expect(ctx.engages).toHaveLength(0);
  });

  it('configured sweepSymbols are swept even with zero local state', async () => {
    // No orders, no positions — only the config names SYM; the failing trade sweep proves it ran.
    const ctx = build({ tradesThrow: true }, undefined, undefined, undefined, {
      sweepSymbols: [SYM],
    });
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
  });

  it('an axis throw past the per-item guards records result=error + PASS_ERROR row, then rethrows', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const coid = makeIntent().clientOrderId;
    const ctx = build(
      { openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'boom-1')] },
      undefined,
      runs,
    );
    seedOpenOrder(ctx, coid);
    // The ingest path's store write throwing is exactly the kind of escape the pass accounting must
    // survive: the row and the runs counter still land, and the driver sees the rethrow.
    ctx.store.saveFill = () => {
      throw new Error('db down');
    };
    await expect(ctx.recon.reconcile()).rejects.toThrow('db down');
    expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      { venue: V, result: 'error' },
    ]);
    expect(ctx.store.reconciliations).toHaveLength(1);
    expect(ctx.store.reconciliations[0]!.detail).toBe('PASS_ERROR:Error:db down');
    expect(ctx.store.reconciliations[0]!.halted).toBe(false);
  });

  it('a non-Error axis throw is described by type in the PASS_ERROR detail', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'boom-2')] });
    seedOpenOrder(ctx, coid);
    ctx.store.saveFill = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch
      throw 'string failure';
    };
    await expect(ctx.recon.reconcile()).rejects.toBe('string failure');
    expect(ctx.store.reconciliations[0]!.detail).toBe('PASS_ERROR:string:string failure');
  });

  it.each<[ExchangeOrderState['status'], string]>([
    ['canceled', 'CANCELED'],
    ['expired', 'EXPIRED'],
  ])(
    'a local open order absent from the venue adopts the venue terminal truth (%s)',
    async (status, expected) => {
      const ctx = build({
        openOrders: [],
        fetchOrder: () => venueOrder(makeIntent().clientOrderId, status),
      });
      const coid = seedOpenOrder(ctx);
      const r = await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe(expected);
      expect(r.mismatches).toBeGreaterThan(0);
      expect(r.halted).toBe(false);
    },
  );

  it('a venue "rejected" for an order we already acked is a WARN inconsistency, not an illegal adopt', async () => {
    const ctx = build({
      openOrders: [],
      fetchOrder: () => venueOrder(makeIntent().clientOrderId, 'rejected'),
    });
    const coid = seedOpenOrder(ctx);
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // unchanged — never folded illegally
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  it.each<['CANCEL_PENDING' | 'CANCEL_UNKNOWN']>([['CANCEL_PENDING'], ['CANCEL_UNKNOWN']])(
    'adopts venue "canceled" for a %s order — the 2026-07-07 stranded-cancel regression',
    async (state) => {
      const runs = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build(
        { openOrders: [], fetchOrder: () => venueOrder('any', 'canceled') },
        undefined,
        runs,
      );
      const coid = seedOpenOrder(ctx);
      ctx.orders.apply(coid, { type: 'CANCEL_REQUESTED' }); // ACKED → CANCEL_PENDING
      if (state === 'CANCEL_UNKNOWN') ctx.orders.apply(coid, { type: 'CANCEL_REJECT_UNKNOWN' });
      const r = await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe('CANCELED');
      expect(ctx.portfolio.snapshot().openOrders).toHaveLength(0); // retired, not stuck
      expect(r.halted).toBe(false);
      expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
        { venue: V, result: 'mismatch' }, // an adopted terminal, never a PASS_ERROR abort
      ]);
    },
  );

  it('a fold the reducer refuses does not abort the pass — remaining orders still reconcile', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(
      { openOrders: [], fetchOrder: () => venueOrder('any', 'canceled') },
      undefined,
      runs,
    );
    // First order frozen at RECONCILE_REQUIRED: VENUE_CANCELED is illegal there and the fold throws.
    const frozen = seedOpenOrder(ctx);
    ctx.orders.apply(frozen, { type: 'CANCEL_REQUESTED' });
    ctx.orders.apply(frozen, { type: 'CANCEL_REJECT_UNKNOWN' });
    ctx.orders.apply(frozen, { type: 'QUERY_INCONCLUSIVE' });
    // Second order is a healthy ACKED adoption that must still run after the refused fold.
    const adoptable = seedOpenOrder(ctx, OTHER_COID);
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(frozen)?.state).toBe('RECONCILE_REQUIRED'); // untouched
    expect(ctx.orders.get(adoptable)?.state).toBe('CANCELED'); // the pass kept going
    expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      { venue: V, result: 'mismatch' }, // 2026-07-07: this was result=error and 100% reconcile downtime
    ]);
    expect(r.halted).toBe(false);
  });

  it('a non-TransitionError from an adopt-terminal fold still aborts the pass (rethrown past the refusal guard)', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(
      { openOrders: [], fetchOrder: () => venueOrder('any', 'canceled') },
      undefined,
      runs,
    );
    seedOpenOrder(ctx);
    // The refusal guard swallows only reducer refusals (TransitionError); an infrastructure
    // throw (store down) must escape it and abort through the PASS_ERROR machinery.
    ctx.store.appendOrderEvent = () => {
      throw new Error('store down');
    };
    await expect(ctx.recon.reconcile()).rejects.toThrow('store down');
    expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      { venue: V, result: 'error' },
    ]);
  });

  it('backfills a missed fill for a known order via the FillIngestor (WARN)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [venueOrder(coid, 'open')],
      trades: [trade(coid, 'missed-1')],
    });
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(ctx.store.fills.size).toBe(1); // the missed fill was ingested
    expect(r.mismatches).toBeGreaterThan(0);
  });

  it('a trade for an our-prefix order unknown locally HALTs', async () => {
    // Seed a known order on SYM so SYM is swept; the orphan trade is a DIFFERENT our-prefix id.
    const known = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [venueOrder(known, 'open')],
      trades: [trade(OTHER_COID, 'orphan-1')],
    });
    seedOpenOrder(ctx, known);
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages.some((e) => e.reason.includes('FILL_FOR_UNKNOWN_ORDER'))).toBe(true);
  });

  // Cluster-A: on the real venue, VenueFill.clientOrderId carries the numeric venue order id
  // (ccxt myTrades has no clientOrderId field) — normalizeTrade sets it from `t.order`. These three
  // cases exercise the venue-id-first resolution + durable second-tier discrimination that replaces
  // the old cb-prefix-only classification.
  it('resolves a venue-shaped trade (numeric order id, no coid) to OUR order via the venueOrderId index and backfills it — the ccxt myTrades path (cluster-A)', async () => {
    const coid = makeIntent().clientOrderId;
    // balanceAxis:false isolates this to the trade axis — applying the fill moves local cash away
    // from the default venue-balance stub, an unrelated axis this test does not exercise (same
    // isolation the position-axis tests below use for the identical reason).
    const ctx = build(
      {
        openOrders: [venueOrder(coid, 'open')],
        trades: [trade('48212893', 'venue-shaped-1')], // numeric venue order id, not our coid
      },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    seedOpenOrder(ctx, coid, {}, '48212893'); // ACKED with this order's real venue order id
    const r = await ctx.recon.reconcile();
    expect(ctx.store.fills.size).toBe(1); // backfilled_fill — the trade resolved via venueOrderId
    expect(r.halted).toBe(false);
  });

  it('a venue-shaped trade (numeric order id, no coid) resolving to a NON-terminal durable-only order HALTs as FILL_FOR_UNKNOWN_ORDER — in-memory-lost live state is ours, never foreign (cluster-A)', async () => {
    const ctx = build(
      { trades: [trade('77777777', 'venue-shaped-2')] },
      undefined,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    // Durable-only: I1's write-ahead persisted this order (saveNewOrder + the ACK's
    // appendOrderEvent) but it was never (re)loaded into the runtime OrderBookService — simulates a
    // crash / second instance / a recovery gap, exactly the corruption FILL_FOR_UNKNOWN_ORDER exists
    // to catch. State is ACKED — NON-terminal — which is the load-bearing bit: 2026-07-19's tier-2
    // refinement only ingests when the durable order is terminal; a still-live order missing from
    // memory must still HALT unconditionally, unchanged.
    const lost = OTHER_COID;
    await ctx.store.saveNewOrder(
      initialOrder(lost, qty('1'), '0.001'),
      makeIntent({ clientOrderId: lost }),
    );
    await ctx.store.appendOrderEvent({
      clientOrderId: lost,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: '77777777' },
      derivedState: 'ACKED',
      cumQty: '0',
      venueOrderId: '77777777',
    });
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages.some((e) => e.reason.includes('FILL_FOR_UNKNOWN_ORDER'))).toBe(true);
  });

  // 2026-07-19 spot-lane false-HALT incident: a historical TERMINAL order (a TP fill that executed
  // server-side while the host slept) is absent from the rehydrated in-memory book by design (boot
  // recovery only reloads non-terminal orders) — every 30s pass kept re-discovering the same old
  // trade via the checkpoint/overlap window and HALTing on it forever. These two cases are the fix.
  it('an already-recorded fill for a historical TERMINAL durable-only order is a silent no-op — the first filter stops the recurring false-HALT', async () => {
    const ctx = build(
      { trades: [trade('55555555', 'historical-1')] },
      undefined,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    const lost = OTHER_COID;
    await ctx.store.saveNewOrder(
      initialOrder(lost, qty('1'), '0.001'),
      makeIntent({ clientOrderId: lost }),
    );
    await ctx.store.appendOrderEvent({
      clientOrderId: lost,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: '55555555' },
      derivedState: 'FILLED', // durably TERMINAL — boot recovery never rehydrates it
      cumQty: '1',
      venueOrderId: '55555555',
    });
    // Pre-record the SAME venueTradeId — simulates the fill having already been ingested (a prior
    // boot, or earlier this same boot).
    await ctx.store.saveFill(
      {
        venue: V,
        symbol: SYM,
        venueTradeId: 'historical-1',
        clientOrderId: lost,
        price: price('100'),
        qty: qty('1'),
        fee: null,
        liquidity: 'taker',
        venueTimestamp: epochMs(T),
        source: 'rest_reconcile',
      },
      'some-intent-id',
    );
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(false);
    expect(ctx.store.fills.size).toBe(1); // unchanged — no double-ingest
  });

  it('an UNRECORDED fill for a historical TERMINAL durable-only order backfills as backfilled_fill — no halt (the missed-fill recovery actually working)', async () => {
    const ctx = build(
      { trades: [{ ...trade('66666666', 'unrecorded-1'), qty: '0.00000001' }] }, // dust-sized: stays within the FILLED order's qty+stepSize tolerance
      undefined,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    const lost = OTHER_COID;
    await ctx.store.saveNewOrder(
      initialOrder(lost, qty('1'), '0.001'),
      makeIntent({ clientOrderId: lost }),
    );
    await ctx.store.appendOrderEvent({
      clientOrderId: lost,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: '66666666' },
      derivedState: 'FILLED',
      cumQty: '1',
      venueOrderId: '66666666',
    });
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(false);
    expect(ctx.store.fills.size).toBe(1); // backfilled — never seen before, correctly ingested
  });

  it('balance drift beyond ε HALTs, no auto-flatten', async () => {
    const ctx = build({ balances: () => new Map([['USDT', { free: '90000', locked: '0' }]]) }); // 10000 < 100000 by 10000 ≫ ε
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages[0]!.reason).toContain('BALANCE_DRIFT:USDT');
    expect(ctx.engages[0]!.flatten).toBe(false);
  });

  it('within-ε drift that grows monotonically across 3 passes HALTs (systematic leak)', async () => {
    let n = 0;
    const ctx = build({
      balances: () => {
        n += 1;
        // 0.001, 0.002, 0.003 below the local 100000 — each within ε (tol 10) but strictly growing.
        return new Map([
          [
            'USDT',
            { free: new Decimal(100000).add(new Decimal(0.001).mul(n)).toFixed(), locked: '0' },
          ],
        ]);
      },
    });
    expect((await ctx.recon.reconcile()).halted).toBe(false); // pass 1
    expect((await ctx.recon.reconcile()).halted).toBe(false); // pass 2
    const third = await ctx.recon.reconcile(); // pass 3 — strictly growing window
    expect(third.halted).toBe(true);
    expect(ctx.engages.at(-1)!.reason).toContain('BALANCE_LEAK:USDT');
  });

  it('drift history trims to driftPasses entries across many passes, and strictly-growing detection still fires past the trim boundary', async () => {
    const driftPasses = 3;
    let n = 0;
    const ctx = build(
      {
        balances: () => {
          n += 1;
          // Strictly increasing every pass, same shape as the 3-pass case above, run well past
          // driftPasses so the front-trim (reconciliation.service.ts's driftHistory push site) fires
          // repeatedly — proves the per-asset array never grows past driftPasses AND the
          // strictly-growing window detection is unaffected by the trim.
          return new Map([
            [
              'USDT',
              { free: new Decimal(100000).add(new Decimal(0.001).mul(n)).toFixed(), locked: '0' },
            ],
          ]);
        },
      },
      undefined,
      undefined,
      undefined,
      { driftPasses },
    );
    const passes = driftPasses + 5;
    for (let i = 0; i < passes; i++) {
      await ctx.recon.reconcile();
    }
    const driftHistory = (ctx.recon as unknown as { driftHistory: Map<string, Decimal[]> })
      .driftHistory;
    // v3: keyed by `${venue}|${asset}` (not asset alone) so a spot wallet's and a perp wallet's same-
    // ticker balance can never share a drift-history bucket (reconciliation.service.ts).
    expect(driftHistory.get(`${V}|USDT`)).toHaveLength(driftPasses); // never grows past driftPasses
    // One more strictly-increasing pass past the trim boundary still HALTs on the leak.
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages.at(-1)!.reason).toContain('BALANCE_LEAK:USDT');
  });

  it('a local-open order the venue still reports open is an inconsistency WARN (no terminal adopt)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [], fetchOrder: () => venueOrder(coid, 'open') }); // absent from list yet "open"
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // not adopted to a terminal
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  it('an order we cannot query while believed open is a WARN mismatch', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [],
      fetchOrder: () => {
        throw new Error('fetchOrder down');
      },
    });
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  it('a failed trade sweep for a symbol is a WARN mismatch', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], tradesThrow: true });
    seedOpenOrder(ctx, coid); // SYM is of interest → its trade sweep is attempted and fails
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  it('a failed balance fetch is a WARN mismatch', async () => {
    const ctx = build({ balancesThrow: true });
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
  });

  it('an already-recorded trade is a no-op (no new mismatch)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'known-1')] });
    seedOpenOrder(ctx, coid);
    // The fill is already in the store with the SAME payload — reconcile must not double-count it.
    await ctx.store.saveFill(
      {
        venue: V,
        symbol: SYM,
        venueTradeId: 'known-1',
        clientOrderId: coid,
        price: price('100'),
        qty: makeIntent().qty,
        fee: null,
        liquidity: 'taker',
        venueTimestamp: epochMs(T),
        source: 'ws',
      },
      'i1',
    );
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(0); // dedupe: nothing new
    expect(r.halted).toBe(false);
  });

  it('advances the per-(venue,symbol) checkpoint so a second pass re-reads it', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'cp-1')] });
    seedOpenOrder(ctx, coid); // stays ACKED + open (KNOWN); SYM is swept both passes
    // Pre-store the fill so each sweep dedupes it (no balance change), isolating the checkpoint path.
    await ctx.store.saveFill(
      {
        venue: V,
        symbol: SYM,
        venueTradeId: 'cp-1',
        clientOrderId: coid,
        price: price('100'),
        qty: makeIntent().qty,
        fee: null,
        liquidity: 'taker',
        venueTimestamp: epochMs(T),
        source: 'ws',
      },
      'i1',
    );
    const first = await ctx.recon.reconcile(); // sets checkpoint = T (the trade's venueTimestamp)
    const second = await ctx.recon.reconcile(); // reads the non-zero checkpoint → since = T − overlap
    expect(first.mismatches).toBe(0);
    expect(second.mismatches).toBe(0);
    expect(ctx.store.fills.size).toBe(1);
  });

  it('does not re-fold an adopt-terminal the journal already recorded (replay-safe)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [], fetchOrder: () => venueOrder(coid, 'canceled') });
    seedOpenOrder(ctx, coid);
    // A prior life journaled the cancel adopt under the reconcile dedupe key.
    await ctx.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey: 'reconcile:VENUE_CANCELED',
      event: { type: 'VENUE_CANCELED' },
      derivedState: 'CANCELED',
      cumQty: '0',
    });
    await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // fold skipped — journal said duplicate
  });

  it('a trade resolving to neither an in-memory nor a durable order is genuinely foreign — ignored, never a halt (cluster-A) — only the known order backfills its fee-bearing fill', async () => {
    const coid = makeIntent().clientOrderId;
    const feeTrade: VenueFill = { ...trade(coid, 'fee-1'), fee: { ccy: 'USDT', amount: '0.1' } };
    const foreign: VenueFill = { ...trade('someoneElseTrade', 'foreign-1') };
    // balanceAxis:false isolates this to the trade axis (see the venueOrderId-backfill test above).
    const ctx = build(
      { openOrders: [venueOrder(coid, 'open')], trades: [foreign, feeTrade] },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(ctx.store.fills.size).toBe(1); // only ours ingested; the foreign trade is ignored
    expect([...ctx.store.fills.values()][0]!.fee?.amount.toFixed()).toBe('0.1');
    expect(r.halted).toBe(false); // no in-memory or durable match ⇒ genuinely foreign, never a halt
  });

  describe('position axis (Defect A fail-closed backstop)', () => {
    // balanceAxis:false isolates every case below to the position axis alone — the local BUY fill
    // moves quote cash away from the default venue balance stub, which would otherwise add an
    // unrelated BALANCE_DRIFT mismatch to these assertions.
    function seedLocalLong(ctx: Ctx, sz = '0.001') {
      const intent = makeIntent({ qty: qty(sz) });
      ctx.portfolio.applyFill(intent, makeFill({ qty: intent.qty, price: intent.refPrice }));
    }

    it('first divergent pass: position_drift counted, NO halt (debounce lets in-flight recovery land)', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build({ positions: () => [] }, counter, undefined, undefined, {
        balanceAxis: false,
      });
      seedLocalLong(ctx);
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(ctx.engages).toHaveLength(0);
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'position_drift' },
        1,
      ]);
    });

    it('second CONSECUTIVE divergent pass HALTs with POSITION_DRIFT, never auto-flattens', async () => {
      const ctx = build({ positions: () => [] }, undefined, undefined, undefined, {
        balanceAxis: false,
      });
      seedLocalLong(ctx);
      const first = await ctx.recon.reconcile();
      expect(first.halted).toBe(false);
      const second = await ctx.recon.reconcile();
      expect(second.halted).toBe(true);
      expect(ctx.engages.some((e) => e.reason.includes(`POSITION_DRIFT:${SYM}`))).toBe(true);
      expect(ctx.engages.every((e) => e.flatten === false)).toBe(true); // HALT, never auto-flatten
    });

    it('divergent → clean → divergent: no HALT (consecutive streak resets on a clean pass)', async () => {
      let venueQty = '0';
      const ctx = build(
        { positions: () => (venueQty === 'absent' ? [] : [{ symbol: SYM, signedQty: venueQty }]) },
        undefined,
        undefined,
        undefined,
        { balanceAxis: false },
      );
      seedLocalLong(ctx); // local 0.001
      expect((await ctx.recon.reconcile()).halted).toBe(false); // divergent #1 (venue 0)
      venueQty = '0.001';
      expect((await ctx.recon.reconcile()).halted).toBe(false); // clean — streak resets
      venueQty = '0';
      expect((await ctx.recon.reconcile()).halted).toBe(false); // divergent #1 again, still no HALT
      expect(ctx.engages).toHaveLength(0);
    });

    it('venue matches local exactly ⇒ clean', async () => {
      const ctx = build(
        { positions: () => [{ symbol: SYM, signedQty: '0.001' }] },
        undefined,
        undefined,
        undefined,
        { balanceAxis: false },
      );
      seedLocalLong(ctx);
      const r = await ctx.recon.reconcile();
      expect(r).toEqual({ mismatches: 0, halted: false });
    });

    it('positionAxis:false ⇒ axis skipped even when fetchPositions is defined (spot-lane config)', async () => {
      // The shared adapter defines fetchPositions on every venue (vacuous [] off-perp), so config —
      // not method presence — is the decider; reconConfigFrom sets this false off-perp.
      const ctx = build({ positions: () => [] }, undefined, undefined, undefined, {
        balanceAxis: false,
        positionAxis: false,
      });
      seedLocalLong(ctx); // would drift every pass if the axis ran
      expect((await ctx.recon.reconcile()).halted).toBe(false);
      expect((await ctx.recon.reconcile()).halted).toBe(false); // past the debounce too — axis truly off
      expect(ctx.engages).toHaveLength(0);
    });

    it('fetchPositions undefined ⇒ axis skipped (existing behavior byte-identical)', async () => {
      const ctx = build({}, undefined, undefined, undefined, { balanceAxis: false });
      seedLocalLong(ctx); // would drift POSITION_DRIFT if the axis ran — no venue truth ⇒ never observed
      const r = await ctx.recon.reconcile();
      expect(r).toEqual({ mismatches: 0, halted: false });
    });

    it('fetchPositions throw ⇒ sweep_failure only, no halt', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build({ positionsThrow: true }, counter, undefined, undefined, {
        balanceAxis: false,
      });
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'sweep_failure' },
        1,
      ]);
    });

    it('exact-string qty comparison: venue 0.00100 vs local 0.001 MATCH (Decimal, not string equality)', async () => {
      const ctx = build(
        { positions: () => [{ symbol: SYM, signedQty: '0.00100' }] },
        undefined,
        undefined,
        undefined,
        { balanceAxis: false },
      );
      seedLocalLong(ctx, '0.001');
      const r = await ctx.recon.reconcile();
      expect(r).toEqual({ mismatches: 0, halted: false });
    });
  });
});

// v3 §1.5: one pass per venue per tick, one reconciliations row per venue pass. This block
// constructs the service with venuePorts/venueRegistry supplied (the composition-root wiring) and
// asserts iteration behavior; every case above this block exercises the legacy single-venue
// constructor path unchanged (byte-identical — venuePorts/venueRegistry are @Optional).
describe('ReconciliationService — v3 multi-venue iteration (§1.5)', () => {
  const SPOT = venueId('binance');
  const PERP = venueId('binanceusdm');

  function fakePort(venue: VenueId, script: { balancesThrow?: boolean } = {}): ExchangePort {
    return {
      venue,
      capabilities: {
        clientOrderId: true,
        fetchOrderByClientId: true,
        wsUserStream: true,
        stp: false,
        sandbox: true,
      },
      placeOrder: () => Promise.reject(new Error('unused')),
      cancelOrder: () => Promise.reject(new Error('unused')),
      fetchOrder: () => Promise.reject(new Error('unused')),
      fetchOpenOrders: () => Promise.resolve([]),
      fetchBalances: () =>
        script.balancesThrow
          ? Promise.reject(new Error('balances down'))
          : Promise.resolve(new Map([['USDT', { free: '100000', locked: '0' }]])),
      fetchMyTrades: () => Promise.resolve([]),
      validateCredentials: () => Promise.reject(new Error('unused')),
    };
  }

  function descriptor(venue: VenueId, perpCapable: boolean): VenueRuntimeDescriptor {
    return {
      venue,
      config: { id: venue, environment: 'demo' },
      symbols: [],
      capitalShare: '500',
      perpCapable,
    };
  }

  function buildMultiVenue(
    ports: ReadonlyMap<VenueId, ExchangePort>,
    registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
  ) {
    const clock = { now: () => epochMs(T) };
    const store = new InMemoryExecutionStore();
    const orders = new OrderBookService();
    const portfolio = new PortfolioStateService(
      { quoteAsset: 'USDT', startingCash: '100000' },
      new FeeLedgerService(),
    );
    const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), clock, store);
    const { ks } = killSwitchStub();
    const ingestor = new FillIngestorService(store, ks, orders, portfolio, sampler);
    const recon = new ReconciliationService(
      clock,
      ports.values().next().value!, // legacy single-venue slot — unused whenever venuePorts is present
      store,
      ks,
      { ...CFG },
      orders,
      portfolio,
      ingestor,
      undefined,
      undefined,
      undefined,
      ports,
      registry,
    );
    return { store, recon };
  }

  it('runs one pass per venue and writes one reconciliations row per venue', async () => {
    const ports = new Map([
      [SPOT, fakePort(SPOT)],
      [PERP, fakePort(PERP)],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    const { store, recon } = buildMultiVenue(ports, registry);

    const result = await recon.reconcile();

    expect(result).toEqual({ mismatches: 0, halted: false });
    expect(store.reconciliations).toHaveLength(2);
    expect(store.reconciliations.map((r) => r.venue).sort()).toEqual([PERP, SPOT].sort());
  });

  it("one venue's balances-fetch failure is isolated to that venue's row — the other venue's pass still completes clean", async () => {
    const ports = new Map([
      [SPOT, fakePort(SPOT, { balancesThrow: true })],
      [PERP, fakePort(PERP)],
    ]);
    const registry = new Map([
      // balanceAxis derives from descriptor.config.environment !== 'demo' — 'testnet' here so the
      // axis actually runs and the spot venue's fetchBalances throw is exercised.
      [SPOT, { ...descriptor(SPOT, false), config: { id: SPOT, environment: 'testnet' } }],
      [PERP, descriptor(PERP, true)],
    ]);
    const { store, recon } = buildMultiVenue(ports, registry);

    const result = await recon.reconcile();

    expect(result.halted).toBe(false); // sweep_failure never halts
    expect(result.mismatches).toBe(1); // the spot venue's one failed balances sweep, summed book-wide
    const spotRow = store.reconciliations.find((r) => r.venue === SPOT)!;
    const perpRow = store.reconciliations.find((r) => r.venue === PERP)!;
    expect(spotRow.mismatches).toBe(1); // the failed sweep is visible on the spot venue's OWN row
    expect(perpRow.mismatches).toBe(0); // the other venue's pass is unaffected
    expect(perpRow.detail).toBe('clean');
  });
});
