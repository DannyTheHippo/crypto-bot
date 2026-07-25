import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  runCandidateBacktest,
  simulateRoundTrip,
  type CandidateBacktestConfig,
} from '../../../src/features/trading/agentic/candidate-backtest';
import type { AgentDecisionRow, AgentDirectives } from '../../../src/ports/agentic-strategy';
import { strategyId, symbolId, venueId, epochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');

function row(overrides: Partial<AgentDecisionRow> = {}): AgentDecisionRow {
  const id = overrides.id ?? 'row-0';
  return {
    strategyId: SID,
    symbol: symbolId('BTC/USDT'),
    venue: venueId('binance'),
    triggerKind: 'candle',
    basedOnSeq: 1n,
    eventTime: epochMs(T),
    model: 'claude-sonnet-5',
    action: 'hold',
    confidence: 0.5,
    rationale: '',
    refPrice: null,
    close: '100',
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    playbookVersion: 1,
    promptHash: 'hash',
    inputPayload: JSON.stringify({ marker: id, position: { side: 'FLAT' } }),
    id,
    createdAt: epochMs(T),
    ...overrides,
  };
}

const DIRECTIVES: AgentDirectives = {
  sizeFraction: '0.10',
  stopLossPct: '0.02',
  takeProfitPct: '0.04',
  entryOffsetBps: 10,
  entryValidityBars: 2,
  maxHoldBars: 3,
  entryStyle: 'maker',
};

describe('simulateRoundTrip', () => {
  it('returns null (unsimulatable) below MIN_FORWARD_COVERAGE (25% of maxHoldBars, rounded up)', () => {
    // maxHoldBars=3 → ceil(3*0.25)=1 forward point required; 0 supplied.
    expect(simulateRoundTrip('100', DIRECTIVES, [], 'LONG')).toBeNull();
  });

  it('exits at take-profit on the first bar that clears entry*(1+takeProfitPct) and nets exact bps (LONG)', () => {
    // entry 100, takeProfitPct 0.04 → TP price 104 exactly.
    const result = simulateRoundTrip('100', DIRECTIVES, ['104', '101.92'], 'LONG');
    expect(result).not.toBeNull();
    // netFraction = 104/100 − 1 − 0.0020 = 0.04 − 0.002 = 0.038 → 380 bps exactly. These bps figures
    // are plain indicator-grade numbers derived from exact Decimal arithmetic (never a money-string
    // path — see this file's own header comment), so an exact `toBe` is both correct and precise; the
    // repo's blanket toBeCloseTo ban (CLAUDE.md rule 1, money-assertion discipline) is syntactic and
    // would otherwise flag this non-money float comparison too (same convention as
    // test/backtest/indicators.spec.ts's own expectCloseTo escape hatch — exact here, so no helper
    // needed).
    expect(result!.netBps).toBe(380);
  });

  it('exits at stop on the first bar at/below entry*(1−stopLossPct) and nets exact bps (LONG)', () => {
    // entry 104, stopLossPct 0.02 → stop price 104*0.98 = 101.92 exactly.
    const result = simulateRoundTrip('104', DIRECTIVES, ['101.92'], 'LONG');
    expect(result).not.toBeNull();
    // netFraction = 101.92/104 − 1 − 0.0020 = −0.02 − 0.002 = −0.022 → −220 bps exactly.
    expect(result!.netBps).toBe(-220);
  });

  it('falls back to the LAST available forward close when data runs out before any executor exit fires', () => {
    // maxHoldBars=3, coverage floor=1; supply exactly 2 forward closes, neither breaches stop/TP.
    const result = simulateRoundTrip('100', DIRECTIVES, ['100.5', '101'], 'LONG');
    expect(result).not.toBeNull();
    // netFraction = 101/100 − 1 − 0.0020 = 0.01 − 0.002 = 0.008 → 80 bps exactly.
    const expected = new Decimal('101').div('100').minus(1).minus('0.0020').mul(10_000).toNumber();
    expect(expected).toBe(80);
    expect(result!.netBps).toBe(expected);
  });

  it('exits on max_hold exactly when forward data covers the full maxHoldBars window', () => {
    const flatCloses = ['100.5', '100.5', '100.5']; // maxHoldBars=3, never breaches stop/TP
    const result = simulateRoundTrip('100', DIRECTIVES, flatCloses, 'LONG');
    expect(result).not.toBeNull();
    // netFraction = 100.5/100 − 1 − 0.0020 = 0.005 − 0.002 = 0.003 → 30 bps exactly.
    const expected = new Decimal('100.5')
      .div('100')
      .minus(1)
      .minus('0.0020')
      .mul(10_000)
      .toNumber();
    expect(expected).toBe(30);
    expect(result!.netBps).toBe(expected);
  });

  it('P3: SHORT mirrors LONG — exits at take-profit BELOW entry and nets a POSITIVE bps on a decline', () => {
    // entry 100, takeProfitPct 0.04 → SHORT TP price 96 exactly (mirrors the LONG TP-above formula).
    const result = simulateRoundTrip('100', DIRECTIVES, ['96', '98'], 'SHORT');
    expect(result).not.toBeNull();
    // netFraction = 100/96 − 1 − 0.0020 (entry/exit inverted vs LONG's exit/entry).
    const expected = new Decimal('100').div('96').minus(1).minus('0.0020').mul(10_000).toNumber();
    expect(result!.netBps).toBe(expected);
    expect(result!.netBps).toBeGreaterThan(0); // a short profits when price fell
  });

  it('P3: SHORT exits at stop ABOVE entry and nets a NEGATIVE bps on a rally', () => {
    // entry 100, stopLossPct 0.02 → SHORT stop price 102 exactly.
    const result = simulateRoundTrip('100', DIRECTIVES, ['102'], 'SHORT');
    expect(result).not.toBeNull();
    const expected = new Decimal('100').div('102').minus(1).minus('0.0020').mul(10_000).toNumber();
    expect(result!.netBps).toBe(expected);
    expect(result!.netBps).toBeLessThan(0);
  });
});

// ── runCandidateBacktest fixtures ──────────────────────────────────────────

interface DirectivesInput {
  readonly sizeFraction: number;
  readonly entry: { readonly style: 'maker' | 'taker'; readonly offsetBps: number };
  readonly entryValidityBars: number;
  readonly stopLossPct: number;
  readonly takeProfitPct: number;
  readonly maxHoldBars: number;
}

type RowAction = 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold';

function tradeToolBody(action: RowAction, directives?: DirectivesInput): unknown {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_bt',
        name: 'submit_trade',
        input: {
          action,
          ...(directives ?? {}),
        },
      },
    ],
    usage: { input_tokens: 8, output_tokens: 8 },
  };
}

function apiResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

interface RowArmResponse {
  readonly action: RowAction;
  readonly directives?: DirectivesInput;
}

// Dispatches by (a) which playbook block rode in the request (candidate vs champion — detected via a
// marker substring unique to each) and (b) which row's `marker` field is embedded in the row payload
// text — the two axes a shared fake fetch has to distinguish requests on in this suite's design.
function buildFetch(
  responses: Record<string, { candidate: RowArmResponse; champion: RowArmResponse }>,
): typeof fetch {
  const impl: typeof fetch = (_url, init) => {
    const body = JSON.parse(init?.body as string) as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    const content = body.messages[0]!.content;
    const playbookText = content[0]!.text ?? '';
    const rowText = content[1]!.text ?? '';
    const arm: 'candidate' | 'champion' = playbookText.includes('CANDIDATE_PB_MARKER')
      ? 'candidate'
      : 'champion';
    const rowIdMatch = /"marker":"([^"]+)"/.exec(rowText);
    const rowId = rowIdMatch![1]!;
    const resp = responses[rowId]![arm];
    return Promise.resolve(apiResponse(tradeToolBody(resp.action, resp.directives)));
  };
  return impl;
}

function cfg(over: Partial<CandidateBacktestConfig> = {}): CandidateBacktestConfig {
  return {
    apiKey: 'sk-test',
    model: 'claude-sonnet-5',
    timeoutMs: 5000,
    sizeFractionMax: '0.15',
    candidatePlaybook: 'CANDIDATE_PB_MARKER content',
    championPlaybook: 'CHAMPION_PB_MARKER content',
    ...over,
  };
}

const OPEN_LONG_INPUT: DirectivesInput = {
  sizeFraction: 0.1,
  entry: { style: 'maker', offsetBps: 10 },
  entryValidityBars: 2,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  maxHoldBars: 3,
};

