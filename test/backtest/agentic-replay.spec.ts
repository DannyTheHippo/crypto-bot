// Offline (no-network) unit tests for the LLM-in-the-loop backtest engine on the v3 submit_trade
// contract, BOTH DIRECTIONS — RESEARCH TOOLING (test/backtest/, off the production gate, run via
// `pnpm backtest`). Every case injects a scripted `fetchFn` returning a canned submit_trade tool_use
// response (mirrors test/eval/agentic/fixtures.ts's scriptedFetch convention, reimplemented locally
// against the v3 wire shape — test/backtest and test/eval stay separate research lanes; the ONE thing
// they now share is test/shared/model-routing.ts), so no real API key or network call is ever needed.
//
// MONEY ASSERTIONS ARE EXACT STRINGS (CLAUDE.md rule 1 — toBeCloseTo is lint-banned here). Every
// fixture is chosen so the arithmetic terminates: equityBase x sizeFraction (Fix 1, 2026-07-22
// fidelity pass — entryNotional derives from the directive, not a flat constant) is set to an exact
// multiple of the entry price, giving a whole-number qty, so a wrong fee/side/direction shows up as a
// different STRING rather than a rounding-tolerant near-miss.
import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { runAgenticReplay, EARLIEST_ALLOWED_MS, capabilitiesForSymbol } from './agentic-replay';
import { LiveAgenticStrategy } from './strategies/live-agentic-strategy';
import { symbolId } from '../../src/domain/types/ids';
import type { AgentDirectives } from '../../src/ports/agentic-strategy';
import type { Bar } from './harness';
import type { BarContext, BarStrategy } from './strategy';

const T0 = EARLIEST_ALLOWED_MS + 24 * 3_600_000; // one day past the training-cutoff floor
const HOUR = 3_600_000;

const SPOT = 'BTC/USDT';
const PERP = 'BTC/USDT:USDT';

// The v3 submit_trade payload a scripted response carries — the wire shape (plain JSON numbers),
// deliberately NOT the parsed AgentDirectives shape, so these fixtures exercise production's own
// tradeDecisionSchema exactly as a real model response would.
interface ScriptedTrade {
  readonly action: 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold';
  readonly sizeFraction?: number;
  readonly entry?: { readonly style: 'maker' | 'taker'; readonly offsetBps: number };
  readonly entryValidityBars?: number;
  readonly stopLossPct?: number;
  readonly takeProfitPct?: number;
  readonly maxHoldBars?: number;
  readonly thesis?: string;
}

// Clears every harness floor: TP 0.03 >= edgeFloor (1.5 x 0.002), stop 0.01 >= feeFraction 0.002,
// TP/SL = 3 >= minRr 1.5. sizeFraction 0.1 is inside BOTH caps (spot 0.15, perp 0.35), so the same
// fixture is schema-valid on either venue.
const VIABLE: Omit<ScriptedTrade, 'action'> = {
  sizeFraction: 0.1,
  entry: { style: 'maker', offsetBps: 10 },
  entryValidityBars: 5,
  stopLossPct: 0.01,
  takeProfitPct: 0.03,
  maxHoldBars: 4,
};

interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function fakeResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Returns the next scripted decision on each call as a canned submit_trade tool-use response, and
// records the URL/headers each call was made with (the routing assertions read those). Throws if
// called more times than the script provides — a mis-wired test must fail loudly.
function scriptedFetch(
  script: readonly ScriptedTrade[],
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 100, outputTokens: 20 },
  calls: FetchCall[] = [],
): typeof fetch {
  let callIndex = 0;
  return (input: unknown, init?: RequestInit) => {
    if (callIndex >= script.length) {
      throw new Error(`scriptedFetch: no scripted decision left for call #${callIndex}`);
    }
    const decision = script[callIndex]!;
    callIndex++;
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(
      fakeResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'submit_trade', input: decision }],
        usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
      }),
    );
  };
}

// A raw tool payload that is NOT a valid submit_trade decision — used for the schema-rejection path.
function malformedFetch(input: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      fakeResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'submit_trade', input }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
}

// Fix 4: a max_tokens stop with NO tool_use block at all — the model ran out of output budget before
// emitting the call. Distinct from malformedFetch above (which DOES emit a tool_use block, just an
// invalid one) — this is the XA4 truncation case (anthropic-agent-client.ts:707-722).
function truncatedFetch(): typeof fetch {
  return () =>
    Promise.resolve(
      fakeResponse({
        stop_reason: 'max_tokens',
        content: [{ type: 'text' }], // no tool_use block present
        usage: { input_tokens: 100, output_tokens: 4096 },
      }),
    );
}

function bar(ts: number, o: number, h: number, l: number, c: number): Bar {
  return [ts, o, h, l, c, 1];
}

const BASE_OPTS = {
  interval: '1h' as const,
  model: 'claude-sonnet-5',
  apiKey: 'sk-ant-test',
  maxUsd: '100',
};

