import { describe, it, expect } from 'vitest';
import { InMemoryAgentDecisionJournal } from '../../../../src/database/repositories/strategy/in-memory-agent-decision-journal';
import type {
  AgentDecisionEntry,
  AgentPlan,
  RegimeTags,
} from '../../../../src/ports/strategy/agentic-strategy';
import { REPLAY_STRATEGY_ID_PREFIX } from '../../../../src/ports/strategy/agentic-strategy';
import { strategyId, symbolId, venueId, epochMs } from '../../../../src/domain/common/types/ids';

const PLAN: AgentPlan = {
  entryOffsetBps: 10,
  stopLossPct: '0.02',
  takeProfitPct: '0.03',
  entryValidityBars: 2,
  maxHoldBars: 8,
};

function entry(eventTime: number, overrides: Partial<AgentDecisionEntry> = {}): AgentDecisionEntry {
  return {
    strategyId: strategyId('s1'),
    symbol: symbolId('BTC/USDT'),
    venue: venueId('binance'),
    triggerKind: 'candle',
    basedOnSeq: 1n,
    eventTime: epochMs(eventTime),
    model: 'claude-opus-4-8',
    action: 'hold',
    confidence: 0.5,
    rationale: 'no edge',
    refPrice: '50000.5',
    close: '50000.5',
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 500,
    playbookVersion: 1,
    promptHash: 'hash-1',
    inputPayload: null,
    ...overrides,
  };
}

