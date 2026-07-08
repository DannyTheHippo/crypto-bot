import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';

export interface AgentDecisionInsert {
  strategyId: string;
  symbol: string;
  venue: string;
  triggerKind: 'candle' | 'ticker' | 'book' | 'exec';
  basedOnSeq: bigint;
  eventTime: number;
  model: string;
  action: 'long' | 'flat' | 'hold' | 'error';
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
}
