import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
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
    resume: () => undefined,
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

  // RecoveryCoordinatorService's per-cause condition-clearing read (M2 direct coverage, owner-
  // authorized auto-resume 2026-07-22): onSample never calls portfolio.recordEquity() itself (that is
  // EquitySamplerService's job — this file constructs EquityMonitorService in isolation), so these
  // tests drive PortfolioStateService directly to control the LIVE equity causeCleared reads.
  describe('causeCleared (RecoveryCoordinatorService precondition)', () => {
    it('MAX_DRAWDOWN: clears only after recovering PAST the hysteresis band, against the NEVER-RESET peak', () => {
      const ctx = build();
      ctx.portfolio.recordEquity(new Decimal('79000'), new Decimal('0')); // dd 21% > 20% cap
      expect(ctx.monitor.causeCleared('MAX_DRAWDOWN')).toBe(false);
      expect(ctx.portfolio.peakEquity().toFixed()).toBe('100000'); // peak never ratchets down

      // dd 19% is back under the 20% TRIP cap but still inside the clear band (20% × (1 − 0.25) = 15%).
      // Clearing here is exactly the boundary flapping the band exists to prevent: the next sample
      // could re-trip and the coordinator would have resumed into it.
      ctx.portfolio.recordEquity(new Decimal('81000'), new Decimal('0'));
      expect(ctx.monitor.causeCleared('MAX_DRAWDOWN')).toBe(false);

      ctx.portfolio.recordEquity(new Decimal('86000'), new Decimal('0')); // dd 14% — past the 15% band
      expect(ctx.monitor.causeCleared('MAX_DRAWDOWN')).toBe(true);
      expect(ctx.portfolio.peakEquity().toFixed()).toBe('100000'); // recovery measured against the SAME peak
    });

    it('DAILY_LOSS: clears on a UTC-day rollover re-anchor, even with equity still down from the OLD anchor', () => {
      const ctx = build();
      ctx.monitor.onSample(sample('100000', { sessionDateUtc: '2026-06-13' })); // seeds lastSessionDate, no anchor yet
      ctx.portfolio.recordEquity(new Decimal('94000'), new Decimal('0')); // loss 6000 ≥ 5000 cap from sod 100000
      expect(ctx.monitor.causeCleared('DAILY_LOSS')).toBe(false);

      ctx.monitor.onSample(sample('94000', { sessionDateUtc: '2026-06-14' })); // rollover re-anchors sod := 94000
      expect(ctx.portfolio.sodEquity().toFixed()).toBe('94000');
      expect(ctx.monitor.causeCleared('DAILY_LOSS')).toBe(true); // 94000 - 94000 = 0 < cap
    });

    it('MAX_DRAWDOWN: the clear test uses the HYSTERESIS-tightened limit, and equality still counts as tripped', () => {
      const ctx = build();
      ctx.portfolio.recordEquity(new Decimal('80000'), new Decimal('0')); // dd EXACTLY 20% == trip cap
      expect(ctx.monitor.causeCleared('MAX_DRAWDOWN')).toBe(false);

      ctx.portfolio.recordEquity(new Decimal('80001'), new Decimal('0')); // just under the TRIP cap…
      expect(ctx.monitor.causeCleared('MAX_DRAWDOWN')).toBe(false); // …nowhere near the 15% clear band

      ctx.portfolio.recordEquity(new Decimal('85000'), new Decimal('0')); // dd EXACTLY 15% == clear band
      expect(ctx.monitor.causeCleared('MAX_DRAWDOWN')).toBe(false); // a limit is a ceiling you may reach

      ctx.portfolio.recordEquity(new Decimal('85001'), new Decimal('0')); // dd just under the clear band
      expect(ctx.monitor.causeCleared('MAX_DRAWDOWN')).toBe(true);
    });

    it('DAILY_LOSS: the clear test uses the HYSTERESIS-tightened limit, and equality still counts as tripped', () => {
      const ctx = build();
      ctx.portfolio.recordEquity(new Decimal('95000'), new Decimal('0')); // loss EXACTLY 5000 == trip cap
      expect(ctx.monitor.causeCleared('DAILY_LOSS')).toBe(false);

      ctx.portfolio.recordEquity(new Decimal('95001'), new Decimal('0')); // just under the TRIP cap…
      expect(ctx.monitor.causeCleared('DAILY_LOSS')).toBe(false); // …still inside the 3750 clear band

      ctx.portfolio.recordEquity(new Decimal('96250'), new Decimal('0')); // loss EXACTLY 3750 == band
      expect(ctx.monitor.causeCleared('DAILY_LOSS')).toBe(false); // equality still counts as tripped

      ctx.portfolio.recordEquity(new Decimal('96251'), new Decimal('0')); // loss just under the band
      expect(ctx.monitor.causeCleared('DAILY_LOSS')).toBe(true);
    });

    it('observationSeq advances on EVERY sample, including while halted — the debounce depends on it', () => {
      const ctx = build();
      expect(ctx.monitor.observationSeq()).toBe(0);

      ctx.monitor.onSample(sample('100000'));
      expect(ctx.monitor.observationSeq()).toBe(1);

      // EquitySamplerService keeps ticking after a halt (it records equity before ever consulting
      // kill-switch state), so this counter MUST keep advancing while HALTED — otherwise
      // RecoveryCoordinatorService's debounce could never see an independent second observation and
      // would never resume at all. Incrementing before onSample's early return is what guarantees it.
      ctx.setState('HALTED');
      ctx.monitor.onSample(sample('99000'));
      ctx.monitor.onSample(sample('99500'));
      expect(ctx.monitor.observationSeq()).toBe(3);
    });
  });
});
