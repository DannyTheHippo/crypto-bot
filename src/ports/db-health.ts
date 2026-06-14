import type { HealthIndicatorResult } from '@nestjs/terminus';

export const DB_HEALTH = Symbol('DB_HEALTH');

export interface DbHealthPort {
  check(key: string): Promise<HealthIndicatorResult>;
}
