import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Decimal from 'decimal.js';
import { evaluate, type RiskEvalInput, type MarkInfo } from '../../../src/domain/risk/evaluate';
import type { PartialRiskLimits } from '../../../src/domain/risk/limits';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import type { Position } from '../../../src/domain/types/portfolio';
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
const MARK: MarkInfo = { mid: price('100'), ageMs: 0, feedHealth: 'LIVE' };
const LIMITS: PartialRiskLimits = {
  maxBandBps: 100,
  maxPassiveExitBandBps: 1200,
  maxStopTriggerBandBps: 2000,
  stopLimitBufferBps: 50,
  maxOrderNotional: '100000000',
  maxDriftBps: 100,
  maxPositionPerSymbol: '1000',
  maxGrossExposure: '100000000',
  maxNetExposure: '100000000',
  maxDailyLoss: '999999',
  maxDrawdownPct: '0.99',
  staleMaxAgeMs: 5000,
};

function input(
  intentQty: string,
  opts: { reduceOnly?: boolean; posSigned?: string; maxPos?: string } = {},
): RiskEvalInput {
  const positions = new Map<string, Position>();
  if (opts.posSigned !== undefined) {
    positions.set(`${SID}:${V}:${SYM}`, {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      signedQty: new Decimal(opts.posSigned),
      avgEntry: price('100'),
      realizedPnl: new Decimal(0),
    });
  }
  const intent: OrderIntent = {
    intentId: IID,
    clientOrderId: encodeClientOrderId(IID, 'paper'),
    strategyId: SID,
    venue: V,
    symbol: SYM,
    side: opts.reduceOnly ? 'SELL' : 'BUY',
    type: 'LIMIT',
    qty: qty(intentQty),
    limitPrice: price('100'),
    timeInForce: 'GTC',
    reduceOnly: opts.reduceOnly ?? false,
    mode: 'paper',
    refPrice: price('100'),
    refSeq: 1n,
    createdAt: epochMs(0),
    expiresAt: epochMs(10_000),
    source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 1n, strength: 1 },
  };
  return {
    intent,
    isFlatten: false,
    snapshot: {
      positions,
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
    },
    limits: { ...LIMITS, maxPositionPerSymbol: opts.maxPos ?? '1000' },
    killState: 'RUNNING',
    effectiveMode: 'paper',
    mark: MARK,
    filters: { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' },
    rate: { allowed: true, runaway: false },
    wouldCross: false,
    currentGross: new Decimal(0),
    currentNet: new Decimal(0),
    now: epochMs(1),
  };
}

describe('risk evaluate — property invariants (fast-check)', () => {
  it('never throws and a non-reject result never increases qty beyond the original', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 1000 }),
        (q, maxPos) => {
          const r = evaluate(input(String(q), { maxPos: String(maxPos) }));
          if (r.verdict === 'APPROVED' || r.verdict === 'RESIZED') {
            expect(r.intent.qty.lte(new Decimal(q))).toBe(true); // clamps only shrink
            expect(r.intent.qty.gte(new Decimal('0.001'))).toBe(true); // F1 floor
          }
        },
      ),
    );
  });

  it('an APPROVED/RESIZED order keeps post-trade position within the limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 2000 }),
        (q, maxPos) => {
          const r = evaluate(input(String(q), { maxPos: String(maxPos) }));
          if (r.verdict === 'APPROVED' || r.verdict === 'RESIZED') {
            expect(r.intent.qty.lte(new Decimal(maxPos))).toBe(true); // post = 0 + qty ≤ maxPos
          }
        },
      ),
    );
  });

  it('reduce-only never produces a qty exceeding the position it reduces', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        (q, posSize) => {
          const r = evaluate(input(String(q), { reduceOnly: true, posSigned: String(posSize) }));
          if (r.verdict === 'APPROVED' || r.verdict === 'RESIZED') {
            expect(r.intent.qty.lte(new Decimal(posSize))).toBe(true); // never flips or grows the position
          }
        },
      ),
    );
  });
});
