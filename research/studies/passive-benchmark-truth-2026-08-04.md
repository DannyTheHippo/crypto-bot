# Passive-benchmark truth — an independent recomputation (2026-08-04)

`BELOW_PASSIVE_BENCHMARK` is one of the eight blocking reasons on the earned-live promotion gate
(`src/features/trading/mode-control/promotion-readiness.service.ts:134`), and its adapter
(`src/database/repositories/trading/passive-benchmark.repository.ts`) fails CLOSED by returning
`'Infinity'` on any data problem. An error in it is therefore blocking-side, not cosmetic. The
standing caution in `research/loop/STATUS.md:34-35` rests on one number produced by that adapter —
a 28-asset equal-weight basket at **−2.175%** over the evidence window — and on the attribution it
was used to justify: *"≈$37 of the loss was strategy, not beta"*. Neither had been recomputed from
anything other than the code path it certifies.

This study recomputes both from `agent_decisions.close` by direct SQL, with an independently written
basket and exposure fold, against the promotion gate's own two evidence windows.

**The basket return reproduces. The dollar attribution does not, and the direction of the error
strengthens the caution rather than weakening it.** Stated up front; the readings are in § 3–§ 5.

## Bottom line

| Question | Answer |
| --- | --- |
| Does the recorded **−2.175%** basket return reproduce? | **Yes — −2.2150%** over the exact Pass-57 evidence window (§ 3). A 0.04 pp difference, well inside the ±0.5 pp the basket moves across neighbouring 15m bars. |
| Does the recorded dispersion pair *"worst −11.15%, best +17.19%"* reproduce? | **No.** No `(from, to)` pair on the 1,091-bar journal grid produces that triple, under either the 28-base or the 40-string basket (§ 3.3). `RECORDED, NOT REPRODUCED` — do not re-quote those two figures. |
| Was `passivePnlQuote` — the number the gate actually compares against — ever measured? | **No.** The record's *"≈ −$11 at ~50% exposure, ≈ −$22 at full notional, ≈ −$44 at 2× the book"* are scenarios over an assumed $1,000 book, not readings. No metric exposes `passivePnlQuote` and none ever has. |
| What is the lane's measured time-weighted average gross exposure? | **$235.05** over the Pass-57 window, **$204.44** over the current one (§ 4) — 2.1× to 4.9× below the $500 / $1,000 / $2,000 the scenarios assumed. |
| So what was `passivePnlQuote` actually? | **≈ −$5.21** at Pass 57, **≈ −$1.88** now (§ 5). |
| Is *"≈$37 of the loss was strategy, not beta"* right? | **Directionally yes, numerically no, and it UNDERSTATES the strategy's share.** Pass-57 truth: beta **−$5.21 (10.7%)**, strategy **−$43.33 (89.3%)**. Current: beta **−$1.88 (3.0%)**, strategy **−$61.65 (97.0%)** (§ 5). |
| Is the fail-closed gate input sound? | **The verdict is sound; the discrimination is near-zero.** Price coverage is 40/40 dense so `CANNOT_COMPUTE` cannot fire on prices in this window, and the clause fires on evidence exactly as recorded. But whenever `passivePnlQuote < 0` the clause is *logically implied by* `NON_POSITIVE_NET_PNL` and can never be the sole blocker (§ 7). |
| Survivorship in the basket? | **None from menu rotation.** `TRADING_SYMBOLS` was last edited in `b41023c`, **2026-07-19T21:30:31Z** — four days before the evidence window opens. The universe is ex-ante (§ 6.1). |
| A hole found that is not in any record | The adapter puts **no staleness bound** on either endpoint lookup. A 46.5-hour journal gap sits *inside* this very window (§ 6.2); had an endpoint landed in it, the basket would have anchored to a price up to two days away and still returned a finite, non-sentinel number. |

## 1. Method, and what makes it independent

`PassiveBenchmarkRepository.passivePnlQuote(fromMs, toMs)` computes, per its own code:

1. `assets = distinctBaseAssetRepresentatives(TRADING_SYMBOLS)` — one representative symbol per
   distinct base, first-occurrence order. On the deployed universe this is **28** representatives
   (24 spot + `HYPE`/`KAITO`/`TRUMP`/`BCH` perp) out of 40 configured strings.