describe('runCandidateBacktest', () => {
  it('returns {skipped} on an empty row set', async () => {
    const result = await runCandidateBacktest(cfg(), [], buildFetch({}));
    expect(result).toEqual({ skipped: 'no rows to replay' });
  });

  it('computes exact per-arm consults/entries/simulated round trips/net bps and counts divergent decisions', async () => {
    // row-0 close=100: candidate opens long (plan tp=104), champion holds — divergent.
    // row-1 close=104: champion opens long (plan tp/sl off entry=104), candidate holds — divergent.
    // row-2 close=101.92: both hold — not divergent.
    const rows = [
      row({ id: 'row-0', close: '100' }),
      row({ id: 'row-1', close: '104' }),
      row({ id: 'row-2', close: '101.92' }),
    ];
    const fetchFn = buildFetch({
      'row-0': {
        candidate: { action: 'open_long', directives: OPEN_LONG_INPUT },
        champion: { action: 'hold' },
      },
      'row-1': {
        candidate: { action: 'hold' },
        champion: { action: 'open_long', directives: OPEN_LONG_INPUT },
      },
      'row-2': { candidate: { action: 'hold' }, champion: { action: 'hold' } },
    });

    const result = await runCandidateBacktest(cfg(), rows, fetchFn);
    if ('skipped' in result) throw new Error('expected a measurement, got skipped');

    expect(result.candidate.consults).toBe(3);
    expect(result.candidate.entries).toBe(1);
    expect(result.candidate.simulatedRoundTrips).toBe(1);
    expect(result.candidate.unsimulatableEntries).toBe(0);
    // row-0 entry=100, forward=[104, 101.92] → TP hit bar1 at 104 → +380bps (exact — see
    // simulateRoundTrip's own tests above for why toBe, not toBeCloseTo, is correct here).
    expect(result.candidate.meanNetBps).toBe(380);
    expect(result.candidate.totalNetBps).toBe(380);

    expect(result.champion.consults).toBe(3);
    expect(result.champion.entries).toBe(1);
    expect(result.champion.simulatedRoundTrips).toBe(1);
    expect(result.champion.unsimulatableEntries).toBe(0);
    // row-1 entry=104, forward=[101.92] → stop hit bar1 at 101.92 → −220bps.
    expect(result.champion.meanNetBps).toBe(-220);
    expect(result.champion.totalNetBps).toBe(-220);

    expect(result.divergentDecisions).toBe(2);
  });

  it('P3: an open_short entry is counted, simulated on the SHORT arm, and nets a positive bps on a decline', async () => {
    const rows = [row({ id: 'row-0', close: '100' }), row({ id: 'row-1', close: '96' })];
    const fetchFn = buildFetch({
      'row-0': {
        candidate: { action: 'open_short', directives: OPEN_LONG_INPUT },
        champion: { action: 'hold' },
      },
      'row-1': { candidate: { action: 'hold' }, champion: { action: 'hold' } },
    });

    const result = await runCandidateBacktest(cfg({ shortsEnabled: true }), rows, fetchFn);
    if ('skipped' in result) throw new Error('expected a measurement, got skipped');

    expect(result.candidate.entries).toBe(1);
    expect(result.candidate.simulatedRoundTrips).toBe(1);
    expect(result.candidate.meanNetBps).toBeGreaterThan(0);
  });

  it('excludes an open_long+directives entry on the LAST row of its symbol group (zero forward closes) as unsimulatable', async () => {
    const rows = [row({ id: 'row-0', close: '100' }), row({ id: 'row-1', close: '101' })];
    const fetchFn = buildFetch({
      'row-0': { candidate: { action: 'hold' }, champion: { action: 'hold' } },
      // row-1 is the LAST row of the (only) symbol group — no forward closes exist for it.
      'row-1': {
        candidate: { action: 'open_long', directives: OPEN_LONG_INPUT },
        champion: { action: 'hold' },
      },
    });

    const result = await runCandidateBacktest(cfg(), rows, fetchFn);
    if ('skipped' in result) throw new Error('expected a measurement, got skipped');

    expect(result.candidate.entries).toBe(1);
    expect(result.candidate.simulatedRoundTrips).toBe(0);
    expect(result.candidate.unsimulatableEntries).toBe(1);
  });

  it('#37 lesson: never mixes symbols — a BTC entry only ever walks LATER BTC closes, never interleaved ETH rows', async () => {
    // Interleaved BTC/ETH rows. If the forward walk ever leaked ETH's close=1 into the BTC row-0
    // entry's walk (stop price 98), it would stop out immediately at a wildly different bps — this
    // test's exact-380bps assertion below would fail under that bug.
    const rows = [
      row({ id: 'btc-0', symbol: symbolId('BTC/USDT'), close: '100' }),
      row({ id: 'eth-0', symbol: symbolId('ETH/USDT'), close: '1' }),
      row({ id: 'btc-1', symbol: symbolId('BTC/USDT'), close: '104' }),
      row({ id: 'eth-1', symbol: symbolId('ETH/USDT'), close: '1' }),
    ];
    const fetchFn = buildFetch({
      'btc-0': {
        candidate: { action: 'open_long', directives: OPEN_LONG_INPUT },
        champion: { action: 'hold' },
      },
      'eth-0': { candidate: { action: 'hold' }, champion: { action: 'hold' } },
      'btc-1': { candidate: { action: 'hold' }, champion: { action: 'hold' } },
      'eth-1': { candidate: { action: 'hold' }, champion: { action: 'hold' } },
    });

    const result = await runCandidateBacktest(cfg(), rows, fetchFn);
    if ('skipped' in result) throw new Error('expected a measurement, got skipped');

    expect(result.candidate.consults).toBe(4);
    expect(result.candidate.entries).toBe(1);
    expect(result.candidate.simulatedRoundTrips).toBe(1);
    // Forward closes for btc-0 must be ['104'] (btc-1's close) ONLY — never eth-0's '1'. A
    // symbol-mixing bug would walk close='1' on bar1 (stop=98) and net roughly −9920bps instead.
    expect(result.candidate.meanNetBps).toBe(380);
    expect(result.divergentDecisions).toBe(1); // only btc-0 (long vs hold); every other row agrees
  });

  it('THROWS on a malformed forward close — the hazard runMintBacktest wraps fail-open (documented, not swallowed here)', async () => {
    // In production every close is a Postgres NUMERIC, so this is near-unreachable — but the
    // caller's veto-only contract depends on the wrap, so the raw throwing behavior is pinned
    // here where it is actually reachable (the reflection-level path converts closes in earlier
    // evidence machinery first, so a journal-level malformed close can never reach the wrap).
    const rows = [row({ id: 'row-0', close: '100' }), row({ id: 'row-1', close: 'not-a-close' })];
    const fetchFn = buildFetch({
      'row-0': {
        candidate: { action: 'open_long', directives: OPEN_LONG_INPUT },
        champion: { action: 'hold' },
      },
      'row-1': { candidate: { action: 'hold' }, champion: { action: 'hold' } },
    });

    await expect(runCandidateBacktest(cfg(), rows, fetchFn)).rejects.toThrow(/Invalid argument/);
  });

  it('reuses cachedChampionReplays: the champion arm makes ZERO fetch calls and reproduces identical numbers', async () => {
    const rows = [row({ id: 'row-0', close: '100' }), row({ id: 'row-1', close: '104' })];
    const responses = {
      'row-0': {
        candidate: { action: 'hold' as const },
        champion: { action: 'open_long' as const, directives: OPEN_LONG_INPUT },
      },
      'row-1': { candidate: { action: 'hold' as const }, champion: { action: 'hold' as const } },
    };
    let championFetches = 0;
    const base = buildFetch(responses);
    const countingFetch: typeof fetch = (url, init) => {
      // replayPlanRow always sends a JSON-string body; anything else counts as not-champion.
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('CHAMPION_PB_MARKER')) championFetches += 1;
      return base(url, init);
    };

    const first = await runCandidateBacktest(cfg(), rows, countingFetch);
    if ('skipped' in first) throw new Error('expected a measurement');
    expect(championFetches).toBe(2);

    const second = await runCandidateBacktest(cfg(), rows, countingFetch, first.championReplays);
    if ('skipped' in second) throw new Error('expected a measurement');
    expect(championFetches).toBe(2); // unchanged — champion arm never re-fetched
    expect(second.champion).toEqual({ ...first.champion, usages: first.champion.usages });
    expect(second.champion.meanNetBps).toBe(first.champion.meanNetBps);

    // A length mismatch (corpus changed) ignores the cache and re-replays.
    const third = await runCandidateBacktest(
      cfg(),
      rows,
      countingFetch,
      first.championReplays.slice(0, 1),
    );
    if ('skipped' in third) throw new Error('expected a measurement');
    expect(championFetches).toBe(4);
  });
});
