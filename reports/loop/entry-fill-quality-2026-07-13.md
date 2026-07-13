# LIMIT_MAKER entry fill-quality study — 2026-07-13

**Read this line first: N = 1.** `ENTRY_ORDER_TYPE=LIMIT_MAKER` (post-only entries) defaults to
`LIMIT` (`src/config/environment/environment.config.ts:380`) and is opt-in; across this DB's entire
`orders` table (54 rows) there is exactly **one** `type='LIMIT_MAKER'` entry order, and it filled. This
is not a fill-leak measurement with statistical weight — it is an honest report of what the data
currently contains, per the task's own "thin data = honest small-N report" instruction.

## 1. Method (3 sentences)

`test/backtest/entry-fill-quality/run.mjs` pulls every `orders` row with `type='LIMIT_MAKER'` joined
to its `order_intents` (`reduce_only=false`), cross-checks fill status against the `fills` table by
`client_order_id` (never trusting `orders.first_fill_at` alone — see §2's stamp-gap note), and
correlates each entry to its originating `agent_decisions` plan row by nearest `created_at` between
`order_intents.created_at` and the decision's own `created_at` (both stamped in the same synchronous
`decide()` cycle, empirically ~2ms apart, rejected past a 10s tolerance). For any entry that expired
unfilled, it replays the plan's TP/SL/maxHold from the order's own resting `limit_price` against real
forward 15m Binance OHLCV (ccxt, public REST, no keys), using the exact stop-first/take-profit/max-hold
walk semantics of `plan-executor.ts`'s `evaluatePlan`, net of a 20bps round-trip fee — with zero
expired entries in this dataset, that replay path exists but was never exercised this run.

## 2. Data card

- **N = 1** `LIMIT_MAKER` entry order in the entire DB (`orders.type='LIMIT_MAKER' AND
  order_intents.reduce_only=false`): `LINK/USDT`, strategy `agentic-5`, mode `testnet`.
- Every other entry order in this DB (53 rows) is plain `type='LIMIT'` — either because
  `ENTRY_ORDER_TYPE` was `LIMIT` (the default) for most of this window, or because
  `position-sizer.service.ts`'s `entryType()` falls a `LIMIT_MAKER`-configured entry back to `LIMIT`
  whenever the computed resting price would cross the book (see that file's own comment). This script
  cannot distinguish "config was off" from "config was on but every entry happened to cross" from the
  `orders` table alone — both are visible only as `type='LIMIT'` rows, out of this study's scope by the
  task's own type filter.
- **Stamp-gap caveat, confirmed live**: the one row's `orders.first_fill_at` is `NULL` despite
  `state='FILLED'` — exactly the backlog #40 gap the task flagged. Cross-checking `fills` by
  `client_order_id` found 1 fill (`fill_id=220`, `venue_timestamp=1783936923300`, `liquidity='maker'`),
  confirmed by `order_events` (`SUBMIT_SENT` → `ACK` → `FILL`, 10:00:07.528Z → 10:02:06.805Z). The
  fills-join is what this script and this report actually treat as ground truth; `first_fill_at` is not
  used when it disagrees.
- **Plan correlation, confirmed live**: the entry order's `order_intents.created_at`
  (`1783936807505` ms) matched `agent_decisions` row `id=817` (`agentic-5`/`LINK/USDT`,
  `action='long'`, `plan_json` present) at a **2ms** `created_at` delta — the tight-tolerance
  correlation strategy (§1) resolves cleanly on the one row this DB has.

## 3. Per-symbol + aggregate results

| Symbol | N | Fill rate | Expiry rate | Still open | Median bars-to-fill | Missed fills | Would-have-won | Would-have-lost | Signed foregone net bps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LINK/USDT | 1 | 100% | 0% | 0 | 0.13 | 0 | 0 | 0 | 0.0 |
| **ALL** | **1** | **100%** | **0%** | **0** | **0.13** | **0** | **0** | **0** | **0.0** |

- **Median bars-to-fill = 0.13** (15m bars): the one order filled ~116 seconds after it was placed
  (`order_events`: SUBMIT_SENT 10:00:07.528Z, FILL 10:02:06.805Z) — well under one bar, i.e. it filled
  almost immediately, not near its `entryValidityBars` boundary.
- **Missed-fill count = 0**, so **signed foregone net PnL = 0** by construction — there is nothing to
  price this run. The correlated plan (`entryOffsetBps=5`, `entryValidityBars=4`, `stopLossPct=0.008`,
  `takeProfitPct=0.014`, `maxHoldBars=16`) is reported for completeness (§2) but was never at risk of
  expiring: the order filled in under one bar against a 4-bar validity window.

## 4. Conclusion

**The maker-entry fill leak is not material in this dataset, because there is effectively no maker-entry
population to leak from.** Signed foregone PnL is $0 against this window's realized PnL (testnet mode,
all strategies: **−$6.76**, `sum(positions.realized_pnl)`) — a 0/−6.76 ratio that says nothing about
maker-entry quality specifically; it says `ENTRY_ORDER_TYPE=LIMIT_MAKER` has essentially never run.
**This is a data-coverage finding, not a fill-quality verdict**: the one observed maker entry filled
fast (well under one 15m bar) and cleanly, which is a mildly encouraging single data point but is
statistically indistinguishable from noise at N=1.

**No `entryOffsetBps`/`entryValidityBars` guidance change is supported by this data.** The one filled
entry rested at `entryOffsetBps=5` (5bps below close) with `entryValidityBars=4` and filled in ~0.13
bars — nowhere near its expiry window — so this sample offers no evidence either direction on whether
the current offset/validity bounds are too tight, too loose, or well-calibrated. Recommendation: rerun
this exact script after `ENTRY_ORDER_TYPE=LIMIT_MAKER` has accumulated a meaningful population of
entries (tens, not one) before drawing any conclusion about fill leak or bounds guidance; the harness
(`test/backtest/entry-fill-quality/run.mjs`) is ready to rerun as-is against a larger sample, including
its never-yet-exercised missed-fill settlement-replay path.

## Artifacts

- `test/backtest/entry-fill-quality/run.mjs` — the harness (rerun: `node
  test/backtest/entry-fill-quality/run.mjs`, reads `DATABASE_URL` from `.env` or falls back to the
  checked-in docker-compose dev default; DB reads only, no LLM calls, no network unless a missed-fill
  candidate needs a candle fetch).
- This report's numbers are the harness's direct console output against the live local DB at
  report-generation time; no intermediate JSON was checked in (rerun to reproduce).

## Honesty notes

- Research metric, off the production test gate (`pnpm backtest` per CLAUDE.md rule 4). This script
  and report only ever read the DB — no order was placed, no config was changed.
- N=1 throughout. Every aggregate stat in §3 is a single observation, not a rate estimate — "100% fill
  rate" and "0% expiry rate" describe exactly one order, not a population.
- The plan-correlation and stamp-gap-cross-check mechanisms (§1, §2) were validated against real data
  in this run (2ms correlation delta, confirmed fills-vs-`first_fill_at` mismatch) — those two pieces
  of the harness are exercised and trustworthy. The missed-fill settlement-replay path (§1's third
  sentence) is implemented and unit-consistent with `plan-executor.ts`'s own walk semantics but was
  **never exercised this run** (zero expired candidates) — it is unverified against real data until a
  future rerun actually has an expired `LIMIT_MAKER` entry to replay.
- `INTERVAL_MS` (15m bars) is assumed from this repo's existing convention (`bounds-calibration`,
  `recorded-entry-scoring.ts`'s `REFERENCE_INTERVAL`), not re-derived per-strategy from config in this
  script.
