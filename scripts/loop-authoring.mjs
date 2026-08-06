#!/usr/bin/env node
// Loop-side playbook AUTHORING pass —
// `pnpm loop:authoring --dry-run` / `pnpm loop:authoring --out research/candidates/authoring-<date>`.
//
// Seven stages: read the whole history, draft a candidate, validate it offline against the real
// validator, SCORE it through the replay engine that produced NO_SURVIVOR, gate it on the DEPLOYMENT
// bar (reporting the research bar beside it, never merged), log EVERY scored variant to the
// append-only experiments registry, and only then mint. All decision logic lives in
// loop-authoring-core.mjs (unit-tested on the production gate); this file is the IO shell.
//
// HONEST FRAMING, carried here because a reader of the output deserves it before the numbers.
// `NO_SURVIVOR` settled that PROSE DOES NOT MOVE THE ENTRY SIGN: the `minimal` arm carried no
// guidance at all and scored within a bar of `champion_v8`. So this pass is a LOW-PRIOR BET. It is
// justified by COST (a subscription-funded loop at ~zero marginal cost, against the $5.01 the deleted
// in-process reflection lane charged) and by INFORMATION (the whole database, against the newest 200
// journal rows of one strategy that reflection saw) — NOT by an expectation that better prose flips
// the sign. The measurement gate in stage 5 is the only thing that keeps that bet honest.
//
// WHAT IT NEVER DOES: no stage writes anything under --dry-run, the drafting call is the ONLY paid
// call the shell itself makes, and the mint is delegated to `pnpm playbook:candidate` rather than
// re-implemented — that script owns the unresolved-candidate gate, the byte-identical refusal and
// the append-only INSERT, and a second implementation of any of them would be a second thing to keep
// correct.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import pg from 'pg';
import {
  mapUniqueViolation,
  readVersionEntryStats,
  resolveActiveVersion,
} from './lib/playbook-shared.mjs';
import { deriveValidationOpts } from './playbook-candidate-core.mjs';
import {
  AUTHORING_ATTEMPT_FAMILY,
  assertNoRetiredObjective,
  buildEvidenceDigest,
  buildScorecard,
  classifyEntryRateFloor,
  classifyMintGate,
  classifyRegistrySplitBrain,
  classifySameDayGate,
  corpusAttemptKey,
  describeRunTruncation,
  parseArgs,
  parsePlaybookInfoVersion,
  primaryHorizonDeltaBps,
  renderTwoBars,
  resolveIncumbent,
  stripRetiredGuidance,
} from './loop-authoring-core.mjs';

const { Pool } = pg;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const LOG = 'loop:authoring';
const GUIDANCE_FILE = join(REPO_ROOT, 'research', 'loop', 'playbook-authoring.md');
const SCORE_SPEC = 'test/eval/agentic/loop-authoring-score.spec.ts';
// Dust threshold for the round-trip walk. Mirrors the promotion path's own posture: a residue below
// this closes the cycle rather than leaving it open forever on a rounding remainder.
const DUST_NOTIONAL = new Decimal('1');

function fail(message) {
  console.error(`${LOG}: ${message}`);
  process.exitCode = 1;
}

// Repo-relative when the path IS inside the repo, absolute otherwise. `relative()` alone renders a
// $TMPDIR artifact as a nine-level `../../..` chain that nobody can paste into a shell.
function displayPath(file) {
  const rel = relative(REPO_ROOT, file);
  return rel.startsWith('..') ? file : rel;
}

// Refuses stale/missing dist rather than silently validating against an out-of-date copy of a source
// file — this script has no build step of its own. Identical posture to playbook-candidate.mjs's own
// loadValidatePlaybook, which is why the check lives in one helper here.
function loadFromDist(...segments) {
  const distPath = join(REPO_ROOT, 'dist', ...segments) + '.js';
  const srcPath = join(REPO_ROOT, 'src', ...segments) + '.ts';
  if (!existsSync(distPath)) {
    fail(`${relative(REPO_ROOT, distPath)} not found — run pnpm build first.`);
    return null;
  }
  if (existsSync(srcPath) && statSync(srcPath).mtimeMs > statSync(distPath).mtimeMs) {
    fail(`${relative(REPO_ROOT, distPath)} is older than its source — run pnpm build first.`);
    return null;
  }
  return createRequire(import.meta.url)(distPath);
}

// ── stage 1: the whole history ───────────────────────────────────────────────────────────────────

/**
 * The journal, filtered to decisions the MODEL itself authored. TWO filters, and neither alone is
 * enough — this is the whole reason the digest is worth more than what reflection saw.
 *
 *  1. **`model LIKE 'claude%'`**, the same real-LLM predicate
 *     AgentDecisionJournalPort.versionEntryStats uses. Without it the table is 25,507 `prescreen`
 *     rows and 1,064 `plan-executor` rows against 1,422 real decides (measured 2026-07-30) — 95% of
 *     the journal is machinery. Reflection read the newest 200 rows unfiltered, which is why its
 *     evidence was "mostly prescreen noise"; a digest that repeated the mistake at 27,993 rows would
 *     repeat it larger.
 *  2. **`isModelAuthoredDecision`** (domain/strategy/types/decide-rationale.ts, loaded from dist),
 *     which is not reproducible by a SQL rationale filter written here: it excludes the 'error'
 *     action, the six degrade tags AND the three pre-call short-circuit tags ('client_latched:',
 *     'off_menu:', 'budget_exhausted:'). The last three carry `action: 'hold'`, so leaving them in
 *     inflates the hold bucket with consults that never reached a model.
 *
 * Both exclusion counts are reported rather than dropped silently — the share of consults that never
 * reached the model is itself evidence about the lane (the 60-hour unfunded outage is exactly this
 * shape).
 */
