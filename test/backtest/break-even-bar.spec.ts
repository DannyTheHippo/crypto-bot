import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { writeFileSync } from 'node:fs';
import { walkRoundTrips } from '../../src/domain/trading/risk/round-trips';
import type { RoundTripFill } from '../../src/domain/trading/risk/round-trips';
import { partitionFillsIntoCycles } from './live-frame';
import {
  BOOTSTRAP_SEED,
  BPS,
  MIN_CLUSTERS,
  MIN_OBS,
  N_BOOT,
  bookRateBps,
  breakEvenBars,
  clusterCi,
  feeBps,
  grossCostBps,
  llmBpsPerTrip,
  meanDecimal,
  medianDecimal,
  notionalWeightedBps,
  slipBps,
  type CycleCost,
} from './break-even';

// ── The true break-even bar (R1) ──────────────────────────────────────────────
//
// Study: research/studies/break-even-bar-derivation-2026-08-04.md.
//
// Every study in this programme is scored against +13.0 bps (research) / +24.2 bps (deployment).
// Neither was ever derived — both enter the repo fully formed in commit 7b3e977 and every later
// citation is circular (research/studies/fee-floor-derivation-2026-07-31.md § 1). This spec
// composes a bar from measured operands instead: venue fees, execution slippage, and amortized
// inference spend, each re-derived here from raw rows.
//
// Cycle boundaries are OWNED by the imported `walkRoundTrips` and are never re-derived. The
// population ledger this consumes is book-truth.spec.ts /
// research/studies/book-truth-2026-08-04.md.
//
// Gated: BREAK_EVEN_BAR=1 + DATABASE_URL, self-skips otherwise, read-only, never on the production
// gate.

