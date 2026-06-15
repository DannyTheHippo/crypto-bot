import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { BootRecoveryService } from '../../../src/modules/execution/boot-recovery.service';
import { PortfolioStateService } from '../../../src/modules/execution/portfolio-state.service';
import { OrderBookService } from '../../../src/modules/execution/order-book.service';
import type { CrashRecoveryService } from '../../../src/modules/execution/crash-recovery.service';
import { FeeLedgerService } from '../../../src/modules/execution/fee-ledger.service';
import { positionKey } from '../../../src/domain/risk/evaluate';
import type { ExecutionStorePort, EquitySample } from '../../../src/ports/execution';
import type { Position } from '../../../src/domain/types/portfolio';
import type { OrderRecord } from '../../../src/domain/oms/reducer';
import { price } from '../../../src/domain/types/money';
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
function fakeStore(snap: RecoverySnap, open: OrderRecord[]): ExecutionStorePort {
  return {
    loadRecoverySnapshot: () => Promise.resolve(snap),
    loadOpenOrders: () => Promise.resolve(open),
  } as unknown as ExecutionStorePort;
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

const OPEN_ORDER: OrderRecord = {
  clientOrderId: clientOrderId('cbp-recover-00000000000000000000001'),
  state: 'ACKED',
  qty: new Decimal('1'),
  cumQty: new Decimal('0'),
  stepSize: '0.00000001',
  attempt: 0,
  cancelWanted: false,
};

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
    expect(orderBook.all()[0]!.clientOrderId).toBe(OPEN_ORDER.clientOrderId);
    expect(calls.n).toBe(1);
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
