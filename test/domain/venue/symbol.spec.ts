import { describe, it, expect } from 'vitest';
import { splitSymbol } from '../../../src/domain/venue/types/symbol';
import { symbolId } from '../../../src/domain/common/types/ids';

describe('splitSymbol', () => {
  it('splits a unified BASE/QUOTE symbol', () => {
    expect(splitSymbol(symbolId('BTC/USDT'))).toEqual({ base: 'BTC', quote: 'USDT' });
  });

  it('rejects a symbol without exactly one separator', () => {
    expect(() => splitSymbol(symbolId('BTCUSDT'))).toThrow(/unsupported symbol format/);
    expect(() => splitSymbol(symbolId('A/B/C'))).toThrow(/unsupported symbol format/);
  });

  it('rejects an empty base or quote', () => {
    expect(() => splitSymbol(symbolId('/USDT'))).toThrow(/unsupported symbol format/);
    expect(() => splitSymbol(symbolId('BTC/'))).toThrow(/unsupported symbol format/);
  });

  it('splits a linear-swap BASE/QUOTE:SETTLE symbol, stripping the settle suffix from quote', () => {
    expect(splitSymbol(symbolId('BTC/USDT:USDT'))).toEqual({
      base: 'BTC',
      quote: 'USDT',
      settle: 'USDT',
    });
  });

  it('rejects a colon form with an empty settle asset', () => {
    expect(() => splitSymbol(symbolId('BTC/USDT:'))).toThrow(/unsupported symbol format/);
  });

  it('rejects a colon form with an empty quote asset', () => {
    expect(() => splitSymbol(symbolId('BTC/:USDT'))).toThrow(/unsupported symbol format/);
  });
});
