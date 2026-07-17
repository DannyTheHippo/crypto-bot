import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { AlgoStopRecoveryService } from '../../../src/features/trading/execution/algo-stop-recovery.service';
import { OrderBookService } from '../../../src/features/trading/execution/order-book.service';
import { PortfolioStateService } from '../../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/features/trading/execution/fee-ledger.service';
import { EquitySamplerService } from '../../../src/features/trading/execution/equity-sampler.service';
import { FillIngestorService } from '../../../src/features/trading/execution/fill-ingestor.service';
import { InMemoryExecutionStore } from '../../../src/features/trading/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import type {
  ExchangePort,
  AlgoOrderState,
  AlgoOrderHistoryView,
  VenueFill,
} from '../../../src/ports/exchange';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import type { ApprovalProof } from '../../../src/domain/types/risk-decision';
import {
  encodeClientOrderId,
  clientOrderId,
  symbolId,
  venueId,
  epochMs,
} from '../../../src/domain/types/ids';
import { price, qty } from '../../../src/domain/types/money';
import { makeIntent, makeFill, fixedFeed, killSwitchStub, IID, SID, T } from './helpers';

const PROOF: ApprovalProof = {
  intentHash: 'h',
  hmac: 'm',
  nonce: 'n',
  approvedAtMs: epochMs(1),
  ttlMs: 2000,
  limitsVersion: 'v1',
  snapshotSeq: 1n,
};

const V_PERP = venueId('binanceusdm');
const SYM_PERP = symbolId('BTC/USDT:USDT');
const STOP_COID = encodeClientOrderId(IID, 'paper');

interface ExchangeScript {
  openAlgo?: AlgoOrderState[];
  algoStatus?: AlgoOrderHistoryView | undefined;
  algoStatusThrow?: boolean;
  trades?: VenueFill[];
}

function build(script: ExchangeScript = {}) {
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

  const exchange: ExchangePort = {
    venue: V_PERP,
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
    fetchBalances: () => Promise.resolve(new Map()),
    fetchMyTrades: () => Promise.resolve(script.trades ?? []),
    validateCredentials: () => Promise.reject(new Error('unused')),
    fetchOpenAlgoOrders: () => Promise.resolve(script.openAlgo ?? []),
    fetchAlgoOrderStatus: () =>
      script.algoStatusThrow
        ? Promise.reject(new Error('algo history down'))
        : Promise.resolve(script.algoStatus),
  };

  const svc = new AlgoStopRecoveryService(clock, exchange, store, orders, portfolio, ingestor);
  return { store, orders, portfolio, svc };
}

type Ctx = ReturnType<typeof build>;

// Seed an ACKED, in-flight algo-rail stop intent — the state execution-gate.service.ts's own
// Push 3 P7f fix 1 leaves a placed STOP_MARKET in: ACKED + addInFlight, but NEVER registered in the
// local open-orders set (that set is regular-rail only; the algo rail is strategy-managed).
function seedAlgoIntent(ctx: Ctx, over: Partial<OrderIntent> = {}): { intent: OrderIntent } {
  const intent = makeIntent({
    venue: V_PERP,
    symbol: SYM_PERP,
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: price('48000'),
    qty: qty('0.001'),
    ...over,
  });
  const coid = intent.clientOrderId;
  // stepSize a full order of magnitude below qty so a 0.0005 partial residual is never dust-rounded
  // to FILLED (the partial-fill regression test needs a genuine PARTIALLY_FILLED plateau).
  ctx.orders.create(initialOrder(coid, intent.qty, '0.0001'));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'algo-999' });
  ctx.portfolio.addInFlight(intent);
  return { intent };
}

// Post-restart geometry (P7f(3), the corrected root cause): boot recovery seeds the ORDER RECORD
// non-terminal (ACKED) from the persisted orders row, but the intent is NOT rehydrated into the
// in-flight map — only the write-ahead store still holds it (loadIntentByClientOrderId, the same
// P7c primitive boot recovery itself uses). `withStoreIntent` toggles whether the intent is even
// persisted, so the 'store-load returns null' gap can be exercised alongside the healed path.
async function seedPostBootAlgoIntent(
  ctx: Ctx,
  over: Partial<OrderIntent> = {},
  withStoreIntent = true,
): Promise<{ intent: OrderIntent }> {
  const intent = makeIntent({
    venue: V_PERP,
    symbol: SYM_PERP,
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: price('48000'),
    qty: qty('0.001'),
    ...over,
  });
  const coid = intent.clientOrderId;
  ctx.orders.create(initialOrder(coid, intent.qty, '0.0001'));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'algo-999' });
  // Deliberately NO portfolio.addInFlight(intent) — that is the exact post-restart gap this anchor
  // widening closes.
  if (withStoreIntent) await ctx.store.saveIntent(intent, PROOF);
  return { intent };
}

