import { describe, it, expect } from 'vitest';
import {
  normalizeOrderState,
  normalizeTrade,
  normalizeBalances,
  normalizeFundingPayment,
  normalizeAlgoHistory,
} from '../../../../src/features/venue/exchange/ccxt-normalize';
import { clientOrderId, venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';
import type {
  CcxtOrder,
  CcxtTrade,
  CcxtBalances,
  CcxtFundingHistoryEntry,
  RawAlgoOrder,
} from '../../../../src/features/venue/exchange/ccxt-order-client';

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

  // String(undefined) used to mint the literal "undefined" as the venue identity: reconciliation's
  // venueOrderIndex would key on it and the unknown-resolver's `length > 0` truth test would accept
  // it as a real venue order.
  it('throws when the venue order id is missing (never mints the string "undefined")', () => {
    expect(() => normalizeOrderState({ ...baseOrder, id: undefined }, COID, SYM)).toThrow(
      'normalizeOrderState: order is missing a venue order id (got undefined)',
    );
  });

  it('throws when the venue order id is an empty string', () => {
    expect(() => normalizeOrderState({ ...baseOrder, id: '' }, COID, SYM)).toThrow(
      'normalizeOrderState: order is missing a venue order id (got empty string)',
    );
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

  // venueTradeId is the dedupe key of UNIQUE(venue, symbol, venue_trade_id): two id-less trades on
  // one symbol both stringified to "undefined", so the second was swallowed by the ingestor's
  // ON CONFLICT DO NOTHING and its money effect never landed.
  it('throws when the venue trade id is missing (never mints the string "undefined")', () => {
    expect(() => normalizeTrade({ ...baseTrade, id: undefined }, VEN, SYM)).toThrow(
      'normalizeTrade: trade is missing a venue trade id (got undefined)',
    );
  });

  it('throws when the venue trade id is an empty string', () => {
    expect(() => normalizeTrade({ ...baseTrade, id: '' }, VEN, SYM)).toThrow(
      'normalizeTrade: trade is missing a venue trade id (got empty string)',
    );
  });

  it('stringifies numeric fee cost', () => {
    const fill = normalizeTrade({ ...baseTrade, fee: { cost: 2.5, currency: 'BNB' } }, VEN, SYM);
    expect(fill.fee).toEqual({ ccy: 'BNB', amount: '2.5' });
  });
});

// ── normalizeFundingPayment ───────────────────────────────────────────────────
// Sign convention (ccxt unified income-endpoint semantics, pinned both directions):
// amountQuote POSITIVE = received (a short collecting funding), NEGATIVE = paid (a long paying
// funding) — see VenueFundingPayment's own header comment, ports/venue/exchange.ts.

describe('normalizeFundingPayment', () => {
  const baseEntry: CcxtFundingHistoryEntry = {
    id: 'fund-1',
    symbol: 'BTC/USDT:USDT',
    timestamp: 1_700_000_000_000,
    amount: '1.23456789012345678',
  };

  it('maps a RECEIVED (positive) settlement with an exact decimal string', () => {
    const payment = normalizeFundingPayment(baseEntry, VEN, SYM);
    expect(payment.venue).toBe(VEN);
    expect(payment.symbol).toBe(SYM);
    expect(payment.venuePaymentId).toBe('fund-1');
    expect(payment.amountQuote).toBe('1.23456789012345678');
    expect(payment.fundingTime).toBe(epochMs(1_700_000_000_000));
  });

  it('maps a PAID (negative) settlement with an exact decimal string', () => {
    const payment = normalizeFundingPayment(
      { ...baseEntry, amount: '-0.98765432109876543' },
      VEN,
      SYM,
    );
    expect(payment.amountQuote).toBe('-0.98765432109876543');
  });

  it('stringifies a numeric amount (never Number()-rounds)', () => {
    const payment = normalizeFundingPayment({ ...baseEntry, amount: -2.5 }, VEN, SYM);
    expect(payment.amountQuote).toBe('-2.5');
  });

  it('defaults amount to "0" when absent', () => {
    const payment = normalizeFundingPayment({ ...baseEntry, amount: undefined }, VEN, SYM);
    expect(payment.amountQuote).toBe('0');
  });

  it('stringifies a numeric id', () => {
    const payment = normalizeFundingPayment({ ...baseEntry, id: 42 }, VEN, SYM);
    expect(payment.venuePaymentId).toBe('42');
  });

  it('throws when timestamp is undefined', () => {
    expect(() => normalizeFundingPayment({ ...baseEntry, timestamp: undefined }, VEN, SYM)).toThrow(
      'missing a valid integer timestamp',
    );
  });

  it('throws when timestamp is a float', () => {
    expect(() => normalizeFundingPayment({ ...baseEntry, timestamp: 1.5 }, VEN, SYM)).toThrow(
      'missing a valid integer timestamp',
    );
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

describe('normalizeAlgoHistory status mapping', () => {
  // Verbatim demo-fapi row for the WATCH-V4-10 strand (keyed probe 2026-07-31): HYPE stop
  // cbt019fb31cb7c97ea0a8dfa5462d3d3764 fired ~4 minutes after its position went flat, so the
  // reduce-only order it spawned was refused and the conditional ended REJECTED with an EMPTY
  // actualOrderId. Field-for-field as the venue returned it, timestamps as JSON strings included.
  const REJECTED_ROW: RawAlgoOrder = {
    algoId: '1000000150396877',
    clientAlgoId: 'cbt019fb31cb7c97ea0a8dfa5462d3d3764',
    symbol: 'HYPEUSDT',
    side: 'BUY',
    orderType: 'STOP_MARKET',
    quantity: '1.49',
    triggerPrice: '54.57400',
    algoStatus: 'REJECTED',
    reduceOnly: true,
    actualOrderId: '',
    updateTime: '1785427479999',
    triggerTime: '1785427479939',
  };

  it('REJECTED maps to its own terminal member, NOT UNKNOWN (the strand root cause)', () => {
    const view = normalizeAlgoHistory(REJECTED_ROW);
    // Before this mapping existed REJECTED fell through to UNKNOWN, which recoverIntent treats as
    // "the sweep could not tell" and retries forever — nothing could ever retire the order.
    expect(view?.status).toBe('REJECTED');
    expect(view?.algoId).toBe('1000000150396877');
    expect(view?.clientAlgoId).toBe('cbt019fb31cb7c97ea0a8dfa5462d3d3764');
  });

  it('an empty actualOrderId yields NO spawnedOrderId, so the caller may fold terminal-no-fill', () => {
    // '' means absent, never a valid id. This is what lets recoverIntent distinguish "provably no
    // fill" (fold) from "a spawned order may have executed" (fail closed, never fold).
    expect(normalizeAlgoHistory(REJECTED_ROW)?.spawnedOrderId).toBeUndefined();
  });

  it('a REJECTED row that DOES name a spawned order surfaces it (drives the fail-closed path)', () => {
    const view = normalizeAlgoHistory({ ...REJECTED_ROW, actualOrderId: '901234' });
    expect(view?.status).toBe('REJECTED');
    expect(view?.spawnedOrderId).toBe('901234');
  });

  it('an unrecognized algoStatus still collapses to UNKNOWN', () => {
    expect(normalizeAlgoHistory({ ...REJECTED_ROW, algoStatus: 'SOMETHING_NEW' })?.status).toBe(
      'UNKNOWN',
    );
  });
});
