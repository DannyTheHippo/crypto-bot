import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { AlgoStopRecoveryService } from '../../../../src/features/trading/execution/algo-stop-recovery.service';
import { OrderBookService } from '../../../../src/features/trading/execution/order-book.service';
import { PortfolioStateService } from '../../../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../../src/features/trading/execution/fee-ledger.service';
import { EquitySamplerService } from '../../../../src/features/trading/execution/equity-sampler.service';
import { FillIngestorService } from '../../../../src/features/trading/execution/fill-ingestor.service';
import { InMemoryExecutionStore } from '../../../../src/features/trading/execution/in-memory-store';
import { initialOrder } from '../../../../src/domain/trading/oms/reducer';
import type {
  ExchangePort,
  AlgoOrderState,
  AlgoOrderHistoryView,
  VenueFill,
} from '../../../../src/ports/venue/exchange';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';
import type { ApprovalProof } from '../../../../src/domain/trading/types/risk-decision';
import {
  encodeClientOrderId,
  clientOrderId,
  symbolId,
  venueId,
  epochMs,
} from '../../../../src/domain/common/types/ids';
import { price, qty } from '../../../../src/domain/common/types/money';
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
  // Rejection value for the algo-history rail when algoStatusThrow is set; defaults to an Error.
  // A non-Error value (a bare string, as a transport layer can reject with) exercises the
  // String(err) side of the log-message formatting on both catch paths.
  algoStatusThrowAs?: unknown;
  trades?: VenueFill[];
  // Fired INSIDE the corresponding venue call — i.e. after the anchor scan has already chosen its
  // candidates and before the fold runs. That await seam is the only place a concurrent path (the
  // regular fill pipeline, a HALT sweep) can mutate the local book mid-recovery, so it is where the
  // race the defensive re-checks exist for has to be injected.
  onAlgoStatus?: () => void;
  onTrades?: () => void;
}

function build(script: ExchangeScript = {}) {
  const calls = { openAlgo: 0, algoStatus: 0, trades: 0 };
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
    fetchMyTrades: () => {
      calls.trades += 1;
      script.onTrades?.();
      return Promise.resolve(script.trades ?? []);
    },
    validateCredentials: () => Promise.reject(new Error('unused')),
    fetchOpenAlgoOrders: () => {
      calls.openAlgo += 1;
      return Promise.resolve(script.openAlgo ?? []);
    },
    fetchAlgoOrderStatus: () => {
      calls.algoStatus += 1;
      script.onAlgoStatus?.();
      if (!script.algoStatusThrow) return Promise.resolve(script.algoStatus);
      // A NON-Error rejection value is exactly what one test below scripts (a transport layer can
      // reject with a bare string); forcing an Error here would delete that case.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(script.algoStatusThrowAs ?? new Error('algo history down'));
    },
  };

  const svc = new AlgoStopRecoveryService(clock, exchange, store, orders, portfolio, ingestor);
  return { store, orders, portfolio, svc, calls };
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

// The two recurring venue answers, factored out for the tests below that vary only the surrounding
// local state (the earlier tests keep their own inline literals — each pins a distinct venue shape).
const CANCELED_VIEW: AlgoOrderHistoryView = {
  algoId: '999',
  clientAlgoId: STOP_COID,
  status: 'CANCELED',
  qty: '0.001',
  triggerPrice: '48000',
};

const TRIGGERED_VIEW: AlgoOrderHistoryView = {
  algoId: '999',
  clientAlgoId: STOP_COID,
  status: 'TRIGGERED',
  spawnedOrderId: 'spawn-1',
  qty: '0.001',
  triggerPrice: '48000',
};

