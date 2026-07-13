import { describe, it, expect } from 'vitest';
import {
  PaperPerpAdapter,
  type PaperPerpConfig,
} from '../../../src/features/trading/exchange/paper-perp.adapter';
import { InMemoryExecOutbox } from '../../../src/features/trading/execution/in-memory-outbox';
import { InMemoryFundingSink } from '../../../src/features/trading/exchange/in-memory-funding-sink';
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
import { price, qty } from '../../../src/domain/types/money';

const SYM = symbolId('BTC/USDT:USDT');
const VEN = venueId('binanceusdm');
const clock: ClockPort = { now: () => epochMs(1_700_000_000_000) };
const lvl = (p: string, q: string): OrderLevel => ({ price: price(p), qty: qty(q) });

function cfg(over: Partial<PaperPerpConfig> = {}): PaperPerpConfig {
  return {
    seed: 42,
    fees: { makerBps: '0', takerBps: '10' },
    latency: { submitMs: [0, 0], eventMs: [0, 0] },
    insufficientDepthPolicy: 'partial_then_reject_rest',
    settlementAsset: 'USDT',
    startingMargin: '100000',
    leverage: '1',
    mmrFallback: '0.005',
    mode: 'paper',
    strategyId: 'test-strat',
    ...over,
  };
}

function make(over: Partial<PaperPerpConfig> = {}, notify = () => Promise.resolve()) {
  const outbox = new InMemoryExecOutbox();
  const fundingSink = new InMemoryFundingSink();
  const adapter = new PaperPerpAdapter(clock, outbox, notify, fundingSink, cfg(over), VEN);
  return { outbox, fundingSink, adapter };
}

