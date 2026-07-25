import Decimal from 'decimal.js';
import { isOurClientOrderId, venueId } from '../../common/types/ids';
import { splitSymbol } from '../../venue/types/symbol';
import type { OrderIntent } from '../types/order-intent';

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

export function classifyVenueOpenOrder(
  venueClientOrderId: string,
  knownLocally: boolean,
): VenueOpenVerdict {
  if (!isOurClientOrderId(venueClientOrderId)) return 'FOREIGN';
  return knownLocally ? 'KNOWN' : 'UNKNOWN_OURS';
}

// binanceusdm (USD-M swap): the only venue this pass wires perp/algo-rail detection against —
// mirrors position-sizer.service.ts's own local PERP_VENUE_ID convention. Centralized HERE (rather
// than re-duplicated per file, the usual convention for feature-local code — see that file's own
// comment on the eslint-plugin-boundaries wall) because execution-gate/unknown-resolver/
// reconciliation/boot-recovery all live in the SAME feature zone (features/trading/execution) and
// all need the IDENTICAL predicate (Push 3 P7f fixes 1-3) — a single domain-level source beats four
// copies drifting.
const ALGO_RAIL_VENUE_ID = venueId('binanceusdm');

// Push 3 P7f (fixes 1-3, structural root cause): true iff `intent` rides the swap venue's ALGO/
// conditional-order rail (binanceusdm STOP_MARKET) — invisible to fetchOpenOrders/cancelOrder/
// fetchOrder (the regular rail), reachable only through fetchOpenAlgoOrders/cancelAlgoOrder (see
// ports/venue/exchange.ts's AlgoOrderState). A trigger price ALONE is not sufficient — a SPOT
// STOP_LOSS_LIMIT also carries triggerPrice but rests on the regular open-orders rail (see
// OrderIntent's own header comment on the type split), so both conditions are load-bearing: the
// venue/symbol perp discriminator is the exact one position-sizer.service.ts's isPerpSignal already
// uses for STOP_MARKET vs STOP_LOSS_LIMIT routing, reused here so the two decisions can never drift.
export function isAlgoRailIntent(
  intent: Pick<OrderIntent, 'venue' | 'symbol' | 'triggerPrice'>,
): boolean {
  if (intent.triggerPrice === undefined) return false;
  return intent.venue === ALGO_RAIL_VENUE_ID || splitSymbol(intent.symbol).settle !== undefined;
}

// Balance drift within ε = max(εabs_dust, εrel·|venue|) is recorded, NOT adopted (§6.4).
export function balanceWithinEpsilon(
  local: Decimal,
  venue: Decimal,
  epsAbs: string,
  epsRel: string,
): boolean {
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
