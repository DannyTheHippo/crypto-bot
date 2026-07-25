import { describe, it, expect } from 'vitest';
import { computeVersionPnlDigest } from '../../../../src/features/strategy/agentic/version-pnl-digest';
import type { AgentDecisionRow } from '../../../../src/ports/strategy/agentic-strategy';
import type { RoundTripEvidence } from '../../../../src/ports/trading/promotion';
import { strategyId, epochMs } from '../../../../src/domain/common/types/ids';

const SID = 'agentic-1';
const SYM = 'BTC/USDT';

// Same fixture shape as promotion-evaluator.spec.ts's own decisionRow — this module reuses that
// file's attributeVersion (imported, not duplicated), so the join semantics under test are identical.
function decisionRow(version: number, at: number, symbol = SYM): AgentDecisionRow {
  return {
    id: `d-${version}-${at}`,
    createdAt: epochMs(at),
    strategyId: strategyId(SID),
    symbol: symbol as unknown as AgentDecisionRow['symbol'],
    venue: 'binance' as unknown as AgentDecisionRow['venue'],
    triggerKind: 'candle',
    basedOnSeq: 0n,
    eventTime: epochMs(at),
    model: 'm',
    action: 'open_long',
    confidence: 0.6,
    rationale: 'r',
    refPrice: null,
    close: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    playbookVersion: version,
    promptHash: 'h',
    inputPayload: null,
  };
}

function trip(over: Partial<RoundTripEvidence> = {}): RoundTripEvidence {
  return {
    strategyId: SID,
    symbol: SYM,
    openedAt: 0,
    closedAt: 100,
    holdingMs: 100,
    entryVwap: '100',
    exitVwap: '101',
    boughtQty: '1',
    realizedPnl: '1',
    feesQuote: '0.2',
    netPnl: '0.8',
    meanSlippageBps: null,
    ...over,
  };
}

describe('computeVersionPnlDigest (X8)', () => {
  it('sums net PnL and counts trips per attributed version, exact decimal strings', () => {
    const decisions = [decisionRow(1, 0), decisionRow(2, 50_000)];
    const trips = [
      trip({ openedAt: 1_000, netPnl: '5' }), // before the v2 decision → v1
      trip({ openedAt: 2_000, netPnl: '-2' }), // still before → v1
      trip({ openedAt: 60_000, netPnl: '10.5' }), // after the v2 decision → v2
    ];
    expect(computeVersionPnlDigest(trips, decisions)).toEqual({
      rows: [
        { version: 1, trips: 2, netPnlFeesOnly: '3' },
        { version: 2, trips: 1, netPnlFeesOnly: '10.5' },
      ],
      unattributed: { trips: 0, netPnlFeesOnly: '0' },
    });
  });

  it('sends every trip to unattributed when no versioned decision covers it (pre-stamp/legacy)', () => {
    const trips = [trip({ netPnl: '4' }), trip({ netPnl: '-1' })];
    expect(computeVersionPnlDigest(trips, [])).toEqual({
      rows: [],
      unattributed: { trips: 2, netPnlFeesOnly: '3' },
    });
  });

  it('fails a single trip to unattributed when its symbol has no covering decision, without disturbing the attributed rows (fail-to-unknown, never misattributed)', () => {
    const decisions = [decisionRow(1, 0, 'BTC/USDT')];
    const trips = [
      trip({ symbol: 'BTC/USDT', openedAt: 1_000, netPnl: '6' }),
      trip({ symbol: 'ETH/USDT', openedAt: 1_000, netPnl: '-3' }),
    ];
    expect(computeVersionPnlDigest(trips, decisions)).toEqual({
      rows: [{ version: 1, trips: 1, netPnlFeesOnly: '6' }],
      unattributed: { trips: 1, netPnlFeesOnly: '-3' },
    });
  });

  it('caps the table at the most recent 7 versions when more attribute, dropping the oldest first', () => {
    const decisions = Array.from({ length: 9 }, (_, i) => decisionRow(i + 1, i * 10_000));
    const trips = Array.from({ length: 9 }, (_, i) =>
      trip({ openedAt: i * 10_000 + 5_000, netPnl: String(i + 1) }),
    );
    const digest = computeVersionPnlDigest(trips, decisions);
    expect(digest.rows).toHaveLength(7);
    expect(digest.rows[0]!.version).toBe(3); // versions 1-2 dropped, 3..9 kept
    expect(digest.rows.at(-1)!.version).toBe(9);
  });
});
