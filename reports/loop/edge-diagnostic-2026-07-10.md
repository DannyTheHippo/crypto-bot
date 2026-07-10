# Edge diagnostic — 2026-07-10

Task A2 (edge program, `reports/loop/state.md` § Flagged). Screens the deployed seed playbook's LONG
entry rule (EMA9/EMA21 + RSI14 + freshness) with an ATR-derived expected-move selectivity overlay,
across 52 symbol x timeframe x selectivity buckets, for a genuine cost-covering edge. The honest prior
going in was NO-GO, and that is the honest result coming out: **zero of 52 buckets clear the seam bar.**
No bucket was retried, reparametrized, or dropped to make a number look better — this is a screen, not
a tuning exercise, and the empty seam list is reported as-is.

## Method

### Rule (SeedEntryStrategy, `test/backtest/strategies/seed-entry-strategy.ts`)

- **Entry (LONG only):** EMA9 > EMA21 AND 50 < RSI14 < 70 AND the EMA9/EMA21 crossover that put the
  pair into that bullish state is <= 2 bars old (a "fresh cross," not a stale chase).
- **Selectivity overlay:** `expectedMoveBps = (ATR14 / close) * sqrt(maxHoldBars) * 1e4`; the bucket's
  k-multiple gates entry to only fire when `expectedMoveBps >= k * 20bps` (20bps = the round-trip
  taker-fee hurdle, 10bps x 2 legs — a fixed constant per the task spec, not derived from the harness's
  own fill config).
- **Exit:** `maxHoldBars` cap (fixed at 20 bars for every bucket — see below) OR the opposite EMA cross
  (EMA9 crosses below EMA21). No richer exit logic, per the diagnostic's mandate to keep the rule
  exactly this simple (it mirrors the deployed seed playbook).
- **Indicators:** EMA9/EMA21/RSI14/ATR14, all maintained incrementally (O(1) amortized per bar) rather
  than recomputed from the full close history on every call — required for the 70k-bar 15m series to
  finish in seconds rather than hours (an O(n) recompute per bar is O(n^2) over a full run).
- `maxHoldBars = 20` is **fixed across all 52 buckets, not swept**. The task's bucket budget (52 =
  {BTC,ETH} x 4 timeframes x 4 k-values, plus 5 alts x 15m x 4 k-values) has no room for a third grid
  dimension; sweeping `maxHoldBars` per timeframe would have required either a much larger grid or an
  arbitrary per-timeframe choice disguised as a fixed rule. Holding it constant means the real-time
  holding window differs sharply by timeframe (20 bars = 5h at 15m, 20h at 1h, ~3.3d at 4h, 20d at
  1d) — that is a deliberate consequence of testing "the same simple rule at its own native
  resolution" in each bucket, not an oversight.

### Data

