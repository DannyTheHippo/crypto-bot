import { describe, it, expect, vi } from 'vitest';
import type { Counter } from 'prom-client';
import Decimal from 'decimal.js';
import { RiskEngineService } from '../../../src/features/trading/risk/risk-engine.service';
import { KillSwitchService } from '../../../src/features/trading/risk/kill-switch.service';
import { RateBucketsService } from '../../../src/features/trading/risk/rate-buckets.service';
import { CrossingRegistryService } from '../../../src/features/trading/risk/crossing-registry.service';
import type { RiskEngineDeps, RiskJournalPort } from '../../../src/ports/risk';
import type { FeedHealthPort } from '../../../src/ports/market-data';
import type { SymbolFilters } from '../../../src/domain/risk/evaluate';
import type { ClockPort } from '../../../src/ports/clock';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import type { PortfolioSnapshot, Position } from '../../../src/domain/types/portfolio';
import type { PartialRiskLimits } from '../../../src/domain/risk/limits';
import type { RiskDecision } from '../../../src/domain/types/risk-decision';
import { price, qty } from '../../../src/domain/types/money';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
} from '../../../src/domain/types/ids';
import { verifyApproval } from '../../../src/domain/risk/proof';

const T = 1700000000000;
const clock: ClockPort = { now: () => epochMs(T) };
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const SID = strategyId('s');
const IID = intentId('0190abcd-1234-7abc-89ab-0123456789ab');
const FILTERS: SymbolFilters = {
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  minNotional: '5',
};
const LIMITS: PartialRiskLimits = {
  maxBandBps: 100,
  maxPassiveExitBandBps: 1200,
  maxStopTriggerBandBps: 2000,
  stopLimitBufferBps: 50,
  maxOrderNotional: '1000000',
  maxDriftBps: 100,
  maxPositionPerSymbol: '1000',
  maxGrossExposure: '1000000',
  maxNetExposure: '1000000',
  maxDailyLoss: '5000',
  maxDrawdownPct: '0.5',
  staleMaxAgeMs: 5000,
};

function deps(over: Partial<RiskEngineDeps> = {}): RiskEngineDeps {
  return {
    key: Buffer.alloc(32, 1),
    limits: LIMITS,
    limitsVersion: 'v1',
    mode: 'paper',
    filters: new Map([[String(SYM), FILTERS]]),
    randomBytes: (n) => new Uint8Array(n).fill(3),
    ...over,
  };
}

function feed(refPresent = true): FeedHealthPort {
  return {
    getRefPrice: () => (refPresent ? { mid: price('100'), at: epochMs(T) } : undefined),
    health: () => 'LIVE',
    fetchCandles: () => Promise.resolve([]),
  };
}

function intent(o: Partial<OrderIntent> = {}): OrderIntent {
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
    refSeq: 9n,
    createdAt: epochMs(0),
    expiresAt: epochMs(T + 10_000),
    source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 9n, strength: 1 },
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

function makeEngine(
  over: {
    deps?: Partial<RiskEngineDeps>;
    refPresent?: boolean;
    riskRejects?: Counter<string>;
  } = {},
) {
  const journal: RiskJournalPort & { records: RiskDecision[] } = {
    records: [],
    record(d) {
      this.records.push(d);
    },
  };
  const kill = new KillSwitchService();
  const engine = new RiskEngineService(
    clock,
    deps(over.deps),
    feed(over.refPresent ?? true),
    kill,
    new RateBucketsService(clock),
    new CrossingRegistryService(),
    journal,
    over.riskRejects,
  );
  return { engine, journal, kill };
}

