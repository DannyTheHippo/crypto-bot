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

Binance USDT-M perp OHLCV (1h) + funding-rate history, 7 symbols, already fetched: 26000 bars / 3250 funding rows each, 2023-07-25T14:00 -> 2026-07-12T21:00 (~2.0y).

| Symbol | OHLCV bars | Funding rows | Range (UTC) |
| --- | --- | --- | --- |
| BTC, ETH, SOL, DOGE, XRP, AVAX, LINK | 26000 | 3250 | 2023-07-25T14:00 -> 2026-07-12T21:00 |

### Grid and split

126 cells = 7 symbols x L{9, 21, 42} (3d/7d/14d entry lookback) x H{5%, 8%, 12%} (annualized entry threshold) x E{flip, decay} (exit rule). Each cell runs ONE continuous state-machine pass over its symbol's full funding history, then every CLOSED episode is bucketed into train/holdout by whether its entry ("open") timestamp falls before/after the 70%-by-episode-count split point — chronological 70/30 by episode open time, per the task spec.

### Walk-forward robustness check

`walk-forward.ts`'s anchored/rolling machinery is built for a BarStrategy driven bar-by-bar through `harness.ts`'s `runBacktest`; it does not fit a pre-computed per-episode return series, so this study implements a simple anchored equal-count segmentation instead (documented here rather than silently reused where its API does not apply): each cell's FULL episode series (train+holdout together, chronological) is split into up to 4 equal-count segments, and the gate requires the summed net return to be positive in EVERY segment. Applied over the full series rather than holdout-only because holdout alone is too thin to sub-segment for most cells. Fewer than 2 total episodes fails this check conservatively (cannot be meaningfully segmented).

### Deflation methodology (N = 178)

N = 178 = this study's 126 cells + the 52 pre-existing `PRIOR_TRIALS` entries (`test/backtest/trial-registry.ts`, the SeedEntryStrategy edge-diagnostic grid, `reports/loop/edge-diagnostic-2026-07-10.md`). V is the WINSORIZED (|SR| clipped to 3, `stats.ts`'s `winsorizedVariance`) cross-trial variance of the UNION of 126 per-cell HOLDOUT Sharpe ratios (this study) and 52 FULL-SAMPLE Sharpe ratios (`trial-registry.ts`'s `harvest()`, as the task spec names it). `harvest()` cross-products every spec against every interval in its bars map rather than filtering by `spec.symbol`/`spec.interval` — to get exactly 52 honestly-paired results, this study calls `harvest()` once per prior spec with a single-spec/single-interval map. `FEE_BPS_VIP0` (10bps) + `harvest()`'s hardcoded 5bps haircut reproduces `fill-models.ts`'s `DEFAULT_FILL_CONFIG` exactly, matching the original edge-diagnostic run's fill economics.

## Selection-correction benchmark

- N (total trials, this study + PRIOR_TRIALS) = **178**
- V (winsorized cross-trial variance of the union of holdout/full-sample Sharpes) = **1.7369730**
- E[max Z_178] (False-Strategy-Theorem benchmark) = **2.7272**
- E[max Sharpe] under the null, SR0* = sqrt(V) x E[max Z_178] = **3.5943**

**Observation — V is dominated by a handful of extreme-outlier per-cell holdout Sharpes, not by typical cross-trial spread.** The 52 PRIOR_TRIALS full-sample Sharpes are all bounded within [-0.0955, 0.0910] — the ordinary range seen in `reports/loop/edge-diagnostic-2026-07-10.md`. This study's own 126 holdout Sharpes are NOT: 5 of them exceed |SR| = 10 (worst: `SOL-L42-H12-flip` at SR -114.7859). This is a real property of the per-trade Sharpe formula (mean/population-std) applied to small holdout samples (2-23 episodes) whose net returns happen to cluster tightly around a negative mean (the fixed 24bps round-trip cost dominating a thin funding accrual in most losing episodes) — not a bug, and not filtered or reparametrized away. Separately, 18 cells have <=1 holdout episode and contribute exactly SR = 0 (`sharpeStats`' zero-variance guard on a single-point series). Net effect: V is pulled far above what the ordinary cross-trial spread would suggest, inflating SR0* to 3.59 — a bar no plausible per-trade Sharpe could clear, so the DSR component of the gate is effectively unpassable for this specific trial pool composition, independent of whether any cell has genuine edge. See Caveats.

## Results — full 126-cell grid

