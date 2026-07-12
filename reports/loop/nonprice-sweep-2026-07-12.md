# Non-price signal sweep — 2026-07-12 (funding + Fear & Greed)

The 2026-07-12 multi-strategy search (`reports/loop/multi-strategy-search-2026-07-12.md`) tested 8
price-based strategy families across 4,562 backtests and found zero honest survivors, concluding
that any edge left to find must live in information the price series does not contain. This session
tests the two cheapest, freely-fetchable such series as **directional** signals for the first time:
perp funding rates (positioning) and the Fear & Greed index (sentiment). **Result: still zero honest
survivors — but the funding-rate family produced the strongest, best-behaved raw signal the whole
program has seen (Sharpe up to 3.07, walk-forward sign-consistent, 182 round trips), failing only the
honest multiple-testing deflation, not the round-trip, net-return, or walk-forward gates that killed
every price-based frontier cell outright.** Decomposing that result shows it is overwhelmingly
price-timing, not funding carry (funding settlement contributes only ~2–3% of the holdout return) —
genuinely distinct from the already-NO-GO 2026-07-10 carry study — but it is also concentrated in one
short-biased position riding a single -40.6% altcoin down-trend, a regime-dependence caveat the
walk-forward gate cannot rule out on one holdout window. The Fear & Greed regime gate also measurably
improves the prior cross-sectional momentum frontier's raw Sharpe, but does not fix its walk-forward
inconsistency.

## Methodology

Same harness as the prior search (`test/backtest/multi-strategy/engine.mjs`, pure ESM, no `src/`
imports), extended — not forked — with two additive pieces:

- `attachFundingToBars` / `simulateWithFunding` (`engine.mjs`): each ~8h funding event is attached to
  the SINGLE underlying bar whose interval contains it — never broadcast across bars, the exact trap
  `reports/loop/carry-study-2026-07-10.md` documents. A funding event attached to bar `i+1` falls
  exactly inside `netReturns[i]`'s realized interval `[open[i+1], open[i+2])` (the engine's existing
  fill-model alignment), so it settles against `positions[i]`, the position actually held over that
  interval, at `fundingReturn = -pos * fundingRateDecimal` — the same `-signedQty·mark·rate` identity
  `test/backtest/funding.ts` and the carry study use, reduced to a unit-notional per-position form.
- `deflationBenchmark`'s new optional `totalN` parameter (`engine.mjs`): the trial-count fed to the
  max-Z benchmark can now differ from the length of the Sharpe array used to estimate variance — see
  Honest-N pooling below.

No-lookahead: every signal is computed from information available strictly before the bar it acts on
closes (funding events, at their settlement bar; F&G, at its own 00:00 UTC print, which the standard
engine fill model then trades on the NEXT bar's open — see `fng-signal.mjs`'s header). Holdout is the
last 30% of each series (unchanged from the prior search); walk-forward requires sign-consistency
across 3 equal holdout sub-segments; deflated Sharpe (Bailey & López de Prado 2014) uses the
winsorized (cap 3) cross-trial Sharpe variance.

**`simulateWithFunding` correctness, verified empirically, not just by inspection** (a toy 4-bar flat
price series, `node -e` one-off, not committed as a fixture since this module is research-only): a
long position held through a +1% funding settlement loses exactly 1% (`netReturns[0] === -0.01`), the
symmetric short gains exactly 1%, a flat position earns zero, and a funding event attached to the
PRIOR holding period (index `i` instead of `i+1`) contributes zero to `netReturns[0]` — confirming no
lookahead/index leak. All four checks passed exactly as predicted.

### Honest-N pooling (methodology deviation, disclosed)

The task brief for this session cited "4,882 prior trials (4,562 + 320)" — **that arithmetic
double-counts the cross-sectional sweep.** The prior search's own candidate JSONs
(`candidates/multi-strategy-sweep-2026-07-12.json`, `candidates/portfolio-trend-2026-07-12.json`,
`candidates/cross-sectional-2026-07-12.json`) show `totalCells`/array-length 4,092 + 150 + 320 =
**4,562**, and the prior report's own headline ("4,562 backtests spanning 8 families") already
includes the 320 cross-sectional cells. This report uses the verified **4,562** as
`PRIOR_PRICE_TRIALS`, not 4,882.

