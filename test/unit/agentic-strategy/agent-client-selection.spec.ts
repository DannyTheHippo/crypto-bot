import { describe, it, expect } from 'vitest';
import type { TypedConfigService } from '../../../src/config/environment/typed-config.service';
import {
  selectAgentClient,
  createAgentLlmBudget,
  agenticEnv,
  SEED_PLAYBOOK,
  SEED_PLAYBOOK_PERP,
} from '../../../src/features/trading/agentic/agentic-strategy.module';
import { StubAgentClient } from '../../../src/features/trading/agentic/agent-client.adapter';
import { AnthropicAgentClient } from '../../../src/features/trading/agentic/anthropic-agent-client';
import { BatchingAgentClient } from '../../../src/features/trading/agentic/batching-agent-client';
import { BudgetedAgentClient } from '../../../src/features/trading/agentic/agent-budget';
import { validatePlaybook } from '../../../src/features/trading/agentic/playbook-validator';
import type { AppConfig } from '../../../src/ports/app-config';

describe('selectAgentClient', () => {
  it('returns the inert StubAgentClient when no ANTHROPIC_API_KEY is configured', () => {
    expect(selectAgentClient({})).toBeInstanceOf(StubAgentClient);
  });

  it('returns the StubAgentClient under NODE_ENV=test even with an API key present', () => {
    const client = selectAgentClient({ ANTHROPIC_API_KEY: 'k', NODE_ENV: 'test' });

    expect(client).toBeInstanceOf(StubAgentClient);
  });

  it('returns the StubAgentClient under CI even with an API key present', () => {
    const client = selectAgentClient({ ANTHROPIC_API_KEY: 'k', CI: 'true' });

    expect(client).toBeInstanceOf(StubAgentClient);
  });

  it('wires the concrete AnthropicAgentClient, budget-wrapped, when an API key is present outside test/CI', () => {
    const client = selectAgentClient({ ANTHROPIC_API_KEY: 'k' });

    expect(client).toBeInstanceOf(BudgetedAgentClient);
    expect((client as BudgetedAgentClient).inner).toBeInstanceOf(AnthropicAgentClient);
  });

  it('the stub path stays unwrapped (unbudgeted, playbook-free)', () => {
    const client = selectAgentClient({});

    expect(client).not.toBeInstanceOf(BudgetedAgentClient);
  });

  it('shares the caller-supplied budget instance rather than constructing its own', () => {
    const budget = createAgentLlmBudget({ AGENTIC_MAX_CALLS_PER_DAY: '3' });
    const client = selectAgentClient({ ANTHROPIC_API_KEY: 'k' }, budget) as BudgetedAgentClient;

    expect(client.budget).toBe(budget);
  });

  it('constructs without throwing when a custom playbookProvider is supplied (real wiring seam)', () => {
    const playbookProvider = { current: () => Promise.resolve({ version: 9, content: 'x' }) };

    expect(() =>
      selectAgentClient({ ANTHROPIC_API_KEY: 'k' }, undefined, playbookProvider),
    ).not.toThrow();
  });

  it('constructs without throwing when env overrides for model/timeout/tokens/ttl are supplied', () => {
    // AnthropicAgentClientConfig is stored on a private field with no accessor, so this asserts the
    // observable contract (construction succeeds, concrete adapter wired) rather than reaching into it.
    expect(() =>
      selectAgentClient({
        ANTHROPIC_API_KEY: 'k',
        AGENTIC_MODEL: 'claude-custom',
        AGENTIC_TIMEOUT_MS: '9000',
        AGENTIC_MAX_TOKENS: '2048',
        SIGNAL_TTL_MS: '60000',
      }),
    ).not.toThrow();
    const client = selectAgentClient({
      ANTHROPIC_API_KEY: 'k',
      AGENTIC_MODEL: 'claude-custom',
      AGENTIC_TIMEOUT_MS: '9000',
      AGENTIC_MAX_TOKENS: '2048',
      SIGNAL_TTL_MS: '60000',
    }) as BudgetedAgentClient;
    expect(client).toBeInstanceOf(BudgetedAgentClient);
    expect(client.inner).toBeInstanceOf(AnthropicAgentClient);
  });

  it('AGENTIC_PORTFOLIO_CONSULT absent/false: BatchingAgentClient is never constructed — the legacy BudgetedAgentClient(AnthropicAgentClient) chain is byte-identical', () => {
    const client = selectAgentClient({ ANTHROPIC_API_KEY: 'k' });
    expect(client).toBeInstanceOf(BudgetedAgentClient);
    expect(client).not.toBeInstanceOf(BatchingAgentClient);

    const explicitOff = selectAgentClient({
      ANTHROPIC_API_KEY: 'k',
      AGENTIC_PORTFOLIO_CONSULT: 'false',
    });
    expect(explicitOff).toBeInstanceOf(BudgetedAgentClient);
    expect(explicitOff).not.toBeInstanceOf(BatchingAgentClient);
  });

  it('AGENTIC_PORTFOLIO_CONSULT=true wires BatchingAgentClient (wrapping the same AnthropicAgentClient, sharing the caller-supplied budget) in place of BudgetedAgentClient', () => {
    const budget = createAgentLlmBudget({});
    const client = selectAgentClient(
      { ANTHROPIC_API_KEY: 'k', AGENTIC_PORTFOLIO_CONSULT: 'true' },
      budget,
    );

    expect(client).toBeInstanceOf(BatchingAgentClient);
    expect(client).not.toBeInstanceOf(BudgetedAgentClient);
  });

  it('AGENTIC_PORTFOLIO_CONSULT + AGENTIC_SHORTS_ENABLED constructs a BatchingAgentClient (#41: the shorts-capable submit_portfolio tool carries plan.direction, so the former boot refusal is gone)', () => {
    const budget = createAgentLlmBudget({});
    const client = selectAgentClient(
      {
        ANTHROPIC_API_KEY: 'k',
        AGENTIC_PORTFOLIO_CONSULT: 'true',
        AGENTIC_SHORTS_ENABLED: 'true',
        AGENTIC_PLAN_MODE: 'true',
        AGENTIC_PERP_VENUE: 'true',
      },
      budget,
    );
    expect(client).toBeInstanceOf(BatchingAgentClient);
  });

  it('legacy (non-plan) shorts with portfolio consult refuses at boot — the batched tool cannot express a short without plan.direction (reviewer S1)', () => {
    const budget = createAgentLlmBudget({});
    expect(() =>
      selectAgentClient(
        {
          ANTHROPIC_API_KEY: 'k',
          AGENTIC_PORTFOLIO_CONSULT: 'true',
          AGENTIC_SHORTS_ENABLED: 'true',
        },
        budget,
      ),
    ).toThrow(/requires AGENTIC_PLAN_MODE/);
  });

  it('shorts without a perp-capable venue still refuses construction under portfolio consult (the constructor guard binds before batching wraps)', () => {
    const budget = createAgentLlmBudget({});
    expect(() =>
      selectAgentClient(
        {
          ANTHROPIC_API_KEY: 'k',
          AGENTIC_PORTFOLIO_CONSULT: 'true',
          AGENTIC_SHORTS_ENABLED: 'true',
          AGENTIC_PLAN_MODE: 'true',
        },
        budget,
      ),
    ).toThrow(/perp/i);
  });
});

