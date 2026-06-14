import type { TradingMode } from './mode';

// ── Branded primitives ───────────────────────────────────────────────────────

declare const _strategyId: unique symbol;
declare const _venueId: unique symbol;
declare const _symbolId: unique symbol;
declare const _intentId: unique symbol;
declare const _clientOrderId: unique symbol;
declare const _signalId: unique symbol;
declare const _epochMs: unique symbol;

export type StrategyId = string & { readonly [_strategyId]: true };
export type VenueId = string & { readonly [_venueId]: true };
export type SymbolId = string & { readonly [_symbolId]: true };
export type IntentId = string & { readonly [_intentId]: true };
export type ClientOrderId = string & { readonly [_clientOrderId]: true };
export type SignalId = string & { readonly [_signalId]: true };

export type EpochMs = number & { readonly [_epochMs]: true };

// ── UUIDv7 validation ────────────────────────────────────────────────────────

// UUIDv7: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdError';
  }
}

function assertUuidV7(s: string, label: string): void {
  if (!UUIDV7_RE.test(s)) {
    throw new IdError(`${label} must be a UUIDv7, got: "${s}"`);
  }
}

// ── Smart constructors ───────────────────────────────────────────────────────

export function strategyId(s: string): StrategyId {
  return s as StrategyId;
}

export function venueId(s: string): VenueId {
  return s as VenueId;
}

export function symbolId(s: string): SymbolId {
  return s as SymbolId;
}

export function intentId(s: string): IntentId {
  assertUuidV7(s, 'IntentId');
  return s.toLowerCase() as IntentId;
}

export function clientOrderId(s: string): ClientOrderId {
  return s as ClientOrderId;
}

export function signalId(s: string): SignalId {
  assertUuidV7(s, 'SignalId');
  return s.toLowerCase() as SignalId;
}

export function epochMs(n: number): EpochMs {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new IdError(`EpochMs must be a finite integer, got: ${n}`);
  }
  return n as EpochMs;
}

// ── ClientOrderId codec ──────────────────────────────────────────────────────

const MODE_CHAR: Record<TradingMode, string> = {
  paper: 'p',
  testnet: 't',
  live: 'l',
};

const CHAR_TO_MODE: Record<string, TradingMode> = {
  p: 'paper',
  t: 'testnet',
  l: 'live',
};

// clientOrderId = 'cb' + modeChar + hex32 (intentId with dashes stripped)
// Total: 2 + 1 + 32 = 35 chars, charset [a-z0-9].
// Nibble constraints enforce UUIDv7 structure in the encoded form:
//   position 12 of hex32 = version nibble, must be '7'
//   position 16 of hex32 = variant nibble, must be [89ab]
const CLIENT_ORDER_ID_RE = /^cb[ptl][0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;

export function encodeClientOrderId(id: IntentId, mode: TradingMode): ClientOrderId {
  const hex32 = id.replace(/-/g, '').toLowerCase();
  const modeChar = MODE_CHAR[mode];
  return `cb${modeChar}${hex32}` as ClientOrderId;
}

export interface DecodedClientOrderId {
  intentId: IntentId;
  mode: TradingMode;
}

function insertDashes(hex32: string): string {
  // UUIDv7 format: 8-4-4-4-12
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

export function decodeClientOrderId(c: string): DecodedClientOrderId {
  if (!isOurClientOrderId(c)) {
    throw new IdError(`"${c}" is not a valid clientOrderId (expected ^cb[ptl][0-9a-f]{32}$)`);
  }
  const modeChar = c[2] as string;
  const hex32 = c.slice(3);
  const mode = CHAR_TO_MODE[modeChar] as TradingMode;
  return {
    intentId: insertDashes(hex32) as IntentId,
    mode,
  };
}

export function isOurClientOrderId(s: string): boolean {
  return CLIENT_ORDER_ID_RE.test(s);
}
