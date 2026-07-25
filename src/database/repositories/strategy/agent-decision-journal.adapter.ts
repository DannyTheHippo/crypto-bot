import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  AgentDecisionJournalPort,
  AgentDecisionEntry,
  AgentDecisionRow,
  RegimeTags,
  SimilarSetupRow,
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
// v3 (consolidation spec §2/§9): the DB column (and AgentDecisionInsert.action) narrows to the
// rich-tool-contract-only vocabulary — the legacy 'long'/'flat' literals (the retired
// DECISION_TOOL/SHORTS_DECISION_TOOL contract) are no longer accepted. AgentDecisionEntry.action
// (ports/agentic-strategy.ts, owned by the agentic workstream) still declares the wider legacy union
// until that contract is fully deleted there, so this is a RUNTIME persistence-boundary guard AND a
// narrowing type predicate: any action outside this set — including a well-typed legacy literal, or
// a caller that narrowed/cast `action` to a type the compiler accepts while the real runtime value is
// something else — is logged and the row dropped, never persisted.
const KNOWN_JOURNAL_ACTIONS: ReadonlySet<string> = new Set([
  'open_long',
  'open_short',
  'close',
  'adjust',
  'hold',
  'error',
]);

function isJournalAction(action: string): action is AgentDecisionInsert['action'] {
  return KNOWN_JOURNAL_ACTIONS.has(action);
}

// XA4 (A0, 2026-07-20): assemble plan_json from the directive set and/or the portfolio-level
// nextConsultBars. A plan present ⇒ directives (+ schedule merged in when set); no plan but a
// schedule present ⇒ a bare `{nextConsultBars}` object so a hold's model-chosen cadence is still
// auditable; neither ⇒ null. Split out as a pure function so its behavior is unit-testable directly.
// R2: regimeTags (a compact regime fingerprint stamped on every row for tag-equality retrieval — see
// AgentDecisionJournalPort.recentSimilarSetups) merges in alongside the directive set / schedule. A
// tagged hold that carried neither directives nor a schedule persists `{ regimeTags }` on its own, so
// the retrieval corpus is not limited to rows that opened a position — the pre-R2 arms (directives,
// `{ nextConsultBars }`, null) are otherwise unchanged.
export function buildPlanJson(
  plan: AgentDecisionEntry['plan'] | null,
  nextConsultBars: number | null,
  regimeTags: RegimeTags | null = null,
): AgentDecisionInsert['planJson'] {
  const schedule = nextConsultBars != null ? { nextConsultBars } : {};
  const tags = regimeTags != null ? { regimeTags } : {};
  if (plan) {
    return { ...plan, ...schedule, ...tags };
  }
  const rest = { ...schedule, ...tags };
  return Object.keys(rest).length > 0 ? rest : null;
}

// XA4 read-side coercion: a directive plan_json passes through verbatim (the I1b behavior — the
// merged nextConsultBars stays inside `plan` for existing readers); the NEW schedule-only shape
// (`{ nextConsultBars }`, no directive fields) reads back as null so no consumer mistakes a bare
// portfolio schedule for a real directive plan. Identified by the plan's required stopLossPct.
export function readPlanJson(
  planJson: AgentDecisionInsert['planJson'],
): AgentDecisionEntry['plan'] | null {
  if (planJson == null || !('stopLossPct' in planJson)) return null;
  // R2: regimeTags is retrieval metadata, not part of the directive set — strip it so directive
  // readers (plan-executor bookkeeping, boot rehydration) never see a stray key on the returned
  // AgentPlan/AgentDirectives. Absent regimeTags ⇒ the row passes through byte-identically (pre-R2).
  if (!('regimeTags' in planJson)) return planJson;
  const directives = { ...planJson };
  delete (directives as { regimeTags?: unknown }).regimeTags;
  return directives;
}

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
    if (!isJournalAction(entry.action)) {
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
      // I1b + XA4 (A0, 2026-07-20): plan_json carries the directive set AND the portfolio-level
      // nextConsultBars. Before XA4 the schedule was merged in ONLY when a `plan` object was also
      // present — but v2 holds (the overwhelming majority of decisions) carry a schedule and NO
      // plan, so every hold dropped its model-chosen nextConsultBars and A0 found plan_json empty on
      // every v2 row, making the scheduler's own choices unauditable. Now a hold that carried a
      // schedule persists `{nextConsultBars}` on its own; a plan row merges the schedule into the
      // directives; a bare hold with neither stays null. (The runtime schedule is still driven off
      // AgentProposal directly — this column is an analysis artifact, but now a complete one.)
      // R2: the regime fingerprint rides inside plan_json alongside the directives/schedule — no new
      // column (same no-migration convention as nextConsultBars). Null ⇒ untagged (fail-open miss).
      planJson: buildPlanJson(
        entry.plan ?? null,
        entry.nextConsultBars ?? null,
        entry.regimeTags ?? null,
      ),
      // v3-transitional(#10): info_arm/thinking_arm columns are dropped (spec §2/§9 — the
      // derivatives-control A/B factorial was retired; the playbook champion/candidate A/B is NOT
      // retired and is attributed via consultId + playbookVersion, not an arm flag). entry.infoArm/
      // entry.thinkingArm (still declared on AgentDecisionEntry, ports/agentic-strategy.ts, owned by
      // workstream #10) are read by the client for prompt-template selection but are simply never
      // forwarded to persistence now.
      consultId: entry.consultId ?? null,
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

  // R1 synthetic-experience read — see AgentDecisionJournalPort.recentSynthetic.
  async recentSynthetic(limit: number): Promise<readonly AgentDecisionRow[]> {
    const rows = await this.repo.selectRecentSynthetic(limit);
    return rows.map((r) => toRow(r));
  }

  // R2 episodic-memory retrieval — see AgentDecisionJournalPort.recentSimilarSetups. Straight
  // passthrough: the repository query already shapes the SimilarSetupRow (tag match + forward-move
  // join + synthetic labeling), so no per-row mapping is needed here.
  recentSimilarSetups(tags: RegimeTags, limit: number): Promise<readonly SimilarSetupRow[]> {
    return this.repo.selectSimilarSetups(tags, limit);
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
    plan: readPlanJson(r.planJson),
    consultId: r.consultId,
    id: String(r.id),
    createdAt: r.createdAt.getTime() as EpochMs,
  };
}
