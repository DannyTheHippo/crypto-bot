import { Injectable, Inject } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../ports/clock';
import {
  SIZER_DEPS,
  type PositionSizerPort,
  type SizingResult,
  type SizerDeps,
} from '../../ports/risk';
import { positionKey } from '../../domain/risk/evaluate';
import type { Signal } from '../../domain/types/signal';
import type { OrderIntent } from '../../domain/types/order-intent';
import type { PortfolioSnapshot } from '../../domain/types/portfolio';
import { roundToStep, roundToTick, type Qty } from '../../domain/types/money';
import { intentId, encodeClientOrderId, epochMs } from '../../domain/types/ids';
import { uuidv7 } from './uuidv7';

// Pure, exhaustive kind → {side, reduceOnly} mapping. The switch covers every Signal kind and returns
// in each arm, so adding a kind without a case is a COMPILE error (the function then "lacks an ending
// return") — exhaustiveness without an unreachable default branch (which a 100%-coverage zone forbids).
// A mis-sided order is a wrong-way trade, so this derivation must never silently fall through. Returns
// null for kinds that produce no order.
function orderForKind(
  kind: Signal['kind'],
  posQty: Decimal,
): { side: 'BUY' | 'SELL'; reduceOnly: boolean } | null {
  switch (kind) {
    case 'ENTER_LONG':
      return { side: 'BUY', reduceOnly: false };
    case 'EXIT_LONG':
      return { side: 'SELL', reduceOnly: true };
    case 'ENTER_SHORT':
      return { side: 'SELL', reduceOnly: false };
    case 'EXIT_SHORT':
      return { side: 'BUY', reduceOnly: true };
    case 'FLATTEN':
      // Oriented opposite the held position; a flat book ⇒ BUY here but rawQty 0 ⇒ NO_POSITION reject.
      return { side: posQty.gt(0) ? 'SELL' : 'BUY', reduceOnly: true };
    case 'CANCEL_OPEN':
      return null; // resting-order cancellation is an execution action, not a sizable order
  }
}

@Injectable()
export class PositionSizerService implements PositionSizerPort {
  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SIZER_DEPS) private readonly deps: SizerDeps,
  ) {}

  size(signal: Signal, snapshot: PortfolioSnapshot): SizingResult {
    const filters = this.deps.filters.get(signal.symbol);
    if (!filters) return { ok: false, reason: 'NO_REF_PRICE' };

    // Attributed position (needed for reduce-only sizing and to orient a FLATTEN against its sign).
    const pos = snapshot.positions.get(positionKey(signal.strategyId, signal.venue, signal.symbol));
    const posQty = pos ? pos.signedQty : new Decimal(0);

    // Exhaustive map: signal kind → order side + reduce-only. A short opens with side=SELL
    // (reduceOnly=false) and covers with side=BUY (reduceOnly=true); OrderIntent.side stays BUY|SELL,
    // so Execution's RiskApprovedIntent signature is NOT widened. FLATTEN is oriented opposite the
    // current position. CANCEL_OPEN is not an order-producing signal (resting-order cancellation is an
    // execution action) ⇒ null ⇒ a benign no-op reject.
    const order = orderForKind(signal.kind, posQty);
    if (order === null) return { ok: false, reason: 'NO_POSITION' };
    const { side, reduceOnly } = order;

    // Limit price: hint or decision-time reference, rounded directionally to the tick. A hint or an
    // entry price rounds conservatively (BUY down, SELL up — never pay/receive worse than intended).
    // Reduce-only intents with no caller-supplied hint are instead made marketable (crossed past the
    // spread by EXIT_CROSS_BUFFER_BPS): the tick-rounding direction FLIPS to stay crossed rather than
    // retreat toward passive — SELL rounds down (still below the bid), BUY-cover rounds up (still
    // above the ask) — so a partial IOC fill never leaves sub-minNotional dust resting away from
    // market. A caller-supplied hint (e.g. the kill-switch flatten path's own band-edge pricing)
    // always wins, unchanged, using the conservative direction.
    const refPrice = signal.refPrice;
    const isCrossedExit = reduceOnly && signal.limitPriceHint === undefined;
    const basePrice =
      signal.limitPriceHint ?? (isCrossedExit ? this.crossedExitPrice(side, refPrice) : refPrice);
    const tickDirection = isCrossedExit
      ? side === 'BUY'
        ? 'up'
        : 'down'
      : side === 'BUY'
        ? 'down'
        : 'up';
    const limitPrice = roundToTick(basePrice, filters.tickSize, tickDirection);

    // Sizing: reduce-only legs (exit-long, cover-short, flatten) reduce the attributed position;
    // entries (long or short) scale base notional by conviction.
    const rawQty: Decimal = reduceOnly
      ? posQty.abs()
      : new Decimal(this.deps.baseNotional).mul(signal.strength).div(limitPrice);
    // A reduce-only with nothing attributed is a strategy no-op, not a dust order — report it
    // distinctly so trade analysis can separate "flat, nothing to exit" from a genuine sub-min size.
    if (rawQty.lte(0)) return { ok: false, reason: 'NO_POSITION' };

    // Round the raw (possibly high-precision, e.g. baseNotional/price) quantity to the step FIRST;
    // wrapping it in qty() before rounding would throw on the 18-place precision limit.
    const steppedQty: Qty = roundToStep(rawQty, filters.stepSize, 'down');
    if (
      steppedQty.lt(new Decimal(filters.minQty)) ||
      steppedQty.mul(limitPrice).lt(new Decimal(filters.minNotional))
    ) {
      return { ok: false, reason: 'BELOW_MINIMUM' };
    }

    const id = intentId(uuidv7(this.clock.now(), this.deps.randomBytes(10)));
    const createdAt = this.clock.now();
    const intent: OrderIntent = {
      intentId: id,
      clientOrderId: encodeClientOrderId(id, this.deps.mode),
      strategyId: signal.strategyId,
      venue: signal.venue,
      symbol: signal.symbol,
      side,
      type: 'LIMIT',
      qty: steppedQty,
      limitPrice,
      timeInForce: reduceOnly ? 'IOC' : 'GTC',
      reduceOnly,
      mode: this.deps.mode,
      refPrice,
      refSeq: signal.basedOnSeq,
      createdAt,
      expiresAt: epochMs(createdAt + signal.ttlMs),
      source: {
        dedupeKey: signal.dedupeKey,
        eventTime: signal.eventTime,
        basedOnSeq: signal.basedOnSeq,
        strength: signal.strength,
      },
    };
    return { ok: true, intent };
  }

  // Crosses refPrice past the spread by EXIT_CROSS_BUFFER_BPS: SELL prices down (marketable against
  // bids), BUY prices up (marketable against asks). Capped at 99bps in the config schema so the
  // crossed price never trips domain/risk/evaluate.ts's price-band veto (maxBandBps=100). Falls back
  // to 25 when deps omit the knob (module-isolation unit fixtures).
  private crossedExitPrice(side: 'BUY' | 'SELL', refPrice: Decimal): Decimal {
    const bufferBps = this.deps.exitCrossBufferBps ?? 25;
    const buffer = new Decimal(bufferBps).div(10_000);
    return side === 'SELL' ? refPrice.mul(new Decimal(1).sub(buffer)) : refPrice.mul(buffer.add(1));
  }
}
