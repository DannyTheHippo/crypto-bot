// LLM-in-the-loop backtest runner — driven ONLY by scripts/backtest-agentic.mjs (never run directly,
// and NEVER swept by `pnpm backtest` — see the BACKTEST_AGENTIC_RUN gate below). This file exists,
// rather than a plain .mjs importing runAgenticReplay directly, because agentic-replay.ts (like every
// other test/backtest/*.ts module) has no compiled dist output — the whole test/backtest/ research
// tree is only ever executed through vitest's on-the-fly TS transform (see vitest.config.ts's swc
// plugin), the same way `pnpm backtest` runs every other *.spec.ts here. The .mjs wrapper does CLI
// arg-parsing, OHLCV cache resolution, and playbook-content resolution, then spawns
// `vitest run test/backtest/agentic-replay-runner.spec.ts` with the resolved inputs threaded through
// env vars — this file is the actual call site of runAgenticReplay.
//
// GATED on BACKTEST_AGENTIC_RUN=1 (set only by the .mjs wrapper): `pnpm backtest` (vitest run
// test/backtest) would otherwise sweep this file up like any other *.spec.ts and attempt a REAL,
// billed Anthropic call with no operator present to have chosen a $ budget — the same reasoning
// test/eval/agentic/*-live.spec.ts gates on EVAL_LIVE=1.
import { writeFileSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { runAgenticReplay, EARLIEST_ALLOWED_MS, type AgenticReplayOpts } from './agentic-replay';
import type { Bar } from './harness';
import type { CandleInterval } from '../../src/domain/types/market-events';

const RUN = process.env['BACKTEST_AGENTIC_RUN'] === '1';
const API_KEY = process.env['ANTHROPIC_API_KEY'];

describe.skipIf(!RUN)(
  'agentic-replay runner (invoked only by scripts/backtest-agentic.mjs)',
  () => {
    it('runs the LLM-in-the-loop walk-forward backtest and writes the scorecard', async () => {
      if (!API_KEY) throw new Error('ANTHROPIC_API_KEY is required — refusing to run without one');

      const symbol = process.env['BACKTEST_AGENTIC_SYMBOL'];
      const timeframe = process.env['BACKTEST_AGENTIC_TIMEFRAME'] as CandleInterval | undefined;
      const ohlcvFile = process.env['BACKTEST_AGENTIC_OHLCV_FILE'];
      const playbookFile = process.env['BACKTEST_AGENTIC_PLAYBOOK_FILE'];
      const outFile = process.env['BACKTEST_AGENTIC_OUT'];
      const maxUsd = process.env['BACKTEST_AGENTIC_MAX_USD'];
      const model = process.env['BACKTEST_AGENTIC_MODEL'];
      const fromMsRaw = process.env['BACKTEST_AGENTIC_FROM_MS'];
      const toMsRaw = process.env['BACKTEST_AGENTIC_TO_MS'];
      if (
        !symbol ||
        !timeframe ||
        !ohlcvFile ||
        !playbookFile ||
        !outFile ||
        !maxUsd ||
        !model ||
        !fromMsRaw ||
        !toMsRaw
      ) {
        throw new Error(
          'agentic-replay-runner: missing required BACKTEST_AGENTIC_* env vars — invoke via scripts/backtest-agentic.mjs, not directly',
        );
      }
      const fromMs = Number(fromMsRaw);
      const toMs = Number(toMsRaw);

      const allBars = JSON.parse(readFileSync(ohlcvFile, 'utf8')) as Bar[];
      const bars = allBars.filter((b) => b[0]! >= fromMs && b[0]! <= toMs);
      expect(bars.length).toBeGreaterThan(0);
      expect(bars[0]![0]!).toBeGreaterThanOrEqual(EARLIEST_ALLOWED_MS);

      const playbookContent = readFileSync(playbookFile, 'utf8');

      const opts: AgenticReplayOpts = {
        symbol,
        interval: timeframe,
        bars,
        playbookContent,
        model,
        apiKey: API_KEY,
        maxUsd,
      };
      const result = await runAgenticReplay(opts);

      const scorecard = JSON.stringify(result, null, 2);
      writeFileSync(outFile, scorecard);
      console.log(scorecard);
      console.log(
        `agentic-replay: barsUsed=${result.barsUsed}/${result.barsSupplied} decisions=${result.decisionsRequested} accepted=${result.decisionsAccepted} spend=$${result.spendUsd}/${result.maxUsd} aborted=${result.aborted} roundTrips=${result.totals.roundTrips} netBpsPerRT=${result.totals.netBpsPerRoundTrip ?? 'n/a'}`,
      );
    }, 600_000); // few hundred sequential calls at a few seconds each comfortably fits inside 10 minutes. // Generous fixed ceiling — the $ budget (maxUsd), not wall-clock, is the run's real limiter; a
  },
);
