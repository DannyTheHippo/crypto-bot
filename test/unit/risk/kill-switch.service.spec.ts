import { describe, it, expect } from 'vitest';
import { KillSwitchService } from '../../../src/features/trading/risk/kill-switch.service';

describe('KillSwitchService', () => {
  it('starts RUNNING and engages to HALTING carrying reason + flatten flag', () => {
    const ks = new KillSwitchService();
    expect(ks.state()).toBe('RUNNING');
    ks.engage('drawdown', true);
    expect(ks.state()).toBe('HALTING');
    expect(ks.reason()).toBe('drawdown');
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
