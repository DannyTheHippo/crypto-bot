import { describe, it, expect, vi } from 'vitest';
import { InsufficientFunds, OrderNotFound } from 'ccxt';
import { CcxtExchangeAdapter } from '../../../src/features/trading/exchange/ccxt-exchange.adapter';
import { AdapterError } from '../../../src/ports/exchange';
import { clientOrderId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type {
  CcxtOrderClient,
  CcxtOrder,
  CcxtTrade,
  CcxtBalances,
} from '../../../src/features/trading/exchange/ccxt-order-client';
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

    const [, type, , , , params] = (client.createOrder as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string, string, string | undefined, Record<string, unknown>];
    expect(type).toBe('market');
    expect(params['timeInForce']).toBeUndefined();
  });

  it('calls createOrder with type=limit, postOnly=true, and NO timeInForce for LIMIT_MAKER', async () => {
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    await adapter.placeOrder({ ...baseReq, type: 'LIMIT_MAKER', timeInForce: 'GTC' });

    const [, type, , , , params] = (client.createOrder as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string, string, string | undefined, Record<string, unknown>];
    expect(type).toBe('limit');
    expect(params['postOnly']).toBe(true);
    // Binance rejects extras on LIMIT_MAKER (-1106) and pinned ccxt forwards params verbatim —
    // postOnly alone expresses post-only; the intent's GTC persists but never reaches the venue.
    expect(params['timeInForce']).toBeUndefined();
    expect(params['clientOrderId']).toBe(COID);
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

// ── placeOrder reduceOnly (Push 3 P4) ──────────────────────────────────────────

describe('CcxtExchangeAdapter.placeOrder reduceOnly forwarding', () => {
  function paramsOf(client: CcxtOrderClient): Record<string, unknown> {
    const [, , , , , params] = (client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
      string,
      string | undefined,
      Record<string, unknown>,
    ];
    return params;
  }

  it('forwards reduceOnly:true on binanceusdm for LIMIT', async () => {
    const client = fakeClient();
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    await adapter.placeOrder({ ...baseReq, reduceOnly: true });

    expect(paramsOf(client)['reduceOnly']).toBe(true);
  });

  it('forwards reduceOnly:true on binanceusdm for MARKET', async () => {
    const client = fakeClient();
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    await adapter.placeOrder({
      ...baseReq,
      type: 'MARKET',
      limitPrice: undefined,
      reduceOnly: true,
    });

    expect(paramsOf(client)['reduceOnly']).toBe(true);
  });

  it('never sends reduceOnly on a spot venue even when the request asks for it', async () => {
    const client = fakeClient();
    const adapter = new CcxtExchangeAdapter(client, venueId('binance'), true);

    await adapter.placeOrder({ ...baseReq, reduceOnly: true });

    expect(paramsOf(client)).not.toHaveProperty('reduceOnly');
  });

  it('omits reduceOnly on binanceusdm when the request has it false', async () => {
    const client = fakeClient();
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    await adapter.placeOrder({ ...baseReq, reduceOnly: false });

    expect(paramsOf(client)).not.toHaveProperty('reduceOnly');
  });
});

// ── placeOrder trigger orders (Push 3 P7a) ─────────────────────────────────────

describe('CcxtExchangeAdapter.placeOrder trigger orders', () => {
  function paramsOf(client: CcxtOrderClient): Record<string, unknown> {
    const [, , , , , params] = (client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
      string,
      string | undefined,
      Record<string, unknown>,
    ];
    return params;
  }

  it('maps STOP_LOSS_LIMIT to ccxt limit + stopLossPrice on the spot rail', async () => {
    const client = fakeClient();
    const adapter = new CcxtExchangeAdapter(client, venueId('binance'), true);

    await adapter.placeOrder({
      ...baseReq,
      type: 'STOP_LOSS_LIMIT',
      limitPrice: '49000',
      triggerPrice: '49500',
    });

    const [, type, , , price] = (client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
      string,
      string | undefined,
      Record<string, unknown>,
    ];
    expect(type).toBe('limit');
    expect(price).toBe('49000'); // the limit leg price, distinct from the trigger price
    const params = paramsOf(client);
    expect(params['stopLossPrice']).toBe('49500');
    expect(params['timeInForce']).toBe('GTC');
    expect(params['clientOrderId']).toBe(COID);
  });

  it('maps STOP_MARKET to ccxt market + stopPrice + reduceOnly + clientAlgoId on the swap venue', async () => {
    const client = fakeClient();
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    await adapter.placeOrder({
      ...baseReq,
      type: 'STOP_MARKET',
      limitPrice: undefined,
      triggerPrice: '48000',
      reduceOnly: true,
    });

    const [, type] = (client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
      string,
      string | undefined,
      Record<string, unknown>,
    ];
    expect(type).toBe('market');
    const params = paramsOf(client);
    expect(params['stopPrice']).toBe('48000');
    expect(params['reduceOnly']).toBe(true);
    // OMS rule 5: the algo rail's dedupe key is clientAlgoId, set to the same clientOrderId string.
    expect(params['clientAlgoId']).toBe(COID);
  });

  it('throws fail-closed when STOP_LOSS_LIMIT is placed on the swap venue', async () => {
    const client = fakeClient();
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    await expect(
      adapter.placeOrder({
        ...baseReq,
        type: 'STOP_LOSS_LIMIT',
        triggerPrice: '49500',
      }),
    ).rejects.toThrow(/STOP_LOSS_LIMIT is spot-only.*fail-closed/);
  });

  it('throws fail-closed when STOP_MARKET is placed on a spot venue', async () => {
    const client = fakeClient();
    const adapter = new CcxtExchangeAdapter(client, venueId('binance'), true);

    await expect(
      adapter.placeOrder({
        ...baseReq,
        type: 'STOP_MARKET',
        limitPrice: undefined,
        triggerPrice: '48000',
      }),
    ).rejects.toThrow(/STOP_MARKET is swap-only.*fail-closed/);
  });
});

// ── algo rail (Push 3 P7a) ──────────────────────────────────────────────────────

describe('CcxtExchangeAdapter algo rail (fetchOpenAlgoOrders/cancelAlgoOrder)', () => {
  // Live demo-fapi row shape (#54, probe 2026-07-16): `symbol` is the VENUE market id
  // ("BTCUSDT"), never the unified form — the pre-fix filter compared only the unified form and
  // silently dropped every genuine row.
  const rawAlgo = {
    algoId: 999,
    clientAlgoId: COID,
    symbol: 'BTCUSDT',
    side: 'SELL',
    orderType: 'STOP_MARKET',
    quantity: '0.5',
    triggerPrice: '48000',
    algoStatus: 'NEW',
    reduceOnly: true,
  };
  const normalizedAlgo = {
    algoId: '999',
    clientAlgoId: COID,
    symbol: symbolId('BTC/USDT:USDT'),
    side: 'SELL',
    type: 'STOP_MARKET',
    qty: '0.5',
    triggerPrice: '48000',
    status: 'NEW',
    reduceOnly: true,
  };

  it('normalizes the documented { orders } response shape on the swap venue', async () => {
    const fetchAlgo = vi.fn().mockResolvedValue({ orders: [rawAlgo] });
    const client = fakeClient({ fapiPrivateGetOpenAlgoOrders: fetchAlgo });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchOpenAlgoOrders(symbolId('BTC/USDT:USDT'));

    expect(fetchAlgo).toHaveBeenCalledWith();
    expect(result).toEqual([normalizedAlgo]);
  });

  // #54 regression: demo-fapi answers with a BARE ARRAY (probe-verified for both the empty and
  // non-empty case) — the pre-fix `const { orders } = …` destructure made `.filter` throw
  // TypeError on EVERY live call, which the strategy saw as an AdapterError on every managed bar.
  it('#54: normalizes the live bare-array response shape identically (demo-fapi reality)', async () => {
    const fetchAlgo = vi.fn().mockResolvedValue([rawAlgo]);
    const client = fakeClient({ fapiPrivateGetOpenAlgoOrders: fetchAlgo });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchOpenAlgoOrders(symbolId('BTC/USDT:USDT'));

    expect(result).toEqual([normalizedAlgo]);
  });

  it('#54: the symbol filter matches the venue market id AND the unified form, and drops other symbols', async () => {
    const ethRow = { ...rawAlgo, algoId: 1000, symbol: 'ETHUSDT' };
    const unifiedRow = { ...rawAlgo, algoId: 1001, symbol: 'BTC/USDT:USDT' };
    const fetchAlgo = vi.fn().mockResolvedValue([rawAlgo, ethRow, unifiedRow]);
    const client = fakeClient({ fapiPrivateGetOpenAlgoOrders: fetchAlgo });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchOpenAlgoOrders(symbolId('BTC/USDT:USDT'));

    expect(result.map((o) => o.algoId)).toEqual(['999', '1001']);
    expect(result.every((o) => o.symbol === symbolId('BTC/USDT:USDT'))).toBe(true);
  });

  it('#54: an empty bare-array response resolves to [] (the demo empty case that used to throw)', async () => {
    const fetchAlgo = vi.fn().mockResolvedValue([]);
    const client = fakeClient({ fapiPrivateGetOpenAlgoOrders: fetchAlgo });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    await expect(adapter.fetchOpenAlgoOrders(symbolId('BTC/USDT:USDT'))).resolves.toEqual([]);
  });

  it('returns an empty list on a spot venue without calling the client', async () => {
    const fetchAlgo = vi.fn().mockResolvedValue({ orders: [rawAlgo] });
    const client = fakeClient({ fapiPrivateGetOpenAlgoOrders: fetchAlgo });
    const adapter = new CcxtExchangeAdapter(client, venueId('binance'), true);

    const result = await adapter.fetchOpenAlgoOrders();

    expect(result).toEqual([]);
    expect(fetchAlgo).not.toHaveBeenCalled();
  });

  it('throws fail-closed on the swap venue when the client lacks the hook', async () => {
    const adapter = new CcxtExchangeAdapter({} as CcxtOrderClient, venueId('binanceusdm'), true);

    await expect(adapter.fetchOpenAlgoOrders()).rejects.toThrow(/fail-closed/);
  });

  it('calls the raw fapi cancel endpoint with algoId on the swap venue', async () => {
    const cancelAlgo = vi.fn().mockResolvedValue({});
    const client = fakeClient({ fapiPrivateDeleteAlgoOrder: cancelAlgo });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    await adapter.cancelAlgoOrder('999', symbolId('BTC/USDT:USDT'));

    expect(cancelAlgo).toHaveBeenCalledWith({ algoId: '999' });
  });

  it('throws fail-closed when cancelAlgoOrder is called on a spot venue', async () => {
    const cancelAlgo = vi.fn().mockResolvedValue({});
    const client = fakeClient({ fapiPrivateDeleteAlgoOrder: cancelAlgo });
    const adapter = new CcxtExchangeAdapter(client, venueId('binance'), true);

    await expect(adapter.cancelAlgoOrder('999', symbolId('BTC/USDT'))).rejects.toThrow(
      /swap-only.*fail-closed/,
    );
    expect(cancelAlgo).not.toHaveBeenCalled();
  });

  it('throws fail-closed on the swap venue when the client lacks the cancel hook', async () => {
    const adapter = new CcxtExchangeAdapter({} as CcxtOrderClient, venueId('binanceusdm'), true);

    await expect(adapter.cancelAlgoOrder('999', symbolId('BTC/USDT:USDT'))).rejects.toThrow(
      /fail-closed/,
    );
  });
});

// ── fetchAlgoOrderStatus (Defect A) ────────────────────────────────────────────

describe('CcxtExchangeAdapter.fetchAlgoOrderStatus', () => {
  const rawHistRow = {
    algoId: 999,
    clientAlgoId: COID,
    symbol: 'BTCUSDT',
    orderType: 'STOP_MARKET',
    side: 'SELL',
    quantity: '0.5',
    triggerPrice: '48000',
    algoStatus: 'TRIGGERED',
    orderId: 555,
    updateTime: 1_700_000_000_000,
  };

  it('normalizes the documented { orders } response shape, matching by clientAlgoId', async () => {
    const fetchHist = vi.fn().mockResolvedValue({ orders: [rawHistRow] });
    const client = fakeClient({ fapiPrivateGetAllAlgoOrders: fetchHist });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchAlgoOrderStatus(
      COID,
      symbolId('BTC/USDT:USDT'),
      epochMs(1_699_000_000_000),
    );

    expect(fetchHist).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      startTime: epochMs(1_699_000_000_000),
      limit: 100,
    });
    expect(result).toEqual({
      algoId: '999',
      clientAlgoId: COID,
      status: 'TRIGGERED',
      spawnedOrderId: '555',
      qty: '0.5',
      triggerPrice: '48000',
      updateTimeMs: 1_700_000_000_000,
    });
  });

  it('#54-style: normalizes the live bare-array response shape identically', async () => {
    const fetchHist = vi.fn().mockResolvedValue([rawHistRow]);
    const client = fakeClient({ fapiPrivateGetAllAlgoOrders: fetchHist });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchAlgoOrderStatus(COID, symbolId('BTC/USDT:USDT'), epochMs(0));

    expect(result?.algoId).toBe('999');
    expect(result?.status).toBe('TRIGGERED');
    expect(result?.spawnedOrderId).toBe('555');
  });

  it('matches ONLY by clientAlgoId among foreign rows, ignoring a foreign row sharing our orderId', async () => {
    const foreignRow = {
      ...rawHistRow,
      algoId: 1,
      clientAlgoId: 'someone-elses-coid',
      orderId: 999,
    };
    const fetchHist = vi.fn().mockResolvedValue([foreignRow, rawHistRow]);
    const client = fakeClient({ fapiPrivateGetAllAlgoOrders: fetchHist });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchAlgoOrderStatus(COID, symbolId('BTC/USDT:USDT'), epochMs(0));

    expect(result?.algoId).toBe('999');
  });

  it('returns undefined when no row matches the requested clientAlgoId', async () => {
    const fetchHist = vi.fn().mockResolvedValue([{ ...rawHistRow, clientAlgoId: 'not-ours' }]);
    const client = fakeClient({ fapiPrivateGetAllAlgoOrders: fetchHist });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchAlgoOrderStatus(COID, symbolId('BTC/USDT:USDT'), epochMs(0));

    expect(result).toBeUndefined();
  });

  it('maps an unrecognized algoStatus to UNKNOWN', async () => {
    const weirdRow = { ...rawHistRow, algoStatus: 'SOMETHING_NEW' };
    const fetchHist = vi.fn().mockResolvedValue([weirdRow]);
    const client = fakeClient({ fapiPrivateGetAllAlgoOrders: fetchHist });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchAlgoOrderStatus(COID, symbolId('BTC/USDT:USDT'), epochMs(0));

    expect(result?.status).toBe('UNKNOWN');
  });

  it('returns undefined on a spot venue without calling the client', async () => {
    const fetchHist = vi.fn().mockResolvedValue([rawHistRow]);
    const client = fakeClient({ fapiPrivateGetAllAlgoOrders: fetchHist });
    const adapter = new CcxtExchangeAdapter(client, venueId('binance'), true);

    const result = await adapter.fetchAlgoOrderStatus(COID, SYM, epochMs(0));

    expect(result).toBeUndefined();
    expect(fetchHist).not.toHaveBeenCalled();
  });

  it('throws fail-closed on the swap venue when the client lacks the hook', async () => {
    const adapter = new CcxtExchangeAdapter({} as CcxtOrderClient, venueId('binanceusdm'), true);

    await expect(
      adapter.fetchAlgoOrderStatus(COID, symbolId('BTC/USDT:USDT'), epochMs(0)),
    ).rejects.toThrow(/fail-closed/);
  });
});

