#!/usr/bin/env node
// PER-TRIP LLM COST ATTRIBUTION — the I/O shell. Gathers six reads through scripts/loop-transport.mjs
// (five psql folds + two promtool gauges) and hands them to the pure core (loop-llm-attrib-core.mjs),
// which owns every judgement. This file makes no decision about the data beyond "did the read
// succeed" and one thing only it can decide: the STRUCTURAL classification of NULL-token rows, which
// depends on the journal's row shape rather than on any cost rule (see UNPRICEABLE_SQL).
//
// FAILURE DIRECTION — MEASUREMENT, FAILS OPEN. Annotations only; no alarms, no gate, no exit code
// that could stop a pass. `main()` exits non-zero only if the TOOL ITSELF crashes, never because the
// measurement came out unfavourable. Nothing in the sweep imports this: it is an on-demand read
// (`pnpm loop:llm-attrib`), deliberately not merged into loop-sweep.mjs, because the sweep's output
// feeds the watermark and a watermark carrying a cost attribution is nonsense (same argument
// loop-forward-return.mjs:17-19 makes for itself).
//
// THE WINDOW MUST MATCH THE GATE'S, EXACTLY, or the cross-check is meaningless. Every fold below
// therefore reproduces PromotionStatsRepository.tokenTotals (promotion-stats.repository.ts:100-192)
// clause for clause:
//   * `agent_decisions` filtered on `created_at >= epoch` — NOT `event_time`. event_time is a BIGINT
//     epoch-millisecond column (trading.schema.ts:381) and the bar-open instant, stale by up to a bar
//     by construction; created_at is the DB wall clock and is what the gate filters on. Comparing a
//     timestamptz literal against event_time ERRORS rather than coercing, so the mistake is loud —
//     but the quiet version (filtering the right column with the wrong semantics) is why this is
//     spelled out rather than assumed.
//   * `strategy_id not like 'replay-%'` on the decide side — R1 synthetic backfills bill the same
//     account but must never enter the EVIDENCE fold (promotion-stats.repository.ts:106-109).
//   * `llm_usage` restricted to `kind = 'reflection'`, with NO replay filter, because the replay
//     engine writes no llm_usage rows at all. That table has had no live writer since 9a63edf, so its
//     half of the cost is frozen history — read for completeness, never expected to grow.
// The gate folds both tables into ONE per-model bucket; this shell keeps (model, source) separate so
// the frozen half is visible. The core's costOf is linear and exact, so the totals still agree.
//
// TRIP DENOMINATOR — READ, NEVER RE-DERIVED. `walkRoundTrips` (src/domain/trading/risk/round-trips.ts)
// is the single source of the closed-round-trip count, and this shell takes that number from the
// gate's own `agentic_promotion_round_trips` gauge rather than walking fills a second time. Two walks
// would be two truths, and the whole value of the cross-check below is that both sides divide the
// same book by the same denominator. If the gauge is unreadable the per-trip figures VOID BY NAME.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { psql, promQuery } from './loop-transport.mjs';
import {
  TRADE_ACTIONS,
  computeLlmAttribution,
  renderLlmAttribution,
} from './loop-llm-attrib-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

/** How many of the newest priced rows the cost-curve tail carries. The gauge samples every 5 minutes
 *  (promotion-metrics.service.ts:79) and the lane prices a few rows per bar, so 500 covers days of
 *  lag — but the core reports LAG_UNRESOLVED rather than agreement if the cut is not inside it. */
const TAIL_ROWS = 500;

/** SQL list literal for the trade-causing actions, built from the CORE's array so the two cannot
 *  drift. A quoted action name never contains a quote, so no escaping is involved. */
const TRADE_ACTION_SQL = TRADE_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * The evidence epoch, resolved the same way the app resolves it: PROMOTION_EVIDENCE_EPOCH is a full
 * ISO-8601 UTC instant (environment.config.ts:526-534). Absent ⇒ all-time, which is exactly the
 * gate's own `sinceMs === undefined` branch — not an error, and not a silently different window.
 */
