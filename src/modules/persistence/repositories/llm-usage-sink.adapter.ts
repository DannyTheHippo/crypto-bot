import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { LlmUsageSink, LlmUsageEntry } from '../../../ports/agentic-strategy';
import type * as schema from '../schema';
import { LlmUsageRepository, type LlmUsageInsert } from './llm-usage.repository';

// Composition-root binding for LLM_USAGE_SINK: persists reflection-path token usage to the llm_usage
// table. Fire-and-forget — LlmUsageSink.record is sync and this is an analysis artifact, never a
// safety interlock (mirrors AgentDecisionJournalAdapter/SignalJournalAdapter); a failed insert is
// logged, never thrown. mode is stamped here from the constructor's run context (same convention as
// SignalJournalAdapter's ExecRunContext) rather than carried on the entry — the caller (e.g.
// ReflectionService) has no natural access to the run's trading mode.
export class LlmUsageSinkAdapter implements LlmUsageSink {
  private readonly repo: LlmUsageRepository;
  private readonly log = new Logger('LlmUsageSink');

  constructor(
    db: NodePgDatabase<typeof schema>,
    private readonly mode: 'paper' | 'testnet' | 'live',
  ) {
    this.repo = new LlmUsageRepository(db);
  }

  record(entry: LlmUsageEntry): void {
    const row: LlmUsageInsert = {
      kind: entry.kind,
      model: entry.model,
      mode: this.mode,
      strategyId: entry.strategyId ?? null,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    };
    void this.repo.insert(row).catch((err: unknown) => {
      this.log.error(`llm_usage insert failed: ${String(err)}`);
    });
  }
}