// ── fetchPositions (Defect A) ───────────────────────────────────────────────────

describe('CcxtExchangeAdapter.fetchPositions', () => {
  it('returns [] on a spot venue without calling the client', async () => {
    const fetchPositions = vi.fn().mockResolvedValue([]);
    const client = fakeClient({ fetchPositions });
    const adapter = new CcxtExchangeAdapter(client, venueId('binance'), true);

    const result = await adapter.fetchPositions([SYM]);

    expect(result).toEqual([]);
    expect(fetchPositions).not.toHaveBeenCalled();
  });

  it('surfaces info.positionAmt as an EXACT string, never the unified float contracts', async () => {
    const rawPos = {
      symbol: 'BTC/USDT:USDT',
      contracts: 0.001, // unified float — must never be read
      info: { symbol: 'BTCUSDT', positionAmt: '0.00100', entryPrice: '117000.5' },
    };
    const fetchPositions = vi.fn().mockResolvedValue([rawPos]);
    const client = fakeClient({ fetchPositions });
    const adapter = new CcxtExchangeAdapter(client, venueId('binanceusdm'), true);

    const result = await adapter.fetchPositions([symbolId('BTC/USDT:USDT')]);

    expect(fetchPositions).toHaveBeenCalledWith(['BTC/USDT:USDT'], {});
    expect(result).toEqual([
      { symbol: symbolId('BTC/USDT:USDT'), signedQty: '0.00100', entryPrice: '117000.5' },
    ]);
  });

  it('throws fail-closed on the swap venue when the client lacks fetchPositions', async () => {
    const adapter = new CcxtExchangeAdapter({} as CcxtOrderClient, venueId('binanceusdm'), true);

    await expect(adapter.fetchPositions([symbolId('BTC/USDT:USDT')])).rejects.toThrow(
      /fail-closed/,
    );
  });
});

