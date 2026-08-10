import { describe, it, expect } from 'vitest';
import {
  VENUE_FEE_SCHEDULES,
  TAKE_PROFIT_GROSS_BAR_FRACTION,
  feeScheduleForVenue,
  roundTripFeeFraction,
  takeProfitFloorFraction,
} from '../../../src/domain/trading/fees';
import { SPOT_VENUE_ID, PERP_VENUE_ID } from '../../../src/domain/venue/types/venue-map';

describe('domain/trading fees', () => {
  describe('VENUE_FEE_SCHEDULES', () => {
    it('carries the measured spot schedule (10 maker / 10 taker)', () => {
      const spot = feeScheduleForVenue(SPOT_VENUE_ID);
      expect(spot.makerBps).toBe('10');
      expect(spot.takerBps).toBe('10');
    });

    it('carries the measured perp schedule (2 maker / 5 taker) — the pre-registered round-up', () => {
      const perp = feeScheduleForVenue(PERP_VENUE_ID);
      expect(perp.makerBps).toBe('2');
      expect(perp.takerBps).toBe('5');
    });
  });

  describe('roundTripFeeFraction', () => {
    it('spot: (10 + 10) / 10000 = 0.002', () => {
      expect(roundTripFeeFraction(SPOT_VENUE_ID).toFixed()).toBe('0.002');
    });

    it('perp: (2 + 5) / 10000 = 0.0007', () => {
      expect(roundTripFeeFraction(PERP_VENUE_ID).toFixed()).toBe('0.0007');
    });
  });

  describe('takeProfitFloorFraction', () => {
    it('perp: the gross bar (0.00083619) beats the venue fee (0.0007), so the bar wins', () => {
      expect(takeProfitFloorFraction(PERP_VENUE_ID).toFixed()).toBe(TAKE_PROFIT_GROSS_BAR_FRACTION);
    });

    it('spot: the venue fee (0.002) beats the gross bar (0.00083619), so the fee wins', () => {
      expect(takeProfitFloorFraction(SPOT_VENUE_ID).toFixed()).toBe('0.002');
    });

    it('never floors below TAKE_PROFIT_GROSS_BAR_FRACTION for any venue in the table', () => {
      for (const venue of VENUE_FEE_SCHEDULES.keys()) {
        expect(takeProfitFloorFraction(venue).gte(TAKE_PROFIT_GROSS_BAR_FRACTION)).toBe(true);
      }
    });

    it('an unmapped venue still floors at least at the gross bar (fails CLOSED via feeScheduleForVenue)', () => {
      const unmapped = feeScheduleForVenue(
        PERP_VENUE_ID,
        new Map([[SPOT_VENUE_ID, feeScheduleForVenue(SPOT_VENUE_ID)]]),
      );
      expect(unmapped.makerBps).toBe('10'); // falls back to the only (worst) entry present
    });
  });
});