const SPAWNED_TRADE: VenueFill = {
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

  it('a TERMINAL order record is skipped by the anchor scan — the venue is never asked', async () => {
    const ctx = build({ openAlgo: [], algoStatus: CANCELED_VIEW });
    seedAlgoIntent(ctx);
    const acked = ctx.orders.get(STOP_COID);
    if (acked === undefined) throw new Error('seed failed');
    // A prior pass already retired it. The RECORD is the anchor, so a terminal one contributes
    // nothing no matter what the in-flight map still holds — otherwise every retired stop would be
    // re-queried on the algo rail forever.
    ctx.orders.commit({ ...acked, state: 'CANCELED' });

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('none');
    expect(ctx.calls.openAlgo).toBe(0);
    expect(ctx.calls.algoStatus).toBe(0);
    expect(ctx.store.events).toHaveLength(0);
  });

  it('EXPIRED: folds VENUE_EXPIRED under algo-hist:EXPIRED:999, zero ingests', async () => {
    const ctx = build({ openAlgo: [], algoStatus: { ...CANCELED_VIEW, status: 'EXPIRED' } });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('canceled'); // same aggregate class as CANCELED — the stop is gone either way
    expect(ctx.orders.get(STOP_COID)?.state).toBe('EXPIRED');
    expect(ctx.store.fills.size).toBe(0);
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);
    const ev = ctx.store.events.find((e) => e.dedupeKey === 'algo-hist:EXPIRED:999');
    expect(ev?.event).toEqual({ type: 'VENUE_EXPIRED' });
  });

  it('journal rejects the terminal fold as a duplicate: no local commit, in-flight untouched', async () => {
    const ctx = build({ openAlgo: [], algoStatus: CANCELED_VIEW });
    seedAlgoIntent(ctx);
    // Journal-before-commit (I1): another pass already appended this exact (clientOrderId,
    // dedupeKey) row and died before committing locally. The journal is the idempotency authority,
    // so this pass must not re-fold in memory off a row it did not write.
    await ctx.store.appendOrderEvent({
      clientOrderId: STOP_COID,
      dedupeKey: 'algo-hist:CANCELED:999',
      event: { type: 'VENUE_CANCELED' },
      derivedState: 'CANCELED',
      cumQty: '0',
    });

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('canceled');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED'); // never committed
    expect(ctx.store.events).toHaveLength(1); // only the pre-existing row
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1); // never retired
  });

  it('local order row gone by the time the terminal fold runs: no journal write, no commit', async () => {
    const script: ExchangeScript = { openAlgo: [], algoStatus: CANCELED_VIEW };
    const ctx = build(script);
    seedAlgoIntent(ctx);
    // OrderBookService is a runtime CACHE of the durable event log (its own header says so) and the
    // anchor scan is separated from the fold by two awaited venue calls, so the row can be gone by
    // the time the fold looks for it. There is no public evict API, so the disappearance is
    // injected at exactly that seam.
    const realGet = ctx.orders.get.bind(ctx.orders);
    script.onAlgoStatus = () => {
      ctx.orders.get = () => undefined;
    };

    const result = await ctx.svc.recoverSymbol(SYM_PERP);
    ctx.orders.get = realGet;

    expect(result).toBe('canceled'); // the venue truth is still a positive terminal identification
    expect(ctx.store.events).toHaveLength(0); // nothing journaled without a record to reduce
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1); // never retired
  });

  it('order turned terminal mid-recovery (a concurrent fold won the race): unknown, no fill folded', async () => {
    const script: ExchangeScript = {
      openAlgo: [],
      algoStatus: TRIGGERED_VIEW,
      trades: [SPAWNED_TRADE],
    };
    const ctx = build(script);
    seedAlgoIntent(ctx);
    script.onTrades = () => {
      const rec = ctx.orders.get(STOP_COID);
      if (rec === undefined) throw new Error('seed failed');
      // The regular fill pipeline folded the same venue fill first and retired the order while this
      // pass was still fetching trades.
      ctx.orders.commit({ ...rec, state: 'FILLED', cumQty: rec.qty });
    };

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    // Fail OPEN: no second fold onto an already-retired order, and no mutation at all — the drift
    // axis stays the fail-closed backstop.
    expect(result).toBe('unknown');
    expect(ctx.store.fills.size).toBe(0);
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.orders.get(STOP_COID)?.cumQty.toFixed()).toBe('0.001'); // only the racing fold's work
  });

  it('carries the venue trade fee onto the folded fill record (exact strings)', async () => {
    const trade: VenueFill = { ...SPAWNED_TRADE, fee: { ccy: 'USDT', amount: '0.0468724' } };
    const ctx = build({ openAlgo: [], algoStatus: TRIGGERED_VIEW, trades: [trade] });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('triggered');
    const fill = ctx.store.fills.get(`${V_PERP}|${SYM_PERP}|t1`);
    expect(fill?.fee?.ccy).toBe('USDT');
    expect(fill?.fee?.amount.toFixed()).toBe('0.0468724'); // exact string, never toBeCloseTo
  });

  it('a NON-Error rejection from the algo-history rail is treated as unknown just the same', async () => {
    const ctx = build({
      openAlgo: [],
      algoStatusThrow: true,
      algoStatusThrowAs: 'algo history 503', // a transport layer can reject with a bare string
    });
    seedAlgoIntent(ctx);

    const result = await ctx.svc.recoverSymbol(SYM_PERP);

    expect(result).toBe('unknown');
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(1);
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

  it('order row vanishes between the pre-check and the per-candidate fold: skipped, reservation unwound', async () => {
    const ctx = build({ openAlgo: [], algoStatus: TRIGGERED_VIEW, trades: [SPAWNED_TRADE] });
    await seedPostBootAlgoIntent(ctx); // no in-flight anchor, so the unwind below is observable
    const realGet = ctx.orders.get.bind(ctx.orders);
    let lookups = 0;
    ctx.orders.get = (coid) => {
      // Lookup 1 is the pre-loop rec0 check, lookup 2 the per-candidate one — a concurrent path
      // dropped the row from the runtime cache in between. Later lookups see it again: the book is
      // a projection of the durable log, not the log itself.
      lookups += 1;
      return lookups === 2 ? undefined : realGet(coid);
    };

    const result = await ctx.svc.recoverSymbol(SYM_PERP);
    ctx.orders.get = realGet;

    expect(result).toBe('triggered'); // the venue answer is still a positive identification
    expect(ctx.store.fills.size).toBe(0); // ingest is a no-op with no live record to fold onto
    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0); // not stranded
  });
});

