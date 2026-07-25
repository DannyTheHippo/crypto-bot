import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  dailyLossTripped,
  drawdownTripped,
} from '../../../../src/domain/trading/risk/equity-monitor';

const D = (s: string) => new Decimal(s);

describe('dailyLossTripped (§5 C1)', () => {
  it('trips at exact equality (a limit is a ceiling you may reach)', () => {
    expect(dailyLossTripped(D('100000'), D('95000'), '5000')).toBe(true); // loss 5000 == cap
  });
  it('trips beyond the cap', () => {
    expect(dailyLossTripped(D('100000'), D('94000'), '5000')).toBe(true);
  });
  it('does not trip below the cap', () => {
    expect(dailyLossTripped(D('100000'), D('96000'), '5000')).toBe(false); // loss 4000 < cap
  });
  it('does not trip on a gain', () => {
    expect(dailyLossTripped(D('100000'), D('105000'), '5000')).toBe(false);
  });
});

describe('drawdownTripped (§5 C2)', () => {
  it('trips at exact equality', () => {
    expect(drawdownTripped(D('100000'), D('80000'), '0.2')).toBe(true); // 20% == cap
  });
  it('trips beyond the cap', () => {
    expect(drawdownTripped(D('100000'), D('70000'), '0.2')).toBe(true);
  });
  it('does not trip below the cap', () => {
    expect(drawdownTripped(D('100000'), D('85000'), '0.2')).toBe(false); // 15% < cap
  });
  it('never trips with a non-positive peak (no equity history)', () => {
    expect(drawdownTripped(D('0'), D('-10'), '0.2')).toBe(false);
    expect(drawdownTripped(D('-5'), D('-10'), '0.2')).toBe(false);
  });
});