describe('RiskEngineService', () => {
  it('APPROVES a clean intent, mints a proof, and journals the decision', () => {
    const { engine, journal } = makeEngine();
    // A held position exercises the pre-trade exposure aggregation loop.
    const positions = new Map<string, Position>([
      [
        `${SID}:${V}:${SYM}`,
        {
          strategyId: SID,
          venue: V,
          symbol: SYM,
          signedQty: new Decimal('2'),
          avgEntry: price('100'),
          realizedPnl: new Decimal(0),
        },
      ],
    ]);
    const d = engine.evaluate(intent({ reduceOnly: false }), snapshot({ positions }));
    expect(d.verdict).toBe('APPROVED');
    if (d.verdict === 'APPROVED') {
      expect(d.approved.proof.hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(d.approved.proof.limitsVersion).toBe('v1');
    }
    expect(journal.records).toHaveLength(1);
  });

  it('REJECTS with STALE_DATA when the feed has no reference price (no mint)', () => {
    const { engine, journal } = makeEngine({ refPresent: false });
    const d = engine.evaluate(intent(), snapshot());
    expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['STALE_DATA'] });
    expect(journal.records).toHaveLength(1);
  });

  it('counts risk_rejections_total{code} by reason on a veto (§8 rejection taxonomy, risk stage)', () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    const { engine } = makeEngine({ refPresent: false, riskRejects: counter });
    const d = engine.evaluate(intent(), snapshot());
    expect(d.verdict).toBe('REJECTED');
    expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      { code: 'STALE_DATA' },
    ]);
  });

  it('engages the kill switch on a daily-loss halt', () => {
    const { engine, kill } = makeEngine();
    const d = engine.evaluate(
      intent(),
      snapshot({ equity: new Decimal(5_000), sodEquityUtc: new Decimal(10_000) }),
    );
    expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['DAILY_LOSS'] });
    expect(kill.state()).toBe('HALTING');
  });

  it('engages the kill switch with flatten on a drawdown halt', () => {
    const { engine, kill } = makeEngine();
    const d = engine.evaluate(
      intent(),
      snapshot({
        equity: new Decimal(4_000),
        peakEquity: new Decimal(10_000),
        sodEquityUtc: new Decimal(4_000),
      }),
    );
    expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['MAX_DRAWDOWN'] });
    expect(kill.state()).toBe('HALTING'); // flatten-requested branch
  });

  it('REJECTS when the symbol has no exchange filters (incomplete venue config)', () => {
    const { engine, journal } = makeEngine({ deps: { filters: new Map() } });
    const d = engine.evaluate(intent(), snapshot());
    expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['LIMITS_INCOMPLETE'] });
    expect(journal.records).toHaveLength(1);
  });

  it('RESIZES and mints when a clamp shrinks the order', () => {
    const { engine } = makeEngine({ deps: { limits: { ...LIMITS, maxPositionPerSymbol: '10' } } });
    const d = engine.evaluate(intent({ qty: qty('20') }), snapshot());
    expect(d.verdict).toBe('RESIZED');
    if (d.verdict === 'RESIZED') {
      expect(d.originalQty.toFixed()).toBe('20');
      expect(d.approved.intent.qty.toFixed()).toBe('10');
    }
  });

  // A strategy's reduce-only intent MUST draw from the normal per-symbol bucket, never the
  // reserved flatten bucket (which exists so the kill switch can always flatten). The symbol
  // cap is 2: two normal intents exhaust it, so a third — reduce-only — intent rejects with
  // RATE_LIMIT at R1. The old bug routed reduce-only to the untouched flatten bucket, which
  // would have passed R1 and rejected at F2 with REDUCE_ONLY_VIOLATION (no position) — a
  // different reason code. Asserting RATE_LIMIT proves reduce-only consumed the normal bucket.
  it('drains the normal per-symbol rate bucket for a reduce-only intent (not the flatten bucket)', () => {
    const { engine } = makeEngine();
    expect(engine.evaluate(intent(), snapshot()).verdict).toBe('APPROVED');
    expect(engine.evaluate(intent(), snapshot()).verdict).toBe('APPROVED');
    const d = engine.evaluate(intent({ reduceOnly: true, side: 'SELL' }), snapshot());
    expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['RATE_LIMIT'] });
  });

  // The flatten path is the kill switch's only way out: it MUST clear evaluate end-to-end while
  // FLATTENING and mint a proof the execution gate then verifies. If any gate silently vetoed a
  // flatten, the bot would deadlock halted-but-unable-to-flatten — this is that guard.
  const longPos = () =>
    new Map<string, Position>([
      [
        `${SID}:${V}:${SYM}`,
        {
          strategyId: SID,
          venue: V,
          symbol: SYM,
          signedQty: new Decimal('2'),
          avgEntry: price('100'),
          realizedPnl: new Decimal(0),
        },
      ],
    ]);

  it('evaluateFlatten APPROVES a reduce-only flatten during FLATTENING and mints a verifiable proof', () => {
    const { engine, kill } = makeEngine();
    kill.engage('drawdown', true); // RUNNING → HALTING
    kill.confirmCancels(); // HALTING → FLATTENING (flatten requested)
    expect(kill.state()).toBe('FLATTENING');

    const d = engine.evaluateFlatten(
      intent({ reduceOnly: true, side: 'SELL', qty: qty('2') }),
      snapshot({ positions: longPos() }),
    );
    expect(['APPROVED', 'RESIZED']).toContain(d.verdict);
    if (d.verdict === 'APPROVED' || d.verdict === 'RESIZED') {
      // The gate would verify exactly this proof before placing the order.
      expect(verifyApproval(d.approved, Buffer.alloc(32, 1), epochMs(T), false)).toBe('OK');
    }
  });

  it('evaluateFlatten draws from the RESERVED flatten bucket, not the drained normal one', () => {
    const { engine, kill } = makeEngine();
    // Exhaust the normal per-symbol bucket (cap 2) while RUNNING.
    expect(engine.evaluate(intent(), snapshot()).verdict).toBe('APPROVED');
    expect(engine.evaluate(intent(), snapshot()).verdict).toBe('APPROVED');
    // Now flatten: a separate reserved bucket, so R1 still passes even though the normal one is dry.
    kill.engage('drawdown', true);
    kill.confirmCancels();
    const d = engine.evaluateFlatten(
      intent({ reduceOnly: true, side: 'SELL', qty: qty('2') }),
      snapshot({ positions: longPos() }),
    );
    expect(['APPROVED', 'RESIZED']).toContain(d.verdict);
  });

  it('evaluateFlatten still hard-rejects KILL_SWITCH for a non-reduce-only intent (carve-out is reduce-only)', () => {
    const { engine, kill } = makeEngine();
    kill.engage('drawdown', true);
    kill.confirmCancels(); // FLATTENING
    const d = engine.evaluateFlatten(
      intent({ reduceOnly: false }),
      snapshot({ positions: longPos() }),
    );
    expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['KILL_SWITCH'] });
  });
});
