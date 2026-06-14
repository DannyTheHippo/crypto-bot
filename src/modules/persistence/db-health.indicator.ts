import { Injectable, Inject, Optional } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import type { Pool } from 'pg';
import { DATABASE_POOL } from './persistence.tokens';

@Injectable()
export class DbHealthIndicator {
  constructor(
    @Optional()
    @Inject(DATABASE_POOL)
    private readonly pool: Pool | null,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    if (!this.pool) {
      // No DATABASE_URL configured — report up/degraded so the app boots in paper mode.
      return { [key]: { status: 'up' as const, detail: 'not_configured' } };
    }

    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      return { [key]: { status: 'up' as const } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // status 'down' causes terminus to mark /health/ready as failing
      return { [key]: { status: 'down' as const, message } };
    }
  }
}
