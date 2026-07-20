// R1 historical-replay PRACTICE HARNESS — engine + EXCLUSION-PROOF specs. Offline (no network): every
// case injects a scripted fetchFn returning a v2 submit_trade envelope, so no ANTHROPIC_API_KEY is
// ever needed. These run on the PRODUCTION gate (test/unit) — the exclusion proofs are the safety net
// against a replay run poisoning promotion evidence or a lane's epoch cost, so they must never sit off
// the gate with the rest of the research tree.
import { describe, it, expect, vi } from 'vitest';
import {
  runAgenticReplayR1,
  EARLIEST_ALLOWED_MS,
  type AgenticReplayR1Opts,
} from '../../backtest/agentic-replay-r1';
import { InMemoryAgentDecisionJournal } from '../../../src/database/repositories/in-memory-agent-decision-journal';
import { REPLAY_STRATEGY_ID_PREFIX } from '../../../src/ports/agentic-strategy';
import type { AgentDecisionEntry } from '../../../src/ports/agentic-strategy';
import { strategyId, symbolId, venueId, epochMs } from '../../../src/domain/types/ids';
import type { Bar } from '../../backtest/harness';

const HOUR = 3_600_000;
const T0 = EARLIEST_ALLOWED_MS + 24 * HOUR; // one day past the training-cutoff floor

// A gently trending synthetic candle series — the values are immaterial (the scripted decide never
// reads them); only the count and the training-cutoff-safe timestamps matter here.
function fixtureBars(n: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i;
    bars.push([T0 + i * HOUR, base, base + 1, base - 1, base + 0.5, 10]);
  }
  return bars;
}

const OPEN_LONG_DIRECTIVES = {
  sizeFraction: 0.1,
  entry: { style: 'maker' as const, offsetBps: 10 },
  entryValidityBars: 2,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  maxHoldBars: 3,
};

function tradeToolResponse(
  action: 'open_long' | 'hold',
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 8, output_tokens: 8 },
): Response {
  const body = {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_r1',
        name: 'submit_trade',
        input: { action, ...(action === 'open_long' ? OPEN_LONG_DIRECTIVES : {}) },
      },
    ],
    usage,
  };
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function baseOpts(over: Partial<AgenticReplayR1Opts> = {}): AgenticReplayR1Opts {
  return {
    runId: 'run1',
    symbol: 'BTC/USDT',
    interval: '1h',
    bars: fixtureBars(6),
    playbookContent: 'R1_TEST_PLAYBOOK content',
    model: 'claude-test-model',
    apiKey: 'sk-test',
    maxUsd: '5',
    journal: new InMemoryAgentDecisionJournal(),
    fetchFn: vi.fn(() => Promise.resolve(tradeToolResponse('open_long'))),
    ...over,
  };
}

