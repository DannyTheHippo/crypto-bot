import { describe, it, expect } from 'vitest';
import { UnknownResolverService } from '../../../src/features/trading/execution/unknown-resolver.service';
import { OrderBookService } from '../../../src/features/trading/execution/order-book.service';
import { PortfolioStateService } from '../../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/features/trading/execution/fee-ledger.service';
import { EquitySamplerService } from '../../../src/features/trading/execution/equity-sampler.service';
import { FillIngestorService } from '../../../src/features/trading/execution/fill-ingestor.service';
import { InMemoryExecutionStore } from '../../../src/features/trading/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import {
  AdapterError,
  type ExchangePort,
  type ExchangeOrderState,
  type AlgoOrderState,
  type VenueFill,
} from '../../../src/ports/exchange';
import type { KillSwitchPort } from '../../../src/ports/risk';
import { epochMs, venueId } from '../../../src/domain/types/ids';
import { makeIntent, fixedFeed, killSwitchStub, SYM, V, T } from './helpers';
import { qty, price } from '../../../src/domain/types/money';
import type { OrderIntent } from '../../../src/domain/types/order-intent';

const QUOTE = '0.001'; // step size used in tests

type FetchBehavior = ExchangeOrderState | (() => ExchangeOrderState);

function venueState(over: Partial<ExchangeOrderState> = {}): ExchangeOrderState {
  return {
    clientOrderId: makeIntent().clientOrderId,
    venueOrderId: 'v1',
    symbol: SYM,
    status: 'open',
    cumQty: '0',
    qty: '1',
    ...over,
  };
}

function build(
  opts: {
    fetch?: FetchBehavior;
    trades?: VenueFill[];
    tradesThrow?: boolean;
    // Push 3 P7f fix 2: opt-in fetchOpenAlgoOrders — absent means the adapter lacks the method
    // entirely (spot/paper), exactly the "treat as NOT FOUND" fallback fix 2's own comment covers.
    fetchOpenAlgoOrders?: () => Promise<AlgoOrderState[]>;
  } = {},
) {
  let nowMs = T;
  const clock = { now: () => epochMs(nowMs) };
  const setNow = (t: number) => {
    nowMs = t;
  };

  const store = new InMemoryExecutionStore();
  const orders = new OrderBookService();
  const portfolio = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
  const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), clock, store);
  const ingestor = new FillIngestorService(store, killSwitchStub().ks, orders, portfolio, sampler);

  const kills: Array<{ reason: string; flatten: boolean }> = [];
  const killSwitch: KillSwitchPort = {
    state: () => 'RUNNING',
    engage: (reason, flatten) => kills.push({ reason, flatten }),
    confirmCancels: () => undefined,
    cancelTimeout: () => undefined,
    allFlat: () => undefined,
  };

  const cancels: string[] = [];
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
    cancelOrder: (coid) => {
      cancels.push(coid);
      return Promise.resolve({ clientOrderId: coid, venueOrderId: 'v1' });
    },
    fetchOrder: () => {
      const b = opts.fetch ?? venueState();
      return Promise.resolve(typeof b === 'function' ? b() : b);
    },
    fetchOpenOrders: () => Promise.resolve([]),
    fetchBalances: () => Promise.resolve(new Map()),
    fetchMyTrades: () =>
      opts.tradesThrow
        ? Promise.reject(ambiguous('RequestTimeout'))
        : Promise.resolve(opts.trades ?? []),
    validateCredentials: () => Promise.reject(new Error('unused')),
    ...(opts.fetchOpenAlgoOrders ? { fetchOpenAlgoOrders: opts.fetchOpenAlgoOrders } : {}),
  };

  const resolver = new UnknownResolverService(
    clock,
    exchange,
    store,
    killSwitch,
    orders,
    portfolio,
    ingestor,
  );
  return { clock, setNow, store, orders, portfolio, resolver, kills, cancels };
}

type Ctx = ReturnType<typeof build>;

