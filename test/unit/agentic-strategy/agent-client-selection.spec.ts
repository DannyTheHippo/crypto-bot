import { describe, it, expect } from 'vitest';
import type { TypedConfigService } from '../../../src/config/environment/typed-config.service';
import {
  selectAgentClient,
  createAgentLlmBudget,
  agenticEnv,
  SEED_PLAYBOOK,
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

describe('SEED_PLAYBOOK', () => {
  it('passes validatePlaybook (version 1)', () => {
    expect(SEED_PLAYBOOK.version).toBe(1);
    expect(validatePlaybook(SEED_PLAYBOOK.content)).toEqual({ ok: true });
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
      crossSymbolEnabled: false,
      crossSymbolLookbackBars: 20,
      portfolioConsultEnabled: true,
      portfolioWindowMs: 4000,
      expectancyLadderEnabled: false,
      planMode: false,
      minEdgeMultiple: '1.5',
      planMaxQuietBars: 16,
      dailyCostStopUsd: 6,
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
      minRr: '1.5',
      planExitTtlBars: 2,
      quietPayloadSampleBars: 4,
      venueTpEnabled: false,
      venueTpReplaceDriftBps: 10,
      tokenPriceInputPerMtok: '3',
      tokenPriceOutputPerMtok: '15',
      tokenPriceCacheReadPerMtok: '0.3',
      tokenPriceCacheWritePerMtok: '6',
      promotionDustNotional: '5',
      prescreenEnabled: true,
      prescreenVolShortBars: 10,
      prescreenVolLongBars: 50,
      prescreenVolRatio: 1.3,
      prescreenBreakoutLookbackBars: 20,
      prescreenBreakoutPct: 0.005,
    };
    // C1: agenticEnv also reads config.derivativesFeed (a sibling AppConfig top-level key, not part
    // of the `agentic` block) — present here so the fixture matches the real TypedConfigService shape.
    const derivativesFeed: AppConfig['derivativesFeed'] = { enabled: true, pollIntervalMs: 60000 };
    // Same sibling-key convention as derivativesFeed above (2026-07-13).
    const tradeFlowFeed: AppConfig['tradeFlowFeed'] = { enabled: true, pollIntervalMs: 60000 };
    const positioningFeed: AppConfig['positioningFeed'] = { enabled: true, pollIntervalMs: 300000 };
    // Portfolio-consult batching's AGENTIC_PORTFOLIO_SYMBOL_COUNT overlay reads config.strategy.symbols
    // (a sibling AppConfig top-level key, not part of the `agentic` block) — present here so the
    // fixture matches the real TypedConfigService shape (mirrors derivativesFeed/tradeFlowFeed above).
    const strategy: AppConfig['strategy'] = {
      symbol: 'BTC/USDT',
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      interval: '15m',
      active: 'agentic',
    };
    const config = {
      agentic,
      derivativesFeed,
      tradeFlowFeed,
      positioningFeed,
      strategy,
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
    });
  });
});
