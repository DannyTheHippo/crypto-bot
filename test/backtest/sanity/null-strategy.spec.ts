// Sanity gate (ii): null strategy — ACCEPTANCE for the backtest rebuild.
//
// A strategy that always holds must never touch position/fees/funding: final equity is EXACTLY the
// starting cash, an exact decimal string (toBeCloseTo is banned on money paths — CLAUDE.md rule 1).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBacktest, type Bar } from '../harness';
import type { BarStrategy, BacktestAction } from '../strategy';

const BARS = (
  JSON.parse(readFileSync(join(__dirname, '../data/BTCUSDT-1h.json'), 'utf8')) as Bar[]
).slice(0, 500);

class NullStrategy implements BarStrategy {
  decide(): BacktestAction {
    return { type: 'hold' };
  }
}

describe('sanity: null strategy', () => {
  it('final equity is exactly the starting cash — "1" as a decimal string', () => {
    const result = runBacktest(BARS, () => new NullStrategy(), { startingCash: '1' });
    expect(result.finalEquity).toBe('1');
    expect(result.closedRoundTrips).toEqual([]);
    expect(result.fundingPaid).toBe('0');
  });
});
