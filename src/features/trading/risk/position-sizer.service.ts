import { Injectable, Inject } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import {
  SIZER_DEPS,
  type PositionSizerPort,
  type SizingResult,
  type SizerDeps,
} from '../../../ports/risk';
import { positionKey } from '../../../domain/risk/evaluate';
import {
  marginNotionalCap,
  liqSafeNotionalCap,
  applyFundingScaling,
} from '../../../domain/risk/perp-sizing';
import type { Signal } from '../../../domain/types/signal';
import type { OrderIntent } from '../../../domain/types/order-intent';
import type { PortfolioSnapshot } from '../../../domain/types/portfolio';
import { splitSymbol } from '../../../domain/types/symbol';
import { roundToStep, roundToTick, type Price, type Qty } from '../../../domain/types/money';
import { intentId, encodeClientOrderId, epochMs, venueId } from '../../../domain/types/ids';
import { uuidv7 } from './uuidv7';

// binanceusdm (USD-M swap): the only venue this pass wires perp detection against. A symbol's own
// :SETTLE suffix (splitSymbol) is the second, venue-independent signal — either one is sufficient.
const PERP_VENUE_ID = venueId('binanceusdm');

function isPerpSignal(signal: Signal): boolean {
  return signal.venue === PERP_VENUE_ID || splitSymbol(signal.symbol).settle !== undefined;
}

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
    //
    // exitStyle 'RESTING' (plan-mode take-profit) with a hint present overrides the crossed-exit
    // path entirely: the exit rests GTC at the hint, rounded the conservative direction (SELL up —
    // never receive worse than the TP price). A RESTING exit with no hint has no price to rest at,
    // so it falls back to the ordinary crossed-IOC path rather than guessing a price.
    //
    // exitStyle 'RESTING_STOP' (Push 3 P7b) is a distinct protective-stop variant, handled entirely
    // below (see the isRestingStopExit branch): it builds a venue trigger order (STOP_MARKET/
    // STOP_LOSS_LIMIT) off triggerPriceHint instead of a plain limit price, so it is excluded from
    // isRestingExit/isCrossedExit here — this legacy-path block never sees it.
    const refPrice = signal.refPrice;
    const isRestingStopExit =
      reduceOnly && signal.exitStyle === 'RESTING_STOP' && signal.triggerPriceHint !== undefined;
    const isRestingExit =
      reduceOnly &&
      !isRestingStopExit &&
      signal.exitStyle === 'RESTING' &&
      signal.limitPriceHint !== undefined;
    const isCrossedExit =
      reduceOnly && !isRestingExit && !isRestingStopExit && signal.limitPriceHint === undefined;

    let type: OrderIntent['type'];
    let limitPrice: Price | undefined;
    let triggerPrice: Price | undefined;
    let timeInForce: OrderIntent['timeInForce'];

    if (isRestingStopExit) {
      // Protective stop (reduce-only exit resting at the venue): trigger rounds AWAY from the
      // market on the protective side — SELL (long stop-loss) rounds DOWN, BUY-cover (short
      // stop-loss) rounds UP — so tick-rounding can only ever loosen the stop, never fire it
      // earlier/tighter than the strategy requested.
      const trigger = signal.triggerPriceHint;
      const triggerDirection = side === 'SELL' ? 'down' : 'up';
      triggerPrice = roundToTick(trigger, filters.tickSize, triggerDirection);
      if (isPerpSignal(signal)) {
        // Perp venues carry a native conditional/ALGO rail — no limit leg needed.
        type = 'STOP_MARKET';
      } else {
        // Spot has no native stop order; STOP_LOSS_LIMIT rests a limit leg once triggered, buffered
        // past the trigger so it is immediately marketable on the fill side (SELL leg below the
        // trigger, BUY-cover leg above it) rather than resting passively and never filling.
        type = 'STOP_LOSS_LIMIT';
        const bufferBps = this.deps.stopLimitBufferBps ?? 50;
        const buffer = new Decimal(bufferBps).div(10_000);
        const rawLeg =
          side === 'SELL' ? trigger.mul(new Decimal(1).sub(buffer)) : trigger.mul(buffer.add(1));
        limitPrice = roundToTick(rawLeg, filters.tickSize, side === 'SELL' ? 'down' : 'up');
      }
      timeInForce = 'GTC';
    } else {
      // Limit price: hint or decision-time reference, rounded directionally to the tick. A hint or
      // an entry price rounds conservatively (BUY down, SELL up — never pay/receive worse than
      // intended). Reduce-only intents with no caller-supplied hint are instead made marketable
      // (crossed past the spread by EXIT_CROSS_BUFFER_BPS): the tick-rounding direction FLIPS to
      // stay crossed rather than retreat toward passive — SELL rounds down (still below the bid),
      // BUY-cover rounds up (still above the ask) — so a partial IOC fill never leaves sub-minNotional
      // dust resting away from market. A caller-supplied hint (e.g. the kill-switch flatten path's
      // own band-edge pricing) always wins, unchanged, using the conservative direction.
      const basePrice =
        signal.limitPriceHint ?? (isCrossedExit ? this.crossedExitPrice(side, refPrice) : refPrice);
      const tickDirection = isCrossedExit
        ? side === 'BUY'
          ? 'up'
          : 'down'
        : side === 'BUY'
          ? 'down'
          : 'up';
      limitPrice = roundToTick(basePrice, filters.tickSize, tickDirection);
      type = reduceOnly ? 'LIMIT' : this.entryType(side, basePrice, refPrice);
      timeInForce = reduceOnly ? (isRestingExit ? 'GTC' : 'IOC') : 'GTC';
    }

    // Sizing: reduce-only legs (exit-long, cover-short, flatten) reduce the attributed position;
    // entries (long or short) scale by conviction — compounding equity-fraction sizing when enabled,
    // else the legacy fixed baseNotional.
    const rawQty: Decimal = reduceOnly
      ? posQty.abs()
      : this.entryNotional(signal, snapshot, side).div(limitPrice!);
    // A reduce-only with nothing attributed is a strategy no-op, not a dust order — report it
    // distinctly so trade analysis can separate "flat, nothing to exit" from a genuine sub-min size.
    if (rawQty.lte(0)) return { ok: false, reason: 'NO_POSITION' };

    // Round the raw (possibly high-precision, e.g. baseNotional/price) quantity to the step FIRST;
    // wrapping it in qty() before rounding would throw on the 18-place precision limit.
    const steppedQty: Qty = roundToStep(rawQty, filters.stepSize, 'down');
    // Notional check: STOP_MARKET carries no limit leg, so the trigger price is the best available
    // proxy for the eventual fill price (a STOP_LOSS_LIMIT/plain-limit intent always has limitPrice).
    const notionalPrice = limitPrice ?? triggerPrice!;
    if (
      steppedQty.lt(new Decimal(filters.minQty)) ||
      steppedQty.mul(notionalPrice).lt(new Decimal(filters.minNotional))
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
      type,
      qty: steppedQty,
      limitPrice,
      triggerPrice,
      timeInForce,
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

  // ENTRY_ORDER_TYPE=LIMIT_MAKER (deps.entryOrderType) rests non-reduce-only intents post-only
  // (maker fee, never taker); 'LIMIT' (the default) is byte-identical to pre-knob behavior. Only
  // called for entries — exits always stay plain 'LIMIT'+IOC (the caller branches on reduceOnly).
  //
  // Fallback to plain 'LIMIT': the sizer has no order-book access, so it cannot see whether basePrice
  // would actually cross the current bid/ask. As a proxy, basePrice on the marketable side of refPrice
  // (BUY priced above, SELL priced below — the plan mode signature of a negative entryOffsetBps, which
  // rests the entry ABOVE the last close instead of below it, see anthropic-agent-client.ts) is treated
  // as a likely crossing entry: a post-only order priced there would immediately match and be
  // venue-rejected. Falling back to plain LIMIT there is the safe direction — worst case it costs a
  // taker fee on a fill that would have succeeded as maker. A passively-priced LIMIT_MAKER can still
  // cross if the book moves before placement; that fails safely (OrderImmediatelyFillable →
  // TERMINAL_REJECT, no blind resubmit) and the plan/strategy re-fires.
  private entryType(
    side: 'BUY' | 'SELL',
    basePrice: Decimal,
    refPrice: Decimal,
  ): 'LIMIT' | 'LIMIT_MAKER' {
    if ((this.deps.entryOrderType ?? 'LIMIT') !== 'LIMIT_MAKER') return 'LIMIT';
    const wouldCross = side === 'BUY' ? basePrice.gt(refPrice) : basePrice.lt(refPrice);
    return wouldCross ? 'LIMIT' : 'LIMIT_MAKER';
  }

  // Entry (non-reduce-only) notional, quote-denominated. P5 compounding path: equity × fraction ×
  // strength, when a positive fraction is configured AND equity is finite-positive (an unfunded or
  // corrupt equity read falls back to the legacy path rather than sizing off a nonsensical base).
  // Falls back to the legacy fixed baseNotional × strength otherwise — byte-identical to the
  // pre-P5 behavior for every deployment that leaves SIZER_EQUITY_FRACTION at its disabled default.
  //
  // A single extra clamp applies to spot BUY entries only: capped at 95% of the symbol's free quote
  // balance, so a compounding size can never request more quote cash than is actually free (the
  // RiskEngine's maxOrderNotional/exposure limits are a separate, independent ceiling — this clamp
  // is the sizer's own affordability check). SELL entries (opening a spot short — never happens —
  // or a perp short) spend no quote cash up front, so the clamp does not apply. Absent balance
  // data ⇒ no cap here — the engine/venue still vetoes an unaffordable order downstream. Perp
  // (margined) venues skip this spot-specific cash clamp entirely and go through applyPerpCaps
  // instead (margin×leverageCap + liq-buffer, applied to BOTH sides — a perp short still locks
  // margin, unlike a spot sell).
  private entryNotional(
    signal: Signal,
    snapshot: PortfolioSnapshot,
    side: 'BUY' | 'SELL',
  ): Decimal {
    const isPerp = isPerpSignal(signal);
    const fraction = new Decimal(this.deps.equityFraction ?? '0');
    const legacyNotional = new Decimal(this.deps.baseNotional).mul(signal.strength);

    let base: Decimal;
    if (fraction.lte(0) || !snapshot.equity.isFinite() || snapshot.equity.lte(0)) {
      base = legacyNotional;
    } else {
      const target = snapshot.equity.mul(fraction).mul(signal.strength);
      if (side === 'BUY' && !isPerp) {
        const quoteAsset = splitSymbol(signal.symbol).quote;
        const freeQuote = snapshot.balances.get(quoteAsset)?.free;
        base = freeQuote === undefined ? target : Decimal.min(target, freeQuote.mul('0.95'));
      } else {
        base = target;
      }
    }

    return isPerp ? this.applyPerpCaps(base, signal, snapshot) : base;
  }

  // Perp entry-sizing caps (B2): notional = min(currentBehavior, margin×leverageCap,
  // liqSafeNotional), then the optional funding-scaling hook. deps.perp absent (module-isolation
  // fixtures that never configure it) ⇒ no additional cap, matching every other optional-deps
  // fallback in this service.
  private applyPerpCaps(base: Decimal, signal: Signal, snapshot: PortfolioSnapshot): Decimal {
    const perp = this.deps.perp;
    if (!perp) return base;

    const marginAsset = splitSymbol(signal.symbol).settle ?? splitSymbol(signal.symbol).quote;
    const freeMargin = snapshot.balances.get(marginAsset)?.free;
    const leverageCap = new Decimal(perp.leverageCap);

    let notional = base;
    // Absent margin-balance data ⇒ no margin cap here, mirroring the spot free-quote clamp's own
    // "absent balance ⇒ no cap" fallback — the engine/venue still vetoes an unaffordable order.
    if (freeMargin !== undefined) {
      notional = Decimal.min(notional, marginNotionalCap(freeMargin, leverageCap));
    }
    const liqCap = liqSafeNotionalCap(
      leverageCap,
      new Decimal(perp.mmrFallback),
      new Decimal(perp.liqBufferPct),
    );
    notional = Decimal.min(notional, liqCap);

    const fundingBps =
      perp.expectedFundingBpsPerHold === undefined
        ? undefined
        : new Decimal(perp.expectedFundingBpsPerHold);
    return applyFundingScaling(notional, fundingBps);
  }
}
