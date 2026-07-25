// Pure leaky/token-bucket math. State + clock in → decision + next state out, so the
// stateful service is a thin shell and the rate logic is 100% testable (§5 R1).
export interface TokenBucket {
  readonly tokens: number;
  readonly lastRefillMs: number;
}

export function makeBucket(capacity: number, atMs: number): TokenBucket {
  return { tokens: capacity, lastRefillMs: atMs };
}

function refill(b: TokenBucket, capacity: number, refillPerSec: number, now: number): TokenBucket {
  const elapsedMs = now > b.lastRefillMs ? now - b.lastRefillMs : 0; // clock never runs backward here
  const added = (elapsedMs / 1000) * refillPerSec;
  return { tokens: Math.min(capacity, b.tokens + added), lastRefillMs: now };
}

export interface BucketResult {
  readonly allowed: boolean;
  readonly bucket: TokenBucket;
}

// Refill by elapsed time, then consume one token if available.
export function tryConsume(
  b: TokenBucket,
  capacity: number,
  refillPerSec: number,
  now: number,
): BucketResult {
  const refilled = refill(b, capacity, refillPerSec, now);
  if (refilled.tokens >= 1) {
    return { allowed: true, bucket: { tokens: refilled.tokens - 1, lastRefillMs: now } };
  }
  return { allowed: false, bucket: refilled };
}