Binance spot OHLCV, paged via `test/backtest/fetch-data.mjs`'s extended fetch (`ohlcv-<SYMBOL>-<TF>.
json`), fetched today (2026-07-10), sandbox-disabled:

| Symbol | Timeframe | Bars | Range (UTC) |
| ----------------- | --------- | ----- | --------------------------------------- |
| BTC/USDT, ETH/USDT | 15m | 70080 | 2024-07-10T10:00 -> 2026-07-10T09:45 (~2.0y) |
| BTC/USDT, ETH/USDT | 1h | 17520 | 2024-07-10T10:00 -> 2026-07-10T09:00 (~2.0y) |
| BTC/USDT, ETH/USDT | 4h | 8760 | 2022-07-11T12:00 -> 2026-07-10T08:00 (~4.0y) |
| BTC/USDT, ETH/USDT | 1d | 1460 | 2022-07-12T00:00 -> 2026-07-10T00:00 (~4.0y) |
| SOL/USDT, DOGE/USDT, XRP/USDT, AVAX/USDT, LINK/USDT | 15m | 70080 | 2024-07-10T10:00 -> 2026-07-10T09:45 (~2.0y) |

**Alt selection rationale:** SOL, DOGE, XRP, AVAX, LINK — liquid Binance USDT majors with consistently
high realized volatility relative to BTC/ETH, chosen to stress-test whether the ATR-based selectivity
overlay finds a cost-covering edge more readily in higher-vol names (it does not — see Results).

### Buckets and split

52 buckets = {BTC,ETH} x {15m,1h,4h,1d} x k{1,1.5,2,3} (32) + {SOL,DOGE,XRP,AVAX,LINK} x 15m x
k{1,1.5,2,3} (20). Registered as `PRIOR_TRIALS` in `test/backtest/trial-registry.ts`.

**Split methodology — chronological 70/30 by time, NOT `walk-forward.ts`.** Each bucket runs ONE
full-series backtest with a single fresh `SeedEntryStrategy` instance start-to-finish (indicators warm
up continuously from bar 0 — no mid-series cold restart), then every closed round trip is bucketed into
train/holdout by whether its OPEN time falls before/after the series' 70%-by-bar-count timestamp. This
is safe against lookahead because the rule has **no fitted parameters** — `k` and `maxHoldBars` are
fixed constants per bucket, not estimated from data, so there is nothing for a continuous run to leak
across the split boundary that a fresh-state walk-forward re-run would prevent. `walk-forward.ts`'s
anchored/rolling multi-segment machinery exists for a different purpose (catching a regime-specific
fluke across several OOS windows); this study budgets one 70/30 split per bucket (52 total backtests),
per the task's bucket-count budget, and states that choice here rather than silently substituting it.

### Seam definition

A bucket is a SEAM only if **all three** hold:

1. Holdout net-of-cost expectancy per round trip > 0bps.
2. Holdout round trips >= 20 (below this, the sample is noise — see Caveats).
3. Holdout Sharpe survives the deflated-Sharpe selection correction (Bailey & Lopez de Prado 2014) at
   N = 52 (the full registered trial count) and V = the cross-bucket variance of holdout per-trade
   Sharpe ratios, gated at DSR > 0.95.

## Selection-correction benchmark (N = 52)

- N (registered trials) = **52**
- V (cross-bucket variance of holdout SR) = **0.0049658**
- E[max Z_52] (dimensionless False-Strategy-Theorem benchmark) = **2.2913**
- E[max Sharpe] under the null, SR0\* = sqrt(V) x E[max Z_52] = **0.16146**

Any single bucket's observed holdout Sharpe must clear ~0.161 before the deflated-Sharpe gate (DSR >
0.95) can even be reached — it is the bar a lucky draw from 52 independent zero-edge coin flips would be
expected to clear. The single best-Sharpe bucket with an adequately sized holdout sample (BTCUSDT-4h,
61 RT) posts a holdout Sharpe of 0.0306 — about **19% of the null benchmark**, nowhere near significant.

## Results — full 52-bucket table

Train/holdout expectancy is net-of-cost per round trip (10bps taker + 5bps adverse haircut per leg,
`fill-models.ts` defaults), in basis points. Holdout DSR uses the N/V above.

| Bucket | Symbol | Interval | k | Total bars | Train RT | Holdout RT | Train exp (bps/RT) | Holdout exp (bps/RT) | Holdout Sharpe | Holdout DSR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT-15m-k1 | BTCUSDT | 15m | 1 | 70080 | 1135 | 476 | -6.37 | -13.02 | -0.1665 | 3.693e-10 |
| BTCUSDT-15m-k1.5 | BTCUSDT | 15m | 1.5 | 70080 | 1130 | 473 | -6.37 | -13.08 | -0.1668 | 4.046e-10 |
| BTCUSDT-15m-k2 | BTCUSDT | 15m | 2 | 70080 | 1112 | 462 | -6.33 | -13.17 | -0.1660 | 6.416e-10 |
| BTCUSDT-15m-k3 | BTCUSDT | 15m | 3 | 70080 | 1045 | 429 | -6.54 | -13.82 | -0.1687 | 1.864e-9 |
| BTCUSDT-1h-k1 | BTCUSDT | 1h | 1 | 17520 | 262 | 117 | 4.35 | -14.96 | -0.0878 | 4.523e-3 |
| BTCUSDT-1h-k1.5 | BTCUSDT | 1h | 1.5 | 17520 | 262 | 117 | 4.35 | -14.96 | -0.0878 | 4.523e-3 |
| BTCUSDT-1h-k2 | BTCUSDT | 1h | 2 | 17520 | 262 | 117 | 4.35 | -14.96 | -0.0878 | 4.523e-3 |
| BTCUSDT-1h-k3 | BTCUSDT | 1h | 3 | 17520 | 262 | 117 | 4.35 | -14.96 | -0.0878 | 4.523e-3 |
| BTCUSDT-4h-k1 | BTCUSDT | 4h | 1 | 8760 | 123 | 61 | 44.57 | 10.20 | 0.0306 | 1.521e-1 |
| BTCUSDT-4h-k1.5 | BTCUSDT | 4h | 1.5 | 8760 | 123 | 61 | 44.57 | 10.20 | 0.0306 | 1.521e-1 |
| BTCUSDT-4h-k2 | BTCUSDT | 4h | 2 | 8760 | 123 | 61 | 44.57 | 10.20 | 0.0306 | 1.521e-1 |
| BTCUSDT-4h-k3 | BTCUSDT | 4h | 3 | 8760 | 123 | 61 | 44.57 | 10.20 | 0.0306 | 1.521e-1 |
| BTCUSDT-1d-k1 | BTCUSDT | 1d | 1 | 1460 | 23 | 8 | 135.21 | -19.53 | -0.0341 | 3.052e-1 |
| BTCUSDT-1d-k1.5 | BTCUSDT | 1d | 1.5 | 1460 | 23 | 8 | 135.21 | -19.53 | -0.0341 | 3.052e-1 |
| BTCUSDT-1d-k2 | BTCUSDT | 1d | 2 | 1460 | 23 | 8 | 135.21 | -19.53 | -0.0341 | 3.052e-1 |
| BTCUSDT-1d-k3 | BTCUSDT | 1d | 3 | 1460 | 23 | 8 | 135.21 | -19.53 | -0.0341 | 3.052e-1 |
| ETHUSDT-15m-k1 | ETHUSDT | 15m | 1 | 70080 | 1087 | 486 | 2.47 | -16.39 | -0.1524 | 7.759e-10 |
| ETHUSDT-15m-k1.5 | ETHUSDT | 15m | 1.5 | 70080 | 1087 | 486 | 2.47 | -16.39 | -0.1524 | 7.759e-10 |
| ETHUSDT-15m-k2 | ETHUSDT | 15m | 2 | 70080 | 1087 | 486 | 2.47 | -16.39 | -0.1524 | 7.759e-10 |
| ETHUSDT-15m-k3 | ETHUSDT | 15m | 3 | 70080 | 1085 | 472 | 2.46 | -16.45 | -0.1510 | 1.421e-9 |
| ETHUSDT-1h-k1 | ETHUSDT | 1h | 1 | 17520 | 291 | 112 | -2.32 | -12.02 | -0.0490 | 1.511e-2 |
| ETHUSDT-1h-k1.5 | ETHUSDT | 1h | 1.5 | 17520 | 291 | 112 | -2.32 | -12.02 | -0.0490 | 1.511e-2 |
| ETHUSDT-1h-k2 | ETHUSDT | 1h | 2 | 17520 | 291 | 112 | -2.32 | -12.02 | -0.0490 | 1.511e-2 |
| ETHUSDT-1h-k3 | ETHUSDT | 1h | 3 | 17520 | 291 | 112 | -2.32 | -12.02 | -0.0490 | 1.511e-2 |
| ETHUSDT-4h-k1 | ETHUSDT | 4h | 1 | 8760 | 137 | 66 | -11.64 | -27.50 | -0.0507 | 5.911e-2 |
| ETHUSDT-4h-k1.5 | ETHUSDT | 4h | 1.5 | 8760 | 137 | 66 | -11.64 | -27.50 | -0.0507 | 5.911e-2 |
| ETHUSDT-4h-k2 | ETHUSDT | 4h | 2 | 8760 | 137 | 66 | -11.64 | -27.50 | -0.0507 | 5.911e-2 |
| ETHUSDT-4h-k3 | ETHUSDT | 4h | 3 | 8760 | 137 | 66 | -11.64 | -27.50 | -0.0507 | 5.911e-2 |
| ETHUSDT-1d-k1 | ETHUSDT | 1d | 1 | 1460 | 23 | 7 | 159.31 | 17.40 | 0.0102 | 3.543e-1 |
| ETHUSDT-1d-k1.5 | ETHUSDT | 1d | 1.5 | 1460 | 23 | 7 | 159.31 | 17.40 | 0.0102 | 3.543e-1 |
| ETHUSDT-1d-k2 | ETHUSDT | 1d | 2 | 1460 | 23 | 7 | 159.31 | 17.40 | 0.0102 | 3.543e-1 |
| ETHUSDT-1d-k3 | ETHUSDT | 1d | 3 | 1460 | 23 | 7 | 159.31 | 17.40 | 0.0102 | 3.543e-1 |
| SOLUSDT-15m-k1 | SOLUSDT | 15m | 1 | 70080 | 1097 | 488 | -6.98 | -12.04 | -0.1026 | 3.337e-8 |
| SOLUSDT-15m-k1.5 | SOLUSDT | 15m | 1.5 | 70080 | 1097 | 488 | -6.98 | -12.04 | -0.1026 | 3.337e-8 |
| SOLUSDT-15m-k2 | SOLUSDT | 15m | 2 | 70080 | 1097 | 488 | -6.98 | -12.04 | -0.1026 | 3.337e-8 |
| SOLUSDT-15m-k3 | SOLUSDT | 15m | 3 | 70080 | 1097 | 488 | -6.98 | -12.04 | -0.1026 | 3.337e-8 |
| DOGEUSDT-15m-k1 | DOGEUSDT | 15m | 1 | 70080 | 1128 | 471 | -7.70 | -19.32 | -0.1792 | 1.291e-11 |
| DOGEUSDT-15m-k1.5 | DOGEUSDT | 15m | 1.5 | 70080 | 1128 | 471 | -7.70 | -19.32 | -0.1792 | 1.291e-11 |
| DOGEUSDT-15m-k2 | DOGEUSDT | 15m | 2 | 70080 | 1128 | 471 | -7.70 | -19.32 | -0.1792 | 1.291e-11 |
| DOGEUSDT-15m-k3 | DOGEUSDT | 15m | 3 | 70080 | 1128 | 471 | -7.70 | -19.32 | -0.1792 | 1.291e-11 |
| XRPUSDT-15m-k1 | XRPUSDT | 15m | 1 | 70080 | 1152 | 481 | -4.90 | -15.42 | -0.1458 | 2.935e-9 |
| XRPUSDT-15m-k1.5 | XRPUSDT | 15m | 1.5 | 70080 | 1152 | 481 | -4.90 | -15.42 | -0.1458 | 2.935e-9 |
| XRPUSDT-15m-k2 | XRPUSDT | 15m | 2 | 70080 | 1152 | 481 | -4.90 | -15.42 | -0.1458 | 2.935e-9 |
| XRPUSDT-15m-k3 | XRPUSDT | 15m | 3 | 70080 | 1152 | 476 | -4.90 | -15.19 | -0.1429 | 4.238e-9 |
| AVAXUSDT-15m-k1 | AVAXUSDT | 15m | 1 | 70080 | 1110 | 490 | -5.70 | -18.00 | -0.1445 | 3.511e-9 |
| AVAXUSDT-15m-k1.5 | AVAXUSDT | 15m | 1.5 | 70080 | 1110 | 490 | -5.70 | -18.00 | -0.1445 | 3.511e-9 |
| AVAXUSDT-15m-k2 | AVAXUSDT | 15m | 2 | 70080 | 1110 | 490 | -5.70 | -18.00 | -0.1445 | 3.511e-9 |
| AVAXUSDT-15m-k3 | AVAXUSDT | 15m | 3 | 70080 | 1110 | 490 | -5.70 | -18.00 | -0.1445 | 3.511e-9 |
| LINKUSDT-15m-k1 | LINKUSDT | 15m | 1 | 70080 | 1119 | 500 | -2.84 | -21.01 | -0.1852 | 9.538e-12 |
| LINKUSDT-15m-k1.5 | LINKUSDT | 15m | 1.5 | 70080 | 1119 | 500 | -2.84 | -21.01 | -0.1852 | 9.538e-12 |
| LINKUSDT-15m-k2 | LINKUSDT | 15m | 2 | 70080 | 1119 | 500 | -2.84 | -21.01 | -0.1852 | 9.538e-12 |
| LINKUSDT-15m-k3 | LINKUSDT | 15m | 3 | 70080 | 1119 | 500 | -2.84 | -21.01 | -0.1852 | 9.538e-12 |

**Observation — the k grid is largely non-binding.** Within almost every symbol x interval block, all
four k-values (1, 1.5, 2, 3 — a 3x range in the required expected-move hurdle) produce IDENTICAL or
near-identical trade counts and expectancy. This means the ATR14-implied expected move at these
timeframes routinely clears even k=3's 60bps hurdle whenever the entry/RSI/freshness gate fires at all
— the selectivity overlay screens almost nothing beyond what the entry rule itself already screens. Only
BTCUSDT-15m, ETHUSDT-15m, and XRPUSDT-15m show any k-sensitivity (a handful of trades dropped between
k=2 and k=3). This is a real empirical finding about this rule/data, not a scan bug: it means the
`k * 20bps` framing does not meaningfully differentiate strategy variants at these frequencies, and any
future study of this rule family should widen the k grid substantially (e.g. k up to 10-20) or express
selectivity in a different unit if it wants the overlay to bind.

## Seam list

**Empty. Zero of 52 buckets meet all three seam criteria.**

The closest approach: BTCUSDT-4h (all k) is the only bucket combining positive holdout expectancy
(+10.20bps/RT) with an adequately sized holdout sample (61 RT, clears the 20-RT floor) — but its
holdout Sharpe (0.0306) sits at 19% of the N=52 null benchmark (0.16146), giving a deflated Sharpe of
0.152, an order of magnitude short of the 0.95 gate. ETHUSDT-1d (all k) posts a nominally higher holdout
expectancy (+17.40bps/RT) but on only 7 holdout round trips — below the 20-RT floor, so it fails
criterion 2 outright regardless of its Sharpe.

## Recorded-entry scoring (secondary)

**Skipped: no DATABASE_URL** in this environment. `test/backtest/diagnostic/recorded-entry-scoring.ts`
implements the scoring path (gated identically to `test/eval/agentic/recorded-rows.spec.ts`: requires
both DATABASE_URL and the DB_SUITE_ALLOW_RESET/`_test`-suffix gate; loads recent `agent_decisions` rows
via `AgentDecisionJournalAdapter.recent()`, aligns each row's `eventTime` to the last BTCUSDT 15m bar at
or before it, and replays the resulting action sequence through `RecordedAgenticStrategy` over the real
harness settlement path) but was never exercised end-to-end against a live database in this run — it
returns a structured `{ skipped: true, reason }` and the diagnostic runner proceeds without blocking on
it, per the task's "skip gracefully" instruction.

## Verdict: **NO-GO**

Zero of 52 buckets clear the seam bar. Quantifying the gap against the task's reference hurdle (20bps
round-trip fee cost): the best holdout expectancy among buckets with an adequately sized sample
(RT >= 20) is BTCUSDT-4h at **+10.20bps/RT — literally about half of the raw 20bps fee hurdle**, and even
that is not statistically distinguishable from zero after the N=52 selection correction (DSR = 0.152,
need > 0.95). The nominal-best bucket by raw expectancy (ETHUSDT-1d, +17.40bps/RT) is disqualified by
sample size (7 RT). Every other bucket — 46 of 52 — has NEGATIVE holdout expectancy, several by a wide
margin (worst: LINKUSDT-15m at -21.01bps/RT).

The train-vs-holdout comparison independently corroborates NO-GO: several buckets flip sign between
train and holdout (BTCUSDT-1h: +4.35bps train -> -14.96bps holdout; BTCUSDT-1d: +135.21bps train ->
-19.53bps holdout; ETHUSDT-4h train is already negative and gets markedly worse in holdout,
-11.64 -> -27.50bps). A genuine edge should degrade gracefully out-of-sample, not invert sign — this
pattern is consistent with in-sample noise being mistaken for signal, exactly what the seam gate exists
to catch.

**Recommendation:** do not promote this rule family. If a follow-up screen is warranted, the two
highest-leverage changes are (1) widen the k grid well past 3 (the current grid is non-binding for
~85% of buckets, so it under-explores the selectivity dimension) and (2) revisit the fixed 20-bar
`maxHoldBars` — the only two buckets with positive-and-adequately-sampled holdout expectancy (BTC/ETH
4h/1d) are also the ones where 20 bars corresponds to a multi-day hold, suggesting the entry rule may
have more signal at a longer horizon than this study's fixed bar-count exit lets it capture.

## Caveats

- **Thin holdout samples are noise, not signal.** 8 of 52 buckets (the four 1d buckets per symbol) have
  holdout RT counts of 7-8, far below any threshold where a Sharpe estimate is meaningful — their DSR
  values are reported for completeness but should not be read as evidence either way.
- **This is a screen, not step-D proof.** The seam gate here (expectancy > 0, RT >= 20, DSR > 0.95) is a
  cheaper, faster bar than the full `stats.ts` 4-part gate (`evaluateGate`: tStat, DSR, MinBTL, walk-
  forward-every-segment) used for an actual promotion decision — a bucket clearing THIS screen would
  still need to clear that gate before being taken seriously as a candidate.
- **k grid is non-binding for most buckets** (see table observation above) — the 52-bucket count
  nominally covers 4 distinct selectivity levels per symbol/timeframe, but empirically covers closer to
  1-2 distinct strategies in most cases. The deflation N=52 is still the honest count of trials actually
  run and registered (`PRIOR_TRIALS`), even though several trials turned out to be behaviorally
  identical — the registry does not retroactively collapse duplicates.
- **Single 70/30 split, not walk-forward.** See Method — defensible for a zero-fitted-parameter rule,
  but a single split is still one draw; a bucket that looked marginal here could look different on a
  different split point. Given the actual results (46/52 negative, the best two disqualified by sample
  size or significance), this is very unlikely to flip the verdict.
- **maxHoldBars fixed at 20, not swept** — see Method. The real-time holding window this implies ranges
  from 5 hours (15m) to 20 days (1d) across buckets; buckets are comparable within a timeframe but not
  across timeframes on a like-for-like holding-period basis.
