import { Global, Module } from '@nestjs/common';
import { StrategyRegistry } from '../agentic/strategy-registry';
import { STRATEGY_REGISTRY } from '../../../ports/strategy';

// W3 Part 4: pure code motion out of app.module.ts — see db-health-bridge.module.ts's own header
// comment on the boundaries 'app' zone widening this relies on.
//
// Lifts STRATEGY_REGISTRY into the global DI scope so ObservabilityModule's MetricsService
// (per-strategy strategy_lifecycle sampling) and HealthController (ready() strategies detail) resolve
// it via @Optional() @Inject(STRATEGY_REGISTRY) without an observability→app-root import (the
// boundary wall runs the other way — modules must not import the composition root). Unlike
// DbHealthBridgeModule/PortfolioViewBridgeModule, StrategyRegistry has no owning sub-module to
// re-export from: it is the composition root's own service, so this bridge provides (not just
// re-exports) it — AppModule imports this module instead of declaring StrategyRegistry as a local
// provider, keeping exactly one instance.
@Global()
@Module({
  providers: [StrategyRegistry, { provide: STRATEGY_REGISTRY, useExisting: StrategyRegistry }],
  exports: [StrategyRegistry, STRATEGY_REGISTRY],
})
export class StrategyRegistryBridgeModule {}
