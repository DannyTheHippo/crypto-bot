import { describe, it, expect } from 'vitest';
import { DEFAULT_FILTERS } from '../../../src/domain/risk/default-filters';

describe('DEFAULT_FILTERS', () => {
  it('carries the demo universe (BTC/USDT, ETH/USDT) with exact filter strings', () => {
    expect(DEFAULT_FILTERS.size).toBe(2);
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
  });
  it('has no entries beyond the demo universe', () => {
    expect(DEFAULT_FILTERS.get('SOL/USDT')).toBeUndefined();
  });
});