function seedUnknown(ctx: Ctx, kind: 'submit' | 'cancel', intent: OrderIntent = makeIntent()) {
  const coid = intent.clientOrderId;
  ctx.orders.create(initialOrder(coid, intent.qty, QUOTE));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  ctx.portfolio.addInFlight(intent);
  if (kind === 'submit') {
    ctx.orders.apply(coid, { type: 'SUBMIT_AMBIGUOUS' }); // SUBMITTING → SUBMIT_UNKNOWN
  } else {
    ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' });
    ctx.portfolio.openOrder(intent.strategyId, {
      clientOrderId: coid,
      symbol: SYM,
      side: 'BUY',
      qty: intent.qty,
    });
    ctx.orders.apply(coid, { type: 'CANCEL_REQUESTED' }); // ACKED → CANCEL_PENDING
    ctx.orders.apply(coid, { type: 'CANCEL_REJECT_UNKNOWN' }); // → CANCEL_UNKNOWN
  }
  return coid;
}

// The resolver auto-registers an unknown on the first tick it sees it (firstUnknownAt = that tick),
// then polls one backoff later. So a resolution needs two ticks: register, then poll. 5000ms steps
// always clear the largest jittered backoff (4000 × 1.2 = 4800), so each later tick is guaranteed due.
async function register(ctx: Ctx) {
  await ctx.resolver.tick(epochMs(T));
}
async function polls(ctx: Ctx, n: number) {
  for (let k = 1; k <= n; k++) await ctx.resolver.tick(epochMs(T + 5000 * k));
}
async function settle(ctx: Ctx) {
  await register(ctx);
  await polls(ctx, 1);
}

const fill = (coid: string, q: string, tradeId: string): VenueFill => ({
  venue: V,
  symbol: SYM,
  venueTradeId: tradeId,
  clientOrderId: coid as VenueFill['clientOrderId'],
  price: '100',
  qty: q,
  fee: null,
  liquidity: 'taker',
  venueTimestamp: epochMs(T),
});

const ambiguous = (code: string) => new AdapterError('OUTCOME_AMBIGUOUS', code, code);

describe('UnknownResolverService — SUBMIT_UNKNOWN resolution', () => {
  it('venue open (cum 0) → folds the ack and stops tracking', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'open', cumQty: '0' }) });
    const coid = seedUnknown(ctx, 'submit');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('ACKED');
    expect(ctx.resolver.trackedCount()).toBe(0);
  });

  it('venue open (cum > 0) → backfills fills to PARTIALLY_FILLED, stops tracking', async () => {
    const intent = makeIntent({ qty: qty('2') });
    const coid = intent.clientOrderId;
    const ctx = build({
      fetch: () => venueState({ status: 'open', cumQty: '1', qty: '2' }),
      trades: [fill(coid, '1', 'td1')],
    });
    seedUnknown(ctx, 'submit', intent);
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('PARTIALLY_FILLED');
    expect(ctx.resolver.trackedCount()).toBe(0);
  });

  it('venue closed + matching trades → backfill drives FILLED', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      fetch: () => venueState({ status: 'closed', cumQty: '1', qty: '1' }),
      trades: [fill(coid, '1', 'td-full')],
    });
    seedUnknown(ctx, 'submit');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('FILLED');
    expect(ctx.resolver.trackedCount()).toBe(0);
  });

  // Cluster-A: on the real venue, VenueFill.clientOrderId carries the numeric venue order id (ccxt
  // myTrades has no clientOrderId field), so a filled SUBMIT_UNKNOWN must rebuild cumQty by matching
  // on the venue order id this same fetchOrder call returned — never on p.coid alone.
  it('venue closed + venue-shaped trade (numeric order id, no coid) → backfill rebuilds cumQty and drives FILLED, no freeze — the ccxt myTrades path (cluster-A)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      fetch: () =>
        venueState({ status: 'closed', cumQty: '1', qty: '1', venueOrderId: '48212893' }),
      trades: [fill('48212893', '1', 'td-venue-shaped')], // numeric venue order id, not our coid
    });
    seedUnknown(ctx, 'submit');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('FILLED');
    expect(ctx.resolver.trackedCount()).toBe(0);
    expect(ctx.resolver.isFrozen(SYM)).toBe(false); // rebuilt from the fill, never a false freeze
  });

  it('venue canceled → VENUE_CANCELED → CANCELED', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'canceled' }) });
    const coid = seedUnknown(ctx, 'submit');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('CANCELED');
  });

  it('venue rejected → REJECTED', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'rejected' }) });
    const coid = seedUnknown(ctx, 'submit');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('REJECTED');
  });

  it('venue expired → EXPIRED', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'expired' }) });
    const coid = seedUnknown(ctx, 'submit');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('EXPIRED');
  });

  it('not-found with live intent TTL → NEW (resubmit-eligible), reserve kept', async () => {
    const ctx = build({
      fetch: () => {
        throw ambiguous('OrderNotFound');
      },
    });
    const coid = seedUnknown(ctx, 'submit', makeIntent({ expiresAt: epochMs(T + 10_000) }));
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('NEW');
    expect(ctx.portfolio.inFlightIntent(coid)).toBeDefined(); // exposure still reserved
  });

  it('not-found with expired intent TTL → CANCELED, reserve released', async () => {
    const ctx = build({
      fetch: () => {
        throw ambiguous('OrderNotFound');
      },
    });
    const coid = seedUnknown(ctx, 'submit', makeIntent({ expiresAt: epochMs(T - 1) }));
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('CANCELED');
    expect(ctx.portfolio.inFlightIntent(coid)).toBeUndefined();
  });

  it('five transient inconclusive polls → RECONCILE_REQUIRED + frozen symbol', async () => {
    const ctx = build({
      fetch: () => {
        throw ambiguous('RequestTimeout');
      },
    });
    const coid = seedUnknown(ctx, 'submit');
    // Register, then five due polls (5000ms steps clear any jittered backoff); the 5th freezes.
    await register(ctx);
    await polls(ctx, 5);
    expect(ctx.orders.get(coid)?.state).toBe('RECONCILE_REQUIRED');
    expect(ctx.resolver.isFrozen(SYM)).toBe(true);
    expect(ctx.resolver.trackedCount()).toBe(0);
  });

  it('AUTH_FATAL on the query → engages the kill switch (no flatten)', async () => {
    const ctx = build({
      fetch: () => {
        throw new AdapterError('AUTH_FATAL', 'AuthenticationError', 'creds');
      },
    });
    seedUnknown(ctx, 'submit');
    await settle(ctx);
    expect(ctx.kills).toHaveLength(1);
    expect(ctx.kills[0]!.flatten).toBe(false);
    expect(ctx.kills[0]!.reason).toContain('AUTH_FATAL');
  });
});

