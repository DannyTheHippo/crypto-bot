import { describe, it, expect } from 'vitest';
import {
  mintApproval,
  verifyApproval,
  APPROVAL_TTL_MS,
  type MintOptions,
} from '../../../src/domain/risk/proof';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import { price, qty } from '../../../src/domain/types/money';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
} from '../../../src/domain/types/ids';

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
});
