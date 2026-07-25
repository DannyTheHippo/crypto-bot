import { describe, it, expect } from 'vitest';
import { makeBucket, tryConsume } from '../../../../src/domain/trading/risk/rate-bucket';

describe('token bucket (§5 R1)', () => {
  it('starts full and consumes one token per allowed request', () => {
    let b = makeBucket(2, 1000);
    let r = tryConsume(b, 2, 1, 1000);
    expect(r.allowed).toBe(true);
    b = r.bucket;
    r = tryConsume(b, 2, 1, 1000);
    expect(r.allowed).toBe(true);
    b = r.bucket;
    r = tryConsume(b, 2, 1, 1000); // empty now
    expect(r.allowed).toBe(false);
  });

  it('refills by elapsed time up to capacity', () => {
    const empty = { tokens: 0, lastRefillMs: 1000 };
    // 2s later at 1 token/s → 2 tokens refilled, capped at capacity 5
    const r = tryConsume(empty, 5, 1, 3000);
    expect(r.allowed).toBe(true);
    expect(r.bucket.tokens).toBe(1); // 2 refilled − 1 consumed
  });

  it('caps refill at capacity even after a long idle', () => {
    const r = tryConsume({ tokens: 0, lastRefillMs: 0 }, 3, 1, 1_000_000);
    expect(r.bucket.tokens).toBe(2); // capped at 3 then −1
  });

  it('treats a non-advancing clock as zero elapsed (no negative refill)', () => {
    const r = tryConsume({ tokens: 0, lastRefillMs: 5000 }, 5, 1, 4000); // now < lastRefill
    expect(r.allowed).toBe(false);
    expect(r.bucket.tokens).toBe(0);
  });
});
