import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { KillSwitchService } from '../../../src/features/trading/risk/kill-switch.service';
import type { OpsEvent, OpsEventPort } from '../../../src/ports/observability';

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

  // Backlog #52: dispatch() is the single choke point for every state-set — emits killswitch.
  // transition on each genuine transition, and skips an event the reducer ignores in its current
  // state (RESUME while RUNNING below).
  it('emits ops-event killswitch.transition{from,to,reason} on every genuine transition, skipping no-op events', () => {
    const opsEvents: OpsEvent[] = [];
    const opsEventLogger: OpsEventPort = { emit: (e) => opsEvents.push(e) };
    const ks = new KillSwitchService(opsEventLogger);
    ks.engage('drawdown', true); // RUNNING → HALTING
    ks.dispatch({ type: 'RESUME' }); // ignored by the reducer while HALTING — no transition
    ks.dispatch({ type: 'CANCELS_CONFIRMED' }); // HALTING → FLATTENING (flattenRequested)
    expect(opsEvents).toEqual([
      { event: 'killswitch.transition', from: 'RUNNING', to: 'HALTING', reason: 'drawdown' },
      { event: 'killswitch.transition', from: 'HALTING', to: 'FLATTENING', reason: 'drawdown' },
    ]);
  });
});
