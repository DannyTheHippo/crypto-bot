import { Inject, Injectable } from '@nestjs/common';
import {
  EXEC_OUTBOX,
  EXECUTION_STORE,
  EXEC_RUN_CONTEXT,
  type ExecOutboxPort,
  type ExecutionStorePort,
  type ExecRunContext,
  type OutboxEntry,
} from '../../../ports/execution';
import {
  reduce,
  TERMINAL_ORDER_STATES,
  type OrderRecord,
  type OrderEvent,
} from '../../../domain/oms/reducer';
import type { ClientOrderId } from '../../../domain/types/ids';
import type { FillReport, FillRecord } from '../../../domain/types/exec-report';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';
import { FillIngestorService } from './fill-ingestor.service';

const TERMINAL = TERMINAL_ORDER_STATES;

// Consumes the never-drop EXEC_OUTBOX (§3.3/§6.6): read by cursor → apply → ack. A report is
// already durable before its money effects, so the apply is idempotent on redelivery — the
// fill table dedupes on venueTradeId and the order_events journal dedupes on the reportId, and
// only the durably-journaled fold is committed to the in-memory book. cumQty is recomputed
// from the running total (never trusted as a delta), matching §6.6's replay convergence.
@Injectable()
export class ExecReportConsumerService {
  private static readonly CONSUMER_ID = 'oms';
  private cursor = 0;

  constructor(
    @Inject(EXEC_OUTBOX) private readonly outbox: ExecOutboxPort,
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    @Inject(EXEC_RUN_CONTEXT) private readonly ctx: ExecRunContext,
    private readonly orders: OrderBookService,
    private readonly portfolio: PortfolioStateService,
    private readonly ingestor: FillIngestorService,
  ) {}

  // Drain all available reports. Returns the number applied. Idempotent across calls.
  async pump(): Promise<number> {
    const rows = await this.outbox.consume(ExecReportConsumerService.CONSUMER_ID, this.cursor);
    let applied = 0;
    for (const row of rows) {
      await this.apply(row); // apply BEFORE ack (durable-before-apply guarantees re-apply safety)
      await this.outbox.ack(ExecReportConsumerService.CONSUMER_ID, row.cursor);
      this.cursor = row.cursor;
      applied += 1;
    }
    return applied;
  }

  private async apply(row: OutboxEntry): Promise<void> {
    const report = row.report;
    const coid = report.clientOrderId;
    const rec = this.orders.get(coid);
    if (rec === undefined) return; // an event for an order we never created — reconciliation owns it (Phase 6)

    switch (report.kind) {
      case 'FILL':
        await this.applyFill(rec, report);
        return;
      case 'CANCEL_ACK':
        await this.foldEvent(coid, rec, report.reportId, { type: 'CANCEL_ACK' });
        return;
      case 'EXPIRE':
        await this.foldEvent(coid, rec, report.reportId, { type: 'VENUE_EXPIRED' });
        return;
      case 'REJECT':
        await this.foldEvent(coid, rec, report.reportId, { type: 'REJECT' });
        return;
      case 'ACK':
        if (rec.state === 'SUBMITTING' || rec.state === 'SUBMIT_UNKNOWN') {
          await this.foldEvent(coid, rec, report.reportId, {
            type: 'ACK',
            venueOrderId: report.venueOrderId,
          });
        } else {
          this.orders.setVenueOrderId(coid, report.venueOrderId); // redundant ack — metadata only
        }
        return;
    }
  }

  private async applyFill(rec: OrderRecord, report: FillReport): Promise<void> {
    const fill: FillRecord = {
      venue: report.venue,
      symbol: report.symbol,
      venueTradeId: report.venueTradeId,
      clientOrderId: report.clientOrderId,
      price: report.price,
      qty: report.qty,
      fee: report.fee,
      liquidity: report.liquidity,
      venueTimestamp: report.venueTimestamp,
      source: this.ctx.mode === 'paper' ? 'paper' : 'ws',
    };
    // §6.6 fill idempotency + position/equity effects are owned by the shared FillIngestor; the
    // stream reportId keys the journal fold so a redelivered report is a no-op.
    await this.ingestor.ingest(rec, fill, report.reportId);
  }

  private async foldEvent(
    coid: ClientOrderId,
    rec: OrderRecord,
    dedupeKey: string,
    event: OrderEvent,
  ): Promise<void> {
    const next = reduce(rec, event);
    const { applied } = await this.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey,
      event,
      derivedState: next.state,
      cumQty: next.cumQty.toFixed(),
    });
    if (!applied) return; // redelivered report — journal already has it, do not re-fold
    this.orders.commit(next);
    if (TERMINAL.has(next.state)) this.retire(coid);
  }

  private retire(coid: ClientOrderId): void {
    this.portfolio.clearInFlight(coid);
    this.portfolio.closeOrder(coid);
  }
}
