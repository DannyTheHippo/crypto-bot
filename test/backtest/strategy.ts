// Backtest executor port — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// The strategy-agnostic contract harness.ts drives: a BarStrategy sees only bars up to and including
// the current one (no lookahead) and proposes an action; the harness owns fills, fees, sizing, and
// settlement identically for every implementation (RuleStrategy, RecordedAgenticStrategy,
// LiveAgenticStrategy). This is a DIFFERENT, narrower port than src/ports/strategy.ts's production
// Strategy interface (which the retired src/domain/strategy/* implemented) — that port speaks
// CandleEvent/Signal against the live event bus; this one speaks plain bar arrays for offline replay.
import type { PositionState } from '../../src/domain/trading/oms/position';

export type BacktestAction =
  | { readonly type: 'enter'; readonly side: 'LONG' | 'SHORT'; readonly sizeHint?: string }
  | { readonly type: 'exit'; readonly reason: string }
  | { readonly type: 'hold' };

export interface BarContext {
  // Closes up to and including the current bar, oldest-first, as exact decimal strings. The harness
  // passes the SAME backing array on every call (not a copy, for O(1) amortized push cost over long
  // series) — read it synchronously within decide(); do not retain the reference across bars.
  readonly closes: readonly string[];
  // Highs/lows up to and including the current bar — same shared-backing-array convention as closes.
  // Added for ATR-family indicators (true range needs the bar's own high/low, not just its close).
  readonly highs: readonly string[];
  readonly lows: readonly string[];
  // Next bar's open — the fill reference for any action returned this bar. null on the final bar (no
  // lookahead: there is nothing to fill against, so enter/exit proposed on the last bar is a no-op).
  readonly nextOpen: string | null;
  // Current bar's close, used as the mark for unrealized PnL and funding settlement.
  readonly markPrice: string;
  // Funding rate applicable at this bar, when the caller supplied a funding schedule; null otherwise.
  readonly fundingRate: string | null;
  readonly position: PositionState;
  readonly barIndex: number;
}

export interface BarStrategy {
  decide(ctx: BarContext): BacktestAction;
}
