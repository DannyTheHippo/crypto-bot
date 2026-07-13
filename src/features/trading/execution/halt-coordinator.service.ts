import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { FEED_HEALTH, type FeedHealthPort } from '../../../ports/market-data';
import {
  KILL_SWITCH,
  RISK_ENGINE,
  POSITION_SIZER,
  type KillSwitchPort,
  type RiskEnginePort,
  type PositionSizerPort,
} from '../../../ports/risk';
import {
  EXECUTION_GATE,
  PORTFOLIO_VIEW,
  EXEC_FILTERS,
  type ExecutionGatePort,
  type PortfolioViewPort,
  type ExecFilters,
} from '../../../ports/execution';
import { price, type Price } from '../../../domain/types/money';
import type { Signal } from '../../../domain/types/signal';
import type { Position } from '../../../domain/types/portfolio';
import type { EpochMs } from '../../../domain/types/ids';

const CANCEL_TIMEOUT_MS = 10_000; // §5: cancels unconfirmed in 10s ⇒ HALTED_DEGRADED
const FLATTEN_TTL_MS = 60_000;
// Marketable hint 2% through the touch on the position's OWN exit side: below mark for a long's
// SELL, ABOVE mark for a short's BUY cover (review finding: a direction-blind 0.98 factor priced
// short covers on the passive side, and with an operator-widened RISK_MAX_BAND_BPS >= 200 the
// flatten clamp would never repair it — an IOC BUY below mark fills nothing and FLATTENING never
// converges). For the default 1% band both directions are out-of-band, so evaluate's flatten
// PRICE_BAND clamp reprices to the exact edge. Kept near mark (not e.g. 0.5) so the sizer's
// minNotional check isn't falsely tripped on small lots.
const MARKETABLE_FACTOR_SELL = '0.98';
const MARKETABLE_FACTOR_BUY_COVER = '1.02';

// Per-position flatten outcome. UNFLATTENABLE (below the exchange minimum at the venue, or risk
// rejects the clamped slice) is residual dust that can never be sold — it counts toward ALL_FLAT so
// FLATTENING converges. DEFER (no mark this tick) does NOT, so it is retried.
type FlattenOutcome = 'FIRED' | 'DEFER' | 'UNFLATTENABLE';

