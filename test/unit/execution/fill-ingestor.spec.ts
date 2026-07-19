import { describe, it, expect, vi } from 'vitest';
import type { Counter, Histogram } from 'prom-client';
import { FillIngestorService } from '../../../src/features/trading/execution/fill-ingestor.service';
import { OrderBookService } from '../../../src/features/trading/execution/order-book.service';
import { PortfolioStateService } from '../../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/features/trading/execution/fee-ledger.service';
import { EquitySamplerService } from '../../../src/features/trading/execution/equity-sampler.service';
import { InMemoryExecutionStore } from '../../../src/features/trading/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import {
  makeIntent,
  makeFill,
  feeQuote,
  fixedFeed,
  fixedClock,
  killSwitchStub,
  SYM,
  T,
} from './helpers';
import { price, qty } from '../../../src/domain/types/money';
import { intentId } from '../../../src/domain/types/ids';
import type { ExecQualitySinkPort } from '../../../src/ports/execution';
import { ExecQualityService } from '../../../src/features/trading/agentic/exec-quality.service';

// A second intentId so the closing SELL leg of a round trip gets its own clientOrderId/order.
const SELL_IID = intentId('0190abcd-1234-7abc-89ab-0123456789ac');

function build(
  fillsCounter?: Counter<string>,
  filledQtyCounter?: Counter<string>,
  fullyFilledCounter?: Counter<string>,
  slippageDecision?: Histogram<string>,
  feesPaidCounter?: Counter<string>,
  roundTripsCounter?: Counter<string>,
  tradePnl?: Histogram<string>,
  execQualitySink?: ExecQualitySinkPort,
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
    feesPaidCounter,
    roundTripsCounter,
    tradePnl,
    execQualitySink,
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

  it('threads the optional reason onto the persisted event; a 3-arg call leaves it undefined', async () => {
    const ctx = build();
    const { coid, acked } = seed(ctx, makeIntent({ qty: qty('2') }));
    await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, qty: qty('1'), venueTradeId: 'r1' }),
      'rep-reason',
      'venue_stop_filled:algoId=999',
    );
    const withReason = ctx.store.events.find((e) => e.dedupeKey === 'rep-reason');
    expect(withReason?.reason).toBe('venue_stop_filled:algoId=999');

    // Byte-identical on the pre-existing 3-arg call shape: no 4th arg ⇒ reason stays undefined.
    const { coid: coid2, acked: acked2 } = seed(
      ctx,
      makeIntent({ qty: qty('2'), intentId: SELL_IID }),
    );
    await ctx.ingestor.ingest(
      acked2,
      makeFill({ clientOrderId: coid2, qty: qty('1'), venueTradeId: 'r2' }),
      'rep-no-reason',
    );
    const noReason = ctx.store.events.find((e) => e.dedupeKey === 'rep-no-reason');
    expect(noReason?.reason).toBeUndefined();
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

  it('records fees_paid_total{ccy} when a fill carries a fee', async () => {
    const feesPaid = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(undefined, undefined, undefined, undefined, feesPaid);
    const { coid, acked } = seed(ctx); // qty 1, BUY — opening fill, not a round trip
    await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, qty: qty('1'), venueTradeId: 'wf1', fee: feeQuote('0.1') }),
      'rep1',
    );
    expect((feesPaid.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      { ccy: 'USDT' },
      0.1,
    ]);
  });

  it('does not touch fees_paid_total when the fill has no fee', async () => {
    const feesPaid = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(undefined, undefined, undefined, undefined, feesPaid);
    const { coid, acked } = seed(ctx);
    await ctx.ingestor.ingest(
      acked,
      makeFill({ clientOrderId: coid, venueTradeId: 'nf1' }),
      'rep1',
    );
    expect((feesPaid.inc as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('records a winning round trip (round_trips_total{win} + trade_pnl_usdt) when a fill closes to flat', async () => {
    const roundTrips = { inc: vi.fn() } as unknown as Counter<string>;
    const tradePnl = { observe: vi.fn() } as unknown as Histogram<string>;
    const ctx = build(undefined, undefined, undefined, undefined, undefined, roundTrips, tradePnl);
    // Open long: BUY 1 @ 100.
    const buy = seed(ctx, makeIntent({ side: 'BUY' }));
    await ctx.ingestor.ingest(
      buy.acked,
      makeFill({ clientOrderId: buy.coid, qty: qty('1'), price: price('100'), venueTradeId: 'b1' }),
      'rep-b',
    );
    // The opening fill is not a round trip — no metric yet.
    expect((roundTrips.inc as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((tradePnl.observe as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // Close: SELL 1 @ 110 → +10 realized → win.
    const sell = seed(ctx, makeIntent({ side: 'SELL', intentId: SELL_IID }));
    await ctx.ingestor.ingest(
      sell.acked,
      makeFill({
        clientOrderId: sell.coid,
        qty: qty('1'),
        price: price('110'),
        venueTradeId: 's1',
      }),
      'rep-s',
    );
    expect((roundTrips.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([{ result: 'win' }]);
    expect((tradePnl.observe as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([10]);
  });

  it('records a losing round trip (round_trips_total{loss}) when the close nets ≤ 0', async () => {
    const roundTrips = { inc: vi.fn() } as unknown as Counter<string>;
    const tradePnl = { observe: vi.fn() } as unknown as Histogram<string>;
    const ctx = build(undefined, undefined, undefined, undefined, undefined, roundTrips, tradePnl);
    const buy = seed(ctx, makeIntent({ side: 'BUY' }));
    await ctx.ingestor.ingest(
      buy.acked,
      makeFill({ clientOrderId: buy.coid, qty: qty('1'), price: price('100'), venueTradeId: 'b2' }),
      'rep-b',
    );
    // Close below entry: SELL 1 @ 95 → −5 realized → loss.
    const sell = seed(ctx, makeIntent({ side: 'SELL', intentId: SELL_IID }));
    await ctx.ingestor.ingest(
      sell.acked,
      makeFill({ clientOrderId: sell.coid, qty: qty('1'), price: price('95'), venueTradeId: 's2' }),
      'rep-s',
    );
    expect((roundTrips.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      { result: 'loss' },
    ]);
    expect((tradePnl.observe as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([-5]);
  });

  it('tolerates absent profitability metrics on a fee-bearing round trip (no throw)', async () => {
    const ctx = build(); // no metrics wired — every @Optional counter/histogram is undefined
    const buy = seed(ctx, makeIntent({ side: 'BUY' }));
    await ctx.ingestor.ingest(
      buy.acked,
      makeFill({
        clientOrderId: buy.coid,
        qty: qty('1'),
        price: price('100'),
        venueTradeId: 'b3',
        fee: feeQuote('0.1'),
      }),
      'rep-b',
    );
    const sell = seed(ctx, makeIntent({ side: 'SELL', intentId: SELL_IID }));
    const r = await ctx.ingestor.ingest(
      sell.acked,
      makeFill({
        clientOrderId: sell.coid,
        qty: qty('1'),
        price: price('110'),
        venueTradeId: 's3',
        fee: feeQuote('0.1'),
      }),
      'rep-s',
    );
    expect(r.applied).toBe(true);
    expect(ctx.portfolio.snapshot().positions.size).toBe(0); // round trip closed to flat
  });

  // W3 Part 1: exec-quality fan-out.
  describe('exec-quality fan-out', () => {
    it('feeds a full ENTRY fill to the exec-quality sink (maker/taker style from fill.liquidity)', async () => {
      const recordEntryAttempt = vi.fn();
      const sink: ExecQualitySinkPort = { recordEntryAttempt };
      const ctx = build(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sink,
      );
      const { coid, acked } = seed(ctx); // qty 1, BUY, LIMIT, limitPrice 100, reduceOnly false
      await ctx.ingestor.ingest(
        acked,
        makeFill({
          clientOrderId: coid,
          qty: qty('1'),
          price: price('101'),
          liquidity: 'maker',
          venueTradeId: 'eq1',
        }),
        'rep1',
      );
      expect(recordEntryAttempt).toHaveBeenCalledTimes(1);
      expect(recordEntryAttempt).toHaveBeenCalledWith({
        symbol: SYM,
        side: 'long',
        style: 'maker',
        limitPrice: '100',
        outcome: 'filled',
        fillPrice: '101',
        terminalAt: T,
      });
    });

    it('never feeds a partial fill (only the FILLED terminal fold does)', async () => {
      const recordEntryAttempt = vi.fn();
      const sink: ExecQualitySinkPort = { recordEntryAttempt };
      const ctx = build(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sink,
      );
      const { coid, acked } = seed(ctx, makeIntent({ qty: qty('2') }));
      await ctx.ingestor.ingest(
        acked,
        makeFill({ clientOrderId: coid, qty: qty('1'), venueTradeId: 'partial' }),
        'rep1',
      );
      expect(recordEntryAttempt).not.toHaveBeenCalled();
    });

    it('never feeds a reduce-only (exit) fill — exec-quality models entry attempts only', async () => {
      const recordEntryAttempt = vi.fn();
      const sink: ExecQualitySinkPort = { recordEntryAttempt };
      const ctx = build(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sink,
      );
      const { coid, acked } = seed(ctx, makeIntent({ reduceOnly: true }));
      await ctx.ingestor.ingest(
        acked,
        makeFill({ clientOrderId: coid, qty: qty('1'), venueTradeId: 'exit' }),
        'rep1',
      );
      expect(recordEntryAttempt).not.toHaveBeenCalled();
    });

    it('tolerates an absent sink (no throw) and a throwing sink (fails open, never blocks the fill)', async () => {
      const ctxAbsent = build();
      const { coid: c1, acked: a1 } = seed(ctxAbsent);
      const r1 = await ctxAbsent.ingestor.ingest(
        a1,
        makeFill({ clientOrderId: c1, qty: qty('1'), venueTradeId: 'noop' }),
        'rep1',
      );
      expect(r1.applied).toBe(true);

      const throwingSink: ExecQualitySinkPort = {
        recordEntryAttempt: () => {
          throw new Error('boom');
        },
      };
      const ctxThrow = build(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        throwingSink,
      );
      const { coid: c2, acked: a2 } = seed(ctxThrow, makeIntent({ intentId: SELL_IID }));
      const r2 = await ctxThrow.ingestor.ingest(
        a2,
        makeFill({ clientOrderId: c2, qty: qty('1'), venueTradeId: 'throws' }),
        'rep1',
      );
      expect(r2.applied).toBe(true); // the fold itself is unaffected by a sink failure
    });

    it('end-to-end: feeding real FILLED entry attempts through a real ExecQualityService flips digest() from undefined to defined', async () => {
      // Same adapter shape app.module.ts's EXEC_QUALITY_SINK_OVERRIDE factory wires — this proves the
      // whole W3 Part 1 chain (ingest → sink.recordEntryAttempt → ExecQualityService.digest), not just
      // that the sink was called.
      // nowFn pinned to T (the fixture fills' venueTimestamp/terminalAt): the service's default
      // Date.now() would otherwise prune every attempt as older than WINDOW_MAX_AGE_MS (7 days) on
      // the very next recordEntryAttempt call, since T is a fixed 2023 fixture timestamp.
      const execQuality = new ExecQualityService({ priceLookup: () => undefined, nowFn: () => T });
      const sink: ExecQualitySinkPort = {
        recordEntryAttempt: (attempt) => execQuality.recordEntryAttempt(attempt),
      };
      const ctx = build(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sink,
      );
      expect(execQuality.digest()).toBeUndefined();

      // MIN_ATTEMPTS_FOR_DIGEST is 5 (exec-quality.service.ts) — 5 distinct full ENTRY fills.
      const entryIds = [
        '0190abcd-1234-7abc-89ab-0123456789ad',
        '0190abcd-1234-7abc-89ab-0123456789ae',
        '0190abcd-1234-7abc-89ab-0123456789af',
        '0190abcd-1234-7abc-89ab-0123456789b0',
        '0190abcd-1234-7abc-89ab-0123456789b1',
      ];
      for (const [i, id] of entryIds.entries()) {
        const { coid, acked } = seed(ctx, makeIntent({ intentId: intentId(id) }));
        await ctx.ingestor.ingest(
          acked,
          makeFill({
            clientOrderId: coid,
            qty: qty('1'),
            liquidity: 'maker',
            venueTradeId: `eqe2e-${i}`,
          }),
          `rep-${i}`,
        );
      }
      expect(execQuality.digest()).toBeDefined();
      // fillRate is scoped to MAKER attempts (exec-quality.service.ts) — all 5 fixtures above are
      // maker fills, so 5/5 filled = 100%.
      expect(execQuality.digest()).toContain('fillRate=100.0%');
      expect(execQuality.digest()).toContain('n=5');
    });
  });
});
