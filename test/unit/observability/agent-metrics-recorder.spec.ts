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
  AGENTIC_PRESCREEN_COUNTER,
  AGENTIC_REFLECTION_OUTCOMES_COUNTER,
} from '../../../src/features/common/observability/metrics.service';
import { AgentMetricsRecorder } from '../../../src/features/common/observability/agent-metrics-recorder.service';

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
        AGENTIC_PRESCREEN_COUNTER,
        AGENTIC_REFLECTION_OUTCOMES_COUNTER,
        AgentMetricsRecorder,
      ],
    }).compile();
    recorder = moduleRef.get(AgentMetricsRecorder);
  });

  afterEach(async () => {
    await moduleRef.close();
    register.clear();
  });

  it('registers all eight agentic-lane metrics', async () => {
    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    for (const name of [
      'agent_decide_total',
      'agent_tokens_total',
      'agent_decide_latency_seconds',
      'agentic_playbook_info',
      'playbook_validator_rejections_total',
      'agent_client_info',
      'agentic_prescreen_total',
      'agentic_reflection_outcomes_total',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('recordDecide increments agent_decide_total{outcome}', async () => {
    recorder.recordDecide('proposed');
    recorder.recordDecide('timeout');
    const metric = await register.getSingleMetricAsString('agent_decide_total');
    expect(metric).toContain('outcome="proposed"} 1');
    expect(metric).toContain('outcome="timeout"} 1');
  });

  it('recordTokens increments the input and output series independently', async () => {
    recorder.recordTokens(120, 45);
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="input"} 120');
    expect(metric).toContain('kind="output"} 45');
  });

  it('recordTokens leaves the cache series absent when the response carried no cache fields', async () => {
    recorder.recordTokens(120, 45);
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).not.toContain('kind="cache_read"');
    expect(metric).not.toContain('kind="cache_creation"');
  });

  it('recordTokens materializes cache series at explicit zero (W2.4: absent ≠ confirmed-zero)', async () => {
    recorder.recordTokens(120, 45, 0, 0);
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="cache_read"} 0');
    expect(metric).toContain('kind="cache_creation"} 0');
  });

  it('recordTokens accumulates cache_read and cache_creation counts', async () => {
    recorder.recordTokens(120, 45, 1500, 0);
    recorder.recordTokens(80, 30, 0, 2000);
    const metric = await register.getSingleMetricAsString('agent_tokens_total');
    expect(metric).toContain('kind="cache_read"} 1500');
    expect(metric).toContain('kind="cache_creation"} 2000');
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

  it('recordPrescreen increments agentic_prescreen_total{outcome,reason}', async () => {
    recorder.recordPrescreen('called', 'vol_expansion');
    recorder.recordPrescreen('called', 'position_open');
    recorder.recordPrescreen('skipped_quiet', 'quiet');
    recorder.recordPrescreen('failopen_error');
    const metric = await register.getSingleMetricAsString('agentic_prescreen_total');
    expect(metric).toContain('outcome="called",reason="vol_expansion"} 1');
    expect(metric).toContain('outcome="called",reason="position_open"} 1');
    expect(metric).toContain('outcome="skipped_quiet",reason="quiet"} 1');
    expect(metric).toContain('outcome="failopen_error",reason="n/a"} 1');
  });

  it('recordReflectionOutcome increments agentic_reflection_outcomes_total{outcome}', async () => {
    recorder.recordReflectionOutcome('minted');
    recorder.recordReflectionOutcome('validator_reject');
    const metric = await register.getSingleMetricAsString('agentic_reflection_outcomes_total');
    expect(metric).toContain('outcome="minted"} 1');
    expect(metric).toContain('outcome="validator_reject"} 1');
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
    );
    expect(() => recorder.recordDecide('proposed')).not.toThrow();
    expect(() => recorder.recordTokens(1, 1)).not.toThrow();
    expect(() => recorder.observeDecideLatency(1)).not.toThrow();
    expect(() => recorder.setPlaybookInfo(1)).not.toThrow();
    expect(() => recorder.recordValidatorRejection(true)).not.toThrow();
    expect(() => recorder.setClientInfo('stub')).not.toThrow();
    expect(() => recorder.recordPrescreen('called')).not.toThrow();
    expect(() => recorder.recordReflectionOutcome('minted')).not.toThrow();
  });
});
