import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import type { Counter, Gauge } from 'prom-client';
import { ReconciliationService } from '../../../src/modules/execution/reconciliation.service';
import { OrderBookService } from '../../../src/modules/execution/order-book.service';
import { PortfolioStateService } from '../../../src/modules/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/modules/execution/fee-ledger.service';
import { EquitySamplerService } from '../../../src/modules/execution/equity-sampler.service';
import { FillIngestorService } from '../../../src/modules/execution/fill-ingestor.service';
import { InMemoryExecutionStore } from '../../../src/modules/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import type { ExchangePort, ExchangeOrderState, VenueFill } from '../../../src/ports/exchange';
import type { ReconConfig } from '../../../src/ports/execution';
import { encodeClientOrderId, intentId, epochMs } from '../../../src/domain/types/ids';
import { price } from '../../../src/domain/types/money';
import { makeIntent, makeFill, fixedFeed, killSwitchStub, SYM, V, T } from './helpers';

const CFG: ReconConfig = {
  epsAbs: '0.00000001',
  epsRel: '0.0001',
  overlapMs: 300_000,
  driftPasses: 3,
};
const OTHER_COID = encodeClientOrderId(intentId('0190ffff-1234-7abc-89ab-0123456789ab'), 'paper');

interface ExchangeScript {
  openOrders?: ExchangeOrderState[];
  fetchOrder?: () => ExchangeOrderState;
  trades?: VenueFill[];
  tradesThrow?: boolean;
  balances?: () => Map<string, { free: string; locked: string }>;
  balancesThrow?: boolean;
}

function build(
  script: ExchangeScript = {},
  mismatchCounter?: Counter<string>,
  runsCounter?: Counter<string>,
  lastSuccessGauge?: Gauge<string>,
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
    fetchOpenOrders: () => Promise.resolve(script.openOrders ?? []),
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
  };

  const recon = new ReconciliationService(
    clock,
    exchange,
    store,
    ks,
    CFG,
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
) {
  const intent = makeIntent({ clientOrderId: coid, ...over });
  ctx.orders.create(initialOrder(coid, intent.qty, '0.001'));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' });
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

  it('increments the reconciliation_mismatch_total metric by the pass mismatch count', async () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    // A foreign venue open order is a WARN mismatch (count 1) — a deterministic non-zero pass.
    const ctx = build({ openOrders: [venueOrder('someoneElseOrder', 'open')] }, counter);
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBeGreaterThan(0);
    expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([r.mismatches]);
  });

  it('records reconciliation_runs_total{result} and stamps last-success only on a clean pass', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const lastSuccess = { set: vi.fn() } as unknown as Gauge<string>;
    const incCalls = (runs.inc as ReturnType<typeof vi.fn>).mock.calls;
    const setCalls = (lastSuccess.set as ReturnType<typeof vi.fn>).mock.calls;

    // clean pass → result 'clean', gauge set to clock-now/1000
    const clean = build({}, undefined, runs, lastSuccess);
    await clean.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ result: 'clean' }]);
    expect(setCalls.at(-1)).toEqual([T / 1000]);

    // mismatch pass (foreign open order) → result 'mismatch', no new gauge set
    const setCountAfterClean = setCalls.length;
    const mismatch = build(
      { openOrders: [venueOrder('someoneElseOrder', 'open')] },
      undefined,
      runs,
      lastSuccess,
    );
    await mismatch.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ result: 'mismatch' }]);
    expect(setCalls.length).toBe(setCountAfterClean); // gauge unchanged on a non-clean pass

    // halt pass (our-prefix unknown open) → result 'halt'
    const halt = build(
      { openOrders: [venueOrder(OTHER_COID, 'open')] },
      undefined,
      runs,
      lastSuccess,
    );
    await halt.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ result: 'halt' }]);
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
    const ctx = build({ openOrders: [venueOrder('someoneElseOrder', 'open')] });
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
  });

  it('our-prefix venue open order unknown locally HALTs (no auto-cancel)', async () => {
    const ctx = build({ openOrders: [venueOrder(OTHER_COID, 'open')] });
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages[0]!.flatten).toBe(false); // HALT, never auto-flatten
    expect(ctx.engages[0]!.reason).toContain('UNKNOWN_OURS_OPEN');
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

  it('ignores a foreign trade and backfills a fee-bearing fill for a known order', async () => {
    const coid = makeIntent().clientOrderId;
    const feeTrade: VenueFill = { ...trade(coid, 'fee-1'), fee: { ccy: 'USDT', amount: '0.1' } };
    const foreign: VenueFill = { ...trade('someoneElseTrade', 'foreign-1') };
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], trades: [foreign, feeTrade] });
    seedOpenOrder(ctx, coid);
    await ctx.recon.reconcile();
    expect(ctx.store.fills.size).toBe(1); // only ours ingested; the foreign trade is ignored
    expect([...ctx.store.fills.values()][0]!.fee?.amount.toFixed()).toBe('0.1');
  });
});