async function readDecisionSummary(pool, isModelAuthoredDecision) {
  const { rows: allRows } = await pool.query(
    'SELECT count(*)::int AS n FROM public.agent_decisions',
  );
  const { rows } = await pool.query(
    `SELECT action, rationale, symbol, event_time::bigint AS event_time
       FROM public.agent_decisions
      WHERE model LIKE 'claude%'
      ORDER BY event_time ASC`,
  );
  const authored = rows.filter((r) => isModelAuthoredDecision(r.action, r.rationale ?? undefined));
  const actionHistogram = {};
  for (const r of authored) actionHistogram[r.action] = (actionHistogram[r.action] ?? 0) + 1;
  return {
    total: authored.length,
    excludedNonModel: (allRows[0]?.n ?? 0) - rows.length,
    excluded: rows.length - authored.length,
    symbols: new Set(authored.map((r) => r.symbol)).size,
    firstEventTime: Number(authored[0]?.event_time ?? 0),
    lastEventTime: Number(authored[authored.length - 1]?.event_time ?? 0),
    actionHistogram,
  };
}

/**
 * The hold lengths the RUNNING playbook's own plans actually ask for, as {h, n} pairs.
 *
 * Read rather than assumed because the horizon set the study measured (1/4/8/24) and the set the
 * model plans at are DIFFERENT sets — v10's `plan_json.maxHoldBars` reads 48 and 40, never 24
 * (measured 2026-07-30). Feeding both into the per-horizon table is what makes the unmeasured rows
 * appear as UNMEASURED instead of simply being absent.
 *
 * Same `model LIKE 'claude%'` predicate as readDecisionSummary: a prescreen row carries no plan the
 * drafting model authored. The `~ '^[0-9]+$'` guard keeps a malformed plan out of the cast rather
 * than failing the whole query on one bad row.
 */
async function readPlannedHorizons(pool, version) {
  const { rows } = await pool.query(
    `SELECT (plan_json->>'maxHoldBars')::int AS h, count(*)::int AS n
       FROM public.agent_decisions
      WHERE playbook_version = $1
        AND model LIKE 'claude%'
        AND plan_json->>'maxHoldBars' ~ '^[0-9]+$'
      GROUP BY 1
      ORDER BY 1`,
    [version],
  );
  return rows.map((r) => ({ h: Number(r.h), n: Number(r.n) }));
}

/**
 * Closed round trips, walked by the PRODUCTION walker loaded from dist — never a second FIFO
 * implementation in this script. `walkRoundTrips` is what the promotion evaluator itself walks, so a
 * divergent count here would be a bug in the evidence, not a second opinion.
 *
 * Returns null (an explicit "no data" in the digest) rather than a number when the fills table spans
 * more than one trading mode and the ambiguity cannot be resolved from TRADING_MODE — mixing modes
 * would interleave two books into one position walk.
 */
async function readRoundTrips(pool, walkRoundTrips) {
  const { rows: modeRows } = await pool.query(
    'SELECT mode, count(*)::int AS n FROM public.fills GROUP BY mode ORDER BY n DESC',
  );
  if (modeRows.length === 0) return null;
  const declared = process.env.TRADING_MODE;
  const mode =
    modeRows.length === 1 ? modeRows[0].mode : modeRows.find((r) => r.mode === declared)?.mode;
  if (mode === undefined) {
    console.warn(
      `${LOG}: fills span ${modeRows.length} modes (${modeRows.map((r) => r.mode).join(', ')}) and ` +
        'TRADING_MODE names none of them — skipping the round-trip walk rather than interleaving books.',
    );
    return null;
  }
  const { rows } = await pool.query(
    `SELECT oi.strategy_id, f.symbol, oi.side,
            f.qty::text AS qty, f.price::text AS price,
            f.fee_amount::text AS fee, f.fee_ccy AS fee_asset,
            f.venue_timestamp::bigint AS executed_at, oi.ref_price::text AS ref_price
       FROM public.fills f
       LEFT JOIN public.order_intents oi ON oi.intent_id = f.intent_id
      WHERE f.mode = $1
      ORDER BY f.venue_timestamp ASC, f.fill_id ASC`,
    [mode],
  );
  const walk = walkRoundTrips(
    rows.map((r) => ({
      strategyId: r.strategy_id,
      symbol: r.symbol,
      side: r.side,
      qty: r.qty,
      price: r.price,
      fee: r.fee,
      feeAsset: r.fee_asset,
      executedAt: Number(r.executed_at),
      refPrice: r.ref_price,
    })),
    DUST_NOTIONAL,
  );
  const cycles = walk.cycles;
  if (cycles.length === 0) return { mode, count: 0 };
  const gross = cycles.reduce((s, c) => s.plus(c.realizedPnl), new Decimal(0));
  const fees = cycles.reduce((s, c) => s.plus(c.feesQuote), new Decimal(0));
  const net = gross.minus(fees);
  return {
    mode,
    count: cycles.length,
    symbols: new Set(cycles.map((c) => c.symbol)).size,
    winners: cycles.filter((c) => c.realizedPnl.minus(c.feesQuote).greaterThan(0)).length,
    grossPnlQuote: gross.toFixed(6),
    feesQuote: fees.toFixed(6),
    netPnlQuote: net.toFixed(6),
    meanNetPerTripQuote: net.dividedBy(cycles.length).toFixed(6),
    unconvertibleFeeAsset: walk.unconvertibleFeeAsset,
  };
}

/**
 * The `agentic_playbook_info` gauge, scraped from the running app. Fails OPEN to null — see
 * loop-authoring-core.mjs's header; the caller falls back to the DB precedence mirror, never to a
 * literal version.
 */
async function readGaugeVersion(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parsePlaybookInfoVersion(await res.text());
  } catch (err) {
    console.warn(
      `${LOG}: could not scrape ${url} (${err instanceof Error ? err.message : String(err)}) — ` +
        'falling back to the DB precedence mirror, which applies the same rule the gauge is stamped from.',
    );
    return null;
  }
}

// ── the once-per-UTC-day ceiling ─────────────────────────────────────────────────────────────────

