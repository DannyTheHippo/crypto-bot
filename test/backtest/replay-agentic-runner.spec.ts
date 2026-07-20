// R1 historical-replay harness runner — driven ONLY by scripts/replay-agentic.mjs (never run directly,
// and NEVER swept by `pnpm backtest` — see the REPLAY_AGENTIC_RUN gate below), mirroring
// agentic-replay-runner.spec.ts's own rationale: agentic-replay-r1.ts has no compiled dist output (the
// whole test/backtest/ research tree runs only through vitest's on-the-fly TS transform), so the .mjs
// wrapper does arg-parsing + env threading and this file is the actual call site of runAgenticReplayR1.
//
// GATED on REPLAY_AGENTIC_RUN=1 (set only by the .mjs wrapper): `pnpm backtest` would otherwise sweep
// this up like any other *.spec.ts. A DRY run (REPLAY_AGENTIC_DRY_RUN=1) needs neither a key, an OHLCV
// cache, nor a DB (fixture candles + in-memory journal + scripted decide); a real run reads the OHLCV
// cache, journals to the live agent_decisions table via DATABASE_URL, and bills real decides.
import { writeFileSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runAgenticReplayR1, EARLIEST_ALLOWED_MS } from './agentic-replay-r1';
import type { Bar } from './harness';
import type { CandleInterval } from '../../src/domain/types/market-events';
import type { AgentDecisionJournalPort } from '../../src/ports/agentic-strategy';
import { InMemoryAgentDecisionJournal } from '../../src/database/repositories/in-memory-agent-decision-journal';
import { AgentDecisionJournalAdapter } from '../../src/database/repositories/agent-decision-journal.adapter';
import * as schema from '../../src/database/schemas/trading';

const RUN = process.env['REPLAY_AGENTIC_RUN'] === '1';
const DRY = process.env['REPLAY_AGENTIC_DRY_RUN'] === '1';

const HOUR = 3_600_000;

// Dry-run fixture: a synthetic training-cutoff-safe candle series + a scripted decide that returns a
// single hold (no key, no network) — the CI-safe path scripts/replay-agentic.mjs --dry-run exercises.
function fixtureBars(n: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i;
    bars.push([
      EARLIEST_ALLOWED_MS + 24 * HOUR + i * HOUR,
      base,
      base + 1,
      base - 1,
      base + 0.5,
      10,
    ]);
  }
  return bars;
}

function scriptedHoldFetch(): typeof fetch {
  const impl: typeof fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't', name: 'submit_trade', input: { action: 'hold' } }],
          usage: { input_tokens: 4, output_tokens: 4 },
        }),
    } as unknown as Response);
  return impl;
}

describe.skipIf(!RUN)('R1 replay runner (invoked only by scripts/replay-agentic.mjs)', () => {
  it('runs the historical-replay harness and writes the run report', async () => {
    const symbol = process.env['REPLAY_AGENTIC_SYMBOL'];
    const timeframe = process.env['REPLAY_AGENTIC_TIMEFRAME'] as CandleInterval | undefined;
    const outFile = process.env['REPLAY_AGENTIC_OUT'];
    const maxUsd = process.env['REPLAY_AGENTIC_MAX_USD'];
    const model = process.env['REPLAY_AGENTIC_MODEL'];
    const runId = process.env['REPLAY_AGENTIC_RUN_ID'];
    if (!symbol || !timeframe || !outFile || !maxUsd || !model || !runId) {
      throw new Error(
        'replay-agentic-runner: missing required REPLAY_AGENTIC_* env vars — invoke via scripts/replay-agentic.mjs',
      );
    }

    let bars: Bar[];
    let playbookContent: string;
    let apiKey: string;
    let journal: AgentDecisionJournalPort;
    let fetchFn: typeof fetch | undefined;

    if (DRY) {
      bars = fixtureBars(8);
      playbookContent = 'R1_DRY_RUN_PLAYBOOK';
      apiKey = 'dry-run-no-key';
      journal = new InMemoryAgentDecisionJournal();
      fetchFn = scriptedHoldFetch();
    } else {
      const ohlcvFile = process.env['REPLAY_AGENTIC_OHLCV_FILE'];
      const playbookFile = process.env['REPLAY_AGENTIC_PLAYBOOK_FILE'];
      const key = process.env['ANTHROPIC_API_KEY'];
      const dbUrl = process.env['DATABASE_URL'];
      const fromMs = Number(process.env['REPLAY_AGENTIC_FROM_MS']);
      const toMs = Number(process.env['REPLAY_AGENTIC_TO_MS']);
      if (!ohlcvFile || !playbookFile || !key || !dbUrl) {
        throw new Error(
          'replay-agentic-runner: a real run requires OHLCV/playbook files, ANTHROPIC_API_KEY, and DATABASE_URL',
        );
      }
      const allBars = JSON.parse(readFileSync(ohlcvFile, 'utf8')) as Bar[];
      bars = allBars.filter((b) => b[0]! >= fromMs && b[0]! <= toMs);
      expect(bars.length).toBeGreaterThan(0);
      playbookContent = readFileSync(playbookFile, 'utf8');
      apiKey = key;
      // Real synthetic experience is journaled into the live agent_decisions table under
      // replay-<runId> — the whole point of a paid run (reflection later opts in via recentSynthetic).
      journal = new AgentDecisionJournalAdapter(
        drizzle(new Pool({ connectionString: dbUrl }), { schema }),
      );
      fetchFn = undefined; // real fetch
    }

    const report = await runAgenticReplayR1({
      runId,
      symbol,
      interval: timeframe,
      bars,
      playbookContent,
      model,
      apiKey,
      maxUsd,
      journal,
      fetchFn,
    });

    const json = JSON.stringify(report, null, 2);
    writeFileSync(outFile, json);
    console.log(json);
    console.log(
      `replay:agentic: strategyId=${report.strategyId} bars=${report.barsUsed}/${report.barsSupplied} decisions=${report.decisionsRequested} entries=${report.entries} spend=$${report.spendUsd}/${report.maxUsd} aborted=${report.aborted}`,
    );
  }, 600_000);
});
