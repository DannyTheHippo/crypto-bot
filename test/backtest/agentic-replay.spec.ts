// Offline (no-network) unit tests for the pure pieces of the LLM-in-the-loop backtest engine —
// RESEARCH TOOLING (test/backtest/, off the production gate, run via `pnpm backtest`). Every case
// injects a scripted `fetchFn` (mirrors test/eval/agentic/fixtures.ts's scriptedFetch convention,
// reimplemented locally against PLAN_TOOL's response shape rather than imported — test/backtest and
// test/eval are separate research lanes with no established cross-import convention) so no real
// ANTHROPIC_API_KEY or network call is ever needed; the orchestrator's live smoke run is the only
// place this module talks to a real endpoint.
import { describe, it, expect } from 'vitest';
import { runAgenticReplay, EARLIEST_ALLOWED_MS } from './agentic-replay';
import type { Bar } from './harness';

const T0 = EARLIEST_ALLOWED_MS + 24 * 3_600_000; // one day past the training-cutoff floor
const HOUR = 3_600_000;

interface ScriptedRawDecision {
  readonly action: 'long' | 'flat' | 'hold';
  readonly confidence: number;
  readonly rationale?: string;
  readonly plan?: {
    readonly entryOffsetBps: number;
    readonly stopLossPct: number;
    readonly takeProfitPct: number;
    readonly entryValidityBars: number;
    readonly maxHoldBars: number;
  };
}

function fakeResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Returns the next scripted decision on each call, as a canned submit_plan tool-use response — no
// network I/O. Throws if called more times than the script provides (a mis-wired test should fail
// loudly, matching fixtures.ts's scriptedFetch convention).
function scriptedFetch(
  script: readonly ScriptedRawDecision[],
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 100, outputTokens: 20 },
): typeof fetch {
  let callIndex = 0;
  return () => {
    if (callIndex >= script.length) {
      throw new Error(`scriptedFetch: no scripted decision left for call #${callIndex}`);
    }
    const decision = script[callIndex]!;
    callIndex++;
    return Promise.resolve(
      fakeResponse({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            name: 'submit_plan',
            input: {
              action: decision.action,
              confidence: decision.confidence,
              rationale: decision.rationale ?? 'scripted rationale',
              ...(decision.plan ? { plan: decision.plan } : {}),
            },
          },
        ],
        usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
      }),
    );
  };
}

const VIABLE_PLAN = {
  entryOffsetBps: 10, // rests 10bps below the decision bar's close
  stopLossPct: 0.01,
  takeProfitPct: 0.03, // TP/SL = 3 >= minRr 1.5; TP 0.03 >= edgeFloor (1.5 * 0.002)
  entryValidityBars: 5,
  maxHoldBars: 4, // PLAN_BOUNDS floor
};

function bar(ts: number, o: number, h: number, l: number, c: number): Bar {
  return [ts, o, h, l, c, 1];
}

