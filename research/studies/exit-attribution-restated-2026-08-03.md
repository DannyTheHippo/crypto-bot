# Exit-attribution restated — measured fees and a side-aware entry anchor (2026-08-03)

The frozen pre-registration `research/studies/edge-verdict-2026-08-10.md` has a verdict due
**2026-08-10**, adjudicated on cells produced by `test/backtest/exit-attribution.spec.ts`. That
harness carries two measurement defects. This study restates its 16 cells under a corrected cost
basis and a corrected entry anchor, reports the restated numbers **beside** the published ones, and
discharges backlog task **#105**.

Harness: `test/backtest/exit-attribution-restated.spec.ts` over `test/backtest/restated-cost.ts`,
env-gated (`EXIT_ATTRIBUTION_RESTATED=1` + `DATABASE_URL`), self-skipping, off the production gate.
Read-only against `fills` / `order_intents` / `agent_decisions`. Zero LLM calls, zero dollars spent.
The frozen spec was **not edited** and its cells are **not replaced**.

**The ENTRIES verdict does not move, and the restatement makes the arms look WORSE.** Every cell in
every arm is still negative; the best cell falls from −45.0 to −59.5 bps/trip. But one published
sub-clause reverses: the "Arm 2 beats Arm 1 by 29.7 bps, just under the ≥30 bar" reading is an
artifact of the two defects pulling in opposite directions, and under the restatement Arm 2 is
**34.3 bps worse** than Arm 1, not better (§ 4).

## Bottom line

| Question | Answer |
| --- | --- |
| Does the control pass reproduce the frozen table? | **Yes, cell for cell** — all 16 cells, trip counts, hit rates and stop/tp/hold splits, Arm 1 −108.1 bps, margin 29.7 bps (§ 2). |
| Defect (a): how wrong is the flat 20 bps? | The book here is **binanceusdm 2.0000 bps/leg maker, 4.5787 taker; binance 10.0000 both** (§ 1). The frozen spec bills 10 bps/leg on everything, i.e. **~2.15x** the real cost on 20 of 23 trips. |
| Defect (b): how wrong is `entryVwap` on a short? | **9 of 23 trips open short.** Anchor shift ranges **−200.9 to +238.0 bps** (§ 3). TRUMP/USDT:USDT reproduces the reported case exactly: `buyVwap` **1.593** (the cover) vs opening SELL VWAP **1.561**. |
| Did any cell's SIGN flip? | **No.** All 16 cells are negative in the control and negative under the restatement (§ 4). |
| Did the Arm2−Arm1 margin's sign flip? | **Yes: +29.7 → −34.3 bps** on the frozen population (§ 4). On the current 49-trip book it does not flip (+26.3 → +11.6) but still misses the bar (§ 6). |
| Would the fee defect ALONE have changed a clause? | **Yes.** Fees-only restated puts the margin at **+40.4 bps**, clearing clause 1's ≥30 bps condition that the published run missed by 0.3 bps (§ 5). |
| Does the ENTRIES verdict change? | **No**, and it is strengthened — no cell is net-positive under any of the five passes, on either population. |
| Which cost basis should a reader use? | The **measured per-(venue, liquidity) schedule** in § 1, never a flat 20 bps. The flat constant is the spot schedule applied to a book that is 85% perp. |

## Method — five passes over ONE population

The restatement changes measurement only. `walkRoundTrips` (`src/domain/trading/risk/round-trips.ts`)
is **imported and used**, never reimplemented: the cycle-closure rule (dust / `peakNotional` fold)
stays the single source of when a cycle opens and closes, so nothing here can become a second source
of truth for the number the promotion gate returns.

A trip is admitted only if **every** pass can price it, so all five tables share one population and
each delta is attributable to that pass's own change rather than to a moved denominator.

