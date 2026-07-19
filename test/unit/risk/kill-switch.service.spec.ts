import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { KillSwitchService } from '../../../src/features/trading/risk/kill-switch.service';

describe('KillSwitchService', () => {
  it('starts RUNNING and engages to HALTING carrying reason + flatten flag', () => {
    const ks = new KillSwitchService();
    expect(ks.state()).toBe('RUNNING');
    ks.engage('drawdown', true);
    expect(ks.state()).toBe('HALTING');
    expect(ks.reason()).toBe('drawdown');
  });

  // 2026-07-19: engage() went a full day with zero log signal at the source — a level-50 (error)
  // line on every call is the one place a HALT can never be silent, regardless of caller.
  it('engage() logs level-50 (error) with the reason string, every call', () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ks = new KillSwitchService();
    ks.engage('FILL_FOR_UNKNOWN_ORDER', false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('FILL_FOR_UNKNOWN_ORDER');
    errorSpy.mockRestore();
  });

  it('progresses through cancel-confirmed → FLATTENING → all-flat → HALTED, then RESUME', () => {
    const ks = new KillSwitchService();
    ks.engage('manual', true);
    ks.dispatch({ type: 'CANCELS_CONFIRMED' });
    expect(ks.state()).toBe('FLATTENING');
    ks.dispatch({ type: 'ALL_FLAT' });
    expect(ks.state()).toBe('HALTED');
    ks.dispatch({ type: 'RESUME' });
    expect(ks.state()).toBe('RUNNING');
  });
});