describe('UnknownResolverService — escalation + cadence', () => {
  it('engages the kill switch once when an unknown is unresolved past 60s', async () => {
    // Keep it unresolved by returning a "closed" status with no backfillable trades.
    const ctx = build({
      fetch: () => venueState({ status: 'closed', cumQty: '0', qty: '1' }),
      trades: [],
    });
    seedUnknown(ctx, 'submit');
    await settle(ctx); // register + first poll
    await ctx.resolver.tick(epochMs(T + 61_000)); // > 60s since firstUnknownAt
    const sixtySec = ctx.kills.filter((k) => k.reason === 'UNKNOWN_UNRESOLVED_60S');
    expect(sixtySec).toHaveLength(1);
    expect(sixtySec[0]!.flatten).toBe(false);
  });

  it('does not track an unknown order that has no reserved in-flight intent', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'open', cumQty: '0' }) });
    const intent = makeIntent();
    const coid = intent.clientOrderId;
    ctx.orders.create(initialOrder(coid, intent.qty, QUOTE));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
    ctx.orders.apply(coid, { type: 'SUBMIT_AMBIGUOUS' }); // SUBMIT_UNKNOWN, but never added to in-flight
    await ctx.resolver.tick(epochMs(T));
    expect(ctx.resolver.trackedCount()).toBe(0); // reconciliation owns it, not the resolver
  });

  it('does nothing when no entry is due yet', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'open', cumQty: '0' }) });
    const coid = seedUnknown(ctx, 'submit');
    await ctx.resolver.tick(epochMs(T)); // registers, nextDueAt ≈ T+250 (not due at exactly T)
    expect(ctx.orders.get(coid)?.state).toBe('SUBMIT_UNKNOWN');
    expect(ctx.resolver.trackedCount()).toBe(1);
  });

  it('drops an entry resolved out-of-band by the stream before its next poll', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'open', cumQty: '0' }) });
    const coid = seedUnknown(ctx, 'submit');
    await ctx.resolver.tick(epochMs(T)); // register only
    ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'vX' }); // WS ack resolves it
    await ctx.resolver.tick(epochMs(T + 1)); // sync drops it
    expect(ctx.resolver.trackedCount()).toBe(0);
  });
});

