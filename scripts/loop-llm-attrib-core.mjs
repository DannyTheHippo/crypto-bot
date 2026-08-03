#!/usr/bin/env node
// PER-TRIP LLM COST ATTRIBUTION — PURE logic. No I/O, no clock, no process/env access, and it NEVER
// throws: given the per-model token sums, the rate table, the consult fan-out rows and the trip
// count the runner probed, derive the book LLM cost, both per-trip attributions, and the disclosures
// that name everything the data could not price. The runner (loop-llm-attrib.mjs) only gathers rows
// and renders what this returns.
//
// STATUS 2026-08-03 — INCOMPLETE, UNVERIFIED, UNWIRED. This core landed but its three companions did
// NOT: there is no loop-llm-attrib.mjs runner, no offline spec, and no `loop:llm-attrib` entry in
// package.json. Nothing imports it, so it cannot affect the gate or the runtime — but no number it
// produces has ever been checked against the book, and the cross-check against the evaluate() tuple's
// llmCostUsd that would validate it has not been run. Do not cite its output until the spec exists.
//
// WHY THIS EXISTS. The book's objective is `net-of-cost PnL = realizedPnl − fees − llmCostUsd`, but
// NO per-trip statistic anywhere contains the LLM term. promotion-readiness.service.ts:136-139 fixes
// `winRate` on `realizedPnl − feesQuote` and carries llmCostUsd at BOOK level only — a deliberate,
// documented choice, but the consequence is that the largest per-trip cost term is invisible by
// construction. The measured fee floor is ~9 bps/trip and the whole program optimises against it;
// this instrument's job is to put the LLM term on the same page, in the same units, permanently.
//
// FAILURE DIRECTION — this is a MEASUREMENT, so it fails toward OVERSTATEMENT, LOUDLY, and NEVER
// toward a flattering silence. A zero printed by this module always means a MEASURED zero; absent
// data is always visibly absent. Concretely:
//   * an unknown / unpriced model is charged the MOST EXPENSIVE configured rate per component
//     (`resolveRates` below mirrors promotion-readiness.service.ts's `ratesFor` fold) — a model the
//     operator never priced can only ever OVER-count;
//   * rows that attempted a client call and carry NULL tokens are reported as a named
//     `unpriceable_rows` count, never folded in as zero;
//   * a transport failure, an unreadable rate table, or an unreadable model fold voids the WHOLE
//     reading as `MEASUREMENT-VOID` — it is never rendered as `$0.00`;
//   * an unknown trip count voids the PER-TRIP figures by name while still reporting the book cost —
//     a book number divided by a guessed denominator is the exact defect this instrument exists to
//     stop, so the denominator is never guessed.
// It emits no alarms and carries no gate: a broken measurement must never block the thing it
// measures.
//
// MONEY EXACTNESS (root CLAUDE.md hard rule 1). Token counts are exact integers and arrive already
// summed by the database (bigint SUM, exact). Every USD product is decimal.js — already a scripts
// dependency (scripts/loop-sweep-core.mjs:32, scripts/loop-authoring.mjs:32) — never a native float,
// and never `parseFloat`/`Number()`. The per-component fold below is `Decimal(tokens).div(1e6)
// .mul(rate)`, ORDER-IDENTICAL to promotion-readiness.service.ts:167-171, which is what makes the
// cross-check in `crossCheck` a real equality test rather than a rounding-tolerance test. The only
// native-float numbers this module touches are COUNTS (rows, trips, fan-out) and the bps RATIO,
// which is a dimensionless presentation figure derived from Decimals and rendered to one decimal.

import Decimal from 'decimal.js';

/** Tokens are quoted per million everywhere in this codebase's rate config. */
export const MTOK = new Decimal(1_000_000);

/**
 * The actions that make a decision row TRADE-CAUSING rather than cadence.
 *
 * `hold` is excluded deliberately and it is the whole argument of the marginal number below: a hold
 * consult fires because the bar closed, not because a trip existed. `error` is excluded because an
 * errored consult produced no action at all (and is separately disclosed as unpriceable when the
 * client was actually called).
 */
export const TRADE_ACTIONS = ['open_long', 'open_short', 'close', 'adjust'];

/** USD rendered at full precision — `toFixed()` with no argument on a Decimal is exact, never rounded. */
export const usd = (d) => (d === null || d === undefined ? 'n/a' : `$${d.toFixed()}`);

/** USD rendered to cents, for figures a human compares at a glance. The exact value is always
 *  available alongside; this is presentation only and is labelled as such wherever it is printed. */
export const usd2 = (d) => (d === null || d === undefined ? 'n/a' : `$${d.toFixed(2)}`);

/**
 * A cost per unit notional, in basis points. Dimensionless, so a native Number is correct here —
 * but it is derived from Decimals and only ever rendered, never re-entered into money arithmetic.
 * Returns null (never 0) when the denominator is unknown: a bps figure with no notional behind it
 * is not a small number, it is no number.
 */
