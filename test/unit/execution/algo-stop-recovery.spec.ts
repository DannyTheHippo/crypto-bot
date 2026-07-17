import { describe, it, expect } from 'vitest';
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
import {
  encodeClientOrderId,
  clientOrderId,
  symbolId,
  venueId,
  epochMs,
} from '../../../src/domain/types/ids';
import { price, qty } from '../../../src/domain/types/money';
import { makeIntent, fixedFeed, killSwitchStub, IID, T } from './helpers';

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
