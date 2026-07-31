import { Inject, Injectable, Optional } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import { FEED_HEALTH, type FeedHealthPort } from '../../../ports/venue/market-data';
import {
  KILL_SWITCH,
  RISK_ENGINE,
  POSITION_SIZER,
  PLAN_STOP_REGISTRY,
  type KillSwitchPort,
  type RiskEnginePort,
  type PositionSizerPort,
  type PlanStopRegistryPort,
} from '../../../ports/trading/risk';
import {
  EXECUTION_GATE,
  PORTFOLIO_VIEW,
  EXEC_FILTERS,
  type ExecutionGatePort,
  type PortfolioViewPort,
  type ExecFilters,
} from '../../../ports/trading/execution';
import { EXCHANGE_PORT, type ExchangePort } from '../../../ports/venue/exchange';
import { OPS_EVENTS, type OpsEventPort } from '../../../ports/common/observability';
import { price, type Price } from '../../../domain/common/types/money';
import type { Signal } from '../../../domain/strategy/types/signal';
import type { Position } from '../../../domain/trading/types/portfolio';
import type { EpochMs, SymbolId } from '../../../domain/common/types/ids';
import { AlgoStopRecoveryService } from './algo-stop-recovery.service';

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
    // Push 3 P7f fix 7a: the perp algo-rail cancel seam, mirroring ProtectiveExitService.fire()'s
    // own @Optional PLAN_STOP_REGISTRY/EXCHANGE_PORT pair — @Optional so every pre-existing
    // direct-construction unit test keeps constructing without them. Absent (no registry wired, or
    // a spot-only deployment whose adapter lacks cancelAlgoOrder) makes the algo-cancel below a
    // no-op, byte-identical to pre-fix behavior.
    @Optional()
    @Inject(PLAN_STOP_REGISTRY)
    private readonly planStops?: PlanStopRegistryPort,
    @Optional()
    @Inject(EXCHANGE_PORT)
    private readonly exchange?: Pick<ExchangePort, 'cancelAlgoOrder'>,
    // Backlog #52: diagnostic side-channel, never a control-flow input — @Optional so every
    // pre-existing direct-construction unit test keeps constructing without it (OpsEventsModule
    // binds the real one at the composition root).
    @Optional()
    @Inject(OPS_EVENTS)
    private readonly opsEvents?: OpsEventPort,
    // 2026-07-31 stale-non-terminal-algo-stop defect: the JOURNAL seam for the algo cancels below
    // (see journalAlgoStopCanceled). Same feature folder, so this is a plain class injection — no
    // boundaries crossing. @Optional for the same reason as the pair above: every pre-existing
    // direct-construction unit test keeps constructing without it, and an unwired deployment stays
    // byte-identical to pre-fix behavior.
    @Optional()
    @Inject(AlgoStopRecoveryService)
    private readonly algoRecovery?: Pick<AlgoStopRecoveryService, 'recoverSymbol'>,
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
        this.resetEpisode(now); // RUNNING / HALTED / HALTED_DEGRADED — nothing to drive
    }
  }

  // Issue cancel-all once, then wait for the open-order set to drain (cancels confirmed) or for the
  // 10s window to lapse (orders may still be live ⇒ HALTED_DEGRADED, reconciliation keeps polling).
  private async driveHalting(now: EpochMs): Promise<void> {
    if (!this.cancelAllIssued) {
      this.cancelAllIssued = true;
      this.haltingSince = now;
      this.opsEvents?.emit({ event: 'halt.engage', reason: this.killSwitch.reason() });
      await this.cancelRestingAlgoStops(); // best-effort, WITH the regular-rail flatten below
      await this.gate.flattenAll('HALT'); // cancel every known open order
    }
    if (this.portfolio.snapshot().openOrders.length === 0) {
      this.killSwitch.confirmCancels(); // → HALTED or FLATTENING (per the flatten-requested flag)
      this.resetEpisode(now);
    } else if (this.haltingSince !== undefined && now - this.haltingSince >= CANCEL_TIMEOUT_MS) {
      this.killSwitch.cancelTimeout(); // → HALTED_DEGRADED + page
      this.resetEpisode(now);
    }
  }

  // Push 3 P7f fix 7a: a resting perp algo-rail stop (STOP_MARKET) is invisible to
  // gate.flattenAll()/portfolio.snapshot().openOrders (fix 1 keeps it off the regular-rail set by
  // design), so the HALT drain above would otherwise never touch it — stranding it resting through
  // a halt. Best-effort AWAITED cancel of every registry entry carrying an algoId, mirroring
  // ProtectiveExitService.fire()'s own algo-cancel: a failed/timed-out cancel here must NEVER block
  // the flatten (this is a risk-REDUCING drain; refusing to proceed because best-effort cleanup
  // failed would defeat its purpose). A stray resting stop left behind self-heals — its own
  // eventual fill attempt reduce-only-rejects once the flatten below empties the position (never a
  // duplicate reduction). Symbol comes from the portfolio snapshot's OWN position map (keyed by the
  // SAME positionKey the registry uses), never parsed out of the registry key string — the key's
  // symbol segment can itself contain colons (perp settle-suffix symbols, e.g. "BTC/USDT:USDT").
  private async cancelRestingAlgoStops(): Promise<void> {
    if (!this.planStops || !this.exchange?.cancelAlgoOrder) return;
    const positions = this.portfolio.snapshot().positions;
    const canceled = new Set<SymbolId>();
    for (const [key, stop] of this.planStops.entries()) {
      if (stop.algoId === undefined) continue;
      const pos = positions.get(key);
      if (pos === undefined) continue; // registry entry stale/foreign to this snapshot — no symbol to cancel against
      try {
        await this.exchange.cancelAlgoOrder(stop.algoId, pos.symbol);
        canceled.add(pos.symbol);
      } catch {
        // Fail-safe direction: proceed to the regular-rail flatten regardless — see this method's
        // own header comment.
      }
    }
    // NOT awaited — see journalAlgoStopCanceled's own header on why this seam must never sit in the
    // drain's critical path.
    for (const symbol of canceled) void this.journalAlgoStopCanceled(symbol);
  }

  // 2026-07-31 stale-non-terminal-algo-stop defect: an algo-rail cancel is invisible to the OMS (no
  // exec report ever arrives for one), so the local order row above stays non-terminal and its intent
  // stays registered in inFlightIntents (boot-recovery.service.ts). driveFlattening below reads that
  // registration as a BUSY symbol — which makes this HALT both the producer of the stranding and its
  // victim: allFlat never becomes true for that symbol, so the drain cannot complete for it. Nothing
  // heals it in between (gate.flattenAll cannot see the algo rail by design — see the caller's own
  // header; the demo poller only recovers symbols carrying an unmatched fill; the runtime's own
  // AlgoStopRecoveryService.sweep is boot-only), so absent this call it waits for the next boot.
  // recoverSymbol reads the venue's OWN algo-history rail and APPENDS the CANCELED fold — never an
  // UPDATE or DELETE, order_events is append-only (hard rule 6).
  //
  // Cleanup/measurement seam ⇒ FAILS OPEN, and here that is load-bearing rather than incidental: the
  // HALT drain is the safety path, so this is fire-and-forget (`void` at the call site), never
  // awaited and never bounded-then-awaited. recoverSymbol makes up to three venue reads per intent
  // and no ccxt timeout is configured anywhere in features/venue/exchange (the library's 10s default
  // applies per call), so awaiting it inline would let a degraded venue stall the drain for tens of
  // seconds. Every throw is swallowed here and can never reach the drain.
  //
  // Two asymmetries deliberately preserved. A failed FOLD leaves the order non-terminal
  // (foldVenueTerminal's own `if (!applied) return`), so a later sweep retries instead of this path
  // resurrecting anything. And recoverIntent reads fetchOpenAlgoOrders FIRST, returning 'none' while
  // the stop is still on the venue's open-algo set — a stale or slow read therefore fails toward
  // "still resting", so this call can never terminalize an order still live at the venue. The cost of
  // that direction: a venue that still lists the just-cancelled stop makes this pass a no-op and the
  // row waits for the boot sweep — the same place it waited before this fix, never worse.
  private async journalAlgoStopCanceled(symbol: SymbolId): Promise<void> {
    if (!this.algoRecovery) return;
    try {
      await this.algoRecovery.recoverSymbol(symbol);
    } catch {
      // FAILS OPEN — see this method's own header comment on the failure direction.
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

  private resetEpisode(now: EpochMs): void {
    // Backlog #52: only a genuine episode end is ops-event-worthy — this is also called every tick
    // while RUNNING/HALTED (default branch of tick() above), where haltingSince is already undefined.
    // The drain ends into HALTED/FLATTENING/HALTED_DEGRADED (never RUNNING), so the event carries the
    // resulting `to` state; state() is a pure non-throwing getter, safe inside the emit argument.
    if (this.haltingSince !== undefined) {
      this.opsEvents?.emit({
        event: 'halt.cancels_drained',
        durationMs: now - this.haltingSince,
        to: this.killSwitch.state(),
      });
    }
    this.cancelAllIssued = false;
    this.haltingSince = undefined;
  }
}
