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
  | 'budget_blocked'
  // H4 (2026-07-27): the four remaining post-200 (or pre-call) soft-hold branches, previously
  // collapsed into 'hold' — see anthropic-agent-client.ts/agent-budget.ts/batching-agent-client.ts's
  // own decision.rationale tags and trading-runtime.module.ts's outcomeForProposal, which now
  // branches on those tags before falling through to 'hold'. 'truncated' covers BOTH the
  // truncated_max_tokens and no_tool_use rationale tags — the distinction is queryable via the
  // journal rationale, not a separate metric label.
  | 'envelope_malformed'
  | 'model_refusal'
  | 'truncated'
  | 'off_menu'
  // 2026-07-28: a call SUPPRESSED before it happened, because the client is inside its FATAL-error
  // latch cooldown. Distinct from 'error_fatal' (which counts the one failure that STARTED the
  // latch) in the way that matters for alerting: error_fatal is a permanent record of a past event
  // and only resets on a container recreate, whereas this is emitted continuously while the lane is
  // actually dead and stops the moment it recovers — so it can carry an alert that self-clears.
  | 'client_latched';

// Outcomes that mean the client is latched (no HTTP call was made, or the call that just failed
// latched it). Drive agent_client_latched to 1.
const LATCHED_DECIDE_OUTCOMES: ReadonlySet<AgentDecideOutcome> = new Set([
  'client_latched',
  'error_fatal',
]);

// Outcomes that PROVE a request reached the API, so the latch cannot be in force — including the ones
// that are themselves failures, because reaching them at all required an HTTP round trip. Drive
// agent_client_latched to 0.
//
// Deliberately an allowlist and not "everything else": 'off_menu' and 'budget_blocked' (the outcomes
// behind BatchingAgentClient's `off_menu:` / `budget_exhausted:` rationale tags) are pre-call
// short-circuits that never touch the Anthropic client, so they must leave the level alone. See
// recordDecide.
const PROVES_CALL_COMPLETED_OUTCOMES: ReadonlySet<AgentDecideOutcome> = new Set([
  'proposed',
  'hold',
  'noop',
  'error_retryable',
  'timeout',
  'envelope_malformed',
  'model_refusal',
  'truncated',
]);

// Pass 47 (2026-07-29): the two bound `kind` sets below back the zero-seed in the constructor. Both
// mirror anthropic-agent-client.ts's own literal enumerations exactly — duplicated rather than
// imported (the boundaries wall forbids this feature importing features/strategy/agentic, same
// convention as ConsultGateOutcome/AgentVenueTpEvent/AgentVenueStopEvent above).
//
// CAPABILITY_VIOLATION_KINDS: recordCapabilityViolation's `kind` param is typed as plain `string` (no
// literal union pins it), but grep of every call site in the codebase (anthropic-agent-client.ts:864,
// :1269) shows exactly one value is ever produced — 'open_short_on_spot'. Seeding only that one,
// not a wider guessed set: a fabricated child the increment path could never reach would be its own
// measurement lie.
const CAPABILITY_VIOLATION_KINDS = ['open_short_on_spot'] as const;
// SCHEMA_REJECTION_KINDS: AnthropicAgentClientConfig.recordSchemaFailure's own signature pins this as
// a closed literal union (single/batch/element/missing_symbol/batch_stringified_recovered) —
// genuinely enumerable, unlike the open-ended `outcome`/`event` strings on the recorder's other
// methods. 'batch_stringified_recovered' (Pass 64) is the salvage counterpart to 'batch': a
// whole-batch parse that failed only because `decisions` arrived as a JSON string, recovered rather
// than discarded — see anthropic-agent-client.ts's proposeBatch coercion.
const SCHEMA_REJECTION_KINDS = [
  'single',
  'batch',
  'element',
  'missing_symbol',
  'batch_stringified_recovered',
] as const;