describe('AlgoStopRecoveryService.sweep', () => {
  const SYM_ETH = symbolId('ETH/USDT:USDT');
  const ETH_COID = clientOrderId('cbp' + 'e'.repeat(32));

  // A second anchor on a different symbol, same post-restart geometry (record present, intent only
  // in the write-ahead store), so one sweep exercises both symbols' passes.
  async function seedEthAnchor(ctx: Ctx): Promise<void> {
    await seedPostBootAlgoIntent(ctx, { clientOrderId: ETH_COID, symbol: SYM_ETH });
  }

  it('recovers every swept symbol that carries an anchor', async () => {
    const ctx = build({ openAlgo: [], algoStatus: CANCELED_VIEW });
    seedAlgoIntent(ctx);
    await seedEthAnchor(ctx);

    await ctx.svc.sweep([SYM_PERP, SYM_ETH]);

    expect(ctx.orders.get(STOP_COID)?.state).toBe('CANCELED');
    expect(ctx.orders.get(ETH_COID)?.state).toBe('CANCELED');
    expect(ctx.store.events).toHaveLength(2); // one venue-cancel fold per symbol
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);
  });

  it('a symbol whose anchor scan throws never aborts the symbols after it', async () => {
    const ctx = build({ openAlgo: [], algoStatus: CANCELED_VIEW });
    seedAlgoIntent(ctx); // BTC: in-flight anchor, resolved without any store read
    await seedEthAnchor(ctx); // ETH: store-only anchor, so the scan does read the store
    const realLoad = ctx.store.loadIntentByClientOrderId.bind(ctx.store);
    let loads = 0;
    ctx.store.loadIntentByClientOrderId = (coid) => {
      // A transient store failure during the FIRST symbol's scan (the scan walks every record, so
      // it reads the store even for a symbol whose own anchor is in-flight); the connection
      // recovers immediately after.
      loads += 1;
      return loads === 1 ? Promise.reject(new Error('order_intents unavailable')) : realLoad(coid);
    };

    await expect(ctx.svc.sweep([SYM_PERP, SYM_ETH])).resolves.toBeUndefined();

    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED'); // its own pass threw before any fold
    expect(ctx.orders.get(ETH_COID)?.state).toBe('CANCELED'); // the next symbol still recovered
  });

  it('a non-Error throw from one symbol is tolerated identically', async () => {
    const ctx = build({ openAlgo: [], algoStatus: CANCELED_VIEW });
    seedAlgoIntent(ctx);
    await seedEthAnchor(ctx);
    const realLoad = ctx.store.loadIntentByClientOrderId.bind(ctx.store);
    let loads = 0;
    ctx.store.loadIntentByClientOrderId = (coid) => {
      loads += 1;
      if (loads > 1) return realLoad(coid);
      // The non-Error rejection value IS the case under test (the String(err) log path).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject('order_intents unavailable');
    };

    await expect(ctx.svc.sweep([SYM_PERP, SYM_ETH])).resolves.toBeUndefined();

    expect(ctx.orders.get(STOP_COID)?.state).toBe('ACKED');
    expect(ctx.orders.get(ETH_COID)?.state).toBe('CANCELED');
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
