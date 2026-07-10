# Funding-carry offline study — 2026-07-10

Task S2 (carry-build GO/NO-GO gate, `reports/loop/state.md`). Screens a delta-neutral funding-carry state machine (long spot + short equal-notional perp, one synthetic position of notional N) — enter when trailing funding is richly positive, exit on a flip or decay of that signal — across 7 symbols x 3 entry-lookback windows x 3 entry thresholds x 2 exit rules = 126 cells, for a genuine cost-covering funding edge. No cell was retried, reparametrized, or dropped to make a number look better — the grid is reported as-is. **Verdict: NO-GO.**

## Method

### Rule (`test/backtest/carry/carry-sim.ts`)

- **Position:** one synthetic delta-neutral unit (long spot + short equal-notional perp) of notional N = 1 — the spot leg cancels price risk by construction, so only the funding leg has PnL here. Every return below is per-unit-notional.
- **State machine, evaluated only at funding timestamps (the 8h grid), using ONLY data strictly before the decision timestamp (no lookahead):**
  - **OFF -> ON:** trailing-L-interval mean funding rate, annualized (`mean_per_8h_rate x 3 x 365`), >= H.
  - **ON -> OFF ('flip' exit):** trailing-1d (3-interval) mean funding rate <= 0.
  - **ON -> OFF ('decay' exit):** trailing-1d mean funding rate, annualized, < H/2.
- **Accrual timing (documented choice — the task spec does not pin this down verbatim):** transitions are resolved first at each funding timestamp, then accrual runs against the POST-transition state at that same timestamp. Entering ON at t_i immediately captures t_i's funding settlement; exiting to OFF at t_i does NOT capture t_i's settlement (already flat as of t_i). Symmetric — one extra interval on entry, one fewer on exit.
- **Accrual, while ON:** `fundingPayment(signedQty = -N/mark, mark, rate)` (`test/backtest/funding.ts`), mark = the 1h close at-or-before the funding timestamp. Positive rate credits the short perp (verified algebraically: signedQty = -N/mark makes `fundingPayment` reduce to exactly `N x rate`, independent of mark — the mark cancels because position size is defined as a fixed notional divided by price).
- **Costs:** 0.12% x N at entry and 0.12% x N at exit (0.24% round trip, both legs, taker + slippage haircut, fixed per the task spec).
- **Episode:** one ENTRY -> EXIT pair, net return = (accrued funding - entry cost - exit cost) / N. An open position at the end of the data window (no matching exit) is dropped, not counted — mirrors `walkRoundTrips`' closed-cycles-only convention used everywhere else in this spine.
- **Basis-sensitivity robustness band (reported, not gated):** each episode's net return is also computed at ∓2bps (`netReturn - 0.0002` / `netReturn + 0.0002`), reported as the holdout expectancy band in the grid table below.

### Data

Binance USDT-M perp OHLCV (1h) + funding-rate history, 7 symbols, already fetched: 17520 bars / 2190 funding rows each, 2024-07-10T18:00 -> 2026-07-10T17:00 (~2.0y).

| Symbol | OHLCV bars | Funding rows | Range (UTC) |
| --- | --- | --- | --- |
| BTC, ETH, SOL, DOGE, XRP, AVAX, LINK | 17520 | 2190 | 2024-07-10T18:00 -> 2026-07-10T17:00 |

### Grid and split

126 cells = 7 symbols x L{9, 21, 42} (3d/7d/14d entry lookback) x H{5%, 8%, 12%} (annualized entry threshold) x E{flip, decay} (exit rule). Each cell runs ONE continuous state-machine pass over its symbol's full funding history, then every CLOSED episode is bucketed into train/holdout by whether its entry ("open") timestamp falls before/after the 70%-by-episode-count split point — chronological 70/30 by episode open time, per the task spec.

### Walk-forward robustness check

`walk-forward.ts`'s anchored/rolling machinery is built for a BarStrategy driven bar-by-bar through `harness.ts`'s `runBacktest`; it does not fit a pre-computed per-episode return series, so this study implements a simple anchored equal-count segmentation instead (documented here rather than silently reused where its API does not apply): each cell's FULL episode series (train+holdout together, chronological) is split into up to 4 equal-count segments, and the gate requires the summed net return to be positive in EVERY segment. Applied over the full series rather than holdout-only because holdout alone is too thin to sub-segment for most cells. Fewer than 2 total episodes fails this check conservatively (cannot be meaningfully segmented).

### Deflation methodology (N = 178)

