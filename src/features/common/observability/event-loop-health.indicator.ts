import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { HealthIndicatorService, HealthIndicatorResult } from '@nestjs/terminus';
import { monitorEventLoopDelay } from 'perf_hooks';

@Injectable()
export class EventLoopHealthIndicator implements OnModuleInit, OnModuleDestroy {
  private monitor: ReturnType<typeof monitorEventLoopDelay> | null = null;

  constructor(private readonly healthIndicatorService: HealthIndicatorService) {}

  onModuleInit() {
    this.monitor = monitorEventLoopDelay({ resolution: 10 });
    this.monitor.enable();
  }

  onModuleDestroy() {
    if (this.monitor) {
      this.monitor.disable();
      this.monitor.reset();
      this.monitor = null;
    }
  }

  getMonitor(): ReturnType<typeof monitorEventLoopDelay> | null {
    return this.monitor;
  }

  getP99Ms(): number {
    if (!this.monitor) return 0;
    return this.monitor.percentile(99) / 1e6;
  }

  check(key: string, thresholdMs = 500): HealthIndicatorResult {
    const p99 = this.getP99Ms();
    const healthy = p99 < thresholdMs;
    const indicator = this.healthIndicatorService.check(key);
    return healthy
      ? indicator.up({ p99Ms: p99, thresholdMs })
      : indicator.down({ p99Ms: p99, thresholdMs });
  }
}
