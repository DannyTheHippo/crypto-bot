import { describe, it, expect } from 'vitest';
import {
  summarizeDecisionPostMortems,
  type PostMortemRow,
} from '../../../src/features/trading/agentic/decision-postmortem';
import { epochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;

function row(index: number, over: Partial<PostMortemRow> = {}): PostMortemRow {
  return {
    eventTime: epochMs(T + index * 60_000),
    action: 'hold',
    refPrice: null,
    close: null,
    symbol: 'BTC/USDT',
    ...over,
  };
}

describe('summarizeDecisionPostMortems — thesis post-mortems', () => {
  it('pins the exact rendered line for a thesis-bearing round trip whose close series touches take-profit before exit', () => {
    const plan = {
      stopLossPct: '0.02',
      takeProfitPct: '0.04',
      maxHoldBars: 5,
      thesis: 'breakout continuation',
    };
    const rows: PostMortemRow[] = [
      row(0, { action: 'open_long', refPrice: '100', close: '100', plan }),
      row(1, { action: 'hold', close: '101' }), // below both stop (98) and take-profit (104)
      row(2, { action: 'hold', close: '104' }), // touches take-profit first
      row(3, { action: 'close', refPrice: '105', close: '105' }),
    ];
    const digest = summarizeDecisionPostMortems(rows);
    // hold = exitIndex(3) - entryIndex(0) = 3; pnl = (105-100)/100*100 = +5.0%.
    expect(digest.thesisPostMortems).toEqual([
      { eventTime: rows[0]!.eventTime, line: 'LONG dir=ok exit=tp hold=3/5b pnl=+5.0%' },
    ]);
  });

  it('skips a thesis-less round trip cleanly — no throw, no fabricated grade', () => {
    const rows: PostMortemRow[] = [
      row(0, { action: 'open_long', refPrice: '100', close: '100' }), // no plan at all
      row(1, { action: 'close', refPrice: '110', close: '110' }),
    ];
    expect(() => summarizeDecisionPostMortems(rows)).not.toThrow();
    expect(summarizeDecisionPostMortems(rows).thesisPostMortems).toEqual([]);
  });

  it('skips a v2 round trip whose plan carries directives but no thesis field', () => {
    const rows: PostMortemRow[] = [
      row(0, {
        action: 'open_long',
        refPrice: '100',
        close: '100',
        plan: { stopLossPct: '0.02', takeProfitPct: '0.04', maxHoldBars: 5 }, // no thesis
      }),
      row(1, { action: 'close', refPrice: '102', close: '102' }),
    ];
    expect(summarizeDecisionPostMortems(rows).thesisPostMortems).toEqual([]);
  });
});

// LOAD-BEARING POPULATION SPLIT: these grade HOLD DECISIONS only (a hold/adjust that resulted in a
// FLAT book), never unfilled/rejected ORDERS — see decision-postmortem.ts's own header comment.
describe('summarizeDecisionPostMortems — hold post-mortems (declined-entry population)', () => {
  it('classifies a declined-entry hold followed by a >1% favorable run within the horizon as a missed entry', () => {
    // 25 rows: index 0 is the only row with a full 24-bar forward window (i+24 < 25). A single +2%
    // spike at index 13 makes the max favorable excursion over the window 2%, above the 1% threshold.
    const rows: PostMortemRow[] = Array.from({ length: 25 }, (_, i) =>
      row(i, { action: 'hold', close: i === 13 ? '102' : '100' }),
    );
    const digest = summarizeDecisionPostMortems(rows);
    expect(digest.holdPostMortem).toEqual({
      gradedHolds: 1,
      missedEntries: 1,
      correctHolds: 0,
      missedEntryRate: 1,
      correctHoldRate: 0,
    });
  });

  it('classifies a declined-entry hold followed by a drawdown as a correct hold', () => {
    // Monotonic decline -> every forward return is <= 0, so the max favorable excursion never clears
    // the 1% threshold ("price went nowhere or against" — a correct hold).
    const rows: PostMortemRow[] = Array.from({ length: 25 }, (_, i) =>
      row(i, { action: 'hold', close: String(100 - i * 0.1) }),
    );
    const digest = summarizeDecisionPostMortems(rows);
    expect(digest.holdPostMortem).toEqual({
      gradedHolds: 1,
      missedEntries: 0,
      correctHolds: 1,
      missedEntryRate: 0,
      correctHoldRate: 1,
    });
  });

  it('excludes a declined-entry hold with fewer than the horizon`s forward closes (end of window)', () => {
    const rows: PostMortemRow[] = Array.from({ length: 20 }, (_, i) =>
      row(i, { action: 'hold', close: '100' }),
    );
    expect(summarizeDecisionPostMortems(rows).holdPostMortem).toEqual({
      gradedHolds: 0,
      missedEntries: 0,
      correctHolds: 0,
      missedEntryRate: null,
      correctHoldRate: null,
    });
  });

  it('grades an "adjust"-noop-on-a-flat-book hold exactly like a "hold" row (both declined the entry)', () => {
    const rows: PostMortemRow[] = Array.from({ length: 25 }, (_, i) =>
      row(i, { action: i === 0 ? 'adjust' : 'hold', close: i === 13 ? '102' : '100' }),
    );
    expect(summarizeDecisionPostMortems(rows).holdPostMortem.gradedHolds).toBe(1);
    expect(summarizeDecisionPostMortems(rows).holdPostMortem.missedEntries).toBe(1);
  });
});

describe('summarizeDecisionPostMortems — unfilled-order population is structurally absent', () => {
  it('grades a declined-entry hold purely off action + resulting exposure — refPrice (an order-attempt artifact) never affects classification', () => {
    // PostMortemRow carries only journal decision fields (eventTime/action/refPrice/close/symbol/
    // plan) — there is no order-status/fill field this module could key an "unfilled/rejected order"
    // grade off (the N=25 study population this module must never reach). This pins that refPrice —
    // which on a real row may reflect an attempted-but-unfilled maker order — has NO effect on the
    // hold post-mortem classification, which reads only the close series.
    const withRefPriceArtifact: PostMortemRow[] = Array.from({ length: 25 }, (_, i) =>
      row(i, {
        action: 'hold',
        refPrice: i === 0 ? '99.5' : null,
        close: i === 13 ? '102' : '100',
      }),
    );
    const withoutRefPrice: PostMortemRow[] = Array.from({ length: 25 }, (_, i) =>
      row(i, { action: 'hold', close: i === 13 ? '102' : '100' }),
    );
    expect(summarizeDecisionPostMortems(withRefPriceArtifact).holdPostMortem).toEqual(
      summarizeDecisionPostMortems(withoutRefPrice).holdPostMortem,
    );
  });
});

describe('summarizeDecisionPostMortems — hour-of-day / weekday-weekend expectancy buckets', () => {
  it('buckets graded holds by UTC hour-of-day and weekday/weekend, with per-bucket missedEntryRate + mean favorable excursion', () => {
    const rows: PostMortemRow[] = [];
    // Block A: index 0 is a declined-entry hold (FLAT, forward window rows 1-24 available). Rows
    // 1-24 hold a LONG position (opened at 1, closed at 24) so none of them are themselves eligible
    // declined-entry holds — only index 0 is graded in this block. A single +2% spike at index 13
    // gives index 0 a 2% max favorable excursion -> missed entry.
    rows.push(
      row(0, {
        action: 'hold',
        close: '100',
        eventTime: epochMs(Date.UTC(2026, 0, 5, 2, 0, 0)), // Mon 2026-01-05 02:00 UTC -> weekday, h0-5
      }),
    );
    rows.push(row(1, { action: 'open_long', close: '100' }));
    for (let i = 2; i <= 23; i++) {
      rows.push(row(i, { action: 'hold', close: i === 13 ? '102' : '100' }));
    }
    rows.push(row(24, { action: 'close', close: '100' }));
    // Block B: index 25 is a declined-entry hold (FLAT again after block A's close). Rows 26-49 hold
    // a LONG position so only index 25 is graded in this block; a flat close series gives it a 0%
    // max favorable excursion -> correct hold.
    rows.push(
      row(25, {
        action: 'hold',
        close: '100',
        eventTime: epochMs(Date.UTC(2026, 0, 10, 20, 0, 0)), // Sat 2026-01-10 20:00 UTC -> weekend, h18-23
      }),
    );
    rows.push(row(26, { action: 'open_long', close: '100' }));
    for (let i = 27; i <= 48; i++) {
      rows.push(row(i, { action: 'hold', close: '100' }));
    }
    rows.push(row(49, { action: 'close', close: '100' }));

    const digest = summarizeDecisionPostMortems(rows);

    expect(digest.holdPostMortem).toEqual({
      gradedHolds: 2,
      missedEntries: 1,
      correctHolds: 1,
      missedEntryRate: 0.5,
      correctHoldRate: 0.5,
    });
    expect(digest.hourBuckets).toEqual([
      { bucket: 'h0-5', graded: 1, missedEntryRate: 1, meanFavorableExcursionPct: 2 },
      { bucket: 'h18-23', graded: 1, missedEntryRate: 0, meanFavorableExcursionPct: 0 },
    ]);
    expect(digest.dayTypeBuckets).toEqual([
      { bucket: 'weekday', graded: 1, missedEntryRate: 1, meanFavorableExcursionPct: 2 },
      { bucket: 'weekend', graded: 1, missedEntryRate: 0, meanFavorableExcursionPct: 0 },
    ]);
  });
});

describe('summarizeDecisionPostMortems — advisory (entry-rate relaxation signal)', () => {
  it('emits an advisory line when the computed entry rate is below 1/day and holds were graded', () => {
    // 1-day spacing between rows -> a ~24-day span; a single entry (index 24) over that span is
    // ~0.04/day, well under the 1/day floor.
    const rows: PostMortemRow[] = Array.from({ length: 25 }, (_, i) =>
      row(i, {
        eventTime: epochMs(T + i * 86_400_000),
        action: i === 24 ? 'open_long' : 'hold',
        close: i === 13 ? '102' : '100',
      }),
    );
    const digest = summarizeDecisionPostMortems(rows);
    expect(digest.holdPostMortem.gradedHolds).toBe(1);
    expect(digest.advisory).toMatch(/entry rate 0\.04\/day is below 1\/day/);
  });

  it('omits the advisory when no entries exist at all in the window (rate uncomputable)', () => {
    const rows: PostMortemRow[] = Array.from({ length: 25 }, (_, i) =>
      row(i, { action: 'hold', close: i === 13 ? '102' : '100' }),
    );
    expect(summarizeDecisionPostMortems(rows).advisory).toBeUndefined();
  });

  it('omits the advisory when no holds were graded at all (fails OPEN — never fabricates a rate)', () => {
    const rows: PostMortemRow[] = Array.from({ length: 20 }, (_, i) =>
      row(i, { action: i === 5 ? 'open_long' : 'hold', close: '100' }),
    );
    expect(summarizeDecisionPostMortems(rows).advisory).toBeUndefined();
  });
});
