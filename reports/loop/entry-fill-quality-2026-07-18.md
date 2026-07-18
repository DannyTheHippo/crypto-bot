# LIMIT_MAKER entry fill-quality study — 2026-07-18 (P0b pre-auth re-run)

**Read this line first: N = 25 — the pre-registered ≥15 floor is met** (P0a/P0b pre-auth,
`reports/loop/state.md` § Push 3: "re-run once LIMIT_MAKER entry N≥15"). This supersedes the
N=1 data-coverage report of 2026-07-13 (`reports/loop/entry-fill-quality-2026-07-13.md`) as the
operative fill-quality read. Registry: `experiments` row **130** (family `entry-fill-quality`).

## 1. Method

Identical harness, unchanged: `test/backtest/entry-fill-quality/run.mjs` (method §1 of the
2026-07-13 report; DB reads only, fills-table ground truth, 10s plan-correlation tolerance,
missed-fill settlement replay from the order's own resting `limit_price` against real forward 15m
Binance OHLCV, `plan-executor.ts` walk semantics, 20bps round-trip fee). The missed-fill replay
path — implemented but **never exercised** in the 07-13 run — ran against 6 real expired entries
this time and is now validated on live data.

## 2. Data card

- **N = 25** `LIMIT_MAKER` non-reduce-only entry orders, 2026-07-13 10:00:07Z → 2026-07-18
  07:45:13Z (the entire post-Phase-1 maker-entry population; spot DB, mode `testnet`).
- **19 filled / 6 terminal-unfilled / 0 still open.** Unfilled breakdown by terminal state:
  **5 REJECTED** (venue-side post-only would-cross — price moved through the resting level between
  intent build and venue ack; the sizer's build-time crossed-price LIMIT fallback cannot catch
  these) + **1 CANCELED** (plan `cancel_entry` sweep).
- **1 stamp-gap row** (`first_fill_at` NULL despite a real fill — the known #40-era LINK row from
  07-13; fills-join ground truth used, as designed).
- All 6 missed entries plan-correlated cleanly; forward-candle replays complete (none censored).

## 3. Per-symbol + aggregate results

| Symbol | N | Fill rate | Expiry rate | Median bars-to-fill | Missed | Won/Lost | Foregone net bps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC/USDT | 6 | 83% | 17% | 0.10 | 1 | 0/1 | −89.8 |
| LINK/USDT | 5 | 80% | 20% | 0.14 | 1 | 1/0 | +258.7 |
| ETH/USDT | 4 | 100% | 0% | 0.30 | 0 | — | 0.0 |
| SOL/USDT | 4 | 50% | 50% | 0.17 | 2 | 0/2 | −204.1 |
| ZEC/USDT | 4 | 50% | 50% | 0.07 | 2 | 0/2 | −318.3 |
| XRP/USDT | 2 | 100% | 0% | 0.15 | 0 | — | 0.0 |
| **ALL** | **25** | **76%** | **24%** | **0.13** | **6** | **1/5** | **−353.5** |

Missed-fill settlement replays (net of 20bps fees, from the order's own resting price):

| Symbol | Entry (UTC) | Resting price | Cleared via | Sim exit | Net bps | Bars |
| --- | --- | --- | --- | --- | --- | --- |
| LINK/USDT | 07-14 11:00 | 7.966 | plan_expired | take_profit | +259 | 16 |
| SOL/USDT | 07-14 22:30 | 77.54 | cancel_entry | max_hold | −52 | 16 |
| SOL/USDT | 07-16 14:15 | 76.62 | plan_expired | stop | −152 | 16 |
| BTC/USDT | 07-16 14:15 | 64603.11 | plan_expired | max_hold | −90 | 16 |
| ZEC/USDT | 07-17 14:15 | 543.08 | plan_expired | stop | −162 | 16 |
| ZEC/USDT | 07-18 01:00 | 546.57 | plan_expired | stop | −157 | 24 |

## 4. Conclusion

**The post-only maker-entry discipline is VALIDATED at N=25 — no guidance change.**

1. **Fills are fast and the leak is small:** 76% of maker entries fill, at a median 0.13 bars
   (~2 minutes) — nowhere near their validity windows. The 24% miss rate is dominated by
   venue-side would-cross rejects (5/6), i.e. entries into price that was already running away.
2. **The missed fills were, net, trades worth missing:** replaying all 6 through their own plans
   yields **−353.5bps signed foregone net return** — five of six would have LOST (three by
   stop-out). Only the LINK 07-14 miss forwent a win (+259bps). The "fill leak" P0b set out to
   price is, on this population, a **loss filter**: chasing those entries with marketable orders
   would have cost ~354bps notional net, plus taker fees on every filled entry.
3. **Bounds guidance:** no change to `entryOffsetBps`/`entryValidityBars` is supported — fills
   happen in fractions of a bar, misses are would-cross rejects (which no offset/validity tuning
   fixes; only abandoning post-only would, and point 2 argues against that).

**Next re-run:** at N≈50 or after any entry-mechanic change (whichever first) — the would-cross
reject share (currently 5/25 = 20% of all entries) is the number to watch: if it grows with the
8-symbol universe, the foregone-PnL sign could flip in a momentum regime (the one winner was a
momentum continuation LINK missed).

## Artifacts

- Harness: `test/backtest/entry-fill-quality/run.mjs` (unchanged; rerun as-is to reproduce).
- Registry: `experiments` row 130 (source `loop`, metrics JSON carries the §3 aggregate).
- Raw console output archived in the session scratchpad only; the harness is deterministic
  against the same DB snapshot (candle fetches are public REST).

## Honesty notes

- Research metric, off the production test gate. DB reads + one registry INSERT (append-only,
  non-money); no order placed, no config changed.
- N=25 is enough to clear the pre-registered floor, not enough for per-symbol conclusions —
  SOL/ZEC's 50% fill rates are 2-of-4 observations each.
- The settlement replay prices misses against the plan's own TP/SL/maxHold walk on 15m closes —
  intra-bar paths (S3-style backstops, venue TP maker fills) are not modeled; treat per-trade
  magnitudes as approximate, the aggregate sign as robust (5/6 losers, three by stop).
- The corpus spans the 5→8 universe expansion (2026-07-17): AAVE/NEAR have no maker entries yet;
  ZEC contributes 4 rows in <2 days — the population is regime-weighted toward this week.