describe('agentic-replay (offline, v3 contract)', () => {
  describe('capabilities are venue-derived, exactly as the production client derives them', () => {
    it('a :SETTLE-suffixed perp symbol is shorts-capable and carries the perp caps', () => {
      const caps = capabilitiesForSymbol(symbolId(PERP), '500');
      expect(caps.shorts).toBe(true);
      expect(caps.leverage).toBe('2');
      expect(caps.maxSizeFraction).toBe('0.35');
      expect(String(caps.venue)).toBe('binanceusdm');
    });

    it('a plain spot symbol is NOT shorts-capable and carries the spot caps', () => {
      const caps = capabilitiesForSymbol(symbolId(SPOT), '500');
      expect(caps.shorts).toBe(false);
      expect(caps.leverage).toBe('1');
      expect(caps.maxSizeFraction).toBe('0.15');
      expect(String(caps.venue)).toBe('binance');
    });
  });

  describe('LONG round trip (behaviour preserved across the v2 -> v3 contract swap)', () => {
    it('fills a maker entry on a later bar LOW-cross and exits AT the take-profit price (Fix 3), sized off equityBase x sizeFraction (Fix 1), with exact PnL', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100, 99, 100), // decision bar: entry rests at 100*(1-10/10000)=99.9
        bar(T0 + HOUR, 100, 100, 99.8, 100), // low 99.8 <= 99.9 -> fills at 99.9
        bar(T0 + 2 * HOUR, 100, 104, 100, 103), // close 103 >= TP(99.9*1.03=102.897) -> exit @ TP price
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        // Fix 1: entryNotional = equityBase x sizeFraction (VIABLE's 0.1) = 999, and 999/99.9 = exactly
        // 10 units, so every figure below terminates.
        equityBase: '9990',
        fetchFn: scriptedFetch([{ action: 'open_long', ...VIABLE }]),
      });

      expect(result.shortsEnabled).toBe(false);
      expect(result.aborted).toBe(false);
      expect(result.decisionsRequested).toBe(1);
      expect(result.decisionsAccepted).toBe(1);
      expect(result.decisionOutcomeCounts.accepted).toBe(1);
      expect(result.exitReasonCounts.take_profit).toBe(1);
      expect(result.totals.roundTrips).toBe(1);
      expect(result.totals.sign).toBe('positive');
      expect(result.sizingModel).toEqual({
        kind: 'sizeFraction-of-equityBase',
        equityBaseQuote: '9990',
      });

      // Fix 3: exits AT takeProfitPrice (99.9 x 1.03 = 102.897), never at candle.close (103) — the
      // repo's own overshoot fixture. BUY 10 @ 99.9 (fee 0.999) then SELL 10 @ 102.897 (fee 1.02897).
      // PRE-FIX (close-fill) this booked gross +31 / net +28.971 / 290.00bps — ~10.3bps of phantom
      // edge the venue-resting TP (AGENTIC_VENUE_TP=true) never actually pays out.
      expect(result.pnl.realizedQuote).toBe('29.97');
      expect(result.pnl.feesQuote).toBe('2.02797');
      expect(result.pnl.netQuote).toBe('27.94203');
      expect(result.pnl.long).toEqual({ roundTrips: 1, winRate: 1, netPnlQuote: '27.94203' });
      expect(result.pnl.short).toEqual({ roundTrips: 0, winRate: null, netPnlQuote: '0' });
      // 27.94203 / (opening notional 999) = 279.70bps — a LONG's opening leg is its BUY, which is also
      // what walkRoundTrips calls entryVwap, so both readings agree here (see the SHORT case, where
      // they do not).
      expect(result.totals.netBpsPerRoundTrip).toBe('279.70');
      // 100 input + 20 output tokens at sonnet's 3/15 per MTok = 0.0003 + 0.0003.
      expect(result.pnl.llmSpendUsd).toBe('0.0006');
      expect(result.pnl.netOfLlmSpendQuote).toBe('27.94143');
    });

    it('exits on stop-loss when price falls through the stop after fill', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100, 99, 100),
        bar(T0 + HOUR, 100, 100, 99.8, 100), // fills at 99.9
        bar(T0 + 2 * HOUR, 100, 100, 95, 96), // close 96 <= stop(99.9*0.99=98.901) -> exit @ 96
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        equityBase: '9990', // entryNotional = 9990 x 0.1 (VIABLE's sizeFraction) = 999
        fetchFn: scriptedFetch([{ action: 'open_long', ...VIABLE }]),
      });

      expect(result.exitReasonCounts.stop).toBe(1);
      expect(result.totals.roundTrips).toBe(1);
      expect(result.totals.sign).toBe('negative');
      // A stop exit still fills at candle.close (Fix 3 only changes take-profit fills) — SELL 10 @ 96
      // = 960 proceeds vs 999 cost; fees 0.999 + 0.96.
      expect(result.pnl.netQuote).toBe('-40.959');
      expect(result.pnl.long.netPnlQuote).toBe('-40.959');
    });

    it('exits on max-hold when neither stop nor take-profit is hit within the bar budget', async () => {
      const flat = { ...VIABLE, takeProfitPct: 0.05, maxHoldBars: 4 };
      const bars: Bar[] = [
        bar(T0, 100, 100, 99, 100),
        bar(T0 + HOUR, 100, 100, 99.8, 100), // fills at 99.9 (barsElapsed -> 1)
        bar(T0 + 2 * HOUR, 100, 100.5, 99.5, 100), // hold (-> 2)
        bar(T0 + 3 * HOUR, 100, 100.5, 99.5, 100), // hold (-> 3)
        bar(T0 + 4 * HOUR, 100, 100.5, 99.5, 100), // hold (-> 4)
        bar(T0 + 5 * HOUR, 100, 100.5, 99.5, 100), // barsElapsed 4 >= maxHoldBars 4 -> max_hold exit
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        equityBase: '9990', // entryNotional = 9990 x 0.1 = 999
        fetchFn: scriptedFetch([{ action: 'open_long', ...flat }]),
      });

      expect(result.exitReasonCounts.max_hold).toBe(1);
      expect(result.totals.roundTrips).toBe(1);
    });

    it("a 'taker' entry crosses immediately on the plan bar at that bar's own close", async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100, 99, 100), // taker: fills HERE at 100 (offsetBps ignored per the contract)
        bar(T0 + HOUR, 100, 104, 100, 103), // close 103 >= TP(100*1.03=103) -> exit @ 103
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        equityBase: '10000', // entryNotional = 10000 x 0.1 = 1000; 1000/100 = exactly 10 units
        fetchFn: scriptedFetch([
          { action: 'open_long', ...VIABLE, entry: { style: 'taker', offsetBps: 0 } },
        ]),
      });

      expect(result.totals.roundTrips).toBe(1);
      expect(result.exitReasonCounts.take_profit).toBe(1);
      // Entry on bar 0 and exit on bar 1 — a resting-maker model would not have filled until bar 1.
      expect(result.totals.meanHoldBars).toBe(1);
      // takeProfitPrice (100 x 1.03 = 103) exactly equals candle.close here, so Fix 3 does not change
      // this fixture's numbers — BUY 10 @ 100 (fee 1) then SELL 10 @ 103 (fee 1.03).
      expect(result.pnl.realizedQuote).toBe('30');
      expect(result.pnl.feesQuote).toBe('2.03');
      expect(result.pnl.netQuote).toBe('27.97');
    });
  });

  describe('Fix 1 (2026-07-22 fidelity pass): entryNotional derives from directives.sizeFraction x equityBase', () => {
    // Same fixture as the very first LONG round-trip test above (entry rests at 99.9, TP at 102.897,
    // close 103 -> exit AT the TP price) — only the CONVICTION (sizeFraction) and venue differ, so any
    // PnL delta between the two runs below is attributable ENTIRELY to sizeFraction.
    const bars: Bar[] = [
      bar(T0, 100, 100, 99, 100),
      bar(T0 + HOUR, 100, 100, 99.8, 100),
      bar(T0 + 2 * HOUR, 100, 104, 100, 103),
    ];

    it('doubling sizeFraction (0.1 -> 0.2) exactly doubles the booked qty/PnL — pre-fix these were byte-identical (both booked the flat equityBase notional regardless of conviction)', async () => {
      const low = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        equityBase: '9990', // 9990 x 0.1 (VIABLE's sizeFraction) = entryNotional 999 -> qty 999/99.9=10
        fetchFn: scriptedFetch([{ action: 'open_long', ...VIABLE }]),
      });
      const high = await runAgenticReplay({
        ...BASE_OPTS,
        // sizeFraction 0.2 clears the PERP cap (0.35) but exceeds the SPOT cap (0.15) — a perp long is
        // unaffected by shorts capability, so this isolates the sizeFraction change from any floor.
        symbol: PERP,
        // Isolates this fixture from perp funding (see funding accrual tests below) — this test is
        // about sizeFraction sizing, not carry, so an empty funding schedule keeps its pinned PnL
        // exactly comparable to the SPOT `low` run above (same fixture, funding-free either way).
        fundingRows: [],
        bars,
        equityBase: '9990', // 9990 x 0.2 = entryNotional 1998 -> qty 1998/99.9 = 20 (exactly double)
        fetchFn: scriptedFetch([{ action: 'open_long', ...VIABLE, sizeFraction: 0.2 }]),
      });

      expect(low.sizingModel).toEqual({
        kind: 'sizeFraction-of-equityBase',
        equityBaseQuote: '9990',
      });
      // BUY 10 @ 99.9 (fee 0.999) then SELL 10 @ TP price 102.897 (fee 1.02897) — matches the first
      // LONG round-trip test's numbers exactly (same fixture, same equityBase, same sizeFraction).
      expect(low.pnl.netQuote).toBe('27.94203');
      // Exactly double the qty at the SAME two prices -> exactly double gross/fees/net.
      expect(high.pnl.netQuote).toBe('55.88406');
    });
  });

  describe('SHORT round trip (perp symbol — SELL to open, BUY to close, mirrored triggers)', () => {
    it('fills a maker entry on a later bar HIGH-cross and exits AT the take-profit price BELOW entry (Fix 3), with exact PnL', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100.2, 99.5, 100), // decision bar: entry rests ABOVE at 100*(1+10/10000)=100.1
        bar(T0 + HOUR, 100, 100.5, 99.8, 100), // high 100.5 >= 100.1 -> fills at 100.1
        bar(T0 + 2 * HOUR, 100, 100, 96.5, 97), // close 97 <= TP(100.1*0.97=97.097) -> exit @ TP price
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        // These fixed-fee-mechanics tests isolate fill/PnL correctness from funding (its own dedicated
        // tests below) — an empty schedule keeps their pinned PnL exact and disk-fixture-independent.
        fundingRows: [],
        bars,
        // Fix 1: entryNotional = equityBase x sizeFraction (0.1) = 1001; 1001/100.1 = exactly 10 units.
        equityBase: '10010',
        fetchFn: scriptedFetch([{ action: 'open_short', ...VIABLE }]),
      });

      expect(result.shortsEnabled).toBe(true);
      expect(result.decisionsAccepted).toBe(1);
      expect(result.exitReasonCounts.take_profit).toBe(1);
      expect(result.totals.roundTrips).toBe(1);
      expect(result.totals.sign).toBe('positive');
      expect(result.openPositionAtEnd).toBe(false);

      // Fix 3: a SHORT's take-profit exit BUYS BACK at takeProfitPrice (100.1 x 0.97 = 97.097), a
      // WORSE (higher) price than candle.close (97) — the mirrored direction of the LONG case, and
      // exactly why filling at close would be optimistic here, never pessimistic, for a short.
      // SELL 10 @ 100.1 (proceeds 1001, fee 1.001) then BUY 10 @ 97.097 (cost 970.97, fee 0.97097).
      // PRE-FIX (close-fill) this booked gross +31 / net +29.029 / 290.00bps.
      expect(result.pnl.realizedQuote).toBe('30.03');
      expect(result.pnl.feesQuote).toBe('1.97197');
      expect(result.pnl.netQuote).toBe('28.05803');
      expect(result.pnl.short).toEqual({ roundTrips: 1, winRate: 1, netPnlQuote: '28.05803' });
      expect(result.pnl.long).toEqual({ roundTrips: 0, winRate: null, netPnlQuote: '0' });
      expect(result.pnl.netOfLlmSpendQuote).toBe('28.05743');
      // 28.05803 / (OPENING notional 1001, the SELL leg) = 280.30bps. walkRoundTrips names its VWAPs
      // by fill side, so reading its `entryVwap` (the BUY = this short's CLOSING leg) instead of
      // exitVwap (the OPENING leg) would read a different, wrong bps figure — this pin is what catches
      // that long-biased regression.
      expect(result.totals.netBpsPerRoundTrip).toBe('280.30');
    });

    it('exits on stop ABOVE entry — the mirrored direction; an UP move stops a short out', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100.2, 99.5, 100),
        bar(T0 + HOUR, 100, 100.5, 99.8, 100), // fills at 100.1
        bar(T0 + 2 * HOUR, 100, 102.5, 100, 102), // close 102 >= stop(100.1*1.01=101.101) -> exit @ 102
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        fundingRows: [], // isolates fill/PnL mechanics from funding — see the dedicated tests below
        bars,
        equityBase: '10010', // entryNotional = 10010 x 0.1 = 1001
        fetchFn: scriptedFetch([{ action: 'open_short', ...VIABLE }]),
      });

      expect(result.exitReasonCounts.stop).toBe(1);
      expect(result.totals.sign).toBe('negative');
      // A stop exit still fills at candle.close (Fix 3 only changes take-profit fills) — SELL 10 @
      // 100.1 (proceeds 1001, fee 1.001) then BUY 10 @ 102 (cost 1020, fee 1.02).
      expect(result.pnl.realizedQuote).toBe('-19');
      expect(result.pnl.feesQuote).toBe('2.021');
      expect(result.pnl.netQuote).toBe('-21.021');
      expect(result.pnl.short).toEqual({ roundTrips: 1, winRate: 0, netPnlQuote: '-21.021' });
    });

    it('does NOT fill on a bar whose LOW crosses the resting price but whose HIGH does not (the long-biased check would)', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100.2, 99.5, 100), // entry rests at 100.1
        bar(T0 + HOUR, 100, 100.0, 99.0, 99.5), // low 99 crosses 100.1 downward; high 100.0 does NOT
        bar(T0 + 2 * HOUR, 100, 100.2, 99.9, 100), // high 100.2 >= 100.1 -> fills HERE at 100.1
        bar(T0 + 3 * HOUR, 100, 100, 96.5, 97), // close 97 <= TP -> exit @ TP price (Fix 3)
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        fundingRows: [], // isolates fill/PnL mechanics from funding — see the dedicated tests below
        bars,
        equityBase: '10010', // entryNotional = 10010 x 0.1 = 1001
        fetchFn: scriptedFetch([{ action: 'open_short', ...VIABLE }]),
      });

      expect(result.totals.roundTrips).toBe(1);
      // Entry bar 2, exit bar 3 — a low-cross fill would have entered on bar 1 (hold of 2 bars).
      expect(result.totals.meanHoldBars).toBe(1);
      // Same entry/TP/exit-close prices as the maker-HIGH-cross TP test above -> same Fix-3 PnL.
      expect(result.pnl.short.netPnlQuote).toBe('28.05803');
    });

    it("rejects 'open_short' on a spot symbol as a counted capability violation, never a silent hold", async () => {
      const bars: Bar[] = [bar(T0, 100, 100.2, 99.5, 100), bar(T0 + HOUR, 100, 100.5, 99.8, 100)];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT, // capabilities.shorts === false
        bars,
        fetchFn: scriptedFetch([
          { action: 'open_short', ...VIABLE },
          { action: 'open_short', ...VIABLE },
        ]),
      });

      expect(result.decisionOutcomeCounts.capability_rejected).toBe(2);
      expect(result.decisionOutcomeCounts.accepted).toBe(0);
      expect(result.decisionsAccepted).toBe(0);
      expect(result.totals.roundTrips).toBe(0);
      expect(result.openPositionAtEnd).toBe(false);
    });
  });

  describe('funding accrual (perp carry, 2026-07-22 funding-accounting fix)', () => {
    // A single funding row timestamped inside the HOLD BAR (strictly after the entry-fill bar's own
    // close and at/before the hold bar's close) — see agentic-replay.ts's accrual loop: a row
    // coincident with the EXIT bar's own close would settle against an already-flat position (the exit
    // fill runs first, same bar, mirroring harness.ts/carry-sim.ts's own "flat as of the settling
    // timestamp accrues nothing" convention), so this fixture inserts one extra in-bounds HOLD bar
    // between fill and exit specifically so the funding timestamp lands while the position is
    // genuinely still open.
    const fundingTs = (base: number): number => base + 2 * HOUR + 1;

    it('a LONG held across a positive-rate funding timestamp PAYS — strictly less PnL than the same trip with funding zeroed', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100, 99, 100), // decision bar: entry rests at 100*(1-10/10000)=99.9
        bar(T0 + HOUR, 100, 100, 99.8, 100), // low 99.8 <= 99.9 -> fills at 99.9
        bar(T0 + 2 * HOUR, 100, 100.5, 99.5, 100), // HOLD — funding settles here (fundingTs(T0))
        bar(T0 + 3 * HOUR, 100, 104, 100, 103), // close 103 >= TP(99.9*1.03=102.897) -> exit @ TP price
      ];
      const paid = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        bars,
        equityBase: '9990', // 9990 x 0.1 (VIABLE) = entryNotional 999 -> qty 999/99.9 = 10
        fetchFn: scriptedFetch([{ action: 'open_long', ...VIABLE }]),
        fundingRows: [{ timestamp: fundingTs(T0), fundingRate: '0.001' }],
      });
      const zeroed = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        bars,
        equityBase: '9990',
        fetchFn: scriptedFetch([{ action: 'open_long', ...VIABLE }]),
        fundingRows: [],
      });

      // Same fill/TP economics as the very first LONG round-trip test above -> same gross/fees,
      // funding is NEVER mixed into either.
      expect(paid.pnl.realizedQuote).toBe('29.97');
      expect(paid.pnl.feesQuote).toBe('2.02797');
      // payment = -signedQty(10) x markPrice(100, the HOLD bar's own close) x rate(0.001) = -1 (PAYS).
      expect(paid.pnl.fundingQuote).toBe('-1');
      expect(paid.pnl.fundingLong).toEqual({ events: 1, netQuote: '-1' });
      expect(paid.pnl.fundingShort).toEqual({ events: 0, netQuote: '0' });
      expect(paid.pnl.netQuote).toBe('26.94203'); // 29.97 - 2.02797 - 1
      expect(zeroed.pnl.fundingQuote).toBe('0');
      expect(zeroed.pnl.netQuote).toBe('27.94203'); // pre-funding-fix pin, unchanged
      expect(new Decimal(paid.pnl.netQuote).lt(new Decimal(zeroed.pnl.netQuote))).toBe(true);
    });

    it('a SHORT held across the same positive-rate funding timestamp RECEIVES — strictly more PnL than the same trip with funding zeroed', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100.2, 99.5, 100), // decision bar: entry rests ABOVE at 100*(1+10/10000)=100.1
        bar(T0 + HOUR, 100, 100.5, 99.8, 100), // high 100.5 >= 100.1 -> fills at 100.1
        bar(T0 + 2 * HOUR, 100, 100.5, 99.5, 100), // HOLD — funding settles here (fundingTs(T0))
        bar(T0 + 3 * HOUR, 100, 100, 96.5, 97), // close 97 <= TP(100.1*0.97=97.097) -> exit @ TP price
      ];
      const received = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        bars,
        equityBase: '10010', // 10010 x 0.1 = entryNotional 1001 -> qty 1001/100.1 = 10
        fetchFn: scriptedFetch([{ action: 'open_short', ...VIABLE }]),
        fundingRows: [{ timestamp: fundingTs(T0), fundingRate: '0.001' }],
      });
      const zeroed = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        bars,
        equityBase: '10010',
        fetchFn: scriptedFetch([{ action: 'open_short', ...VIABLE }]),
        fundingRows: [],
      });

      expect(received.pnl.realizedQuote).toBe('30.03');
      expect(received.pnl.feesQuote).toBe('1.97197');
      // payment = -signedQty(-10) x markPrice(100) x rate(0.001) = +1 (RECEIVES) — the mirror of the
      // LONG case above.
      expect(received.pnl.fundingQuote).toBe('1');
      expect(received.pnl.fundingShort).toEqual({ events: 1, netQuote: '1' });
      expect(received.pnl.fundingLong).toEqual({ events: 0, netQuote: '0' });
      expect(received.pnl.netQuote).toBe('29.05803'); // 30.03 - 1.97197 + 1
      expect(zeroed.pnl.fundingQuote).toBe('0');
      expect(zeroed.pnl.netQuote).toBe('28.05803'); // pre-funding-fix pin, unchanged
      expect(new Decimal(received.pnl.netQuote).gt(new Decimal(zeroed.pnl.netQuote))).toBe(true);
    });

    it('a negative rate flips both directions: the LONG now RECEIVES', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100, 99, 100),
        bar(T0 + HOUR, 100, 100, 99.8, 100),
        bar(T0 + 2 * HOUR, 100, 100.5, 99.5, 100),
        bar(T0 + 3 * HOUR, 100, 104, 100, 103),
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        bars,
        equityBase: '9990',
        fetchFn: scriptedFetch([{ action: 'open_long', ...VIABLE }]),
        fundingRows: [{ timestamp: fundingTs(T0), fundingRate: '-0.001' }],
      });

      // payment = -signedQty(10) x markPrice(100) x rate(-0.001) = +1 — the SIGN flip of the
      // positive-rate LONG test above (-1 there, +1 here); a test passing under both signs would be
      // worthless, which is exactly why this pin exists.
      expect(result.pnl.fundingQuote).toBe('1');
      expect(result.pnl.fundingLong).toEqual({ events: 1, netQuote: '1' });
      expect(result.pnl.netQuote).toBe('28.94203'); // 29.97 - 2.02797 + 1
    });

    it('a negative rate flips both directions: the SHORT now PAYS', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100.2, 99.5, 100),
        bar(T0 + HOUR, 100, 100.5, 99.8, 100),
        bar(T0 + 2 * HOUR, 100, 100.5, 99.5, 100),
        bar(T0 + 3 * HOUR, 100, 100, 96.5, 97),
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: PERP,
        bars,
        equityBase: '10010',
        fetchFn: scriptedFetch([{ action: 'open_short', ...VIABLE }]),
        fundingRows: [{ timestamp: fundingTs(T0), fundingRate: '-0.001' }],
      });

      // payment = -signedQty(-10) x markPrice(100) x rate(-0.001) = -1 — the SIGN flip of the
      // positive-rate SHORT test above (+1 there, -1 here).
      expect(result.pnl.fundingQuote).toBe('-1');
      expect(result.pnl.fundingShort).toEqual({ events: 1, netQuote: '-1' });
      expect(result.pnl.netQuote).toBe('27.05803'); // 30.03 - 1.97197 - 1
    });

    it('a SPOT symbol accrues exactly zero funding regardless of any injected schedule — byte-identical to the pre-funding-fix PnL', async () => {
      const bars: Bar[] = [
        bar(T0, 100, 100, 99, 100),
        bar(T0 + HOUR, 100, 100, 99.8, 100),
        bar(T0 + 2 * HOUR, 100, 104, 100, 103),
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        equityBase: '9990',
        fetchFn: scriptedFetch([{ action: 'open_long', ...VIABLE }]),
      });

      expect(result.pnl.fundingQuote).toBe('0');
      expect(result.pnl.fundingLong).toEqual({ events: 0, netQuote: '0' });
      expect(result.pnl.fundingShort).toEqual({ events: 0, netQuote: '0' });
      // Byte-identical to the very first LONG round-trip test's pin above (same fixture) — a spot run
      // is untouched by this fix.
      expect(result.pnl.realizedQuote).toBe('29.97');
      expect(result.pnl.feesQuote).toBe('2.02797');
      expect(result.pnl.netQuote).toBe('27.94203');
    });

    it('refuses a perp run when the on-disk funding cache is missing — naming the file and the fetch command, never silently zero', async () => {
      const bars: Bar[] = [bar(T0, 100, 100, 99, 100)];
      await expect(
        runAgenticReplay({
          ...BASE_OPTS,
          symbol: 'ZZZ/USDT:USDT', // no test/backtest/data/funding-ZZZUSDTUSDT.json cache exists
          bars,
          fetchFn: scriptedFetch([]),
        }),
      ).rejects.toThrow(/funding-ZZZUSDTUSDT\.json/);
      await expect(
        runAgenticReplay({
          ...BASE_OPTS,
          symbol: 'ZZZ/USDT:USDT',
          bars,
          fetchFn: scriptedFetch([]),
        }),
      ).rejects.toThrow(/fetch-data\.mjs ZZZ\/USDT:USDT/);
    });
  });

  describe('degrade-to-hold paths are COUNTED, never masked', () => {
    it('a floor-rejected directive set degrades to a hold counted as floor_rejected', async () => {
      // TP 0.001 < edgeFloor (the default minEdgeMultiple '1' x feeFraction 0.002) — still rejected
      // under Fix 2's production-matching defaults (a TP this far below even the bare fee floor would
      // fail regardless of minRr).
      const thin = { ...VIABLE, takeProfitPct: 0.001, stopLossPct: 0.002 };
      const bars: Bar[] = [
        bar(T0, 100, 100, 99, 100),
        bar(T0 + HOUR, 100, 100, 99.8, 100),
        bar(T0 + 2 * HOUR, 100, 104, 100, 103),
      ];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        fetchFn: scriptedFetch([
          { action: 'open_long', ...thin },
          { action: 'open_long', ...thin },
          { action: 'open_long', ...thin },
        ]),
      });

      expect(result.decisionOutcomeCounts.floor_rejected).toBe(3);
      expect(result.decisionOutcomeCounts.hold).toBe(0);
      expect(result.decisionsAccepted).toBe(0);
      expect(result.totals.roundTrips).toBe(0);
      expect(result.openPositionAtEnd).toBe(false);
    });

    it('Fix 2 (2026-07-22 fidelity pass): a directive set with RR 1.2 — below the RETIRED 1.5 default — is accepted now, matching production which enforces no RR floor', async () => {
      // TP 0.012 still clears the fee floor (0.012 >= feeFraction 0.002) — RR = 0.012/0.01 = 1.2.
      // PRE-FIX (minRr defaulted to 1.5) this exact directive set was floor_rejected on RR alone.
      const rr12 = { ...VIABLE, stopLossPct: 0.01, takeProfitPct: 0.012 };
      const bars: Bar[] = [bar(T0, 100, 100, 99, 100), bar(T0 + HOUR, 100, 100, 99.8, 100)];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        fetchFn: scriptedFetch([{ action: 'open_long', ...rr12 }]),
      });

      expect(result.decisionOutcomeCounts.accepted).toBe(1);
      expect(result.decisionOutcomeCounts.floor_rejected).toBe(0);
    });

    it('a schema-invalid response (open_long missing sizeFraction) degrades to a hold counted as schema_rejected', async () => {
      const bars: Bar[] = [bar(T0, 100, 100, 99, 100), bar(T0 + HOUR, 100, 100, 99.8, 100)];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        fetchFn: malformedFetch({
          action: 'open_long',
          entry: { style: 'maker', offsetBps: 10 },
          entryValidityBars: 5,
          stopLossPct: 0.01,
          takeProfitPct: 0.03,
          maxHoldBars: 4,
        }),
      });

      expect(result.decisionOutcomeCounts.schema_rejected).toBe(2);
      expect(result.decisionOutcomeCounts.hold).toBe(0);
      expect(result.decisionsAccepted).toBe(0);
    });

    it('Fix 4 (2026-07-22 fidelity pass): a max_tokens truncation with no tool_use block is counted as truncated, never folded into schema_rejected', async () => {
      const bars: Bar[] = [bar(T0, 100, 100, 99, 100), bar(T0 + HOUR, 100, 100, 99.8, 100)];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        fetchFn: truncatedFetch(),
      });

      expect(result.decisionOutcomeCounts.truncated).toBe(2);
      expect(result.decisionOutcomeCounts.schema_rejected).toBe(0);
      expect(result.decisionOutcomeCounts.hold).toBe(0);
      expect(result.decisionsAccepted).toBe(0);
    });

    it("a deliberate 'hold' is counted separately from every rejection", async () => {
      const bars: Bar[] = [bar(T0, 100, 100, 99, 100), bar(T0 + HOUR, 100, 100, 99.8, 100)];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        fetchFn: scriptedFetch([{ action: 'hold' }, { action: 'hold', thesis: 'no setup' }]),
      });

      expect(result.decisionOutcomeCounts).toEqual({
        accepted: 0,
        hold: 2,
        close: 0,
        adjust: 0,
        floor_rejected: 0,
        capability_rejected: 0,
        schema_rejected: 0,
        truncated: 0,
        call_failed: 0,
      });
    });

    it("'close' and 'adjust' arriving while FLAT are counted as themselves, not as holds", async () => {
      const bars: Bar[] = [bar(T0, 100, 100, 99, 100), bar(T0 + HOUR, 100, 100, 99.8, 100)];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        fetchFn: scriptedFetch([{ action: 'close' }, { action: 'adjust' }]),
      });

      expect(result.decisionOutcomeCounts.close).toBe(1);
      expect(result.decisionOutcomeCounts.adjust).toBe(1);
      expect(result.decisionOutcomeCounts.hold).toBe(0);
      expect(result.totals.roundTrips).toBe(0);
    });

    it('a transport failure degrades to a hold counted as call_failed, with no spend attributed', async () => {
      const bars: Bar[] = [bar(T0, 100, 100, 99, 100)];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        fetchFn: () => Promise.reject(new Error('ECONNRESET')),
      });

      expect(result.decisionOutcomeCounts.call_failed).toBe(1);
      expect(result.spendUsd).toBe('0.000000');
    });
  });

  describe('no-flip rule (v3): an open_* opposite an open position is a no-op hold', () => {
    const fallback: BarStrategy = { decide: () => ({ type: 'hold' }) };
    const directives: AgentDirectives = {
      sizeFraction: '0.1',
      stopLossPct: '0.01',
      takeProfitPct: '0.03',
      entryOffsetBps: 10,
      entryValidityBars: 5,
      maxHoldBars: 4,
      entryStyle: 'maker',
      direction: 'short',
    };

    function ctxWithSignedQty(signed: string): BarContext {
      return {
        closes: ['100'],
        highs: ['100'],
        lows: ['100'],
        nextOpen: null,
        markPrice: '100',
        fundingRate: null,
        position: {
          signedQty: new Decimal(signed),
          avgEntry: new Decimal(signed === '0' ? '0' : '100'),
          realizedPnl: new Decimal('0'),
        },
        barIndex: 0,
      };
    }

    it('refuses an open_short while LONG — holds, and arms no plan (the position keeps its own)', () => {
      const strategy = new LiveAgenticStrategy(undefined, { maxDecisions: 10 }, fallback);
      const action = strategy.decide(ctxWithSignedQty('10'), {
        action: 'open_short',
        rationale: 'flip attempt',
        directives,
      });
      expect(action).toEqual({ type: 'hold' });
      expect(strategy.hasActivePlan).toBe(false);
      expect(strategy.pendingEntryPrice).toBeNull();
    });

    it('refuses an open_long while SHORT — holds, and arms no plan', () => {
      const strategy = new LiveAgenticStrategy(undefined, { maxDecisions: 10 }, fallback);
      const action = strategy.decide(ctxWithSignedQty('-10'), {
        action: 'open_long',
        rationale: 'flip attempt',
        directives: { ...directives, direction: 'long' },
      });
      expect(action).toEqual({ type: 'hold' });
      expect(strategy.hasActivePlan).toBe(false);
    });

    it('control: the SAME decision from FLAT does arm a plan (so the refusals above are the rule, not a dead path)', () => {
      const strategy = new LiveAgenticStrategy(undefined, { maxDecisions: 10 }, fallback);
      const action = strategy.decide(ctxWithSignedQty('0'), {
        action: 'open_short',
        rationale: 'fresh short',
        directives,
      });
      expect(action).toEqual({ type: 'hold' }); // maker: armed now, fills on a later high-cross
      expect(strategy.hasActivePlan).toBe(true);
      expect(strategy.pendingEntryPrice).toBe('100.1'); // rests ABOVE close for a short
    });
  });

  describe('per-model routing and pricing', () => {
    const bars: Bar[] = [bar(T0, 100, 100, 99, 100)];

    it('prices usage from the per-model override table rather than the sonnet defaults', async () => {
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        model: 'kimi-k3',
        symbol: SPOT,
        bars,
        tokenPricesJson: JSON.stringify({
          'kimi-k3': { inputPerMtok: '1', outputPerMtok: '2' },
        }),
        fetchFn: scriptedFetch([{ action: 'hold' }], {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      });

      // 1 MTok in x $1 + 1 MTok out x $2 = $3 — the sonnet default table would have billed $18.
      expect(result.spendUsd).toBe('3.000000');
    });

    it('falls back to the sonnet-tier rate for a model absent from every table', async () => {
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        model: 'some-unlisted-model',
        symbol: SPOT,
        bars,
        fetchFn: scriptedFetch([{ action: 'hold' }], {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      });

      expect(result.spendUsd).toBe('18.000000');
    });

    it("routes to the model's own baseUrl and reads its key from the route's apiKeyEnv", async () => {
      const calls: FetchCall[] = [];
      await runAgenticReplay({
        ...BASE_OPTS,
        model: 'kimi-k3',
        symbol: SPOT,
        bars,
        modelRoutesJson: JSON.stringify({
          'kimi-k3': {
            baseUrl: 'https://api.moonshot.ai/anthropic',
            apiKeyEnv: 'MOONSHOT_TEST_KEY',
            callDelayMs: 0,
          },
        }),
        env: { MOONSHOT_TEST_KEY: 'sk-moonshot-test' },
        fetchFn: scriptedFetch([{ action: 'hold' }], undefined, calls),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
      // Non-default base: both auth headers are sent, carrying the ROUTE's key — never the
      // Anthropic default-route key passed as opts.apiKey.
      expect(calls[0]!.headers['x-api-key']).toBe('sk-moonshot-test');
      expect(calls[0]!.headers['authorization']).toBe('Bearer sk-moonshot-test');
    });

    it('refuses to run when a routed model names an apiKeyEnv that is unset — naming the VARIABLE, never a key value', async () => {
      await expect(
        runAgenticReplay({
          ...BASE_OPTS,
          model: 'kimi-k3',
          symbol: SPOT,
          bars,
          modelRoutesJson: JSON.stringify({
            'kimi-k3': {
              baseUrl: 'https://api.moonshot.ai/anthropic',
              apiKeyEnv: 'MOONSHOT_TEST_KEY',
            },
          }),
          env: {},
          fetchFn: scriptedFetch([{ action: 'hold' }]),
        }),
      ).rejects.toThrow(/MOONSHOT_TEST_KEY/);

      // The default-route key must never appear in the refusal, and must never have been sent to
      // the third-party host either (the run throws before any call).
      await expect(
        runAgenticReplay({
          ...BASE_OPTS,
          model: 'kimi-k3',
          symbol: SPOT,
          bars,
          modelRoutesJson: JSON.stringify({
            'kimi-k3': {
              baseUrl: 'https://api.moonshot.ai/anthropic',
              apiKeyEnv: 'MOONSHOT_TEST_KEY',
            },
          }),
          env: {},
          fetchFn: scriptedFetch([{ action: 'hold' }]),
        }),
      ).rejects.not.toThrow(/sk-ant-test/);
    });

    it('rejects a malformed routes JSON before any paid call is made', async () => {
      const calls: FetchCall[] = [];
      await expect(
        runAgenticReplay({
          ...BASE_OPTS,
          symbol: SPOT,
          bars,
          modelRoutesJson: '{not valid json',
          fetchFn: scriptedFetch([{ action: 'hold' }], undefined, calls),
        }),
      ).rejects.toThrow(/BACKTEST_AGENTIC_MODEL_ROUTES_JSON is not valid JSON/);
      expect(calls).toHaveLength(0);
    });
  });

  describe('budget + walk-forward mechanics', () => {
    it('aborts cleanly once accumulated spend reaches maxUsd, before spending further', async () => {
      // 1,000,000 input + 1,000,000 output tokens per call = $3 + $15 = $18/call at sonnet rates.
      const bars: Bar[] = [bar(T0, 100, 100, 99, 100), bar(T0 + HOUR, 100, 100, 99, 100)];
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        maxUsd: '10', // below one call's $18 cost
        fetchFn: scriptedFetch([{ action: 'hold' }], {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      });

      expect(result.decisionsRequested).toBe(1);
      expect(result.spendUsd).toBe('18.000000');
      expect(result.aborted).toBe(true);
      expect(result.abortReason).toBe('ABORTED_BUDGET');
      expect(result.barsUsed).toBe(1); // the second bar's top-of-loop check aborts before processing it
    });

    it('segments the walked bars into contiguous, correctly-bounded chunks (walk-forward math)', async () => {
      const bars: Bar[] = Array.from({ length: 9 }, (_, i) =>
        bar(T0 + i * HOUR, 100, 100, 100, 100),
      );
      const result = await runAgenticReplay({
        ...BASE_OPTS,
        symbol: SPOT,
        bars,
        maxUsd: '1000',
        segments: 3,
        // Every bar stays FLAT with no plan (always 'hold') -> 9 decision calls, one per bar.
        fetchFn: scriptedFetch(Array.from({ length: 9 }, () => ({ action: 'hold' as const }))),
      });

      expect(result.barsUsed).toBe(9);
      expect(result.segments).toHaveLength(3);
      expect(result.segments.map((s) => [s.fromBarIndex, s.toBarIndex])).toEqual([
        [0, 3],
        [3, 6],
        [6, 9],
      ]);
      expect(result.segments.every((s) => s.roundTrips === 0 && s.sign === 'n/a')).toBe(true);
      expect(result.totals.roundTrips).toBe(0);
      expect(result.pnl.netQuote).toBe('0');
    });

    it('refuses bars that predate the training-cutoff floor', async () => {
      const bars: Bar[] = [bar(EARLIEST_ALLOWED_MS - HOUR, 100, 100, 99, 100)];
      await expect(
        runAgenticReplay({ ...BASE_OPTS, symbol: SPOT, bars, fetchFn: scriptedFetch([]) }),
      ).rejects.toThrow(/training-cutoff floor/);
    });
  });
});
