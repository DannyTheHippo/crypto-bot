import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { BootRecoveryService } from '../../../src/features/trading/execution/boot-recovery.service';
import { PortfolioStateService } from '../../../src/features/trading/execution/portfolio-state.service';
import { OrderBookService } from '../../../src/features/trading/execution/order-book.service';
import type { CrashRecoveryService } from '../../../src/features/trading/execution/crash-recovery.service';
import { FeeLedgerService } from '../../../src/features/trading/execution/fee-ledger.service';
import { positionKey } from '../../../src/domain/risk/evaluate';
import type {
  ExecutionStorePort,
  EquitySample,
  RecoveredOpenOrder,
  PersistedOrderEvent,
} from '../../../src/ports/execution';
import type { Position } from '../../../src/domain/types/portfolio';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import type { OrderRecord, OrderState } from '../../../src/domain/oms/reducer';
import { price, qty } from '../../../src/domain/types/money';
import { clientOrderId, intentId, epochMs } from '../../../src/domain/types/ids';
import { SID, V, SYM } from './helpers';

type RecoverySnap = Awaited<ReturnType<ExecutionStorePort['loadRecoverySnapshot']>>;

function makePortfolio(): PortfolioStateService {
  return new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
}

// store fake: BootRecoveryService calls loadRecoverySnapshot + loadOpenOrders + loadFilledQty,
// and journals cum rebuilds through appendOrderEvent (captured for assertions).
function fakeStore(
  snap: RecoverySnap,
  open: RecoveredOpenOrder[],
  filledQty: Record<string, string> = {},
): ExecutionStorePort & { journaled: PersistedOrderEvent[] } {
  const journaled: PersistedOrderEvent[] = [];
  return {
    journaled,
    loadRecoverySnapshot: () => Promise.resolve(snap),
    loadOpenOrders: () => Promise.resolve(open),
    loadFilledQty: (coid: string) => Promise.resolve(filledQty[String(coid)] ?? '0'),
    appendOrderEvent: (ev: PersistedOrderEvent) => {
      journaled.push(ev);
      return Promise.resolve({ applied: true });
    },
  } as unknown as ExecutionStorePort & { journaled: PersistedOrderEvent[] };
}

function intentFor(coid: string): OrderIntent {
  return {
    intentId: intentId('0190abcd-1234-7abc-89ab-0123456789ab'),
    clientOrderId: clientOrderId(coid),
    strategyId: SID,
    venue: V,
    symbol: SYM,
    side: 'BUY',
    type: 'LIMIT',
    qty: qty('1'),
    limitPrice: price('100'),
    timeInForce: 'GTC',
    reduceOnly: false,
    mode: 'testnet',
    refPrice: price('100'),
    refSeq: 1n,
    createdAt: epochMs(1_700_000_000_000),
    expiresAt: epochMs(1_700_000_060_000),
    source: {
      dedupeKey: 'sig-1',
      eventTime: epochMs(1_700_000_000_000),
      basedOnSeq: 1n,
      strength: 1,
    },
  };
}

function recovered(
  state: OrderState,
  coid: string,
  over: { qty?: string; cumQty?: string; intent?: OrderIntent | null } = {},
): RecoveredOpenOrder {
  const record: OrderRecord = {
    clientOrderId: clientOrderId(coid),
    state,
    qty: new Decimal(over.qty ?? '1'),
    cumQty: new Decimal(over.cumQty ?? '0'),
    stepSize: '0.00000001',
    attempt: 0,
    cancelWanted: false,
  };
  return {
    record,
    strategyId: SID,
    summary: {
      clientOrderId: clientOrderId(coid),
      symbol: SYM,
      side: 'BUY',
      qty: qty(over.qty ?? '1'),
      limitPrice: price('100'),
    },
    intent: over.intent ?? null,
  };
}

function crashRecoveryStub(calls: { n: number }): CrashRecoveryService {
  return {
    recoverOnBoot: () => {
      calls.n += 1;
      return Promise.resolve([]);
    },
  } as unknown as CrashRecoveryService;
}

