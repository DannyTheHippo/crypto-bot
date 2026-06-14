import Decimal from 'decimal.js';

export function setupDecimal(): void {
  Decimal.set({
    precision: 40,
    rounding: Decimal.ROUND_HALF_EVEN,
    toExpNeg: -19,
    toExpPos: 39,
  });
}

// ── Error ────────────────────────────────────────────────────────────────────

export type MoneyErrorCode =
  | 'NAN'
  | 'INFINITE'
  | 'NON_POSITIVE'
  | 'NEGATIVE'
  | 'PRECISION_OVERFLOW';

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  constructor(code: MoneyErrorCode, detail: string) {
    super(`MoneyError[${code}]: ${detail}`);
    this.name = 'MoneyError';
    this.code = code;
  }
}

// ── Branded types ────────────────────────────────────────────────────────────

declare const _price: unique symbol;
declare const _qty: unique symbol;
declare const _notional: unique symbol;
declare const _feeAmount: unique symbol;

export type Price = Decimal & { readonly [_price]: true };
export type Qty = Decimal & { readonly [_qty]: true };
export type Notional = Decimal & { readonly [_notional]: true };
export type FeeAmount = Decimal & { readonly [_feeAmount]: true };

// ── Precision validation ─────────────────────────────────────────────────────

// DB constraint: NUMERIC(38,18) — max 20 integer digits + 18 fractional.
// We validate: integer part ≤ 20 significant digits and fractional part ≤ 18 places.
const MAX_DECIMAL_PLACES = 18;
const MAX_INTEGER_SIG_DIGITS = 20;

function checkPrecision(d: Decimal): void {
  const fixed = d.abs().toFixed(MAX_DECIMAL_PLACES + 1);
  const dotIdx = fixed.indexOf('.');
  const intPart = dotIdx === -1 ? fixed : fixed.slice(0, dotIdx);

  // Count significant integer digits (strip leading zeros)
  const sigInt = intPart.replace(/^0+/, '').length;
  if (sigInt > MAX_INTEGER_SIG_DIGITS) {
    throw new MoneyError(
      'PRECISION_OVERFLOW',
      `integer part has ${sigInt} significant digits (max ${MAX_INTEGER_SIG_DIGITS})`,
    );
  }

  // Count actual decimal places the value has
  const dStr = d.toFixed();
  const dDot = dStr.indexOf('.');
  const actualFrac = dDot === -1 ? 0 : dStr.length - dDot - 1;
  // Remove trailing zeros to get actual significant decimal places
  const trimmedFrac = dDot === -1 ? '' : dStr.slice(dDot + 1).replace(/0+$/, '');

  if (trimmedFrac.length > MAX_DECIMAL_PLACES) {
    throw new MoneyError(
      'PRECISION_OVERFLOW',
      `value has ${actualFrac} decimal places (max ${MAX_DECIMAL_PLACES})`,
    );
  }
}

// ── Input parsing ────────────────────────────────────────────────────────────

// Accepts only plain decimal strings (no exponent notation, no hex, non-empty).
// Infinity and NaN are caught here before reaching the Decimal constructor.
const PLAIN_DECIMAL_RE = /^-?[0-9]+(\.[0-9]+)?$/;

function decimalFromString(s: string): Decimal {
  if (s === '') {
    throw new MoneyError('NAN', 'empty string is not a valid money value');
  }
  if (!PLAIN_DECIMAL_RE.test(s)) {
    throw new MoneyError('NAN', `"${s}" is not a plain decimal string (exponent/hex not allowed)`);
  }
  return new Decimal(s);
}

function toDecimal(s: string | Decimal): Decimal {
  if (s instanceof Decimal) return s;
  return decimalFromString(s);
}

// ── Smart constructors ───────────────────────────────────────────────────────

export function price(s: string | Decimal): Price {
  const d = toDecimal(typeof s === 'string' ? s : s.toFixed());
  if (d.lte(0)) throw new MoneyError('NON_POSITIVE', `price must be > 0, got ${d.toFixed()}`);
  checkPrecision(d);
  return d as Price;
}

export function qty(s: string | Decimal): Qty {
  const d = toDecimal(typeof s === 'string' ? s : s.toFixed());
  if (d.lte(0)) throw new MoneyError('NON_POSITIVE', `qty must be > 0, got ${d.toFixed()}`);
  checkPrecision(d);
  return d as Qty;
}

export function notional(s: string | Decimal): Notional {
  const d = toDecimal(typeof s === 'string' ? s : s.toFixed());
  if (d.lt(0)) throw new MoneyError('NEGATIVE', `notional must be ≥ 0, got ${d.toFixed()}`);
  checkPrecision(d);
  return d as Notional;
}

export function feeAmount(s: string | Decimal): FeeAmount {
  const d = toDecimal(typeof s === 'string' ? s : s.toFixed());
  if (d.lt(0)) throw new MoneyError('NEGATIVE', `feeAmount must be ≥ 0, got ${d.toFixed()}`);
  checkPrecision(d);
  return d as FeeAmount;
}

// ── Serialization ────────────────────────────────────────────────────────────

export function moneyToString(v: Price | Qty | Notional | FeeAmount): string {
  return v.toFixed();
}

// ── Rounding helpers ─────────────────────────────────────────────────────────

// Exact-mod rounding: avoids implicit precision-bound rounding from div/mul.
// down = v - (v mod t);  up = isZero(v mod t) ? v : down + t.

export function roundToTick(p: Price, tick: string, direction: 'down' | 'up'): Price {
  const t = new Decimal(tick);
  const mod = p.mod(t);
  const down = p.sub(mod);
  const rounded = direction === 'down' ? down : mod.isZero() ? p : down.add(t);
  return rounded as Price;
}

// Accepts a raw Decimal (not only a Qty): a quantity derived by division (baseNotional/price) can
// exceed the 18-place precision limit, so it must be rounded to the step BEFORE it can be a valid
// Qty — validating first would throw. The rounded result is a clean multiple of the step (≤ the
// step's decimal places), hence precision-valid by construction; the brand cast is sound.
export function roundToStep(q: Decimal, step: string, direction: 'down' | 'up'): Qty {
  const s = new Decimal(step);
  const mod = q.mod(s);
  const down = q.sub(mod);
  const rounded = direction === 'down' ? down : mod.isZero() ? q : down.add(s);
  return rounded as Qty;
}

// ── Indicator escape hatch ───────────────────────────────────────────────────

export function toIndicatorNumber(v: Price | Qty | Notional | FeeAmount): number {
  return Number(v.toFixed());
}
