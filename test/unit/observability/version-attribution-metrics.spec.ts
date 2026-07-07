import { describe, it, expect, vi } from 'vitest';
import { VersionAttributionMetricsService } from '../../../src/features/common/observability/version-attribution-metrics.service';
import type { PromotionFillRow, PromotionStatsPort } from '../../../src/ports/promotion';
import type {
  AgentDecisionJournalPort,
  AgentDecisionRow,
} from '../../../src/ports/agentic-strategy';
import type { TypedConfigService } from '../../../src/config/environment/typed-config.service';
import type { StrategyId, SymbolId, VenueId, EpochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;

function fill(over: Partial<PromotionFillRow>): PromotionFillRow {
  return {
    strategyId: 'agentic-1',
    symbol: 'BTC/USDT',
    side: 'BUY',
    qty: '0.001',
    price: '50000',
    fee: '0.05',
    feeAsset: 'USDT',
    executedAt: T,
    ...over,
  };
}

function decision(over: Partial<AgentDecisionRow>): AgentDecisionRow {
  return {
    strategyId: 'agentic-1' as StrategyId,
    symbol: 'BTC/USDT' as SymbolId,
    venue: 'binance' as VenueId,
    triggerKind: 'candle',
    basedOnSeq: 1n,
    eventTime: T as EpochMs,
    model: 'test',
    action: 'long',
    confidence: 0.8,
    rationale: '',
    refPrice: null,
    close: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    playbookVersion: 1,
    promptHash: 'h',
    inputPayload: null,
    id: '1',
    createdAt: T as EpochMs,
    ...over,
  };
}

interface GaugeFake {
  set: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

function gaugeFake(): GaugeFake {
  return { set: vi.fn(), reset: vi.fn() };
}

function service(
  fills: readonly PromotionFillRow[],
  decisions: readonly AgentDecisionRow[],
): { svc: VersionAttributionMetricsService; net: GaugeFake; trips: GaugeFake } {
  const net = gaugeFake();
  const trips = gaugeFake();
  const stats: PromotionStatsPort = {
    fillsForMode: () => Promise.resolve(fills),
    llmTokenTotals: () =>
      Promise.resolve({
        decideInputTokens: 0,
        decideOutputTokens: 0,
        reflectionInputTokens: 0,
        reflectionOutputTokens: 0,
      }),
  };
  const journal: AgentDecisionJournalPort = {
    record: () => undefined,
    recent: () => Promise.resolve(decisions),
  };
  const config = { agentic: { promotionDustNotional: '5' } } as unknown as TypedConfigService;
  const svc = new VersionAttributionMetricsService(
    net as never,
    trips as never,
    config,
    stats,
    journal,
  );
  return { svc, net, trips };
}

describe('VersionAttributionMetricsService', () => {
  it('attributes a round trip to the version active at ENTRY, across a promotion boundary', async () => {
    // Entry decided under v1 at T; v2 promoted at T+1000; exit fills at T+2000 — still v1's trade.
    const fills = [
      fill({ side: 'BUY', executedAt: T }),
      fill({ side: 'SELL', price: '51000', executedAt: T + 2000 }),
    ];
    const decisions = [
      decision({ eventTime: T as EpochMs, playbookVersion: 1, id: '1' }),
      decision({ eventTime: (T + 1000) as EpochMs, playbookVersion: 2, id: '2' }),
    ];
    const { svc, net, trips } = service(fills, decisions);

    await svc.tick();

    expect(trips.set).toHaveBeenCalledWith({ version: '1' }, 1);
    expect(net.set).toHaveBeenCalledTimes(1);
    // realized 0.001×(51000−50000)=1 gross, minus 0.05+0.05 quote fees = 0.9 exactly.
    expect(net.set).toHaveBeenCalledWith({ version: '1' }, 0.9);
  });

  it("labels 'unknown' when no decision precedes the entry, and resets stale labels each tick", async () => {
    const fills = [
      fill({ side: 'BUY', executedAt: T }),
      fill({ side: 'SELL', price: '50500', executedAt: T + 1000 }),
    ];
    const decisions = [decision({ eventTime: (T + 5000) as EpochMs, playbookVersion: 3 })];
    const { svc, net, trips } = service(fills, decisions);

    await svc.tick();

    expect(net.reset).toHaveBeenCalled();
    expect(trips.reset).toHaveBeenCalled();
    expect(trips.set).toHaveBeenCalledWith({ version: 'unknown' }, 1);
  });

  it('no-ops on empty data without setting any series', async () => {
    const { svc, net, trips } = service([], []);

    await svc.tick();

    expect(net.set).not.toHaveBeenCalled();
    expect(trips.set).not.toHaveBeenCalled();
  });
});
