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
// A3: the full set of `action` literals the DB column (and AgentDecisionInsert.action) accepts —
// mirrors AgentDecisionEntry.action verbatim. TypeScript's static type already constrains every
// well-typed caller, but this is a RUNTIME persistence-boundary guard for the case that matters more:
// a caller that narrows/casts `action` to a type the compiler accepts while the real runtime value is
// something else (see anthropic-agent-client.ts's `action as 'long' | 'flat' | 'hold'` breadcrumb —
// the legacy shorts capability's real value can be 'short', a literal outside this set entirely).
const KNOWN_JOURNAL_ACTIONS = new Set<AgentDecisionEntry['action']>([
  'open_long',
  'open_short',
  'close',
  'adjust',
  'hold',
  'long',
  'flat',
  'error',
]);

export class AgentDecisionJournalAdapter implements AgentDecisionJournalPort {
  private readonly repo: AgentDecisionRepository;
  private readonly log = new Logger('AgentDecisionJournal');

  constructor(db: NodePgDatabase<typeof schema>) {
    this.repo = new AgentDecisionRepository(db);
  }

  // Fail-loud, fails OPEN: agent_decisions is an analysis artifact, never a safety interlock
  // (CLAUDE.md rule 6 scope — the append-only hardening binds audit_log/order_events only), so a
  // write carrying an action outside KNOWN_JOURNAL_ACTIONS is logged (offending value + strategyId)
  // and the ROW IS DROPPED here — it must never throw into the caller's decide() path.
  record(entry: AgentDecisionEntry): void {
    if (!KNOWN_JOURNAL_ACTIONS.has(entry.action)) {
      this.log.error(
        `agent_decisions insert dropped: action "${String(entry.action)}" is outside the known ` +
          `journal action set (strategyId=${entry.strategyId})`,
      );
      return;
    }
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
      // I1b: nextConsultBars rides in plan_json alongside the rest of the directive set (no new
      // column — see AgentDecisionEntry.nextConsultBars' own comment) — merged in ONLY when a plan
      // object is actually present; a hold-without-directives row that still carried a portfolio
      // schedule value has nowhere in this shape to carry it (accepted: the runtime schedule itself
      // — agentic.strategy.ts's scheduledConsultBars — is driven straight off AgentProposal, never
      // off this journal read; this column is an analysis artifact only).
      planJson:
        entry.plan && entry.nextConsultBars != null
          ? { ...entry.plan, nextConsultBars: entry.nextConsultBars }
          : entry.plan ?? null,
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
