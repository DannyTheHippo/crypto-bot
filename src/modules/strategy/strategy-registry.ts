import { Injectable } from '@nestjs/common';
import type { StrategyId } from '../../domain/types/ids';
import type { Strategy } from '../../domain/strategy/strategy';
import type { StrategyRegistryPort, StrategyState, DrainPolicy } from '../../ports/strategy';

interface RegistryEntry {
  strategy: Strategy;
  lifecycle: StrategyState['lifecycle'];
  drainPolicy: DrainPolicy;
}

@Injectable()
export class StrategyRegistry implements StrategyRegistryPort {
  private readonly factories = new Map<
    string,
    (id: StrategyId, params: unknown) => Strategy
  >();
  private readonly entries = new Map<StrategyId, RegistryEntry>();

  register(type: string, factory: (id: StrategyId, params: unknown) => Strategy): void {
    this.factories.set(type, factory);
  }

  enable(id: StrategyId, type: string, params: unknown): void {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`Unknown strategy type: "${type}"`);
    }
    const strategy = factory(id, params);
    this.entries.set(id, {
      strategy,
      lifecycle: 'LOADING',
      drainPolicy: 'CANCEL_OPEN_KEEP_POSITION',
    });
  }

  disable(id: StrategyId, drain: DrainPolicy = 'CANCEL_OPEN_KEEP_POSITION'): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.set(id, { ...entry, lifecycle: 'DRAINING', drainPolicy: drain });
  }

  states(): readonly StrategyState[] {
    return Array.from(this.entries.entries()).map(([id, e]) => ({
      id,
      lifecycle: e.lifecycle,
    }));
  }

  getStrategy(id: StrategyId): Strategy | undefined {
    return this.entries.get(id)?.strategy;
  }

  getLifecycle(id: StrategyId): StrategyState['lifecycle'] | undefined {
    return this.entries.get(id)?.lifecycle;
  }

  setLifecycle(id: StrategyId, lc: StrategyState['lifecycle']): void {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.set(id, { ...entry, lifecycle: lc });
    }
  }

  allActive(): StrategyId[] {
    return Array.from(this.entries.entries())
      .filter(([, e]) => e.lifecycle === 'ACTIVE' || e.lifecycle === 'DRAINING')
      .map(([id]) => id);
  }
}
