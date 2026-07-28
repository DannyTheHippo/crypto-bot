import { Test, type TestingModule } from '@nestjs/testing';
import { register } from 'prom-client';
import type { Counter, Gauge, Histogram } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  AGENTIC_REFLECTION_TRIGGER_COUNTER,
  AGENTIC_REARM_FALLBACK_COUNTER,
  AGENT_CLIENT_LATCHED_GAUGE,
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
        AGENTIC_REFLECTION_TRIGGER_COUNTER,
        AGENTIC_REARM_FALLBACK_COUNTER,
        AGENT_CLIENT_LATCHED_GAUGE,
        AgentMetricsRecorder,
      ],
    }).compile();
    recorder = moduleRef.get(AgentMetricsRecorder);
  });

  afterEach(async () => {
    await moduleRef.close();
    register.clear();
  });

  it('registers all nineteen agentic-lane metrics', async () => {
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
      'agentic_reflection_trigger_total',
      'agentic_rearm_fallback_total',
      'agent_client_latched',
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

  it('recordReflectionTrigger increments agentic_reflection_trigger_total{outcome}', async () => {
    recorder.recordReflectionTrigger('fired');
    recorder.recordReflectionTrigger('cooldown');
    recorder.recordReflectionTrigger('cooldown');
    const metric = await register.getSingleMetricAsString('agentic_reflection_trigger_total');
    expect(metric).toContain('outcome="fired"} 1');
    expect(metric).toContain('outcome="cooldown"} 2');
  });

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
      throwing as unknown as Counter<string>,
      // agent_client_latched: a `set` that throws — recordDecide writes the latch LEVEL alongside the
      // counter, so a misbehaving gauge must not escape into the decide path either.
      {
        ...throwing,
        set: () => {
          throw new Error('boom');
        },
      } as unknown as Gauge<string>,
    );
    expect(() => recorder.recordDecide('proposed')).not.toThrow();
    expect(() => recorder.recordDecide('client_latched')).not.toThrow();
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
    expect(() => recorder.recordReflectionTrigger('fired')).not.toThrow();
    expect(() => recorder.recordRearmFallback()).not.toThrow();
  });
});
