import { describe, it, expect } from 'vitest';
import { LiveExchangeAdapter } from '../../../src/features/trading/exchange/live-exchange.adapter';
import type { ExchangePort } from '../../../src/ports/exchange';

// The live adapter is a Phase-7 placeholder; its ONE asserted Phase-8 behaviour is the constructor
// backstop: under NODE_ENV=test/ci or CI it must throw outright, so no live client can ever exist in
// a CI process even if the capability token leaked. Vitest runs with NODE_ENV=test, so the guard
// fires here — which is exactly the property the live-gate matrix relies on.
describe('LiveExchangeAdapter', () => {
  it('throws on construction under NODE_ENV=test (CI-cannot-reach-live backstop)', () => {
    // The NODE_ENV guard fires before the inner adapter is touched, so a stub inner is fine here.
    expect(() => new LiveExchangeAdapter(Symbol('cap'), {} as unknown as ExchangePort)).toThrow(
      /never be constructed/,
    );
  });
});
