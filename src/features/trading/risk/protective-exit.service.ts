import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { FEED_HEALTH, type FeedHealthPort } from '../../../ports/market-data';
import {
  KILL_SWITCH,
  PROTECTIVE_EXIT_CONFIG,
  type KillSwitchPort,
  type ProtectiveExitConfig,
} from '../../../ports/risk';
import { PORTFOLIO_VIEW, type PortfolioViewPort } from '../../../ports/execution';
import { SIGNAL_SINK, type SignalSinkPort } from '../../../ports/strategy';
import type { Signal } from '../../../domain/types/signal';
import type { Position } from '../../../domain/types/portfolio';
import type { EpochMs } from '../../../domain/types/ids';

type ProtectReason = 'STOP_LOSS' | 'TRAILING_STOP';

// §S3 bot-enforced protective backstop for the agentic (LLM) lane, which decides only on closed
// candles and can go dark (budget-blocked, degraded, outage) — this service fires an EXIT_LONG or
// EXIT_SHORT Signal through the FULL Strategy→Risk→Execution chokepoint (CLAUDE.md rule 2: never
// bypass risk; it never touches execution/the adapter directly, only SIGNAL_SINK).
// @Optional injection so the directly-constructed unit tests cover the metric-absent branch.
export const PROTECTIVE_EXITS_COUNTER = makeCounterProvider({
  name: 'protective_exits_total',
  help: 'Bot-enforced protective exits fired (stop-loss/trailing-stop), by reason',
  labelNames: ['reason'] as const,
});

