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
  // Agentic lane knobs, validated but not yet the read path (composition still reads process.env
  // directly; a later pass switches it to ConfigService against these exact fields).
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
    // Absent means unpinned.
    playbookPin?: number;
  };
  // Risk-lane knobs read via ConfigService (mirrors the agentic block above).
  risk: {
    // Marketable-exit crossing buffer (bps) for reduce-only intents — see the schema comment.
    exitCrossBufferBps: number;
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
