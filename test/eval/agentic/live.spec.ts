// Live eval: a REAL network call to the Anthropic API. Guarded by BOTH ANTHROPIC_API_KEY and
// EVAL_LIVE=1 — either absent skips cleanly, so `pnpm eval:agentic` never makes a network call or
// spends a real token by default. recorded-payload-live-compare.spec.ts is the only other file in
// test/eval/agentic that can touch the network (double-gated further behind DATABASE_URL); every
// other suite here is offline (scripted fetchFn or DB-only).
import { describe, it, expect } from 'vitest';
import { AnthropicAgentClient } from '../../../src/features/strategy/agentic/anthropic-agent-client';
import { SEED_PLAYBOOK } from '../../../src/features/strategy/agentic/agentic-strategy.module';
import {
  scoreRows,
  type ScoringRow,
} from '../../../src/features/strategy/agentic/counterfactual-scoring';
import { evalCandle, evalInput, EVAL_PROFILE, toScoringAction } from './fixtures';

const API_KEY = process.env['ANTHROPIC_API_KEY'];
const LIVE_ENABLED = process.env['EVAL_LIVE'] === '1';
const SKIP = !API_KEY || !LIVE_ENABLED;

describe.skipIf(SKIP)('agentic eval — live (guarded, real Anthropic API call)', () => {
  it('produces a real decision and a scorable row against a single fixture candle', async () => {
    const client = new AnthropicAgentClient(
      {
        apiKey: API_KEY!,
        model: process.env['AGENTIC_MODEL'] ?? 'claude-opus-5',
        timeoutMs: 30_000,
        maxTokens: 512,
        signalTtlMs: 60_000,
        profile: EVAL_PROFILE,
      },
      fetch,
      undefined,
      { current: () => Promise.resolve(SEED_PLAYBOOK) },
    );
    const candle = evalCandle(0, '65000');
    const input = evalInput(candle);
    const proposal = await client.propose(input);

    expect(proposal.decision?.action).toMatch(/^(long|flat|hold)$/);
    const row: ScoringRow = {
      eventTime: input.snapshot.eventTime,
      action: toScoringAction(proposal.decision?.action),
      confidence: proposal.decision?.confidence ?? null,
      refPrice: candle.close.toFixed(),
      close: candle.close.toFixed(),
      playbookVersion: proposal.playbookVersion ?? null,
      promptHash: proposal.promptHash ?? 'unknown',
      model: process.env['AGENTIC_MODEL'] ?? 'claude-opus-5',
      symbol: String(candle.symbol),
    };
    expect(() => scoreRows([row])).not.toThrow();
  }, 30_000);
});