// Reviewer should-fix (2026-07-17 review): InMemoryExecutionStore.loadIntentByClientOrderId
// round-trips the FULL intent object, triggerPrice included — so every test above that seeds the
// store via seedPostBootAlgoIntent would keep passing even if the type==='STOP_MARKET'
// discriminator were reverted to isAlgoRailIntent (which only needs triggerPrice, not type). This
// stub mirrors drizzle-execution-store.ts's loadIntentForRecovery exactly (order_intents carries no
// trigger_price column, so the field is never restored), so the discriminator's central
// justification is actually exercised: the suite must fail if isAlgoRailIntent replaces it.
function stubStoreIntentWithoutTriggerPrice(ctx: Ctx, intent: OrderIntent): void {
  ctx.store.loadIntentByClientOrderId = (coid) =>
    Promise.resolve(coid === intent.clientOrderId ? { ...intent, triggerPrice: undefined } : null);
}

const RESTING_ROW: AlgoOrderState = {
  algoId: '999',
  clientAlgoId: STOP_COID,
  symbol: SYM_PERP,
  side: 'SELL',
  type: 'STOP_MARKET',
  qty: '0.001',
  triggerPrice: '48000',
  status: 'NEW',
  reduceOnly: true,
};

describe('AlgoStopRecoveryService.recoverSymbol', () => {
  it("TRIGGERED: ingests under the stop's local clientOrderId, reaches FILLED, clears in-flight", async () => {
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      spawnedOrderId: 'spawn-1',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const trade: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: 't1',
      clientOrderId: clientOrderId('spawn-1'),
      price: '117000',
      qty: '0.001',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const ctx = build({ openAlgo: [], algoStatus: view, trades: [trade] });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('FILLED');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);

    const ev = ctx.store.events.find((e) => e.dedupeKey === 'algo-trig:t1');
    expect(ev).toBeDefined();
    expect(ev?.clientOrderId).toBe(STOP_COID);
    expect(ev?.reason).toBe('venue_stop_filled:algoId=999');

    const fill = ctx.store.fills.get(`${V_PERP}|${SYM_PERP}|t1`);
    expect(fill?.price.toFixed()).toBe('117000'); // exact string, never toBeCloseTo
    expect(fill?.qty.toFixed()).toBe('0.001');
  });

  it('CANCELED: folds the venue-cancel event under algo-hist:CANCELED:999, zero ingests', async () => {
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'CANCELED',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const ctx = build({ openAlgo: [], algoStatus: view });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('canceled');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('CANCELED');
    expect(ctx.store.fills.size).toBe(0);
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);
    const ev = ctx.store.events.find((e) => e.dedupeKey === 'algo-hist:CANCELED:999');
    expect(ev).toBeDefined();
  });

  it('UNKNOWN status: no fold, returns unknown, intent stays live for the next sweep', async () => {
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'UNKNOWN',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const ctx = build({ openAlgo: [], algoStatus: view });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('unknown');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1);
  });

  it('adapter throw: caught per-intent, treated as unknown, no fold', async () => {
    const ctx = build({ openAlgo: [], algoStatusThrow: true });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('unknown');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1);
  });

  it('partial fill stays PARTIALLY_FILLED, a second sweep completes it without double-folding', async () => {
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      spawnedOrderId: 'spawn-1',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const t1: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: 't1',
      clientOrderId: clientOrderId('spawn-1'),
      price: '117000',
      qty: '0.0005',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const t2: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: 't2',
      clientOrderId: clientOrderId('spawn-1'),
      price: '117000',
      qty: '0.0005',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T + 1),
    };
    const script: ExchangeScript = { openAlgo: [], algoStatus: view, trades: [t1] };
    const ctx = build(script);
    seedAlgoIntent(ctx);

    const first = await ctx.svc.recoverSymbol(SYM_PERP);
    expect(first).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('PARTIALLY_FILLED');
    expect(ctx.orders.get(STOP_COID)?.cumQty.toFixed()).toBe('0.0005');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1); // not retired — partial

    // Second sweep's fetchMyTrades answer is cumulative (since intent.createdAt, never reset) —
    // t1 re-arrives alongside the new t2.
    script.trades = [t1, t2];
    const second = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(second).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('FILLED');
    expect(ctx.orders.get(STOP_COID)?.cumQty.toFixed()).toBe('0.001');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);
    expect(ctx.store.fills.size).toBe(2); // t1 deduped (saveFill inserted:false), t2 newly applied
  });

  it("TRIGGERED without spawnedOrderId: 'unknown', zero ingests — never infer ownership by exclusion", async () => {
    // Adversarial review 2026-07-17: on a shared wallet an exclusion-based fallback could fold a
    // foreign fill onto our intent; without positive identification recovery must defer to the
    // debounced position-drift HALT instead of guessing.
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const foreign: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: 't-foreign',
      clientOrderId: clientOrderId('someone-elses-order'),
      price: '117000',
      qty: '0.001',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const ctx = build({ openAlgo: [], algoStatus: view, trades: [foreign] });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('unknown');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.store.fills.size).toBe(0);
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1);
  });

  it('still resting (fetchOpenAlgoOrders lists it): none, never touches the live stop', async () => {
    const ctx = build({ openAlgo: [RESTING_ROW] });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('none');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1);
  });

  it('no live algo intent for the symbol: none, no venue calls needed', async () => {
    const ctx = build();
    const result = await ctx.svc.recoverSymbol(SYM_PERP);
    expect(result).toBe('none');
  });
});

