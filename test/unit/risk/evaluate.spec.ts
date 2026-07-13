import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { evaluate, type RiskEvalInput, type MarkInfo } from '../../../src/domain/risk/evaluate';
import type { PartialRiskLimits } from '../../../src/domain/risk/limits';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import type { PortfolioSnapshot, Position } from '../../../src/domain/types/portfolio';
import { price, qty } from '../../../src/domain/types/money';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
} from '../../../src/domain/types/ids';

const SID = strategyId('s1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const IID = intentId('0190abcd-1234-7abc-89ab-0123456789ab');

const FULL_LIMITS: PartialRiskLimits = {
  maxBandBps: 100, // 1%
  maxPassiveExitBandBps: 1200, // 12%
  maxOrderNotional: '1000000',
  maxDriftBps: 100,
  maxPositionPerSymbol: '1000',
  maxGrossExposure: '1000000',
  maxNetExposure: '1000000',
  maxDailyLoss: '5000',
  maxDrawdownPct: '0.5',
  staleMaxAgeMs: 5000,
};

function makeIntent(o: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intentId: IID,
    clientOrderId: encodeClientOrderId(IID, 'paper'),
    strategyId: SID,
    venue: V,
    symbol: SYM,
    side: 'BUY',
    type: 'LIMIT',
    qty: qty('1'),
    limitPrice: price('100'),
    timeInForce: 'GTC',
    reduceOnly: false,
    mode: 'paper',
    refPrice: price('100'),
    refSeq: 1n,
    createdAt: epochMs(0),
    expiresAt: epochMs(10_000),
    source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 1n, strength: 1 },
    ...o,
  };
}

function snapshot(o: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    positions: new Map<string, Position>(),
    balances: new Map(),
    openOrders: [],
    inFlightIntents: [],
    equity: new Decimal(10_000),
    unrealized: new Decimal(0),
    startingCash: new Decimal(10_000),
    peakEquity: new Decimal(10_000),
    sodEquityUtc: new Decimal(10_000),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
    ...o,
  };
}

const MARK: MarkInfo = { mid: price('100'), ageMs: 0, feedHealth: 'LIVE' };

