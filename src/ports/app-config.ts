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
    timeoutMs: number;
    maxTokens: number;
    minDecisionIntervalMs: number;
    warmupBars: number;
    maxCallsPerDay: number;
    maxTokensPerDay: number;
    maxEntriesPerDay: number;
    drainCooldownBaseMs: number;
    drainCooldownMaxMs: number;
    reflectionEveryNTrades: number;
    reflectionCooldownMs: number;
    // Cumulative closed-trade floor before a reflection candidate auto-promotes (G4b); 0 disables.
    autoPromoteMinTrades: number;
    // Absent means unpinned.
    playbookPin?: number;
    // PromotionReadinessService LLM-cost math: USD per 1M tokens, operator-adjustable.
    tokenPriceInputPerMtok: string;
    tokenPriceOutputPerMtok: string;
    // Residual-position notional (quote ccy) below which a round-trip cycle counts as CLOSED.
    promotionDustNotional: string;
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
    symbol: string;
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
