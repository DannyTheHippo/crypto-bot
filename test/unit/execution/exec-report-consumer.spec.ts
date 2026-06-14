import { describe, it, expect } from 'vitest';
import { ExecReportConsumerService } from '../../../src/modules/execution/exec-report-consumer.service';
import { OrderBookService } from '../../../src/modules/execution/order-book.service';
import { PortfolioStateService } from '../../../src/modules/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/modules/execution/fee-ledger.service';
import { EquitySamplerService } from '../../../src/modules/execution/equity-sampler.service';
import { FillIngestorService } from '../../../src/modules/execution/fill-ingestor.service';
import { InMemoryExecOutbox } from '../../../src/modules/execution/in-memory-outbox';
import { InMemoryExecutionStore } from '../../../src/modules/execution/in-memory-store';
import { initialOrder } from '../../../src/domain/oms/reducer';
import { makeIntent, fixedClock, fixedFeed, killSwitchStub, V, SYM, T } from './helpers';
import { price, qty } from '../../../src/domain/types/money';
import { epochMs, type ClientOrderId } from '../../../src/domain/types/ids';
import type { ExecRunContext } from '../../../src/ports/execution';
import type { FillReport, AckReport, CancelAckReport, ExpireReport, RejectReport } from '../../../src/domain/types/exec-report';

const CTX: ExecRunContext = { mode: 'paper', runId: 'run', bootId: 'boot' };

function build(ctx: ExecRunContext = CTX) {
  const outbox = new InMemoryExecOutbox();
  const store = new InMemoryExecutionStore();
  const orders = new OrderBookService();
  const portfolio = new PortfolioStateService({ quoteAsset: 'USDT', startingCash: '100000' }, new FeeLedgerService());
  const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), fixedClock(), store);
  const ingestor = new FillIngestorService(store, killSwitchStub().ks, orders, portfolio, sampler);
  const consumer = new ExecReportConsumerService(outbox, store, ctx, orders, portfolio, ingestor);
  return { outbox, store, orders, portfolio, consumer };
}

const base = (coid: ClientOrderId) => ({
  clientOrderId: coid, venue: V, symbol: SYM, eventTime: epochMs(T), ingestTime: epochMs(T),
});

function fill(coid: ClientOrderId, reportId: string, q: string, tradeId = 'td-' + reportId): FillReport {
  return {
    kind: 'FILL', reportId, ...base(coid), venueTradeId: tradeId,
    price: price('100'), qty: qty(q), fee: null, liquidity: 'taker', venueTimestamp: epochMs(T),
  };
}
const ack = (coid: ClientOrderId, reportId: string): AckReport => ({ kind: 'ACK', reportId, ...base(coid), venueOrderId: 'v1' });
const cancelAck = (coid: ClientOrderId, reportId: string): CancelAckReport => ({ kind: 'CANCEL_ACK', reportId, ...base(coid) });
const expire = (coid: ClientOrderId, reportId: string): ExpireReport => ({ kind: 'EXPIRE', reportId, ...base(coid) });
const reject = (coid: ClientOrderId, reportId: string): RejectReport => ({ kind: 'REJECT', reportId, ...base(coid), reason: 'x' });

// Seed an order already ACKED + open + in-flight, as it would be after gate.submit.
function seedAcked(ctx: ReturnType<typeof build>, intent = makeIntent()) {
  const coid = intent.clientOrderId;
  ctx.orders.create(initialOrder(coid, intent.qty, '0.001'));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' });
  ctx.portfolio.addInFlight(intent);
  ctx.portfolio.openOrder(intent.strategyId, { clientOrderId: coid, symbol: SYM, side: 'BUY', qty: intent.qty, limitPrice: price('100') });
  return { coid, intent };
}