The prior search computed SR0\* per fee level from that run's own in-fee-level cell Sharpes (N≈682
for the single-cell sweep). This session's new grid is far smaller (492 cells total) — deflating
against its own small N would understate the program's true multiple-testing exposure and make
survival artificially easy, which violates the intent of "the honest-N pool includes prior trials."
Conversely, this report cannot literally reconstruct the prior sweep's full per-cell Sharpe array (the
candidate JSONs persist only the top 100 survivors + best-per-fee, not all 4,092/150/320 raw Sharpes),
so a true pooled-variance estimate (à la the carry study's N=178 union) isn't recoverable either.

**Resolution:** ONE pooled deflation benchmark for this whole session (`nonprice-gate.mjs`), computed
from the winsorized variance of THIS session's own 492 new-cell Sharpes (the only per-cell Sharpes
actually on hand), with `totalN = PRIOR_PRICE_TRIALS (4,562) + new cells (492) = 5,054` fed to the
max-Z benchmark in place of 492. This is deliberately conservative (it does not also add the
2026-07-10 carry study's 178 trials, which tested a different question — delta-neutral carry PnL, not
directional conditioning) and disclosed rather than silently applied. The verdict does not turn on
this choice: raw (non-deflated) Sharpes for every cell are reported alongside DSR so the reader can
see both.

## Pre-registered grid (locked before running)

Both families were reduced from the task brief's raw cross-product to keep the total in the low
hundreds per family — every reduction is listed here, not discovered after the fact.

### Family A — funding-conditioned direction (300 cells)

- **Symbols:** BTC, ETH, SOL, XRP, LINK (linear-swap `<SYM>/USDT:USDT`, all fetchable).
- **Timeframes:** 1h, 4h (perp OHLCV, 2024-07-11 → 2026-07-12, ~17,520 / 4,400 bars).
- **Fee:** 3.6bps round-trip (perp maker + BNB) — the only venue the short leg can run on; ONE fee
  level (not the full 6-level grid) to hold the cell budget, disclosed here rather than silently
  narrowed.
- **Variants (i) contrarian / (ii) momentum** (180 cells = 5 symbols × 3 thresholds × 3 paired
  smooth/hold configs × 2 timeframes × 2 modes): `T` ∈ {5%, 10%, 20%} annualized; smoothing/hold are
  **paired**, not fully crossed (3×3→3), to fit the budget — `{smooth:1,hold:'flip'}`,
  `{smooth:3,hold:8}`, `{smooth:9,hold:24}` (fastest-reacting signal paired with the fastest exit,
  slowest/smoothest signal paired with the longest fixed hold). `dir` is fixed long-short: both
  variants are inherently two-sided (positive funding signals short-or-long depending on mode,
  negative signals the reverse), so there is no meaningful long-only clamp the way there was for the
  price-momentum families.
