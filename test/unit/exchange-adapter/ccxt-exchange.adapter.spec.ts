import { describe, it, expect, vi } from 'vitest';
import { InsufficientFunds, OrderNotFound } from 'ccxt';
import { CcxtExchangeAdapter } from '../../../src/modules/exchange-adapter/ccxt-exchange.adapter';
import { AdapterError } from '../../../src/ports/exchange';
import { clientOrderId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type { CcxtOrderClient, CcxtOrder, CcxtTrade, CcxtBalances } from '../../../src/modules/exchange-adapter/ccxt-order-client';
import type { PlaceOrderRequest } from '../../../src/ports/exchange';

const SYM = symbolId('BTC/USDT');
const VEN = venueId('binance');
const COID = clientOrderId('cbp0190abcd12347abc89ab0123456789aa');

const baseOrder: CcxtOrder = {
  id: '12345',
  clientOrderId: COID,
  status: 'open',
  filled: '0',
  amount: '1.0',
  symbol: 'BTC/USDT',
};

const baseTrade: CcxtTrade = {
  id: 'trade-1',
  order: COID,
  timestamp: 1_700_000_000_000,
  price: '50000.00',
  amount: '0.1',
  side: 'buy',
  takerOrMaker: 'taker',
  fee: { cost: '5.00', currency: 'USDT' },
};

function fakeClient(overrides: Partial<CcxtOrderClient> = {}): CcxtOrderClient {
  return {
    createOrder: vi.fn().mockResolvedValue(baseOrder),
    cancelOrder: vi.fn().mockResolvedValue(baseOrder),
    fetchOrder: vi.fn().mockResolvedValue(baseOrder),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    fetchBalance: vi.fn().mockResolvedValue({
      BTC: { free: '1.0', used: '0.0' },
    } satisfies CcxtBalances),
    fetchMyTrades: vi.fn().mockResolvedValue([baseTrade]),
    sapiGetAccountApiRestrictions: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeCcxtAdapter(client: CcxtOrderClient = fakeClient()): CcxtExchangeAdapter {
  return new CcxtExchangeAdapter(client, VEN, true);
}

const baseReq: PlaceOrderRequest = {
  clientOrderId: COID,
  symbol: SYM,
  side: 'BUY',
  type: 'LIMIT',
  qty: '1.0',
  limitPrice: '50000',
  timeInForce: 'GTC',
  reduceOnly: false,
};

// ── placeOrder ────────────────────────────────────────────────────────────────

describe('CcxtExchangeAdapter.placeOrder', () => {
  it('calls createOrder with correct type/side/params for LIMIT', async () => {
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    const ack = await adapter.placeOrder(baseReq);

    expect((client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      SYM,
      'limit',
      'buy',
      '1.0',
      '50000',
      { clientOrderId: COID, timeInForce: 'GTC' },
    ]);
    expect(ack.clientOrderId).toBe(COID);
    expect(ack.venueOrderId).toBe('12345');
  });

  it('calls createOrder with type=market and no timeInForce for MARKET', async () => {
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    await adapter.placeOrder({ ...baseReq, type: 'MARKET', limitPrice: undefined });

    const [, type, , , , params] = (client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
      string,
      string | undefined,
      Record<string, unknown>,
    ];
    expect(type).toBe('market');
    expect(params['timeInForce']).toBeUndefined();
  });

  it('calls createOrder with type=limit and postOnly=true for LIMIT_MAKER', async () => {
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    await adapter.placeOrder({ ...baseReq, type: 'LIMIT_MAKER' });

    const [, type, , , , params] = (client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
      string,
      string | undefined,
      Record<string, unknown>,
    ];
    expect(type).toBe('limit');
    expect(params['postOnly']).toBe(true);
  });

  it('passes clientOrderId in params', async () => {
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    await adapter.placeOrder(baseReq);

    const [, , , , , params] = (client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
      string,
      string | undefined,
      Record<string, unknown>,
    ];
    expect(params['clientOrderId']).toBe(COID);
  });

  it('wraps InsufficientFunds into AdapterError TERMINAL_REJECT', async () => {
    const client = fakeClient({
      createOrder: vi.fn().mockRejectedValue(new InsufficientFunds('broke')),
    });
    const adapter = makeCcxtAdapter(client);

    await expect(adapter.placeOrder(baseReq)).rejects.toMatchObject({
      errorClass: 'TERMINAL_REJECT',
      code: 'InsufficientFunds',
    });
  });

  it('throws AdapterError (not raw ccxt) on venue rejection', async () => {
    const client = fakeClient({
      createOrder: vi.fn().mockRejectedValue(new InsufficientFunds('broke')),
    });
    const adapter = makeCcxtAdapter(client);

    const err = await adapter.placeOrder(baseReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
  });
});

// ── cancelOrder ───────────────────────────────────────────────────────────────

describe('CcxtExchangeAdapter.cancelOrder', () => {
  it('calls cancelOrder with undefined id and clientOrderId param', async () => {
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    const ack = await adapter.cancelOrder(COID, SYM);

    expect((client.cancelOrder as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([undefined, SYM, { clientOrderId: COID }]);
    expect(ack.clientOrderId).toBe(COID);
    expect(ack.venueOrderId).toBe('12345');
  });

  it('wraps OrderNotFound into AdapterError OUTCOME_AMBIGUOUS', async () => {
    const client = fakeClient({
      cancelOrder: vi.fn().mockRejectedValue(new OrderNotFound('gone')),
    });
    const adapter = makeCcxtAdapter(client);

    await expect(adapter.cancelOrder(COID, SYM)).rejects.toMatchObject({
      errorClass: 'OUTCOME_AMBIGUOUS',
      code: 'OrderNotFound',
    });
  });
});

// ── fetchOrder ────────────────────────────────────────────────────────────────

describe('CcxtExchangeAdapter.fetchOrder', () => {
  it('calls fetchOrder with undefined id and clientOrderId param', async () => {
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    const state = await adapter.fetchOrder(COID, SYM);

    expect((client.fetchOrder as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([undefined, SYM, { clientOrderId: COID }]);
    expect(state.clientOrderId).toBe(COID);
    expect(state.venueOrderId).toBe('12345');
    expect(state.status).toBe('open');
  });

  it('wraps OrderNotFound into OUTCOME_AMBIGUOUS', async () => {
    const client = fakeClient({
      fetchOrder: vi.fn().mockRejectedValue(new OrderNotFound('not found')),
    });
    const adapter = makeCcxtAdapter(client);

    await expect(adapter.fetchOrder(COID, SYM)).rejects.toMatchObject({
      errorClass: 'OUTCOME_AMBIGUOUS',
    });
  });
});

// ── fetchOpenOrders ───────────────────────────────────────────────────────────

describe('CcxtExchangeAdapter.fetchOpenOrders', () => {
  it('returns empty array when no open orders', async () => {
    const adapter = makeCcxtAdapter();
    const result = await adapter.fetchOpenOrders(SYM);
    expect(result).toHaveLength(0);
  });

  it('maps open orders to ExchangeOrderState', async () => {
    const client = fakeClient({
      fetchOpenOrders: vi.fn().mockResolvedValue([
        { ...baseOrder, status: 'open', symbol: 'BTC/USDT' },
      ]),
    });
    const adapter = makeCcxtAdapter(client);

    const result = await adapter.fetchOpenOrders(SYM);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('open');
    expect(result[0]!.venueOrderId).toBe('12345');
  });

  it('uses order.symbol when symbol param is undefined', async () => {
    const client = fakeClient({
      fetchOpenOrders: vi.fn().mockResolvedValue([
        { ...baseOrder, status: 'open', symbol: 'ETH/USDT' },
      ]),
    });
    const adapter = makeCcxtAdapter(client);

    const result = await adapter.fetchOpenOrders(undefined);

    expect(result[0]!.symbol).toBe(symbolId('ETH/USDT'));
  });
});

// ── fetchBalances ─────────────────────────────────────────────────────────────

describe('CcxtExchangeAdapter.fetchBalances', () => {
  it('returns a map of asset free/locked strings', async () => {
    const adapter = makeCcxtAdapter();
    const result = await adapter.fetchBalances();
    expect(result.get('BTC')).toEqual({ free: '1.0', locked: '0.0' });
  });
});

// ── fetchMyTrades ─────────────────────────────────────────────────────────────

describe('CcxtExchangeAdapter.fetchMyTrades', () => {
  it('passes symbol and since to client, maps to VenueFill with exact strings', async () => {
    const since = epochMs(1_699_000_000_000);
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    const fills = await adapter.fetchMyTrades(SYM, since);

    expect((client.fetchMyTrades as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([SYM, since, undefined, {}]);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe('50000.00'); // exact string, never toBeCloseTo
    expect(fills[0]!.qty).toBe('0.1');
    expect(fills[0]!.fee).toEqual({ ccy: 'USDT', amount: '5.00' });
    expect(fills[0]!.liquidity).toBe('taker');
  });
});

// ── validateCredentials ───────────────────────────────────────────────────────

describe('CcxtExchangeAdapter.validateCredentials', () => {
  it('returns valid stub with withdrawalsEnabled=false', async () => {
    const adapter = makeCcxtAdapter();
    const result = await adapter.validateCredentials();
    expect(result.valid).toBe(true);
    expect(result.canTrade).toBe(true);
    expect(result.withdrawalsEnabled).toBe(false);
    expect(result.keyFingerprint).toBe('ccxt');
  });
});

// ── capabilities ─────────────────────────────────────────────────────────────

describe('CcxtExchangeAdapter capabilities', () => {
  it('reflects sandbox flag passed to constructor', () => {
    const adapter = new CcxtExchangeAdapter(fakeClient(), VEN, true);
    expect(adapter.capabilities.sandbox).toBe(true);
    const liveAdapter = new CcxtExchangeAdapter(fakeClient(), VEN, false);
    expect(liveAdapter.capabilities.sandbox).toBe(false);
  });

  it('has clientOrderId and fetchOrderByClientId true', () => {
    const adapter = makeCcxtAdapter();
    expect(adapter.capabilities.clientOrderId).toBe(true);
    expect(adapter.capabilities.fetchOrderByClientId).toBe(true);
  });
});
