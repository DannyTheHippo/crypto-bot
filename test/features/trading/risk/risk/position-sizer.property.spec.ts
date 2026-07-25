import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
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
const SID = strategyId('s1');
const clock: ClockPort = { now: () => epochMs(1700000000000) };
// Wide-enough filters that the property never bottoms out at BELOW_MINIMUM before the notional
// bound can be checked — this test asserts an upper bound on sized notional, not exchange minimums.
const FILTERS: SymbolFilters = {
  tickSize: '0.01',
  stepSize: '0.00000001',
  minQty: '0.00000001',
  minNotional: '0',
};

function deps(equityFraction: string): SizerDeps {
  return {
    baseNotional: '100',
    mode: 'paper',
    filters: new Map([[String(SYM), FILTERS]]),
    randomBytes: (n) => new Uint8Array(n).fill(7),
    equityFraction,
  };
}

function signal(strength: number): Signal {
  return {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    kind: 'ENTER_LONG',
    strength,
    refPrice: price('100'),
    basedOnSeq: 7n,
    eventTime: epochMs(1000),
    ttlMs: 5000,
    dedupeKey: 'k',
    reason: 'r',
  };
}

function snapshot(equity: Decimal): PortfolioSnapshot {
  return {
    positions: new Map<string, Position>(),
    balances: new Map(), // no quote balance entry: the free-quote clamp never binds in this property
    openOrders: [],
    inFlightIntents: [],
    equity,
    unrealized: new Decimal(0),
    startingCash: new Decimal(0),
    peakEquity: new Decimal(0),
    sodEquityUtc: new Decimal(0),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
  };
}

describe('PositionSizerService — equity-fraction property invariants (fast-check)', () => {
  it('a sized entry never requests notional exceeding equity × fraction × strength, and never negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }), // equity, whole quote units
        // fraction × 100 starts at 1: fraction 0 selects the legacy fixed-notional path by design,
        // which is deliberately NOT equity-bounded — the invariant only governs the fraction path.
        fc.integer({ min: 1, max: 100 }), // fraction × 100 (0.01 .. 1.00)
        fc.integer({ min: 1, max: 100 }), // strength × 100 (0.01 .. 1.00)
        (equityUnits, fractionHundredths, strengthHundredths) => {
          const equity = new Decimal(equityUnits);
          const fraction = new Decimal(fractionHundredths).div(100);
          const strength = strengthHundredths / 100;
          const bound = equity.mul(fraction).mul(strength);

          const r = new PositionSizerService(clock, deps(fraction.toFixed())).size(
            signal(strength),
            snapshot(equity),
          );

          if (r.ok) {
            // The sizer only ever emits LIMIT intents, which always carry a limitPrice.
            const notional = r.intent.qty.mul(r.intent.limitPrice!);
            expect(notional.gte(0)).toBe(true);
            // Step-rounding only ever shrinks qty (roundToStep 'down'), so sized notional is bounded
            // above by the pre-rounding target — never exceeds equity × fraction × strength.
            expect(notional.lte(bound)).toBe(true);
          }
          // r.ok === false (e.g. BELOW_MINIMUM at fraction/strength 0) is a valid, safe outcome —
          // the invariant only constrains what a produced order can size at, not whether one exists.
        },
      ),
    );
  });
});

describe('PositionSizerService — planned-stop cap property invariants (fast-check)', () => {
  const CAP_DEPS: SizerDeps = {
    baseNotional: '100',
    mode: 'paper',
    filters: new Map([[String(SYM), FILTERS]]),
    randomBytes: (n) => new Uint8Array(n).fill(7),
    equityCap: '1000',
    maxPlannedStopRiskFraction: '0.01',
    maxAgentPositionFractionByVenue: new Map([[V, '1']]),
  };

  it('held + proposed cost-notional never exceeds cappedEquity × fraction / stopLossPct on fresh entries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }), // stopLossPct × 1000 (0.001 .. 0.05)
        fc.integer({ min: 1, max: 100 }), // sizeFraction × 100
        (stopThousandths, sizeHundredths) => {
          const stopLossPct = new Decimal(stopThousandths).div(1000);
          const sizeFraction = new Decimal(sizeHundredths).div(100);
          const cappedEquity = new Decimal('1000');
          const maxTotal = cappedEquity.mul('0.01').div(stopLossPct);

          const r = new PositionSizerService(clock, CAP_DEPS).size(
            {
              ...signal(1),
              sizeFraction: sizeFraction.toFixed(),
              stopLossPct: stopLossPct.toFixed(),
              dedupeKey: `k-${stopThousandths}-${sizeHundredths}`,
            },
            snapshot(new Decimal(5000)),
          );

          if (r.ok) {
            const proposed = r.intent.qty.mul(r.intent.limitPrice!);
            expect(proposed.lte(maxTotal)).toBe(true);
          }
        },
      ),
    );
  });
});
