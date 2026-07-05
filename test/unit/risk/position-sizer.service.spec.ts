import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PositionSizerService } from '../../../src/modules/risk/position-sizer.service';
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

function snapshot(positions = new Map<string, Position>()): PortfolioSnapshot {
  return {
    positions,
    balances: new Map(),
    openOrders: [],
    inFlightIntents: [],
    equity: new Decimal(0),
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
});
