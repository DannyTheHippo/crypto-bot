import { Injectable } from '@nestjs/common';
import type { EpochMs } from '../../../domain/common/types/ids';

// Single-use nonce ledger backing the §4.2 replay defence. TTL-bounded so it cannot grow
// without limit: a nonce is only useful within its approval's TTL window — a replay past
// expiry fails the EXPIRED check regardless, so evicting expired nonces is always safe.
// `has` is the read used by verifyApproval (no mutation); `record` burns the nonce only
// AFTER the proof verifies OK, so a failed (forged/expired) attempt never blocks a retry.
@Injectable()
export class NonceLedgerService {
  private readonly seen = new Map<string, EpochMs>(); // nonce → expiresAt (approvedAtMs + ttlMs)

  has(nonce: string, now: EpochMs): boolean {
    this.evict(now);
    return this.seen.has(nonce);
  }

  record(nonce: string, approvedAtMs: EpochMs, ttlMs: number): void {
    this.seen.set(nonce, (approvedAtMs + ttlMs) as EpochMs);
  }

  size(): number {
    return this.seen.size;
  }

  private evict(now: EpochMs): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(nonce);
    }
  }
}
