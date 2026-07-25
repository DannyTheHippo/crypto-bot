import { describe, it, expect, afterEach } from 'vitest';
import { computeProof, main } from '../../../../scripts/arm-ceremony.mjs';
import { verifyArmingHmac } from '../../../../src/features/trading/mode-control/hmac.ts';

// arm-ceremony.mjs runs standalone via `node` (outside the tsconfig/Nest graph — see
// eslint.config.mjs's scripts/** ignore, hence this spec is plain .mjs too rather than importing
// a bare .mjs from a typed .ts file). computeProof must satisfy the SAME server-side verifier the
// running service uses (src/features/trading/mode-control/hmac.ts's verifyArmingHmac), proving the
// CLI's proof is accepted by the real arming state machine (src/domain/trading/mode/arming.ts's CONFIRM
// branch) without ever starting a server.
describe('arm-ceremony computeProof', () => {
  it('produces a proof the server-side verifier accepts', () => {
    const proof = computeProof('chal-123', 'boot-abc', 'arming-secret');
    expect(verifyArmingHmac('chal-123', 'boot-abc', 'arming-secret', proof)).toBe(true);
  });

  it('is bound to challengeId and bootId (captured-token defence)', () => {
    const proof = computeProof('chal-123', 'boot-abc', 'arming-secret');
    expect(verifyArmingHmac('chal-other', 'boot-abc', 'arming-secret', proof)).toBe(false);
    expect(verifyArmingHmac('chal-123', 'boot-other', 'arming-secret', proof)).toBe(false);
  });
});

// The network-calling paths (arm/request, arm/confirm, /metrics bootId lookup, disarm) need a
// running server and are exercised out-of-session (docs/runbook.md §Re-arm) — this spec covers
// the argument-validation behavior that is meaningfully testable offline: the script must refuse
// before it ever computes a proof or opens a connection.
describe('arm-ceremony argument validation', () => {
  const originalSecret = process.env.ARMING_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.ARMING_SECRET;
    } else {
      process.env.ARMING_SECRET = originalSecret;
    }
  });

  it('refuses to run when ARMING_SECRET is absent', async () => {
    delete process.env.ARMING_SECRET;
    const code = await main([]);
    expect(code).toBe(1);
  });

  it('refuses to run on an unrecognized flag before touching the network', async () => {
    delete process.env.ARMING_SECRET;
    const code = await main(['--bogus-flag']);
    expect(code).toBe(1);
  });

  it('prints help and exits 0 without requiring ARMING_SECRET', async () => {
    delete process.env.ARMING_SECRET;
    const code = await main(['--help']);
    expect(code).toBe(0);
  });
});