describe('InMemoryAgentDecisionJournal', () => {
  it('recent() returns rows oldest→newest, matching AgentContext.recentDecisions convention', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1));
    journal.record(entry(2));
    journal.record(entry(3));

    const rows = await journal.recent(10);
    expect(rows.map((r) => r.eventTime)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('recent(limit) returns only the most recent `limit` rows, still oldest→newest', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    for (let i = 1; i <= 5; i++) journal.record(entry(i));

    const rows = await journal.recent(2);
    expect(rows.map((r) => r.eventTime)).toEqual([4, 5]);
  });

  it('ring buffer evicts the oldest row once MAX_ROWS (500) is exceeded', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    for (let i = 1; i <= 501; i++) journal.record(entry(i));

    const rows = await journal.recent(501);
    expect(rows).toHaveLength(500);
    // eventTime=1 (the oldest) was evicted; the tail is 2..501.
    expect(rows[0]!.eventTime).toBe(2);
    expect(rows[rows.length - 1]!.eventTime).toBe(501);
  });

  it('recent(limit, strategyId) scopes to one strategy before applying the limit (P7)', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1, { strategyId: strategyId('agentic-1') }));
    journal.record(entry(2, { strategyId: strategyId('agentic-2') }));
    journal.record(entry(3, { strategyId: strategyId('agentic-1') }));
    journal.record(entry(4, { strategyId: strategyId('agentic-2') }));

    const scoped = await journal.recent(10, 'agentic-2');
    expect(scoped.map((r) => r.eventTime)).toEqual([2, 4]);
    // The limit applies AFTER the scope — the tail of the scoped rows, not of the raw ring.
    const limited = await journal.recent(1, 'agentic-1');
    expect(limited.map((r) => r.eventTime)).toEqual([3]);
    // Unscoped read stays the historical behavior.
    expect((await journal.recent(10)).map((r) => r.eventTime)).toEqual([1, 2, 3, 4]);
  });

  it('preserves every field on the entry, mapping id/createdAt in addition', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(
      entry(1, { action: 'open_long', confidence: 0.9, rationale: 'trend confirmed' }),
    );

    const [row] = await journal.recent(1);
    expect(row!.action).toBe('open_long');
    expect(row!.confidence).toBe(0.9);
    expect(row!.rationale).toBe('trend confirmed');
    expect(row!.strategyId).toBe('s1');
    expect(typeof row!.id).toBe('string');
    expect(typeof row!.createdAt).toBe('number');
  });

  it('round-trips a carried plan, and defaults absent plan to undefined on the row', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1, { plan: PLAN }));
    journal.record(entry(2));

    const [withPlan, withoutPlan] = await journal.recent(2);
    expect(withPlan!.plan).toEqual(PLAN);
    expect(withoutPlan!.plan).toBeUndefined();
  });

  it('round-trips a carried consultId, and defaults absent consultId to undefined on the row', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1, { consultId: 'consult-abc' }));
    journal.record(entry(2));

    const [withConsultId, withoutConsultId] = await journal.recent(2);
    expect(withConsultId!.consultId).toBe('consult-abc');
    expect(withoutConsultId!.consultId).toBeUndefined();
  });

  it('recentVersioned() returns versioned rows only, honors sinceMs and keeps the newest under the cap', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1, { playbookVersion: 1 }));
    journal.record(entry(2, { playbookVersion: null }));
    journal.record(entry(3, { playbookVersion: 2 }));
    journal.record(entry(4, { playbookVersion: null }));
    journal.record(entry(5, { playbookVersion: 3 }));

    // NULL-version (quiet/prescreen) rows never consume the attribution window.
    expect((await journal.recentVersioned(10)).map((r) => r.eventTime)).toEqual([1, 3, 5]);
    // Over-cap keeps the NEWEST versioned rows, still oldest→newest.
    expect((await journal.recentVersioned(2)).map((r) => r.eventTime)).toEqual([3, 5]);
    // sinceMs bounds at-or-after the instant.
    expect((await journal.recentVersioned(10, 3)).map((r) => r.eventTime)).toEqual([3, 5]);
  });

  it('versionEntryStats counts lifetime real-LLM decides/entries for one version (abstention-lapse evidence base)', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1, { model: 'claude-sonnet-5', action: 'open_long', playbookVersion: 2 }));
    journal.record(entry(2, { model: 'claude-sonnet-5', action: 'hold', playbookVersion: 2 }));
    // Non-LLM replay/synthetic rows are excluded from the decide count entirely.
    journal.record(entry(3, { model: 'replay-sim', action: 'open_long', playbookVersion: 2 }));
    journal.record(entry(4, { model: 'claude-sonnet-5', action: 'open_long', playbookVersion: 1 }));

    expect(await journal.versionEntryStats(2)).toEqual({ decides: 2, entries: 1 });
    expect(await journal.versionEntryStats(1)).toEqual({ decides: 1, entries: 1 });
    expect(await journal.versionEntryStats(3)).toEqual({ decides: 0, entries: 0 });
  });

  it('versionEntryStats (P4): counts v2 open_long/open_short as entries, never close/adjust/hold', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1, { model: 'claude-sonnet-5', action: 'open_long', playbookVersion: 5 }));
    journal.record(
      entry(2, { model: 'claude-sonnet-5', action: 'open_short', playbookVersion: 5 }),
    );
    journal.record(entry(3, { model: 'claude-sonnet-5', action: 'close', playbookVersion: 5 }));
    journal.record(entry(4, { model: 'claude-sonnet-5', action: 'adjust', playbookVersion: 5 }));
    journal.record(entry(5, { model: 'claude-sonnet-5', action: 'hold', playbookVersion: 5 }));

    expect(await journal.versionEntryStats(5)).toEqual({ decides: 5, entries: 2 });
  });

  // R2 episodic-memory retrieval.
  const UP_HIGH_EU: RegimeTags = { trend: 'up', vol: 'high', funding: 'positive', session: 'eu' };
  const DOWN_LOW_US: RegimeTags = { trend: 'down', vol: 'low', funding: 'negative', session: 'us' };

  it('recentSimilarSetups returns only matching-tag rows, newest-first, with forward-move outcomes', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    // Two matching rows (t=1 close 100, t=3 close 110) and one non-matching (t=2, different regime).
    journal.record(entry(1, { action: 'open_long', close: '100', regimeTags: UP_HIGH_EU }));
    journal.record(entry(2, { action: 'hold', close: '105', regimeTags: DOWN_LOW_US }));
    journal.record(entry(3, { action: 'open_long', close: '110', regimeTags: UP_HIGH_EU }));
    // A later row (t=4, close 121) supplies the forward close for the t=3 setup.
    journal.record(entry(4, { action: 'close', close: '121', regimeTags: DOWN_LOW_US }));

    const rows = await journal.recentSimilarSetups(UP_HIGH_EU, 5);
    // Newest-first: t=3 then t=1; the DOWN_LOW_US rows are excluded.
    expect(rows.map((r) => r.eventTime)).toEqual([3, 1]);
    // t=3 (close 110) → next decision close 121 ⇒ +10%. t=1 (close 100) → next close 105 ⇒ +5%.
    // Exact (Decimal math, chosen so the % is integral) — toBeCloseTo is banned for assertions here.
    expect(rows[0]!.priceMovePct).toBe(10);
    expect(rows[1]!.priceMovePct).toBe(5);
  });

  it('funding is matched only when the query carries it; trend/vol/session always pin', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1, { close: '100', regimeTags: UP_HIGH_EU }));
    journal.record(
      entry(2, { close: '100', regimeTags: { trend: 'up', vol: 'high', session: 'eu' } }),
    );
    // A funding-less query matches BOTH (funding unconstrained); a positive-funding query pins to the
    // row that carried it.
    expect(
      (await journal.recentSimilarSetups({ trend: 'up', vol: 'high', session: 'eu' }, 5)).map(
        (r) => r.eventTime,
      ),
    ).toEqual([2, 1]);
    expect((await journal.recentSimilarSetups(UP_HIGH_EU, 5)).map((r) => r.eventTime)).toEqual([1]);
  });

  it('retrieval INCLUDES replay-<runId> synthetic rows and labels them synthetic', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(
      entry(1, {
        strategyId: strategyId(`${REPLAY_STRATEGY_ID_PREFIX}run7`),
        close: '100',
        regimeTags: UP_HIGH_EU,
      }),
    );
    journal.record(entry(2, { close: '100', regimeTags: UP_HIGH_EU }));

    const rows = await journal.recentSimilarSetups(UP_HIGH_EU, 5);
    expect(rows.map((r) => r.synthetic)).toEqual([false, true]); // newest-first: t=2 live, t=1 synthetic
  });

  it('a row with no regimeTags is never retrieved (fail-open miss, never a wrong match)', async () => {
    const journal = new InMemoryAgentDecisionJournal();
    journal.record(entry(1, { close: '100' })); // untagged
    expect(await journal.recentSimilarSetups(UP_HIGH_EU, 5)).toEqual([]);
  });
});
