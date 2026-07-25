import Decimal from 'decimal.js';
import type { Counter } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type { SymbolFilters } from '../../../../src/domain/trading/risk/evaluate';
import type { PartialRiskLimits } from '../../../../src/domain/trading/risk/limits';
import { verifyApproval } from '../../../../src/domain/trading/risk/proof';
import {
  encodeClientOrderId,
  epochMs,
  intentId,
  strategyId,
  symbolId,
  venueId,
} from '../../../../src/domain/common/types/ids';
import { price, qty } from '../../../../src/domain/common/types/money';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';
import type { PortfolioSnapshot, Position } from '../../../../src/domain/trading/types/portfolio';
import type { RiskDecision } from '../../../../src/domain/trading/types/risk-decision';
import { CrossingRegistryService } from '../../../../src/features/trading/risk/crossing-registry.service';
import { KillSwitchService } from '../../../../src/features/trading/risk/kill-switch.service';
import { RateBucketsService } from '../../../../src/features/trading/risk/rate-buckets.service';
import { RiskEngineService } from '../../../../src/features/trading/risk/risk-engine.service';
import type { ClockPort } from '../../../../src/ports/common/clock';
import type { FeedHealthPort } from '../../../../src/ports/venue/market-data';
import type { RiskEngineDeps, RiskJournalPort } from '../../../../src/ports/trading/risk';

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
    updateRefPrice: () => undefined,
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
    // Per-channel feed health, for the menu-rotation regression below. Default keeps every channel
    // 'LIVE' so existing cases are unchanged.
    feedPort?: FeedHealthPort;
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
    over.feedPort ?? feed(over.refPresent ?? true),
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

  // Regression, confirmed live 2026-07-22: the mark's ref price is fed by BOTH the ticker and the
  // order-book channels (teeing-market-stream.ts's observe()), but this engine probed 'book' ALONE.
  // `book` is subscribed only for the active menu (8 of 40 symbols, and the menu rotates), so every
  // off-menu symbol answered the unknown-channel default 'GAP' and was vetoed STALE_DATA forever —
  // 32 of 40 symbols could never trade and the orders table was empty across the whole DB history.
  it('APPROVES when the book channel is absent (GAP) but the ticker feeding the same ref price is LIVE', () => {
    const feedPort: FeedHealthPort = {
      getRefPrice: () => ({ mid: price('100'), at: epochMs(T) }),
      updateRefPrice: () => undefined,
      // Exactly the off-menu shape: no book subscription, healthy universe-wide ticker.
      health: (_v, _s, channel) => (channel === 'book' ? 'GAP' : 'LIVE'),
      fetchCandles: () => Promise.resolve([]),
    };
    const { engine } = makeEngine({ feedPort });
    const d = engine.evaluate(intent(), snapshot());
    expect(d.verdict).toBe('APPROVED'); // pre-fix this was REJECTED ['STALE_DATA']
  });

  it('still REJECTS STALE_DATA when BOTH the book and ticker channels are down (gate not weakened)', () => {
    const feedPort: FeedHealthPort = {
      getRefPrice: () => ({ mid: price('100'), at: epochMs(T) }),
      updateRefPrice: () => undefined,
      health: () => 'GAP',
      fetchCandles: () => Promise.resolve([]),
    };
    const { engine } = makeEngine({ feedPort });
    const d = engine.evaluate(intent(), snapshot());
    expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['STALE_DATA'] });
  });

  // The book leg is load-bearing and was previously unpinned: Binance USD-M's @ticker carries no
  // bid/ask, and normalizeTicker drops a payload without them (the throw is swallowed in
  // market-data.service.ts), so for perps the BOOK can be the sole producer of the ref price. Without
  // this test, "simplify to ticker only" would pass every other case here and silently break perps.
  it('APPROVES when the ticker is GAP but the book feeding the same ref price is LIVE (perp shape)', () => {
    const feedPort: FeedHealthPort = {
      getRefPrice: () => ({ mid: price('100'), at: epochMs(T) }),
      updateRefPrice: () => undefined,
      health: (_v, _s, channel) => (channel === 'ticker' ? 'GAP' : 'LIVE'),
      fetchCandles: () => Promise.resolve([]),
    };
    const { engine } = makeEngine({ feedPort });
    expect(engine.evaluate(intent(), snapshot()).verdict).toBe('APPROVED');
  });

  // Security review MF1: ageMs = now - ref.at, so a FUTURE stamp yields a NEGATIVE age that an
  // upper-bound-only test accepts. It is doubly dangerous because updateRefPrice only accepts
  // `at >= existing.at`, so one such frame PINS the mark and every correct frame after it is dropped.
  it('REJECTS STALE_DATA on a FUTURE-stamped ref price (negative age is a broken clock, not freshness)', () => {
    const feedPort: FeedHealthPort = {
      getRefPrice: () => ({ mid: price('100'), at: epochMs(T + 3_600_000) }), // an hour ahead
      updateRefPrice: () => undefined,
      health: () => 'LIVE',
      fetchCandles: () => Promise.resolve([]),
    };
    const { engine } = makeEngine({ feedPort });
    expect(engine.evaluate(intent(), snapshot())).toMatchObject({
      verdict: 'REJECTED',
      reasons: ['STALE_DATA'],
    });
  });

  it('still REJECTS STALE_DATA on an aged ref price even with both channels LIVE (freshness bound intact)', () => {
    const feedPort: FeedHealthPort = {
      // 5001ms old against staleMaxAgeMs 5000 — one ms past the bound.
      getRefPrice: () => ({ mid: price('100'), at: epochMs(T - 5001) }),
      updateRefPrice: () => undefined,
      health: () => 'LIVE',
      fetchCandles: () => Promise.resolve([]),
    };
    const { engine } = makeEngine({ feedPort });
    const d = engine.evaluate(intent(), snapshot());
    expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['STALE_DATA'] });
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

  // ── CONFIRMED risk-cap bypass fix: E2/E3 (gross/net exposure) must reserve resting/in-flight
  // ENTRY order notional across ALL symbols, not just snapshot.positions — pre-fix a resting order
  // on one symbol was invisible to another symbol's gross/net headroom (evidence: risk-engine.
  // service.ts:104). SYM2 stands in for "a different symbol" so the reservation is provably
  // cross-symbol, not merely same-symbol (E1 already handled the same-symbol/same-lane case). ──
  describe('reserved exposure: resting/in-flight orders close the E2/E3 gross/net bypass', () => {
    const SYM2 = symbolId('ETH/USDT');

    it('(c) positions $1000 + resting entries $300 (a different symbol) vs gross cap $1200 ⇒ a new $100 entry REJECTED', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('10'), // × avgEntry 100 = $1000 filled position notional
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const resting = intent({
        clientOrderId: encodeClientOrderId(
          intentId('01900000-0000-7000-8000-000000000001'),
          'paper',
        ),
        symbol: SYM2,
        side: 'BUY',
        qty: qty('3'),
        limitPrice: price('100'), // $300 reserved notional, on a DIFFERENT symbol than the new intent
        reduceOnly: false,
      });
      const { engine } = makeEngine({
        deps: { limits: { ...LIMITS, maxGrossExposure: '1200', maxNetExposure: '1000000' } },
      });
      // Pre-fix: currentGross counted only the $1000 position ⇒ headroom 1200−1000=200 ⇒ the $100
      // entry (intent()'s default qty 1 @ limitPrice 100) would have APPROVED. Post-fix: currentGross
      // also reserves the $300 resting entry ⇒ headroom 1200−1300=−100 ⇒ REJECTED outright.
      const d = engine.evaluate(intent(), snapshot({ positions, inFlightIntents: [resting] }));
      expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['EXPOSURE_LIMIT'] });
    });

    it('a reduce-only resting order reserves nothing for gross/net — the same $1000 position + $300 reduce-only resting order still APPROVES under the $1200 gross cap', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('10'),
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const restingReduceOnly = intent({
        clientOrderId: encodeClientOrderId(
          intentId('01900000-0000-7000-8000-000000000002'),
          'paper',
        ),
        symbol: SYM2,
        side: 'SELL',
        qty: qty('3'),
        limitPrice: price('100'),
        reduceOnly: true,
      });
      const { engine } = makeEngine({
        deps: { limits: { ...LIMITS, maxGrossExposure: '1200', maxNetExposure: '1000000' } },
      });
      // currentGross = $1000 (position only; the reduce-only resting order reserves nothing) ⇒
      // headroom 1200−1000=200 ⇒ the $100 entry passes.
      const d = engine.evaluate(
        intent(),
        snapshot({ positions, inFlightIntents: [restingReduceOnly] }),
      );
      expect(d.verdict).toBe('APPROVED');
    });

    it('a resting entry with NO limit price reserves at its own refPrice, not zero', () => {
      // A MARKET entry carries no limit leg, so refPrice is the only available valuation — treating
      // it as zero notional would reopen the same E2/E3 bypass the reservation fold above closes.
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('10'), // × avgEntry 100 = $1000 filled position notional
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const restingMarket = intent({
        clientOrderId: encodeClientOrderId(
          intentId('01900000-0000-7000-8000-000000000004'),
          'paper',
        ),
        symbol: SYM2,
        side: 'BUY',
        type: 'MARKET',
        qty: qty('3'),
        limitPrice: undefined,
        refPrice: price('100'), // $300 reserved, valued off refPrice
        reduceOnly: false,
      });
      const { engine } = makeEngine({
        deps: { limits: { ...LIMITS, maxGrossExposure: '1200', maxNetExposure: '1000000' } },
      });
      // Valued at zero, currentGross would be $1000 ⇒ headroom 200 ⇒ the $100 entry APPROVES.
      // Valued at refPrice, currentGross is $1300 ⇒ over the $1200 cap ⇒ REJECTED.
      const d = engine.evaluate(
        intent(),
        snapshot({ positions, inFlightIntents: [restingMarket] }),
      );
      expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['EXPOSURE_LIMIT'] });
    });

    it('net-cap sign case for a short: reserved SELL entries drive currentNet negative, correctly binding a new short against −maxNetExposure', () => {
      // No filled positions — purely resting/in-flight SELL entries reserve the short exposure.
      const restingShort = intent({
        clientOrderId: encodeClientOrderId(
          intentId('01900000-0000-7000-8000-000000000003'),
          'paper',
        ),
        symbol: SYM2,
        side: 'SELL',
        qty: qty('11'),
        limitPrice: price('100'), // $1100 reserved short notional ⇒ currentNet = −1100
        reduceOnly: false,
      });
      const { engine } = makeEngine({
        deps: { limits: { ...LIMITS, maxGrossExposure: '10000', maxNetExposure: '1000' } },
      });
      // Pre-fix: currentNet ignored resting orders ⇒ stayed 0 ⇒ signedNet(SELL)=0 ⇒ netHeadroom
      // 1000−0=1000 ⇒ APPROVED. Post-fix: currentNet=−1100 ⇒ signedNet(SELL)=−(−1100)=1100 ⇒
      // netHeadroom 1000−1100=−100 ≤ 0 ⇒ REJECTED — the −maxNetExposure bound on the short side is
      // enforced against the reserved short notional, not just filled positions.
      const d = engine.evaluate(
        intent({ side: 'SELL' }),
        snapshot({ inFlightIntents: [restingShort] }),
      );
      expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['EXPOSURE_LIMIT'] });
    });
  });

  // v3 §1.5/§10: gross/net exposure and drawdown are BOOK-scoped (one snapshot, one equity) — the
  // fold in run() above iterates snapshot.positions/inFlightIntents with no venue filter at all, so
  // a two-venue book's exposure sums across both venues automatically. This proves it explicitly
  // (rather than merely by absence of a venue predicate): a spot position + a perp position together
  // must bind a single combined gross/net cap, and neither venue alone would trip it.
  describe('v3 §6.4/§10: combined-book (cross-venue) gross/net exposure', () => {
    const V_PERP = venueId('binanceusdm');
    const SYM_PERP = symbolId('BTC/USDT:USDT');

    it('a spot position + a perp position on the SAME strategy sum into ONE gross/net exposure', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('6'), // × avgEntry 100 = $600 spot notional
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
        [
          `${SID}:${V_PERP}:${SYM_PERP}`,
          {
            strategyId: SID,
            venue: V_PERP,
            symbol: SYM_PERP,
            signedQty: new Decimal('6'), // × avgEntry 100 = $600 perp notional
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const { engine } = makeEngine({
        deps: {
          limits: { ...LIMITS, maxGrossExposure: '1200', maxNetExposure: '1000000' },
          filters: new Map([
            [String(SYM), FILTERS],
            [String(SYM_PERP), FILTERS],
          ]),
        },
      });
      // Neither position alone ($600) would trip a $1200 gross cap; SUMMED ($1200) leaves exactly 0
      // headroom for a new $100 spot entry ⇒ REJECTED — proof the two venues share one exposure pool.
      const d = engine.evaluate(intent(), snapshot({ positions }));
      expect(d).toMatchObject({ verdict: 'REJECTED', reasons: ['EXPOSURE_LIMIT'] });
    });
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

  // v3 §1.5/§7.2: "Arming flips both venues together — there is no per-venue armed state" and the
  // kill switch is ONE book-global instance (KillSwitchService, unchanged). This proves the FLATTEN
  // carve-out (G0) is venue-blind: a flatten intent for EITHER venue clears while FLATTENING off the
  // SAME kill-switch state, with no venue-keyed gate anywhere in between.
  it('the FLATTENING carve-out reaches a flatten intent for EITHER venue off the SAME kill switch', () => {
    const V_PERP = venueId('binanceusdm');
    const SYM_PERP = symbolId('BTC/USDT:USDT');
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
      [
        `${SID}:${V_PERP}:${SYM_PERP}`,
        {
          strategyId: SID,
          venue: V_PERP,
          symbol: SYM_PERP,
          signedQty: new Decimal('2'),
          avgEntry: price('100'),
          realizedPnl: new Decimal(0),
        },
      ],
    ]);
    const { engine, kill } = makeEngine({
      deps: {
        filters: new Map([
          [String(SYM), FILTERS],
          [String(SYM_PERP), FILTERS],
        ]),
      },
    });
    kill.engage('drawdown', true); // RUNNING → HALTING
    kill.confirmCancels(); // HALTING → FLATTENING — ONE state, shared by both venues
    expect(kill.state()).toBe('FLATTENING');

    const dSpot = engine.evaluateFlatten(
      intent({ reduceOnly: true, side: 'SELL', qty: qty('2') }),
      snapshot({ positions }),
    );
    const dPerp = engine.evaluateFlatten(
      intent({ venue: V_PERP, symbol: SYM_PERP, reduceOnly: true, side: 'SELL', qty: qty('2') }),
      snapshot({ positions }),
    );
    // Neither venue's flatten is vetoed by G0 — the SAME FLATTENING state clears both, proving the
    // carve-out never checks (or needs) a venue-scoped kill-switch flag.
    expect(['APPROVED', 'RESIZED']).toContain(dSpot.verdict);
    expect(['APPROVED', 'RESIZED']).toContain(dPerp.verdict);
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
