# TP/SL/maxHold calibration study — 2026-07-13

**Read this line first: N=26 entries drawn from ~2.5 overlapping days of one shared market regime.
This is a descriptive diagnostic of what would have happened, not a validated edge claim, and it
does not by itself warrant any change to `PLAN_BOUNDS` or the agentic prompt.** $0 study: no LLM
calls, no network, replaying the agentic lane's own recorded entries through a TP/SL/maxHold grid on
real 15m candles.

## 1. Data card

- **N = 26** recorded `long` decisions from `agent_decisions` (5 strategy instances: agentic-1
  through agentic-5), 2026-07-10T21:15Z through 2026-07-13T00:45Z — roughly 2.5 days, overlapping
  windows across symbols (multiple strategies fire on the same 15m bar for different symbols).
- **Per-symbol counts:** ETH 7, LINK 7, BTC 6, XRP 4, SOL 2. SOL/XRP are thin — treat their per-
  symbol rows (§5) as directional color, not a stable estimate.
- **Entry-fill caveat:** every entry resolves cleanly to the candle bar whose `openTime` equals the
  decision's `event_time` (verified: that bar's `close` equals the entry's recorded `close` field,
  exactly, for all 26 rows). This script fills the simulated trade **at that bar's close**. The real
  plan-executor enters at `ref_price` — an offset a few bps *below* close (`entryOffsetBps`, see
  `agent-prompt.ts` PLAN_BOUNDS) — not simulated here, so real fills would sit slightly better on
  longs than this study's numbers show.
- **Censoring:** only 3 of 26 entries (`371`/ETHUSDT, `386`/SOLUSDT, `429`/ETHUSDT — the ones nearest
  the end of the candle window) ever get censored, and only in wide `sl=0.02`, high-`tp`, `hold=96`
  cells that never resolve before the data runs out (max 3/26 censored in any single cell). None of
  the top-10 cells in either mode have any censored trades. Per-cell censored counts are reported
  alongside every cell below; "excl.-censored" stats are in the underlying JSON but are identical to
  the "all" stats for every cell shown here since none of them carry censoring.

## 2. Aggregate top-10 grid cells by mean net bps/trade

Grid: `tp` in {0.3%, 0.5%, 0.8%, 1%, 1.5%, 2%, 3%}, `sl` in {0.3%, 0.5%, 0.8%, 1%, 1.5%, 2%}, `hold`
in {8, 16, 32, 64, 96} bars. 210 cells x 2 modes = 420 cells, N=26 trades per cell. Fees: 20bps
round-trip baked into every net return.

### Mode A — close-detection (current plan-executor semantics)

| Rank | tp | sl | hold | mean bps | median bps | win rate | N | censored |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.5% | 0.5% | 64 | +15.5 | +16.1 | 58% | 26 | 0 |
| 2 | 0.8% | 0.5% | 64 | +11.6 | +42.9 | 65% | 26 | 0 |
| 3 | 0.8% | 0.5% | 96 | +10.8 | +64.0 | 58% | 26 | 0 |
| 4 | 1.0% | 0.5% | 96 | +9.5 | +40.2 | 50% | 26 | 0 |
| 5 | 1.0% | 0.5% | 64 | +9.0 | +16.1 | 58% | 26 | 0 |
| 6 | 1.0% | 1.0% | 96 | +8.1 | +82.9 | 58% | 26 | 0 |
| 7 | 1.0% | 0.8% | 96 | +7.4 | +82.9 | 58% | 26 | 0 |
| 8 | 1.0% | 0.8% | 64 | +6.3 | +39.2 | 65% | 26 | 0 |
| 9 | 1.0% | 1.0% | 64 | +6.1 | +39.2 | 65% | 26 | 0 |
| 10 | 0.8% | 1.0% | 96 | +5.7 | +65.0 | 62% | 26 | 0 |

### Mode B — touch-detection (venue-resting-TP change under evaluation)

