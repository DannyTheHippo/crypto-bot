import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  AgentDecisionJournalPort,
  AgentDecisionEntry,
  AgentDecisionRow,
} from '../../ports/agentic-strategy';
import type { StrategyId, VenueId, SymbolId, EpochMs } from '../../domain/types/ids';
import type * as schema from '../schemas/trading';
import { AgentDecisionRepository, type AgentDecisionInsert } from './agent-decision.repository';

// Composition-root binding for AGENT_DECISION_JOURNAL: persists every agentic-lane decision to
// agent_decisions for offline analysis — mirrors SignalJournalAdapter's conventions (see
// signal-journal.adapter.ts): record is sync fire-and-forget, an analysis artifact rather than a
// safety interlock (Risk still sizes/vetoes every proposed Signal — CLAUDE.md rules 2/4), and a
// failed insert is logged, never thrown, so journaling can never break the decide() path.
//
// recent() ordering: oldest→newest (ascending event_time), matching AgentContext.recentDecisions'
// documented "newest-last" convention (see ports/agentic-strategy.ts) — a caller folding persisted
// rows into that in-memory trail sees the same chronological order from either source.
export class AgentDecisionJournalAdapter implements AgentDecisionJournalPort {
  private readonly repo: AgentDecisionRepository;
  private readonly log = new Logger('AgentDecisionJournal');

  constructor(db: NodePgDatabase<typeof schema>) {
    this.repo = new AgentDecisionRepository(db);
  }

  record(entry: AgentDecisionEntry): void {
    const row: AgentDecisionInsert = {
      strategyId: entry.strategyId,
      symbol: entry.symbol,
      venue: entry.venue,
      triggerKind: entry.triggerKind,
      basedOnSeq: entry.basedOnSeq,
      eventTime: entry.eventTime,
      model: entry.model,
      action: entry.action,
      confidence: entry.confidence,
      rationale: entry.rationale,
      refPrice: entry.refPrice,
      close: entry.close,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadInputTokens: entry.cacheReadInputTokens ?? null,
      cacheCreationInputTokens: entry.cacheCreationInputTokens ?? null,
      latencyMs: entry.latencyMs,
      playbookVersion: entry.playbookVersion,
      promptHash: entry.promptHash,
      inputPayload: entry.inputPayload,
      planJson: entry.plan ?? null,
      consultId: entry.consultId ?? null,
      infoArm: entry.infoArm ?? null,
      thinkingArm: entry.thinkingArm ?? null,
    };
    void this.repo.insert(row).catch((err: unknown) => {
      this.log.error(`agent_decisions insert failed: ${String(err)}`);
    });
  }

  async recent(limit: number, strategyId?: string): Promise<readonly AgentDecisionRow[]> {
    const rows = await this.repo.selectRecent(limit, strategyId);
    return rows.map((r) => toRow(r));
  }

  async recentVersioned(limit: number, sinceMs?: number): Promise<readonly AgentDecisionRow[]> {
    const rows = await this.repo.selectRecentVersioned(limit, sinceMs);
    return rows.map((r) => toRow(r));
  }

  versionEntryStats(version: number): Promise<{ decides: number; entries: number }> {
    return this.repo.countVersionEntryStats(version);
  }
}

function toRow(
  r: Awaited<ReturnType<AgentDecisionRepository['selectRecent']>>[number],
): AgentDecisionRow {
  return {
    strategyId: r.strategyId as StrategyId,
    symbol: r.symbol as SymbolId,
    venue: r.venue as VenueId,
    triggerKind: r.triggerKind,
    basedOnSeq: r.basedOnSeq,
    eventTime: r.eventTime as EpochMs,
    model: r.model,
    action: r.action,
    confidence: r.confidence,
    rationale: r.rationale,
    refPrice: r.refPrice,
    close: r.close,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadInputTokens: r.cacheReadInputTokens,
    cacheCreationInputTokens: r.cacheCreationInputTokens,
    latencyMs: r.latencyMs,
    playbookVersion: r.playbookVersion,
    promptHash: r.promptHash,
    inputPayload: r.inputPayload,
    plan: r.planJson,
    consultId: r.consultId,
    infoArm: r.infoArm,
    thinkingArm: r.thinkingArm,
    id: String(r.id),
    createdAt: r.createdAt.getTime() as EpochMs,
  };
}
