import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, gt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../persistence.tokens';
import * as schema from '../schema';
import { requireDb } from './persistence-guard';

export interface OutboxReport {
  reportId: string;
  payload: unknown;
  mode: 'paper' | 'testnet' | 'live';
  runId: string;
  bootId: string;
}

export interface OutboxRow {
  cursor: number;
  reportId: string;
  payload: unknown;
}

// Advisory lock key distinct from the journal's key (arbitrary stable 64-bit value).
const OUTBOX_ADVISORY_KEY = 6_123_789_012_345_678n;

@Injectable()
export class OutboxRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  // Appends a report to the outbox under an advisory lock so IDENTITY commit-order
  // races cannot strand a row below a high-water ack cursor.
  // Single-logical-producer expectation: concurrent producers from different processes
  // are safe (the lock serialises them), but this is not designed for high-fanout.
  // reportId deduplication: duplicate calls return the existing cursor (idempotent).
  async append(report: OutboxReport): Promise<number> {
    return requireDb(this.db).transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${OUTBOX_ADVISORY_KEY}::bigint)`);

      const rows = await tx
        .insert(schema.execOutbox)
        .values(report)
        .onConflictDoNothing()
        .returning({ cursor: schema.execOutbox.cursor });

      if (rows.length === 0) {
        const existing = await tx
          .select({ cursor: schema.execOutbox.cursor })
          .from(schema.execOutbox)
          .where(eq(schema.execOutbox.reportId, report.reportId));
        return existing[0]!.cursor;
      }
      return rows[0]!.cursor;
    });
  }

  // Returns rows with cursor > effectiveCursor (max of fromCursor and last ack), ordered ascending.
  // Callers must ack after successfully applying each row (at-least-once delivery).
  // Use reportId dedupe on the consumer side to make processing idempotent.
  async consume(consumerId: string, fromCursor: number): Promise<OutboxRow[]> {
    const db = requireDb(this.db);
    const ackRow = await db
      .select()
      .from(schema.outboxConsumerAcks)
      .where(eq(schema.outboxConsumerAcks.consumerId, consumerId));

    const effectiveCursor =
      ackRow.length > 0 ? Math.max(fromCursor, ackRow[0]!.cursor) : fromCursor;

    return db
      .select({
        cursor: schema.execOutbox.cursor,
        reportId: schema.execOutbox.reportId,
        payload: schema.execOutbox.payload,
      })
      .from(schema.execOutbox)
      .where(gt(schema.execOutbox.cursor, effectiveCursor))
      .orderBy(schema.execOutbox.cursor);
  }

  // Advances the consumer's high-water cursor. Call only after the row has been
  // successfully applied (ack-after-apply contract; at-least-once + reportId dedupe).
  async ack(consumerId: string, cursor: number): Promise<void> {
    await requireDb(this.db)
      .insert(schema.outboxConsumerAcks)
      .values({ consumerId, cursor })
      .onConflictDoUpdate({
        target: schema.outboxConsumerAcks.consumerId,
        set: { cursor, ackedAt: new Date() },
      });
  }
}
