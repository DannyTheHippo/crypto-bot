// Generic rule-based BarStrategy — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// The diagnostic driver for the sanity gates: a deterministic, non-agentic BarStrategy that exercises
// the harness's fill/settlement machinery independent of any LLM or recorded-decision dependency.
// EMA-cross, long-only. Indicator math reuses src/domain/indicators (the production indicator
// library) and crosses to plain floats explicitly at the ctx.closes boundary — floats are fine for
// indicators, never for money (CLAUDE.md rule 1); no float ever reaches the harness's fill/PnL path.
import { emaFromNumbers } from '../../../src/domain/indicators/indicators';
import type { BarStrategy, BarContext, BacktestAction } from '../strategy';

export interface RuleStrategyConfig {
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  readonly sizeHint?: string;
}

export class RuleStrategy implements BarStrategy {
  constructor(private readonly cfg: RuleStrategyConfig) {}

  decide(ctx: BarContext): BacktestAction {
    const { fastPeriod, slowPeriod } = this.cfg;
    if (ctx.closes.length < slowPeriod + 1) return { type: 'hold' };

    const closes = ctx.closes.map(Number); // indicator boundary — see file header
    const prevCloses = closes.slice(0, -1);
    const fastNow = emaFromNumbers(closes, fastPeriod);
    const slowNow = emaFromNumbers(closes, slowPeriod);
    const fastPrev = emaFromNumbers(prevCloses, fastPeriod);
    const slowPrev = emaFromNumbers(prevCloses, slowPeriod);
    if ([fastNow, slowNow, fastPrev, slowPrev].some((v) => Number.isNaN(v)))
      return { type: 'hold' };

    const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
    const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;

    if (ctx.position.signedQty.isZero()) {
      return crossedUp
        ? { type: 'enter', side: 'LONG', sizeHint: this.cfg.sizeHint }
        : { type: 'hold' };
    }
    if (ctx.position.signedQty.gt(0) && crossedDown)
      return { type: 'exit', reason: 'ema_cross_down' };
    return { type: 'hold' };
  }
}