/**
 * The DB's own clock and the day's blocking attempt row, in ONE round trip and over ONE connection.
 *
 * One statement rather than two because a boundary and a row read against two different clocks is the
 * defect this gate exists to rule out: `now()` is stable within a statement, so `now_ms` and the
 * `created_at >= …` predicate below cannot disagree. `date_trunc('day', now() AT TIME ZONE 'UTC')`
 * yields the naive UTC wall clock, and the trailing `AT TIME ZONE 'UTC'` casts it back to a
 * timestamptz so it compares against `created_at` (timestamptz) without a silent local-zone shift.
 *
 * The LEFT JOIN onto a one-row source is what makes "no attempt today" a ROW with null columns rather
 * than an empty result: the clock must come back either way, because the refusal message names the
 * instant the next slot opens.
 *
 * ORDER BY created_at ASC picks the FIRST attempt of the day — the one that actually took the slot.
 *
 * Errors are RETURNED, never thrown: an unreachable registry is a verdict this gate must classify
 * (CLOSED), not an exception that would skip the gate entirely.
 */
async function readSameDayAttempt(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT (extract(epoch FROM now()) * 1000)::bigint AS now_ms,
              e.id::text AS id,
              (extract(epoch FROM e.created_at) * 1000)::bigint AS created_at_ms,
              to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM (SELECT 1) AS clock_row
         LEFT JOIN public.experiments e
                ON e.family = $1
               AND e.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        ORDER BY e.created_at ASC
        LIMIT 1`,
      [AUTHORING_ATTEMPT_FAMILY],
    );
    const row = rows[0];
    return {
      nowMsFromDb: Number(row?.now_ms),
      blockingRow:
        row?.id === null || row?.id === undefined
          ? null
          : { id: row.id, createdAt: row.created_at, createdAtMs: Number(row.created_at_ms) },
      registryError: null,
    };
  } catch (err) {
    return {
      nowMsFromDb: null,
      blockingRow: null,
      registryError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Takes the day's slot by INSERTing the attempt row — BEFORE the drafting call, so the ceiling bounds
 * spend rather than describing it afterwards.
 *
 * `params_hash` and `dataset_hash` are NOT NULL on this table and this row is a MARKER, not a trial.
 * They are therefore filled with canonical descriptions of what the row is, never borrowed from a
 * scored run: a marker carrying a trial's hashes would be indistinguishable from a scored row under
 * `experiments_family_params_dataset_idx`, and this table is append-only, so that confusion would be
 * permanent. The day key is hashed into `params_hash` so two rows claiming the same day are visibly
 * the same claim.
 *
 * There is no unique index to lean on (adding one to an append-only money-adjacent table is
 * report-only work), so the last-writer-wins race between two simultaneous passes is handled by the
 * pass lease in scripts/loop-pass-lock.mjs rather than here. Returns the new row's id, or null when
 * the write failed — a slot that could not be claimed refuses the pass, since an unclaimed slot
 * bounds nothing.
 */
async function claimTodaysSlot(
  pool,
  { utcDay, nowMsFromDb, nextSlotIso, incumbentVersion, model },
) {
  const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  try {
    const { rows } = await pool.query(
      `INSERT INTO public.experiments (family, params_hash, dataset_hash, source, label, metrics)
       VALUES ($1, $2, $3, 'loop', $4, $5)
       RETURNING id::text AS id`,
      [
        AUTHORING_ATTEMPT_FAMILY,
        sha256({ family: AUTHORING_ATTEMPT_FAMILY, utcDay, incumbentVersion, model }),
        sha256({ dataset: null, note: 'day-slot marker — this row measures nothing' }),
        `authoring-attempt-${utcDay}`,
        JSON.stringify({
          kind: 'authoring-attempt-slot',
          utcDay,
          claimedAtMsFromDb: nowMsFromDb,
          nextSlotIso,
          incumbentVersion,
          model,
          note:
            'Marker for the once-per-UTC-day authoring ceiling, written BEFORE the drafting call. It ' +
            'records an ATTEMPT, not a result: the scored variants land under family=' +
            '"playbook-authoring" at stage 6, and their absence next to this row means the pass ' +
            'refused or failed after claiming the day.',
        }),
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error(
      `${LOG}: could not claim today's slot — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── stage 2: the drafting prompt ─────────────────────────────────────────────────────────────────

function buildDraftingPrompt(guidanceText, digest, incumbent) {
  return [
    'You are drafting a replacement crypto trading playbook for a live agentic lane.',
    '',
    'STANDING OBJECTIVE, which supersedes anything in the preserved guidance below that implies an',
    'entry-rate target. It is QUALIFIED PER HORIZON, and the qualification is the whole instruction —',
    'an unqualified "minimise entries" would cut the only cells that clear the cost floor:',
    '',
    '  * At a horizon whose MEASURED net-per-trip is NEGATIVE: reduce the entry rate. Abstention is a',
    '    permitted terminal state there and a flat week is a CORRECT week.',
    '  * At a horizon whose MEASURED net-per-trip is NOT negative: HOLD the rate. Do not cut it, and do',
    '    not raise it either — a mean above the floor whose interval is not is not a licence to trade',
    '    more.',
    '  * At a horizon with NO measurement: it is UNVALIDATED, not favourable. Reason about it as',
    '    unknown risk. Do not treat the absence of a measured loss as evidence of a gain.',
    '',
    'Net-per-trip is gross forward return MINUS the break-even cost floor, which is +13.0 bps/trip at',
    'demo fees and +24.2 bps/trip live (research/loop/verdicts.md). It is NOT a flat 20 bps, and a',
    'gross mean must clear the floor of the lane it actually runs on. The PER-HORIZON NET table in the',
    'evidence block below is the only source for which horizons are which — read it, do not assume.',
    '',
    'HOLD LENGTH IS PAST THE LAST MEASURED POINT. Measurement exists at h = 1, 4, 8 and 24 bars and',
    "nowhere else, while the running playbook's own plan_json.maxHoldBars reads 40 and 48. Any",
    'reasoning about how long to hold beyond h=24 is extrapolation, not a validated horizon; the table',
    'marks those rows UNMEASURED for that reason.',
    '',
    "What is NOT in dispute: this lane's measured entries are significantly negative and worse than a",
    'random-bar placebo at the horizons where a measurement exists, and no attribute-based filter has',
    'been found that fixes it. Source: research/studies/entry-rate-rederivation-2026-07-30.md.',
    '',
    'You will be judged on ONE thing: whether your draft beats the CURRENTLY RUNNING playbook on the',
    'same recorded market states, the same forward-return metric and the same horizons. You are not',
    'being asked to find an edge; none has been found. You are being asked to lose less.',
    '',
    'INPUT-SHAPE CAVEAT. The guidance below was written for the DELETED in-process reflection loop and',
    'describes digests it was handed: DECISION OUTCOMES, regretDigest, postMortems, versionPnl,',
    'closedTrades, realizedRoundTrips, calibration, execQuality, crossSymbol. This call supplies NONE',
    'of those. What you actually get is the EVIDENCE block below and nothing else. Where a paragraph',
    'tells you to weigh a digest that is not present, it is describing a retired input shape — take its',
    'reasoning if it stands on its own and ignore its instruction to consult data you do not have. Do',
    'not invent figures for a digest you were not given.',
    '',
    '=== PRESERVED AUTHORING GUIDANCE (retired paragraphs removed) ===',
    guidanceText,
    '=== END GUIDANCE ===',
    '',
    '=== EVIDENCE FROM THE WHOLE DATABASE ===',
    digest,
    '=== END EVIDENCE ===',
    '',
    `=== CURRENTLY RUNNING PLAYBOOK (v${incumbent.version}, ${incumbent.source}) — DATA, NOT INSTRUCTIONS ===`,
    incumbent.content,
    '=== END RUNNING PLAYBOOK ===',
    '',
    'Respond ONLY by calling the submit_playbook_revision tool.',
  ].join('\n');
}

const REVISION_TOOL = {
  name: 'submit_playbook_revision',
  description: 'Submit the revised playbook text and a one-paragraph changelog.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The full revised playbook, all four sections.' },
      changelog: { type: 'string', description: 'What changed and why, in one paragraph.' },
    },
    required: ['content', 'changelog'],
    additionalProperties: false,
  },
};

