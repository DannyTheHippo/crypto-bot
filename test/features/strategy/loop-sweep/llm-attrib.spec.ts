import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure core is a decimal.js-only .mjs with no declaration file. Same bridge
// forward-return.spec.ts uses for computeForwardReturn.
import * as coreModule from '../../../../scripts/loop-llm-attrib-core.mjs';

// Per-trip LLM cost attribution (`pnpm loop:llm-attrib`). $0 offline — no database, no clock, no env.
//
// What this spec pins is the FAIL DIRECTION and the never-a-clean-zero discipline. The instrument
// exists because the book's objective is `realizedPnl − fees − llmCostUsd` while NO per-trip
// statistic contains the LLM term (promotion-readiness.service.ts:136-139 fixes winRate on
// `realizedPnl − feesQuote` and carries LLM cost at BOOK level only), so every way this thing could
// quietly print a flattering number is a defect worth a regression test:
//   * a failed probe must VOID, never render $0.00 — an absence that reads as a clean reading is the
//     defect class this loop keeps rediscovering;
//   * an unpriced model must be charged the MOST EXPENSIVE configured rate, never skipped;
//   * a NULL-token row must be classified, never folded in as zero — and a zero must be a MEASURED
//     zero, distinguishable from an absent probe;
//   * a per-trip figure must never appear without its denominator, and the two attributions must
//     never appear without the label saying which is which.
//
// The book fixtures below are the REAL post-epoch fold read off the live journal 2026-08-03T22:12Z,
// so the exact-string assertions double as a pin on the numbers the study record cites
// (research/studies/llm-cost-attribution-2026-08-04.md).

