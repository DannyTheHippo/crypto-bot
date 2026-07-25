import { describe, it, expect } from 'vitest';
import { numericMoney } from '../../../../src/database/schemas/trading/custom-types';

/**
 * numericMoney is a drizzle customType builder.  Calling it with a column name returns
 * a column object whose config.customTypeParams holds the dataType / toDriver / fromDriver
 * callbacks defined in custom-types.ts.  We verify those callbacks directly.
 */
interface CustomTypeParams {
  dataType: () => string;
  toDriver?: (v: string) => string;
  fromDriver?: (v: string) => string;
}

// Build a temporary column instance to access the registered callbacks.
const col = (
  numericMoney as unknown as (name: string) => { config: { customTypeParams: CustomTypeParams } }
)('_test');
const params = col.config.customTypeParams;

const toDriver = (v: string) => (params.toDriver ? params.toDriver(v) : v);
const fromDriver = (v: string) => (params.fromDriver ? params.fromDriver(v) : v);

describe('numericMoney customType — SQL type', () => {
  it('dataType() returns lowercase numeric(38, 18)', () => {
    // lowercase is load-bearing: drizzle-kit emits uppercase dataType strings as
    // quoted identifiers, which Postgres rejects as an unknown custom type
    expect(params.dataType()).toBe('numeric(38, 18)');
  });
});

describe('numericMoney customType — toDriver passthrough', () => {
  const cases = [
    '0.000000000000000001',
    '99999999999999999999.999999999999999999',
    '0.1',
    '123.456000000000000000',
  ];

  for (const v of cases) {
    it(`passes '${v}' to driver unchanged`, () => {
      expect(toDriver(v)).toBe(v);
    });
  }

  it('does not coerce to float: 0.100000000000000001 stays exact', () => {
    const adversarial = '0.100000000000000001';
    expect(toDriver(adversarial)).toBe(adversarial);
    expect(typeof toDriver(adversarial)).toBe('string');
  });
});

describe('numericMoney customType — fromDriver passthrough', () => {
  const cases = [
    '0.000000000000000001',
    '123.456000000000000000',
    '99999999999999999999.999999999999999999',
  ];

  for (const v of cases) {
    it(`returns '${v}' from driver unchanged`, () => {
      expect(fromDriver(v)).toBe(v);
      expect(typeof fromDriver(v)).toBe('string');
    });
  }
});