describe('runAgenticReplayR1 — engine behavior', () => {
  it('refuses bars that predate the training-cutoff floor (memorization confound)', async () => {
    const early: Bar[] = [[EARLIEST_ALLOWED_MS - HOUR, 100, 101, 99, 100, 10]];
    await expect(runAgenticReplayR1(baseOpts({ bars: early }))).rejects.toThrow(/training-cutoff/);
  });

  it('journals every decision under a replay-<runId> strategyId and reports the run', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    const report = await runAgenticReplayR1(baseOpts({ journal, runId: 'abc' }));

    expect(report.strategyId).toBe(`${REPLAY_STRATEGY_ID_PREFIX}abc`);
    expect(report.decisionsJournaled).toBe(6);
    expect(report.decisionsRequested).toBe(6);
    expect(report.aborted).toBe(false);
    // Every open_long entry priced through the candidate-backtest fill model for the RUN REPORT only.
    expect(report.entries).toBe(6);
    expect(report.simulatedRoundTrips + report.unsimulatableEntries).toBe(6);

    const synthetic = await journal.recentSynthetic(100);
    expect(synthetic.length).toBe(6);
    expect(synthetic.every((r) => r.strategyId === `${REPLAY_STRATEGY_ID_PREFIX}abc`)).toBe(true);
    // playbookVersion NULL keeps synthetic rows out of every versioned/attribution read.
    expect(synthetic.every((r) => r.playbookVersion === null)).toBe(true);
  });

  it('the decide request carries the DECIDE model id (cfg.model — R8-8: never a different model)', async () => {
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValue(tradeToolResponse('open_long'));
    await runAgenticReplayR1(
      baseOpts({ model: 'claude-under-study-9', fetchFn: fetchFn as unknown as typeof fetch }),
    );
    const firstBody = JSON.parse((fetchFn.mock.calls[0]![1] as { body: string }).body) as {
      model: string;
    };
    expect(firstBody.model).toBe('claude-under-study-9');
  });

  it('the per-run USD cap aborts BEFORE the breaching decide (pre-call reservation, not after)', async () => {
    // One call costs input 1M tok × $3/MTok = $3, far over the $0.00001 cap. The FIRST call is
    // reserved at $0 spend, then records $3; the SECOND bar's reservation fails ⇒ abort before it.
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        tradeToolResponse('open_long', { input_tokens: 1_000_000, output_tokens: 0 }),
      ),
    );
    const report = await runAgenticReplayR1(
      baseOpts({ maxUsd: '0.00001', fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toBe('ABORTED_BUDGET');
    expect(report.decisionsRequested).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1); // the breaching 2nd call never fired
    expect(report.barsUsed).toBe(1);
  });
});

// The exclusion proofs: fixture replay rows PRESENT ⇒ the reads that feed promotion/cost/attribution
// ignore them. promotion-stats.fillsForMode, RoundTripEvidence, version-pnl and exec-quality are
// excluded BY CONSTRUCTION (this engine writes NO fills and NO llm_usage rows — it has no such
// dependency to write through); the journal reads below are the FILTER-based exclusions.
describe('runAgenticReplayR1 — exclusion proofs (synthetic rows never leak into live reads)', () => {
  it('lane-wide recent() excludes replay rows; a real lane row still surfaces', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    const realRow: AgentDecisionEntry = {
      strategyId: strategyId('agentic-1'),
      symbol: symbolId('BTC/USDT'),
      venue: venueId('binance'),
      triggerKind: 'candle',
      basedOnSeq: 1n,
      eventTime: epochMs(T0),
      model: 'claude-sonnet-5',
      action: 'hold',
      confidence: null,
      rationale: 'real',
      refPrice: null,
      close: '100',
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      playbookVersion: 1,
      promptHash: 'h',
      inputPayload: null,
    };
    journal.record(realRow);
    await runAgenticReplayR1(baseOpts({ journal, runId: 'abc' }));

    // Lane-wide (mint-floor corpus) read: only the real row, never the 6 synthetic ones.
    const laneWide = await journal.recent(100);
    expect(laneWide.length).toBe(1);
    expect(laneWide[0]!.strategyId).toBe('agentic-1');

    // Per-strategy read for a real lane instance: excluded by construction (no prefix match).
    const scoped = await journal.recent(100, 'agentic-1');
    expect(scoped.length).toBe(1);

    // recentSynthetic is the ONLY read that surfaces the replay rows.
    const synthetic = await journal.recentSynthetic(100);
    expect(synthetic.length).toBe(6);
    expect(synthetic.every((r) => r.strategyId.startsWith(REPLAY_STRATEGY_ID_PREFIX))).toBe(true);
  });

  it('two replay runs coexist without either leaking into lane-wide reads', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    await runAgenticReplayR1(baseOpts({ journal, runId: 'runA', bars: fixtureBars(3) }));
    await runAgenticReplayR1(baseOpts({ journal, runId: 'runB', bars: fixtureBars(3) }));

    expect((await journal.recent(100)).length).toBe(0); // lane-wide sees no synthetic rows
    expect((await journal.recentSynthetic(100)).length).toBe(6); // both runs surface here
  });
});
