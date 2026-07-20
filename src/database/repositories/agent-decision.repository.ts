import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, count, desc, eq, gte, isNotNull, like, notLike, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';
import { REPLAY_STRATEGY_ID_PREFIX } from '../../ports/agentic-strategy';
import type {
  AgentPlan,
  AgentDirectives,
  RegimeTags,
  SimilarSetupRow,
} from '../../ports/agentic-strategy';
import type { EpochMs } from '../../domain/types/ids';

// SQL LIKE pattern for R1 synthetic (replay-<runId>) strategyIds — `%` matches the runId suffix.
const REPLAY_STRATEGY_LIKE = `${REPLAY_STRATEGY_ID_PREFIX}%`;

export interface AgentDecisionInsert {
  strategyId: string;
  symbol: string;
  venue: string;
  triggerKind: 'candle' | 'ticker' | 'book' | 'exec';
  basedOnSeq: bigint;
  eventTime: number;
  model: string;
  // v3 (consolidation spec §2/§9): narrowed to the rich-tool-contract-only vocabulary — the legacy
  // 'long'/'flat' literals (the retired DECISION_TOOL/SHORTS_DECISION_TOOL contract) are no longer
  // accepted; AgentDecisionJournalAdapter's record() guard narrows AgentDecisionEntry['action'] (the
  // wider ports-level union, still carrying the legacy literals for pre-v3 callers) down to this set
  // before ever building this row, and drops anything outside it.
  action: 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold' | 'error';
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
  // in by the adapter's record()) — mirrors trading.schema.ts's plan_json $type widening. XA4: the
  // schedule-only object `{ nextConsultBars }` (a hold that carried a portfolio schedule but no
  // directive set) is a distinct third arm — before XA4 those rows dropped their schedule entirely.
  // R2: regimeTags rides on every arm (a compact fingerprint stamped on every row for tag-equality
  // retrieval — see selectSimilarSetups); the schedule-only arm additionally accepts a bare
  // `{ regimeTags }` (a tagged hold that carried neither directives nor a schedule).
  planJson?:
    | ((AgentPlan | AgentDirectives) & { nextConsultBars?: number; regimeTags?: RegimeTags })
    | { nextConsultBars?: number; regimeTags?: RegimeTags }
    | null;
  // See AgentDecisionEntry.consultId — the batch join key; absent and null both insert as NULL.
  consultId?: string | null;
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
  // R1: the LANE-WIDE branch (strategyId undefined — the mint-floor corpus read) EXCLUDES synthetic
  // replay-<runId> rows so a replay run never pads the entry-rate floor's corpus; the scoped branch
  // needs no such filter — a real strategyId never carries REPLAY_STRATEGY_ID_PREFIX (excluded by
  // construction). recentSynthetic below is the only read that surfaces the excluded rows.
  async selectRecent(limit: number, strategyId?: string): Promise<AgentDecisionDbRow[]> {
    const db = requireDb(this.db);
    const rows =
      strategyId === undefined
        ? await db
            .select()
            .from(schema.agentDecisions)
            .where(notLike(schema.agentDecisions.strategyId, REPLAY_STRATEGY_LIKE))
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

  // R1 synthetic-experience read (AgentDecisionJournalPort.recentSynthetic): the newest `limit`
  // replay-<runId> rows, oldest→newest like selectRecent. The exact complement of selectRecent's
  // lane-wide filter — this is where reflection's opt-in synthetic digest draws its rows.
  async selectRecentSynthetic(limit: number): Promise<AgentDecisionDbRow[]> {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.agentDecisions)
      .where(like(schema.agentDecisions.strategyId, REPLAY_STRATEGY_LIKE))
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
  // model.startsWith('claude') filter in SQL form. Entry set is every OPEN action
  // ('open_long'/'open_short') — 'close'/'adjust'/'hold' are never entries. v3: the legacy 'long'
  // literal is dropped from the filter — a fresh v3 DB never carries a legacy-contract row.
  async countVersionEntryStats(version: number): Promise<{ decides: number; entries: number }> {
    const db = requireDb(this.db);
    const [row] = await db
      .select({
        decides: count(),
        entries: count(
          sql`case when ${schema.agentDecisions.action} in ('open_long', 'open_short') then 1 end`,
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

  // R2 episodic-memory retrieval (AgentDecisionJournalPort.recentSimilarSetups): the newest `limit`
  // rows whose persisted plan_json.regimeTags equal `tags` — trend/vol/session matched always, funding
  // matched only when the query carries it (a spot-lane query with no funding tag must not require the
  // stored row to lack one, but a perp query WITH a funding tag pins it). LANE-WIDE and DELIBERATELY
  // INCLUSIVE of replay-<runId> synthetic rows (the ONE lane-wide read that does not exclude them — see
  // the port comment). Each matched row is paired with the price move that FOLLOWED it: a correlated
  // subquery fetches that strategy's NEXT decision close (the true next decision, not the next
  // tag-matching one), joined at read time because the forward outcome is never stored on the row
  // (CLAUDE.md — see AGENT_DECISION_JOURNAL's comment). Newest-first (recency-weighted retrieval).
  async selectSimilarSetups(tags: RegimeTags, limit: number): Promise<SimilarSetupRow[]> {
    const db = requireDb(this.db);
    const d = schema.agentDecisions;
    const tagAt = (key: string) => sql`${d.planJson} -> 'regimeTags' ->> ${key}`;
    const conds = [
      sql`${tagAt('trend')} = ${tags.trend}`,
      sql`${tagAt('vol')} = ${tags.vol}`,
      sql`${tagAt('session')} = ${tags.session}`,
      ...(tags.funding !== undefined ? [sql`${tagAt('funding')} = ${tags.funding}`] : []),
    ];
    // Correlated forward-close lookup: the SINGLE next decision (by event_time, id tiebreak) for the
    // SAME strategy, regardless of its tags — the actual "what happened next", not the next similar
    // setup. Runs at most `limit` times (once per output row, after LIMIT), each hit served by the
    // agent_decisions_strategy_event_idx index.
    const nextClose = sql<string | null>`(
      select d2.close from agent_decisions d2
      where d2.strategy_id = ${d.strategyId}
        and (d2.event_time, d2.id) > (${d.eventTime}, ${d.id})
      order by d2.event_time asc, d2.id asc
      limit 1
    )`;
    const rows = await db
      .select({
        strategyId: d.strategyId,
        action: d.action,
        close: d.close,
        eventTime: d.eventTime,
        nextClose,
      })
      .from(d)
      .where(and(...conds))
      .orderBy(desc(d.eventTime), desc(d.id))
      .limit(limit);
    return rows.map((r) => ({
      eventTime: r.eventTime as EpochMs,
      synthetic: r.strategyId.startsWith(REPLAY_STRATEGY_ID_PREFIX),
      action: r.action,
      close: r.close,
      priceMovePct: forwardMovePct(r.close, r.nextClose),
    }));
  }
}

// Forward price move (%) from a row's own close to its strategy's next decision close — indicator-
// grade context, computed on Decimal (never a native-float money coercion) and dropped to a plain
// number only at the very end. null when either close is absent/non-finite or the base close is <= 0
// (same null-not-NaN honesty as AgentDecisionRecord.outcome.priceMovePct).
export function forwardMovePct(close: string | null, nextClose: string | null): number | null {
  if (close === null || nextClose === null) return null;
  const base = new Decimal(close);
  const next = new Decimal(nextClose);
  if (!base.isFinite() || !next.isFinite() || base.lte(0)) return null;
  return next.minus(base).div(base).times(100).toNumber();
}
