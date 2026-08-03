#!/usr/bin/env node
// PER-TRIP LLM COST ATTRIBUTION — PURE logic. No I/O, no clock, no process/env access, and it NEVER
// throws: given the per-model token sums, the rate table, the consult fan-out rows and the trip
// count the runner probed, derive the book LLM cost, both per-trip attributions, and the disclosures
// that name everything the data could not price. The runner (loop-llm-attrib.mjs) only gathers rows
// and renders what this returns.
//
// STATUS 2026-08-04 — WIRED and VERIFIED against the live book. `pnpm loop:llm-attrib` runs the
// runner; test/features/strategy/loop-sweep/llm-attrib.spec.ts pins this core offline (no database).
// The cross-check that validates it RAN and PASSED, on both of its branches: at 2026-08-03T22:12:28Z
// the recomputed book cost $28.7683109 equalled the gate's own published
// `agentic_promotion_llm_cost_usd` outright (EXACT, delta $0), and against the gauge's earlier
// $28.7007443 sample it matched EXACTLY once the one priced row written after 2026-08-03T22:00:31Z
// was peeled off (EXACT_AT_CUT). Both folds price the same raw token columns at the same rates in
// the same order, so those equalities are identity tests, not tolerances. Full record:
// research/studies/llm-cost-attribution-2026-08-04.md.
//
// WHY THIS EXISTS. The book's objective is `net-of-cost PnL = realizedPnl − fees − llmCostUsd`, but
// NO per-trip statistic anywhere contains the LLM term. promotion-readiness.service.ts:136-139 fixes
// `winRate` on `realizedPnl − feesQuote` and carries llmCostUsd at BOOK level only — a deliberate,
// documented choice, but the consequence is that the largest per-trip cost term is invisible by
// construction. The measured fee floor is 9.29 bps/trip (fee-floor-derivation-2026-07-31.md:117) and
// the whole program optimises against it; this instrument's job is to put the LLM term on the same
// page, in the same units, permanently.
//
// FAILURE DIRECTION — this is a MEASUREMENT, so it fails toward OVERSTATEMENT, LOUDLY, and NEVER
// toward a flattering silence. A zero printed by this module always means a MEASURED zero; absent
// data is always visibly absent. Concretely:
//   * an unknown / unpriced model is charged the MOST EXPENSIVE configured rate per component
//     (`resolveRates` below mirrors promotion-readiness.service.ts's `ratesFor` fold) — a model the
//     operator never priced can only ever OVER-count;
//   * rows the caller marks `billable` that carry NULL tokens are reported as a named
//     `unpriceable_rows` count, never folded in as zero;
//   * a transport failure, an unreadable rate table, or an unreadable model fold voids the WHOLE
//     reading as `MEASUREMENT-VOID` — it is never rendered as `$0.00`;
//   * an unknown trip count voids the PER-TRIP figures by name while still reporting the book cost —
//     a book number divided by a guessed denominator is the exact defect this instrument exists to
//     stop, so the denominator is never guessed.
// It emits no alarms and carries no gate: a broken measurement must never block the thing it
// measures. THE ONE AXIS THAT UNDER-STATES is the bps denominator, and it is named where it is used
// (see `notionalBasis` on computeLlmAttribution) rather than left for a reader to discover.
//
// TRIP BOUNDARIES — NOT derived here, by decision. `walkRoundTrips`
// (src/domain/trading/risk/round-trips.ts) is the single source of the closed-round-trip count the
// promotion gate returns; a second walk in this file would become a second truth, and the whole
// point of the cross-check below is that this instrument and the gate divide the same book by the
// same denominator. `trips` is therefore an EXPLICIT INPUT the caller supplies together with
// `tripsSource` naming where it came from, and the runner sources it from the gate's own
// `agentic_promotion_round_trips` gauge — which is walkRoundTrips' published output, read rather
// than re-derived. A caller that cannot state a source gets per-trip figures voided by name.
//
// MONEY EXACTNESS (root CLAUDE.md hard rule 1). Token counts are exact integers and arrive already
// summed by the database (bigint SUM, exact). Every USD product is decimal.js — already a scripts
// dependency (scripts/loop-sweep-core.mjs:32, scripts/loop-authoring.mjs:32) — never a native float,
// and never `parseFloat`/`Number()`. The per-component fold below is `Decimal(tokens).div(1e6)
// .mul(rate)`, ORDER-IDENTICAL to promotion-readiness.service.ts:167-171, which is what makes the
// cross-check in `crossCheck` a real equality test rather than a rounding-tolerance test. Two native
// -float uses are deliberate and are the only ones: COUNTS (rows, trips, fan-out) and the bps RATIO,
// a dimensionless presentation figure rendered to one decimal; plus the ONE `Decimal.toNumber()`
// pair in `matchesGauge` below, which exists because the gauge is itself a float64 image.

import Decimal from 'decimal.js';

/** Tokens are quoted per million everywhere in this codebase's rate config. */
export const MTOK = new Decimal(1_000_000);