export function bps(costUsd, notionalUsd) {
  if (costUsd === null || notionalUsd === null || notionalUsd === undefined) return null;
  const n = new Decimal(notionalUsd);
  if (!n.gt(0)) return null;
  return Number(costUsd.div(n).mul(10_000).toFixed(4));
}

export const fmtBps = (v) =>
  v === null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`;

function annotation(kind, detail) {
  return { kind, detail };
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
 * measurement it does not have.
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
      input: new Decimal(e.inputPerMtok),
      output: new Decimal(e.outputPerMtok),
      cacheRead: new Decimal(e.cacheReadPerMtok ?? '0'),
      cacheWrite: new Decimal(e.cacheWritePerMtok ?? '0'),
      resolution,
    };
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (!out[k].isFinite()) return null;
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
 */
export function costOf(totals, rates) {
  return new Decimal(totals.inputTokens ?? 0)
    .div(MTOK)
    .mul(rates.input)
    .plus(new Decimal(totals.outputTokens ?? 0).div(MTOK).mul(rates.output))
    .plus(new Decimal(totals.cacheReadTokens ?? 0).div(MTOK).mul(rates.cacheRead))
    .plus(new Decimal(totals.cacheCreationTokens ?? 0).div(MTOK).mul(rates.cacheWrite));
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
 *                     TRIP BOUNDARIES note on `tripsSource` below.
 * @param tripsSource  free text naming where `trips` came from. Required whenever trips is non-null:
 *                     a denominator whose provenance is unstated is a denominator nobody can check.
 * @param gaugeLlmCostUsd  the live `agentic_promotion_llm_cost_usd` gauge as a string, or null. This
 *                     is PromotionReadinessService.evaluate()'s own llmCostUsd, published from ONE
 *                     evaluate() call, and the cross-check against it is what validates both sides.
 * @param consultRows  [{ consultId, fanout, tradeActionRows, model, inputTokens, outputTokens,
 *                        cacheReadTokens, cacheCreationTokens }] or null.
 * @param unpriceable  [{ klass, rows, detail }] or null when the probe failed.
 * @param oneWayNotionalUsd  mean one-way fill notional in quote USD, as a string, or null.
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
  consultRows,
  unpriceable,
  oneWayNotionalUsd,
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
  let anyUnpricedModel = false;
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
    if (rates.resolution === 'max_of_configured') anyUnpricedModel = true;
    byModel.push({ ...m, rates, cost, resolution: rates.resolution });
    bookCost = bookCost.plus(cost);
  }
  byModel.sort((a, b) => b.cost.comparedTo(a.cost) || a.model.localeCompare(b.model));

  const maxPricedWithTokens = byModel.filter(
    (m) => m.resolution === 'max_of_configured' && m.cost.gt(0),
  );
  if (maxPricedWithTokens.length > 0) {
    annotations.push(
      annotation(
        'llm_attrib_unpriced_model_charged_max',
        `${maxPricedWithTokens.length} model(s) carry tokens but have NO configured rate entry and ` +
          'were charged the MOST EXPENSIVE configured rate per component (the fail-toward-' +
          `overstatement rule): ${maxPricedWithTokens.map((m) => `${m.model} → ${usd(m.cost)}`).join(', ')}. ` +
          'These figures are UPPER BOUNDS, not measurements — price the model in ' +
          'AGENTIC_TOKEN_PRICES_JSON to turn them into measurements',
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
  if (anyUnpricedModel === false && byModel.length === 0) {
    annotations.push(
      annotation(
        'llm_attrib_no_token_rows',
        'the probe succeeded and found ZERO token-bearing rows in the window — this IS a ' +
          'determinate reading (a measured zero), distinct from the void reads above',
      ),
    );
  }

  // ── cross-check against the gate's own published cost ──────────────────────────────────────────
  let crossCheck;
  if (gaugeLlmCostUsd === null || gaugeLlmCostUsd === undefined || gaugeLlmCostUsd === '') {
    crossCheck = { gauge: null, recomputed: bookCost, delta: null, verdict: 'UNAVAILABLE' };
    annotations.push(
      annotation(
        'llm_attrib_crosscheck_unavailable',
        'the `agentic_promotion_llm_cost_usd` gauge could not be read, so the recomputed book cost ' +
          'below is UNVALIDATED. Absence of a disagreement here is not agreement — the comparison ' +
          'did not run',
      ),
    );
  } else {
    const gauge = new Decimal(gaugeLlmCostUsd);
    const delta = bookCost.minus(gauge);
    crossCheck = {
      gauge,
      recomputed: bookCost,
      delta,
      verdict: delta.isZero() ? 'EXACT' : 'DISAGREE',
    };
    if (!delta.isZero()) {
      annotations.push(
        annotation(
          'llm_attrib_crosscheck_disagrees',
          `recomputed book LLM cost ${usd(bookCost)} vs the gate's published ` +
            `agentic_promotion_llm_cost_usd ${usd(gauge)} — delta ${usd(delta)}. Both sides fold ` +
            'the SAME raw token columns at the SAME rates in the SAME order, so a non-zero delta is ' +
            'a FINDING about the row window or the rate fold, not a rounding artifact. The benign ' +
            'explanation is scrape lag: the gauge is a snapshot and agent_decisions keeps growing, ' +
            'so a delta of the size of a few consults with the recompute HIGHER is the expected ' +
            'shape. A delta with the recompute LOWER, or a large one, is not',
        ),
      );
    }
  }

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
  }

  const amortizedUsd = tripCount === null ? null : bookCost.div(tripCount);

  // Consult-chain marginal. Structure verified against the live table 2026-08-03: `consult_id`
  // identifies ONE Anthropic call whose result fans out to N per-symbol decision rows (rows-per-
  // consult equals distinct-symbols-per-consult exactly, 1..8), and exactly one row per consult
  // carries the token columns. So a consult's cost is indivisible at the call level and SHARED at
  // the symbol level, which is why the marginal is reported as a BRACKET rather than a point:
  //   upper  — every consult that emitted at least one trade action, charged in FULL. Over-counts,
  //            because the same call also decided symbols that did not trade.
  //   proRata— that same consult cost times (its trade-action rows / its fan-out). The trip's
  //            per-symbol slice.
  // Both are true; neither is the counterfactual (see `cadenceOnlyUsd` and the header note the
  // renderer prints).
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
        'the unpriceable-row probe failed, so the count of rows that CALLED the client and carry ' +
          'NULL tokens is unknown. That is not zero — it means the size of the unmeasured cost tail ' +
          'is itself unmeasured, and every cost figure above is a lower bound by an unknown amount',
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
          `unpriceable_rows=${unpriceableTotal} — rows that attempted a client call and carry NULL ` +
            'token columns. Their cost is NOT in any figure above and is NOT zero: an API call that ' +
            'errored after the model produced tokens still bills. Every cost figure in this report ' +
            'is therefore a LOWER bound by this tail, which is the one place the instrument ' +
            'under-states and the reason the tail is named rather than folded in as zero',
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
    perTrip: {
      amortizedUsd,
      amortizedBps: bps(amortizedUsd, oneWayNotionalUsd),
      marginal,
      marginalUpperBps: bps(marginal?.upperPerTripUsd ?? null, oneWayNotionalUsd),
      marginalProRataBps: bps(marginal?.proRataPerTripUsd ?? null, oneWayNotionalUsd),
    },
    unpriceableRows: unpriceableTotal,
    unpriceableClasses,
    annotations,
  };
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────

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
    `_As of ${w.readAtIso ?? 'unknown'} · window ${w.epochIso ?? 'all-time'} → ` +
      `${w.lastIso ?? 'unknown'} (PROMOTION_EVIDENCE_EPOCH-anchored, `,
    `filtered on \`created_at\` exactly as the promotion evidence fold is)._',`.slice(0, 0) +
      '_' +
      'filtered on `created_at` exactly as the promotion evidence fold is)._',
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
      `- recomputed ${usd(cc.recomputed)} vs published ${usd(cc.gauge)} — ` +
        `**${cc.verdict}** (delta ${usd(cc.delta)})`,
      '',
    );
  }

  lines.push('### Per-trip cost — TWO attributions, not interchangeable', '');
  if (result.trips === null) {
    lines.push(
      '- **VOID** — the closed round-trip denominator is unknown, so no per-trip figure is printed.',
      '',
    );
  } else {
    const notional = result.oneWayNotionalUsd;
    const denom =
      `over ${result.trips} closed round trip(s) (${result.tripsSource})` +
      (notional === null ? '' : `, mean one-way notional $${new Decimal(notional).toFixed(2)}`);
    lines.push(
      `- **AMORTIZED AVERAGE** — ${usd2(result.perTrip.amortizedUsd)}/trip ` +
        `(${fmtBps(result.perTrip.amortizedBps)} of one-way notional), ${denom}.`,
      '  Answers: _does this book pay for itself?_ Exact: ' +
        `${usd(result.perTrip.amortizedUsd)}.`,
    );
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
      '_the objective function needs_ — `net-of-cost PnL = realizedPnl − fees − llmCostUsd` divides the',
      "book cost across the book's trips, and that is the figure to compare against the ~9 bps/trip fee",
      'floor. The marginal bracket above is NOT that figure and must never be substituted for it.',
      '',
      "**The true counterfactual marginal is near ZERO.** The lane's consult cadence is TIME-driven —",
      'a consult fires when a bar closes, whether or not a position exists — so one more trip does not',
      'buy one more consult. The cadence-only line above is the direct evidence: that spend happened',
      'with no trade action attached to it at all. Reading the marginal as "what a trip costs" would',
      'therefore understate the book cost by design, which is exactly why the amortized figure is',
      'printed first and why neither number is ever printed alone.',
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