describe('UnknownResolverService — CANCEL_UNKNOWN resolution', () => {
  it('venue canceled → CANCEL_ACK → CANCELED', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'canceled' }) });
    const coid = seedUnknown(ctx, 'cancel');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('CANCELED');
  });

  it('still open → re-issues cancel, freezing to RECONCILE_REQUIRED after >3 reissues', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'open', cumQty: '0' }) });
    const coid = seedUnknown(ctx, 'cancel');
    await register(ctx);
    await polls(ctx, 4); // 3 reissues, then the 4th sighting (still open) freezes
    expect(ctx.cancels.length).toBe(3); // capped reissues
    expect(ctx.orders.get(coid)?.state).toBe('RECONCILE_REQUIRED');
    expect(ctx.resolver.isFrozen(SYM)).toBe(true);
  });

  it('not-found → RECONCILE_REQUIRED (an order we hold an ack for cannot vanish)', async () => {
    const ctx = build({
      fetch: () => {
        throw ambiguous('OrderNotFound');
      },
    });
    const coid = seedUnknown(ctx, 'cancel');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('RECONCILE_REQUIRED');
  });

  it('venue reports rejected on a cancel-unknown → freezes (contradiction)', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'rejected' }) });
    const coid = seedUnknown(ctx, 'cancel');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('RECONCILE_REQUIRED');
  });

  it('venue reports expired on a cancel-unknown → freezes (contradiction)', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'expired' }) });
    const coid = seedUnknown(ctx, 'cancel');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('RECONCILE_REQUIRED');
  });

  it('venue closed (filled) + trades → backfill drives FILLED (fills win the cancel race)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      fetch: () => venueState({ status: 'closed', cumQty: '1', qty: '1' }),
      trades: [fill(coid, '1', 'race')],
    });
    seedUnknown(ctx, 'cancel');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('FILLED');
  });
});

describe('UnknownResolverService — backfill edge cases', () => {
  it('still folds the ack when fetchMyTrades fails (backfill is best-effort)', async () => {
    const intent = makeIntent({ qty: qty('2') });
    const coid = intent.clientOrderId;
    const ctx = build({
      fetch: () => venueState({ status: 'open', cumQty: '1', qty: '2' }),
      tradesThrow: true,
    });
    seedUnknown(ctx, 'submit', intent);
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // no fills applied, but the order resolves
  });

  it("skips a sibling order's trade on the same symbol and applies a fee-bearing fill", async () => {
    const intent = makeIntent({ qty: qty('2') });
    const coid = intent.clientOrderId;
    const trades: VenueFill[] = [
      { ...fill('cbpSIBLING0000', '1', 'td-foreign') }, // different clientOrderId — must be skipped
      { ...fill(coid, '1', 'td-fee'), fee: { ccy: 'USDT', amount: '0.1' } }, // ours, with a quote fee
    ];
    const ctx = build({
      fetch: () => venueState({ status: 'open', cumQty: '1', qty: '2' }),
      trades,
    });
    seedUnknown(ctx, 'submit', intent);
    await settle(ctx);
    expect(ctx.orders.get(coid)?.cumQty.toFixed()).toBe('1'); // only our fill counted
    expect(ctx.store.fills.size).toBe(1);
  });

  it('defers a non-AdapterError query failure as a transient attempt', async () => {
    const ctx = build({
      fetch: () => {
        throw new Error('socket hang up');
      },
    }); // not an AdapterError
    const coid = seedUnknown(ctx, 'submit');
    await settle(ctx); // register + one poll → deferred, not escalated
    expect(ctx.orders.get(coid)?.state).toBe('SUBMIT_UNKNOWN');
    expect(ctx.resolver.trackedCount()).toBe(1);
  });

  it('records no venueOrderId when the venue omits it', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'canceled', venueOrderId: '' }) });
    const coid = seedUnknown(ctx, 'submit');
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('CANCELED');
    expect(ctx.orders.get(coid)?.venueOrderId).toBeUndefined();
  });

  it('does not re-fold an event the journal already recorded (replay-safe)', async () => {
    const ctx = build({ fetch: () => venueState({ status: 'open', cumQty: '0' }) });
    const coid = seedUnknown(ctx, 'submit');
    // A prior life already journaled the ack under the resolver's dedupe key.
    await ctx.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey: 'query-ack',
      event: { type: 'ACK', venueOrderId: 'v1' },
      derivedState: 'ACKED',
      cumQty: '0',
    });
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('SUBMIT_UNKNOWN'); // fold skipped — journal said duplicate
    expect(ctx.resolver.trackedCount()).toBe(0); // but still untracked (resolution attempted)
  });
});

