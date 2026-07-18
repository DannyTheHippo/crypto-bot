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

  recent(limit: number, strategyId?: string): Promise<readonly AgentDecisionRow[]> {
    // rows are stored oldest→newest already (append-only push); apply the optional per-strategy
    // scope (P7 — see the port's own comment), then take the tail `limit` entries.
    const scoped =
      strategyId === undefined ? this.rows : this.rows.filter((r) => r.strategyId === strategyId);
    return Promise.resolve(scoped.slice(Math.max(0, scoped.length - limit)));
  }

  recentVersioned(limit: number, sinceMs?: number): Promise<readonly AgentDecisionRow[]> {
    // Same tail-of-oldest→newest shape as recent(), over versioned rows only — see the port's
    // recentVersioned comment. "Since" honesty is bounded by the MAX_ROWS ring, like
    // versionEntryStats' lifetime below.
    const scoped = this.rows.filter(
      (r) => r.playbookVersion !== null && (sinceMs === undefined || r.eventTime >= sinceMs),
    );
    return Promise.resolve(scoped.slice(Math.max(0, scoped.length - limit)));
  }

  versionEntryStats(version: number): Promise<{ decides: number; entries: number }> {
    // "Lifetime" here is bounded by the MAX_ROWS ring — honest only within the buffer, which is
    // acceptable for the DB-less paper/test substrate this journal serves (see the port comment).
    let decides = 0;
    let entries = 0;
    for (const r of this.rows) {
      if (r.playbookVersion !== version) continue;
      if (!r.model.startsWith('claude')) continue;
      decides += 1;
      if (r.action === 'long') entries += 1;
    }
    return Promise.resolve({ decides, entries });
  }
}
