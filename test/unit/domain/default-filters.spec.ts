import { describe, it, expect } from 'vitest';
import { DEFAULT_FILTERS } from '../../../src/domain/risk/default-filters';

describe('DEFAULT_FILTERS', () => {
  it('carries the demo universe (24 spot /USDT symbols) with exact filter strings', () => {
    // 24 spot rows (8→24 expansion, U1: BNB DOGE ADA AVAX DOT LTC SUI PEPE WIF TRX SHIB UNI APT ARB
    // OP FIL added to the original 8 — live-probe-verified 2026-07-18 against
    // api.binance.com/api/v3/exchangeInfo) + 2 futures-demo perp rows (BTC/ETH :USDT — Push II
    // Phase 8; REVERIFY note in default-filters.ts applies to the perp figures).
    expect(DEFAULT_FILTERS.size).toBe(26);
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
    // 5→8 expansion rows — values probe-verified against the live demo venue 2026-07-17
    // (demo-api.binance.com loadMarkets; match prod exchangeInfo per universe-study-2026-07-13).
    expect(DEFAULT_FILTERS.get('ZEC/USDT')).toEqual({
      tickSize: '0.01',
      stepSize: '0.001',
      minQty: '0.001',
      minNotional: '5',
    });
    expect(DEFAULT_FILTERS.get('AAVE/USDT')).toEqual({
      tickSize: '0.01',
      stepSize: '0.001',
      minQty: '0.001',
      minNotional: '5',
    });
    expect(DEFAULT_FILTERS.get('NEAR/USDT')).toEqual({
      tickSize: '0.001',
      stepSize: '0.1',
      minQty: '0.1',
      minNotional: '5',
    });
    // U1 8→24 expansion rows — live-probe-verified 2026-07-18 against
    // api.binance.com/api/v3/exchangeInfo (spot-check a few of the corrected-on-probe values).
    expect(DEFAULT_FILTERS.get('AVAX/USDT')).toEqual({
      tickSize: '0.001',
      stepSize: '0.01',
      minQty: '0.01',
      minNotional: '5',
    });
    expect(DEFAULT_FILTERS.get('PEPE/USDT')).toEqual({
      tickSize: '0.00000001',
      stepSize: '1',
      minQty: '1',
      minNotional: '1',
    });
    expect(DEFAULT_FILTERS.get('DOGE/USDT')).toEqual({
      tickSize: '0.00001',
      stepSize: '1',
      minQty: '1',
      minNotional: '1',
    });
  });
  it('has no entries beyond the demo universe', () => {
    expect(DEFAULT_FILTERS.get('MATIC/USDT')).toBeUndefined();
    expect(DEFAULT_FILTERS.get('ATOM/USDT')).toBeUndefined();
  });
});