// Push 3 P7f fix 2: an algo-rail SUBMIT_UNKNOWN is resolved off fetchOpenAlgoOrders, never
// fetchOrder (the regular rail, which 404s for a perp STOP_MARKET).
function algoIntent(over: Partial<OrderIntent> = {}): OrderIntent {
  return makeIntent({
    venue: venueId('binanceusdm'),
    type: 'STOP_MARKET',
    triggerPrice: price('90'),
    ...over,
  });
}

describe('UnknownResolverService — algo-rail SUBMIT_UNKNOWN resolution (fix 2)', () => {
  it('never calls fetchOrder (the regular rail) for an algo-rail intent', async () => {
    let fetchOrderCalls = 0;
    const ctx = build({
      fetch: () => {
        fetchOrderCalls += 1;
        return venueState({ status: 'open' });
      },
      fetchOpenAlgoOrders: () => Promise.resolve([]),
    });
    seedUnknown(ctx, 'submit', algoIntent());
    await settle(ctx);
    expect(fetchOrderCalls).toBe(0);
  });

  it('FOUND on fetchOpenAlgoOrders (matching clientAlgoId) folds the ACK and stops tracking', async () => {
    const intent = algoIntent();
    const coid = intent.clientOrderId;
    const ctx = build({
      fetchOpenAlgoOrders: () =>
        Promise.resolve([
          {
            algoId: 'venue-algo-1',
            clientAlgoId: String(coid),
            symbol: SYM,
            side: 'SELL',
            type: 'STOP_MARKET',
            qty: '1',
            triggerPrice: '90',
            status: 'NEW',
            reduceOnly: true,
          },
        ]),
    });
    seedUnknown(ctx, 'submit', intent);
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('ACKED');
    expect(ctx.orders.get(coid)?.venueOrderId).toBe('venue-algo-1');
    expect(ctx.resolver.trackedCount()).toBe(0);
  });

  it('NOT FOUND proves nothing — stays pending indefinitely, never freezes to RECONCILE_REQUIRED', async () => {
    const intent = algoIntent();
    const coid = intent.clientOrderId;
    const ctx = build({ fetchOpenAlgoOrders: () => Promise.resolve([]) });
    seedUnknown(ctx, 'submit', intent);
    await register(ctx);
    await polls(ctx, 10); // far past MAX_QUERY_ATTEMPTS (5) — the regular rail would have frozen by now
    expect(ctx.orders.get(coid)?.state).toBe('SUBMIT_UNKNOWN'); // never resolved, never fabricated
    expect(ctx.resolver.trackedCount()).toBe(1); // still tracked
    expect(ctx.resolver.isFrozen(SYM)).toBe(false); // no false RECONCILE_REQUIRED freeze
  });

  it('an adapter that lacks fetchOpenAlgoOrders (spot/paper) is treated identically to NOT FOUND', async () => {
    const intent = algoIntent();
    const coid = intent.clientOrderId;
    const ctx = build(); // no fetchOpenAlgoOrders wired at all
    seedUnknown(ctx, 'submit', intent);
    await settle(ctx);
    expect(ctx.orders.get(coid)?.state).toBe('SUBMIT_UNKNOWN');
    expect(ctx.resolver.trackedCount()).toBe(1);
  });

  it('a query failure on fetchOpenAlgoOrders defers (transient), never freezes', async () => {
    const intent = algoIntent();
    const coid = intent.clientOrderId;
    const ctx = build({
      fetchOpenAlgoOrders: () => Promise.reject(new Error('network down')),
    });
    seedUnknown(ctx, 'submit', intent);
    await register(ctx);
    await polls(ctx, 10);
    expect(ctx.orders.get(coid)?.state).toBe('SUBMIT_UNKNOWN');
    expect(ctx.resolver.isFrozen(SYM)).toBe(false);
  });

  it('the rule-5 60s kill-switch watchdog still escalates for an unresolved algo-rail unknown', async () => {
    const ctx = build({ fetchOpenAlgoOrders: () => Promise.resolve([]) });
    seedUnknown(ctx, 'submit', algoIntent());
    await settle(ctx);
    await ctx.resolver.tick(epochMs(T + 61_000));
    const sixtySec = ctx.kills.filter((k) => k.reason === 'UNKNOWN_UNRESOLVED_60S');
    expect(sixtySec).toHaveLength(1);
  });
});
