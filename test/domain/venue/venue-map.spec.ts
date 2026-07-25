import { describe, it, expect } from 'vitest';
import { SPOT_VENUE, PERP_VENUE, venueForSymbol } from '../../../src/domain/venue/types/venue-map';
import { symbolId } from '../../../src/domain/common/types/ids';

describe('venueForSymbol', () => {
  it('resolves a plain BASE/QUOTE spot symbol to the spot venue', () => {
    expect(venueForSymbol(symbolId('BTC/USDT'))).toBe(SPOT_VENUE);
  });

  it('resolves a BASE/QUOTE:SETTLE linear-swap symbol to the perp venue', () => {
    expect(venueForSymbol(symbolId('BTC/USDT:USDT'))).toBe(PERP_VENUE);
  });

  it('rejects an unparseable symbol (delegates to splitSymbol)', () => {
    expect(() => venueForSymbol(symbolId('BTCUSDT'))).toThrow(/unsupported symbol format/);
  });
});