| Pass | Anchor | Side | Cost |
| --- | --- | --- | --- |
| `CONTROL` | buy-side VWAP | `agent_decisions` label | flat 20 bps |
| `FEES-ONLY` | buy-side VWAP | `agent_decisions` label | measured |
| `ANCHOR-ONLY` | opening-leg VWAP | sign of first fill | flat 20 bps |
| `RESTATED` | opening-leg VWAP | sign of first fill | measured |
| `RESTATED all-taker` | opening-leg VWAP | sign of first fill | measured, every counterfactual exit leg taker |

**Population.** `mode='testnet'`, `venue_timestamp` in
`[2026-07-21T11:21:00Z, 2026-07-27T16:00:00Z)` — the frozen run's own inputs, reproduced exactly:
**175 fills, 23 cycles, 61 entry decisions, 23 usable trips, 0 unmatched, 0 missing candle series,
0 partition mismatches**.

**Forward bars are bounded at the same instant as the fills.** The OHLCV cache under
`test/backtest/data/` has been refreshed since 2026-07-27 (it now reaches 2026-07-31T20:45Z per
`frame-audit-2026-08-03.md` § 2). Replaying on today's cache hands every arm forward bars the frozen
run did not have and resolves trips it excluded under the `openAtEnd` rule — with the unbounded
cache the control's Arm 2 reads −49.8 bps over 23 trips instead of the published −78.4 over 22. That
is not a defect in either run; it is that **the published cells are not reproducible from today's
cache**, and the bar bound is what makes the comparison like-for-like. This is a look-ahead bound,
not a fitted one: no arm may see past the freeze instant.

## 1. Defect (a) — the cost constant is the spot schedule

`exit-attribution.spec.ts:45` hardcodes `ROUND_TRIP_FEE = '0.002'` with the comment _"20 bps: 10 bps
per leg, maker = taker (verified demo schedule)"_. That comment is true of `binance` spot and false
of the book. Re-derived from the same 175 fills the study replays (notional-weighted, fees converted
to quote by the production `sumFeesQuote`):

| venue | liquidity | bps/leg | fills | notional |
| --- | --- | --- | --- | --- |
| `binanceusdm` | maker | 2.0000 | 106 | $1,044.92 |
| `binanceusdm` | taker | 4.5787 | 59 | $2,733.25 |
| `binance` | maker | 10.0000 | 2 | $79.96 |
| `binance` | taker | 10.0000 | 8 | $393.47 |

This reproduces `fee-floor-derivation-2026-07-31.md` § 2's per-venue table on the narrower window.
20 of the 23 trips are `binanceusdm`.

**How each trip is billed.** No flat constant anywhere:

- The **opening leg** is billed its own recorded fee — quote-converted fees on that leg divided by
  that leg's notional. Per-trip this ranges **2.000 to 10.000 bps**.
- The **counterfactual exit leg** (which the arm replaces, so no recorded fee exists) is billed the
  venue's measured rate for that leg's liquidity, scaled by `exitPrice / entryPrice`. Liquidity by
  mechanism: a stop is **taker** (all 13 recorded `STOP_MARKET` / `STOP_LOSS_LIMIT` reduce-only fills
  in the book are taker — 100%), a take-profit is **maker** (a limit resting away from the market and
  hit), a `maxHoldBars` flatten is **taker**.
- The take-profit=maker choice is the one modelling judgement in the cost model. The
  `RESTATED all-taker` pass prices every counterfactual exit taker instead; it moves the best cell by
  **0.7 bps** and no clause at all (§ 4). The judgement is not load-bearing.

## 2. The control reproduces the frozen table cell for cell

This is the check that makes every delta below trustworthy, and it is exact — not "close".

