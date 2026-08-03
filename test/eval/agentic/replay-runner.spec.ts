// Offline eval harness (pnpm eval:agentic) — replays a fixture candle window through the REAL
// prompt-composition + client pipeline (buildSystemPrompt/buildUserMessage inside
// AnthropicAgentClient) with a scripted, no-network fetchFn, then scores the resulting rows.
// This suite never touches the network and never requires an API key — CI-exempt only because
// ci.yml simply doesn't invoke it, not because it needs guarding.
import { describe, expect, it } from 'vitest';
import {
  MAX_TOKENS_TEMPLATE_PREFIX,
  THINKING_TEMPLATE_VERSION,
  TRADE_TEMPLATE_VERSION,
  buildSystemPrompt,
  buildTradeTool,
  computePromptHash,
} from '../../../src/features/strategy/agentic/agent-prompt';
import { SEED_PLAYBOOK } from '../../../src/features/strategy/agentic/agentic-strategy.module';
import { scoreRows } from '../../../src/features/strategy/agentic/counterfactual-scoring';
import { EVAL_MAX_TOKENS, EVAL_PROFILE, replay, type ScriptedDecision } from './fixtures';

const MODEL = 'claude-eval-fixture-model';
const CLOSES = ['100', '102', '108', '104', '96', '99', '101'];
const SCRIPT: readonly ScriptedDecision[] = [
  { action: 'open_long', confidence: 0.7 },
  { action: 'hold', confidence: 0.6 },
  { action: 'hold', confidence: 0.6 },
  { action: 'close', confidence: 0.8 },
  { action: 'hold', confidence: 0.4 },
  { action: 'open_long', confidence: 0.5 },
  { action: 'hold', confidence: 0.5 },
];

// 2026-07-30: the fixture caps object this file used to build for buildTradeTool is gone with the
// tool's parameter — the tool is byte-identical for every symbol now, so the expected promptHash
// below no longer depends on this symbol's capabilities at all.

describe('agentic eval — replay runner (offline, fixture fetchFn)', () => {
  it('drives buildSystemPrompt/buildUserMessage + AnthropicAgentClient through a full candle window and produces one scorecard', async () => {
    const { rows, requestLog } = await replay(SEED_PLAYBOOK.content, MODEL, CLOSES, SCRIPT);

    expect(rows).toHaveLength(CLOSES.length);
    expect(requestLog).toHaveLength(CLOSES.length);

    // Every request actually carried the real system prompt this profile/playbook composes —
    // proof the fixture drove the REAL buildSystemPrompt, not a stubbed-out one. The client sends
    // `system` as a single cache_control text block (W2.4 prompt caching, anthropic-agent-client.ts),
    // so the assertion checks that envelope, not a bare string.
    const expectedSystemPrompt = buildSystemPrompt(EVAL_PROFILE);
    for (const req of requestLog) {
      expect(req.system).toEqual([
        {
          type: 'text',
          text: expectedSystemPrompt,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]);
    }

    // Client always stamps thinkingArm=true ⇒ TRADE_TEMPLATE_VERSION+th1 (prepareDecideContext),
    // and since 2026-08-04 it appends an `mt<value>` tag whenever maxTokens deviates from the
    // deployed baseline. This fixture runs at EVAL_MAX_TOKENS, which is such a deviation, so the
    // tag is EXPECTED here — its absence would mean fixture rows hash identically to real
    // deployment rows, which is the collision the tag exists to prevent. Composed from the same
    // constants the client composes from, so a future prefix or budget change cannot leave this
    // assertion quietly asserting the old contract.
    const expectedPromptHash = computePromptHash({
      templateVersion: `${TRADE_TEMPLATE_VERSION}+${THINKING_TEMPLATE_VERSION}+${MAX_TOKENS_TEMPLATE_PREFIX}${EVAL_MAX_TOKENS}`,
      playbookContent: SEED_PLAYBOOK.content,
      toolSchemaJson: JSON.stringify(buildTradeTool()),
      modelId: MODEL,
    });
    expect(rows[0]!.promptHash).toBe(expectedPromptHash);

    const scorecards = scoreRows(rows);
    // One client/playbook throughout -> one promptHash -> one scorecard.
    expect(scorecards).toHaveLength(1);
    const [scorecard] = scorecards;
    expect(scorecard!.rowCount).toBe(CLOSES.length);
    expect(scorecard!.promptHash).toBe(expectedPromptHash);
    expect(scorecard!.horizonStats).toHaveLength(3);
    // Scripted: long@0, flat@3 -> exactly one closed round trip; long@5 never closes.
    expect(scorecard!.toyEquity.roundTrips).toBe(1);
    expect(scorecard!.toyEquity.openAtEnd).toBe(true);
    expect(typeof scorecard!.toyEquity.finalEquity).toBe('number');
  });
});