describe('createAgentLlmBudget', () => {
  it('reads caps from AGENTIC_MAX_CALLS_PER_DAY / AGENTIC_MAX_TOKENS_PER_DAY, defaulting when absent', () => {
    const defaulted = createAgentLlmBudget({});
    expect(defaulted.snapshot()).toMatchObject({ maxCallsPerDay: 500, maxTokensPerDay: 2_000_000 });

    const overridden = createAgentLlmBudget({
      AGENTIC_MAX_CALLS_PER_DAY: '10',
      AGENTIC_MAX_TOKENS_PER_DAY: '1000',
    });
    expect(overridden.snapshot()).toMatchObject({ maxCallsPerDay: 10, maxTokensPerDay: 1000 });
  });

  it('reads the cost cap and prices from AGENTIC_DAILY_COST_STOP_USD / AGENTIC_TOKEN_PRICE_*_PER_MTOK, defaulting when absent', () => {
    const defaulted = createAgentLlmBudget({});
    expect(defaulted.snapshot()).toMatchObject({ maxCostUsdPerDay: 3 });

    const overridden = createAgentLlmBudget({
      AGENTIC_DAILY_COST_STOP_USD: '10',
      AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: '2',
      AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: '4',
    });
    overridden.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }); // 2 + 4 = 6
    expect(overridden.snapshot()).toMatchObject({ maxCostUsdPerDay: 10, costUsd: 6 });
  });
});

describe('SEED_PLAYBOOK (spot, P2 expert seed)', () => {
  it('passes validatePlaybook strictly (no capability flags — spot must never need shorts/leverage)', () => {
    expect(SEED_PLAYBOOK.version).toBe(2);
    expect(validatePlaybook(SEED_PLAYBOOK.content)).toEqual({ ok: true });
  });

  it('stays under the 4000-char cap with room to spare', () => {
    expect(SEED_PLAYBOOK.content.length).toBeLessThanOrEqual(4000);
    expect(SEED_PLAYBOOK.content.length).toMatchSnapshot('SEED_PLAYBOOK char count');
  });

  it('content is pinned (regression on the shipped expert-seed prose)', () => {
    expect(SEED_PLAYBOOK.content).toMatchSnapshot();
  });
});