| Cell | Published (`edge-verdict-2026-08-10.md` § RESULT) | Control pass |
| --- | --- | --- |
| Arm 1 actual | 23 trips, 17.4%, −108.1 | 23 trips, 17.4%, −108.1 |
| Arm 2 declared plan | 22, 22.7%, −78.4, 12/2/8 | 22, 22.7%, −78.4, 12/2/8 |
| Arm 3 stop ×1 tp ×0.5 | 22, 31.8%, −65.8, 11/5/6 | 22, 31.8%, −65.8, 11/5/6 |
| Arm 3 stop ×1.5 tp ×0.5 | 20, 40.0%, −45.0, 7/6/7 | 20, 40.0%, −45.0, 7/6/7 |
| Arm 3 stop ×3 tp ×2 | 20, 30.0%, −105.8, 2/0/18 | 20, 30.0%, −105.8, 2/0/18 |
| Arm2 − Arm1 margin | 29.7 bps | 29.7 bps |

All 16 cells match; five are shown. The remaining eleven are in the harness output.

## 3. Defect (b) — the anchor is the cover price on every short

`ClosedRoundTrip.entryVwap` is `cost / boughtQty` (`round-trips.ts:201`) — the **BUY-side** VWAP. Its
own doc comment says so. On a short round trip the BUYs are the **cover**, so `entryVwap` is the
**exit** price standing in as the entry anchor, and the frozen spec then resolves stop and take-profit
against forward bars starting at the cycle's OPEN.

**9 of 23 trips open short.** Per-trip anchor shift (opening-leg VWAP against `entryVwap`):

| symbol | opening SELL VWAP | `entryVwap` (cover) | shift |
| --- | --- | --- | --- |
| TRUMP/USDT:USDT | 1.561000 | 1.593000 | −200.9 bps |
| KAITO/USDT:USDT | 1.002300 | 1.022300 | −195.6 bps |
| KAITO/USDT:USDT | 1.016300 | 1.033600 | −167.4 bps |
| HYPE/USDT:USDT | 57.488000 | 58.146000 | −113.2 bps |
| HYPE/USDT:USDT | 57.075000 | 57.564000 | −84.9 bps |
| ZEC/USDT:USDT | 504.910000 | 508.900000 | −78.4 bps |
| ETH/USDT:USDT | 1874.620000 | 1885.010000 | −55.1 bps |
| XRP/USDT:USDT | 1.112600 | 1.107476 | +46.3 bps |
| KAITO/USDT:USDT | 0.985200 | 0.962300 | +238.0 bps |

TRUMP/USDT:USDT reproduces the reported case exactly (16 SELL fills @ 1.561 opening, one BUY @ 1.593
covering). The shift runs **both ways** — negative on a losing short (the cover is above the entry,
so the wrong anchor makes the short look like it was sold higher than it was) and positive on a
winning one. Because most trips lose, the net effect of the defect is to **flatter** the short arms,
and correcting it makes them worse.

The `agent_decisions` label and the fill-derived opening direction agree on **all 23 trips**
(`sideDisagreements=0`), so the anchor is the whole of defect (b) — the simulated direction was never
wrong, only the price it was measured from.

## 4. Restated cells beside the originals

Mean net bps per round trip. `CONTROL` is the published number; `RESTATED` corrects both defects.

