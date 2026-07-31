#!/usr/bin/env node
// Inserts a model-eval scorecard (trade-model-eval spec's JSON output) into the append-only
// `experiments` registry table — one row per scorecard `candidates[]` entry.
//
// `node scripts/log-eval-experiment.mjs --scorecard <file> --family <name> ` +
// `--source <loop|reflection|human|study> --label <text>`
//
// Connection gate FAILS CLOSED: this script's entire purpose is the write, so a closed/ambiguous
// gate must refuse loudly rather than silently no-op (the inverse of test/backtest/experiment-log.ts's
// logTrials, which is a best-effort side channel and fails OPEN/silent by design — that asymmetry is
// intentional, not an inconsistency to reconcile). Reads REGISTRY_DATABASE_URL ONLY, never
// DATABASE_URL — the eval harness binds DATABASE_URL to a scratch corpus DB (candidate-model-eval.spec.ts),
// and a registry write must never be aimed at that scratch DB by accident.
//
// THE REGISTRY IS THE PRODUCTION `public.experiments` TABLE — not a test-only mirror. Three facts fix
// that, so the next reader does not re-derive the "should this have its own database?" question:
// (1) the table exists so the deflated-Sharpe multiple-testing count N is honest "across sessions
// rather than reset per-process" (src/database/schemas/trading/trading.schema.ts § experiments), which
// is precisely what a per-run or per-suite scratch DB cannot do; (2) it is hardened append-only
// alongside audit_log/order_events — REVOKE UPDATE/DELETE/TRUNCATE plus immutability triggers
// (drizzle/0001_v3_append_only_hardening.sql § experiments); (3) scripts/playbook-candidate.mjs
// already INSERTs into public.experiments over the plain DATABASE_URL with no registry gate at all.
// So writing production here is the DESIGNED behaviour. The gate below therefore exists to make the
// operator NAME that production target deliberately (REGISTRY_ALLOW_PRODUCTION_DB=1), not to keep the
// write away from production — a gate that could never open would make the mint unreachable forever.
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { Pool } from 'pg';

const VALID_SOURCES = ['loop', 'reflection', 'human', 'study'];

function usageError(message) {
  console.error(`log-eval-experiment: ${message}`);
  console.error(
    'usage: node scripts/log-eval-experiment.mjs --scorecard <file> --family <name> ' +
      '--source <loop|reflection|human|study> --label <text>',
  );
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    out[key] = argv[i + 1];
    i++;
  }
  return out;
}

// ── canonical hashing — mirrors test/backtest/experiment-log.ts hashing — keep in sync ──────────
function sortedKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedKeys);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = sortedKeys(value[k]);
  return out;
}

