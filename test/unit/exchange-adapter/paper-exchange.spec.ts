import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  PaperExchangeAdapter,
  type PaperConfig,
} from '../../../src/features/trading/exchange/paper-exchange.adapter';
import { InMemoryExecOutbox } from '../../../src/features/trading/execution/in-memory-outbox';
import { price, qty } from '../../../src/domain/types/money';
import {
  venueId,
  symbolId,
  epochMs,
  encodeClientOrderId,
  intentId,
  type ClientOrderId,
} from '../../../src/domain/types/ids';
import type { ClockPort } from '../../../src/ports/clock';
import type { OrderLevel } from '../../../src/domain/types/market-events';
import type { ExecReport, FillReport } from '../../../src/domain/types/exec-report';
import type { PlaceOrderRequest } from '../../../src/ports/exchange';

const SYM = symbolId('BTC/USDT');
const VEN = venueId('binance');
const clock: ClockPort = { now: () => epochMs(1_700_000_000_000) };
const lvl = (p: string, q: string): OrderLevel => ({ price: price(p), qty: qty(q) });
const asks = [lvl('100', '1'), lvl('101', '2')];
const bids = [lvl('99', '2'), lvl('98', '3')];

function cfg(over: Partial<PaperConfig> = {}): PaperConfig {
  return {
    seed: 42,
    takerBuffer: '0.05',
    fees: { makerBps: '1', takerBps: '10', feeCurrency: 'quote' },
    latency: { submitMs: [0, 0], eventMs: [0, 5] },
    insufficientDepthPolicy: 'partial_then_reject_rest',
    startingBalances: { USDT: '100000', BTC: '10' },
    ...over,
  };
}

function make(over: Partial<PaperConfig> = {}, notify = () => Promise.resolve()) {
  const outbox = new InMemoryExecOutbox();
  const adapter = new PaperExchangeAdapter(clock, outbox, notify, cfg(over), VEN);
  return { outbox, adapter };
}

let coidSeq = 0;
function coid(): ClientOrderId {
  // distinct valid clientOrderIds per order (last UUID group is exactly 12 hex chars)
  const hex = (coidSeq++).toString(16).padStart(2, '0');
  return encodeClientOrderId(intentId(`0190abcd-1234-7abc-89ab-0123456789${hex}`), 'paper');
}

function req(over: Partial<PlaceOrderRequest>): PlaceOrderRequest {
  return {
    clientOrderId: coid(),
    symbol: SYM,
    side: 'BUY',
    type: 'MARKET',
    qty: '1',
    timeInForce: 'GTC',
    reduceOnly: false,
    ...over,
  };
}

async function reports(outbox: InMemoryExecOutbox): Promise<ExecReport[]> {
  return (await outbox.consume('t', 0)).map((r) => r.report);
}