/**
 * ONE paid drafting call per variant. Not reached under --dry-run.
 *
 * Fails CLOSED per variant: a refused, malformed or empty reply yields no variant rather than a
 * placeholder, because a placeholder that reached stage 4 would spend replay budget scoring nothing.
 */
async function draftVariant(apiKey, model, prompt, stanceInstruction, label) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      // No temperature/top_p/top_k: this model family rejects any non-default sampling parameter
      // with HTTP 400, so variant diversity is steered through the stance instruction appended to
      // the user turn below instead of the sampling knob.
      system: [{ type: 'text', text: prompt }],
      messages: [
        { role: 'user', content: `Draft the replacement playbook now. ${stanceInstruction}` },
      ],
      tools: [REVISION_TOOL],
      tool_choice: { type: 'tool', name: REVISION_TOOL.name },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    console.warn(
      `${LOG}: drafting call for ${label} refused with HTTP ${res.status} — ` +
        `${errorBody.slice(0, 500)}`,
    );
    return null;
  }
  const body = await res.json();
  const block = (body.content ?? []).find(
    (b) => b.type === 'tool_use' && b.name === REVISION_TOOL.name,
  );
  const content = block?.input?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    console.warn(`${LOG}: drafting call for ${label} returned no usable content — no variant.`);
    return null;
  }
  return { name: label, content, changelog: block.input.changelog ?? '' };
}

/**
 * Deterministic stand-ins for the drafting call, used ONLY under --dry-run.
 *
 * They are edits of the incumbent's own text, so they stay structurally valid and clearly synthetic:
 * nobody can mistake a dry-run variant for a drafted one, and the pass still exercises a real
 * multi-variant comparison including a loser.
 */
function syntheticVariants(incumbent) {
  const suffixes = [
    '\nDo not enter to fill a quiet session; a flat book costs nothing and pays no spread.',
    '\nWhen two readings of the same structure disagree, stand aside rather than sizing down.',
  ];
  return suffixes.map((suffix, i) => ({
    name: `dryrun_variant_${i + 1}`,
    content: `${incumbent.content}${suffix}`,
    changelog: 'DRY RUN — a deterministic edit of the running playbook, not a drafted candidate.',
  }));
}

// ── stage 6: the experiments registry ────────────────────────────────────────────────────────────

/**
 * How many registry rows have ALREADY been scored against this corpus, before this pass adds its own.
 *
 * FAILS OPEN, and the direction is not negotiable: this is a measurement, and a measurement that
 * cannot be taken must never block the thing it measures. A query error, a missing table or an
 * underivable key all return `null`, which every consumer renders as "NOT COUNTED" — never as zero.
 * Zero is a claim; "not counted" is the truth in that case, and the difference is the whole point of
 * a counter whose absence was the original defect.
 *
 * Both counts are taken: the identity key (see `corpusAttemptKey` for why it is the key) and the
 * payload fingerprint. The second is carried purely so the drift between them stays visible on every
 * pass rather than being rediscovered.
 */
