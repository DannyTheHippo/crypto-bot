import { Test, type TestingModule } from '@nestjs/testing';
import { register } from 'prom-client';
import type { Counter, Gauge, Histogram } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_DECIDE_COUNTER,
  AGENT_TOKENS_COUNTER,
  AGENT_DECIDE_LATENCY_HISTOGRAM,
  AGENTIC_PLAYBOOK_INFO_GAUGE,
  PLAYBOOK_VALIDATOR_REJECTIONS_COUNTER,
  AGENT_CLIENT_INFO_GAUGE,
  AGENTIC_CONSULT_GATE_COUNTER,
  AGENTIC_REFLECTION_OUTCOMES_COUNTER,
  AGENTIC_VENUE_TP_COUNTER,
  AGENTIC_VENUE_STOP_COUNTER,
  FUNDING_PAYMENTS_INGESTED_COUNTER,
  AGENTIC_ACTIVE_MENU_GAUGE,
  AGENTIC_MENU_CHURN_COUNTER,
  AGENTIC_BUDGET_REMAINING_GAUGE,
  AGENTIC_CAPABILITY_VIOLATIONS_COUNTER,
  AGENTIC_SCHEMA_REJECTIONS_COUNTER,
  AGENTIC_REARM_FALLBACK_COUNTER,
  AGENT_CLIENT_LATCHED_GAUGE,
  AGENT_CLIENT_LATCH_CAUSE_GAUGE,
  AGENT_LAST_SUCCESS_GAUGE,
} from '../../../../src/features/common/observability/metrics.service';
import { AgentMetricsRecorder } from '../../../../src/features/common/observability/agent-metrics-recorder.service';

