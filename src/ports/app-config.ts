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
