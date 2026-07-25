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
import { drizzle } from 'drizzle-orm/node-postgres';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentDecisionJournalAdapter } from '../../../src/database/repositories/strategy/agent-decision-journal.adapter';
import { PlaybookStoreAdapter } from '../../../src/database/repositories/strategy/playbook-store.adapter';
import * as schema from '../../../src/database/schemas/trading';
import {
  DECISION_TOOL,
  PROMPT_TEMPLATE_VERSION,
  buildSystemPrompt,
  computePromptHash,
} from '../../../src/features/strategy/agentic/agent-prompt';
import { SEED_PLAYBOOK } from '../../../src/features/strategy/agentic/agentic-strategy.module';
import {
  combineScorecards,
  compare,
  scoreRows,
  type ScoringRow,
} from '../../../src/features/strategy/agentic/counterfactual-scoring';
import { validatePlaybook } from '../../../src/features/strategy/agentic/playbook-validator';
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
// Wall-clock budget must scale with the row budget (each row is 2 sequential real API calls,
// ~3-5s each) — a fixed cap silently contradicts a raised AGENTIC_EVAL_ROW_LIMIT: the run dies on
// the vitest timeout AFTER the API spend. Default preserves the original 120s.
const TIMEOUT_MS = Number(process.env['AGENTIC_EVAL_TIMEOUT_MS'] ?? '120000');
// N2.4: loop-side override — swap the fixed CANDIDATE_PLAYBOOK_CONTENT tweak below for a real
// loop-minted candidate file (scripts/playbook-candidate.mjs's own input, or its DB row's content
// re-exported to a file) so this eval can score an ACTUAL candidate before it's promoted. Absent,
// this file's behavior is byte-identical to before N2.4.
const CANDIDATE_PLAYBOOK_FILE = process.env['AGENTIC_CANDIDATE_PLAYBOOK_FILE'];

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
  'Fee arithmetic, quantified: a round trip costs ~20bps; your',
  'Fee arithmetic, quantified: a round trip costs ~25bps; your',
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
    it(
      'replays recorded rows through champion vs candidate playbooks against the real API and prints a scorecard',
      async () => {
        // Fail fast on an invalid loop-minted candidate BEFORE any real API spend below — the same
        // structural gate the runtime read-path (ValidatingPlaybookProvider) applies.
        let candidatePlaybookContent = CANDIDATE_PLAYBOOK_CONTENT;
        if (CANDIDATE_PLAYBOOK_FILE) {
          const fileContent = readFileSync(CANDIDATE_PLAYBOOK_FILE, 'utf8');
          const validation = validatePlaybook(fileContent);
          if (!validation.ok) {
            throw new Error(
              `AGENTIC_CANDIDATE_PLAYBOOK_FILE=${CANDIDATE_PLAYBOOK_FILE} failed validation: ${validation.reason}`,
            );
          }
          candidatePlaybookContent = fileContent;
        }

        const pool = new Pool({ connectionString: DB_URL! });
        try {
          const db = drizzle(pool, { schema });
          const journal = new AgentDecisionJournalAdapter(db);
          const rows = (await journal.recent(ROW_LIMIT)).filter((r) => r.inputPayload !== null);
          expect(rows.length).toBeGreaterThan(0);

          // Champion resolution: when a loop-minted candidate file is supplied, resolve the CHAMPION
          // from the DB's actual active version (same pin > promotion > seed precedence the running
          // process uses — PlaybookStoreAdapter.resolve()) rather than assuming SEED, so the candidate
          // is scored against what's really active. Absent AGENTIC_CANDIDATE_PLAYBOOK_FILE, this stays
          // SEED_PLAYBOOK exactly as before (byte-identical default behavior).
          let championContent = SEED_PLAYBOOK.content;
          let championVersion = SEED_PLAYBOOK.version;
          if (CANDIDATE_PLAYBOOK_FILE) {
            const pinEnv = process.env['AGENTIC_PLAYBOOK_PIN'];
            const store = new PlaybookStoreAdapter(
              db,
              SEED_PLAYBOOK,
              pinEnv ? Number(pinEnv) : undefined,
            );
            const resolved = await store.current(); // SEED fallback when the DB has none (ensureSeed)
            championContent = resolved.content;
            championVersion = resolved.version;
          }

          const systemPrompt = buildSystemPrompt(EVAL_PROFILE);
          const championIdentity = promptIdentityFor(championContent, championVersion);
          const candidateIdentity = promptIdentityFor(
            candidatePlaybookContent,
            championVersion + 1,
          );

          const championRows: ScoringRow[] = [];
          const candidateRows: ScoringRow[] = [];
          let skippedRows = 0;
          for (const row of rows) {
            const payloadJson = row.inputPayload!;
            // Screen the payload BEFORE spending two live calls on it — a malformed/residue row
            // (no usable eventTime) costs one skipped row, never an aborted run or wasted spend.
            const screen = scoringRowFromPayload(
              payloadJson,
              { action: 'hold', confidence: 0 },
              championIdentity,
            );
            if (screen === null) {
              skippedRows += 1;
              continue;
            }
            const championDecision = await callAnthropicLive(
              systemPrompt,
              composeRecordedUserMessage(payloadJson, championContent),
            );
            const candidateDecision = await callAnthropicLive(
              systemPrompt,
              composeRecordedUserMessage(payloadJson, candidatePlaybookContent),
            );
            championRows.push(
              scoringRowFromPayload(payloadJson, championDecision, championIdentity)!,
            );
            candidateRows.push(
              scoringRowFromPayload(payloadJson, candidateDecision, candidateIdentity)!,
            );
          }
          expect(championRows.length).toBeGreaterThan(0);

          // scoreRows() yields one card per (version, hash, SYMBOL) — recorded rows span the whole
          // 5-symbol universe, so each variant gets per-symbol cards that combineScorecards()
          // aggregates into the one-card-per-side shape compare() judges. Before symbol-aware
          // grouping, this scored cross-symbol close transitions (BTC→LINK) as forward returns.
          const championCard = combineScorecards(scoreRows(championRows));
          const candidateCard = combineScorecards(scoreRows(candidateRows));
          const result = compare(championCard, candidateCard, { assertSameTemplate: true });

          // The scorecard IS this script's deliverable. Console alone is NOT durable — vitest's
          // reporter can intercept/suppress console output (2026-07-10: two paid scoring runs lost
          // their scorecards exactly this way) — so when AGENTIC_EVAL_SCORECARD_FILE is set the
          // scorecard is ALSO written there verbatim.
          const scorecard = JSON.stringify(
            {
              rowsScored: championRows.length,
              rowsSkipped: skippedRows,
              model: MODEL,
              symbols: championCard.symbol,
              championVersion,
              championHorizonStats: championCard.horizonStats,
              candidateHorizonStats: candidateCard.horizonStats,
              championToyEquity: championCard.toyEquity,
              candidateToyEquity: candidateCard.toyEquity,
              finalEquityDelta: result.finalEquityDelta,
              hitRateDeltas: result.hitRateDeltas,
            },
            null,
            2,
          );
          console.log(scorecard);
          const scorecardFile = process.env['AGENTIC_EVAL_SCORECARD_FILE'];
          if (scorecardFile) {
            writeFileSync(scorecardFile, scorecard);
          }
        } finally {
          await pool.end();
        }
      },
      TIMEOUT_MS,
    );
  },
);
