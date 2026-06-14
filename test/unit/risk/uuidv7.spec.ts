import { describe, it, expect } from 'vitest';
import { uuidv7 } from '../../../src/modules/risk/uuidv7';
import { intentId } from '../../../src/domain/types/ids';

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('produces a string that passes the domain UUIDv7 validator', () => {
    const id = uuidv7(0x0190abcd1234, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(id).toMatch(UUIDV7_RE);
    expect(() => intentId(id)).not.toThrow(); // accepted by the branded smart constructor
  });

  it('is deterministic for the same inputs', () => {
    const r = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(uuidv7(123456, r)).toBe(uuidv7(123456, r));
  });

  it('maps rand[0] % 4 onto the full variant set [89ab]', () => {
    const variants: Record<number, string> = { 0: '8', 1: '9', 2: 'a', 3: 'b' };
    for (const [b, v] of Object.entries(variants)) {
      const r = new Uint8Array([Number(b), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(uuidv7(1, r)[19]).toBe(v); // variant nibble position
    }
  });

  it('throws with fewer than 10 random bytes', () => {
    expect(() => uuidv7(1, new Uint8Array(9))).toThrow(/10 random bytes/);
  });
});