export function resolveEpochMs(env = process.env) {
  const raw = env['PROMOTION_EVIDENCE_EPOCH'];
  if (raw === undefined || raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The rate table, in the core's shape, off the process env — the SAME knobs
 * PromotionReadinessConfig is built from, so the two folds cannot price the same tokens differently.
 * Returns null when the flat defaults are absent: unpriceable, and the core voids on it rather than
 * rendering $0 (run through `--env-file-if-exists=.env.app`, as the package.json entry does).
 */
export function resolveRateTable(env = process.env) {
  const i = env['AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK'];
  const o = env['AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK'];
  if (i === undefined || o === undefined) return null;
  let models;
  const raw = env['AGENTIC_TOKEN_PRICES_JSON'];
  if (raw !== undefined && raw !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') models = parsed;
    } catch {
      // A malformed map is NOT silently dropped to "no map": with no map an unknown model would
      // price at the flat defaults instead of the most-expensive configured rate, which is the
      // fail-OPEN direction this instrument refuses. Returning null voids the whole reading by name.
      return null;
    }
  }
  return {
    defaults: {
      inputPerMtok: i,
      outputPerMtok: o,
      cacheReadPerMtok: env['AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK'] ?? '0',
      cacheWritePerMtok: env['AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK'] ?? '0',
    },
    models,
  };
}

/** `created_at >= <epoch>` as SQL, or `true` for the all-time branch. to_timestamp(ms/1000.0) rather
 *  than a string literal so the millisecond value in this file is the same integer everywhere. */
function epochPred(epochMs, col = 'created_at') {
  return epochMs === null ? 'true' : `${col} >= to_timestamp(${epochMs}/1000.0)`;
}

const ISO = (col) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const TOKEN_COLS =
  'coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),' +
  ' coalesce(sum(cache_read_input_tokens),0), coalesce(sum(cache_creation_input_tokens),0)';

export function decideTotalsSql(epochMs) {
  return (
    `select 'agent_decisions', model, count(*), ${TOKEN_COLS} from agent_decisions` +
    ` where ${epochPred(epochMs)} and strategy_id not like 'replay-%' group by model order by model`
  );
}

export function reflectionTotalsSql(epochMs) {
  return (
    `select 'llm_usage', model, count(*), ${TOKEN_COLS} from llm_usage` +
    ` where kind = 'reflection' and ${epochPred(epochMs)} group by model order by model`
  );
}

/**
 * NULL-token rows, classified STRUCTURALLY — the one judgement this shell owns, because it is a fact
 * about the journal's row shape rather than a cost rule.
 *
 * The naive reading ("a row that called the client and carries NULL tokens is unmeasured spend") is
 * WRONG for this schema, and getting it wrong would have printed a four-figure phantom cost tail.
 * Verified against the live journal 2026-08-04: one `consult_id` is ONE Anthropic call that fans out
 * to N per-symbol decision rows (fan-out equals distinct (symbol,venue) exactly, 1..8, across all 667
 * post-epoch consults) and EXACTLY ONE row per consult carries the token columns. So the 769
 * called-with-NULL-tokens rows are fan-out SIBLINGS of calls already priced above — counting them as
 * unmeasured spend would double-count the book.
 *
 * The four classes are mutually exclusive and cover every NULL-token row. Only two are BILLABLE, and
 * both are shapes that would mean the fan-out invariant had broken:
 *   consult_with_no_priced_row  — a consult fanned out but its token-bearing row is missing.
 *   client_called_no_consult_id — latency/prompt_hash say a call happened, but nothing ties it to a
 *                                 priced consult.
 * Both read 0 today. That is a MEASURED zero and the core says so by name; if either ever goes
 * positive, the book cost is a lower bound by that many calls.
 */
export function unpriceableSql(epochMs) {
  return (
    'with d as (select consult_id, latency_ms, prompt_hash, input_tokens,' +
    ' count(input_tokens) over (partition by consult_id) as priced_in_consult' +
    ` from agent_decisions where ${epochPred(epochMs)} and strategy_id not like 'replay-%')` +
    ' select klass, count(*) from (select case' +
    " when consult_id is not null and priced_in_consult > 0 then 'consult_sibling_of_priced_call'" +
    " when consult_id is not null then 'consult_with_no_priced_row'" +
    " when latency_ms is not null or prompt_hash <> '' then 'client_called_no_consult_id'" +
    " else 'no_client_call'" +
    ' end klass from d where input_tokens is null) s group by klass order by klass'
  );
}

export function reflectionUnpriceableSql(epochMs) {
  return (
    'select count(*) from llm_usage' +
    ` where kind = 'reflection' and ${epochPred(epochMs)} and input_tokens is null`
  );
}

/**
 * One row per consult: its fan-out, how many of those rows carried a trade action, and its token
 * sums (exactly one row per consult carries them, so SUM is the call's own usage).
 *
 * A consult spanning two models is impossible today (0 of 667) but is emitted as the synthetic name
 * `MIXED-MODEL-CONSULT` rather than silently taking one of them — an unmapped model name prices at
 * the most-expensive configured rate, which is the loud, over-counting direction.
 */
export function consultSql(epochMs) {
  return (
    'select consult_id,' +
    " case when count(distinct model) = 1 then min(model) else 'MIXED-MODEL-CONSULT' end," +
    ` count(*), count(*) filter (where action in (${TRADE_ACTION_SQL})), ${TOKEN_COLS}` +
    ` from agent_decisions where ${epochPred(epochMs)} and strategy_id not like 'replay-%'` +
    ' and consult_id is not null group by consult_id order by consult_id'
  );
}

/** The newest TAIL_ROWS priced rows across BOTH source tables, for the exact-at-cut cross-check. */
export function tailSql(epochMs) {
  const cols =
    'coalesce(input_tokens,0), coalesce(output_tokens,0),' +
    ' coalesce(cache_read_input_tokens,0), coalesce(cache_creation_input_tokens,0)';
  return (
    `select * from ((select ${ISO('created_at')} c, model, ${cols} from agent_decisions` +
    ` where ${epochPred(epochMs)} and strategy_id not like 'replay-%' and input_tokens is not null)` +
    ` union all (select ${ISO('created_at')} c, model, ${cols} from llm_usage` +
    ` where kind = 'reflection' and ${epochPred(epochMs)} and input_tokens is not null)) u` +
    ` order by c desc limit ${TAIL_ROWS}`
  );
}

/**
 * Traded notional over the SAME fill predicate PromotionStatsRepository.fillsForMode uses
 * (mode='testnet', venue_timestamp >= epoch — a BIGINT epoch-ms column, compared against the raw
 * number, never a timestamptz).
 */
export function notionalSql(epochMs) {
  const pred = epochMs === null ? 'true' : `venue_timestamp >= ${epochMs}`;
  return (
    "select count(*), coalesce(sum(price*qty),0)::text from fills where mode = 'testnet'" +
    ` and ${pred}`
  );
}

export function windowSql(epochMs) {
  return (
    `select ${ISO('min(created_at)')}, ${ISO('max(created_at)')}, ${ISO('now()')}` +
    ` from agent_decisions where ${epochPred(epochMs)} and strategy_id not like 'replay-%'`
  );
}

// psql -At emits pipe-separated rows. Empty stdout is ZERO ROWS (a determinate reading), which is why
// it returns [] here and only a transport failure returns null — the core treats the two differently
// and the whole point of this measurement is that it never confuses them.
function parseRows(res, arity) {
  if (!res || res.ok !== true || typeof res.value !== 'string') return null;
  const text = res.value.trim();
  if (text === '') return [];
  const rows = [];
  for (const line of text.split('\n')) {
    const parts = line.split('|');
    if (parts.length !== arity) return null;
    rows.push(parts);
  }
  return rows;
}

/**
 * `promtool query instant` prints `name{labels} => <value> @[<unix seconds>]`.
 *
 * Returns null on anything that is not EXACTLY one series: zero series is "the gauge is not
 * published" and several is an ambiguity no caller can resolve. Both void the figure by name in the
 * core rather than picking one.
 */
export function parseGauge(res) {
  if (!res || res.ok !== true || typeof res.value !== 'string') return null;
  const matches = [...res.value.matchAll(/=>\s*([-+0-9.eE]+)\s*@\[([0-9.]+)\]/g)];
  if (matches.length !== 1) return null;
  const [, value, at] = matches[0];
  const atMs = Number(at) * 1000;
  return {
    value,
    readAtIso: Number.isFinite(atMs)
      ? new Date(atMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
      : null,
  };
}

const tokens = (p, i) => ({
  inputTokens: Number(p[i]),
  outputTokens: Number(p[i + 1]),
  cacheReadTokens: Number(p[i + 2]),
  cacheCreationTokens: Number(p[i + 3]),
});

export function gatherLlmAttribution(opts = {}) {
  const cwd = opts.cwd ?? REPO_ROOT;
  const env = opts.env ?? process.env;
  const epochMs = opts.epochMs !== undefined ? opts.epochMs : resolveEpochMs(env);

  const decideRes = opts.decideRes ?? psql(decideTotalsSql(epochMs), { cwd });
  const reflectRes = opts.reflectRes ?? psql(reflectionTotalsSql(epochMs), { cwd });
  const unpricedRes = opts.unpricedRes ?? psql(unpriceableSql(epochMs), { cwd });
  const unpricedReflectRes =
    opts.unpricedReflectRes ?? psql(reflectionUnpriceableSql(epochMs), { cwd });
  const consultRes = opts.consultRes ?? psql(consultSql(epochMs), { cwd });
  const tailRes = opts.tailRes ?? psql(tailSql(epochMs), { cwd });
  const notionalRes = opts.notionalRes ?? psql(notionalSql(epochMs), { cwd });
  const windowRes = opts.windowRes ?? psql(windowSql(epochMs), { cwd });
  const costGauge = opts.costGauge ?? parseGauge(promQuery('agentic_promotion_llm_cost_usd'));
  const tripsGauge = opts.tripsGauge ?? parseGauge(promQuery('agentic_promotion_round_trips'));

  const decideParts = parseRows(decideRes, 7);
  const reflectParts = parseRows(reflectRes, 7);
  // Either half failing voids the whole fold: a book cost missing one of its two source tables is
  // not a smaller cost, it is a partial reading, and the core must never render it as the book.
  const modelTotals =
    decideParts === null || reflectParts === null
      ? null
      : [...decideParts, ...reflectParts].map((p) => ({
          source: p[0],
          model: p[1],
          rows: Number(p[2]),
          ...tokens(p, 3),
        }));

  const unpricedParts = parseRows(unpricedRes, 2);
  const unpricedReflectParts = parseRows(unpricedReflectRes, 1);
  const BILLABLE = {
    consult_sibling_of_priced_call: false,
    consult_with_no_priced_row: true,
    client_called_no_consult_id: true,
    no_client_call: false,
  };
  const DETAIL = {
    consult_sibling_of_priced_call:
      'fan-out rows of a consult whose ONE token-bearing row is already priced above — same ' +
      'Anthropic call, one row per (symbol,venue). Counting these would double-count the book',
    consult_with_no_priced_row:
      'a consult that fanned out but carries NO token-bearing row — a real call whose usage was ' +
      'never journaled, so its cost is missing from every figure above',
    client_called_no_consult_id:
      'latency_ms/prompt_hash say the client was called, but no consult_id ties the row to a priced ' +
      'call — unattributable spend',
    no_client_call:
      'never reached the client (no latency, empty prompt_hash) — prescreen/plan-executor rows and ' +
      'pre-call errors. Genuinely $0, by construction rather than by absence of data',
  };
  const unpriceable =
    unpricedParts === null || unpricedReflectParts === null
      ? null
      : [
          ...unpricedParts.map((p) => ({
            klass: p[0],
            rows: Number(p[1]),
            // An unrecognised class is charged as BILLABLE: a class this file does not know about is
            // a class whose cost it cannot vouch for, and the loud direction is to name it.
            billable: BILLABLE[p[0]] ?? true,
            detail:
              DETAIL[p[0]] ??
              'unrecognised class — charged as billable because it cannot be vouched for',
          })),
          {
            klass: 'reflection_null_tokens',
            rows: Number(unpricedReflectParts[0]?.[0] ?? 0),
            billable: true,
            detail:
              'llm_usage reflection rows with NULL token columns — a recorded call with no usage',
          },
        ];

  const consultParts = parseRows(consultRes, 8);
  const consultRows =
    consultParts === null
      ? null
      : consultParts.map((p) => ({
          consultId: p[0],
          model: p[1],
          fanout: Number(p[2]),
          tradeActionRows: Number(p[3]),
          ...tokens(p, 4),
        }));

  const tailParts = parseRows(tailRes, 6);
  // Reversed to ASCENDING: the core peels the NEWEST row first, which is the order the gauge's own
  // sample lag drops them in.
  const costCurveTail =
    tailParts === null
      ? null
      : tailParts.map((p) => ({ createdAtIso: p[0], model: p[1], ...tokens(p, 2) })).reverse();

  const notionalParts = parseRows(notionalRes, 2);
  const fills = notionalParts === null ? null : Number(notionalParts[0]?.[0] ?? 0);
  const tradedNotionalUsd = notionalParts === null ? null : (notionalParts[0]?.[1] ?? null);

  const windowParts = parseRows(windowRes, 3);
  const window = {
    epochMs,
    epochIso: epochMs === null ? null : new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    firstIso: windowParts?.[0]?.[0] ?? null,
    lastIso: windowParts?.[0]?.[1] ?? null,
    readAtIso: windowParts?.[0]?.[2] ?? null,
  };

  return {
    modelTotals,
    unpriceable,
    consultRows,
    costCurveTail,
    fills,
    tradedNotionalUsd,
    window,
    costGauge,
    tripsGauge,
  };
}

/**
 * The one-way (per-LEG) notional, and the sentence naming how it was built.
 *
 * Basis: total traded notional / (2 × closed round trips). That is EXACTLY the denominator
 * fee-floor-derivation-2026-07-31.md:104-109 uses — its `bps_per_round_trip` is
 * `2 × 10000 × Σfee / Σnotional`, which is algebraically `(Σfee / trips) ÷ (Σnotional / (2×trips))`.
 * Using the same denominator is what makes the LLM bps below directly comparable to the 9.29 bps/trip
 * fee floor instead of merely similar-looking.
 *
 * DIRECTION OF BIAS, stated because this is the one axis on which the instrument under-states: the
 * fill sum also contains legs of cycles that are still OPEN, so it is an UPPER bound on the notional
 * belonging to the closed trips — and an over-large denominator makes the bps figure a LOWER bound.
 * The USD-per-trip figures are unaffected; only the bps conversion carries this.
 */
export function oneWayNotional(tradedNotionalUsd, trips, fills) {
  if (tradedNotionalUsd === null || trips === null || trips <= 0) {
    return { usd: null, basis: null };
  }
  const legs = 2 * trips;
  const value = (Number(tradedNotionalUsd) / legs).toFixed(8);
  return {
    usd: value,
    basis:
      `Σ(price×qty) over ${fills ?? '?'} fills (mode='testnet', venue_timestamp ≥ epoch — the same ` +
      `predicate PromotionStatsRepository.fillsForMode uses) = $${Number(tradedNotionalUsd).toFixed(2)}, ` +
      `÷ ${legs} legs (2 × ${trips} closed round trips). Same per-leg denominator as ` +
      'fee-floor-derivation-2026-07-31.md:104-109, so the bps figure is directly comparable to the ' +
      '9.29 bps/trip fee floor. UPPER bound (the fill sum includes legs of cycles still open), so ' +
      'the bps it yields is a LOWER bound; the USD/trip figures do not depend on it',
  };
}

export function runLlmAttribution(opts = {}) {
  const g = gatherLlmAttribution(opts);
  const trips =
    g.tripsGauge === null || g.tripsGauge === undefined ? null : Number(g.tripsGauge.value);
  const tripCount = Number.isInteger(trips) && trips > 0 ? trips : null;
  const notional = oneWayNotional(g.tradedNotionalUsd, tripCount, g.fills);

  return computeLlmAttribution({
    modelTotals: g.modelTotals,
    rateTable: opts.rateTable ?? resolveRateTable(opts.env ?? process.env),
    trips: tripCount,
    tripsSource:
      tripCount === null
        ? null
        : `agentic_promotion_round_trips gauge${g.tripsGauge.readAtIso ? ` @ ${g.tripsGauge.readAtIso}` : ''}` +
          " — PromotionReadinessService.evaluate()'s own walkRoundTrips count " +
          '(src/domain/trading/risk/round-trips.ts), read rather than re-derived',
    gaugeLlmCostUsd: g.costGauge?.value ?? null,
    gaugeReadAtIso: g.costGauge?.readAtIso ?? null,
    costCurveTail: g.costCurveTail,
    consultRows: g.consultRows,
    unpriceable: g.unpriceable,
    oneWayNotionalUsd: notional.usd,
    notionalBasis: notional.basis,
    window: g.window,
  });
}

function main() {
  process.stdout.write(renderLlmAttribution(runLlmAttribution()) + '\n');
}

// CLI entry-point guard: an `import` (a spec importing the SQL builders above) must NOT fire a
// blocking set of database reads as an import side effect.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `loop-llm-attrib: FATAL ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
