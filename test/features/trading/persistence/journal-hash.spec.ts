import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  computeAuditHash,
  canonicalPayload,
  AUDIT_INITIAL_PREV_HASH,
} from '../../../src/database/journal-hash';

describe('computeAuditHash', () => {
  it('returns a 64-char hex string', () => {
    const h = computeAuditHash({ event: 'boot' }, AUDIT_INITIAL_PREV_HASH);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    const payload = { actor: 'system', category: 'mode', data: 42 };
    const prev = 'a'.repeat(64);
    expect(computeAuditHash(payload, prev)).toBe(computeAuditHash(payload, prev));
  });

  it('changes when payload changes', () => {
    const prev = AUDIT_INITIAL_PREV_HASH;
    const h1 = computeAuditHash({ x: 1 }, prev);
    const h2 = computeAuditHash({ x: 2 }, prev);
    expect(h1).not.toBe(h2);
  });

  it('changes when prevHash changes', () => {
    const payload = { x: 1 };
    const h1 = computeAuditHash(payload, AUDIT_INITIAL_PREV_HASH);
    const h2 = computeAuditHash(payload, 'b'.repeat(64));
    expect(h1).not.toBe(h2);
  });

  it('matches independently computed sha256(canonicalPayload + prevHash)', () => {
    const payload = { actor: 'test', category: 'unit', value: 'hello' };
    const prev = '1'.repeat(64);
    const expected = crypto
      .createHash('sha256')
      .update(canonicalPayload(payload) + prev)
      .digest('hex');
    expect(computeAuditHash(payload, prev)).toBe(expected);
  });

  it('is key-order invariant: {z,a} and {a,z} produce identical hash', () => {
    const prev = AUDIT_INITIAL_PREV_HASH;
    const h1 = computeAuditHash({ z: 1, a: 2 }, prev);
    const h2 = computeAuditHash({ a: 2, z: 1 }, prev);
    expect(h1).toBe(h2);
  });

  it('AUDIT_INITIAL_PREV_HASH is 64 zeros', () => {
    expect(AUDIT_INITIAL_PREV_HASH).toBe('0'.repeat(64));
  });

  it('three-entry chain: each hash chains from the previous', () => {
    const entries = [
      { actor: 'a', category: 'c', payload: { n: 1 } },
      { actor: 'b', category: 'c', payload: { n: 2 } },
      { actor: 'c', category: 'c', payload: { n: 3 } },
    ];
    let prev = AUDIT_INITIAL_PREV_HASH;
    const hashes: string[] = [];
    for (const e of entries) {
      const h = computeAuditHash(e.payload, prev);
      hashes.push(h);
      prev = h;
    }
    // Re-derive and assert equality
    let rePrev = AUDIT_INITIAL_PREV_HASH;
    for (let i = 0; i < entries.length; i++) {
      const reH = computeAuditHash(entries[i]!.payload, rePrev);
      expect(reH).toBe(hashes[i]);
      rePrev = reH;
    }
  });

  it('chain breaks if payload of first entry is tampered', () => {
    const p1 = { n: 1 };
    const p2 = { n: 2 };
    const h1 = computeAuditHash(p1, AUDIT_INITIAL_PREV_HASH);
    const h2 = computeAuditHash(p2, h1);

    // Tamper: recompute h2 using corrupted p1 hash
    const tamperedH1 = computeAuditHash({ n: 999 }, AUDIT_INITIAL_PREV_HASH);
    const tamperedH2 = computeAuditHash(p2, tamperedH1);
    expect(tamperedH2).not.toBe(h2);
  });
});

describe('canonicalPayload', () => {
  it('serialises to JSON string', () => {
    expect(canonicalPayload({ a: 1 })).toBe('{"a":1}');
  });

  it('null payload serialises to "null"', () => {
    expect(canonicalPayload(null)).toBe('null');
  });

  it('array payload serialises correctly', () => {
    expect(canonicalPayload([1, 2, 3])).toBe('[1,2,3]');
  });

  it('key-order invariant: out-of-order keys produce same string as sorted keys', () => {
    const outOfOrder = canonicalPayload({ z: 3, a: 1, m: 2 });
    const inOrder = canonicalPayload({ a: 1, m: 2, z: 3 });
    expect(outOfOrder).toBe(inOrder);
    expect(outOfOrder).toBe('{"a":1,"m":2,"z":3}');
  });

  it('key-order invariant applies recursively to nested objects', () => {
    const result = canonicalPayload({ b: { y: 2, x: 1 }, a: { q: 4, p: 3 } });
    expect(result).toBe('{"a":{"p":3,"q":4},"b":{"x":1,"y":2}}');
  });

  it('array order is preserved, not sorted', () => {
    expect(canonicalPayload([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalPayload(['c', 'a', 'b'])).toBe('["c","a","b"]');
  });

  it('unicode strings are stable across calls', () => {
    const r1 = canonicalPayload({ msg: 'événement' });
    const r2 = canonicalPayload({ msg: 'événement' });
    expect(r1).toBe(r2);
    expect(r1).toBe('{"msg":"événement"}');
  });
});
