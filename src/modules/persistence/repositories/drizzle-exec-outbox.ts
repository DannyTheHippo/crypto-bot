import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ExecOutboxPort, OutboxAppend, OutboxEntry, ExecRunContext } from '../../../ports/execution';
import type * as schema from '../schema';
import { OutboxRepository } from './outbox.repository';

// Thin adapter: wraps OutboxRepository to satisfy ExecOutboxPort.
// The repo stores ExecReport as `payload: unknown` alongside mode/runId/bootId from run context.
// consume returns rows with `payload` field; we rehydrate as `report` for the port contract.
export class DrizzleExecOutbox implements ExecOutboxPort {
  private readonly repo: OutboxRepository;

  constructor(
    db: NodePgDatabase<typeof schema>,
    private readonly ctx: ExecRunContext,
  ) {
    this.repo = new OutboxRepository(db);
  }

  async append(entry: OutboxAppend): Promise<number> {
    return this.repo.append({
      reportId: entry.reportId,
      payload: entry.report,
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    });
  }

  async consume(consumerId: string, fromCursor: number): Promise<readonly OutboxEntry[]> {
    const rows = await this.repo.consume(consumerId, fromCursor);
    return rows.map((r) => ({
      cursor: r.cursor,
      reportId: r.reportId,
      report: r.payload as OutboxEntry['report'],
    }));
  }

  ack(consumerId: string, cursor: number): Promise<void> {
    return this.repo.ack(consumerId, cursor);
  }
}
