import {
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import path from 'node:path';
import Decimal from 'decimal.js';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { ObservabilityModule } from '../../common/observability/observability.module';
import { RiskModule } from '../risk/risk.module';
import { ExecutionModule } from '../execution/execution.module';
import { ModeControlModule } from '../mode-control/mode-control.module';
import { ModeControlService } from '../mode-control/mode-control.service';
import { SignalSinkService, SIGNAL_REJECTIONS_COUNTER } from '../execution/signal-sink.service';
import { HaltCoordinatorService } from '../execution/halt-coordinator.service';
import { ProtectiveExitService, PROTECTIVE_EXITS_COUNTER } from '../risk/protective-exit.service';
import { PlanStopRegistryService } from '../risk/plan-stop-registry.service';
import { UnknownResolverService } from '../execution/unknown-resolver.service';
import { ReconciliationService } from '../execution/reconciliation.service';
import { EquitySamplerService } from '../execution/equity-sampler.service';
import { BootRecoveryService } from '../execution/boot-recovery.service';
import { DemoFillPollerService } from '../execution/demo-fill-poller.service';
import { AlgoStopRecoveryService } from '../execution/algo-stop-recovery.service';
import { StrategyRegistry } from '../agentic/strategy-registry';
import { StrategyHost } from '../agentic/strategy-host';
import {
  AgenticStrategyModule,
  AGENT_LLM_BUDGET,
  PLAYBOOK_PROVIDER_OVERRIDE,
  ACTIVE_MENU_GATE_OVERRIDE,
  REFLECTION_SERVICE,
  agenticEnv,
} from '../agentic/agentic-strategy.module';
import type { DailyLlmBudget } from '../agentic/agent-budget';
import { buildAgentPortfolioBlock } from '../agentic/agent-portfolio-block';
import { loadMacroCalendar, filterUpcoming } from '../agentic/macro-calendar';
import {
  createPromotionEvaluator,
  PromotionEvaluator,
  type EvaluatorPlaybookStore,
} from '../agentic/promotion-evaluator';
import { ReflectionService } from '../agentic/reflection.service';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
} from '../agentic/agentic.strategy';
import { CrossSymbolContextService } from '../agentic/cross-symbol-context';
import { UniverseScannerService } from '../agentic/universe-scanner.service';
import { PriceHistoryStore } from '../agentic/price-history-store';
import { assertAgenticLaneNotLive } from '../agentic/agentic-live-interlock';
import { symbolConstraintsFor } from './agentic-bridge.module';
import { MergedExchangeStream } from './market-streams.module';
import { AgentMetricsRecorder } from '../../common/observability/agent-metrics-recorder.service';
import { DEFAULT_FILTERS } from '../../../domain/risk/default-filters';
import { venueForSymbol } from '../../../domain/types/venue-map';
import { symbolId, strategyId, type SymbolId } from '../../../domain/types/ids';
import type { CandleInterval } from '../../../domain/types/market-events';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import {
  KILL_SWITCH,
  PROTECTIVE_EXIT_CONFIG,
  PLAN_STOP_REGISTRY,
  type KillSwitchPort,
  type ProtectiveExitConfig,
  type PlanStopRegistryPort,
} from '../../../ports/risk';
import { EXCHANGE_PORT, type ExchangePort } from '../../../ports/exchange';
import { EXCHANGE_STREAM, type ExchangeStreamPort } from '../../../ports/exchange-stream';
import {
  PORTFOLIO_VIEW,
  EXECUTION_STORE,
  type PortfolioViewPort,
  type ExecutionStorePort,
} from '../../../ports/execution';
import {
  MARKET_STREAM,
  FEED_HEALTH,
  type FeedHealthPort,
  type MarketStreamPort,
} from '../../../ports/market-data';
import {
  STRATEGY_HOST,
  STRATEGY_REGISTRY,
  SIGNAL_SINK,
  type StrategyHostPort,
  type StrategyRegistryPort,
} from '../../../ports/strategy';
import {
  AGENT_CLIENT,
  AGENT_DECISION_JOURNAL,
  PLAYBOOK_PROVIDER,
  AgentProposeError,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentDecisionJournalPort,
  type AgentProposal,
  type AgentCalendarEvent,
  type PlaybookProvider,
} from '../../../ports/agentic-strategy';
import type { AgentDecideOutcome } from '../../common/observability/agent-metrics-recorder.service';
import {
  PROMOTION_READINESS,
  PROMOTION_STATS,
  REFLECTION_EVIDENCE,
  type PromotionReadinessPort,
  type PromotionReadiness,
  type RoundTripEvidencePort,
  type PromotionStatsPort,
} from '../../../ports/promotion';
import { DERIVATIVES_FEED, type DerivativesFeedPort } from '../../../ports/derivatives-feed';
import { SENTIMENT_FEED, type SentimentFeedPort } from '../../../ports/sentiment-feed';
import { FEAR_GREED_FEED, type FearGreedFeedPort } from '../../../ports/fear-greed-feed';
import { TRADE_FLOW_FEED, type TradeFlowFeedPort } from '../../../ports/trade-flow-feed';
import { POSITIONING_FEED, type PositioningFeedPort } from '../../../ports/positioning-feed';
import { LIQUIDATION_FEED, type LiquidationFeedPort } from '../../../ports/liquidation-feed';
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue-registry';
import type { VenueId } from '../../../domain/types/ids';

// v3 spec §1.3: TradingRuntimeModule absorbs app.module.ts's root provider block (SignalSinkService
// … STRATEGY_HOST, verbatim) plus TradingRuntimeService, extracted from the old AppModule class body.
// NOT @Global (spec §1.3) — it is imported once, directly, by the thin app.module.ts root; nothing
// else in the graph needs to inject its own providers (SIGNAL_SINK/STRATEGY_HOST are consumed only by
// StrategyHost's own construction here).

