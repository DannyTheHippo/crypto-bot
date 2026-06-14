import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import type { Counter, Histogram } from 'prom-client';
import { ExecutionGateService } from '../../../src/modules/execution/execution-gate.service';
import { NonceLedgerService } from '../../../src/modules/execution/nonce-ledger.service';
import { OrderBookService } from '../../../src/modules/execution/order-book.service';
import { PortfolioStateService } from '../../../src/modules/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/modules/execution/fee-ledger.service';
import { InMemoryExecutionStore } from '../../../src/modules/execution/in-memory-store';
import { mintApproval } from '../../../src/domain/risk/proof';
import { AdapterError, type ExchangePort, type ExchangeAck, type PlaceOrderRequest } from '../../../src/ports/exchange';
import { ModeViolationError, type ModeControlPort } from '../../../src/ports/mode-control';
import type { ExecRunContext, ExecFilters } from '../../../src/ports/execution';
import type { SymbolFilters } from '../../../src/domain/risk/evaluate';
import type { RiskApprovedIntent } from '../../../src/domain/types/risk-decision';
import { initialOrder } from '../../../src/domain/oms/reducer';
import { makeIntent, fixedClock, SYM, T } from './helpers';
import { epochMs, venueId, symbolId, type ClientOrderId } from '../../../src/domain/types/ids';

