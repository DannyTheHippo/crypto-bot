import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, count, desc, eq, gte, isNotNull, like, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';
import type { AgentPlan, AgentDirectives } from '../../ports/agentic-strategy';

export interface AgentDecisionInsert {
  strategyId: string;
  symbol: string;
  venue: string;
  triggerKind: 'candle' | 'ticker' | 'book' | 'exec';
  basedOnSeq: bigint;
  eventTime: number;
  model: string;
  // A3: widened alongside AgentDecisionEntry.action (ports/agentic-strategy.ts) — this is the row
  // shape AgentDecisionJournalAdapter.record() builds AFTER its own fail-loud guard has already
  // dropped anything outside this union, so the type here stays the full accepted set.
  action: 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold' | 'long' | 'flat' | 'error';
  confidence: number | null;
  rationale: string;
  refPrice: string | null;
  close: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  // Optional so pre-#27 callers and test fixtures stay valid (nullable analytics columns; absent ⇒
  // NULL, distinguishable from a confirmed zero — see AgentUsage's own absent-vs-zero convention).
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  latencyMs: number | null;
  playbookVersion: number | null;
  promptHash: string;
  inputPayload: string | null;
  // Optional so pre-this-column callers and test fixtures stay valid (same absent-vs-null
  // convention as the cache-token fields above); absent and null both insert as NULL. A3: widened to
  // ALSO accept AgentDirectives (the v2 shape, mirrored locally in trading.schema.ts's plan_json
  // $type) — AgentPlan (legacy) stays accepted unchanged for every pre-v2 caller/fixture. I1b: the
  // intersection additionally accepts nextConsultBars (AgentDecisionEntry's own sibling field, merged
  // in by the adapter's record()) — mirrors trading.schema.ts's plan_json $type widening.
  planJson?: ((AgentPlan | AgentDirectives) & { nextConsultBars?: number }) | null;
  // See AgentDecisionEntry.consultId — the batch join key; absent and null both insert as NULL.
  consultId?: string | null;
  // See AgentDecisionEntry.infoArm/thinkingArm — A/B treatment truth; absent and null both insert
  // as NULL.
  infoArm?: boolean | null;
  thinkingArm?: boolean | null;
}

export type AgentDecisionDbRow = typeof schema.agentDecisions.$inferSelect;

@Injectable()
export class AgentDecisionRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(row: AgentDecisionInsert): Promise<void> {
    await requireDb(this.db).insert(schema.agentDecisions).values(row);
  }

  // Most recent `limit` decisions, returned oldest→newest — see AgentDecisionJournalAdapter's
  // header comment for why (matches AgentContext.recentDecisions' "newest-last" convention). The
  // desc(id) tiebreak matters when two rows share an eventTime: id is the insertion-ordered PK, so
  // ties resolve the same way InMemoryAgentDecisionJournal's plain append-order does, rather than
  // however Postgres happens to return same-eventTime rows.
  // strategyId (P7) scopes the window to one instance's rows — see the port's own comment.
  async selectRecent(limit: number, strategyId?: string): Promise<AgentDecisionDbRow[]> {
    const db = requireDb(this.db);
    const rows =
      strategyId === undefined
        ? await db
            .select()
            .from(schema.agentDecisions)
            .orderBy(desc(schema.agentDecisions.eventTime), desc(schema.agentDecisions.id))
            .limit(limit)
        : await db
            .select()
            .from(schema.agentDecisions)
            .where(eq(schema.agentDecisions.strategyId, strategyId))
            .orderBy(desc(schema.agentDecisions.eventTime), desc(schema.agentDecisions.id))
            .limit(limit);
    return rows.reverse();
  }

  // Versioned-only variant of selectRecent for the attribution reads — see
  // AgentDecisionJournalPort.recentVersioned for why quiet NULL-version rows must not share the
  // window. sinceMs bounds the scan when the caller carries an evidence epoch; the cap binds either
  // way (newest rows win, same desc(eventTime), desc(id) tiebreak as selectRecent).
  async selectRecentVersioned(limit: number, sinceMs?: number): Promise<AgentDecisionDbRow[]> {
    const db = requireDb(this.db);
    const versioned = isNotNull(schema.agentDecisions.playbookVersion);
    const rows = await db
      .select()
      .from(schema.agentDecisions)
      .where(
        sinceMs === undefined
          ? versioned
          : and(versioned, gte(schema.agentDecisions.eventTime, sinceMs)),
      )
      .orderBy(desc(schema.agentDecisions.eventTime), desc(schema.agentDecisions.id))
      .limit(limit);
    return rows.reverse();
  }

  // Lifetime decide/entry counts for one playbook version (the abstention lapse's evidence base —
  // see AgentDecisionJournalPort.versionEntryStats): real-LLM rows only, ReflectionService's
  // model.startsWith('claude') filter in SQL form. P4: entry set widened to every v2/legacy OPEN
  // action ('long' the legacy tool, 'open_long'/'open_short' the v2 tools) — 'close'/'adjust'/'flat'/
  // 'hold' are never entries. Missing this widening false-abstention-lapses every v2 candidate (the
  // plan's highest-priority silent break — see this codebase's design doc).
  async countVersionEntryStats(version: number): Promise<{ decides: number; entries: number }> {
    const db = requireDb(this.db);
    const [row] = await db
      .select({
        decides: count(),
        entries: count(
          sql`case when ${schema.agentDecisions.action} in ('long', 'open_long', 'open_short') then 1 end`,
        ),
      })
      .from(schema.agentDecisions)
      .where(
        and(
          eq(schema.agentDecisions.playbookVersion, version),
          like(schema.agentDecisions.model, 'claude%'),
        ),
      );
    return { decides: row?.decides ?? 0, entries: row?.entries ?? 0 };
  }

  // Latest non-null plan_json.thesis for a strategyId (boot rehydration — a later consumer restores
  // activePlan's currentThesis from the newest journaled row that actually carried one, so a redeploy
  // doesn't start the model with a blank thesis it already committed to). jsonb ->> extracts the text
  // field directly in SQL so a thesis-less row (legacy AgentPlan shape, or a v2 row whose model
  // omitted thesis) is filtered by the WHERE, never read back and checked in JS.
  async latestThesis(strategyId: string): Promise<string | null> {
    const db = requireDb(this.db);
    const thesisNotNull = sql`${schema.agentDecisions.planJson} ->> 'thesis' is not null`;
    const [row] = await db
      .select({ thesis: sql<string>`${schema.agentDecisions.planJson} ->> 'thesis'` })
      .from(schema.agentDecisions)
      .where(and(eq(schema.agentDecisions.strategyId, strategyId), thesisNotNull))
      .orderBy(desc(schema.agentDecisions.eventTime), desc(schema.agentDecisions.id))
      .limit(1);
    return row?.thesis ?? null;
  }
}