// Pass 48 (2026-07-30): mirrors anthropic-agent-client.ts's own AgentClientLatchCause union exactly —
// duplicated rather than imported, same boundaries-wall convention as the two sets above and
// ConsultGateOutcome/AgentVenueTpEvent/AgentVenueStopEvent below (this feature cannot import
// features/strategy/agentic). Backs both the constructor's zero-seed and recordDecide's cause-set
// call below, so the seeded set and the writer can never drift apart.
const AGENT_CLIENT_LATCH_CAUSES = ['insufficient_credit', 'auth', 'other'] as const;
export type AgentClientLatchCauseLabel = (typeof AGENT_CLIENT_LATCH_CAUSES)[number];

export type AgentTokenKind = 'input' | 'output' | 'cache_read' | 'cache_creation';

// Pass 50 (2026-07-30): agent_tokens_total's zero-seed only ever covers 'input'/'output' — NOT the
// full AgentTokenKind union. 'cache_read'/'cache_creation' are deliberately excluded: recordTokens'
// own comment establishes that an ABSENT cache series (envelope never reported cache usage) and a
// ZERO cache series (confirmed zero reads) answer the W2.4 falsifiability check differently, so
// zero-seeding them here at construction would erase that distinction before any real call ever runs.
const AGENT_TOKEN_SEED_KINDS = ['input', 'output'] as const;

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

// Pass 50: the six-member ConsultGateOutcome set above, kept as its own runtime array (a union type
// carries no runtime member list) so the constructor's zero-seed below can iterate it — same
// hand-kept-in-sync convention as reconciliation.service.ts's ALL_MISMATCH_CLASSES.
const ALL_CONSULT_GATE_OUTCOMES: readonly ConsultGateOutcome[] = [
  'consulted',
  'skipped_scheduled',
  'forced_fill',
  'forced_move',
  'forced_fallback',
  'forced_rearm',
];

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

// Pass 50 (adversarial-review fix): the nine-member AgentVenueTpEvent set above, kept as its own
// runtime array for the same reason ALL_CONSULT_GATE_OUTCOMES is above — backs seedVenueTpVenues'
// zero-seed below. Only seedable now that trading-runtime.module.ts's onVenueTp closure passes a real
// venue (params.venue) instead of always falling through to recordVenueTp's 'unknown' default.
const ALL_AGENT_VENUE_TP_EVENTS: readonly AgentVenueTpEvent[] = [
  'placed',
  'skipped_existing',
  'skipped_inflight',
  'cancel_for_exit',
  'drift_cancel',
  'qty_cancel',
  'tp_race_hold',
  'orphan_cancel',
  'filled_flat',
];

// Mirrors agentic.strategy.ts's VenueStopEvent (Push 3 P7d) — duplicated rather than imported, same
// convention as AgentVenueTpEvent above. 'triggered' (Defect A commit-1, 2026-07-16) and the three
// orphan-reconcile labels (2026-07-31) — see VenueStopEvent's own comment.
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
  | 'triggered'
  | 'orphan_scan'
  | 'orphan_readopt'
  | 'orphan_cancel_failed';

// Pass 50: the fifteen-member AgentVenueStopEvent set above, kept as its own runtime value for the
// same reason ALL_CONSULT_GATE_OUTCOMES is above — backs seedVenueStopVenues' zero-seed below. The
// seed is the whole point for the three orphan labels: an unseeded child reads as ABSENT in the
// scrape, and absent is indistinguishable from zero.
//
// Keyed off a `satisfies Record<AgentVenueStopEvent, true>` map rather than the sibling arrays'
// plain literal (2026-07-31 adversarial review): a `readonly AgentVenueStopEvent[]` annotation only
// checks that every MEMBER is a valid label, never that every LABEL is a member — so a sixteenth
// event would compile while silently missing the zero-seed, which is precisely the unreadable-zero
// defect this set exists to prevent. Record<> is exhaustive in both directions: a missing key and a
// stray key are both compile errors. Only this set carries the pin; the sibling arrays keep their
// literal style until they earn the same treatment.
const AGENT_VENUE_STOP_EVENT_KEYS = {
  placed: true,
  skipped_existing: true,
  skipped_inflight: true,
  cancel_for_exit: true,
  drift_cancel: true,
  qty_cancel: true,
  orphan_cancel: true,
  filled_flat: true,
  stood_down: true,
  force_fired: true,
  reconcile_error: true,
  triggered: true,
  orphan_scan: true,
  orphan_readopt: true,
  orphan_cancel_failed: true,
} satisfies Record<AgentVenueStopEvent, true>;