describe('agentic-replay (offline)', () => {
  it('fills a resting entry on a later bar low-cross and exits on take-profit', async () => {
    const bars: Bar[] = [
      bar(T0, 100, 100, 99, 100), // decision bar: entry rests at 100*(1-10/10000)=99.9
      bar(T0 + HOUR, 100, 100, 99.8, 100), // low 99.8 <= 99.9 -> fills at 99.9
      bar(T0 + 2 * HOUR, 100, 104, 100, 103), // close 103 >= TP(99.9*1.03=102.897) -> exit @ 103
    ];
    const result = await runAgenticReplay({
      symbol: 'BTC/USDT',
      interval: '1h',
      bars,
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-test',
      maxUsd: '100',
      fetchFn: scriptedFetch([{ action: 'long', confidence: 0.9, plan: VIABLE_PLAN }]),
    });

    expect(result.aborted).toBe(false);
    expect(result.decisionsRequested).toBe(1);
    expect(result.decisionsAccepted).toBe(1);
    expect(result.exitReasonCounts.take_profit).toBe(1);
    expect(result.totals.roundTrips).toBe(1);
    expect(result.totals.sign).toBe('positive');
  });

  it('exits on stop-loss when price falls through the stop after fill', async () => {
    const bars: Bar[] = [
      bar(T0, 100, 100, 99, 100),
      bar(T0 + HOUR, 100, 100, 99.8, 100), // fills at 99.9
      bar(T0 + 2 * HOUR, 100, 100, 95, 96), // close 96 <= stop(99.9*0.99=98.901) -> exit @ 96
    ];
    const result = await runAgenticReplay({
      symbol: 'BTC/USDT',
      interval: '1h',
      bars,
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-test',
      maxUsd: '100',
      fetchFn: scriptedFetch([{ action: 'long', confidence: 0.9, plan: VIABLE_PLAN }]),
    });

    expect(result.exitReasonCounts.stop).toBe(1);
    expect(result.totals.roundTrips).toBe(1);
    expect(result.totals.sign).toBe('negative');
  });

  it('exits on max-hold when neither stop nor take-profit is hit within the bar budget', async () => {
    const flatPlan = { ...VIABLE_PLAN, takeProfitPct: 0.05, maxHoldBars: 4 };
    const bars: Bar[] = [
      bar(T0, 100, 100, 99, 100),
      bar(T0 + HOUR, 100, 100, 99.8, 100), // fills at 99.9 (barsElapsed -> 1)
      bar(T0 + 2 * HOUR, 100, 100.5, 99.5, 100), // hold (-> 2)
      bar(T0 + 3 * HOUR, 100, 100.5, 99.5, 100), // hold (-> 3)
      bar(T0 + 4 * HOUR, 100, 100.5, 99.5, 100), // hold (-> 4)
      bar(T0 + 5 * HOUR, 100, 100.5, 99.5, 100), // barsElapsed 4 >= maxHoldBars 4 -> max_hold exit
    ];
    const result = await runAgenticReplay({
      symbol: 'BTC/USDT',
      interval: '1h',
      bars,
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-test',
      maxUsd: '100',
      fetchFn: scriptedFetch([{ action: 'long', confidence: 0.9, plan: flatPlan }]),
    });

    expect(result.exitReasonCounts.max_hold).toBe(1);
    expect(result.totals.roundTrips).toBe(1);
  });

  it('aborts cleanly once accumulated spend reaches maxUsd, before spending further', async () => {
    // 1,000,000 input + 1,000,000 output tokens per call = $3 + $15 = $18/call (task's stated rates).
    const bars: Bar[] = [bar(T0, 100, 100, 99, 100), bar(T0 + HOUR, 100, 100, 99, 100)];
    const result = await runAgenticReplay({
      symbol: 'BTC/USDT',
      interval: '1h',
      bars,
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-test',
      maxUsd: '10', // below one call's $18 cost
      fetchFn: scriptedFetch([{ action: 'hold', confidence: 0.1 }], {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    });

    expect(result.decisionsRequested).toBe(1);
    expect(result.spendUsd).toBe('18.000000');
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('ABORTED_BUDGET');
    expect(result.barsUsed).toBe(1); // the second bar's top-of-loop check aborts before processing it
  });

  it('rejects a plan whose stop/TP fails the fee-aware floors, downgrading to hold', async () => {
    const thinPlan = { ...VIABLE_PLAN, takeProfitPct: 0.001, stopLossPct: 0.002 }; // TP/SL=0.5 < minRr 1.5
    const bars: Bar[] = [
      bar(T0, 100, 100, 99, 100),
      bar(T0 + HOUR, 100, 100, 99.8, 100),
      bar(T0 + 2 * HOUR, 100, 104, 100, 103),
    ];
    const result = await runAgenticReplay({
      symbol: 'BTC/USDT',
      interval: '1h',
      bars,
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-test',
      maxUsd: '100',
      fetchFn: scriptedFetch([{ action: 'long', confidence: 0.9, plan: thinPlan }]),
    });

    expect(result.decisionsAccepted).toBe(0);
    expect(result.totals.roundTrips).toBe(0);
    expect(result.openPositionAtEnd).toBe(false);
  });

  it('segments the walked bars into contiguous, correctly-bounded chunks (walk-forward math)', async () => {
    const bars: Bar[] = Array.from({ length: 9 }, (_, i) => bar(T0 + i * HOUR, 100, 100, 100, 100));
    const result = await runAgenticReplay({
      symbol: 'BTC/USDT',
      interval: '1h',
      bars,
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-test',
      maxUsd: '1000',
      segments: 3,
      // Every bar stays FLAT with no plan (always 'hold') -> 9 decision calls, one per bar.
      fetchFn: scriptedFetch(
        Array.from({ length: 9 }, () => ({ action: 'hold' as const, confidence: 0.1 })),
      ),
    });

    expect(result.barsUsed).toBe(9);
    expect(result.segments).toHaveLength(3);
    expect(result.segments.map((s) => [s.fromBarIndex, s.toBarIndex])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
    expect(result.segments.every((s) => s.roundTrips === 0 && s.sign === 'n/a')).toBe(true);
    expect(result.totals.roundTrips).toBe(0);
  });

  it('refuses bars that predate the training-cutoff floor', async () => {
    const bars: Bar[] = [bar(EARLIEST_ALLOWED_MS - HOUR, 100, 100, 99, 100)];
    await expect(
      runAgenticReplay({
        symbol: 'BTC/USDT',
        interval: '1h',
        bars,
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-test',
        maxUsd: '100',
        fetchFn: scriptedFetch([]),
      }),
    ).rejects.toThrow(/training-cutoff floor/);
  });
});
