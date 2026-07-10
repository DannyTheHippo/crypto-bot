// Recorded-agentic-decision replay — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Replays a flattened agent_decisions action sequence ('long'/'flat'/'hold', one row per bar) through
// the real harness fill/PnL machinery — the offline counterpart to
// src/features/trading/agentic/counterfactual-scoring.ts's toy-equity walk, but settled through
// applyFillToPosition/walkRoundTrips instead of a standalone toy fold. Rows are accepted as
// constructor input (no DB dependency — the caller reads agent_decisions itself). A plan (the
// submit_plan tool payload) is NEVER reconstructed here: plans are not persisted alongside the
// decision journal, only the flattened action survives, so this strategy can only emit a plain
// enter/exit/hold — never a stop/take-profit/max-hold managed plan (that requires
// LiveAgenticStrategy's plan-executor wiring against a live decide callback).
import type { BarStrategy, BarContext, BacktestAction } from '../strategy';

export type RecordedAction = 'long' | 'flat' | 'hold';

export interface RecordedRow {
  readonly action: RecordedAction;
}

export class RecordedAgenticStrategy implements BarStrategy {
  constructor(
    private readonly rows: readonly RecordedRow[],
    private readonly sizeHint?: string,
  ) {}

  decide(ctx: BarContext): BacktestAction {
    const row = this.rows[ctx.barIndex];
    if (!row || row.action === 'hold') return { type: 'hold' };
    const isLong = ctx.position.signedQty.gt(0);
    if (row.action === 'long' && !isLong) {
      return { type: 'enter', side: 'LONG', sizeHint: this.sizeHint };
    }
    if (row.action === 'flat' && isLong) return { type: 'exit', reason: 'recorded_flat' };
    return { type: 'hold' };
  }
}
