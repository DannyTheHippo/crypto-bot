import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { simulateRoundTrip } from '../../../../src/features/strategy/agentic/candidate-backtest';
import type { AgentDirectives } from '../../../../src/ports/strategy/agentic-strategy';

const DIRECTIVES: AgentDirectives = {
  sizeFraction: '0.10',
  stopLossPct: '0.02',
  takeProfitPct: '0.04',
  entryOffsetBps: 10,
  entryValidityBars: 2,
  maxHoldBars: 3,
  entryStyle: 'maker',
};

describe('simulateRoundTrip', () => {
  it('returns null (unsimulatable) below MIN_FORWARD_COVERAGE (25% of maxHoldBars, rounded up)', () => {
    // maxHoldBars=3 → ceil(3*0.25)=1 forward point required; 0 supplied.
    expect(simulateRoundTrip('100', DIRECTIVES, [], 'LONG')).toBeNull();
  });

  it('exits at take-profit on the first bar that clears entry*(1+takeProfitPct) and nets exact bps (LONG)', () => {
    // entry 100, takeProfitPct 0.04 → TP price 104 exactly.
    const result = simulateRoundTrip('100', DIRECTIVES, ['104', '101.92'], 'LONG');
    expect(result).not.toBeNull();
    // netFraction = 104/100 − 1 − 0.0020 = 0.04 − 0.002 = 0.038 → 380 bps exactly. These bps figures
    // are plain indicator-grade numbers derived from exact Decimal arithmetic (never a money-string
    // path — see this file's own header comment), so an exact `toBe` is both correct and precise; the
    // repo's blanket toBeCloseTo ban (CLAUDE.md rule 1, money-assertion discipline) is syntactic and
    // would otherwise flag this non-money float comparison too (same convention as
    // test/backtest/indicators.spec.ts's own expectCloseTo escape hatch — exact here, so no helper
    // needed).
    expect(result!.netBps).toBe(380);
  });

  it('exits at stop on the first bar at/below entry*(1−stopLossPct) and nets exact bps (LONG)', () => {
    // entry 104, stopLossPct 0.02 → stop price 104*0.98 = 101.92 exactly.
    const result = simulateRoundTrip('104', DIRECTIVES, ['101.92'], 'LONG');
    expect(result).not.toBeNull();
    // netFraction = 101.92/104 − 1 − 0.0020 = −0.02 − 0.002 = −0.022 → −220 bps exactly.
    expect(result!.netBps).toBe(-220);
  });

  it('falls back to the LAST available forward close when data runs out before any executor exit fires', () => {
    // maxHoldBars=3, coverage floor=1; supply exactly 2 forward closes, neither breaches stop/TP.
    const result = simulateRoundTrip('100', DIRECTIVES, ['100.5', '101'], 'LONG');
    expect(result).not.toBeNull();
    // netFraction = 101/100 − 1 − 0.0020 = 0.01 − 0.002 = 0.008 → 80 bps exactly.
    const expected = new Decimal('101').div('100').minus(1).minus('0.0020').mul(10_000).toNumber();
    expect(expected).toBe(80);
    expect(result!.netBps).toBe(expected);
  });

  it('exits on max_hold exactly when forward data covers the full maxHoldBars window', () => {
    const flatCloses = ['100.5', '100.5', '100.5']; // maxHoldBars=3, never breaches stop/TP
    const result = simulateRoundTrip('100', DIRECTIVES, flatCloses, 'LONG');
    expect(result).not.toBeNull();
    // netFraction = 100.5/100 − 1 − 0.0020 = 0.005 − 0.002 = 0.003 → 30 bps exactly.
    const expected = new Decimal('100.5')
      .div('100')
      .minus(1)
      .minus('0.0020')
      .mul(10_000)
      .toNumber();
    expect(expected).toBe(30);
    expect(result!.netBps).toBe(expected);
  });

  it('P3: SHORT mirrors LONG — exits at take-profit BELOW entry and nets a POSITIVE bps on a decline', () => {
    // entry 100, takeProfitPct 0.04 → SHORT TP price 96 exactly (mirrors the LONG TP-above formula).
    const result = simulateRoundTrip('100', DIRECTIVES, ['96', '98'], 'SHORT');
    expect(result).not.toBeNull();
    // netFraction = 100/96 − 1 − 0.0020 (entry/exit inverted vs LONG's exit/entry).
    const expected = new Decimal('100').div('96').minus(1).minus('0.0020').mul(10_000).toNumber();
    expect(result!.netBps).toBe(expected);
    expect(result!.netBps).toBeGreaterThan(0); // a short profits when price fell
  });

  it('P3: SHORT exits at stop ABOVE entry and nets a NEGATIVE bps on a rally', () => {
    // entry 100, stopLossPct 0.02 → SHORT stop price 102 exactly.
    const result = simulateRoundTrip('100', DIRECTIVES, ['102'], 'SHORT');
    expect(result).not.toBeNull();
    const expected = new Decimal('100').div('102').minus(1).minus('0.0020').mul(10_000).toNumber();
    expect(result!.netBps).toBe(expected);
    expect(result!.netBps).toBeLessThan(0);
  });
});