const KEY = Buffer.alloc(32, 7);
const CTX: ExecRunContext = { mode: 'paper', runId: 'run', bootId: 'boot' };
const FILTERS: ExecFilters = new Map<string, SymbolFilters>([
  [String(SYM), { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
]);

const flush = () => new Promise((r) => setImmediate(r));

function approve(over = {}, key: Buffer = KEY, approvedAtMs = T): RiskApprovedIntent {
  return mintApproval(makeIntent(over), key, {
    nonce: 'nonce-' + JSON.stringify(over), approvedAtMs: epochMs(approvedAtMs), limitsVersion: 'v1', snapshotSeq: 1n,
  });
}

function fakeExchange(place: (req: PlaceOrderRequest) => Promise<ExchangeAck>): {
  port: ExchangePort; placeCalls: PlaceOrderRequest[]; cancelCalls: [ClientOrderId, string][];
} {
  const placeCalls: PlaceOrderRequest[] = [];
  const cancelCalls: [ClientOrderId, string][] = [];
  const port: ExchangePort = {
    venue: venueId('binance'),
    capabilities: { clientOrderId: true, fetchOrderByClientId: true, wsUserStream: true, stp: false, sandbox: true },
    placeOrder: (req) => { placeCalls.push(req); return place(req); },
    cancelOrder: (coid, sym) => { cancelCalls.push([coid, String(sym)]); return Promise.resolve({ clientOrderId: coid, venueOrderId: 'v1' }); },
    fetchOrder: () => Promise.reject(new Error('unused')),
    fetchOpenOrders: () => Promise.resolve([]),
    fetchBalances: () => Promise.resolve(new Map()),
    fetchMyTrades: () => Promise.resolve([]),
    validateCredentials: () => Promise.resolve({ valid: true, canTrade: true, withdrawalsEnabled: false, keyFingerprint: 'fp' }),
  };
  return { port, placeCalls, cancelCalls };
}

// Paper-authority ModeControl: live intents are refused (throw), paper intents pass, effective=paper.
function fakeModeControl(over: Partial<ModeControlPort> = {}): ModeControlPort {
  return {
    resolveMode: () => ({ effective: 'paper', requested: 'paper', downgrades: [] }),
    armLive: () => ({ ok: true }),
    disarm: () => undefined,
    assertCanTrade: (m) => { if (m === 'live') throw new ModeViolationError('NOT_LIVE_AUTHORITY', 'live not authorised'); },
    ...over,
  };
}

function build(
  exchange: ExchangePort,
  clockT = T,
  modeControl: ModeControlPort = fakeModeControl(),
  ordersCounter?: Counter<string>,
  ordersRejectedCounter?: Counter<string>,
  submittedCounter?: Counter<string>,
  submittedQtyCounter?: Counter<string>,
  submitLatency?: Histogram<string>,
) {
  const store = new InMemoryExecutionStore();
  const nonces = new NonceLedgerService();
  const orders = new OrderBookService();
  const portfolio = new PortfolioStateService({ quoteAsset: 'USDT', startingCash: '100000' }, new FeeLedgerService());
  const gate = new ExecutionGateService(fixedClock(clockT), KEY, CTX, FILTERS, store, exchange, modeControl, nonces, orders, portfolio, ordersCounter, ordersRejectedCounter, submittedCounter, submittedQtyCounter, submitLatency);
  return { gate, store, nonces, orders, portfolio };
}

const ackOf = (req: PlaceOrderRequest): ExchangeAck => ({ clientOrderId: req.clientOrderId, venueOrderId: 'v-' + req.clientOrderId });

describe('ExecutionGateService.submit', () => {
  it('happy path: write-ahead NEW→SUBMITTING, places, folds ACK, journals each step', async () => {
    const { port, placeCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate, store, orders } = build(port);
    const approved = approve();
    const ack = await gate.submit(approved);
    expect(ack.outcome).toBe('SUBMITTED');
    expect(ack.state).toBe('ACKED');
    expect(ack.venueOrderId).toMatch(/^v-/);
    expect(placeCalls).toHaveLength(1);
    expect(orders.get(approved.intent.clientOrderId)?.state).toBe('ACKED');
    expect(store.events.map((e) => e.dedupeKey)).toEqual(['submit', 'ack']);
  });

  it('persists SUBMITTING BEFORE placeOrder resolves (write-ahead invariant)', async () => {
    let resolvePlace!: (a: ExchangeAck) => void;
    const pending = new Promise<ExchangeAck>((r) => { resolvePlace = r; });
    const { port } = fakeExchange(() => pending);
    const { gate, store } = build(port);
    const approved = approve();
    const coid = approved.intent.clientOrderId;

    const submitP = gate.submit(approved);
    await flush(); // run up to the placeOrder await
    expect(store.stateOf(coid)).toBe('SUBMITTING'); // durable before the network call resolved

    resolvePlace(ackOf({ clientOrderId: coid } as PlaceOrderRequest));
    expect((await submitP).state).toBe('ACKED');
  });

  it.each([
    ['BAD_HMAC', () => approve({}, Buffer.alloc(32, 9))], // minted under a foreign key
  ])('refuses a forged proof (%s) with no order and no network call', async (reason, mk) => {
    const { port, placeCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate, store, orders } = build(port);
    const approved = mk();
    const res = await gate.submit(approved);
    expect(res).toMatchObject({ outcome: 'REJECTED', reason });
    expect(placeCalls).toHaveLength(0);
    expect(orders.get(approved.intent.clientOrderId)).toBeUndefined();
    expect(store.intents.size).toBe(0);
  });

  it('refuses a tampered intent (BAD_HASH)', async () => {
    const { port, placeCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port);
    const approved = approve();
    const tampered = { ...approved, intent: { ...approved.intent, refSeq: 999n } } as RiskApprovedIntent;
    const res = await gate.submit(tampered);
    expect(res).toMatchObject({ outcome: 'REJECTED', reason: 'BAD_HASH' });
    expect(placeCalls).toHaveLength(0);
  });

  it('refuses an expired approval (EXPIRED) and a replayed nonce (REPLAY)', async () => {
    const { port } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port, T);
    const expired = approve({}, KEY, T - 5000); // approvedAt+ttl(2000) < now(T)
    expect(await gate.submit(expired)).toMatchObject({ outcome: 'REJECTED', reason: 'EXPIRED' });

    const fresh = approve();
    expect((await gate.submit(fresh)).outcome).toBe('SUBMITTED');
    expect(await gate.submit(fresh)).toMatchObject({ outcome: 'REJECTED', reason: 'REPLAY' }); // same nonce
  });

  it('rejects to terminal on a TERMINAL_REJECT adapter error and clears in-flight', async () => {
    const { port } = fakeExchange(() => Promise.reject(new AdapterError('TERMINAL_REJECT', 'INSUFFICIENT_FUNDS', 'no funds')));
    const { gate, orders, portfolio } = build(port);
    const approved = approve();
    const res = await gate.submit(approved);
    expect(res).toMatchObject({ outcome: 'REJECTED', state: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
    expect(orders.get(approved.intent.clientOrderId)?.state).toBe('REJECTED');
    expect(portfolio.snapshot().inFlightIntents).toHaveLength(0);
  });

  it('routes an ambiguous adapter error to SUBMIT_UNKNOWN (exposure reserved)', async () => {
    const { port } = fakeExchange(() => Promise.reject(new AdapterError('OUTCOME_AMBIGUOUS', 'TIMEOUT', 'maybe sent')));
    const { gate, portfolio } = build(port);
    const res = await gate.submit(approve());
    expect(res).toMatchObject({ outcome: 'UNKNOWN', state: 'SUBMIT_UNKNOWN', reason: 'TIMEOUT' });
    expect(portfolio.snapshot().inFlightIntents).toHaveLength(1); // worst-case exposure held
  });

  it('treats an unmapped (non-AdapterError) throw as ambiguous, never terminal', async () => {
    const { port } = fakeExchange(() => Promise.reject(new Error('socket hangup')));
    const { gate } = build(port);
    expect(await gate.submit(approve())).toMatchObject({ outcome: 'UNKNOWN', state: 'SUBMIT_UNKNOWN', reason: 'UNKNOWN' });
  });

  it('skips the ACK fold when a fill implicitly acked the order during placeOrder', async () => {
    // The fake folds a FILL into the book before resolving — simulating a WS fill that beat REST.
    const hold: { orders?: OrderBookService } = {};
    const { port } = fakeExchange((req) => {
      hold.orders!.apply(req.clientOrderId, { type: 'FILL', cumQty: new Decimal('0.5') });
      return Promise.resolve(ackOf(req));
    });
    const built = build(port);
    hold.orders = built.orders;
    const approved = approve();
    const coid = approved.intent.clientOrderId;
    const res = await built.gate.submit(approved);
    expect(res.state).toBe('PARTIALLY_FILLED');
    expect(built.store.events.map((e) => e.dedupeKey)).toEqual(['submit']); // no 'ack' event
    expect(built.orders.get(coid)?.venueOrderId).toMatch(/^v-/);
  });

  it('does not register a phantom open order when a fill fully filled the order during placeOrder', async () => {
    // A market-style fill delivered while SUBMITTING (auto-notify) runs the order straight to FILLED.
    // The order is terminal by the time submit's tail runs — it must NOT be re-added to the open set
    // (a phantom no cancel could clear, which would stall a later HALTING drain into a cancel-timeout).
    const hold: { orders?: OrderBookService } = {};
    const { port } = fakeExchange((req) => {
      hold.orders!.apply(req.clientOrderId, { type: 'FILL', cumQty: new Decimal('1') }); // full qty (makeIntent qty=1)
      return Promise.resolve(ackOf(req));
    });
    const built = build(port);
    hold.orders = built.orders;
    const approved = approve();
    const res = await built.gate.submit(approved);
    expect(res).toMatchObject({ outcome: 'SUBMITTED', state: 'FILLED' });
    expect(built.orders.get(approved.intent.clientOrderId)?.state).toBe('FILLED');
    expect(built.portfolio.snapshot().openOrders).toHaveLength(0); // no phantom
  });

  it('throws ModeViolationError for a live-stamped intent on a paper-authority run (no network call)', async () => {
    // §10: a live intent that reaches a never-live-authorised process is a forgery/bug — assertCanTrade
    // throws BEFORE any persistence or network. The 16-row live-gate matrix relies on this propagation.
    const { port, placeCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port);
    await expect(gate.submit(approve({ mode: 'live' }))).rejects.toThrow(ModeViolationError);
    expect(placeCalls).toHaveLength(0);
  });

  it('returns MODE_MISMATCH when the intent stamp differs from the current effective mode (downgrade)', async () => {
    // assertCanTrade passes (paper intent), but the live-effective process re-resolves the stamp as a
    // mismatch — the graceful operational path (returned, not thrown), e.g. a mid-run downgrade.
    const { port, placeCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const liveEffective = fakeModeControl({
      resolveMode: () => ({ effective: 'live', requested: 'live', downgrades: [] }),
      assertCanTrade: () => undefined,
    });
    const { gate } = build(port, T, liveEffective);
    const res = await gate.submit(approve()); // paper-stamped intent vs live effective ⇒ mismatch
    expect(res).toMatchObject({ outcome: 'REJECTED', reason: 'MODE_MISMATCH' });
    expect(placeCalls).toHaveLength(0);
  });

  it('refuses a live intent on a live-AUTHORITY but not-yet-armed process (effective paper) — MODE_MISMATCH, no network', async () => {
    // The cardinal row the throw-path does NOT cover: boot authority IS live (assertCanTrade passes),
    // but the four gates are incomplete so effective=paper ⇒ the live order is refused (returned), never placed.
    const { port, placeCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const liveAuthorityNotArmed = fakeModeControl({
      assertCanTrade: () => undefined, // requested=live ⇒ no throw
      resolveMode: () => ({ effective: 'paper', requested: 'live', downgrades: ['NOT_ARMED'] }),
    });
    const { gate } = build(port, T, liveAuthorityNotArmed);
    const res = await gate.submit(approve({ mode: 'live' }));
    expect(res).toMatchObject({ outcome: 'REJECTED', reason: 'MODE_MISMATCH' });
    expect(placeCalls).toHaveLength(0);
  });

  it('increments orders_total and orders_rejected_total{stage,code} when a submit returns REJECTED', async () => {
    const ordersCounter = { inc: vi.fn() } as unknown as Counter<string>;
    const ordersRejectedCounter = { inc: vi.fn() } as unknown as Counter<string>;
    const { port } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port, T, fakeModeControl(), ordersCounter, ordersRejectedCounter);
    // A bad-key approval is rejected before any persistence or network call (oms stage).
    const res = await gate.submit(approve({}, Buffer.alloc(32, 9)));
    expect(res.outcome).toBe('REJECTED');
    expect((ordersCounter.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([{ outcome: 'REJECTED' }]);
    expect((ordersRejectedCounter.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([{ stage: 'oms', code: res.reason }]);
  });

  it('records fill-rate (submitted) + submit latency on a SUBMITTED outcome', async () => {
    const submitted = { inc: vi.fn() } as unknown as Counter<string>;
    const submittedQty = { inc: vi.fn() } as unknown as Counter<string>;
    const latency = { observe: vi.fn() } as unknown as Histogram<string>;
    const { port } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port, T, fakeModeControl(), undefined, undefined, submitted, submittedQty, latency);
    const res = await gate.submit(approve({})); // LIMIT/GTC, qty 1, venue binance
    expect(res.outcome).toBe('SUBMITTED');
    expect((submitted.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([{ type: 'LIMIT', tif: 'GTC' }]);
    expect((submittedQty.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([{ type: 'LIMIT', tif: 'GTC' }, 1]);
    const obs = (latency.observe as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(obs![0]).toEqual({ venue: 'binance', type: 'LIMIT' });
    expect(typeof obs![1]).toBe('number');
  });
});

describe('ExecutionGateService cancel / drain / flatten', () => {
  it('cancels an ACKED order to CANCEL_PENDING and calls the venue', async () => {
    const { port, cancelCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate, orders } = build(port);
    const approved = approve();
    await gate.submit(approved);
    await gate.cancel(approved.intent.clientOrderId, 'TTL');
    expect(orders.get(approved.intent.clientOrderId)?.state).toBe('CANCEL_PENDING');
    expect(cancelCalls).toEqual([[approved.intent.clientOrderId, String(SYM)]]);
  });

  it('cancels a NEW (never-sent) order locally with no venue call', async () => {
    const { port, cancelCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate, orders, portfolio } = build(port);
    const intent = makeIntent();
    orders.create(initialOrder(intent.clientOrderId, intent.qty, '0.001'));
    portfolio.addInFlight(intent);
    await gate.cancel(intent.clientOrderId, 'SHUTDOWN');
    expect(orders.get(intent.clientOrderId)?.state).toBe('CANCELED');
    expect(cancelCalls).toHaveLength(0);
    expect(portfolio.snapshot().inFlightIntents).toHaveLength(0);
  });

  it('cancel of an unknown order is a no-op', async () => {
    const { port } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port);
    const unknown = makeIntent().clientOrderId; // valid coid, never submitted
    await expect(gate.cancel(unknown, 'x')).resolves.toBeUndefined();
  });

  it('cancelAllFor drains the strategy’s open orders', async () => {
    const { port, cancelCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port);
    await gate.submit(approve());
    await gate.cancelAllFor(makeIntent().strategyId);
    expect(cancelCalls).toHaveLength(1);
  });

  it('flattenAll cancels known open orders', async () => {
    const { port, cancelCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port);
    await gate.submit(approve());
    await gate.flattenAll('KILL_SWITCH');
    expect(cancelCalls).toHaveLength(1);
  });

  it('cancel of a terminal (FILLED) order is a no-op', async () => {
    const { port, cancelCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate, orders } = build(port);
    const approved = approve();
    const coid = approved.intent.clientOrderId;
    await gate.submit(approved);
    orders.apply(coid, { type: 'FILL', cumQty: new Decimal('1') }); // drive ACKED → FILLED
    await gate.cancel(coid, 'TTL');
    expect(orders.get(coid)?.state).toBe('FILLED');
    expect(cancelCalls).toHaveLength(0);
  });

  it('cancels an ACKED order with no in-flight intent (CANCEL_PENDING, no venue call)', async () => {
    const { port, cancelCalls } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate, orders, portfolio } = build(port);
    const approved = approve();
    const coid = approved.intent.clientOrderId;
    await gate.submit(approved);
    portfolio.clearInFlight(coid); // intent gone (e.g. already retired)
    await gate.cancel(coid, 'TTL');
    expect(orders.get(coid)?.state).toBe('CANCEL_PENDING');
    expect(cancelCalls).toHaveLength(0); // no intent → no symbol → no venue cancel
  });

  it('falls back to the default step size when the symbol has no filter', async () => {
    const { port } = fakeExchange((req) => Promise.resolve(ackOf(req)));
    const { gate } = build(port);
    const approved = approve({ symbol: symbolId('ETH/USDT') }); // not in FILTERS
    expect((await gate.submit(approved)).outcome).toBe('SUBMITTED');
  });

  it('SUBMITTING + cancel sets cancelWanted (deferred), no venue cancel yet', async () => {
    let resolvePlace!: (a: ExchangeAck) => void;
    const pending = new Promise<ExchangeAck>((r) => { resolvePlace = r; });
    const { port, cancelCalls } = fakeExchange(() => pending);
    const { gate, orders } = build(port);
    const approved = approve();
    const coid = approved.intent.clientOrderId;
    const submitP = gate.submit(approved);
    await flush();
    await gate.cancel(coid, 'TTL');
    expect(orders.get(coid)?.cancelWanted).toBe(true);
    expect(cancelCalls).toHaveLength(0);
    resolvePlace(ackOf({ clientOrderId: coid } as PlaceOrderRequest));
    await submitP;
  });
});
