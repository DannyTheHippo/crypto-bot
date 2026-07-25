import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge, Histogram } from 'prom-client';

export type AgentDecideOutcome =
  | 'proposed'
  | 'hold'
  | 'noop'
  | 'error_retryable'
  | 'error_fatal'
  | 'timeout'
  | 'budget_blocked';

export type AgentTokenKind = 'input' | 'output' | 'cache_read' | 'cache_creation';

// P6 (Design § Learning & measurement stack): mirrors agentic.strategy.ts's ConsultGateOutcome
// (B2) — duplicated rather than imported, same boundaries-wall convention as AgentVenueTpEvent/
// AgentVenueStopEvent below. Supersedes the retired AgentPrescreenOutcome/AgentPrescreenReason
// pair: evaluateConsultSchedule folded "why" into the outcome itself, so there is no separate
// reason label to carry forward.
export type ConsultGateOutcome =
  | 'consulted'
  | 'skipped_scheduled'
  | 'forced_fill'
  | 'forced_move'
  | 'forced_fallback'
  | 'forced_rearm';

// Mirrors agentic.strategy.ts's VenueTpEvent — duplicated rather than imported (the boundaries wall
// forbids this feature importing trading/agentic, same convention as ConsultGateOutcome above).
export type AgentVenueTpEvent =
  | 'placed'
  | 'skipped_existing'
  | 'skipped_inflight'
  | 'cancel_for_exit'
  | 'drift_cancel'
  | 'qty_cancel'
  | 'tp_race_hold'
  | 'orphan_cancel'
  | 'filled_flat';

// Mirrors agentic.strategy.ts's VenueStopEvent (Push 3 P7d) — duplicated rather than imported, same
// convention as AgentVenueTpEvent above. 'triggered' (Defect A commit-1, 2026-07-16) — see
// VenueStopEvent's own comment.
export type AgentVenueStopEvent =
  | 'placed'
  | 'skipped_existing'
  | 'skipped_inflight'
  | 'cancel_for_exit'
  | 'drift_cancel'
  | 'qty_cancel'
  | 'orphan_cancel'
  | 'filled_flat'
  | 'stood_down'
  | 'force_fired'
  | 'reconcile_error'
  | 'triggered';

// Typed recorder over the agentic-lane providers registered in metrics.service.ts. Exported from
// ObservabilityModule so the composition root can hand it (or closures over it) to the agentic lane —
// this module never imports features/strategy/agentic itself (the boundaries wall runs the other way).
// Every method swallows and drops prom-client errors: metrics must never throw into a trading path.
@Injectable()
export class AgentMetricsRecorder {
  private activePlaybookVersion: number | null = null;

  constructor(
    @InjectMetric('agent_decide_total') private readonly decideCounter: Counter<string>,
    @InjectMetric('agent_tokens_total') private readonly tokensCounter: Counter<string>,
    @InjectMetric('agent_decide_latency_seconds')
    private readonly decideLatency: Histogram<string>,
    @InjectMetric('agentic_playbook_info') private readonly playbookInfoGauge: Gauge<string>,
    @InjectMetric('playbook_validator_rejections_total')
    private readonly validatorRejectionsCounter: Counter<string>,
    @InjectMetric('agent_client_info') private readonly clientInfoGauge: Gauge<string>,
    @InjectMetric('agentic_consult_gate_total')
    private readonly consultGateCounter: Counter<string>,
    @InjectMetric('agentic_reflection_outcomes_total')
    private readonly reflectionOutcomesCounter: Counter<string>,
    @InjectMetric('agentic_venue_tp_total')
    private readonly venueTpCounter: Counter<string>,
    @InjectMetric('agentic_venue_stop_total')
    private readonly venueStopCounter: Counter<string>,
    @InjectMetric('funding_payments_ingested_total')
    private readonly fundingIngestedCounter: Counter<string>,
    @InjectMetric('agentic_active_menu') private readonly activeMenuGauge: Gauge<string>,
    @InjectMetric('agentic_menu_churn_total')
    private readonly menuChurnCounter: Counter<string>,
    @InjectMetric('agentic_budget_remaining_usd')
    private readonly budgetRemainingGauge: Gauge<string>,
    @InjectMetric('agentic_capability_violations_total')
    private readonly capabilityViolationsCounter: Counter<string>,
    @InjectMetric('agentic_schema_rejections_total')
    private readonly schemaRejectionsCounter: Counter<string>,
    @InjectMetric('agentic_reflection_trigger_total')
    private readonly reflectionTriggerCounter: Counter<string>,
    @InjectMetric('agentic_rearm_fallback_total')
    private readonly rearmFallbackCounter: Counter<string>,
  ) {}

