import { customType } from 'drizzle-orm/pg-core';

/**
 * NUMERIC(38,18) ↔ string bridge.
 * toDriver: string passthrough; callers serialize Decimals via toFixed() before passing.
 * fromDriver: returns the raw pg string (repos hand it to domain smart constructors).
 * The Decimal identity stays inside domain; no decimal.js import needed here.
 */
export const numericMoney = customType<{ data: string; driverData: string }>({
  dataType() {
    // lowercase: drizzle-kit emits uppercase dataType strings as quoted identifiers,
    // which Postgres then resolves as a (nonexistent) custom type name
    return 'numeric(38, 18)';
  },
  toDriver(value: string): string {
    return value;
  },
  fromDriver(value: string): string {
    return value;
  },
});