interface Dec {
  toFixed(dp?: number): string;
  toNumber(): number;
}
interface Annotation {
  kind: string;
  detail: string;
}
interface ModelTotals {
  source: string;
  model: string;
  rows: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
interface RateEntry {
  inputPerMtok: string;
  outputPerMtok: string;
  cacheReadPerMtok?: string;
  cacheWritePerMtok?: string;
}
interface RateTable {
  defaults?: RateEntry;
  models?: Record<string, RateEntry>;
}
interface ConsultRow {
  consultId: string;
  model: string;
  fanout: number;
  tradeActionRows: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
interface TailRow {
  createdAtIso: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
interface UnpriceableClass {
  klass: string;
  rows: number;
  detail: string;
  billable: boolean;
}
interface CrossCheck {
  gauge: Dec | null;
  gaugeReadAtIso: string | null;
  recomputed: Dec;
  delta: Dec | null;
  verdict: 'EXACT' | 'EXACT_AT_CUT' | 'LAG_UNRESOLVED' | 'DISAGREE' | 'UNAVAILABLE';
  cutRows: number | null;
  cutAtIso: string | null;
  tailScanned: number;
  tailCost: Dec | null;
}
interface Result {
  status: 'measured' | 'MEASUREMENT-VOID';
  window: Record<string, unknown> | null;
  book: { llmCostUsd: Dec; byModel: (ModelTotals & { cost: Dec; resolution: string })[] };
  crossCheck: CrossCheck;
  trips: number | null;
  tripsSource: string | null;
  oneWayNotionalUsd: string | null;
  notionalBasis: string | null;
  perTrip: {
    amortizedUsd: Dec | null;
    amortizedBps: number | null;
    marginal: {
      tradeConsults: number;
      cadenceConsults: number;
      upperUsd: Dec;
      proRataUsd: Dec;
      cadenceOnlyUsd: Dec;
      upperPerTripUsd: Dec | null;
      proRataPerTripUsd: Dec | null;
    } | null;
    marginalUpperBps: number | null;
    marginalProRataBps: number | null;
  };
  unpriceableRows: number | null;
  unpriceableClasses: UnpriceableClass[];
  annotations: Annotation[];
}
interface Input {
  modelTotals?: ModelTotals[] | null;
  rateTable?: RateTable | null;
  trips?: number | null;
  tripsSource?: string | null;
  gaugeLlmCostUsd?: string | null;
  gaugeReadAtIso?: string | null;
  costCurveTail?: TailRow[] | null;
  consultRows?: ConsultRow[] | null;
  unpriceable?: Omit<UnpriceableClass, never>[] | null;
  oneWayNotionalUsd?: string | null;
  notionalBasis?: string | null;
  window?: Record<string, unknown> | null;
}
interface Core {
  TRADE_ACTIONS: string[];
  computeLlmAttribution: (input: Input) => Result;
  renderLlmAttribution: (r: Result) => string;
  resolveRates: (model: string, table: RateTable | null) => { resolution: string } | null;
}
const { TRADE_ACTIONS, computeLlmAttribution, renderLlmAttribution, resolveRates } =
  coreModule as unknown as Core;

const kinds = (r: Result): string[] => r.annotations.map((a) => a.kind);

// The committed rate map (.env.app:165-171): sonnet-5 3/15/0.3/6, opus-5 5/25/0.5/10 USD per Mtok.
const RATES: RateTable = {
  defaults: {
    inputPerMtok: '3',
    outputPerMtok: '15',
    cacheReadPerMtok: '0.3',
    cacheWritePerMtok: '6',
  },
  models: {
    'claude-sonnet-5': {
      inputPerMtok: '3',
      outputPerMtok: '15',
      cacheReadPerMtok: '0.3',
      cacheWritePerMtok: '6',
    },
    'claude-opus-5': {
      inputPerMtok: '5',
      outputPerMtok: '25',
      cacheReadPerMtok: '0.5',
      cacheWritePerMtok: '10',
    },
  },
};

/** The real post-epoch per-model fold, live journal 2026-08-03T22:12Z. `claude-opus-4-8` is the
 *  unpriced model the reflection path actually left behind; `prescreen`/`plan-executor` are the
 *  token-free pseudo-models the journal stamps on rows that never reached the client. */
const LIVE_TOTALS: ModelTotals[] = [
  {
    source: 'agent_decisions',
    model: 'claude-sonnet-5',
    rows: 2109,
    inputTokens: 4320625,
    outputTokens: 410712,
    cacheReadTokens: 4950523,
    cacheCreationTokens: 524832,
  },
  {
    source: 'llm_usage',
    model: 'claude-opus-4-8',
    rows: 58,
    inputTokens: 463269,
    outputTokens: 79327,
    cacheReadTokens: 140788,
    cacheCreationTokens: 9788,
  },
  {
    source: 'llm_usage',
    model: 'claude-opus-5',
    rows: 11,
    inputTokens: 60145,
    outputTokens: 6032,
    cacheReadTokens: 52736,
    cacheCreationTokens: 6592,
  },
  {
    source: 'agent_decisions',
    model: 'plan-executor',
    rows: 1783,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  {
    source: 'agent_decisions',
    model: 'prescreen',
    rows: 40020,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
];

/** The single priced row written between the gate's 2026-08-03T22:03Z sample and the recompute —
 *  the real lag the exact-at-cut check has to peel back. Its own cost is $0.0675666. */
const LIVE_TAIL: TailRow[] = [
  {
    createdAtIso: '2026-08-03T22:00:31Z',
    model: 'claude-sonnet-5',
    inputTokens: 16108,
    outputTokens: 1122,
    cacheReadTokens: 8042,
    cacheCreationTokens: 0,
  },
];

const LIVE_UNPRICEABLE = [
  {
    klass: 'consult_sibling_of_priced_call',
    rows: 769,
    billable: false,
    detail: 'fan-out rows of an already-priced consult',
  },
  { klass: 'no_client_call', rows: 42476, billable: false, detail: 'never reached the client' },
  {
    klass: 'reflection_null_tokens',
    rows: 0,
    billable: true,
    detail: 'recorded call with no usage',
  },
];

function live(over: Partial<Input> = {}): Result {
  return computeLlmAttribution({
    modelTotals: LIVE_TOTALS,
    rateTable: RATES,
    trips: 49,
    tripsSource: 'agentic_promotion_round_trips gauge',
    gaugeLlmCostUsd: '28.7683109',
    gaugeReadAtIso: '2026-08-03T22:12:28Z',
    costCurveTail: LIVE_TAIL,
    consultRows: [],
    unpriceable: LIVE_UNPRICEABLE,
    oneWayNotionalUsd: '84.42609410',
    notionalBasis: 'Σ(price×qty) ÷ 2×trips',
    window: { epochIso: '2026-07-21T11:21:00Z', readAtIso: '2026-08-03T22:12:28Z' },
    ...over,
  });
}

describe('loop-llm-attrib-core — the book fold', () => {
  it('recomputes the live book cost to the exact cent-and-beyond string', () => {
    const r = live();
    expect(r.status).toBe('measured');
    expect(r.book.llmCostUsd.toFixed()).toBe('28.7683109');
  });

  it('prices each model at its OWN rates and sorts the biggest cost first', () => {
    const r = live();
    expect(r.book.byModel.map((m) => [m.model, m.cost.toFixed(), m.resolution])).toEqual([
      ['claude-sonnet-5', '23.7567039', 'mapped'],
      ['claude-opus-4-8', '4.467794', 'max_of_configured'],
      ['claude-opus-5', '0.543813', 'mapped'],
      ['plan-executor', '0', 'max_of_configured'],
      ['prescreen', '0', 'max_of_configured'],
    ]);
  });

  it('charges an UNPRICED model the most expensive configured rate and says so', () => {
    const r = live();
    expect(kinds(r)).toContain('llm_attrib_unpriced_model_charged_max');
    // At the sonnet default rates the same tokens would cost $1.7871176 less — that difference IS
    // the fail-toward-overstatement rule, and a silent fallback to defaults is the defect it stops.
    const opus48 = r.book.byModel.find((m) => m.model === 'claude-opus-4-8');
    expect(opus48?.cost.toFixed()).toBe('4.467794');
    const cheap = computeLlmAttribution({
      modelTotals: LIVE_TOTALS.filter((m) => m.model === 'claude-opus-4-8'),
      rateTable: { defaults: RATES.defaults },
      trips: null,
    });
    expect(cheap.book.llmCostUsd.toFixed()).toBe('2.6806764');
  });

  it('names token-free unpriced models as $0-because-zero-tokens, not $0-because-free', () => {
    const r = live();
    const a = r.annotations.find((x) => x.kind === 'llm_attrib_unpriced_model_zero_tokens');
    expect(a?.detail).toContain('`prescreen` (40020 row(s))');
    expect(a?.detail).toContain('not');
  });

  it('reports a genuinely empty window as a MEASURED zero, distinct from a void read', () => {
    const r = live({ modelTotals: [], costCurveTail: null, gaugeLlmCostUsd: '0' });
    expect(r.status).toBe('measured');
    expect(r.book.llmCostUsd.toFixed()).toBe('0');
    expect(kinds(r)).toContain('llm_attrib_no_token_rows');
  });
});

describe('loop-llm-attrib-core — void reads never render as $0', () => {
  it('voids when the token probe failed', () => {
    const r = live({ modelTotals: null });
    expect(r.status).toBe('MEASUREMENT-VOID');
    expect(kinds(r)).toContain('llm_attrib_token_probe_failed');
    const text = renderLlmAttribution(r);
    expect(text).toContain('MEASUREMENT-VOID');
    // No cost section at all — not a cost section reading zero. The only `$0.00` a void render is
    // allowed to contain is the sentence saying it is deliberately NOT rendering one.
    expect(text).not.toContain('### Book LLM cost');
    expect(text).toContain('deliberately not rendered as $0.00');
  });

  it('voids when no rate table could be read', () => {
    const r = live({ rateTable: null });
    expect(r.status).toBe('MEASUREMENT-VOID');
    expect(kinds(r)).toContain('llm_attrib_rates_unreadable');
    expect(renderLlmAttribution(r)).not.toContain('### Book LLM cost');
  });

  it('voids — rather than charging zero — when a model cannot be priced by ANY rule', () => {
    const r = live({
      rateTable: { defaults: { inputPerMtok: 'not-a-number', outputPerMtok: '15' } },
    });
    expect(r.status).toBe('MEASUREMENT-VOID');
    expect(kinds(r)).toContain('llm_attrib_model_unpriceable');
  });
});

describe('loop-llm-attrib-core — the cross-check against the gate', () => {
  it('reads EXACT when the recompute equals the published gauge', () => {
    const r = live();
    expect(r.crossCheck.verdict).toBe('EXACT');
    expect(r.crossCheck.delta?.toFixed()).toBe('0');
  });

  it('resolves 5-minute sample lag by peeling the cost curve to the row cut', () => {
    // The real 2026-08-03T22:03:01Z gauge reading against the 22:12Z book.
    const r = live({ gaugeLlmCostUsd: '28.7007443', gaugeReadAtIso: '2026-08-03T22:03:01Z' });
    expect(r.crossCheck.verdict).toBe('EXACT_AT_CUT');
    expect(r.crossCheck.delta?.toFixed()).toBe('0.0675666');
    expect(r.crossCheck.cutRows).toBe(1);
    expect(r.crossCheck.cutAtIso).toBe('2026-08-03T22:00:31Z');
    expect(kinds(r)).toContain('llm_attrib_crosscheck_exact_at_cut');
  });

  it('refuses to call an unresolved positive residual agreement', () => {
    const r = live({ gaugeLlmCostUsd: '20', costCurveTail: LIVE_TAIL });
    expect(r.crossCheck.verdict).toBe('LAG_UNRESOLVED');
    const a = r.annotations.find((x) => x.kind === 'llm_attrib_crosscheck_lag_unresolved');
    expect(a?.detail).toContain('NOT agreement');
  });

  it('calls a recompute BELOW the gauge a DISAGREE — the one shape lag cannot produce', () => {
    const r = live({ gaugeLlmCostUsd: '40' });
    expect(r.crossCheck.verdict).toBe('DISAGREE');
    expect(r.crossCheck.delta?.toFixed()).toBe('-11.2316891');
    expect(kinds(r)).toContain('llm_attrib_crosscheck_disagrees');
  });

  it('says UNAVAILABLE — never "agrees" — when the gauge could not be read', () => {
    const r = live({ gaugeLlmCostUsd: null });
    expect(r.crossCheck.verdict).toBe('UNAVAILABLE');
    const a = r.annotations.find((x) => x.kind === 'llm_attrib_crosscheck_unavailable');
    expect(a?.detail).toContain('not agreement');
    expect(renderLlmAttribution(r)).toContain('This is not agreement');
  });
});

describe('loop-llm-attrib-core — the two per-trip attributions', () => {
  it("divides the book by the gate's OWN trip count for the amortized average", () => {
    const r = live();
    expect(r.trips).toBe(49);
    // A quotient, so decimal.js default precision (20 significant digits), not an exact terminating
    // value — the renderer labels it "full precision" rather than "exact" for that reason.
    expect(r.perTrip.amortizedUsd?.toFixed()).toBe('0.58710838571428571429');
    expect(r.perTrip.amortizedUsd?.toFixed(2)).toBe('0.59');
    expect(r.perTrip.amortizedBps).toBe(69.5411);
  });

  it('voids EVERY per-trip figure — but not the book cost — when trips are unknown', () => {
    const r = live({ trips: null });
    expect(r.book.llmCostUsd.toFixed()).toBe('28.7683109');
    expect(r.perTrip.amortizedUsd).toBeNull();
    expect(r.perTrip.amortizedBps).toBeNull();
    expect(kinds(r)).toContain('llm_attrib_trips_unknown');
    const text = renderLlmAttribution(r);
    expect(text).toContain('$28.7683109');
    expect(text).toContain('the closed round-trip denominator is unknown');
  });

  it('discloses a trip count whose provenance the caller did not state', () => {
    expect(kinds(live({ tripsSource: null }))).toContain('llm_attrib_trips_source_unstated');
  });

  it('brackets the consult-chain marginal by full-charge and pro-rata slice', () => {
    // Two consults on one call each: one fanned out to 4 symbols of which 1 traded, one pure cadence.
    const consultRows: ConsultRow[] = [
      {
        consultId: 'c1',
        model: 'claude-sonnet-5',
        fanout: 4,
        tradeActionRows: 1,
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        consultId: 'c2',
        model: 'claude-sonnet-5',
        fanout: 8,
        tradeActionRows: 0,
        inputTokens: 2_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ];
    const r = live({ consultRows, trips: 3 });
    const m = r.perTrip.marginal!;
    expect(m.tradeConsults).toBe(1);
    expect(m.cadenceConsults).toBe(1);
    expect(m.upperUsd.toFixed()).toBe('3');
    expect(m.proRataUsd.toFixed()).toBe('0.75');
    expect(m.cadenceOnlyUsd.toFixed()).toBe('6');
    expect(m.upperPerTripUsd?.toFixed()).toBe('1');
    expect(m.proRataPerTripUsd?.toFixed()).toBe('0.25');
  });

  it('drops a malformed consult from the marginal and says the bracket now UNDER-counts', () => {
    const r = live({
      consultRows: [
        {
          consultId: 'bad',
          model: 'claude-sonnet-5',
          fanout: 0,
          tradeActionRows: 1,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
    const a = r.annotations.find((x) => x.kind === 'llm_attrib_consults_malformed');
    expect(a?.detail).toContain('UNDER-count');
  });

  it('reports a failed consult probe as not-computed, never as a marginal of zero', () => {
    const r = live({ consultRows: null });
    expect(r.perTrip.marginal).toBeNull();
    expect(kinds(r)).toContain('llm_attrib_consult_probe_failed');
    expect(renderLlmAttribution(r)).toContain('not computed (consult probe failed)');
  });

  it('never prints a per-trip figure without its attribution label and denominator', () => {
    const text = renderLlmAttribution(live());
    expect(text).toContain('**AMORTIZED AVERAGE**');
    expect(text).toContain('**CONSULT-CHAIN MARGINAL**');
    expect(text).toContain('over 49 closed round trip(s)');
    expect(text).toContain('marginal cost of ONE MORE TRIP is near ZERO');
    expect(text).toContain('must never be substituted for it');
  });
});

describe('loop-llm-attrib-core — denominators and the one under-stating axis', () => {
  it('returns no bps at all — never 0 — when the notional is unknown', () => {
    const r = live({ oneWayNotionalUsd: null, notionalBasis: null });
    expect(r.perTrip.amortizedBps).toBeNull();
    expect(kinds(r)).toContain('llm_attrib_notional_unknown');
  });

  it('discloses a notional whose construction the caller did not state', () => {
    expect(kinds(live({ notionalBasis: null }))).toContain('llm_attrib_notional_basis_unstated');
  });

  it('prints the notional basis alongside every bps figure', () => {
    expect(renderLlmAttribution(live())).toContain('Notional basis: Σ(price×qty) ÷ 2×trips');
  });
});

describe('loop-llm-attrib-core — unpriceable rows', () => {
  it('counts ONLY billable classes and reads the live tail as a MEASURED zero', () => {
    const r = live();
    expect(r.unpriceableRows).toBe(0);
    expect(kinds(r)).toContain('llm_attrib_unpriceable_rows_measured_zero');
    // The 769 fan-out siblings are printed in full so the classification can be re-checked; folding
    // them in as billable would have double-counted calls already priced in the book above.
    const text = renderLlmAttribution(r);
    expect(text).toContain('not billable `consult_sibling_of_priced_call` — 769 row(s)');
    expect(text).toContain('`unpriceable_rows` = **0**');
  });

  it('names a billable tail and calls every cost figure a LOWER bound when one appears', () => {
    const r = live({
      unpriceable: [
        {
          klass: 'consult_with_no_priced_row',
          rows: 4,
          billable: true,
          detail: 'token row missing',
        },
        ...LIVE_UNPRICEABLE,
      ],
    });
    expect(r.unpriceableRows).toBe(4);
    const a = r.annotations.find((x) => x.kind === 'llm_attrib_unpriceable_rows');
    expect(a?.detail).toContain('unpriceable_rows=4');
    expect(a?.detail).toContain('`consult_with_no_priced_row` 4');
    expect(a?.detail).toContain('LOWER bound');
  });

  it('treats a failed unpriceable probe as UNKNOWN, never as zero', () => {
    const r = live({ unpriceable: null });
    expect(r.unpriceableRows).toBeNull();
    expect(kinds(r)).toContain('llm_attrib_unpriceable_probe_failed');
    expect(renderLlmAttribution(r)).toContain('the unmeasured tail is itself unmeasured');
  });
});

describe('loop-llm-attrib-core — rate resolution mirrors the gate', () => {
  it('prefers the mapped entry, then defaults, then the most expensive configured rate', () => {
    expect(resolveRates('claude-sonnet-5', RATES)?.resolution).toBe('mapped');
    expect(resolveRates('who-is-this', RATES)?.resolution).toBe('max_of_configured');
    expect(resolveRates('who-is-this', { defaults: RATES.defaults })?.resolution).toBe('defaults');
    expect(resolveRates('who-is-this', null)).toBeNull();
  });

  it('exports the trade-action set the runner builds its SQL from', () => {
    expect(TRADE_ACTIONS).toEqual(['open_long', 'open_short', 'close', 'adjust']);
  });
});