2. Per asset, `entry` = first `agent_decisions.close` at-or-after `fromMs`, `exit` = last close
   at-or-before `toMs`, filtered `trigger_kind='candle'`, `close is not null`,
   `strategy_id not like 'replay-%'`. Any missing end voids the whole basket.
3. `basketReturn` = arithmetic mean of `(exit − entry) / entry`.
4. `avgGrossExposureUsd = timeWeightedAvgGrossExposure(testnet fills through toMs, fromMs, toMs)` —
   an average-cost position replay valued at `avgEntry`
   (`src/domain/trading/risk/gross-exposure.ts`).
5. `passivePnlQuote = avgGrossExposureUsd × basketReturn`.

What is independent here: the price series was pulled by direct `psql` with a single `DISTINCT ON`
query rather than 28 per-symbol Drizzle round trips; the basket and the exposure fold were written
fresh against the published spec; and the whole thing was run twice, once in JS floats and once in
`decimal.js` at 40-digit precision, agreeing to every printed digit. What is *not* independent: the
price source is the same `agent_decisions.close` grid the adapter reads, because that is the only
persisted price history that exists (§ "What this study cannot answer").

## 2. The evidence window, recovered exactly rather than assumed

The gate exposes `windowDays` but not its endpoints. `windowStart = max(firstClosedAt, epochMs)` and
`lastClosedAt` are both closing-fill timestamps, so the endpoints were recovered by searching the
268 distinct `testnet` fill timestamps for the pair whose difference matches `windowDays × 86400000`
exactly. Each of the three published `windowDays` readings resolves to a **unique** pair, and all
three share the same start — which is itself the check that the recovery is right.

| source reading | `windowDays` | Δ ms | `windowStart` | `lastClosedAt` |
| --- | --- | --- | --- | --- |
| digest 2026-08-03T08:45Z (`roundTrips=46`) | 9.916774444444444 | 856,809,312 | 2026-07-23T18:00:26.554Z | 2026-08-02T16:00:35.866Z |
| digest 2026-08-03T17:09Z (`roundTrips=48`) | 10.847196840277778 | 937,197,807 | 2026-07-23T18:00:26.554Z | 2026-08-03T14:20:24.361Z |
| **current tuple 2026-08-03T22:02Z (`roundTrips=49`)** | 10.968840810185185 | 947,707,846 | **2026-07-23T18:00:26.554Z** | **2026-08-03T17:15:34.400Z** |
| Pass-57 record ("8.47 window-days", `netPnl −$48.54`) | 8.468859 | 731,709,444 | 2026-07-23T18:00:26.554Z | 2026-08-01T05:15:35.998Z |

The Pass-57 row is the one the **−2.175%** was recorded against. Its endpoint is the unique fill
timestamp inside the band `windowDays ∈ [8.465, 8.475]`, so it is pinned to a single 15m bar.

`PROMOTION_EVIDENCE_EPOCH = 1784632860000` (2026-07-21T11:21:00Z) is **not** the window start: the
first `testnet` fill is 2026-07-23T15:45:22.279Z, so `firstClosedAt > epochMs` and the `max()` picks
`firstClosedAt`.

## 3. The basket return

### 3.1 The headline reproduces

| window | recorded | recomputed (28 base reps) | Δ |
| --- | --- | --- | --- |
| Pass-57 `[2026-07-23T18:00:26.554Z, 2026-08-01T05:15:35.998Z]` | **−2.175%** | **−2.2150%** | 0.040 pp |
| current `[2026-07-23T18:00:26.554Z, 2026-08-03T17:15:34.400Z]` | (none on record) | **−0.9218%** | — |

The basket mean traverses roughly `[−2.9%, −1.9%]` over the bars of 2026-08-01 alone, so a 0.04 pp
gap between a recorded figure and a recomputation anchored one bar apart is agreement, not a
discrepancy. **AGREEMENT: the standing caution's basket figure gains an independent leg.**

Every one of the 28 assets anchors on the *same* two bars — entry `2026-07-23T18:15:00Z` (8.5 min
after `windowStart`), exit `2026-08-03T17:15:00Z` (34.4 s before `lastClosedAt`) — so the basket
carries no per-asset endpoint staggering.

### 3.2 Per-asset, current window

