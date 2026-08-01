import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, asc, desc, eq, gte, isNotNull, lte, notLike } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { PassiveBenchmarkPort } from '../../../ports/trading/promotion';
import type { TradingMode } from '../../../domain/trading/types/mode';
import {
  timeWeightedAvgGrossExposure,
  type GrossExposureFill,
} from '../../../domain/trading/risk/gross-exposure';
import { distinctBaseAssetRepresentatives } from '../../../domain/venue/types/symbol';
import { DRIZZLE_DB } from '../../database.tokens';
import * as schema from '../../schemas/trading';
import { requireDb } from '../common/persistence-guard';
import { REPLAY_STRATEGY_ID_PREFIX } from '../../../ports/strategy/agentic-strategy';

// Same demo/earned-live evidence mode PromotionReadinessService scopes its own fills read to
// (that file's own DEMO_MODE) — the benchmark must be exposure-matched against the SAME book the
// promotion verdict is judging, never a different mode's fills.
const DEMO_MODE: TradingMode = 'testnet';

const REPLAY_STRATEGY_LIKE = `${REPLAY_STRATEGY_ID_PREFIX}%`;

// FAIL-CLOSED sentinel (2026-08-01, research/studies/success-exit-2026-07-31.md § 6, G4): this
// clause is a veto on a path to LIVE MONEY, and a data gap cannot be allowed to read as "beat the
// basket". Every case this adapter cannot compute (a missing price series, an asset with no usable
// close in the window, an empty/degenerate window, or zero measured exposure) therefore returns
// 'Infinity' rather than null — decimal.js parses it as a genuine (always-larger-than-any-finite-
// netPnl) Decimal, so PromotionReadinessService's `netPnl.lte(passivePnlQuote)` unconditionally
// blocks. Returning null here would instead hit the service's OWN "measurement gap ⇒ drop the
// clause" branch (ports/trading/promotion.ts's PassiveBenchmarkPort doc, pinned by
// promotion-readiness.service.spec.ts's "port returns null" test) — the opposite of what this
// design requires, so null is reserved for a port that is not bound at all, never for a bound one
// that tried and could not compute.
const CANNOT_COMPUTE = 'Infinity';

