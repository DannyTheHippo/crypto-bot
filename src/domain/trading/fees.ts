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
const BREAK_EVEN_BAR_STUDY = 'research/studies/break-even-bar-derivation-2026-08-04.md § 1.1';

// MEASURED (fills table, demo lane, from PROMOTION_EVIDENCE_EPOCH): binance spot charges exactly
// 10.0000 bps/leg with maker = taker; binanceusdm perp charges 2 bps maker and 4–5 bps taker.
//
// The perp entry now carries its measured 2/5 schedule (previously deliberately left at the SPOT
// 10/10 pair — see break-even-bar-derivation-2026-08-04.md § 1.1 for the re-derivation: 7.2208 bps
// measured round-trip on 41 of 48 trips, 88.65% of one-way notional). The enable this comment used
// to defer is this table row. The take-profit floor gate this entry feeds is no longer a bare
// roundTripFeeFraction read — see takeProfitFloorFraction below for the bar-side refusal that makes
// dropping this entry to its true cost safe.
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
    { makerBps: '2', takerBps: '5', measuredAt: '2026-08-04', sourceStudy: BREAK_EVEN_BAR_STUDY },
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

// The derived GROSS bar (venue fees + slippage) as a fraction of notional: +8.3619 bps/round trip,
// per-cycle mean, cluster bootstrap CI95 [+6.2010, +10.7616] bps, n=48 closed round trips over 12
// base-asset clusters (break-even-bar-derivation-2026-08-04.md § 3/§ 5). This is what "beats venue
// cost" actually requires on this book, not merely what the venue itself charges.
export const TAKE_PROFIT_GROSS_BAR_FRACTION = '0.00083619';

// FAILURE DIRECTION — the take-profit floor may NEVER be set below the derived gross bar, on EITHER
// venue, regardless of how cheap that venue's own fee schedule is. binanceusdm's measured round-trip
// (7.2208 bps, § 1.1) sits BELOW the CI95 lower bound of the gross bar (6.2010–10.7616 bps): a floor
// set at the venue's bare fee would admit trades whose entire best case can sit below the cost the
// bar says the book must actually clear. So the floor takes the WORSE (higher) of the two: it only
// ever moves UP toward the bar, never down to the schedule. This is why this function exists rather
// than callers reading roundTripFeeFraction directly — a bare fee-fraction floor is the exact defect
// this function is here to close off.
export function takeProfitFloorFraction(
  venue: VenueId,
  schedules: ReadonlyMap<VenueId, VenueFeeSchedule> = VENUE_FEE_SCHEDULES,
): Decimal {
  return Decimal.max(roundTripFeeFraction(venue, schedules), TAKE_PROFIT_GROSS_BAR_FRACTION);
}
