import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorResult } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { EventLoopHealthIndicator } from './event-loop-health.indicator';
import type { AppConfig } from '../../ports/app-config';
import { DB_HEALTH, type DbHealthPort } from '../../ports/db-health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly eventLoopIndicator: EventLoopHealthIndicator,
    @Optional()
    @Inject(DB_HEALTH)
    private readonly dbHealth: DbHealthPort | null,
  ) {}

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    const mode = this.configService.get('mode', { infer: true });
    const checks: Array<() => HealthIndicatorResult | Promise<HealthIndicatorResult>> = [
      () => this.eventLoopIndicator.check('event_loop_delay'),
      () =>
        Promise.resolve({
          config: {
            status: 'up' as const,
            effectiveMode: mode.configMode,
            killSwitchState: 'RUNNING' as const,
          },
        }),
    ];

    if (this.dbHealth) {
      checks.push(() => this.dbHealth!.check('database'));
    }

    return this.health.check(checks);
  }
}
