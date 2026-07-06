import Decimal from 'decimal.js';
import type {
  PromotionStatsPort,
  ReflectionTriggerSeed,
  RoundTripEvidence,
  RoundTripEvidencePort,
} from '../../../ports/promotion';
import { walkRoundTrips, type ClosedRoundTrip } from '../../../domain/risk/round-trips';

const DEMO_MODE = 'testnet' as const;

// Realized round-trip evidence for reflection: replays the SAME fills + dust-closure walk the
// earned-live promotion verdict uses (one closure rule, two consumers), then maps the most recent
// cycles into decimal-string rows for the reflection prompt. A plain class (no Nest decorators) —
// the composition root constructs it inside the DB-only agentic bridge factory over the same
// PromotionStatsPort binding the readiness service consumes.
export class RoundTripEvidenceReader implements RoundTripEvidencePort {
  constructor(
    private readonly stats: PromotionStatsPort,
    // Same knob as the promotion verdict (PROMOTION_DUST_NOTIONAL) so "closed" means the same
    // thing in both places.
    private readonly dustNotional: string,
  ) {}

  async recentRoundTrips(limit: number): Promise<readonly RoundTripEvidence[]> {
    if (limit <= 0) return []; // slice(-0) would return everything
    const fills = await this.stats.fillsForMode(DEMO_MODE);
    const { cycles } = walkRoundTrips(fills, new Decimal(this.dustNotional));
    return cycles.slice(-limit).map(toEvidence);
  }

  // Durable trigger state: total closed demo round trips, and how many closed after the last
  // reflection attempt that reached the API. latestReflectionAt is an optional port method —
  // absent reads as "never reflected", which counts every closed trip as pending. strategyId (P7)
  // scopes the counts to one instance's cycles; closedTradesTotal stays LANE-WIDE either way (it
  // floors the auto-promotion gate, which guards the lane-global playbook).
  async reflectionSeed(strategyId?: string): Promise<ReflectionTriggerSeed> {
    const [fills, lastReflectionAt] = await Promise.all([
      this.stats.fillsForMode(DEMO_MODE),
      this.stats.latestReflectionAt?.() ?? Promise.resolve(null),
    ]);
    const { cycles } = walkRoundTrips(fills, new Decimal(this.dustNotional));
    const scoped =
      strategyId === undefined ? cycles : cycles.filter((c) => c.strategyId === strategyId);
    const closedSinceLastReflection =
      lastReflectionAt === null
        ? scoped.length
        : scoped.filter((c) => c.closedAt > lastReflectionAt).length;
    return {
      closedTradesTotal: cycles.length,
      closedSinceLastReflection,
      lastReflectionAt,
    };
  }
}

function toEvidence(c: ClosedRoundTrip): RoundTripEvidence {
  return {
    strategyId: c.strategyId,
    symbol: c.symbol,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    holdingMs: c.closedAt - c.openedAt,
    entryVwap: c.entryVwap === null ? null : c.entryVwap.toFixed(),
    exitVwap: c.exitVwap === null ? null : c.exitVwap.toFixed(),
    boughtQty: c.boughtQty.toFixed(),
    realizedPnl: c.realizedPnl.toFixed(),
    feesQuote: c.feesQuote.toFixed(),
    netPnl: c.realizedPnl.minus(c.feesQuote).toFixed(),
    meanSlippageBps: c.meanSlippageBps === null ? null : c.meanSlippageBps.toFixed(2),
  };
}
