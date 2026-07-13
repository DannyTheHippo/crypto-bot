import { describe, it, expect } from 'vitest';
import { InMemoryAgentDecisionJournal } from '../../../src/database/repositories/in-memory-agent-decision-journal';
import type { AgentDecisionEntry, AgentPlan } from '../../../src/ports/agentic-strategy';
import { strategyId, symbolId, venueId, epochMs } from '../../../src/domain/types/ids';

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
    journal.record(entry(1, { action: 'long', confidence: 0.9, rationale: 'trend confirmed' }));

    const [row] = await journal.recent(1);
    expect(row!.action).toBe('long');
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
});