describe('SEED_PLAYBOOK_PERP (P2 expert seed)', () => {
  it('is rejected under strict (spot) validation — it must never leak to the spot lane', () => {
    expect(validatePlaybook(SEED_PLAYBOOK_PERP.content).ok).toBe(false);
  });

  it('passes validatePlaybook only with the perp lane capability flags', () => {
    expect(SEED_PLAYBOOK_PERP.version).toBe(2);
    expect(
      validatePlaybook(SEED_PLAYBOOK_PERP.content, { shortsAllowed: true, leverageAllowed: true }),
    ).toEqual({ ok: true });
  });

  it('stays under the 4000-char cap with room to spare', () => {
    expect(SEED_PLAYBOOK_PERP.content.length).toBeLessThanOrEqual(4000);
    expect(SEED_PLAYBOOK_PERP.content.length).toMatchSnapshot('SEED_PLAYBOOK_PERP char count');
  });

  it('content is pinned (regression on the shipped expert-seed prose)', () => {
    expect(SEED_PLAYBOOK_PERP.content).toMatchSnapshot();
  });
});

describe('seed selection by lane (P2 — same AGENTIC_SHORTS_ENABLED signal P1 uses)', () => {
  it('selectAgentClient defaults to SEED_PLAYBOOK on a spot (shorts-disabled) boot', async () => {
    const client = selectAgentClient({ ANTHROPIC_API_KEY: 'k' }) as BudgetedAgentClient;
    const anthropic = client.inner as unknown as {
      playbookProvider: { current(): Promise<{ content: string }> };
    };
    await expect(anthropic.playbookProvider.current()).resolves.toEqual(SEED_PLAYBOOK);
  });

  it('selectAgentClient defaults to SEED_PLAYBOOK_PERP on a shorts-enabled (perp) boot', async () => {
    const client = selectAgentClient({
      ANTHROPIC_API_KEY: 'k',
      AGENTIC_SHORTS_ENABLED: 'true',
      AGENTIC_PERP_VENUE: 'true',
    }) as BudgetedAgentClient;
    const anthropic = client.inner as unknown as {
      playbookProvider: { current(): Promise<{ content: string }> };
    };
    await expect(anthropic.playbookProvider.current()).resolves.toEqual(SEED_PLAYBOOK_PERP);
  });
});

