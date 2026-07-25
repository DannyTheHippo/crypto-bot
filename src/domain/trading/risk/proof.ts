import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { OrderIntent } from '../types/order-intent';
import type { ApprovalProof, RiskApprovedIntent } from '../types/risk-decision';
import { intentCanonical } from './canonical';
import { __mintApprovedIntent } from './minting';
import type { EpochMs } from '../types/ids';

// Layer-2 runtime forgery defense for RiskApprovedIntent (§4.2). Pure crypto over domain
// types (node:crypto is deterministic — no clock/process/network), so it lives in domain and
// is shared by exactly two callers: the RiskEngine (mint) and Execution (verify), each given
// the process-lifetime signing key. A forged HMAC, a mutated intent (hash mismatch), a
// replayed nonce, or a stale approval all fail here even past the compile-time brand.

export const APPROVAL_TTL_MS = 2000;

function intentHash(intent: OrderIntent): string {
  // intentCanonical uses Decimal toFixed (no exponent) so both sides hash identically.
  return createHash('sha256').update(intentCanonical(intent)).digest('hex');
}

function hmacOf(intentHashHex: string, nonce: string, key: Buffer | string): string {
  return createHmac('sha256', key).update(`${intentHashHex}:${nonce}`).digest('hex');
}

export interface MintOptions {
  readonly nonce: string; // single-use; the engine draws it from a CSPRNG
  readonly approvedAtMs: EpochMs;
  readonly limitsVersion: string;
  readonly snapshotSeq: bigint;
}

export function mintApproval(
  intent: OrderIntent,
  key: Buffer | string,
  opts: MintOptions,
): RiskApprovedIntent {
  const hash = intentHash(intent);
  const proof: ApprovalProof = {
    intentHash: hash,
    hmac: hmacOf(hash, opts.nonce, key),
    nonce: opts.nonce,
    approvedAtMs: opts.approvedAtMs,
    ttlMs: APPROVAL_TTL_MS,
    limitsVersion: opts.limitsVersion,
    snapshotSeq: opts.snapshotSeq,
  };
  return __mintApprovedIntent(intent, proof);
}

export type VerifyResult = 'OK' | 'BAD_HASH' | 'BAD_HMAC' | 'EXPIRED' | 'REPLAY';

// Execution-side check. `nonceSeen` is the OMS's single-use nonce ledger lookup.
export function verifyApproval(
  approved: RiskApprovedIntent,
  key: Buffer | string,
  now: EpochMs,
  nonceSeen: boolean,
): VerifyResult {
  const { intent, proof } = approved;

  // Recompute the hash independently — a mutated intent no longer matches.
  if (intentHash(intent) !== proof.intentHash) return 'BAD_HASH';

  // Constant-time HMAC comparison — a forged key cannot reproduce it.
  const expected = Buffer.from(hmacOf(proof.intentHash, proof.nonce, key), 'hex');
  const actual = Buffer.from(proof.hmac, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 'BAD_HMAC';

  // Replayed approvals (nonce already consumed) are refused.
  if (nonceSeen) return 'REPLAY';

  // Stale approvals must be re-risked.
  if (now > proof.approvedAtMs + proof.ttlMs) return 'EXPIRED';

  return 'OK';
}
