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
} from '../../../src/modules/observability/metrics.service';
import { AgentMetricsRecorder } from '../../../src/modules/observability/agent-metrics-recorder.service';

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
        AgentMetricsRecorder,
      ],
    }).compile();
    recorder = moduleRef.get(AgentMetricsRecorder);
  });

  afterEach(async () => {
    await moduleRef.close();
    register.clear();
  });

  it('registers all six agentic-lane metrics', async () => {
    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    for (const name of [
      'agent_decide_total',
      'agent_tokens_total',
      'agent_decide_latency_seconds',
      'agentic_playbook_info',
      'playbook_validator_rejections_total',
      'agent_client_info',
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

  it('recordValidatorRejection tags banned_token true/false', async () => {
    recorder.recordValidatorRejection(true);
    recorder.recordValidatorRejection(false);
    const metric = await register.getSingleMetricAsString('playbook_validator_rejections_total');
    expect(metric).toContain('banned_token="true"} 1');
    expect(metric).toContain('banned_token="false"} 1');
  });

  it('setClientInfo sets agent_client_info{kind} to 1', async () => {
    recorder.setClientInfo('stub');
    const metric = await register.getSingleMetricAsString('agent_client_info');
    expect(metric).toContain('kind="stub"} 1');
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
    );
    expect(() => recorder.recordDecide('proposed')).not.toThrow();
    expect(() => recorder.recordTokens(1, 1)).not.toThrow();
    expect(() => recorder.observeDecideLatency(1)).not.toThrow();
    expect(() => recorder.setPlaybookInfo(1)).not.toThrow();
    expect(() => recorder.recordValidatorRejection(true)).not.toThrow();
    expect(() => recorder.setClientInfo('stub')).not.toThrow();
  });
});
