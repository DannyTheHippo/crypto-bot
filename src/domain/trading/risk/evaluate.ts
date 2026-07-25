import Decimal from 'decimal.js';
import type { OrderIntent } from '../types/order-intent';
import type { PortfolioSnapshot, Position } from '../types/portfolio';
import type { Price, Qty } from '../../common/types/money';
import { roundToStep, roundToTick } from '../../common/types/money';
import type { RiskReason } from '../types/risk-decision';
import type { ChannelHealth } from '../../venue/types/market-events';
import type { TradingMode } from '../types/mode';
import type { EpochMs, StrategyId, VenueId, SymbolId } from '../../common/types/ids';
import { validateLimits, type PartialRiskLimits } from './limits';
import { splitSymbol } from '../../venue/types/symbol';
import type { KillSwitchState } from './kill-switch';

// ── Inputs (all facts pre-computed by the stateful layer; evaluate stays pure) ──

export interface SymbolFilters {
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minQty: string;
  readonly minNotional: string;
}

export interface MarkInfo {
  readonly mid: Price;
  readonly ageMs: number;
  readonly feedHealth: ChannelHealth;
  readonly lastTrade?: Price;
}

export interface RateState {
  readonly allowed: boolean; // token buckets had capacity (global/symbol/strategy/flatten)
  readonly runaway: boolean; // ≥25 rate-rejects in 5s → escalation
}

export interface RiskEvalInput {
  readonly intent: OrderIntent;
  readonly isFlatten: boolean; // true ONLY for kill-switch flatten intents (band/notional clamp vs hard-reject)
  readonly snapshot: PortfolioSnapshot;
  readonly limits: PartialRiskLimits | null;
  readonly killState: KillSwitchState;
  readonly effectiveMode: TradingMode;
  readonly mark: MarkInfo | undefined;
  readonly filters: SymbolFilters;
  readonly rate: RateState;
  readonly wouldCross: boolean;
  // Pre-trade portfolio exposure (quote), pre-valued across all symbols by the
  // portfolio layer. v1 is spot long/flat, so an increasing order raises gross and
  // net by the same order notional; the binding constraint is the tighter headroom.
  readonly currentGross: Decimal;
  readonly currentNet: Decimal;
  readonly now: EpochMs;
}

export type HaltRequest = 'DAILY_LOSS' | 'MAX_DRAWDOWN' | 'ORDER_RATE_RUNAWAY';

export type RiskEvaluation =
  | { readonly verdict: 'APPROVED'; readonly intent: OrderIntent }
  | {
      readonly verdict: 'RESIZED';
      readonly intent: OrderIntent;
      readonly originalQty: Qty;
      readonly reasons: readonly RiskReason[];
    }
  | {
      readonly verdict: 'REJECTED';
      readonly intent: OrderIntent;
      readonly reasons: readonly RiskReason[];
      readonly halt?: HaltRequest;
    };

export function positionKey(strategyId: StrategyId, venue: VenueId, symbol: SymbolId): string {
  return `${strategyId}:${venue}:${symbol}`;
}

function reject(intent: OrderIntent, reason: RiskReason, halt?: HaltRequest): RiskEvaluation {
  return { verdict: 'REJECTED', intent, reasons: [reason], halt };
}

// signed quantity an intent contributes: BUY adds, SELL subtracts
function signedQty(side: OrderIntent['side'], q: Decimal): Decimal {
  return side === 'BUY' ? q : q.neg();
}