N = 178 = this study's 126 cells + the 52 pre-existing `PRIOR_TRIALS` entries (`test/backtest/trial-registry.ts`, the SeedEntryStrategy edge-diagnostic grid, `reports/loop/edge-diagnostic-2026-07-10.md`). V is the cross-trial variance of the UNION of 126 per-cell HOLDOUT Sharpe ratios (this study) and 52 FULL-SAMPLE Sharpe ratios (`trial-registry.ts`'s `harvest()`, as the task spec names it). `harvest()` cross-products every spec against every interval in its bars map rather than filtering by `spec.symbol`/`spec.interval` — to get exactly 52 honestly-paired results, this study calls `harvest()` once per prior spec with a single-spec/single-interval map. `FEE_BPS_VIP0` (10bps) + `harvest()`'s hardcoded 5bps haircut reproduces `fill-models.ts`'s `DEFAULT_FILL_CONFIG` exactly, matching the original edge-diagnostic run's fill economics.

## Selection-correction benchmark

- N (total trials, this study + PRIOR_TRIALS) = **178**
- V (cross-trial variance of the union of holdout/full-sample Sharpes) = **2650.6676846**
- E[max Z_178] (False-Strategy-Theorem benchmark) = **2.7272**
- E[max Sharpe] under the null, SR0* = sqrt(V) x E[max Z_178] = **140.4096**

**Observation — V is dominated by a handful of extreme-outlier per-cell holdout Sharpes, not by typical cross-trial spread.** The 52 PRIOR_TRIALS full-sample Sharpes are all bounded within [-0.0955, 0.0910] — the ordinary range seen in `reports/loop/edge-diagnostic-2026-07-10.md`. This study's own 126 holdout Sharpes are NOT: 10 of them exceed |SR| = 10 (worst: `BTC-L21-H8-flip` at SR -544.5897). This is a real property of the per-trade Sharpe formula (mean/population-std) applied to small holdout samples (2-23 episodes) whose net returns happen to cluster tightly around a negative mean (the fixed 24bps round-trip cost dominating a thin funding accrual in most losing episodes) — not a bug, and not filtered or reparametrized away. Separately, 37 cells have <=1 holdout episode and contribute exactly SR = 0 (`sharpeStats`' zero-variance guard on a single-point series). Net effect: V is pulled far above what the ordinary cross-trial spread would suggest, inflating SR0* to 140.41 — a bar no plausible per-trade Sharpe could clear, so the DSR component of the gate is effectively unpassable for this specific trial pool composition, independent of whether any cell has genuine edge. See Caveats.

## Results — full 126-cell grid

Train/holdout expectancy is net-of-cost per episode (0.24% round-trip cost baked into `netReturn`), in basis points. Holdout Sharpe / DSR use the N/V above. "Gate pass" is the full step-D 4-part gate (`stats.ts` `evaluateGate`: tStat > 3.0, DSR > 0.95, holdout episodes >= MinBTL, WF positive every segment); "GO" additionally requires holdout net expectancy > 0 and holdout episodes >= 8.