let coidSeq = 0;
function coid(): ClientOrderId {
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

describe('PaperPerpAdapter', () => {
  it('opens a long position on a market BUY and locks isolated margin', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));

    const fills = (await reports(outbox)).filter((r): r is FillReport => r.kind === 'FILL');
    expect(fills.map((f) => f.price.toFixed())).toEqual(['100']);
    expect(fills[0]!.fee!.amount.toFixed()).toBe('0.2'); // 200 notional × 10bps

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '2', avgEntry: '100', margin: '200' });
    const bal = await adapter.fetchBalances();
    expect(bal.get('USDT')?.free).toBe('99799.8'); // 100000 − 200(margin) − 0.2(fee)
    expect(bal.get('USDT')?.locked).toBe('200');
  });

  it('opens a short position on a market SELL', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'SELL', qty: '2' }));

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '-2', avgEntry: '99', margin: '198' });
    const bal = await adapter.fetchBalances();
    expect(bal.get('USDT')?.free).toBe('99801.802'); // 100000 − 198(margin) − 0.198(fee)
    expect(bal.get('USDT')?.locked).toBe('198');
  });

  it('throws a ccxt-shaped TERMINAL_REJECT on insufficient margin', async () => {
    const { adapter } = make({ startingMargin: '50' });
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await expect(
      adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '1' })),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      errorClass: 'TERMINAL_REJECT',
      code: 'INSUFFICIENT_FUNDS',
    });
  });

  it('closing a long realizes PnL and releases margin back to free (exact strings)', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));
    expect((await adapter.fetchBalances()).get('USDT')?.free).toBe('99799.8');

    adapter.ingestBook(SYM, [lvl('110', '10')], [lvl('111', '10')]); // price rallied
    await adapter.placeOrder(req({ type: 'MARKET', side: 'SELL', qty: '2', reduceOnly: true }));

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '0', avgEntry: '100', margin: '0' });
    const bal = await adapter.fetchBalances();
    // 99799.8 + 200(margin release) + 20(realized: 2×(110−100)) − 0.22(fee: 220×10bps) = 100019.58
    expect(bal.get('USDT')?.free).toBe('100019.58');
    expect(bal.get('USDT')?.locked).toBe('0');
  });

  it('closing a short realizes PnL and releases margin back to free (exact strings)', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'SELL', qty: '2' }));
    expect((await adapter.fetchBalances()).get('USDT')?.free).toBe('99801.802');

    adapter.ingestBook(SYM, [lvl('89', '10')], [lvl('90', '10')]); // price dropped (favorable for short)
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2', reduceOnly: true }));

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '0', avgEntry: '99', margin: '0' });
    const bal = await adapter.fetchBalances();
    // 99801.802 + 198(margin release) + 18(realized: 2×(99−90)) − 0.18(fee: 180×10bps) = 100017.622
    expect(bal.get('USDT')?.free).toBe('100017.622');
    expect(bal.get('USDT')?.locked).toBe('0');
  });

  it('partial close: proportional margin release with a non-unit ratio (closingQty/priorAbsQty = 1/3)', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '3' }));
    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '3', avgEntry: '100', margin: '300' });
    expect((await adapter.fetchBalances()).get('USDT')?.free).toBe('99699.7');

    adapter.ingestBook(SYM, [lvl('130', '10')], [lvl('131', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'SELL', qty: '1' }));

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '2', avgEntry: '100', margin: '200' });
    const bal = await adapter.fetchBalances();
    // release = 300×(1/3) = 100 (non-unit ratio); realized = 1×(130−100) = 30; fee = 130×10bps = 0.13
    expect(bal.get('USDT')?.free).toBe('99829.57');
    expect(bal.get('USDT')?.locked).toBe('200');
  });

  it('add-to-position re-averages entry over the combined notional', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));
    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '2', avgEntry: '100', margin: '200' });

    adapter.ingestBook(SYM, [lvl('109', '10')], [lvl('110', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '4', avgEntry: '105', margin: '420' });
    const bal = await adapter.fetchBalances();
    // margin: 200 + 220(110×2/1) = 420; fee: 0.2(first leg) + 0.22(second leg) = 0.42
    expect(bal.get('USDT')?.free).toBe('99579.58');
    expect(bal.get('USDT')?.locked).toBe('420');
  });

  it('flip-through-zero (non-reduceOnly): long 2 @ 100, sell 3 @ 110 → short 1 @ 110', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));
    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '2', avgEntry: '100', margin: '200' });

    adapter.ingestBook(SYM, [lvl('110', '10')], [lvl('111', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'SELL', qty: '3', reduceOnly: false }));

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '-1', avgEntry: '110', margin: '110' });
    const bal = await adapter.fetchBalances();
    // close 2: release 200, realized 2×(110−100)=20 → 99799.8+200+20=100019.8
    // open 1 short leg: margin 110 locked; fee on the whole 3-qty leg: 330×10bps=0.33
    expect(bal.get('USDT')?.free).toBe('99909.47');
    expect(bal.get('USDT')?.locked).toBe('110');
  });

  it('reduceOnly caps a fill at the open position size and never flips (excess dropped)', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));
    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '2', avgEntry: '100', margin: '200' });

    adapter.ingestBook(SYM, [lvl('110', '10')], [lvl('111', '10')]);
    const ack = await adapter.placeOrder(
      req({ type: 'MARKET', side: 'SELL', qty: '3', reduceOnly: true }),
    );

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '0', avgEntry: '100', margin: '0' });
    const bal = await adapter.fetchBalances();
    // capped fill qty = 2 (open position size), excess 1 dropped; release 200; realized
    // 2×(110−100)=20; fee billed only on the capped qty: 110×2×10bps=0.22
    expect(bal.get('USDT')?.free).toBe('100019.58');
    expect(bal.get('USDT')?.locked).toBe('0');

    const fills = (await reports(outbox)).filter(
      (r): r is FillReport => r.kind === 'FILL' && r.clientOrderId === ack.clientOrderId,
    );
    expect(fills).toHaveLength(1); // the dropped excess never resolves into a second fill
    expect(fills[0]!.qty.toFixed()).toBe('2');
  });

  it('reduceOnly never flips on a multi-level walk: legs after the position closes are dropped', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));
    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '2', avgEntry: '100', margin: '200' });

    // Three bid levels: the walk yields legs [1@110, 1@109, 3@108]; the first two close the long,
    // the third arrives against a flat simulated position and must be dropped — not opened short.
    adapter.ingestBook(
      SYM,
      [lvl('110', '1'), lvl('109', '1'), lvl('108', '5')],
      [lvl('111', '10')],
    );
    const ack = await adapter.placeOrder(
      req({ type: 'MARKET', side: 'SELL', qty: '5', reduceOnly: true }),
    );

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '0', avgEntry: '100', margin: '0' });
    const bal = await adapter.fetchBalances();
    // open: 100000 − 200(margin) − 0.2(fee) = 99799.8; close leg1 +100 +10 −0.11;
    // leg2 +100 +9 −0.109; dropped leg3 locks nothing and bills nothing.
    expect(bal.get('USDT')?.free).toBe('100018.581');
    expect(bal.get('USDT')?.locked).toBe('0');

    const fills = (await reports(outbox)).filter(
      (r): r is FillReport => r.kind === 'FILL' && r.clientOrderId === ack.clientOrderId,
    );
    expect(fills.map((f) => f.qty.toFixed())).toEqual(['1', '1']); // settled sum = 2, never 5
  });

  it('reduceOnly while flat is a no-op: every leg dropped, nothing opened', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    const ack = await adapter.placeOrder(
      req({ type: 'MARKET', side: 'SELL', qty: '2', reduceOnly: true }),
    );

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '0', avgEntry: '0', margin: '0' });
    const bal = await adapter.fetchBalances();
    expect(bal.get('USDT')?.free).toBe('100000');
    expect(bal.get('USDT')?.locked).toBe('0');
    const fills = (await reports(outbox)).filter(
      (r): r is FillReport => r.kind === 'FILL' && r.clientOrderId === ack.clientOrderId,
    );
    expect(fills).toHaveLength(0);
  });

  it('same-side reduceOnly is dropped: it can never add to the position', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));

    const ack = await adapter.placeOrder(
      req({ type: 'MARKET', side: 'BUY', qty: '1', reduceOnly: true }),
    );

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '2', avgEntry: '100', margin: '200' });
    const bal = await adapter.fetchBalances();
    expect(bal.get('USDT')?.free).toBe('99799.8'); // unchanged from the open
    expect(bal.get('USDT')?.locked).toBe('200');
    const fills = (await reports(outbox)).filter(
      (r): r is FillReport => r.kind === 'FILL' && r.clientOrderId === ack.clientOrderId,
    );
    expect(fills).toHaveLength(0);
  });

  it('rejects atomically when the full book walk needs more margin than the top-of-book pre-check estimated (deep-walk pricing)', async () => {
    const { adapter, outbox } = make({ leverage: '1', startingMargin: '500' });
    // Steep price jump between levels: the top-of-book price (100) underestimates the true cost
    // of walking deeper into the book for the full requested qty.
    adapter.ingestBook(SYM, [], [lvl('100', '1'), lvl('1000', '10')]);

    await expect(
      adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '3' })),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      errorClass: 'TERMINAL_REJECT',
      code: 'INSUFFICIENT_FUNDS',
    });

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '0', avgEntry: '0', margin: '0' });
    const bal = await adapter.fetchBalances();
    expect(bal.get('USDT')?.free).toBe('500');
    expect(bal.get('USDT')?.locked).toBe('0');
    const fills = (await reports(outbox)).filter((r): r is FillReport => r.kind === 'FILL');
    expect(fills).toHaveLength(0);
  });

  it('funding: a long with positive fundingRate pays (balance decreases)', async () => {
    const { adapter, fundingSink } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '2' }));
    const freeBefore = (await adapter.fetchBalances()).get('USDT')!.free;
    expect(freeBefore).toBe('99799.8');

    await adapter.applyFunding(SYM, '0.0001', '100', epochMs(1_700_000_100_000));

    const bal = await adapter.fetchBalances();
    // payment = −signedQty × markPrice × fundingRate = −2 × 100 × 0.0001 = −0.02
    expect(bal.get('USDT')?.free).toBe('99799.78');
    expect(fundingSink.rows).toHaveLength(1);
    expect(fundingSink.rows[0]!.paymentQuote).toBe('-0.02');
    expect(fundingSink.rows[0]!.signedQty).toBe('2');
  });

  it('funding: a short with positive fundingRate receives (balance increases)', async () => {
    const { adapter, fundingSink } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'SELL', qty: '2' }));
    const freeBefore = (await adapter.fetchBalances()).get('USDT')!.free;
    expect(freeBefore).toBe('99801.802');

    await adapter.applyFunding(SYM, '0.0001', '100', epochMs(1_700_000_100_000));

    const bal = await adapter.fetchBalances();
    // payment = −(−2) × 100 × 0.0001 = 0.02
    expect(bal.get('USDT')?.free).toBe('99801.822');
    expect(fundingSink.rows[0]!.paymentQuote).toBe('0.02');
  });

  it('funding is a no-op on a flat position', async () => {
    const { adapter, fundingSink } = make();
    await adapter.applyFunding(SYM, '0.0001', '100', epochMs(1_700_000_100_000));
    expect(fundingSink.rows).toHaveLength(0);
  });

  it('force-closes a long when mark crosses the liq price (distinguishable liq fill)', async () => {
    const { adapter, outbox } = make({ leverage: '5', mmrFallback: '0.01' });
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '1' }));
    // margin = 100×1/5 = 20; fee = 100×10bps = 0.1; free = 100000 − 20 − 0.1 = 99979.9
    expect((await adapter.fetchBalances()).get('USDT')?.free).toBe('99979.9');

    // long liq = entry×(1 − 1/leverage + mmr) = 100×(1 − 0.2 + 0.01) = 81
    await adapter.ingestMark(SYM, price('81'));

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '0', avgEntry: '100', margin: '0' });
    const bal = await adapter.fetchBalances();
    // realized = 1×(81−100) = −19; release = 20; net +1 (≈ maintenance margin: 100×1×0.01=1)
    expect(bal.get('USDT')?.free).toBe('99980.9');
    expect(bal.get('USDT')?.locked).toBe('0');

    const fills = (await reports(outbox)).filter((r): r is FillReport => r.kind === 'FILL');
    const liqFill = fills.find((f) => f.reportId.includes('-liq-'));
    expect(liqFill).toBeDefined();
    expect(liqFill!.price.toFixed()).toBe('81');
  });

  it('force-closes a short when mark crosses the liq price (distinguishable liq fill)', async () => {
    const { adapter, outbox } = make({ leverage: '5', mmrFallback: '0.01' });
    adapter.ingestBook(SYM, [lvl('100', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'SELL', qty: '1' }));
    expect((await adapter.fetchBalances()).get('USDT')?.free).toBe('99979.9');

    // short liq = entry×(1 + 1/leverage − mmr) = 100×(1 + 0.2 − 0.01) = 119
    await adapter.ingestMark(SYM, price('119'));

    expect(adapter.positionOf(SYM)).toEqual({ signedQty: '0', avgEntry: '100', margin: '0' });
    const bal = await adapter.fetchBalances();
    expect(bal.get('USDT')?.free).toBe('99980.9');

    const fills = (await reports(outbox)).filter((r): r is FillReport => r.kind === 'FILL');
    const liqFill = fills.find((f) => f.reportId.includes('-liq-'));
    expect(liqFill).toBeDefined();
    expect(liqFill!.price.toFixed()).toBe('119');
  });

  it('does not liquidate while mark stays on the safe side of the liq price', async () => {
    const { adapter } = make({ leverage: '5', mmrFallback: '0.01' });
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await adapter.placeOrder(req({ type: 'MARKET', side: 'BUY', qty: '1' }));
    await adapter.ingestMark(SYM, price('82')); // above the 81 liq price
    expect(adapter.positionOf(SYM).signedQty).toBe('1');
  });

  it('boot guard: refuses construction against the live fapi host in a non-live mode', () => {
    expect(() =>
      make({
        boot: { swapMode: 'paper', privateBaseUrl: 'https://fapi.binance.com/fapi/v1' },
      }),
    ).toThrow(/refusing to boot/);
  });

  it('boot guard: allows construction against the testnet/demo hosts in a non-live mode', () => {
    expect(() =>
      make({
        boot: { swapMode: 'testnet', privateBaseUrl: 'https://testnet.binancefuture.com/fapi/v1' },
      }),
    ).not.toThrow();
    expect(() =>
      make({
        boot: { swapMode: 'demo', privateBaseUrl: 'https://demo-fapi.binance.com/fapi/v1' },
      }),
    ).not.toThrow();
  });

  it('cancels a resting order and emits CANCEL_ACK', async () => {
    const { adapter, outbox } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    const c = coid();
    await adapter.placeOrder({
      clientOrderId: c,
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: '1',
      limitPrice: '90',
      timeInForce: 'GTC',
      reduceOnly: false,
    });
    expect(await adapter.fetchOpenOrders(SYM)).toHaveLength(1);
    await adapter.cancelOrder(c);
    expect((await reports(outbox)).some((r) => r.kind === 'CANCEL_ACK')).toBe(true);
    expect(await adapter.fetchOpenOrders(SYM)).toHaveLength(0);
  });

  it('exposes fetchOrder / fetchMyTrades / validateCredentials', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
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

  // ── trigger orders (Push 3 P7a) ────────────────────────────────────────────
  it('rejects a trigger order (STOP_MARKET) fail-closed rather than silently placing a plain MARKET', async () => {
    const { adapter } = make();
    adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);

    await expect(
      adapter.placeOrder(req({ type: 'STOP_MARKET', triggerPrice: '95', reduceOnly: true })),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      errorClass: 'TERMINAL_REJECT',
      code: 'UNSUPPORTED_ORDER_TYPE',
    });
  });
});
