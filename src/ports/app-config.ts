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
  // v3 §3.1/§6.1: fixed wallet split of the one book (VENUE_CAPITAL_SPLIT), keyed by venue id,
  // decimal-string shares. Cross-field-validated at construction (key-set exactly equals `venues`'
  // ids once venues is non-empty; every share positive; Σ shares ≤ risk.equityCap unless the cap is
  // disabled) — see environment.config.ts's validate(). Workstream #5's VenueRegistryModule builds
  // its VENUE_REGISTRY map's capitalShare field off this record.
  venueCapitalSplit: Readonly<Record<string, string>>;
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
    // v3-transitional(#8,#10): AGENTIC_MAX_POSITION_FRACTION is renamed to
    // maxPositionFractionSpot/maxPositionFractionPerp below (§3.3). risk.module.ts and
    // agentic-strategy.module.ts/reflection.service.ts still read this single field as their
    // lane-wide sizeFraction cap; environment.config.ts derives it from maxPositionFractionSpot
    // until those workstreams consume the per-venue-class fields directly.
    maxPositionFraction: string;
    // v3 §3.1/§3.3: upper bound on sizeFraction (the model's conviction channel), injected into both
    // the trade-tool description and the client's zod schema (S3) — per-venue-class cap, now
    // enforced per-symbol via the payload's capabilities.maxSizeFraction (§4.2) rather than per-lane.
    maxPositionFractionSpot: string;
    maxPositionFractionPerp: string;
    // v2 consult scheduler (B2): floor cadence — a re-consult fires at least this often even if the
    // model's own nextConsultBars requested a longer gap, so a stuck/quiet basket never goes dark.
    fallbackConsultBars: number;
    // v2 consult scheduler (B2): wake-on-move fraction — a bar-close move against the last consult
    // price beyond this forces an immediate re-consult regardless of schedule.
    wakeMovePct: string;
    // Universe (U1): top-N ranking size the deterministic scanner selects daily as the active menu
    // batched into consults; bounded <= the configured symbol count (environment.config.ts's
    // superRefine refuses a wider menu than the basket it ranks from).
    activeMenuSize: number;
    maxEntriesPerDay: number;
    drainCooldownBaseMs: number;
    drainCooldownMaxMs: number;
    reflectionEveryNTrades: number;
    reflectionCooldownMs: number;
    // Mint-time candidate-vs-champion offline expectancy backtest (reflection.service.ts's
    // runMintBacktest): rows of the newest recorded decisions replayed against BOTH the draft
    // candidate and the current champion playbook, simulating each 'long' plan's outcome. 0 disables
    // (default; the actual reflection wiring reads this off raw process.env, not this field — see
    // environment.config.ts's own comment).
    mintBacktestRows: number;
    // Noise handicap (bps): the candidate mints unless its mean net bps/trip trails the champion's
    // by MORE than this (candidate >= champion − margin passes).
    mintBacktestMarginBps: number;
    // Minimum simulated round trips BOTH arms need before the backtest verdict is trusted.
    mintBacktestMinTrips: number;
    // v3-transitional(#10): AGENTIC_AUTO_PROMOTE_MIN_TRADES is deleted (§3.4) — the legacy
    // count-only auto-promotion path is permanently superseded by autoPromoteMinAttributedTrades
    // below. reflection.service.ts/agentic-strategy.module.ts still read this field;
    // environment.config.ts hardcodes 0 (disabled).
    autoPromoteMinTrades: number;
    // Absent means unpinned.
    playbookPin?: number;
    // W4.1 champion/candidate A/B: percent (0-50) of decides deterministically routed to a newer
    // INACTIVE reflection-minted candidate instead of ACTIVE. 0 disables (default).
    playbookAbPct: number;
    // v3-transitional(#10): AGENTIC_DERIVATIVES_AB_PCT is deleted (§3.4, XA3 decision record — the
    // information-context control arm is retired at 0 for good: treatment drove 8.4% vs 1.9%
    // proposes). anthropic-agent-client.ts/agentic-strategy.module.ts still read this field;
    // environment.config.ts hardcodes 0.
    derivativesAbPct: number;
    // d2 (Push 3 P6 Unit 1): switches the derivatives block/sentence/promptHash tag from d1 to d2,
    // surfacing three fields the feed already accumulates (spot-perp basis, OI percent change,
    // funding trend). Inert unless derivativesFeed.enabled is also true. Default false ⇒ byte-
    // identical d1 behavior. ENABLING MID-FACTORIAL IS FORBIDDEN (see environment.config.ts's
    // AGENTIC_DERIVATIVES_V2_ENABLED comment) — d1/d2 rows are not cross-comparable.
    derivativesV2Enabled: boolean;
    // Cross-symbol relative-strength context (2026-07-12): when true, the model sees where its symbol
    // ranks by trailing return within the basket (cross-symbol-context.ts). Gated together with the
    // derivatives block under the information-context A/B (derivativesAbPct).
    crossSymbolEnabled: boolean;
    crossSymbolLookbackBars: number;
    // Book-structure block (Push 3 P6 Unit 3): microprice/depth-weighted-imbalance/depth-notional,
    // computed from the already-streaming order book — no new feed, no A/B interaction. Default
    // false ⇒ byte-identical.
    bookStructureFeedEnabled: boolean;
    // Track-record block (Push 3 P6 Unit 4, #17 residual): surfaces this strategy's own realized
    // tripCount/winRate/meanNetBpsPerTrip/trailingWindowTrips over the same trailing window the
    // expectancy ladder computes from. Inert without a RoundTripEvidencePort wired. No A/B
    // interaction. Default false ⇒ byte-identical.
    trackRecordEnabled: boolean;
    // Portfolio-consult batching (Push II Phase 5, DESIGN Task 2): coalesces concurrent single-symbol
    // decide() calls landing within one window into ONE Anthropic call (BatchingAgentClient,
    // submit_portfolio). Off by default — BatchingAgentClient is not even constructed unconfigured.
    portfolioConsultEnabled: boolean;
    // Coalescing window (ms). Inert unless portfolioConsultEnabled is true.
    portfolioWindowMs: number;
    // PromotionReadinessService LLM-cost math: USD per 1M tokens, operator-adjustable.
    tokenPriceInputPerMtok: string;
    tokenPriceOutputPerMtok: string;
    // Residual-position notional (quote ccy) below which a round-trip cycle counts as CLOSED.
    promotionDustNotional: string;
    // W3.1 plan-based trading: LLM emits a full trade plan; plan-executor.ts manages it
    // deterministically between consults. Off by default; enabling gated on offline A/B + owner.
    planMode: boolean;
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
    // AGENTIC_VENUE_TP: rests the plan's take-profit at the venue (reduce-only EXIT_LONG,
    // exitStyle RESTING) instead of waiting for plan-executor's own close-price crossing to fire an
    // IOC exit. Off by default — byte-identical to pre-feature until enabled (agentic.strategy.ts's
    // manageVenueTp).
    venueTpEnabled: boolean;
    // Re-place threshold (bps): a resting TP SELL priced more than this many bps from the plan's
    // current TP price gets cancelled this bar for next-bar re-placement.
    venueTpReplaceDriftBps: number;
    // Push 3 P7d (AGENTIC_VENUE_STOP): rests the plan's protective stop at the venue (SPOT:
    // STOP_LOSS_LIMIT on the regular open-orders rail; PERP: STOP_MARKET on the swap algo/
    // conditional rail) instead of relying solely on plan-executor's own bar-close stop-price
    // crossing. Off by default — byte-identical to pre-feature until enabled
    // (agentic.strategy.ts's manageVenueStop). Independent of venueTpEnabled and of
    // risk.planStopWatchEnabled below.
    venueStopEnabled: boolean;
    // Re-place threshold (bps), mirrors venueTpReplaceDriftBps above.
    venueStopReplaceDriftBps: number;
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
    // v3-transitional(#5,#10): AGENTIC_SHORTS_ENABLED is deleted (§3.4) — shorts is now a per-symbol
    // capability derived from venue presence (§4.2's capabilities.shorts), not a boot flag.
    // app.module.ts and agentic-strategy.module.ts still read this field as their perp-lane
    // selector; environment.config.ts derives it as `venues.some(v => v.id === 'binanceusdm')`.
    shortsEnabled: boolean;
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
    // $1k-book economics (D1, Design § Live-scale economics): sizing equity = min(actualEquity,
    // this cap) on every sizer path. v3 §3.2: DEFAULTED to '1000' (was optional/uncapped) — the
    // validated schema always supplies a value now; explicit '0' still disables the cap
    // (position-sizer.service.ts's cappedEquity treats a non-positive cap as pass-through). Stays
    // optional in this port type only for module-isolation callers that hand-build a partial config.
    equityCap?: string;
    // ProtectiveExitService (bot-side stop-loss/trailing-stop backstop): fraction below avgEntry
    // (stop) / the ratcheted high-water mark (trailing) that force-exits a long. '0' disables each
    // independently.
    protectStopLossPct: string;
    protectTrailingPct: string;
    // Plan-stop watcher (Push 3 P2): default false — the 1s protective tick never consults the
    // plan-stop registry (ports/risk.ts's PlanStopRegistryPort), byte-identical to pre-feature.
    // Rollback = flip back to false.
    planStopWatchEnabled: boolean;
    // Force-fire threshold (bps) for a registry entry whose venueStopResting is true — see
    // ports/risk.ts's ProtectiveExitConfig.planStopForceBps for the full rationale.
    planStopForceBps: number;
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
    // P2 passive-exit override (domain/risk/limits.ts): reduce-only intents priced on the passive
    // side of ref (resting take-profits) check against this wider band instead of maxBandBps.
    maxPassiveExitBandBps: number;
    // P7b protective-stop trigger checks (domain/risk/evaluate.ts): a trigger order's |trigger −
    // mid| / mid must be ≤ this (basis points).
    maxStopTriggerBandBps: number;
    // P7b: bps a spot STOP_LOSS_LIMIT's limit leg sits past its own trigger (PositionSizerService),
    // and the sanity tolerance (×2) evaluate.ts's T3 check enforces on that leg.
    stopLimitBufferBps: number;
    staleMaxAgeMs: number;
  };
  // Perp/swap paper adapter knobs (B1) + entry-sizing knob (B2, position-sizer's perp branch).
  // PERP_VENUE_ENABLED (the old `enabled` field) is DELETED (§3.4) — venue presence in VENUES is
  // the signal now, and the field had no consumer outside environment.config.ts itself.
  perp: {
    leverageCap: string;
    mmrFallback: string;
    // B2: required liquidation-price buffer (fraction) a perp entry must clear — see
    // domain/risk/perp-sizing.ts's liqSafeNotionalCap.
    liqBufferPct: string;
  };
  // C1: read-only public derivatives-data feed (funding rate, open interest, mark/index basis) —
  // feature-flagged OFF by default. Off ⇒ zero behavior change (no poll starts, the agentic prompt's
  // derivatives block never renders).
  derivativesFeed: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  // P5b: perp funding-payment settlement ingestion (funding-ingest.service.ts) — feature-flagged OFF
  // by default. Off ⇒ zero behavior change (no poll starts, funding_payments never gains a writer,
  // promotion's fundingNet stays 0). Only ever effective on the perp venue (binanceusdm) — spot/paper
  // adapters have no ExchangePort.fetchFundingPayments and the composition root no-ops.
  fundingIngest: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  // C4: read-only free news/sentiment feed (headlines only) — feature-flagged OFF by default.
  // Off ⇒ zero behavior change (no poll starts, the agentic prompt's sentiment block never renders).
  // The API key is NOT carried here (see environment.config.ts's SENTIMENT_FEED_API_KEY comment) —
  // read directly off process.env at the composition root, same convention as ANTHROPIC_API_KEY.
  sentimentFeed: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  // X3a: read-only Crypto Fear & Greed Index (alternative.me) — feature-flagged OFF by default, same
  // zero-behavior-change convention as sentimentFeed above. No API key (a public endpoint), lane-wide
  // (not per-symbol) — see fear-greed-feed.ts's own header comment.
  fearGreedFeed: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  // Trade-flow/CVD context (taker aggressor imbalance) — feature-flagged OFF by default, same
  // zero-behavior-change convention as derivativesFeed above. Rides the SAME information-context A/B
  // control arm as derivativesFeed/crossSymbol (agentic.derivativesAbPct).
  tradeFlowFeed: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  // Positioning context (global long/short account ratio) — feature-flagged OFF by default, same
  // zero-behavior-change convention as derivativesFeed above. Rides the SAME information-context A/B
  // control arm as derivativesFeed/crossSymbol (agentic.derivativesAbPct). REST-poll liquidation-order
  // flow is NOT part of this config (no public REST source exists in ccxt 4.5.58, see
  // positioning-feed.ts's header comment) — a WS-based liquidation feed is shipped separately below.
  positioningFeed: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  // #43 (Push 3 P6 Unit 2): public liquidation-order flow via ccxt PRO's watchLiquidationsForSymbols
  // WS stream — feature-flagged OFF by default, same zero-behavior-change convention as
  // derivativesFeed above. No pollIntervalMs (WS-driven, not REST-polled).
  liquidationFeed: {
    enabled: boolean;
  };
  // Order-book memory bound (normalize.ts's normalizeBook, threaded via MarketDataService): a
  // percent-of-mid band filter plus a hard per-side level cap, applied to the raw ccxt float arrays
  // BEFORE any Decimal is constructed. 0 disables either bound independently — an unconfigured
  // deployment (both non-zero defaults below) already gets the bound, unlike the feature-flag
  // convention elsewhere in this file, because this is a resource fix, not an opt-in behavior change.
  marketData: {
    bookBandBps: number;
    bookMaxLevels: number;
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
