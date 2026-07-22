import { Injectable } from '@nestjs/common';
import type { StrategyId } from '../../../domain/types/ids';
import type { AsyncStrategy } from '../../../ports/agentic-strategy';
import type { StrategyRegistryPort, StrategyState, DrainPolicy } from '../../../ports/strategy';

// Why a strategy is DRAINING. Provenance lives here (registry), not in host runtime state, so an
// AUTO (3-strike failure) drain and its recovery probe can never override an OPERATOR (explicit
// disable()) drain — only a transition to ACTIVE clears it. Owner-authorized recovery program
// (2026-07-22, RECOVERY_AUTO_RESUME_ENABLED): StrategyHost's runDecide may now drive that ACTIVE
// transition off a healthy decide for BOTH reasons (previously AUTO only) — this registry's own
// clearing mechanism (setLifecycle(id, 'ACTIVE') always wipes drainReason) is unchanged either way.
export type DrainReason = 'AUTO' | 'OPERATOR';

interface RegistryEntry {
  strategy: AsyncStrategy;
  lifecycle: StrategyState['lifecycle'];
  drainPolicy: DrainPolicy;
  drainReason?: DrainReason;
}

@Injectable()
export class StrategyRegistry implements StrategyRegistryPort {
  private readonly factories = new Map<
    string,
    (id: StrategyId, params: unknown) => AsyncStrategy
  >();
  private readonly entries = new Map<StrategyId, RegistryEntry>();

  register(type: string, factory: (id: StrategyId, params: unknown) => AsyncStrategy): void {
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
    this.entries.set(id, {
      ...entry,
      lifecycle: 'DRAINING',
      drainPolicy: drain,
      drainReason: 'OPERATOR',
    });
  }

  states(): readonly StrategyState[] {
    return Array.from(this.entries.entries()).map(([id, e]) => ({
      id,
      lifecycle: e.lifecycle,
    }));
  }

  getStrategy(id: StrategyId): AsyncStrategy | undefined {
    return this.entries.get(id)?.strategy;
  }

  getLifecycle(id: StrategyId): StrategyState['lifecycle'] | undefined {
    return this.entries.get(id)?.lifecycle;
  }

  getDrainReason(id: StrategyId): DrainReason | undefined {
    return this.entries.get(id)?.drainReason;
  }

  // `drainReason` stamps provenance only when transitioning INTO DRAINING (the host's auto-drain
  // passes 'AUTO'; disable() above stamps 'OPERATOR' directly, bypassing this method). Transitioning
  // to ACTIVE always clears it, so recovery never carries a stale reason forward. OPERATOR never
  // downgrades to AUTO here: an explicit disable() must not be silently overridden by a later
  // AUTO-drain call racing against it (no caller does this today, but the invariant is structural).
  setLifecycle(id: StrategyId, lc: StrategyState['lifecycle'], drainReason?: DrainReason): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (lc === 'ACTIVE') {
      this.entries.set(id, { ...entry, lifecycle: lc, drainReason: undefined });
      return;
    }
    if (lc === 'DRAINING') {
      this.entries.set(id, {
        ...entry,
        lifecycle: lc,
        drainReason:
          entry.drainReason === 'OPERATOR' ? 'OPERATOR' : (drainReason ?? entry.drainReason),
      });
      return;
    }
    this.entries.set(id, { ...entry, lifecycle: lc });
  }

  allActive(): StrategyId[] {
    return Array.from(this.entries.entries())
      .filter(([, e]) => e.lifecycle === 'ACTIVE' || e.lifecycle === 'DRAINING')
      .map(([id]) => id);
  }
}