function sha256Hex(canonical) {
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function paramsHash(params) {
  return sha256Hex(JSON.stringify(sortedKeys(params)));
}

function datasetHash(key) {
  return sha256Hex(JSON.stringify(sortedKeys(key)));
}

// ── scorecard validation ──────────────────────────────────────────────────────────────────────
const REQUIRED_TOP_LEVEL = [
  'criteriaVersion',
  'corpusFingerprint',
  'window',
  'capabilities',
  'thinking',
  'maxTokens',
  'tokenPrices',
  'championReference',
  'candidates',
];
const REQUIRED_WINDOW = [
  'rowSince',
  'rowUntil',
  'firstEventTime',
  'lastEventTime',
  'rowsLoaded',
  'rowsReplayed',
];
const REQUIRED_CANDIDATE = [
  'model',
  'rowsReplayed',
  'schemaValidRate',
  'tradeSanityRate',
  'proposeCount',
  'proposeRate',
  'actionHistogram',
  'directionalForwardProxyBps',
  'costPerDecideUsd',
];

function missingKeys(obj, keys) {
  return keys.filter((k) => obj === undefined || obj === null || obj[k] === undefined);
}

function validateScorecard(scorecard) {
  const problems = [];
  const topMissing = missingKeys(scorecard, REQUIRED_TOP_LEVEL);
  if (topMissing.length > 0) problems.push(`missing top-level field(s): ${topMissing.join(', ')}`);
  const windowMissing = missingKeys(scorecard.window, REQUIRED_WINDOW);
  if (scorecard.window !== undefined && windowMissing.length > 0) {
    problems.push(`missing window field(s): ${windowMissing.join(', ')}`);
  }
  if (scorecard.candidates !== undefined) {
    if (!Array.isArray(scorecard.candidates)) {
      problems.push('candidates must be an array');
    } else {
      scorecard.candidates.forEach((candidate, i) => {
        const candidateMissing = missingKeys(candidate, REQUIRED_CANDIDATE);
        if (candidateMissing.length > 0) {
          problems.push(`candidates[${i}] missing field(s): ${candidateMissing.join(', ')}`);
        }
      });
    }
  }
  return problems;
}

// ── registry connection gate (fails CLOSED — see header) ─────────────────────────────────────
function dbNameEndsWithTest(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

// Opens ⟺ REGISTRY_DATABASE_URL is set AND the target is either a rehearsal database (`_test` suffix,
// so a local dry run needs no production opt-in) or one the operator named deliberately.
//
// DB_SUITE_ALLOW_RESET is deliberately NOT a third route. Its documented meaning is the OPPOSITE of
// this one: it exists so READ-ONLY suites can acknowledge a production DATABASE_URL, and "must never
// double as a license to reset one" (test/db/destructive-guard.ts § assertDestructiveTargetIsTestDb).
// Setting it in an app env to reach this write would also un-skip suites that INSERT into this very
// append-only table and take advisory locks against the live single-writer interlock. Keeping it here
// would re-create exactly the coupling this predicate exists to break.
function gateOpen(dbUrl) {
  if (!dbUrl) return false;
  return dbNameEndsWithTest(dbUrl) || process.env.REGISTRY_ALLOW_PRODUCTION_DB === '1';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const scorecardPath = args.scorecard;
  const family = args.family;
  const source = args.source;
  const label = args.label;
  const missingArgs = [];
  if (!scorecardPath) missingArgs.push('--scorecard');
  if (!family) missingArgs.push('--family');
  if (!source) missingArgs.push('--source');
  if (!label) missingArgs.push('--label');
  if (missingArgs.length > 0) {
    usageError(`missing required arg(s): ${missingArgs.join(', ')}`);
    return;
  }
  if (!VALID_SOURCES.includes(source)) {
    usageError(`--source must be one of ${VALID_SOURCES.join('/')}, got "${source}"`);
    return;
  }

  const registryUrl = process.env.REGISTRY_DATABASE_URL;
  if (!gateOpen(registryUrl)) {
    console.error(
      'log-eval-experiment: refusing to write — REGISTRY_DATABASE_URL is unset, or its database ' +
        'name does not end in "_test" and REGISTRY_ALLOW_PRODUCTION_DB is not "1". The registry IS ' +
        'the production public.experiments table, so a production target is expected here — set ' +
        'REGISTRY_ALLOW_PRODUCTION_DB=1 to name it deliberately. This gate fails CLOSED: this script ' +
        'only exists to write the registry, so an ambiguous target must abort loudly rather than ' +
        'silently skip or write to the wrong database.',
    );
    process.exitCode = 1;
    return;
  }

  let scorecardRaw;
  try {
    scorecardRaw = readFileSync(scorecardPath, 'utf8');
  } catch (err) {
    usageError(
      `could not read --scorecard ${scorecardPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  let scorecard;
  try {
    scorecard = JSON.parse(scorecardRaw);
  } catch (err) {
    usageError(
      `--scorecard ${scorecardPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const problems = validateScorecard(scorecard);
  if (problems.length > 0) {
    console.error(`log-eval-experiment: scorecard ${scorecardPath} failed validation:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const rows = scorecard.candidates.map((candidate) => ({
    family,
    paramsHash: paramsHash({
      model: candidate.model,
      // From the scorecard when present (registry provenance from data, not a hardcoded literal —
      // an append-only registry row is permanent, so a wrong hardcoded value never self-corrects);
      // 'v3' stays the fallback for scorecards produced before this field existed.
      templateVersion: scorecard.templateVersion ?? 'v3',
      tool: 'submit_trade',
      thinking: scorecard.thinking,
      maxTokens: scorecard.maxTokens,
      capabilities: scorecard.capabilities,
      criteriaVersion: scorecard.criteriaVersion,
      tokenPrices: scorecard.tokenPrices[candidate.model] ?? null,
    }),
    datasetHash: datasetHash({
      source: 'agent_decisions.input_payload',
      provenance: scorecard.corpusSource ?? 'v2-volume-clone-jsonl-dump',
      rowsLoaded: scorecard.window.rowsLoaded,
      rowsReplayed: scorecard.window.rowsReplayed,
      firstTs: scorecard.window.firstEventTime,
      lastTs: scorecard.window.lastEventTime,
    }),
    source,
    label: `${label}-${candidate.model}`,
    metrics: {
      ...candidate,
      corpusFingerprint: scorecard.corpusFingerprint,
      championReference: scorecard.championReference,
      window: scorecard.window,
      // How many rows had ALREADY been scored against this corpus when this decision was taken.
      // Carried into the row itself rather than left derivable, because the registry only grows: a
      // count re-derived later answers a different question than the one the decision faced. `null`
      // when the producing pass did not count — never coerced to 0, which would be a false claim.
      priorAttemptsOnCorpus: scorecard.priorAttemptsOnCorpus ?? null,
      priorAttemptsKey: scorecard.priorAttemptsKey ?? null,
      priorAttemptsOnCorpusFingerprint: scorecard.priorAttemptsOnCorpusFingerprint ?? null,
    },
  }));

  const pool = new Pool({ connectionString: registryUrl });
  try {
    const valuesSql = [];
    const params = [];
    let i = 1;
    for (const r of rows) {
      valuesSql.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(
        r.family,
        r.paramsHash,
        r.datasetHash,
        r.source,
        r.label,
        JSON.stringify(r.metrics),
      );
    }
    // INSERT only — never UPDATE/DELETE (append-only table, DB triggers enforce it). RETURNING
    // stands in for the "SELECT back" confirmation without a second round trip.
    const result = await pool.query(
      `INSERT INTO experiments (family, params_hash, dataset_hash, source, label, metrics)
       VALUES ${valuesSql.join(', ')}
       RETURNING id, family, label`,
      params,
    );
    for (const row of result.rows) {
      console.log(`inserted id=${row.id} family=${row.family} label=${row.label}`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(
    `log-eval-experiment: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
