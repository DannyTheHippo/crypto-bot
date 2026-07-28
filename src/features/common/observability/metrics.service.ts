import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  InjectMetric,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import Decimal from 'decimal.js';
import { performance } from 'perf_hooks';
import { Counter, Gauge } from 'prom-client';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { venueForSymbol } from '../../../domain/venue/types/venue-map';
import { DERIVATIVES_FEED, type DerivativesFeedPort } from '../../../ports/venue/derivatives-feed';
import { PORTFOLIO_VIEW, type PortfolioViewPort } from '../../../ports/trading/execution';
import {
  MARKET_STREAM_TELEMETRY,
  type MarketStreamTelemetryPort,
} from '../../../ports/venue/market-data';
import { MODE_CONTROL, type ModeControlPort } from '../../../ports/trading/mode-control';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/trading/risk';
import { SENTIMENT_FEED, type SentimentFeedPort } from '../../../ports/strategy/sentiment-feed';
import {
  STRATEGY_REGISTRY,
  type StrategyLifecycle,
  type StrategyRegistryPort,
} from '../../../ports/strategy/strategy';
import { EventLoopHealthIndicator } from './event-loop-health.indicator';

export const EVENT_LOOP_DELAY_GAUGE = makeGaugeProvider({
  name: 'event_loop_delay_p99_seconds',
  help: 'Event loop delay p99 in seconds',
});

export const EVENT_LOOP_UTILIZATION_GAUGE = makeGaugeProvider({
  name: 'event_loop_utilization',
  help: 'Event loop utilization ratio',
});

export const MODE_INFO_GAUGE = makeGaugeProvider({
  name: 'mode_info',
  help:
    'Trading mode info — requested is always env requestedMode (pre-test/ci override); ' +
    'effective is ModeControlPort.resolveMode().effective when MODE_CONTROL is bound ' +
    '(arming-aware), otherwise boot configMode.',
  labelNames: ['requested', 'effective'],
});

export const BOOT_INFO_GAUGE = makeGaugeProvider({
  name: 'boot_info',
  help: 'Boot info',
  labelNames: ['boot_id'],
});

// §5/§8 kill-switch state, sampled in the 5s loop: only the active state's series carries 1 (the
// gauge is reset each tick so stale states do not linger). Drives the KillSwitchEngaged /
// HaltedDegraded alerts (kill_switch_state{state!="RUNNING"} == 1).
export const KILL_SWITCH_STATE_GAUGE = makeGaugeProvider({
  name: 'kill_switch_state',
  help: 'Kill switch state (1 on the currently-active state label)',
  labelNames: ['state'],
});

// §8 trading metrics — PULLED from the canonical PortfolioSnapshot on the 5s sample loop. Ledger
// truth is Decimal in Postgres; these gauges are display-grade float exports (design §8: "Prometheus
// floats are display-grade exports"). Labeled gauges are reset each tick so a closed position's
// series does not linger. Unrealized PnL is embedded in equity (cash + Σ position×mark).
export const EQUITY_GAUGE = makeGaugeProvider({
  name: 'equity_usdt',
  help: 'Account equity (cash + Σ position×mark), USDT',
});
export const CASH_GAUGE = makeGaugeProvider({
  name: 'cash_usdt',
  help: 'Free quote (USDT) balance',
});
export const PEAK_EQUITY_GAUGE = makeGaugeProvider({
  name: 'peak_equity_usdt',
  help: 'Peak equity high-water mark, USDT',
});
export const DAY_PNL_GAUGE = makeGaugeProvider({
  name: 'day_pnl_usdt',
  help: 'Equity − start-of-day-UTC equity, USDT',
});
export const DRAWDOWN_GAUGE = makeGaugeProvider({
  name: 'drawdown_ratio',
  help: '(peak − equity) / peak, 0..1',
});
export const UNREALIZED_PNL_GAUGE = makeGaugeProvider({
  name: 'unrealized_pnl_usdt',
  help: 'Unrealized PnL on open positions, Σ signedQty×(mark − avgEntry), USDT',
});
export const STARTING_CASH_GAUGE = makeGaugeProvider({
  name: 'starting_cash_usdt',
  help: 'Seed baseline (PortfolioConfig.startingCash) — return-since-inception denominator, USDT',
});
export const REALIZED_PNL_GAUGE = makeGaugeProvider({
  name: 'realized_pnl_usdt',
  help: 'Realized PnL per venue/strategy/symbol, USDT',
  labelNames: ['venue', 'strategy', 'symbol'],
});
export const POSITION_QTY_GAUGE = makeGaugeProvider({
  name: 'position_qty',
  help: 'Signed position quantity per venue/strategy/symbol',
  labelNames: ['venue', 'strategy', 'symbol'],
});
export const POSITION_NOTIONAL_GAUGE = makeGaugeProvider({
  name: 'position_notional_usdt',
  help: 'abs(position) × avgEntry per venue/strategy/symbol, USDT',
  labelNames: ['venue', 'strategy', 'symbol'],
});
// v3 §8: venue-scoped facts — open_orders/in_flight_intents count per venue rather than one
// process-wide total (the v2 shape, when each venue ran its own process).
export const OPEN_ORDERS_GAUGE = makeGaugeProvider({
  name: 'open_orders',
  help: 'Open (resting) order count, by venue',
  labelNames: ['venue'],
});
export const IN_FLIGHT_GAUGE = makeGaugeProvider({
  name: 'in_flight_intents',
  help: 'In-flight (reserved) intent count, by venue',
  labelNames: ['venue'],
});

