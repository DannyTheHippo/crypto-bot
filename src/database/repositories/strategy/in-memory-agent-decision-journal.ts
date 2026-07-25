import { Injectable } from '@nestjs/common';
import {
  REPLAY_STRATEGY_ID_PREFIX,
  type AgentDecisionJournalPort,
  type AgentDecisionEntry,
  type AgentDecisionRow,
  type RegimeTags,
  type SimilarSetupRow,
} from '../../../ports/strategy/agentic-strategy';
import type { EpochMs } from '../../../domain/common/types/ids';
import { forwardMovePct } from './agent-decision.repository';

// In-process AGENT_DECISION_JOURNAL default (DB-less paper/test substrate) — a working ring
// buffer rather than a no-op, unlike SIGNAL_JOURNAL's undefined-under-no-DB binding (see
// ports/strategy/strategy.ts): reflection's read side needs a real recent() even without a database.
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
    // R1 parity with AgentDecisionRepository.selectRecent: the LANE-WIDE branch excludes synthetic
    // replay-<runId> rows (the mint-floor corpus must never draw on replay simulations); the scoped
    // branch excludes them by construction (a real strategyId never carries the prefix).
    const scoped =
      strategyId === undefined
        ? this.rows.filter((r) => !r.strategyId.startsWith(REPLAY_STRATEGY_ID_PREFIX))
        : this.rows.filter((r) => r.strategyId === strategyId);
    return Promise.resolve(scoped.slice(Math.max(0, scoped.length - limit)));
  }

  // R1 synthetic-experience read — the complement of recent()'s lane-wide filter (see the port's
  // recentSynthetic comment). Matches AgentDecisionRepository.selectRecentSynthetic.
  recentSynthetic(limit: number): Promise<readonly AgentDecisionRow[]> {
    const scoped = this.rows.filter((r) => r.strategyId.startsWith(REPLAY_STRATEGY_ID_PREFIX));
    return Promise.resolve(scoped.slice(Math.max(0, scoped.length - limit)));
  }

  // R2 episodic-memory retrieval — mirrors AgentDecisionRepository.selectSimilarSetups on the DB-less
  // substrate: rows whose regimeTags equal `tags` (trend/vol/session always, funding only when the
  // query carries it), newest-first, capped at `limit`, DELIBERATELY INCLUSIVE of replay-<runId>
  // synthetic rows (labeled synthetic in the row), each paired with the forward price move to that
  // strategy's next decision close.
  recentSimilarSetups(tags: RegimeTags, limit: number): Promise<readonly SimilarSetupRow[]> {
    const result: SimilarSetupRow[] = [];
    for (let i = this.rows.length - 1; i >= 0 && result.length < limit; i -= 1) {
      const r = this.rows[i]!;
      if (!regimeMatches(r.regimeTags, tags)) continue;
      result.push({
        eventTime: r.eventTime,
        synthetic: r.strategyId.startsWith(REPLAY_STRATEGY_ID_PREFIX),
        action: r.action,
        close: r.close,
        priceMovePct: forwardMovePct(r.close, this.nextCloseFor(r)),
      });
    }
    return Promise.resolve(result);
  }

  // The close of the SINGLE next decision (by event_time, id tiebreak) for the SAME strategy — the
  // in-memory analogue of selectSimilarSetups' correlated forward-close subquery.
  private nextCloseFor(row: AgentDecisionRow): string | null {
    // id is a numeric string (the insertion-ordered PK) — compared as BigInt, never Number() (the
    // money-path lint bans Number() lane-wide), so the (event_time, id) tiebreak matches the DB path.
    const rowId = BigInt(row.id);
    let best: AgentDecisionRow | undefined;
    for (const c of this.rows) {
      if (c.strategyId !== row.strategyId) continue;
      const after =
        c.eventTime > row.eventTime || (c.eventTime === row.eventTime && BigInt(c.id) > rowId);
      if (!after) continue;
      const better =
        best === undefined ||
        c.eventTime < best.eventTime ||
        (c.eventTime === best.eventTime && BigInt(c.id) < BigInt(best.id));
      if (better) best = c;
    }
    return best?.close ?? null;
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
    // P4: entry set widened to every v2/legacy OPEN action, mirroring
    // AgentDecisionRepository.countVersionEntryStats' own SQL widening — this is the DB-less path
    // that serves test/CI/no-DB paper runs, so an unwidened entries check here false-abstention-
    // lapses every v2 candidate on exactly the paths this journal backs.
    let decides = 0;
    let entries = 0;
    for (const r of this.rows) {
      if (r.playbookVersion !== version) continue;
      if (!r.model.startsWith('claude')) continue;
      decides += 1;
      if (r.action === 'open_long' || r.action === 'open_short') {
        entries += 1;
      }
    }
    return Promise.resolve({ decides, entries });
  }
}

// Tag-equality match for episodic retrieval: trend/vol/session must all match; funding is matched only
// when the QUERY carries it (a spot-lane query with no funding tag must not require the stored row to
// lack one, but a perp query WITH a funding tag pins it) — mirrors selectSimilarSetups' SQL WHERE.
function regimeMatches(stored: RegimeTags | null | undefined, query: RegimeTags): boolean {
  if (!stored) return false;
  if (
    stored.trend !== query.trend ||
    stored.vol !== query.vol ||
    stored.session !== query.session
  ) {
    return false;
  }
  return query.funding === undefined || stored.funding === query.funding;
}