// Object.keys widens to string[]; the assertion is sound because the map above is pinned exhaustive.
const ALL_AGENT_VENUE_STOP_EVENTS = Object.keys(
  AGENT_VENUE_STOP_EVENT_KEYS,
) as readonly AgentVenueStopEvent[];

// Typed recorder over the agentic-lane providers registered in metrics.service.ts. Exported from
// ObservabilityModule so the composition root can hand it (or closures over it) to the agentic lane —
// this module never imports features/strategy/agentic itself (the boundaries wall runs the other way).
// Every method swallows and drops prom-client errors: metrics must never throw into a trading path.
@Injectable()
export class AgentMetricsRecorder {
  private activePlaybookVersion: number | null = null;
  // Epoch ms mirror of agent_last_success_timestamp_seconds. Guarded in seedLastSuccessAt only (see
  // its max() check); recordModelRoundTrip sets it unconditionally, deliberately — see its comment.
  private lastSuccessAtMs = 0;

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
    @InjectMetric('agentic_rearm_fallback_total')
    private readonly rearmFallbackCounter: Counter<string>,
    @InjectMetric('agent_client_latched')
    private readonly clientLatchedGauge: Gauge<string>,
    @InjectMetric('agent_last_success_timestamp_seconds')
    private readonly lastSuccessGauge: Gauge<string>,
    @InjectMetric('agent_client_latch_cause')
    private readonly latchCauseGauge: Gauge<string>,
  ) {
    // Pass 47 (2026-07-29): prom-client only materialises a labeled child once it is touched, so
    // before this seed a lane that had never hit one of these `kind` values exported NO series for
    // it — an empty vector indistinguishable from unbound telemetry or a renamed metric (the same
    // defect Pass 44 fixed for market_stream_forced_reconnects_total). Seeded once, over the closed
    // sets above (Pass 48 adds agent_client_latch_cause's own three-member set), so a quiet lane
    // reads as a real zero rather than a void. Measurement-only: wrapped so a misbehaving counter can
    // never escape this constructor and therefore never block boot (fail OPEN) — same convention as
    // every recordXxx method below. Split into three OWN try/catches (adversarial review, 2026-07-30
    // — same non-cross-cancellation rationale as the Pass 50 block just below): the three counters
    // previously shared one try, so a throw from any one of them silently cancelled the other two's
    // seed as well.
    try {
      for (const kind of CAPABILITY_VIOLATION_KINDS) {
        this.capabilityViolationsCounter.inc({ kind }, 0);
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
    try {
      for (const kind of SCHEMA_REJECTION_KINDS) {
        this.schemaRejectionsCounter.inc({ kind }, 0);
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
    try {
      for (const cause of AGENT_CLIENT_LATCH_CAUSES) {
        this.latchCauseGauge.labels({ cause }).set(0);
      }
    } catch {
      /* metrics must never throw into a trading path */
    }

    // Pass 50 (2026-07-30): each of the next two seeds gets its OWN try/catch — reconciliation.
    // service.ts's Pass 49 comment explains why: sharing one try would let any single counter's
    // failure silently cancel every other block's seed, one throw taking down siblings it has nothing
    // to do with. Both are closed literal sets this file already owns, so — unlike
    // seedTokenModels/seedVenueTpVenues/seedVenueStopVenues below — neither needs config injected from
    // the composition root.
    try {
      for (const outcome of ALL_CONSULT_GATE_OUTCOMES) {
        this.consultGateCounter.inc({ outcome }, 0);
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
    try {
      // Exactly ONE reachable child, not a banned_token × token cross-product (adversarial review,
      // 2026-07-30): playbook-validator.ts's validatePlaybook sets bannedTokenHit:true ALWAYS
      // alongside a real bannedToken label (its one `return` for a denylist match sets both fields
      // together — see its own ~:199-209); both call sites (agentic-bridge.module.ts,
      // reflection.service.ts) read `validation.bannedTokenHit ?? false` paired with
      // `validation.bannedToken`, so `banned_token="true"` NEVER arrives with `token="none"` — only
      // with a real denylist label. `banned_token="true", token="none"` would therefore be a
      // fabricated, unreachable child. The ~20 real denylist labels themselves live in the reflection
      // validator, across the boundaries wall this file cannot cross, so they cannot be enumerated
      // here either — 'false'/'none' (the structural-rejection shape) is the one child this recorder
      // can seed truthfully.
      this.validatorRejectionsCounter.inc({ banned_token: 'false', token: 'none' }, 0);
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Pass 50: agent_tokens_total's `model` label is config-driven (AGENTIC_MODEL/
  // AGENTIC_REFLECTION_MODEL), not a closed literal this file can enumerate on its own — the
  // composition root (trading-runtime.module.ts) is the one place both configured model ids are
  // already resolved (the exact pair MetricsWrappingAgentClient's own `model` param carries), so it
  // hands them here once at boot rather than this recorder duplicating that resolution and risking
  // drift from the real one. Deduplicated: decide and reflection share one model unless
  // AGENTIC_REFLECTION_MODEL is explicitly overridden. Fail OPEN, own try/catch — measurement-only,
  // must never block boot.
  seedTokenModels(models: readonly string[]): void {
    try {
      for (const model of new Set(models)) {
        for (const kind of AGENT_TOKEN_SEED_KINDS) {
          this.tokensCounter.inc({ kind, model }, 0);
        }
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Pass 50: agentic_venue_stop_total's `venue` label is config-driven (TypedConfigService.venues),
  // same rationale as seedTokenModels above — handed in from the composition root rather than
  // guessed. Deliberately does NOT seed venue:'unknown' — adversarial review (2026-07-30) confirmed
  // the ONLY production writer (trading-runtime.module.ts's onVenueStop closure) now passes this
  // registration's own params.venue, so 'unknown' is reachable only via recordVenueStop's own
  // pre-v3 default argument for a caller that omits venue entirely (a stale fixture/test, never this
  // process's real wiring) — seeding it here would be the same fabricated-child lie a configured-venue
  // cross-product avoids everywhere else in this file.
  seedVenueStopVenues(venues: readonly string[]): void {
    try {
      for (const venue of venues) {
        for (const event of ALL_AGENT_VENUE_STOP_EVENTS) {
          this.venueStopCounter.inc({ venue, event }, 0);
        }
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Pass 50 (adversarial-review fix): the agentic_venue_tp_total twin — seedable for the identical
  // reason seedVenueStopVenues is now: onVenueTp's own call site previously omitted venue too (the
  // sibling instance of the same defect class), fixed in the same commit.
  seedVenueTpVenues(venues: readonly string[]): void {
    try {
      for (const venue of venues) {
        for (const event of ALL_AGENT_VENUE_TP_EVENTS) {
          this.venueTpCounter.inc({ venue, event }, 0);
        }
      }
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // WATCH-V4-8: stamped by MetricsWrappingAgentClient when the returned proposal carries the
  // structural proof of a completed round trip (promptHash + latencyMs, assigned together and only
  // after a response body was parsed) AND is not one of the post-200 degrades — deliberately NOT
  // derived from AgentDecideOutcome the way the latch level above is. The outcome sets cannot express
  // this: 'error_retryable' is in PROVES_CALL_COMPLETED_OUTCOMES (any HTTP reply disproves a latch)
  // yet a 429 is exactly what a SUSPENDED Moonshot account returns, and 'hold' also covers the
  // decision-less `{ signals: [] }` early returns where no call was made at all (47 such rows in the
  // live journal) as well as every schema_rejected degrade. All of those would keep this gauge fresh
  // through the very outage it exists to expose. Reading the same evidence the boot seed's SQL
  // predicate reads also keeps the two congruent by construction rather than by comment.
  //
  // Unconditional, unlike the seed below, and the direction is the reason: an unguarded set can only
  // move the gauge toward MORE stale, which is the fail-toward-alerting direction a measurement
  // should take. A max() here would do the opposite — across a backwards wall-clock correction (this
  // host sleeps and resumes; app_wall_clock_skew_seconds exists because of it) it would freeze the
  // gauge at a value ahead of time(), making time() - gauge negative and SUPPRESSING the staleness
  // alert for the length of the skew.
  recordModelRoundTrip(atMs: number = Date.now()): void {
    try {
      this.lastSuccessGauge.set(atMs / 1000);
      this.lastSuccessAtMs = atMs;
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Boot seed from the durable journal (seed-agent-last-success.ts), max()-guarded in the one
  // direction that matters: startTrading seeds while the strategy host is already registered, so a
  // seed landing after this boot's first live round trip would otherwise rewind liveness by hours.
  seedLastSuccessAt(atMs: number): void {
    try {
      if (atMs <= this.lastSuccessAtMs) return;
      this.lastSuccessGauge.set(atMs / 1000);
      this.lastSuccessAtMs = atMs;
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // `model` on both methods (#28): optional with an 'unknown' fallback so the label is always
  // materialized (never prom-client's implicit "") and pre-label call sites/test fakes keep working.
  // `latchCause` (Pass 48) is the caller's own classification (anthropic-agent-client.ts's
  // classifyLatchCause on a fresh FATAL, or parseLatchCauseFromClientLatchedRationale on every later
  // suppressed call) — folded into this SAME method, rather than a second public one, so the cause
  // gauge can never move on an outcome the latch gauge did not also move on.
  recordDecide(
    outcome: AgentDecideOutcome,
    model?: string,
    latchCause?: AgentClientLatchCauseLabel,
  ): void {
    try {
      this.decideCounter.inc({ outcome, model: model ?? 'unknown' });
      // The latch LEVEL, derived from the same outcome rather than plumbed separately, so it can never
      // disagree with the counter it is read alongside. 'error_fatal' is treated as latched because in
      // this codebase it implies the latch: AgentProposeError is constructed only in
      // anthropic-agent-client.ts's attemptOnce, and every FATAL classification passes through
      // handleFailure before being thrown. Setting it here rather than only on 'client_latched' is what
      // makes detection land within one scrape of the failing call instead of waiting for the next
      // suppressed consult (up to a 2h fallback-gate floor away).
      if (LATCHED_DECIDE_OUTCOMES.has(outcome)) {
        this.clientLatchedGauge.set(1);
        // Cause rides alongside the coarser level, set only when the caller supplied one — absent
        // (a caller/fixture that predates Pass 48) leaves the cause gauge exactly where it already
        // was rather than guessing, the same two-explicit-sets discipline as the level below.
        if (latchCause) {
          for (const c of AGENT_CLIENT_LATCH_CAUSES) {
            this.latchCauseGauge.labels({ cause: c }).set(c === latchCause ? 1 : 0);
          }
        }
      } else if (PROVES_CALL_COMPLETED_OUTCOMES.has(outcome)) {
        this.clientLatchedGauge.set(0);
        for (const c of AGENT_CLIENT_LATCH_CAUSES) {
          this.latchCauseGauge.labels({ cause: c }).set(0);
        }
      }
      // Everything else leaves the gauge UNCHANGED, which is the whole point of using two explicit
      // sets instead of an else-branch. 'off_menu' and 'budget_blocked' are returned by
      // BatchingAgentClient BEFORE inner.proposeBatch is ever called (batching-agent-client.ts) — they
      // never reach AnthropicAgentClient, so they prove nothing about the latch. Clearing on them
      // would drop this gauge to 0 while the lane was still latched and silence the critical alert:
      // exactly the blindness this metric exists to remove, reintroduced one layer up. A NEW outcome
      // added later also lands here and is inert until someone classifies it deliberately, rather than
      // silently clearing a live alert.
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

  // 2026-07-22 schema-hardening: the client zod layer calls this at each of its five schema-fail
  // branches (single/batch/element/missing_symbol/batch_stringified_recovered — the last added by
  // Pass 64's stringified-decisions salvage) — see SCHEMA_REJECTION_KINDS' own comment above for what
  // each kind means.
  recordSchemaFailure(kind: string): void {
    try {
      this.schemaRejectionsCounter.inc({ kind });
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
