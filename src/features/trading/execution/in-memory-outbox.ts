import { Injectable } from '@nestjs/common';
import type { ExecOutboxPort, OutboxAppend, OutboxEntry } from '../../../ports/trading/execution';

// In-process EXEC_OUTBOX default (DB-less paper, and the deterministic test substrate).
// append is idempotent on reportId; consume returns rows past max(fromCursor, lastAck);
// ack is monotone. The DB-backed adapter (app composition root) mirrors this contract.
@Injectable()
export class InMemoryExecOutbox implements ExecOutboxPort {
  private readonly rows: OutboxEntry[] = [];
  private readonly byReportId = new Map<string, number>();
  private readonly acks = new Map<string, number>();
  private cursorSeq = 0;

  append(entry: OutboxAppend): Promise<number> {
    const existing = this.byReportId.get(entry.reportId);
    if (existing !== undefined) return Promise.resolve(existing);
    this.cursorSeq += 1;
    this.rows.push({ cursor: this.cursorSeq, reportId: entry.reportId, report: entry.report });
    this.byReportId.set(entry.reportId, this.cursorSeq);
    return Promise.resolve(this.cursorSeq);
  }

  consume(consumerId: string, fromCursor: number): Promise<readonly OutboxEntry[]> {
    const acked = this.acks.get(consumerId) ?? 0;
    const effective = Math.max(fromCursor, acked);
    return Promise.resolve(this.rows.filter((r) => r.cursor > effective));
  }

  ack(consumerId: string, cursor: number): Promise<void> {
    const prev = this.acks.get(consumerId) ?? 0;
    if (cursor > prev) this.acks.set(consumerId, cursor);
    return Promise.resolve();
  }
}