| asset | ret | asset | ret | asset | ret | asset | ret |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | −1.52% | ETH | −0.68% | SOL | −2.88% | XRP | −2.15% |
| LINK | −2.69% | ZEC | −3.98% | AAVE | −2.60% | NEAR | −7.17% |
| BNB | +4.33% | DOGE | +1.27% | ADA | +13.26% | AVAX | +4.21% |
| DOT | +1.97% | LTC | −5.51% | SUI | −6.80% | PEPE | +4.68% |
| WIF | −3.34% | TRX | +0.67% | SHIB | +20.87% | UNI | +4.02% |
| APT | −6.55% | ARB | −5.32% | OP | −5.47% | FIL | −0.48% |
| HYPE | −7.12% | KAITO | −10.59% | TRUMP | −7.82% | BCH | +1.58% |

Worst `KAITO −10.59%`, best `SHIB +20.87%`, mean **−0.9218%**.

### 3.3 The recorded dispersion pair does not reproduce

`LOG.md:144` records the basket as *"−2.175% (worst −11.15%, best +17.19%)"*. An exhaustive scan of
all `(from, to)` bar pairs on the complete-coverage journal grid — 1,091 bars, both the 28-base-rep
and the 40-string basket, ~595k pairs each — finds **no window that produces that triple**. The best
combined match is a 4.4-day window (`2026-07-23T22:30Z → 2026-07-28T08:00Z`: mean −2.2097, worst
−11.1699, best +17.1848), which is not any evidence window this gate has ever used. At the true
Pass-57 endpoint the extremes are `TRUMP −11.48%` and `SHIB +18.93%`.

The mean is reproduced and the extremes are not, so the two are not from the same computation.
**Treat `−11.15%` / `+17.19%` as `RECORDED, NOT REPRODUCED`.** Nothing downstream depends on them —
the gate reads only the mean — so this is a citation-hygiene finding, not a verdict change.

### 3.4 The universe choice moves the benchmark by up to 3.7×

The adapter's 28-base-representative choice is one of four defensible baskets. All four, both
windows:

| basket | unit | current window | Pass-57 window |
| --- | --- | --- | --- |
| **28 base representatives (adapter spec)** | base asset | **−0.9218%** | **−2.2150%** |
| 40 raw symbol strings | symbol string | −1.3389% | −2.5039% |
| 12 traded bases | base asset | −3.4069% | −3.5014% |
| 15 traded symbols | symbol string | −3.2843% | −3.8326% |

Two things follow. First, the 40-string basket is *more negative* than the 28-base basket in both
windows, because the twelve dual-listed majors fell while the spot-only alt tail (`SHIB +20.9%`,
`ADA +13.3%`) rose — string-weighting silently overweights the majors. Second, the assets the lane
*actually traded* fell far harder than the configured universe (−3.41% vs −0.92% on the current
window): under a traded-basket benchmark, beta explains 11.0% of the loss rather than 3.0% (§ 5).
The adapter's own choice is the one *least* favourable to the strategy in the current window, and
that choice was made ex ante (`LOG.md:101-107`), so this is not selection after the fact.

## 4. The exposure — the term nobody has ever measured

`passivePnlQuote` is `avgGrossExposureUsd × basketReturn`. The record has never carried the first
factor.

| window | measured avg gross exposure | vs `SIZER_EQUITY_CAP` $1,000 book | vs equity ($4,966) |
| --- | --- | --- | --- |
| Pass-57 | **$235.051919** | 23.5% | 4.7% |
| current | **$204.441957** | 20.4% | 4.1% |

Replayed from all 295 `testnet` fills through each endpoint (0 fills carried an unresolved side —
115 BUY / 180 SELL — so the fold skipped nothing). On the Pass-57 window this is 2.1× below the
*lowest* of the three scenarios the record priced the benchmark at ($500) and 8.5× below the highest
($2,000).

The record's own basis for *"~50% gross exposure"* was a design-time estimate written *before* the
adapter existed (`LOG.md:94-99`, the open G4 design question), and it was never revisited once the
adapter shipped.

## 5. The decomposition, under both computations

`strategy = netPnl − passivePnlQuote`. `betaShare = passivePnlQuote / netPnl`.

**Pass-57 window (`netPnl = −$48.54`) — the window the standing caution quotes:**

