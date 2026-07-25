// CI-safe unit coverage for the pure helpers in test/eval/agentic/trade-eval-fixtures.ts — this
// path IS on the always-on `pnpm test` gate (vitest run test/unit test/livegate), unlike the
// eval-only *.spec.ts files under test/eval/agentic that require paid API env vars to run at all.
// Pure functions only: no network, no DB, no env leakage beyond what a test itself saves/restores.
import { describe, it, expect } from 'vitest';
import {
  directionalForwardProxyBps,
  evaluateHeadToHeadVerdict,
  isTradeSane,
  corpusFingerprint,
  withSyntheticCapabilities,
  resolveModelRoute,
  SYNTHETIC_PERP_CAPS,
  type TradeToolDecision,
  type TradeModelCandidateResult,
} from '../../../eval/agentic/trade-eval-fixtures';
import { EVAL_PROFILE } from '../../../eval/agentic/fixtures';
import type { ScoringRow } from '../../../../src/features/strategy/agentic/counterfactual-scoring';
import { epochMs } from '../../../../src/domain/common/types/ids';

const T = 1_700_000_000_000;

// Mirrors test/unit/agentic-strategy/counterfactual-scoring.spec.ts's own row() helper exactly —
// same convention, same defaults.
function row(index: number, over: Partial<ScoringRow> = {}): ScoringRow {
  return {
    eventTime: epochMs(T + index * 60_000),
    action: 'hold',
    confidence: null,
    refPrice: null,
    close: null,
    playbookVersion: 1,
    promptHash: 'hash-a',
    model: 'test-model',
    symbol: 'BTC/USDT',
    ...over,
  };
}

describe('directionalForwardProxyBps', () => {
  it('groups interleaved rows from two symbols per-symbol before combining — cross-symbol bleed would change this number', () => {
    // BTC and ETH interleaved in event-time order; each symbol's own entries bucket sees only its
    // own price path. If rows leaked across symbols (the #37/5da2630 defect class), row0's forward
    // return would read row1's ETH close (50) instead of row2's BTC close (110) — a very different
    // number from the correctly-grouped one asserted below.
    const rows: ScoringRow[] = [
      row(0, { symbol: 'BTC/USDT', action: 'open_long', close: '100' }),
      row(1, { symbol: 'ETH/USDT', action: 'open_long', close: '50' }),
      row(2, { symbol: 'BTC/USDT', action: 'hold', close: '110' }), // BTC entry fwd: (110-100)/100=+0.10
      row(3, { symbol: 'ETH/USDT', action: 'hold', close: '55' }), // ETH entry fwd: (55-50)/50=+0.10
    ];
    // Per symbol: entries.count=1, meanForwardReturnPct=10 (percent). Combined across both symbols:
    // count=2, weightedPctSum=10+10=20 -> (20/2)*100 = 1000 bps.
    expect(directionalForwardProxyBps(rows)).toBe(1000);
  });

  it('negates a shortEntries forward return so a profitable short contributes POSITIVE edge', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'open_long', close: '100' }), // FLAT->LONG (entries)
      row(1, { action: 'close', close: '110' }), // LONG->FLAT; gives row0 fwd=(110-100)/100=+0.10
      row(2, { action: 'open_short', close: '100' }), // FLAT->SHORT (shortEntries)
      row(3, { action: 'hold', close: '90' }), // gives row2 raw fwd=(90-100)/100=-0.10 (short profited)
    ];
    // entries: count=1, mean=+10%. shortEntries: count=1, RAW mean=-10%, negated to +10% before
    // combining. Un-negated, the short's -10% would net against the long's +10% to exactly 0 —
    // asserting a nonzero positive 1000 proves the negation ran.
    expect(directionalForwardProxyBps(rows)).toBe(1000);
  });

  it('returns null when every row is a hold (no entries or shortEntries in any symbol group)', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'hold', close: '100' }),
      row(1, { action: 'hold', close: '105' }),
    ];
    expect(directionalForwardProxyBps(rows)).toBeNull();
  });
});

