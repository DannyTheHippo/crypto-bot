# Frame-audit — how much recorded PnL is a demo/live artifact (2026-08-03)

Backlog 57: market data runs `FEED_ENV=live` while orders execute against `SANDBOX_ENV=demo`
(`market-streams.module.ts:77-79`), so every recorded fill is priced in the DEMO frame while every
OHLCV-based replay prices in the LIVE frame. The question is how much of the recorded PnL is an
artifact of that decoupling. Harness: `test/backtest/frame-audit.spec.ts` over
`test/backtest/live-frame.ts`, modelled on `test/backtest/exit-attribution.spec.ts`.

**No verdict moves.** The measured artifact is small relative to the program's standing gap
(§ 4), and it runs in the direction that flatters the book — correcting for it would make the
number worse, not better, exactly as the 2026-07-31 incident's write-up anticipated. Several
specific figures quoted in this study's own brief as "prior partial work" do **not** reproduce
under measurement; § 5 reports that as a finding rather than reconciling it.

## Bottom line

| Question | Answer |
| --- | --- |
| How many closed round trips exist since the evidence epoch (2026-07-21T11:21Z)? | **46** (`fills=284`, `cycles=46`), of which **38 are measurable** (§ 2 — 8 excluded for a grid-coverage gap, not a methodology defect). |
| Mean artifact per trip, over the 38 measurable trips? | **+21.0 bps/trip** (median +0.53), cluster-bootstrap 95% CI **[+1.4, +39.8]** — excludes zero. |
| Which direction does the artifact run? | **Flattering the demo book.** Demo-frame gross realised is $-19.33 (-70.3 bps/trip); live-frame is $-25.64 (-91.2 bps/trip). Correcting for the frame makes the book **worse**, not better. |
| Does this rescue the standing loss? | **No.** +21.0 bps against a documented gap exceeding 100 bps/trip (§ 4) is immaterial to the profitability question. |
| Does the KAITO six-hour maker-TP episode from the incident report reproduce? | **Yes, closely** — measured **+609.2 bps** against a described **+611 bps** (§ 3). |
| Does the TRUMP STOP_MARKET episode reproduce? | **No.** Measured **-11.0 bps**, not the described **-207 bps** (§ 5). This is reported as an open contradiction, not reconciled. |
| Was the `fetch-edge-tournament-data.mjs` scoping finding confirmed? | **Yes** (§ 6) — the replay family was always live-frame; this study does not touch it. |

## 1. Method

`walkRoundTrips` (`src/domain/trading/risk/round-trips.ts`) owns the closure rule (dust/peakNotional
fold) and is never re-derived here — this study only substitutes the **mark**. `live-frame.ts`:

- `livePriceAt` linearly interpolates the cached 15m OHLCV grid between consecutive bar OPEN prices,
  treating each bar's open as a price sample at its own open timestamp. Returns null (a GRID MISS)
  outside the grid.
