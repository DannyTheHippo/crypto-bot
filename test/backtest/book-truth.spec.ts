import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { writeFileSync } from 'node:fs';
import { walkRoundTrips, sumFeesQuote } from '../../src/domain/trading/risk/round-trips';
import type { RoundTripFill } from '../../src/domain/trading/risk/round-trips';
import { partitionFillsIntoCycles } from './live-frame';

// ── Book truth (R9) ───────────────────────────────────────────────────────────
//
// Study: research/studies/book-truth-2026-08-04.md.
//
// Recomputes the atomic book tuple the record quotes — roundTrips / windowDays / netPnlUsd /
// llmCostUsd / winRate — from raw rows, under the PRODUCTION definitions, so that every later
// write-up cites one measured ledger rather than a remembered one.
//
// TWO round-trip walks run here, deliberately:
//
//   1. `walkRoundTrips` IMPORTED from src/domain/trading/risk/round-trips.ts — the same fold the
//      promotion gate runs. This is the TRUTH. Its cycle boundaries are never re-derived.
//   2. A pure-SQL window-function walk (running signed qty per (strategy_id, symbol); a row is a
//      close when residual notional < dust). This is a SECOND IMPLEMENTATION of a boundary rule,
//      which is exactly what the corpus-fingerprint lesson forbids for an IDENTITY function
//      (`research/studies/corpus-fingerprint-drift-correction-2026-08-03.md`: "a reimplemented hash
//      is a second source of truth — import it or do not compute it"). It is the right tool HERE
//      because the purpose is an AUDIT, not an identity: the SQL is a probe whose disagreements
//      with the production walk are the measurement. Where they differ the production walk is the
//      answer and the SQL is wrong by construction — it cannot carry the stateful `peakNotional`
//      guard (round-trips.ts:68-75, added after the 2026-07-27 BCH incident minted a −10,004 bps
//      phantom trip) and it cannot reset the running position at a close, so its residual dust
//      carries forward where production drops it.
//
// Gated like the sibling live evals: BOOK_TRUTH=1 + DATABASE_URL, self-skips otherwise, so a clean
// clone stays green and this never joins the production gate. Read-only: SELECT only, no write, no
// reset, no migration.

const RUN = process.env['BOOK_TRUTH'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const OUT_FILE = process.env['BOOK_TRUTH_OUTPUT_FILE'];
// Optional as-of cap (epoch ms) so a historical tuple can be reproduced at the instant it was
// sampled; absent ⇒ the whole book as of now.
const AS_OF_MS = process.env['BOOK_TRUTH_AS_OF_MS'];

const EPOCH_MS = 1_784_632_860_000; // PROMOTION_EVIDENCE_EPOCH = 2026-07-21T11:21:00Z
const DUST_NOTIONAL = '5'; // PROMOTION_DUST_NOTIONAL
const DEMO_MODE = 'testnet';
const DAY_MS = 24 * 60 * 60 * 1000;

// AGENTIC_TOKEN_PRICES_JSON as deployed (.env.app:171), plus the flat AGENTIC_TOKEN_PRICE_*
// defaults (.env.app:165-168). An UNKNOWN model resolves to the component-wise MAX across the
// defaults and every mapped entry — PromotionReadinessService.ratesFor's fail-closed fallback
// (promotion-readiness.service.ts:176-220), reproduced here so the recomputed llmCostUsd is the
// service's own number and not a cheaper one.
const TOKEN_PRICES: Record<
  string,
  { input: string; output: string; cacheRead: string; cacheWrite: string }
> = {
  'claude-sonnet-5': { input: '3', output: '15', cacheRead: '0.3', cacheWrite: '6' },
  'claude-opus-5': { input: '5', output: '25', cacheRead: '0.5', cacheWrite: '10' },
};
const FLAT_DEFAULTS = { input: '3', output: '15', cacheRead: '0.3', cacheWrite: '6' };
const MTOK = new Decimal(1_000_000);

function ratesFor(model: string): {
  input: Decimal;
  output: Decimal;
  cacheRead: Decimal;
  cacheWrite: Decimal;
} {
  const entry = TOKEN_PRICES[model];
  const pools = [FLAT_DEFAULTS, ...Object.values(TOKEN_PRICES)];
  const pick = entry ?? {
    input: pools.reduce((m, p) => (Number(p.input) > Number(m) ? p.input : m), '0'),
    output: pools.reduce((m, p) => (Number(p.output) > Number(m) ? p.output : m), '0'),
    cacheRead: pools.reduce((m, p) => (Number(p.cacheRead) > Number(m) ? p.cacheRead : m), '0'),
    cacheWrite: pools.reduce((m, p) => (Number(p.cacheWrite) > Number(m) ? p.cacheWrite : m), '0'),
  };
  return {
    input: new Decimal(pick.input),
    output: new Decimal(pick.output),
    cacheRead: new Decimal(pick.cacheRead),
    cacheWrite: new Decimal(pick.cacheWrite),
  };
}

type BookFill = RoundTripFill & { readonly fillId: string; readonly venue: string };

function median(xs: readonly Decimal[]): Decimal | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? s[mid - 1]!.plus(s[mid]!).div(2) : s[mid]!;
}

