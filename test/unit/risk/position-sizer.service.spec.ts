import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PositionSizerService } from '../../../src/features/trading/risk/position-sizer.service';
import type { SizerDeps } from '../../../src/ports/risk';
import type { SymbolFilters } from '../../../src/domain/risk/evaluate';
import type { ClockPort } from '../../../src/ports/clock';
import type { Signal } from '../../../src/domain/types/signal';
import type { PortfolioSnapshot, Position } from '../../../src/domain/types/portfolio';
import { price } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

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

function snapshot(
  positions = new Map<string, Position>(),
  over: { equity?: Decimal; balances?: Map<string, { free: Decimal; locked: Decimal }> } = {},
): PortfolioSnapshot {
  return {
    positions,
    balances: over.balances ?? new Map(),
    openOrders: [],
    inFlightIntents: [],
    equity: over.equity ?? new Decimal(0),
    unrealized: new Decimal(0),
    startingCash: new Decimal(0),
    peakEquity: new Decimal(0),
    sodEquityUtc: new Decimal(0),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
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
      // 1/5 - 0.005 = 0.195 < 0.2 buffer ⇒ liqSafeNotional collapses to 0 regardless of margin.
      const perpDeps = {
        filters: perpFilters(),
        perp: { leverageCap: '5', mmrFallback: '0.005', liqBufferPct: '0.2' },
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
});