// v3 §8/§6.4: per-venue capital-split observables — the wallet's free quote/margin balance and the
// sizer's remaining split headroom. `venue_capital_headroom_usdt` replicates the exact §6.1 formula
// (venueCap(v) − venueOpenNotional(v) − venueReservedNotional(v)) for display; like
// position_notional_usdt above, open notional uses avgEntry rather than a live ref price (no
// FeedHealthPort injection in this service) — a display-grade approximation, never a sizing input.
export const VENUE_FREE_CASH_GAUGE = makeGaugeProvider({
  name: 'venue_free_cash_usdt',
  help: "Free quote/margin balance in each venue wallet (the split's observable), USDT",
  labelNames: ['venue'],
});
export const VENUE_CAPITAL_HEADROOM_GAUGE = makeGaugeProvider({
  name: 'venue_capital_headroom_usdt',
  help: 'Per-venue capital-split headroom: venueCap − open notional − reserved notional (spec §6.1), USDT',
  labelNames: ['venue'],
});

// Agentic-lane metrics (G3b). Recorded via AgentMetricsRecorder, NOT sampled by this service's loop —
// the agentic lane calls the recorder's methods directly as decisions/tokens/rejections occur.
// `model` on both counters (#28): decide (Sonnet) and reflection (Opus) tokens land in the same
// counter, and their per-MTok prices differ ~5× — without the label Prometheus cannot split $/day
// per model once reflection fires. Bounded cardinality: values come from AGENTIC_MODEL /
// AGENTIC_REFLECTION_MODEL config (1-2 ids), 'unknown' only from call sites that predate the label.
export const AGENT_DECIDE_COUNTER = makeCounterProvider({
  name: 'agent_decide_total',
  help: 'Agentic lane decide() outcomes',
  labelNames: ['outcome', 'model'] as const,
});
// 1 while AnthropicAgentClient is inside its FATAL-error latch (no LLM calls being made), 0 once a
// decide completes normally. A LEVEL, deliberately, not a counter-window: the 2026-07-27 outage
// showed that every counter-derived formulation of "the lane is dead right now" is either unable to
// clear (`sum(agent_decide_total{outcome="error_fatal"}) > 0` holds until a container recreate) or
// unable to fire in time — `increase(...{outcome="client_latched"}[2h])` reads 0 through the FIRST
// latch, because prom-client creates a label child lazily and a batched consult births the whole
// series in one tick, so every sample in the range is equal (the same first-sample-after-reset trap
// alerts.rules.yml documents for AgenticReflectionNeverMinted). A gauge fires on the next scrape and
// clears on the next scrape, and depends on no consult cadence, so a host-sleep gap cannot false-clear
// it. Label-less: one client, one book.
export const AGENT_CLIENT_LATCHED_GAUGE = makeGaugeProvider({
  name: 'agent_client_latched',
  help: 'Agentic lane client latched degraded by a FATAL API error (1) or making calls normally (0)',
});
export const AGENT_TOKENS_COUNTER = makeCounterProvider({
  name: 'agent_tokens_total',
  help: 'Agentic lane LLM token usage, by kind and model',
  labelNames: ['kind', 'model'] as const,
});
export const AGENT_DECIDE_LATENCY_HISTOGRAM = makeHistogramProvider({
  name: 'agent_decide_latency_seconds',
  help: 'Agentic lane decide() latency in seconds',
  buckets: [0.5, 1, 2, 5, 10, 15, 20, 30],
});
export const AGENTIC_PLAYBOOK_INFO_GAUGE = makeGaugeProvider({
  name: 'agentic_playbook_info',
  help: 'Active agentic playbook version info (1 on the active version)',
  labelNames: ['version'] as const,
});
export const PLAYBOOK_VALIDATOR_REJECTIONS_COUNTER = makeCounterProvider({
  name: 'playbook_validator_rejections_total',
  help: 'Playbook validator rejections, tagged by whether the denylist tripwire fired and which concept',
  // `token` is the matched denylist concept label (bounded ~20-value set) or 'none' for a structural
  // rejection — low cardinality, so the exact trigger is queryable without the ephemeral warn log.
  labelNames: ['banned_token', 'token'] as const,
});
// (E) Which agent client the lane bound at boot: 'stub' = inert (no ANTHROPIC_API_KEY, or test/ci) so
// the demo proposes nothing; 'anthropic' = a live client that actually decides. One series carries 1.
export const AGENT_CLIENT_INFO_GAUGE = makeGaugeProvider({
  name: 'agent_client_info',
  help: 'Bound agentic client kind (1 on the active kind; stub = INERT, anthropic = LIVE)',
  labelNames: ['kind'] as const,
});
// P6 (Design § Learning & measurement stack): renamed from AGENTIC_PRESCREEN_COUNTER —
// evaluateConsultSchedule (agentic.strategy.ts, B2) replaced the prescreen gate outright, so the
// metric now carries B2's ConsultGateOutcome six-member set directly; the old `reason` label had
// no ConsultGateOutcome equivalent (the outcome itself already encodes what drove it) and is
// dropped rather than stubbed.
export const AGENTIC_CONSULT_GATE_COUNTER = makeCounterProvider({
  name: 'agentic_consult_gate_total',
  help:
    'Consult-gate outcomes ahead of agentic LLM calls (consulted / skipped_scheduled / ' +
    'forced_fill / forced_move / forced_fallback / forced_rearm)',
  labelNames: ['outcome'] as const,
});
// W2: every silent exit in the reflection loop (onClosedTrade/runReflection/maybeAutoPromote) now
// increments this with a closed-set outcome label — the loop's only prior mint was invisible from
// outside a debugger (see reflection.service.ts's own header comment on the confirmed root cause).
export const AGENTIC_REFLECTION_OUTCOMES_COUNTER = makeCounterProvider({
  name: 'agentic_reflection_outcomes_total',
  help: 'Reflection loop attempt outcomes, labeled by the exit reason (bound closed set)',
  labelNames: ['outcome'] as const,
});
// AGENTIC_VENUE_TP: venue-resting take-profit lifecycle events for plan-mode longs, emitted by
// agentic.strategy.ts's manageVenueTp/runActivePlan (see VenueTpEvent there for the bound label set:
// placed / skipped_existing / cancel_for_exit / drift_cancel / filled_flat).
export const AGENTIC_VENUE_TP_COUNTER = makeCounterProvider({
  name: 'agentic_venue_tp_total',
  help: 'Venue-resting take-profit lifecycle events (bound closed set — see VenueTpEvent), by venue',
  labelNames: ['venue', 'event'] as const,
});
// Push 3 P7d (AGENTIC_VENUE_STOP): venue-resting protective stop lifecycle events for plan-mode
// positions, emitted by agentic.strategy.ts's manageVenueStop/runActivePlan (see VenueStopEvent
// there for the bound label set: placed / skipped_existing / skipped_inflight / cancel_for_exit /
// drift_cancel / qty_cancel / orphan_cancel / filled_flat / stood_down / force_fired / triggered —
// Defect A commit-1, 2026-07-16). Query
// patterns: `rate(agentic_venue_stop_total{event="force_fired"}[1h]) > 0` flags a venue stop that
// evidently failed to fill on its own (worth an operator look at the venue's algo-order health);
// `sum by (event) (agentic_venue_stop_total)` gives the same at-a-glance lifecycle mix
// agentic_venue_tp_total already provides for the TP side.
export const AGENTIC_VENUE_STOP_COUNTER = makeCounterProvider({
  name: 'agentic_venue_stop_total',
  help: 'Venue-resting protective stop lifecycle events (bound closed set — see VenueStopEvent), by venue',
  labelNames: ['venue', 'event'] as const,
});

