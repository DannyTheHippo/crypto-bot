import { describe, it, expect } from 'vitest';
import { DEFAULT_FILTERS } from '../../../src/domain/risk/default-filters';

describe('DEFAULT_FILTERS', () => {
  it('carries the demo universe (BTC, ETH, SOL, XRP, LINK /USDT) with exact filter strings', () => {
    // 5 spot rows + 2 futures-demo perp rows (BTC/ETH :USDT — Push II Phase 8; REVERIFY note in
    // default-filters.ts applies to the perp figures).
    expect(DEFAULT_FILTERS.size).toBe(7);
    expect(DEFAULT_FILTERS.has('BTC/USDT:USDT')).toBe(true);
    expect(DEFAULT_FILTERS.has('ETH/USDT:USDT')).toBe(true);
    expect(DEFAULT_FILTERS.get('BTC/USDT')).toEqual({
      tickSize: '0.01',
      stepSize: '0.00001',
      minQty: '0.00001',
      minNotional: '5',
    });
    expect(DEFAULT_FILTERS.get('ETH/USDT')).toEqual({
      tickSize: '0.01',
      stepSize: '0.0001',
      minQty: '0.0001',
      minNotional: '5',
    });
    // Symbol expansion, owner decision 2026-07-10 — values from live Binance spot exchangeInfo
    // fetched the same day (provenance note in default-filters.ts).
    expect(DEFAULT_FILTERS.get('SOL/USDT')).toEqual({
      tickSize: '0.01',
      stepSize: '0.001',
      minQty: '0.001',
      minNotional: '5',
    });
    expect(DEFAULT_FILTERS.get('XRP/USDT')).toEqual({
      tickSize: '0.0001',
      stepSize: '0.1',
      minQty: '0.1',
      minNotional: '5',
    });
    expect(DEFAULT_FILTERS.get('LINK/USDT')).toEqual({
      tickSize: '0.001',
      stepSize: '0.01',
      minQty: '0.01',
      minNotional: '5',
    });
  });
  it('has no entries beyond the demo universe', () => {
    expect(DEFAULT_FILTERS.get('DOGE/USDT')).toBeUndefined();
    expect(DEFAULT_FILTERS.get('AVAX/USDT')).toBeUndefined();
  });
});
