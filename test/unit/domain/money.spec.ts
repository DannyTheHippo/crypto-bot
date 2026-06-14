import { describe, it, expect, beforeAll } from 'vitest';
import Decimal from 'decimal.js';
import {
  setupDecimal,
  price,
  qty,
  notional,
  feeAmount,
  moneyToString,
  roundToTick,
  roundToStep,
  toIndicatorNumber,
  MoneyError,
} from '../../../src/domain/types/money';

beforeAll(() => {
  setupDecimal();
});

// ── Constructor accept/reject matrix ─────────────────────────────────────────

describe('price()', () => {
  it('accepts a valid positive string', () => {
    expect(() => price('1.5')).not.toThrow();
    expect(moneyToString(price('1.5'))).toBe('1.5');
  });

  it('accepts integer string', () => {
    expect(moneyToString(price('100'))).toBe('100');
  });

  it('accepts large value within precision', () => {
    // 20 integer digits (fits NUMERIC(38,18) integer part)
    expect(() => price('12345678901234567890')).not.toThrow();
  });

  it('rejects empty string', () => {
    const err = (() => {
      try {
        price('');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NAN');
  });

  it('rejects "0" (must be > 0)', () => {
    const err = (() => {
      try {
        price('0');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NON_POSITIVE');
  });

  it('rejects negative value', () => {
    const err = (() => {
      try {
        price('-1');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NON_POSITIVE');
  });

  it('rejects "NaN"', () => {
    const err = (() => {
      try {
        price('NaN');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NAN');
  });

  it('rejects "Infinity"', () => {
    const err = (() => {
      try {
        price('Infinity');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NAN');
  });

  it('rejects "-Infinity"', () => {
    const err = (() => {
      try {
        price('-Infinity');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NAN');
  });

  it('rejects "1e5" (exponent notation)', () => {
    const err = (() => {
      try {
        price('1e5');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NAN');
  });

  it('rejects hex string', () => {
    const err = (() => {
      try {
        price('0xff');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
  });

  it('rejects value with > 18 decimal places', () => {
    const err = (() => {
      try {
        price('1.1234567890123456789');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('PRECISION_OVERFLOW');
  });

  it('accepts exactly 18 decimal places', () => {
    expect(() => price('1.123456789012345678')).not.toThrow();
  });

  it('accepts a 20-significant-integer-digit value (NUMERIC(38,18) max integer part)', () => {
    expect(() => price('9'.repeat(20))).not.toThrow();
  });

  it('rejects a 21-significant-integer-digit value (exceeds NUMERIC(38,18) integer part)', () => {
    const err = (() => {
      try {
        price('9'.repeat(21));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('PRECISION_OVERFLOW');
  });

  it('accepts a Decimal input', () => {
    const d = new Decimal('42.5');
    expect(moneyToString(price(d))).toBe('42.5');
  });
});

describe('qty()', () => {
  it('accepts positive string', () => {
    expect(moneyToString(qty('10'))).toBe('10');
  });

  it('rejects "0"', () => {
    const err = (() => {
      try {
        qty('0');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NON_POSITIVE');
  });

  it('rejects negative', () => {
    const err = (() => {
      try {
        qty('-0.01');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NON_POSITIVE');
  });

  it('rejects "NaN"', () => {
    const err = (() => {
      try {
        qty('NaN');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NAN');
  });

  it('rejects "1e5"', () => {
    const err = (() => {
      try {
        qty('1e5');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
  });

  it('rejects > 18 decimal places', () => {
    const err = (() => {
      try {
        qty('1.0000000000000000001');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('PRECISION_OVERFLOW');
  });
});

describe('notional()', () => {
  it('accepts "0" (≥ 0 allowed)', () => {
    expect(moneyToString(notional('0'))).toBe('0');
  });

  it('accepts positive value', () => {
    expect(moneyToString(notional('500'))).toBe('500');
  });

  it('rejects negative', () => {
    const err = (() => {
      try {
        notional('-1');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NEGATIVE');
  });

  it('rejects "NaN"', () => {
    const err = (() => {
      try {
        notional('NaN');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NAN');
  });

  it('rejects "Infinity"', () => {
    const err = (() => {
      try {
        notional('Infinity');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NAN');
  });
});

describe('feeAmount()', () => {
  it('accepts "0"', () => {
    expect(moneyToString(feeAmount('0'))).toBe('0');
  });

  it('accepts positive', () => {
    expect(moneyToString(feeAmount('0.001'))).toBe('0.001');
  });

  it('rejects negative', () => {
    const err = (() => {
      try {
        feeAmount('-0.001');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe('NEGATIVE');
  });
});

// ── toFixed canonicalization — no exponent output ─────────────────────────────

describe('moneyToString()', () => {
  it('produces fixed notation for very small value', () => {
    const p = price('0.000000000000000001'); // 1e-18
    const s = moneyToString(p);
    expect(s).not.toMatch(/e/i);
    expect(s).toBe('0.000000000000000001');
  });

  it('produces fixed notation for large value', () => {
    const p = price('12345678901234567890');
    const s = moneyToString(p);
    expect(s).not.toMatch(/e/i);
    expect(s).toBe('12345678901234567890');
  });

  it('does not add trailing zeros beyond value precision', () => {
    const p = price('1.5');
    expect(moneyToString(p)).toBe('1.5');
  });

  it('rounds consistently — same value, same string', () => {
    const a = price('1.23');
    const b = price('1.23');
    expect(moneyToString(a)).toBe(moneyToString(b));
  });
});

// ── Directional rounding ──────────────────────────────────────────────────────

describe('roundToTick()', () => {
  it('rounds down correctly: 1.014 with tick 0.01 → 1.01', () => {
    const p = price('1.014');
    const result = roundToTick(p, '0.01', 'down');
    expect(moneyToString(result)).toBe('1.01');
  });

  it('rounds up correctly: 1.014 with tick 0.01 → 1.02', () => {
    const p = price('1.014');
    const result = roundToTick(p, '0.01', 'up');
    expect(moneyToString(result)).toBe('1.02');
  });

  it('exact-on-tick unchanged when rounding down', () => {
    const p = price('1.01');
    const result = roundToTick(p, '0.01', 'down');
    expect(moneyToString(result)).toBe('1.01');
  });

  it('exact-on-tick unchanged when rounding up', () => {
    const p = price('1.01');
    const result = roundToTick(p, '0.01', 'up');
    expect(moneyToString(result)).toBe('1.01');
  });

  it('0.005 tick — rounds down from midpoint', () => {
    const p = price('1.0075');
    const result = roundToTick(p, '0.005', 'down');
    expect(moneyToString(result)).toBe('1.005');
  });

  it('0.005 tick — rounds up from midpoint', () => {
    const p = price('1.0075');
    const result = roundToTick(p, '0.005', 'up');
    expect(moneyToString(result)).toBe('1.01');
  });
});

describe('roundToStep()', () => {
  it('rounds down: 1.014 step 0.01 → 1.01', () => {
    const q = qty('1.014');
    const result = roundToStep(q, '0.01', 'down');
    expect(moneyToString(result)).toBe('1.01');
  });

  it('rounds up: 1.014 step 0.01 → 1.02', () => {
    const q = qty('1.014');
    const result = roundToStep(q, '0.01', 'up');
    expect(moneyToString(result)).toBe('1.02');
  });

  it('exact-on-step unchanged down', () => {
    const q = qty('2.50');
    const result = roundToStep(q, '0.01', 'down');
    // Decimal.toFixed() normalizes trailing zeros: '2.50' → '2.5'
    expect(moneyToString(result)).toBe('2.5');
  });

  it('exact-on-step unchanged up', () => {
    const q = qty('2.50');
    const result = roundToStep(q, '0.01', 'up');
    expect(moneyToString(result)).toBe('2.5');
  });
});

// ── ROUND_HALF_EVEN policy ────────────────────────────────────────────────────

describe('ROUND_HALF_EVEN policy after setupDecimal()', () => {
  it('2.5 rounds to 2 (banker rounding — even)', () => {
    const d = new Decimal('2.5').toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
    expect(d.toFixed()).toBe('2');
  });

  it('3.5 rounds to 4 (banker rounding — even)', () => {
    const d = new Decimal('3.5').toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
    expect(d.toFixed()).toBe('4');
  });
});

// ── toIndicatorNumber ─────────────────────────────────────────────────────────

describe('toIndicatorNumber()', () => {
  it('returns a JS number', () => {
    const p = price('42.5');
    const n = toIndicatorNumber(p);
    expect(typeof n).toBe('number');
    expect(n).toBe(42.5);
  });

  it('indicator number is close to the original value', () => {
    const p = price('1234.56');
    expect(Math.abs(toIndicatorNumber(p) - 1234.56)).toBeLessThan(0.0001);
  });
});