// C1: derivatives-feed health, sampled in the 5s loop below (same pull pattern as kill_switch_state
// and event_loop_utilization). Present regardless of DERIVATIVES_FEED_ENABLED — staleness simply
// never drops while the feed is unwired/disabled (NOOP_DERIVATIVES_FEED.lastSuccessfulPollAt is
// always null, sampled as -1 below so "never polled" is distinguishable from "just polled").
export const DERIVATIVES_FEED_STALENESS_GAUGE = makeGaugeProvider({
  name: 'derivatives_feed_staleness_seconds',
  help: 'Seconds since the derivatives feed last polled successfully (-1 if never)',
});
export const DERIVATIVES_FEED_POLL_ERRORS_COUNTER = makeCounterProvider({
  name: 'derivatives_feed_poll_errors_total',
  help: 'Cumulative derivatives-feed poll failures',
});

// C4: sentiment-feed health, sampled in the same 5s pull loop below — mirrors the derivatives-feed
// gauge/counter pair above. Present regardless of SENTIMENT_FEED_ENABLED — staleness simply never
// drops while the feed is unwired/disabled/keyless.
export const SENTIMENT_FEED_STALENESS_GAUGE = makeGaugeProvider({
  name: 'sentiment_feed_staleness_seconds',
  help: 'Seconds since the sentiment feed last polled successfully (-1 if never)',
});
export const SENTIMENT_FEED_POLL_ERRORS_COUNTER = makeCounterProvider({
  name: 'sentiment_feed_poll_errors_total',
  help: 'Cumulative sentiment-feed poll failures',
});