describe('PaperExchangeAdapter', () => {
  it('book-walks a market BUY across levels (one taker fill per level)', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, bids, asks);
    const ack = await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));
    expect(ack.venueOrderId).toMatch(/^paper-ord-/);
    const fills = (await reports(outbox)).filter((r): r is FillReport => r.kind === 'FILL');
    expect(fills.map((f) => f.price.toFixed())).toEqual(['100', '101']);
    expect(fills.map((f) => f.qty.toFixed())).toEqual(['1', '1']);
    expect(fills.every((f) => f.liquidity === 'taker')).toBe(true);

    const bal = await adapter.fetchBalances();
    expect(bal.get('BTC')?.free).toBe('12'); // 10 + 2
    expect(bal.get('USDT')?.free).toBe('99798.799'); // 100000 − 100.1 − 101.101
    expect(bal.get('USDT')?.locked).toBe('0');
  });

  it('throws a ccxt-shaped TERMINAL_REJECT on insufficient funds', async () => {
    const { adapter } = make({ startingBalances: { USDT: '50', BTC: '0' } });
    adapter.ingestBook(SYM, bids, asks);
    await expect(
      adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '1' })),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      errorClass: 'TERMINAL_REJECT',
      code: 'INSUFFICIENT_FUNDS',
    });
  });

  it('rests a non-marketable limit and fills it on trade-through', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, bids, asks); // bestAsk 100
    await adapter.placeOrder(req({ type: 'LIMIT', side: 'BUY', qty: '1', limitPrice: '99' })); // 99 < 100 → rests
    expect(await reports(outbox)).toHaveLength(0); // no fill yet
    await adapter.ingestTrade(SYM, { price: new Decimal('98'), qty: new Decimal('1') }); // 98 < 99 → trades through
    const fills = (await reports(outbox)).filter((r): r is FillReport => r.kind === 'FILL');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price.toFixed()).toBe('99'); // filled at OUR limit
    expect(fills[0]!.liquidity).toBe('maker');
  });

  it('crosses a marketable-on-arrival limit immediately as taker, capped at the limit', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, bids, asks); // bestAsk 100
    await adapter.placeOrder(req({ type: 'LIMIT', side: 'BUY', qty: '1', limitPrice: '101' })); // 100 ≤ 101 → crosses
    const fills = (await reports(outbox)).filter((r): r is FillReport => r.kind === 'FILL');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price.toFixed()).toBe('100'); // price improvement at the ask
    expect(fills[0]!.liquidity).toBe('taker');
  });

  it('cancels a resting order, releases the lock, and emits CANCEL_ACK', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, bids, asks);
    const c = coid();
    await adapter.placeOrder({
      clientOrderId: c,
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: '1',
      limitPrice: '99',
      timeInForce: 'GTC',
      reduceOnly: false,
    });
    expect((await adapter.fetchBalances()).get('USDT')?.locked).not.toBe('0'); // locked while resting
    await adapter.cancelOrder(c);
    expect((await reports(outbox)).some((r) => r.kind === 'CANCEL_ACK')).toBe(true);
    expect((await adapter.fetchBalances()).get('USDT')?.locked).toBe('0'); // released
    expect(await adapter.fetchOpenOrders(SYM)).toHaveLength(0);
  });

  it('sells base for quote, crediting proceeds net of quote fee', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, bids, asks);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'SELL', qty: '1' })); // walks bids: 1 @ 99
    const bal = await adapter.fetchBalances();
    expect(bal.get('BTC')?.free).toBe('9'); // 10 − 1
    expect(bal.get('USDT')?.free).toBe('100098.901'); // +99 − fee(99×0.001=0.099)
  });

  it('produces a byte-identical report sequence for the same seed + inputs', async () => {
    const run = async () => {
      const { adapter, outbox } = make();
      adapter.ingestBook(SYM, bids, asks);
      await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));
      return (await reports(outbox)).map((r) => JSON.stringify(r));
    };
    coidSeq = 0;
    const a = await run();
    coidSeq = 0;
    const b = await run();
    expect(a).toEqual(b);
  });

  it('auto-delivers via notify in normal mode but defers in reorderDelivery mode', async () => {
    let normal = 0;
    const a = make({}, () => {
      normal += 1;
      return Promise.resolve();
    });
    a.adapter.ingestBook(SYM, bids, asks);
    await a.adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '1' }));
    expect(normal).toBeGreaterThanOrEqual(1); // fill auto-delivered to the OMS

    let reorder = 0;
    const r = make({ reorderDelivery: true }, () => {
      reorder += 1;
      return Promise.resolve();
    });
    r.adapter.ingestBook(SYM, bids, asks);
    await r.adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '1' }));
    expect(reorder).toBe(0); // delivery deferred to manual control (reorder rows)
  });

  it('exposes fetchOrder / fetchMyTrades / validateCredentials', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, bids, asks);
    const c = coid();
    await adapter.placeOrder({
      clientOrderId: c,
      symbol: SYM,
      side: 'BUY',
      type: 'MARKET',
      qty: '1',
      timeInForce: 'GTC',
      reduceOnly: false,
    });
    expect((await adapter.fetchOrder(c, SYM)).status).toBe('closed');
    expect(await adapter.fetchMyTrades(SYM, epochMs(0))).toHaveLength(1);
    expect((await adapter.validateCredentials()).withdrawalsEnabled).toBe(false);
  });
});
