import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../../../src/app.module';
import { symbolId, venueId, type VenueId } from '../../../../src/domain/common/types/ids';
import { REFLECTION_SERVICE } from '../../../../src/features/strategy/agentic/agentic-strategy.module';
import { VenueRoutingExchangeAdapter } from '../../../../src/features/trading/composition/exchange-adapters.module';
import { LiveExchangeAdapter } from '../../../../src/features/venue/exchange/live-exchange.adapter';
import { PaperExchangeAdapter } from '../../../../src/features/venue/exchange/paper-exchange.adapter';
import { PaperPerpAdapter } from '../../../../src/features/venue/exchange/paper-perp.adapter';
import { CrashRecoveryService } from '../../../../src/features/trading/execution/crash-recovery.service';
import { HaltCoordinatorService } from '../../../../src/features/trading/execution/halt-coordinator.service';
import { ReconciliationService } from '../../../../src/features/trading/execution/reconciliation.service';
import { UnknownResolverService } from '../../../../src/features/trading/execution/unknown-resolver.service';
import {
  EXCHANGE_PORT,
  VENUE_EXCHANGE_PORTS,
  type ExchangePort,
} from '../../../../src/ports/venue/exchange';
import {
  EXECUTION_GATE,
  INSTANCE_LOCK,
  PORTFOLIO_VIEW,
} from '../../../../src/ports/trading/execution';
import {
  MODE_CONTROL,
  ModeViolationError,
  type ModeControlPort,
} from '../../../../src/ports/trading/mode-control';
import { KILL_SWITCH } from '../../../../src/ports/trading/risk';
import {
  VENUE_REGISTRY,
  type VenueRuntimeDescriptor,
} from '../../../../src/ports/venue/venue-registry';

// v3 §3.2: VENUES defaults to empty under test/ci (config.module.ts's AppConfigModule sets
// `skipProcessEnv: true` + `ignoreEnvFile: isTestOrCi` — a deliberate hermetic-test boundary; no
// process.env mutation in a spec ever reaches environment.config.ts's validate()). A real deploy
// always configures both venues (VENUES non-empty is enforced outside test/ci), so this boot spec
// overrides ONLY the derived VENUE_REGISTRY token — a pure data provider with no further deps — to
// the deployed two-venue shape, while every other provider in the graph (ExchangeAdaptersModule,
// MarketStreamsModule, ContextFeedsModule, TradingRuntimeModule, …) resolves for real off of it. This
// is the minimal override that lets the REAL AppModule construct both venues' exchange ports without
// touching environment.config.ts (frozen, owned by workstream #7 — see the v3 spec's integration order).
const TWO_VENUE_REGISTRY: ReadonlyMap<VenueId, VenueRuntimeDescriptor> = new Map([
  [
    venueId('binance'),
    {
      venue: venueId('binance'),
      config: { id: 'binance', environment: 'demo' },
      symbols: [symbolId('BTC/USDT')],
      capitalShare: '500',
      perpCapable: false,
    },
  ],
  [
    venueId('binanceusdm'),
    {
      venue: venueId('binanceusdm'),
      config: { id: 'binanceusdm', environment: 'demo' },
      symbols: [],
      capitalShare: '500',
      perpCapable: true,
    },
  ],
]);

