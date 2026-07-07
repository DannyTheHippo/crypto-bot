// Live eval: replays REAL recorded agent_decisions.input_payload rows through two prompt variants
// (the seed playbook vs a candidate tweak) against the REAL Anthropic API, scores both, and prints a
// scorecard. This is the second file in test/eval/agentic that can touch the network (see
// live.spec.ts, the first) — double-gated because it is materially more expensive than that file (2x
// the recorded row count in real API calls, not one):
//   - ANTHROPIC_API_KEY + EVAL_LIVE=1 — the exact network gate live.spec.ts already uses.
//   - DATABASE_URL + the same read-only DB_SUITE_ALLOW_RESET/_test-suffix gate recorded-rows.spec.ts
//     uses for its rows source (mirrored locally below, not imported, so each spec's gate stays
//     self-contained and independently auditable).
// Any one of the four missing skips the whole suite, so `pnpm eval:agentic` never calls the network
// or reads a real database by default, and this file is never wired into CI.
//
// To run it against a real staging/local DB + key:
//   DATABASE_URL=postgres://...   (must end in _test, or set DB_SUITE_ALLOW_RESET=1)
//   ANTHROPIC_API_KEY=sk-ant-...
//   EVAL_LIVE=1
//   AGENTIC_MODEL=claude-opus-4-8        (optional, defaults below)
//   AGENTIC_EVAL_ROW_LIMIT=10            (optional, defaults below — each row costs 2 real calls)
//   pnpm exec vitest run test/eval/agentic/recorded-payload-live-compare.spec.ts
//
// To inspect what rows are available first (read-only, no code path here requires this — it's the
// same query journal.recent() issues under the hood, spelled out for manual inspection):
//   psql "$DATABASE_URL" -c "SELECT id, event_time, model, prompt_hash FROM agent_decisions
//     WHERE input_payload IS NOT NULL ORDER BY event_time ASC LIMIT 50;"
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../src/database/schemas/trading';
import { AgentDecisionJournalAdapter } from '../../../src/database/repositories/agent-decision-journal.adapter';
import {
  DECISION_TOOL,
  PROMPT_TEMPLATE_VERSION,
  buildSystemPrompt,
  computePromptHash,
} from '../../../src/features/trading/agentic/agent-prompt';
import { SEED_PLAYBOOK } from '../../../src/features/trading/agentic/agentic-strategy.module';
import {
  compare,
  scoreRows,
  type ScoringRow,
} from '../../../src/features/trading/agentic/counterfactual-scoring';
import { EVAL_PROFILE } from './fixtures';
import {
  composeRecordedUserMessage,
  scoringRowFromPayload,
  type PromptIdentity,
} from './recorded-payload-fixtures';

const API_KEY = process.env['ANTHROPIC_API_KEY'];
const LIVE_ENABLED = process.env['EVAL_LIVE'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const MODEL = process.env['AGENTIC_MODEL'] ?? 'claude-opus-4-8';
const ROW_LIMIT = Number(process.env['AGENTIC_EVAL_ROW_LIMIT'] ?? '10');

// Mirrors recorded-rows.spec.ts's read-only DB gate — see that file for the full rationale.
function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

const resetAllowed =
  process.env['DB_SUITE_ALLOW_RESET'] === '1' || (!!DB_URL && dbNameEndsWithTest(DB_URL));

const SKIP = !API_KEY || !LIVE_ENABLED || !DB_URL || !resetAllowed;

// A structurally valid, textually different candidate — same tweak candidate-vs-champion.spec.ts
// uses, so both suites' notion of "candidate" stays recognizable across the eval harness.
const CANDIDATE_PLAYBOOK_CONTENT = SEED_PLAYBOOK.content.replace(
  'Do not overtrade small, noisy fluctuations — each round trip costs real fees.',
  'Prefer high-conviction setups only — each round trip costs real fees.',
);

const liveDecisionSchema = z.object({
  action: z.enum(['long', 'flat', 'hold']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});

// Calls the real Anthropic Messages API directly, mirroring anthropic-agent-client.ts's
// attemptOnce()/response-envelope handling in miniature. This does NOT go through
// AnthropicAgentClient.propose(): that method takes a full AgentDecisionInput and derives its own
// market JSON internally, but a persisted input_payload row has no surviving AgentDecisionInput to
// hand it (see recorded-payload-fixtures.ts's composeRecordedUserMessage comment) — this script's
// entire purpose is to re-splice a NEW playbook onto that OLD, already-rendered market snapshot.
// No retry/backoff here (unlike production): a single failed call in an offline eval run just
// degrades that one row to an 'error' action rather than costing a second real API call.
async function callAnthropicLive(
  systemPrompt: string,
  userMessage: string,
): Promise<{ action: 'long' | 'flat' | 'hold' | 'error'; confidence: number | null }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [DECISION_TOOL],
      tool_choice: { type: 'tool', name: 'submit_decision' },
      thinking: { type: 'disabled' },
    }),
  });
  if (!res.ok) return { action: 'error', confidence: null };
  const body = (await res.json()) as {
    readonly content?: readonly {
      readonly type: string;
      readonly name?: string;
      readonly input?: unknown;
    }[];
  };
  const toolBlock = body.content?.find(
    (b) => b.type === 'tool_use' && b.name === 'submit_decision',
  );
  const parsed = liveDecisionSchema.safeParse(toolBlock?.input);
  if (!parsed.success) return { action: 'error', confidence: null };
  return { action: parsed.data.action, confidence: parsed.data.confidence };
}

