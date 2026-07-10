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
    // Reflection-path request timeout. Separate from timeoutMs (the decide path): reflection runs a
    // pricier model (reflectionModel, e.g. Opus) with adaptive thinking over a large evidence prompt,
    // so it legitimately needs far longer than a fast decide — sharing the 30s decide timeout aborted
    // every attempt live (2026-07-09). Off the trading hot path, so a generous value costs nothing.
    reflectionTimeoutMs: number;
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
    // R:R structure floor (decimal string): reject plans whose takeProfitPct/stopLossPct ratio is
    // below this. Complements minEdgeMultiple, which floors only the win side — without a ratio
    // bound a plan may carry a stop smaller than the round-trip fee itself.
    minRr: string;
    // TTL (in bars) for plan-executor-emitted exit signals. Executor exits carry eventTime = the
    // evaluated bar's close, so a one-bar TTL races its own age by construction (observed live:
    // a max_hold exit expired at age 902.2s vs ttl 900s). Two bars gives jitter headroom; Risk's
    // own ref-price staleness veto is the freshness gate, this TTL is only replay protection.
    planExitTtlBars: number;
    // Attributed auto-promotion: candidate-attributed closed-trip floor before the promotion
    // evaluator may promote a reflection candidate to ACTIVE on evidence (candidate mean net/trip
    // beats champion). 0 disables the evaluator. Distinct from autoPromoteMinTrades, the legacy
    // count-only path this replaces.
    autoPromoteMinAttributedTrades: number;
    // Sample the decide-time input payload every Nth plan-managed (quiet) bar so the offline
    // replay harness accrues rows while plan mode manages positions. 0 disables sampling.
    quietPayloadSampleBars: number;
    // Cache-token pricing for the DEFAULT model (USD per 1M tokens, decimal strings): reads bill
    // at ~0.1x input, 1h-TTL writes at ~2x input. Priced $0 before W4/W13 — an undercount of true
    // spend inside a promotion gate (fail-open) — now first-class.
    tokenPriceCacheReadPerMtok: string;
    tokenPriceCacheWritePerMtok: string;
    // Per-model price override map (parsed from AGENTIC_TOKEN_PRICES_JSON). Keys are model ids;
    // absent models fall back to the flat tokenPrice* knobs above. Consumers pricing an UNKNOWN
    // model (present in rows, absent here and ≠ the default model) must use the most expensive
    // configured rates — the fail-closed direction.
    tokenPrices?: Readonly<
      Record<
        string,
        {
          readonly inputPerMtok: string;
          readonly outputPerMtok: string;
          readonly cacheReadPerMtok: string;
          readonly cacheWritePerMtok: string;
        }
      >
    >;
    // Owner-declared evidence epoch (ISO-8601): the promotion gate evaluates fills/tokens/window
    // from this instant instead of all-time. Absent ⇒ all-time (byte-identical legacy behavior).
    promotionEvidenceEpoch?: string;
  };
  // Risk-lane knobs read via ConfigService (mirrors the agentic block above).
  risk: {
    // Marketable-exit crossing buffer (bps) for reduce-only intents — see the schema comment.
    exitCrossBufferBps: number;
    // Entry order type (PositionSizerService). 'LIMIT' (default) is byte-identical to pre-knob
    // behavior. 'LIMIT_MAKER' rests entries post-only; the sizer falls back to 'LIMIT' per-intent
    // when the plan-derived entry price would cross the book (see the schema comment).
    entryOrderType: 'LIMIT' | 'LIMIT_MAKER';
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
  // Perp/swap paper adapter knobs (B1). PaperPerpAdapter is not wired into app.module.ts this
  // pass — enabled stays false so an unconfigured deployment sees zero behavior change; these
  // are scaffolding for the future composition-root wiring.
  perp: {
    enabled: boolean;
    leverageCap: string;
    mmrFallback: string;
  };
  // C1: read-only public derivatives-data feed (funding rate, open interest, mark/index basis) —
  // feature-flagged OFF by default. Off ⇒ zero behavior change (no poll starts, the agentic prompt's
  // derivatives block never renders).
  derivativesFeed: {
    enabled: boolean;
    pollIntervalMs: number;
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