function quantile(xs: readonly Decimal[], q: number): Decimal | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[idx]!;
}

describe.skipIf(!RUN || !DB_URL)(
  'book-truth: the atomic book tuple, recomputed from raw rows',
  () => {
    it('recomputes roundTrips / windowDays / netPnl / llmCost / winRate and audits the cycle boundaries', async () => {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: DB_URL });
      const lines: string[] = [];
      const capMs = AS_OF_MS === undefined ? null : Number(AS_OF_MS);
      try {
        // Mirrors PromotionStatsRepository.fillsForMode verbatim (same LEFT JOIN, same predicate,
        // same venue_timestamp + fill_id ordering), plus fill_id/venue for the boundary audit.
        const fillsRes = await pool.query<{
          fill_id: string;
          strategy_id: string | null;
          symbol: string;
          venue: string;
          side: 'BUY' | 'SELL' | null;
          qty: string;
          price: string;
          fee_amount: string | null;
          fee_ccy: string | null;
          venue_timestamp: string;
          ref_price: string | null;
        }>(
          `SELECT f.fill_id, oi.strategy_id, f.symbol, f.venue, oi.side, f.qty, f.price,
                f.fee_amount, f.fee_ccy, f.venue_timestamp, oi.ref_price
           FROM fills f
           LEFT JOIN order_intents oi ON f.intent_id = oi.intent_id
          WHERE f.mode = $1 AND f.venue_timestamp >= $2
            AND ($3::bigint IS NULL OR f.venue_timestamp <= $3::bigint)
          ORDER BY f.venue_timestamp ASC, f.fill_id ASC`,
          [DEMO_MODE, EPOCH_MS, capMs],
        );

        const fills: BookFill[] = fillsRes.rows.map((r) => ({
          fillId: r.fill_id,
          strategyId: r.strategy_id,
          symbol: r.symbol,
          venue: r.venue,
          side: r.side,
          qty: r.qty,
          price: r.price,
          fee: r.fee_amount,
          feeAsset: r.fee_ccy,
          executedAt: Number(r.venue_timestamp),
          refPrice: r.ref_price,
        }));

        // ── Epoch-straddle bound ────────────────────────────────────────────────
        // A cycle whose OPENING fills predate the epoch loses its cost basis to the epoch-bounded
        // fill window. The bound is measured, not assumed: count demo fills strictly before the
        // epoch. Zero such fills ⇒ zero straddling cycles ⇒ the band on this tuple is exactly zero.
        const preEpoch = await pool.query<{ n: string; first_ts: string | null }>(
          `SELECT count(*)::text AS n,
                to_char(to_timestamp(min(venue_timestamp)/1000.0) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SSZ') AS first_ts
           FROM fills WHERE mode = $1 AND venue_timestamp < $2`,
          [DEMO_MODE, EPOCH_MS],
        );
        const preEpochFills = Number(preEpoch.rows[0]!.n);

        const dustNotional = new Decimal(DUST_NOTIONAL);
        const { cycles, unconvertibleFeeAsset } = walkRoundTrips(fills, dustNotional);
        expect(cycles.length).toBeGreaterThan(0);

        const parts = partitionFillsIntoCycles(fills, cycles, dustNotional);

        // ── Walk 2: the pure-SQL probe ──────────────────────────────────────────
        // Running signed qty per (strategy_id, symbol); a row CLOSES when residual notional
        // (|running qty| × that fill's own price) drops below dust. No peakNotional guard and no
        // reset — the two ways it is knowingly wrong, and the two shapes the diff below localises.
        const sqlRes = await pool.query<{
          fill_id: string;
          strategy_id: string;
          symbol: string;
          residual: string;
          closes: boolean;
        }>(
          `WITH src AS (
           SELECT f.fill_id, oi.strategy_id, f.symbol, oi.side, f.qty, f.price, f.venue_timestamp
             FROM fills f
             JOIN order_intents oi ON f.intent_id = oi.intent_id
            WHERE f.mode = $1 AND f.venue_timestamp >= $2
              AND ($3::bigint IS NULL OR f.venue_timestamp <= $3::bigint)
         ), run AS (
           SELECT src.*,
                  SUM(CASE WHEN side = 'BUY' THEN qty ELSE -qty END) OVER (
                    PARTITION BY strategy_id, symbol
                    ORDER BY venue_timestamp ASC, fill_id ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_qty
             FROM src
         )
         SELECT fill_id::text, strategy_id, symbol,
                (abs(running_qty) * price)::text AS residual,
                (abs(running_qty) * price < $4::numeric) AS closes
           FROM run
          ORDER BY strategy_id, symbol, venue_timestamp ASC, fill_id ASC`,
          [DEMO_MODE, EPOCH_MS, capMs, DUST_NOTIONAL],
        );

        const sqlCloseIds = new Set(sqlRes.rows.filter((r) => r.closes).map((r) => r.fill_id));

        // ── Boundary diff, fill by fill ─────────────────────────────────────────
        // The production walk's closing fill for each cycle is the LAST member of its partition.
        // Any disagreement is localised to a named fill, never reported as an aggregate count.
        const prodCloseIds = new Set<string>();
        const prodCloseOrder: { fillId: string; symbol: string; strategyId: string }[] = [];
        let partitionMismatches = 0;
        for (let i = 0; i < cycles.length; i += 1) {
          const c = cycles[i]!;
          const members = parts[i]!;
          const closing = members[members.length - 1];
          // The partition MUST reproduce the real fold's own answer before its members are trusted.
          const recomputed = members.reduce(
            (s, f) =>
              f.side === 'BUY'
                ? s.minus(new Decimal(f.qty).mul(f.price))
                : s.plus(new Decimal(f.qty).mul(f.price)),
            new Decimal(0),
          );
          if (!recomputed.eq(c.realizedPnl)) partitionMismatches += 1;
          if (closing !== undefined) {
            prodCloseIds.add(closing.fillId);
            prodCloseOrder.push({
              fillId: closing.fillId,
              symbol: c.symbol,
              strategyId: c.strategyId,
            });
          }
        }

        const sqlOnly = sqlRes.rows.filter((r) => r.closes && !prodCloseIds.has(r.fill_id));
        const prodOnly = prodCloseOrder.filter((p) => !sqlCloseIds.has(p.fillId));

        // ── The tuple, recomposed ───────────────────────────────────────────────
        const realizedPnl = cycles.reduce((s, c) => s.plus(c.realizedPnl), new Decimal(0));
        const fees = sumFeesQuote(fills);
        const wins = cycles.reduce(
          (n, c) => (c.realizedPnl.minus(c.feesQuote).gt(0) ? n + 1 : n),
          0,
        );
        const winRate = cycles.length > 0 ? wins / cycles.length : 0;
        const firstClosedAt = Math.min(...cycles.map((c) => c.closedAt));
        const lastClosedAt = Math.max(...cycles.map((c) => c.closedAt));
        const windowStart = Math.max(firstClosedAt, EPOCH_MS);
        const windowDays = (lastClosedAt - windowStart) / DAY_MS;

        // Two funding folds, because they are not the same number and the difference is the
        // reason a recorded tuple is not reproducible from the DB by market time alone.
        // `byMarketTime` is what PromotionStatsRepository.fundingNetForMode returns TODAY for the
        // as-of window (funding_time only — the repository has no created_at predicate).
        // `asIngested` additionally requires the row to have EXISTED at the as-of instant
        // (created_at <= cap). A live evaluate() could only ever have seen the second. Ingest lag
        // is ~37 min on this venue, so a sample taken inside that lag reads a funding sum that the
        // same query returns differently once the poller catches up.
        const fundingRes = await pool.query<{
          net: string | null;
          n: string;
          net_ingested: string | null;
          n_ingested: string;
        }>(
          `SELECT sum(amount_quote)::text AS net,
                  count(*)::text AS n,
                  sum(amount_quote) FILTER (
                    WHERE $3::bigint IS NULL OR created_at <= to_timestamp($3::bigint/1000.0)
                  )::text AS net_ingested,
                  count(*) FILTER (
                    WHERE $3::bigint IS NULL OR created_at <= to_timestamp($3::bigint/1000.0)
                  )::text AS n_ingested
             FROM funding_payments
            WHERE mode = $1 AND funding_time >= $2
              AND ($3::bigint IS NULL OR funding_time <= $3::bigint)`,
          [DEMO_MODE, EPOCH_MS, capMs],
        );
        const fundingNet = new Decimal(fundingRes.rows[0]!.net ?? '0');
        const fundingNetAsIngested = new Decimal(fundingRes.rows[0]!.net_ingested ?? '0');

        // llmCostUsd, both folds of PromotionStatsRepository.tokenTotals: agent_decisions (replay
        // EXCLUDED — the evidence fold) + llm_usage kind='reflection'. created_at, not event_time,
        // matching the repository (promotion-stats.repository.ts:105-122).
        const tokensRes = await pool.query<{
          model: string;
          i: string;
          o: string;
          cr: string;
          cc: string;
        }>(
          `SELECT model, coalesce(sum(input_tokens),0)::text AS i,
                coalesce(sum(output_tokens),0)::text AS o,
                coalesce(sum(cache_read_input_tokens),0)::text AS cr,
                coalesce(sum(cache_creation_input_tokens),0)::text AS cc
           FROM agent_decisions
          WHERE strategy_id NOT LIKE 'replay-%' AND created_at >= to_timestamp($1/1000.0)
            AND ($2::bigint IS NULL OR created_at < to_timestamp($2::bigint/1000.0))
          GROUP BY model
         UNION ALL
         SELECT model, coalesce(sum(input_tokens),0)::text,
                coalesce(sum(output_tokens),0)::text,
                coalesce(sum(cache_read_input_tokens),0)::text,
                coalesce(sum(cache_creation_input_tokens),0)::text
           FROM llm_usage
          WHERE kind = 'reflection' AND created_at >= to_timestamp($1/1000.0)
            AND ($2::bigint IS NULL OR created_at < to_timestamp($2::bigint/1000.0))
          GROUP BY model`,
          [EPOCH_MS, capMs],
        );
        const llmCostUsd = tokensRes.rows.reduce((sum, r) => {
          const rate = ratesFor(r.model);
          return sum.plus(
            new Decimal(r.i)
              .div(MTOK)
              .mul(rate.input)
              .plus(new Decimal(r.o).div(MTOK).mul(rate.output))
              .plus(new Decimal(r.cr).div(MTOK).mul(rate.cacheRead))
              .plus(new Decimal(r.cc).div(MTOK).mul(rate.cacheWrite)),
          );
        }, new Decimal(0));

        const netPnl = realizedPnl.minus(fees).minus(llmCostUsd).plus(fundingNet);
        const netPnlAsIngested = realizedPnl
          .minus(fees)
          .minus(llmCostUsd)
          .plus(fundingNetAsIngested);
        // "Gross" as STATUS.md uses the word: everything except LLM spend, i.e. netPnl + llmCost.
        const grossAsIngested = realizedPnl.minus(fees).plus(fundingNetAsIngested);

        // ── One-way notional per trip (turnover / 2) ────────────────────────────
        const perTrip = cycles.map((c, i) => {
          const members = parts[i]!;
          const turnover = members.reduce(
            (s, f) => s.plus(new Decimal(f.qty).mul(f.price)),
            new Decimal(0),
          );
          return {
            symbol: c.symbol,
            strategyId: c.strategyId,
            oneWay: turnover.div(2),
            turnover,
            realizedPnl: c.realizedPnl,
            feesQuote: c.feesQuote,
            netOfFee: c.realizedPnl.minus(c.feesQuote),
            venue: members[0]?.venue ?? 'unknown',
            fills: members.length,
            openedAt: c.openedAt,
            closedAt: c.closedAt,
          };
        });
        const oneWays = perTrip.map((t) => t.oneWay);
        const meanOneWay = oneWays
          .reduce((s, x) => s.plus(x), new Decimal(0))
          .div(Math.max(1, oneWays.length));

        lines.push(
          `[book-truth] asOf=${capMs === null ? 'now' : new Date(capMs).toISOString()} ` +
            `epoch=${new Date(EPOCH_MS).toISOString()} mode=${DEMO_MODE}`,
          `fills=${fills.length} nullJoin=${fills.filter((f) => f.strategyId === null).length} ` +
            `preEpochDemoFills=${preEpochFills} (first ever: ${preEpoch.rows[0]!.first_ts ?? 'n/a'})`,
          '',
          '--- the tuple, recomputed ---',
          `roundTrips   = ${cycles.length}`,
          `windowDays   = ${windowDays}`,
          `realizedPnl  = ${realizedPnl.toFixed()}   (GROSS of fees)`,
          `fees         = ${fees.toFixed()}`,
          `llmCostUsd   = ${llmCostUsd.toFixed()}`,
          `fundingNet   = ${fundingNet.toFixed()}   (rows=${fundingRes.rows[0]!.n}, by funding_time)`,
          `fundingNet(as-ingested) = ${fundingNetAsIngested.toFixed()}   (rows=${fundingRes.rows[0]!.n_ingested})`,
          `netPnl       = ${netPnl.toFixed()}`,
          `netPnl(as-ingested) = ${netPnlAsIngested.toFixed()}   gross(as-ingested) = ${grossAsIngested.toFixed()}`,
          `winRate      = ${winRate}   (${wins} of ${cycles.length}, realizedPnl − feesQuote > 0)`,
          `unconvertibleFeeAsset = ${unconvertibleFeeAsset}`,
          `firstClosedAt=${new Date(firstClosedAt).toISOString()} lastClosedAt=${new Date(lastClosedAt).toISOString()}`,
          '',
          '--- one-way notional per trip (turnover / 2) ---',
          `n=${oneWays.length} mean=${meanOneWay.toFixed(4)} median=${median(oneWays)?.toFixed(4)} ` +
            `min=${quantile(oneWays, 0)?.toFixed(4)} p10=${quantile(oneWays, 0.1)?.toFixed(4)} ` +
            `p90=${quantile(oneWays, 0.9)?.toFixed(4)} max=${quantile(oneWays, 1)?.toFixed(4)}`,
          ...['binance', 'binanceusdm'].map((v) => {
            const sub = perTrip.filter((t) => t.venue === v).map((t) => t.oneWay);
            const m = sub.reduce((s, x) => s.plus(x), new Decimal(0)).div(Math.max(1, sub.length));
            return `  ${v.padEnd(12)} n=${sub.length} mean=${sub.length > 0 ? m.toFixed(4) : 'n/a'} median=${median(sub)?.toFixed(4) ?? 'n/a'}`;
          }),
          '',
          '--- boundary audit: production walk vs pure-SQL probe ---',
          `sqlCloseRows=${sqlCloseIds.size} prodCloseRows=${prodCloseIds.size} ` +
            `partitionMismatches=${partitionMismatches}`,
          `sqlOnly (SQL closed, production did NOT) = ${sqlOnly.length}`,
          ...sqlOnly.map(
            (r) =>
              `  SQL-ONLY fill_id=${r.fill_id.padStart(4)} ${r.strategy_id.padEnd(11)} ${r.symbol.padEnd(18)} residual=${new Decimal(r.residual).toFixed(6)}`,
          ),
          `prodOnly (production closed, SQL did NOT) = ${prodOnly.length}`,
          ...prodOnly.map(
            (p) =>
              `  PROD-ONLY fill_id=${p.fillId.padStart(4)} ${p.strategyId.padEnd(11)} ${p.symbol}`,
          ),
          '',
          '--- per-trip ledger ---',
          ...perTrip.map(
            (t, i) =>
              `  #${String(i + 1).padStart(2)} ${t.strategyId.padEnd(11)} ${t.symbol.padEnd(18)} ` +
              `oneWay=${t.oneWay.toFixed(2).padStart(8)} pnl=${t.realizedPnl.toFixed(4).padStart(10)} ` +
              `fees=${t.feesQuote.toFixed(4).padStart(8)} netOfFee=${t.netOfFee.toFixed(4).padStart(10)} ` +
              `fills=${String(t.fills).padStart(2)} ` +
              `held=${(((t.closedAt - t.openedAt) / 3_600_000).toFixed(2) + 'h').padStart(9)} ` +
              `closed=${new Date(t.closedAt).toISOString()}`,
          ),
        );

        const out = lines.join('\n');
        console.log(out);
        if (OUT_FILE) writeFileSync(OUT_FILE, `${out}\n`, 'utf8');

        // Internal consistency only — the verdict is recorded by hand in the study writeup, never
        // asserted here (a green test must never imply a result).
        expect(partitionMismatches).toBe(0);
        expect(netPnl.toFixed()).toBe(
          realizedPnl.minus(fees).minus(llmCostUsd).plus(fundingNet).toFixed(),
        );
      } finally {
        await pool.end();
      }
    }, 180_000);
  },
);
