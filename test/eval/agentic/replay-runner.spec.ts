// Offline eval harness (pnpm eval:agentic) — replays a fixture candle window through the REAL
// prompt-composition + client pipeline (buildSystemPrompt/buildUserMessage inside
// AnthropicAgentClient) with a scripted, no-network fetchFn, then scores the resulting rows.
// This suite never touches the network and never requires an API key — CI-exempt only because
// ci.yml simply doesn't invoke it, not because it needs guarding.
import { describe, it, expect } from 'vitest';
import {
  DECISION_TOOL,
  PROMPT_TEMPLATE_VERSION,
  buildSystemPrompt,
  computePromptHash,
} from '../../../src/features/trading/agentic/agent-prompt';
import { SEED_PLAYBOOK } from '../../../src/features/trading/agentic/agentic-strategy.module';
import { scoreRows } from '../../../src/features/trading/agentic/counterfactual-scoring';
import { EVAL_PROFILE, replay, type ScriptedDecision } from './fixtures';

const MODEL = 'claude-eval-fixture-model';
const CLOSES = ['100', '102', '108', '104', '96', '99', '101'];
const SCRIPT: readonly ScriptedDecision[] = [
  { action: 'long', confidence: 0.7 },
  { action: 'hold', confidence: 0.6 },
  { action: 'hold', confidence: 0.6 },
  { action: 'flat', confidence: 0.8 },
  { action: 'hold', confidence: 0.4 },
  { action: 'long', confidence: 0.5 },
  { action: 'hold', confidence: 0.5 },
];

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

    // The promptHash the client returned must match an independent computePromptHash call over
    // the same components — proof the real hashing path (not a fixture-side stand-in) ran.
    const expectedPromptHash = computePromptHash({
      templateVersion: PROMPT_TEMPLATE_VERSION,
      playbookContent: SEED_PLAYBOOK.content,
      toolSchemaJson: JSON.stringify(DECISION_TOOL),
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
