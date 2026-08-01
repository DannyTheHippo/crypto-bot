import { describe, it, expect } from 'vitest';
import {
  distinctBaseAssetRepresentatives,
  splitSymbol,
} from '../../../src/domain/venue/types/symbol';
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

describe('distinctBaseAssetRepresentatives', () => {
  it('a dual-listed asset (spot + perp) collapses to ONE representative, spot preferred by config order', () => {
    // The exact shape TRADING_SYMBOLS carries: spot entries first, perp duplicates later. Holding
    // BTC twice in the basket is the failure mode this function exists to prevent.
    const symbols = ['BTC/USDT', 'ETH/USDT', 'BTC/USDT:USDT', 'ETH/USDT:USDT'];
    expect(distinctBaseAssetRepresentatives(symbols)).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('a perp-only asset (no spot listing) still surfaces via its own representative', () => {
    const symbols = ['BTC/USDT', 'HYPE/USDT:USDT'];
    expect(distinctBaseAssetRepresentatives(symbols)).toEqual(['BTC/USDT', 'HYPE/USDT:USDT']);
  });

  it('no duplicates ⇒ every symbol passes through unchanged, in order', () => {
    const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    expect(distinctBaseAssetRepresentatives(symbols)).toEqual(symbols);
  });

  it('an empty universe yields an empty basket', () => {
    expect(distinctBaseAssetRepresentatives([])).toEqual([]);
  });
});
