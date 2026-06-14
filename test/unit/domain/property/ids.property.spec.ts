import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import {
  intentId,
  encodeClientOrderId,
  decodeClientOrderId,
} from '../../../../src/domain/types/ids';
import type { TradingMode } from '../../../../src/domain/types/mode';

// UUIDv7: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
// stringMatching generates strings that match the regex
const uuidV7Arb = fc
  .tuple(
    fc.stringMatching(/^[0-9a-f]{8}$/),
    fc.stringMatching(/^[0-9a-f]{4}$/),
    fc.stringMatching(/^[0-9a-f]{3}$/),
    fc.constantFrom('8', '9', 'a', 'b'),
    fc.stringMatching(/^[0-9a-f]{3}$/),
    fc.stringMatching(/^[0-9a-f]{12}$/),
  )
  .map(([a, b, c, variant, d, e]) => `${a}-${b}-7${c}-${variant}${d}-${e}`);

const modeArb: fc.Arbitrary<TradingMode> = fc.constantFrom('paper', 'testnet', 'live');

describe('clientOrderId codec bijectivity', () => {
  it('decode(encode(intentId, mode)) === {intentId, mode} for all valid UUIDv7 × modes', () => {
    fc.assert(
      fc.property(uuidV7Arb, modeArb, (uuidStr, mode) => {
        const id = intentId(uuidStr);
        const cid = encodeClientOrderId(id, mode);
        const decoded = decodeClientOrderId(cid);
        return decoded.intentId === id && decoded.mode === mode;
      }),
      { numRuns: 500 },
    );
  });

  it('encoded id is always 35 chars matching ^cb[ptl][0-9a-f]{32}$', () => {
    fc.assert(
      fc.property(uuidV7Arb, modeArb, (uuidStr, mode) => {
        const id = intentId(uuidStr);
        const cid = encodeClientOrderId(id, mode);
        return cid.length === 35 && /^cb[ptl][0-9a-f]{32}$/.test(cid);
      }),
      { numRuns: 500 },
    );
  });
});
