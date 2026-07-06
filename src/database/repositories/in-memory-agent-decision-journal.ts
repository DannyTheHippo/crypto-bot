import { Injectable } from '@nestjs/common';
import type {
  AgentDecisionJournalPort,
  AgentDecisionEntry,
  AgentDecisionRow,
} from '../../ports/agentic-strategy';
import type { EpochMs } from '../../domain/types/ids';

// In-process AGENT_DECISION_JOURNAL default (DB-less paper/test substrate) — a working ring
// buffer rather than a no-op, unlike SIGNAL_JOURNAL's undefined-under-no-DB binding (see
// ports/strategy.ts): reflection's read side needs a real recent() even without a database.
// Ring-capped at MAX_ROWS; oldest row evicted first. recent() ordering matches
// AgentDecisionJournalAdapter's: oldest→newest (see its header comment).
@Injectable()
export class InMemoryAgentDecisionJournal implements AgentDecisionJournalPort {
  private static readonly MAX_ROWS = 500;

  private readonly rows: AgentDecisionRow[] = [];
  private nextId = 1;

  record(entry: AgentDecisionEntry): void {
    const row: AgentDecisionRow = {
      ...entry,
      id: String(this.nextId),
      createdAt: Date.now() as EpochMs,
    };
    this.nextId += 1;
    this.rows.push(row);
    if (this.rows.length > InMemoryAgentDecisionJournal.MAX_ROWS) {
      this.rows.shift();
    }
  }

  recent(limit: number): Promise<readonly AgentDecisionRow[]> {
    // rows are stored oldest→newest already (append-only push); take the tail `limit` entries.
    return Promise.resolve(this.rows.slice(Math.max(0, this.rows.length - limit)));
  }
}