describe('AlgoStopRecoveryService.hasLiveAlgoIntent', () => {
  it('true iff a non-terminal in-flight intent rides the algo rail for the symbol', () => {
    const ctx = build();
    expect(ctx.svc.hasLiveAlgoIntent(SYM_PERP)).toBe(false);
    seedAlgoIntent(ctx);
    expect(ctx.svc.hasLiveAlgoIntent(SYM_PERP)).toBe(true);
    expect(ctx.svc.hasLiveAlgoIntent(symbolId('ETH/USDT:USDT'))).toBe(false);
  });
});

// 2026-07-17 ROOT GEOMETRY correction: boot recovery (P7f(3)) seeds a non-terminal algo-rail
// order's RECORD but does not always rehydrate its intent into the in-flight map — the live
// 2026-07-16 phantom's actual shape. These pin the widened anchor (candidateAlgoIntents) that
// resolves an intent from the write-ahead store when the in-flight map has nothing.
describe('AlgoStopRecoveryService.recoverSymbol — post-boot geometry (store-rehydrated anchor)', () => {
  it('TRIGGERED heal with NO in-flight intent: folds the position flat with the exact venue strings', async () => {
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      spawnedOrderId: 'spawn-518',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const trade: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: '518032435',
      clientOrderId: clientOrderId('spawn-518'),
      price: '64181.4',
      qty: '0.001',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const ctx = build({ openAlgo: [], algoStatus: view, trades: [trade] });
    await seedPostBootAlgoIntent(ctx);
    // The diagnosed live geometry: a long 0.001 BTC position the venue-fired SELL stop closes flat.
    ctx.portfolio.restoreFromSnapshot({
      cash: new Decimal('100000'),
      equity: new Decimal('100000'),
      peak: new Decimal('100000'),
      sodEquity: new Decimal('100000'),
      positions: [
        {
          strategyId: SID,
          venue: V_PERP,
          symbol: SYM_PERP,
          signedQty: new Decimal('0.001'),
          avgEntry: price('64000'),
          realizedPnl: new Decimal('0'),
        },
      ],
    });
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0); // the post-restart gap

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('FILLED');
    expect(ctx.portfolio.livePositions()).toHaveLength(0); // flattened, exact-zero fold
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);

    const fill = ctx.store.fills.get(`${V_PERP}|${SYM_PERP}|518032435`);
    expect(fill?.price.toFixed()).toBe('64181.4'); // exact string, never toBeCloseTo
    expect(fill?.qty.toFixed()).toBe('0.001');

    const ev = ctx.store.events.find((e) => e.dedupeKey === 'algo-trig:518032435');
    expect(ev).toBeDefined();
    expect(ev?.clientOrderId).toBe(STOP_COID);
    expect(ev?.reason).toBe('venue_stop_filled:algoId=999');
  });

  it('TRIGGERED heal via a store answer WITHOUT triggerPrice (mirrors drizzle — proves the type discriminator, not isAlgoRailIntent, does the work)', async () => {
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      spawnedOrderId: 'spawn-518',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const trade: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: '518032435',
      clientOrderId: clientOrderId('spawn-518'),
      price: '64181.4',
      qty: '0.001',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const ctx = build({ openAlgo: [], algoStatus: view, trades: [trade] });
    const { intent } = await seedPostBootAlgoIntent(ctx, {}, false); // no store save — the stub answers instead
    stubStoreIntentWithoutTriggerPrice(ctx, intent);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    // If the discriminator were isAlgoRailIntent (needs triggerPrice), this store answer would be
    // rejected and the result would be 'none' — 'triggered' pins that type==='STOP_MARKET' is what
    // actually admits it.
    expect(result).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('FILLED');
    const fill = ctx.store.fills.get(`${V_PERP}|${SYM_PERP}|518032435`);
    expect(fill?.price.toFixed()).toBe('64181.4');
    expect(fill?.qty.toFixed()).toBe('0.001');
  });

  it('heals from a RECONCILE_REQUIRED record (the live 2026-07-17 DB state) — frozen state still ingests fills', async () => {
    // DB-probe-verified geometry: the stranded stop's orders row sits at RECONCILE_REQUIRED (a
    // prior HALT's cancel path degraded it), the order_intents row is loadable, no in-flight
    // intent. Reducer contract: RECONCILE_REQUIRED ingests FILL facts and withFill promotes to
    // FILLED at full qty — the heal must work from exactly this state.
    const view: AlgoOrderHistoryView = {
      algoId: '1000000137621559',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      spawnedOrderId: '22141017991',
      qty: '0.001',
      triggerPrice: '64348.6',
    };
    const trade: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: '518032435',
      clientOrderId: clientOrderId('22141017991'),
      price: '64181.4',
      qty: '0.001',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const ctx = build({ openAlgo: [], algoStatus: view, trades: [trade] });
    await seedPostBootAlgoIntent(ctx);
    const acked = ctx.orders.get(STOP_COID);
    if (acked === undefined) throw new Error('seed failed');
    ctx.orders.commit({ ...acked, state: 'RECONCILE_REQUIRED' });
    ctx.portfolio.restoreFromSnapshot({
      cash: new Decimal('100000'),
      equity: new Decimal('100000'),
      peak: new Decimal('100000'),
      sodEquity: new Decimal('100000'),
      positions: [
        {
          strategyId: SID,
          venue: V_PERP,
          symbol: SYM_PERP,
          signedQty: new Decimal('0.001'),
          avgEntry: price('64577.6'),
          realizedPnl: new Decimal('0'),
        },
      ],
    });

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('FILLED');
    expect(ctx.portfolio.livePositions()).toHaveLength(0);
    const fill = ctx.store.fills.get(`${V_PERP}|${SYM_PERP}|518032435`);
    expect(fill?.price.toFixed()).toBe('64181.4');
    expect(fill?.qty.toFixed()).toBe('0.001');
    expect(ctx.store.events.find((e) => e.dedupeKey === 'algo-trig:518032435')?.reason).toBe(
      'venue_stop_filled:algoId=1000000137621559',
    );
  });

  it('in-flight anchor stays byte-identical when both sources resolve (regression pin)', async () => {
    // seedAlgoIntent already registers the intent in-flight; also persisting it in the store must
    // not change the outcome — inFlightIntent wins the `??` before any store I/O runs.
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      spawnedOrderId: 'spawn-1',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const trade: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: 't1',
      clientOrderId: clientOrderId('spawn-1'),
      price: '117000',
      qty: '0.001',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const ctx = build({ openAlgo: [], algoStatus: view, trades: [trade] });
    const { intent } = seedAlgoIntent(ctx);
    await ctx.store.saveIntent(intent, PROOF); // also resolvable via the store — must not matter

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('FILLED');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);
  });

  it("store-load returns null (never persisted): candidate dropped, 'none', zero mutations", async () => {
    const ctx = build({ openAlgo: [], algoStatus: undefined });
    await seedPostBootAlgoIntent(ctx, {}, false); // withStoreIntent=false — nothing to resolve from

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    // Neither in-flight nor the store can resolve this record's intent, so it cannot even be
    // confirmed to belong to SYM_PERP — dropped from every symbol's candidate set rather than
    // guessed into an 'unknown' for a symbol it might not even carry (fail OPEN, no mutation).
    expect(result).toBe('none');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.store.fills.size).toBe(0);
    expect(ctx.store.events).toHaveLength(0);
  });

  it('second sweep over a store-anchored partial fill is idempotent and completes it (no double fold)', async () => {
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      spawnedOrderId: 'spawn-1',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const t1: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: 't1',
      clientOrderId: clientOrderId('spawn-1'),
      price: '117000',
      qty: '0.0005',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const t2: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: 't2',
      clientOrderId: clientOrderId('spawn-1'),
      price: '117000',
      qty: '0.0005',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T + 1),
    };
    const script: ExchangeScript = { openAlgo: [], algoStatus: view, trades: [t1] };
    const ctx = build(script);
    await seedPostBootAlgoIntent(ctx);
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0); // no in-flight anchor yet

    const first = await ctx.svc.recoverSymbol(SYM_PERP);
    expect(first).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('PARTIALLY_FILLED');
    expect(ctx.orders.get(STOP_COID)?.cumQty.toFixed()).toBe('0.0005');
    // recoverTriggeredFill's addInFlight "wakes" the intent for the next sweep — a non-terminal
    // partial never clears it.
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1);

    script.trades = [t1, t2];
    const second = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(second).toBe('triggered');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('FILLED');
    expect(ctx.orders.get(STOP_COID)?.cumQty.toFixed()).toBe('0.001');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);
    expect(ctx.store.fills.size).toBe(2); // t1 deduped (saveFill inserted:false), t2 newly applied
  });

  it('all candidates already ingested (duplicates): the in-flight registration this call added is cleared, not stranded', async () => {
    // Reviewer should-fix (2026-07-17 review): a sweep whose every candidate fill is already in the
    // fill table (saveFill inserted:false — e.g. the regular fill pipeline beat this sweep to it)
    // never advances cumQty, so the record stays non-terminal ACKED and ingest's own terminal-only
    // clearInFlight never fires. Without the fix below, the addInFlight this call performed to reach
    // the portfolio fold would strand the intent in-flight — halt-coordinator treats that as
    // symbol-busy, blocking HALT flatten until the next boot.
    const view: AlgoOrderHistoryView = {
      algoId: '999',
      clientAlgoId: STOP_COID,
      status: 'TRIGGERED',
      spawnedOrderId: 'spawn-1',
      qty: '0.001',
      triggerPrice: '48000',
    };
    const trade: VenueFill = {
      venue: V_PERP,
      symbol: SYM_PERP,
      venueTradeId: 't1',
      clientOrderId: clientOrderId('spawn-1'),
      price: '117000',
      qty: '0.001',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const ctx = build({ openAlgo: [], algoStatus: view, trades: [trade] });
    const { intent } = await seedPostBootAlgoIntent(ctx);
    // Pre-seed the SAME fill (identical payload) as already ingested — this sweep's fold is then an
    // all-duplicate no-op (saveFill sees an existing row with matching price/qty ⇒ inserted:false).
    await ctx.store.saveFill(
      makeFill({
        venue: V_PERP,
        symbol: SYM_PERP,
        venueTradeId: 't1',
        clientOrderId: STOP_COID,
        price: price('117000'),
        qty: qty('0.001'),
        venueTimestamp: epochMs(T),
      }),
      intent.intentId,
    );
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0); // pre-condition: not in-flight

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('triggered'); // unchanged truth value — a duplicate is still a positive TRIGGERED identification
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED'); // nothing actually folded — cumQty never advanced
    expect(ctx.orders.get(STOP_COID)?.cumQty.toFixed()).toBe('0');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0); // not stranded
  });
});

describe('AlgoStopRecoveryService.hasAlgoAnchor', () => {
  it('true iff either the in-flight map or the store resolves an algo-rail intent for the symbol', async () => {
    const ctx = build();
    expect(await ctx.svc.hasAlgoAnchor(SYM_PERP)).toBe(false);
    await seedPostBootAlgoIntent(ctx);
    expect(await ctx.svc.hasAlgoAnchor(SYM_PERP)).toBe(true);
    expect(await ctx.svc.hasAlgoAnchor(symbolId('ETH/USDT:USDT'))).toBe(false);
  });

  it('true from a store answer WITHOUT triggerPrice (mirrors drizzle — pins the type discriminator)', async () => {
    const ctx = build();
    const { intent } = await seedPostBootAlgoIntent(ctx, {}, false);
    stubStoreIntentWithoutTriggerPrice(ctx, intent);

    // isAlgoRailIntent would reject a triggerPrice-less intent outright; only the type==='STOP_MARKET'
    // discriminator can answer true here.
    expect(await ctx.svc.hasAlgoAnchor(SYM_PERP)).toBe(true);
  });
});