// Market-stream channel staleness + watchdog reconnects, sampled in the same 5s pull loop
// (MARKET_STREAM_TELEMETRY). Motivated by the 2026-07-16 incident: all five spot candle channels
// hung silently for 8h with zero log/metric/alert surface — a stalled ccxt watch* future is
// invisible to the supervised loops, so staleness must be exported and alerted on independently.
// Bounded cardinality: symbols × 4 channel kinds (ticker/trade/book/candle:<tf>) ≈ 20 series.
export const MARKET_CHANNEL_STALENESS_GAUGE = makeGaugeProvider({
  name: 'market_channel_staleness_seconds',
  help: 'Seconds since each market-data websocket channel last delivered an event, by venue',
  labelNames: ['venue', 'symbol', 'channel'] as const,
});
// v3 §8: +venue. MarketStreamTelemetryPort.forcedReconnectCount() is still a single process-wide
// aggregate today (the per-venue split is workstream #5's MarketStreamsModule merge, spec §1.3:
// "forced-reconnect counts summed per venue") — see the sampling loop below for how the aggregate is
// labeled until that facade lands.
export const MARKET_STREAM_FORCED_RECONNECTS_COUNTER = makeCounterProvider({
  name: 'market_stream_forced_reconnects_total',
  help:
    'Watchdog-forced websocket reconnects after a channel (ticker/trade/book/candle) stalled ' +
    'silently, by venue',
  labelNames: ['venue'] as const,
});

// W1 (Grafana rebuild): funding-ingest / universe-scanner / agent-budget metrics recorded via
// AgentMetricsRecorder from FundingIngestService/UniverseScannerService/TradingRuntimeService — same
// cross-boundary duplicated-provider convention as AGENTIC_VENUE_TP_COUNTER/AGENTIC_VENUE_STOP_COUNTER
// above (those callers live in features/strategy/agentic too but are recorded through the same seam).
export const FUNDING_PAYMENTS_INGESTED_COUNTER = makeCounterProvider({
  name: 'funding_payments_ingested_total',
  help: 'Perp funding-payment settlement rows ingested from the venue (FundingIngestService), by venue/symbol',
  labelNames: ['venue', 'symbol'] as const,
});
export const AGENTIC_ACTIVE_MENU_GAUGE = makeGaugeProvider({
  name: 'agentic_active_menu',
  help: 'Universe scanner active-menu membership (1 on a symbol currently in the consulted menu; absent otherwise)',
  labelNames: ['symbol'] as const,
});
export const AGENTIC_MENU_CHURN_COUNTER = makeCounterProvider({
  name: 'agentic_menu_churn_total',
  help: 'Universe scanner active-menu churn — symbols entering/leaving the menu per recompute, by direction',
  labelNames: ['direction'] as const,
});
export const AGENTIC_BUDGET_REMAINING_GAUGE = makeGaugeProvider({
  name: 'agentic_budget_remaining_usd',
  help: 'Remaining daily LLM spend budget (USD) before the cost breaker trips — DailyLlmBudget.budgetBlock(), ONE shared lane-wide cap (not per-strategy: AGENT_LLM_BUDGET is a single instance shared across all strategy instances in this process)',
});

// v3 §4.3: the client zod layer degrades an `open_short` on a spot symbol (capabilities.shorts is
// false) to `hold`, journaled with rationale `capability_violation:open_short_on_spot` — this
// counter is that degrade's Prometheus mirror. `kind` is the bound violation-kind set the tool
// contract defines; workstream #10 (agentic) is the caller, through this recorder interface only.
export const AGENTIC_CAPABILITY_VIOLATIONS_COUNTER = makeCounterProvider({
  name: 'agentic_capability_violations_total',
  help: 'Per-symbol capability violations degraded to hold by the client zod layer (spec §4.3), by kind',
  labelNames: ['kind'] as const,
});