// §5 HALTING/FLATTENING coordinator. Driven by the kill switch state (never the reverse). The
// cardinal safety property is the STACKING GUARD: a flatten slice fires for a symbol only when it
// has no open or in-flight order, the flatten analog of the OMS's never-blind-resubmit rule —
// otherwise each tick would stack another reduce-only order before the prior slice filled, working
// multiples of the intended exposure. The guard also makes slicing self-sequencing: a slice fills
// → retires from openOrders → the next tick fires the next slice against the now-smaller position.
// All cross-module access is through ports (no modules→modules). Time is explicit: tick(now) reads
// the clock, the cron wrapper is a thin untested caller.
@Injectable()
export class HaltCoordinatorService {
  private cancelAllIssued = false;
  private haltingSince: EpochMs | undefined;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    @Inject(EXECUTION_GATE) private readonly gate: ExecutionGatePort,
    @Inject(PORTFOLIO_VIEW) private readonly portfolio: PortfolioViewPort,
    @Inject(RISK_ENGINE) private readonly engine: RiskEnginePort,
    @Inject(POSITION_SIZER) private readonly sizer: PositionSizerPort,
    @Inject(FEED_HEALTH) private readonly feed: FeedHealthPort,
    @Inject(EXEC_FILTERS) private readonly filters: ExecFilters,
  ) {}

  async tick(now: EpochMs): Promise<void> {
    switch (this.killSwitch.state()) {
      case 'HALTING':
        await this.driveHalting(now);
        return;
      case 'FLATTENING':
        await this.driveFlattening(now);
        return;
      default:
        this.resetEpisode(); // RUNNING / HALTED / HALTED_DEGRADED — nothing to drive
    }
  }

  // Issue cancel-all once, then wait for the open-order set to drain (cancels confirmed) or for the
  // 10s window to lapse (orders may still be live ⇒ HALTED_DEGRADED, reconciliation keeps polling).
  private async driveHalting(now: EpochMs): Promise<void> {
    if (!this.cancelAllIssued) {
      this.cancelAllIssued = true;
      this.haltingSince = now;
      await this.gate.flattenAll('HALT'); // cancel every known open order
    }
    if (this.portfolio.snapshot().openOrders.length === 0) {
      this.killSwitch.confirmCancels(); // → HALTED or FLATTENING (per the flatten-requested flag)
      this.resetEpisode();
    } else if (this.haltingSince !== undefined && now - this.haltingSince >= CANCEL_TIMEOUT_MS) {
      this.killSwitch.cancelTimeout(); // → HALTED_DEGRADED + page
      this.resetEpisode();
    }
  }

  // Fire one marketable reduce-only flatten slice per non-flat, non-busy position; declare ALL_FLAT
  // once every position is dust (< exchange minQty).
  private async driveFlattening(now: EpochMs): Promise<void> {
    const snap = this.portfolio.snapshot();
    const busy = new Set<string>();
    for (const o of snap.openOrders) busy.add(o.symbol);
    for (const f of snap.inFlightIntents) busy.add(f.symbol);

    let allFlat = true;
    for (const pos of snap.positions.values()) {
      if (this.isDust(pos)) continue; // already flat by qty for ALL_FLAT purposes
      if (busy.has(pos.symbol)) {
        allFlat = false;
        continue;
      } // STACKING GUARD: a slice is working this symbol
      const outcome = await this.fireFlatten(pos, now, snap.snapshotSeq);
      if (outcome !== 'UNFLATTENABLE') allFlat = false; // FIRED/DEFER ⇒ live qty still to clear
    }
    if (allFlat) this.killSwitch.allFlat(); // → HALTED
  }

  private async fireFlatten(pos: Position, now: EpochMs, seq: bigint): Promise<FlattenOutcome> {
    const ref = this.feed.getRefPrice(pos.symbol);
    if (ref === undefined) return 'DEFER'; // cannot price the slice this tick — retry next tick
    const signal = this.flattenSignal(pos, ref.mid, now, seq);
    const sized = this.sizer.size(signal, this.portfolio.snapshot());
    if (!sized.ok) return 'UNFLATTENABLE'; // below the venue minimum — residual dust, counts as flat
    const decision = this.engine.evaluateFlatten(sized.intent, this.portfolio.snapshot());
    if (decision.verdict === 'APPROVED' || decision.verdict === 'RESIZED') {
      await this.gate.submit(decision.approved);
      return 'FIRED';
    }
    return 'UNFLATTENABLE'; // risk rejected the clamped slice (below exchange min) — residual dust
  }

  private flattenSignal(pos: Position, mark: Price, now: EpochMs, seq: bigint): Signal {
    return {
      strategyId: pos.strategyId,
      venue: pos.venue,
      symbol: pos.symbol,
      kind: 'FLATTEN',
      strength: 1,
      // Short positions flatten via a BUY cover that must cross UP — orient the marketable hint by
      // the position's sign. Clamped to the band edge by evaluate either way.
      limitPriceHint: price(
        mark.mul(pos.signedQty.isNegative() ? MARKETABLE_FACTOR_BUY_COVER : MARKETABLE_FACTOR_SELL),
      ),
      refPrice: mark,
      basedOnSeq: seq,
      eventTime: now,
      ttlMs: FLATTEN_TTL_MS,
      dedupeKey: `flatten:${pos.symbol}:${now}`,
      reason: 'KILL_SWITCH_FLATTEN',
    };
  }

  private isDust(pos: Position): boolean {
    const minQty = this.filters.get(pos.symbol)?.minQty ?? '0';
    return pos.signedQty.abs().lt(new Decimal(minQty));
  }

  private resetEpisode(): void {
    this.cancelAllIssued = false;
    this.haltingSince = undefined;
  }
}
