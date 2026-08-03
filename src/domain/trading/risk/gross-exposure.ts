import Decimal from 'decimal.js';
import { applyFillToPosition, FLAT, type PositionState } from '../oms/position';

// ── Time-weighted average gross exposure, replayed purely from fills ───────────────────────────────
//
// WHY A REPLAY, NOT A SNAPSHOT: there is no exposure history to read — equity_curve carries no
// exposure column, and `positions` is replaceAll'd on every sample (a snapshot, not a series). The
// only durable source for "what was the book's gross notional at time T" is the fills themselves, so
// this folds them into a stepwise per-symbol position series using the SAME average-cost accounting
// the OMS/paper-fill path already uses (applyFillToPosition, domain/trading/oms/position.ts), valued
// at avgEntry — the identical convention agent-portfolio-block.ts:74-96 and risk-engine.service.ts's
// pre-trade `gross` fold both apply. No mark-to-market: introducing a second exposure convention
// inside a live-arming gate is worse than reusing the one the risk/prompt paths already trust.

export interface GrossExposureFill {
  readonly symbol: string;
  // null (unresolved order_intents join) carries no direction to replay — the fill is skipped and
  // the position it belongs to is left unchanged, same under-count-never-guess discipline
  // round-trips.ts's walk applies to the identical join gap.
  readonly side: 'BUY' | 'SELL' | null;
  readonly qty: string;
  readonly price: string;
  readonly executedAt: number;
}

/**
 * `fills` MUST be ordered oldest→newest and MUST cover every fill for the mode from the start of the
 * book through `toMs` (not merely fills inside [fromMs, toMs]) — the position entering `fromMs` can
 * only be known by replaying everything that came before it.
 *
 * Returns null only for a degenerate (zero-or-negative-width) window — the caller decides what that
 * means for its own verdict. A window with valid width but zero fills folds to a legitimate 0, which
 * IS a meaningful answer (the book was flat throughout); the promotion-gate caller is responsible for
 * treating a zero result as its own fail-closed case, not this pure fold.
 */
export function timeWeightedAvgGrossExposure(
  fills: readonly GrossExposureFill[],
  fromMs: number,
  toMs: number,
): Decimal | null {
  if (toMs <= fromMs) return null;

  const positions = new Map<string, PositionState>();
  let currentGross = new Decimal(0);

  function applyAndTrackGross(f: GrossExposureFill): void {
    if (f.side === null) return;
    const prev = positions.get(f.symbol) ?? FLAT;
    const prevNotional = prev.signedQty.abs().mul(prev.avgEntry);
    const next = applyFillToPosition(
      prev,
      f.side,
      new Decimal(f.qty),
      new Decimal(f.price),
      new Decimal(0), // fees only affect realizedPnl, which this fold never reads
    );
    positions.set(f.symbol, next);
    const nextNotional = next.signedQty.abs().mul(next.avgEntry);
    currentGross = currentGross.minus(prevNotional).plus(nextNotional);
  }

  let i = 0;
  // Seed the position entering the window: fills strictly before fromMs move currentGross but
  // contribute no weighted time (the window has not started yet).
  while (i < fills.length && fills[i]!.executedAt < fromMs) {
    applyAndTrackGross(fills[i]!);
    i++;
  }

  let weightedSum = new Decimal(0);
  let cursor = fromMs;
  for (; i < fills.length && fills[i]!.executedAt < toMs; i++) {
    const f = fills[i]!;
    if (f.executedAt > cursor) {
      weightedSum = weightedSum.plus(currentGross.mul(f.executedAt - cursor));
      cursor = f.executedAt;
    }
    applyAndTrackGross(f);
  }
  // Unconditional: `cursor` only ever takes fromMs or an executedAt the loop guard already proved
  // < toMs, so toMs - cursor is always positive — the guard this replaced was a dead branch in a
  // 100%-branch zone, and mul(0) would be a no-op even if the tail were empty.
  weightedSum = weightedSum.plus(currentGross.mul(toMs - cursor));

  return weightedSum.div(toMs - fromMs);
}