// ── cancelOrder ───────────────────────────────────────────────────────────────

describe('CcxtExchangeAdapter.cancelOrder', () => {
  it('calls cancelOrder with undefined id and clientOrderId param', async () => {
    const client = fakeClient();
    const adapter = makeCcxtAdapter(client);

    const ack = await adapter.cancelOrder(COID, SYM);

    expect((client.cancelOrder as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      undefined,
      SYM,
      { clientOrderId: COID },
    ]);
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

    expect((client.fetchOrder as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      undefined,
      SYM,
      { clientOrderId: COID },
    ]);
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
      fetchOpenOrders: vi
        .fn()
        .mockResolvedValue([{ ...baseOrder, status: 'open', symbol: 'BTC/USDT' }]),
    });
    const adapter = makeCcxtAdapter(client);

    const result = await adapter.fetchOpenOrders(SYM);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('open');
    expect(result[0]!.venueOrderId).toBe('12345');
  });

  it('uses order.symbol when symbol param is undefined', async () => {
    const client = fakeClient({
      fetchOpenOrders: vi
        .fn()
        .mockResolvedValue([{ ...baseOrder, status: 'open', symbol: 'ETH/USDT' }]),
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

    expect((client.fetchMyTrades as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      SYM,
      since,
      undefined,
      {},
    ]);
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