describe('evaluateHeadToHeadVerdict', () => {
  function result(overrides: Partial<TradeModelCandidateResult> = {}): TradeModelCandidateResult {
    return {
      model: 'model-x',
      rowsReplayed: 200,
      schemaValidRate: 0.95,
      tradeSanityRate: 0.9,
      proposeCount: 100,
      proposeRate: 0.5,
      directionalForwardProxyBps: 10,
      costPerDecideUsd: 0.02,
      corpusFingerprint: 'fp-shared',
      ...overrides,
    };
  }

  it('passes all five criteria when the candidate clears every threshold', () => {
    const baseline = result({
      model: 'baseline',
      schemaValidRate: 0.9,
      tradeSanityRate: 0.8,
      directionalForwardProxyBps: 10,
      proposeRate: 0.5,
      costPerDecideUsd: 0.02,
    });
    const candidate = result({
      model: 'candidate',
      schemaValidRate: 0.95,
      tradeSanityRate: 0.85,
      directionalForwardProxyBps: 9, // >= baseline(10) - 2
      proposeRate: 0.6, // ratio 1.2, in [0.5, 1.5]
      costPerDecideUsd: 0.015,
    });

    const verdict = evaluateHeadToHeadVerdict(candidate, baseline);
    expect(verdict.criteria.every((c) => c.pass === true)).toBe(true);
    expect(verdict.pass).toBe(true);
  });

  it('sinks a criterion to pass:null (never true or silently skipped) when either side is null, and that alone fails the overall verdict', () => {
    const baseline = result({ model: 'baseline', tradeSanityRate: 0.8 });
    const candidate = result({ model: 'candidate', tradeSanityRate: null });

    const verdict = evaluateHeadToHeadVerdict(candidate, baseline);
    const tradeSanityCriterion = verdict.criteria.find((c) =>
      c.criterion.includes('trade sanity'),
    )!;
    expect(tradeSanityCriterion.pass).toBeNull();
    expect(verdict.pass).toBe(false);
    // Every other criterion still individually passes — the null sinks ONLY its own criterion.
    const otherCriteria = verdict.criteria.filter((c) => c !== tradeSanityCriterion);
    expect(otherCriteria.every((c) => c.pass === true)).toBe(true);
  });

  it('a baseline proposeRate of 0 sinks the propose-ratio criterion to null (never a divide-by-zero) and fails overall', () => {
    const baseline = result({ model: 'baseline', proposeRate: 0 });
    const candidate = result({ model: 'candidate' });

    const verdict = evaluateHeadToHeadVerdict(candidate, baseline);
    const ratioCriterion = verdict.criteria.find((c) =>
      c.criterion.includes('propose-rate ratio'),
    )!;
    expect(ratioCriterion.pass).toBeNull();
    expect(verdict.pass).toBe(false);
  });

  it('refuses to compare scorecards from different corpus slices, throwing a message that names the fingerprints', () => {
    const baseline = result({ model: 'baseline', corpusFingerprint: 'fp-a' });
    const candidate = result({ model: 'candidate', corpusFingerprint: 'fp-b' });

    expect(() => evaluateHeadToHeadVerdict(candidate, baseline)).toThrow(/fingerprint/i);
  });
});

