import { Injectable } from '@nestjs/common';
import type { FundingEventPayload, FundingSinkPort } from './paper-perp.adapter';

// In-process FUNDING_SINK for the DB-less/test substrate — mirrors InMemoryExecOutbox's role for
// EXEC_OUTBOX (../execution/in-memory-outbox.ts). No longer the production binding: with a database
// present the composition root binds FundingEventsRepository (the funding_events writer) instead
// (exchange-adapters.module.ts's buildFundingSink).
@Injectable()
export class InMemoryFundingSink implements FundingSinkPort {
  readonly rows: FundingEventPayload[] = [];

  record(row: FundingEventPayload): Promise<void> {
    this.rows.push(row);
    return Promise.resolve();
  }
}