describe('AgentMetricsRecorder', () => {
  let moduleRef: TestingModule;
  let recorder: AgentMetricsRecorder;

  beforeEach(async () => {
    register.clear();
    moduleRef = await Test.createTestingModule({
      providers: [
        AGENT_DECIDE_COUNTER,
        AGENT_TOKENS_COUNTER,
        AGENT_DECIDE_LATENCY_HISTOGRAM,
        AGENTIC_PLAYBOOK_INFO_GAUGE,
        PLAYBOOK_VALIDATOR_REJECTIONS_COUNTER,
        AGENT_CLIENT_INFO_GAUGE,
        AGENTIC_CONSULT_GATE_COUNTER,
        AGENTIC_REFLECTION_OUTCOMES_COUNTER,
        AGENTIC_VENUE_TP_COUNTER,
        AGENTIC_VENUE_STOP_COUNTER,
        FUNDING_PAYMENTS_INGESTED_COUNTER,
        AGENTIC_ACTIVE_MENU_GAUGE,
        AGENTIC_MENU_CHURN_COUNTER,
        AGENTIC_BUDGET_REMAINING_GAUGE,
        AGENTIC_CAPABILITY_VIOLATIONS_COUNTER,
        AGENTIC_SCHEMA_REJECTIONS_COUNTER,
        AGENTIC_REARM_FALLBACK_COUNTER,
        AGENT_CLIENT_LATCHED_GAUGE,
        AGENT_LAST_SUCCESS_GAUGE,
        AGENT_CLIENT_LATCH_CAUSE_GAUGE,
        AgentMetricsRecorder,
      ],
    }).compile();
    recorder = moduleRef.get(AgentMetricsRecorder);
  });

  afterEach(async () => {
    await moduleRef.close();
    register.clear();
  });

  it('registers all twenty agentic-lane metrics', async () => {
    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    for (const name of [
      'agent_decide_total',
      'agent_tokens_total',
      'agent_decide_latency_seconds',
      'agentic_playbook_info',
      'playbook_validator_rejections_total',
      'agent_client_info',
      'agentic_consult_gate_total',
      'agentic_reflection_outcomes_total',
      'agentic_venue_tp_total',
      'agentic_venue_stop_total',
      'funding_payments_ingested_total',
      'agentic_active_menu',
      'agentic_menu_churn_total',
      'agentic_budget_remaining_usd',
      'agentic_capability_violations_total',
      'agentic_schema_rejections_total',
      'agentic_rearm_fallback_total',
      'agent_client_latched',
      'agent_last_success_timestamp_seconds',
      'agent_client_latch_cause',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  // The 2026-07-27 outage's alerting lesson: every counter-derived form of "the lane is dead right
  // now" either cannot clear or cannot fire in time, so the latch is published as a LEVEL. These pin
  // both directions, because an alert that cannot clear is as bad as one that cannot fire.
  it('recordDecide raises agent_client_latched on a suppressed call and on the fatal that starts the latch', async () => {
    recorder.recordDecide('client_latched', 'claude-sonnet-5');
    expect(await register.getSingleMetricAsString('agent_client_latched')).toContain(
      'agent_client_latched 1',
    );
    register.resetMetrics();
    recorder.recordDecide('error_fatal', 'claude-sonnet-5');
    expect(await register.getSingleMetricAsString('agent_client_latched')).toContain(
      'agent_client_latched 1',
    );
  });

  // The review's must-fix: 'off_menu' and 'budget_exhausted' are returned by BatchingAgentClient
  // BEFORE inner.proposeBatch, so they never reach the Anthropic client and prove nothing about the
  // latch. Clearing on them would drop the gauge to 0 while the lane was still latched and silence the
  // critical alert — the exact blindness the metric exists to remove, one layer up.
  it.each(['off_menu', 'budget_blocked'] as const)(
    'recordDecide leaves agent_client_latched UNCHANGED on %s — a pre-call short-circuit cannot clear a latch',
    async (outcome) => {
      recorder.recordDecide('client_latched');
      recorder.recordDecide(outcome);
      expect(await register.getSingleMetricAsString('agent_client_latched')).toContain(
        'agent_client_latched 1',
      );
    },
  );

  it('recordDecide clears agent_client_latched on any outcome that proves a call completed, including a retryable failure', async () => {
    recorder.recordDecide('client_latched');
    recorder.recordDecide('error_retryable');
    expect(await register.getSingleMetricAsString('agent_client_latched')).toContain(
      'agent_client_latched 0',
    );
    recorder.recordDecide('client_latched');
    recorder.recordDecide('proposed');
    expect(await register.getSingleMetricAsString('agent_client_latched')).toContain(
      'agent_client_latched 0',
    );
  });

  // Pass 48: agent_client_latch_cause is the WHY behind agent_client_latched, at the same LEVEL
  // granularity — these mirror the pinned agent_client_latched behavior above one label deeper.
  it('seeds agent_client_latch_cause at 0 for all three causes on construction, before any latch is recorded', async () => {
    const metric = await register.getSingleMetricAsString('agent_client_latch_cause');
    expect(metric).toContain('cause="insufficient_credit"} 0');
    expect(metric).toContain('cause="auth"} 0');
    expect(metric).toContain('cause="other"} 0');
  });

  it('recordDecide(error_fatal, cause) raises exactly the classified cause and holds every other cause at 0', async () => {
    recorder.recordDecide('error_fatal', 'claude-sonnet-5', 'insufficient_credit');
    const metric = await register.getSingleMetricAsString('agent_client_latch_cause');
    expect(metric).toContain('cause="insufficient_credit"} 1');
    expect(metric).toContain('cause="auth"} 0');
    expect(metric).toContain('cause="other"} 0');
  });

  it('recordDecide(client_latched, cause) re-affirms the cause on every suppressed call, and switches cleanly if it changes', async () => {
    recorder.recordDecide('client_latched', undefined, 'auth');
    let metric = await register.getSingleMetricAsString('agent_client_latch_cause');
    expect(metric).toContain('cause="auth"} 1');
    expect(metric).toContain('cause="insufficient_credit"} 0');

    // A later latch (a container recreate, or a genuinely different cause) must not leave the OLD
    // cause child stuck at 1 alongside the new one — exactly one child reads 1 at any time.
    recorder.recordDecide('client_latched', undefined, 'insufficient_credit');
    metric = await register.getSingleMetricAsString('agent_client_latch_cause');
    expect(metric).toContain('cause="insufficient_credit"} 1');
    expect(metric).toContain('cause="auth"} 0');
  });

  it('recordDecide clears every cause back to 0 on any outcome that proves a call completed', async () => {
    recorder.recordDecide('error_fatal', undefined, 'insufficient_credit');
    recorder.recordDecide('proposed');
    const metric = await register.getSingleMetricAsString('agent_client_latch_cause');
    expect(metric).toContain('cause="insufficient_credit"} 0');
    expect(metric).toContain('cause="auth"} 0');
    expect(metric).toContain('cause="other"} 0');
  });

  it.each(['off_menu', 'budget_blocked'] as const)(
    'recordDecide leaves agent_client_latch_cause UNCHANGED on %s — a pre-call short-circuit proves nothing',
    async (outcome) => {
      recorder.recordDecide('error_fatal', undefined, 'auth');
      recorder.recordDecide(outcome);
      const metric = await register.getSingleMetricAsString('agent_client_latch_cause');
      expect(metric).toContain('cause="auth"} 1');
    },
  );

  it('recordDecide(client_latched) with no cause supplied leaves the gauge exactly where it was, rather than guessing', async () => {
    recorder.recordDecide('error_fatal', undefined, 'auth');
    recorder.recordDecide('client_latched'); // no third argument — a caller/fixture predating Pass 48
    const metric = await register.getSingleMetricAsString('agent_client_latch_cause');
    expect(metric).toContain('cause="auth"} 1');
  });

  it('recordDecide increments agent_decide_total{outcome,model}', async () => {
    recorder.recordDecide('proposed', 'claude-sonnet-5');
    recorder.recordDecide('timeout', 'claude-sonnet-5');
    const metric = await register.getSingleMetricAsString('agent_decide_total');
    expect(metric).toContain('outcome="proposed",model="claude-sonnet-5"} 1');
    expect(metric).toContain('outcome="timeout",model="claude-sonnet-5"} 1');
  });

  it('recordDecide falls back to model="unknown" when no model is given', async () => {
    recorder.recordDecide('hold');
    const metric = await register.getSingleMetricAsString('agent_decide_total');
    expect(metric).toContain('outcome="hold",model="unknown"} 1');
  });

  it('recordTokens increments the input and output series independently', async () => {
    recorder.recordTokens(120, 45, undefined, undefined, 'claude-sonnet-5');
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="input",model="claude-sonnet-5"} 120');
    expect(metric).toContain('kind="output",model="claude-sonnet-5"} 45');
  });

  it('recordTokens keeps per-model series separate (#28: decide vs reflection $/day split)', async () => {
    recorder.recordTokens(120, 45, undefined, undefined, 'claude-sonnet-5');
    recorder.recordTokens(500, 90, undefined, undefined, 'claude-opus-5');
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="input",model="claude-sonnet-5"} 120');
    expect(metric).toContain('kind="input",model="claude-opus-5"} 500');
    expect(metric).toContain('kind="output",model="claude-opus-5"} 90');
  });

  it('recordTokens falls back to model="unknown" when no model is given', async () => {
    recorder.recordTokens(120, 45);
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="input",model="unknown"} 120');
    expect(metric).toContain('kind="output",model="unknown"} 45');
  });

  it('recordTokens leaves the cache series absent when the response carried no cache fields', async () => {
    recorder.recordTokens(120, 45);
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).not.toContain('kind="cache_read"');
    expect(metric).not.toContain('kind="cache_creation"');
  });

  it('recordTokens materializes cache series at explicit zero (W2.4: absent ≠ confirmed-zero)', async () => {
    recorder.recordTokens(120, 45, 0, 0, 'claude-sonnet-5');
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="cache_read",model="claude-sonnet-5"} 0');
    expect(metric).toContain('kind="cache_creation",model="claude-sonnet-5"} 0');
  });

  it('recordTokens accumulates cache_read and cache_creation counts', async () => {
    recorder.recordTokens(120, 45, 1500, 0, 'claude-sonnet-5');
    recorder.recordTokens(80, 30, 0, 2000, 'claude-sonnet-5');
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="cache_read",model="claude-sonnet-5"} 1500');
    expect(metric).toContain('kind="cache_creation",model="claude-sonnet-5"} 2000');
  });

  // Pass 50: the composition root calls this once at construction with [decideModel, reflectionModel]
  // — a shared model (the common case: no AGENTIC_REFLECTION_MODEL override) must dedupe to one
  // series pair, not two identical ones.
  it('seedTokenModels seeds agent_tokens_total{kind,model}=0 for input/output only, deduplicating a shared decide/reflection model', async () => {
    recorder.seedTokenModels(['claude-sonnet-5', 'claude-sonnet-5']);
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="input",model="claude-sonnet-5"} 0');
    expect(metric).toContain('kind="output",model="claude-sonnet-5"} 0');
    // cache_read/cache_creation stay absent — recordTokens' own W2.4 absent-vs-zero distinction would
    // be erased if this seed also zeroed them (see the seed's own comment).
    expect(metric).not.toContain('kind="cache_read"');
    expect(metric).not.toContain('kind="cache_creation"');
  });

  it('seedTokenModels seeds each distinct model separately when the reflection model is overridden', async () => {
    recorder.seedTokenModels(['claude-sonnet-5', 'claude-opus-5']);
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="input",model="claude-sonnet-5"} 0');
    expect(metric).toContain('kind="output",model="claude-sonnet-5"} 0');
    expect(metric).toContain('kind="input",model="claude-opus-5"} 0');
    expect(metric).toContain('kind="output",model="claude-opus-5"} 0');
  });

  it('observeDecideLatency records into the latency histogram', async () => {
    recorder.observeDecideLatency(3);
    const metric = await register.getSingleMetricAsString('agent_decide_latency_seconds');
    expect(metric).toContain('agent_decide_latency_seconds_count 1');
    expect(metric).toContain('agent_decide_latency_seconds_sum 3');
  });

  it('setPlaybookInfo sets the active version to 1 and clears the previous version on change', async () => {
    recorder.setPlaybookInfo(1);
    let metric = await register.getSingleMetricAsString('agentic_playbook_info');
    expect(metric).toContain('version="1"} 1');

    recorder.setPlaybookInfo(2);
    metric = await register.getSingleMetricAsString('agentic_playbook_info');
    expect(metric).toContain('version="2"} 1');
    expect(metric).not.toContain('version="1"');
  });

  it('recordValidatorRejection tags banned_token true/false and the concept token', async () => {
    recorder.recordValidatorRejection(true, 'leverage');
    recorder.recordValidatorRejection(false); // structural rejection: token defaults to 'none'
    const metric = await register.getSingleMetricAsString('playbook_validator_rejections_total');
    expect(metric).toContain('banned_token="true",token="leverage"} 1');
    expect(metric).toContain('banned_token="false",token="none"} 1');
  });

  // Pass 50 (2026-07-30, adversarial-review fix): mirrors the Pass 47/49 seeding tests elsewhere in
  // this file — asserted at CONSTRUCTION, before recordValidatorRejection is ever called, so deleting
  // the constructor seed (leaving only recordValidatorRejection's own `.inc` call) fails this test.
  // Exactly ONE child, not both banned_token values: validatePlaybook always pairs
  // bannedTokenHit:true with a real denylist label, so banned_token="true" NEVER arrives with
  // token="none" — seeding that pair would be an unreachable, fabricated child (see the seed's own
  // comment). The ~20 real denylist labels live in the reflection validator, across the boundaries
  // wall this file cannot cross, so only the structural-rejection shape is seedable here.
  it('seeds playbook_validator_rejections_total{banned_token="false",token="none"} at 0 on construction, before any rejection is recorded', async () => {
    const metric = await register.getSingleMetricAsString('playbook_validator_rejections_total');
    expect(metric).toContain('banned_token="false",token="none"} 0');
    // banned_token="true" is UNREACHABLE with token="none" — must not be seeded.
    expect(metric).not.toContain('banned_token="true",token="none"');
  });

  it('setClientInfo sets agent_client_info{kind} to 1', async () => {
    recorder.setClientInfo('stub');
    const metric = await register.getSingleMetricAsString('agent_client_info');
    expect(metric).toContain('kind="stub"} 1');
  });

  it('recordConsultGate increments agentic_consult_gate_total{outcome} for all six outcomes', async () => {
    recorder.recordConsultGate('consulted');
    recorder.recordConsultGate('skipped_scheduled');
    recorder.recordConsultGate('forced_fill');
    recorder.recordConsultGate('forced_move');
    recorder.recordConsultGate('forced_fallback');
    recorder.recordConsultGate('forced_rearm');
    const metric = await register.getSingleMetricAsString('agentic_consult_gate_total');
    expect(metric).toContain('outcome="consulted"} 1');
    expect(metric).toContain('outcome="skipped_scheduled"} 1');
    expect(metric).toContain('outcome="forced_fill"} 1');
    expect(metric).toContain('outcome="forced_move"} 1');
    expect(metric).toContain('outcome="forced_fallback"} 1');
    expect(metric).toContain('outcome="forced_rearm"} 1');
  });

  // Pass 50: same construction-only seeding convention as the playbook-validator test above, applied
  // to the six-member ConsultGateOutcome set. No recordConsultGate call precedes this assertion.
  it('seeds agentic_consult_gate_total at 0 for all six outcomes on construction, before any consult is recorded', async () => {
    const metric = await register.getSingleMetricAsString('agentic_consult_gate_total');
    for (const outcome of [
      'consulted',
      'skipped_scheduled',
      'forced_fill',
      'forced_move',
      'forced_fallback',
      'forced_rearm',
    ]) {
      expect(metric, outcome).toContain(`outcome="${outcome}"} 0`);
    }
  });

  it('recordReflectionOutcome increments agentic_reflection_outcomes_total{outcome}', async () => {
    recorder.recordReflectionOutcome('minted');
    recorder.recordReflectionOutcome('validator_reject');
    const metric = await register.getSingleMetricAsString('agentic_reflection_outcomes_total');
    expect(metric).toContain('outcome="minted"} 1');
    expect(metric).toContain('outcome="validator_reject"} 1');
  });

  it('recordVenueTp increments agentic_venue_tp_total{venue,event}, defaulting venue to "unknown"', async () => {
    recorder.recordVenueTp('placed');
    recorder.recordVenueTp('drift_cancel', 'binanceusdm');
    recorder.recordVenueTp('drift_cancel', 'binanceusdm');
    const metric = await register.getSingleMetricAsString('agentic_venue_tp_total');
    expect(metric).toContain('venue="unknown",event="placed"} 1');
    expect(metric).toContain('venue="binanceusdm",event="drift_cancel"} 2');
  });

  it('recordVenueStop increments agentic_venue_stop_total{venue,event}, defaulting venue to "unknown"', async () => {
    recorder.recordVenueStop('placed');
    recorder.recordVenueStop('force_fired', 'binance');
    recorder.recordVenueStop('force_fired', 'binance');
    const metric = await register.getSingleMetricAsString('agentic_venue_stop_total');
    expect(metric).toContain('venue="unknown",event="placed"} 1');
    expect(metric).toContain('venue="binance",event="force_fired"} 2');
  });

  // Pass 50 (2026-07-30): the composition root (trading-runtime.module.ts) calls this once at
  // construction with the configured venue list — AgentMetricsRecorder has no config dependency of
  // its own (see the method's own comment), so this exercises it directly with a fixture venue list.
  // Adversarial review (2026-07-30) confirmed the ONLY production writer (onVenueStop) now passes
  // this registration's own params.venue rather than falling through to 'unknown' — so this
  // configured-venue seed is truthful, not a fabricated cross-product.
  it('seedVenueStopVenues seeds agentic_venue_stop_total{venue,event}=0 for every given venue across all twelve events', async () => {
    recorder.seedVenueStopVenues(['binance', 'binanceusdm']);
    const metric = await register.getSingleMetricAsString('agentic_venue_stop_total');
    for (const venue of ['binance', 'binanceusdm']) {
      for (const event of [
        'placed',
        'skipped_existing',
        'skipped_inflight',
        'cancel_for_exit',
        'drift_cancel',
        'qty_cancel',
        'orphan_cancel',
        'filled_flat',
        'stood_down',
        'force_fired',
        'reconcile_error',
        'triggered',
      ]) {
        expect(metric, `${venue}/${event}`).toContain(`venue="${venue}",event="${event}"} 0`);
      }
    }
  });

  // Pass 50 (adversarial-review fix): the agentic_venue_tp_total twin, seedable for the identical
  // reason — onVenueTp's call site had the sibling instance of the same missing-venue defect, fixed
  // in the same commit.
  it('seedVenueTpVenues seeds agentic_venue_tp_total{venue,event}=0 for every given venue across all nine events', async () => {
    recorder.seedVenueTpVenues(['binance', 'binanceusdm']);
    const metric = await register.getSingleMetricAsString('agentic_venue_tp_total');
    for (const venue of ['binance', 'binanceusdm']) {
      for (const event of [
        'placed',
        'skipped_existing',
        'skipped_inflight',
        'cancel_for_exit',
        'drift_cancel',
        'qty_cancel',
        'tp_race_hold',
        'orphan_cancel',
        'filled_flat',
      ]) {
        expect(metric, `${venue}/${event}`).toContain(`venue="${venue}",event="${event}"} 0`);
      }
    }
  });

  it('recordCapabilityViolation increments agentic_capability_violations_total{kind}', async () => {
    recorder.recordCapabilityViolation('open_short_on_spot');
    recorder.recordCapabilityViolation('open_short_on_spot');
    const metric = await register.getSingleMetricAsString('agentic_capability_violations_total');
    expect(metric).toContain('kind="open_short_on_spot"} 2');
  });

  it('recordSchemaFailure increments agentic_schema_rejections_total{kind}', async () => {
    recorder.recordSchemaFailure('single');
    recorder.recordSchemaFailure('element');
    recorder.recordSchemaFailure('element');
    const metric = await register.getSingleMetricAsString('agentic_schema_rejections_total');
    expect(metric).toContain('kind="single"} 1');
    expect(metric).toContain('kind="element"} 2');
  });

  // Pass 47 (2026-07-29): prom-client only materialises a labeled child once touched, so before this
  // seed a lane that had never violated a capability exported NO series at all for
  // agentic_capability_violations_total — an empty vector indistinguishable from unbound telemetry
  // (same defect Pass 44 fixed for market_stream_forced_reconnects_total). Asserted with NO prior call
  // to recordCapabilityViolation in this test — the module was only just compiled in beforeEach — so
  // deleting the constructor seed and leaving only the per-violation `.inc` call fails this test.
  it('seeds agentic_capability_violations_total{kind="open_short_on_spot"} at 0 on construction, before any violation is recorded', async () => {
    const metric = await register.getSingleMetricAsString('agentic_capability_violations_total');
    expect(metric).toContain('kind="open_short_on_spot"} 0');
  });

  // Same Pass 47 defect, the schema-rejection sibling: all four kinds
  // (single/batch/element/missing_symbol) are the closed set anthropic-agent-client.ts's
  // recordSchemaFailure signature pins — every one must publish its true zero, not just the ones a
  // given lane has happened to hit. No recordSchemaFailure call precedes this assertion.
  it.each(['single', 'batch', 'element', 'missing_symbol'] as const)(
    'seeds agentic_schema_rejections_total{kind="%s"} at 0 on construction, before any rejection is recorded',
    async (kind) => {
      const metric = await register.getSingleMetricAsString('agentic_schema_rejections_total');
      expect(metric).toContain(`kind="${kind}"} 0`);
    },
  );

  it('recordRearmFallback increments agentic_rearm_fallback_total', async () => {
    recorder.recordRearmFallback();
    recorder.recordRearmFallback();
    const metric = await register.getSingleMetricAsString('agentic_rearm_fallback_total');
    expect(metric).toContain('agentic_rearm_fallback_total 2');
  });

  it('recordFundingIngested increments funding_payments_ingested_total{venue,symbol} by count', async () => {
    recorder.recordFundingIngested('binanceusdm', 'BTC/USDT:USDT', 3);
    recorder.recordFundingIngested('binanceusdm', 'ETH/USDT:USDT', 1);
    const metric = await register.getSingleMetricAsString('funding_payments_ingested_total');
    expect(metric).toContain('venue="binanceusdm",symbol="BTC/USDT:USDT"} 3');
    expect(metric).toContain('venue="binanceusdm",symbol="ETH/USDT:USDT"} 1');
  });

  it('setActiveMenu sets 1 on the given symbols and drops symbols no longer in the menu', async () => {
    recorder.setActiveMenu(['BTC/USDT', 'ETH/USDT']);
    let metric = await register.getSingleMetricAsString('agentic_active_menu');
    expect(metric).toContain('symbol="BTC/USDT"} 1');
    expect(metric).toContain('symbol="ETH/USDT"} 1');

    recorder.setActiveMenu(['BTC/USDT']);
    metric = await register.getSingleMetricAsString('agentic_active_menu');
    expect(metric).toContain('symbol="BTC/USDT"} 1');
    expect(metric).not.toContain('symbol="ETH/USDT"');
  });

  it('recordMenuChurn increments agentic_menu_churn_total{direction} by the given counts', async () => {
    recorder.recordMenuChurn(2, 1);
    const metric = await register.getSingleMetricAsString('agentic_menu_churn_total');
    expect(metric).toContain('direction="in"} 2');
    expect(metric).toContain('direction="out"} 1');
  });

  it('recordMenuChurn skips zero-count directions (no in=0/out=0 series minted)', async () => {
    recorder.recordMenuChurn(1, 0);
    const metric = await register.getSingleMetricAsString('agentic_menu_churn_total');
    expect(metric).toContain('direction="in"} 1');
    expect(metric).not.toContain('direction="out"');
  });

  it('setBudgetRemainingUsd sets agentic_budget_remaining_usd', async () => {
    recorder.setBudgetRemainingUsd(0.42);
    const metric = await register.getSingleMetricAsString('agentic_budget_remaining_usd');
    expect(metric).toContain('agentic_budget_remaining_usd 0.42');
  });

  // WATCH-V4-8. T0/T1 are the real instants from the 2026-07-29 incident: the last completed round
  // trip, and the moment the board still read green on a 37h-dead lane.
  const T0 = 1_785_183_331_000; // 2026-07-27T20:15:31Z — newest successful decide in the live journal
  const T1 = 1_785_318_000_000; // 2026-07-29T09:40:00Z

  it('recordModelRoundTrip publishes the round-trip instant in unix SECONDS', async () => {
    recorder.recordModelRoundTrip(T1);
    expect(
      await register.getSingleMetricAsString('agent_last_success_timestamp_seconds'),
    ).toContain(`agent_last_success_timestamp_seconds ${T1 / 1000}`);
  });

  it('seedLastSuccessAt publishes the durable seed, and a later live round trip moves it forward', async () => {
    recorder.seedLastSuccessAt(T0);
    expect(
      await register.getSingleMetricAsString('agent_last_success_timestamp_seconds'),
    ).toContain(`agent_last_success_timestamp_seconds ${T0 / 1000}`);
    recorder.recordModelRoundTrip(T1);
    expect(
      await register.getSingleMetricAsString('agent_last_success_timestamp_seconds'),
    ).toContain(`agent_last_success_timestamp_seconds ${T1 / 1000}`);
  });

  // The seed is max()-guarded in this one direction: startTrading seeds while the strategy host is
  // already registered, and a seed landing after this boot's first live round trip would rewind
  // liveness by hours and fire a false staleness alert.
  it('a stale seed arriving after a newer live stamp is ignored', async () => {
    recorder.recordModelRoundTrip(T1);
    recorder.seedLastSuccessAt(T0);
    expect(
      await register.getSingleMetricAsString('agent_last_success_timestamp_seconds'),
    ).toContain(`agent_last_success_timestamp_seconds ${T1 / 1000}`);
  });

  // The defect this metric exists to remove: nothing on the decide path may refresh liveness on its
  // own. 'error_retryable' is the load-bearing member — it clears agent_client_latched (any HTTP
  // reply disproves a latch) and a SUSPENDED Moonshot account answers 429, i.e. retryable; 'hold'
  // is the other, because it also covers the decision-less early returns where no call was made.
  it.each([
    'proposed',
    'hold',
    'noop',
    'error_retryable',
    'error_fatal',
    'client_latched',
    'budget_blocked',
    'off_menu',
  ] as const)(
    'recordDecide(%s) alone never stamps agent_last_success_timestamp_seconds',
    async (outcome) => {
      recorder.seedLastSuccessAt(T0);
      recorder.recordDecide(outcome, 'claude-sonnet-5');
      expect(
        await register.getSingleMetricAsString('agent_last_success_timestamp_seconds'),
      ).toContain(`agent_last_success_timestamp_seconds ${T0 / 1000}`);
    },
  );
});