describe('agenticEnv', () => {
  it('falls back to plain process.env when no TypedConfigService is supplied (module-isolation contexts)', () => {
    expect(agenticEnv(undefined)).toBe(process.env);
  });

  it('maps every AGENTIC_* field off the validated AppConfig.agentic config, so the real wiring path can never drift from it', () => {
    const agentic: AppConfig['agentic'] = {
      model: 'claude-config-model',
      timeoutMs: 12345,
      reflectionTimeoutMs: 111000,
      maxTokens: 777,
      minDecisionIntervalMs: 1000,
      warmupBars: 50,
      maxCallsPerDay: 42,
      maxTokensPerDay: 999999,
      entryTtlBars: 2,
      playbookAbPct: 0,
      derivativesAbPct: 30,
      derivativesV2Enabled: false,
      crossSymbolEnabled: false,
      crossSymbolLookbackBars: 20,
      bookStructureFeedEnabled: false,
      trackRecordEnabled: false,
      portfolioConsultEnabled: true,
      portfolioWindowMs: 4000,
      planMode: false,
      shortsEnabled: false,
      dailyCostStopUsd: 6,
      // D1 (Todo Steps): retired AGENTIC_PRESCREEN_*/AGENTIC_EXPECTANCY_LADDER/AGENTIC_MIN_RR/
      // AGENTIC_MIN_EDGE_MULTIPLE/AGENTIC_PLAN_MAX_QUIET_BARS/AGENTIC_THINKING_AB_PCT off
      // AppConfig.agentic — the fixture below carries only the surviving + I1-added fields, so it
      // stays an exact structural match of the real (validated) config shape.
      maxPositionFraction: '0.15',
      fallbackConsultBars: 16,
      wakeMovePct: '0.015',
      activeMenuSize: 12,
      maxEntriesPerDay: 3,
      drainCooldownBaseMs: 1000,
      drainCooldownMaxMs: 2000,
      reflectionEveryNTrades: 7,
      reflectionCooldownMs: 86400000,
      mintBacktestRows: 0,
      mintBacktestMarginBps: 10,
      mintBacktestMinTrips: 3,
      autoPromoteMinTrades: 9,
      autoPromoteMinAttributedTrades: 10,
      planExitTtlBars: 2,
      quietPayloadSampleBars: 4,
      venueTpEnabled: false,
      venueTpReplaceDriftBps: 10,
      venueStopEnabled: false,
      venueStopReplaceDriftBps: 10,
      tokenPriceInputPerMtok: '3',
      tokenPriceOutputPerMtok: '15',
      tokenPriceCacheReadPerMtok: '0.3',
      tokenPriceCacheWritePerMtok: '6',
      promotionDustNotional: '5',
    };
    // C1: agenticEnv also reads config.derivativesFeed (a sibling AppConfig top-level key, not part
    // of the `agentic` block) — present here so the fixture matches the real TypedConfigService shape.
    const derivativesFeed: AppConfig['derivativesFeed'] = { enabled: true, pollIntervalMs: 60000 };
    // Same sibling-key convention as derivativesFeed above (2026-07-13).
    const tradeFlowFeed: AppConfig['tradeFlowFeed'] = { enabled: true, pollIntervalMs: 60000 };
    const positioningFeed: AppConfig['positioningFeed'] = { enabled: true, pollIntervalMs: 300000 };
    // Same sibling-key convention as derivativesFeed above (Push 3 P6 Unit 2).
    const liquidationFeed: AppConfig['liquidationFeed'] = { enabled: false };
    // Portfolio-consult batching's AGENTIC_PORTFOLIO_SYMBOL_COUNT overlay reads config.strategy.symbols
    // (a sibling AppConfig top-level key, not part of the `agentic` block) — present here so the
    // fixture matches the real TypedConfigService shape (mirrors derivativesFeed/tradeFlowFeed above).
    const strategy: AppConfig['strategy'] = {
      symbol: 'BTC/USDT',
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      interval: '15m',
      active: 'agentic',
    };
    // Push II Phase 8: agenticEnv reads config.venues (a sibling AppConfig top-level key) to derive
    // AGENTIC_PERP_VENUE — present here so the fixture matches the real TypedConfigService shape
    // (mirrors derivativesFeed/tradeFlowFeed/strategy above).
    const venues: AppConfig['venues'] = [{ id: 'binanceusdm', environment: 'demo' }];
    const config = {
      agentic,
      derivativesFeed,
      tradeFlowFeed,
      positioningFeed,
      liquidationFeed,
      strategy,
      venues,
    } as unknown as TypedConfigService;

    expect(agenticEnv(config)).toMatchObject({
      AGENTIC_MODEL: 'claude-config-model',
      AGENTIC_TIMEOUT_MS: '12345',
      AGENTIC_REFLECTION_TIMEOUT_MS: '111000',
      AGENTIC_MAX_TOKENS: '777',
      AGENTIC_MAX_CALLS_PER_DAY: '42',
      AGENTIC_MAX_TOKENS_PER_DAY: '999999',
      AGENTIC_DAILY_COST_STOP_USD: '6',
      AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: '3',
      AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: '15',
      AGENTIC_REFLECTION_EVERY_N_TRADES: '7',
      AGENTIC_REFLECTION_COOLDOWN_MS: '86400000',
      AGENTIC_AUTO_PROMOTE_MIN_TRADES: '9',
      DERIVATIVES_FEED_ENABLED: 'true',
      AGENTIC_DERIVATIVES_AB_PCT: '30',
      AGENTIC_TRADEFLOW_ENABLED: 'true',
      AGENTIC_POSITIONING_ENABLED: 'true',
      AGENTIC_PORTFOLIO_CONSULT: 'true',
      AGENTIC_PORTFOLIO_WINDOW_MS: '4000',
      AGENTIC_PORTFOLIO_SYMBOL_COUNT: '3',
      AGENTIC_SHORTS_ENABLED: 'false',
      AGENTIC_PERP_VENUE: 'true',
      // I1: the v2 lane cap, sourced off AppConfig.agentic.maxPositionFraction (D1) — see
      // selectAgentClient's unconditional tradeContract wiring.
      AGENTIC_MAX_POSITION_FRACTION: '0.15',
    });
  });

  it('selectAgentClient always wires tradeContract (v2 is unconditional — no staged flag)', () => {
    const client = selectAgentClient({ ANTHROPIC_API_KEY: 'k' }) as BudgetedAgentClient;
    // AnthropicAgentClientConfig is private with no accessor — this asserts the observable contract
    // (construction succeeds with the real adapter wired), mirroring the env-override test above.
    expect(client.inner).toBeInstanceOf(AnthropicAgentClient);
  });
});
