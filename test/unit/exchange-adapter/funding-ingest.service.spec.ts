import { describe, it, expect } from 'vitest';
import { FundingIngestService } from '../../../src/features/trading/exchange/funding-ingest.service';
import type { ExchangePort, VenueFundingPayment } from '../../../src/ports/exchange';
import type { FundingPaymentRow, FundingPaymentsPort } from '../../../src/ports/funding-payments';
import type { ClockPort } from '../../../src/ports/clock';
import { symbolId, venueId, epochMs } from '../../../src/domain/types/ids';

const SYM = symbolId('BTC/USDT:USDT');
const VEN = venueId('binanceusdm');

function mutableClock(start = 1_000_000): { clock: ClockPort; set: (t: number) => void } {
  let t = start;
  return { clock: { now: () => epochMs(t) }, set: (n) => (t = n) };
}

function payment(amountQuote: string, fundingTime: number, id = '1'): VenueFundingPayment {
  return {
    venue: VEN,
    symbol: SYM,
    venuePaymentId: id,
    amountQuote,
    fundingTime: epochMs(fundingTime),
  };
}

// Full-interface fixture (unused methods reject) — mirrors unknown-resolver.spec.ts's own
// ExchangePort fixture convention.
function fixtureExchange(
  fetchFundingPayments?: ExchangePort['fetchFundingPayments'],
): ExchangePort {
  return {
    venue: VEN,
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
    fetchOpenOrders: () => Promise.reject(new Error('unused')),
    fetchBalances: () => Promise.reject(new Error('unused')),
    fetchMyTrades: () => Promise.reject(new Error('unused')),
    validateCredentials: () => Promise.reject(new Error('unused')),
    fetchFundingPayments,
  };
}

function fakeRepo(overrides: Partial<FundingPaymentsPort> = {}): FundingPaymentsPort & {
  recorded: FundingPaymentRow[][];
} {
  const recorded: FundingPaymentRow[][] = [];
  return {
    recorded,
    record: (rows) => {
      recorded.push([...rows]);
      return Promise.resolve();
    },
    latestFundingTimeMs: () => Promise.resolve(null),
    ...overrides,
  };
}