| Cell | Symbol | L (intervals) | H (annualized) | Exit | Episodes | Train ep | Holdout ep | Train exp (bps) | Holdout exp (bps) | Holdout ±2bps band (bps) | Holdout Sharpe | DSR | WF pass | Gate pass | GO |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC-L9-H5-flip | BTC | 9 | 5% | flip | 16 | 11 | 5 | 24.27 | 42.49 | [40.49, 44.49] | 0.8973 | 0.000e+0 | no | fail | - |
| BTC-L9-H5-decay | BTC | 9 | 5% | decay | 45 | 31 | 14 | -2.40 | -14.74 | [-16.74, -12.74] | -1.4041 | 0.000e+0 | no | fail | - |
| BTC-L9-H8-flip | BTC | 9 | 8% | flip | 11 | 7 | 4 | 63.67 | 8.02 | [6.02, 10.02] | 0.3912 | 0.000e+0 | no | fail | - |
| BTC-L9-H8-decay | BTC | 9 | 8% | decay | 19 | 13 | 6 | 15.16 | -17.93 | [-19.93, -15.93] | -3.4972 | 0.000e+0 | no | fail | - |
| BTC-L9-H12-flip | BTC | 9 | 12% | flip | 1 | 0 | 1 | n/a | 278.41 | [276.41, 280.41] | 0.0000 | 0.000e+0 | no | fail | - |
| BTC-L9-H12-decay | BTC | 9 | 12% | decay | 1 | 0 | 1 | n/a | 220.49 | [218.49, 222.49] | 0.0000 | 0.000e+0 | no | fail | - |
| BTC-L21-H5-flip | BTC | 21 | 5% | flip | 17 | 11 | 6 | 34.67 | 2.24 | [0.24, 4.24] | 0.0922 | 0.000e+0 | no | fail | - |
| BTC-L21-H5-decay | BTC | 21 | 5% | decay | 50 | 35 | 15 | -5.12 | -17.41 | [-19.41, -15.41] | -1.7871 | 0.000e+0 | no | fail | - |
| BTC-L21-H8-flip | BTC | 21 | 8% | flip | 6 | 4 | 2 | 111.71 | -16.86 | [-18.86, -14.86] | -544.5897 | 0.000e+0 | no | fail | - |
| BTC-L21-H8-decay | BTC | 21 | 8% | decay | 14 | 9 | 5 | 23.72 | -17.78 | [-19.78, -15.78] | -4.3010 | 0.000e+0 | no | fail | - |
| BTC-L21-H12-flip | BTC | 21 | 12% | flip | 1 | 0 | 1 | n/a | 273.31 | [271.31, 275.31] | 0.0000 | 0.000e+0 | no | fail | - |
| BTC-L21-H12-decay | BTC | 21 | 12% | decay | 1 | 0 | 1 | n/a | 215.39 | [213.39, 217.39] | 0.0000 | 0.000e+0 | no | fail | - |
| BTC-L42-H5-flip | BTC | 42 | 5% | flip | 25 | 17 | 8 | 17.10 | -14.50 | [-16.50, -12.50] | -0.6981 | 0.000e+0 | no | fail | - |
| BTC-L42-H5-decay | BTC | 42 | 5% | decay | 70 | 49 | 21 | -10.49 | -20.93 | [-22.93, -18.93] | -3.1736 | 0.000e+0 | no | fail | - |
| BTC-L42-H8-flip | BTC | 42 | 8% | flip | 3 | 2 | 1 | 157.90 | 105.40 | [103.40, 107.40] | 0.0000 | 0.000e+0 | no | fail | - |
| BTC-L42-H8-decay | BTC | 42 | 8% | decay | 10 | 7 | 3 | 32.57 | -19.71 | [-21.71, -17.71] | -5.5841 | 0.000e+0 | no | fail | - |
| BTC-L42-H12-flip | BTC | 42 | 12% | flip | 1 | 0 | 1 | n/a | 273.31 | [271.31, 275.31] | 0.0000 | 0.000e+0 | no | fail | - |
| BTC-L42-H12-decay | BTC | 42 | 12% | decay | 1 | 0 | 1 | n/a | 215.39 | [213.39, 217.39] | 0.0000 | 0.000e+0 | no | fail | - |
| ETH-L9-H5-flip | ETH | 9 | 5% | flip | 21 | 14 | 7 | 28.95 | -3.88 | [-5.88, -1.88] | -0.2409 | 0.000e+0 | no | fail | - |
| ETH-L9-H5-decay | ETH | 9 | 5% | decay | 40 | 28 | 12 | 1.97 | -15.02 | [-17.02, -13.02] | -1.4370 | 0.000e+0 | no | fail | - |
| ETH-L9-H8-flip | ETH | 9 | 8% | flip | 11 | 7 | 4 | 71.47 | -16.34 | [-18.34, -14.34] | -2.8548 | 0.000e+0 | no | fail | - |
| ETH-L9-H8-decay | ETH | 9 | 8% | decay | 17 | 11 | 6 | 29.86 | -17.90 | [-19.90, -15.90] | -5.5489 | 0.000e+0 | no | fail | - |
| ETH-L9-H12-flip | ETH | 9 | 12% | flip | 1 | 0 | 1 | n/a | 299.33 | [297.33, 301.33] | 0.0000 | 0.000e+0 | no | fail | - |
| ETH-L9-H12-decay | ETH | 9 | 12% | decay | 1 | 0 | 1 | n/a | 199.11 | [197.11, 201.11] | 0.0000 | 0.000e+0 | no | fail | - |
| ETH-L21-H5-flip | ETH | 21 | 5% | flip | 21 | 14 | 7 | 26.51 | -8.46 | [-10.46, -6.46] | -0.5702 | 0.000e+0 | no | fail | - |
| ETH-L21-H5-decay | ETH | 21 | 5% | decay | 45 | 31 | 14 | -1.74 | -17.44 | [-19.44, -15.44] | -1.7584 | 0.000e+0 | no | fail | - |
| ETH-L21-H8-flip | ETH | 21 | 8% | flip | 6 | 4 | 2 | 110.51 | -4.87 | [-6.87, -2.86] | -0.3236 | 0.000e+0 | no | fail | - |
| ETH-L21-H8-decay | ETH | 21 | 8% | decay | 11 | 7 | 4 | 45.77 | -16.06 | [-18.06, -14.06] | -2.3368 | 0.000e+0 | no | fail | - |
| ETH-L21-H12-flip | ETH | 21 | 12% | flip | 1 | 0 | 1 | n/a | 299.33 | [297.33, 301.33] | 0.0000 | 0.000e+0 | no | fail | - |
| ETH-L21-H12-decay | ETH | 21 | 12% | decay | 1 | 0 | 1 | n/a | 199.11 | [197.11, 201.11] | 0.0000 | 0.000e+0 | no | fail | - |
| ETH-L42-H5-flip | ETH | 42 | 5% | flip | 23 | 16 | 7 | 16.32 | -12.12 | [-14.12, -10.12] | -1.1132 | 0.000e+0 | no | fail | - |
| ETH-L42-H5-decay | ETH | 42 | 5% | decay | 59 | 41 | 18 | -8.50 | -20.47 | [-22.47, -18.47] | -2.8228 | 0.000e+0 | no | fail | - |
| ETH-L42-H8-flip | ETH | 42 | 8% | flip | 4 | 2 | 2 | 177.73 | 19.32 | [17.32, 21.32] | 1.9313 | 0.000e+0 | no | fail | - |
| ETH-L42-H8-decay | ETH | 42 | 8% | decay | 9 | 6 | 3 | 48.74 | -17.75 | [-19.75, -15.75] | -2.7265 | 0.000e+0 | no | fail | - |
| ETH-L42-H12-flip | ETH | 42 | 12% | flip | 1 | 0 | 1 | n/a | 294.55 | [292.55, 296.55] | 0.0000 | 0.000e+0 | no | fail | - |
| ETH-L42-H12-decay | ETH | 42 | 12% | decay | 1 | 0 | 1 | n/a | 194.33 | [192.33, 196.33] | 0.0000 | 0.000e+0 | no | fail | - |
| SOL-L9-H5-flip | SOL | 9 | 5% | flip | 37 | 25 | 12 | -3.97 | -20.63 | [-22.63, -18.63] | -4.7532 | 0.000e+0 | no | fail | - |
| SOL-L9-H5-decay | SOL | 9 | 5% | decay | 57 | 39 | 18 | -11.69 | -21.94 | [-23.94, -19.94] | -7.6858 | 0.000e+0 | no | fail | - |
| SOL-L9-H8-flip | SOL | 9 | 8% | flip | 19 | 13 | 6 | 10.37 | -21.45 | [-23.45, -19.45] | -10.9566 | 0.000e+0 | no | fail | - |
| SOL-L9-H8-decay | SOL | 9 | 8% | decay | 26 | 18 | 8 | -2.17 | -20.83 | [-22.83, -18.83] | -9.3473 | 0.000e+0 | no | fail | - |
| SOL-L9-H12-flip | SOL | 9 | 12% | flip | 2 | 1 | 1 | 190.51 | -20.85 | [-22.85, -18.85] | 0.0000 | 0.000e+0 | no | fail | - |
| SOL-L9-H12-decay | SOL | 9 | 12% | decay | 2 | 1 | 1 | 190.70 | -24.42 | [-26.42, -22.42] | 0.0000 | 0.000e+0 | no | fail | - |
| SOL-L21-H5-flip | SOL | 21 | 5% | flip | 29 | 20 | 9 | -1.37 | -19.80 | [-21.80, -17.80] | -4.5877 | 0.000e+0 | no | fail | - |
| SOL-L21-H5-decay | SOL | 21 | 5% | decay | 52 | 36 | 16 | -11.73 | -21.99 | [-23.99, -19.99] | -7.1638 | 0.000e+0 | no | fail | - |
| SOL-L21-H8-flip | SOL | 21 | 8% | flip | 8 | 5 | 3 | 37.12 | 3.72 | [1.72, 5.72] | 0.2370 | 0.000e+0 | no | fail | - |
| SOL-L21-H8-decay | SOL | 21 | 8% | decay | 15 | 10 | 5 | 8.81 | -21.98 | [-23.98, -19.98] | -7.8510 | 0.000e+0 | no | fail | - |
| SOL-L21-H12-flip | SOL | 21 | 12% | flip | 1 | 0 | 1 | n/a | 182.84 | [180.84, 184.84] | 0.0000 | 0.000e+0 | no | fail | - |
| SOL-L21-H12-decay | SOL | 21 | 12% | decay | 1 | 0 | 1 | n/a | 183.03 | [181.03, 185.03] | 0.0000 | 0.000e+0 | no | fail | - |
| SOL-L42-H5-flip | SOL | 42 | 5% | flip | 29 | 20 | 9 | -6.48 | -15.47 | [-17.47, -13.47] | -0.9020 | 0.000e+0 | no | fail | - |
| SOL-L42-H5-decay | SOL | 42 | 5% | decay | 51 | 35 | 16 | -14.07 | -19.42 | [-21.42, -17.42] | -2.9637 | 0.000e+0 | no | fail | - |
| SOL-L42-H8-flip | SOL | 42 | 8% | flip | 8 | 5 | 3 | 29.15 | -8.90 | [-10.90, -6.90] | -0.7725 | 0.000e+0 | no | fail | - |
| SOL-L42-H8-decay | SOL | 42 | 8% | decay | 16 | 11 | 5 | 1.97 | -23.29 | [-25.29, -21.29] | -38.3185 | 0.000e+0 | no | fail | - |
| SOL-L42-H12-flip | SOL | 42 | 12% | flip | 3 | 2 | 1 | 75.86 | -24.60 | [-26.60, -22.60] | 0.0000 | 0.000e+0 | no | fail | - |
| SOL-L42-H12-decay | SOL | 42 | 12% | decay | 4 | 2 | 2 | 76.12 | -25.07 | [-27.07, -23.07] | -31.5971 | 0.000e+0 | no | fail | - |
| DOGE-L9-H5-flip | DOGE | 9 | 5% | flip | 56 | 39 | 17 | -6.31 | -20.69 | [-22.69, -18.69] | -3.4865 | 0.000e+0 | no | fail | - |
| DOGE-L9-H5-decay | DOGE | 9 | 5% | decay | 76 | 53 | 23 | -11.11 | -21.76 | [-23.76, -19.76] | -6.0421 | 0.000e+0 | no | fail | - |
| DOGE-L9-H8-flip | DOGE | 9 | 8% | flip | 19 | 13 | 6 | 22.43 | -15.64 | [-17.64, -13.64] | -2.2957 | 0.000e+0 | no | fail | - |
| DOGE-L9-H8-decay | DOGE | 9 | 8% | decay | 26 | 18 | 8 | 7.12 | -20.88 | [-22.88, -18.88] | -5.4081 | 0.000e+0 | no | fail | - |
| DOGE-L9-H12-flip | DOGE | 9 | 12% | flip | 2 | 1 | 1 | 216.75 | -29.01 | [-31.01, -27.01] | 0.0000 | 0.000e+0 | no | fail | - |
| DOGE-L9-H12-decay | DOGE | 9 | 12% | decay | 2 | 1 | 1 | 216.75 | -27.84 | [-29.84, -25.84] | 0.0000 | 0.000e+0 | no | fail | - |
| DOGE-L21-H5-flip | DOGE | 21 | 5% | flip | 40 | 28 | 12 | -0.45 | -22.17 | [-24.17, -20.17] | -4.6423 | 0.000e+0 | no | fail | - |
| DOGE-L21-H5-decay | DOGE | 21 | 5% | decay | 64 | 44 | 20 | -9.75 | -22.29 | [-24.29, -20.29] | -7.4712 | 0.000e+0 | no | fail | - |
| DOGE-L21-H8-flip | DOGE | 21 | 8% | flip | 14 | 9 | 5 | 20.52 | 3.96 | [1.96, 5.96] | 0.1180 | 0.000e+0 | no | fail | - |
| DOGE-L21-H8-decay | DOGE | 21 | 8% | decay | 22 | 15 | 7 | 6.67 | -19.70 | [-21.70, -17.70] | -2.7982 | 0.000e+0 | no | fail | - |
| DOGE-L21-H12-flip | DOGE | 21 | 12% | flip | 1 | 0 | 1 | n/a | 213.76 | [211.76, 215.76] | 0.0000 | 0.000e+0 | no | fail | - |
| DOGE-L21-H12-decay | DOGE | 21 | 12% | decay | 1 | 0 | 1 | n/a | 213.76 | [211.76, 215.76] | 0.0000 | 0.000e+0 | no | fail | - |
| DOGE-L42-H5-flip | DOGE | 42 | 5% | flip | 43 | 30 | 13 | -10.40 | -7.10 | [-9.10, -5.10] | -0.2686 | 0.000e+0 | no | fail | - |
| DOGE-L42-H5-decay | DOGE | 42 | 5% | decay | 71 | 49 | 22 | -13.81 | -19.23 | [-21.23, -17.23] | -2.6980 | 0.000e+0 | no | fail | - |
| DOGE-L42-H8-flip | DOGE | 42 | 8% | flip | 9 | 6 | 3 | 32.10 | 14.34 | [12.34, 16.34] | 0.4657 | 0.000e+0 | no | fail | - |
| DOGE-L42-H8-decay | DOGE | 42 | 8% | decay | 18 | 12 | 6 | 3.54 | -11.77 | [-13.77, -9.77] | -0.6628 | 0.000e+0 | no | fail | - |
| DOGE-L42-H12-flip | DOGE | 42 | 12% | flip | 4 | 2 | 2 | 91.77 | -24.89 | [-26.89, -22.89] | -106.3140 | 0.000e+0 | no | fail | - |
| DOGE-L42-H12-decay | DOGE | 42 | 12% | decay | 4 | 2 | 2 | 92.67 | -23.25 | [-25.25, -21.25] | -409.6714 | 0.000e+0 | no | fail | - |
| XRP-L9-H5-flip | XRP | 9 | 5% | flip | 33 | 23 | 10 | 4.80 | -12.93 | [-14.93, -10.93] | -0.7772 | 0.000e+0 | no | fail | - |
| XRP-L9-H5-decay | XRP | 9 | 5% | decay | 56 | 39 | 17 | -7.61 | -17.79 | [-19.79, -15.79] | -1.6130 | 0.000e+0 | no | fail | - |
| XRP-L9-H8-flip | XRP | 9 | 8% | flip | 17 | 11 | 6 | 20.37 | 2.74 | [0.74, 4.74] | 0.1220 | 0.000e+0 | no | fail | - |
| XRP-L9-H8-decay | XRP | 9 | 8% | decay | 25 | 17 | 8 | 6.44 | -16.23 | [-18.23, -14.23] | -2.1191 | 0.000e+0 | no | fail | - |
| XRP-L9-H12-flip | XRP | 9 | 12% | flip | 2 | 1 | 1 | 172.61 | 12.05 | [10.05, 14.05] | 0.0000 | 0.000e+0 | yes | fail | - |
| XRP-L9-H12-decay | XRP | 9 | 12% | decay | 2 | 1 | 1 | 157.94 | 9.69 | [7.69, 11.69] | 0.0000 | 0.000e+0 | yes | fail | - |
| XRP-L21-H5-flip | XRP | 21 | 5% | flip | 32 | 22 | 10 | 3.83 | -11.90 | [-13.90, -9.90] | -0.6865 | 0.000e+0 | no | fail | - |
| XRP-L21-H5-decay | XRP | 21 | 5% | decay | 59 | 41 | 18 | -9.60 | -17.38 | [-19.38, -15.38] | -1.4647 | 0.000e+0 | no | fail | - |
| XRP-L21-H8-flip | XRP | 21 | 8% | flip | 10 | 7 | 3 | 47.25 | 2.78 | [0.78, 4.78] | 0.1713 | 0.000e+0 | no | fail | - |
| XRP-L21-H8-decay | XRP | 21 | 8% | decay | 23 | 16 | 7 | 5.36 | -18.37 | [-20.37, -16.37] | -2.8844 | 0.000e+0 | no | fail | - |
| XRP-L21-H12-flip | XRP | 21 | 12% | flip | 2 | 1 | 1 | 169.23 | 12.05 | [10.05, 14.05] | 0.0000 | 0.000e+0 | yes | fail | - |
| XRP-L21-H12-decay | XRP | 21 | 12% | decay | 3 | 2 | 1 | 70.54 | 9.69 | [7.69, 11.69] | 0.0000 | 0.000e+0 | no | fail | - |
| XRP-L42-H5-flip | XRP | 42 | 5% | flip | 33 | 23 | 10 | 0.77 | -10.63 | [-12.63, -8.63] | -0.5725 | 0.000e+0 | no | fail | - |
| XRP-L42-H5-decay | XRP | 42 | 5% | decay | 61 | 42 | 19 | -10.71 | -16.99 | [-18.99, -14.99] | -1.3442 | 0.000e+0 | no | fail | - |
| XRP-L42-H8-flip | XRP | 42 | 8% | flip | 9 | 6 | 3 | 53.39 | -6.40 | [-8.40, -4.40] | -0.6541 | 0.000e+0 | no | fail | - |
| XRP-L42-H8-decay | XRP | 42 | 8% | decay | 27 | 18 | 9 | 1.02 | -21.93 | [-23.93, -19.93] | -8.3753 | 0.000e+0 | no | fail | - |
| XRP-L42-H12-flip | XRP | 42 | 12% | flip | 3 | 2 | 1 | 79.34 | -4.02 | [-6.02, -2.02] | 0.0000 | 0.000e+0 | no | fail | - |
| XRP-L42-H12-decay | XRP | 42 | 12% | decay | 6 | 4 | 2 | 23.03 | -14.69 | [-16.69, -12.69] | -1.7674 | 0.000e+0 | no | fail | - |
| AVAX-L9-H5-flip | AVAX | 9 | 5% | flip | 54 | 37 | 17 | -10.69 | -23.39 | [-25.39, -21.39] | -10.1322 | 0.000e+0 | no | fail | - |
| AVAX-L9-H5-decay | AVAX | 9 | 5% | decay | 74 | 51 | 23 | -14.54 | -23.46 | [-25.46, -21.46] | -13.9226 | 0.000e+0 | no | fail | - |
| AVAX-L9-H8-flip | AVAX | 9 | 8% | flip | 26 | 18 | 8 | -0.48 | -23.67 | [-25.67, -21.67] | -8.8258 | 0.000e+0 | no | fail | - |
| AVAX-L9-H8-decay | AVAX | 9 | 8% | decay | 29 | 20 | 9 | -3.24 | -23.73 | [-25.73, -21.73] | -13.6424 | 0.000e+0 | no | fail | - |
| AVAX-L9-H12-flip | AVAX | 9 | 12% | flip | 1 | 0 | 1 | n/a | 172.33 | [170.33, 174.33] | 0.0000 | 0.000e+0 | no | fail | - |
| AVAX-L9-H12-decay | AVAX | 9 | 12% | decay | 1 | 0 | 1 | n/a | 172.86 | [170.86, 174.86] | 0.0000 | 0.000e+0 | no | fail | - |
| AVAX-L21-H5-flip | AVAX | 21 | 5% | flip | 38 | 26 | 12 | -8.79 | -18.72 | [-20.72, -16.72] | -2.0123 | 0.000e+0 | no | fail | - |
| AVAX-L21-H5-decay | AVAX | 21 | 5% | decay | 58 | 40 | 18 | -13.87 | -21.20 | [-23.20, -19.20] | -3.0688 | 0.000e+0 | no | fail | - |
| AVAX-L21-H8-flip | AVAX | 21 | 8% | flip | 12 | 8 | 4 | 12.06 | -13.05 | [-15.05, -11.05] | -5.7030 | 0.000e+0 | no | fail | - |
| AVAX-L21-H8-decay | AVAX | 21 | 8% | decay | 18 | 12 | 6 | 0.58 | -18.98 | [-20.98, -16.98] | -3.8589 | 0.000e+0 | no | fail | - |
| AVAX-L21-H12-flip | AVAX | 21 | 12% | flip | 1 | 0 | 1 | n/a | 166.36 | [164.36, 168.36] | 0.0000 | 0.000e+0 | no | fail | - |
| AVAX-L21-H12-decay | AVAX | 21 | 12% | decay | 1 | 0 | 1 | n/a | 166.90 | [164.90, 168.90] | 0.0000 | 0.000e+0 | no | fail | - |
| AVAX-L42-H5-flip | AVAX | 42 | 5% | flip | 28 | 19 | 9 | -5.65 | -15.25 | [-17.25, -13.25] | -1.5661 | 0.000e+0 | no | fail | - |
| AVAX-L42-H5-decay | AVAX | 42 | 5% | decay | 45 | 31 | 14 | -12.73 | -18.61 | [-20.61, -16.61] | -2.3641 | 0.000e+0 | no | fail | - |
| AVAX-L42-H8-flip | AVAX | 42 | 8% | flip | 13 | 9 | 4 | 7.33 | -11.68 | [-13.68, -9.68] | -0.9522 | 0.000e+0 | no | fail | - |
| AVAX-L42-H8-decay | AVAX | 42 | 8% | decay | 21 | 14 | 7 | -5.38 | -21.78 | [-23.78, -19.78] | -6.5022 | 0.000e+0 | no | fail | - |
| AVAX-L42-H12-flip | AVAX | 42 | 12% | flip | 3 | 2 | 1 | 57.77 | 26.27 | [24.27, 28.27] | 0.0000 | 0.000e+0 | no | fail | - |
| AVAX-L42-H12-decay | AVAX | 42 | 12% | decay | 4 | 2 | 2 | 58.35 | -24.12 | [-26.12, -22.12] | -26.6277 | 0.000e+0 | no | fail | - |
| LINK-L9-H5-flip | LINK | 9 | 5% | flip | 66 | 46 | 20 | -5.67 | -19.40 | [-21.40, -17.40] | -2.6157 | 0.000e+0 | no | fail | - |
| LINK-L9-H5-decay | LINK | 9 | 5% | decay | 99 | 69 | 30 | -12.04 | -21.33 | [-23.33, -19.33] | -3.4446 | 0.000e+0 | no | fail | - |
| LINK-L9-H8-flip | LINK | 9 | 8% | flip | 33 | 23 | 10 | 6.44 | -17.46 | [-19.46, -15.46] | -2.2679 | 0.000e+0 | no | fail | - |
| LINK-L9-H8-decay | LINK | 9 | 8% | decay | 45 | 31 | 14 | -3.96 | -20.43 | [-22.43, -18.43] | -3.6083 | 0.000e+0 | no | fail | - |
| LINK-L9-H12-flip | LINK | 9 | 12% | flip | 1 | 0 | 1 | n/a | 328.30 | [326.30, 330.30] | 0.0000 | 0.000e+0 | no | fail | - |
| LINK-L9-H12-decay | LINK | 9 | 12% | decay | 1 | 0 | 1 | n/a | 223.68 | [221.68, 225.68] | 0.0000 | 0.000e+0 | no | fail | - |
| LINK-L21-H5-flip | LINK | 21 | 5% | flip | 65 | 45 | 20 | -6.75 | -20.09 | [-22.09, -18.09] | -2.6946 | 0.000e+0 | no | fail | - |
| LINK-L21-H5-decay | LINK | 21 | 5% | decay | 97 | 67 | 30 | -12.67 | -21.22 | [-23.22, -19.22] | -3.3473 | 0.000e+0 | no | fail | - |
| LINK-L21-H8-flip | LINK | 21 | 8% | flip | 13 | 9 | 4 | 44.24 | -14.94 | [-16.94, -12.94] | -2.4636 | 0.000e+0 | no | fail | - |
| LINK-L21-H8-decay | LINK | 21 | 8% | decay | 31 | 21 | 10 | 1.11 | -16.73 | [-18.73, -14.73] | -2.0573 | 0.000e+0 | no | fail | - |
| LINK-L21-H12-flip | LINK | 21 | 12% | flip | 1 | 0 | 1 | n/a | 323.04 | [321.04, 325.04] | 0.0000 | 0.000e+0 | no | fail | - |
| LINK-L21-H12-decay | LINK | 21 | 12% | decay | 1 | 0 | 1 | n/a | 218.42 | [216.42, 220.42] | 0.0000 | 0.000e+0 | no | fail | - |
| LINK-L42-H5-flip | LINK | 42 | 5% | flip | 62 | 43 | 19 | -7.02 | -19.87 | [-21.87, -17.87] | -2.6258 | 0.000e+0 | no | fail | - |
| LINK-L42-H5-decay | LINK | 42 | 5% | decay | 85 | 59 | 26 | -11.96 | -20.51 | [-22.51, -18.51] | -3.0721 | 0.000e+0 | no | fail | - |
| LINK-L42-H8-flip | LINK | 42 | 8% | flip | 10 | 7 | 3 | 52.30 | -21.85 | [-23.85, -19.85] | -8.5924 | 0.000e+0 | no | fail | - |
| LINK-L42-H8-decay | LINK | 42 | 8% | decay | 30 | 21 | 9 | -1.24 | -20.14 | [-22.14, -18.14] | -3.8719 | 0.000e+0 | no | fail | - |
| LINK-L42-H12-flip | LINK | 42 | 12% | flip | 1 | 0 | 1 | n/a | 311.98 | [309.98, 313.98] | 0.0000 | 0.000e+0 | no | fail | - |
| LINK-L42-H12-decay | LINK | 42 | 12% | decay | 4 | 2 | 2 | 91.62 | -15.24 | [-17.24, -13.24] | -1.7073 | 0.000e+0 | no | fail | - |

