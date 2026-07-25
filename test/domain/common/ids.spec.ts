import { describe, it, expect } from 'vitest';
import {
  intentId,
  clientOrderId,
  encodeClientOrderId,
  decodeClientOrderId,
  isOurClientOrderId,
  epochMs,
  IdError,
} from '../../../src/domain/common/types/ids';
import type { TradingMode } from '../../../src/domain/trading/types/mode';

const VALID_UUIDV7 = '01900000-0000-7000-8000-000000000001';
const VALID_UUIDV7_B = '01900000-0000-7abc-9def-123456789abc';

// ── intentId construction ────────────────────────────────────────────────────

describe('intentId()', () => {
  it('accepts a valid UUIDv7', () => {
    expect(() => intentId(VALID_UUIDV7)).not.toThrow();
  });

  it('normalizes to lowercase', () => {
    const id = intentId(VALID_UUIDV7.toUpperCase());
    expect(id).toBe(VALID_UUIDV7.toLowerCase());
  });

  it('rejects a non-UUIDv7 string', () => {
    expect(() => intentId('not-a-uuid')).toThrow(IdError);
  });

  it('rejects UUIDv4 (version digit 4, not 7)', () => {
    const uuidV4 = '550e8400-e29b-41d4-a716-446655440000';
    expect(() => intentId(uuidV4)).toThrow(IdError);
  });
});

// ── encodeClientOrderId ───────────────────────────────────────────────────────

describe('encodeClientOrderId()', () => {
  const modes: TradingMode[] = ['paper', 'testnet', 'live'];

  it('produces exactly 35 characters', () => {
    const id = intentId(VALID_UUIDV7);
    for (const mode of modes) {
      const cid = encodeClientOrderId(id, mode);
      expect(cid.length).toBe(35);
    }
  });

  it('matches regex ^cb[ptl][0-9a-f]{32}$', () => {
    const id = intentId(VALID_UUIDV7);
    const pattern = /^cb[ptl][0-9a-f]{32}$/;
    for (const mode of modes) {
      expect(encodeClientOrderId(id, mode)).toMatch(pattern);
    }
  });

  it('uses "p" for paper mode', () => {
    const cid = encodeClientOrderId(intentId(VALID_UUIDV7), 'paper');
    expect(cid[2]).toBe('p');
  });

  it('uses "t" for testnet mode', () => {
    const cid = encodeClientOrderId(intentId(VALID_UUIDV7), 'testnet');
    expect(cid[2]).toBe('t');
  });

  it('uses "l" for live mode', () => {
    const cid = encodeClientOrderId(intentId(VALID_UUIDV7), 'live');
    expect(cid[2]).toBe('l');
  });

  it('hex32 is lowercase and dash-free', () => {
    const id = intentId(VALID_UUIDV7_B);
    const cid = encodeClientOrderId(id, 'paper');
    const hex32 = cid.slice(3);
    expect(hex32).toMatch(/^[0-9a-f]{32}$/);
    expect(hex32).not.toContain('-');
  });
});

// ── decodeClientOrderId ───────────────────────────────────────────────────────

