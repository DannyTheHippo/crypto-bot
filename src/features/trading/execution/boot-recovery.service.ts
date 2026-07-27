import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EXECUTION_STORE, type ExecutionStorePort } from '../../../ports/trading/execution';
import type { TradingMode } from '../../../domain/trading/types/mode';
import {
  reduce,
  TERMINAL_ORDER_STATES,
  type OrderRecord,
  type OrderState,
} from '../../../domain/trading/oms/reducer';
import { isAlgoRailIntent } from '../../../domain/trading/oms/reconcile';
import { PortfolioStateService } from './portfolio-state.service';
import { OrderBookService } from './order-book.service';
import { CrashRecoveryService } from './crash-recovery.service';
import { isUnresolved } from '../../../domain/trading/oms/recovery';

// States with a venue ack behind them: the order may genuinely rest venue-side, so it belongs in
// the portfolio open set where reconciliation adopts venue truth for it and the stale-entry sweep
// can see it (before 2026-07-07 recovered orders entered only the order book and were invisible
// to both — a stranded CANCEL_PENDING and 57 unsweepable zombies). NEW/SUBMITTING/SUBMIT_UNKNOWN
// rows never confirmed landing — registering them would turn every reconcile pass into
// fetchOrder-not-found mismatch noise — and RECONCILE_REQUIRED is frozen, operator-owned.
const VENUE_CONFIRMED_OPEN: ReadonlySet<OrderState> = new Set([
  'ACKED',
  'PARTIALLY_FILLED',
  'CANCEL_PENDING',
  'CANCEL_UNKNOWN',
]);

// Boot recovery (§4.2). On a real (DB-backed) boot this restores the reduced portfolio snapshot —
// cash, equity, peak, start-of-day anchor and open positions — from Postgres so P/L spans restarts,
// then seeds the OrderBook projection with the persisted non-terminal orders and runs crash recovery
// so the query loop + a reconciliation pass establish venue truth before trading resumes (without
// the seed, recoverOnBoot reads an empty book and degrades nothing — the bug this closes).
//
// Snapshot-restore, NOT fill-replay: re-folding fills onto starting cash would double-count cash
// across boots. Fills are deliberately NOT reloaded — idempotent saveFill on
// (venue, symbol, venue_trade_id) already prevents double-ingest when the poller re-fetches after a
// restart. Recovery is scoped by mode only (run_id/boot_id are per-boot), so P/L carries across runs.
// In paper / no-DB the in-memory store returns an empty snapshot, making this an inexpensive no-op.
@Injectable()
export class BootRecoveryService {
  private readonly log = new Logger('BootRecovery');

  constructor(
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    private readonly portfolio: PortfolioStateService,
    private readonly orderBook: OrderBookService,
    private readonly crashRecovery: CrashRecoveryService,
  ) {}

