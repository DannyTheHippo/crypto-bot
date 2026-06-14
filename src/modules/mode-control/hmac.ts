import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC-SHA256(challengeId + ':' + bootId, secret) → hex. Produces the operator's expected
// proof token for the two-step arming flow.
export function computeArmingHmac(challengeId: string, bootId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${challengeId}:${bootId}`).digest('hex');
}

// Constant-time comparison guards against timing oracle attacks. A non-hex or wrong-length
// candidate returns false immediately: timingSafeEqual throws on unequal byte length, and
// Buffer.from(hex) silently truncates at the first invalid pair — so an un-validated same-length
// non-hex candidate would decode short and make timingSafeEqual throw (an uncaught 500 / a length
// side-channel). The format check is on attacker-controlled input only (never the secret), so it
// leaks nothing secret-dependent.
const HEX_64 = /^[0-9a-f]{64}$/i;
export function verifyArmingHmac(
  challengeId: string,
  bootId: string,
  secret: string,
  candidateHex: string,
): boolean {
  const expected = computeArmingHmac(challengeId, bootId, secret); // SHA-256 ⇒ always 64 hex chars
  // HEX_64 fixes both the alphabet and the length, so a passing candidate decodes to the same 32
  // bytes as `expected` — no separate length check (which would be an unreachable branch).
  if (!HEX_64.test(candidateHex)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidateHex, 'hex'));
}