describe('isTradeSane', () => {
  // EVAL_PROFILE: makerBps=10, takerBps=10 -> fee floor = (10+10)/10000 = 0.002.
  it('takeProfitPct exactly at the fee floor (0.002) passes (gte, not gt)', () => {
    const decision: TradeToolDecision = {
      action: 'open_long',
      takeProfitPct: 0.002,
      entry: { style: 'maker', offsetBps: 5 },
    };
    expect(isTradeSane(decision, EVAL_PROFILE)).toBe(true);
  });

  it('takeProfitPct just below the fee floor (0.0019) fails', () => {
    const decision: TradeToolDecision = {
      action: 'open_long',
      takeProfitPct: 0.0019,
      entry: { style: 'maker', offsetBps: 5 },
    };
    expect(isTradeSane(decision, EVAL_PROFILE)).toBe(false);
  });

  it('a taker entry with offsetBps 0 passes', () => {
    const decision: TradeToolDecision = {
      action: 'open_long',
      takeProfitPct: 0.01,
      entry: { style: 'taker', offsetBps: 0 },
    };
    expect(isTradeSane(decision, EVAL_PROFILE)).toBe(true);
  });

  it('a taker entry with a nonzero offsetBps fails (the tool contract requires 0 for taker)', () => {
    const decision: TradeToolDecision = {
      action: 'open_long',
      takeProfitPct: 0.01,
      entry: { style: 'taker', offsetBps: 3 },
    };
    expect(isTradeSane(decision, EVAL_PROFILE)).toBe(false);
  });

  it('a maker entry with a nonzero offsetBps passes (the taker-only offset constraint does not apply)', () => {
    const decision: TradeToolDecision = {
      action: 'open_long',
      takeProfitPct: 0.01,
      entry: { style: 'maker', offsetBps: 8 },
    };
    expect(isTradeSane(decision, EVAL_PROFILE)).toBe(true);
  });

  it.each(['hold', 'close', 'adjust'] as const)(
    'returns null for action=%s (excluded from the denominator)',
    (action) => {
      expect(isTradeSane({ action }, EVAL_PROFILE)).toBeNull();
    },
  );

  it('an open_long with a missing entry returns false (fail conservative, never vacuously sane)', () => {
    const decision: TradeToolDecision = { action: 'open_long', takeProfitPct: 0.01 };
    expect(isTradeSane(decision, EVAL_PROFILE)).toBe(false);
  });

  it('an open_long with a missing takeProfitPct returns false', () => {
    const decision: TradeToolDecision = {
      action: 'open_long',
      entry: { style: 'maker', offsetBps: 0 },
    };
    expect(isTradeSane(decision, EVAL_PROFILE)).toBe(false);
  });
});

describe('corpusFingerprint', () => {
  it('is deterministic over the same input', () => {
    const rows = [
      { id: 'a', eventTime: 1 },
      { id: 'b', eventTime: 2 },
    ];
    const sameRows = [
      { id: 'a', eventTime: 1 },
      { id: 'b', eventTime: 2 },
    ];
    expect(corpusFingerprint(rows)).toBe(corpusFingerprint(sameRows));
  });

  it('changes when row order changes', () => {
    const rows = [
      { id: 'a', eventTime: 1 },
      { id: 'b', eventTime: 2 },
    ];
    const reordered = [
      { id: 'b', eventTime: 2 },
      { id: 'a', eventTime: 1 },
    ];
    expect(corpusFingerprint(rows)).not.toBe(corpusFingerprint(reordered));
  });
});

describe('withSyntheticCapabilities', () => {
  it('injects exactly the caps block into a payload with no existing capabilities key', () => {
    const payloadJson = JSON.stringify({ foo: 'bar' });
    const patched = withSyntheticCapabilities(payloadJson, SYNTHETIC_PERP_CAPS);
    const parsed = JSON.parse(patched) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['capabilities', 'foo']);
    expect(parsed['foo']).toBe('bar');
    expect(parsed['capabilities']).toEqual({
      venue: String(SYNTHETIC_PERP_CAPS.venue),
      shorts: SYNTHETIC_PERP_CAPS.shorts,
      leverage: SYNTHETIC_PERP_CAPS.leverage,
      maxSizeFraction: SYNTHETIC_PERP_CAPS.maxSizeFraction,
      venueFreeCash: SYNTHETIC_PERP_CAPS.venueFreeCash,
    });
  });

  it('returns a payload that already carries a capabilities key byte-identical (untouched)', () => {
    const payloadJson = JSON.stringify({ capabilities: { existing: true } });
    const patched = withSyntheticCapabilities(payloadJson, SYNTHETIC_PERP_CAPS);
    expect(patched).toBe(payloadJson);
  });
});

