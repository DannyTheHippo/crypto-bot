import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EXECUTION_STORE, type ExecutionStorePort } from '../../ports/execution';
import type { TradingMode } from '../../domain/types/mode';
import { PortfolioStateService } from './portfolio-state.service';
import { OrderBookService } from './order-book.service';
import { CrashRecoveryService } from './crash-recovery.service';

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
    for (const order of open) this.orderBook.create(order);
    const degraded = await this.crashRecovery.recoverOnBoot();
    this.log.log(
      `boot recovery: ${open.length} open order(s) seeded, ${degraded.length} degraded to *_UNKNOWN`,
    );
  }
}