| basket | passive (beta) | strategy residual | beta share |
| --- | --- | --- | --- |
| **28 base reps (what the gate uses)** | **−$5.21** | **−$43.33** | **10.7%** |
| 40 symbol strings | −$5.89 | −$42.65 | 12.1% |
| 12 traded bases | −$8.23 | −$40.31 | 17.0% |
| 15 traded symbols | −$9.01 | −$39.53 | 18.6% |
| *record's assumed $1,000 book* | *−$22.15* | *−$26.39* | *45.6%* |
| *record's assumed ~50% exposure* | *−$11.08* | *−$37.46* | *22.8%* |

The bottom row is where **$37** came from: the record's *most* strategy-adverse scenario, taken from
a range it also stated as spanning −$11 to −$44. At the actual measured exposure the answer is
**−$43.33**, i.e. **$6 worse for the strategy than the figure in circulation**.

**Current window (`netPnl = −$63.5326`):**

| basket | passive (beta) | strategy residual | beta share |
| --- | --- | --- | --- |
| **28 base reps (what the gate uses)** | **−$1.88** | **−$61.65** | **3.0%** |
| 40 symbol strings | −$2.74 | −$60.80 | 4.3% |
| 12 traded bases | −$6.97 | −$56.57 | 11.0% |
| 15 traded symbols | −$6.71 | −$56.82 | 10.6% |

**DISAGREEMENT, reported as it falls.** The record's attribution is wrong in the direction that
flatters the lane. Under every one of the four baskets, on both windows, market beta explains
between 3% and 19% of the loss — never the ~24% the *"$37 of $48.54"* sentence implies, and never
anything close to the 46% the *"full notional"* scenario would have implied. `STATUS.md`'s
*"THE LANE IS WORSE THAN DOING NOTHING"* is not merely still true; it is true by a wider margin than
the record claims.

## 6. Hazards, addressed rather than noted

### 6.1 Survivorship — checked and clean, for one specific reason

The basket is today's `TRADING_SYMBOLS` applied retroactively, which is a survivorship hazard by
construction: if the menu rotated during the window, the basket would hold whatever survived the
rotation. It did not. `git log -S` puts the last edit to that line at **`b41023c`,
2026-07-19T21:30:31Z** — four days *before* the window opens, and before the adapter existed at all.
The universe is genuinely ex-ante for this window.

This is a property of *this* window, not of the design. `research/loop/STATUS.md` backlog 48 (vol-ranked
symbol rotation) and backlog 58 (retire the spot half) both propose changing `TRADING_SYMBOLS`. Either
would make every subsequent benchmark reading a rotated-universe reading applied backwards over a
window the old universe traded, with no record in the adapter that it happened. Whoever ships one
owes this file an amendment.

### 6.2 Window endpoints — the unbounded lookup

`closeAtOrAfter` and `closeAtOrBefore` are unbounded: they return the nearest bar in the requested
direction however far away it is, and a far-away bar yields a finite return, not the
`CANNOT_COMPUTE` sentinel. The journal grid carries a **46.5-hour hole**
(`2026-07-25T11:00Z → 2026-07-27T09:30Z`, plus eight 30-minute holes) *inside this very window*.
Here both endpoints landed 8.5 minutes and 34.4 seconds from their targets, so nothing is wrong with
the readings above — but an endpoint falling in that hole would have anchored the basket up to two
days off-window, silently, inside a fail-closed adapter. Naming it because the adapter's entire
safety argument is *"every case it cannot compute returns Infinity"*, and this is a case it computes
wrongly rather than refusing.

### 6.3 Venue-duplicate collinearity — the unit, stated

Every basket figure marked *base asset* in § 3.4 clusters on the **base**, per this program's
standing rule and per `MIN_CLUSTERS`'s own reasoning (spot/perp h=24 forward-return correlation
0.9993–0.9999 for the same base, `research/studies/cluster-degeneracy-2026-08-03.md`). The adapter
already does this correctly — `distinctBaseAssetRepresentatives` exists for exactly this reason.
The 40-string and 15-symbol rows in § 3.4 are reported *only* to size the error a symbol-weighted
basket would introduce (0.42 pp on the current window, 0.29 pp on Pass-57); they are not
recommendations. The census (`research/studies/census-2026-08-03.md` § 8) records 15 symbols over
12 bases traded since epoch, which is where the traded-basket rows draw their membership.