// PASSIVE_BENCHMARK binding — the benchmark half of the earned-live promotion verdict (see the
// port's own header comment, ports/trading/promotion.ts). Crosses the features/trading/mode-control
// ↔ database boundary the same way PromotionStatsRepository does; only the composition root may
// bind a concrete instance (mode-control cannot import database directly — eslint-plugin-boundaries).
@Injectable()
export class PassiveBenchmarkRepository implements PassiveBenchmarkPort {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
    // AppConfig.strategy.symbols — the configured trading universe (environment.config.ts
    // TRADING_SYMBOLS), passed as a plain array so this class stays ConfigService-free (mirrors
    // PromotionReadinessConfig's own "derived value object, not the service" convention).
    private readonly symbols: readonly string[],
  ) {}

  async passivePnlQuote(fromMs: number, toMs: number): Promise<string | null> {
    if (toMs <= fromMs) return CANNOT_COMPUTE;

    // Basket = equal-weight over DISTINCT UNDERLYING ASSETS, not the raw symbol strings: the
    // universe lists both e.g. 'BTC/USDT' and 'BTC/USDT:USDT', and equal-weighting strings would
    // hold ~12 dual-listed assets twice — not a buy-and-hold benchmark. One representative symbol
    // (the first configured entry) stands in for each distinct base asset.
    const assets = distinctBaseAssetRepresentatives(this.symbols);
    if (assets.length === 0) return CANNOT_COMPUTE;

    const returns: Decimal[] = [];
    for (const symbol of assets) {
      const [entry, exit] = await Promise.all([
        this.closeAtOrAfter(symbol, fromMs),
        this.closeAtOrBefore(symbol, toMs),
      ]);
      // A single asset with no usable price at either end of the window voids the WHOLE basket,
      // not just that asset: silently dropping it would change what "beat the alternative" means
      // without anyone deciding to change it. See CANNOT_COMPUTE's own comment for the direction.
      if (entry === null || exit === null || entry.lte(0)) return CANNOT_COMPUTE;
      returns.push(exit.minus(entry).div(entry));
    }
    const basketReturn = returns
      .reduce((sum, r) => sum.plus(r), new Decimal(0))
      .div(returns.length);

    const fills = await this.fillsThrough(toMs);
    const avgGrossExposureUsd = timeWeightedAvgGrossExposure(fills, fromMs, toMs);
    // Exposure-matched (design § 4): an unmatched full-notional basket would compare a partially-
    // exposed strategy against a 100%-exposed benchmark, flattering the strategy in a drawdown
    // exactly as much as it would punish it in a rally. Zero measured exposure means there is
    // nothing to exposure-match against — CANNOT_COMPUTE, not a benchmark of 0 (which would let
    // ANY positive netPnl silently clear the clause with no basket comparison at all).
    if (avgGrossExposureUsd === null || avgGrossExposureUsd.lte(0)) return CANNOT_COMPUTE;

    return avgGrossExposureUsd.mul(basketReturn).toFixed();
  }

  // First closed 15m bar at-or-after `atMs` — see scripts/loop-forward-return-core.mjs's header for
  // the verified close-at-event_time convention this table-wide read relies on. trigger_kind =
  // 'candle' excludes exec-triggered rows (a fill time is not bar-aligned); strategy_id NOT LIKE
  // 'replay-%' excludes R1 synthetic backfill rows from live price evidence.
  private async closeAtOrAfter(symbol: string, atMs: number): Promise<Decimal | null> {
    const rows = await requireDb(this.db)
      .select({ close: schema.agentDecisions.close })
      .from(schema.agentDecisions)
      .where(
        and(
          eq(schema.agentDecisions.symbol, symbol),
          eq(schema.agentDecisions.triggerKind, 'candle'),
          isNotNull(schema.agentDecisions.close),
          notLike(schema.agentDecisions.strategyId, REPLAY_STRATEGY_LIKE),
          gte(schema.agentDecisions.eventTime, atMs),
        ),
      )
      .orderBy(asc(schema.agentDecisions.eventTime))
      .limit(1);
    const close = rows[0]?.close;
    return close === undefined || close === null ? null : new Decimal(close);
  }

  // Last closed 15m bar at-or-before `atMs` — same predicate as closeAtOrAfter, opposite bound.
  private async closeAtOrBefore(symbol: string, atMs: number): Promise<Decimal | null> {
    const rows = await requireDb(this.db)
      .select({ close: schema.agentDecisions.close })
      .from(schema.agentDecisions)
      .where(
        and(
          eq(schema.agentDecisions.symbol, symbol),
          eq(schema.agentDecisions.triggerKind, 'candle'),
          isNotNull(schema.agentDecisions.close),
          notLike(schema.agentDecisions.strategyId, REPLAY_STRATEGY_LIKE),
          lte(schema.agentDecisions.eventTime, atMs),
        ),
      )
      .orderBy(desc(schema.agentDecisions.eventTime))
      .limit(1);
    const close = rows[0]?.close;
    return close === undefined || close === null ? null : new Decimal(close);
  }

  // Every demo-mode fill from the start of the book through `toMs`, oldest→newest — the exposure
  // fold needs the FULL history (not merely the window) to know the position entering `fromMs`; see
  // timeWeightedAvgGrossExposure's own comment. Same LEFT JOIN as PromotionStatsRepository.fillsForMode
  // (fills carries neither strategyId nor side — resolved through order_intents); an unresolved join
  // surfaces here with side null, which the exposure fold skips rather than guesses.
  private async fillsThrough(toMs: number): Promise<readonly GrossExposureFill[]> {
    return requireDb(this.db)
      .select({
        symbol: schema.fills.symbol,
        side: schema.orderIntents.side,
        qty: schema.fills.qty,
        price: schema.fills.price,
        executedAt: schema.fills.venueTimestamp,
      })
      .from(schema.fills)
      .leftJoin(schema.orderIntents, eq(schema.fills.intentId, schema.orderIntents.intentId))
      .where(and(eq(schema.fills.mode, DEMO_MODE), lte(schema.fills.venueTimestamp, toMs)))
      .orderBy(asc(schema.fills.venueTimestamp), asc(schema.fills.fillId));
  }
}