- `partitionFillsIntoCycles` slices the ordered fill list into the exact cycles `walkRoundTrips`
  already closed. A first attempt cut membership on `fill.executedAt === cycle.closedAt`, which is
  WRONG whenever two fills in the same (strategyId, symbol) group share a millisecond timestamp (the
  query's own `fill_id` tiebreak exists for exactly this reason) — it produced 5 corrupted trips with
  nonsense pnl (a whole cycle's fills silently misassigned to the wrong cycle). The fix re-derives
  each group's boundaries by calling `walkRoundTrips` on that group's own growing prefix and watching
  `cycles.length` increase — the closure RULE is never reimplemented, only probed via the real
  function, which is safe because groups never interact (the fold is keyed per strategy+symbol).
- Every partitioned cycle's recomputed demo pnl is checked against `cycle.realizedPnl` before being
  trusted for anything (`partitionMismatches=0` in the current run). This is not a formality: it is
  the only thing that caught the first, wrong, partitioning method.
- `artifact_bps = (pnl_demo − pnl_live) / (turnover / 2) × 1e4`, `turnover` = total notional traded
  both legs in the demo frame. A **constant** basis difference between the frames contributes
  **exactly zero** to a closed cycle's artifact, because `Σ sgn·qty ≈ 0` over BUY and SELL legs — this
  statistic measures the **change in basis between the legs**, i.e. an episodic divergence, not a
  standing offset. That property is why a single large per-fill divergence (572 bps at the 2026-07-31
  stall) can still net to a small trip-level artifact if it does not move between the two legs.
- Cluster bootstrap (20,000 draws, seed `20260803`, ported from
  `scripts/loop-forward-return-core.mjs`'s `clusterBootstrap`) resamples BASE ASSETS, not symbol
  strings or rows, for the same reason documented there — spot and perp legs of the same coin are
  near-collinear, not independent.

## 2. A trip with any grid-miss fill is EXCLUDED, not averaged in

A first run computed `livePnl` from whatever fills DID interpolate and silently zeroed the rest,
which manufactured nonsense (`-5108 bps`, `-10108 bps`, `+9926 bps` on trips with 1-12 missed fills
out of 2-12 — an entire leg dropped from the sum, not a measurement). Fixed: any trip with
`gridMisses > 0` is excluded from every aggregate and reported separately.

`gridMisses=28/276` fills, concentrated in **8 trips** opened **2026-08-01 or later**. The cached
15m OHLCV grid (`test/backtest/data/ohlcv-*-15m.json`) ends **2026-07-31T20:45Z**; this study's
epoch window runs through **2026-08-03**, so every trip opened after the cache's last bar is, by
construction, a grid miss. This is a **coverage gap in the cache relative to the current DB**, not a
defect in the interpolation method, and refreshing the cache would require a network call this study
does not make (see the constraint under "cost: $0" — no `scripts/fetch-edge-tournament-data.mjs` run
was made; that script is peer-owned and out of this study's scope regardless). The **measurable**
population is therefore **38 of 46** closed trips, all from 2026-07-23 through 2026-07-31.

## 3. The KAITO episode — confirmed

Largest positive artifact: **KAITO/USDT:USDT, +609.2 bps**, closing leg **maker**, opened
2026-07-27T13:30:34.529Z, closed 2026-07-27T13:47:07.605Z (17 minutes held). Verified against the
raw fills (`fills`/`order_intents`, read-only):

- Entry: 15 `BUY LIMIT` maker fills @ **1.1963**.
- Exit: one `SELL LIMIT reduce_only` maker fill @ **1.2681** — a **+6.0%** move from entry, matching
  the "6% level" description.
- Demo-frame realised: **+582.7 bps**. Live-frame (interpolated at the exit fill's own timestamp,
  13:47:07Z): **-26.5 bps** — the live tape had **not** moved in the demo book's favour at all at
  that instant.
- Scanning the cached live-frame candles forward from the exit fill: the first 15m bar whose HIGH
  reaches 1.2681 is **2026-07-27T20:00:00Z — 6.21 hours after the demo fill**.

This reproduces the incident's described episode (maker TP fill at a level the live tape had not
reached for six hours) to within 2 bps of magnitude (**609.2** measured vs **611** described) and
confirms the six-hour figure exactly (**6.21h** measured). This is the strongest single piece of
evidence that the artifact mechanism is real: a resting maker order filled against a frozen/stale
demo book at a price the live tape needed hours to justify.

## 4. Aggregate (n=38 measurable trips of 46 closed)

```text
demo-frame gross realised   $-19.33   mean=-70.3 bps/trip
live-frame gross realised   $-25.64   mean=-91.2 bps/trip
artifact_bps                mean=+21.0  median=+0.53  clusters=12  CI95=[+1.4, +39.8]
P(|artifact| >= 50 bps)     0.1579  (6 of 38 trips)
channel split                taker (n=30) mean=-5.8 bps   maker (n=8) mean=+121.3 bps
```

Clusters (12, distinct base assets) clear the sibling program's `MIN_CLUSTERS=5` density floor by a
wide margin, so the bootstrap interval is not a lattice artifact.

**Reading.** The mean artifact is positive and its cluster CI **excludes zero** — the demo book is,
on average, measurably more favourable than the live tape would have marked the same fills. It is
concentrated almost entirely in the **maker** channel (+121.3 bps mean over 8 trips) — a resting
limit order can fill against a stale or decoupled demo price the live tape has not reached, exactly
the KAITO mechanism in § 3. The **taker** channel (30 trips) is close to flat and slightly negative
(-5.8 bps), consistent with a taker fill executing near whatever the demo book's current price is,
which usually tracks the live tape closely.

**This does not rescue the standing loss.** `verdicts.md:444-457` records the exit-attribution
study's demo-frame gap at **-108.1 bps/trip** (Arm 1, 23 trips, frozen). A +21.0 bps/trip artifact —
even taken at face value, before any of the four limits in § 7 are applied — is an order of
magnitude too small to explain it, and it runs the WRONG way to be an explanation: correcting the
demo PnL for the artifact makes it **worse** (demo -70.3 → live -91.2 bps/trip on the measurable
population), not better. **The demo/live decoupling cannot be what makes the numbers negative.**

## 5. The TRUMP episode — does NOT reproduce, reported as a contradiction

This study's own brief described a "TRUMP STOP_MARKET walked 284 bps through the live price by a
thin demo book (-207 bps)." The measured TRUMP trip does not show this.

There is exactly one closed TRUMP/USDT:USDT round trip in the current window: opened
2026-07-25T00:47:55.596Z (16 `SELL LIMIT_MAKER` fills @ 1.561, opening a short), closed
2026-07-26T05:30:19.052Z by a single `BUY STOP_MARKET reduce_only` taker fill @ **1.593** — this IS
a STOP_MARKET exit, consistent with the description. But:

- Demo-frame realised: **-202.9 bps**. Live-frame: **-191.9 bps**. Artifact: **-11.0 bps** — small,
  not -207.
- The cached 15m candle bracketing the fill (2026-07-26T05:30:00Z open **1.591**, 05:45:00Z open
  **1.594**) interpolates to **~1.5911** at the fill's own timestamp (05:30:19Z, 19s into the bar) —
  within **13 bps** of the demo fill price of 1.593, not 284 bps.

**This directly contradicts the described episode.** No other TRUMP round trip exists in this window
to be the "real" match, and re-checking the arithmetic (fee-floor-derivation-style, by hand) does not
change the conclusion. Candidate explanations, none confirmed: the -284/-207 figures may describe a
different quantity entirely (e.g. slippage against the intent's decide-time `ref_price`, which this
study does not compute — `round-trips.ts`'s `meanSlippageBps` is a separate measure from the
frame-audit's OHLCV-interpolated live mark), or may reference a TRUMP position that no longer exists
in this form after a subsequent reconciliation. **This is reported as an unresolved discrepancy, not
reconciled toward the described number** — per this study's own instruction not to bend a measurement
toward an expected answer.

## 6. Scoping finding — the replay family was always live-frame

`scripts/fetch-edge-tournament-data.mjs:215` constructs `new ccxt.binanceusdm({ enableRateLimit:
true })` with no `setSandboxMode` call anywhere in the file, and `:230` fetches klines directly from
`https://fapi.binance.com/fapi/v1/klines` — production, not a sandbox host. Confirmed by direct
inspection of both lines.

**Consequence:** the 20 playbook-space cells, the 15/15 non-price-channel cells and the 24/24
horizon cells (`research/studies/nonprice-channels-2026-07-27.md`,
`research/studies/horizon-and-baseline-2026-07-27.md`, and the edge-tournament family) were **always
live-frame** — there is no demo/live mixing in that replay family to correct, because it never
touched the demo venue at all. The frame artifact measured in this study therefore does not touch any
of those verdicts, and `WATCH-PLAYBOOK-V10-1`'s stop-and-rebuild trigger
(`research/loop/watches.md:220-245`) is **not** fired by this finding and could not have been — it
watches a live-vs-replay divergence in the entry signal, not a demo-vs-live frame issue, and the
replay side of that comparison was never in the demo frame to begin with.

## 7. The four things this data cannot answer

1. **The demo MARK (not the demo fill price) is not independently recoverable at scale.** The
   2026-07-31 incident (`research/loop/incidents/2026-07-31-perp-exit-band-rejects.md`) reconstructed
   the demo mark from `-4024` reject-message shortfalls, but that only exists for **one symbol
   (KAITO) in one ~5-minute window** — 12 samples is not an estimator of a general demo-mark series.
   This study sidesteps that by using the fills table's own recorded price (an exact transaction
   price, not an estimated mark) for the demo side, and the cached OHLCV grid for the live side — but
   it means this study cannot independently cross-check whether OUR OWN fill price was itself
   diverged from the demo venue's mark at the time, only whether the demo fill differs from the live
   tape.
2. **Interpolation carries ±7.5 minutes of drift as noise.** `livePriceAt` linearly interpolates
   between 15-minute bar opens; any fill landing between two knots is marked at an interpolated point
   that could be up to half a bar-width away from the true live price at that instant.
3. **Frame basis cannot be separated from our own market impact.** During the 2026-07-31 stall, this
   book's own order was **281-300 of the 5-minute volume** on the live venue's own tape (per the
   incident report) — a probe of "what would the live price have been" is partly a probe of what our
   own order would have done to it, which this study cannot isolate from genuine frame divergence.
4. **Whether a given fill would have filled on the live venue at all is unanswerable from this data.**
   A live-frame price existing at a given instant says nothing about available depth, and the demo
   book's fill does not imply a live counterparty existed at that price and size.

## What this study does not claim

- It does not claim the +21.0 bps/trip artifact explains, offsets, or meaningfully moves the
  program's standing -108.1 bps/trip gap (`verdicts.md:444-457`) — § 4 shows the opposite direction
  and an order-of-magnitude difference.
- It does not resolve the TRUMP discrepancy in § 5; it reports it.
- It does not re-derive or reopen the demo/live `FEED_ENV` design decision itself (real prices for
  the venue traded, at the cost of a near-dead order book) — that remains a pre-registered decision,
  unchanged here.
- It does not touch the edge-tournament / playbook-space replay family's verdicts (§ 6) — those were
  never demo-framed.