  // `model` on both methods (#28): optional with an 'unknown' fallback so the label is always
  // materialized (never prom-client's implicit "") and pre-label call sites/test fakes keep working.
  recordDecide(outcome: AgentDecideOutcome, model?: string): void {
    try {
      this.decideCounter.inc({ outcome, model: model ?? 'unknown' });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Cache kinds are inc'd only when the response actually carried the field: an absent series
  // (envelope never reported cache usage) and a zero series (confirmed zero cache reads) answer
  // the W2.4 falsifiability check differently (see AgentUsage in ports/strategy/agentic-strategy.ts).
  // These series also expose the cache-write premium the flat 3/15 accounting can't see —
  // cache_creation tokens bill above base input rate and appear in NEITHER input nor output.
  recordTokens(
    input: number,
    output: number,
    cacheRead?: number,
    cacheCreation?: number,
    model?: string,
  ): void {
    try {
      const m = model ?? 'unknown';
      this.tokensCounter.inc({ kind: 'input', model: m }, input);
      this.tokensCounter.inc({ kind: 'output', model: m }, output);
      if (cacheRead !== undefined) {
        this.tokensCounter.inc({ kind: 'cache_read', model: m }, cacheRead);
      }
      if (cacheCreation !== undefined) {
        this.tokensCounter.inc({ kind: 'cache_creation', model: m }, cacheCreation);
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  observeDecideLatency(seconds: number): void {
    try {
      this.decideLatency.observe(seconds);
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Clears the previously-active version's series (rather than leaving it lingering at 0) before
  // setting the new one — an "info" gauge should only ever carry one live series at a time.
  setPlaybookInfo(version: number): void {
    try {
      if (this.activePlaybookVersion !== null && this.activePlaybookVersion !== version) {
        this.playbookInfoGauge.remove({ version: String(this.activePlaybookVersion) });
      }
      this.playbookInfoGauge.labels({ version: String(version) }).set(1);
      this.activePlaybookVersion = version;
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  recordValidatorRejection(bannedTokenHit: boolean, token?: string): void {
    try {
      this.validatorRejectionsCounter.inc({
        banned_token: String(bannedTokenHit),
        token: token ?? 'none',
      });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // (E) Set once at boot to the bound client kind ('stub' | 'anthropic'). The kind is fixed for the
  // process lifetime, so a single series is set and never cleared (unlike setPlaybookInfo, which
  // rotates on promotion). Surfaced as the dashboard "client status" panel — the loud, always-on
  // signal for whether the demo is actually deciding vs inertly holding.
  setClientInfo(kind: string): void {
    try {
      this.clientInfoGauge.labels({ kind }).set(1);
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // P6: renamed from recordPrescreen — see ConsultGateOutcome above for the six-member set B2's
  // evaluateConsultSchedule emits. Single `outcome` label (no `reason`): unlike prescreen's
  // outcome/reason pair, the consult-gate outcome already names what drove it.
  recordConsultGate(outcome: ConsultGateOutcome): void {
    try {
      this.consultGateCounter.inc({ outcome });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // W2: bound closed set of outcome labels emitted by ReflectionService's own ReflectionMetricsRecorder
  // interface — duplicated rather than imported (boundaries wall, same reasoning as
  // ConsultGateOutcome above).
  recordReflectionOutcome(outcome: string): void {
    try {
      this.reflectionOutcomesCounter.inc({ outcome });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // AGENTIC_VENUE_TP: bound closed set of lifecycle events — see AgentVenueTpEvent above. `venue`
  // is optional (defaults to 'unknown') so the pre-v3 call site (app.module.ts, one process = one
  // venue) keeps compiling unchanged until the composition workstream's per-venue wiring lands.
  recordVenueTp(event: AgentVenueTpEvent, venue?: string): void {
    try {
      this.venueTpCounter.inc({ venue: venue ?? 'unknown', event });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Push 3 P7d (AGENTIC_VENUE_STOP): bound closed set of lifecycle events — see AgentVenueStopEvent
  // above. `venue` optional for the same reason as recordVenueTp above.
  recordVenueStop(event: AgentVenueStopEvent, venue?: string): void {
    try {
      this.venueStopCounter.inc({ venue: venue ?? 'unknown', event });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // W1 (Grafana rebuild): FundingIngestService.pollOne() calls this after a successful non-empty
  // write, one call per (venue, symbol) poll — mirrors fills_total's plain counter shape, no
  // agentic_ prefix (funding ingestion is a venue-truth feed, not an agentic-lane decision metric).
  recordFundingIngested(venue: string, symbol: string, count: number): void {
    try {
      this.fundingIngestedCounter.inc({ venue, symbol }, count);
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // W1: UniverseScannerService.recompute() calls this with the fresh active-menu set each recompute.
  // reset()-then-set mirrors MetricsService's own labeled-gauge convention (e.g. positionQtyGauge) —
  // a symbol that drops out of the menu goes absent rather than lingering at a stale 1.
  setActiveMenu(symbols: readonly string[]): void {
    try {
      this.activeMenuGauge.reset();
      for (const symbol of symbols) {
        this.activeMenuGauge.labels({ symbol }).set(1);
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // W1: sibling call alongside setActiveMenu — UniverseScannerService.recompute() already computes
  // menuIn/menuOut counts for its own structured log line; this mirrors that count into Prometheus.
  recordMenuChurn(menuIn: number, menuOut: number): void {
    try {
      if (menuIn > 0) this.menuChurnCounter.inc({ direction: 'in' }, menuIn);
      if (menuOut > 0) this.menuChurnCounter.inc({ direction: 'out' }, menuOut);
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // W1: TradingRuntimeService.logPortfolio() (app.module.ts) calls this each 15s tick with
  // DailyLlmBudget.budgetBlock().remainingUsdToday — see the gauge's own help string for why this is
  // ONE lane-wide series, never per-strategy.
  setBudgetRemainingUsd(remainingUsd: number): void {
    try {
      this.budgetRemainingGauge.set(remainingUsd);
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // v3 §4.3: the client zod layer calls this when a decision is degraded to `hold` for violating
  // its symbol's capabilities (e.g. `open_short` on a spot symbol — `kind` = 'open_short_on_spot').
  recordCapabilityViolation(kind: string): void {
    try {
      this.capabilityViolationsCounter.inc({ kind });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // 2026-07-22 schema-hardening: the client zod layer calls this at each of its four schema-fail
  // branches (single/batch/element/missing_symbol) — see AGENTIC_SCHEMA_REJECTIONS_COUNTER's own
  // comment for what each kind means.
  recordSchemaFailure(kind: string): void {
    try {
      this.schemaRejectionsCounter.inc({ kind });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Backlog #53: ReflectionService.evaluateTrigger calls this at each of its four exits
  // (below_threshold/cooldown/inflight/fired) — see AGENTIC_REFLECTION_TRIGGER_COUNTER's own
  // comment. `outcome` is the same bound set the ReflectionMetricsRecorder interface pins.
  recordReflectionTrigger(outcome: string): void {
    try {
      this.reflectionTriggerCounter.inc({ outcome });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // 2026-07-24 fail-closed re-arm fallback — see AGENTIC_REARM_FALLBACK_COUNTER's own comment.
  recordRearmFallback(): void {
    try {
      this.rearmFallbackCounter.inc();
    } catch {
      /* metrics must never throw into a trading path */
    }
  }
}
