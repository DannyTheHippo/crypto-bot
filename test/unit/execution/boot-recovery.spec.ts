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
} from '../../../src/ports/execution';
import type { Position } from '../../../src/domain/types/portfolio';
import type { OrderRecord, OrderState } from '../../../src/domain/oms/reducer';
import { price, qty } from '../../../src/domain/types/money';
import { clientOrderId, epochMs } from '../../../src/domain/types/ids';
import { SID, V, SYM } from './helpers';

type RecoverySnap = Awaited<ReturnType<ExecutionStorePort['loadRecoverySnapshot']>>;

function makePortfolio(): PortfolioStateService {
  return new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
}

// store fake: BootRecoveryService only calls loadRecoverySnapshot + loadOpenOrders.
function fakeStore(snap: RecoverySnap, open: RecoveredOpenOrder[]): ExecutionStorePort {
  return {
    loadRecoverySnapshot: () => Promise.resolve(snap),
    loadOpenOrders: () => Promise.resolve(open),
  } as unknown as ExecutionStorePort;
}

function recovered(state: OrderState, coid: string): RecoveredOpenOrder {
  const record: OrderRecord = {
    clientOrderId: clientOrderId(coid),
    state,
    qty: new Decimal('1'),
    cumQty: new Decimal('0'),
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
      qty: qty('1'),
      limitPrice: price('100'),
    },
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
});