// Boots the REAL AppModule (not a mirror) as a full HTTP application: nest build only typechecks —
// DI resolution errors (token collisions, unresolvable providers, the SigningKeyModule/
// PaperExchangeModule wiring, RISK_SIGNING_KEY having been removed from RiskModule) surface only at
// init(), and route/controller wiring surfaces only when the HTTP layer actually serves. DB-less
// paper must boot (config defaults to paper, the pg pool resolves to null). This is the CI-stable
// regression guard for the first real `main.ts` boot (which serves these same routes via app.listen).
//
// ONE AppModule instantiation per file: prom-client is a process-global singleton; a second compile
// would double-register its metrics. createNestApplication wraps the single compiled module, so the
// HTTP assertions reuse that one graph. Under vitest NODE_ENV=test the config is forced paper and the
// periodic drivers are skipped; app.close() clears any timers regardless.
describe('AppModule composition', () => {
  it('boots the full trading graph DB-less (paper) and serves health + metrics', async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(VENUE_REGISTRY)
      .useValue(TWO_VENUE_REGISTRY)
      .compile();
    const app: INestApplication = ref.createNestApplication();
    await app.init();

    try {
      expect(app.get(EXECUTION_GATE, { strict: false })).toBeDefined();
      expect(app.get(PORTFOLIO_VIEW, { strict: false })).toBeDefined();
      expect(app.get(EXCHANGE_PORT, { strict: false })).toBeDefined();
      expect(app.get(KILL_SWITCH, { strict: false })).toBeDefined(); // single global kill switch
      expect(app.get(INSTANCE_LOCK, { strict: false })).toBeDefined();
      // G4a: REFLECTION_SERVICE resolves through the full DI graph (AGENT_LLM_BUDGET plus every
      // @Global-bound optional token it depends on) even though startTrading() — which would wire
      // AgenticStrategyDeps.onClosedTrade to it — never fires under test/ci.
      expect(app.get(REFLECTION_SERVICE, { strict: false })).toBeDefined();
      // The Phase-6 OMS-hardening graph resolves: resolver/reconciliation/crash-recovery in
      // ExecutionModule, and the cross-module HaltCoordinator (RISK_ENGINE + POSITION_SIZER) at root.
      expect(app.get(UnknownResolverService, { strict: false })).toBeDefined();
      expect(app.get(ReconciliationService, { strict: false })).toBeDefined();
      expect(app.get(CrashRecoveryService, { strict: false })).toBeDefined();
      expect(app.get(HaltCoordinatorService, { strict: false })).toBeDefined();

      // §10 / live-gate matrix on the REAL container (CI-cannot-reach-live): under NODE_ENV=test the
      // config is forced paper, so every venue's EXCHANGE_PORT factory selects a paper adapter and no
      // LiveExchangeAdapter is ever constructed (absent from the graph, not merely disabled). v3:
      // EXCHANGE_PORT itself is now the VenueRoutingExchangeAdapter facade (exchange-adapters.module.ts)
      // — the per-venue paper adapters live behind VENUE_EXCHANGE_PORTS, asserted below.
      const exchange = app.get<ExchangePort>(EXCHANGE_PORT, { strict: false });
      expect(exchange).toBeInstanceOf(VenueRoutingExchangeAdapter);
      expect(exchange).not.toBeInstanceOf(LiveExchangeAdapter);

      // v3 §1.3: paper boot must construct BOTH venues behind the EXCHANGE_PORT routing facade —
      // spot (binance) gets the PaperExchangeAdapter, perp (binanceusdm) gets the PaperPerpAdapter
      // (signed position ledger + isolated margin), and neither is ever a LiveExchangeAdapter on a
      // paper/test boot (the four-gate arming ceremony never fires here).
      const venuePorts = app.get<ReadonlyMap<VenueId, ExchangePort>>(VENUE_EXCHANGE_PORTS, {
        strict: false,
      });
      expect(venuePorts.size).toBe(2);
      const spotPort = venuePorts.get(venueId('binance'));
      const perpPort = venuePorts.get(venueId('binanceusdm'));
      expect(spotPort).toBeInstanceOf(PaperExchangeAdapter);
      expect(perpPort).toBeInstanceOf(PaperPerpAdapter);
      expect(spotPort).not.toBeInstanceOf(LiveExchangeAdapter);
      expect(perpPort).not.toBeInstanceOf(LiveExchangeAdapter);

      const mode = app.get<ModeControlPort>(MODE_CONTROL, { strict: false });
      expect(mode.resolveMode().effective).toBe('paper');
      expect(() => mode.assertCanTrade('live')).toThrow(ModeViolationError);

      // The assembled HTTP layer actually serves (the first-real-boot integration step, locked in CI).
      const server = app.getHttpServer() as Parameters<typeof request>[0];

      const live = await request(server).get('/health/live');
      expect(live.status).toBe(200);
      expect((live.body as { status?: string }).status).toBe('ok');

      const ready = await request(server).get('/health/ready');
      expect(ready.status).toBe(200);
      const readyInfo = (
        ready.body as {
          info: {
            config: { effectiveMode: string; strategies?: Record<string, unknown> };
            database: { detail: string };
          };
        }
      ).info;
      expect(readyInfo.config.effectiveMode).toBe('paper');
      expect(readyInfo.database.detail).toBe('not_configured'); // DB-less paper boots ready
      // G3c: STRATEGY_REGISTRY is bridged into global scope, so the detail key is present (empty under
      // test/ci — onApplicationBootstrap's startTrading(), which registers the agentic strategy, never
      // fires there).
      expect(readyInfo.config.strategies).toEqual({});

      const metrics = await request(server).get('/metrics');
      expect(metrics.status).toBe(200);
      expect(metrics.text).toContain('mode_info{requested="paper",effective="paper"}');
      // G3c: the strategy_lifecycle gauge is registered (STRATEGY_REGISTRY bridge active) even though
      // no labeled series exists yet under test/ci (the 5s sample loop hasn't ticked, and the registry
      // is empty regardless).
      expect(metrics.text).toContain('# TYPE strategy_lifecycle gauge');
      // G3c: AppModule.onModuleInit resolves the playbook and records it at boot, unconditionally
      // (not gated behind the test/ci skip that guards the periodic trading drivers) —
      // SEED_PLAYBOOK_V3 version 2 (2026-07-23 trim+bump): unified single lineage — ensureSeed
      // inserts this version on a greenfield DB (content-only edits of v1 are a live no-op).
      expect(metrics.text).toContain('agentic_playbook_info{version="6"} 1');
      // E: onModuleInit records the bound client kind at boot. Under test/ci no ANTHROPIC_API_KEY is
      // read, so the inert StubAgentClient binds and the gauge carries kind="stub".
      expect(metrics.text).toContain('agent_client_info{kind="stub"} 1');
    } finally {
      await app.close();
    }
  });
});
