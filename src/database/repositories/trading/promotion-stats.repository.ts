import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  eq,
  ne,
  asc,
  desc,
  and,
  gte,
  lte,
  isNotNull,
  max,
  not,
  notLike,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import type { TradingMode } from '../../../domain/trading/types/mode';
import { DEGRADED_DECIDE_RATIONALE_TAGS } from '../../../domain/strategy/types/decide-rationale';
import type {
  PromotionStatsPort,
  PromotionFillRow,
  LlmTokenTotals,
  PerModelTokenTotals,
} from '../../../ports/trading/promotion';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';
import { REPLAY_STRATEGY_ID_PREFIX } from '../../../ports/strategy/agentic-strategy';

// SQL LIKE pattern for R1 synthetic (replay-<runId>) strategyIds — excluded from epoch cost below.
const REPLAY_STRATEGY_LIKE = `${REPLAY_STRATEGY_ID_PREFIX}%`;

// Newest created_at in a materialised rowset, null when it is empty. Reduce, not Math.max(...spread):
// these folds routinely carry tens of thousands of rows, which is argument-count territory.
function latestCreatedAt(rows: readonly { readonly createdAt: Date }[]): number | null {
  return rows.reduce<number | null>((latest, r) => {
    const ms = r.createdAt.getTime();
    return latest === null || ms > latest ? ms : latest;
  }, null);
}

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

  // EVIDENCE fold — replay excluded. Feeds the promotion verdict's llmCostUsd.
  //
  // AS-OF CAP (defect 150). This is the promotion gate's LARGEST cost term ($30.62 against a
  // -$70.24 net on the 2026-08-04 sample) and it had no upper bound at all: the returned set was a
  // function of WHEN the query ran, so two evaluations seconds apart cover different rows under one
  // published windowDays and a recorded verdict cannot be re-derived. asOfMs restores that —
  // agent_decisions.created_at and llm_usage.created_at are immutable under the append-only
  // hardening, so `created_at <= asOfMs` pins a reproducible row set (with the same defaultNow()
  // caveat fundingNetForMode documents below: created_at is transaction START time, so a
  // transaction spanning the read can land a row under the watermark the read never saw).
  //
  // THE LIVE GATE MUST NOT PASS asOfMs, for the same reason fundingNetForMode's must not: narrowing
  // a COST window drops spend and inflates netPnl, the wrong direction for a live-arming gate.
  // Undefined asOfMs ⇒ every row through read time ⇒ the widest, most conservative read. It exists
  // for the audit re-derivation path — "what did the gate see at T", never "may this lane arm".
  async llmTokenTotals(sinceMs?: number, asOfMs?: number): Promise<LlmTokenTotals> {
    return this.tokenTotals(sinceMs, false, asOfMs);
  }

  // SPEND fold — replay INCLUDED. Feeds the daily cost breaker only. A replay run bills the same
  // Anthropic account as a live decide, so a cap that cannot see those dollars is not a cap; the
  // evidence fold above must still never see them, because one unfiltered run outweighs a lane's
  // whole 14-day budget and would poison netPnl. Two folds, two truths, one query.
  async llmSpendTotalsAllSources(sinceMs?: number): Promise<LlmTokenTotals> {
    return this.tokenTotals(sinceMs, true);
  }

  private async tokenTotals(
    sinceMs: number | undefined,
    includeReplay: boolean,
    asOfMs?: number,
  ): Promise<LlmTokenTotals> {
    const db = requireDb(this.db);
    const since = sinceMs === undefined ? undefined : new Date(sinceMs);
    const asOf = asOfMs === undefined ? undefined : new Date(asOfMs);
    // R1 cost exclusion (BY FILTER): synthetic replay-<runId> decide rows must NEVER enter the lane's
    // epoch token cost — one unfiltered replay run exceeds a lane's 14-day breaker budget and poisons
    // netPnl. The reflection llm_usage side needs no such filter: the R1 engine writes no llm_usage
    // rows at all (replay decides ride agent_decisions only), so that half is excluded by construction.
    // Predicate ARRAYS rather than the previous nested ternaries: the as-of cap (defect 150) makes
    // three independent optional predicates per side, which a ternary chain cannot express readably.
    const decidePredicates: SQL[] = [];
    if (!includeReplay) {
      decidePredicates.push(notLike(schema.agentDecisions.strategyId, REPLAY_STRATEGY_LIKE));
    }
    if (since !== undefined) decidePredicates.push(gte(schema.agentDecisions.createdAt, since));
    if (asOf !== undefined) decidePredicates.push(lte(schema.agentDecisions.createdAt, asOf));
    const reflectionPredicates: SQL[] = [eq(schema.llmUsage.kind, 'reflection')];
    if (since !== undefined) reflectionPredicates.push(gte(schema.llmUsage.createdAt, since));
    if (asOf !== undefined) reflectionPredicates.push(lte(schema.llmUsage.createdAt, asOf));

    const [decideRows, reflectionRows] = await Promise.all([
      db
        .select({
          model: schema.agentDecisions.model,
          inputTokens: schema.agentDecisions.inputTokens,
          outputTokens: schema.agentDecisions.outputTokens,
          cacheReadInputTokens: schema.agentDecisions.cacheReadInputTokens,
          cacheCreationInputTokens: schema.agentDecisions.cacheCreationInputTokens,
          createdAt: schema.agentDecisions.createdAt,
        })
        .from(schema.agentDecisions)
        .where(and(...decidePredicates)),
      db
        .select({
          model: schema.llmUsage.model,
          inputTokens: schema.llmUsage.inputTokens,
          outputTokens: schema.llmUsage.outputTokens,
          cacheReadInputTokens: schema.llmUsage.cacheReadInputTokens,
          cacheCreationInputTokens: schema.llmUsage.cacheCreationInputTokens,
          createdAt: schema.llmUsage.createdAt,
        })
        .from(schema.llmUsage)
        .where(and(...reflectionPredicates)),
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

    // Watermark of the fold (defect 150): folded in JS off the created_at already projected above
    // rather than by two extra MAX() round trips — the rows are materialised here regardless.
    const watermarks = [latestCreatedAt(decideRows), latestCreatedAt(reflectionRows)].filter(
      (ms): ms is number => ms !== null,
    );
    return {
      perModel: [...byModel.values()],
      countedThroughMs: watermarks.length === 0 ? null : Math.max(...watermarks),
    };
  }

  // P5b: Σ funding_payments.amount_quote for mode (sinceMs-scoped like fillsForMode above).
  // hasRows distinguishes "ingested rows that happen to net to zero" from "nothing ingested" —
  // PromotionReadinessService's fail-open missing-data flag depends on that distinction, not the
  // netQuote value alone (SUM() over zero matching rows is SQL NULL, not '0').
  //
  // AS-OF CAP. funding_time is the venue's MARKET instant; created_at is when the hourly poller
  // wrote the row. Measured on the live journal 2026-08-04 (n=54): median ingest lag 48 min, p95
  // 30.7 h, max 4.81 days (first-ever backfill and host-sleep catch-up bursts are the tail). With
  // no created_at bound the returned set is a function of WHEN the query runs, not of its
  // arguments: the 2026-08-03T16:07Z gate sample read -0.74678358 over 50 rows and the identical
  // query re-read -0.77918708 over 53 rows eight hours later. asOfMs restores re-derivation —
  // created_at is immutable (0001_v3_append_only_hardening.sql funding_payments_immutable) and a
  // batch INSERT shares one transaction timestamp, so `created_at <= asOfMs` pins an exactly
  // reproducible row set — with one caveat: created_at is defaultNow() (transaction START time, not
  // commit time), so a transaction that begins before a read and commits after can land a row whose
  // created_at <= watermark the read never actually saw. Theoretical against the current single
  // short batched-insert writer, but not a hard guarantee.
  //
  // THE LIVE GATE MUST NOT PASS asOfMs. This book PAYS funding net (-0.78038125 over 54 rows: 36
  // payments totalling -1.18451127 against 18 receipts totalling +0.40413002), so NARROWING the
  // window drops a COST and inflates netPnl. Undefined asOfMs ⇒ every ingested row ⇒ the widest and
  // therefore most conservative read. asOfMs has no caller yet — it exists for the audit
  // re-derivation path, so a future caller passing it is asking "what did the gate see at T", never
  // "may this lane arm". promotion-readiness.service.ts:79 passes two arguments and must keep
  // passing two.
  //
  // ingestedThroughMs is the watermark of the returned set (max created_at, null when empty) so a
  // recorded verdict is self-describing: replaying it as asOfMs reproduces this exact sum.
  async fundingNetForMode(
    mode: TradingMode,
    sinceMs?: number,
    asOfMs?: number,
  ): Promise<{
    readonly netQuote: string;
    readonly hasRows: boolean;
    readonly ingestedThroughMs: number | null;
  }> {
    const predicates: SQL[] = [eq(schema.fundingPayments.mode, mode)];
    if (sinceMs !== undefined) {
      predicates.push(gte(schema.fundingPayments.fundingTime, sinceMs));
    }
    if (asOfMs !== undefined) {
      predicates.push(lte(schema.fundingPayments.createdAt, new Date(asOfMs)));
    }
    const rows = await requireDb(this.db)
      .select({
        net: sum(schema.fundingPayments.amountQuote),
        ingestedThrough: max(schema.fundingPayments.createdAt),
      })
      .from(schema.fundingPayments)
      .where(and(...predicates));
    const net = rows[0]?.net;
    const ingestedThrough = rows[0]?.ingestedThrough ?? null;
    return {
      netQuote: net ?? '0',
      hasRows: net !== null && net !== undefined,
      ingestedThroughMs: ingestedThrough === null ? null : ingestedThrough.getTime(),
    };
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

  // WATCH-V4-8 boot seed for agent_last_success_timestamp_seconds — see the port's own comment for
  // why prompt_hash/latency_ms are the predicate rather than the action/rationale text. The replay
  // exclusion is the same one tokenTotals applies BY FILTER above: an R1 `replay-<runId>` backfill
  // writes agent_decisions rows carrying both fields, and a backfill must never make a dead lane
  // read fresh. The degrade-tag exclusion is the other half of the same discipline: a post-200
  // degrade carries hash+latency too, so hash+latency alone would count "the model answered with
  // something unusable" as liveness (see DEGRADED_DECIDE_RATIONALE_TAGS). starts_with(), not NOT
  // LIKE: every tag contains an underscore, which LIKE reads as a single-character wildcard, so
  // 'schema_rejected:%' would also exclude a thesis opening 'schema rejected: …'.
  // created_at (DB wall clock), not event_time (the market snapshot's bar-open instant, stale by up
  // to a bar by construction) — same choice latestReflectionAt makes.
  // Verified against the live journal 2026-07-29: 575 of 22,873 rows match (660 before the degrade
  // exclusion, 85 of which were schema_rejected holds), newest 2026-07-27T20:15:31Z — a genuine model
  // hold, so the seeded instant is unchanged by the exclusion — 0 replay rows.
  async lastSuccessfulDecideAt(): Promise<number | null> {
    const rows = await requireDb(this.db)
      .select({ createdAt: schema.agentDecisions.createdAt })
      .from(schema.agentDecisions)
      .where(
        and(
          ne(schema.agentDecisions.promptHash, ''),
          isNotNull(schema.agentDecisions.latencyMs),
          notLike(schema.agentDecisions.strategyId, REPLAY_STRATEGY_LIKE),
          ...DEGRADED_DECIDE_RATIONALE_TAGS.map((tag) =>
            not(sql`starts_with(${schema.agentDecisions.rationale}, ${tag})`),
          ),
        ),
      )
      .orderBy(desc(schema.agentDecisions.createdAt), desc(schema.agentDecisions.id))
      .limit(1);
    const first = rows[0];
    return first === undefined ? null : first.createdAt.getTime();
  }
}