// Composition-root decorator recording agentic-lane decide() telemetry (G3b's AgentMetricsRecorder)
// around whichever AgentClientPort AgenticStrategyModule resolved (stub / budgeted-Anthropic) — kept
// OUTSIDE that module so it can depend on ObservabilityModule (the boundary wall runs the other way).
// Wrapped in TradingRuntimeService's constructor body rather than re-provided under the AGENT_CLIENT
// token: Nest has no way to inject "the imported AGENT_CLIENT specifically" from a scope that ALSO
// re-provides that exact token locally (the local provider would shadow — and thus self-reference —
// the import it's trying to wrap), so this wraps at the point of consumption instead of via a second
// DI binding. Exported so agent-decide-outcome.spec.ts can exercise it directly against fakes.
export class MetricsWrappingAgentClient implements AgentClientPort {
  // `model` is the configured decide model (config.agentic.model), not read off the proposal —
  // AgentUsage carries no model field, and every call this wrapper sees is a decide call (#28:
  // reflection tags its own tokens with cfg.model in reflection.service.ts).
  constructor(
    private readonly inner: AgentClientPort,
    private readonly recorder: AgentMetricsRecorder,
    private readonly budget: DailyLlmBudget,
    private readonly model: string,
  ) {}

  async propose(input: AgentDecisionInput): Promise<AgentProposal> {
    const started = Date.now();
    try {
      const proposal = await this.inner.propose(input);
      this.recorder.observeDecideLatency((Date.now() - started) / 1000);
      if (proposal.usage) {
        this.recorder.recordTokens(
          proposal.usage.inputTokens,
          proposal.usage.outputTokens,
          proposal.usage.cacheReadInputTokens,
          proposal.usage.cacheCreationInputTokens,
          this.model,
        );
      }
      this.recorder.recordDecide(this.outcomeForProposal(proposal), this.model);
      return proposal;
    } catch (err) {
      this.recorder.observeDecideLatency((Date.now() - started) / 1000);
      this.recorder.recordDecide(this.outcomeForError(err), this.model);
      throw err;
    }
  }

  // AgentProposeError carries only RETRYABLE|FATAL (ports/agentic-strategy.ts) — no distinct TIMEOUT
  // kind, and string-matching the message to detect an aborted call would violate the very reason
  // AgentProposeError exists (branch on kind, never on message text). 'timeout' is therefore never
  // emitted here; a timed-out call surfaces as error_retryable like any other transient failure.
  private outcomeForError(err: unknown): AgentDecideOutcome {
    if (err instanceof AgentProposeError) {
      return err.kind === 'FATAL' ? 'error_fatal' : 'error_retryable';
    }
    return 'error_retryable';
  }

  // A proposal with no client-supplied decision and no signals is either a genuine soft no-op (stub
  // client, malformed response, refusal — see anthropic-agent-client.ts) or the budget gate's inert
  // `{ signals: [] }` short-circuit (agent-budget.ts) — the two are indistinguishable from the
  // proposal shape alone, so the budget snapshot (read AFTER propose() resolves, reflecting whether
  // THIS call's reservation attempt was the one that failed) breaks the tie.
  private outcomeForProposal(proposal: AgentProposal): AgentDecideOutcome {
    if (!proposal.decision) {
      let exhausted = false;
      try {
        exhausted = this.budget.snapshot().exhausted;
      } catch {
        /* metrics must never throw into a trading path */
      }
      return proposal.signals.length === 0 && exhausted ? 'budget_blocked' : 'hold';
    }
    if (proposal.decision.action === 'hold') return 'hold';
    // A non-hold action can still map to zero signals (e.g. 'flat' while already FLAT, 'long' while
    // already LONG — see the mapping comment in anthropic-agent-client.ts) — nothing reached Risk.
    return proposal.signals.length === 0 ? 'noop' : 'proposed';
  }
}

