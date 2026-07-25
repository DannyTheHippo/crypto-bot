import { describe, expect, it } from 'vitest';
import { epochMs, symbolId } from '../../../src/domain/types/ids';
import { buildMarketPayload } from '../../../src/features/trading/agentic/agent-prompt';
import {
  createEdgePolicyPort,
  DISABLED_EDGE_POLICY,
  DisabledEdgePolicy,
  EDGE_POLICY_INACTIVE,
} from '../../../src/features/trading/agentic/disabled-edge-policy';
import { validate } from '../../../src/config/environment/environment.config';
import type { AgentContext, AgentDecisionInput } from '../../../src/ports/agentic-strategy';

const SYM = symbolId('BTC/USDT');
const T = epochMs(1_700_000_000_000);

function inputWithContext(context: AgentContext): AgentDecisionInput {
  return {
    strategyId: 'agentic-1' as AgentDecisionInput['strategyId'],
    trigger: { kind: 'candle', event: { symbol: 'BTC/USDT' } },
    snapshot: {
      eventTime: T,
      candles: new Map(),
      tickers: new Map(),
      books: new Map(),
      execReports: [],
      portfolio: {
        strategyId: 'agentic-1' as AgentDecisionInput['strategyId'],
        positions: new Map(),
        openOrders: [],
      },
    },
    context,
  } as unknown as AgentDecisionInput;
}

const flatContext = (): AgentContext => ({
  indicators: null,
  position: {
    side: 'FLAT',
    qty: '0',
    avgEntry: null,
    realizedPnl: '0',
    unrealizedPnlPct: null,
    openOrders: 0,
  },
  recentDecisions: [],
});

describe('DisabledEdgePolicy', () => {
  it('always returns inactive snapshot', () => {
    const policy = new DisabledEdgePolicy();
    expect(policy.snapshot({ symbol: SYM, eventTime: T })).toEqual(EDGE_POLICY_INACTIVE);
    expect(DISABLED_EDGE_POLICY.snapshot({ symbol: SYM, eventTime: T })).toEqual(
      EDGE_POLICY_INACTIVE,
    );
  });
});

describe('createEdgePolicyPort', () => {
  it('returns disabled when flag off', () => {
    const port = createEdgePolicyPort({ enabled: false, family: 'xsec20-ew' });
    expect(port.snapshot({ symbol: SYM, eventTime: T })).toEqual(EDGE_POLICY_INACTIVE);
  });

  it('returns disabled when family is none', () => {
    const port = createEdgePolicyPort({ enabled: true, family: 'none' });
    expect(port.snapshot({ symbol: SYM, eventTime: T })).toEqual(EDGE_POLICY_INACTIVE);
  });

  it('fail-closed when enabled with a family but no winner implementation', () => {
    const port = createEdgePolicyPort({ enabled: true, family: 'xsec20-volbeta' });
    const snap = port.snapshot({ symbol: SYM, eventTime: T });
    expect(snap.active).toBe(false);
    expect(snap.familyId).toBe('none');
  });

  it('uses override implementation when supplied', () => {
    const port = createEdgePolicyPort({
      enabled: true,
      family: 'xsec20-ew',
      implementation: {
        snapshot: () => ({
          active: true,
          familyId: 'xsec20-ew',
          cohort: { asOfMs: T, members: [{ symbol: 'BTC/USDT', score: '0.12', rank: 1 }] },
          sideEligibility: { long: true, short: false },
          maxSizeFraction: '0.10',
        }),
      },
    });
    const snap = port.snapshot({ symbol: SYM, eventTime: T });
    expect(snap.active).toBe(true);
    if (snap.active) {
      expect(snap.maxSizeFraction).toBe('0.10');
    }
  });
});

describe('buildMarketPayload edgePolicy block', () => {
  it('omits edgePolicy key when context carries no active block', () => {
    const raw = buildMarketPayload(inputWithContext(flatContext()));
    const payload = JSON.parse(raw) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('edgePolicy');
  });

  it('includes edgePolicy when context carries an active block', () => {
    const edgePolicy = {
      familyId: 'xsec20-ew' as const,
      cohort: { asOfMs: T, members: [] },
      sideEligibility: { long: true, short: false },
      maxSizeFraction: '0.08',
    };
    const input = inputWithContext({ ...flatContext(), edgePolicy });
    const payload = JSON.parse(buildMarketPayload(input)) as { edgePolicy?: unknown };
    expect(payload.edgePolicy).toEqual(edgePolicy);
  });
});

describe('validate AGENTIC_EDGE_POLICY_* defaults', () => {
  it('defaults edge policy off and family none', () => {
    const cfg = validate({ NODE_ENV: 'test' });
    expect(cfg.agentic.edgePolicyEnabled).toBe(false);
    expect(cfg.agentic.edgePolicyFamily).toBe('none');
  });

  it('does not surface live secrets under test/ci', () => {
    const cfg = validate({ NODE_ENV: 'test', AGENTIC_EDGE_POLICY_ENABLED: 'true' });
    expect(cfg.liveApiKey).toBeUndefined();
    expect(cfg.liveApiSecret).toBeUndefined();
    expect(cfg.armingSecret).toBeUndefined();
  });
});