async function readPriorAttemptsOnCorpus(pool, corpus) {
  const key = corpusAttemptKey(corpus);
  if (key === null) return null;
  try {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (
           WHERE metrics->'window'->>'rowsLoaded' = $1
             AND metrics->'window'->>'rowSince'   = $2
             AND metrics->'window'->>'rowUntil'   = $3
         )::int AS by_identity,
         count(*) FILTER (WHERE metrics->>'corpusFingerprint' = $4)::int AS by_fingerprint
       FROM public.experiments`,
      [
        String(key.rowsLoaded),
        String(key.rowSince),
        String(key.rowUntil),
        String(corpus.payloadSha256 ?? ''),
      ],
    );
    return {
      key,
      count: rows[0]?.by_identity ?? 0,
      byFingerprint: rows[0]?.by_fingerprint ?? 0,
    };
  } catch (err) {
    console.warn(
      `${LOG}: could not count prior attempts on this corpus — ` +
        `${err instanceof Error ? err.message : String(err)}. Reported as NOT COUNTED (fails OPEN: ` +
        'a broken measurement must never block the thing it measures).',
    );
    return null;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    fail(parsed.error);
    console.error(
      'usage: node scripts/loop-authoring.mjs [--dry-run] [--out <dir>] [--rows <n>] ' +
        '[--cap-usd <usd>] [--model <id>] [--draft-file <path>] [--label <text>]',
    );
    return;
  }
  const { dryRun, rows: rowsArg, capUsd, model: modelArg, draftFile, label } = parsed;
  const model = modelArg ?? process.env.AGENTIC_MODEL ?? 'claude-sonnet-5';

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail('DATABASE_URL is required — this pass reads the real journal, no default.');
    return;
  }

  // SPLIT-BRAIN GUARD, before the first paid drafting call so a misconfigured pass refuses cheaply
  // rather than after spending on two drafts. This pass READS the same-day gate and the attempt
  // counter over the DATABASE_URL pool below, while stage 6 WRITES every scored variant over
  // log-eval-experiment.mjs's REGISTRY_DATABASE_URL; if those diverge the gate reads a table nobody
  // writes and the counter under-reports forever — a silent failure that looks like success, because
  // every stage still prints OK. Fails CLOSED. Rationale and the parsed-not-string comparison:
  // classifyRegistrySplitBrain in loop-authoring-core.mjs.
  const splitBrain = classifyRegistrySplitBrain({
    databaseUrl,
    registryUrl: process.env.REGISTRY_DATABASE_URL,
  });
  if (!splitBrain.ok) {
    fail(splitBrain.reason);
    return;
  }

  const outDir = parsed.outDir ?? mkdtempSync(join(tmpdir(), 'loop-authoring-'));
  mkdirSync(outDir, { recursive: true });

  const validatorModule = loadFromDist('features', 'strategy', 'agentic', 'playbook-validator');
  if (validatorModule === null) return;
  const roundTripModule = loadFromDist('domain', 'trading', 'risk', 'round-trips');
  if (roundTripModule === null) return;
  const rationaleModule = loadFromDist('domain', 'strategy', 'types', 'decide-rationale');
  if (rationaleModule === null) return;
  const { validatePlaybook } = validatorModule;

  console.log(`\n${LOG}${dryRun ? ' (DRY RUN — nothing is written, no paid call is made)' : ''}`);
  console.log(`out: ${outDir}\n`);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // ── stage 1 ────────────────────────────────────────────────────────────────────────────────
    console.log('stage 1 — read the full history');
    const { rows: playbookRows } = await pool.query(
      'SELECT version, content, source, parent_version, created_at FROM public.agent_playbook_versions ORDER BY version',
    );
    const gaugeVersion = await readGaugeVersion(
      process.env.AGENTIC_METRICS_URL ?? 'http://localhost:3100/metrics',
    );
    const dbVersion = resolveActiveVersion(playbookRows, process.env.AGENTIC_PLAYBOOK_PIN);
    const incumbent = resolveIncumbent({ rows: playbookRows, gaugeVersion, dbVersion });
    if (!incumbent.ok) {
      fail(incumbent.reason);
      return;
    }
    console.log(
      `  incumbent: v${incumbent.version} (${incumbent.source}) via ${incumbent.resolvedFrom}` +
        ` — gauge ${gaugeVersion === null ? 'unavailable' : `v${gaugeVersion}`}, DB mirror v${dbVersion}`,
    );
    if (incumbent.divergence !== null) console.warn(`  DIVERGENCE: ${incumbent.divergence}`);

    const decisions = await readDecisionSummary(pool, rationaleModule.isModelAuthoredDecision);
    const versionStats = [];
    for (const row of playbookRows) {
      const stats = await readVersionEntryStats(pool, row.version, LOG);
      if (stats !== undefined) {
        versionStats.push({ version: row.version, source: row.source, ...stats });
      }
    }
    const roundTrips = await readRoundTrips(pool, roundTripModule.walkRoundTrips);
    const plannedHorizons = await readPlannedHorizons(pool, incumbent.version);
    const digest = buildEvidenceDigest({
      decisions,
      versionStats,
      roundTrips,
      incumbent,
      plannedHorizons,
    });
    console.log(
      `  ${decisions.total} model-authored decides (${decisions.excludedNonModel} non-LLM rows and ` +
        `${decisions.excluded} degraded/pre-call rows excluded), ${versionStats.length} versions with ` +
        `stats, ${roundTrips?.count ?? 0} closed round trips (${roundTrips?.mode ?? 'no fills'})`,
    );
    console.log(
      `  planned hold lengths under v${incumbent.version}: ` +
        (plannedHorizons.length === 0
          ? 'none recorded'
          : plannedHorizons.map((p) => `h=${p.h} x${p.n}`).join(', ')),
    );

    // Derived here rather than at stage 3 because the DRAFTING prompt needs it too: telling the model
    // to write for a lane the validator will then reject is a guaranteed wasted call.
    const { opts: validationOpts, derivedFrom } = deriveValidationOpts(process.env.VENUES);

    // ── stage 2 ────────────────────────────────────────────────────────────────────────────────
    console.log('\nstage 2 — draft candidates from the preserved (de-retired) guidance');
    const guidance = stripRetiredGuidance(readFileSync(GUIDANCE_FILE, 'utf8'), {
      shortsAllowed: validationOpts.shortsAllowed,
    });
    // Two assertions, not one: the stripped guidance AND the assembled prompt. The second would catch
    // the retired text arriving by any other route — the digest, the incumbent's own content, a
    // future prompt edit — and it is the only one that covers what the model actually receives.
    assertNoRetiredObjective(guidance.text, 'stripped authoring guidance');
    const prompt = buildDraftingPrompt(guidance.text, digest, incumbent);
    assertNoRetiredObjective(prompt, 'assembled drafting prompt');
    const promptFile = join(outDir, 'drafting-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf8');
    console.log(
      `  ${guidance.lane} lane, ${guidance.blocksRemoved} fenced retired block(s) + ` +
        `${guidance.substanceParagraphsRemoved} retired-in-substance paragraph(s) stripped; ` +
        `prompt ${prompt.length} chars → ${promptFile}`,
    );
    console.log('  ANTI-RATCHET assertion: PASSED (guidance and assembled prompt both clean)');

    // ── the once-per-UTC-day ceiling ───────────────────────────────────────────────────────────
    // PLACEMENT IS THE SUBTLE PART, in both directions.
    //
    // AFTER every cheap precondition — stale dist, an unreachable DB, an unresolvable incumbent, the
    // retired-objective assertion, the split-brain guard — so that an environmental failure does not
    // burn the day's only slot. A pass that dies on a missing build has spent nothing and must be
    // able to run again in the same day.
    //
    // BEFORE the first paid drafting call, because bounding spend is the whole point. Gating on the
    // SCORED rows instead would be too late: stage 4's replay is the expensive part and runs before
    // stage 6 logs anything, so a scored-row gate would permit two full replays in a day.
    //
    // --draft-file lands on the refusing side of that line deliberately: it skips the drafting call
    // and still spends the full stage-4 replay budget. --dry-run is the only exemption.
    //
    // The API-key check is HOISTED above the gate for the same reason the gate sits after the dist
    // check: a run that cannot make its drafting call at all must not consume the day. Both LLM
    // accounts were unfunded as recently as 2026-07-29, so this is a live failure mode, not a
    // hypothetical one.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!dryRun && draftFile === undefined && !apiKey) {
      fail('ANTHROPIC_API_KEY is required for a real drafting call (use --dry-run otherwise).');
      return;
    }
    // Same reasoning for the supplied draft: an unreadable --draft-file is an environmental failure,
    // and it would otherwise surface only after the slot had been claimed.
    if (draftFile !== undefined && !existsSync(draftFile)) {
      fail(`--draft-file ${draftFile} does not exist — nothing to score.`);
      return;
    }
    const attempt = await readSameDayAttempt(pool);
    const sameDay = classifySameDayGate({
      blockingRow: attempt.blockingRow,
      nowMsFromDb: attempt.nowMsFromDb,
      dryRun,
      registryError: attempt.registryError,
    });
    console.log(`  ONCE-PER-UTC-DAY: ${sameDay.verdict}`);
    console.log(`  ${sameDay.reason}`);
    if (!sameDay.proceed) {
      if (sameDay.verdict === 'SLOT_SPENT') {
        // Not an error exit: refusing the second run of a UTC day is this gate working, not failing —
        // the same posture as a mint refusal on a measured bar.
        console.log(`\n${LOG}: no run today (slot spent). Artifacts in ${outDir}`);
        return;
      }
      // An unreadable registry IS an environmental failure, so it exits non-zero — unlike a spent
      // slot, it is a condition someone must fix rather than a normal day's outcome.
      fail(sameDay.reason);
      return;
    }
    if (!sameDay.exempt) {
      const claimedId = await claimTodaysSlot(pool, {
        utcDay: sameDay.utcDay,
        nowMsFromDb: attempt.nowMsFromDb,
        nextSlotIso: sameDay.nextSlotIso,
        incumbentVersion: incumbent.version,
        model,
      });
      if (claimedId === null) {
        fail(
          "could not claim today's authoring slot in public.experiments — refusing to draft. An " +
            'unclaimed slot bounds nothing, so proceeding would leave the once-per-UTC-day ceiling ' +
            'unenforced for the rest of the day.',
        );
        return;
      }
      console.log(
        `  claimed ${sameDay.utcDay}: public.experiments id=${claimedId} ` +
          `(family=${AUTHORING_ATTEMPT_FAMILY}) — next slot ${sameDay.nextSlotIso}`,
      );
    }

    let variants;
    if (draftFile !== undefined) {
      variants = [
        {
          name: label ?? 'supplied_draft',
          content: readFileSync(draftFile, 'utf8'),
          changelog: `supplied via --draft-file ${draftFile}`,
        },
      ];
      console.log(`  using the supplied draft at ${draftFile} — no drafting call made`);
    } else if (dryRun) {
      variants = syntheticVariants(incumbent);
      console.log(`  DRY RUN: ${variants.length} deterministic stand-in variants, no paid call`);
    } else {
      // The key's presence was checked BEFORE the day gate — a run that could never draft must not
      // consume the day's slot on its way to failing.
      const drafted = [];
      // Two stances, not two temperatures (the model rejects the parameter — see draftVariant):
      // one conservative pass and one exploratory pass, both steered by prompt instruction alone.
      const stances = [
        {
          label: 'draft_conservative',
          instruction:
            'Draft a CONSERVATIVE revision: change as little as possible from the incumbent, ' +
            'only what the evidence directly supports.',
        },
        {
          label: 'draft_exploratory',
          instruction:
            'Draft an EXPLORATORY revision: where the evidence permits, consider a materially ' +
            'different approach rather than a minimal edit.',
        },
      ];
      for (const { label: stanceLabel, instruction } of stances) {
        const v = await draftVariant(apiKey, model, prompt, instruction, stanceLabel);
        if (v !== null) drafted.push(v);
      }
      variants = drafted;
      console.log(`  drafted ${variants.length} variant(s) at model ${model}`);
    }
    if (variants.length === 0) {
      fail('no variants to score — refusing to proceed with an empty comparison.');
      return;
    }

    // ── stage 3 ────────────────────────────────────────────────────────────────────────────────
    console.log('\nstage 3 — validate offline against the real validatePlaybook');
    console.log(
      `  capabilities: shortsAllowed=${validationOpts.shortsAllowed} ` +
        `leverageAllowed=${validationOpts.leverageAllowed} (from ${derivedFrom})`,
    );
    const valid = [];
    for (const v of variants) {
      const result = validatePlaybook(v.content, validationOpts);
      if (result.ok) {
        valid.push(v);
        console.log(`  ${v.name}: OK (${v.content.length} chars)`);
      } else {
        console.warn(
          `  ${v.name}: REJECTED — ${result.reason}` +
            (result.bannedToken ? ` (bannedToken=${result.bannedToken})` : ''),
        );
      }
    }
    if (valid.length === 0) {
      fail('every variant failed the live structural validator — nothing reachable to score.');
      return;
    }

    // ── stage 4 ────────────────────────────────────────────────────────────────────────────────
    console.log('\nstage 4 — score through the playbook-space replay engine');
    const variantsFile = join(outDir, 'variants.json');
    writeFileSync(
      variantsFile,
      JSON.stringify(
        {
          incumbent: { name: `incumbent_v${incumbent.version}`, content: incumbent.content },
          candidates: valid.map((v) => ({ name: v.name, content: v.content })),
        },
        null,
        2,
      ),
      'utf8',
    );
    const scoreFile = join(outDir, 'score.json');
    const env = {
      ...process.env,
      PLAYBOOK_SPACE: '1',
      LOOP_AUTHORING_SCORE: '1',
      LOOP_AUTHORING_DRY_RUN: dryRun ? '1' : '0',
      LOOP_AUTHORING_VARIANTS_FILE: variantsFile,
      LOOP_AUTHORING_OUT: scoreFile,
      LOOP_AUTHORING_MODEL: model,
    };
    if (rowsArg !== undefined) env.LOOP_AUTHORING_ROWS = String(rowsArg);
    if (capUsd !== undefined) env.LOOP_AUTHORING_CAP_USD = capUsd;
    // The local vitest CLI via the current Node binary (PATH-independent) — same spawn shape as
    // replay-agentic.mjs, for the same reason: the engine is TS under test/ with no dist output.
    const require = createRequire(import.meta.url);
    const vitestPkgPath = require.resolve('vitest/package.json');
    const vitestEntry = join(
      dirname(vitestPkgPath),
      JSON.parse(readFileSync(vitestPkgPath, 'utf8')).bin.vitest,
    );
    const spawned = spawnSync(process.execPath, [vitestEntry, 'run', SCORE_SPEC], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    });
    const scoringExitOk = spawned.error === undefined && spawned.status === 0;
    if (spawned.error) console.error(`  failed to spawn vitest: ${spawned.error.message}`);
    let score;
    if (existsSync(scoreFile)) score = JSON.parse(readFileSync(scoreFile, 'utf8'));
    if (score === undefined) {
      fail('the scoring run produced no results file — nothing measured, nothing to gate on.');
      return;
    }

    // Read BEFORE stage 6 writes this pass's own rows, so the number is "attempts that PRECEDED this
    // decision" rather than a count that includes it.
    const priorAttemptsOnCorpus = await readPriorAttemptsOnCorpus(pool, score.corpus);

    // Computed ONCE, here, and reused at stage 5 (the comparison table's truncation banner), stage 7
    // (the incumbent entry-rate line) and stage 7's gate call — a run that aborted or failed to exit
    // cleanly must render identically wherever its numbers are printed. Same shape classifyMintGate's
    // own `run` argument takes (2026-08-04: previously only stage 7's gate call saw this; stage 5's
    // table and stage 7's entry-rate line printed the run's numbers as if unqualified).
    const scoringRun = scoringExitOk ? score : { ...score, voided: true };

    // ── stage 5 ────────────────────────────────────────────────────────────────────────────────
    console.log('\nstage 5 — the two bars, side by side (they are NEVER the same bar)');
    // 2026-08-06 (Pass 65): this loop threw and cost the run EVERYTHING it had paid for. The run
    // aborted on its $5 spend cap mid-replay, so every perHorizon cell was legitimately null;
    // renderTwoBars then called .toFixed on one and threw out of main(). Stage 6 never ran, so a
    // completed 348-call / $5.0015 / 630s scoring run logged ZERO rows to public.experiments and the
    // day's single authoring slot was consumed for nothing. renderTwoBars is now total (proven by
    // mutation in loop-authoring-core.spec.mjs), but that makes THIS block's failure merely unlikely
    // rather than impossible — and the asymmetry is absolute: a lost console table is reprintable
    // from score.json, a lost registry row is not (append-only, and the slot does not reopen).
    // So printing is isolated from logging structurally, not just made correct today. Fails OPEN
    // toward LOGGING: a render defect degrades the operator's table, never the evidence.
    // NOTE: `shipping`/`winner` below stay OUTSIDE this guard on purpose — they are load-bearing for
    // stage 7's mint, not presentation, and must not be silently skipped by a rendering failure.
    try {
      for (const d of score.deployment) {
        console.log(
          renderTwoBars({
            arm: d.arm,
            deployment: d,
            research: score.research,
            priorAttemptsOnCorpus,
            run: scoringRun,
          }),
        );
        console.log('');
      }
    } catch (err) {
      console.log(
        `  *** STAGE 5 RENDER FAILED (continuing to stage 6 so the evidence is still logged): ` +
          `${err instanceof Error ? err.message : String(err)} — the scored numbers are intact in ` +
          `${join(outDir, 'score.json')} ***`,
      );
    }
    const shipping = score.deployment.filter((d) => d.ships === true);
    // Best of the shipping candidates at the declared primary horizon. Ranking among SHIPPERS only:
    // "ranking is not passing", so a ranking never promotes a candidate that failed the bar.
    // `shipping`/`winner` stay OUTSIDE the stage-5 try/catch above on purpose (load-bearing for stage
    // 7's mint) — so the lookup itself, not a wrapping try, must be the thing that cannot throw.
    // primaryHorizonDeltaBps applies the SAME Array.isArray + optional-chaining guard renderTwoBars
    // was just hardened with, on this same `perHorizon` field (see that function's own header).
    const winner = shipping
      .slice()
      .sort((a, b) => primaryHorizonDeltaBps(b) - primaryHorizonDeltaBps(a))[0];
    console.log(
      shipping.length === 0
        ? '  no candidate clears the deployment bar — the running playbook stays.'
        : `  deployment-bar winner: ${winner.arm} (${shipping.length} of ${score.deployment.length} clear the bar)`,
    );

    // ── stage 6 ────────────────────────────────────────────────────────────────────────────────
    console.log('\nstage 6 — log EVERY scored variant to public.experiments (winners AND losers)');
    const scorecards = score.arms.map((report) => ({
      report,
      file: join(outDir, `scorecard-${report.arm}.json`),
      // scoringRun, not score: the run-status wrapper is what carries VOID/ABORTED/unfaithful-caps, and
      // every OTHER consumer of that state (stage 5's tables, stage 7's gate call) already receives it.
      // Passing the raw `score` here is exactly the wiring gap that logged id=18/19/20 with no
      // truncation marker at all — see buildScorecard's own header in loop-authoring-core.mjs.
      card: buildScorecard(score, report, priorAttemptsOnCorpus, scoringRun),
    }));
    for (const s of scorecards) writeFileSync(s.file, JSON.stringify(s.card, null, 2), 'utf8');
    let experimentsLogged = false;
    if (dryRun) {
      console.log(`  DRY RUN: ${scorecards.length} scorecard(s) written, none inserted:`);
      for (const s of scorecards) {
        console.log(
          `    pnpm loop:experiment --scorecard ${displayPath(s.file)} ` +
            `--family playbook-authoring --source loop --label ${label ?? 'authoring'}-${s.report.arm}`,
        );
      }
    } else {
      let allOk = true;
      for (const s of scorecards) {
        const res = spawnSync(
          process.execPath,
          [
            join(SCRIPT_DIR, 'log-eval-experiment.mjs'),
            '--scorecard',
            s.file,
            '--family',
            'playbook-authoring',
            '--source',
            'loop',
            '--label',
            `${label ?? 'authoring'}-${s.report.arm}`,
          ],
          { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' },
        );
        if (res.status !== 0) allOk = false;
      }
      experimentsLogged = allOk;
      console.log(
        allOk
          ? `  logged ${scorecards.length} variant(s)`
          : '  at least one variant failed to log — the mint gate treats that as a blocker.',
      );
    }

    // ── stage 7 ────────────────────────────────────────────────────────────────────────────────
    console.log('\nstage 7 — entry-rate floor, then the mint gate');
    const winnerReport = winner ? score.arms.find((a) => a.arm === winner.arm) : undefined;
    const floor = winnerReport
      ? classifyEntryRateFloor({
          rowsParsed: winnerReport.rowsParsed,
          entries: winnerReport.entries,
        })
      : undefined;
    if (floor) console.log(`  entry-rate floor: ${floor.pass ? 'PASS' : 'VETO'} — ${floor.reason}`);
    const incumbentReport = score.arms.find((a) => a.role === 'incumbent');
    if (incumbentReport) {
      // Measured here rather than quoted from a constant: the deleted floor's own feedback text
      // asserted "champion enters ~28% of such consults" against a live rate of 16.1%. "(measured this
      // run)" is only true when the run that produced this number is itself usable — a truncated or
      // void run's rate is exactly as unquotable as any other number it produced (2026-08-04: this
      // line and stage 5's table used to be the only two places a reader saw an ABORTED run's figures
      // with no qualifier at all).
      const runTruncation = describeRunTruncation(scoringRun);
      console.log(
        `  incumbent ${incumbentReport.arm} entered ${incumbentReport.entries}/${incumbentReport.rowsParsed} ` +
          `= ${(incumbentReport.entryRate * 100).toFixed(1)}% on the same rows ` +
          (runTruncation.length === 0
            ? '(measured this run)'
            : `(TRUNCATED / VOID — MAY NOT BE QUOTED: ${runTruncation.join('; ')})`),
      );
    }

    const gate = classifyMintGate({
      deployment: winner,
      deploymentComparisons: score.deployment,
      research: score.research,
      floor,
      run: scoringRun,
      experimentsLogged,
      priorAttemptsOnCorpus,
    });
    console.log(`\n  MINT GATE: ${gate.mint ? 'PROCEED' : 'REFUSED'}`);
    console.log(`  ${gate.reason}`);
    if (dryRun && !gate.mint) {
      console.log(
        '  (DRY RUN: the experiments-logging blocker above is EXPECTED — a dry run writes nothing, ' +
          'so it cannot log, and an unlogged mint is exactly the selection effect this gate forbids.)',
      );
    }

    if (!gate.mint) {
      // Not an error exit: a refusal on a measured bar is this pass working, not failing.
      console.log(`\n${LOG}: no mint. Artifacts in ${outDir}`);
      return;
    }
    const winnerVariant = valid.find((v) => v.name === winner.arm);
    const candidateFile = join(outDir, `candidate-${winner.arm}.md`);
    writeFileSync(candidateFile, winnerVariant.content, 'utf8');
    const scorecardFile = scorecards.find((s) => s.report.arm === winner.arm).file;
    const mint = spawnSync(
      process.execPath,
      [join(SCRIPT_DIR, 'playbook-candidate.mjs'), candidateFile, '--metrics', scorecardFile],
      { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' },
    );
    if (mint.status !== 0) {
      fail(
        'playbook:candidate refused the mint — its own gates are the final word, not this pass.',
      );
      return;
    }
    console.log(`\n${LOG}: minted ${winner.arm}. Artifacts in ${outDir}`);
  } catch (err) {
    const mapped = mapUniqueViolation(err, LOG);
    if (mapped) {
      fail(mapped);
      return;
    }
    throw err;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  // Stack included, not just the message: a pg driver error can carry an EMPTY message, and a pass
  // that reports `unexpected error: ` with nothing after it is undiagnosable from its own output.
  fail(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});
