#!/usr/bin/env node
// READ-ONLY one-shot dump of the offline eval corpus: every agent_decisions row that carries a
// recorded LLM input_payload, serialized as JSONL on stdout — so the eval harness
// (test/eval/agentic/) can replay recorded consult payloads without a live scratch DB.
//
// Usage: DATABASE_URL=postgres://... node scripts/dump-eval-corpus.mjs > test/eval/agentic/data/corpus-<name>.jsonl
//
// Provenance: the 2026-07 corpus was dumped from a read-only clone of the retired v2
// `crypto-bot_postgres_data` volume (never the live production DB).
//
// Failure direction: this is a read-only tool that gates nothing downstream — it fails LOUD and
// CLOSED (nonzero exit, no partial stdout claimed complete) on any connection or query error,
// rather than emitting a truncated corpus silently.
//
// Column projection mirrors AgentDecisionJournalAdapter.recent()'s row mapping exactly
// (src/database/repositories/agent-decision-journal.adapter.ts's toRow/readPlanJson) — raw SQL +
// hand-mirrored mapping, not an import, matching this repo's existing DB-script convention
// (scripts/resolve-stale-orders.mjs, scripts/playbook-promote.mjs never import repositories either).

import pg from 'pg';
import { pathToFileURL } from 'node:url';

const { Pool } = pg;

const SELECT_COLUMNS = [
  'id',
  'strategy_id',
  'symbol',
  'venue',
  'trigger_kind',
  'based_on_seq',
  'event_time',
  'model',
  'action',
  'confidence',
  'rationale',
  'ref_price',
  'close',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'latency_ms',
  'playbook_version',
  'prompt_hash',
  'input_payload',
  'plan_json',
  'consult_id',
  'created_at',
].join(', ');

function log(msg) {
  console.error(`dump-eval-corpus: ${msg}`);
}

// Mirrors agent-decision-journal.adapter.ts's readPlanJson: a schedule/regime-only plan_json
// (no stopLossPct) is not a directive plan and reads back as null; regimeTags is retrieval
// metadata stripped from a real directive plan before it reaches a consumer.
export function readPlanJson(planJson) {
  if (planJson == null || !('stopLossPct' in planJson)) return null;
  if (!('regimeTags' in planJson)) return planJson;
  const { regimeTags: _regimeTags, ...directives } = planJson;
  return directives;
}

// One raw pg row -> one AgentDecisionRow-shaped JSONL line. id/basedOnSeq are bigint columns pg
// already returns as strings (precision-safe); event_time is the same bigint shape but the
// adapter's EpochMs is a number, so it gets an explicit Number() coercion here. numeric(38,18)
// columns (ref_price/close) pass through as the raw pg string untouched — CLAUDE.md rule 1.
export function mapRow(row) {
  return {
    id: String(row.id),
    strategyId: row.strategy_id,
    symbol: row.symbol,
    venue: row.venue,
    triggerKind: row.trigger_kind,
    basedOnSeq: String(row.based_on_seq),
    eventTime: Number(row.event_time),
    model: row.model,
    action: row.action,
    confidence: row.confidence,
    rationale: row.rationale,
    refPrice: row.ref_price,
    close: row.close,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    latencyMs: row.latency_ms,
    playbookVersion: row.playbook_version,
    promptHash: row.prompt_hash,
    inputPayload: row.input_payload,
    plan: readPlanJson(row.plan_json),
    consultId: row.consult_id,
    createdAt: row.created_at.getTime(),
  };
}

export async function main(poolFactory = (url) => new Pool({ connectionString: url })) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log('DATABASE_URL is required (no default — this script refuses to guess a corpus source)');
    return 1;
  }

  const pool = poolFactory(databaseUrl);
  try {
    let host = '(unparseable)';
    try {
      host = new URL(databaseUrl).host;
    } catch {
      // diagnostic only — an unparseable URL still fails loud below via the actual connect attempt
    }
    log(`connecting to ${host} ...`);

    const { rows } = await pool.query(
      `SELECT ${SELECT_COLUMNS}
         FROM public.agent_decisions
        WHERE input_payload IS NOT NULL
        ORDER BY event_time ASC`,
    );
    log(`dumping ${rows.length} row(s) to stdout as JSONL`);

    for (const row of rows) {
      process.stdout.write(JSON.stringify(mapRow(row)) + '\n');
    }
    return 0;
  } finally {
    await pool.end();
  }
}

// Only auto-run when executed directly — importing this module must never open a DB connection.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
