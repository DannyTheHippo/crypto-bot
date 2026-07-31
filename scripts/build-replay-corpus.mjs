#!/usr/bin/env node
// READ-ONLY one-shot dump of the offline PLAYBOOK-SPACE REPLAY corpus consumed by
// test/eval/agentic/playbook-space-replay.ts's loadCorpus() — every agent_decisions row that is a
// REAL model decide (prompt_hash <> '' AND latency_ms IS NOT NULL AND strategy_id NOT LIKE
// 'replay-%') recorded while the account was FLAT (input_payload's position.side === 'FLAT'),
// serialized as JSONL on stdout.
//
// Usage: DATABASE_URL=postgres://... node scripts/build-replay-corpus.mjs > \
//          test/eval/agentic/data/corpus-<name>-flat.jsonl
//
// Sibling of scripts/dump-eval-corpus.mjs (that script dumps EVERY input_payload row, camelCase,
// for the trade-model-eval.spec.ts / candidate-model-eval.spec.ts head-to-head lane). This script
// exists because playbook-space-replay.ts's loadCorpus() reads a DIFFERENT, narrower row shape
// (snake_case, `event_time`/`input_payload`, matching the raw agent_decisions column names — see
// that module's RawCorpusRow) that the checked-in corpus-v3-flat.jsonl already used; this mirrors
// it rather than re-deriving a shape.
//
// The FLAT filter and JSON key order are done SERVER-SIDE via row_to_json() over an explicit column
// list — never JS-side Number()/parseFloat() on the numeric(38,18) ref_price/close columns (CLAUDE.md
// rule 1). Postgres's own to_json() renders bigint/numeric as bare JSON numbers, byte-matching the
// existing corpus-v3-flat.jsonl's column order and number formatting exactly.
//
// The "-flat" name is a semantic, not decoration: the published playbook-space-replay scorecards
// were run against FLAT-only rows, and their comparability depends on every corpus sharing that
// filter. A corpus that widens the FLAT predicate is a DIFFERENT population and must ship under a
// different name with its own stated rationale — never silently swapped in under an existing name.
//
// Failure direction: read-only tool that gates nothing downstream — fails LOUD and CLOSED (nonzero
// exit, no partial stdout claimed complete) on any connection or query error, rather than emitting a
// truncated corpus silently.

import pg from 'pg';
import { pathToFileURL } from 'node:url';

const { Pool } = pg;

// Column order matches the existing test/eval/agentic/data/corpus-v3-flat.jsonl exactly, so a
// consumer diffing the two files sees only new rows, never a reshuffled schema.
const ROW_TO_JSON_QUERY = `
  SELECT row_to_json(t)::text AS line
  FROM (
    SELECT
      id,
      strategy_id,
      symbol,
      venue,
      trigger_kind,
      based_on_seq,
      event_time,
      model,
      action,
      confidence,
      rationale,
      ref_price,
      close,
      playbook_version,
      prompt_hash,
      input_payload,
      plan_json,
      consult_id
    FROM public.agent_decisions
    WHERE input_payload IS NOT NULL
      AND prompt_hash <> ''
      AND latency_ms IS NOT NULL
      AND strategy_id NOT LIKE 'replay-%'
      AND (input_payload::jsonb #>> '{position,side}') = 'FLAT'
    ORDER BY event_time ASC
  ) t
`;

function log(msg) {
  console.error(`build-replay-corpus: ${msg}`);
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

    const { rows } = await pool.query(ROW_TO_JSON_QUERY);
    log(`dumping ${rows.length} FLAT real-decide row(s) to stdout as JSONL`);

    for (const row of rows) {
      process.stdout.write(row.line + '\n');
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
