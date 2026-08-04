import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { buildMenuPinPredicate } from '../../../../src/features/trading/composition/agentic-bridge.module';
import { EdgeCohortPinState } from '../../../../src/features/strategy/agentic/edge-cohort-pin-state';
import { price, qty } from '../../../../src/domain/common/types/money';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
  intentId,
  encodeClientOrderId,
} from '../../../../src/domain/common/types/ids';
import type { Position, PortfolioSnapshot } from '../../../../src/domain/trading/types/portfolio';
import type { PortfolioViewPort } from '../../../../src/ports/trading/execution';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';

const SID = strategyId('s1');
const V = venueId('binance');
const SYM = symbolId('AAVE/USDT');
const NOW = 1_700_000_000_000;

function makePosition(over: Partial<Position> = {}): Position {
  return {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    signedQty: new Decimal('0.01'),
    avgEntry: price('100'),
    realizedPnl: new Decimal('0'),
    ...over,
  };
}

function makeIntent(over: Partial<OrderIntent> = {}): OrderIntent {
  const id = intentId('0190abcd-1234-7abc-89ab-0123456789ab');
  return {
    intentId: id,
    clientOrderId: encodeClientOrderId(id, 'paper'),
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
    expiresAt: epochMs(NOW + 10_000),
    source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 9n, strength: 1 },
    ...over,
  };
}

function snapshotWith(opts: {
  positions?: Position[];
  openOrders?: PortfolioSnapshot['openOrders'];
  inFlightIntents?: PortfolioSnapshot['inFlightIntents'];
}): PortfolioSnapshot {
  const positions = new Map<string, Position>();
  for (const p of opts.positions ?? []) positions.set(`${p.strategyId}:${p.venue}:${p.symbol}`, p);
  return {
    positions,
    balances: new Map(),
    openOrders: opts.openOrders ?? [],
    inFlightIntents: opts.inFlightIntents ?? [],
    equity: new Decimal(1000),
    unrealized: new Decimal(0),
    startingCash: new Decimal(1000),
    peakEquity: new Decimal(1000),
    sodEquityUtc: new Decimal(1000),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 0n,
  };
}

function portfolioOf(snap: PortfolioSnapshot): PortfolioViewPort {
  return {
    snapshot: () => snap,
    forStrategy: () => {
      throw new Error('not needed by isPinned');
    },
  };
}

// Same knob as PROMOTION_DUST_NOTIONAL (.env.app) — a fixed literal here so the "at/above the bar"
// vs "below the bar" cases are exact, not dependent on env state.
const DUST_NOTIONAL = '5';

// buildMenuPinPredicate is the ACTIVE_MENU_GATE_OVERRIDE pin precedence (agentic-bridge.module.ts):
// edge-cohort pin, then position-notional-vs-dust-bar, then resting order / in-flight entry intent.
//
// History: a 2026-08-03 review found (research/loop/LOG.md records) that the position clause pinned
// on ANY nonzero signedQty, so a sub-stepSize residual below PROMOTION_DUST_NOTIONAL could never
// reach exact-zero and held a menu slot (and LLM spend) forever. That pass recorded the fix as
// blocked "pending a durable round-trip-cycle reader" to distinguish a genuinely-closed dust residual
// from a position still being opened. That blocker did not survive inspection on 2026-08-04: the
// durable reader already existed — round-trip-evidence.reader.ts — but this seam never needed the
// reader itself, only the SAME dustNotional knob it (and portfolio-state.service.ts's dust-close
// fold) already use to decide "closed". "Still being opened" is independently covered by the
// resting-order/in-flight-intent clause below, which pins unconditionally regardless of notional.
describe('buildMenuPinPredicate', () => {
  it('pins a symbol carrying a position at or above the dust bar', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({
      positions: [makePosition({ signedQty: new Decimal('1'), avgEntry: price('100') })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('pins a symbol whose position notional sits exactly at the dust bar (gte, not gt)', () => {
    const edgePins = new EdgeCohortPinState();
    // signedQty × avgEntry = 0.05 × 100 = 5 = DUST_NOTIONAL exactly.
    const snap = snapshotWith({
      positions: [makePosition({ signedQty: new Decimal('0.05'), avgEntry: price('100') })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('pins a symbol whose position notional sits just above the dust bar', () => {
    const edgePins = new EdgeCohortPinState();
    // signedQty × avgEntry = 0.0501 × 100 = 5.01 > DUST_NOTIONAL.
    const snap = snapshotWith({
      positions: [makePosition({ signedQty: new Decimal('0.0501'), avgEntry: price('100') })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('does NOT pin a below-dust-bar residual with no resting order and no in-flight intent', () => {
    const edgePins = new EdgeCohortPinState();
    // signedQty × avgEntry = 0.0006 × 100 = 0.06, well under DUST_NOTIONAL — the SOL/USDT-shaped
    // residual from the live measurement (research/loop/LOG.md, 2026-08-04).
    const snap = snapshotWith({
      positions: [makePosition({ signedQty: new Decimal('0.0006'), avgEntry: price('100') })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(false);
  });

  it('pins a below-dust-bar residual anyway when a resting order exists (never lose a consult mid-unwind)', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({
      positions: [makePosition({ signedQty: new Decimal('0.0006'), avgEntry: price('100') })],
      openOrders: [
        {
          clientOrderId: clientOrderId('co1'),
          symbol: SYM,
          side: 'SELL',
          qty: qty('0.0006'),
        },
      ],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('pins a below-dust-bar residual anyway when an in-flight entry intent exists (never lose a consult mid-entry)', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({
      positions: [makePosition({ signedQty: new Decimal('0.0006'), avgEntry: price('100') })],
      inFlightIntents: [makeIntent({ symbol: SYM })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('pins a symbol with an in-flight entry intent and no position/order yet (S1, 2026-08-03 review): closes a pre-existing gap unrelated to position size — the window between submit and the order-open event had no pin at all before this fix', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({
      inFlightIntents: [makeIntent({ symbol: SYM })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('pins a symbol carrying a resting order and no position (order pin unaffected)', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({
      openOrders: [
        {
          clientOrderId: clientOrderId('co1'),
          symbol: SYM,
          side: 'BUY',
          qty: qty('0.001'),
        },
      ],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('does not pin an unrelated symbol with no position, order, or in-flight intent', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({});
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap), DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(false);
  });

  it('short-circuits on the edge-cohort pin before ever reading the portfolio snapshot, independent of position size', () => {
    const edgePins = new EdgeCohortPinState();
    edgePins.set([String(SYM)]);
    const portfolio: PortfolioViewPort = {
      snapshot: () => {
        throw new Error('snapshot must not be read when the edge-cohort pin already applies');
      },
      forStrategy: () => {
        throw new Error('not needed by isPinned');
      },
    };
    const isPinned = buildMenuPinPredicate(edgePins, portfolio, DUST_NOTIONAL);
    expect(isPinned(String(SYM))).toBe(true);
  });
});
