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

// buildMenuPinPredicate is the ACTIVE_MENU_GATE_OVERRIDE pin precedence (agentic-bridge.module.ts),
// factored out so it's unit-testable without a Nest bootstrap: edge-cohort pin, then any nonzero
// position, then resting order / in-flight entry intent. A 2026-08-03 review found (and this repo's
// research/loop/LOG.md records) a real dust-residual defect — a position reduced to sub-stepSize
// residue below PROMOTION_DUST_NOTIONAL can never reach exact-zero and holds a menu slot forever —
// but no sound "was this position ever real, or is it still being opened" signal exists at this
// seam (PortfolioViewPort exposes only a point-in-time snapshot()), so that fix is NOT shipped here;
// it is tracked as a blocked defect pending a durable round-trip-cycle reader. This suite only
// exercises the precedence that IS shipped.
describe('buildMenuPinPredicate', () => {
  it('pins a symbol carrying a nonzero position', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({
      positions: [makePosition({ signedQty: new Decimal('1'), avgEntry: price('100') })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap));
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('pins a symbol carrying a nonzero position regardless of how small its notional is (no size-based unpin logic exists)', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({
      positions: [makePosition({ signedQty: new Decimal('0.0006'), avgEntry: price('100') })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap));
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('pins a symbol with an in-flight entry intent and no position/order yet (S1, 2026-08-03 review): closes a pre-existing gap unrelated to position size — the window between submit and the order-open event had no pin at all before this fix', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({
      inFlightIntents: [makeIntent({ symbol: SYM })],
    });
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap));
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
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap));
    expect(isPinned(String(SYM))).toBe(true);
  });

  it('does not pin an unrelated symbol with no position, order, or in-flight intent', () => {
    const edgePins = new EdgeCohortPinState();
    const snap = snapshotWith({});
    const isPinned = buildMenuPinPredicate(edgePins, portfolioOf(snap));
    expect(isPinned(String(SYM))).toBe(false);
  });

  it('short-circuits on the edge-cohort pin before ever reading the portfolio snapshot', () => {
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
    const isPinned = buildMenuPinPredicate(edgePins, portfolio);
    expect(isPinned(String(SYM))).toBe(true);
  });
});
