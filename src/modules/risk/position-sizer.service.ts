import { Injectable, Inject } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../ports/clock';
import { SIZER_DEPS, type PositionSizerPort, type SizingResult, type SizerDeps } from '../../ports/risk';
import { positionKey } from '../../domain/risk/evaluate';
import type { Signal } from '../../domain/types/signal';
import type { OrderIntent } from '../../domain/types/order-intent';
import type { PortfolioSnapshot } from '../../domain/types/portfolio';
import { roundToStep, roundToTick, type Qty } from '../../domain/types/money';
import { intentId, encodeClientOrderId, epochMs } from '../../domain/types/ids';
import { uuidv7 } from './uuidv7';

@Injectable()
export class PositionSizerService implements PositionSizerPort {
  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SIZER_DEPS) private readonly deps: SizerDeps,
  ) {}

  size(signal: Signal, snapshot: PortfolioSnapshot): SizingResult {
    const filters = this.deps.filters.get(signal.symbol);
    if (!filters) return { ok: false, reason: 'NO_REF_PRICE' };

    const isExit = signal.kind === 'EXIT_LONG' || signal.kind === 'FLATTEN';
    const side: 'BUY' | 'SELL' = isExit ? 'SELL' : 'BUY';

    // Limit price: hint or decision-time reference, rounded directionally to the tick.
    const refPrice = signal.refPrice;
    const limitPrice = roundToTick(signal.limitPriceHint ?? refPrice, filters.tickSize, side === 'BUY' ? 'down' : 'up');

    // Sizing: exits reduce the attributed position; entries scale base notional by conviction.
    let rawQty: Decimal;
    if (isExit) {
      const pos = snapshot.positions.get(positionKey(signal.strategyId, signal.venue, signal.symbol));
      rawQty = pos ? pos.signedQty.abs() : new Decimal(0);
    } else {
      rawQty = new Decimal(this.deps.baseNotional).mul(signal.strength).div(limitPrice);
    }
    if (rawQty.lte(0)) return { ok: false, reason: 'BELOW_MINIMUM' };

    // Round the raw (possibly high-precision, e.g. baseNotional/price) quantity to the step FIRST;
    // wrapping it in qty() before rounding would throw on the 18-place precision limit.
    const steppedQty: Qty = roundToStep(rawQty, filters.stepSize, 'down');
    if (steppedQty.lt(new Decimal(filters.minQty)) || steppedQty.mul(limitPrice).lt(new Decimal(filters.minNotional))) {
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
      timeInForce: 'GTC',
      reduceOnly: isExit,
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
}