@Injectable()
export class TradingRuntimeService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger('TradingRuntime');
  private readonly driverTimers: ReturnType<typeof setInterval>[] = [];
  private tradingSymbols: SymbolId[] = [];
  // Wraps the raw AGENT_CLIENT with G3b metrics telemetry — see MetricsWrappingAgentClient's own
  // comment for why this happens here rather than via a second DI binding under the same token.
  private readonly agentClient: AgentClientPort;
  // The raw (unwrapped) client's own class name, kept for the startup log line below — the wrapper's
  // own constructor.name would otherwise mask which concrete client (stub/budgeted-Anthropic) got
  // selected.
  private readonly agentClientKind: string;
  private readonly promotionEvaluator: PromotionEvaluator;
  // One shared cross-symbol relative-strength context for the whole agentic lane (2026-07-12). Each
  // agentic-N instance records its symbol's trailing return into it and reads the basket ranking.
  private readonly crossSymbolContext = new CrossSymbolContextService();
  // I1: no longer constructed here — ACTIVE_MENU_GATE_OVERRIDE (AgenticBridgeModule) binds ONE
  // UniverseScannerService instance, injected below, so this class and the batching client's
  // ActiveMenuGate (agentic-strategy.module.ts's AGENT_CLIENT factory) share the exact same scanner.
  // Recompute cadence (daily + once after warmup) and the pin provider are wired at the end of the
  // constructor / in startTrading below.
  private readonly macroCalendar: readonly AgentCalendarEvent[];

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly coordinator: HaltCoordinatorService,
    private readonly protectiveExit: ProtectiveExitService,
    // Push 3 P2: the SAME instance ProtectiveExitService resolved via PLAN_STOP_REGISTRY (both bind
    // to the one provider below) — threaded into the agentic strategy factory's deps below.
    @Inject(PLAN_STOP_REGISTRY) private readonly planStopRegistry: PlanStopRegistryPort,
    private readonly resolver: UnknownResolverService,
    private readonly reconciliation: ReconciliationService,
    private readonly sampler: EquitySamplerService,
    private readonly config: TypedConfigService,
    @Inject(STRATEGY_HOST) private readonly host: StrategyHostPort,
    @Inject(STRATEGY_REGISTRY) private readonly registry: StrategyRegistryPort,
    @Inject(PORTFOLIO_VIEW) private readonly portfolio: PortfolioViewPort,
    private readonly modeControl: ModeControlService,
    private readonly fillPoller: DemoFillPollerService,
    private readonly bootRecovery: BootRecoveryService,
    // Defect A commit-1 (2026-07-16 phantom perp position): wired into the agentic strategy's
    // onAlgoStopGone dep below (bar-level recovery) AND swept directly at boot in startTrading
    // (heals an already-phantom position before the first reconcile tick can HALT on it).
    private readonly algoStopRecovery: AlgoStopRecoveryService,
    @Inject(AGENT_CLIENT) rawAgentClient: AgentClientPort,
    private readonly agentMetrics: AgentMetricsRecorder,
    @Inject(AGENT_LLM_BUDGET) private readonly agentBudget: DailyLlmBudget,
    // I1: the SAME scanner instance ACTIVE_MENU_GATE_OVERRIDE binds (see that token's own comment) —
    // shared with agentic-strategy.module.ts's AGENT_CLIENT factory via the identical DI token.
    @Inject(ACTIVE_MENU_GATE_OVERRIDE) private readonly universeScanner: UniverseScannerService,
    // W3 Part 2: ONE shared PriceHistoryStore instance (AgenticBridgeModule's own provider, same
    // @Global()-exported convention as ExecQualityService) — this factory's onCandleMetrics closure
    // below feeds it off the SAME candle window universeScanner already reads; PAYLOAD_EXTRAS_
    // PROVIDER_OVERRIDE's factory reads it back for correlation.btcBeta.
    private readonly priceHistory: PriceHistoryStore,
    @Inject(AGENT_DECISION_JOURNAL) private readonly agentJournal: AgentDecisionJournalPort,
    @Inject(PLAYBOOK_PROVIDER) private readonly playbookProvider: PlaybookProvider,
    // C1: always bound (ContextFeedsModule's DERIVATIVES_FEED factory returns the NOOP shape when
    // DERIVATIVES_FEED_ENABLED is off/test-ci) — never @Optional.
    @Inject(DERIVATIVES_FEED) private readonly derivativesFeed: DerivativesFeedPort,
    // C4: always bound (ContextFeedsModule's SENTIMENT_FEED factory returns the NOOP shape when
    // SENTIMENT_FEED_ENABLED/key is off/absent/test-ci) — never @Optional, mirrors derivativesFeed.
    @Inject(SENTIMENT_FEED) private readonly sentimentFeed: SentimentFeedPort,
    // X3a: always bound (ContextFeedsModule's FEAR_GREED_FEED factory returns the NOOP shape when
    // FEAR_GREED_FEED_ENABLED is off/test-ci) — never @Optional, mirrors sentimentFeed.
    @Inject(FEAR_GREED_FEED) private readonly fearGreedFeed: FearGreedFeedPort,
    // Always bound (ContextFeedsModule's TRADE_FLOW_FEED factory returns the NOOP shape when
    // AGENTIC_TRADEFLOW_ENABLED is off/test-ci) — never @Optional, mirrors derivativesFeed.
    @Inject(TRADE_FLOW_FEED) private readonly tradeFlowFeed: TradeFlowFeedPort,
    // Always bound (ContextFeedsModule's POSITIONING_FEED factory returns the NOOP shape when
    // AGENTIC_POSITIONING_ENABLED is off/test-ci) — never @Optional, mirrors derivativesFeed.
    @Inject(POSITIONING_FEED) private readonly positioningFeed: PositioningFeedPort,
    // Always bound (ContextFeedsModule's LIQUIDATION_FEED factory returns the NOOP shape when
    // AGENTIC_LIQUIDATIONS_ENABLED is off/test-ci) — never @Optional, mirrors derivativesFeed.
    @Inject(LIQUIDATION_FEED) private readonly liquidationFeed: LiquidationFeedPort,
    @Inject(REFLECTION_SERVICE) private readonly reflectionService: ReflectionService,
    @Inject(PROMOTION_READINESS) private readonly promotionReadiness: PromotionReadinessPort,
    // Backlog #51: the adapter behind EXCHANGE_PORT, for the perp deploy pin in startTrading — only
    // perp-capable adapters implement pinPerpVenueDefaults, everything else no-ops via `?.`. The
    // routing facade (VenueRoutingExchangeAdapter, exchange-adapters.module.ts) already narrows the
    // pin call to the perp venue's own port internally, so this single call reaches the perp runtime
    // only — no change needed here for the multi-venue split.
    @Inject(EXCHANGE_PORT) private readonly exchangePort: ExchangePort,
    // XA6: the raw stream, for the channel-tier resolver wiring in startTrading — the adapter
    // (market-data layer) and the scanner (agentic layer) must not import each other, so this
    // composition-root class is where the two meet (instanceof-guarded: test/ci's NOOP_STREAM and
    // the paper path have no tiering). v3: MergedExchangeStream (both venues' adapters) replaces the
    // single-venue CcxtExchangeStreamAdapter — one setChannelTierResolver call reaches both venues'
    // underlying adapters (MergedExchangeStream.setChannelTierResolver forwards to each).
    @Inject(EXCHANGE_STREAM) private readonly rawExchangeStream: ExchangeStreamPort,
    // v3 §1.5: the per-venue fact table — drives the fill-poller loop (iterate venues, poll each
    // venue's own symbol subset) below. Always bound (VenueRegistryModule is @Global and built purely
    // from config, present in every boot including test/ci).
    @Inject(VENUE_REGISTRY)
    private readonly venueRegistry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
    // W5 attributed auto-promotion: the evaluator promotes a reflection candidate to ACTIVE on its
    // own A/B-attributed evidence beating the champion (see promotion-evaluator.ts). Built here from
    // the same store the reflection loop writes and the DB-backed stats/journal, and wired as a
    // second onClosedTrade observer alongside reflection below. All deps @Optional: absent under
    // test/ci/no-DB leaves the evaluator inert (createPromotionEvaluator's own inert guard).
    // W4.2 expectancy ladder's realized-evidence feed — @Optional like the token's other consumers:
    // absent under test/ci/no-DB, which leaves the ladder inert regardless of its flag.
    @Optional()
    @Inject(REFLECTION_EVIDENCE)
    private readonly roundTripEvidence?: RoundTripEvidencePort,
    @Optional() @Inject(PROMOTION_STATS) promotionStats?: PromotionStatsPort,
    @Optional() @Inject(PLAYBOOK_PROVIDER_OVERRIDE) playbookStore?: EvaluatorPlaybookStore,
    @Optional() @Inject(KILL_SWITCH) killSwitch?: KillSwitchPort,
    // Push 3 P7c: resting-order role resolution (vtp/vsl), threaded into AgenticStrategyDeps.
    // intentStore below. @Optional like the other DB-backed deps: absent under test/ci/no-DB
    // leaves every role lookup 'unknown' (warn-once, leave-alone — never a blind cancel).
    @Optional() @Inject(EXECUTION_STORE) private readonly executionStore?: ExecutionStorePort,
  ) {
    this.agentClient = new MetricsWrappingAgentClient(
      rawAgentClient,
      this.agentMetrics,
      this.agentBudget,
      this.config.agentic.model,
    );
    this.agentClientKind = rawAgentClient.constructor.name;
    // I1 (Design § Enriched model inputs): repo-maintained macro calendar, loaded once at boot for
    // THIS class's own boot log line (logPortfolio below) — the live payload's calendar block reads
    // its own separately-loaded copy via PAYLOAD_EXTRAS_PROVIDER_OVERRIDE (AgenticBridgeModule), not
    // this field; both are tolerant loaders of the same static file (loadMacroCalendar fails OPEN —
    // a missing/malformed file never blocks boot, it just yields an empty calendar).
    this.macroCalendar = loadMacroCalendar(
      path.join(process.cwd(), 'data', 'macro-calendar.json'),
      { warn: (m) => this.log.warn(m) },
    );
    this.promotionEvaluator = createPromotionEvaluator(agenticEnv(this.config), {
      stats: promotionStats,
      journal: this.agentJournal,
      playbookStore,
      recorder: this.agentMetrics,
      killSwitch,
      registry: this.registry,
      logger: { warn: (m) => this.log.warn(m) },
    });
  }

  // Resolves the active playbook version once at boot and surfaces it to Prometheus
  // (agentic_playbook_info) and the boot log (§G4b activation journaling — which of pin/promotion/
  // seed won) — independent of onApplicationBootstrap's test/ci skip below: this is boot-time
  // observability trivia, not a periodic trading driver, so it runs unconditionally (the in-memory
  // store resolves synchronously; the DB-backed store is never reached under test/ci —
  // AgenticBridgeModule's own isTestEnv() gate). A resolution failure is logged, never thrown — it
  // must not block boot.
  async onModuleInit(): Promise<void> {
    // (E) Surface which agent client bound at boot so live-vs-inert is unambiguous in Grafana and the
    // log, not buried in one startup line. StubAgentClient (no ANTHROPIC_API_KEY, or test/ci) is inert
    // — it proposes nothing, so the demo will never trade until a key is set; anything else is a live
    // deciding client. constructor.name is the only distinguisher (the Anthropic path is wrapped in
    // BudgetedAgentClient, so it is never literally 'AnthropicAgentClient').
    const clientKind = this.agentClientKind === 'StubAgentClient' ? 'stub' : 'anthropic';
    this.agentMetrics.setClientInfo(clientKind);
    if (clientKind === 'stub') {
      this.log.warn(
        'agentic lane INERT: no ANTHROPIC_API_KEY — proposing nothing; demo will not trade until a key is set',
      );
    }

    try {
      // active() (never current()): with a live A/B candidate, current() serves the candidate in
      // routed minute-buckets — a boot landing there would stamp agentic_playbook_info with the
      // INACTIVE candidate's version. The gauge and this log line are the "was it promoted?" read —
      // active only.
      const { version, source } = await (this.playbookProvider.active?.() ??
        this.playbookProvider.current());
      this.agentMetrics.setPlaybookInfo(version);
      this.log.log(`active playbook resolved: version=${version} source=${source ?? 'unknown'}`);
    } catch (err) {
      this.log.warn(
        `playbook resolution failed at boot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // §6/§8 periodic drivers — the runtime FIRING of logic unit-tested in isolation: the halt
  // coordinator and unknown-order resolver tick each second, equity samples every 5s, reconciliation
  // sweeps every 30s (ReconciliationService.reconcile() iterates VENUE_REGISTRY internally — one pass
  // per venue per tick, §1.5 — so this single timer already drives per-venue reconciliation). SKIPPED
  // under test/ci so timers never fire inside the suite — the tick/reconcile/sample logic is verified
  // directly in the unit/paper tests; only the firing was deferred. Each fire is fire-and-forget with
  // its rejection swallowed (the services engage the kill switch on real faults).
  async onApplicationBootstrap(): Promise<void> {
    const env = process.env['NODE_ENV'];
    if (env === 'test' || env === 'ci' || process.env['CI']) return;
    const mode = this.config.mode.configMode;
    // Restore P/L state (cash/equity/peak/sod + open positions) and seed+degrade open orders from
    // Postgres BEFORE any trading or sampling, so equity/drawdown continue across restarts and the
    // first reconcile sees recovered truth. No-op in paper/no-DB (in-memory store returns empty). A
    // corrupt persisted order state throws here — failing the boot loudly rather than trading on it.
    await this.bootRecovery.recoverOnBoot(mode);
    this.driverTimers.push(
      setInterval(() => {
        const now = this.clock.now();
        void Promise.resolve(this.coordinator.tick(now)).catch(() => undefined);
        void Promise.resolve(this.resolver.tick(now)).catch(() => undefined);
      }, 1_000),
      setInterval(() => {
        void Promise.resolve(this.sampler.sample()).catch(() => undefined);
      }, 5_000),
    );
    // §S3 protective backstop: ticks alongside the halt coordinator/resolver, but its rejection is
    // LOGGED (not silently swallowed) — a tick failure here means the bot-side stop-loss/trailing
    // stop is not being enforced, which is worth a warn line even though the tick itself never engages
    // the kill switch on its own faults.
    this.driverTimers.push(
      setInterval(() => {
        void Promise.resolve(this.protectiveExit.tick(this.clock.now())).catch((err: unknown) => {
          this.log.warn(
            `protective-exit tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, 1_000),
    );
    // Reconciliation compares the in-memory portfolio against the venue, per venue. In paper the
    // in-memory paper adapters ARE the venue, so they match exactly. On the Binance Demo flavor the
    // account is a SHARED multi-asset wallet (not dedicated to the bot), so a demo venue's own
    // ReconConfig disables the balances axis for it (a BALANCE_DRIFT HALT on holdings the bot never
    // touched would be wrong — see ReconciliationService.venueReconConfig); order/trade axes run
    // everywhere. A failed pass is logged AND lands in reconciliation_runs_total{result="error"} +
    // the reconciliations row — a silent .catch here once hid a per-pass throw for weeks (reconTs=0,
    // zero rows) while the safety sweep never actually confirmed venue truth.
    if (mode === 'paper' || mode === 'testnet') {
      this.driverTimers.push(
        setInterval(() => {
          void Promise.resolve(this.reconciliation.reconcile()).catch((err: unknown) => {
            this.log.warn(
              `reconcile pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }, 30_000),
      );
    }
    void this.startTrading(mode);
  }

  onModuleDestroy(): void {
    for (const timer of this.driverTimers) clearInterval(timer);
    void this.host.stop();
  }

  // The deferred runtime glue that turns the statically-wired Strategy→Risk→Execution→Adapter graph
  // into a running bot. Non-paper modes trade with credentials, so the key MUST be probed first:
  // resolveMode() yields testnetKeysValid from the probe, and without it testnet downgrades to paper
  // (lastProbe undefined) → the gate rejects every order MODE_MISMATCH. Then the strategy is
  // registered + enabled, the host starts (warmup + live consume), and — because the venue fills its
  // own orders with no WS user stream yet — the fill poller sweeps fetchMyTrades per venue. Portfolio
  // is logged on a cadence so a run is observable. The only hard human gate stays paper→live.
  private async startTrading(mode: 'paper' | 'testnet' | 'live'): Promise<void> {
    // Multi-symbol (P7): one agentic strategy instance per configured symbol, across BOTH venues
    // (v3: TRADING_SYMBOLS spans the combined 40-symbol basket). Every symbol MUST have a
    // DEFAULT_FILTERS row — the sizer/risk/prompt all read it, and a missing entry would otherwise
    // surface as a per-order NO_REF_PRICE/LIMITS_INCOMPLETE drizzle of rejections instead of one loud
    // boot failure here.
    const symbols = this.config.strategy.symbols;
    const unfiltered = symbols.filter((s) => !DEFAULT_FILTERS.has(s));
    if (unfiltered.length > 0) {
      throw new Error(
        `TRADING_SYMBOLS entries without a DEFAULT_FILTERS row: ${unfiltered.join(', ')} — add venue filters (domain/risk/default-filters.ts) before trading them`,
      );
    }
    this.tradingSymbols = symbols.map((s) => symbolId(s));

    if (mode !== 'paper') {
      // Defect A commit-1 (2026-07-16 phantom perp position): heal any already-phantom position
      // BEFORE the reconciliation timer's first 30s tick (registered in onApplicationBootstrap,
      // ahead of this fire-and-forget startTrading call) can observe the latent local/venue
      // divergence and HALT on it — asks the venue's algo-history rail about every live algo-rail
      // intent and folds any missed TRIGGERED fill onto the OMS under the stop intent's own
      // clientOrderId. Runs FIRST in this block, before the slower refreshKeyProbe/pin network
      // calls below, to close the race window as tightly as this synchronous boot sequence allows.
      // Fail OPEN (warn, never throw) even though sweep() already swallows every per-symbol error
      // itself — a boot-time recovery failure must never block trading; the bar-level
      // onAlgoStopGone hook (agentic.strategy.ts) and this same sweep's own periodic backstops
      // (none yet wired — sweep is boot-only today) retry on their own cadence.
      await this.algoStopRecovery.sweep(this.tradingSymbols).catch((err: unknown) => {
        this.log.warn(
          `algo-stop recovery sweep failed at boot: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      await this.refreshKeyProbe();
      // Backlog #51 (Phase-8 perp deploy checklist): pin venue-side isolated margin + leverage
      // BEFORE the first order — account defaults are never trusted. The routing facade behind
      // EXCHANGE_PORT (VenueRoutingExchangeAdapter) narrows this call to the perp venue's own port
      // and filters the symbol list to that venue's symbols internally (exchange-adapters.module.ts)
      // — a spot-only deployment no-ops (no perp port registered). Fail-closed on the perp runtime: a
      // pin failure throws here and the boot dies — including a FRACTIONAL PERP_LEVERAGE_CAP, passed
      // through UNfloored so the client's integer guard refuses it (silently truncating a cap the
      // sizer still reads as a decimal would diverge venue leverage from sizing math — reviewer S2).
      // NB LiveExchangeAdapter does not delegate the hook — a live perp deployment (far future, own
      // ceremony) must wire that deliberately.
      await this.exchangePort.pinPerpVenueDefaults?.(
        this.tradingSymbols,
        // Decimal round-trip (not Number()): leverage is a multiplier, not money, but the money
        // lint rule is deliberately blanket; toNumber() is exact for any sane integer cap.
        new Decimal(this.config.perp.leverageCap).toNumber(),
      );
      this.driverTimers.push(
        setInterval(() => {
          void this.refreshKeyProbe();
        }, 60_000),
      );
    }
    const resolved = this.modeControl.resolveMode();
    this.log.log(
      `effective mode=${resolved.effective} (requested=${resolved.requested}) downgrades=[${resolved.downgrades.join(',')}]`,
    );

    // Strategy selection. ACTIVE_STRATEGY picks which registered strategy the host runs; the schema
    // constrains it to 'agentic', the only registered lane — an invalid value fails loud at config
    // validation (boot) rather than at registry.enable.
    const active = this.config.strategy.active;
    // onClosedTrade is built per-registered-instance (using the factory's own `id`, not a fixed
    // literal) so a future second agentic registration would each wire the reflection loop's
    // lifecycle check against ITS OWN strategy id (see ReflectionService.runReflection).
    this.registry.register('agentic', (id, p) => {
      const deps: AgenticStrategyDeps = {
        journal: this.agentJournal,
        onClosedTrade: (count) => {
          this.reflectionService.onClosedTrade(id, count);
          // W5: the attributed evaluator observes the same closed-trade seam; inert unless
          // AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES > 0 and the DB-backed deps are bound.
          this.promotionEvaluator.onClosedTrade(id, count);
        },
        // P3: sibling of onClosedTrade above, wired the same per-instance way — fires this
        // registration's OWN strategy id into the weekly time-based trigger every decide() call (see
        // AgenticStrategyDeps.checkWeeklyReflection's own comment for why the caller lives here).
        checkWeeklyReflection: () => this.reflectionService.checkWeeklyReflectionTrigger(id),
        // P6: onConsultGate wired to the renamed recorder — evaluateConsultSchedule's
        // ConsultGateOutcome now matches AgentMetricsRecorder.recordConsultGate's param exactly.
        onConsultGate: (outcome) => this.agentMetrics.recordConsultGate(outcome),
        // XA1 (A0 activation bundle): the SAME scanner instance the batching client's menu gate
        // reads — the strategy-side gate keeps off-menu idle symbols from recording forced_*
        // outcomes and from having their consult clock/wake baseline reset by the batching
        // client's inert menu-hold (scanner warmup default = everything active, fail OPEN).
        menuGate: this.universeScanner,
        // I1b (Design § Universe): the SAME shared UniverseScannerService instance
        // ACTIVE_MENU_GATE_OVERRIDE binds — each agentic-N instance records its own symbol's closed-
        // candle window on its own decide cadence. Storage-only (recordCandles no-ops below warmup
        // and never triggers a recompute itself) — see AgenticStrategyDeps.onCandleMetrics.
        // W3 Part 2: the SAME closure also feeds the shared PriceHistoryStore (this.priceHistory) off
        // the identical candle window.
        onCandleMetrics: (symbol, candles) => {
          this.universeScanner.recordCandles(String(symbol), candles);
          this.priceHistory.recordWindow(symbol, candles);
        },
        onVenueTp: (event) => this.agentMetrics.recordVenueTp(event),
        onVenueStop: (event) => this.agentMetrics.recordVenueStop(event),
        // Backlog #55: without this the strategy falls back to its NOOP_LOGGER and every warn it
        // emits (venue-stop reconcile_error, intent-store failures, prescreen fail-open,
        // unknown-role) is invisible in production logs — metrics were the only observable.
        logger: { warn: (m) => this.log.warn(`[${id}] ${m}`) },
        evidence: this.roundTripEvidence,
        derivativesFeed: this.derivativesFeed,
        sentimentFeed: this.sentimentFeed,
        fearGreedFeed: this.fearGreedFeed,
        tradeFlowFeed: this.tradeFlowFeed,
        positioningFeed: this.positioningFeed,
        liquidationFeed: this.liquidationFeed,
        // Cross-symbol relative-strength context: ONE service shared across every agentic-N instance
        // (this closure runs once per registration but `deps` is captured by the factory), so each
        // instance records its own symbol's trailing return and reads the whole basket's ranking.
        crossSymbolContext: this.crossSymbolContext,
        // W3 Part 2: ONE shared PriceHistoryStore instance — see AgenticStrategyDeps.priceHistory's
        // own comment.
        priceHistory: this.priceHistory,
        // Push 3 P2: the SAME instance ProtectiveExitService reads each 1s tick (PLAN_STOP_REGISTRY,
        // provided once above) — this strategy instance populates it on plan entry-fill/clear.
        planStopRegistry: this.planStopRegistry,
        // Push 3 P7c: resting-order role resolution (vtp/vsl) — see AgenticStrategyDeps.intentStore.
        intentStore: this.executionStore,
        // Push 3 P7d: the swap algo-rail round-trip, narrowed off the SAME EXCHANGE_PORT instance
        // the perp deploy pin (startTrading) already holds — see AgenticStrategyDeps.algoOrders'
        // own comment. Structurally satisfies the narrowed Pick<ExchangePort, ...> even when the
        // bound adapter is spot/paper (both methods stay `undefined` there; every call site guards
        // with `?.`).
        algoOrders: this.exchangePort,
        // Defect A commit-1: the ONLY route back to AlgoStopRecoveryService — see
        // AgenticStrategyDeps.onAlgoStopGone's own comment for why this is a closure, never a
        // direct import (eslint-plugin-boundaries forbids the agentic feature importing execution).
        onAlgoStopGone: (symbol) => this.algoStopRecovery.recoverSymbol(symbol),
      };
      return new AgenticStrategy(id, p as AgenticStrategyParams, this.agentClient, deps);
    });
    // SAFETY INTERLOCK (hard, fail-loud at boot). A live-configured agentic boot is refused unless
    // the earned-live promotion gate passes: an explicit permitted PromotionReadiness verdict
    // computed fresh from durable demo evidence (>=30 round trips, positive net-of-cost PnL, >=14d
    // — see PromotionReadinessService). The verdict is evaluated ONLY for a live boot (paper/testnet
    // boots skip the DB query and stay byte-identical); any evaluation error collapses to undefined
    // = fail-closed refusal. Gate on the LITERAL enabled below ('agentic'), NOT on `active` —
    // ACTIVE_STRATEGY only selects among registered types (an unrecognized value fails loud at
    // registry.enable's "unknown strategy type" throw just below); it must never be able to pick its
    // way around this interlock while the enable call still composes the agentic lane. Gate on the
    // STATIC `mode` (= configMode, the boundary that binds the live adapter), NOT
    // resolveMode().effective — which is always 'paper' here pre-arming and so would never fire. See
    // assertAgenticLaneNotLive for the full rationale; a permitted verdict still leaves the four-gate
    // arming ceremony fully in force.
    let readiness: PromotionReadiness | undefined;
    if (mode === 'live') {
      try {
        readiness = await this.promotionReadiness.evaluate();
      } catch (err) {
        this.log.error(`promotion-readiness evaluation failed (fail-closed): ${String(err)}`);
        readiness = undefined;
      }
    }
    assertAgenticLaneNotLive('agentic', mode, readiness);

    // One instance per symbol: agentic-1, agentic-2, … — ids stay stable for a given TRADING_SYMBOLS
    // ordering (positions/journals key off the id, so reordering the CSV re-attributes state; the
    // runbook documents append-only symbol management). Each instance gets its own params (symbol,
    // venue, entry caps run per-strategy in the host) while AGENT_LLM_BUDGET stays ONE shared
    // lane-wide spend cap across all instances.
    symbols.forEach((symbol, i) => {
      this.registry.enable(strategyId(`agentic-${i + 1}`), active, this.agenticParams(symbol));
    });
    const first = this.agenticParams(symbols[0]!);
    this.log.warn(
      `ACTIVE_STRATEGY=agentic — UNVALIDATED, NON-DETERMINISTIC EXPERIMENT (live in-process agent; ` +
        `step-D-uncertifiable, live access is earned). symbols=[${symbols.join(', ')}] ${first.interval} ` +
        `warmupBars=${first.warmupBars} agentClient=${this.agentClientKind}`,
    );

    await this.host.start();
    this.log.log('strategy host started — consuming market data');
    // I1 (Design § Universe): "once at boot" recompute, run right after the host starts consuming —
    // the basket's own candle warmup then proceeds on its normal cadence (isActive() safely defaults
    // to "everything active" until real data lands).
    this.universeScanner.maybeRecompute(this.clock.now());

    // XA6: per-symbol channel tiering — heavy channels (book, trades) only for active-menu +
    // positioned symbols (isActive() covers both). v3: MergedExchangeStream replaces the single-venue
    // CcxtExchangeStreamAdapter — one setChannelTierResolver call reaches both venues' underlying
    // adapters (MergedExchangeStream.setChannelTierResolver forwards to each — market-streams.module.ts).
    if (this.rawExchangeStream instanceof MergedExchangeStream) {
      this.rawExchangeStream.setChannelTierResolver({
        fullChannels: (symbol) => this.universeScanner.isActive(String(symbol)),
      });
    }

    if (mode !== 'paper') {
      this.fillPoller.init();
      this.driverTimers.push(
        setInterval(() => {
          void this.runFillPoll();
        }, 10_000),
      );
    }
    this.driverTimers.push(
      setInterval(() => {
        this.logPortfolio();
        // Daily-at-00:00-UTC cadence (Design § Universe): maybeRecompute is a no-op idempotent
        // UTC-day-key check, so piggybacking it on this existing 15s tick costs nothing extra and
        // needs no new timer.
        this.universeScanner.maybeRecompute(this.clock.now());
      }, 15_000),
    );
  }

  private async refreshKeyProbe(): Promise<void> {
    try {
      await this.modeControl.refreshKeyProbe();
    } catch (err) {
      this.log.warn(`key probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // v3 §1.5: one poll per registry venue, each sweeping only its own symbol subset — a spot-heavy
  // poll advancing DemoFillPollerService's watermark must never starve the perp venue's own
  // since-window, and vice versa (see DemoFillPollerService.poll's own comment). Isolated per venue
  // (try/catch inside the loop, mirroring MergedExchangeStream/ReconciliationService's own per-venue
  // isolation) so one venue's poll failure never skips the other venue's sweep this tick.
  private async runFillPoll(): Promise<void> {
    let ingested = 0;
    let skippedUnknown = 0;
    for (const descriptor of this.venueRegistry.values()) {
      try {
        const result = await this.fillPoller.poll(descriptor.venue, descriptor.symbols);
        ingested += result.ingested;
        skippedUnknown += result.skippedUnknown;
      } catch (err) {
        this.log.warn(
          `fill poll failed for venue "${descriptor.venue}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (ingested > 0 || skippedUnknown > 0)
      this.log.log(`fill poll: ingested=${ingested} skippedUnknown=${skippedUnknown}`);
  }

  private logPortfolio(): void {
    const snap = this.portfolio.snapshot();
    const positions = [...snap.positions.values()].map(
      (p) => `${p.symbol}:${p.signedQty.toFixed()}@${p.avgEntry.toFixed()}`,
    );
    this.log.log(
      `portfolio: equity=${snap.equity.toFixed()} cash=${snap.balances.get('USDT')?.free.toFixed() ?? '?'} ` +
        `positions=[${positions.join(',')}] openOrders=${snap.openOrders.length} inFlight=${snap.inFlightIntents.length}`,
    );
    // I1 (Design § Enriched model inputs): boot-log echo of the SAME sources
    // PAYLOAD_EXTRAS_PROVIDER_OVERRIDE's own closure computes on every decide()/batch — this log line
    // is now a redundant-but-harmless periodic sanity echo, not the only consumer. cappedEquity
    // mirrors risk.module.ts's equityCapFor(config) so this log and the sizer's own cap can never
    // silently disagree.
    const portfolioBlock = buildAgentPortfolioBlock(snap, this.config.risk.equityCap);
    const budgetBlock = this.agentBudget.budgetBlock();
    // W1 (Grafana rebuild): remainingUsdToday is a decimal string (money-adjacent, never a money
    // arithmetic path) — Decimal round-trip, never Number(), mirrors promotion-metrics.service.ts's
    // own evidence.netPnl conversion.
    this.agentMetrics.setBudgetRemainingUsd(new Decimal(budgetBlock.remainingUsdToday).toNumber());
    const upcoming = filterUpcoming(this.macroCalendar, this.clock.now());
    this.log.log(
      `agent context: cappedEquity=${portfolioBlock.cappedEquity} ` +
        `grossExposure=${portfolioBlock.grossExposure} remainingCallsToday=${budgetBlock.remainingCallsToday} ` +
        `remainingUsdToday=${budgetBlock.remainingUsdToday} upcomingCalendarEvents=${upcoming.length}`,
    );
  }

  // v3 §1.3 (flagged venues[0] misroute fix): venue is now a pure function of the symbol
  // (venueForSymbol) — every strategy instance stamps its OWN symbol's venue rather than the whole
  // process's first configured venue (the v2 bug: a perp symbol running under a spot-first VENUES
  // ordering silently stamped `binance`).
  private agenticParams(symbol: string): AgenticStrategyParams {
    const symbolIdValue = symbolId(symbol);
    const agentic = this.config.agentic;
    const strategy = this.config.strategy;
    return {
      symbol: symbolIdValue,
      venue: venueForSymbol(symbolIdValue),
      // The schema constrains STRATEGY_INTERVAL to the CandleInterval values; the cast narrows the
      // AppConfig string field back to the domain union.
      interval: strategy.interval as CandleInterval,
      warmupBars: agentic.warmupBars,
      model: agentic.model,
      entryTtlBars: agentic.entryTtlBars,
      // Money-lint rule is deliberately blanket (hard rule 1) — route the decimal-string→number
      // conversion through Decimal even though wakeMovePct is a reference-grade threshold, not money.
      wakeMovePct: new Decimal(agentic.wakeMovePct).toNumber(),
      fallbackConsultBars: agentic.fallbackConsultBars,
      // Push 3 P6 Unit 4 (#17 residual): off by default ⇒ byte-identical (see agentic.strategy.ts's
      // computeTrackRecordContext).
      trackRecordEnabled: agentic.trackRecordEnabled,
      planMode: agentic.planMode,
      planExitTtlBars: agentic.planExitTtlBars,
      quietPayloadSampleBars: agentic.quietPayloadSampleBars,
      crossSymbolEnabled: agentic.crossSymbolEnabled,
      crossSymbolLookbackBars: agentic.crossSymbolLookbackBars,
      venueTpEnabled: agentic.venueTpEnabled,
      venueTpReplaceDriftBps: agentic.venueTpReplaceDriftBps,
      // The venue tick the sizer will round the TP hint to — lets manageVenueTp compare the resting
      // price against the tick-rounded expectation instead of the raw hint (review finding: the
      // [0, tick) rounding bias reads as permanent drift on coarse-tick symbols). Boot asserts every
      // traded symbol has a DEFAULT_FILTERS row, so this is present for all live instances.
      venueTpTickSize: DEFAULT_FILTERS.get(symbol)?.tickSize,
      // The venue LOT_SIZE step from the SAME row the sizer rounds reduce-only exit qty with — lets
      // manageVenueTp compare the resting order against the step-rounded (sellable) qty instead of the
      // raw full-precision position.qty (2026-07-15 fix: exact equality reads the always-present
      // sub-step dust residue as a mismatch and churns cancel/re-place every managed bar).
      venueTpStepSize: DEFAULT_FILTERS.get(symbol)?.stepSize,
      venueStopEnabled: agentic.venueStopEnabled,
      venueStopReplaceDriftBps: agentic.venueStopReplaceDriftBps,
      // Same DEFAULT_FILTERS tick — mirrors venueTpTickSize above (manageVenueStop's own drift
      // reconciliation, both rails).
      venueStopTickSize: DEFAULT_FILTERS.get(symbol)?.tickSize,
      // Same DEFAULT_FILTERS step — mirrors venueTpStepSize (manageVenueStop's qty reconciliation).
      venueStopStepSize: DEFAULT_FILTERS.get(symbol)?.stepSize,
      // The SAME buffer PositionSizerService applies past the trigger for a spot STOP_LOSS_LIMIT's
      // limit leg (SIZER_DEPS.stopLimitBufferBps) — manageVenueStopSpot's drift check must compare
      // against this exact value or it reads the buffer itself as permanent drift.
      stopLimitBufferBps: this.config.risk.stopLimitBufferBps,
      // ProtectiveExitService's OWN force-band threshold (ports/risk.ts's planStopForceBps) — the
      // strategy's bar-close 'stop' branch applies the SAME band on its own coarser cadence (see
      // AgenticStrategyParams.planStopForceBps's own comment on why this is independent of
      // PLAN_STOP_WATCH_ENABLED).
      planStopForceBps: this.config.risk.planStopForceBps,
    };
  }
}

@Module({
  // ObservabilityModule for AgentMetricsRecorder (TradingRuntimeService's own dep, plus the STRATEGY_HOST
  // factory's HaltCoordinatorService/ProtectiveExitService chain) — not @Global, so every consumer of
  // its exports must import it directly (same requirement AgenticBridgeModule's own imports satisfy).
  imports: [
    RiskModule,
    ExecutionModule,
    ModeControlModule,
    AgenticStrategyModule,
    ObservabilityModule,
  ],
  providers: [
    SignalSinkService,
    SIGNAL_REJECTIONS_COUNTER,
    HaltCoordinatorService,
    {
      // §S3: ProtectiveExitConfig rides the SAME validated config + DEFAULT_FILTERS the risk lane
      // uses (never a second, independently-tunable copy). cooldownMs is a fixed constant (not yet
      // config-tunable) — a per-symbol re-fire floor, not a safety gate.
      provide: PROTECTIVE_EXIT_CONFIG,
      useFactory: (config: TypedConfigService): ProtectiveExitConfig => ({
        stopLossPct: config.risk.protectStopLossPct,
        trailingPct: config.risk.protectTrailingPct,
        cooldownMs: 30_000,
        filters: DEFAULT_FILTERS,
        planStopWatchEnabled: config.risk.planStopWatchEnabled,
        planStopForceBps: config.risk.planStopForceBps,
      }),
      inject: [TypedConfigService],
    },
    // Push 3 P2: single shared instance — ProtectiveExitService resolves it via this token, and the
    // agentic strategy factory resolves the SAME instance through TradingRuntimeService's own
    // constructor injection above (mirrors PROTECTIVE_EXIT_CONFIG's single-source-of-truth convention).
    { provide: PLAN_STOP_REGISTRY, useClass: PlanStopRegistryService },
    ProtectiveExitService,
    PROTECTIVE_EXITS_COUNTER,
    { provide: SIGNAL_SINK, useExisting: SignalSinkService },
    {
      provide: STRATEGY_HOST,
      useFactory: (
        ms: MarketStreamPort,
        fh: FeedHealthPort,
        sink: SignalSinkService,
        reg: StrategyRegistry,
        pv: PortfolioViewPort,
        config: TypedConfigService,
        killSwitch: KillSwitchPort,
      ) => {
        const agentic = config.agentic;
        return new StrategyHost(ms, fh, sink, reg, {
          agentTimeoutMs: agentic.timeoutMs + 2_000, // backstop: client aborts first
          minDecisionIntervalMs: agentic.minDecisionIntervalMs,
          portfolioFor: (id) => pv.forStrategy(id),
          tradingHalted: () => killSwitch.state() !== 'RUNNING',
          constraintsFor: symbolConstraintsFor,
          drainCooldownBaseMs: agentic.drainCooldownBaseMs,
          drainCooldownMaxMs: agentic.drainCooldownMaxMs,
          maxEntriesPerDay: agentic.maxEntriesPerDay,
        });
      },
      inject: [
        MARKET_STREAM,
        FEED_HEALTH,
        SIGNAL_SINK,
        StrategyRegistry,
        PORTFOLIO_VIEW,
        TypedConfigService,
        KILL_SWITCH,
      ],
    },
    TradingRuntimeService,
  ],
  exports: [TradingRuntimeService],
})
export class TradingRuntimeModule {}
