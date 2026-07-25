// W4.3 — zero-LLM offline parameter sweep for the plan executor (plan-executor.ts). Grid-runs
// {stopLossPct × takeProfitPct × entryValidityBars × maxHoldBars} against recorded candle paths
// with bar-level conservative fill assumptions and flat 10/10bps fees, ranking combos by mean net
// return fraction. TOY RESEARCH METRIC (same caveats as counterfactual-scoring.ts): bar closes
// only — no intrabar stop/TP resolution — so results seed executor defaults, never certify them.
// CI-safe on the checked-in fixtures; feed real rows via:
//   SELECT input_payload FROM agent_decisions WHERE input_payload IS NOT NULL ORDER BY id;
//
// LEGACY CONTRACT PIN (S2/B1 v2 retype): this sweep's public grid/SweepResult stays on the retired
// v1 AgentPlan shape (no sizeFraction/entryStyle) — it measures the retired submit_plan contract,
// same as the sibling PLAN_TOOL-pinned specs. `plan-executor.ts`'s evaluatePlan was retyped to
// AgentDirectives (v2) in B1; toAgentDirectives() below adapts at the call boundary only. The two
// v2-only fields it fills (sizeFraction, entryStyle) are inert placeholders — evaluatePlan's
// stop/take-profit/max-hold/entry-validity arithmetic reads only stopLossPct/takeProfitPct/
// maxHoldBars/entryValidityBars, unchanged by the v2 retype, so the toy metric's behavior is
// unaffected by the adapter.
import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { evaluatePlan } from '../../../src/features/strategy/agentic/plan-executor';
import type { AgentDirectives, AgentPlan } from '../../../src/ports/strategy/agentic-strategy';
import { RECORDED_PAYLOAD_ROWS, type RecordedMarketPayload } from './recorded-payload-fixtures';

// Inert placeholders — see header note: evaluatePlan never reads these v2-only fields.
function toAgentDirectives(plan: AgentPlan): AgentDirectives {
  return { ...plan, sizeFraction: '1', entryStyle: 'taker' };
}

const ROUND_TRIP_FEE_FRACTION = new Decimal('0.002'); // 10bps maker + 10bps taker

export interface SweepResult {
  readonly plan: AgentPlan;
  readonly trades: number;
  readonly meanNetReturn: string; // fraction, Decimal string
}

// One pass of a single plan over one candle path: enter at the first bar (entry = close×(1−offset)),
// fill on the first later bar whose close ≤ entry (conservative: closes only, no lows), then hand
// each subsequent bar to the real executor until it exits or the path ends (open-at-end excluded —
// same openAtEnd discipline as counterfactual-scoring).
function runPlanOverPath(plan: AgentPlan, closes: readonly string[]): Decimal | null {
  if (closes.length < 3) return null;
  const entryTarget = new Decimal(closes[0]!).mul(
    new Decimal(1).minus(new Decimal(plan.entryOffsetBps).div(10_000)),
  );
  let entryPrice: string | null = null;
  let barsElapsed = 0;
  for (let i = 1; i < closes.length; i += 1) {
    barsElapsed += 1;
    const close = closes[i]!;
    if (entryPrice === null && new Decimal(close).lte(entryTarget)) {
      entryPrice = close; // conservative: filled at the close that crossed, not the better target
    }
    const verdict = evaluatePlan({
      state: { plan: toAgentDirectives(plan), entryPrice, planStartedBar: 0, barsElapsed },
      closePrice: close,
      positionSide: entryPrice === null ? 'FLAT' : 'LONG',
      hasRestingEntry: entryPrice === null,
    });
    if (verdict.type === 'cancel_entry' || verdict.type === 'plan_expired') return null;
    if (verdict.type === 'exit') {
      return new Decimal(close).minus(entryPrice!).div(entryPrice!).minus(ROUND_TRIP_FEE_FRACTION);
    }
  }
  return null; // still open (or never filled) at path end — excluded, not guessed
}

export function sweepPlanParams(
  payloadRows: readonly string[],
  grid: {
    stopLossPct: readonly string[];
    takeProfitPct: readonly string[];
    entryValidityBars: readonly number[];
    maxHoldBars: readonly number[];
  },
): SweepResult[] {
  const paths = payloadRows.map((row) => {
    const payload = JSON.parse(row) as RecordedMarketPayload;
    return payload.candles.map((c) => c[4]); // close column
  });

  const results: SweepResult[] = [];
  for (const stopLossPct of grid.stopLossPct) {
    for (const takeProfitPct of grid.takeProfitPct) {
      for (const entryValidityBars of grid.entryValidityBars) {
        for (const maxHoldBars of grid.maxHoldBars) {
          const plan: AgentPlan = {
            entryOffsetBps: 5,
            stopLossPct,
            takeProfitPct,
            entryValidityBars,
            maxHoldBars,
          };
          let sum = new Decimal(0);
          let trades = 0;
          for (const closes of paths) {
            const net = runPlanOverPath(plan, closes);
            if (net !== null) {
              sum = sum.plus(net);
              trades += 1;
            }
          }
          results.push({
            plan,
            trades,
            meanNetReturn: trades > 0 ? sum.div(trades).toFixed(6) : '0',
          });
        }
      }
    }
  }
  // Rank best-first by mean net return (Decimal compare, never float subtraction on the strings).
  return results.sort((a, b) => new Decimal(b.meanNetReturn).comparedTo(a.meanNetReturn));
}

