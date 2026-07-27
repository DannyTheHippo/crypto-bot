import { describe, it, expect } from 'vitest';
import { simulateExit, type RawCandle } from './exit-simulator';

// Preregistration: research/studies/edge-verdict-2026-08-10.md.
// The load-bearing case is `a wick that pierces the stop but closes above it` — that single
// difference is what separates this simulator from production's close-only plan-executor, and it is
// the bias the exit-attribution study exists to measure.

const FEE = '0.002'; // 20 bps round trip — 10 bps per leg, the verified demo schedule

/** [ts, open, high, low, close, volume] */
function bar(high: string, low: string, close: string, ts = 0): RawCandle {
  return [ts, close, high, low, close, '1'];
}

describe('exit-simulator intrabar resolution', () => {
  it('registers a stop-out when the wick pierces the stop even though the bar closes above it', () => {
    // Entry 100, 2% stop => stop at 98. The bar dips to 97.5 and recovers to close at 101.
    const bars = [bar('101.5', '97.5', '101')];

    const intrabar = simulateExit({
      side: 'long',
      entryPrice: '100',
      stopLossPct: '0.02',
      takeProfitPct: '0.04',
      maxHoldBars: 72,
      bars,
      resolution: 'intrabar',
      roundTripFee: FEE,
    });
    expect(intrabar?.reason).toBe('stop');
    expect(intrabar?.exitPrice).toBe('98');
    // −2% move − 20 bps fee
    expect(intrabar?.netReturn).toBe('-0.022');

    // Production's close-only semantics never see the wick: same bar, no exit at all.
    const closeOnly = simulateExit({
      side: 'long',
      entryPrice: '100',
      stopLossPct: '0.02',
      takeProfitPct: '0.04',
      maxHoldBars: 72,
      bars,
      resolution: 'close',
      roundTripFee: FEE,
    });
    expect(closeOnly).toBeNull();
  });

  it('takes the stop when one bar touches both the stop and the take-profit', () => {
    // Entry 100, stop 98, TP 104. The bar spans 97 to 105 — both are reachable in the same bar.
    const outcome = simulateExit({
      side: 'long',
      entryPrice: '100',
      stopLossPct: '0.02',
      takeProfitPct: '0.04',
      maxHoldBars: 72,
      bars: [bar('105', '97', '104')],
      resolution: 'intrabar',
      roundTripFee: FEE,
    });
    expect(outcome?.reason).toBe('stop');
  });

  it('mirrors stop and take-profit for a short', () => {
    // Short at 100: stop ABOVE at 102, take-profit BELOW at 96.
    const stopped = simulateExit({
      side: 'short',
      entryPrice: '100',
      stopLossPct: '0.02',
      takeProfitPct: '0.04',
      maxHoldBars: 72,
      bars: [bar('102.5', '99', '99.5')],
      resolution: 'intrabar',
      roundTripFee: FEE,
    });
    expect(stopped?.reason).toBe('stop');
    expect(stopped?.exitPrice).toBe('102');
    expect(stopped?.netReturn).toBe('-0.022');

    const profited = simulateExit({
      side: 'short',
      entryPrice: '100',
      stopLossPct: '0.02',
      takeProfitPct: '0.04',
      maxHoldBars: 72,
      bars: [bar('100.5', '95.5', '96.5')],
      resolution: 'intrabar',
      roundTripFee: FEE,
    });
    expect(profited?.reason).toBe('take_profit');
    expect(profited?.exitPrice).toBe('96');
    // +4% move − 20 bps fee
    expect(profited?.netReturn).toBe('0.038');
  });

  it('exits at max_hold on the bar close when neither level is touched', () => {
    const outcome = simulateExit({
      side: 'long',
      entryPrice: '100',
      stopLossPct: '0.02',
      takeProfitPct: '0.04',
      maxHoldBars: 3,
      bars: [
        bar('100.5', '99.5', '100.1'),
        bar('100.6', '99.6', '100.2'),
        bar('100.7', '99.7', '100.3'),
      ],
      resolution: 'intrabar',
      roundTripFee: FEE,
    });
    expect(outcome?.reason).toBe('max_hold');
    expect(outcome?.exitPrice).toBe('100.3');
    expect(outcome?.barsHeld).toBe(3);
  });

  it('returns null rather than marking to market when the series ends with the position open', () => {
    const outcome = simulateExit({
      side: 'long',
      entryPrice: '100',
      stopLossPct: '0.02',
      takeProfitPct: '0.04',
      maxHoldBars: 72,
      bars: [bar('100.5', '99.5', '100.1')],
      resolution: 'intrabar',
      roundTripFee: FEE,
    });
    expect(outcome).toBeNull();
  });

  it('supports the no-stop and no-take-profit boundary arms', () => {
    const noStop = simulateExit({
      side: 'long',
      entryPrice: '100',
      stopLossPct: null,
      takeProfitPct: '0.04',
      maxHoldBars: 72,
      // Would have stopped out at 98 had a stop existed; must survive to the take-profit.
      bars: [bar('99', '90', '98.5'), bar('105', '98', '104.5')],
      resolution: 'intrabar',
      roundTripFee: FEE,
    });
    expect(noStop?.reason).toBe('take_profit');

    const noTakeProfit = simulateExit({
      side: 'long',
      entryPrice: '100',
      stopLossPct: '0.02',
      takeProfitPct: null,
      maxHoldBars: 2,
      bars: [bar('110', '99.5', '109'), bar('112', '108', '111')],
      resolution: 'intrabar',
      roundTripFee: FEE,
    });
    expect(noTakeProfit?.reason).toBe('max_hold');
    expect(noTakeProfit?.exitPrice).toBe('111');
  });

  it('rejects a non-positive entry price instead of returning a nonsense return', () => {
    expect(() =>
      simulateExit({
        side: 'long',
        entryPrice: '0',
        stopLossPct: '0.02',
        takeProfitPct: '0.04',
        maxHoldBars: 72,
        bars: [bar('101', '99', '100')],
        resolution: 'intrabar',
        roundTripFee: FEE,
      }),
    ).toThrow(/entryPrice must be > 0/);
  });
});
