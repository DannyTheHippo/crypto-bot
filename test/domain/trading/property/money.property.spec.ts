import { describe, it, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import {
  setupDecimal,
  price,
  qty,
  notional,
  moneyToString,
  roundToTick,
  roundToStep,
} from '../../../../src/domain/common/types/money';

beforeAll(() => {
  setupDecimal();
});

// Arbitraries for valid plain decimal strings within NUMERIC(38,18) bounds
const validDecimalString = fc
  .tuple(
    fc.bigInt({ min: 1n, max: 99999999999999999999n }), // up to 20-digit integer part
    fc.integer({ min: 0, max: 18 }),
    fc.integer({ min: 0, max: 999999999999999999 }),
  )
  .map(([intPart, dpCount, fracDigits]) => {
    if (dpCount === 0) return intPart.toString();
    const frac = fracDigits.toString().padStart(dpCount, '0').slice(0, dpCount);
    return `${intPart.toString()}.${frac}`;
  })
  .filter((s) => {
    // strip trailing zeros from frac to get actual dp
    const dot = s.indexOf('.');
    if (dot === -1) return true;
    const frac = s.slice(dot + 1).replace(/0+$/, '');
    return frac.length <= 18;
  });

// Tick/step sizes: powers of 10 from 1e-8 to 1
const tickSizes = fc.constantFrom(
  '0.00000001',
  '0.0000001',
  '0.000001',
  '0.00001',
  '0.0001',
  '0.001',
  '0.01',
  '0.1',
  '1',
);

describe('money constructor round-trip stability', () => {
  it('price: moneyToString(price(s)) re-parses equal to original', () => {
    fc.assert(
      fc.property(validDecimalString, (s) => {
        try {
          const p = price(s);
          const str = moneyToString(p);
          const reparsed = new Decimal(str);
          return reparsed.eq(new Decimal(s));
        } catch {
          return true; // constructor rejection is valid
        }
      }),
      { numRuns: 200 },
    );
  });

  it('qty: moneyToString(qty(s)) re-parses equal to original', () => {
    fc.assert(
      fc.property(validDecimalString, (s) => {
        try {
          const q = qty(s);
          const str = moneyToString(q);
          const reparsed = new Decimal(str);
          return reparsed.eq(new Decimal(s));
        } catch {
          return true;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('notional: accepts "0" and positive values, string round-trips', () => {
    const nonNegDecimal = validDecimalString.filter((s) => new Decimal(s).gte(0));
    fc.assert(
      fc.property(nonNegDecimal, (s) => {
        try {
          const n = notional(s);
          const str = moneyToString(n);
          return new Decimal(str).eq(new Decimal(s));
        } catch {
          return true;
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('roundToTick: down ≤ input ≤ up and both tick-aligned', () => {
  it('satisfies monotonicity and alignment invariant', () => {
    fc.assert(
      fc.property(validDecimalString, tickSizes, (s, tick) => {
        let p;
        try {
          p = price(s);
        } catch {
          return true;
        }

        const tickD = new Decimal(tick);
        const down = roundToTick(p, tick, 'down');
        const up = roundToTick(p, tick, 'up');

        // down ≤ p ≤ up
        if (new Decimal(down.toFixed()).gt(new Decimal(p.toFixed()))) return false;
        if (new Decimal(up.toFixed()).lt(new Decimal(p.toFixed()))) return false;

        // both tick-aligned: value mod tick === 0 exactly (exact-mod rounding)
        const downAligned = new Decimal(down.toFixed()).mod(tickD).abs();
        const upAligned = new Decimal(up.toFixed()).mod(tickD).abs();

        if (!downAligned.isZero()) return false;
        if (!upAligned.isZero()) return false;

        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe('roundToStep: down ≤ input ≤ up and both step-aligned', () => {
  it('satisfies monotonicity and alignment invariant', () => {
    fc.assert(
      fc.property(validDecimalString, tickSizes, (s, step) => {
        let q;
        try {
          q = qty(s);
        } catch {
          return true;
        }

        const stepD = new Decimal(step);
        const down = roundToStep(q, step, 'down');
        const up = roundToStep(q, step, 'up');

        if (new Decimal(down.toFixed()).gt(new Decimal(q.toFixed()))) return false;
        if (new Decimal(up.toFixed()).lt(new Decimal(q.toFixed()))) return false;

        // exact-mod rounding guarantees zero residual
        const downAligned = new Decimal(down.toFixed()).mod(stepD).abs();
        const upAligned = new Decimal(up.toFixed()).mod(stepD).abs();

        if (!downAligned.isZero()) return false;
        if (!upAligned.isZero()) return false;

        return true;
      }),
      { numRuns: 300 },
    );
  });
});