const RUN = process.env['BREAK_EVEN_BAR'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const OUT_FILE = process.env['BREAK_EVEN_OUTPUT_FILE'];
const AS_OF_MS = process.env['BREAK_EVEN_AS_OF_MS'];

const EPOCH_MS = 1_784_632_860_000; // PROMOTION_EVIDENCE_EPOCH = 2026-07-21T11:21:00Z
const DUST_NOTIONAL = '5';
const DEMO_MODE = 'testnet';

// Ref-price freshness bound for a slippage measurement. Beyond it the intent's `ref_price` is a
// stale mark and the difference is position PnL, not execution cost — the failure mode that put a
// +221.8 bps "slippage" on STOP_LOSS_LIMIT legs with 7-hour fill lags in the 2026-07-31 audit.
const REF_FRESH_MS = 60_000;

type BarFill = RoundTripFill & {
  readonly fillId: string;
  readonly venue: string;
  readonly liquidity: string;
  readonly reduceOnly: boolean;
  readonly orderType: string;
  readonly intentCreatedAt: number | null;
};

/** Signed adverse slippage in bps: paid above ref on a BUY, sold below ref on a SELL. Mirrors
 *  round-trips.ts's own `slippageBps` convention exactly. */
function signedSlipBps(side: 'BUY' | 'SELL', price: Decimal, ref: Decimal): Decimal {
  const raw = price.minus(ref).div(ref).mul(BPS);
  return side === 'BUY' ? raw : raw.neg();
}

function fmt(d: Decimal | null, dp = 4): string {
  return d === null ? 'n/a' : d.toFixed(dp);
}

describe.skipIf(!RUN || !DB_URL)('break-even-bar: the bar, composed from measured operands', () => {
  it('derives the gross and all-in break-even bars from fees, slippage and inference spend', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: DB_URL });
    const lines: string[] = [];
    const capMs = AS_OF_MS === undefined ? null : Number(AS_OF_MS);
    try {
      const fillsRes = await pool.query<{
        fill_id: string;
        strategy_id: string | null;
        symbol: string;
        venue: string;
        liquidity: string;
        side: 'BUY' | 'SELL' | null;
        qty: string;
        price: string;
        fee_amount: string | null;
        fee_ccy: string | null;
        venue_timestamp: string;
        ref_price: string | null;
        reduce_only: boolean | null;
        order_type: string | null;
        intent_created_at: string | null;
      }>(
        `SELECT f.fill_id, oi.strategy_id, f.symbol, f.venue, f.liquidity, oi.side, f.qty, f.price,
                f.fee_amount, f.fee_ccy, f.venue_timestamp, oi.ref_price, oi.reduce_only,
                oi.type AS order_type, oi.created_at AS intent_created_at
           FROM fills f
           LEFT JOIN order_intents oi ON f.intent_id = oi.intent_id
          WHERE f.mode = $1 AND f.venue_timestamp >= $2
            AND ($3::bigint IS NULL OR f.venue_timestamp <= $3::bigint)
          ORDER BY f.venue_timestamp ASC, f.fill_id ASC`,
        [DEMO_MODE, EPOCH_MS, capMs],
      );

      const fills: BarFill[] = fillsRes.rows.map((r) => ({
        fillId: r.fill_id,
        strategyId: r.strategy_id,
        symbol: r.symbol,
        venue: r.venue,
        liquidity: r.liquidity,
        side: r.side,
        qty: r.qty,
        price: r.price,
        fee: r.fee_amount,
        feeAsset: r.fee_ccy,
        executedAt: Number(r.venue_timestamp),
        refPrice: r.ref_price,
        reduceOnly: r.reduce_only ?? false,
        orderType: r.order_type ?? 'UNKNOWN',
        intentCreatedAt: r.intent_created_at === null ? null : Number(r.intent_created_at),
      }));

      const dustNotional = new Decimal(DUST_NOTIONAL);
      const { cycles } = walkRoundTrips(fills, dustNotional);
      const parts = partitionFillsIntoCycles(fills, cycles, dustNotional);
      expect(cycles.length).toBeGreaterThan(0);

      // ── Term 2 first: per-leg slippage, re-derived ──────────────────────────
      // A leg qualifies when it is an ENTRY (not reduce_only), carries a positive ref price, and
      // filled within REF_FRESH_MS of the intent being written. Everything else contributes zero
      // to the cycle's slippage cost and is counted as unmeasured, never imputed.
      const isRefFresh = (f: BarFill): boolean =>
        !f.reduceOnly &&
        f.refPrice !== null &&
        f.refPrice !== undefined &&
        new Decimal(f.refPrice).gt(0) &&
        f.intentCreatedAt !== null &&
        f.executedAt - f.intentCreatedAt < REF_FRESH_MS;

      const legRows = fills
        .filter((f) => f.side !== null)
        .map((f) => {
          const notional = new Decimal(f.qty).mul(f.price);
          const fresh = isRefFresh(f);
          const bps = fresh
            ? signedSlipBps(f.side!, new Decimal(f.price), new Decimal(f.refPrice!))
            : null;
          return { f, notional, fresh, bps };
        });

      const freshLegs = legRows.filter((r) => r.bps !== null);
      const legSlipWeighted = notionalWeightedBps(
        freshLegs.map((r) => ({ notional: r.notional, bps: r.bps! })),
      );
      const legSlipMean = meanDecimal(freshLegs.map((r) => r.bps!));

      // ── Per-cycle cost rows ─────────────────────────────────────────────────
      const costs: (CycleCost & { readonly netOfFeePnl: Decimal })[] = cycles.map((c, i) => {
        const members = parts[i]!;
        const turnover = members.reduce(
          (s, f) => s.plus(new Decimal(f.qty).mul(f.price)),
          new Decimal(0),
        );
        let slipQuote = new Decimal(0);
        let slipLegs = 0;
        for (const m of members) {
          const row = legRows.find((r) => r.f.fillId === m.fillId);
          if (row?.bps != null) {
            slipQuote = slipQuote.plus(row.bps.div(BPS).mul(row.notional));
            slipLegs += 1;
          }
        }
        return {
          symbol: c.symbol,
          venue: members[0]?.venue ?? 'unknown',
          oneWayNotional: turnover.div(2),
          feesQuote: c.feesQuote,
          slipQuote,
          slipLegs,
          legs: members.length,
          netOfFeePnl: c.realizedPnl.minus(c.feesQuote),
        };
      });

      const oneWayTotal = costs.reduce((s, c) => s.plus(c.oneWayNotional), new Decimal(0));
      const feesTotal = costs.reduce((s, c) => s.plus(c.feesQuote), new Decimal(0));
      const slipTotal = costs.reduce((s, c) => s.plus(c.slipQuote), new Decimal(0));

      // ── Term 1: venue-split fees, exact per cycle ───────────────────────────
      const feeBookBps = bookRateBps(feesTotal, oneWayTotal);
      const feeMean = meanDecimal(costs.map(feeBps));
      const feeMedian = medianDecimal(costs.map(feeBps));
      const byVenue = ['binance', 'binanceusdm'].map((v) => {
        const sub = costs.filter((c) => c.venue === v);
        const ow = sub.reduce((s, c) => s.plus(c.oneWayNotional), new Decimal(0));
        const fq = sub.reduce((s, c) => s.plus(c.feesQuote), new Decimal(0));
        return { venue: v, n: sub.length, oneWay: ow, rate: bookRateBps(fq, ow) };
      });
      const perpShare = oneWayTotal.gt(0)
        ? (byVenue.find((v) => v.venue === 'binanceusdm')?.oneWay ?? new Decimal(0))
            .div(oneWayTotal)
            .mul(100)
        : null;
      // Per-LEG venue schedule, straight off the fills — the check that the per-cycle rate above is
      // the same schedule seen through a different denominator, not a different schedule.
      const legSchedule = await pool.query<{
        venue: string;
        liquidity: string;
        fills: string;
        notional: string;
        bps_leg: string;
      }>(
        `SELECT venue, liquidity, count(*)::text AS fills,
                sum(price*qty)::text AS notional,
                (10000*sum(CASE WHEN fee_ccy='USDT' THEN fee_amount ELSE fee_amount*price END)
                   / sum(price*qty))::text AS bps_leg
           FROM fills
          WHERE mode = $1 AND venue_timestamp >= $2
            AND ($3::bigint IS NULL OR venue_timestamp <= $3::bigint)
          GROUP BY venue, liquidity ORDER BY venue, liquidity`,
        [DEMO_MODE, EPOCH_MS, capMs],
      );

      // ── The gross term, with its cluster CI ─────────────────────────────────
      const grossObs = costs.map((c) => ({
        symbol: c.symbol,
        value: grossCostBps(c).toNumber(),
      }));
      const grossCi = clusterCi(grossObs);
      const grossBookBps = bookRateBps(feesTotal.plus(slipTotal), oneWayTotal);

      // ── Term 3: LLM spend, both attributions ────────────────────────────────
      // Split decide vs reflection so the marginal chain can be priced off the decide side alone.
      const llmRes = await pool.query<{
        src: string;
        model: string;
        cost: string;
        rows: string;
        token_rows: string;
      }>(
        `WITH r(model, ri, ro, rcr, rcw) AS (VALUES
             ('claude-sonnet-5', 3::numeric, 15::numeric, 0.3::numeric, 6::numeric),
             ('claude-opus-5',   5::numeric, 25::numeric, 0.5::numeric, 10::numeric)),
           d AS (
             SELECT 'decide' AS src, model,
                    coalesce(sum(input_tokens),0) i, coalesce(sum(output_tokens),0) o,
                    coalesce(sum(cache_read_input_tokens),0) cr,
                    coalesce(sum(cache_creation_input_tokens),0) cc,
                    count(*) rows, count(*) FILTER (WHERE input_tokens > 0) token_rows
               FROM agent_decisions
              WHERE strategy_id NOT LIKE 'replay-%' AND created_at >= to_timestamp($1/1000.0)
                AND ($2::bigint IS NULL OR created_at < to_timestamp($2::bigint/1000.0))
              GROUP BY model
             UNION ALL
             SELECT 'reflection', model,
                    coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                    coalesce(sum(cache_read_input_tokens),0),
                    coalesce(sum(cache_creation_input_tokens),0),
                    count(*), count(*) FILTER (WHERE input_tokens > 0)
               FROM llm_usage
              WHERE kind = 'reflection' AND created_at >= to_timestamp($1/1000.0)
                AND ($2::bigint IS NULL OR created_at < to_timestamp($2::bigint/1000.0))
              GROUP BY model)
         SELECT d.src, d.model,
                (d.i/1e6*coalesce(r.ri,5) + d.o/1e6*coalesce(r.ro,25)
                 + d.cr/1e6*coalesce(r.rcr,0.5) + d.cc/1e6*coalesce(r.rcw,10))::text AS cost,
                d.rows::text, d.token_rows::text
           FROM d LEFT JOIN r ON r.model = d.model ORDER BY d.src, d.model`,
        [EPOCH_MS, capMs],
      );
      const llmTotal = llmRes.rows.reduce((s, r) => s.plus(r.cost), new Decimal(0));
      const decideCost = llmRes.rows
        .filter((r) => r.src === 'decide')
        .reduce((s, r) => s.plus(r.cost), new Decimal(0));
      const decideTokenRows = llmRes.rows
        .filter((r) => r.src === 'decide')
        .reduce((s, r) => s + Number(r.token_rows), 0);

      // Denominator RANGE, not a CI — there is no sampling in a book-level scalar over a count.
      //
      // Each candidate trip count from the book-truth ledger is evaluated as a WINDOW-CONSISTENT
      // snapshot: the LLM cost is re-read up to the instant that trip count was reached, and paired
      // with the one-way notional those same trips turned over. Pairing the full-window cost with a
      // truncated trip set would overstate every early point by the spend that had not happened
      // yet, which is the exact class of error this pass exists to remove.
      const sortedByClose = cycles
        .map((c, i) => ({ closedAt: c.closedAt, oneWay: costs[i]!.oneWayNotional }))
        .sort((a, b) => a.closedAt - b.closedAt);
      const denominators = [23, 38, 46, cycles.length].filter(
        (n, idx, arr) => n <= cycles.length && arr.indexOf(n) === idx,
      );
      const llmRange: {
        trips: number;
        asOf: number;
        cost: Decimal;
        oneWayTotal: Decimal;
        perTripUsd: Decimal;
        bps: Decimal | null;
      }[] = [];
      for (const n of denominators) {
        const asOf = sortedByClose[n - 1]!.closedAt;
        const snap = await pool.query<{ cost: string }>(
          `WITH r(model, ri, ro, rcr, rcw) AS (VALUES
               ('claude-sonnet-5', 3::numeric, 15::numeric, 0.3::numeric, 6::numeric),
               ('claude-opus-5',   5::numeric, 25::numeric, 0.5::numeric, 10::numeric)),
             d AS (
               SELECT model, coalesce(sum(input_tokens),0) i, coalesce(sum(output_tokens),0) o,
                      coalesce(sum(cache_read_input_tokens),0) cr,
                      coalesce(sum(cache_creation_input_tokens),0) cc
                 FROM agent_decisions
                WHERE strategy_id NOT LIKE 'replay-%'
                  AND created_at >= to_timestamp($1/1000.0)
                  AND created_at < to_timestamp($2::bigint/1000.0)
                GROUP BY model
               UNION ALL
               SELECT model, coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                      coalesce(sum(cache_read_input_tokens),0),
                      coalesce(sum(cache_creation_input_tokens),0)
                 FROM llm_usage
                WHERE kind = 'reflection' AND created_at >= to_timestamp($1/1000.0)
                  AND created_at < to_timestamp($2::bigint/1000.0)
                GROUP BY model)
           SELECT coalesce(sum(d.i/1e6*coalesce(r.ri,5) + d.o/1e6*coalesce(r.ro,25)
                  + d.cr/1e6*coalesce(r.rcr,0.5) + d.cc/1e6*coalesce(r.rcw,10)),0)::text AS cost
             FROM d LEFT JOIN r ON r.model = d.model`,
          [EPOCH_MS, asOf],
        );
        const cost = new Decimal(snap.rows[0]!.cost);
        const ow = sortedByClose.slice(0, n).reduce((s, x) => s.plus(x.oneWay), new Decimal(0));
        llmRange.push({
          trips: n,
          asOf,
          cost,
          oneWayTotal: ow,
          perTripUsd: cost.div(n),
          bps: llmBpsPerTrip(cost, ow),
        });
      }
      const llmAmortized = llmBpsPerTrip(llmTotal, oneWayTotal)!;

      // Consult-chain marginal: the decide consults a single trip actually consumed — one entry
      // and one exit, priced at the mean cost of a token-carrying decide row.
      const perConsultUsd = decideTokenRows > 0 ? decideCost.div(decideTokenRows) : null;
      const marginalChainUsd = perConsultUsd === null ? null : perConsultUsd.mul(2);
      const meanOneWay = oneWayTotal.div(cycles.length);
      const marginalChainBps =
        marginalChainUsd === null ? null : marginalChainUsd.div(meanOneWay).mul(BPS);

      const bars = breakEvenBars(new Decimal(grossCi.mean), llmAmortized);
      const barsBookWeighted = breakEvenBars(grossBookBps!, llmAmortized);

      // What the book actually earned per round trip, on the SAME denominator the bars use, so the
      // gap is a subtraction rather than a comparison of two differently-scaled numbers.
      const realizedTotal = cycles.reduce((s, c) => s.plus(c.realizedPnl), new Decimal(0));
      const realizedBps = bookRateBps(realizedTotal, oneWayTotal)!;
      const gapVsGross = bars.grossBarBps.minus(realizedBps);
      const gapVsAllIn = bars.allInBarBps.minus(realizedBps);

      lines.push(
        `[break-even-bar] asOf=${capMs === null ? 'now' : new Date(capMs).toISOString()} ` +
          `epoch=${new Date(EPOCH_MS).toISOString()} fills=${fills.length} trips=${cycles.length}`,
        `oneWayNotionalTotal=${oneWayTotal.toFixed(4)} meanOneWay=${meanOneWay.toFixed(4)} ` +
          `medianOneWay=${fmt(medianDecimal(costs.map((c) => c.oneWayNotional)), 4)}`,
        '',
        '--- TERM 1: venue fees, exact per cycle (feesQuote / one-way notional) ---',
        `book rate      = ${fmt(feeBookBps)} bps/round trip   (Σfees ${feesTotal.toFixed(8)} / Σone-way ${oneWayTotal.toFixed(4)})`,
        `per-cycle mean = ${fmt(feeMean)} bps   median = ${fmt(feeMedian)} bps`,
        ...byVenue.map(
          (v) =>
            `  ${v.venue.padEnd(12)} trips=${String(v.n).padStart(3)} oneWay=${v.oneWay.toFixed(2).padStart(9)} rate=${fmt(v.rate)} bps/round trip`,
        ),
        `perp share of one-way notional = ${fmt(perpShare, 2)}%`,
        '  per-leg venue schedule (cross-check, same fills, per-leg denominator):',
        ...legSchedule.rows.map(
          (r) =>
            `    ${r.venue.padEnd(12)} ${r.liquidity.padEnd(6)} fills=${r.fills.padStart(4)} ` +
            `notional=${new Decimal(r.notional).toFixed(4).padStart(11)} ${new Decimal(r.bps_leg).toFixed(6)} bps/leg`,
        ),
        '',
        '--- TERM 2: execution slippage, re-derived (entry legs, ref fresh < 60s) ---',
        `qualifying legs = ${freshLegs.length} of ${legRows.length} ` +
          `(entry legs: ${legRows.filter((r) => !r.f.reduceOnly).length})`,
        `notional-weighted = ${fmt(legSlipWeighted)} bps/leg   unweighted mean = ${fmt(legSlipMean)} bps/leg`,
        `cycle-level Σslip = ${slipTotal.toFixed(8)} quote ⇒ ${fmt(bookRateBps(slipTotal, oneWayTotal))} bps/round trip`,
        `per-cycle mean = ${fmt(meanDecimal(costs.map(slipBps)))} bps  median = ${fmt(medianDecimal(costs.map(slipBps)))} bps`,
        `cycles with ≥1 fresh leg = ${costs.filter((c) => c.slipLegs > 0).length} of ${costs.length}`,
        '',
        '--- GROSS BAR: fees + slippage per round trip ---',
        `book-weighted = ${fmt(grossBookBps)} bps`,
        `per-cycle mean = ${grossCi.mean.toFixed(4)} bps  n=${grossCi.n} clusters=${grossCi.clusters} ` +
          `CI95=[${grossCi.ciLo.toFixed(4)}, ${grossCi.ciHi.toFixed(4)}] seed=${BOOTSTRAP_SEED} N_BOOT=${N_BOOT}`,
        `power: ${grossCi.underpowered ? `RECORDED, NOT EVIDENCE (n<${MIN_OBS} or clusters<${MIN_CLUSTERS})` : `n>=${MIN_OBS} and clusters>=${MIN_CLUSTERS}`}`,
        '',
        '--- TERM 3: LLM spend ---',
        `llmCostUsd (evidence fold, replay excluded) = ${llmTotal.toFixed(7)}`,
        ...llmRes.rows.map(
          (r) =>
            `  ${r.src.padEnd(11)} ${r.model.padEnd(16)} rows=${r.rows.padStart(6)} tokenRows=${r.token_rows.padStart(5)} cost=${new Decimal(r.cost).toFixed(6)}`,
        ),
        `AMORTIZED (book cost ÷ closed trips) — this is the number the bar uses.`,
        `Each row is a window-consistent snapshot: cost and trips both read as of that instant.`,
        ...llmRange.map(
          (r) =>
            `  trips=${String(r.trips).padStart(3)} asOf=${new Date(r.asOf).toISOString()} ` +
            `cost=${r.cost.toFixed(4).padStart(8)} $/trip=${r.perTripUsd.toFixed(4)} ` +
            `Σone-way=${r.oneWayTotal.toFixed(2).padStart(9)} ⇒ ${fmt(r.bps, 2)} bps/round trip`,
        ),
        `CONSULT-CHAIN MARGINAL: perTokenCarryingDecideRow=$${fmt(perConsultUsd, 6)} ` +
          `x2 legs = $${fmt(marginalChainUsd, 6)} ⇒ ${fmt(marginalChainBps, 2)} bps/round trip ` +
          `(decideTokenRows=${decideTokenRows})`,
        '',
        '--- THE BARS ---',
        `GROSS  research bar (fees+slippage, per-cycle mean) = ${bars.grossBarBps.toFixed(4)} bps/round trip`,
        `ALL-IN book bar     (gross + amortized LLM)         = ${bars.allInBarBps.toFixed(4)} bps/round trip`,
        `GROSS  (book-weighted variant)                      = ${barsBookWeighted.grossBarBps.toFixed(4)} bps`,
        `ALL-IN (book-weighted variant)                      = ${barsBookWeighted.allInBarBps.toFixed(4)} bps`,
        `asserted, never derived: +13.0 (research) / +24.2 (deployment)`,
        '',
        '--- the gap, on the bars own denominator ---',
        `realised gross = ${realizedBps.toFixed(4)} bps/round trip (Σ realizedPnl ${realizedTotal.toFixed(6)} / Σ one-way ${oneWayTotal.toFixed(4)})`,
        `gap to GROSS bar  = ${gapVsGross.toFixed(4)} bps/round trip`,
        `gap to ALL-IN bar = ${gapVsAllIn.toFixed(4)} bps/round trip`,
      );

      const out = lines.join('\n');
      console.log(out);
      if (OUT_FILE) writeFileSync(OUT_FILE, `${out}\n`, 'utf8');

      // Internal consistency only — no verdict is asserted here.
      expect(oneWayTotal.gt(0)).toBe(true);
      expect(bars.allInBarBps.minus(bars.grossBarBps).toFixed()).toBe(llmAmortized.toFixed());
    } finally {
      await pool.end();
    }
  }, 180_000);
});