/**
 * The actions that make a decision row TRADE-CAUSING rather than cadence.
 *
 * `hold` is excluded deliberately and it is the whole argument of the marginal number below: a hold
 * consult fires because the bar closed, not because a trip existed. `error` is excluded because an
 * errored consult produced no action at all.
 *
 * Exported so the runner's SQL builds its `action in (…)` list from THIS array rather than a second
 * hand-typed copy — a silently divergent trade-action set would move the marginal bracket with no
 * visible edit to either file.
 */
export const TRADE_ACTIONS = ['open_long', 'open_short', 'close', 'adjust'];

/** USD at decimal.js default precision (20 significant digits). Exact for every SUM and PRODUCT this
 *  module forms; a QUOTIENT (cost/trips) may be non-terminating, so the renderer says "full
 *  precision", never "exact", wherever it prints a quotient. */
export const usd = (d) => (d === null || d === undefined ? 'n/a' : `$${d.toFixed()}`);

/** USD rendered to cents, for figures a human compares at a glance. The full-precision value is
 *  always available alongside; this is presentation only and is labelled as such where it is printed. */
export const usd2 = (d) => (d === null || d === undefined ? 'n/a' : `$${d.toFixed(2)}`);

/**
 * A cost per unit notional, in basis points. Dimensionless, so a native Number is correct here —
 * but it is derived from Decimals and only ever rendered, never re-entered into money arithmetic.
 * Returns null (never 0) when the denominator is unknown: a bps figure with no notional behind it
 * is not a small number, it is no number.
 */
export function bps(costUsd, notionalUsd) {
  if (costUsd === null || notionalUsd === null || notionalUsd === undefined) return null;
  const n = dec(notionalUsd);
  if (n === null || !n.gt(0)) return null;
  return Number(costUsd.div(n).mul(10_000).toFixed(4));
}

