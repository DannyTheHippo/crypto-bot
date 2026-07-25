// Offline eval harness (pnpm eval:agentic) — the candidate-vs-champion A/B comparison workflow:
// replay the SAME fixture candle window through two known playbook variants of one known template
// version, score each into its own Scorecard, and compare() them. This is exactly the scenario
// compare()'s own refusal-without-flag docstring describes as the one caller who CAN vouch for
// template equality.
import { describe, expect, it } from 'vitest';
import { SEED_PLAYBOOK } from '../../../src/features/trading/agentic/agentic-strategy.module';
import { compare, scoreRows } from '../../../src/features/trading/agentic/counterfactual-scoring';
import { validatePlaybook } from '../../../src/features/trading/agentic/playbook-validator';
import { replay, type ScriptedDecision } from './fixtures';

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

// A structurally valid candidate: same 4 sections, same order, one line of "mistakes to avoid"
// tightened — enough to change promptHash (playbook content is folded into the hash) without
// tripping validatePlaybook's structural gate.
const CANDIDATE_PLAYBOOK_CONTENT = SEED_PLAYBOOK.content.replace(
  'Fee arithmetic, quantified: a round trip costs ~20bps; your',
  'Fee arithmetic, quantified: a round trip costs ~25bps; your',
);

describe('agentic eval — candidate-vs-champion A/B', () => {
  it('candidate playbook is structurally valid and textually different from the champion', () => {
    expect(validatePlaybook(CANDIDATE_PLAYBOOK_CONTENT).ok).toBe(true);
    expect(CANDIDATE_PLAYBOOK_CONTENT).not.toBe(SEED_PLAYBOOK.content);
  });

  it('replays the same window through both variants and compares them once assertSameTemplate is passed', async () => {
    const champion = await replay(SEED_PLAYBOOK.content, MODEL, CLOSES, SCRIPT);
    const candidate = await replay(CANDIDATE_PLAYBOOK_CONTENT, MODEL, CLOSES, SCRIPT);

    const championCard = scoreRows(champion.rows)[0]!;
    const candidateCard = scoreRows(candidate.rows)[0]!;

    // Different playbook content -> different promptHash, even though the scripted decisions
    // (and therefore every scored metric) are identical.
    expect(championCard.promptHash).not.toBe(candidateCard.promptHash);

    expect(() => compare(championCard, candidateCard)).toThrow(/assertSameTemplate/);

    const result = compare(championCard, candidateCard, { assertSameTemplate: true });
    expect(result.champion).toBe(championCard);
    expect(result.candidate).toBe(candidateCard);
    // Identical scripted decisions over the identical window -> identical toy equity/hit rates.
    expect(result.finalEquityDelta).toBe(0);
    for (const delta of result.hitRateDeltas) {
      expect(delta.delta === null || delta.delta === 0).toBe(true);
    }
  });
});
