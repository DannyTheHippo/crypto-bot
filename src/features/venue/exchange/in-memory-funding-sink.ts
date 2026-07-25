import { Injectable } from '@nestjs/common';
import type { FundingEventPayload, FundingSinkPort } from './paper-perp.adapter';

// In-process FUNDING_SINK default (DB-less paper, and the deterministic test substrate) — mirrors
// InMemoryExecOutbox's role for EXEC_OUTBOX (../execution/in-memory-outbox.ts). A future
// Drizzle-backed adapter writing to the funding_events table (trading.schema.ts) mirrors this
// contract at the composition root.
@Injectable()
export class InMemoryFundingSink implements FundingSinkPort {
  readonly rows: FundingEventPayload[] = [];

  record(row: FundingEventPayload): Promise<void> {
    this.rows.push(row);
    return Promise.resolve();
  }
}
