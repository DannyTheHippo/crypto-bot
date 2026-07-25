// Offline eval harness (pnpm eval:agentic) — deterministic render checks over REAL persisted
// decision inputs (agent_decisions.input_payload, playbook-free by construction — see
// buildMarketPayload's own comment). Never touches the network and never requires an API key: it
// re-renders the fixture rows in recorded-payload-fixtures.ts under the CURRENT prompt template and
// under variants (a different playbook, a different candle-window size), then asserts the render is
// deterministic and that promptHash varies with template components (playbook/model) but NOT with
// per-call market payload (candle count) — the exact invariant groupKey()/scoreRows() rely on to
// group many rows sharing one prompt config into a single Scorecard.
import { describe, expect, it } from 'vitest';
import {
  DECISION_TOOL,
  PROMPT_TEMPLATE_VERSION,
  buildSystemPrompt,
  buildUserMessage,
  computePromptHash,
} from '../../../src/features/strategy/agentic/agent-prompt';
import { SEED_PLAYBOOK } from '../../../src/features/strategy/agentic/agentic-strategy.module';
import { compare, scoreRows } from '../../../src/features/strategy/agentic/counterfactual-scoring';
import { EVAL_PROFILE, evalCandle, evalInput } from './fixtures';
import {
  RECORDED_PAYLOAD_ROWS,
  composeRecordedUserMessage,
  scoringRowFromPayload,
  withCandleWindow,
} from './recorded-payload-fixtures';

const MODEL = 'claude-eval-fixture-model';

// Same structurally-valid-but-textually-different tweak candidate-vs-champion.spec.ts uses — one
// playbook content variant, one template.
const CANDIDATE_PLAYBOOK_CONTENT = SEED_PLAYBOOK.content.replace(
  'Fee arithmetic, quantified: a round trip costs ~20bps; your',
  'Fee arithmetic, quantified: a round trip costs ~25bps; your',
);

function hashFor(playbookContent: string, model: string = MODEL): string {
  return computePromptHash({
    templateVersion: PROMPT_TEMPLATE_VERSION,
    playbookContent,
    toolSchemaJson: JSON.stringify(DECISION_TOOL),
    modelId: model,
  });
}

