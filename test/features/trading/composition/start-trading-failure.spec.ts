import { describe, expect, it, vi } from 'vitest';
import { engageStartTradingFailure } from '../../../../src/features/trading/composition/start-trading-failure';
import type { KillSwitchPort } from '../../../../src/ports/trading/risk';

describe('engageStartTradingFailure (startTrading().catch contract)', () => {
  it('engages the kill switch with flatten=true and a truncated START_TRADING_FAILED reason', () => {
    const engage = vi.fn();
    const killSwitch = { engage } as unknown as KillSwitchPort;
    const long = 'x'.repeat(300);
    const reason = engageStartTradingFailure(killSwitch, new Error(long));
    expect(reason).toBe(`START_TRADING_FAILED: ${'x'.repeat(200)}`);
    expect(engage).toHaveBeenCalledOnce();
    expect(engage).toHaveBeenCalledWith(reason, true);
  });
});
