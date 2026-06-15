import { describe, it, expect, vi } from 'vitest';
import type { Counter, Histogram } from 'prom-client';
import { FillIngestorService } from '../../../src/modules/execution/fill-ingestor.service';
import { OrderBookService } from '../../../src/modules/execution/order-book.service';
import { PortfolioStateService } from '../../../src/modules/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/modules/execution/fee-ledger.service';
import { EquitySamplerService } from '../../../src/modules/execution/equity-sampler.service';
import { InMemoryExecutionStore } from '../../../src/modules/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import { makeIntent, makeFill, fixedFeed, fixedClock, killSwitchStub, SYM } from './helpers';
import { price, qty } from '../../../src/domain/types/money';

function build(
  fillsCounter?: Counter<string>,
  filledQtyCounter?: Counter<string>,
  fullyFilledCounter?: Counter<string>,
  slippageDecision?: Histogram<string>,
) {
  const store = new InMemoryExecutionStore();
  const orders = new OrderBookService();
  const portfolio = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
  const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), fixedClock(), store);
  const { ks, engages } = killSwitchStub();
  const ingestor = new FillIngestorService(
    store,
    ks,
    orders,
    portfolio,
    sampler,
    fillsCounter,
    filledQtyCounter,
    fullyFilledCounter,
    slippageDecision,
  );
  return { store, orders, portfolio, ingestor, engages };
}

// Seed an ACKED, open, in-flight order exactly as the gate leaves it after a successful submit.
function seed(ctx: ReturnType<typeof build>, intent = makeIntent()) {
  const coid = intent.clientOrderId;
  ctx.orders.create(initialOrder(coid, intent.qty, '0.001'));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  const acked = ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' });
  ctx.portfolio.addInFlight(intent);
  ctx.portfolio.openOrder(intent.strategyId, {
    clientOrderId: coid,
    symbol: SYM,
    side: 'BUY',
    qty: intent.qty,
    limitPrice: price('100'),
  });
  return { coid, intent, acked };
}

