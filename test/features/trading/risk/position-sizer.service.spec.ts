import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import type { SymbolFilters } from '../../../../src/domain/trading/risk/evaluate';
import {
  clientOrderId,
  epochMs,
  intentId,
  strategyId,
  symbolId,
  venueId,
} from '../../../../src/domain/common/types/ids';
import { price, qty } from '../../../../src/domain/common/types/money';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';
import type { PortfolioSnapshot, Position } from '../../../../src/domain/trading/types/portfolio';
import type { Signal } from '../../../../src/domain/strategy/types/signal';
import { PositionSizerService } from '../../../../src/features/trading/risk/position-sizer.service';
import type { ClockPort } from '../../../../src/ports/common/clock';
import type { SizerDeps } from '../../../../src/ports/trading/risk';

const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const SID = strategyId('s');
const clock: ClockPort = { now: () => epochMs(1700000000000) };
const FILTERS: SymbolFilters = {
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  minNotional: '5',
};

function deps(over: Partial<SizerDeps> = {}): SizerDeps {
  return {
    baseNotional: '1000',
    mode: 'paper',
    filters: new Map([[String(SYM), FILTERS]]),
    randomBytes: (n) => new Uint8Array(n).fill(7),
    ...over,
  };
}

function signal(o: Partial<Signal> = {}): Signal {
  return {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    kind: 'ENTER_LONG',
    strength: 1,
    refPrice: price('100'),
    basedOnSeq: 7n,
    eventTime: epochMs(1000),
    ttlMs: 5000,
    dedupeKey: 'k',
    reason: 'r',
    ...o,
  };
}

// A resting-or-in-flight ENTRY order the sizer's headroom clamp must reserve against (see
// reservedEntryNotional). One counter drives distinct clientOrderIds across calls in one test.
let restingSeq = 0;
function restingIntent(o: Partial<OrderIntent> = {}): OrderIntent {
  restingSeq += 1;
  return {
    intentId: intentId(
      `01900000-0000-7000-8000-00000000${restingSeq.toString(16).padStart(4, '0')}`,
    ),
    clientOrderId: clientOrderId(`resting-${restingSeq}`),
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
    createdAt: clock.now(),
    expiresAt: epochMs(clock.now() + 5000),
    source: { dedupeKey: 'resting', eventTime: epochMs(1000), basedOnSeq: 1n, strength: 1 },
    ...o,
  };
}

function snapshot(
  positions = new Map<string, Position>(),
  over: {
    equity?: Decimal;
    balances?: Map<string, { free: Decimal; locked: Decimal }>;
    inFlightIntents?: readonly OrderIntent[];
    // v3 §6.4: per-venue wallet view — optional, absent in every pre-split fixture (byte-identical).
    venueBalances?: PortfolioSnapshot['venueBalances'];
  } = {},
): PortfolioSnapshot {
  return {
    positions,
    balances: over.balances ?? new Map(),
    openOrders: [],
    inFlightIntents: over.inFlightIntents ?? [],
    equity: over.equity ?? new Decimal(0),
    unrealized: new Decimal(0),
    startingCash: new Decimal(0),
    peakEquity: new Decimal(0),
    sodEquityUtc: new Decimal(0),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
    venueBalances: over.venueBalances,
  };
}