### 6.4 The demo-vs-live frame

The strategy leg (`netPnl`) is `testnet` — simulated execution against real market data. The basket
leg is real market data with no execution at all. So the comparison is not like-for-like on
execution quality, and backlog 57's measured decoupling artifact (**+21.0 bps/trip flattering the
demo book**, `research/studies/frame-audit-2026-08-03.md`) sits entirely on the strategy leg. Correcting
for it moves `netPnl` *down*, not up, so it widens the gap in § 5 rather than closing it. The basket
leg carries no execution cost either, which is the conservative direction for a benchmark: a real
passive holder would have paid entry and exit fees the basket does not charge.

## 7. What this means for the gate, as a fail-closed input

**The clause fires on evidence, exactly as Pass 57 recorded, and this study confirms it
independently.** Price coverage is complete: all 40 configured symbols carry 1,093–1,100
`trigger_kind='candle'` rows with a non-null close spanning `2026-07-21T11:15Z → 2026-08-03T21:45Z`,
so the `CANNOT_COMPUTE` sentinel cannot fire on a price gap in this window; measured exposure is
positive; the window is non-degenerate. `netPnl (−$63.53) ≤ passivePnlQuote (−$1.88)` is true, and
the reason is genuine.

**But it has never had any blocking power of its own, and cannot while the basket is falling.**
When `passivePnlQuote < 0`, `netPnl ≤ passivePnlQuote` *implies* `netPnl ≤ 0`, so
`BELOW_PASSIVE_BENCHMARK` firing entails `NON_POSITIVE_NET_PNL` firing. It has therefore never been
able to block anything the older clause did not already block. Its designed value — *"a strategy
earning +3% while the basket earns +12%"* — materialises only when the basket **rises**, and even
then the bar it sets scales with the lane's own gross exposure: at $204 that bar is one fifth of
what the record's $1,000-book framing implies.

Two consequences worth carrying, neither of which is a repair proposal:

- The clause is **exposure-matched by design**, so a lane that trades less faces a benchmark closer
  to zero. In a rising market it is easier to beat the less you are exposed; against a flat book it
  is exactly zero and vetoes nothing. That is the deliberate design (`LOG.md:101-107` records the
  reasoning and the alternative it rejected), but it is not what *"the lane is worse than doing
  nothing"* asserts — that sentence is a claim about the whole book, and the clause is a claim about
  the fraction of the book that was exposed.
- **`passivePnlQuote` is in the evidence payload and on no metric.** Every reading in this file had
  to be reconstructed. A gauge would have made the *"$37"* error impossible to make.

## What this study cannot answer

- **Whether `agent_decisions.close` is the right price.** It is the only persisted price history in
  this system, so both the adapter and this recomputation stand on it. If the journal's close
  convention were wrong, both would be wrong identically and this study could not detect it. The
  convention itself is verified elsewhere with five cited code references
  (`scripts/loop-forward-return-core.mjs:16-31`) and is not re-derived here.
- **Whether the adapter, executed, returns the numbers § 5 attributes to it.** No metric exposes
  `passivePnlQuote` and constructing the Nest graph to call it would have re-run the code path this
  study exists to check independently. § 5 is what the adapter's published algorithm yields on
  independently-extracted inputs — a specification check, not an execution trace. A gauge would
  close this gap in one line.
- **The round-trip count and `netPnl` themselves.** Both are taken from the orchestrator's atomic
  `evaluate()` tuple and from the Pass-57 record. Reproducing them means reproducing
  `walkRoundTrips`, which is R9's job with the imported production function; a second implementation
  here would be a second source of truth for the number the gate returns
  (`research/studies/census-2026-08-03.md` § "What this census cannot answer").
- **Whether the recorded `−11.15% / +17.19%` pair came from somewhere legitimate.** § 3.3
  establishes only that no window on this grid produces it alongside the recorded mean. It does not
  establish what was computed instead.
- **Anything about a rising basket.** Every window this gate has ever evaluated has a falling
  basket, so § 7's claim that the clause has never had independent blocking power is a statement
  about the realised history, not a theorem about the clause.
- **Forward returns, edge, or per-entry attribution.** Nothing here measures those; the basket is a
  buy-and-hold drift over a window, not a signal.