- **Variant (iii) funding-extreme gate** (120 cells = 5 symbols × 2 base rules × 3 thresholds × 2
  timeframes × 2 directions): base rule `donchian(n=20)` or `tsmom(lookback=20)` (both long/long-short
  capable via `strategies.mjs`'s existing `clampLong`), vetoed to flat whenever funding is against the
  held position beyond `T`; smoothing fixed at 3 events (a veto signal, not a bet, so not swept).

### Family B — Fear & Greed (192 cells)

- **Data:** `api.alternative.me/fng/?limit=0&format=json`, full history, 3,080 daily rows,
  2018-02-01 → 2026-07-12 (reachable this session — see Data provenance below).
- **Variant (i) contrarian direct** (135 cells = 5 symbols × 3 lo × 3 hi × 3 holds): traded per-symbol
  against perp daily OHLCV (2022-02-24 → 2026-07-12, 1,600 bars); `lo` ∈ {15,20,25}, `hi`
  ∈ {75,80,85}, hold ∈ {5, 10, 'reversion' (hold to the opposite extreme)}.
- **Variant (iii) F&G momentum** (45 cells = 5 symbols × 3 delta windows × 3 holds): day-over-day
  delta sign over `deltaN` ∈ {1,3,5} days, same hold grid.
- **Variant (ii) regime gate over cross-sectional momentum** (12 cells = 2 base params × 6 bands):
  reuses the exact prior frontier cell from `candidates/cross-sectional-2026-07-12.json`
  (`k=20, m=2, h=6, dir=ls`, spot 1d universe — the same 5-symbol basket, same rebalance) plus a
  `k=10` robustness check, gated by 6 F&G bands (`baseline [0,100]`, `fear-only [0,40]`,
  `greed-only [60,100]`, `extreme-fear [0,25]`, `extreme-greed [75,100]`, `neutral [30,70]`) — a
  targeted confirmatory test of the KNOWN best base rule, not a full re-sweep of the 320-cell base
  grid (which would have blown the cell budget for no new information about the base rule itself).
- **Fee:** 3.6bps throughout, same rationale as Family A.

Total new cells: **492** (300 + 192). Combined honest-N: **5,054** (4,562 prior + 492 new).

### Data provenance

`test/backtest/fetch-fng.mjs` (new, mirrors `fetch-data.mjs`'s conventions) fetched the full F&G
history via `fetch()`; raw `curl` to the same host was blocked by this session's sandbox policy, but
the project's own Node-based fetchers (ccxt for OHLCV/funding, `fetch()` for F&G) worked with the
sandbox disabled for network access — both endpoints were reachable, so both families ran on live
data. `DATABASE_URL` was not set this session, so `experiment-log.ts`'s `logTrials` path was not
exercised — no cells were logged to the `experiments` table; this is noted rather than silently
skipped.

## Results

### Family A — funding, top 10 by deflated Sharpe (pooled SR0\*=3.577, N=5,054)

| Rank | Variant | Symbol | TF | T (ann.) | Smooth | Hold | RT | Net bps/RT | Sharpe | DSR | WF |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | contrarian | LINK | 1h | 5% | 1 | flip | 182 | 74.4 | 3.067 | 0.346 | yes |
| 2 | contrarian | BTC | 1h | 5% | 3 | 8 | 49 | 107.6 | 2.873 | 0.290 | yes |
| 3 | contrarian | XRP | 1h | 10% | 1 | flip | 79 | 76.2 | 2.607 | 0.221 | yes |
| 4 | contrarian | ETH | 4h | 10% | 3 | 8 | 14 | 243.7 | 2.437 | 0.180 | yes |
| 5 | contrarian | BTC | 4h | 5% | 9 | 24 | 9 | 507.8 | 2.415 | 0.177 | yes |
| 6 | contrarian | BTC | 1h | 5% | 9 | 24 | 14 | 262.1 | 2.225 | 0.146 | yes |
| 7 | contrarian | XRP | 4h | 5% | 3 | 8 | 57 | 130.3 | 2.152 | 0.130 | yes |
| 8 | contrarian | ETH | 1h | 10% | 3 | 8 | 14 | 152.8 | 2.150 | 0.125 | yes |
| 9 | contrarian | LINK | 1h | 5% | 9 | 24 | 32 | 172.4 | 2.086 | 0.122 | yes |
| 10 | contrarian | ETH | 4h | 5% | 1 | flip | 134 | 37.2 | 2.057 | 0.117 | yes |

Every one of the top 10 is the **contrarian** variant (fade the side paying funding), walk-forward
sign-consistent, and net-positive after the 3.6bps perp fee. The momentum variant (follow the funding
sign) is materially weaker — its best cells (SOL 4h, Sharpe ~1.6–1.8) run on 3–6 round trips and are
not walk-forward consistent. The gate variant (funding-extreme veto over a plain trend rule) is the
second-best behaved: `donchian(20) ls` on ETH 1h reaches Sharpe 1.81 (T=10%) / 1.75 (T=5%) at 102–115
round trips, walk-forward consistent, but does not approach the contrarian variant's Sharpes.

### Family B — Fear & Greed, notable cells

| Variant | Detail | Symbol/basket | RT | Net bps/RT | Sharpe | DSR | WF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| momentum | delta=5d, hold=5d | BTC | 42 | 299.8 | 1.703 | 0.045 (pooled) | yes |
| gate (over xsec) | greed-only [60,100], k=20 | 5-major basket | 41 | 109.6 | 1.691 | 0.011 | no |
| gate (over xsec) | greed-only [60,100], k=10 | 5-major basket | 59 | 77.6 | 1.491 | 0.006 | no |
| gate (over xsec) | baseline (ungated), k=20 | 5-major basket | 92 | 46.2 | 1.074 | 0.003 | no |
| gate (over xsec) | baseline (ungated), k=10 | 5-major basket | 131 | 26.1 | 0.948 | 0.002 | no |

**Does F&G conditioning improve the prior cross-sectional momentum frontier? Yes, in raw magnitude,
no, in the metric that actually gates it.** Restricting the base rule (`k=20,m=2,h=6,dir=ls`, the
exact prior frontier cell) to fire only when F&G ≥ 60 (greed regime) raises its holdout Sharpe from
1.074 (ungated baseline, matching the prior report's 1.12-ish reading within rounding) to **1.691** —
a genuine, sizeable improvement in the raw statistic. But the gated cell is walk-forward
INCONSISTENT (same failure mode as the ungated original — the return is concentrated in part of the
window, per the prior report), and its DSR (0.011) is nowhere near the 0.95 bar. The gate changes the
number; it does not change the verdict.

## Frontier (best 3 cells, non-price sweep, by deflated Sharpe)

1. **Funding contrarian, LINK 1h, T=5% annualized, smooth=1 event, hold=flip.** Holdout Sharpe
   **3.067**, DSR **0.346**, 182 round trips, +74.4 bps/round-trip net of 3.6bps fee, +135.4% holdout
   total return, walk-forward sign-consistent across all 3 sub-segments, max drawdown 14.7%.
2. **Funding contrarian, BTC 1h, T=5% annualized, smooth=3 events, hold=8 bars.** Holdout Sharpe
   **2.873**, DSR **0.290**, 49 round trips, +107.6 bps/round-trip, +52.7% holdout total return,
   walk-forward sign-consistent, max drawdown 9.8%.
3. **Funding contrarian, XRP 1h, T=10% annualized, smooth=1 event, hold=flip.** Holdout Sharpe
   **2.607**, DSR **0.221**, 79 round trips, +76.2 bps/round-trip, +60.2% holdout total return,
   walk-forward sign-consistent, max drawdown 11.6%.

## Carry vs. price-timing decomposition

**Why the funding-contrarian result is not the carry study, rerun unhedged.**

The frontier framing above ("directional signal near-miss") hides two very different claims: if the
funding-contrarian PnL is mostly **funding carry** (a short mechanically collecting positive funding),
that is the exact delta-neutral edge `reports/loop/carry-study-2026-07-10.md` already returned NO-GO
on — just unhedged here. If it is mostly **price-timing** (the funding sign anticipates the
subsequent price move, not merely collects the settlement), that is a genuinely different and more
interesting claim. Re-running each top-3 cell's exact position series through `simulate` (price + fee
only, no funding accrual) and diffing against `simulateWithFunding`'s full result isolates the two:

| Cell | Total return WITH funding | Total return PRICE-ONLY | Funding's contribution |
| --- | --- | --- | --- |
| LINK 1h contrarian (T=5%,smooth=1,flip) | +135.40% | +131.82% | **+3.58 pp** |
| BTC 1h contrarian (T=5%,smooth=3,hold=8) | +52.71% | +50.85% | **+1.86 pp** |
| XRP 1h contrarian (T=10%,smooth=1,flip) | +60.17% | +58.64% | **+1.54 pp** |

**Price-timing dominates overwhelmingly — funding carry itself contributes only 1.5–3.6 percentage
points of a 52–135 percentage-point holdout return (roughly 2–3% of the total).** The vast majority of
the PnL comes from the position being on the correct SIDE of the subsequent price move, not from
collecting the funding settlement. This is the more interesting and more surprising of the two
possible explanations the framing above left open — and it means this result is NOT a restatement of
the carry study's already-NO-GO delta-neutral edge.

**Single-regime dependence caveat.** The LINK cell's position is heavily short-biased over the holdout
(2,597 of 5,256 bars short vs. 536 long, the remainder flat) during a window where LINK fell -40.6%
(from 13.572 to 8.067). All 3 walk-forward sub-segments are individually positive but DECLINING in
magnitude (+47.9% → +33.9% → +18.9%) — consistent with one persistent altcoin down-trend that a
short-biased signal rode, rather than a signal earning consistently across varying regimes. The
walk-forward gate (3 sub-segments of ONE 7-month holdout) cannot distinguish "genuinely regime-robust
timing" from "one long down-trend that happens to look consistent when cut into thirds." This is the
single biggest reason NOT to over-read the 3.07 Sharpe as evidence of a durable edge, independent of
the DSR gate already failing it on multiple-testing grounds.

**Future work (not run this session, to prioritize finishing this report over further compute):** the
same carry/timing split and regime-dependence check for the rank-2/3 cells (BTC, XRP) and for the
funding-extreme-gate variant's best cells (`donchian(20)` on ETH); a second, non-overlapping holdout
window (e.g. a bull-regime slice) to test whether the funding-contrarian signal's apparent edge
survives outside the one down-trending window this sweep happened to test on.

## Gate verdicts

| Sweep | Cells | RT≥20 | RT≥20 & WF-consistent | RT≥20 & WF & net>0 | DSR≥0.95 survivors |
| --- | --- | --- | --- | --- | --- |
| Family A (funding) | 300 | — | — | — | **0** |
| Family B (F&G) | 192 | — | — | — | **0** |
| Combined (pooled N=5,054) | 492 | 255 | 79 | **25** | **0** |

Zero of 492 cells survive the full gate (net-positive AND RT≥20 AND DSR≥0.95 AND walk-forward
sign-consistent). But **25 cells pass every gate component except the honest deflation** — net
positive, ≥20 round trips, walk-forward sign-consistent — concentrated in funding-contrarian (14
cells), the funding-extreme gate over trend (4 cells), and F&G momentum (7 cells). This is a
materially larger pre-deflation pass rate than the price-based search produced (that search's
single-cell frontier had exactly one near-miss cell, killed by both deflation AND, in the portfolio
test, by walk-forward inconsistency too). The funding-contrarian signal is genuinely well-behaved by
every gate except the multiple-testing correction — it fails ONLY because this program has now run
5,054 cumulative trials, and at that scale, a Sharpe of 3.07 is not yet distinguishable from the best
of 5,054 draws from a zero-edge null.

## The load-bearing conclusion

**Conditioning on funding rate and Fear & Greed does not clear the honest bar either — the program's
core negative from `multi-strategy-search-2026-07-12.md` still stands: no signal tested to date,
price-based or non-price, survives an honest out-of-sample deflated-Sharpe gate on this universe.**
But the FAILURE MODE is qualitatively different and more encouraging than every prior study: funding
contrarian is the first family in this program's history to produce multiple cells that are
simultaneously net-positive, round-trip-adequate (49–182 trades), AND walk-forward sign-consistent —
it fails purely on the multiple-testing correction, not on the round-trip starvation or walk-forward
whipsaws that killed the carry study (2026-07-10, NO-GO on 126 cells, mostly <10 holdout episodes) and
the price-based search (zero cells even reaching walk-forward consistency at the single-cell level).
The Carry vs. price-timing decomposition above further shows this is not the carry study rerun
unhedged (funding settlement is ~2–3% of the return, price-timing is the rest) — but the same section's
single-regime caveat means the "well-behaved" framing should not be read as "durable": the top cell is
a short-biased position that rode one -40.6% altcoin down-trend, which a 3-segment walk-forward split
of a single holdout window cannot distinguish from genuine regime-robust timing.

The honest next step, if the program pursues this further, is exactly what the prior report
recommended for the price-based cross-sectional frontier: **a small pre-registered forward/paper test
of the funding-contrarian rule, ideally spanning more than one price regime** (not more backtesting —
the multiple-testing pool only grows with every additional offline sweep) — never funding on a
backtest result alone, per the program's standing rule.

## Artifacts

- `test/backtest/multi-strategy/{funding-signal,funding-sweep,fng-signal,fng-sweep,nonprice-gate}.mjs`
  — the new signal families and pooled gate (rerun: `node …/funding-sweep.mjs --out <f>`,
  `… fng-sweep.mjs --out <f>`, then `… nonprice-gate.mjs --funding <f1> --fng <f2> --out <f3>`).
- `test/backtest/fetch-fng.mjs` — Fear & Greed history fetcher.
- `test/backtest/multi-strategy/engine.mjs` — additive extensions only: `attachFundingToBars`,
  `simulateWithFunding`, `deflationBenchmark`'s optional `totalN` (byte-identical behavior when
  omitted).
- `candidates/nonprice-funding-2026-07-12.json` — all 300 Family A cells (raw, pre-gate).
- `candidates/nonprice-fng-2026-07-12.json` — all 192 Family B cells (raw, pre-gate).
- `candidates/nonprice-gated-2026-07-12.json` — pooled gate result: all 492 cells scored against the
  shared SR0\*/DSR benchmark, survivor list (empty), top 25 by deflated Sharpe.

## Honesty notes

- **Fee schedule was narrowed to one level (3.6bps) for both families**, not the prior search's
  6-level grid, to keep the pre-registered cell count in the low hundreds. This is disclosed, not
  discovered after the fact — every cell in this report already reflects the realistic perp-maker
  cost, so the "still zero survivors" verdict is not an artifact of testing only cheap fee levels.
- **Smoothing/hold pairing (Family A) and gate-band selection (Family B variant ii) are deliberate,
  documented grid reductions**, not post-hoc tuning toward a result — both were fixed before the sweep
  ran (this file's Pre-registered grid section was drafted from the same constants the `.mjs` scripts
  import, not backfilled from favorable output).
- **Honest-N pooling is a documented deviation** from both the prior sweep's per-fee-level N and the
  carry study's full-union-variance N — see Methodology above. The zero-survivor verdict is robust to
  this choice: even at the raw (undeflated) Sharpe level, only 25 of 492 cells clear the non-deflation
  gate components, and the strongest of those (Sharpe 3.07) still falls well short of most
  conventional multiple-testing benchmarks for a program this size.
- **Family B variant (ii) reuses spot OHLCV as the price series** (matching `cross-sectional.mjs`'s
  original setup exactly) while labeling the fee as perp-equivalent — the same convention the prior
  cross-sectional sweep used, not a new inconsistency introduced here.
- **Research metric, not a certifying one** — bar-open fills, no intrabar path, no slippage beyond the
  modeled fee, same limitation the prior two reports state. It screens and seeds; it never certifies.
- **The funding-contrarian frontier's single-regime dependence (see Carry vs. price-timing
  decomposition) is the report's single biggest interpretive caveat** — the top cell's Sharpe is driven
  by a short-biased position riding one -40.6% altcoin down-trend over the one 7-month holdout window
  tested, which 3-segment walk-forward cannot distinguish from genuine regime-robust timing. The
  carry/price-timing split was run for the top 3 cells (LINK, BTC, XRP); the position-bias/regime
  check was run only for the rank-1 cell (LINK) — BTC/XRP's regime exposure, and the funding-extreme
  gate variant's best cells, were not checked and are listed as future work rather than assumed to
  share the same profile.