export const fmtBps = (v) =>
  v === null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`;

function annotation(kind, detail) {
  return { kind, detail };
}

/**
 * `new Decimal(x)` that returns null instead of THROWING on unparseable input.
 *
 * decimal.js raises `[DecimalError] Invalid argument` rather than yielding a NaN Decimal, so an
 * `isFinite()` check placed after the construction never runs — the module's "never throws" contract
 * dies at the constructor. That is not hypothetical for a rate table: these values arrive as strings
 * off the process env, where a stray character in AGENTIC_TOKEN_PRICES_JSON is one typo away, and a
 * throw would abort the whole reading instead of voiding it BY NAME the way every other failure path
 * here does. Caught 2026-08-04 by this module's own spec.
 */
function dec(v) {
  try {
    return new Decimal(v);
  } catch {
    return null;
  }
}

// ── rates ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Resolution order, PORTED from promotion-readiness.service.ts:182-220 so this instrument and the
 * live-arming gate cannot silently price the same tokens differently:
 *   1. the model's own entry in the per-model map;
 *   2. the flat default rates (used when no map is configured at all);
 *   3. for an UNKNOWN model WITH a map configured, the MOST EXPENSIVE rate per component across
 *      every configured rate set (defaults + every mapped model).
 *
 * Clause 3 is the fail-toward-overstatement rule, and it is why `resolution` is returned alongside
 * the rates rather than kept private: a cost line priced at `max_of_configured` is an UPPER BOUND on
 * a model nobody priced, and a report that printed it without saying so would be asserting a
 * measurement it does not have. Clause 3 is NOT hypothetical here — `claude-opus-4-8` carries live
 * reflection tokens in `llm_usage` and has no entry in AGENTIC_TOKEN_PRICES_JSON, so the gate itself
 * is charging it at max_of_configured today (verified: the recompute matched the gauge EXACTLY only
 * under that rule).
 *
 * One deliberate DIVERGENCE from the service, in the safe direction: a mapped entry whose rates do
 * not parse to finite Decimals falls through to clause 3 here, where the service would carry the
 * NaN. Config validation (environment.config.ts's tokenPriceEntrySchema requires all four rates as
 * decimal strings) makes this unreachable through the app's own config path; a hand-built rate table
 * passed to this core is the case it covers, and over-charging beats propagating NaN.
 *
 * Returns null when NO rate set is available at all. That is not "free" — it is unpriceable, and the
 * caller voids on it.
 */
export function resolveRates(model, rateTable) {
  if (!rateTable || typeof rateTable !== 'object') return null;
  const map = rateTable.models;
  const toSet = (e, resolution) => {
    if (!e) return null;
    const out = {
      input: dec(e.inputPerMtok),
      output: dec(e.outputPerMtok),
      cacheRead: dec(e.cacheReadPerMtok ?? '0'),
      cacheWrite: dec(e.cacheWritePerMtok ?? '0'),
      resolution,
    };
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (out[k] === null || !out[k].isFinite()) return null;
    }
    return out;
  };
  const defaults = toSet(rateTable.defaults, 'defaults');
  if (map && Object.prototype.hasOwnProperty.call(map, model)) {
    const mapped = toSet(map[model], 'mapped');
    if (mapped) return mapped;
  }
  if (!map || Object.keys(map).length === 0) return defaults;
  const pools = [defaults, ...Object.keys(map).map((k) => toSet(map[k], 'mapped'))].filter(Boolean);
  if (pools.length === 0) return null;
  return {
    input: Decimal.max(...pools.map((p) => p.input)),
    output: Decimal.max(...pools.map((p) => p.output)),
    cacheRead: Decimal.max(...pools.map((p) => p.cacheRead)),
    cacheWrite: Decimal.max(...pools.map((p) => p.cacheWrite)),
    resolution: 'max_of_configured',
  };
}

/**
 * Σ (tokens × rate) / 1M per component. Fold order is byte-identical to
 * promotion-readiness.service.ts:167-171 — see the module header's MONEY EXACTNESS note for why that
 * identity is load-bearing rather than stylistic.
 *
 * The gate folds BOTH source tables into ONE per-model bucket before pricing; this core prices each
 * (model, source) bucket separately and sums. Those agree exactly, because the fold is linear in the
 * token counts and every step is exact Decimal arithmetic — which is what lets the report show the
 * `llm_usage` half separately (it has no live writer) without breaking the equality test.
 */
export function costOf(totals, rates) {
  return new Decimal(totals.inputTokens ?? 0)
    .div(MTOK)
    .mul(rates.input)
    .plus(new Decimal(totals.outputTokens ?? 0).div(MTOK).mul(rates.output))
    .plus(new Decimal(totals.cacheReadTokens ?? 0).div(MTOK).mul(rates.cacheRead))
    .plus(new Decimal(totals.cacheCreationTokens ?? 0).div(MTOK).mul(rates.cacheWrite));
}

/**
 * Equality AT THE GAUGE'S OWN RESOLUTION.
 *
 * `agentic_promotion_llm_cost_usd` is the float64 IMAGE of the gate's Decimal —
 * promotion-metrics.service.ts:141 calls `.toNumber()` before prom-client renders it — so the
 * strongest equality test that exists compares float64 to float64. The lossy step belongs to the
 * GATE's publication path, not to this instrument, and pretending otherwise (a Decimal-exact test
 * against a float64 rendering) would report DISAGREE on a book that agrees. The full-precision
 * Decimal delta is reported alongside regardless, so nothing is hidden by this choice.
 */
export function matchesGauge(candidate, gauge) {
  return candidate.toNumber() === gauge.toNumber();
}

// ── the measurement ──────────────────────────────────────────────────────────────────────────────

const VOID = (annotations) => ({ status: 'MEASUREMENT-VOID', annotations });

/**
 * @param modelTotals  [{ model, source, rows, inputTokens, outputTokens, cacheReadTokens,
 *                        cacheCreationTokens }] or null when the probe failed. `source` is the table
 *                     the fold came from ('agent_decisions' | 'llm_usage'), carried so the report can
 *                     show that the historical `llm_usage` half has no live writer.
 * @param rateTable    { defaults, models } or null when config could not be read.
 * @param trips        closed round-trip COUNT for the window, or null. NEVER derived here — see the
 *                     module header's TRIP BOUNDARIES note.
 * @param tripsSource  free text naming where `trips` came from. Required whenever trips is non-null:
 *                     a denominator whose provenance is unstated is a denominator nobody can check.
 * @param gaugeLlmCostUsd  the live `agentic_promotion_llm_cost_usd` gauge as a string, or null. This
 *                     is PromotionReadinessService.evaluate()'s own llmCostUsd, published from ONE
 *                     evaluate() call, and the cross-check against it is what validates both sides.
 * @param gaugeReadAtIso  when the gauge sample was read, or null. A gauge quoted without its instant
 *                     cannot be compared against a book that keeps growing.
 * @param costCurveTail  the most recent priced rows in the window, ASCENDING by created_at, each
 *                     { createdAtIso, model, inputTokens, outputTokens, cacheReadTokens,
 *                     cacheCreationTokens }, or null. Defeats scrape lag: the gauge is a 5-minute
 *                     sample (promotion-metrics.service.ts:79) of a book that keeps growing, so a raw
 *                     delta against the CURRENT book is expected to be non-zero and proves nothing.
 *                     Peeling this tail back one row at a time finds the row cut at which the two
 *                     folds are IDENTICAL, which is the equality test the raw delta cannot be.
 * @param consultRows  [{ consultId, fanout, tradeActionRows, model, inputTokens, outputTokens,
 *                        cacheReadTokens, cacheCreationTokens }] or null.
 * @param unpriceable  [{ klass, rows, detail, billable }] or null when the probe failed. The caller
 *                     owns the billable/not-billable call because only the caller can see the row
 *                     STRUCTURE that decides it — see the runner's UNPRICEABLE_SQL for the live
 *                     classification and why the biggest NULL-token class is not billable.
 * @param oneWayNotionalUsd  mean ONE-LEG fill notional in quote USD, as a string, or null.
 * @param notionalBasis  free text naming how `oneWayNotionalUsd` was constructed AND its direction of
 *                     bias. Required whenever the notional is non-null: every bps figure below is a
 *                     ratio, and a ratio whose denominator's construction is unstated is not a
 *                     measurement. This is the ONE axis on which the instrument can UNDER-state.
 * @param window       { epochMs, epochIso, firstIso, lastIso, readAtIso } — the as-of block. Every
 *                     money figure this module renders is printed with its denominator AND this
 *                     as-of, because a cost figure without both is not falsifiable.
 * Never throws. Returns { status, ..., annotations } and deliberately no `alarms` key.
 */
export function computeLlmAttribution({
  modelTotals,
  rateTable,
  trips,
  tripsSource,
  gaugeLlmCostUsd,
  gaugeReadAtIso,
  costCurveTail,
  consultRows,
  unpriceable,
  oneWayNotionalUsd,
  notionalBasis,
  window,
} = {}) {
  const annotations = [];

  if (!Array.isArray(modelTotals)) {
    annotations.push(
      annotation(
        'llm_attrib_token_probe_failed',
        'the per-model token fold against agent_decisions/llm_usage returned no readable rows — this ' +
          'is NOT a zero-cost window, it is NO READING AT ALL, and nothing below was measured',
      ),
    );
    return VOID(annotations);
  }
  if (!rateTable || typeof rateTable !== 'object' || !rateTable.defaults) {
    annotations.push(
      annotation(
        'llm_attrib_rates_unreadable',
        'no token rate table could be read (AGENTIC_TOKEN_PRICE_*_PER_MTOK / ' +
          'AGENTIC_TOKEN_PRICES_JSON absent or malformed) — tokens exist but cannot be priced, so ' +
          'the reading is VOID. It is deliberately NOT rendered as $0: run this through ' +
          '`--env-file-if-exists=.env.app` so the committed rates are on the process env',
      ),
    );
    return VOID(annotations);
  }

  // ── book cost, recomputed from raw token columns ───────────────────────────────────────────────
  const byModel = [];
  let bookCost = new Decimal(0);
  for (const m of modelTotals) {
    const rates = resolveRates(m.model, rateTable);
    if (rates === null) {
      annotations.push(
        annotation(
          'llm_attrib_model_unpriceable',
          `model \`${m.model}\` could not be priced by ANY rule (no mapped entry, no defaults, no ` +
            'configured pool to take a maximum over) — the whole reading is VOID rather than ' +
            'charging it zero',
        ),
      );
      return VOID(annotations);
    }
    const cost = costOf(m, rates);
    byModel.push({ ...m, rates, cost, resolution: rates.resolution });
    bookCost = bookCost.plus(cost);
  }
  byModel.sort((a, b) => b.cost.comparedTo(a.cost) || a.model.localeCompare(b.model));

  const maxPricedWithTokens = byModel.filter(
    (m) => m.resolution === 'max_of_configured' && m.cost.gt(0),
  );
  if (maxPricedWithTokens.length > 0) {
    const share = bookCost.gt(0)
      ? maxPricedWithTokens
          .reduce((s, m) => s.plus(m.cost), new Decimal(0))
          .div(bookCost)
          .mul(100)
          .toFixed(1)
      : '0.0';
    annotations.push(
      annotation(
        'llm_attrib_unpriced_model_charged_max',
        `${maxPricedWithTokens.length} model(s) carry tokens but have NO configured rate entry and ` +
          'were charged the MOST EXPENSIVE configured rate per component (the fail-toward-' +
          `overstatement rule): ${maxPricedWithTokens.map((m) => `${m.model} → ${usd(m.cost)}`).join(', ')}. ` +
          `That is ${share}% of the book cost carried as an UPPER BOUND rather than a measurement — ` +
          'price the model in AGENTIC_TOKEN_PRICES_JSON to convert it. Note this is not this ' +
          "instrument's convention alone: the promotion gate prices those same tokens the same way, " +
          'so the gate is running on the same upper bound',
      ),
    );
  }
  const maxPricedZero = byModel.filter(
    (m) => m.resolution === 'max_of_configured' && m.cost.isZero(),
  );
  if (maxPricedZero.length > 0) {
    annotations.push(
      annotation(
        'llm_attrib_unpriced_model_zero_tokens',
        `${maxPricedZero.map((m) => `\`${m.model}\` (${m.rows} row(s))`).join(', ')} carry NO rate ` +
          'entry and NO tokens, so they cost $0 only because their token totals are zero — not ' +
          'because they are known to be free. The moment any writer stamps tokens on one of these ' +
          'model names it will price at the most-expensive configured rate with no further warning',
      ),
    );
  }
  if (byModel.length === 0) {
    annotations.push(
      annotation(
        'llm_attrib_no_token_rows',
        'the probe succeeded and found ZERO token-bearing rows in the window — this IS a ' +
          'determinate reading (a measured zero), distinct from the void reads above',
      ),
    );
  }

  // ── cross-check against the gate's own published cost ──────────────────────────────────────────
  const crossCheck = crossCheckGauge(
    bookCost,
    gaugeLlmCostUsd,
    gaugeReadAtIso,
    costCurveTail,
    rateTable,
    annotations,
  );

  // ── per-trip attributions ──────────────────────────────────────────────────────────────────────
  const tripCount = Number.isInteger(trips) && trips > 0 ? trips : null;
  if (tripCount === null) {
    annotations.push(
      annotation(
        'llm_attrib_trips_unknown',
        'the closed round-trip count could not be read, so EVERY per-trip figure below is void. ' +
          'This module never derives trip boundaries itself: `walkRoundTrips` ' +
          '(src/domain/trading/risk/round-trips.ts) is the single source of the number the promotion ' +
          'gate returns, and a second walk here would become a second truth. The book cost above is ' +
          'still a real reading — only the denominator is missing',
      ),
    );
  } else if (tripsSource === null || tripsSource === undefined || tripsSource === '') {
    annotations.push(
      annotation(
        'llm_attrib_trips_source_unstated',
        `the caller supplied trips=${tripCount} with NO source — the per-trip figures below are ` +
          'computed but their denominator cannot be checked by anyone reading this report',
      ),
    );
  }

  const amortizedUsd = tripCount === null ? null : bookCost.div(tripCount);

  // The notional denominator is the one place this instrument can UNDER-state (a bps figure is a
  // ratio; an inflated denominator shrinks it), so an unnamed basis is disclosed rather than assumed.
  if (
    oneWayNotionalUsd !== null &&
    oneWayNotionalUsd !== undefined &&
    (notionalBasis === null || notionalBasis === undefined || notionalBasis === '')
  ) {
    annotations.push(
      annotation(
        'llm_attrib_notional_basis_unstated',
        'a one-way notional was supplied with NO statement of how it was constructed — every bps ' +
          'figure below is therefore uncheckable. bps is the ONE axis on which this instrument can ' +
          'under-state (an over-large denominator shrinks the ratio), which is exactly why the basis ' +
          'is required rather than optional',
      ),
    );
  }
  if (oneWayNotionalUsd === null || oneWayNotionalUsd === undefined) {
    annotations.push(
      annotation(
        'llm_attrib_notional_unknown',
        'the mean one-way fill notional could not be read, so no bps figure is printed. The USD ' +
          'per-trip figures are unaffected — only the comparison against the bps fee floor is missing',
      ),
    );
  }

  // Consult-chain marginal. Structure VERIFIED against the live table 2026-08-04, not assumed:
  // `consult_id` identifies ONE Anthropic call whose result fans out to N per-symbol decision rows
  // (rows-per-consult equals distinct-(symbol,venue)-per-consult EXACTLY, 1..8, over all 667
  // post-epoch consults), and EXACTLY ONE row per consult carries the token columns (every consult,
  // no exceptions). So a consult's cost is indivisible at the call level and SHARED at the symbol
  // level, which is why the marginal is reported as a BRACKET rather than a point:
  //   upper  — every consult that emitted at least one trade action, charged in FULL. Over-counts,
  //            because the same call also decided symbols that did not trade.
  //   proRata— that same consult cost times (its trade-action rows / its fan-out). The trip's
  //            per-symbol slice.
  // Both are true; neither is the counterfactual (see `cadenceOnlyUsd` and the renderer's note).
  let marginal = null;
  if (!Array.isArray(consultRows)) {
    annotations.push(
      annotation(
        'llm_attrib_consult_probe_failed',
        'the consult fan-out probe returned no readable rows — the consult-chain MARGINAL cost was ' +
          'not computed at all (this is not a marginal of zero). The amortized figure is unaffected',
      ),
    );
  } else {
    let upper = new Decimal(0);
    let proRata = new Decimal(0);
    let cadenceOnly = new Decimal(0);
    let tradeConsults = 0;
    let cadenceConsults = 0;
    let malformed = 0;
    for (const c of consultRows) {
      const rates = resolveRates(c.model, rateTable);
      if (rates === null || !Number.isInteger(c.fanout) || c.fanout <= 0) {
        malformed += 1;
        continue;
      }
      const cost = costOf(c, rates);
      if ((c.tradeActionRows ?? 0) > 0) {
        tradeConsults += 1;
        upper = upper.plus(cost);
        proRata = proRata.plus(cost.mul(c.tradeActionRows).div(c.fanout));
      } else {
        cadenceConsults += 1;
        cadenceOnly = cadenceOnly.plus(cost);
      }
    }
    if (malformed > 0) {
      annotations.push(
        annotation(
          'llm_attrib_consults_malformed',
          `${malformed} consult(s) carried an unusable model or fan-out and were excluded from the ` +
            'marginal — the bracket below covers the rest only and is therefore an UNDER-count of ' +
            'the marginal, the one direction this instrument does not otherwise fail in',
        ),
      );
    }
    marginal = {
      tradeConsults,
      cadenceConsults,
      upperUsd: upper,
      proRataUsd: proRata,
      cadenceOnlyUsd: cadenceOnly,
      upperPerTripUsd: tripCount === null ? null : upper.div(tripCount),
      proRataPerTripUsd: tripCount === null ? null : proRata.div(tripCount),
    };
  }

  // ── unpriceable rows ───────────────────────────────────────────────────────────────────────────
  let unpriceableTotal = null;
  const unpriceableClasses = [];
  if (!Array.isArray(unpriceable)) {
    annotations.push(
      annotation(
        'llm_attrib_unpriceable_probe_failed',
        'the unpriceable-row probe failed, so the count of NULL-token rows that carry real spend is ' +
          'unknown. That is not zero — it means the size of the unmeasured cost tail is itself ' +
          'unmeasured, and every cost figure above is a lower bound by an unknown amount',
      ),
    );
  } else {
    unpriceableTotal = 0;
    for (const u of unpriceable) {
      const rows = Number.isInteger(u.rows) ? u.rows : 0;
      unpriceableClasses.push({ klass: u.klass, rows, detail: u.detail, billable: u.billable });
      if (u.billable === true) unpriceableTotal += rows;
    }
    if (unpriceableTotal > 0) {
      annotations.push(
        annotation(
          'llm_attrib_unpriceable_rows',
          `unpriceable_rows=${unpriceableTotal} — NULL-token rows the classifier could NOT account ` +
            'for through an already-priced sibling call: ' +
            unpriceableClasses
              .filter((u) => u.billable === true && u.rows > 0)
              .map((u) => `\`${u.klass}\` ${u.rows}`)
              .join(', ') +
            '. Their cost is NOT in any figure above and is NOT zero: an API call that errored after ' +
            'the model produced tokens still bills. Every cost figure in this report is therefore a ' +
            'LOWER bound by this tail, which is the one place the instrument under-states and the ' +
            'reason the tail is named rather than folded in as zero',
        ),
      );
    } else {
      annotations.push(
        annotation(
          'llm_attrib_unpriceable_rows_measured_zero',
          'unpriceable_rows=0 — a MEASURED zero, not an absent probe. Every NULL-token row in the ' +
            'window was classified as either a fan-out sibling of a consult whose single ' +
            'token-bearing row IS priced above, or a row that never called the client. The ' +
            'not-billable class counts are printed in full so the classification can be re-checked ' +
            'rather than trusted',
        ),
      );
    }
  }

  return {
    status: 'measured',
    window: window ?? null,
    book: { llmCostUsd: bookCost, byModel },
    crossCheck,
    trips: tripCount,
    tripsSource: tripCount === null ? null : (tripsSource ?? 'UNSTATED'),
    oneWayNotionalUsd: oneWayNotionalUsd ?? null,
    notionalBasis: notionalBasis ?? null,
    perTrip: {
      amortizedUsd,
      amortizedBps: bps(amortizedUsd, oneWayNotionalUsd ?? null),
      marginal,
      marginalUpperBps: bps(marginal?.upperPerTripUsd ?? null, oneWayNotionalUsd ?? null),
      marginalProRataBps: bps(marginal?.proRataPerTripUsd ?? null, oneWayNotionalUsd ?? null),
    },
    unpriceableRows: unpriceableTotal,
    unpriceableClasses,
    annotations,
  };
}