@Injectable()
export class ProtectiveExitService {
  // High-water mark per LONG position key (positionKey(strategyId, venue, symbol) — see
  // domain/risk/evaluate.ts). Seeded at max(avgEntry, ref) the first tick a position is seen: BOOT
  // AMNESIA IS ACCEPTED — after a process restart this map is empty, so trailing protection re-arms
  // from max(entry, current) rather than the pre-restart peak. A real trailing stop that had already
  // ratcheted above that point loses its prior peak on restart; this is a deliberate simplicity
  // trade-off (no persistence for this map), not an oversight.
  private readonly hwm = new Map<string, Decimal>();
  // Low-water mark per SHORT position key — the mirror of hwm: seeded at min(avgEntry, ref) and
  // ratchets DOWN as price falls in the short's favor, never back up. Same boot-amnesia trade-off.
  private readonly lwm = new Map<string, Decimal>();
  private readonly lastFiredAt = new Map<string, EpochMs>();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    @Inject(FEED_HEALTH) private readonly feed: FeedHealthPort,
    @Inject(PORTFOLIO_VIEW) private readonly portfolio: PortfolioViewPort,
    @Inject(SIGNAL_SINK) private readonly sink: SignalSinkPort,
    @Inject(PROTECTIVE_EXIT_CONFIG) private readonly config: ProtectiveExitConfig,
    @Optional() @InjectMetric('protective_exits_total') private readonly exits?: Counter<string>,
  ) {}

  async tick(now: EpochMs): Promise<void> {
    const stopLossPct = new Decimal(this.config.stopLossPct);
    const trailingPct = new Decimal(this.config.trailingPct);
    if (stopLossPct.lte(0) && trailingPct.lte(0)) return; // inert — both knobs disabled

    if (this.killSwitch.state() !== 'RUNNING') return; // HALTING/FLATTENING belongs to HaltCoordinator

    const snapshot = this.portfolio.snapshot();
    // Push II Phase 8: split by RAW order side (not a pre-decided busy/sellOpen split) — which side
    // is "the unfilled entry" (stacking guard) vs "the venue take-profit" (cancel-before-exit, never
    // blocking) depends on the POSITION's own direction, resolved per-position below. A LONG's entry
    // is a resting BUY and its TP is a resting SELL; a SHORT's entry is a resting SELL and its TP is
    // a resting BUY — mirrored. An in-flight submission (either side) always stacks a slice
    // regardless of direction.
    const buyOpen = new Set<string>();
    const sellOpen = new Set<string>();
    for (const o of snapshot.openOrders) {
      (o.side === 'BUY' ? buyOpen : sellOpen).add(o.symbol);
    }
    const inFlightSymbols = new Set<string>();
    for (const f of snapshot.inFlightIntents) inFlightSymbols.add(f.symbol);

    const liveKeys = new Set<string>();
    for (const [key, pos] of snapshot.positions) {
      if (pos.signedQty.isZero()) continue; // flat; nothing to protect
      const isLong = pos.signedQty.gt(0);
      liveKeys.add(key);

      if (this.isDust(pos)) continue;

      const ref = this.feed.getRefPrice(pos.symbol);
      if (ref === undefined) continue; // cannot price this tick — retry next tick

      // A sign flip reusing the same key changes direction — drop the stale opposite-direction
      // watermark so the newly-opened side reseeds fresh rather than trailing off a peak/trough
      // that belonged to the position it just replaced. The cooldown stamp belonged to that
      // replaced position too: Map.delete returning true IS the flip signal, and dropping
      // lastFiredAt with it means a fresh open gets its first protective exit immediately
      // (per-position cooldown, consistent with the watermark reseed) rather than being
      // suppressed for up to cooldownMs by the prior side's fire.
      const extremeMap = isLong ? this.hwm : this.lwm;
      if ((isLong ? this.lwm : this.hwm).delete(key)) {
        this.lastFiredAt.delete(key);
      }

      const seeded = extremeMap.get(key);
      const extreme = isLong
        ? seeded === undefined
          ? Decimal.max(pos.avgEntry, ref.mid)
          : Decimal.max(seeded, ref.mid)
        : seeded === undefined
          ? Decimal.min(pos.avgEntry, ref.mid)
          : Decimal.min(seeded, ref.mid);
      extremeMap.set(key, extreme);

      // Long: stop fires below entry, trailing fires below the ratcheted peak. Short: inverted —
      // stop fires above entry, trailing fires above the ratcheted trough.
      const stopTriggered = isLong
        ? stopLossPct.gt(0) && ref.mid.lte(pos.avgEntry.mul(new Decimal(1).sub(stopLossPct)))
        : stopLossPct.gt(0) && ref.mid.gte(pos.avgEntry.mul(new Decimal(1).add(stopLossPct)));
      const trailTriggered = isLong
        ? trailingPct.gt(0) && ref.mid.lte(extreme.mul(new Decimal(1).sub(trailingPct)))
        : trailingPct.gt(0) && ref.mid.gte(extreme.mul(new Decimal(1).add(trailingPct)));
      if (!stopTriggered && !trailTriggered) continue;
      const reason: ProtectReason = stopTriggered ? 'STOP_LOSS' : 'TRAILING_STOP';

      // Direction-aware STACKING GUARD (Push II Phase 8): the entry-blocking side is BUY for a
      // LONG, SELL for a SHORT — mirrored. An in-flight submission (either side) always blocks,
      // regardless of direction.
      const entryBusy =
        (isLong ? buyOpen : sellOpen).has(pos.symbol) || inFlightSymbols.has(pos.symbol);
      if (entryBusy) continue; // STACKING GUARD: a slice is already working this symbol

      const lastFired = this.lastFiredAt.get(key);
      if (lastFired !== undefined && now - lastFired < this.config.cooldownMs) continue;

      // The venue take-profit side is the OPPOSITE of the entry side — SELL for a LONG, BUY for a
      // SHORT — never blocking (fire() cancels it first when present).
      const hasOpenTp = (isLong ? sellOpen : buyOpen).has(pos.symbol);
      await this.fire(pos, ref.mid, now, reason, key, snapshot.snapshotSeq, isLong, hasOpenTp);
    }

    // Cleanup: drop HWM/LWM/cooldown state for symbols that no longer carry a position, so a later
    // re-entry seeds a fresh peak/trough rather than reusing the old one.
    for (const key of this.hwm.keys()) {
      if (!liveKeys.has(key)) this.hwm.delete(key);
    }
    for (const key of this.lwm.keys()) {
      if (!liveKeys.has(key)) this.lwm.delete(key);
    }
    for (const key of this.lastFiredAt.keys()) {
      if (!liveKeys.has(key)) this.lastFiredAt.delete(key);
    }
  }

  private async fire(
    pos: Position,
    mid: Signal['refPrice'],
    now: EpochMs,
    reason: ProtectReason,
    key: string,
    snapshotSeq: bigint,
    isLong: boolean,
    hasOpenTp: boolean,
  ): Promise<void> {
    const signal: Signal = {
      strategyId: pos.strategyId,
      venue: pos.venue,
      symbol: pos.symbol,
      kind: isLong ? 'EXIT_LONG' : 'EXIT_SHORT',
      strength: 1,
      refPrice: mid,
      basedOnSeq: snapshotSeq,
      eventTime: now,
      ttlMs: 60_000,
      dedupeKey: `protect:${reason}:${pos.symbol}:${now}`,
      reason,
    };
    // Push II Phase 8: the venue take-profit side mirrors direction — SELL for a LONG, BUY (cover)
    // for a SHORT.
    const tpSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
    try {
      if (hasOpenTp) {
        // A resting TP order locks the base balance (spot LONG) or margin (SHORT cover) — a
        // full-size exit would otherwise be rejected. Cancel it and await the ack before submitting
        // the exit.
        await this.sink.recordSignal({
          strategyId: pos.strategyId,
          venue: pos.venue,
          symbol: pos.symbol,
          kind: 'CANCEL_OPEN',
          cancelSide: tpSide,
          strength: 1,
          refPrice: mid,
          basedOnSeq: snapshotSeq,
          eventTime: now,
          ttlMs: 60_000,
          dedupeKey: `protect:cancel_${tpSide.toLowerCase()}:${pos.symbol}:${now}`,
          reason: `${reason}: clear resting ${tpSide} before protective exit`,
        });
      }
      await this.sink.recordSignal(signal);
    } catch {
      return; // sink failure must not crash the tick — retries next tick, no lastFiredAt update
    }
    this.lastFiredAt.set(key, now);
    this.exits?.inc({ reason });
  }

  private isDust(pos: Position): boolean {
    const filters = this.config.filters.get(pos.symbol);
    if (!filters) return false; // no filter entry ⇒ protect anyway (never silently skip)
    const ref = this.feed.getRefPrice(pos.symbol);
    const qty = pos.signedQty.abs();
    if (qty.lt(new Decimal(filters.minQty))) return true;
    if (ref !== undefined && qty.mul(ref.mid).lt(new Decimal(filters.minNotional))) return true;
    return false;
  }
}
