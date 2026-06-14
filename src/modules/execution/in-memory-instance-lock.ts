import { Injectable } from '@nestjs/common';
import type { InstanceLockPort } from '../../ports/execution';

// In-process single-writer guard (§1): the DB-less default. It enforces the one-lock-per-(venue,
// apiKey) rule WITHIN this process — a re-acquire of a held key throws — which is enough for paper
// and for catching a double-bootstrap in tests. It cannot detect a SECOND OS process on the same
// key; that is the live Postgres pg_advisory_lock's job (deferred until the DB is wired, §7).
@Injectable()
export class InMemoryInstanceLock implements InstanceLockPort {
  private held: string | undefined;

  acquire(venue: string, keyFingerprint: string): Promise<void> {
    const key = `${venue}|${keyFingerprint}`;
    if (this.held !== undefined) {
      return Promise.reject(new Error(`instance lock already held for ${this.held} (cannot also take ${key})`));
    }
    this.held = key;
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.held = undefined;
    return Promise.resolve();
  }
}
