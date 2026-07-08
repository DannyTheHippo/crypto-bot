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

export type AgentPrescreenOutcome = 'called' | 'skipped_quiet' | 'failopen_error';

// Mirrors prescreen.ts's PrescreenReason — duplicated rather than imported because the
// eslint-plugin-boundaries wall forbids this feature (common/observability) importing from
// trading/agentic; same convention as AgentPrescreenOutcome above. 'n/a' is this module's own
// sentinel for the failopen_error path, where evaluatePrescreen threw before computing any reason.
export type AgentPrescreenReason =
  | 'position_open'
  | 'vol_expansion'
  | 'breakout_proximity'
  | 'insufficient_data'
  | 'quiet'
  | 'n/a';

// Typed recorder over the agentic-lane providers registered in metrics.service.ts. Exported from
// ObservabilityModule so the composition root can hand it (or closures over it) to the agentic lane —
// this module never imports features/trading/agentic itself (the boundaries wall runs the other way).
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
    @InjectMetric('agentic_prescreen_total')
    private readonly prescreenCounter: Counter<string>,
    @InjectMetric('agentic_reflection_outcomes_total')
    private readonly reflectionOutcomesCounter: Counter<string>,
  ) {}

  recordDecide(outcome: AgentDecideOutcome): void {
    try {
      this.decideCounter.inc({ outcome });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // Cache kinds are inc'd only when the response actually carried the field: an absent series
  // (envelope never reported cache usage) and a zero series (confirmed zero cache reads) answer
  // the W2.4 falsifiability check differently (see AgentUsage in ports/agentic-strategy.ts).
  // These series also expose the cache-write premium the flat 3/15 accounting can't see —
  // cache_creation tokens bill above base input rate and appear in NEITHER input nor output.
  recordTokens(input: number, output: number, cacheRead?: number, cacheCreation?: number): void {
    try {
      this.tokensCounter.inc({ kind: 'input' }, input);
      this.tokensCounter.inc({ kind: 'output' }, output);
      if (cacheRead !== undefined) this.tokensCounter.inc({ kind: 'cache_read' }, cacheRead);
      if (cacheCreation !== undefined) {
        this.tokensCounter.inc({ kind: 'cache_creation' }, cacheCreation);
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

  recordValidatorRejection(bannedToken: boolean): void {
    try {
      this.validatorRejectionsCounter.inc({ banned_token: String(bannedToken) });
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

  recordPrescreen(outcome: AgentPrescreenOutcome, reason?: AgentPrescreenReason): void {
    try {
      this.prescreenCounter.inc({ outcome, reason: reason ?? 'n/a' });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }

  // W2: bound closed set of outcome labels emitted by ReflectionService's own ReflectionMetricsRecorder
  // interface — duplicated rather than imported (boundaries wall, same reasoning as
  // AgentPrescreenReason above).
  recordReflectionOutcome(outcome: string): void {
    try {
      this.reflectionOutcomesCounter.inc({ outcome });
    } catch {
      /* metrics must never throw into a trading path */
    }
  }
}