## Seam / GO list

**Empty. Zero of 126 cells meet all GO criteria.**

Top 3 cells by holdout Sharpe (for reference, none reaching GO):

- `ETH-L42-H8-flip`: holdout Sharpe 1.9313, DSR 0.000e+0, holdout exp 19.32bps/episode, holdout episodes 2, gate pass = fail.
- `BTC-L9-H5-flip`: holdout Sharpe 0.8973, DSR 0.000e+0, holdout exp 42.49bps/episode, holdout episodes 5, gate pass = fail.
- `DOGE-L42-H8-flip`: holdout Sharpe 0.4657, DSR 0.000e+0, holdout exp 14.34bps/episode, holdout episodes 3, gate pass = fail.

## Verdict: **NO-GO**

Zero of 126 cells clear the GO bar. Best cell by holdout Sharpe: `ETH-L42-H8-flip` (Sharpe 1.9313, DSR 0.000e+0, holdout exp 19.32bps/episode over 2 holdout episodes) — gate pass = fail.

## Caveats

- **Single 70/30 split, not a full walk-forward, for the headline holdout expectancy.** The walk-forward check above is a separate, coarser robustness screen (positive-every-segment over the full series); it does not replace holding out a genuinely unseen final slice.
- **Funding-only PnL model.** This study excludes basis (spot-perp price) drift entirely — the position is treated as perfectly delta-neutral with zero basis risk. The ±2bps band reported per cell is a fixed robustness sensitivity, not a model of realized basis risk, which could be larger or smaller depending on venue/rebalancing frequency.
- **Costs fixed at 0.24% round trip** (0.12% x 2 legs), not swept or fit — a real deployment's costs depend on venue, order type, and size, and could differ meaningfully from this fixed assumption.
- **Demo funding is simulated** (BINANCE_DEMO_* futures-demo funding rates are synthetic/replayed, per prior program notes) — nothing in this study calibrates against demo-venue behavior; it is a pure historical-data backtest.
- **Accrual-timing asymmetry.** Entering ON at a funding timestamp captures that timestamp's settlement; exiting does not. This is mildly optimistic per episode on the entry side, partially offset by the exclusion on the exit side — not expected to materially bias the grid, but not zero either.
- **Sharpe heterogeneity in the N=178 union.** This study's 126 cells contribute HOLDOUT Sharpes; the 52 PRIOR_TRIALS entries contribute FULL-SAMPLE Sharpes (see Deflation methodology above). V is dominated by the 126 carry cells, so this has limited leverage over the benchmark — but it is not an apples-to-apples pool.
- **A handful of extreme-outlier holdout Sharpes inflate V far above the ordinary cross-trial spread** (see the Observation above the grid table) — small holdout samples whose net returns cluster tightly around a negative mean produce very large |SR| via the mean/population-std formula. This pushes the deflation benchmark (SR0*) far out of reach for any plausible per-trade Sharpe, making the DSR gate component the binding (and effectively unpassable) constraint here — not the tStat, length, or WF checks. Separately, cells with <=1 holdout episode get `sr = 0` from `sharpeStats`' zero-variance guard (the same include-all convention `run-scan.ts` uses for the edge-diagnostic grid) rather than being excluded, which moderates V slightly in the other direction. Neither effect was filtered, excluded, or reparametrized away — both are reported exactly as the specified methodology produces them.
