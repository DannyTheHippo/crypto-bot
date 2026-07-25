import type { KillSwitchPort } from '../../../ports/trading/risk';

// Fire-and-forget startTrading().catch contract (2026-07-24): HALT with flatten=true — the
// book may already be positioned when pin/boot fails mid-start. Kept in its own module so the
// unit test does not import the Nest TradingRuntimeModule graph.
export function engageStartTradingFailure(killSwitch: KillSwitchPort, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const reason = `START_TRADING_FAILED: ${msg.slice(0, 200)}`;
  killSwitch.engage(reason, true);
  return reason;
}