describe('ExecReportConsumerService', () => {
  it('applies a partial then a final fill, updates position, persists fills, samples equity', async () => {
    const ctx = build();
    const { coid } = seedAcked(ctx, makeIntent({ qty: qty('2') }));
    await ctx.outbox.append({ reportId: 'f1', report: fill(coid, 'f1', '1') });
    await ctx.outbox.append({ reportId: 'f2', report: fill(coid, 'f2', '1') });
    const applied = await ctx.consumer.pump();

    expect(applied).toBe(2);
    expect(ctx.orders.get(coid)?.state).toBe('FILLED');
    expect(ctx.portfolio.cashBalance().toFixed()).toBe('99800'); // 2 × 100 spent
    expect(ctx.store.fills.size).toBe(2);
    expect(ctx.store.equity.length).toBe(2); // one sample per fill
    // FILLED is terminal → retired from in-flight and open orders
    expect(ctx.portfolio.snapshot().inFlightIntents).toHaveLength(0);
    expect(ctx.portfolio.snapshot().openOrders).toHaveLength(0);
  });

  it('dedupes a redelivered fill by venueTradeId (no double money effect)', async () => {
    const ctx = build();
    const { coid } = seedAcked(ctx, makeIntent({ qty: qty('2') }));
    await ctx.outbox.append({ reportId: 'f1', report: fill(coid, 'f1', '1', 'same-trade') });
    await ctx.consumer.pump();
    // A reconnect re-sends the same trade under a new reportId.
    await ctx.outbox.append({ reportId: 'f1-redelivered', report: fill(coid, 'f1-redelivered', '1', 'same-trade') });
    await ctx.consumer.pump();
    expect(ctx.store.fills.size).toBe(1);
    expect(ctx.portfolio.cashBalance().toFixed()).toBe('99900'); // only one fill applied
    expect(ctx.orders.get(coid)?.cumQty.toFixed()).toBe('1');
  });

  it('folds CANCEL_ACK to CANCELED and retires the order', async () => {
    const ctx = build();
    const { coid } = seedAcked(ctx);
    ctx.orders.apply(coid, { type: 'CANCEL_REQUESTED' }); // ACKED → CANCEL_PENDING
    await ctx.outbox.append({ reportId: 'c1', report: cancelAck(coid, 'c1') });
    await ctx.consumer.pump();
    expect(ctx.orders.get(coid)?.state).toBe('CANCELED');
    expect(ctx.portfolio.snapshot().openOrders).toHaveLength(0);
  });

  it('folds EXPIRE (from ACKED) to EXPIRED', async () => {
    const ctx = build();
    const { coid } = seedAcked(ctx);
    await ctx.outbox.append({ reportId: 'e1', report: expire(coid, 'e1') });
    await ctx.consumer.pump();
    expect(ctx.orders.get(coid)?.state).toBe('EXPIRED');
  });

  it('folds REJECT (from SUBMITTING) to REJECTED', async () => {
    const ctx = build();
    const intent = makeIntent();
    const coid = intent.clientOrderId;
    ctx.orders.create(initialOrder(coid, intent.qty, '0.001'));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' }); // SUBMITTING
    ctx.portfolio.addInFlight(intent);
    await ctx.outbox.append({ reportId: 'rj1', report: reject(coid, 'rj1') });
    await ctx.consumer.pump();
    expect(ctx.orders.get(coid)?.state).toBe('REJECTED');
  });

  it('folds a stream ACK when SUBMITTING, and treats a redundant ACK as metadata only', async () => {
    const ctx = build();
    const intent = makeIntent();
    const coid = intent.clientOrderId;
    ctx.orders.create(initialOrder(coid, intent.qty, '0.001'));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' }); // SUBMITTING
    ctx.portfolio.addInFlight(intent);
    await ctx.outbox.append({ reportId: 'a1', report: ack(coid, 'a1') });
    await ctx.consumer.pump();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED');

    // A second ACK report on the already-ACKED order is metadata only (no illegal fold).
    await ctx.outbox.append({ reportId: 'a2', report: ack(coid, 'a2') });
    await ctx.consumer.pump();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED');
  });

  it('skips a report for an unknown order without throwing', async () => {
    const ctx = build();
    const coid = makeIntent().clientOrderId; // never created in the book
    await ctx.outbox.append({ reportId: 'x1', report: fill(coid, 'x1', '1') });
    await expect(ctx.consumer.pump()).resolves.toBe(1);
    expect(ctx.store.fills.size).toBe(0);
  });

  it('skips an in-memory fold when the journal already has the event (reportId dedupe)', async () => {
    const ctx = build();
    const { coid } = seedAcked(ctx);
    ctx.orders.apply(coid, { type: 'CANCEL_REQUESTED' }); // CANCEL_PENDING
    // Pre-journal the cancel event under the report's id (as if a prior life applied it).
    await ctx.store.appendOrderEvent({ clientOrderId: coid, dedupeKey: 'c9', event: { type: 'CANCEL_ACK' }, derivedState: 'CANCELED', cumQty: '0' });
    await ctx.outbox.append({ reportId: 'c9', report: cancelAck(coid, 'c9') });
    await ctx.consumer.pump();
    expect(ctx.orders.get(coid)?.state).toBe('CANCEL_PENDING'); // fold skipped — journal said duplicate
  });

  it('advances its cursor so a second pump is a no-op', async () => {
    const ctx = build();
    const { coid } = seedAcked(ctx);
    await ctx.outbox.append({ reportId: 'f1', report: fill(coid, 'f1', '1') });
    expect(await ctx.consumer.pump()).toBe(1);
    expect(await ctx.consumer.pump()).toBe(0);
  });

  it('stamps fills from a non-paper run as source "ws"', async () => {
    const ctx = build({ mode: 'live', runId: 'r', bootId: 'b' });
    const { coid } = seedAcked(ctx);
    await ctx.outbox.append({ reportId: 'f1', report: fill(coid, 'f1', '1') });
    await ctx.consumer.pump();
    expect([...ctx.store.fills.values()][0]!.source).toBe('ws');
  });

  it('folds a fill for an order with no in-flight intent without touching the position', async () => {
    const ctx = build();
    const intent = makeIntent();
    const coid = intent.clientOrderId;
    ctx.orders.create(initialOrder(coid, intent.qty, '0.001'));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
    ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' }); // ACKED, but never added to in-flight
    await ctx.outbox.append({ reportId: 'f1', report: fill(coid, 'f1', '1') });
    await ctx.consumer.pump();
    expect(ctx.store.fills.size).toBe(1); // fill journaled
    expect(ctx.orders.get(coid)?.state).toBe('FILLED'); // reducer folded
    expect(ctx.portfolio.snapshot().positions.size).toBe(0); // no intent → no position fold
  });
});
