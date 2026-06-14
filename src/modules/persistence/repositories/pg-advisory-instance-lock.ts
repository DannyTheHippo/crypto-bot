import type { Pool, PoolClient } from 'pg';
import type { InstanceLockPort } from '../../../ports/execution';

// §1/§6 single-writer interlock via PostgreSQL session-level advisory locks.
// pg_advisory_lock is session-scoped: the lock is held for the life of the connection.
// We check out a dedicated client from the pool, hold it for the process lifetime,
// and run pg_advisory_unlock + release on the same client on shutdown.
// acquire throws if the key is already held by another session (pg_try_advisory_lock returns false).
export class PgAdvisoryInstanceLock implements InstanceLockPort {
  private client: PoolClient | undefined;
  private lockKey: string | undefined;

  constructor(private readonly pool: Pool) {}

  async acquire(venue: string, keyFingerprint: string): Promise<void> {
    if (this.client !== undefined) {
      throw new Error(
        `instance lock already held for ${this.lockKey ?? '?'} (cannot also take ${venue}|${keyFingerprint})`,
      );
    }

    const client = await this.pool.connect();
    // hashtext() maps a text key to a 32-bit signed integer safe for advisory lock APIs.
    // We combine venue + fingerprint into a single string for a stable, namespaced key.
    const key = `${venue}|${keyFingerprint}`;
    const result = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [key],
    );

    if (!result.rows[0]?.acquired) {
      client.release();
      throw new Error(
        `instance lock contention: another process already holds the lock for ${key}`,
      );
    }

    this.client = client;
    this.lockKey = key;
  }

  async release(): Promise<void> {
    if (this.client === undefined) return;
    try {
      await this.client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [this.lockKey]);
    } finally {
      this.client.release();
      this.client = undefined;
      this.lockKey = undefined;
    }
  }
}