  async recoverOnBoot(mode: TradingMode): Promise<void> {
    const snap = await this.store.loadRecoverySnapshot(mode);
    if (snap.latest !== null) {
      // sodEquity has no dedicated column; it is the equity of the first sample of the latest row's
      // UTC session. If the bot was down across the UTC-midnight rollover there is no sample for the
      // new day yet, so the anchor falls back to restored equity — day-P/L resets at that restart,
      // which is acceptable.
      const sodEquity =
        snap.sodEquity !== null ? new Decimal(snap.sodEquity) : new Decimal(snap.latest.equity);
      this.portfolio.restoreFromSnapshot({
        cash: new Decimal(snap.latest.cash),
        equity: new Decimal(snap.latest.equity),
        peak: new Decimal(snap.latest.peak),
        sodEquity,
        positions: snap.positions,
      });
      this.log.log(
        `restored portfolio: equity=${snap.latest.equity} cash=${snap.latest.cash} positions=${snap.positions.length}`,
      );
    }

    const open = await this.store.loadOpenOrders(mode);
    let registered = 0;
    let rebuilt = 0;
    let rehydrated = 0;
    for (const o of open) {
      const record = await this.rebuildCumFromFills(o.record);
      if (record !== o.record) rebuilt += 1;
      this.orderBook.create(record);
      // A rebuild can land the record terminal (the fill table already held full qty — the
      // 2026-07-11 stranded RECONCILE_REQUIRED order) — terminal orders never register open.
      if (TERMINAL_ORDER_STATES.has(record.state)) continue;
      if (VENUE_CONFIRMED_OPEN.has(record.state)) {
        // Push 3 P7f fix 3: mirrors execution-gate.service.ts's own fix 1 (same isAlgoRailIntent
        // predicate) — a crash-recovered algo-rail order must not resurrect into the regular
        // open-orders set either, or it pollutes CANCEL_OPEN's target scan and reconciliation's
        // venue-truth sweep exactly like a freshly-placed one would (fix 1's own comment explains
        // the false CANCEL_UNKNOWN → RECONCILE_REQUIRED freeze this prevents). Classifiable only
        // off the recovered INTENT (triggerPrice + venue) — the persisted OpenOrderSummary alone
        // carries neither, so a null intent (row missing/corrupt) falls back to the pre-fix
        // behavior: register it regular-rail rather than silently drop it from both. The algo
        // rail's own boot truth lives in AgenticStrategy's plan-stop registry (re-armed from the
        // model's next 'hold'+plan proposal) plus manageVenueStopPerp's fetchOpenAlgoOrders
        // reconcile scan and HaltCoordinatorService's own registry sweep (Push 3 P7f fix 7) — never
        // here, which only ever restores the regular-rail book.
        const algoRail = o.intent !== null && isAlgoRailIntent(o.intent);
        if (!algoRail) {
          this.portfolio.openOrder(o.strategyId, o.summary);
          registered += 1;
        }
      }
      // Restore the write-ahead intent alongside the order (the persisted pair, §6.2) regardless of
      // rail: fill application, the unknown-resolver's query loop (both rails, fix 2), and Risk's E1
      // in-flight clamp all read the in-memory intent — recovering the order without it left later
      // fills journaled but never applied to position/cash (2026-07-11: an unmanaged 6.9-LINK
      // position).
      //
      // 2026-07-27: widened from VENUE_CONFIRMED_OPEN alone to also cover the UNRESOLVED states.
      // That gate answers "does this belong in the portfolio OPEN-ORDERS set" — a different question
      // from "should its intent be restored" — and fusing the two silently dropped the intent for
      // every RECONCILE_REQUIRED / SUBMIT_UNKNOWN row across a restart. Two live-observed
      // consequences: unknown-resolver's re-query pass reads the symbol off the intent, so a frozen
      // order became permanently un-adoptable after a restart ("no in-flight intent, staying
      // frozen"); and freeze()'s own promise that "the in-flight intent stays, reserving worst-case
      // exposure" silently stopped holding, un-reserving that exposure from Risk's E1 clamp.
      // Restoring it is the fail-CLOSED direction (exposure counted, not forgotten).
      // NEW/SUBMITTING stay excluded deliberately — those never confirmed landing at the venue, so
      // reserving capital for an order that may never exist is the wrong direction. The open-orders
      // registration above is left gated exactly as before, so reconciliation's UNKNOWN_OURS
      // classification is untouched.
      if (
        o.intent !== null &&
        (VENUE_CONFIRMED_OPEN.has(record.state) || isUnresolved(record.state))
      ) {
        this.portfolio.addInFlight(o.intent);
        rehydrated += 1;
      }
    }
    const degraded = await this.crashRecovery.recoverOnBoot();
    this.log.log(
      `boot recovery: ${open.length} open order(s) seeded (${registered} registered open, ` +
        `${rehydrated} intent(s) rehydrated, ${rebuilt} cum rebuilt from fills), ` +
        `${degraded.length} degraded to *_UNKNOWN`,
    );
  }

  // Rebuild the reducer cum from the idempotent fill journal when the persisted derived state
  // lags it — the fill table is the authoritative source ("cumQty is rebuilt from the fill
  // table, never the venue's running field"). Folded through the reducer and journaled like any
  // other FILL (idempotent dedupe key carries the rebuilt total), so a full-qty rebuild
  // terminalizes the order and stamps terminal_at at the store chokepoint. NEW never accepts a
  // FILL — a NEW row with journaled fills is corruption; log loudly and leave it frozen rather
  // than throw the whole boot away.
  private async rebuildCumFromFills(record: OrderRecord): Promise<OrderRecord> {
    const tableCum = new Decimal(await this.store.loadFilledQty(record.clientOrderId));
    if (!tableCum.gt(record.cumQty)) return record;
    if (record.state === 'NEW') {
      this.log.error(
        `boot recovery: NEW order ${record.clientOrderId} has ${tableCum.toFixed()} filled in the journal — corrupt row left untouched`,
      );
      return record;
    }
    let next: OrderRecord;
    try {
      next = reduce(record, { type: 'FILL', cumQty: tableCum });
    } catch (err) {
      // I4 overflow (journal holds more than the order's qty) or another illegal fold: bounded
      // to this one order — log loudly and leave the persisted state untouched rather than
      // crash-loop the boot under the compose restart policy. Nothing trades on a stuck order.
      this.log.error(
        `boot recovery: cum rebuild for ${record.clientOrderId} refused by the reducer (${String(err)}) — row left untouched`,
      );
      return record;
    }
    const { applied } = await this.store.appendOrderEvent({
      clientOrderId: record.clientOrderId,
      dedupeKey: `boot:cum-rebuild:${tableCum.toFixed()}`,
      event: { type: 'FILL', cumQty: tableCum },
      derivedState: next.state,
      cumQty: next.cumQty.toFixed(),
      venueOrderId: next.venueOrderId,
    });
    // applied:false = the dedupe key was journaled by a prior boot. That prior boot may have
    // crashed BETWEEN the journal insert and the orders-row cache update (appendOrderEvent is
    // non-atomic), leaving the persisted row stale forever — so the healed record is returned
    // on BOTH paths; the in-memory book (which hasUnresolvedOrders/arming reads) is correct
    // every boot even if the row cache never catches up.
    this.log.warn(
      `boot recovery: rebuilt cum for ${record.clientOrderId} from the fill journal — ` +
        `${record.cumQty.toFixed()} → ${tableCum.toFixed()} (${record.state} → ${next.state})` +
        (applied ? '' : ' [journal already held the rebuild — row cache was stale]'),
    );
    return next;
  }
}