describe('PositionSizerService', () => {
  it('sizes an ENTER_LONG buy from base notional × conviction', () => {
    const r = new PositionSizerService(clock, deps()).size(signal(), snapshot());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.side).toBe('BUY');
      expect(r.intent.reduceOnly).toBe(false);
      expect(r.intent.qty.toFixed()).toBe('10'); // 1000 × 1 / 100
      expect(r.intent.expiresAt).toBe(clock.now() + 5000);
    }
  });

  it('sizes a non-round price by rounding raw qty to the step (no precision throw)', () => {
    // Regression: 1000 / 101 = 9.900990099… exceeds the 18-place precision limit. The sizer must
    // round to the 0.001 step BEFORE validating, not throw — otherwise nearly every real price fails.
    const r = new PositionSizerService(clock, deps()).size(
      signal({ refPrice: price('101') }),
      snapshot(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.intent.qty.toFixed()).toBe('9.9'); // 9.900990… floored to the step
  });

  it('sizes an EXIT_LONG as a reduce-only sell of the attributed position', () => {
    const positions = new Map<string, Position>([
      [
        `${SID}:${V}:${SYM}`,
        {
          strategyId: SID,
          venue: V,
          symbol: SYM,
          signedQty: new Decimal('5'),
          avgEntry: price('100'),
          realizedPnl: new Decimal(0),
        },
      ],
    ]);
    const r = new PositionSizerService(clock, deps()).size(
      signal({ kind: 'EXIT_LONG' }),
      snapshot(positions),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.side).toBe('SELL');
      expect(r.intent.reduceOnly).toBe(true);
      expect(r.intent.qty.toFixed()).toBe('5');
    }
  });

  it('rejects when there are no filters for the symbol', () => {
    const r = new PositionSizerService(clock, deps({ filters: new Map() })).size(
      signal(),
      snapshot(),
    );
    expect(r).toEqual({ ok: false, reason: 'NO_REF_PRICE' });
  });

  it('rejects an EXIT with no position to reduce as NO_POSITION (distinct from a dust order)', () => {
    const r = new PositionSizerService(clock, deps()).size(signal({ kind: 'FLATTEN' }), snapshot());
    expect(r).toEqual({ ok: false, reason: 'NO_POSITION' });
  });

  it('rejects below the exchange minimum notional', () => {
    const r = new PositionSizerService(clock, deps({ baseNotional: '1' })).size(
      signal({ strength: 0.001 }),
      snapshot(),
    );
    expect(r).toEqual({ ok: false, reason: 'BELOW_MINIMUM' });
  });

  // ── Short support (Phase 3): all six kinds map to the correct side + reduceOnly ──
  function shortPosition(): Map<string, Position> {
    return new Map<string, Position>([
      [
        `${SID}:${V}:${SYM}`,
        {
          strategyId: SID,
          venue: V,
          symbol: SYM,
          signedQty: new Decimal('-4'), // net short 4
          avgEntry: price('100'),
          realizedPnl: new Decimal(0),
        },
      ],
    ]);
  }

  it('sizes an ENTER_SHORT as a non-reduce sell from base notional × conviction', () => {
    const r = new PositionSizerService(clock, deps()).size(
      signal({ kind: 'ENTER_SHORT' }),
      snapshot(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.side).toBe('SELL');
      expect(r.intent.reduceOnly).toBe(false);
      expect(r.intent.qty.toFixed()).toBe('10'); // 1000 × 1 / 100, like an entry
    }
  });

  it('sizes an EXIT_SHORT as a reduce-only buy covering the attributed short', () => {
    const r = new PositionSizerService(clock, deps()).size(
      signal({ kind: 'EXIT_SHORT' }),
      snapshot(shortPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.side).toBe('BUY'); // cover
      expect(r.intent.reduceOnly).toBe(true);
      expect(r.intent.qty.toFixed()).toBe('4'); // |signedQty|
    }
  });

  it('orients FLATTEN opposite the position sign: SELL a long, BUY a short', () => {
    const long = new Map<string, Position>([
      [
        `${SID}:${V}:${SYM}`,
        {
          strategyId: SID,
          venue: V,
          symbol: SYM,
          signedQty: new Decimal('3'),
          avgEntry: price('100'),
          realizedPnl: new Decimal(0),
        },
      ],
    ]);
    const flatLong = new PositionSizerService(clock, deps()).size(
      signal({ kind: 'FLATTEN' }),
      snapshot(long),
    );
    expect(flatLong.ok).toBe(true);
    if (flatLong.ok) expect(flatLong.intent.side).toBe('SELL');

    const flatShort = new PositionSizerService(clock, deps()).size(
      signal({ kind: 'FLATTEN' }),
      snapshot(shortPosition()),
    );
    expect(flatShort.ok).toBe(true);
    if (flatShort.ok) {
      expect(flatShort.intent.side).toBe('BUY');
      expect(flatShort.intent.reduceOnly).toBe(true);
      expect(flatShort.intent.qty.toFixed()).toBe('4');
    }
  });

  it('rejects CANCEL_OPEN as NO_POSITION — not an order-producing signal', () => {
    const r = new PositionSizerService(clock, deps()).size(
      signal({ kind: 'CANCEL_OPEN' }),
      snapshot(shortPosition()), // even while holding, CANCEL_OPEN places no order
    );
    expect(r).toEqual({ ok: false, reason: 'NO_POSITION' });
  });

  // ── Marketable exits: reduce-only intents cross the spread and go IOC ──
  function longPosition(): Map<string, Position> {
    return new Map<string, Position>([
      [
        `${SID}:${V}:${SYM}`,
        {
          strategyId: SID,
          venue: V,
          symbol: SYM,
          signedQty: new Decimal('5'),
          avgEntry: price('100'),
          realizedPnl: new Decimal(0),
        },
      ],
    ]);
  }

  it('sizes a reduce-only SELL (EXIT_LONG) as marketable IOC, crossed down and tick-rounded', () => {
    const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({ kind: 'EXIT_LONG', refPrice: price('100') }),
      snapshot(longPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.timeInForce).toBe('IOC');
      expect(r.intent.type).toBe('LIMIT');
      // 100 × (1 − 25/10000) = 99.75, already a multiple of tick 0.01 ⇒ rounds down to itself.
      expect(r.intent.limitPrice?.toFixed()).toBe('99.75');
    }
  });

  it('sizes a reduce-only BUY (EXIT_SHORT cover) as marketable IOC, crossed up and tick-rounded', () => {
    const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({ kind: 'EXIT_SHORT', refPrice: price('100') }),
      snapshot(shortPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.timeInForce).toBe('IOC');
      // 100 × (1 + 25/10000) = 100.25, already a multiple of tick 0.01 ⇒ rounds up to itself.
      expect(r.intent.limitPrice?.toFixed()).toBe('100.25');
    }
  });

  it('leaves entries (ENTER_LONG/ENTER_SHORT) at LIMIT/GTC, unaffected by the exit buffer', () => {
    const enterLong = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({ kind: 'ENTER_LONG', refPrice: price('100') }),
      snapshot(),
    );
    expect(enterLong.ok).toBe(true);
    if (enterLong.ok) {
      expect(enterLong.intent.timeInForce).toBe('GTC');
      expect(enterLong.intent.limitPrice?.toFixed()).toBe('100');
    }

    const enterShort = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({ kind: 'ENTER_SHORT', refPrice: price('100') }),
      snapshot(),
    );
    expect(enterShort.ok).toBe(true);
    if (enterShort.ok) {
      expect(enterShort.intent.timeInForce).toBe('GTC');
      expect(enterShort.intent.limitPrice?.toFixed()).toBe('100');
    }
  });

  it('buffer 0 still emits IOC, priced at the tick-rounded refPrice with no crossing', () => {
    const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 0 })).size(
      signal({ kind: 'EXIT_LONG', refPrice: price('100') }),
      snapshot(longPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.timeInForce).toBe('IOC');
      expect(r.intent.limitPrice?.toFixed()).toBe('100');
    }
  });

  it('falls back to a 25bps buffer when deps omit exitCrossBufferBps', () => {
    const depsWithoutBuffer = deps();
    expect(depsWithoutBuffer.exitCrossBufferBps).toBeUndefined();
    const r = new PositionSizerService(clock, depsWithoutBuffer).size(
      signal({ kind: 'EXIT_LONG', refPrice: price('100') }),
      snapshot(longPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.timeInForce).toBe('IOC');
      expect(r.intent.limitPrice?.toFixed()).toBe('99.75'); // default 25bps, same as the explicit case
    }
  });

  it('a caller-supplied limitPriceHint on a reduce-only signal wins over the crossed-exit computation', () => {
    // Mirrors halt-coordinator's kill-switch FLATTEN path, which prices its own band-edge hint.
    const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({ kind: 'EXIT_LONG', refPrice: price('100'), limitPriceHint: price('97') }),
      snapshot(longPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.timeInForce).toBe('IOC'); // still IOC — reduceOnly drives TIF, not the hint
      expect(r.intent.limitPrice?.toFixed()).toBe('97');
    }
  });

  // ── Passive resting exits (exitStyle 'RESTING'): plan-mode take-profit rests GTC at the hint ──
  it("exitStyle 'RESTING' with a hint prices the exit LIMIT+GTC at the hint, tick-rounded UP for SELL (exact string)", () => {
    const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({
        kind: 'EXIT_LONG',
        refPrice: price('100'),
        exitStyle: 'RESTING',
        limitPriceHint: price('110.006'),
      }),
      snapshot(longPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.type).toBe('LIMIT');
      expect(r.intent.timeInForce).toBe('GTC');
      expect(r.intent.limitPrice?.toFixed()).toBe('110.01'); // 110.006 rounded UP to the 0.01 tick
    }
  });

  it("exitStyle 'RESTING' with no hint falls back to the ordinary crossed-IOC exit path (never guesses a price)", () => {
    const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({ kind: 'EXIT_LONG', refPrice: price('100'), exitStyle: 'RESTING' }),
      snapshot(longPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.timeInForce).toBe('IOC');
      expect(r.intent.limitPrice?.toFixed()).toBe('99.75'); // same crossed-down pricing as the non-RESTING case
    }
  });

  // ── Protective-stop resting exits (exitStyle 'RESTING_STOP', Push 3 P7b) ──
  describe("exitStyle 'RESTING_STOP' — venue trigger orders", () => {
    const V_PERP = venueId('binanceusdm');
    const SYM_PERP = symbolId('BTC/USDT:USDT');

    function perpFilters(): Map<string, SymbolFilters> {
      return new Map([
        [String(SYM), FILTERS],
        [String(SYM_PERP), FILTERS],
      ]);
    }

    // Position map keyed against the PERP venue/symbol — longPosition()/shortPosition() above key
    // against the spot (V, SYM) pair, so a perp-venue signal would otherwise find NO_POSITION.
    function perpLongPosition(): Map<string, Position> {
      return new Map<string, Position>([
        [
          `${SID}:${V_PERP}:${SYM_PERP}`,
          {
            strategyId: SID,
            venue: V_PERP,
            symbol: SYM_PERP,
            signedQty: new Decimal('5'),
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
    }
    function perpShortPosition(): Map<string, Position> {
      return new Map<string, Position>([
        [
          `${SID}:${V_PERP}:${SYM_PERP}`,
          {
            strategyId: SID,
            venue: V_PERP,
            symbol: SYM_PERP,
            signedQty: new Decimal('-4'),
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
    }

    it('a perp SELL stop builds a STOP_MARKET with no limit leg, GTC reduceOnly', () => {
      const r = new PositionSizerService(clock, deps({ filters: perpFilters() })).size(
        signal({
          venue: V_PERP,
          symbol: SYM_PERP,
          kind: 'EXIT_LONG',
          refPrice: price('100'),
          exitStyle: 'RESTING_STOP',
          triggerPriceHint: price('95.006'),
        }),
        snapshot(perpLongPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.type).toBe('STOP_MARKET');
        expect(r.intent.limitPrice).toBeUndefined();
        expect(r.intent.timeInForce).toBe('GTC');
        expect(r.intent.reduceOnly).toBe(true);
        // Protective direction: a SELL stop rounds its trigger DOWN — never tighter/closer to the
        // current price than requested.
        expect(r.intent.triggerPrice?.toFixed()).toBe('95');
      }
    });

    it('a perp BUY-cover stop builds a STOP_MARKET with a trigger rounded UP (protective direction)', () => {
      const r = new PositionSizerService(clock, deps({ filters: perpFilters() })).size(
        signal({
          venue: V_PERP,
          symbol: SYM_PERP,
          kind: 'EXIT_SHORT',
          refPrice: price('100'),
          exitStyle: 'RESTING_STOP',
          triggerPriceHint: price('105.001'),
        }),
        snapshot(perpShortPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.type).toBe('STOP_MARKET');
        expect(r.intent.limitPrice).toBeUndefined();
        expect(r.intent.triggerPrice?.toFixed()).toBe('105.01'); // rounded UP — never tighter
      }
    });

    it('P7e fix: a reduce-only perp stop BELOW minNotional is allowed (venue -4164 exempts reduce-only; minQty still binds)', () => {
      // Trigger-notional 4 × 95 = 380 < 500 — pre-fix this self-rejected BELOW_MINIMUM and left
      // the position without its venue stop in the [minNotional, minNotional/(1−slPct)) band.
      const bigFloor = new Map([
        [String(SYM), { ...FILTERS, minNotional: '500' }],
        [String(SYM_PERP), { ...FILTERS, minNotional: '500' }],
      ]);
      const r = new PositionSizerService(clock, deps({ filters: bigFloor })).size(
        signal({
          venue: V_PERP,
          symbol: SYM_PERP,
          kind: 'EXIT_LONG',
          refPrice: price('100'),
          exitStyle: 'RESTING_STOP',
          triggerPriceHint: price('95'),
        }),
        snapshot(perpLongPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.type).toBe('STOP_MARKET');
    });

    it('P7e fix scope: a SPOT reduce-only stop below minNotional still rejects (no spot exemption)', () => {
      const bigFloor = new Map([[String(SYM), { ...FILTERS, minNotional: '500' }]]);
      const r = new PositionSizerService(
        clock,
        deps({ filters: bigFloor, stopLimitBufferBps: 50 }),
      ).size(
        signal({
          kind: 'EXIT_LONG',
          refPrice: price('100'),
          exitStyle: 'RESTING_STOP',
          triggerPriceHint: price('95'),
        }),
        snapshot(longPosition()),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('BELOW_MINIMUM');
    });

    it('a spot SELL stop builds a STOP_LOSS_LIMIT whose leg sits the buffer below the trigger, both tick-rounded down', () => {
      const r = new PositionSizerService(clock, deps({ stopLimitBufferBps: 50 })).size(
        signal({
          kind: 'EXIT_LONG',
          refPrice: price('100'),
          exitStyle: 'RESTING_STOP',
          triggerPriceHint: price('95'),
        }),
        snapshot(longPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.type).toBe('STOP_LOSS_LIMIT');
        expect(r.intent.timeInForce).toBe('GTC');
        expect(r.intent.reduceOnly).toBe(true);
        expect(r.intent.triggerPrice?.toFixed()).toBe('95');
        // 95 × (1 − 50bps) = 94.525, tick-rounded DOWN (marketable once triggered) ⇒ 94.52.
        expect(r.intent.limitPrice?.toFixed()).toBe('94.52');
      }
    });

    it('a spot BUY-cover stop builds a STOP_LOSS_LIMIT whose leg sits the buffer above the trigger, both tick-rounded up', () => {
      const r = new PositionSizerService(clock, deps({ stopLimitBufferBps: 50 })).size(
        signal({
          kind: 'EXIT_SHORT',
          refPrice: price('100'),
          exitStyle: 'RESTING_STOP',
          triggerPriceHint: price('105'),
        }),
        snapshot(shortPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.type).toBe('STOP_LOSS_LIMIT');
        expect(r.intent.triggerPrice?.toFixed()).toBe('105');
        // 105 × (1 + 50bps) = 105.525, tick-rounded UP (marketable once triggered) ⇒ 105.53.
        expect(r.intent.limitPrice?.toFixed()).toBe('105.53');
      }
    });

    it('falls back to a 50bps stop-limit buffer when deps omit stopLimitBufferBps', () => {
      const depsWithoutBuffer = deps();
      expect(depsWithoutBuffer.stopLimitBufferBps).toBeUndefined();
      const r = new PositionSizerService(clock, depsWithoutBuffer).size(
        signal({
          kind: 'EXIT_LONG',
          refPrice: price('100'),
          exitStyle: 'RESTING_STOP',
          triggerPriceHint: price('95'),
        }),
        snapshot(longPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.limitPrice?.toFixed()).toBe('94.52'); // same as the explicit-50bps case
    });

    it('a RESTING_STOP with no triggerPriceHint falls back to the ordinary crossed-IOC exit path (never guesses a trigger)', () => {
      const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
        signal({ kind: 'EXIT_LONG', refPrice: price('100'), exitStyle: 'RESTING_STOP' }),
        snapshot(longPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.type).toBe('LIMIT');
        expect(r.intent.timeInForce).toBe('IOC');
        expect(r.intent.triggerPrice).toBeUndefined();
      }
    });

    it('sizes a RESTING_STOP off the attributed position size (F2 caps downstream)', () => {
      const r = new PositionSizerService(clock, deps()).size(
        signal({
          kind: 'EXIT_LONG',
          refPrice: price('100'),
          exitStyle: 'RESTING_STOP',
          triggerPriceHint: price('95'),
        }),
        snapshot(longPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('5'); // |signedQty| from longPosition()
    });
  });

  it('crosses a non-tick-aligned exit price down (SELL) to the nearest tick below', () => {
    // refPrice 101, buffer 25bps ⇒ 101 × 0.9975 = 100.7475, floored to the 0.01 tick ⇒ 100.74.
    const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({ kind: 'EXIT_LONG', refPrice: price('101') }),
      snapshot(longPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.intent.limitPrice?.toFixed()).toBe('100.74');
  });

  it('crosses a non-tick-aligned cover price up (BUY) to the nearest tick above', () => {
    // refPrice 101, buffer 25bps ⇒ 101 × 1.0025 = 101.2525, ceiled to the 0.01 tick ⇒ 101.26.
    const r = new PositionSizerService(clock, deps({ exitCrossBufferBps: 25 })).size(
      signal({ kind: 'EXIT_SHORT', refPrice: price('101') }),
      snapshot(shortPosition()),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.intent.limitPrice?.toFixed()).toBe('101.26');
  });

  // ── P5 compounding position sizing: equity × fraction × strength on entries ──
  describe('equity-fraction (compounding) entry sizing', () => {
    it('sizes an ENTER_LONG from equity × fraction × strength when the fraction is configured', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.02' })).size(
        signal({ strength: 1 }),
        snapshot(new Map(), { equity: new Decimal('10000') }),
      );
      expect(r.ok).toBe(true);
      // notional = 10000 × 0.02 × 1 = 200; qty = 200 / 100 (refPrice) = 2
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('2');
    });

    it('scales the fractional notional by signal strength', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.02' })).size(
        signal({ strength: 0.5 }),
        snapshot(new Map(), { equity: new Decimal('10000') }),
      );
      expect(r.ok).toBe(true);
      // notional = 10000 × 0.02 × 0.5 = 100; qty = 100 / 100 = 1
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    it('applies the fractional path to ENTER_SHORT too, with no free-quote clamp on the SELL side', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.02' })).size(
        signal({ kind: 'ENTER_SHORT', strength: 1 }),
        // No USDT balance at all — the free-quote clamp only ever applies to BUY entries, so a
        // SELL (short open) is unaffected by its absence.
        snapshot(new Map(), { equity: new Decimal('10000') }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.side).toBe('SELL');
        expect(r.intent.qty.toFixed()).toBe('2'); // same 200 notional / 100 price
      }
    });

    it('clamps a BUY entry at 95% of free quote balance when the target notional exceeds it', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.5' })).size(
        signal({ strength: 1 }),
        snapshot(new Map(), {
          equity: new Decimal('10000'),
          balances: new Map([['USDT', { free: new Decimal('100'), locked: new Decimal(0) }]]),
        }),
      );
      expect(r.ok).toBe(true);
      // Uncapped target = 10000 × 0.5 × 1 = 5000, but free-quote clamp caps at 100 × 0.95 = 95;
      // qty = 95 / 100 (refPrice) = 0.95.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('0.95');
    });

    it('applies no free-quote cap on a BUY entry when the balance map has no entry for the quote asset', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.02' })).size(
        signal({ strength: 1 }),
        snapshot(new Map(), { equity: new Decimal('10000') }), // balances map is empty
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('2'); // uncapped: 200 / 100
    });

    it('falls back to the legacy baseNotional × strength path when equityFraction is "0"', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0' })).size(
        signal({ strength: 1 }),
        snapshot(new Map(), { equity: new Decimal('10000') }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('10'); // 1000 (baseNotional) × 1 / 100
    });

    it('falls back to the legacy path when equityFraction is configured but equity is zero', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.02' })).size(
        signal({ strength: 1 }),
        snapshot(), // default equity: 0
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('10'); // legacy baseNotional path
    });

    it('falls back to the legacy path when equityFraction is configured but equity is negative', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.02' })).size(
        signal({ strength: 1 }),
        snapshot(new Map(), { equity: new Decimal('-500') }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('10'); // legacy baseNotional path
    });

    it('falls back to the legacy path when equity is non-finite (e.g. Infinity)', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.02' })).size(
        signal({ strength: 1 }),
        snapshot(new Map(), { equity: new Decimal(Infinity) }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('10'); // legacy baseNotional path
    });

    it('leaves reduce-only exits unaffected by the equity-fraction clamp (sizes off the attributed position)', () => {
      const r = new PositionSizerService(clock, deps({ equityFraction: '0.02' })).size(
        signal({ kind: 'EXIT_LONG' }),
        snapshot(longPosition(), {
          equity: new Decimal('10000'),
          balances: new Map([['USDT', { free: new Decimal('1'), locked: new Decimal(0) }]]),
        }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('5'); // |signedQty|, not equity-fraction-derived
    });
  });

  // ── D1: maker entries (ENTRY_ORDER_TYPE), default OFF and flag-gated ──
  describe('entry order type (ENTRY_ORDER_TYPE knob)', () => {
    it('default (deps.entryOrderType omitted) emits byte-identical LIMIT entries, exact-string money', () => {
      const r = new PositionSizerService(clock, deps()).size(signal(), snapshot());
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.type).toBe('LIMIT');
        expect(r.intent.qty.toFixed()).toBe('10');
        expect(r.intent.limitPrice?.toFixed()).toBe('100');
        expect(r.intent.timeInForce).toBe('GTC');
      }
    });

    it("knob 'LIMIT' explicitly is byte-identical to the default", () => {
      const r = new PositionSizerService(clock, deps({ entryOrderType: 'LIMIT' })).size(
        signal(),
        snapshot(),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.type).toBe('LIMIT');
    });

    it('knob LIMIT_MAKER emits a maker ENTER_LONG when no hint prices it (basePrice === refPrice, not crossing)', () => {
      const r = new PositionSizerService(clock, deps({ entryOrderType: 'LIMIT_MAKER' })).size(
        signal({ refPrice: price('100') }),
        snapshot(),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.type).toBe('LIMIT_MAKER');
        expect(r.intent.qty.toFixed()).toBe('10'); // unaffected by the order-type knob
      }
    });

    it('knob LIMIT_MAKER emits a maker ENTER_LONG for a passive hint below refPrice (positive entryOffsetBps)', () => {
      const r = new PositionSizerService(clock, deps({ entryOrderType: 'LIMIT_MAKER' })).size(
        signal({ refPrice: price('100'), limitPriceHint: price('99.5') }),
        snapshot(),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.type).toBe('LIMIT_MAKER');
    });

    it('knob LIMIT_MAKER falls back to plain LIMIT for a BUY entry priced above refPrice (crossing / negative entryOffsetBps)', () => {
      const r = new PositionSizerService(clock, deps({ entryOrderType: 'LIMIT_MAKER' })).size(
        signal({ refPrice: price('100'), limitPriceHint: price('100.5') }),
        snapshot(),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.type).toBe('LIMIT');
    });

    it('knob LIMIT_MAKER falls back to plain LIMIT for a SELL entry (ENTER_SHORT) priced below refPrice (crossing)', () => {
      const r = new PositionSizerService(clock, deps({ entryOrderType: 'LIMIT_MAKER' })).size(
        signal({ kind: 'ENTER_SHORT', refPrice: price('100'), limitPriceHint: price('99.5') }),
        snapshot(),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.type).toBe('LIMIT');
    });

    it('knob LIMIT_MAKER never affects exits — EXIT_LONG stays plain LIMIT + IOC regardless', () => {
      const r = new PositionSizerService(clock, deps({ entryOrderType: 'LIMIT_MAKER' })).size(
        signal({ kind: 'EXIT_LONG', refPrice: price('100') }),
        snapshot(longPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.type).toBe('LIMIT');
        expect(r.intent.timeInForce).toBe('IOC');
      }
    });
  });

  // ── Perp entry-sizing caps (B2): notional = min(currentBehavior, margin×leverageCap, liqSafeNotional) ──
  describe('perp entry-sizing caps', () => {
    const V_PERP = venueId('binanceusdm');
    const SYM_PERP = symbolId('BTC/USDT:USDT');

    function perpFilters(): Map<string, SymbolFilters> {
      return new Map([
        [String(SYM), FILTERS],
        [String(SYM_PERP), FILTERS],
      ]);
    }

    function marginBalance(free: string): Map<string, { free: Decimal; locked: Decimal }> {
      return new Map([['USDT', { free: new Decimal(free), locked: new Decimal(0) }]]);
    }

    it('detects a perp signal off the venue alone (plain BASE/QUOTE symbol, binanceusdm venue)', () => {
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters(),
          perp: { leverageCap: '2', mmrFallback: '0.005', liqBufferPct: '0.2' },
        }),
      ).size(
        signal({ venue: V_PERP, symbol: SYM }),
        snapshot(new Map(), { balances: marginBalance('50') }),
      );
      expect(r.ok).toBe(true);
      // margin×leverageCap = 50×2 = 100 binds under the 1000 legacy notional ⇒ qty = 100/100 = 1.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    it('detects a perp signal off the :SETTLE symbol suffix alone (spot venue id)', () => {
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters(),
          perp: { leverageCap: '2', mmrFallback: '0.005', liqBufferPct: '0.2' },
        }),
      ).size(
        signal({ venue: V, symbol: SYM_PERP }),
        snapshot(new Map(), { balances: marginBalance('50') }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    it('leverage cap binds under the legacy notional (margin×leverageCap < baseNotional×strength)', () => {
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters(),
          baseNotional: '1000',
          perp: { leverageCap: '2', mmrFallback: '0.005', liqBufferPct: '0.2' },
        }),
      ).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_LONG' }),
        snapshot(new Map(), { balances: marginBalance('50') }),
      );
      expect(r.ok).toBe(true);
      // legacy 1000 vs margin cap 50×2=100 vs liq cap ∞ ⇒ min = 100 ⇒ qty = 100/100 = 1.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    it('liq buffer binds and rejects the entry outright when leverage/MMR fall short of the buffer, on both directions', () => {
      // 1/10 - 0.02 = 0.08 < 0.15 buffer ⇒ liqSafeNotional collapses to 0 regardless of margin.
      // L=5 (the old must-reject case under the 0.005/0.2 triple) is now the production default
      // under the new 5x/0.02/0.15 policy (0.18 >= 0.15 clears — see the positive-coverage test
      // below) — this case moves to L=10 so the reject branch stays covered.
      const perpDeps = {
        filters: perpFilters(),
        perp: { leverageCap: '10', mmrFallback: '0.02', liqBufferPct: '0.15' },
      };
      const long = new PositionSizerService(clock, deps(perpDeps)).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_LONG' }),
        snapshot(new Map(), { balances: marginBalance('10000') }),
      );
      expect(long).toEqual({ ok: false, reason: 'NO_POSITION' });

      const short = new PositionSizerService(clock, deps(perpDeps)).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_SHORT' }),
        snapshot(new Map(), { balances: marginBalance('10000') }),
      );
      expect(short).toEqual({ ok: false, reason: 'NO_POSITION' });
    });

    it('sizes to a nonzero notional at the new production triple (leverage 5, mmr 0.02, buffer 0.15), symmetric on both directions', () => {
      // 1/5 - 0.02 = 0.18 >= 0.15 (buffer) ⇒ liq cap is Infinity; margin×leverageCap = 50×5 = 250
      // binds under the 1000 legacy notional ⇒ qty = 250/100 = 2.5, identical on both sides.
      const perpDeps = {
        filters: perpFilters(),
        perp: { leverageCap: '5', mmrFallback: '0.02', liqBufferPct: '0.15' },
      };
      const long = new PositionSizerService(clock, deps(perpDeps)).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_LONG' }),
        snapshot(new Map(), { balances: marginBalance('50') }),
      );
      expect(long.ok).toBe(true);
      if (long.ok) expect(long.intent.qty.toFixed()).toBe('2.5');

      const short = new PositionSizerService(clock, deps(perpDeps)).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_SHORT' }),
        snapshot(new Map(), { balances: marginBalance('50') }),
      );
      expect(short.ok).toBe(true);
      if (short.ok) {
        expect(short.intent.side).toBe('SELL');
        expect(short.intent.qty.toFixed()).toBe('2.5');
      }
    });

    it('applies the margin cap identically to ENTER_SHORT (both directions symmetric, unlike the spot BUY-only quote clamp)', () => {
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters(),
          baseNotional: '1000',
          perp: { leverageCap: '2', mmrFallback: '0.005', liqBufferPct: '0.2' },
        }),
      ).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_SHORT' }),
        snapshot(new Map(), { balances: marginBalance('50') }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.side).toBe('SELL');
        expect(r.intent.qty.toFixed()).toBe('1'); // same margin×leverageCap = 100 ⇒ qty 1
      }
    });

    it('scales notional down via the funding-aware hook when expectedFundingBpsPerHold is set', () => {
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters(),
          baseNotional: '1000',
          perp: {
            leverageCap: '100',
            mmrFallback: '0.001',
            liqBufferPct: '0.001',
            expectedFundingBpsPerHold: '500', // 5% ⇒ 1000 × 0.95 = 950
          },
        }),
      ).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_LONG' }),
        snapshot(new Map(), { balances: marginBalance('1000000') }), // ample margin — not the binding constraint
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('9.5'); // 950 / 100 (refPrice)
    });

    it('skips the margin cap when the snapshot lacks a margin-asset balance (freeMargin unknown)', () => {
      // Perp detected AND deps.perp configured, but balances carry no settlement-asset entry —
      // the margin cap must be skipped (liq gate still evaluated: 1/2 − 0.005 = 0.495 ≥ 0.2 ⇒ open).
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters(),
          perp: { leverageCap: '2', mmrFallback: '0.005', liqBufferPct: '0.2' },
        }),
      ).size(signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_LONG' }), snapshot());
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('10'); // legacy 1000 × 1 / 100 — nothing to cap by
    });

    it('applies no additional cap when deps.perp is absent, even for a perp-detected signal', () => {
      const r = new PositionSizerService(clock, deps({ filters: perpFilters() })).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, kind: 'ENTER_LONG' }),
        snapshot(),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('10'); // legacy 1000×1/100, unclamped
    });

    it('leaves the spot path byte-identical (no perp detection, no perp caps applied)', () => {
      const r = new PositionSizerService(
        clock,
        deps({ perp: { leverageCap: '2', mmrFallback: '0.005', liqBufferPct: '0.2' } }),
      ).size(signal(), snapshot());
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('10'); // 1000 × 1 / 100, exactly as the spot fixture above
    });
  });

  // ── C1 (rich decision contract, Design § Sizing flow): SIZER_EQUITY_CAP, sizeFraction,
  // reduceFraction, and same-side scale-in headroom ──
  describe('C1: sizeFraction / equityCap / reduceFraction / scale-in headroom', () => {
    it('(a) sizeFraction sizes off cappedEquity, ignoring the (unset) equityFraction/strength path', () => {
      const r = new PositionSizerService(clock, deps({ equityCap: '1000' })).size(
        signal({ sizeFraction: '0.10' }),
        snapshot(new Map(), { equity: new Decimal('5000') }),
      );
      expect(r.ok).toBe(true);
      // cappedEquity = min(5000, 1000) = 1000; notional = 1000 × 0.10 = 100; qty = 100 / 100 = 1.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    it('(b) clamps sizeFraction at maxAgentPositionFractionByVenue when the model requests more', () => {
      const r = new PositionSizerService(
        clock,
        deps({ maxAgentPositionFractionByVenue: new Map([[V, '0.15']]) }),
      ).size(
        signal({ sizeFraction: '0.30' }),
        snapshot(new Map(), { equity: new Decimal('1000') }),
      );
      expect(r.ok).toBe(true);
      // min(0.30, 0.15) = 0.15; notional = 1000 × 0.15 = 150; qty = 150 / 100 = 1.5.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1.5');
    });

    it('(c) perp: sizeFraction computes notional first, then applyPerpCaps (leverageCap 2) still binds after', () => {
      const V_PERP = venueId('binanceusdm');
      const SYM_PERP = symbolId('BTC/USDT:USDT');
      const perpFilters = new Map([
        [String(SYM), FILTERS],
        [String(SYM_PERP), FILTERS],
      ]);
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters,
          maxAgentPositionFractionByVenue: new Map([[V_PERP, '0.50']]),
          perp: { leverageCap: '2', mmrFallback: '0.005', liqBufferPct: '0.2' },
        }),
      ).size(
        signal({ venue: V_PERP, symbol: SYM_PERP, sizeFraction: '0.40' }),
        snapshot(new Map(), {
          equity: new Decimal('1000'),
          balances: new Map([['USDT', { free: new Decimal('1000'), locked: new Decimal(0) }]]),
        }),
      );
      expect(r.ok).toBe(true);
      // sizeFraction notional = 1000 × min(0.40, 0.50) = 400; applyPerpCaps still runs after: margin
      // cap = 1000(free) × 2(leverageCap) = 2000 (doesn't bind), liq cap Infinity (1/2 − 0.005 = 0.495
      // ≥ 0.2 buffer) ⇒ 400 passes through unclamped ⇒ qty = 400 / 100 = 4.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('4');
    });

    it('(d) same-side scale-in clamps sizeFraction notional to the remaining fraction headroom', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('1.2'), // × refPrice 100 = 120 posNotional
            avgEntry: price('90'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const r = new PositionSizerService(
        clock,
        deps({ maxAgentPositionFractionByVenue: new Map([[V, '0.15']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(positions, { equity: new Decimal('1000') }),
      );
      expect(r.ok).toBe(true);
      // posNotional = 1.2 × refPrice(100) = 120; headroom = 1000 × 0.15 − 120 = 30; sizeFraction
      // target = 1000 × 0.10 = 100, clamped down to headroom 30 ⇒ qty = 30 / 100 = 0.3.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('0.3');
    });

    it('(d2) headroom exhausted (posNotional at/over the fraction cap) rejects BELOW_MINIMUM, not NO_POSITION', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('2'), // × refPrice 100 = 200 posNotional ≥ cap (150)
            avgEntry: price('90'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const r = new PositionSizerService(
        clock,
        deps({ maxAgentPositionFractionByVenue: new Map([[V, '0.15']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(positions, { equity: new Decimal('1000') }),
      );
      // headroom = 1000 × 0.15 − 200 = −50 ⇒ target clamps negative ⇒ BELOW_MINIMUM (a sizable
      // request the venue floor rejects), never the reduce-only NO_POSITION no-op shape.
      expect(r).toEqual({ ok: false, reason: 'BELOW_MINIMUM' });
    });

    // ── CONFIRMED risk-cap bypass fix: a same-symbol scale-in placed while the prior entry is
    // still resting/unfilled must also clamp to the fraction headroom (pre-fix, posQty=0 while the
    // prior order rests ⇒ isSameSideEntry was false ⇒ no clamp ⇒ the fraction cap was bypassable). ──
    it('(d3) resting unfilled same-side entry reserves notional: a second entry clamps to the remaining headroom', () => {
      // No filled position at all (posQty=0) — only a resting BUY entry, qty 1 @ limitPrice 100 ⇒
      // $100 reserved. cappedEquity=1000, maxFraction=0.15 ⇒ fraction cap = $150 ⇒ headroom = $50.
      const resting = restingIntent({ side: 'BUY', qty: qty('1'), limitPrice: price('100') });
      const r = new PositionSizerService(
        clock,
        deps({ maxAgentPositionFractionByVenue: new Map([[V, '0.15']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(new Map(), { equity: new Decimal('1000'), inFlightIntents: [resting] }),
      );
      expect(r.ok).toBe(true);
      // Uncapped target = 1000 × 0.10 = 100; reserved = 100; headroom = 150 − 0 (posNotional) − 100
      // = 50, tighter than the uncapped target ⇒ clamped to 50 ⇒ qty = 50 / 100 = 0.5. Pre-fix this
      // sized the full 100 (qty 1) because posQty=0 skipped the clamp entirely.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('0.5');
    });

    it('(d4) a reduce-only resting order reserves nothing — the same-side clamp does not apply', () => {
      const resting = restingIntent({
        side: 'BUY',
        reduceOnly: true,
        qty: qty('1'),
        limitPrice: price('100'),
      });
      const r = new PositionSizerService(
        clock,
        deps({ maxAgentPositionFractionByVenue: new Map([[V, '0.15']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(new Map(), { equity: new Decimal('1000'), inFlightIntents: [resting] }),
      );
      expect(r.ok).toBe(true);
      // No filled position, no reserved notional (reduce-only excluded) ⇒ no clamp ⇒ full uncapped
      // target = 1000 × 0.10 = 100 ⇒ qty = 100 / 100 = 1.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    // isSameSideEntry's SELL arm: a scale-in is same-side when posQty is NEGATIVE (the (d) case
    // above covers the BUY/long mirror). Perp venue — the only place a short position is opened.
    it('(d5) same-side SHORT scale-in clamps to the remaining fraction headroom (negative posQty)', () => {
      const V_PERP = venueId('binanceusdm');
      const SYM_PERP = symbolId('BTC/USDT:USDT');
      const perpFilters = new Map([
        [String(SYM), FILTERS],
        [String(SYM_PERP), FILTERS],
      ]);
      const positions = new Map<string, Position>([
        [
          `${SID}:${V_PERP}:${SYM_PERP}`,
          {
            strategyId: SID,
            venue: V_PERP,
            symbol: SYM_PERP,
            signedQty: new Decimal('-1'), // short 1 × refPrice 100 = 100 posNotional
            avgEntry: price('90'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters,
          maxAgentPositionFractionByVenue: new Map([[V_PERP, '0.15']]),
        }),
      ).size(
        signal({
          venue: V_PERP,
          symbol: SYM_PERP,
          kind: 'ENTER_SHORT',
          sizeFraction: '0.10',
          refPrice: price('100'),
        }),
        snapshot(positions, { equity: new Decimal('1000') }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.side).toBe('SELL');
        // headroom = 1000 × 0.15 − 100 = 50, tighter than target 1000 × 0.10 = 100 ⇒ qty = 0.5.
        // Unclamped (the pre-fix long-only reading of "same side") this would have sized qty 1.
        expect(r.intent.qty.toFixed()).toBe('0.5');
      }
    });

    it('(d6) an opposite-side entry against a short is a flip, not a scale-in — no headroom clamp', () => {
      const V_PERP = venueId('binanceusdm');
      const SYM_PERP = symbolId('BTC/USDT:USDT');
      const perpFilters = new Map([
        [String(SYM), FILTERS],
        [String(SYM_PERP), FILTERS],
      ]);
      const positions = new Map<string, Position>([
        [
          `${SID}:${V_PERP}:${SYM_PERP}`,
          {
            strategyId: SID,
            venue: V_PERP,
            symbol: SYM_PERP,
            signedQty: new Decimal('-1'),
            avgEntry: price('90'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const r = new PositionSizerService(
        clock,
        deps({
          filters: perpFilters,
          maxAgentPositionFractionByVenue: new Map([[V_PERP, '0.15']]),
        }),
      ).size(
        signal({
          venue: V_PERP,
          symbol: SYM_PERP,
          kind: 'ENTER_LONG',
          sizeFraction: '0.10',
          refPrice: price('100'),
        }),
        snapshot(positions, { equity: new Decimal('1000') }),
      );
      expect(r.ok).toBe(true);
      // The existing short does not consume LONG-side headroom ⇒ full target 1000 × 0.10 = 100 ⇒
      // qty 1 (the (d5) clamp above would have cut this to 0.5 if orientation were ignored).
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    it('(d7) a resting entry with NO limit price reserves at its own refPrice (fail-closed valuation)', () => {
      // A MARKET entry carries no limit leg, so its reserved notional can only be valued off the
      // order's own refPrice — valuing it at zero would leave the fraction cap bypassable exactly
      // the way the (d3) resting-order gap did.
      const resting = restingIntent({
        type: 'MARKET',
        side: 'BUY',
        qty: qty('1'),
        limitPrice: undefined,
        refPrice: price('100'), // ⇒ 100 reserved
      });
      const r = new PositionSizerService(
        clock,
        deps({ maxAgentPositionFractionByVenue: new Map([[V, '0.15']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(new Map(), { equity: new Decimal('1000'), inFlightIntents: [resting] }),
      );
      expect(r.ok).toBe(true);
      // headroom = 150 − 0 (posNotional) − 100 (refPrice-valued reservation) = 50 ⇒ qty = 0.5.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('0.5');
    });

    it('(e) absent sizeFraction runs the legacy equity-fraction path on cappedEquity, not actual equity', () => {
      const r = new PositionSizerService(
        clock,
        deps({ equityFraction: '0.02', equityCap: '1000' }),
      ).size(signal({ strength: 1 }), snapshot(new Map(), { equity: new Decimal('5000') }));
      expect(r.ok).toBe(true);
      // cappedEquity = min(5000, 1000) = 1000; notional = 1000 × 0.02 × 1 = 20; qty = 20 / 100 = 0.2.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('0.2');
    });

    it('(e2) a non-positive equityCap is treated as unset — actual equity sizes the entry', () => {
      const r = new PositionSizerService(
        clock,
        deps({ equityFraction: '0.02', equityCap: '0' }),
      ).size(signal({ strength: 1 }), snapshot(new Map(), { equity: new Decimal('10000') }));
      expect(r.ok).toBe(true);
      // Taken literally a '0' cap would collapse cappedEquity — and every equity-derived notional
      // with it — to zero, silently disabling the lane. Guarded ⇒ 10000 × 0.02 = 200 ⇒ qty = 2.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('2');
    });

    it('(e3) a non-finite equityCap is treated as unset — a NaN cap never poisons sizing', () => {
      const r = new PositionSizerService(
        clock,
        deps({ equityFraction: '0.02', equityCap: 'NaN' }),
      ).size(signal({ strength: 1 }), snapshot(new Map(), { equity: new Decimal('10000') }));
      expect(r.ok).toBe(true);
      // Decimal.min(equity, NaN) is NaN, so an unguarded corrupt cap would propagate NaN through
      // every notional and quantity downstream. Guarded ⇒ the ordinary 200 notional ⇒ qty = 2.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('2');
    });

    it('(f) absent sizeFraction/reduceFraction and no equityCap: legacy behavior byte-identical (regression)', () => {
      const r = new PositionSizerService(clock, deps()).size(signal(), snapshot());
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('10'); // unchanged: 1000 (baseNotional) × 1 / 100
    });

    it('(g) reduceFraction partial-closes: rawQty = |posQty| × reduceFraction, step-rounded down', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('0.004'),
            avgEntry: price('3000'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const r = new PositionSizerService(clock, deps()).size(
        signal({ kind: 'EXIT_LONG', refPrice: price('3000'), reduceFraction: '0.5' }),
        snapshot(positions),
      );
      expect(r.ok).toBe(true);
      // 0.004 × 0.5 = 0.002, already a multiple of the 0.001 step; notional 0.002 × ~2992.5 ≫ minNotional 5.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('0.002');
    });

    it('absent reduceFraction sizes the full |posQty| — legacy byte-identical', () => {
      const r = new PositionSizerService(clock, deps()).size(
        signal({ kind: 'EXIT_LONG' }),
        snapshot(longPosition()),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('5'); // |signedQty|, unaffected by reduceFraction
    });

    describe('(h) reduceFraction dust partial: spot minNotional rejects, perp reduce-only exemption accepts', () => {
      it('spot: BELOW_MINIMUM', () => {
        const posSpot = new Map<string, Position>([
          [
            `${SID}:${V}:${SYM}`,
            {
              strategyId: SID,
              venue: V,
              symbol: SYM,
              signedQty: new Decimal('0.05'),
              avgEntry: price('100'),
              realizedPnl: new Decimal(0),
            },
          ],
        ]);
        const r = new PositionSizerService(clock, deps()).size(
          signal({ kind: 'EXIT_LONG', refPrice: price('100'), reduceFraction: '0.1' }),
          snapshot(posSpot),
        );
        // 0.05 × 0.1 = 0.005 qty (passes minQty 0.001) but 0.005 × ~99.75 ≈ 0.499 < minNotional 5.
        expect(r).toEqual({ ok: false, reason: 'BELOW_MINIMUM' });
      });

      it('perp: reduce-only minNotional exemption accepts the same dust partial', () => {
        const V_PERP = venueId('binanceusdm');
        const SYM_PERP = symbolId('BTC/USDT:USDT');
        const posPerp = new Map<string, Position>([
          [
            `${SID}:${V_PERP}:${SYM_PERP}`,
            {
              strategyId: SID,
              venue: V_PERP,
              symbol: SYM_PERP,
              signedQty: new Decimal('0.05'),
              avgEntry: price('100'),
              realizedPnl: new Decimal(0),
            },
          ],
        ]);
        const perpFilters = new Map([
          [String(SYM), FILTERS],
          [String(SYM_PERP), FILTERS],
        ]);
        const r = new PositionSizerService(clock, deps({ filters: perpFilters })).size(
          signal({
            venue: V_PERP,
            symbol: SYM_PERP,
            kind: 'EXIT_LONG',
            refPrice: price('100'),
            reduceFraction: '0.1',
          }),
          snapshot(posPerp),
        );
        expect(r.ok).toBe(true);
        // 0.05 × 0.1 = 0.005 ≥ minQty 0.001; minNotional exempt (reduce-only + perp) ⇒ accepted.
        if (r.ok) expect(r.intent.qty.toFixed()).toBe('0.005');
      });
    });
  });

  // ── v3 §6.1/§6.2/§6.3: capital-split sizing (venueHeadroom clamp, per-venue wallet
  // affordability, reduce-only exemption) ──
  describe('v3 §6: capital-split sizing', () => {
    const SYM2 = symbolId('ETH/USDT'); // a second symbol on the SAME venue V, used to prove the
    // venueHeadroom clamp aggregates across ALL symbols on a venue, not just the signal's own.

    it('venueHeadroom exactly 0 (a same-venue, different-symbol position exhausts the share) ⇒ BELOW_MINIMUM', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM2}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM2,
            signedQty: new Decimal('2'),
            avgEntry: price('60'), // 2 × 60 = 120 venueOpenNotional
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const r = new PositionSizerService(
        clock,
        deps({ venueCapitalShare: new Map([[V, '120']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(positions, { equity: new Decimal('1000') }),
      );
      // No position/reservation on SYM itself ⇒ the pre-existing same-symbol headroom clamp never
      // engages; sizeFraction target = 1000 × 0.10 = 100. venueHeadroom = 120 (cap) − 120
      // (SYM2's own notional, same venue) − 0 (reserved) = 0 ⇒ clamps the target to 0.
      expect(r).toEqual({ ok: false, reason: 'BELOW_MINIMUM' });
    });

    it('venueHeadroom negative after a venue-wide (different-symbol) reservation ⇒ BELOW_MINIMUM', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM2}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM2,
            signedQty: new Decimal('1'),
            avgEntry: price('60'), // 60 venueOpenNotional
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      // A resting entry on a THIRD symbol, same venue — venueReservedNotional is venue-wide, not
      // scoped to strategyId/symbol/side the way reservedEntryNotional (same-symbol) is.
      const SYM3 = symbolId('XRP/USDT');
      const resting = restingIntent({
        symbol: SYM3,
        side: 'SELL',
        qty: qty('1'),
        limitPrice: price('50'),
      });
      const r = new PositionSizerService(
        clock,
        deps({ venueCapitalShare: new Map([[V, '100']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(positions, { equity: new Decimal('1000'), inFlightIntents: [resting] }),
      );
      // venueHeadroom = 100 (cap) − 60 (SYM2 open) − 50 (SYM3 reserved) = −10 ⇒ negative target.
      expect(r).toEqual({ ok: false, reason: 'BELOW_MINIMUM' });
    });

    // The split is per-venue: the two folds it subtracts (open positions, reserved entries) must
    // both ignore everything sitting on the OTHER venue's wallet, or one venue's book would eat the
    // other's share.
    const V_PERP = venueId('binanceusdm');
    const SYM_PERP = symbolId('BTC/USDT:USDT');

    it('venueOpenNotional ignores positions on another venue (that book has its own share)', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V_PERP}:${SYM_PERP}`,
          {
            strategyId: SID,
            venue: V_PERP,
            symbol: SYM_PERP,
            signedQty: new Decimal('5'),
            avgEntry: price('100'), // $500 open — on the PERP venue, not V
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const r = new PositionSizerService(
        clock,
        deps({ venueCapitalShare: new Map([[V, '120']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(positions, { equity: new Decimal('1000') }),
      );
      expect(r.ok).toBe(true);
      // Venue-blind, the perp $500 would leave headroom 120 − 500 < 0 ⇒ BELOW_MINIMUM. Venue-scoped
      // ⇒ headroom = 120, target = 1000 × 0.10 = 100 (the binding bound) ⇒ qty = 1.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    it('venueReservedNotional ignores other-venue and reduce-only in-flight orders', () => {
      const otherVenue = restingIntent({
        venue: V_PERP,
        symbol: SYM_PERP,
        side: 'BUY',
        qty: qty('5'),
        limitPrice: price('100'), // $500 reserved on the PERP venue
      });
      const reduceOnly = restingIntent({
        side: 'SELL',
        reduceOnly: true,
        qty: qty('5'),
        limitPrice: price('100'), // $500 on V, but an exit — it only ever shrinks exposure
      });
      const r = new PositionSizerService(
        clock,
        deps({ venueCapitalShare: new Map([[V, '120']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(new Map(), {
          equity: new Decimal('1000'),
          inFlightIntents: [otherVenue, reduceOnly],
        }),
      );
      expect(r.ok).toBe(true);
      // Counting EITHER order would drive headroom 120 − 500 negative ⇒ BELOW_MINIMUM; skipping
      // both leaves the full $120 share ⇒ target 100 ⇒ qty = 1.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('1');
    });

    it('a venue-wide reservation with NO limit price is valued at its own refPrice', () => {
      // Same fail-closed valuation as the same-symbol reservation (d7): a MARKET entry has no limit
      // leg, and valuing it at zero would hand the venue back headroom it has already committed.
      const SYM3 = symbolId('XRP/USDT');
      const resting = restingIntent({
        symbol: SYM3,
        side: 'SELL',
        type: 'MARKET',
        qty: qty('1'),
        limitPrice: undefined,
        refPrice: price('70'), // ⇒ $70 reserved venue-wide
      });
      const r = new PositionSizerService(
        clock,
        deps({ venueCapitalShare: new Map([[V, '120']]) }),
      ).size(
        signal({ sizeFraction: '0.10', refPrice: price('100') }),
        snapshot(new Map(), { equity: new Decimal('1000'), inFlightIntents: [resting] }),
      );
      expect(r.ok).toBe(true);
      // headroom = 120 − 0 (open) − 70 (refPrice-valued reservation) = 50, tighter than the 100
      // target ⇒ qty = 0.5.
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('0.5');
    });

    it('wallet-underfunded: venueFree (not the combined snapshot.balances) binds the spot BUY affordability clamp', () => {
      const r = new PositionSizerService(clock, deps()).size(
        signal(), // legacy baseNotional path: 1000 × strength(1) = 1000 target
        snapshot(new Map(), {
          equity: new Decimal('1000'),
          // Combined balance is plentiful — if the sizer fell back to it instead of venueBalances,
          // this order would size fine. venueBalances for V is nearly empty (the demo wallet
          // actually holding this venue's split), proving the venue-scoped read is what binds.
          balances: new Map([['USDT', { free: new Decimal('10000'), locked: new Decimal(0) }]]),
          venueBalances: new Map([
            [V, new Map([['USDT', { free: new Decimal('1'), locked: new Decimal(0) }]])],
          ]),
        }),
      );
      // target = min(1000, 1 × 0.95) = 0.95 ⇒ qty = 0.0095, stepped down to 0.009 ⇒ notional 0.9 <
      // minNotional 5 ⇒ rejected as a genuinely underfunded order, not silently floored.
      expect(r).toEqual({ ok: false, reason: 'BELOW_MINIMUM' });
    });

    it('reduce-only is exempt from the split: sizes fully even when the venue is far over its cap', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('5'),
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const r = new PositionSizerService(
        clock,
        // Cap far below the already-open notional (500) — an entry here would clamp to a deeply
        // negative headroom, but this signal is a reduce-only EXIT, which never calls
        // entryNotional (§6.3's structural exemption).
        deps({ venueCapitalShare: new Map([[V, '10']]) }),
      ).size(signal({ kind: 'EXIT_LONG' }), snapshot(positions));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.intent.qty.toFixed()).toBe('5'); // full |posQty|, unaffected by the split
    });
  });

  // ── Profitability Edge Program: aggregate planned-stop entry risk cap ──
  describe('planned-stop entry risk cap (SIZER_MAX_PLANNED_STOP_RISK_FRACTION)', () => {
    const CAP_DEPS = {
      equityCap: '1000',
      maxPlannedStopRiskFraction: '0.01',
      maxAgentPositionFractionByVenue: new Map([[V, '1']]),
    };

    it('(fresh long) clamps aggregate cost-notional to cappedEquity × fraction / stopLossPct', () => {
      const r = new PositionSizerService(clock, deps(CAP_DEPS)).size(
        signal({ sizeFraction: '0.60', stopLossPct: '0.02', refPrice: price('100') }),
        snapshot(undefined, { equity: new Decimal(5000) }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        // max total = 1000 × 0.01 / 0.02 = 500; target 600 clamps to 500 ⇒ qty 5.
        expect(r.intent.qty.toFixed()).toBe('5');
      }
    });

    it('(fresh short) applies the same aggregate cap on ENTER_SHORT', () => {
      const V_PERP = venueId('binanceusdm');
      const SYM_PERP = symbolId('BTC/USDT:USDT');
      const perpFilters: SymbolFilters = { ...FILTERS, minNotional: '0' };
      const r = new PositionSizerService(
        clock,
        deps({
          ...CAP_DEPS,
          filters: new Map([
            [String(SYM), FILTERS],
            [String(SYM_PERP), perpFilters],
          ]),
          maxAgentPositionFractionByVenue: new Map([
            [V, '1'],
            [V_PERP, '1'],
          ]),
        }),
      ).size(
        signal({
          kind: 'ENTER_SHORT',
          venue: V_PERP,
          symbol: SYM_PERP,
          sizeFraction: '0.60',
          stopLossPct: '0.02',
          refPrice: price('100'),
        }),
        snapshot(undefined, { equity: new Decimal(5000) }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.side).toBe('SELL');
        expect(r.intent.qty.toFixed()).toBe('5');
      }
    });

    it('(scale-in) subtracts held same-side cost notional (|qty|×avgEntry) and reserved entry notional', () => {
      const positions = new Map<string, Position>([
        [
          `${SID}:${V}:${SYM}`,
          {
            strategyId: SID,
            venue: V,
            symbol: SYM,
            signedQty: new Decimal('3'),
            avgEntry: price('100'),
            realizedPnl: new Decimal(0),
          },
        ],
      ]);
      const rHeld = new PositionSizerService(clock, deps(CAP_DEPS)).size(
        signal({ sizeFraction: '0.30', stopLossPct: '0.02', refPrice: price('100') }),
        snapshot(positions, { equity: new Decimal(5000) }),
      );
      expect(rHeld.ok).toBe(true);
      if (rHeld.ok) {
        // max total 500 − held 300 = 200 remaining; target 300 clamps to 200 ⇒ qty 2.
        expect(rHeld.intent.qty.toFixed()).toBe('2');
      }

      const rReserved = new PositionSizerService(clock, deps(CAP_DEPS)).size(
        signal({ sizeFraction: '0.40', stopLossPct: '0.02', refPrice: price('100') }),
        snapshot(undefined, {
          equity: new Decimal(5000),
          inFlightIntents: [restingIntent({ qty: qty('2'), limitPrice: price('100') })],
        }),
      );
      expect(rReserved.ok).toBe(true);
      if (rReserved.ok) {
        // max total 500 − reserved 200 = 300; target 400 clamps to 300 ⇒ qty 3.
        expect(rReserved.intent.qty.toFixed()).toBe('3');
      }
    });

    it('(exact cap invariant) held + reserved + proposed cost-notional never exceeds the cap', () => {
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
      const inFlight = [restingIntent({ qty: qty('1'), limitPrice: price('100') })];
      const r = new PositionSizerService(clock, deps(CAP_DEPS)).size(
        signal({ sizeFraction: '0.50', stopLossPct: '0.02', refPrice: price('100') }),
        snapshot(positions, { equity: new Decimal(5000), inFlightIntents: inFlight }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        const held = new Decimal('2').mul('100');
        const reserved = new Decimal('1').mul('100');
        const proposed = r.intent.qty.mul('100');
        const maxTotal = new Decimal('1000').mul('0.01').div('0.02');
        expect(held.add(reserved).add(proposed).lte(maxTotal)).toBe(true);
        expect(r.intent.qty.toFixed()).toBe('2'); // remaining 200/100
      }
    });

    it('(disabled cap) maxPlannedStopRiskFraction 0 stays byte-identical even when stopLossPct is present', () => {
      const snap = snapshot(undefined, { equity: new Decimal(5000) });
      const sig = signal({ sizeFraction: '0.60', stopLossPct: '0.02', refPrice: price('100') });
      const uncapped = new PositionSizerService(
        clock,
        deps({ equityCap: '1000', maxAgentPositionFractionByVenue: new Map([[V, '1']]) }),
      ).size(sig, snap);
      const disabledCap = new PositionSizerService(
        clock,
        deps({
          equityCap: '1000',
          maxPlannedStopRiskFraction: '0',
          maxAgentPositionFractionByVenue: new Map([[V, '1']]),
        }),
      ).size(sig, snap);
      expect(uncapped).toEqual(disabledCap);
      expect(uncapped.ok).toBe(true);
      if (uncapped.ok) expect(uncapped.intent.qty.toFixed()).toBe('6'); // 600/100, no planned-stop clamp
    });

    it('(missing stop) enabled cap with no signal.stopLossPct fails closed on ENTER_*', () => {
      const snap = snapshot(undefined, { equity: new Decimal(5000) });
      const sig = signal({ sizeFraction: '0.60', refPrice: price('100') });
      expect(new PositionSizerService(clock, deps(CAP_DEPS)).size(sig, snap)).toEqual({
        ok: false,
        reason: 'INVALID_STOP_RISK',
      });
    });

    it('(invalid stop) non-finite/non-positive provided stop fails closed with INVALID_STOP_RISK', () => {
      const snap = snapshot(undefined, { equity: new Decimal(5000) });
      const base = signal({ sizeFraction: '0.10', refPrice: price('100') });
      for (const stopLossPct of ['0', '-0.01', 'abc']) {
        expect(
          new PositionSizerService(clock, deps(CAP_DEPS)).size(
            signal({ ...base, stopLossPct }),
            snap,
          ),
        ).toEqual({ ok: false, reason: 'INVALID_STOP_RISK' });
      }
    });

    it('increments planned_stop_sizing_total on clamp and invalid_stop outcomes', () => {
      const inc = vi.fn();
      const metric = { inc } as unknown as import('prom-client').Counter<string>;
      const sizer = new PositionSizerService(clock, deps(CAP_DEPS), metric);
      const snap = snapshot(undefined, { equity: new Decimal(5000) });

      sizer.size(
        signal({ sizeFraction: '0.60', stopLossPct: '0.02', refPrice: price('100') }),
        snap,
      );
      expect(inc).toHaveBeenCalledWith({ outcome: 'clamp' });

      sizer.size(signal({ sizeFraction: '0.10', stopLossPct: '0', refPrice: price('100') }), snap);
      expect(inc).toHaveBeenCalledWith({ outcome: 'invalid_stop' });
    });
  });
});
