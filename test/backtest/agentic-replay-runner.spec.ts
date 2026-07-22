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
// billed model call with no operator present to have chosen a $ budget — the same reasoning
// test/eval/agentic/*-live.spec.ts gates on EVAL_LIVE=1.
//
// KEY RESOLUTION: ANTHROPIC_API_KEY is the DEFAULT-route key and is deliberately NOT required here —
// a model routed to a third-party Anthropic-compat host names its own apiKeyEnv in
// BACKTEST_AGENTIC_MODEL_ROUTES_JSON and must never receive the Anthropic org key (see
// test/shared/model-routing.ts). runAgenticReplay refuses with a message naming the env var that is
// missing, so a routed run needs no ANTHROPIC_API_KEY exported and therefore cannot silently bill
// Anthropic.
import { writeFileSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { runAgenticReplay, EARLIEST_ALLOWED_MS, type AgenticReplayOpts } from './agentic-replay';
import type { Bar } from './harness';
import type { CandleInterval } from '../../src/domain/types/market-events';

const RUN = process.env['BACKTEST_AGENTIC_RUN'] === '1';

// Wall-clock ceiling for the whole run. The $ budget (maxUsd) — NOT the clock — is the real limiter:
// runAgenticReplay aborts cleanly at the cap and still RETURNS a partial scorecard, whereas a vitest
// timeout kills the process before this spec can write anything, losing both the result and the money
// already spent. A 2026-07-22 full-window run proved the old fixed 600_000 was far too low: ~980 4h
// bars at ~2.7s/bar needs ~45min, and a routed model with a per-call delay (kimi-k3's 5s) needs more
// still — both legs died at 10min having spent real budget for zero output. Default 4h, overridable
// via BACKTEST_AGENTIC_TIMEOUT_MS for an unusually long window or a slow routed host.
const TIMEOUT_MS = Number(process.env['BACKTEST_AGENTIC_TIMEOUT_MS'] ?? 14_400_000);

describe.skipIf(!RUN)(
  'agentic-replay runner (invoked only by scripts/backtest-agentic.mjs)',
  () => {
    it(
      'runs the LLM-in-the-loop walk-forward backtest and writes the scorecard',
      async () => {
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

        const modelRoutesJson = process.env['BACKTEST_AGENTIC_MODEL_ROUTES_JSON'];
        const tokenPricesJson = process.env['BACKTEST_AGENTIC_TOKEN_PRICES_JSON'];

        const opts: AgenticReplayOpts = {
          symbol,
          interval: timeframe,
          bars,
          playbookContent,
          model,
          // '' when unset — runAgenticReplay's own key check then produces the operator-facing message
          // naming which variable to export (this spec never inspects or logs a key value).
          apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
          maxUsd,
          ...(modelRoutesJson !== undefined ? { modelRoutesJson } : {}),
          ...(tokenPricesJson !== undefined ? { tokenPricesJson } : {}),
        };
        const result = await runAgenticReplay(opts);

        const scorecard = JSON.stringify(result, null, 2);
        writeFileSync(outFile, scorecard);
        console.log(scorecard);
        console.log(
          `agentic-replay: barsUsed=${result.barsUsed}/${result.barsSupplied} decisions=${result.decisionsRequested} accepted=${result.decisionsAccepted} spend=$${result.spendUsd}/${result.maxUsd} aborted=${result.aborted} roundTrips=${result.totals.roundTrips} netBpsPerRT=${result.totals.netBpsPerRoundTrip ?? 'n/a'}`,
        );
        console.log(
          `agentic-replay: shorts=${result.shortsEnabled} long=${result.pnl.long.roundTrips}rt/${result.pnl.long.netPnlQuote} short=${result.pnl.short.roundTrips}rt/${result.pnl.short.netPnlQuote} net=${result.pnl.netQuote} netOfLlmSpend=${result.pnl.netOfLlmSpendQuote}`,
        );
        console.log(
          `agentic-replay: outcomes=${JSON.stringify(result.decisionOutcomeCounts)} exits=${JSON.stringify(result.exitReasonCounts)}`,
        );
      },
      TIMEOUT_MS,
    ); // see TIMEOUT_MS's own comment — the $ cap, not the clock, bounds this run
  },
);
