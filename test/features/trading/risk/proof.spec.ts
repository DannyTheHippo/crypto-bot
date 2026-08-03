import { describe, it, expect } from 'vitest';
import {
  mintApproval,
  verifyApproval,
  APPROVAL_TTL_MS,
  type MintOptions,
} from '../../../../src/domain/trading/risk/proof';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';
import type { ApprovalProof } from '../../../../src/domain/trading/types/risk-decision';
import { price, qty } from '../../../../src/domain/common/types/money';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
} from '../../../../src/domain/common/types/ids';

const KEY = Buffer.alloc(32, 7);
const IID = intentId('0190abcd-1234-7abc-89ab-0123456789ab');

function intent(o: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intentId: IID,
    clientOrderId: encodeClientOrderId(IID, 'paper'),
    strategyId: strategyId('s'),
    venue: venueId('binance'),
    symbol: symbolId('BTC/USDT'),
    side: 'BUY',
    type: 'LIMIT',
    qty: qty('1'),
    limitPrice: price('100'),
    timeInForce: 'GTC',
    reduceOnly: false,
    mode: 'paper',
    refPrice: price('100'),
    refSeq: 1n,
    createdAt: epochMs(0),
    expiresAt: epochMs(10),
    source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 1n, strength: 1 },
    ...o,
  };
}

const OPTS: MintOptions = {
  nonce: 'n1',
  approvedAtMs: epochMs(1000),
  limitsVersion: 'v1',
  snapshotSeq: 5n,
};

describe('approval proof (§4.2 unforgeable RiskApprovedIntent)', () => {
  it('mint then independently recompute the hash and verify — OK (canonicalization matches)', () => {
    const approved = mintApproval(intent(), KEY, OPTS);
    expect(approved.proof.ttlMs).toBe(APPROVAL_TTL_MS);
    expect(verifyApproval(approved, KEY, epochMs(1500), false)).toBe('OK');
  });

  it('a mutated intent fails the hash check', () => {
    const approved = mintApproval(intent(), KEY, OPTS);
    const tampered = {
      ...approved,
      intent: { ...approved.intent, qty: qty('999') },
    } as typeof approved;
    expect(verifyApproval(tampered, KEY, epochMs(1500), false)).toBe('BAD_HASH');
  });

  it('a forged/wrong key fails the HMAC check', () => {
    const approved = mintApproval(intent(), KEY, OPTS);
    expect(verifyApproval(approved, Buffer.alloc(32, 9), epochMs(1500), false)).toBe('BAD_HMAC');
  });

  it('an HMAC of a different length fails the HMAC check', () => {
    const approved = mintApproval(intent(), KEY, OPTS);
    const shortHmac = { ...approved, proof: { ...approved.proof, hmac: 'ab' } } as typeof approved;
    expect(verifyApproval(shortHmac, KEY, epochMs(1500), false)).toBe('BAD_HMAC');
  });

  it('a replayed nonce is refused', () => {
    const approved = mintApproval(intent(), KEY, OPTS);
    expect(verifyApproval(approved, KEY, epochMs(1500), true)).toBe('REPLAY');
  });

  it('a stale approval (past TTL) is refused', () => {
    const approved = mintApproval(intent(), KEY, OPTS);
    expect(verifyApproval(approved, KEY, epochMs(1000 + APPROVAL_TTL_MS + 1), false)).toBe(
      'EXPIRED',
    );
  });

  it('the same intent + nonce + key produces a stable hmac (deterministic)', () => {
    expect(mintApproval(intent(), KEY, OPTS).proof.hmac).toBe(
      mintApproval(intent(), KEY, OPTS).proof.hmac,
    );
  });

  // The hmac used to cover only `${intentHash}:${nonce}`, leaving every other proof field
  // unauthenticated — including approvedAtMs/ttlMs, the two values verifyApproval reads to decide
  // EXPIRED. A holder of a genuine proof could therefore extend its own TTL indefinitely (the
  // forgery defense answering an attacker-supplied deadline), and limitsVersion/snapshotSeq — the
  // persisted audit record of which limits and which portfolio snapshot approved the order — could
  // be rewritten without detection. Every authenticated field is pinned individually below.
  describe('the hmac authenticates the FULL proof tuple, not just intentHash+nonce', () => {
    const cases: ReadonlyArray<readonly [string, Partial<ApprovalProof>]> = [
      ['approvedAtMs (TTL extension attack)', { approvedAtMs: epochMs(999_000) }],
      ['ttlMs (TTL extension attack)', { ttlMs: 86_400_000 }],
      ['limitsVersion (audit record of which limits approved)', { limitsVersion: 'v0' }],
      ['snapshotSeq (audit record of which snapshot approved)', { snapshotSeq: 6n }],
      ['nonce', { nonce: 'n2' }],
      ['intentHash', { intentHash: 'a'.repeat(64) }],
    ];

    for (const [label, patch] of cases) {
      it(`tampering with ${label} fails the HMAC check`, () => {
        const approved = mintApproval(intent(), KEY, OPTS);
        const tampered = {
          ...approved,
          proof: { ...approved.proof, ...patch },
        } as typeof approved;
        // intentHash is the one field the independent hash recompute catches first.
        const expected = 'intentHash' in patch ? 'BAD_HASH' : 'BAD_HMAC';
        expect(verifyApproval(tampered, KEY, epochMs(1500), false)).toBe(expected);
      });
    }

    it('an untampered proof still verifies OK (the widened MAC is not a blanket reject)', () => {
      expect(verifyApproval(mintApproval(intent(), KEY, OPTS), KEY, epochMs(1500), false)).toBe(
        'OK',
      );
    });

    // A TTL push-out is the attack the old MAC could not see: the proof stays otherwise valid and
    // the expiry check would have accepted the rewritten deadline.
    it('a proof whose approvedAtMs is pushed forward past its real expiry is BAD_HMAC, never OK', () => {
      const approved = mintApproval(intent(), KEY, OPTS);
      const pushedOut = {
        ...approved,
        proof: { ...approved.proof, approvedAtMs: epochMs(1_000_000) },
      } as typeof approved;
      // Long past the genuine 1000+2000ms deadline; pre-fix this returned 'OK'.
      expect(verifyApproval(pushedOut, KEY, epochMs(1_000_500), false)).toBe('BAD_HMAC');
    });
  });
});