describe('resolveModelRoute', () => {
  const ROUTE_ENV_KEYS = [
    'AGENTIC_EVAL_MODEL_ROUTES_JSON',
    'AGENTIC_EVAL_BASE_URL',
    'AGENTIC_EVAL_API_KEY',
    'ANTHROPIC_API_KEY',
    'AGENTIC_EVAL_CALL_DELAY_MS',
    'ROUTE_TEST_KEY',
  ] as const;

  // Save/restore ONLY the keys a test sets — never leaks into other suites in the same worker.
  function withEnv(
    vars: Partial<Record<(typeof ROUTE_ENV_KEYS)[number], string>>,
    fn: () => void,
  ): void {
    const prev: Partial<Record<string, string | undefined>> = {};
    for (const k of ROUTE_ENV_KEYS) prev[k] = process.env[k];
    for (const k of ROUTE_ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    try {
      fn();
    } finally {
      for (const k of ROUTE_ENV_KEYS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  it('resolves baseUrl, apiKeyEnv indirection, and callDelayMs from a per-model route', () => {
    withEnv(
      {
        AGENTIC_EVAL_MODEL_ROUTES_JSON: JSON.stringify({
          'model-a': {
            baseUrl: 'https://foo.example/anthropic/',
            apiKeyEnv: 'ROUTE_TEST_KEY',
            callDelayMs: 250,
          },
        }),
        ROUTE_TEST_KEY: 'secret-123',
      },
      () => {
        const route = resolveModelRoute('model-a');
        expect(route.baseUrl).toBe('https://foo.example/anthropic'); // trailing slash stripped
        expect(route.apiKey).toBe('secret-123');
        expect(route.callDelayMs).toBe(250);
        expect(route.isDefaultBase).toBe(false);
      },
    );
  });

  it('malformed AGENTIC_EVAL_MODEL_ROUTES_JSON throws', () => {
    withEnv({ AGENTIC_EVAL_MODEL_ROUTES_JSON: '{not valid json' }, () => {
      expect(() => resolveModelRoute('model-a')).toThrow(/not valid JSON/);
    });
  });

  it('an unrecognized route field rejects (strict schema — Fix D)', () => {
    withEnv(
      {
        AGENTIC_EVAL_MODEL_ROUTES_JSON: JSON.stringify({
          'model-a': { baseUrl: 'https://foo.example', apiKeyEvn: 'TYPO_OF_apiKeyEnv' },
        }),
      },
      () => {
        expect(() => resolveModelRoute('model-a')).toThrow(/failed validation/);
      },
    );
  });

  it('a per-model route with baseUrl but no apiKeyEnv resolves apiKey undefined — never falls back to the global key chain (Fix D)', () => {
    withEnv(
      {
        AGENTIC_EVAL_MODEL_ROUTES_JSON: JSON.stringify({
          'model-a': { baseUrl: 'https://foo.example' },
        }),
        ANTHROPIC_API_KEY: 'org-key-must-not-leak-to-third-party-host',
      },
      () => {
        const route = resolveModelRoute('model-a');
        expect(route.apiKey).toBeUndefined();
      },
    );
  });

  it('a malformed global AGENTIC_EVAL_CALL_DELAY_MS throws rather than silently dropping the delay (Fix E)', () => {
    withEnv({ AGENTIC_EVAL_CALL_DELAY_MS: 'not-a-number' }, () => {
      expect(() => resolveModelRoute('model-a')).toThrow(/AGENTIC_EVAL_CALL_DELAY_MS/);
    });
  });
});