| Cell | control | fees-only | anchor-only | RESTATED | delta | sign flip |
| --- | --- | --- | --- | --- | --- | --- |
| Arm 1 actual | −108.1 | −108.1 | −109.0 | −109.0 | −0.9 | no |
| Arm 2 declared plan | −78.4 | −67.7 | −153.8 | −143.3 | −64.9 | no |
| Arm 3 stop ×1 tp ×0.5 | −65.8 | −54.7 | −82.4 | −71.4 | −5.6 | no |
| Arm 3 stop ×1 tp ×1 | −78.4 | −67.7 | −153.8 | −143.3 | −64.9 | no |
| Arm 3 stop ×1 tp ×2 | −87.5 | −77.0 | −153.8 | −143.3 | −55.8 | no |
| Arm 3 stop ×1.5 tp ×0.5 | −45.0 | −33.9 | −70.5 | **−59.5** | −14.5 | no |
| Arm 3 stop ×1.5 tp ×1 | −88.6 | −78.1 | −136.0 | −125.7 | −37.0 | no |
| Arm 3 stop ×1.5 tp ×2 | −98.6 | −88.3 | −136.0 | −125.7 | −27.0 | no |
| Arm 3 stop ×2 tp ×0.5 | −56.8 | −45.7 | −75.1 | −64.2 | −7.4 | no |
| Arm 3 stop ×2 tp ×1 | −76.4 | −65.8 | −116.7 | −106.3 | −30.0 | no |
| Arm 3 stop ×2 tp ×2 | −86.4 | −76.0 | −116.7 | −106.3 | −20.0 | no |
| Arm 3 stop ×3 tp ×0.5 | −76.2 | −65.1 | −94.6 | −83.6 | −7.4 | no |
| Arm 3 stop ×3 tp ×1 | −95.8 | −85.2 | −136.1 | −125.8 | −30.0 | no |
| Arm 3 stop ×3 tp ×2 | −105.8 | −95.5 | −136.1 | −125.8 | −20.0 | no |
| Arm 3 time-stop only | −84.5 | −74.2 | −114.8 | −104.5 | −20.0 | no |
| Arm 3 no take-profit | −87.5 | −77.0 | −153.8 | −143.3 | −55.8 | no |

**No cell's sign flipped.** Every cell is negative before and after. The best cell is unchanged in
identity (stop ×1.5 tp ×0.5) and falls from **−45.0 to −59.5** bps/trip.

**The Arm2 − Arm1 margin's sign DID flip: +29.7 → −34.3 bps.** The two defects push in opposite
directions and nearly decompose additively on Arm 2: the fee correction is worth **+10.7 bps** and
the anchor correction **−75.4 bps**, summing to −64.7 against the measured −64.9.

**A structural change worth naming.** Under the corrected anchor the take-profit count on the tp ×1
and tp ×2 arms collapses to **zero** (`stop/tp/hold` goes 12/2/8 → 14/0/8). With the cover price
standing in as the entry, a short's declared take-profit sat on the wrong side of the forward path
and was reachable; from the true opening price it is not, and those trips stop out instead. The
published Arm 2 was not merely mispriced — it was exiting through a mechanism the position could not
have used.

**Arm 1 barely moves** (−108.1 → −109.0). Arm 1 already bills each trip its own measured `feesQuote`,
so defect (a) never touched it, and the anchor enters only as the denominator of a realised PnL.

## 5. The frozen verdict rule, re-evaluated pass by pass

Applying `edge-verdict-2026-08-10.md` § Frozen verdict rule mechanically to each pass:

| Pass | Arm2−Arm1 | ≥30 bps? | Arm 2 hit | ≥34%? | best Arm 3 | net-positive? |
| --- | --- | --- | --- | --- | --- | --- |
| `CONTROL` | +29.7 | not met | 22.7% | not met | −45.0 | no |
| `FEES-ONLY` | **+40.4** | **MET** | 22.7% | not met | −33.9 | no |
| `ANCHOR-ONLY` | −44.8 | not met | 22.7% | not met | −70.5 | no |
| `RESTATED` | −34.3 | not met | 22.7% | not met | −59.5 | no |
| `RESTATED all-taker` | −34.3 | not met | 22.7% | not met | −60.2 | no |

**Clause 1 (DISCRETION) fails in every pass**, because its second condition — Arm 2's hit rate above
the ~34% break-even — fails at 22.7% under all five cost bases. Clause 2 (GEOMETRY) fails in every
pass: no Arm 3 cell is net-positive anywhere. **Clause 3 (ENTRIES) is selected in every pass.**

**But the published first condition was decided by a defect.** The frozen write-up records _"Arm 2
beats Arm 1 by 29.7 bps, just under the ≥30 bps margin"_ and presents that near-miss as a live
demonstration of why the bar was pre-registered rather than chosen afterwards. Correcting only the
fee constant puts the margin at **+40.4 bps** — clearing the bar the published run missed by 0.3.
Correcting the anchor as well puts it at **−34.3 bps** — Arm 2 is _worse_ than Arm 1, reversing the
published secondary reading that _"letting the declared plan run is better than the model's hand"_.

