import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { EXECUTION_GATE, PORTFOLIO_VIEW, INSTANCE_LOCK } from '../../../src/ports/execution';
import { KILL_SWITCH } from '../../../src/ports/risk';
import { REFLECTION_SERVICE } from '../../../src/features/trading/agentic/agentic-strategy.module';
import {
  MODE_CONTROL,
  ModeViolationError,
  type ModeControlPort,
} from '../../../src/ports/mode-control';
import { EXCHANGE_PORT } from '../../../src/ports/exchange';
import { PaperExchangeAdapter } from '../../../src/features/trading/exchange/paper-exchange.adapter';
import { LiveExchangeAdapter } from '../../../src/features/trading/exchange/live-exchange.adapter';
import { HaltCoordinatorService } from '../../../src/features/trading/execution/halt-coordinator.service';
import { ReconciliationService } from '../../../src/features/trading/execution/reconciliation.service';
import { UnknownResolverService } from '../../../src/features/trading/execution/unknown-resolver.service';
import { CrashRecoveryService } from '../../../src/features/trading/execution/crash-recovery.service';

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
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
      // config is forced paper, so the EXCHANGE_PORT factory selects the paper adapter and the
      // LiveExchangeAdapter is never constructed (absent from the graph, not merely disabled). A
      // live-stamped order is refused outright.
      const exchange = app.get<PaperExchangeAdapter>(EXCHANGE_PORT, { strict: false });
      expect(exchange).toBeInstanceOf(PaperExchangeAdapter);
      expect(exchange).not.toBeInstanceOf(LiveExchangeAdapter);
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
      // SEED_PLAYBOOK_V3 starts the unified single lineage fresh at version 1 (greenfield DB,
      // spec §1.3/§9: the per-lane seed versions retired with the lane model).
      expect(metrics.text).toContain('agentic_playbook_info{version="1"} 1');
      // E: onModuleInit records the bound client kind at boot. Under test/ci no ANTHROPIC_API_KEY is
      // read, so the inert StubAgentClient binds and the gauge carries kind="stub".
      expect(metrics.text).toContain('agent_client_info{kind="stub"} 1');
    } finally {
      await app.close();
    }
  });
});