function makeInput(o: Partial<RiskEvalInput> = {}): RiskEvalInput {
  return {
    intent: makeIntent(),
    isFlatten: false,
    snapshot: snapshot(),
    limits: FULL_LIMITS,
    killState: 'RUNNING',
    effectiveMode: 'paper',
    mark: MARK,
    filters: { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' },
    rate: { allowed: true, runaway: false },
    wouldCross: false,
    currentGross: new Decimal(0),
    currentNet: new Decimal(0),
    now: epochMs(1),
    ...o,
  };
}

function pos(signed: string): Map<string, Position> {
  return new Map([
    [
      `${SID}:${V}:${SYM}`,
      {
        strategyId: SID,
        venue: V,
        symbol: SYM,
        signedQty: new Decimal(signed),
        avgEntry: price('100'),
        realizedPnl: new Decimal(0),
      },
    ],
  ]);
}

describe('RiskEngine.evaluate — §5 decision table', () => {
  it('APPROVES a clean in-band intent', () => {
    const r = evaluate(makeInput());
    expect(r.verdict).toBe('APPROVED');
  });

  // G0 kill switch
  it('G0: rejects when kill switch not RUNNING', () => {
    const r = evaluate(makeInput({ killState: 'HALTED' }));
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['KILL_SWITCH'] });
  });
  it('G0: FLATTENING permits a reduce-only flatten (carve-out)', () => {
    const r = evaluate(
      makeInput({
        killState: 'FLATTENING',
        isFlatten: true,
        intent: makeIntent({ side: 'SELL', reduceOnly: true }),
        snapshot: snapshot({ positions: pos('5') }),
      }),
    );
    expect(r.verdict).not.toBe('REJECTED');
  });
  it('G0: FLATTENING still rejects a non-flatten intent', () => {
    const r = evaluate(makeInput({ killState: 'FLATTENING', isFlatten: false }));
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['KILL_SWITCH'] });
  });

  // G1 mode
  it('G1: rejects on mode mismatch', () => {
    const r = evaluate(makeInput({ effectiveMode: 'live' }));
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['MODE_MISMATCH'] });
  });

  // G2 limits
  it('G2: rejects when a limit is missing', () => {
    const r = evaluate(makeInput({ limits: { ...FULL_LIMITS, maxDailyLoss: null } }));
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['LIMITS_INCOMPLETE'] });
  });

  // P1 staleness
  it('P1: rejects on missing mark', () => {
    expect(evaluate(makeInput({ mark: undefined }))).toMatchObject({ reasons: ['STALE_DATA'] });
  });
  it('P1: rejects on stale age', () => {
    expect(evaluate(makeInput({ mark: { ...MARK, ageMs: 6000 } }))).toMatchObject({
      reasons: ['STALE_DATA'],
    });
  });
  it('P1: rejects on non-LIVE feed', () => {
    expect(evaluate(makeInput({ mark: { ...MARK, feedHealth: 'DEGRADED' } }))).toMatchObject({
      reasons: ['STALE_DATA'],
    });
  });
  it('P1: flatten carve-out uses last-trade on stale data with band ×2', () => {
    const r = evaluate(
      makeInput({
        isFlatten: true,
        intent: makeIntent({ side: 'SELL', reduceOnly: true, limitPrice: price('100') }),
        snapshot: snapshot({ positions: pos('5') }),
        mark: { mid: price('100'), ageMs: 9999, feedHealth: 'GAP', lastTrade: price('100') },
      }),
    );
    expect(r.verdict).not.toBe('REJECTED');
  });

  // P2 band
  it('P2: HARD rejects an out-of-band strategy limit', () => {
    const r = evaluate(makeInput({ intent: makeIntent({ limitPrice: price('200') }) }));
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['PRICE_BAND'] });
  });
  it('P2: passes exactly at the band edge (≤)', () => {
    const r = evaluate(makeInput({ intent: makeIntent({ limitPrice: price('101') }) })); // +1% == 100bps
    expect(r.verdict).toBe('APPROVED');
  });
  it('P2: flatten CLAMPS price to the band edge (SELL → lower edge)', () => {
    const r = evaluate(
      makeInput({
        isFlatten: true,
        intent: makeIntent({ side: 'SELL', reduceOnly: true, limitPrice: price('50') }),
        snapshot: snapshot({ positions: pos('5') }),
      }),
    );
    expect(r.verdict).toBe('RESIZED');
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('PRICE_BAND');
      expect(r.intent.limitPrice!.toFixed()).toBe('99'); // 100 × (1 − 0.01)
    }
  });

  // P2 passive-exit override: a reduce-only intent priced on the PASSIVE side of ref (a resting
  // take-profit) checks against the wider maxPassiveExitBandBps (1200) instead of maxBandBps (100).
  it('P2: a passive-side reduce-only exit (SELL priced +10% over ref) PASSES under the wider passive band', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'SELL', reduceOnly: true, limitPrice: price('110') }), // +1000bps < 1200bps
        snapshot: snapshot({ positions: pos('5') }),
      }),
    );
    expect(r.verdict).toBe('APPROVED');
  });
  it('P2: an aggressive-side reduce-only exit (SELL priced 2% below ref, crossing down) still checks the tight band and FAILS', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'SELL', reduceOnly: true, limitPrice: price('98') }), // −200bps > 100bps tight band
        snapshot: snapshot({ positions: pos('5') }),
      }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['PRICE_BAND'] });
  });
  it('P2: a non-reduce-only entry priced +2% over ref still FAILS the tight band (passive-exit override never applies to entries)', () => {
    const r = evaluate(
      makeInput({ intent: makeIntent({ side: 'BUY', limitPrice: price('102') }) }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['PRICE_BAND'] });
  });
  it('P2: a passive-side reduce-only BUY cover (priced 10% below ref) PASSES under the wider passive band', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'BUY', reduceOnly: true, limitPrice: price('90') }), // −1000bps < 1200bps
        snapshot: snapshot({ positions: pos('-5') }),
      }),
    );
    expect(r.verdict).toBe('APPROVED');
  });
  it('P2: a kill-switch flatten NEVER gets the passive band — a mis-directed BUY-cover at −2% is clamped to the tight band edge, not accepted wide', () => {
    // A short-cover flatten priced long-side (mark×0.98, below mid ⇒ accidentally passive-side)
    // must stay on the tight band + clamp path: the band-edge clamp is what repairs the
    // mis-directed price into a marketable limit. The wide passive band would accept it as-is,
    // leaving an unmarketable resting flatten and a >60s-unknown escalation (review finding).
    const r = evaluate(
      makeInput({
        isFlatten: true,
        killState: 'FLATTENING',
        intent: makeIntent({ side: 'BUY', reduceOnly: true, limitPrice: price('98') }), // −200bps: > 100bps tight, < 1200bps passive
        snapshot: snapshot({ positions: pos('-5') }),
      }),
    );
    expect(r.verdict).toBe('RESIZED');
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('PRICE_BAND'); // clamped, not band-accepted
      expect(r.intent.limitPrice?.toFixed()).toBe('101'); // BUY edge = mid × (1 + 100bps)
    }
  });

  // P3 fat-finger
  it('P3: HARD rejects an over-notional strategy order', () => {
    const r = evaluate(
      makeInput({ intent: makeIntent({ qty: qty('20000'), limitPrice: price('100') }) }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['FAT_FINGER'] });
  });
  it('P3: flatten CLAMPS qty to the notional cap', () => {
    const r = evaluate(
      makeInput({
        isFlatten: true,
        intent: makeIntent({
          side: 'SELL',
          reduceOnly: true,
          qty: qty('20000'),
          limitPrice: price('100'),
        }),
        snapshot: snapshot({ positions: pos('20000') }),
        limits: { ...FULL_LIMITS, maxOrderNotional: '1000', maxPositionPerSymbol: '99999' },
      }),
    );
    expect(r.verdict).toBe('RESIZED');
    if (r.verdict === 'RESIZED') expect(r.reasons).toContain('FAT_FINGER');
  });

  // P4 expiry + drift
  it('P4: rejects an expired intent', () => {
    expect(evaluate(makeInput({ now: epochMs(20_000) }))).toMatchObject({ reasons: ['EXPIRED'] });
  });
  it('P4: rejects on reference drift', () => {
    const r = evaluate(
      makeInput({ intent: makeIntent({ refPrice: price('110'), limitPrice: price('100') }) }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['REF_DRIFT'] });
  });

  // R1 rate
  it('R1: SOFT-rejects when the rate bucket is empty (no halt)', () => {
    const r = evaluate(makeInput({ rate: { allowed: false, runaway: false } }));
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['RATE_LIMIT'] });
    expect((r as { halt?: string }).halt).toBeUndefined();
  });
  it('R1: rate runaway escalates to a kill-switch halt', () => {
    const r = evaluate(makeInput({ rate: { allowed: false, runaway: true } }));
    expect(r).toMatchObject({
      verdict: 'REJECTED',
      reasons: ['RATE_LIMIT'],
      halt: 'ORDER_RATE_RUNAWAY',
    });
  });

  // X1 crossing
  it('X1: rejects a crossing intent', () => {
    expect(evaluate(makeInput({ wouldCross: true }))).toMatchObject({
      reasons: ['CROSSING_INTENT'],
    });
  });

  // E1 position limit
  it('E1: CLAMPS to position headroom', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ qty: qty('600') }),
        snapshot: snapshot({ positions: pos('600') }),
        limits: { ...FULL_LIMITS, maxPositionPerSymbol: '1000' },
      }),
    );
    expect(r.verdict).toBe('RESIZED');
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('POSITION_LIMIT');
      expect(r.intent.qty.toFixed()).toBe('400'); // headroom 1000 − 600
    }
  });
  it('E1: rejects when there is no position headroom at all', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ qty: qty('1') }),
        snapshot: snapshot({ positions: pos('1000') }),
        limits: { ...FULL_LIMITS, maxPositionPerSymbol: '1000' },
      }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['POSITION_LIMIT'] });
  });
  it('E1: counts same-direction in-flight intents toward the limit', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ qty: qty('400') }),
        snapshot: snapshot({
          inFlightIntents: [makeIntent({ qty: qty('800'), side: 'BUY' })],
          positions: pos('0'),
        }),
        limits: { ...FULL_LIMITS, maxPositionPerSymbol: '1000' },
      }),
    );
    expect(r.verdict).toBe('RESIZED'); // 800 in-flight + clamp to 200 headroom
    if (r.verdict === 'RESIZED') expect(r.intent.qty.toFixed()).toBe('200');
  });

  // E2/E3 exposure
  it('E2/E3: CLAMPS to gross exposure headroom', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ qty: qty('100'), limitPrice: price('100') }), // wants 10000 notional
        currentGross: new Decimal(995_000),
        currentNet: new Decimal(995_000),
        limits: { ...FULL_LIMITS, maxGrossExposure: '1000000', maxNetExposure: '1000000' },
      }),
    );
    expect(r.verdict).toBe('RESIZED');
    if (r.verdict === 'RESIZED') expect(r.reasons).toContain('EXPOSURE_LIMIT'); // headroom 5000 / 100 = 50 qty
  });
  it('E2/E3: net headroom can be the binding constraint', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ qty: qty('100'), limitPrice: price('100') }),
        currentGross: new Decimal(0),
        currentNet: new Decimal(999_000),
        limits: { ...FULL_LIMITS, maxGrossExposure: '1000000', maxNetExposure: '1000000' },
      }),
    );
    expect(r.verdict).toBe('RESIZED'); // net headroom 1000 < order 10000
  });
  it('E2/E3: rejects when there is no exposure headroom', () => {
    const r = evaluate(
      makeInput({
        currentGross: new Decimal(1_000_000),
        currentNet: new Decimal(1_000_000),
      }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['EXPOSURE_LIMIT'] });
  });

  // E3 directional net headroom (Phase 3 short fix). A net-SHORT book (currentNet < 0) must not let a
  // further SELL (short open) blow past −maxNet. gross headroom is left full to isolate the net branch.
  it('E3: a short SELL is REJECTED at the negative net-exposure cap', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'SELL', reduceOnly: false, qty: qty('10') }), // short open
        currentGross: new Decimal(0),
        currentNet: new Decimal(-1_000_000), // already at −maxNet
        limits: { ...FULL_LIMITS, maxGrossExposure: '1000000', maxNetExposure: '1000000' },
      }),
    );
    // Old direction-blind code computed netHeadroom = maxNet − currentNet = 2,000,000 ⇒ APPROVED (bug).
    // Directional: maxNet − (−currentNet) = 0 ⇒ no room ⇒ REJECT.
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['EXPOSURE_LIMIT'] });
  });
  it('E3: a short SELL is CLAMPED to the remaining negative net headroom', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({
          side: 'SELL',
          reduceOnly: false,
          qty: qty('100'),
          limitPrice: price('100'),
        }),
        currentGross: new Decimal(0),
        currentNet: new Decimal(-999_000), // 1000 of net-short headroom left
        limits: { ...FULL_LIMITS, maxGrossExposure: '1000000', maxNetExposure: '1000000' },
      }),
    );
    expect(r.verdict).toBe('RESIZED'); // 10000 order > 1000 headroom ⇒ clamp to 10 qty
    if (r.verdict === 'RESIZED') expect(r.reasons).toContain('EXPOSURE_LIMIT');
  });
  it('E3: a BUY on a net-long book is byte-identical (maxNet − currentNet)', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({
          side: 'BUY',
          reduceOnly: false,
          qty: qty('100'),
          limitPrice: price('100'),
        }),
        currentGross: new Decimal(0),
        currentNet: new Decimal(999_000), // long book: 1000 headroom up
        limits: { ...FULL_LIMITS, maxGrossExposure: '1000000', maxNetExposure: '1000000' },
      }),
    );
    expect(r.verdict).toBe('RESIZED'); // unchanged long behavior
  });

  // E1 per-symbol cap is direction-agnostic (uses |postPosition|): a short open is clamped too.
  it('E1: a short SELL beyond the per-symbol cap is clamped', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({
          side: 'SELL',
          reduceOnly: false,
          qty: qty('1500'),
          limitPrice: price('100'),
        }),
        limits: { ...FULL_LIMITS, maxPositionPerSymbol: '1000' },
      }),
    );
    expect(r.verdict).toBe('RESIZED');
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('POSITION_LIMIT');
      expect(r.intent.qty.toFixed()).toBe('1000'); // clamped to the cap
    }
  });

  // C1 daily loss
  it('C1: rejects + halts at the daily-loss boundary (equality trips)', () => {
    const r = evaluate(
      makeInput({
        snapshot: snapshot({ equity: new Decimal(5_000), sodEquityUtc: new Decimal(10_000) }),
      }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['DAILY_LOSS'], halt: 'DAILY_LOSS' });
  });
  it('C1: reduce-only passes the daily-loss gate', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'SELL', reduceOnly: true }),
        snapshot: snapshot({
          equity: new Decimal(5_000),
          sodEquityUtc: new Decimal(10_000),
          positions: pos('5'),
        }),
      }),
    );
    expect(r.verdict).not.toBe('REJECTED');
  });

  // C2 drawdown
  it('C2: rejects + halts at the drawdown boundary', () => {
    const r = evaluate(
      makeInput({
        snapshot: snapshot({
          equity: new Decimal(5_000),
          peakEquity: new Decimal(10_000),
          sodEquityUtc: new Decimal(5_000),
        }),
      }),
    );
    expect(r).toMatchObject({
      verdict: 'REJECTED',
      reasons: ['MAX_DRAWDOWN'],
      halt: 'MAX_DRAWDOWN',
    });
  });
  it('C2: a zero peak equity skips the drawdown gate', () => {
    const r = evaluate(
      makeInput({
        snapshot: snapshot({
          peakEquity: new Decimal(0),
          equity: new Decimal(0),
          sodEquityUtc: new Decimal(0),
        }),
      }),
    );
    expect(r.verdict).toBe('APPROVED');
  });

  // F2 reduce-only semantics
  it('F2: reduce-only with the wrong side is a violation', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'BUY', reduceOnly: true }),
        snapshot: snapshot({ positions: pos('5') }),
      }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['REDUCE_ONLY_VIOLATION'] });
  });
  it('F2: reduce-only on a short position permits a BUY', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'BUY', reduceOnly: true, qty: qty('3') }),
        snapshot: snapshot({ positions: pos('-5') }),
      }),
    );
    expect(r.verdict).not.toBe('REJECTED');
  });
  it('F2: reduce-only qty exceeding the position is clamped down', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'SELL', reduceOnly: true, qty: qty('10') }),
        snapshot: snapshot({ positions: pos('4') }),
      }),
    );
    expect(r.verdict).toBe('RESIZED');
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('REDUCE_ONLY_VIOLATION');
      expect(r.intent.qty.toFixed()).toBe('4');
    }
  });

  it('MARKET order with no limit price uses the mark as the working price', () => {
    const r = evaluate(
      makeInput({ intent: makeIntent({ type: 'MARKET', limitPrice: undefined, qty: qty('1') }) }),
    );
    expect(r.verdict).toBe('APPROVED');
  });

  it('nets opposing same-symbol in-flight intents and ignores non-matching ones', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ side: 'BUY', qty: qty('400') }),
        snapshot: snapshot({
          positions: pos('0'),
          inFlightIntents: [
            makeIntent({ side: 'SELL', qty: qty('200') }), // matching → reduces committed exposure
            makeIntent({ side: 'BUY', qty: qty('900'), symbol: symbolId('ETH/USDT') }), // other symbol → ignored
          ],
        }),
        limits: { ...FULL_LIMITS, maxPositionPerSymbol: '1000' },
      }),
    );
    expect(r.verdict).toBe('APPROVED'); // base −200 + 400 = 200 ≤ 1000
  });

  it('P2: flatten CLAMPS a BUY to the upper band edge (reduce-only on a short)', () => {
    const r = evaluate(
      makeInput({
        isFlatten: true,
        intent: makeIntent({
          side: 'BUY',
          reduceOnly: true,
          qty: qty('3'),
          limitPrice: price('500'),
        }),
        snapshot: snapshot({ positions: pos('-5') }),
      }),
    );
    expect(r.verdict).toBe('RESIZED');
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('PRICE_BAND');
      expect(r.intent.limitPrice!.toFixed()).toBe('101'); // 100 × (1 + 0.01)
    }
  });

  // F1 exchange filters
  it('F1: rejects when the clamped qty falls below the exchange minimum', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ qty: qty('1000') }),
        snapshot: snapshot({ positions: pos('999.9995') }),
        limits: { ...FULL_LIMITS, maxPositionPerSymbol: '1000' },
        filters: { tickSize: '0.01', stepSize: '0.001', minQty: '0.01', minNotional: '5' },
      }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['BELOW_EXCHANGE_MIN'] });
  });
  it('F1: rejects when notional is below the exchange minimum', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ qty: qty('0.01'), limitPrice: price('100') }),
        filters: { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' },
      }),
    );
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['BELOW_EXCHANGE_MIN'] });
  });
  // Non-terminating clamp quotients (>18 dp) must resize, never throw PRECISION_OVERFLOW.
  it('P3: flatten CLAMPS to a non-terminating notional quotient without throwing', () => {
    const r = evaluate(
      makeInput({
        isFlatten: true,
        intent: makeIntent({
          side: 'SELL',
          reduceOnly: true,
          qty: qty('100'),
          limitPrice: price('3'),
          refPrice: price('3'),
        }),
        snapshot: snapshot({ positions: pos('100') }),
        mark: { mid: price('3'), ageMs: 0, feedHealth: 'LIVE' },
        limits: { ...FULL_LIMITS, maxOrderNotional: '100', maxPositionPerSymbol: '99999' },
        filters: { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' },
      }),
    );
    expect(r.verdict).toBe('RESIZED'); // 100/3 = 33.333… (>18 dp) clamped then stepped
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('FAT_FINGER');
      expect(r.intent.qty.toFixed()).toBe('33.333'); // stepped down to the 0.001 step
    }
  });
  it('E2/E3: CLAMPS to a non-terminating exposure quotient without throwing', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({ qty: qty('100'), limitPrice: price('3'), refPrice: price('3') }),
        mark: { mid: price('3'), ageMs: 0, feedHealth: 'LIVE' },
        currentGross: new Decimal(999_900),
        currentNet: new Decimal(999_900),
        limits: { ...FULL_LIMITS, maxGrossExposure: '1000000', maxNetExposure: '1000000' },
        filters: { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' },
      }),
    );
    expect(r.verdict).toBe('RESIZED'); // headroom 100 / price 3 = 33.333… (>18 dp)
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('EXPOSURE_LIMIT');
      expect(r.intent.qty.toFixed()).toBe('33.333');
    }
  });
  it('P2: flatten CLAMPS a band edge with an 18-dp mid without throwing', () => {
    const mid = price('0.123456789012345678'); // already at the 18-dp ceiling
    const r = evaluate(
      makeInput({
        isFlatten: true,
        intent: makeIntent({
          side: 'SELL',
          reduceOnly: true,
          qty: qty('1'),
          limitPrice: price('0.05'),
          refPrice: mid,
        }),
        snapshot: snapshot({ positions: pos('5') }),
        mark: { mid, ageMs: 0, feedHealth: 'LIVE' },
        filters: { tickSize: '0.000001', stepSize: '0.001', minQty: '0.001', minNotional: '0' },
      }),
    );
    expect(r.verdict).toBe('RESIZED'); // mid × (1 − band) exceeds 18 dp; must round to tick first
    if (r.verdict === 'RESIZED') {
      expect(r.reasons).toContain('PRICE_BAND');
      expect(r.intent.limitPrice!.toFixed()).toBe('0.122223');
    }
  });

  it('F1: SELL price rounds UP to the tick; APPROVED reduce-only exit', () => {
    const r = evaluate(
      makeInput({
        intent: makeIntent({
          side: 'SELL',
          reduceOnly: true,
          qty: qty('5'),
          limitPrice: price('99.999'),
        }),
        snapshot: snapshot({ positions: pos('5') }),
      }),
    );
    // 99.999 rounds up to 100.00 on a 0.01 tick; reduce-only qty == position ⇒ APPROVED.
    expect(r.verdict).toBe('APPROVED');
    if (r.verdict === 'APPROVED') expect(r.intent.limitPrice!.toFixed()).toBe('100');
  });
});
