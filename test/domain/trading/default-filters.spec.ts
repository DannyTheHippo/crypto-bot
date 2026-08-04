import { describe, it, expect } from 'vitest';
import { DEFAULT_FILTERS } from '../../../src/domain/trading/risk/default-filters';

describe('DEFAULT_FILTERS', () => {
  it('carries the demo universe (24 spot /USDT symbols) with exact filter strings', () => {
    // 24 spot rows (8→24 expansion, U1: BNB DOGE ADA AVAX DOT LTC SUI PEPE WIF TRX SHIB UNI APT ARB
    // OP FIL added to the original 8 — live-probe-verified 2026-07-18 against
    // api.binance.com/api/v3/exchangeInfo) + 16 futures-demo perp rows (X2 stage-1 basket
    // probe-verified 2026-07-20 + v3 §5.4 stage-2 ranks 9-16 probe-verified 2026-07-21, both
    // against demo-fapi.binance.com exchangeInfo; provenance notes in default-filters.ts).
    expect(DEFAULT_FILTERS.size).toBe(40);
    for (const perp of [
      'BTC/USDT:USDT',
      'ETH/USDT:USDT',
      'SOL/USDT:USDT',
      'ZEC/USDT:USDT',
      'AAVE/USDT:USDT',
      'NEAR/USDT:USDT',
      'HYPE/USDT:USDT',
      'KAITO/USDT:USDT',
      'TRUMP/USDT:USDT',
      'UNI/USDT:USDT',
      'BCH/USDT:USDT',
      'XRP/USDT:USDT',
      'LINK/USDT:USDT',
      'AVAX/USDT:USDT',
      'SUI/USDT:USDT',
      'LTC/USDT:USDT',
    ]) {
      expect(DEFAULT_FILTERS.has(perp)).toBe(true);
    }
    // X2 (2026-07-20): the demo venue's BTC perp step is 0.0001 — finer than the 2026-07-13
    // prod-fetched 0.001; on a $1k book the 0.001 step is a ~$110 sizing quantum, so the
    // demo-probed value is both the true venue figure and materially better for fraction sizing.
    expect(DEFAULT_FILTERS.get('BTC/USDT:USDT')).toEqual({
      tickSize: '0.10',
      stepSize: '0.0001',
      minQty: '0.0001',
      minNotional: '50',
    });
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
    // FIL/USDT was the one row the 2026-07-18 probe pass missed (transcription error, tickSize
    // 10x too coarse) — corrected 2026-08-04 per the boot-time filters-drift-check guard's own
    // live reading (research/loop/STATUS.md:82, LOG.md:866).
    expect(DEFAULT_FILTERS.get('FIL/USDT')).toEqual({
      tickSize: '0.0001',
      stepSize: '0.01',
      minQty: '0.01',
      minNotional: '5',
    });
  });
  it('has no entries beyond the demo universe', () => {
    expect(DEFAULT_FILTERS.get('MATIC/USDT')).toBeUndefined();
    expect(DEFAULT_FILTERS.get('ATOM/USDT')).toBeUndefined();
  });
});
