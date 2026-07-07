export type { TradingMode } from '../domain/types/mode';

export type VenueEnvironment = 'paper' | 'testnet' | 'demo' | 'live';

export interface VenueConfig {
  readonly id: string;
  readonly environment: VenueEnvironment;
  readonly baseUrlOverride?: string;
}

export interface AppConfig {
  app: {
    port: number;
    bootId: string;
  };
  mode: {
    requestedMode: string;
    configMode: import('../domain/types/mode').TradingMode;
    // §3.5 sandbox flavor selected when configMode is testnet: 'testnet' (setSandboxMode,
    // purpose-built integration sandbox) or 'demo' (enableDemoTrading, live-mirroring dress
    // rehearsal). Each flavor uses its own non-interchangeable keys. Inert in paper/live.
    sandboxEnv: 'testnet' | 'demo';
    downgrades: string[];
  };
  observability: {
    logLevel: string;
  };
  db: {
    url: string | undefined;
  };
  venues: readonly VenueConfig[];
  // Agentic lane knobs, read off ConfigService at the composition root (agenticEnv overlay in
  // agentic-strategy.module.ts).
  agentic: {
    model: string;
    // Reflection-path model override; absent ⇒ reflection uses `model` (one model, one price —
    // pinning a pricier model requires raising AGENTIC_TOKEN_PRICE_* to its rates, fail-closed).
    reflectionModel?: string;
    timeoutMs: number;
    maxTokens: number;
    minDecisionIntervalMs: number;
    warmupBars: number;
    maxCallsPerDay: number;
    maxTokensPerDay: number;
    // Daily USD cost circuit breaker (agent-budget.ts's DailyLlmBudget), priced off
    // tokenPriceInputPerMtok/tokenPriceOutputPerMtok below. 0 disables it.
    dailyCostStopUsd: number;
    // W2.1 stale-entry sweep TTL in observed decide cycles; 0 disables.
    entryTtlBars: number;
    maxEntriesPerDay: number;
    drainCooldownBaseMs: number;
    drainCooldownMaxMs: number;
    reflectionEveryNTrades: number;
    reflectionCooldownMs: number;
    // Cumulative closed-trade floor before a reflection candidate auto-promotes (G4b); 0 disables.
    autoPromoteMinTrades: number;
    // Absent means unpinned.
    playbookPin?: number;
    // W4.1 champion/candidate A/B: percent (0-50) of decides deterministically routed to a newer
    // INACTIVE reflection-minted candidate instead of ACTIVE. 0 disables (default).
    playbookAbPct: number;
    // PromotionReadinessService LLM-cost math: USD per 1M tokens, operator-adjustable.
    tokenPriceInputPerMtok: string;
    tokenPriceOutputPerMtok: string;
    // Residual-position notional (quote ccy) below which a round-trip cycle counts as CLOSED.
    promotionDustNotional: string;
    // Cost-floor pre-screen gate: consulted before each LLM call so a quiet market never burns a
    // token spend on a call the agent was always going to pass on.
    prescreenEnabled: boolean;
    prescreenVolShortBars: number;
    prescreenVolLongBars: number;
    prescreenVolRatio: number;
    prescreenBreakoutLookbackBars: number;
    prescreenBreakoutPct: number;
    // W4.2 expectancy-laddered strength modulation: reduction-only ENTER_LONG strength scaling keyed
    // to this strategy's rolling realized net expectancy. Default false — inert regardless of the
    // knob unless AgenticStrategyDeps also carries a RoundTripEvidencePort (see agentic.strategy.ts).
    expectancyLadderEnabled: boolean;
    // W3.1 plan-based trading: LLM emits a full trade plan; plan-executor.ts manages it
    // deterministically between consults. Off by default; enabling gated on offline A/B + owner.
    planMode: boolean;
    // Fee-aware plan viability floor (decimal string): reject plans whose takeProfitPct is below
    // multiple × round-trip fee fraction.
    minEdgeMultiple: string;
    // Safety re-consult cadence (bars) while a plan is active without executor action.
    planMaxQuietBars: number;
  };
  // Risk-lane knobs read via ConfigService (mirrors the agentic block above).
  risk: {
    // Marketable-exit crossing buffer (bps) for reduce-only intents — see the schema comment.
    exitCrossBufferBps: number;
    // Quote-currency (USDT) notional per order, sized below the account balance / above minNotional.
    baseNotional: string;
    // Compounding position sizing (P5): fraction of equity sized per entry (0..1). '0' disables —
    // PositionSizerService falls back to the legacy baseNotional × strength path.
    equityFraction: string;
    // ProtectiveExitService (bot-side stop-loss/trailing-stop backstop): fraction below avgEntry
    // (stop) / the ratcheted high-water mark (trailing) that force-exits a long. '0' disables each
    // independently.
    protectStopLossPct: string;
    protectTrailingPct: string;
    // RiskLimitsConfig overlay knobs (domain/risk/limits.ts) — RiskModule merges these onto its
    // DEFAULT_LIMITS hardcoded fallback. maxDriftBps has no env knob (not part of this pass); it
    // stays hardcoded in DEFAULT_LIMITS.
    maxOrderNotional: string;
    maxPositionPerSymbol: string;
    maxGrossExposure: string;
    maxNetExposure: string;
    maxDailyLoss: string;
    maxDrawdownPct: string;
    maxBandBps: number;
    staleMaxAgeMs: number;
  };
  // Strategy-lane knobs (symbol/interval/active lane selection) read via ConfigService.
  strategy: {
    // Deprecated single-symbol knob; still honored as the fallback when TRADING_SYMBOLS is unset.
    symbol: string;
    // Multi-symbol (P7): one agentic strategy instance per entry; always non-empty.
    symbols: string[];
    interval: string;
    active: 'agentic';
  };
  // §10 live-mode secrets — present ONLY when the process did not boot under NODE_ENV=test/ci
  // (the schema strips them otherwise; CI has no in-code path that reaches a live credential).
  // Excluded from configHash by canonicalJsonWithoutSecrets. Read solely inside the live-adapter
  // factory + ModeControl at the composition root; never logged (pino redact).
  liveApiKey?: string;
  liveApiSecret?: string;
  armingSecret?: string;
  liveBaseUrlOverride?: string;
  configHash: string;
}
