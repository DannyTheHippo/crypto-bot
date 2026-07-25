import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  EXEC_OUTBOX,
  EXECUTION_STORE,
  EXEC_RUN_CONTEXT,
  EXEC_QUALITY_SINK,
  type ExecOutboxPort,
  type ExecutionStorePort,
  type ExecRunContext,
  type OutboxEntry,
  type ExecQualitySinkPort,
} from '../../../ports/trading/execution';
import {
  reduce,
  TERMINAL_ORDER_STATES,
  type OrderRecord,
  type OrderEvent,
} from '../../../domain/trading/oms/reducer';
import type { ClientOrderId, EpochMs } from '../../../domain/common/types/ids';
import type { OrderIntent } from '../../../domain/trading/types/order-intent';
import type { FillReport, FillRecord } from '../../../domain/trading/types/exec-report';
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
  private readonly log = new Logger(ExecReportConsumerService.name);

  constructor(
    @Inject(EXEC_OUTBOX) private readonly outbox: ExecOutboxPort,
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    @Inject(EXEC_RUN_CONTEXT) private readonly ctx: ExecRunContext,
    private readonly orders: OrderBookService,
    private readonly portfolio: PortfolioStateService,
    private readonly ingestor: FillIngestorService,
    // W3 Part 1: @Optional so direct-construction unit tests (which omit it) still compile —
    // EXECUTION_MODULE itself always resolves this to at least the no-op sink (see
    // execution.module.ts's own EXEC_QUALITY_SINK provider).
    @Optional()
    @Inject(EXEC_QUALITY_SINK)
    private readonly execQualitySink?: ExecQualitySinkPort,
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
      case 'CANCEL_ACK': {
        // Captured BEFORE foldEvent: a terminal fold's retire() clears the in-flight intent this
        // exec-quality read needs (W3 Part 1) — reading it after would silently drop every cancel.
        const intent = this.portfolio.inFlightIntent(coid);
        const applied = await this.foldEvent(coid, rec, report.reportId, { type: 'CANCEL_ACK' });
        if (applied) this.recordExecQualityUnfilled(intent, rec, 'cancelled', report.eventTime);
        return;
      }
      case 'EXPIRE': {
        const intent = this.portfolio.inFlightIntent(coid);
        const applied = await this.foldEvent(coid, rec, report.reportId, {
          type: 'VENUE_EXPIRED',
        });
        if (applied) this.recordExecQualityUnfilled(intent, rec, 'expired', report.eventTime);
        return;
      }
      case 'REJECT':
        // Defect A commit-1: RejectReport carries the venue's own reason/code (exec-report.ts) —
        // thread it through so this path is no less informative than execution-gate's own REJECT
        // fold. No production source constructs a RejectReport today (WS user-stream REJECT is a
        // deferred follow-up), so this is currently exercised only by direct unit construction.
        await this.foldEvent(
          coid,
          rec,
          report.reportId,
          { type: 'REJECT', code: report.code, message: report.reason },
          report.code !== undefined ? `${report.code}:${report.reason}` : report.reason,
        );
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

  // Returns whether the fold actually applied (false on a redelivered/already-journaled report) —
  // callers that layer a read-side effect (W3 Part 1's exec-quality fan-out) on top of a terminal
  // fold gate on this so a redelivery never double-records.
  private async foldEvent(
    coid: ClientOrderId,
    rec: OrderRecord,
    dedupeKey: string,
    event: OrderEvent,
    reason?: string,
  ): Promise<boolean> {
    const next = reduce(rec, event);
    const { applied } = await this.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey,
      event,
      derivedState: next.state,
      cumQty: next.cumQty.toFixed(),
      ...(reason !== undefined ? { reason } : {}),
    });
    if (!applied) return false; // redelivered report — journal already has it, do not re-fold
    this.orders.commit(next);
    if (TERMINAL.has(next.state)) this.retire(coid);
    return true;
  }

  private retire(coid: ClientOrderId): void {
    this.portfolio.clearInFlight(coid);
    this.portfolio.closeOrder(coid);
  }

  // W3 Part 1 (measurement path, fails OPEN): the 'expired'/'cancelled' half of ExecQualityOutcome.
  // Only a NEVER-FILLED entry attempt qualifies (rec.cumQty, read BEFORE this event folds, must be
  // zero) — a partial fill then cancel already fed its own 'filled' signal via FillIngestor's
  // recordExecQualityFill, and ExecQualityEntryAttempt has no partial-fill shape to layer a second
  // one onto. style is hardcoded 'maker': a taker (MARKET) order fills-or-rejects immediately and
  // never reaches this path unfilled (exec-quality.service.ts's own DTO comment), so only
  // LIMIT/LIMIT_MAKER intents are eligible.
  private recordExecQualityUnfilled(
    intent: OrderIntent | undefined,
    rec: OrderRecord,
    outcome: 'cancelled' | 'expired',
    terminalAt: EpochMs,
  ): void {
    if (this.execQualitySink === undefined || intent === undefined) return;
    if (
      intent.reduceOnly ||
      !rec.cumQty.isZero() ||
      (intent.type !== 'LIMIT' && intent.type !== 'LIMIT_MAKER') ||
      intent.limitPrice === undefined
    ) {
      return;
    }
    try {
      this.execQualitySink.recordEntryAttempt({
        symbol: intent.symbol,
        side: intent.side === 'BUY' ? 'long' : 'short',
        style: 'maker',
        limitPrice: intent.limitPrice.toFixed(),
        outcome,
        terminalAt,
      });
    } catch (err) {
      this.log.warn(
        `exec-quality fan-out failed (${outcome}), omitting: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
