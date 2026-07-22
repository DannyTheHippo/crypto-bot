import { describe, it, expect } from 'vitest';
import { EquityMonitorService } from '../../../src/features/trading/execution/equity-monitor.service';
import { PortfolioStateService } from '../../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/features/trading/execution/fee-ledger.service';
import type { KillSwitchPort } from '../../../src/ports/risk';
import type { KillSwitchState } from '../../../src/domain/risk/kill-switch';
import type { EquitySample, EquityLimits } from '../../../src/ports/execution';
import { epochMs } from '../../../src/domain/types/ids';

const LIMITS: EquityLimits = { maxDailyLoss: '5000', maxDrawdownPct: '0.2' };

function build(startState: KillSwitchState = 'RUNNING') {
  const portfolio = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
  let state: KillSwitchState = startState;
  let lastReason = '';
  const engages: Array<{ reason: string; flatten: boolean }> = [];
  const killSwitch: KillSwitchPort = {
    state: () => state,
    reason: () => lastReason,
    engage: (reason, flatten) => {
      lastReason = reason;
      engages.push({ reason, flatten });
      state = 'HALTING';
    },
    confirmCancels: () => undefined,
    cancelTimeout: () => undefined,
    allFlat: () => undefined,
  };
  const monitor = new EquityMonitorService(portfolio, killSwitch, LIMITS);
  return {
    portfolio,
    monitor,
    engages,
    setState: (s: KillSwitchState) => {
      state = s;
    },
  };
}

const sample = (equity: string, over: Partial<EquitySample> = {}): EquitySample => ({
  ts: epochMs(1_700_000_000_000),
  equity,
  cash: equity,
  unrealized: '0',
  peak: '100000',
  sessionDateUtc: '2026-06-13',
  ...over,
});

describe('EquityMonitorService (§5 post-trade monitors)', () => {
  it('engages the kill switch WITHOUT flatten on a daily-loss trip', () => {
    const ctx = build();
    ctx.monitor.onSample(sample('95000', { peak: '100000' })); // loss 5000 == cap; dd 5% < cap
    expect(ctx.engages).toEqual([{ reason: 'DAILY_LOSS', flatten: false }]);
  });

  it('engages the kill switch WITH flatten on a drawdown trip', () => {
    const ctx = build();
    ctx.monitor.onSample(sample('80000', { peak: '100000' })); // dd 20% == cap
    expect(ctx.engages).toEqual([{ reason: 'MAX_DRAWDOWN', flatten: true }]);
  });

  it('on a same-sample double trip, drawdown wins (single engage, flatten true)', () => {
    const ctx = build();
    // equity 80000: daily loss 20000 ≥ 5000 AND drawdown 20% ≥ 20% — both trip.
    ctx.monitor.onSample(sample('80000', { peak: '100000' }));
    expect(ctx.engages).toEqual([{ reason: 'MAX_DRAWDOWN', flatten: true }]); // exactly one, flatten preserved
  });

  it('does not engage when neither limit is breached', () => {
    const ctx = build();
    ctx.monitor.onSample(sample('99000', { peak: '100000' })); // loss 1000, dd 1%
    expect(ctx.engages).toHaveLength(0);
  });

  it('is idempotent once halted: a later trip is absorbed (no second engage)', () => {
    const ctx = build('HALTED');
    ctx.monitor.onSample(sample('70000', { peak: '100000' })); // would trip both, but not RUNNING
    expect(ctx.engages).toHaveLength(0);
  });

  it('re-anchors start-of-day equity at the UTC rollover (peak untouched)', () => {
    const ctx = build();
    ctx.monitor.onSample(sample('96000', { sessionDateUtc: '2026-06-13' })); // day 1: loss 4000 < cap, no trip
    expect(ctx.engages).toHaveLength(0);
    ctx.monitor.onSample(sample('96000', { sessionDateUtc: '2026-06-14' })); // rollover: sod := 96000
    expect(ctx.portfolio.sodEquity().toFixed()).toBe('96000');
    // Within day 2, a 4000 drop from the NEW anchor does NOT trip (from the old 100000 anchor it would).
    ctx.monitor.onSample(sample('92000', { sessionDateUtc: '2026-06-14' }));
    expect(ctx.engages).toHaveLength(0);
  });

  it('without a rollover, the loss accrues against the original anchor and trips', () => {
    const ctx = build();
    ctx.monitor.onSample(sample('96000', { sessionDateUtc: '2026-06-13' })); // no trip
    ctx.monitor.onSample(sample('94000', { sessionDateUtc: '2026-06-13' })); // loss 6000 ≥ cap from sod 100000
    expect(ctx.engages).toEqual([{ reason: 'DAILY_LOSS', flatten: false }]);
  });
});