// 2026-07-22 schema-hardening: the client zod layer degrades a schema-rejected propose/proposeBatch
// tool payload to `hold` with an explicit `schema_rejected:` rationale (anthropic-agent-client.ts's
// four schema-fail branches) — this counter is that degrade's Prometheus mirror, same convention as
// AGENTIC_CAPABILITY_VIOLATIONS_COUNTER above. `kind` distinguishes the four failure modes: 'single'
// (submit_trade payload), 'batch' (whole submit_portfolio payload), 'element' (one decisions[] entry),
// 'missing_symbol' (a requested symbol absent from decisions[]).
export const AGENTIC_SCHEMA_REJECTIONS_COUNTER = makeCounterProvider({
  name: 'agentic_schema_rejections_total',
  help: 'Per-call tool-payload schema rejections degraded to hold by the client zod layer, by kind',
  labelNames: ['kind'] as const,
});

// Backlog #53: fail-open measurement of ReflectionService.evaluateTrigger's silent pre-fire exits
// (below_threshold/cooldown/inflight/fired) — pre-registered as pure observability, no control-flow
// change, so a metrics-layer failure must never affect whether reflection fires.
export const AGENTIC_REFLECTION_TRIGGER_COUNTER = makeCounterProvider({
  name: 'agentic_reflection_trigger_total',
  help: 'ReflectionService.evaluateTrigger exits, by outcome (below_threshold/cooldown/inflight/fired)',
  labelNames: ['outcome'] as const,
});

// 2026-07-24 fail-closed re-arm fallback: agentic.strategy.ts attaches a synthetic protective plan
// when a positioned consult returns hold/adjust without directives — this counter is that attach's
// Prometheus mirror (label-free; one series process-wide). Query: increase(agentic_rearm_fallback_total[24h]).
export const AGENTIC_REARM_FALLBACK_COUNTER = makeCounterProvider({
  name: 'agentic_rearm_fallback_total',
  help: 'Synthetic protective plans attached when a positioned consult returned hold/adjust without directives',
});

