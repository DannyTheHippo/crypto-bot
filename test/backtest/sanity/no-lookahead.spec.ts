// Sanity gate (i): no-lookahead — ACCEPTANCE for the backtest rebuild.
//
// A BarStrategy sees only closes up to and including the current bar (strategy.ts's BarContext doc);
// fills happen at the NEXT bar's open. So appending MORE FUTURE bars to a series must never change the
// harness's behavior on any bar that both runs share — except the very last bar of the SHORTER run,
// which legitimately gains a fill opportunity once more data exists after it (there was no next-bar
// open to fill against before; now there is). That one boundary bar is excluded from the comparison —
// it is real information availability, not a lookahead bug.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBacktest, type Bar } from '../harness';
import { RuleStrategy } from '../strategies/rule-strategy';

const ALL_BARS = JSON.parse(
  readFileSync(join(__dirname, '../data/BTCUSDT-1h.json'), 'utf8'),
) as Bar[];

describe('sanity: no-lookahead', () => {
  it("equity curve is invariant when future bars are appended (excl. the shorter run's final bar)", () => {
    const SHORT_LEN = 200;
    const LONG_LEN = 300;
    const shortBars = ALL_BARS.slice(0, SHORT_LEN);
    const longBars = ALL_BARS.slice(0, LONG_LEN);

    const cfg = { fastPeriod: 5, slowPeriod: 20 };
    const shortResult = runBacktest(shortBars, () => new RuleStrategy(cfg));
    const longResult = runBacktest(longBars, () => new RuleStrategy(cfg));

    // Bars [0, SHORT_LEN - 1) are shared and must be byte-identical decimal strings.
    expect(longResult.equityCurve.slice(0, SHORT_LEN - 1)).toEqual(
      shortResult.equityCurve.slice(0, SHORT_LEN - 1),
    );
  });
});