**The verdict is unchanged and its grounds are strengthened.** The ENTRIES verdict rests on the fact
that _no_ cell is positive rather than on any single cell's margin, and that fact survives every
pass on both populations.

## 6. Robustness — the current 49-trip book

Re-run unbounded (`fills=295`, `cycles=49`, 20 short trips, full OHLCV cache). This is **not**
like-for-like with the published cells — it is a different population — and is reported only as a
direction check:

| Pass | Arm 1 | Arm 2 | Arm2−Arm1 | best Arm 3 |
| --- | --- | --- | --- | --- |
| `CONTROL` | −96.0 | −69.7 | +26.3 | −54.4 |
| `FEES-ONLY` | −96.0 | −59.2 | **+36.7** | −43.5 |
| `ANCHOR-ONLY` | −97.8 | −96.5 | +1.3 | −60.6 |
| `RESTATED` | −97.8 | −86.2 | +11.6 | −49.9 |

The margin's sign does **not** flip on this population (+26.3 → +11.6) — the flip in § 4 is
population-dependent and is reported as such rather than generalised. Everything else agrees: the fee
defect alone clears the ≥30 bar (+36.7), the anchor defect pushes the other way and dominates, no
cell is net-positive, and no Arm 2 hit rate reaches 34%.

## What this study cannot answer

1. **It cannot restore the published cells' reproducibility.** The forward-bar bound at
   2026-07-27T16:00:00Z is inferred from the fill population, not from a recorded cache manifest —
   the cache's state at the frozen run was never recorded. That it reproduces all 16 cells exactly is
   strong evidence the inference is right, and it remains an inference.
2. **It does not price funding.** The pre-registration's cost model applies recorded
   `funding_payments` to perp holds; neither the frozen harness nor this one does. 20 of 23 trips are
   perp, and recorded funding over the whole book is −$0.21 signed (`edge-verdict-2026-08-10.md`
   § Frozen measurements), so the omission is small — but it is an omission, in both runs, and both
   arms carry it identically.
3. **It cannot say what the exit leg's liquidity would have been.** Maker/taker on a counterfactual
   exit is modelled, not observed, because the exit the arm simulates never happened. The all-taker
   sensitivity bounds the choice at 0.7 bps on the best cell; nothing bounds the possibility that a
   resting take-profit would not have filled at all.
4. **It cannot separate the demo/live frame artifact.** Entry marks are demo-frame fill VWAPs while
   forward bars are live-frame OHLCV — the mixing `frame-audit-2026-08-03.md` measures at +21.0
   bps/trip. This restatement corrects the anchor's SIDE, not its FRAME; the frozen spec's own
   live-frame re-run is a separate axis and is not reproduced here.
5. **It does not make the arms independent.** n = 23 trips sharing one entry set by construction.
   Cell counts are not independent trials, and a 16-cell grid is not 16 tests. No margin here
   licenses anything.

## What this study does not claim

- It does not claim the ENTRIES verdict moves. It does not move, on either population, under any of
  the five passes.
- It does not claim any cell became profitable. None did; the restatement makes the arms **worse**,
  and the best cell falls 14.5 bps.
- It does not edit, replace, or retract the frozen pre-registration's body or its published cells.
  The amendment appended to `edge-verdict-2026-08-10.md` is dated and additive.
- It does not propose changing `ROUND_TRIP_FEE` in `exit-attribution.spec.ts`. That spec is the
  frozen harness of a completed pre-registered study; changing it would make the published cells
  unreproducible for a second reason.
- It does not propose changing `entryVwap` in `src/domain/trading/risk/round-trips.ts`. That field is
  read by the promotion gate and the reflection evidence feed; its doc comment is accurate and the
  defect is in the consumer that assumed BUY = entry. Any change there is a production money-path
  change with its own review, not a research restatement.