const SAMPLE: EquitySample = {
  ts: epochMs(1_700_000_100_000),
  equity: '49850.5',
  cash: '19850.5',
  unrealized: '0',
  peak: '50000',
  sessionDateUtc: '2026-06-14',
};

const POS: Position = {
  strategyId: SID,
  venue: V,
  symbol: SYM,
  signedQty: new Decimal('1.5'),
  avgEntry: price('20000'),
  realizedPnl: new Decimal('12.25'),
};

const OPEN_ORDER = recovered('ACKED', 'cbp-recover-00000000000000000000001');

describe('BootRecoveryService (§4.2 snapshot-restore)', () => {
  it('restores portfolio P/L + positions and seeds open orders, then runs crash recovery', async () => {
    const portfolio = makePortfolio();
    const orderBook = new OrderBookService();
    const calls = { n: 0 };
    const svc = new BootRecoveryService(
      fakeStore({ latest: SAMPLE, sodEquity: '49000', positions: [POS] }, [OPEN_ORDER]),
      portfolio,
      orderBook,
      crashRecoveryStub(calls),
    );

    await svc.recoverOnBoot('testnet');

    const s = portfolio.snapshot();
    expect(portfolio.cashBalance().toFixed()).toBe('19850.5');
    expect(s.equity.toFixed()).toBe('49850.5');
    expect(s.peakEquity.toFixed()).toBe('50000');
    expect(s.sodEquityUtc.toFixed()).toBe('49000'); // sodEquity present → used verbatim
    expect(s.positions.get(positionKey(SID, V, SYM))?.signedQty.toFixed()).toBe('1.5');
    expect(orderBook.all()).toHaveLength(1);
    expect(orderBook.all()[0]!.clientOrderId).toBe(OPEN_ORDER.record.clientOrderId);
    // The venue-acked order is also registered in the portfolio open set, so reconciliation can
    // adopt venue truth for it and the stale-entry sweep can see it (2026-07-07).
    expect(s.openOrders).toHaveLength(1);
    expect(s.openOrders[0]!.clientOrderId).toBe(OPEN_ORDER.record.clientOrderId);
    expect(calls.n).toBe(1);
  });

  it('registers only venue-confirmed states in the portfolio open set (never-landed rows stay book-only)', async () => {
    const portfolio = makePortfolio();
    const orderBook = new OrderBookService();
    const svc = new BootRecoveryService(
      fakeStore({ latest: null, sodEquity: null, positions: [] }, [
        recovered('ACKED', 'cbp-recover-00000000000000000000011'),
        recovered('PARTIALLY_FILLED', 'cbp-recover-00000000000000000000012'),
        recovered('CANCEL_PENDING', 'cbp-recover-00000000000000000000013'),
        recovered('CANCEL_UNKNOWN', 'cbp-recover-00000000000000000000014'),
        recovered('NEW', 'cbp-recover-00000000000000000000015'),
        recovered('SUBMIT_UNKNOWN', 'cbp-recover-00000000000000000000016'),
        recovered('RECONCILE_REQUIRED', 'cbp-recover-00000000000000000000017'),
      ]),
      portfolio,
      orderBook,
      crashRecoveryStub({ n: 0 }),
    );

    await svc.recoverOnBoot('testnet');

    expect(orderBook.all()).toHaveLength(7); // every non-terminal row still seeds the book
    const registered = portfolio
      .snapshot()
      .openOrders.map((o) => String(o.clientOrderId))
      .sort();
    expect(registered).toEqual([
      'cbp-recover-00000000000000000000011',
      'cbp-recover-00000000000000000000012',
      'cbp-recover-00000000000000000000013',
      'cbp-recover-00000000000000000000014',
    ]);
  });

  it('is a no-op when no snapshot exists (paper / first boot): portfolio stays at starting cash', async () => {
    const portfolio = makePortfolio();
    const orderBook = new OrderBookService();
    const calls = { n: 0 };
    const svc = new BootRecoveryService(
      fakeStore({ latest: null, sodEquity: null, positions: [] }, []),
      portfolio,
      orderBook,
      crashRecoveryStub(calls),
    );

    await svc.recoverOnBoot('paper');

    expect(portfolio.cashBalance().toFixed()).toBe('100000'); // unchanged
    expect(portfolio.snapshot().positions.size).toBe(0);
    expect(orderBook.all()).toHaveLength(0);
    expect(calls.n).toBe(1); // crash recovery still runs (degrades nothing on an empty book)
  });

  it('falls back to restored equity for the start-of-day anchor when no session-start sample exists', async () => {
    const portfolio = makePortfolio();
    const svc = new BootRecoveryService(
      fakeStore({ latest: SAMPLE, sodEquity: null, positions: [] }, []),
      portfolio,
      new OrderBookService(),
      crashRecoveryStub({ n: 0 }),
    );

    await svc.recoverOnBoot('live');

    // sodEquity null (down across UTC midnight) → anchor = restored equity.
    expect(portfolio.snapshot().sodEquityUtc.toFixed()).toBe('49850.5');
  });

  // 2026-07-11 regression: a venue-FILLED order stranded at RECONCILE_REQUIRED with a regressed
  // cum cache (1.67 of 5.65) while the fill journal held all three partials. Recovery rebuilds
  // cum from the fill journal, terminalizing the order via a journaled FILL fold.
  it('rebuilds cum from the fill journal and terminalizes an order whose journal already holds full qty', async () => {
    const portfolio = makePortfolio();
    const orderBook = new OrderBookService();
    const coid = 'cbp-recover-00000000000000000000021';
    const store = fakeStore(
      { latest: null, sodEquity: null, positions: [] },
      [recovered('RECONCILE_REQUIRED', coid, { qty: '5.65', cumQty: '1.67' })],
      { [coid]: '5.65' },
    );
    const svc = new BootRecoveryService(store, portfolio, orderBook, crashRecoveryStub({ n: 0 }));

    await svc.recoverOnBoot('testnet');

    const rec = orderBook.get(clientOrderId(coid));
    expect(rec?.state).toBe('FILLED');
    expect(rec?.cumQty.toFixed()).toBe('5.65');
    // The rebuild is journaled (idempotent dedupe key carries the rebuilt total) so the store
    // chokepoint stamps terminal_at; a healed-terminal order never registers open.
    expect(store.journaled).toHaveLength(1);
    expect(store.journaled[0]?.dedupeKey).toBe('boot:cum-rebuild:5.65');
    expect(store.journaled[0]?.derivedState).toBe('FILLED');
    expect(portfolio.snapshot().openOrders).toHaveLength(0);
  });

  it('rebuilds a lagging partial cum without terminalizing and still registers the order open', async () => {
    const portfolio = makePortfolio();
    const orderBook = new OrderBookService();
    const coid = 'cbp-recover-00000000000000000000022';
    const store = fakeStore(
      { latest: null, sodEquity: null, positions: [] },
      [recovered('PARTIALLY_FILLED', coid, { qty: '5.65', cumQty: '1.67' })],
      { [coid]: '3.98' },
    );
    const svc = new BootRecoveryService(store, portfolio, orderBook, crashRecoveryStub({ n: 0 }));

    await svc.recoverOnBoot('testnet');

    const rec = orderBook.get(clientOrderId(coid));
    expect(rec?.state).toBe('PARTIALLY_FILLED');
    expect(rec?.cumQty.toFixed()).toBe('3.98');
    expect(portfolio.snapshot().openOrders).toHaveLength(1);
  });

  it('leaves a row untouched when the fill journal overflows the order qty (I4 — logged, boot survives)', async () => {
    const portfolio = makePortfolio();
    const orderBook = new OrderBookService();
    const coid = 'cbp-recover-00000000000000000000024';
    const store = fakeStore(
      { latest: null, sodEquity: null, positions: [] },
      [recovered('ACKED', coid, { qty: '1', cumQty: '0' })],
      { [coid]: '2' }, // journal holds double the order qty — reducer refuses (cum overflow)
    );
    const svc = new BootRecoveryService(store, portfolio, orderBook, crashRecoveryStub({ n: 0 }));

    await svc.recoverOnBoot('testnet'); // must not throw — bounded to the one order

    const rec = orderBook.get(clientOrderId(coid));
    expect(rec?.state).toBe('ACKED');
    expect(rec?.cumQty.toFixed()).toBe('0');
    expect(store.journaled).toHaveLength(0);
  });

  it('heals the in-memory record even when a prior boot already journaled the rebuild (stale row cache)', async () => {
    // A prior boot crashed between the order_events insert and the orders-row cache update:
    // the dedupe key exists (appendOrderEvent → applied:false) but the loaded record still
    // shows the stale cum. The healed record must win on both paths.
    const portfolio = makePortfolio();
    const orderBook = new OrderBookService();
    const coid = 'cbp-recover-00000000000000000000025';
    const store = fakeStore(
      { latest: null, sodEquity: null, positions: [] },
      [recovered('RECONCILE_REQUIRED', coid, { qty: '5.65', cumQty: '1.67' })],
      { [coid]: '5.65' },
    );
    store.appendOrderEvent = () => Promise.resolve({ applied: false }); // dedupe hit
    const svc = new BootRecoveryService(store, portfolio, orderBook, crashRecoveryStub({ n: 0 }));

    await svc.recoverOnBoot('testnet');

    const rec = orderBook.get(clientOrderId(coid));
    expect(rec?.state).toBe('FILLED');
    expect(rec?.cumQty.toFixed()).toBe('5.65');
    expect(portfolio.snapshot().openOrders).toHaveLength(0);
  });

  it('leaves a NEW row with journaled fills untouched (corruption is logged, never folded or thrown)', async () => {
    const portfolio = makePortfolio();
    const orderBook = new OrderBookService();
    const coid = 'cbp-recover-00000000000000000000023';
    const store = fakeStore(
      { latest: null, sodEquity: null, positions: [] },
      [recovered('NEW', coid, { qty: '1', cumQty: '0' })],
      { [coid]: '1' },
    );
    const svc = new BootRecoveryService(store, portfolio, orderBook, crashRecoveryStub({ n: 0 }));

    await svc.recoverOnBoot('testnet');

    expect(orderBook.get(clientOrderId(coid))?.state).toBe('NEW');
    expect(store.journaled).toHaveLength(0);
  });

  // 2026-07-11 regression: a recovered order's later fill was journaled but never applied to the
  // portfolio (no in-memory intent → FillIngestor skipped applyFill → an unmanaged 6.9-LINK
  // position). Recovery restores the persisted write-ahead intent alongside the order.
  it('rehydrates the persisted intent for venue-confirmed recovered orders so later fills apply', async () => {
    const portfolio = makePortfolio();
    const ackedCoid = 'cbp-recover-00000000000000000000031';
    const newCoid = 'cbp-recover-00000000000000000000032';
    const svc = new BootRecoveryService(
      fakeStore({ latest: null, sodEquity: null, positions: [] }, [
        recovered('ACKED', ackedCoid, { intent: intentFor(ackedCoid) }),
        recovered('NEW', newCoid, { intent: intentFor(newCoid) }),
      ]),
      portfolio,
      new OrderBookService(),
      crashRecoveryStub({ n: 0 }),
    );

    await svc.recoverOnBoot('testnet');

    // Venue-confirmed → intent restored (fill application / resolver / E1 clamp all see it).
    expect(portfolio.inFlightIntent(clientOrderId(ackedCoid))).toBeDefined();
    // Never-landed rows stay book-only: no open registration, no intent.
    expect(portfolio.inFlightIntent(clientOrderId(newCoid))).toBeUndefined();
  });
});