export function evaluate(input: RiskEvalInput): RiskEvaluation {
  const { intent, isFlatten, snapshot, killState, effectiveMode, mark, filters, rate, wouldCross } =
    input;
  const reduceOnly = intent.reduceOnly;
  const flattenClamp = isFlatten && reduceOnly; // FLATTEN gets clamps where strategy intents hard-reject
  // Push 3 P7b: a triggerPrice marks a venue trigger order (STOP_LOSS_LIMIT/STOP_MARKET) — a
  // protective stop, by definition an exit. Never an entry: fail closed rather than let a
  // non-reduce-only trigger order (out of scope for this pass) slip through unchecked.
  const hasTrigger = intent.triggerPrice !== undefined;
  if (hasTrigger && !reduceOnly) return reject(intent, 'REDUCE_ONLY_VIOLATION');

  // G0 — kill switch (reduce-only FLATTEN carve-out during FLATTENING)
  if (!(killState === 'RUNNING' || (killState === 'FLATTENING' && flattenClamp))) {
    return reject(intent, 'KILL_SWITCH');
  }

  // G1 — mode match (catches a downgrade between decision and submission)
  if (intent.mode !== effectiveMode) return reject(intent, 'MODE_MISMATCH');

  // G2 — limits complete (defense in depth behind ModeControl gate d)
  const limits = validateLimits(input.limits);
  if (limits === null) return reject(intent, 'LIMITS_INCOMPLETE');

  // P1 — market-data staleness; flatten carve-out may use last-trade with band ×2
  //
  // The bound is TWO-SIDED (fix 2026-07-22, security review MF1). `ageMs` is `now - ref.at`, so a
  // FUTURE-stamped ref price yields a NEGATIVE age that trivially satisfies an upper-bound-only test.
  // That is reachable: a venue emitting microsecond or skewed timestamps is passed through on a bare
  // `typeof === 'number'` check (ccxt-stream.adapter.ts) and stored verbatim (normalize.ts). Worse,
  // FeedHealthService.updateRefPrice only accepts `at >= existing.at`, so ONE future-stamped frame
  // both passes this gate and FREEZES the mark — every correct frame after it is discarded as older —
  // leaving orders priced off a stale mid for as long as the bogus stamp leads the clock, bounded only
  // by the drift collar below. A negative age is never a fresh price; it is a broken clock, so it
  // fails CLOSED here (and updateRefPrice additionally refuses far-future stamps at the source).
  const fresh =
    mark !== undefined &&
    mark.ageMs >= 0 &&
    mark.ageMs <= limits.staleMaxAgeMs &&
    mark.feedHealth === 'LIVE';
  let refMid: Decimal;
  let bandMultiplier = 1;
  if (fresh) {
    refMid = mark.mid;
  } else if (flattenClamp && mark?.lastTrade !== undefined) {
    refMid = mark.lastTrade;
    bandMultiplier = 2; // you must be able to flatten on stale data; never add risk on it
  } else {
    return reject(intent, 'STALE_DATA');
  }

  const reasons: RiskReason[] = [];
  let workingPrice: Decimal = intent.limitPrice ?? refMid;
  let workingQty: Decimal = intent.qty;

  // P2 — price band. A trigger order (hasTrigger) is priced around its TRIGGER, not around a
  // resting/crossing limit price, so it swaps this whole gate for its own trigger-specific matrix
  // (T1-T3) below rather than running both — see that branch's own comments. Every other intent
  // keeps the pre-existing band logic unchanged.
  if (hasTrigger) {
    const trigger = intent.triggerPrice;
    // T1 — protective side: a SELL stop (protects a long) must trigger BELOW mid; a BUY-cover stop
    // (protects a short) must trigger ABOVE mid — the opposite side would fire immediately on
    // submission instead of protecting against an adverse move.
    const protectiveSideOk = intent.side === 'SELL' ? trigger.lt(refMid) : trigger.gt(refMid);
    if (!protectiveSideOk) return reject(intent, 'PRICE_BAND');

    // T2 — distance: the trigger must not sit further from mid than maxStopTriggerBandBps — a
    // trigger far beyond this is far more likely a bug than a deliberately wide stop.
    const maxTriggerBand = new Decimal(limits.maxStopTriggerBandBps).div(10_000);
    const triggerDeviation = trigger.sub(refMid).abs().div(refMid);
    if (triggerDeviation.gt(maxTriggerBand)) return reject(intent, 'PRICE_BAND');

    // T3 — spot limit-leg sanity (STOP_LOSS_LIMIT only; STOP_MARKET carries no limit leg): the leg
    // must hug the trigger within 2× the configured buffer — PositionSizerService only ever buffers
    // by exactly stopLimitBufferBps, so anything further out is corruption, not a legitimate wider
    // buffer.
    if (intent.limitPrice !== undefined) {
      const maxLegBand = new Decimal(limits.stopLimitBufferBps).mul(2).div(10_000);
      const legDeviation = intent.limitPrice.sub(trigger).abs().div(trigger);
      if (legDeviation.gt(maxLegBand)) return reject(intent, 'PRICE_BAND');
    }
  } else {
    // A reduce-only intent priced on the PASSIVE side of the reference (a resting take-profit:
    // SELL ≥ mid, BUY-cover ≤ mid) checks against the wider maxPassiveExitBandBps instead — a live
    // TP legitimately sits far from ref. Aggressive-side reduce-only intents (crossing toward the
    // market) and every non-reduce-only intent keep the tight maxBandBps. Kill-switch flattens
    // (flattenClamp) are ALWAYS excluded: the band-edge clamp below is the mechanism that repairs a
    // mis-directed marketable price (e.g. a short-cover priced long-side at mark×0.98 — accidentally
    // passive), and the wide band would swallow that repair, leaving an unmarketable resting
    // flatten and a >60s-unknown escalation (review finding).
    const isPassiveReduceOnlyExit =
      reduceOnly &&
      !flattenClamp &&
      ((intent.side === 'SELL' && workingPrice.gte(refMid)) ||
        (intent.side === 'BUY' && workingPrice.lte(refMid)));
    const bandBps = isPassiveReduceOnlyExit ? limits.maxPassiveExitBandBps : limits.maxBandBps;
    const maxBand = new Decimal(bandBps).mul(bandMultiplier).div(10_000);
    const bandDeviation = workingPrice.sub(refMid).abs().div(refMid);
    if (bandDeviation.gt(maxBand)) {
      if (flattenClamp) {
        // clamp to the band edge on the order's side (marketable-limit at the edge)
        const edge =
          intent.side === 'BUY'
            ? refMid.mul(maxBand.add(1))
            : refMid.mul(new Decimal(1).sub(maxBand));
        workingPrice = edge;
        reasons.push('PRICE_BAND');
      } else {
        return reject(intent, 'PRICE_BAND'); // an out-of-band strategy price is a bug, never silently repriced
      }
    }
  }

  // P3 — fat-finger notional
  const maxOrderNotional = new Decimal(limits.maxOrderNotional);
  if (workingQty.mul(workingPrice).gt(maxOrderNotional)) {
    if (flattenClamp) {
      workingQty = maxOrderNotional.div(workingPrice); // F1 will round/validate the slice
      reasons.push('FAT_FINGER');
    } else {
      return reject(intent, 'FAT_FINGER'); // clamping masks a strategy bug
    }
  }

  // P4 — expiry + drift collar
  if (input.now > intent.expiresAt) return reject(intent, 'EXPIRED');
  const driftBps = intent.refPrice.sub(refMid).abs().div(refMid).mul(10_000);
  if (driftBps.gt(new Decimal(limits.maxDriftBps))) return reject(intent, 'REF_DRIFT');

  // R1 — order rate (SOFT: reject this perishable intent; runaway escalates to kill switch)
  if (!rate.allowed) {
    return {
      verdict: 'REJECTED',
      intent,
      reasons: ['RATE_LIMIT'],
      halt: rate.runaway ? 'ORDER_RATE_RUNAWAY' : undefined,
    };
  }

  // X1 — crossing a sibling strategy's resting order
  if (wouldCross) return reject(intent, 'CROSSING_INTENT');

  // Position / exposure context
  const pos: Position | undefined = snapshot.positions.get(
    positionKey(intent.strategyId, intent.venue, intent.symbol),
  );
  const posQty = pos ? pos.signedQty : new Decimal(0);
  let inflightSigned = new Decimal(0);
  for (const f of snapshot.inFlightIntents) {
    if (
      f.strategyId === intent.strategyId &&
      f.venue === intent.venue &&
      f.symbol === intent.symbol
    ) {
      inflightSigned = inflightSigned.add(signedQty(f.side, f.qty));
    }
  }

  // E1 — max position per symbol (reduce-only always reduces ⇒ skip the clamp)
  if (!reduceOnly) {
    const maxPos = new Decimal(limits.maxPositionPerSymbol);
    const base = posQty.add(inflightSigned); // committed same-direction exposure
    const postAbs = base.add(signedQty(intent.side, workingQty)).abs();
    if (postAbs.gt(maxPos)) {
      const headroom = maxPos.sub(base.abs());
      if (headroom.lte(0)) return reject(intent, 'POSITION_LIMIT'); // no room at all
      workingQty = headroom; // clamp to headroom; F1 re-checks the exchange minimum
      reasons.push('POSITION_LIMIT');
    }
  }

  // E2 / E3 — gross & net exposure (reduce-only strictly decreases ⇒ always passes)
  if (!reduceOnly) {
    const grossHeadroom = new Decimal(limits.maxGrossExposure).sub(input.currentGross);
    // Net exposure is bounded by |net| ≤ maxNet in BOTH directions. A BUY grows net up and consumes
    // maxNet − currentNet; a SELL (short open) grows net DOWN and consumes maxNet − (−currentNet) =
    // maxNet + currentNet. The old direction-blind subtraction let a net-SHORT book breach −maxNet
    // (netHeadroom inflated by |currentNet|). Byte-identical for BUY (the only prior non-reduce side).
    const signedNet = intent.side === 'BUY' ? input.currentNet : input.currentNet.neg();
    const netHeadroom = new Decimal(limits.maxNetExposure).sub(signedNet);
    const headroom = Decimal.min(grossHeadroom, netHeadroom); // tighter of the two binds
    const orderNotional = workingQty.mul(workingPrice);
    if (orderNotional.gt(headroom)) {
      if (headroom.lte(0)) return reject(intent, 'EXPOSURE_LIMIT');
      workingQty = headroom.div(workingPrice); // clamp to remaining headroom; F1 re-validates
      reasons.push('EXPOSURE_LIMIT');
    }
  }

  // C1 — max daily loss (equality trips); reduce-only passes
  if (!reduceOnly) {
    const loss = snapshot.sodEquityUtc.sub(snapshot.equity);
    if (loss.gte(new Decimal(limits.maxDailyLoss))) {
      return { verdict: 'REJECTED', intent, reasons: ['DAILY_LOSS'], halt: 'DAILY_LOSS' };
    }
  }

  // C2 — max drawdown (equality trips); reduce-only passes
  if (!reduceOnly && snapshot.peakEquity.gt(0)) {
    const dd = snapshot.peakEquity.sub(snapshot.equity).div(snapshot.peakEquity);
    if (dd.gte(new Decimal(limits.maxDrawdownPct))) {
      return { verdict: 'REJECTED', intent, reasons: ['MAX_DRAWDOWN'], halt: 'MAX_DRAWDOWN' };
    }
  }

  // F2 — reduce-only semantics (sign opposes position; qty ≤ |position|; no flips)
  if (reduceOnly) {
    const reduces =
      (posQty.gt(0) && intent.side === 'SELL') || (posQty.lt(0) && intent.side === 'BUY');
    if (!reduces) return reject(intent, 'REDUCE_ONLY_VIOLATION');
    const maxReduce = posQty.abs();
    if (workingQty.gt(maxReduce)) {
      workingQty = maxReduce; // clamp down; F1 re-validates
      reasons.push('REDUCE_ONLY_VIOLATION');
    }
  }

  // F1 — post-clamp exchange-filter validation (a clamp below minimums REJECTS, never doom-submits)
  const steppedQty = roundToStep(workingQty, filters.stepSize, 'down');
  if (steppedQty.lt(new Decimal(filters.minQty))) return reject(intent, 'BELOW_EXCHANGE_MIN');
  const tickedPrice = roundToTick(
    workingPrice,
    filters.tickSize,
    intent.side === 'BUY' ? 'down' : 'up',
  );
  // Reduce-only perp intents are venue-exempt from MIN_NOTIONAL (Binance USD-M -4164 binds
  // "unless reduce only"; P0d probe verified a sub-floor reduce-only STOP_MARKET is accepted).
  // Mirrors the sizer's carve-out — rejecting here would strand a small position's protective
  // stop the venue itself accepts (P7e finding). This gate is a pre-flight mirror of a venue
  // rule, so over-admitting fails safe: the venue re-checks. Spot keeps the full gate.
  const minNotionalExempt = intent.reduceOnly && splitSymbol(intent.symbol).settle !== undefined;
  if (!minNotionalExempt && steppedQty.mul(tickedPrice).lt(new Decimal(filters.minNotional)))
    return reject(intent, 'BELOW_EXCHANGE_MIN');

  // Build the final (possibly resized) intent.
  const finalIntent: OrderIntent = { ...intent, qty: steppedQty, limitPrice: tickedPrice };

  if (reasons.length === 0 && steppedQty.eq(intent.qty)) {
    return { verdict: 'APPROVED', intent: finalIntent };
  }
  return { verdict: 'RESIZED', intent: finalIntent, originalQty: intent.qty, reasons };
}