describe('decodeClientOrderId()', () => {
  it('round-trips: decode(encode(id, mode)) === {id, mode}', () => {
    const id = intentId(VALID_UUIDV7);
    for (const mode of ['paper', 'testnet', 'live'] as TradingMode[]) {
      const cid = encodeClientOrderId(id, mode);
      const decoded = decodeClientOrderId(cid);
      expect(decoded.intentId).toBe(id);
      expect(decoded.mode).toBe(mode);
    }
  });

  it('re-inserts dashes in UUID format', () => {
    const id = intentId(VALID_UUIDV7);
    const cid = encodeClientOrderId(id, 'paper');
    const decoded = decodeClientOrderId(cid);
    expect(decoded.intentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('throws IdError for foreign id (wrong prefix)', () => {
    expect(() => decodeClientOrderId('cbx' + '0'.repeat(32))).toThrow(IdError);
  });

  it('throws IdError for wrong length (too short)', () => {
    expect(() => decodeClientOrderId('cbp' + '0'.repeat(31))).toThrow(IdError);
  });

  it('throws IdError for wrong length (too long)', () => {
    expect(() => decodeClientOrderId('cbp' + '0'.repeat(33))).toThrow(IdError);
  });

  it('throws IdError for uppercase hex', () => {
    const id = intentId(VALID_UUIDV7);
    const cid = encodeClientOrderId(id, 'paper');
    const upper = cid.toUpperCase();
    expect(() => decodeClientOrderId(upper)).toThrow(IdError);
  });

  it('throws IdError for unknown mode char', () => {
    expect(() => decodeClientOrderId('cbz' + '0'.repeat(32))).toThrow(IdError);
  });
});

// ── isOurClientOrderId ────────────────────────────────────────────────────────

describe('isOurClientOrderId()', () => {
  it('returns true for valid encoded id', () => {
    const cid = encodeClientOrderId(intentId(VALID_UUIDV7), 'paper');
    expect(isOurClientOrderId(cid)).toBe(true);
  });

  it('returns false for wrong prefix', () => {
    expect(isOurClientOrderId('xx' + 'p' + '0'.repeat(32))).toBe(false);
  });

  it('returns false for wrong mode char', () => {
    expect(isOurClientOrderId('cbx' + '0'.repeat(32))).toBe(false);
  });

  it('returns false for wrong length', () => {
    expect(isOurClientOrderId('cbp' + '0'.repeat(31))).toBe(false);
    expect(isOurClientOrderId('cbp' + '0'.repeat(33))).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isOurClientOrderId('')).toBe(false);
  });

  it('returns false for arbitrary string', () => {
    expect(isOurClientOrderId('binance-order-123456')).toBe(false);
  });

  it('rejects hex32 with non-7 version nibble at position 12', () => {
    // Position 12 of hex32 = '4' — UUIDv4, not UUIDv7
    // hex32 layout: [0-11]=019000000000, [12]='4', [13-15]=000, [16]='8', [17-31]=000000000000000
    const v4hex32 = '0190000000004000' + '8' + '000000000000000';
    expect(v4hex32.length).toBe(32);
    expect(isOurClientOrderId('cbp' + v4hex32)).toBe(false);
  });

  it('rejects hex32 with invalid variant nibble at position 16', () => {
    // Position 16 of hex32 = '0' — not in [89ab]
    // hex32 layout: [0-11]=019000000000, [12]='7', [13-15]=000, [16]='0', [17-31]=000000000000000
    const badVariant = '0190000000007000' + '0' + '000000000000000';
    expect(badVariant.length).toBe(32);
    expect(isOurClientOrderId('cbp' + badVariant)).toBe(false);
  });

  it('accepts valid UUIDv7 encodings with each allowed variant nibble', () => {
    for (const variantNibble of ['8', '9', 'a', 'b']) {
      // hex32: [0-11]=019000000000, [12]='7', [13-15]=000, [16]=variantNibble, [17-31]=000000000000000
      const hex32 = '0190000000007000' + variantNibble + '000000000000000';
      expect(hex32.length).toBe(32);
      expect(isOurClientOrderId('cbp' + hex32)).toBe(true);
    }
  });
});

// ── clientOrderId constructor ─────────────────────────────────────────────────

describe('clientOrderId()', () => {
  it('wraps an arbitrary string as ClientOrderId', () => {
    const cid = clientOrderId('some-external-id');
    expect(cid).toBe('some-external-id');
  });
});

// ── epochMs ───────────────────────────────────────────────────────────────────

describe('epochMs()', () => {
  it('accepts a valid positive integer', () => {
    expect(() => epochMs(1700000000000)).not.toThrow();
    expect(epochMs(1700000000000)).toBe(1700000000000);
  });

  it('accepts zero', () => {
    expect(() => epochMs(0)).not.toThrow();
  });

  it('accepts negative integers (pre-epoch timestamps are valid in principle)', () => {
    expect(() => epochMs(-1000)).not.toThrow();
  });

  it('rejects NaN', () => {
    expect(() => epochMs(NaN)).toThrow(IdError);
  });

  it('rejects positive Infinity', () => {
    expect(() => epochMs(Infinity)).toThrow(IdError);
  });

  it('rejects negative Infinity', () => {
    expect(() => epochMs(-Infinity)).toThrow(IdError);
  });

  it('rejects a non-integer float', () => {
    expect(() => epochMs(1700000000000.5)).toThrow(IdError);
  });
});
