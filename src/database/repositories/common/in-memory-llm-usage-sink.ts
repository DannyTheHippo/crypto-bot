import { Injectable } from '@nestjs/common';
import type { LlmUsageSink, LlmUsageEntry } from '../../ports/agentic-strategy';

// In-process LLM_USAGE_SINK default (DB-less paper/test substrate) — array-backed rather than a bare
// no-op (mirrors InMemoryAgentDecisionJournal's own convention) so isolated-module tests can assert
// what was recorded without a database. Unlike AGENT_DECISION_JOURNAL, nothing reads this back at
// runtime — it exists purely for offline analysis and test observability — so there is no ring cap or
// recent() query surface, just append + a plain accessor.
@Injectable()
export class InMemoryLlmUsageSink implements LlmUsageSink {
  private readonly rows: LlmUsageEntry[] = [];

  record(entry: LlmUsageEntry): void {
    this.rows.push(entry);
  }

  all(): readonly LlmUsageEntry[] {
    return this.rows;
  }
}
