import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, asc, desc, and, gte, sum, type SQL } from 'drizzle-orm';
import type { TradingMode } from '../../domain/types/mode';
import type {
  PromotionStatsPort,
  PromotionFillRow,
  LlmTokenTotals,
  PerModelTokenTotals,
} from '../../ports/promotion';
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

  async fillsForMode(mode: TradingMode, sinceMs?: number): Promise<readonly PromotionFillRow[]> {
    // venue_timestamp is a bigint (epoch ms) column — the epoch filter compares against the raw
    // number, not a Date. Absent sinceMs ⇒ mode-only predicate (all-time).
    const modePredicate = eq(schema.fills.mode, mode);
    const where: SQL | undefined =
      sinceMs === undefined
        ? modePredicate
        : and(modePredicate, gte(schema.fills.venueTimestamp, sinceMs));
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
      .where(where)
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

  async llmTokenTotals(sinceMs?: number): Promise<LlmTokenTotals> {
    const db = requireDb(this.db);
    const since = sinceMs === undefined ? undefined : new Date(sinceMs);
    const decideWhere =
      since === undefined ? undefined : gte(schema.agentDecisions.createdAt, since);
    const reflectionWhere =
      since === undefined
        ? eq(schema.llmUsage.kind, 'reflection')
        : and(eq(schema.llmUsage.kind, 'reflection'), gte(schema.llmUsage.createdAt, since));

    const [decideRows, reflectionRows] = await Promise.all([
      db
        .select({
          model: schema.agentDecisions.model,
          inputTokens: schema.agentDecisions.inputTokens,
          outputTokens: schema.agentDecisions.outputTokens,
          cacheReadInputTokens: schema.agentDecisions.cacheReadInputTokens,
          cacheCreationInputTokens: schema.agentDecisions.cacheCreationInputTokens,
        })
        .from(schema.agentDecisions)
        .where(decideWhere),
      db
        .select({
          model: schema.llmUsage.model,
          inputTokens: schema.llmUsage.inputTokens,
          outputTokens: schema.llmUsage.outputTokens,
          cacheReadInputTokens: schema.llmUsage.cacheReadInputTokens,
          cacheCreationInputTokens: schema.llmUsage.cacheCreationInputTokens,
        })
        .from(schema.llmUsage)
        .where(reflectionWhere),
    ]);

    // Accumulate BOTH call sites into one per-model map — a lane running a cheap decide model + a
    // pricier reflection model must be costed at each model's own rates.
    const byModel = new Map<string, PerModelTokenTotals>();
    const fold = (
      model: string,
      input: number | null,
      output: number | null,
      cacheRead: number | null,
      cacheCreation: number | null,
    ): void => {
      const prev = byModel.get(model) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      byModel.set(model, {
        model,
        inputTokens: prev.inputTokens + (input ?? 0),
        outputTokens: prev.outputTokens + (output ?? 0),
        cacheReadTokens: prev.cacheReadTokens + (cacheRead ?? 0),
        cacheCreationTokens: prev.cacheCreationTokens + (cacheCreation ?? 0),
      });
    };
    for (const r of decideRows) {
      fold(
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadInputTokens,
        r.cacheCreationInputTokens,
      );
    }
    for (const r of reflectionRows) {
      fold(
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadInputTokens,
        r.cacheCreationInputTokens,
      );
    }

    return { perModel: [...byModel.values()] };
  }

  // P5b: Σ funding_payments.amount_quote for mode (sinceMs-scoped like fillsForMode above).
  // hasRows distinguishes "ingested rows that happen to net to zero" from "nothing ingested" —
  // PromotionReadinessService's fail-open missing-data flag depends on that distinction, not the
  // netQuote value alone (SUM() over zero matching rows is SQL NULL, not '0').
  async fundingNetForMode(
    mode: TradingMode,
    sinceMs?: number,
  ): Promise<{ readonly netQuote: string; readonly hasRows: boolean }> {
    const modePredicate = eq(schema.fundingPayments.mode, mode);
    const where: SQL | undefined =
      sinceMs === undefined
        ? modePredicate
        : and(modePredicate, gte(schema.fundingPayments.fundingTime, sinceMs));
    const rows = await requireDb(this.db)
      .select({ net: sum(schema.fundingPayments.amountQuote) })
      .from(schema.fundingPayments)
      .where(where);
    const net = rows[0]?.net;
    return { netQuote: net ?? '0', hasRows: net !== null && net !== undefined };
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
