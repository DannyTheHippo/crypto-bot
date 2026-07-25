import { describe, it, expect } from 'vitest';
import {
  computeArmingHmac,
  verifyArmingHmac,
} from '../../../src/features/trading/mode-control/hmac';

// The constant-time HMAC compare is the arming security boundary (§10b). A length-guard precedes
// timingSafeEqual (which throws on unequal-length buffers — itself a length side-channel).
describe('arming HMAC', () => {
  const CHALLENGE = 'chal-123';
  const BOOT = 'boot-abc';
  const SECRET = 'arming-secret';

  it('verifies a proof computed with the same challenge/boot/secret', () => {
    const proof = computeArmingHmac(CHALLENGE, BOOT, SECRET);
    expect(verifyArmingHmac(CHALLENGE, BOOT, SECRET, proof)).toBe(true);
  });

  it('rejects a proof under a different secret', () => {
    const proof = computeArmingHmac(CHALLENGE, BOOT, SECRET);
    expect(verifyArmingHmac(CHALLENGE, BOOT, 'other-secret', proof)).toBe(false);
  });

  it('rejects a proof bound to a different bootId (captured-token defence)', () => {
    const proof = computeArmingHmac(CHALLENGE, BOOT, SECRET);
    expect(verifyArmingHmac(CHALLENGE, 'boot-other', SECRET, proof)).toBe(false);
  });

  it('rejects a proof bound to a different challengeId', () => {
    const proof = computeArmingHmac(CHALLENGE, BOOT, SECRET);
    expect(verifyArmingHmac('chal-other', BOOT, SECRET, proof)).toBe(false);
  });

  it('returns false (never throws) on a length mismatch instead of letting timingSafeEqual throw', () => {
    expect(verifyArmingHmac(CHALLENGE, BOOT, SECRET, 'deadbeef')).toBe(false);
    expect(verifyArmingHmac(CHALLENGE, BOOT, SECRET, '')).toBe(false);
  });

  it('returns false (never throws) on a same-length NON-hex candidate (Buffer.from hex would truncate)', () => {
    // 64 chars but not hex: an un-guarded decode truncates to <32 bytes ⇒ timingSafeEqual would throw.
    expect(verifyArmingHmac(CHALLENGE, BOOT, SECRET, 'z'.repeat(64))).toBe(false);
    expect(verifyArmingHmac(CHALLENGE, BOOT, SECRET, 'g'.repeat(64))).toBe(false);
  });
});