/**
 * The cross-check, extracted so its lag discipline reads as one thing.
 *
 * A RAW delta against the gauge proves nothing on its own. The gauge is a 5-minute sample
 * (promotion-metrics.service.ts:79) of a book that keeps growing, so the current recompute is
 * expected to exceed it by however many consults billed since the last tick. Calling that
 * "DISAGREE" would cry wolf on every run; calling it "agreement" would validate nothing. So the
 * check peels the tail back one priced row at a time and asks whether the gauge sits EXACTLY on the
 * recomputed cost curve. If it does, the two folds are identical at a nameable instant, which is a
 * real equality test. If it does not, the direction of the residual decides the verdict — recompute
 * BELOW the gauge is the one shape lag cannot produce.
 */
function crossCheckGauge(
  bookCost,
  gaugeLlmCostUsd,
  gaugeReadAtIso,
  costCurveTail,
  rateTable,
  annotations,
) {
  // An unparseable gauge is folded into the SAME unavailable path as an absent one, on purpose: a
  // gauge string this module cannot read is a gauge it did not compare against, and inventing a
  // third verdict for it would only invite the reader to treat one of them as softer than the other.
  const gauge =
    gaugeLlmCostUsd === null || gaugeLlmCostUsd === undefined || gaugeLlmCostUsd === ''
      ? null
      : dec(gaugeLlmCostUsd);
  if (gauge === null || !gauge.isFinite()) {
    annotations.push(
      annotation(
        'llm_attrib_crosscheck_unavailable',
        'the `agentic_promotion_llm_cost_usd` gauge could not be read, so the recomputed book cost ' +
          'is UNVALIDATED. Absence of a disagreement here is not agreement — the comparison did not run',
      ),
    );
    return {
      gauge: null,
      gaugeReadAtIso: gaugeReadAtIso ?? null,
      recomputed: bookCost,
      delta: null,
      verdict: 'UNAVAILABLE',
      cutRows: null,
      cutAtIso: null,
      tailScanned: 0,
      tailCost: null,
    };
  }

  const delta = bookCost.minus(gauge);
  const base = {
    gauge,
    gaugeReadAtIso: gaugeReadAtIso ?? null,
    recomputed: bookCost,
    delta,
    cutRows: null,
    cutAtIso: null,
    tailScanned: 0,
    tailCost: null,
  };

  if (matchesGauge(bookCost, gauge)) {
    return { ...base, verdict: 'EXACT', cutRows: 0 };
  }

  // Peel the tail. `costCurveTail` is ascending by created_at, so walking it backwards removes the
  // newest priced row first — the exact order the gauge's own sample lag removes them in.
  let peeled = new Decimal(0);
  let scanned = 0;
  if (Array.isArray(costCurveTail)) {
    for (let i = costCurveTail.length - 1; i >= 0; i -= 1) {
      const r = costCurveTail[i];
      const rates = resolveRates(r.model, rateTable);
      if (rates === null) break;
      peeled = peeled.plus(costOf(r, rates));
      scanned += 1;
      if (matchesGauge(bookCost.minus(peeled), gauge)) {
        annotations.push(
          annotation(
            'llm_attrib_crosscheck_exact_at_cut',
            `recomputed book LLM cost equals the gate's published agentic_promotion_llm_cost_usd ` +
              `${usd(gauge)} EXACTLY once the ${scanned} priced row(s) written after ` +
              `${r.createdAtIso} are peeled off — i.e. the gauge is this instrument's own cost curve ` +
              `evaluated at the gate's last 5-minute sample. Current book ${usd(bookCost)} (${usd(delta)} ` +
              'of consults billed since that tick). Both folds price the SAME raw token columns at ' +
              'the SAME rates in the SAME order, so this is an identity, not a tolerance',
          ),
        );
        return {
          ...base,
          verdict: 'EXACT_AT_CUT',
          cutRows: scanned,
          cutAtIso: r.createdAtIso ?? null,
          tailScanned: scanned,
          tailCost: peeled,
        };
      }
    }
  }

  if (delta.lt(0)) {
    annotations.push(
      annotation(
        'llm_attrib_crosscheck_disagrees',
        `recomputed book LLM cost ${usd(bookCost)} is BELOW the gate's published ` +
          `agentic_promotion_llm_cost_usd ${usd(gauge)} — delta ${usd(delta)}. This is the one shape ` +
          'sample lag CANNOT produce (the gauge samples a strictly growing book), so it is a FINDING ' +
          'about the row window or the rate fold — a filter this instrument applies and the gate ' +
          'does not, or a rate resolved differently. Do not reconcile it away',
      ),
    );
    return { ...base, verdict: 'DISAGREE', tailScanned: scanned, tailCost: peeled };
  }

  annotations.push(
    annotation(
      'llm_attrib_crosscheck_lag_unresolved',
      `recomputed book LLM cost ${usd(bookCost)} exceeds the gate's published ` +
        `agentic_promotion_llm_cost_usd ${usd(gauge)} by ${usd(delta)}, and peeling the ${scanned} ` +
        'row(s) of supplied cost-curve tail never landed on the gauge exactly. The direction is the ' +
        'benign one (sample lag on a growing book), but the EQUALITY TEST DID NOT RUN: either the ' +
        'tail is shorter than the lag, or the two folds genuinely differ. This is NOT agreement',
    ),
  );
  return { ...base, verdict: 'LAG_UNRESOLVED', tailScanned: scanned, tailCost: peeled };
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────

/** The notional as a Decimal, or null when it is absent OR unparseable — the renderer must not be
 *  the one place in this module that can throw on caller data. */
function notionalFor(result) {
  const n = result.oneWayNotionalUsd;
  if (n === null || n === undefined) return null;
  const d = dec(n);
  return d === null || !d.isFinite() ? null : d;
}

/**
 * Renderable report. Kept here (pure) so the runner cannot assemble a money figure without its
 * denominator and as-of, and cannot print a per-trip number without the label saying WHICH
 * attribution it is.
 */
export function renderLlmAttribution(result) {
  const lines = ['## Per-trip LLM cost attribution', ''];
  if (!result || result.status !== 'measured') {
    lines.push(
      '**MEASUREMENT-VOID** — no reading was taken. This is deliberately not rendered as $0.00.',
      '',
    );
    for (const a of result?.annotations ?? []) lines.push(`- **${a.kind}** — ${a.detail}`);
    lines.push('');
    return lines.join('\n');
  }

  const w = result.window ?? {};
  lines.push(
    `_As of ${w.readAtIso ?? 'unknown'} · window ${w.epochIso ?? 'all-time'} → ${w.lastIso ?? 'unknown'}_`,
    '_(PROMOTION\\_EVIDENCE\\_EPOCH-anchored, filtered on `created_at` exactly as the promotion_',
    '_evidence fold is — promotion-stats.repository.ts:113-122.)_',
    '',
    '_Measurement only — annotations, never alarms. Fails toward OVERSTATEMENT: a zero here always_',
    '_means a measured zero._',
    '',
  );

  lines.push('### Book LLM cost (recomputed from raw token columns)', '');
  lines.push(
    `- **${usd(result.book.llmCostUsd)}** total (${usd2(result.book.llmCostUsd)} to cents)`,
  );
  for (const m of result.book.byModel) {
    lines.push(
      `  - \`${m.model}\` (${m.source}, ${m.rows} row(s), rates: ${m.resolution}) — ${usd(m.cost)}` +
        ` [in ${m.inputTokens} / out ${m.outputTokens} / cache-read ${m.cacheReadTokens}` +
        ` / cache-write ${m.cacheCreationTokens}]`,
    );
  }
  lines.push('');

  const cc = result.crossCheck;
  lines.push("### Cross-check vs the gate's own `evaluate()` llmCostUsd", '');
  if (cc.verdict === 'UNAVAILABLE') {
    lines.push('- **UNAVAILABLE** — the gauge could not be read. This is not agreement.', '');
  } else {
    lines.push(
      `- recomputed ${usd(cc.recomputed)} vs published ${usd(cc.gauge)}` +
        `${cc.gaugeReadAtIso ? ` (read ${cc.gaugeReadAtIso})` : ''} — **${cc.verdict}**` +
        ` (raw delta ${usd(cc.delta)})`,
    );
    if (cc.verdict === 'EXACT_AT_CUT') {
      lines.push(
        `  - identical once the ${cc.cutRows} priced row(s) written after ${cc.cutAtIso} are peeled ` +
          `off — the gauge is this cost curve at the gate's last 5-minute sample.`,
      );
    }
    lines.push('');
  }

  lines.push('### Per-trip cost — TWO attributions, not interchangeable', '');
  if (result.trips === null) {
    lines.push(
      '- **VOID** — the closed round-trip denominator is unknown, so no per-trip figure is printed.',
      '',
    );
  } else {
    const notional = notionalFor(result);
    const denom =
      `over ${result.trips} closed round trip(s) (${result.tripsSource})` +
      (notional === null ? '' : `, mean one-way notional $${notional.toFixed(2)}`);
    lines.push(
      `- **AMORTIZED AVERAGE** — ${usd2(result.perTrip.amortizedUsd)}/trip ` +
        `(${fmtBps(result.perTrip.amortizedBps)} of one-way notional), ${denom}.`,
      '  Answers: _does this book pay for itself?_ Full precision (a quotient, so not exact): ' +
        `${usd(result.perTrip.amortizedUsd)}.`,
    );
    if (notional !== null) {
      lines.push(`  Notional basis: ${result.notionalBasis ?? 'UNSTATED'}`);
    }
    const m = result.perTrip.marginal;
    if (m === null) {
      lines.push('- **CONSULT-CHAIN MARGINAL** — not computed (consult probe failed).');
    } else {
      lines.push(
        `- **CONSULT-CHAIN MARGINAL** — bracket, ${denom}:`,
        `  - upper bound (trade-action consults charged in FULL, ${m.tradeConsults} consult(s)): ` +
          `${usd2(m.upperPerTripUsd)}/trip (${fmtBps(result.perTrip.marginalUpperBps)})`,
        `  - pro-rata (same consults, sliced by trade-action rows / fan-out): ` +
          `${usd2(m.proRataPerTripUsd)}/trip (${fmtBps(result.perTrip.marginalProRataBps)})`,
        `  - cadence-only consults (${m.cadenceConsults} consult(s), no trade action): ` +
          `${usd2(m.cadenceOnlyUsd)} total — spend NO trip caused`,
      );
    }
    lines.push(
      '',
      '_Both numbers are true and they answer different questions._ The amortized average is the one',
      'the objective function needs — `net-of-cost PnL = realizedPnl − fees − llmCostUsd` divides the',
      "book cost across the book's trips, and that is the figure to compare against the 9.29 bps/trip",
      'fee floor. The marginal bracket above is NOT that figure and must never be substituted for it.',
      '',
      "**The true counterfactual marginal cost of ONE MORE TRIP is near ZERO.** The lane's consult",
      'cadence is TIME-driven — a consult fires when a bar closes, whether or not a position exists —',
      'so one more trip does not buy one more consult. The cadence-only line above is the direct',
      'evidence: that spend happened with no trade action attached to it at all. Reading the marginal',
      'as "what a trip costs" would therefore understate the book cost by design, which is exactly why',
      'the amortized figure is printed first and why neither number is ever printed alone.',
      '',
    );
  }

  lines.push('### Unpriceable rows', '');
  if (result.unpriceableRows === null) {
    lines.push(
      '- **UNKNOWN** — the probe failed. Not zero: the unmeasured tail is itself unmeasured.',
      '',
    );
  } else {
    lines.push(`- \`unpriceable_rows\` = **${result.unpriceableRows}** (billable classes only)`);
    for (const u of result.unpriceableClasses) {
      lines.push(
        `  - ${u.billable ? 'BILLABLE' : 'not billable'} \`${u.klass}\` — ${u.rows} row(s): ${u.detail}`,
      );
    }
    lines.push('');
  }

  if (result.annotations.length > 0) {
    lines.push('### Annotations', '');
    for (const a of result.annotations) lines.push(`- **${a.kind}** — ${a.detail}`);
    lines.push('');
  }
  return lines.join('\n');
}
