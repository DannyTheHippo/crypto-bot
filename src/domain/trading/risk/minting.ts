// INTERNAL — only the RiskEngine (Phase 4) should import this module.
// Minting a RiskApprovedIntent outside of risk evaluation breaks the HMAC proof contract.

import type { OrderIntent } from '../types/order-intent';
import type { ApprovalProof, RiskApprovedIntent } from '../types/risk-decision';

export function __mintApprovedIntent(
  intent: OrderIntent,
  proof: ApprovalProof,
): RiskApprovedIntent {
  return { intent, proof } as RiskApprovedIntent;
}