describe('AgentMetricsRecorder — never throws into a trading path', () => {
  it('every method swallows an error thrown by a misbehaving provider', () => {
    const throwing = {
      inc: () => {
        throw new Error('boom');
      },
      observe: () => {
        throw new Error('boom');
      },
      labels: () => {
        throw new Error('boom');
      },
      remove: () => {
        throw new Error('boom');
      },
    };
    const recorder = new AgentMetricsRecorder(
      throwing as unknown as Counter<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Histogram<string>,
      throwing as unknown as Gauge<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Gauge<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Gauge<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Gauge<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Counter<string>,
      throwing as unknown as Counter<string>,
      // agent_client_latched: a `set` that throws — recordDecide writes the latch LEVEL alongside the
      // counter, so a misbehaving gauge must not escape into the decide path either.
      {
        ...throwing,
        set: () => {
          throw new Error('boom');
        },
      } as unknown as Gauge<string>,
      // agent_last_success_timestamp_seconds: same treatment — the liveness stamp sits on the decide
      // path too (MetricsWrappingAgentClient.propose), so a throwing gauge must not escape it either.
      {
        ...throwing,
        set: () => {
          throw new Error('boom');
        },
      } as unknown as Gauge<string>,
      // agent_client_latch_cause: the base `throwing.labels` already throws, which is enough to
      // exercise the constructor's own seed loop AND recordDecide's cause-setting loop below.
      throwing as unknown as Gauge<string>,
    );
    expect(() => recorder.recordDecide('proposed')).not.toThrow();
    expect(() => recorder.recordDecide('client_latched')).not.toThrow();
    expect(() =>
      recorder.recordDecide('error_fatal', 'claude-sonnet-5', 'insufficient_credit'),
    ).not.toThrow();
    expect(() => recorder.recordTokens(1, 1)).not.toThrow();
    expect(() => recorder.observeDecideLatency(1)).not.toThrow();
    expect(() => recorder.setPlaybookInfo(1)).not.toThrow();
    expect(() => recorder.recordValidatorRejection(true)).not.toThrow();
    expect(() => recorder.setClientInfo('stub')).not.toThrow();
    expect(() => recorder.recordConsultGate('consulted')).not.toThrow();
    expect(() => recorder.recordReflectionOutcome('minted')).not.toThrow();
    expect(() => recorder.recordVenueTp('placed')).not.toThrow();
    expect(() => recorder.recordVenueStop('placed')).not.toThrow();
    expect(() => recorder.recordFundingIngested('binanceusdm', 'BTC/USDT:USDT', 1)).not.toThrow();
    expect(() => recorder.setActiveMenu(['BTC/USDT'])).not.toThrow();
    expect(() => recorder.recordMenuChurn(1, 1)).not.toThrow();
    expect(() => recorder.setBudgetRemainingUsd(1)).not.toThrow();
    expect(() => recorder.recordCapabilityViolation('open_short_on_spot')).not.toThrow();
    expect(() => recorder.recordSchemaFailure('single')).not.toThrow();
    expect(() => recorder.recordRearmFallback()).not.toThrow();
    expect(() => recorder.recordModelRoundTrip(1)).not.toThrow();
    expect(() => recorder.seedLastSuccessAt(1)).not.toThrow();
    expect(() => recorder.seedTokenModels(['claude-sonnet-5'])).not.toThrow();
    expect(() => recorder.seedVenueTpVenues(['binance'])).not.toThrow();
    expect(() => recorder.seedVenueStopVenues(['binance'])).not.toThrow();
  });

  // Adversarial review (2026-07-30): the Pass 47/48 constructor block used to seed
  // capabilityViolationsCounter/schemaRejectionsCounter/latchCauseGauge inside ONE shared try, so a
  // throw from any one of them silently cancelled the other two's seed as well — same
  // non-cross-cancellation defect the Pass 50 blocks avoid by construction. Pins the fix directly: a
  // throwing capabilityViolationsCounter must not prevent the schemaRejections/latchCause seeds.
  it('a throwing capabilityViolationsCounter does not cancel the schemaRejections/latchCause seeds', () => {
    const noop = {
      inc: vi.fn(),
      observe: vi.fn(),
      labels: vi.fn(() => ({ set: vi.fn() })),
      remove: vi.fn(),
      set: vi.fn(),
    };
    const throwingCapability = {
      inc: () => {
        throw new Error('boom');
      },
    };
    const schemaRejections = { inc: vi.fn() };
    const latchCauseSet = vi.fn();
    const latchCause = { labels: vi.fn(() => ({ set: latchCauseSet })) };

    new AgentMetricsRecorder(
      noop as unknown as Counter<string>, // decideCounter
      noop as unknown as Counter<string>, // tokensCounter
      noop as unknown as Histogram<string>, // decideLatency
      noop as unknown as Gauge<string>, // playbookInfoGauge
      noop as unknown as Counter<string>, // validatorRejectionsCounter
      noop as unknown as Gauge<string>, // clientInfoGauge
      noop as unknown as Counter<string>, // consultGateCounter
      noop as unknown as Counter<string>, // reflectionOutcomesCounter
      noop as unknown as Counter<string>, // venueTpCounter
      noop as unknown as Counter<string>, // venueStopCounter
      noop as unknown as Counter<string>, // fundingIngestedCounter
      noop as unknown as Gauge<string>, // activeMenuGauge
      noop as unknown as Counter<string>, // menuChurnCounter
      noop as unknown as Gauge<string>, // budgetRemainingGauge
      throwingCapability as unknown as Counter<string>, // capabilityViolationsCounter — THROWS
      schemaRejections as unknown as Counter<string>, // schemaRejectionsCounter
      noop as unknown as Counter<string>, // rearmFallbackCounter
      noop as unknown as Gauge<string>, // clientLatchedGauge
      noop as unknown as Gauge<string>, // lastSuccessGauge
      latchCause as unknown as Gauge<string>, // latchCauseGauge
    );

    expect(schemaRejections.inc).toHaveBeenCalledWith({ kind: 'single' }, 0);
    expect(schemaRejections.inc).toHaveBeenCalledWith({ kind: 'batch' }, 0);
    expect(schemaRejections.inc).toHaveBeenCalledWith({ kind: 'element' }, 0);
    expect(schemaRejections.inc).toHaveBeenCalledWith({ kind: 'missing_symbol' }, 0);
    expect(latchCauseSet).toHaveBeenCalledWith(0);
  });
});
