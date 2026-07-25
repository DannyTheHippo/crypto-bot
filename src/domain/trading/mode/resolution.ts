import type { TradingMode } from '../types/mode';

export type EffectiveMode = 'paper' | 'testnet' | 'live';

// All four gates must hold for live to be effective; each failed gate contributes
// its own reason so the audit log and UI can enumerate exactly what is blocking.
// ENV_FLAG is emitted when requested==='live' && !envFlagLive (i.e. the operator
// requested live but the env override is not set), consistent with the 2⁴ branch-test
// requirement (all gate combinations with requested=live must produce a determinate
// downgrade list).
export type DowngradeReason = 'ENV_FLAG' | 'NOT_ARMED' | 'KEYS_INVALID' | 'LIMITS_INCOMPLETE';

export interface ModeResolutionVector {
  readonly requested: TradingMode;
  readonly envFlagLive: boolean; // gate (a): TRADING_MODE_LIVE env flag is set
  readonly armed: boolean; // gate (b): live arming interlock is ARMED
  readonly keysValid: boolean; // gate (c): key probe passed (no withdrawals, spot ok)
  readonly limitsComplete: boolean; // gate (d): all required risk limits are configured
  readonly testnetKeysValid: boolean; // testnet path
}

export interface ModeResolution {
  readonly effective: EffectiveMode;
  readonly requested: TradingMode;
  readonly downgrades: readonly DowngradeReason[];
}

// Pure, total. Downgrade ordering is deterministic (ENV_FLAG, NOT_ARMED,
// KEYS_INVALID, LIMITS_INCOMPLETE) so assertion equality on arrays is stable.
export function resolveMode(v: ModeResolutionVector): ModeResolution {
  if (v.requested === 'live') {
    const downgrades: DowngradeReason[] = [];
    if (!v.envFlagLive) downgrades.push('ENV_FLAG');
    if (!v.armed) downgrades.push('NOT_ARMED');
    if (!v.keysValid) downgrades.push('KEYS_INVALID');
    if (!v.limitsComplete) downgrades.push('LIMITS_INCOMPLETE');

    return {
      effective: downgrades.length === 0 ? 'live' : 'paper',
      requested: 'live',
      downgrades,
    };
  }

  if (v.requested === 'testnet') {
    return {
      effective: v.testnetKeysValid ? 'testnet' : 'paper',
      requested: 'testnet',
      downgrades: [],
    };
  }

  return { effective: 'paper', requested: 'paper', downgrades: [] };
}