describe('plan-executor offline parameter sweep (W4.3)', () => {
  it('grid-runs the recorded fixtures and ranks combos best-first', () => {
    const ranked = sweepPlanParams(RECORDED_PAYLOAD_ROWS, {
      stopLossPct: ['0.01', '0.02'],
      takeProfitPct: ['0.01', '0.03'],
      entryValidityBars: [2, 4],
      maxHoldBars: [8, 24],
    });

    expect(ranked).toHaveLength(16);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(new Decimal(ranked[i - 1]!.meanNetReturn).gte(ranked[i]!.meanNetReturn)).toBe(true);
    }
  });

  it('excludes never-filled and open-at-end paths instead of fabricating outcomes', () => {
    // A monotonically rising path can never fill a below-close entry: zero trades, zero return.
    const rising = JSON.stringify({
      symbol: 'BTC/USDT',
      candles: Array.from({ length: 12 }, (_, i) => [
        i,
        String(100 + i),
        String(100 + i),
        String(100 + i),
        String(100 + i),
        '1',
      ]),
    });
    const [top] = sweepPlanParams([rising], {
      stopLossPct: ['0.02'],
      takeProfitPct: ['0.03'],
      entryValidityBars: [2],
      maxHoldBars: [8],
    });
    expect(top!.trades).toBe(0);
    expect(top!.meanNetReturn).toBe('0');
  });
});

// Live-corpus sweep (2026-07-12): the header's "feed real rows via SQL" recipe, made runnable.
// Gated exactly like the sibling live evals — SWEEP_LIVE=1 + DATABASE_URL, self-skips otherwise;
// read-only against agent_decisions (never a reset), so the production URL is legitimate here.
// The grid is pre-filtered to LIVE-PROPOSABLE combos only (the plan gate's floors: SL >= 20bps fee
// fraction, TP >= 1.5x fee edge floor, TP/SL >= 1.5 RR) so every ranked row maps to a plan the
// model could actually submit. TOY RESEARCH METRIC (bar closes only) — seeds defaults, never
// certifies them.
const SWEEP_LIVE = process.env['SWEEP_LIVE'] === '1';
const SWEEP_DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!SWEEP_LIVE || !SWEEP_DB_URL)('plan-param sweep over the LIVE corpus', () => {
  it('ranks proposable combos over all recorded input_payload rows', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: SWEEP_DB_URL });
    try {
      const res = await pool.query<{ input_payload: string; symbol: string }>(
        'SELECT input_payload, symbol FROM agent_decisions WHERE input_payload IS NOT NULL ORDER BY id',
      );
      const rows = res.rows.map((r) => r.input_payload);
      expect(rows.length).toBeGreaterThan(0);
      const perSymbol = new Map<string, number>();
      for (const r of res.rows) perSymbol.set(r.symbol, (perSymbol.get(r.symbol) ?? 0) + 1);

      const grid = {
        stopLossPct: ['0.005', '0.0075', '0.01', '0.015', '0.02', '0.03'],
        takeProfitPct: ['0.0075', '0.01', '0.015', '0.02', '0.03', '0.045'],
        entryValidityBars: [2, 4, 8],
        maxHoldBars: [8, 16, 32, 64],
      };
      const FEE = new Decimal('0.002');
      const EDGE_FLOOR = new Decimal('1.5').mul(FEE);
      const MIN_RR = new Decimal('1.5');
      const proposable = (slp: string, tpp: string): boolean => {
        const sl = new Decimal(slp);
        const tp = new Decimal(tpp);
        return sl.gte(FEE) && tp.gte(EDGE_FLOOR) && tp.div(sl).gte(MIN_RR);
      };
      const ranked = sweepPlanParams(rows, grid).filter((r) =>
        proposable(r.plan.stopLossPct, r.plan.takeProfitPct),
      );
      expect(ranked.length).toBeGreaterThan(0);

      const fmt = (r: SweepResult): string =>
        `SL=${r.plan.stopLossPct} TP=${r.plan.takeProfitPct} validity=${r.plan.entryValidityBars} hold=${r.plan.maxHoldBars} trades=${r.trades} meanNet=${r.meanNetReturn}`;
      const lines = [
        `[live-sweep] corpus rows=${rows.length} per-symbol: ${[...perSymbol.entries()].map(([s, n]) => `${s}=${n}`).join(' ')}`,
        '[live-sweep] TOP 10 proposable combos:',
        ...ranked.slice(0, 10).map((r) => `  ${fmt(r)}`),
        '[live-sweep] BOTTOM 5:',
        ...ranked.slice(-5).map((r) => `  ${fmt(r)}`),
      ];
      console.log(lines.join('\n'));
      // vitest's console interception can swallow stdout in run mode — a durable artifact wins
      // (same rationale as AGENTIC_EVAL_SCORECARD_FILE on the sibling evals).
      const outFile = process.env['SWEEP_OUTPUT_FILE'];
      if (outFile) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
      }
    } finally {
      await pool.end();
    }
  });
});