Train/holdout expectancy is net-of-cost per episode (0.24% round-trip cost baked into `netReturn`), in basis points. Holdout Sharpe / DSR use the N/V above. "Gate pass" is the full step-D 4-part gate (`stats.ts` `evaluateGate`: tStat > 3.0, DSR > 0.95, holdout episodes >= MinBTL, WF positive every segment); "GO" additionally requires holdout net expectancy > 0 and holdout episodes >= 8.

| Cell | Symbol | L (intervals) | H (annualized) | Exit | Episodes | Train ep | Holdout ep | Train exp (bps) | Holdout exp (bps) | Holdout ±2bps band (bps) | Holdout Sharpe | DSR | WF pass | Gate pass | GO |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC-L9-H5-flip | BTC | 9 | 5% | flip | 21 | 14 | 7 | 97.36 | 23.75 | [21.75, 25.75] | 0.4770 | 0.000e+0 | no | fail | - |
| BTC-L9-H5-decay | BTC | 9 | 5% | decay | 56 | 39 | 17 | 22.06 | -15.02 | [-17.02, -13.02] | -1.5029 | 0.000e+0 | no | fail | - |
| BTC-L9-H8-flip | BTC | 9 | 8% | flip | 14 | 9 | 5 | 151.75 | 31.65 | [29.65, 33.65] | 0.6243 | 0.000e+0 | yes | fail | - |
| BTC-L9-H8-decay | BTC | 9 | 8% | decay | 24 | 16 | 8 | 76.27 | -15.70 | [-17.70, -13.70] | -2.6617 | 0.000e+0 | no | fail | - |
| BTC-L9-H12-flip | BTC | 9 | 12% | flip | 3 | 2 | 1 | 470.92 | 278.41 | [276.41, 280.41] | 0.0000 | 0.000e+0 | yes | fail | - |
| BTC-L9-H12-decay | BTC | 9 | 12% | decay | 4 | 2 | 2 | 395.59 | 127.63 | [125.63, 129.63] | 1.3744 | 1.321e-2 | yes | fail | - |
| BTC-L21-H5-flip | BTC | 21 | 5% | flip | 24 | 16 | 8 | 76.74 | 19.39 | [17.39, 21.39] | 0.4240 | 0.000e+0 | yes | fail | - |
| BTC-L21-H5-decay | BTC | 21 | 5% | decay | 66 | 46 | 20 | 14.44 | -17.10 | [-19.10, -15.10] | -1.8235 | 0.000e+0 | no | fail | - |
| BTC-L21-H8-flip | BTC | 21 | 8% | flip | 9 | 6 | 3 | 224.71 | 28.23 | [26.23, 30.23] | 0.4428 | 6.328e-8 | yes | fail | - |
| BTC-L21-H8-decay | BTC | 21 | 8% | decay | 20 | 14 | 6 | 84.77 | -16.90 | [-18.90, -14.90] | -3.9770 | 7.590e-12 | no | fail | - |
| BTC-L21-H12-flip | BTC | 21 | 12% | flip | 3 | 2 | 1 | 459.14 | 273.31 | [271.31, 275.31] | 0.0000 | 0.000e+0 | yes | fail | - |
| BTC-L21-H12-decay | BTC | 21 | 12% | decay | 4 | 2 | 2 | 391.18 | 116.94 | [114.94, 118.94] | 1.1878 | 8.052e-3 | yes | fail | - |
| BTC-L42-H5-flip | BTC | 42 | 5% | flip | 37 | 25 | 12 | 48.05 | -14.81 | [-16.81, -12.81] | -0.7795 | 1.166e-15 | no | fail | - |
| BTC-L42-H5-decay | BTC | 42 | 5% | decay | 97 | 67 | 30 | 2.19 | -20.79 | [-22.79, -18.79] | -3.0964 | 1.995e-13 | no | fail | - |
| BTC-L42-H8-flip | BTC | 42 | 8% | flip | 10 | 7 | 3 | 128.20 | 140.40 | [138.40, 142.40] | 0.9466 | 1.252e-5 | no | fail | - |
| BTC-L42-H8-decay | BTC | 42 | 8% | decay | 23 | 16 | 7 | 60.88 | -9.31 | [-11.31, -7.31] | -0.5176 | 4.996e-16 | no | fail | - |
| BTC-L42-H12-flip | BTC | 42 | 12% | flip | 2 | 1 | 1 | 833.64 | 273.31 | [271.31, 275.31] | 0.0000 | 0.000e+0 | yes | fail | - |
| BTC-L42-H12-decay | BTC | 42 | 12% | decay | 4 | 2 | 2 | 382.44 | 96.18 | [94.18, 98.18] | 0.8067 | 2.655e-3 | no | fail | - |
| ETH-L9-H5-flip | ETH | 9 | 5% | flip | 25 | 17 | 8 | 92.64 | -6.25 | [-8.25, -4.25] | -0.3829 | 0.000e+0 | no | fail | - |
| ETH-L9-H5-decay | ETH | 9 | 5% | decay | 48 | 33 | 15 | 35.32 | -16.21 | [-18.21, -14.21] | -1.6585 | 4.996e-16 | no | fail | - |
| ETH-L9-H8-flip | ETH | 9 | 8% | flip | 13 | 9 | 4 | 187.13 | -16.34 | [-18.34, -14.34] | -2.8548 | 1.763e-11 | no | fail | - |
| ETH-L9-H8-decay | ETH | 9 | 8% | decay | 24 | 16 | 8 | 84.28 | -15.51 | [-17.51, -13.51] | -2.7500 | 1.792e-9 | no | fail | - |
| ETH-L9-H12-flip | ETH | 9 | 12% | flip | 3 | 2 | 1 | 540.21 | 299.33 | [297.33, 301.33] | 0.0000 | 0.000e+0 | yes | fail | - |
| ETH-L9-H12-decay | ETH | 9 | 12% | decay | 3 | 2 | 1 | 487.07 | 199.11 | [197.11, 201.11] | 0.0000 | 0.000e+0 | yes | fail | - |
| ETH-L21-H5-flip | ETH | 21 | 5% | flip | 26 | 18 | 8 | 84.01 | -10.57 | [-12.57, -8.57] | -0.7065 | 0.000e+0 | no | fail | - |
| ETH-L21-H5-decay | ETH | 21 | 5% | decay | 52 | 36 | 16 | 29.48 | -18.34 | [-20.34, -16.34] | -1.9141 | 1.543e-14 | no | fail | - |
| ETH-L21-H8-flip | ETH | 21 | 8% | flip | 8 | 5 | 3 | 314.40 | 2.86 | [0.86, 4.86] | 0.1741 | 2.093e-6 | no | fail | - |
| ETH-L21-H8-decay | ETH | 21 | 8% | decay | 18 | 12 | 6 | 110.57 | -11.76 | [-13.76, -9.76] | -0.8184 | 2.210e-11 | no | fail | - |
| ETH-L21-H12-flip | ETH | 21 | 12% | flip | 3 | 2 | 1 | 527.55 | 299.33 | [297.33, 301.33] | 0.0000 | 0.000e+0 | yes | fail | - |
| ETH-L21-H12-decay | ETH | 21 | 12% | decay | 3 | 2 | 1 | 474.40 | 199.11 | [197.11, 201.11] | 0.0000 | 0.000e+0 | yes | fail | - |
| ETH-L42-H5-flip | ETH | 42 | 5% | flip | 29 | 20 | 9 | 69.62 | -14.33 | [-16.33, -12.33] | -1.3675 | 0.000e+0 | no | fail | - |
| ETH-L42-H5-decay | ETH | 42 | 5% | decay | 68 | 47 | 21 | 15.68 | -20.95 | [-22.95, -18.95] | -3.0727 | 6.813e-11 | no | fail | - |
| ETH-L42-H8-flip | ETH | 42 | 8% | flip | 6 | 4 | 2 | 369.74 | 19.32 | [17.32, 21.32] | 1.9313 | 4.815e-2 | no | fail | - |
| ETH-L42-H8-decay | ETH | 42 | 8% | decay | 19 | 13 | 6 | 95.35 | -15.35 | [-17.35, -13.35] | -1.3040 | 8.341e-10 | no | fail | - |
| ETH-L42-H12-flip | ETH | 42 | 12% | flip | 3 | 2 | 1 | 508.68 | 294.55 | [292.55, 296.55] | 0.0000 | 0.000e+0 | yes | fail | - |
| ETH-L42-H12-decay | ETH | 42 | 12% | decay | 3 | 2 | 1 | 455.54 | 194.33 | [192.33, 196.33] | 0.0000 | 0.000e+0 | yes | fail | - |
| SOL-L9-H5-flip | SOL | 9 | 5% | flip | 47 | 32 | 15 | 33.31 | -20.78 | [-22.78, -18.78] | -5.1590 | 2.221e-10 | no | fail | - |
| SOL-L9-H5-decay | SOL | 9 | 5% | decay | 74 | 51 | 23 | 11.06 | -21.14 | [-23.14, -19.14] | -6.5788 | 0.000e+0 | no | fail | - |
| SOL-L9-H8-flip | SOL | 9 | 8% | flip | 26 | 18 | 8 | 70.05 | -15.30 | [-17.30, -13.30] | -1.0023 | 3.976e-9 | no | fail | - |
| SOL-L9-H8-decay | SOL | 9 | 8% | decay | 36 | 25 | 11 | 42.07 | -20.58 | [-22.58, -18.58] | -7.2044 | 7.286e-10 | no | fail | - |
| SOL-L9-H12-flip | SOL | 9 | 12% | flip | 4 | 2 | 2 | 563.09 | 84.83 | [82.83, 86.83] | 0.8027 | 2.623e-3 | no | fail | - |
| SOL-L9-H12-decay | SOL | 9 | 12% | decay | 4 | 2 | 2 | 561.49 | 83.14 | [81.14, 85.14] | 0.7729 | 2.391e-3 | no | fail | - |
| SOL-L21-H5-flip | SOL | 21 | 5% | flip | 42 | 29 | 13 | 35.97 | -17.02 | [-19.02, -15.02] | -1.1678 | 2.803e-10 | no | fail | - |
| SOL-L21-H5-decay | SOL | 21 | 5% | decay | 78 | 54 | 24 | 7.77 | -20.19 | [-22.19, -18.19] | -3.4987 | 9.792e-11 | no | fail | - |
| SOL-L21-H8-flip | SOL | 21 | 8% | flip | 14 | 9 | 5 | 146.37 | -6.73 | [-8.73, -4.73] | -0.3805 | 6.389e-14 | no | fail | - |
| SOL-L21-H8-decay | SOL | 21 | 8% | decay | 24 | 16 | 8 | 71.01 | -17.89 | [-19.89, -15.89] | -1.5547 | 1.595e-7 | no | fail | - |
| SOL-L21-H12-flip | SOL | 21 | 12% | flip | 4 | 2 | 2 | 528.12 | 110.99 | [108.99, 112.99] | 1.5447 | 2.020e-2 | no | fail | - |
| SOL-L21-H12-decay | SOL | 21 | 12% | decay | 6 | 4 | 2 | 250.78 | 109.19 | [107.19, 111.19] | 1.4788 | 1.719e-2 | no | fail | - |
| SOL-L42-H5-flip | SOL | 42 | 5% | flip | 43 | 30 | 13 | 31.10 | -15.06 | [-17.06, -13.06] | -0.9369 | 7.772e-16 | no | fail | - |
| SOL-L42-H5-decay | SOL | 42 | 5% | decay | 78 | 54 | 24 | 7.10 | -21.04 | [-23.04, -19.04] | -3.6088 | 1.813e-9 | no | fail | - |
| SOL-L42-H8-flip | SOL | 42 | 8% | flip | 14 | 9 | 5 | 144.48 | -15.34 | [-17.34, -13.34] | -1.2877 | 6.106e-15 | no | fail | - |
| SOL-L42-H8-decay | SOL | 42 | 8% | decay | 32 | 22 | 10 | 43.22 | -21.81 | [-23.81, -19.81] | -3.5069 | 6.354e-5 | no | fail | - |
| SOL-L42-H12-flip | SOL | 42 | 12% | flip | 6 | 4 | 2 | 309.98 | -24.39 | [-26.39, -22.39] | -114.7859 | 0.000e+0 | no | fail | - |
| SOL-L42-H12-decay | SOL | 42 | 12% | decay | 15 | 10 | 5 | 88.97 | 15.82 | [13.82, 17.82] | 0.1974 | 7.772e-16 | no | fail | - |
| DOGE-L9-H5-flip | DOGE | 9 | 5% | flip | 67 | 46 | 21 | 20.57 | -20.10 | [-22.10, -18.10] | -3.4132 | 5.551e-17 | no | fail | - |
| DOGE-L9-H5-decay | DOGE | 9 | 5% | decay | 95 | 66 | 29 | 6.92 | -21.40 | [-23.40, -19.40] | -5.7104 | 0.000e+0 | no | fail | - |
| DOGE-L9-H8-flip | DOGE | 9 | 8% | flip | 27 | 18 | 9 | 74.67 | -2.11 | [-4.11, -0.11] | -0.0731 | 0.000e+0 | no | fail | - |
| DOGE-L9-H8-decay | DOGE | 9 | 8% | decay | 38 | 26 | 12 | 46.32 | -19.09 | [-21.09, -17.09] | -3.2665 | 0.000e+0 | no | fail | - |
| DOGE-L9-H12-flip | DOGE | 9 | 12% | flip | 4 | 2 | 2 | 569.39 | 93.87 | [91.87, 95.87] | 0.7639 | 2.325e-3 | no | fail | - |
| DOGE-L9-H12-decay | DOGE | 9 | 12% | decay | 4 | 2 | 2 | 567.58 | 94.46 | [92.46, 96.46] | 0.7724 | 2.387e-3 | no | fail | - |
| DOGE-L21-H5-flip | DOGE | 21 | 5% | flip | 57 | 39 | 18 | 22.93 | -12.40 | [-14.40, -10.40] | -0.4994 | 0.000e+0 | no | fail | - |
| DOGE-L21-H5-decay | DOGE | 21 | 5% | decay | 91 | 63 | 28 | 6.28 | -20.25 | [-22.25, -18.25] | -3.0274 | 9.581e-14 | no | fail | - |
| DOGE-L21-H8-flip | DOGE | 21 | 8% | flip | 22 | 15 | 7 | 89.17 | -3.20 | [-5.20, -1.20] | -0.1047 | 0.000e+0 | no | fail | - |
| DOGE-L21-H8-decay | DOGE | 21 | 8% | decay | 36 | 25 | 11 | 42.72 | -14.87 | [-16.87, -12.87] | -0.8592 | 2.575e-12 | no | fail | - |
| DOGE-L21-H12-flip | DOGE | 21 | 12% | flip | 3 | 2 | 1 | 556.02 | 213.76 | [211.76, 215.76] | 0.0000 | 0.000e+0 | yes | fail | - |
| DOGE-L21-H12-decay | DOGE | 21 | 12% | decay | 3 | 2 | 1 | 554.21 | 213.76 | [211.76, 215.76] | 0.0000 | 0.000e+0 | yes | fail | - |
| DOGE-L42-H5-flip | DOGE | 42 | 5% | flip | 66 | 46 | 20 | 13.57 | -12.29 | [-14.29, -10.29] | -0.5457 | 0.000e+0 | no | fail | - |
| DOGE-L42-H5-decay | DOGE | 42 | 5% | decay | 105 | 73 | 32 | -0.31 | -17.48 | [-19.48, -15.48] | -1.3464 | 2.498e-15 | no | fail | - |
| DOGE-L42-H8-flip | DOGE | 42 | 8% | flip | 16 | 11 | 5 | 120.59 | -1.35 | [-3.35, 0.65] | -0.0441 | 4.639e-13 | yes | fail | - |
| DOGE-L42-H8-decay | DOGE | 42 | 8% | decay | 36 | 25 | 11 | 38.53 | -17.06 | [-19.06, -15.06] | -1.1899 | 3.054e-10 | no | fail | - |
| DOGE-L42-H12-flip | DOGE | 42 | 12% | flip | 7 | 4 | 3 | 322.20 | -25.07 | [-27.07, -23.07] | -77.5538 | 1.780e-5 | no | fail | - |
| DOGE-L42-H12-decay | DOGE | 42 | 12% | decay | 12 | 8 | 4 | 117.63 | 34.71 | [32.71, 36.71] | 0.3450 | 1.056e-12 | no | fail | - |
| XRP-L9-H5-flip | XRP | 9 | 5% | flip | 44 | 30 | 14 | 42.47 | -8.30 | [-10.30, -6.30] | -0.3692 | 0.000e+0 | no | fail | - |
| XRP-L9-H5-decay | XRP | 9 | 5% | decay | 71 | 49 | 22 | 16.34 | -14.67 | [-16.67, -12.67] | -0.8624 | 0.000e+0 | no | fail | - |
| XRP-L9-H8-flip | XRP | 9 | 8% | flip | 23 | 16 | 7 | 94.12 | -1.09 | [-3.09, 0.91] | -0.0477 | 0.000e+0 | no | fail | - |
| XRP-L9-H8-decay | XRP | 9 | 8% | decay | 36 | 25 | 11 | 48.86 | -12.54 | [-14.54, -10.54] | -0.7028 | 1.155e-14 | no | fail | - |
| XRP-L9-H12-flip | XRP | 9 | 12% | flip | 4 | 2 | 2 | 589.90 | 92.33 | [90.33, 94.33] | 1.1501 | 7.258e-3 | yes | fail | - |
| XRP-L9-H12-decay | XRP | 9 | 12% | decay | 4 | 2 | 2 | 570.87 | 83.81 | [81.81, 85.81] | 1.1307 | 6.877e-3 | yes | fail | - |
| XRP-L21-H5-flip | XRP | 21 | 5% | flip | 45 | 31 | 14 | 38.66 | -8.69 | [-10.69, -6.69] | -0.3773 | 0.000e+0 | no | fail | - |
| XRP-L21-H5-decay | XRP | 21 | 5% | decay | 79 | 55 | 24 | 11.14 | -15.65 | [-17.65, -13.65] | -0.9447 | 0.000e+0 | no | fail | - |
| XRP-L21-H8-flip | XRP | 21 | 8% | flip | 15 | 10 | 5 | 153.11 | 7.25 | [5.25, 9.25] | 0.4029 | 1.867e-11 | yes | fail | - |
| XRP-L21-H8-decay | XRP | 21 | 8% | decay | 32 | 22 | 10 | 57.39 | -19.26 | [-21.26, -17.26] | -3.4381 | 3.024e-9 | no | fail | - |
| XRP-L21-H12-flip | XRP | 21 | 12% | flip | 4 | 2 | 2 | 584.83 | 90.64 | [88.64, 92.64] | 1.1533 | 7.324e-3 | yes | fail | - |
| XRP-L21-H12-decay | XRP | 21 | 12% | decay | 6 | 4 | 2 | 315.79 | -1.89 | [-3.89, 0.11] | -0.1633 | 8.580e-5 | no | fail | - |
| XRP-L42-H5-flip | XRP | 42 | 5% | flip | 51 | 35 | 16 | 30.21 | -9.55 | [-11.55, -7.55] | -0.4347 | 0.000e+0 | no | fail | - |
| XRP-L42-H5-decay | XRP | 42 | 5% | decay | 87 | 60 | 27 | 7.59 | -15.93 | [-17.93, -13.93] | -0.9788 | 0.000e+0 | no | fail | - |
| XRP-L42-H8-flip | XRP | 42 | 8% | flip | 17 | 11 | 6 | 125.38 | 7.47 | [5.47, 9.47] | 0.3416 | 2.776e-16 | yes | fail | - |
| XRP-L42-H8-decay | XRP | 42 | 8% | decay | 43 | 30 | 13 | 32.92 | -18.85 | [-20.85, -16.85] | -1.5237 | 4.403e-8 | no | fail | - |
| XRP-L42-H12-flip | XRP | 42 | 12% | flip | 5 | 3 | 2 | 437.43 | -5.59 | [-7.59, -3.59] | -3.5434 | 4.777e-13 | no | fail | - |
| XRP-L42-H12-decay | XRP | 42 | 12% | decay | 13 | 9 | 4 | 125.69 | -18.74 | [-20.74, -16.74] | -2.6249 | 9.148e-6 | no | fail | - |
| AVAX-L9-H5-flip | AVAX | 9 | 5% | flip | 69 | 48 | 21 | 14.66 | -23.71 | [-25.71, -21.71] | -10.8537 | 1.702e-6 | no | fail | - |
| AVAX-L9-H5-decay | AVAX | 9 | 5% | decay | 96 | 67 | 29 | 3.32 | -23.52 | [-25.52, -21.52] | -13.8197 | 6.193e-10 | no | fail | - |
| AVAX-L9-H8-flip | AVAX | 9 | 8% | flip | 34 | 23 | 11 | 50.54 | -21.83 | [-23.83, -19.83] | -2.9859 | 4.801e-6 | no | fail | - |
| AVAX-L9-H8-decay | AVAX | 9 | 8% | decay | 38 | 26 | 12 | 41.18 | -22.08 | [-24.08, -20.08] | -3.6269 | 3.328e-5 | no | fail | - |
| AVAX-L9-H12-flip | AVAX | 9 | 12% | flip | 3 | 2 | 1 | 571.42 | 172.33 | [170.33, 174.33] | 0.0000 | 0.000e+0 | yes | fail | - |
| AVAX-L9-H12-decay | AVAX | 9 | 12% | decay | 3 | 2 | 1 | 571.39 | 172.86 | [170.86, 174.86] | 0.0000 | 0.000e+0 | yes | fail | - |
| AVAX-L21-H5-flip | AVAX | 21 | 5% | flip | 52 | 36 | 16 | 23.33 | -17.70 | [-19.70, -15.70] | -1.6841 | 0.000e+0 | no | fail | - |
| AVAX-L21-H5-decay | AVAX | 21 | 5% | decay | 85 | 59 | 26 | 5.21 | -21.32 | [-23.32, -19.32] | -3.4857 | 7.514e-7 | no | fail | - |
| AVAX-L21-H8-flip | AVAX | 21 | 8% | flip | 19 | 13 | 6 | 92.28 | -7.59 | [-9.59, -5.59] | -0.5518 | 1.473e-10 | no | fail | - |
| AVAX-L21-H8-decay | AVAX | 21 | 8% | decay | 28 | 19 | 9 | 58.19 | -20.25 | [-22.25, -18.25] | -4.5625 | 3.023e-13 | no | fail | - |
| AVAX-L21-H12-flip | AVAX | 21 | 12% | flip | 3 | 2 | 1 | 567.10 | 166.36 | [164.36, 168.36] | 0.0000 | 0.000e+0 | yes | fail | - |
| AVAX-L21-H12-decay | AVAX | 21 | 12% | decay | 5 | 3 | 2 | 349.48 | 102.91 | [100.91, 104.91] | 1.6081 | 2.351e-2 | no | fail | - |
| AVAX-L42-H5-flip | AVAX | 42 | 5% | flip | 48 | 33 | 15 | 24.22 | -12.86 | [-14.86, -10.86] | -0.9151 | 0.000e+0 | no | fail | - |
| AVAX-L42-H5-decay | AVAX | 42 | 5% | decay | 75 | 52 | 23 | 7.65 | -19.35 | [-21.35, -17.35] | -2.7461 | 5.274e-12 | no | fail | - |
| AVAX-L42-H8-flip | AVAX | 42 | 8% | flip | 18 | 12 | 6 | 100.27 | -10.87 | [-12.87, -8.87] | -0.8250 | 0.000e+0 | no | fail | - |
| AVAX-L42-H8-decay | AVAX | 42 | 8% | decay | 34 | 23 | 11 | 39.74 | -19.84 | [-21.84, -17.84] | -2.4081 | 7.790e-7 | no | fail | - |
| AVAX-L42-H12-flip | AVAX | 42 | 12% | flip | 5 | 3 | 2 | 419.37 | 0.62 | [-1.38, 2.62] | 0.0242 | 1.785e-4 | yes | fail | - |
| AVAX-L42-H12-decay | AVAX | 42 | 12% | decay | 9 | 6 | 3 | 198.14 | -24.22 | [-26.22, -22.22] | -32.1642 | 1.139e-5 | no | fail | - |
| LINK-L9-H5-flip | LINK | 9 | 5% | flip | 77 | 53 | 24 | 16.57 | -19.49 | [-21.49, -17.49] | -2.7874 | 7.933e-14 | no | fail | - |
| LINK-L9-H5-decay | LINK | 9 | 5% | decay | 117 | 81 | 36 | 2.17 | -21.42 | [-23.42, -19.42] | -3.6875 | 5.650e-10 | no | fail | - |
| LINK-L9-H8-flip | LINK | 9 | 8% | flip | 41 | 28 | 13 | 46.82 | -18.98 | [-20.98, -16.98] | -2.5915 | 1.901e-11 | no | fail | - |
| LINK-L9-H8-decay | LINK | 9 | 8% | decay | 58 | 40 | 18 | 21.71 | -19.82 | [-21.82, -17.82] | -3.2349 | 0.000e+0 | no | fail | - |
| LINK-L9-H12-flip | LINK | 9 | 12% | flip | 3 | 2 | 1 | 512.86 | 328.30 | [326.30, 330.30] | 0.0000 | 0.000e+0 | yes | fail | - |
| LINK-L9-H12-decay | LINK | 9 | 12% | decay | 3 | 2 | 1 | 510.15 | 223.68 | [221.68, 225.68] | 0.0000 | 0.000e+0 | yes | fail | - |
| LINK-L21-H5-flip | LINK | 21 | 5% | flip | 78 | 54 | 24 | 14.61 | -20.42 | [-22.42, -18.42] | -2.9027 | 5.071e-9 | no | fail | - |
| LINK-L21-H5-decay | LINK | 21 | 5% | decay | 123 | 86 | 37 | -0.26 | -21.05 | [-23.05, -19.05] | -3.4989 | 1.798e-9 | no | fail | - |
| LINK-L21-H8-flip | LINK | 21 | 8% | flip | 20 | 14 | 6 | 98.31 | 2.58 | [0.58, 4.58] | 0.0761 | 0.000e+0 | no | fail | - |
| LINK-L21-H8-decay | LINK | 21 | 8% | decay | 45 | 31 | 14 | 29.96 | -15.19 | [-17.19, -13.19] | -1.1493 | 5.329e-15 | no | fail | - |
| LINK-L21-H12-flip | LINK | 21 | 12% | flip | 3 | 2 | 1 | 511.41 | 323.04 | [321.04, 325.04] | 0.0000 | 0.000e+0 | yes | fail | - |
| LINK-L21-H12-decay | LINK | 21 | 12% | decay | 5 | 3 | 2 | 311.27 | 128.00 | [126.00, 130.00] | 1.4156 | 1.468e-2 | no | fail | - |
| LINK-L42-H5-flip | LINK | 42 | 5% | flip | 78 | 54 | 24 | 13.48 | -20.23 | [-22.23, -18.23] | -2.9087 | 7.605e-9 | no | fail | - |
| LINK-L42-H5-decay | LINK | 42 | 5% | decay | 117 | 81 | 36 | 0.12 | -19.98 | [-21.98, -17.98] | -2.7812 | 1.110e-16 | no | fail | - |
| LINK-L42-H8-flip | LINK | 42 | 8% | flip | 20 | 14 | 6 | 92.87 | -6.65 | [-8.65, -4.65] | -0.2017 | 2.886e-13 | no | fail | - |
| LINK-L42-H8-decay | LINK | 42 | 8% | decay | 53 | 37 | 16 | 19.06 | -19.11 | [-21.11, -17.11] | -1.9869 | 7.463e-9 | no | fail | - |
| LINK-L42-H12-flip | LINK | 42 | 12% | flip | 3 | 2 | 1 | 498.63 | 311.98 | [309.98, 313.98] | 0.0000 | 0.000e+0 | yes | fail | - |
| LINK-L42-H12-decay | LINK | 42 | 12% | decay | 8 | 5 | 3 | 230.64 | -18.20 | [-20.20, -16.20] | -2.1656 | 1.982e-6 | no | fail | - |