| Rank | tp | sl | hold | mean bps | median bps | win rate | N | censored |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2.0% | 0.5% | 64 | +15.9 | +16.1 | 58% | 26 | 0 |
| 2 | 1.5% | 0.5% | 64 | +14.1 | +16.1 | 58% | 26 | 0 |
| 3 | 0.8% | 0.5% | 64 | +11.2 | +60.0 | 69% | 26 | 0 |
| 4 | 1.0% | 0.5% | 64 | +10.0 | +21.1 | 62% | 26 | 0 |
| 5 | 1.0% | 1.0% | 96 | +9.3 | +80.0 | 62% | 26 | 0 |
| 6 | 1.0% | 0.5% | 96 | +9.0 | +80.0 | 54% | 26 | 0 |
| 7 | 1.0% | 0.8% | 64 | +9.0 | +80.0 | 69% | 26 | 0 |
| 8 | 1.0% | 1.0% | 64 | +8.8 | +80.0 | 69% | 26 | 0 |
| 9 | 0.8% | 0.5% | 96 | +8.7 | +60.0 | 62% | 26 | 0 |
| 10 | 1.0% | 0.8% | 96 | +8.6 | +80.0 | 62% | 26 | 0 |

**Headline best cells:** Mode A peaks at `tp=1.5% / sl=0.5% / hold=64` (+15.5 bps/trade mean). Mode B
peaks at `tp=2.0% / sl=0.5% / hold=64` (+15.9 bps/trade mean) — a different, *wider* tp than mode A's
optimum, because touch-fill can reach a 2% target intrabar that close-detection mostly cannot within
64 bars on this sample.

Both frontiers cluster at `sl=0.5%` (tight stop) and `hold in {64, 96}` (the two longest hold values
tested) — `hold=8` and `hold=16` never place in either top-10. `hold=96` is also this grid's (and
`PLAN_BOUNDS.maxHoldBars`'s) **ceiling**, and it appears in 5 of the 10 mode-A cells and 4 of 10
mode-B cells — the true optimum may sit past 96 bars; this study cannot see beyond the grid it ran.

Mean and median diverge at several cells (e.g. mode A rank 3: mean +10.8 bps but median +64.0 bps) —
the tight 0.5% stop wins on most trades (high median, high win rate) but a handful of close-detected
stop-outs overshoot the −0.5% threshold on a fast-moving bar and drag the mean down (left skew). The
mean ranking used here is therefore tail-sensitive; a median-ranked table would favor these same
tight-stop cells even more strongly.

## 3. The close-vs-touch delta

Same-cell mode B minus mode A, computed for every cell (not cross-cell) — the number this section
calls out is what the venue-resting-TP change is worth on this sample, at that exact (tp, sl, hold):

| tp | sl | hold | Mode A mean bps | Mode B mean bps | **B − A delta** |
| --- | --- | --- | --- | --- | --- |
| **2.0%** | **0.5%** | **64** | **−7.2** | **+15.9** | **+23.1** |
| 1.5% | 0.5% | 64 | +15.5 | +14.1 | −1.5 |
| 1.0% | 0.8% | 64 | +6.3 | +9.0 | +2.6 |
| 1.0% | 1.0% | 64 | +6.1 | +8.8 | +2.6 |
| 1.0% | 1.0% | 96 | +8.1 | +9.3 | +1.2 |
| 1.0% | 0.8% | 96 | +7.4 | +8.6 | +1.2 |
| 1.0% | 0.5% | 64 | +9.0 | +10.0 | +1.0 |
| 0.8% | 0.5% | 64 | +11.6 | +11.2 | −0.4 |
| 1.0% | 0.5% | 96 | +9.5 | +9.0 | −0.4 |
| 0.8% | 0.5% | 96 | +10.8 | +8.7 | −2.2 |
| 0.8% | 1.0% | 96 | +5.7 | −3.0 | −8.7 |

**The number: +23.1 bps/trade at `tp=2.0% / sl=0.5% / hold=64`** — mode A loses money there (−7.2
bps mean) because a 2% close-detected target is rarely reached within 64 bars on this sample; mode B
catches the intrabar high touching +2% far more often (58% win rate at that cell) and turns the same
cell profitable. That is the single largest, and most instructive, delta in the grid: the touch-fill
change's value is concentrated at *wider* TP thresholds that close-detection struggles to clear, not
a uniform uplift across all cells — across mode A's own top-10 (tighter tp, 0.8%–1.5%) the delta is
small and mixed (−8.7 to +2.6 bps), because those cells already resolve via close often enough that
touch-fill adds little.

## 4. Comparison vs PLAN_BOUNDS and the recorded plan_json

Current `PLAN_BOUNDS` (`src/features/trading/agentic/agent-prompt.ts`, read-only):
`stopLossPct` [0.002, 0.05], `takeProfitPct` [0.001, 0.1], `maxHoldBars` [4, 96].

