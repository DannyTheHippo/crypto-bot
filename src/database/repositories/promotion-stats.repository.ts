import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, asc, desc } from 'drizzle-orm';
import type { TradingMode } from '../../domain/types/mode';
import type { PromotionStatsPort, PromotionFillRow, LlmTokenTotals } from '../../ports/promotion';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';

// PROMOTION_STATS binding (mode-control ↔ persistence boundary crossing — see src/ports/promotion.ts's
// own header comment). fills carries neither strategyId nor side (see trading.schema.ts), so both are
// resolved via a LEFT JOIN onto order_intents through fills.intent_id — LEFT, not INNER, so a fill
// whose intent_id is unresolved still surfaces (with strategyId/side null) instead of silently
// vanishing from the round-trip walk; PromotionReadinessService turns that into the fail-closed
// UNRESOLVED_FILL reason rather than a corrupted position count.
@Injectable()
export class PromotionStatsRepository implements PromotionStatsPort {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async fillsForMode(mode: TradingMode): Promise<readonly PromotionFillRow[]> {
    const rows = await requireDb(this.db)
      .select({
        strategyId: schema.orderIntents.strategyId,
        symbol: schema.fills.symbol,
        side: schema.orderIntents.side,
        qty: schema.fills.qty,
        price: schema.fills.price,
        fee: schema.fills.feeAmount,
        feeAsset: schema.fills.feeCcy,
        executedAt: schema.fills.venueTimestamp,
        refPrice: schema.orderIntents.refPrice,
        fillId: schema.fills.fillId,
      })
      .from(schema.fills)
      .leftJoin(schema.orderIntents, eq(schema.fills.intentId, schema.orderIntents.intentId))
      .where(eq(schema.fills.mode, mode))
      // executedAt (venue_timestamp) ordering, fillId (identity PK) as the same-millisecond
      // tiebreak — mirrors EquityRepository's own id-tiebreak convention.
      .orderBy(asc(schema.fills.venueTimestamp), asc(schema.fills.fillId));

    return rows.map((r) => ({
      strategyId: r.strategyId,
      symbol: r.symbol,
      side: r.side,
      qty: r.qty,
      price: r.price,
      fee: r.fee,
      feeAsset: r.feeAsset,
      executedAt: r.executedAt,
      refPrice: r.refPrice,
    }));
  }

  async llmTokenTotals(): Promise<LlmTokenTotals> {
    const db = requireDb(this.db);
    const [decideRows, reflectionRows] = await Promise.all([
      db
        .select({
          inputTokens: schema.agentDecisions.inputTokens,
          outputTokens: schema.agentDecisions.outputTokens,
        })
        .from(schema.agentDecisions),
      db
        .select({
          inputTokens: schema.llmUsage.inputTokens,
          outputTokens: schema.llmUsage.outputTokens,
        })
        .from(schema.llmUsage)
        .where(eq(schema.llmUsage.kind, 'reflection')),
    ]);

    let decideInputTokens = 0;
    let decideOutputTokens = 0;
    for (const row of decideRows) {
      decideInputTokens += row.inputTokens ?? 0;
      decideOutputTokens += row.outputTokens ?? 0;
    }

    let reflectionInputTokens = 0;
    let reflectionOutputTokens = 0;
    for (const row of reflectionRows) {
      reflectionInputTokens += row.inputTokens;
      reflectionOutputTokens += row.outputTokens;
    }

    return { decideInputTokens, decideOutputTokens, reflectionInputTokens, reflectionOutputTokens };
  }

  // Newest reflection-path usage row = the last reflection attempt that actually reached the API
  // (usage is recorded only after a parsed response). Feeds the reflection trigger seed so a
  // redeploy resumes the cadence instead of resetting it.
  async latestReflectionAt(): Promise<number | null> {
    const rows = await requireDb(this.db)
      .select({ createdAt: schema.llmUsage.createdAt })
      .from(schema.llmUsage)
      .where(eq(schema.llmUsage.kind, 'reflection'))
      .orderBy(desc(schema.llmUsage.createdAt), desc(schema.llmUsage.id))
      .limit(1);
    const first = rows[0];
    return first === undefined ? null : first.createdAt.getTime();
  }
}