function promptIdentityFor(playbookContent: string, playbookVersion: number): PromptIdentity {
  return {
    promptHash: computePromptHash({
      templateVersion: PROMPT_TEMPLATE_VERSION,
      playbookContent,
      toolSchemaJson: JSON.stringify(DECISION_TOOL),
      modelId: MODEL,
    }),
    playbookVersion,
    model: MODEL,
  };
}

describe.skipIf(SKIP)(
  'agentic eval — recorded input_payload live prompt-variant compare (optional, requires ANTHROPIC_API_KEY + EVAL_LIVE=1 + DATABASE_URL + db-test gate)',
  () => {
    it('replays recorded rows through champion vs candidate playbooks against the real API and prints a scorecard', async () => {
      const pool = new Pool({ connectionString: DB_URL! });
      try {
        const db = drizzle(pool, { schema });
        const journal = new AgentDecisionJournalAdapter(db);
        const rows = (await journal.recent(ROW_LIMIT)).filter((r) => r.inputPayload !== null);
        expect(rows.length).toBeGreaterThan(0);

        const systemPrompt = buildSystemPrompt(EVAL_PROFILE);
        const championIdentity = promptIdentityFor(SEED_PLAYBOOK.content, SEED_PLAYBOOK.version);
        const candidateIdentity = promptIdentityFor(
          CANDIDATE_PLAYBOOK_CONTENT,
          SEED_PLAYBOOK.version + 1,
        );

        const championRows: ScoringRow[] = [];
        const candidateRows: ScoringRow[] = [];
        for (const row of rows) {
          const payloadJson = row.inputPayload!;
          const championDecision = await callAnthropicLive(
            systemPrompt,
            composeRecordedUserMessage(payloadJson, SEED_PLAYBOOK.content),
          );
          const candidateDecision = await callAnthropicLive(
            systemPrompt,
            composeRecordedUserMessage(payloadJson, CANDIDATE_PLAYBOOK_CONTENT),
          );
          championRows.push(scoringRowFromPayload(payloadJson, championDecision, championIdentity));
          candidateRows.push(
            scoringRowFromPayload(payloadJson, candidateDecision, candidateIdentity),
          );
        }

        const [championCard] = scoreRows(championRows);
        const [candidateCard] = scoreRows(candidateRows);
        expect(championCard).toBeDefined();
        expect(candidateCard).toBeDefined();
        const result = compare(championCard!, candidateCard!, { assertSameTemplate: true });

        // The printed scorecard IS this script's deliverable.
        console.log(
          JSON.stringify(
            {
              rowsScored: rows.length,
              championHorizonStats: championCard!.horizonStats,
              candidateHorizonStats: candidateCard!.horizonStats,
              finalEquityDelta: result.finalEquityDelta,
              hitRateDeltas: result.hitRateDeltas,
            },
            null,
            2,
          ),
        );
      } finally {
        await pool.end();
      }
    }, 120_000);
  },
);
