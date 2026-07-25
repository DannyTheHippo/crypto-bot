import type { EpochMs, SymbolId } from '../../../domain/types/ids';
import type {
  EdgePolicyFamilyId,
  EdgePolicyPort,
  EdgePolicySnapshot,
} from '../../../ports/agentic-strategy';

/** Canonical inactive snapshot — every fail-closed path returns this shape. */
export const EDGE_POLICY_INACTIVE: EdgePolicySnapshot = {
  active: false,
  familyId: 'none',
};

/** Null implementation: always inactive/empty — the only production binding while flag-off. */
export class DisabledEdgePolicy implements EdgePolicyPort {
  snapshot(_args: { readonly symbol: SymbolId; readonly eventTime: EpochMs }): EdgePolicySnapshot {
    void _args;
    return EDGE_POLICY_INACTIVE;
  }
}

export const DISABLED_EDGE_POLICY: EdgePolicyPort = new DisabledEdgePolicy();

export const EDGE_POLICY_OVERRIDE = Symbol('EDGE_POLICY_OVERRIDE');

// Winner adapters wire via EDGE_POLICY_OVERRIDE at the composition root (agentic-bridge), never by
// flipping AGENTIC_EDGE_POLICY_ENABLED alone. residual20-volbeta: ResidualVolbetaEdgePolicy
// (owner-directed demo deploy 2026-07-24 despite tournament DD/concentration gate fail).
export function createEdgePolicyPort(args: {
  readonly enabled: boolean;
  readonly family: EdgePolicyFamilyId;
  readonly implementation?: EdgePolicyPort;
}): EdgePolicyPort {
  if (!args.enabled || args.family === 'none') {
    return DISABLED_EDGE_POLICY;
  }
  if (args.implementation) {
    return args.implementation;
  }
  return DISABLED_EDGE_POLICY;
}