describe('FillIngestorService', () => {
  it('applies a fill: dedupes, folds, updates the position, samples equity', async () => {
    const ctx = build();
    const { coid, acked } = seed(ctx, makeIntent({ qty: qty('2') }));
    const r = await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, qty: qty('1'), venueTradeId: 'td1' }),
      'rep1',
    );

    expect(r.applied).toBe(true);
    expect(r.record.state).toBe('PARTIALLY_FILLED');
    expect(r.record.cumQty.toFixed()).toBe('1');
    expect(ctx.store.fills.size).toBe(1);
    expect(ctx.portfolio.cashBalance().toFixed()).toBe('99900'); // 1 × 100 spent
    expect(ctx.store.equity.length).toBe(1);
  });

  it('is idempotent on (venue, symbol, venueTradeId): a duplicate applies nothing', async () => {
    const ctx = build();
    const { coid, acked } = seed(ctx, makeIntent({ qty: qty('2') }));
    const first = await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, venueTradeId: 'same' }),
      'rep1',
    );
    const dup = await ctx.ingestor.ingest(
      first.record,
      makeFill({ clientOrderId: coid, venueTradeId: 'same' }),
      'rep2',
    );

    expect(dup.applied).toBe(false);
    expect(dup.record).toBe(first.record); // unchanged
    expect(ctx.store.fills.size).toBe(1);
    expect(ctx.portfolio.cashBalance().toFixed()).toBe('99900'); // only one fill's money effect
  });

  it('retires the order from in-flight + open orders on a terminal (full) fill', async () => {
    const ctx = build();
    const { coid, acked } = seed(ctx); // qty 1
    const r = await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, qty: qty('1'), venueTradeId: 'full' }),
      'rep1',
    );

    expect(r.record.state).toBe('FILLED');
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);
    expect(ctx.portfolio.snapshot().openOrders).toHaveLength(0);
  });

  it('engages the kill switch on a same-tradeId, different-payload conflict (§6.6 I3)', async () => {
    const ctx = build();
    const { coid, acked } = seed(ctx, makeIntent({ qty: qty('2') }));
    const first = await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, venueTradeId: 'dupe', qty: qty('1') }),
      'rep1',
    );
    // Same tradeId re-arrives with a different qty — corruption, not a benign duplicate.
    const conflicting = await ctx.ingestor.ingest(
      first.record,
      makeFill({ clientOrderId: coid, venueTradeId: 'dupe', qty: qty('2') }),
      'rep2',
    );

    expect(conflicting.applied).toBe(false);
    expect(ctx.engages).toEqual([{ reason: 'FILL_PAYLOAD_CONFLICT', flatten: false }]);
    expect(ctx.store.fills.size).toBe(1); // the conflicting record is never written
    expect(ctx.portfolio.cashBalance().toFixed()).toBe('99900'); // only the first fill's money effect
  });

  it('folds a fill for an order with no in-flight intent without touching the position', async () => {
    const ctx = build();
    const intent = makeIntent();
    const coid = intent.clientOrderId;
    ctx.orders.create(initialOrder(coid, intent.qty, '0.001'));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
    const acked = ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' }); // never added to in-flight
    const r = await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, venueTradeId: 'x' }),
      'rep1',
    );

    expect(r.applied).toBe(true);
    expect(r.record.state).toBe('FILLED');
    expect(ctx.store.fills.size).toBe(1);
    expect(ctx.portfolio.snapshot().positions.size).toBe(0); // no intent → no position fold
  });

  it('increments fills_total metric once per newly-inserted fill (not on duplicates)', async () => {
    const fillsCounter = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(fillsCounter);
    const { coid, acked } = seed(ctx, makeIntent({ qty: qty('2') }));
    await ctx.ingestor.ingest(acked, makeFill({ clientOrderId: coid, venueTradeId: 'f1' }), 'rep1');
    expect((fillsCounter.inc as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    // Duplicate is a no-op — counter must not increment.
    await ctx.ingestor.ingest(acked, makeFill({ clientOrderId: coid, venueTradeId: 'f1' }), 'rep2');
    expect((fillsCounter.inc as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('emits fill-rate (filled qty + fully-filled) and BUY decision slippage on a fill', async () => {
    const filledQty = { inc: vi.fn() } as unknown as Counter<string>;
    const fullyFilled = { inc: vi.fn() } as unknown as Counter<string>;
    const slippage = { observe: vi.fn() } as unknown as Histogram<string>;
    const ctx = build(undefined, filledQty, fullyFilled, slippage);
    const { coid, acked } = seed(ctx); // qty 1, BUY, refPrice 100, LIMIT/GTC
    // BUY fill at 101 → adverse +100 bps; full fill → FILLED.
    await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, qty: qty('1'), price: price('101'), venueTradeId: 'fr1' }),
      'rep1',
    );
    expect((filledQty.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      { type: 'LIMIT', tif: 'GTC' },
      1,
    ]);
    expect((fullyFilled.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      { type: 'LIMIT', tif: 'GTC' },
    ]);
    const obs = (slippage.observe as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(obs[0]).toEqual({ venue: 'binance', symbol: 'BTC/USDT', side: 'BUY', type: 'LIMIT' });
    expect(obs[1]).toBe(100); // (101-100)/100*1e4*(+1)
  });

  it('signs decision slippage by side: a SELL below reference is adverse (positive bps)', async () => {
    const slippage = { observe: vi.fn() } as unknown as Histogram<string>;
    const ctx = build(undefined, undefined, undefined, slippage);
    const { coid, acked } = seed(ctx, makeIntent({ side: 'SELL' })); // refPrice 100, SELL
    // SELL fill at 99 → sold below reference → adverse +100 bps (sign = -1).
    await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, qty: qty('1'), price: price('99'), venueTradeId: 's1' }),
      'rep1',
    );
    const obs = (slippage.observe as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(obs[0]).toMatchObject({ side: 'SELL' });
    expect(obs[1]).toBe(100);
  });
});
