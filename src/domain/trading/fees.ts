import Decimal from 'decimal.js';
import type { VenueId } from '../common/types/ids';
import { PERP_VENUE_ID, SPOT_VENUE_ID } from '../venue/types/venue-map';

// The per-venue trading fee schedule, keyed by the venue a symbol resolves to (venueForSymbol).
// Pure domain data: exact decimal STRINGS per leg (never native floats — fees are a money path), plus
// the provenance of the measurement so a reviewer can re-run it rather than trust the constant.
//
// One table, two consumers, so they can never drift: the composition root builds the agentic lane's
// AgentTradingProfile from it (agentic-bridge.module.ts's agentTradingProfileFor — what the system
// prompt tells the model a round trip costs), and the client's take-profit floor gate reads it per
// symbol (anthropic-agent-client.ts's buildProposalFromTradeDecision).
export interface VenueFeeSchedule {
  readonly makerBps: string;
  readonly takerBps: string;
  // ISO date of the measurement the numbers come from, and the study that carries the query and its
  // output. Both are falsifiable claims a reviewer can re-derive from the fills table.
  readonly measuredAt: string;
  readonly sourceStudy: string;
}

const FEE_STUDY = 'research/studies/fee-floor-derivation-2026-07-31.md § 2';

// MEASURED (fills table, demo lane, from PROMOTION_EVIDENCE_EPOCH): binance spot charges exactly
// 10.0000 bps/leg with maker = taker; binanceusdm perp charges 2 bps maker and 4–5 bps taker.
//
// The perp entry below deliberately still carries the SPOT schedule (10/10), NOT its measured 2/5.
// Reason: this entry is an input to the take-profit floor gate, which today rejects any
// takeProfitPct under 20 bps across the whole book. Dropping the perp floor to its true ~7 bps in
// the same change that introduces the table would un-suppress trades on 85% of the book before the
// economics behind that floor have been re-derived. Flipping this entry to { makerBps: '2',
// takerBps: '5' } is a SEPARATE, separately-recorded enable — the plumbing that makes the flip a
// one-line change is what ships here, not the behaviour change itself.
export const VENUE_FEE_SCHEDULES: ReadonlyMap<VenueId, VenueFeeSchedule> = new Map<
  VenueId,
  VenueFeeSchedule
>([
  [
    SPOT_VENUE_ID,
    { makerBps: '10', takerBps: '10', measuredAt: '2026-07-31', sourceStudy: FEE_STUDY },
  ],
  [
    PERP_VENUE_ID,
    { makerBps: '10', takerBps: '10', measuredAt: '2026-07-31', sourceStudy: FEE_STUDY },
  ],
]);

// FAILURE DIRECTION — fails CLOSED: an unknown venue resolves to the most EXPENSIVE schedule in the
// table rather than throwing or assuming the cheapest. This feeds a money gate (the take-profit
// floor); an unmapped venue must make that gate stricter, never laxer.
export function feeScheduleForVenue(
  venue: VenueId,
  schedules: ReadonlyMap<VenueId, VenueFeeSchedule> = VENUE_FEE_SCHEDULES,
): VenueFeeSchedule {
  const known = schedules.get(venue);
  if (known) return known;
  return [...schedules.values()].reduce((worst, candidate) =>
    roundTripBps(candidate).gt(roundTripBps(worst)) ? candidate : worst,
  );
}

// Both legs of a round trip: one maker + one taker. An approximation only in that a maker-in/maker-out
// round trip pays less — the gate it feeds wants the cost a normal entry/exit pair actually incurs.
export function roundTripBps(schedule: VenueFeeSchedule): Decimal {
  return new Decimal(schedule.makerBps).plus(schedule.takerBps);
}

// The round-trip cost as a fraction of notional — the unit the model's takeProfitPct is expressed in.
export function roundTripFeeFraction(
  venue: VenueId,
  schedules: ReadonlyMap<VenueId, VenueFeeSchedule> = VENUE_FEE_SCHEDULES,
): Decimal {
  return roundTripBps(feeScheduleForVenue(venue, schedules)).div(10_000);
}