- The swept grid (tp 0.3%–3%, sl 0.3%–2%, hold 8–96) sits **entirely inside** `PLAN_BOUNDS` by
  construction — that comparison is trivial and not itself informative.
- The load-bearing check: **does the best cell sit at a grid edge?** Mode A's best (tp=1.5%,
  sl=0.5%, hold=64) and mode B's best (tp=2.0%, sl=0.5%, hold=64) are both mid-grid on tp and sl, but
  `hold=64` is one grid step short of the ceiling, and `hold=96` (the grid's and `PLAN_BOUNDS`'s
  ceiling) appears repeatedly just below the top cells (§2). **This is the one place bounds might be
  worth widening** — if a future study raises `maxHoldBars` past 96, it's plausible the frontier moves
  further out; this 26-trade sample cannot confirm or rule that out.
- `sl=0.5%` dominating both frontiers is *not* at the grid's tightest setting (0.3% is tighter and
  never appears in either top-10) or `PLAN_BOUNDS`'s floor (0.2%) — no edge pressure there.
- **vs the single recorded `plan_json`** (entry id 636, ETH/USDT: `takeProfitPct=0.02`,
  `stopLossPct=0.012`, `maxHoldBars=16`): replaying that exact combination across all 26 entries gives
  mean net **−13.2 bps/trade**, median −8.4 bps, **35% win rate** — identical in both modes, because
  no entry in this sample ever touches or closes at +2% within 16 bars, so the touch/close
  distinction is moot at that cell. That one live plan is a materially worse cell than either
  frontier above; the gap traces overwhelmingly to `hold=16` being far short of the 64 bars both
  frontiers favor, not to the tp/sl split — consistent with `maxHoldBars` being the dominant lever in
  this sample, not the TP/SL choice.

## 5. Per-symbol secondary table (thin N — do not treat as a per-symbol edge estimate)

Mean net bps/trade at each mode's own best cell (mode A: tp=1.5%/sl=0.5%/hold=64; mode B:
tp=2.0%/sl=0.5%/hold=64):

| Symbol | N | Mode A mean bps | Mode B mean bps |
| --- | --- | --- | --- |
| ETH/USDT | 7 | +67.6 | +73.3 |
| LINK/USDT | 7 | +45.6 | +41.3 |
| BTC/USDT | 6 | −38.7 | −38.7 |
| XRP/USDT | 4 | −0.7 | −0.7 |
| SOL/USDT | 2 | −76.7 | −76.7 |

Columns are each mode's own best cell (A at tp=1.5%, B at tp=2.0% — different tp, not just different
fill mode), so the per-symbol A→B gap here also carries that tp difference; it is not a clean
close-vs-touch contrast (§3 isolates that at a single shared cell).

The aggregate positive mean is carried entirely by ETH and LINK (14 of 26 trades); BTC and SOL are
net negative at both frontier cells, and SOL's N=2 makes its number nearly meaningless. This is
exactly the kind of concentration a 26-trade, 2.5-day sample produces and is the core reason §0's
caveat holds: nothing here should move `PLAN_BOUNDS` or the prompt on its own.

## Artifacts

- `test/backtest/bounds-calibration/run.mjs` — the harness (rerun:
  `node test/backtest/bounds-calibration/run.mjs <entries.json> <candles.json> [--out <file>]`;
  extraction recipe for both inputs is documented in the file header).
- Full 420-cell JSON (all cells, all 26 per-trade rows, the off-grid `plan_json` comparison cell) was
  generated to a scratch path during this study and is not checked in — rerun the harness with
  `--out` against a fresh DB/candle extraction to reproduce it exactly.

## Honesty notes

- Research metric, off the production test gate (`pnpm backtest`). No slippage beyond the modeled
  20bps round-trip fee; mode B's touch-fill assumes a perfect fill at the exact TP price with no
  book-depth or latency effect.
- 210 grid cells x 26 trades is a small, non-independent sample (many entries share the same 15m bar
  across strategies) — no multiple-testing correction is applied here (unlike the multi-strategy
  sweep's deflated-Sharpe protocol), because with N=26 round trips a rigorous deflation would gate
  out everything; the top-10 tables are a descriptive ranking, not a survivor list.
- Same-bar double-touch (mode B) resolves to SL by construction (stop checked before touch-TP each
  bar) — the conservative tie-break the task specified, not empirically tuned.