describe('FundingIngestService', () => {
  it('records rows returned by the venue, stamped with the configured mode', async () => {
    const exchange = fixtureExchange(() => Promise.resolve([payment('1.5', 2_000)]));
    const repo = fakeRepo();
    const { clock } = mutableClock();
    const svc = new FundingIngestService(exchange, repo, {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock,
    });
    await svc.pollAll();
    expect(repo.recorded).toEqual([[{ ...payment('1.5', 2_000), mode: 'testnet' }]]);
  });

  it('a RECEIVED (positive) settlement accumulates positively in cumulativeAccrualQuote', async () => {
    const exchange = fixtureExchange(() => Promise.resolve([payment('2.5', 2_000)]));
    const svc = new FundingIngestService(exchange, fakeRepo(), {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
    });
    await svc.pollAll();
    expect(svc.cumulativeAccrualQuote(SYM)).toBe('2.5');
  });

  it('a PAID (negative) settlement accumulates negatively (opposite sign, same magnitude)', async () => {
    const exchange = fixtureExchange(() => Promise.resolve([payment('-2.5', 2_000)]));
    const svc = new FundingIngestService(exchange, fakeRepo(), {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
    });
    await svc.pollAll();
    expect(svc.cumulativeAccrualQuote(SYM)).toBe('-2.5');
  });

  it('accrual accumulates ACROSS polls, not just within one', async () => {
    let call = 0;
    const exchange = fixtureExchange(() => {
      call += 1;
      return Promise.resolve([payment(call === 1 ? '1' : '2', 2_000 * call, String(call))]);
    });
    const svc = new FundingIngestService(exchange, fakeRepo(), {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
    });
    await svc.pollAll();
    await svc.pollAll();
    expect(svc.cumulativeAccrualQuote(SYM)).toBe('3');
  });

  it('resumes from the DB cursor: sinceMs is latestFundingTimeMs, not epoch 0', async () => {
    const seenSinceMs: number[] = [];
    const exchange = fixtureExchange((_symbol, sinceMs) => {
      seenSinceMs.push(sinceMs);
      return Promise.resolve([]);
    });
    const repo = fakeRepo({ latestFundingTimeMs: () => Promise.resolve(5_000) });
    const svc = new FundingIngestService(exchange, repo, {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
    });
    await svc.pollAll();
    expect(seenSinceMs).toEqual([5_000]);
  });

  it('a re-poll that returns the SAME rows is safe to replay (idempotency is the repo/unique-index concern, not double-counted here)', async () => {
    const exchange = fixtureExchange(() => Promise.resolve([payment('1', 2_000)]));
    const repo = fakeRepo();
    const svc = new FundingIngestService(exchange, repo, {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
    });
    await svc.pollAll();
    await svc.pollAll();
    // record() was called twice with the same row — ON CONFLICT DO NOTHING (funding_payments'
    // unique index) is what makes this safe at the DB layer; this test pins that the service
    // itself never suppresses a resend.
    expect(repo.recorded).toHaveLength(2);
    expect(repo.recorded[0]).toEqual(repo.recorded[1]);
  });

  it('a venue with no fetchFundingPayments (spot/paper) never throws and never records', async () => {
    const exchange = fixtureExchange(undefined);
    const repo = fakeRepo();
    const svc = new FundingIngestService(exchange, repo, {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
    });
    await expect(svc.pollAll()).resolves.toBeUndefined();
    expect(repo.recorded).toEqual([]);
    expect(svc.pollErrorCount()).toBe(0);
  });

  it('a poll failure logs + increments the error counter, never throws (measurement gate fails OPEN)', async () => {
    const exchange = fixtureExchange(() => Promise.reject(new Error('venue down')));
    const warnings: string[] = [];
    const svc = new FundingIngestService(exchange, fakeRepo(), {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
      logger: { warn: (m) => warnings.push(m) },
    });
    await expect(svc.pollAll()).resolves.toBeUndefined();
    expect(svc.pollErrorCount()).toBe(1);
    expect(warnings[0]).toContain('venue down');
  });

  it('W1: records via the optional metrics hook on a non-empty poll, and never calls it on an empty poll', async () => {
    const recorded: Array<[string, string, number]> = [];
    const exchange = fixtureExchange(() =>
      Promise.resolve([payment('1', 2_000), payment('2', 3_000, '2')]),
    );
    const svc = new FundingIngestService(exchange, fakeRepo(), {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
      metrics: { recordIngested: (venue, symbol, count) => recorded.push([venue, symbol, count]) },
    });
    await svc.pollAll();
    expect(recorded).toEqual([[VEN, SYM, 2]]);
  });

  it('W1: the metrics hook is never called on a zero-row poll', async () => {
    const recorded: Array<[string, string, number]> = [];
    const exchange = fixtureExchange(() => Promise.resolve([]));
    const svc = new FundingIngestService(exchange, fakeRepo(), {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
      metrics: { recordIngested: (venue, symbol, count) => recorded.push([venue, symbol, count]) },
    });
    await svc.pollAll();
    expect(recorded).toEqual([]);
  });

  it('a re-poll that re-delivers the cursor-boundary row (since=cursor is inclusive) counts it ONCE in cumulativeAccrualQuote and in the metrics hook', async () => {
    let call = 0;
    const exchange = fixtureExchange(() => {
      call += 1;
      // First poll delivers the boundary row; second poll re-delivers the SAME row (inclusive
      // since=cursor overlap) plus one genuinely new row.
      return Promise.resolve(
        call === 1
          ? [payment('1', 2_000, 'a')]
          : [payment('1', 2_000, 'a'), payment('4', 3_000, 'b')],
      );
    });
    const recorded: Array<[string, string, number]> = [];
    const svc = new FundingIngestService(exchange, fakeRepo(), {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
      metrics: { recordIngested: (venue, symbol, count) => recorded.push([venue, symbol, count]) },
    });
    await svc.pollAll();
    expect(svc.cumulativeAccrualQuote(SYM)).toBe('1');
    await svc.pollAll();
    // Boundary row 'a' re-delivered but already accrued — only 'b' (4) is new: 1 + 4 = 5, not 1 + 1 + 4.
    expect(svc.cumulativeAccrualQuote(SYM)).toBe('5');
    expect(recorded).toEqual([
      [VEN, SYM, 1],
      [VEN, SYM, 1],
    ]);
  });

  it('zero rows on a polled symbol still resolves cumulativeAccrualQuote to "0" (distinguishes polled-empty from never-polled)', async () => {
    const exchange = fixtureExchange(() => Promise.resolve([]));
    const svc = new FundingIngestService(exchange, fakeRepo(), {
      symbols: [SYM],
      mode: 'testnet',
      pollIntervalMs: 60_000,
      clock: mutableClock().clock,
    });
    expect(svc.cumulativeAccrualQuote(SYM)).toBeNull();
    await svc.pollAll();
    expect(svc.cumulativeAccrualQuote(SYM)).toBe('0');
  });
});