// §strategy lifecycle — sampled in the 5s loop below (same pull pattern as kill_switch_state):
// each strategy carries exactly one state at 1, all others in the union explicit 0 (not just absent),
// so a terminal DRAINING/HALTED strategy is directly alertable rather than a "no data" gap.
export const STRATEGY_LIFECYCLE_GAUGE = makeGaugeProvider({
  name: 'strategy_lifecycle',
  help: 'Per-strategy lifecycle state (1 for current state, 0 for others)',
  labelNames: ['strategy', 'state'] as const,
});
const ALL_LIFECYCLE_STATES: readonly StrategyLifecycle[] = [
  'LOADING',
  'WARMUP',
  'ACTIVE',
  'DRAINING',
  'HALTED',
  'UNLOADED',
];

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private sampleInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectMetric('event_loop_delay_p99_seconds')
    private readonly loopDelayGauge: Gauge<string>,
    @InjectMetric('event_loop_utilization')
    private readonly loopUtilizationGauge: Gauge<string>,
    @InjectMetric('mode_info')
    private readonly modeInfoGauge: Gauge<string>,
    @InjectMetric('boot_info')
    private readonly bootInfoGauge: Gauge<string>,
    @InjectMetric('kill_switch_state')
    private readonly killSwitchGauge: Gauge<string>,
    @InjectMetric('equity_usdt') private readonly equityGauge: Gauge<string>,
    @InjectMetric('cash_usdt') private readonly cashGauge: Gauge<string>,
    @InjectMetric('peak_equity_usdt') private readonly peakEquityGauge: Gauge<string>,
    @InjectMetric('day_pnl_usdt') private readonly dayPnlGauge: Gauge<string>,
    @InjectMetric('drawdown_ratio') private readonly drawdownGauge: Gauge<string>,
    @InjectMetric('unrealized_pnl_usdt') private readonly unrealizedPnlGauge: Gauge<string>,
    @InjectMetric('starting_cash_usdt') private readonly startingCashGauge: Gauge<string>,
    @InjectMetric('realized_pnl_usdt') private readonly realizedPnlGauge: Gauge<string>,
    @InjectMetric('position_qty') private readonly positionQtyGauge: Gauge<string>,
    @InjectMetric('position_notional_usdt') private readonly positionNotionalGauge: Gauge<string>,
    @InjectMetric('open_orders') private readonly openOrdersGauge: Gauge<string>,
    @InjectMetric('in_flight_intents') private readonly inFlightGauge: Gauge<string>,
    @InjectMetric('strategy_lifecycle') private readonly strategyLifecycleGauge: Gauge<string>,
    @InjectMetric('derivatives_feed_staleness_seconds')
    private readonly derivativesStalenessGauge: Gauge<string>,
    @InjectMetric('derivatives_feed_poll_errors_total')
    private readonly derivativesPollErrorsCounter: Counter<string>,
    @InjectMetric('sentiment_feed_staleness_seconds')
    private readonly sentimentStalenessGauge: Gauge<string>,
    @InjectMetric('sentiment_feed_poll_errors_total')
    private readonly sentimentPollErrorsCounter: Counter<string>,
    @InjectMetric('market_channel_staleness_seconds')
    private readonly marketChannelStalenessGauge: Gauge<string>,
    @InjectMetric('market_stream_forced_reconnects_total')
    private readonly marketStreamReconnectsCounter: Counter<string>,
    @InjectMetric('venue_free_cash_usdt') private readonly venueFreeCashGauge: Gauge<string>,
    @InjectMetric('venue_capital_headroom_usdt')
    private readonly venueCapitalHeadroomGauge: Gauge<string>,
    private readonly configService: TypedConfigService,
    private readonly eventLoopIndicator: EventLoopHealthIndicator,
    // @Optional so observability can boot standalone (no kill switch) — the gauge is simply not set.
    @Optional() @Inject(KILL_SWITCH) private readonly killSwitch?: KillSwitchPort,
    // @Optional so observability boots standalone; in the running app the composition root bridges
    // PORTFOLIO_VIEW into global scope so the trading gauges are populated from the canonical snapshot.
    @Optional() @Inject(PORTFOLIO_VIEW) private readonly portfolio?: PortfolioViewPort,
    // @Optional: STRATEGY_REGISTRY is not yet bridged into global scope (pending G3c) and is absent in
    // every unit test — sampling below silently skips when it is undefined.
    @Optional() @Inject(STRATEGY_REGISTRY) private readonly registry?: StrategyRegistryPort,
    // C1: @Optional so observability boots standalone (module-isolation tests); in the running app
    // MarketFeedModule is @Global so this always resolves to the real DERIVATIVES_FEED provider
    // (NOOP_DERIVATIVES_FEED when the flag is off — see app.module.ts).
    @Optional() @Inject(DERIVATIVES_FEED) private readonly derivativesFeed?: DerivativesFeedPort,
    // C4: @Optional so observability boots standalone (module-isolation tests); in the running app
    // MarketFeedModule is @Global so this always resolves to the real SENTIMENT_FEED provider
    // (NOOP_SENTIMENT_FEED when the flag/key is off/absent — see app.module.ts).
    @Optional() @Inject(SENTIMENT_FEED) private readonly sentimentFeed?: SentimentFeedPort,
    // @Optional for the same standalone-boot reason; in the running app MarketStreamsModule is
    // @Global so this resolves to the live VenueRoutingFeedHealth facade (or its inert stub under
    // test/ci).
    @Optional()
    @Inject(MARKET_STREAM_TELEMETRY)
    private readonly marketStreamTelemetry?: MarketStreamTelemetryPort,
    // @Optional so observability boots standalone (module-isolation tests without ModeControlModule).
    // ModeControlModule is @Global in the running app, so Overview/Ops mode panels track
    // resolveMode().effective after arming — not a stale boot-time configMode snapshot.
    @Optional() @Inject(MODE_CONTROL) private readonly modeControl?: ModeControlPort,
  ) {}

  private sampleModeInfo(): void {
    // Info-gauge pattern (same as kill_switch_state): reset so only the current label set carries 1.
    // `requested` is always the raw env request (requestedMode) so Ops "{{ requested }} → {{ effective }}"
    // still shows test/ci overrides (e.g. live → paper). `effective` is arming-aware when MODE_CONTROL
    // is bound; ModeControlConfig.requested is configMode and must NOT overwrite this label.
    this.modeInfoGauge.reset();
    const mode = this.configService.mode;
    const requested = mode.requestedMode || 'paper';
    const effective = this.modeControl ? this.modeControl.resolveMode().effective : mode.configMode;
    this.modeInfoGauge.labels({ requested, effective }).set(1);
  }

  onModuleInit() {
    const app = this.configService.app;

    this.sampleModeInfo();
    this.bootInfoGauge.labels({ boot_id: app.bootId }).set(1);

    let prevElu = performance.eventLoopUtilization();
    // C1: cumulative poll-error count as of the previous sample — diffed each tick into the Counter
    // (prom-client Counters only support .inc(), never .set()), same technique as prevElu above.
    let prevDerivativesPollErrors = 0;
    // C4: same delta-against-previous-sample technique as prevDerivativesPollErrors above.
    let prevSentimentPollErrors = 0;
    // Same delta technique for the watchdog's cumulative forced-reconnect count, tracked per-venue
    // (one previous-count entry per venue label) — see the sampling loop below for the real-label
    // switch (v3 §8).
    const prevForcedReconnectsByVenue = new Map<string, number>();

    this.sampleInterval = setInterval(() => {
      const monitor = this.eventLoopIndicator.getMonitor();
      if (monitor) {
        this.loopDelayGauge.set(monitor.percentile(99) / 1e9);
        monitor.reset();
      }
      const elu = performance.eventLoopUtilization(prevElu);
      prevElu = performance.eventLoopUtilization();
      this.loopUtilizationGauge.set(elu.utilization);

      // Resample every tick so arming/disarm changes surface without process restart.
      this.sampleModeInfo();

      if (this.killSwitch) {
        this.killSwitchGauge.reset(); // only the current state carries 1
        this.killSwitchGauge.labels({ state: this.killSwitch.state() }).set(1);
      }

      if (this.portfolio) {
        const snap = this.portfolio.snapshot();
        this.equityGauge.set(snap.equity.toNumber());
        this.cashGauge.set(snap.balances.get('USDT')?.free.toNumber() ?? 0);
        this.peakEquityGauge.set(snap.peakEquity.toNumber());
        this.unrealizedPnlGauge.set(snap.unrealized.toNumber());
        this.startingCashGauge.set(snap.startingCash.toNumber());
        this.dayPnlGauge.set(snap.equity.minus(snap.sodEquityUtc).toNumber());
        this.drawdownGauge.set(
          snap.peakEquity.gt(0)
            ? snap.peakEquity.minus(snap.equity).div(snap.peakEquity).toNumber()
            : 0,
        );
        // v3 §8: open_orders/in_flight_intents are venue-labeled — explicit-zero every configured
        // venue (same convention as strategy_lifecycle's ALL_LIFECYCLE_STATES) so a venue with
        // nothing open reads 0, not absent, then count. OpenOrderSummary carries no venue field yet
        // (pending workstream #8), so its venue is derived via the canonical venueForSymbol mapping;
        // OrderIntent already carries `.venue` directly.
        const configuredVenues = this.configService.venues.map((v) => v.id);
        const openOrdersByVenue = new Map<string, number>(configuredVenues.map((v) => [v, 0]));
        for (const order of snap.openOrders) {
          const venue = venueForSymbol(order.symbol);
          openOrdersByVenue.set(venue, (openOrdersByVenue.get(venue) ?? 0) + 1);
        }
        this.openOrdersGauge.reset();
        for (const [venue, count] of openOrdersByVenue) {
          this.openOrdersGauge.labels({ venue }).set(count);
        }
        const inFlightByVenue = new Map<string, number>(configuredVenues.map((v) => [v, 0]));
        for (const intent of snap.inFlightIntents) {
          inFlightByVenue.set(intent.venue, (inFlightByVenue.get(intent.venue) ?? 0) + 1);
        }
        this.inFlightGauge.reset();
        for (const [venue, count] of inFlightByVenue) {
          this.inFlightGauge.labels({ venue }).set(count);
        }
        // Reset labeled series each tick so a position that closed since last sample drops to absent.
        this.realizedPnlGauge.reset();
        this.positionQtyGauge.reset();
        this.positionNotionalGauge.reset();
        for (const pos of snap.positions.values()) {
          const labels = { venue: pos.venue, strategy: pos.strategyId, symbol: pos.symbol };
          this.realizedPnlGauge.labels(labels).set(pos.realizedPnl.toNumber());
          this.positionQtyGauge.labels(labels).set(pos.signedQty.toNumber());
          this.positionNotionalGauge
            .labels(labels)
            .set(pos.signedQty.abs().mul(pos.avgEntry).toNumber());
        }

        // v3 §8/§6.4: venue_free_cash_usdt — sourced from PortfolioSnapshot.venueBalances
        // (workstream #8, PortfolioStateService). Optional on the type until the composition root
        // wires a venue-keyed balance source, so the gauge simply stays unset (no series) rather
        // than fabricating a value when absent.
        this.venueFreeCashGauge.reset();
        if (snap.venueBalances) {
          for (const [venue, assets] of snap.venueBalances) {
            const free = assets.get('USDT')?.free;
            if (free) {
              this.venueFreeCashGauge.labels({ venue }).set(free.toNumber());
            }
          }
        }

        // v3 §6.1: venue_capital_headroom_usdt = venueCap(v) − venueOpenNotional(v) −
        // venueReservedNotional(v), computed directly off already-available snapshot data + the
        // landed VENUE_CAPITAL_SPLIT config (no dependency on workstream #8's venueBalances field —
        // unlike free-cash above, every input this formula needs already exists on PortfolioSnapshot).
        const venueCapitalSplit = this.configService.venueCapitalSplit;
        this.venueCapitalHeadroomGauge.reset();
        if (Object.keys(venueCapitalSplit).length > 0) {
          const openNotionalByVenue = new Map<string, Decimal>();
          for (const pos of snap.positions.values()) {
            const notional = pos.signedQty.abs().mul(pos.avgEntry);
            openNotionalByVenue.set(
              pos.venue,
              (openNotionalByVenue.get(pos.venue) ?? new Decimal(0)).plus(notional),
            );
          }
          const reservedNotionalByVenue = new Map<string, Decimal>();
          for (const intent of snap.inFlightIntents) {
            if (intent.reduceOnly) continue; // §6.3: reduce-only is exempt from every split clamp
            const price = intent.limitPrice ?? intent.refPrice;
            const notional = intent.qty.mul(price);
            reservedNotionalByVenue.set(
              intent.venue,
              (reservedNotionalByVenue.get(intent.venue) ?? new Decimal(0)).plus(notional),
            );
          }
          for (const [venue, capStr] of Object.entries(venueCapitalSplit)) {
            const cap = new Decimal(capStr);
            const open = openNotionalByVenue.get(venue) ?? new Decimal(0);
            const reserved = reservedNotionalByVenue.get(venue) ?? new Decimal(0);
            this.venueCapitalHeadroomGauge
              .labels({ venue })
              .set(cap.minus(open).minus(reserved).toNumber());
          }
        }
      }

      if (this.registry) {
        this.strategyLifecycleGauge.reset(); // drop any strategy no longer in the registry
        for (const { id, lifecycle } of this.registry.states()) {
          for (const state of ALL_LIFECYCLE_STATES) {
            this.strategyLifecycleGauge
              .labels({ strategy: id, state })
              .set(state === lifecycle ? 1 : 0);
          }
        }
      }

      if (this.derivativesFeed) {
        const lastSuccessAt = this.derivativesFeed.lastSuccessfulPollAt();
        this.derivativesStalenessGauge.set(
          lastSuccessAt === null ? -1 : (Date.now() - lastSuccessAt) / 1000,
        );
        const totalErrors = this.derivativesFeed.pollErrorCount();
        if (totalErrors > prevDerivativesPollErrors) {
          this.derivativesPollErrorsCounter.inc(totalErrors - prevDerivativesPollErrors);
        }
        prevDerivativesPollErrors = totalErrors;
      }

      if (this.sentimentFeed) {
        const lastSuccessAt = this.sentimentFeed.lastSuccessfulPollAt();
        this.sentimentStalenessGauge.set(
          lastSuccessAt === null ? -1 : (Date.now() - lastSuccessAt) / 1000,
        );
        const totalErrors = this.sentimentFeed.pollErrorCount();
        if (totalErrors > prevSentimentPollErrors) {
          this.sentimentPollErrorsCounter.inc(totalErrors - prevSentimentPollErrors);
        }
        prevSentimentPollErrors = totalErrors;
      }

      if (this.marketStreamTelemetry) {
        // Reset labeled series each tick so a channel dropped from the subscription set goes
        // absent instead of freezing at its last age (same pattern as the position gauges above).
        this.marketChannelStalenessGauge.reset();
        for (const age of this.marketStreamTelemetry.channelAges()) {
          this.marketChannelStalenessGauge
            .labels({ venue: age.venue, symbol: age.symbol, channel: age.channel })
            .set(age.ageSeconds);
        }
        // v3 §8: real per-venue labels via forcedReconnectCountByVenue when the bound telemetry
        // exposes it (MarketStreamsModule's VenueRoutingFeedHealth does — see that class's own
        // method). Falls back to one 'aggregate' series for any telemetry shape that predates the
        // per-venue split (module-isolation fixtures, the ExecutionModule-standalone noopFeedHealth
        // path) — same 'aggregate' label the pre-v3 single-process counter used.
        const telemetry = this.marketStreamTelemetry;
        const perVenue = telemetry.forcedReconnectCountByVenue?.();
        const entries: ReadonlyArray<readonly [string, number]> = perVenue
          ? [...perVenue.entries()]
          : [['aggregate', telemetry.forcedReconnectCount()]];
        for (const [venue, total] of entries) {
          const prev = prevForcedReconnectsByVenue.get(venue) ?? 0;
          if (total > prev) {
            this.marketStreamReconnectsCounter.inc({ venue }, total - prev);
          }
          prevForcedReconnectsByVenue.set(venue, total);
        }
      }
    }, 5000);
  }

  onModuleDestroy() {
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
  }
}
