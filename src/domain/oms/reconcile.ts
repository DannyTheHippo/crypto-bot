import Decimal from 'decimal.js';
import { isOurClientOrderId } from '../types/ids';

// §6.4 reconciliation — pure comparison/classification. The service performs the IO (fetch venue
// truth, ingest missed fills, engage the kill switch, persist the row); these functions decide
// WHAT each discrepancy is. The cardinal rule lives in the service, not here: a mismatch HALTs and
// is NEVER auto-flattened (flattening on a model just proven wrong can double the damage).

// A venue OPEN order seen against our local book.
//   FOREIGN       — not our prefix: manual trading on the key. WARN + ignore (runbook: dedicated keys).
//   UNKNOWN_OURS  — our prefix but no local row. I1 write-ahead makes this impossible except DB loss /
//                   key sharing / a second instance ⇒ HALT (and never auto-cancel what we cannot account for).
//   KNOWN         — our prefix, present locally: expected.
export type VenueOpenVerdict = 'FOREIGN' | 'UNKNOWN_OURS' | 'KNOWN';

export function classifyVenueOpenOrder(venueClientOrderId: string, knownLocally: boolean): VenueOpenVerdict {
  if (!isOurClientOrderId(venueClientOrderId)) return 'FOREIGN';
  return knownLocally ? 'KNOWN' : 'UNKNOWN_OURS';
}

// Balance drift within ε = max(εabs_dust, εrel·|venue|) is recorded, NOT adopted (§6.4).
export function balanceWithinEpsilon(local: Decimal, venue: Decimal, epsAbs: string, epsRel: string): boolean {
  const tolerance = Decimal.max(new Decimal(epsAbs), venue.abs().mul(new Decimal(epsRel)));
  return venue.sub(local).abs().lte(tolerance);
}

// Monotone-drift escalation (§6.4): drift growing across N consecutive passes is a systematic
// fee/rounding leak even while each pass stays within ε. `history` is oldest→newest drift
// magnitudes; true iff the last `passes` samples are STRICTLY increasing (and there are that many).
export function driftStrictlyGrowing(history: readonly Decimal[], passes: number): boolean {
  if (history.length < passes) return false;
  const window = history.slice(history.length - passes);
  for (let i = 1; i < window.length; i += 1) {
    if (!window[i]!.gt(window[i - 1]!)) return false;
  }
  return true;
}