describe('agentic eval — recorded input_payload render checks (offline, no network)', () => {
  it('composeRecordedUserMessage matches the REAL buildUserMessage wrapping byte-for-byte', () => {
    // Anchors the necessarily-duplicated wrapping logic in recorded-payload-fixtures.ts (see its
    // own comment for why it can't just call buildUserMessage) against production ground truth —
    // any future drift in buildUserMessage's wrapping fails this immediately.
    const candle = evalCandle(0, '100.00');
    const input = evalInput(candle);
    // Only the wrapping is under test here (not buildMarketPayload's own field rendering, which
    // agent-prompt.ts's own tests own) — buildUserMessage derives its market JSON internally from
    // `input`, so composing against that SAME derived JSON (via the playbook-free buildUserMessage
    // call below) isolates the wrap-only comparison.
    const realMarketJson = buildUserMessage(input, {});
    expect(composeRecordedUserMessage(realMarketJson, undefined)).toBe(realMarketJson);

    const realWrapped = buildUserMessage(input, { playbookContent: SEED_PLAYBOOK.content });
    const recomposed = composeRecordedUserMessage(realMarketJson, SEED_PLAYBOOK.content);
    expect(recomposed).toBe(realWrapped);
  });

  it.each(RECORDED_PAYLOAD_ROWS.map((row, i) => [i, row] as const))(
    'row %i: composing the same payload + playbook twice is byte-identical (render determinism)',
    (_i, row) => {
      const first = composeRecordedUserMessage(row, SEED_PLAYBOOK.content);
      const second = composeRecordedUserMessage(row, SEED_PLAYBOOK.content);
      expect(second).toBe(first);
      expect(first).toContain(row);
    },
  );

  it('promptHash is stable across repeated calls with identical template components', () => {
    const first = hashFor(SEED_PLAYBOOK.content);
    const second = hashFor(SEED_PLAYBOOK.content);
    expect(second).toBe(first);
  });

  it('promptHash is IDENTICAL across every recorded row for the same playbook/model — it is a function of the prompt template, never of the per-call market payload', () => {
    const hash = hashFor(SEED_PLAYBOOK.content);
    for (const row of RECORDED_PAYLOAD_ROWS) {
      const messages = [
        composeRecordedUserMessage(row, SEED_PLAYBOOK.content),
        composeRecordedUserMessage(withCandleWindow(row, 1), SEED_PLAYBOOK.content),
      ];
      // The composed messages differ (candle-window variant changes the rendered JSON)...
      expect(messages[1]).not.toBe(messages[0]);
      // ...but the hash used to group rows into a Scorecard does not: it never saw the payload.
      expect(hashFor(SEED_PLAYBOOK.content)).toBe(hash);
    }
  });

  it('promptHash DIFFERS when the playbook (a template component) changes, for every recorded row', () => {
    const championHash = hashFor(SEED_PLAYBOOK.content);
    const candidateHash = hashFor(CANDIDATE_PLAYBOOK_CONTENT);
    expect(candidateHash).not.toBe(championHash);

    for (const row of RECORDED_PAYLOAD_ROWS) {
      const championMsg = composeRecordedUserMessage(row, SEED_PLAYBOOK.content);
      const candidateMsg = composeRecordedUserMessage(row, CANDIDATE_PLAYBOOK_CONTENT);
      expect(candidateMsg).not.toBe(championMsg);
    }
  });

  it('scores the recorded-row sequence under two playbook variants and compares them, exercising the same scoreRows()/compare() path the live-compare script drives against the real API', () => {
    const championIdentity = {
      promptHash: hashFor(SEED_PLAYBOOK.content),
      playbookVersion: SEED_PLAYBOOK.version,
      model: MODEL,
    };
    const candidateIdentity = {
      promptHash: hashFor(CANDIDATE_PLAYBOOK_CONTENT),
      playbookVersion: SEED_PLAYBOOK.version + 1,
      model: MODEL,
    };
    // Scripted decisions (no network) standing in for what the live script gets from the real API —
    // one per recorded row, in the same chronological order.
    const scriptedActions: readonly ('long' | 'flat' | 'hold')[] = ['long', 'hold', 'flat', 'hold'];

    // Fixture payloads always carry a valid eventTime — the non-null assertions document that
    // this CI-safe path never exercises the malformed-row skip the live scripts tolerate.
    const championRows = RECORDED_PAYLOAD_ROWS.map(
      (row, i) =>
        scoringRowFromPayload(
          row,
          { action: scriptedActions[i]!, confidence: 0.6 },
          championIdentity,
        )!,
    );
    const candidateRows = RECORDED_PAYLOAD_ROWS.map(
      (row, i) =>
        scoringRowFromPayload(
          row,
          { action: scriptedActions[i]!, confidence: 0.6 },
          candidateIdentity,
        )!,
    );

    const championCards = scoreRows(championRows);
    const candidateCards = scoreRows(candidateRows);
    // One promptHash per variant AND one symbol (all fixtures are BTC/USDT) -> exactly one
    // scorecard each; a multi-symbol corpus would yield one card per symbol (combineScorecards
    // aggregates those — the live-compare script's path).
    expect(championCards).toHaveLength(1);
    expect(candidateCards).toHaveLength(1);
    const [championCard] = championCards;
    const [candidateCard] = candidateCards;

    expect(championCard!.rowCount).toBe(RECORDED_PAYLOAD_ROWS.length);
    expect(championCard!.horizonStats).toHaveLength(3);
    // 4 chronological rows -> exactly 3 horizon-1 samples (i, i+1 pairs); horizon 4/24 have none yet.
    const horizon1 = championCard!.horizonStats.find((s) => s.horizon === 1);
    expect(horizon1?.sampleCount).toBe(3);
    expect(horizon1?.hitRate).not.toBeNull();

    const result = compare(championCard!, candidateCard!, { assertSameTemplate: true });
    expect(result.champion).toBe(championCard);
    expect(result.candidate).toBe(candidateCard);
    expect(typeof result.finalEquityDelta).toBe('number');
    expect(result.hitRateDeltas).toHaveLength(3);
  });

  it('buildSystemPrompt is unaffected by which recorded row is being scored (it depends only on the trading profile)', () => {
    const expected = buildSystemPrompt(EVAL_PROFILE);
    expect(buildSystemPrompt(EVAL_PROFILE)).toBe(expected);
  });
});
