import { describe, it, expect } from 'vitest';
import {
  normalizeOrderState,
  normalizeTrade,
  normalizeBalances,
} from '../../../src/features/trading/exchange/ccxt-normalize';
import { clientOrderId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type {
  CcxtOrder,
  CcxtTrade,
  CcxtBalances,
} from '../../../src/features/trading/exchange/ccxt-order-client';

const SYM = symbolId('BTC/USDT');
const VEN = venueId('binance');
const COID = clientOrderId('cbp0190abcd12347abc89ab0123456789aa');

// ── normalizeOrderState ──────────────────────────────────────────────────────

describe('normalizeOrderState', () => {
  const baseOrder: CcxtOrder = {
    id: '12345',
    clientOrderId: COID,
    status: 'open',
    filled: '0.5',
    amount: '1.0',
    symbol: 'BTC/USDT',
  };

  it('maps open status correctly', () => {
    const result = normalizeOrderState(baseOrder, COID, SYM);
    expect(result.status).toBe('open');
    expect(result.venueOrderId).toBe('12345');
    expect(result.clientOrderId).toBe(COID);
    expect(result.symbol).toBe(SYM);
    expect(result.cumQty).toBe('0.5');
    expect(result.qty).toBe('1.0');
  });

  it.each([
    ['closed', 'closed'],
    ['canceled', 'canceled'],
    ['rejected', 'rejected'],
    ['expired', 'expired'],
  ] as const)('maps status %s correctly', (input, expected) => {
    const result = normalizeOrderState({ ...baseOrder, status: input }, COID, SYM);
    expect(result.status).toBe(expected);
  });

  it('throws on unknown status', () => {
    expect(() => normalizeOrderState({ ...baseOrder, status: 'pending' }, COID, SYM)).toThrow(
      'unknown ccxt order status "pending"',
    );
  });

  it('throws on undefined status', () => {
    expect(() => normalizeOrderState({ ...baseOrder, status: undefined }, COID, SYM)).toThrow(
      'unknown ccxt order status "undefined"',
    );
  });

  it('stringifies numeric id', () => {
    const result = normalizeOrderState({ ...baseOrder, id: 99887 }, COID, SYM);
    expect(result.venueOrderId).toBe('99887');
  });

  it('defaults cumQty to "0" when filled is undefined', () => {
    const result = normalizeOrderState({ ...baseOrder, filled: undefined }, COID, SYM);
    expect(result.cumQty).toBe('0');
  });

  it('stringifies numeric filled', () => {
    const result = normalizeOrderState({ ...baseOrder, filled: 0.75 }, COID, SYM);
    expect(result.cumQty).toBe('0.75');
  });

  it('returns exact string money values (toBeCloseTo BANNED)', () => {
    const result = normalizeOrderState(
      { ...baseOrder, filled: '1234567890.123456789', amount: '9876543210.987654321' },
      COID,
      SYM,
    );
    expect(result.cumQty).toBe('1234567890.123456789');
    expect(result.qty).toBe('9876543210.987654321');
  });
});

// ── normalizeTrade ───────────────────────────────────────────────────────────

describe('normalizeTrade', () => {
  const baseTrade: CcxtTrade = {
    id: 'trade-42',
    order: 'venue-order-1',
    timestamp: 1_700_000_000_000,
    price: '50000.00',
    amount: '0.1',
    cost: '5000.00',
    side: 'buy',
    takerOrMaker: 'taker',
    fee: { cost: '5.00', currency: 'USDT' },
  };

  it('maps a full trade to VenueFill with exact strings', () => {
    const fill = normalizeTrade(baseTrade, VEN, SYM);
    expect(fill.venue).toBe(VEN);
    expect(fill.symbol).toBe(SYM);
    expect(fill.venueTradeId).toBe('trade-42');
    expect(fill.price).toBe('50000.00');
    expect(fill.qty).toBe('0.1');
    expect(fill.fee).toEqual({ ccy: 'USDT', amount: '5.00' });
    expect(fill.liquidity).toBe('taker');
    expect(fill.venueTimestamp).toBe(epochMs(1_700_000_000_000));
  });

  it('maps takerOrMaker === "maker" to liquidity maker', () => {
    const fill = normalizeTrade({ ...baseTrade, takerOrMaker: 'maker' }, VEN, SYM);
    expect(fill.liquidity).toBe('maker');
  });

  it('defaults to taker liquidity when takerOrMaker is absent', () => {
    const fill = normalizeTrade({ ...baseTrade, takerOrMaker: undefined }, VEN, SYM);
    expect(fill.liquidity).toBe('taker');
  });

  it('maps fee: null to null in output', () => {
    const fill = normalizeTrade({ ...baseTrade, fee: null }, VEN, SYM);
    expect(fill.fee).toBeNull();
  });

  it('maps fee: undefined to null in output', () => {
    const fill = normalizeTrade({ ...baseTrade, fee: undefined }, VEN, SYM);
    expect(fill.fee).toBeNull();
  });

  it('uses fallbackCoid when trade.order is absent', () => {
    const fallback = clientOrderId('cbp0190abcd12347abc89ab0123456789bb');
    const fill = normalizeTrade({ ...baseTrade, order: undefined }, VEN, SYM, fallback);
    expect(fill.clientOrderId).toBe(fallback);
  });

  it('throws when timestamp is undefined', () => {
    expect(() => normalizeTrade({ ...baseTrade, timestamp: undefined }, VEN, SYM)).toThrow(
      'missing a valid integer timestamp',
    );
  });

  it('throws when timestamp is a float', () => {
    expect(() => normalizeTrade({ ...baseTrade, timestamp: 1.5 }, VEN, SYM)).toThrow(
      'missing a valid integer timestamp',
    );
  });

  it('stringifies numeric trade id', () => {
    const fill = normalizeTrade({ ...baseTrade, id: 777 }, VEN, SYM);
    expect(fill.venueTradeId).toBe('777');
  });

  it('stringifies numeric fee cost', () => {
    const fill = normalizeTrade({ ...baseTrade, fee: { cost: 2.5, currency: 'BNB' } }, VEN, SYM);
    expect(fill.fee).toEqual({ ccy: 'BNB', amount: '2.5' });
  });
});

// ── normalizeBalances ─────────────────────────────────────────────────────────

describe('normalizeBalances', () => {
  it('maps asset entries to free/locked strings', () => {
    const raw: CcxtBalances = {
      BTC: { free: '1.5', used: '0.5', total: '2.0' },
      USDT: { free: 10000, used: 500 },
    };
    const result = normalizeBalances(raw);
    expect(result.get('BTC')).toEqual({ free: '1.5', locked: '0.5' });
    expect(result.get('USDT')).toEqual({ free: '10000', locked: '500' });
  });

  it('filters out ccxt meta keys', () => {
    const raw: CcxtBalances = {
      BTC: { free: '1.0', used: '0.0' },
      info: { some: 'object' },
      free: { free: '100' },
      used: { used: '10' },
      total: { total: '110' },
      timestamp: 1_700_000_000_000,
      datetime: '2023-01-01T00:00:00Z',
    };
    const result = normalizeBalances(raw);
    expect(result.has('info')).toBe(false);
    expect(result.has('free')).toBe(false);
    expect(result.has('used')).toBe(false);
    expect(result.has('total')).toBe(false);
    expect(result.has('timestamp')).toBe(false);
    expect(result.has('datetime')).toBe(false);
    expect(result.has('BTC')).toBe(true);
  });

  it('defaults undefined free/used to "0"', () => {
    const raw: CcxtBalances = {
      ETH: { free: undefined, used: undefined },
    };
    const result = normalizeBalances(raw);
    expect(result.get('ETH')).toEqual({ free: '0', locked: '0' });
  });

  it('skips null/primitive asset values', () => {
    const raw: CcxtBalances = {
      BTC: { free: '1.0', used: '0.0' },
      BADENTRY: null,
    };
    const result = normalizeBalances(raw);
    expect(result.has('BADENTRY')).toBe(false);
    expect(result.has('BTC')).toBe(true);
  });
});
