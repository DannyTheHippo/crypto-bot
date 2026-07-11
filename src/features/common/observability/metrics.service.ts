import { Injectable, OnModuleInit, OnModuleDestroy, Optional, Inject } from '@nestjs/common';
import {
  InjectMetric,
  makeGaugeProvider,
  makeCounterProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { Gauge, Counter } from 'prom-client';
import { performance } from 'perf_hooks';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/risk';
import { PORTFOLIO_VIEW, type PortfolioViewPort } from '../../../ports/execution';
import {
  STRATEGY_REGISTRY,
  type StrategyRegistryPort,
  type StrategyLifecycle,
} from '../../../ports/strategy';
import { DERIVATIVES_FEED, type DerivativesFeedPort } from '../../../ports/derivatives-feed';
import { SENTIMENT_FEED, type SentimentFeedPort } from '../../../ports/sentiment-feed';
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
  help: 'Trading mode info',
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
  help: 'Realized PnL per strategy/symbol, USDT',
  labelNames: ['strategy', 'symbol'],
});
export const POSITION_QTY_GAUGE = makeGaugeProvider({
  name: 'position_qty',
  help: 'Signed position quantity per strategy/symbol',
  labelNames: ['strategy', 'symbol'],
});
export const POSITION_NOTIONAL_GAUGE = makeGaugeProvider({
  name: 'position_notional_usdt',
  help: 'abs(position) × avgEntry per strategy/symbol, USDT',
  labelNames: ['strategy', 'symbol'],
});
export const OPEN_ORDERS_GAUGE = makeGaugeProvider({
  name: 'open_orders',
  help: 'Open (resting) order count',
});
export const IN_FLIGHT_GAUGE = makeGaugeProvider({
  name: 'in_flight_intents',
  help: 'In-flight (reserved) intent count',
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
export const AGENTIC_PRESCREEN_COUNTER = makeCounterProvider({
  name: 'agentic_prescreen_total',
  help:
    'Prescreen gate outcomes ahead of agentic LLM calls (called / skipped_quiet / failopen_error), ' +
    'labeled by the PrescreenReason that drove it (position_open / vol_expansion / ' +
    'breakout_proximity / insufficient_data / quiet / n/a for failopen_error)',
  labelNames: ['outcome', 'reason'] as const,
});
// W2: every silent exit in the reflection loop (onClosedTrade/runReflection/maybeAutoPromote) now
// increments this with a closed-set outcome label — the loop's only prior mint was invisible from
// outside a debugger (see reflection.service.ts's own header comment on the confirmed root cause).
export const AGENTIC_REFLECTION_OUTCOMES_COUNTER = makeCounterProvider({
  name: 'agentic_reflection_outcomes_total',
  help: 'Reflection loop attempt outcomes, labeled by the exit reason (bound closed set)',
  labelNames: ['outcome'] as const,
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
  ) {}

  onModuleInit() {
    const mode = this.configService.mode;
    const app = this.configService.app;

    this.modeInfoGauge
      .labels({ requested: mode.requestedMode || 'paper', effective: mode.configMode })
      .set(1);
    this.bootInfoGauge.labels({ boot_id: app.bootId }).set(1);

    let prevElu = performance.eventLoopUtilization();
    // C1: cumulative poll-error count as of the previous sample — diffed each tick into the Counter
    // (prom-client Counters only support .inc(), never .set()), same technique as prevElu above.
    let prevDerivativesPollErrors = 0;
    // C4: same delta-against-previous-sample technique as prevDerivativesPollErrors above.
    let prevSentimentPollErrors = 0;

    this.sampleInterval = setInterval(() => {
      const monitor = this.eventLoopIndicator.getMonitor();
      if (monitor) {
        this.loopDelayGauge.set(monitor.percentile(99) / 1e9);
        monitor.reset();
      }
      const elu = performance.eventLoopUtilization(prevElu);
      prevElu = performance.eventLoopUtilization();
      this.loopUtilizationGauge.set(elu.utilization);

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
        this.openOrdersGauge.set(snap.openOrders.length);
        this.inFlightGauge.set(snap.inFlightIntents.length);
        // Reset labeled series each tick so a position that closed since last sample drops to absent.
        this.realizedPnlGauge.reset();
        this.positionQtyGauge.reset();
        this.positionNotionalGauge.reset();
        for (const pos of snap.positions.values()) {
          const labels = { strategy: pos.strategyId, symbol: pos.symbol };
          this.realizedPnlGauge.labels(labels).set(pos.realizedPnl.toNumber());
          this.positionQtyGauge.labels(labels).set(pos.signedQty.toNumber());
          this.positionNotionalGauge
            .labels(labels)
            .set(pos.signedQty.abs().mul(pos.avgEntry).toNumber());
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
    }, 5000);
  }

  onModuleDestroy() {
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
  }
}
