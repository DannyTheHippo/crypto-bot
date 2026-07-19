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

// S2/C1: true when `side` opens/adds to a position on the SAME side as the attributed posQty sign
// (positive = long, negative = short — mirrors the FLATTEN orientation above). Zero (flat) is never
// "same side" — that's a fresh entry, not a scale-in, so the headroom clamp must not apply.
function isSameSideEntry(side: 'BUY' | 'SELL', posQty: Decimal): boolean {
  if (posQty.isZero()) return false;
  return side === 'BUY' ? posQty.gt(0) : posQty.lt(0);
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

    // Sizing: reduce-only legs (exit-long, cover-short, flatten) reduce the attributed position —
    // S2/C1's reduceFraction scopes a partial close (posQty.abs() × reduceFraction ?? '1', full size
    // when absent, byte-identical); entries (long or short) scale by conviction — compounding
    // equity-fraction sizing when enabled, the model's own sizeFraction directive when present (C1),
    // else the legacy fixed baseNotional.
    const rawQty: Decimal = reduceOnly
      ? posQty.abs().mul(new Decimal(signal.reduceFraction ?? '1'))
      : this.entryNotional(signal, snapshot, side, posQty).div(limitPrice!);
    // A reduce-only with nothing attributed (or a fully-zeroed reduceFraction) is a strategy no-op,
    // not a dust order — report it distinctly so trade analysis can separate "flat, nothing to
    // exit" from a genuine sub-min size. A non-sizeFraction entry that collapses to zero/negative
    // (legacy zero-strength, or the perp liq-safety gate collapsing to 0 — see applyPerpCaps) keeps
    // that same NO_POSITION shortcut, byte-identical to pre-C1 behavior. A sizeFraction-directed
    // entry (C1) is different: the model asked for a specific, nonzero size — a same-side scale-in
    // clamped to zero/negative by exhausted headroom IS a sizable request the venue floor rejects,
    // so it routes to BELOW_MINIMUM (the ordinary gate below) instead of this no-op shortcut.
    if (rawQty.lte(0)) {
      return {
        ok: false,
        reason: !reduceOnly && signal.sizeFraction !== undefined ? 'BELOW_MINIMUM' : 'NO_POSITION',
      };
    }

    // Round the raw (possibly high-precision, e.g. baseNotional/price) quantity to the step FIRST;
    // wrapping it in qty() before rounding would throw on the 18-place precision limit.
    const steppedQty: Qty = roundToStep(rawQty, filters.stepSize, 'down');
    // Notional check: STOP_MARKET carries no limit leg, so the trigger price is the best available
    // proxy for the eventual fill price (a STOP_LOSS_LIMIT/plain-limit intent always has limitPrice).
    const notionalPrice = limitPrice ?? triggerPrice!;
    // Binance USD-M exempts reduce-only orders from MIN_NOTIONAL (-4164 binds "unless reduce
    // only"; P0d probe 2026-07-13 verified a sub-floor reduce-only STOP_MARKET is accepted).
    // Without this carve-out a small perp position's protective stop is self-rejected here while
    // the venue would take it — the P7e-confirmed protection-gap band [minNotional,
    // minNotional/(1−stopLossPct)). minQty/stepSize still bind. Spot has no such exemption and
    // keeps the full gate.
    const minNotionalExempt = reduceOnly && isPerpSignal(signal);
    if (
      steppedQty.lt(new Decimal(filters.minQty)) ||
      (!minNotionalExempt && steppedQty.mul(notionalPrice).lt(new Decimal(filters.minNotional)))
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

  // Entry (non-reduce-only) notional, quote-denominated. Sizing equity is cappedEquity(actualEquity)
  // throughout (C1, SIZER_EQUITY_CAP — see cappedEquity's own comment). Three paths, in priority
  // order: (1) C1 — signal.sizeFraction present ⇒ the model's own directive, strength/equityFraction
  // ignored entirely (see sizeFractionNotional); (2) P5 compounding — cappedEquity × fraction ×
  // strength, when a positive fraction is configured AND cappedEquity is finite-positive (an
  // unfunded/corrupt equity read falls back to the legacy path rather than sizing off a nonsensical
  // base); (3) legacy fixed baseNotional × strength — byte-identical to pre-P5 behavior for every
  // deployment that leaves SIZER_EQUITY_FRACTION at its disabled default (modulo the equity cap).
  //
  // A single extra clamp applies to spot BUY entries only, on EITHER of paths (1)/(2): capped at 95%
  // of the symbol's free quote balance, so a sized entry can never request more quote cash than is
  // actually free (the RiskEngine's maxOrderNotional/exposure limits are a separate, independent
  // ceiling — this clamp is the sizer's own affordability check). SELL entries (opening a spot short
  // — never happens — or a perp short) spend no quote cash up front, so the clamp does not apply.
  // Absent balance data ⇒ no cap here — the engine/venue still vetoes an unaffordable order
  // downstream. Perp (margined) venues skip this spot-specific cash clamp entirely and go through
  // applyPerpCaps instead (margin×leverageCap + liq-buffer, applied to BOTH sides — a perp short
  // still locks margin, unlike a spot sell).
  private entryNotional(
    signal: Signal,
    snapshot: PortfolioSnapshot,
    side: 'BUY' | 'SELL',
    posQty: Decimal,
  ): Decimal {
    const isPerp = isPerpSignal(signal);
    const cappedEquity = this.cappedEquity(snapshot.equity);

    let base: Decimal;
    if (signal.sizeFraction !== undefined) {
      base = this.sizeFractionNotional(signal, snapshot, side, cappedEquity, posQty);
    } else {
      const fraction = new Decimal(this.deps.equityFraction ?? '0');
      const legacyNotional = new Decimal(this.deps.baseNotional).mul(signal.strength);
      if (fraction.lte(0) || !cappedEquity.isFinite() || cappedEquity.lte(0)) {
        base = legacyNotional;
      } else {
        const target = cappedEquity.mul(fraction).mul(signal.strength);
        base = this.applyAffordabilityClamp(target, signal, side, snapshot);
      }
    }

    return isPerp ? this.applyPerpCaps(base, signal, snapshot) : base;
  }

  // SIZER_EQUITY_CAP (C1, Design § Live-scale economics): sizing equity across every notional path
  // is min(actualEquity, cap) when a finite-positive cap is configured — a demo account earns its
  // promotion verdict at exactly live-book proportions. Absent/non-finite/non-positive cap ⇒ actual
  // equity passes through unchanged (byte-identical to pre-cap behavior).
  private cappedEquity(actualEquity: Decimal): Decimal {
    const cap = this.deps.equityCap;
    if (cap === undefined) return actualEquity;
    const capDecimal = new Decimal(cap);
    if (!capDecimal.isFinite() || capDecimal.lte(0)) return actualEquity;
    return Decimal.min(actualEquity, capDecimal);
  }

  // C1: the agentic lane's own sizing directive. notional = cappedEquity × min(sizeFraction,
  // maxAgentPositionFraction ?? '0.15') — strength and SIZER_EQUITY_FRACTION are deliberately
  // ignored on this path (sizeFraction IS the conviction channel, Design § Sizing flow). A same-side
  // position already open (scale-in) OR a same-side entry order still resting/in-flight and unfilled
  // additionally clamps to the remaining fraction headroom (maxFraction×cappedEquity − |posNotional|
  // − reservedEntryNotional): posNotional is valued at signal.refPrice — the current decision-time
  // reference, not the position's historical avgEntry — while reservedEntryNotional is valued at
  // each resting/in-flight order's own limit price (see reservedEntryNotional below). So repeated
  // scale-ins can never compound past the per-lane cap in aggregate. Gating on posQty alone (the
  // pre-fix behaviour) missed a
  // same-symbol scale-in placed while the prior entry order is still entirely unfilled — posQty is
  // 0 until a fill lands, so the clamp was skipped and the cap bypassable by stacking unfilled
  // entries (CONFIRMED risk-cap bypass); reservedEntryNotional closes that gap by also gating on the
  // resting/in-flight order registry. A headroom ≤ 0 (already at/over cap) or negative clamp flows
  // through as a non-positive target, which size()'s BELOW_MINIMUM gate rejects downstream — never
  // silently floors to a dust order.
  private sizeFractionNotional(
    signal: Signal,
    snapshot: PortfolioSnapshot,
    side: 'BUY' | 'SELL',
    cappedEquity: Decimal,
    posQty: Decimal,
  ): Decimal {
    const maxFraction = new Decimal(this.deps.maxAgentPositionFraction ?? '0.15');
    const sizeFraction = Decimal.min(new Decimal(signal.sizeFraction!), maxFraction);
    let target = cappedEquity.mul(sizeFraction);

    const reserved = this.reservedEntryNotional(signal, snapshot, side);
    if (isSameSideEntry(side, posQty) || reserved.gt(0)) {
      const posNotional = posQty.abs().mul(signal.refPrice);
      const headroom = cappedEquity.mul(maxFraction).sub(posNotional).sub(reserved);
      target = Decimal.min(target, headroom);
    }

    return this.applyAffordabilityClamp(target, signal, side, snapshot);
  }

  // Same-lane (strategyId + venue + symbol) resting-or-in-flight ENTRY order notional matching
  // `side` — snapshot.inFlightIntents is the runtime's single non-terminal order registry (an order
  // joins it before placeOrder and leaves only on a terminal fill/reject/cancel, so it covers both
  // truly in-flight and already-acked/resting orders, execution-gate.service.ts's addInFlight/
  // clearInFlight). Reduce-only orders only ever shrink exposure, so they reserve nothing. Valued at
  // each order's own limit price (its actual reserved notional); falls back to the order's own
  // refPrice for the (never-hit for a non-reduce-only entry) undefined case. FAILS CLOSED: a
  // partially-filled order's already-filled leg is counted here AND in the filled-position notional
  // above — deliberate over-reservation, never under-reservation.
  private reservedEntryNotional(
    signal: Signal,
    snapshot: PortfolioSnapshot,
    side: 'BUY' | 'SELL',
  ): Decimal {
    let reserved = new Decimal(0);
    for (const f of snapshot.inFlightIntents) {
      if (
        f.reduceOnly ||
        f.side !== side ||
        f.strategyId !== signal.strategyId ||
        f.venue !== signal.venue ||
        f.symbol !== signal.symbol
      ) {
        continue;
      }
      reserved = reserved.add(f.qty.mul(f.limitPrice ?? f.refPrice));
    }
    return reserved;
  }

  // Spot BUY affordability clamp, shared by the equity-fraction and sizeFraction entry paths — see
  // entryNotional's header comment for the full spot/perp/SELL split.
  private applyAffordabilityClamp(
    target: Decimal,
    signal: Signal,
    side: 'BUY' | 'SELL',
    snapshot: PortfolioSnapshot,
  ): Decimal {
    if (side !== 'BUY' || isPerpSignal(signal)) return target;
    const quoteAsset = splitSymbol(signal.symbol).quote;
    const freeQuote = snapshot.balances.get(quoteAsset)?.free;
    return freeQuote === undefined ? target : Decimal.min(target, freeQuote.mul('0.95'));
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