## Seam / GO list

**Empty. Zero of 126 cells meet all GO criteria.**

Top 3 cells by holdout Sharpe (for reference, none reaching GO):

- `ETH-L42-H8-flip`: holdout Sharpe 1.9313, DSR 4.815e-2, holdout exp 19.32bps/episode, holdout episodes 2, gate pass = fail.
- `AVAX-L21-H12-decay`: holdout Sharpe 1.6081, DSR 2.351e-2, holdout exp 102.91bps/episode, holdout episodes 2, gate pass = fail.
- `SOL-L21-H12-flip`: holdout Sharpe 1.5447, DSR 2.020e-2, holdout exp 110.99bps/episode, holdout episodes 2, gate pass = fail.

## Verdict: **NO-GO**

Zero of 126 cells clear the GO bar. Best cell by holdout Sharpe: `ETH-L42-H8-flip` (Sharpe 1.9313, DSR 4.815e-2, holdout exp 19.32bps/episode over 2 holdout episodes) — gate pass = fail.

## Caveats

- **Single 70/30 split, not a full walk-forward, for the headline holdout expectancy.** The walk-forward check above is a separate, coarser robustness screen (positive-every-segment over the full series); it does not replace holding out a genuinely unseen final slice.
- **Funding-only PnL model.** This study excludes basis (spot-perp price) drift entirely — the position is treated as perfectly delta-neutral with zero basis risk. The ±2bps band reported per cell is a fixed robustness sensitivity, not a model of realized basis risk, which could be larger or smaller depending on venue/rebalancing frequency.
- **Costs fixed at 0.24% round trip** (0.12% x 2 legs), not swept or fit — a real deployment's costs depend on venue, order type, and size, and could differ meaningfully from this fixed assumption.
- **Demo funding is simulated** (BINANCE_DEMO_* futures-demo funding rates are synthetic/replayed, per prior program notes) — nothing in this study calibrates against demo-venue behavior; it is a pure historical-data backtest.
- **Accrual-timing asymmetry.** Entering ON at a funding timestamp captures that timestamp's settlement; exiting does not. This is mildly optimistic per episode on the entry side, partially offset by the exclusion on the exit side — not expected to materially bias the grid, but not zero either.
- **Sharpe heterogeneity in the N=178 union.** This study's 126 cells contribute HOLDOUT Sharpes; the 52 PRIOR_TRIALS entries contribute FULL-SAMPLE Sharpes (see Deflation methodology above). V is dominated by the 126 carry cells, so this has limited leverage over the benchmark — but it is not an apples-to-apples pool.
- **A handful of extreme-outlier holdout Sharpes inflate V far above the ordinary cross-trial spread** (see the Observation above the grid table) — small holdout samples whose net returns cluster tightly around a negative mean produce very large |SR| via the mean/population-std formula. This pushes the deflation benchmark (SR0*) far out of reach for any plausible per-trade Sharpe, making the DSR gate component the binding (and effectively unpassable) constraint here — not the tStat, length, or WF checks. Separately, cells with <=1 holdout episode get `sr = 0` from `sharpeStats`' zero-variance guard (the same include-all convention `run-scan.ts` uses for the edge-diagnostic grid) rather than being excluded, which moderates V slightly in the other direction. Neither effect was filtered, excluded, or reparametrized away — both are reported exactly as the specified methodology produces them.
