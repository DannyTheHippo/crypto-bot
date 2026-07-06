import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorResult } from '@nestjs/terminus';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { EventLoopHealthIndicator } from './event-loop-health.indicator';
import { DB_HEALTH, type DbHealthPort } from '../../../ports/db-health';
import {
  STRATEGY_REGISTRY,
  type StrategyRegistryPort,
  type StrategyLifecycle,
  type DrainReason,
} from '../../../ports/strategy';

interface StrategyDetail {
  readonly lifecycle: StrategyLifecycle;
  readonly drainReason?: DrainReason;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly configService: TypedConfigService,
    private readonly eventLoopIndicator: EventLoopHealthIndicator,
    @Optional()
    @Inject(DB_HEALTH)
    private readonly dbHealth: DbHealthPort | null,
    // @Optional: STRATEGY_REGISTRY is not yet bridged into global scope (pending G3c) and is absent in
    // every unit test — the strategies detail below is simply omitted when it is null.
    @Optional()
    @Inject(STRATEGY_REGISTRY)
    private readonly registry: StrategyRegistryPort | null,
  ) {}

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    const mode = this.configService.mode;
    const configDetail: {
      status: 'up';
      effectiveMode: string;
      killSwitchState: 'RUNNING';
      strategies?: Record<string, StrategyDetail>;
    } = {
      status: 'up',
      effectiveMode: mode.configMode,
      killSwitchState: 'RUNNING',
    };
    if (this.registry) {
      configDetail.strategies = this.buildStrategiesDetail(this.registry);
    }

    const checks: Array<() => HealthIndicatorResult | Promise<HealthIndicatorResult>> = [
      () => this.eventLoopIndicator.check('event_loop_delay'),
      () => Promise.resolve({ config: configDetail }),
    ];

    if (this.dbHealth) {
      checks.push(() => this.dbHealth!.check('database'));
    }

    return this.health.check(checks);
  }

  private buildStrategiesDetail(registry: StrategyRegistryPort): Record<string, StrategyDetail> {
    const detail: Record<string, StrategyDetail> = {};
    for (const { id, lifecycle } of registry.states()) {
      const drainReason = registry.getDrainReason?.(id);
      detail[id] = drainReason !== undefined ? { lifecycle, drainReason } : { lifecycle };
    }
    return detail;
  }
}
