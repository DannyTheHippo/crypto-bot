# Exit-attribution verdict — preregistration (2026-07-27, verdict due 2026-08-10)

This document freezes the study before any arm is run. Arms, cost model, exclusions, and the verdict
rule below cannot be changed after seeing results. Any follow-up parameter choice is a new registered
trial. Negative evidence is a result.

## Objective

The production agentic lane is net negative. This study asks one question with a frozen answer set:

> Of the deficit between the hit rate the strategy needs and the hit rate it achieves, how much is
> attributable to the model's **discretionary exit timing**, how much to its **declared stop/TP
> geometry**, and how much to the **entries themselves**?

It cannot certify future profitability and does not authorize live trading. It selects which of three
mutually exclusive repair branches the program pursues before the 2026-08-10 kill date.

## Frozen measurements (taken 2026-07-27, before any arm is run)

All figures below were queried from the live Prometheus gauges and the production Postgres, and are
frozen as the study's baseline. They are recorded here so that no later arm can be judged against a
moved baseline.

| Measure | Value |
| --- | --- |
| Closed round trips since `PROMOTION_EVIDENCE_EPOCH=2026-07-21T11:21:00Z` | 23 |
| Win rate (`agentic_promotion_win_rate`) | 0.182 |
| Net-of-cost PnL | −$40.05 |
| Gross trading PnL (`netPnl + llmCostUsd − fundingNet`) | −$24.44 |
| LLM cost | $15.40 |
| Funding (signed, 24 payments) | −$0.21 |
| Entries (`open_long` + `open_short`) | 61 |
| Mean declared `stopLossPct` | 0.0199 |
| Mean declared `takeProfitPct` | 0.0395 |
| Mean declared reward:risk | 2.02 |
| Break-even hit rate at R:R 2.02 after 20 bps round-trip fees | ~34% |
| Measured fees as fraction of traded notional | ≈4 bps |

Exit attribution over the 22 round trips closed at freeze time:

| Closing mechanism | Round trips | Share |
| --- | --- | --- |
| Model's own `close` action | 16 | 72.7% |
| Venue stop (`venue_stop_place`) | 3 | 13.6% |
| Venue take-profit (`venue_tp_place`) | 2 | 9.1% |
| Plan-executor TTL (`plan_exit`) | 1 | 4.5% |
| `PROTECT_STOP_LOSS_PCT` backstop | 0 | 0% |

The protective backstop has never fired and cannot be the routine exit by construction:
`AGENTIC_MAX_STOP_LOSS_PCT='0.05'` caps the model's own stop below the 0.06 backstop, and
`environment.config.ts` refuses to boot if that ordering is violated.

**Predicted vs measured.** `0.182 × 3.95% − 0.818 × 1.99% = −0.91%` per trade against a measured
−1.08%; the residual is fees and slippage. The arithmetic is closed — the hit-rate gap is the whole
deficit, and this study only apportions it.

## Honest prior

The program has already killed, with pre-registered gates: single-venue price technical analysis
(4,562 trials, zero survivors at any fee level including 0 bps), funding carry (0/126 cells),
funding-contrarian (died on second holdout), and the 2026-07-24 public-data tournament (no trial
passed). The `pnl-v1` bake-off measured both candidate decide models as net negative
(−70.5 and −131.4 bps per round trip). **The prior on finding a positive arm here is low**, and the
most likely honest outcome of this study is that it localises the loss rather than removing it.

One prior finding is explicitly *not* carried over: `pnl-v1`'s "stopped out 2-3× more often than they
take profit" was measured on a BTC-perp 4h backtest where only mechanical exits exist. It does not
describe the live book, where mechanical exits account for 6 of 22 closes.

## Frozen arms

The population is the 61 recorded `open_long`/`open_short` rows in `agent_decisions`, each carrying
its own `stopLossPct`, `takeProfitPct`, `maxHoldBars`, `entryStyle`, `entryOffsetBps`, `sizeFraction`
and `thesis` in `plan_json`. No entry is added, dropped, or re-selected by any arm — **every arm
replays the identical entry set at the identical entry fills.** Only the exit rule varies.

1. **Arm 1 — actual.** The realised outcome: discretionary closes included. Baseline 18.2% hit rate,
   −108 bps per round trip.
2. **Arm 2 — declared plan, run mechanically.** Identical entries, exited *only* at the model's own
   declared `stopLossPct` / `takeProfitPct` / `maxHoldBars`. No discretionary `close`. This is the
   decisive cell: it isolates the 72.7% of live exits that the model performs by hand.
3. **Arm 3 — geometry grid.** Stop multiples {1×, 1.5×, 2×, 3×} × take-profit multiples
   {0.5×, 1×, 2×} applied to each entry's own declared values, plus two boundary arms: time-stop-only
   (exit at `maxHoldBars`, no price stop) and no-take-profit (stop and time only). 14 cells.

No cell outside this grid may be reported. No per-symbol parameter is permitted.

## Execution and cost model

- Stop and take-profit resolve **intrabar against candle high/low**, not on closes. A bar that
  touches both the stop and the take-profit counts as the **stop** (conservative).
- Entry fills are taken from the recorded `fills` rows, so entry slippage is real, not modelled.
- Fees: flat 20 bps per round trip (10 bps per leg, maker = taker — the verified demo venue schedule).
- Funding is applied to perp positions from the recorded `funding_payments` where the hold window
  covers a settlement.
- Positions still open at the end of the candle series are **excluded** from every arm
  (`openAtEnd` discipline, matching `counterfactual-scoring.ts`), applied identically across arms.
- Zero LLM calls. The study is pure computation over recorded data and costs nothing.

## Stated statistical limitation

n = 61 entries and 22 closed trips is small, and the arms are not independent — they share entries by
construction, which is what makes the comparison paired and also what forbids treating cell counts as
independent trials. **A cell that merely turns positive is not a pass**; the verdict rule below
requires a margin. No arm result licenses a live flip, and none replaces the promotion gate.

## Frozen verdict rule

Evaluated in this order; the first satisfied clause wins.

1. **DISCRETION** — Arm 2 beats Arm 1 by ≥ 30 bps per round trip **and** Arm 2's hit rate exceeds the
   ~34% break-even. Reading: the model's discretionary exit timing is destroying value; the repair is
   to constrain it (plan task C1).
2. **GEOMETRY** — Arm 2 does not qualify, but some Arm 3 cell is net-positive per round trip **and**
   beats Arm 1 by ≥ 30 bps **and** the same cell's sign is stable when the population is split
   chronologically in half. Reading: the declared stop/TP band is wrong; the repair is bounds (C2).
3. **ENTRIES** — no cell in any arm is net-positive. Reading: the entries carry no directional edge
   that any exit rule can rescue; proceed to C3 (free non-price channels) as the last untested
   channel class before the verdict.

The chronological-split requirement in clause 2 exists because a 14-cell grid over 61 entries will
produce a positive cell by chance; a single positive cell without sign stability is noise, and is
recorded as such.

## Companion study — payload ablation (C4)

Run under the same freeze. Ablate each optional block in `buildMarketPayload` and measure decision
change-rate and forward-return proxy against the unablated baseline.

- **Row count: 40 rows per leg.** 13 legs × 40 rows × ~$0.035 per decide ≈ **$18**, inside the
  ≤$20/gate ceiling. 200 rows/leg would cost ~$90 and is forbidden.
- The `edgePolicy` on/off arm is included. This is how `residual20-volbeta` is measured without
  disabling it in the live deployment, which stays enabled per owner preference for the duration.
- A block is marked DROP only if ablating it changes decisions in < 5% of rows **and** does not worsen
  the forward-return proxy. Ambiguous blocks stay.

## Kill date and branches

**Verdict due 2026-08-10.** After that date a negative result is recorded as a verdict, not iterated.

- **Branch A — a repair is identified and validated.** Apply the branch's repair as a two-step enable
  with a decision record and WATCH, then run the promotion window. Note the timing trap:
  `windowStart = max(firstClosedAt, epoch)`, so re-stamping `PROMOTION_EVIDENCE_EPOCH` restarts the
  14-day clock at re-stamp + 14 days. The current clock already expires **2026-08-06T19:29Z**.
  Re-stamp only if a landed behaviour change invalidates prior evidence, and if so state the new
  promotion date explicitly rather than treating 2026-08-10 as still binding.
- **Branch B — no repair found.** Record "no edge found at this horizon" in
  `research/loop/state.md` § Standing verdicts, recommend against the live flip, and state the
  remaining options (different horizon, different venue class, or stop) without opening another
  iteration.

Capital scaling is gated independently of both branches: `SIZER_EQUITY_CAP` rises from 1000 toward
the $5k intended live capital **only** once gross trading PnL (realized − fees, before LLM cost) is
positive. At $1k the LLM burn is a 91–147%/yr hurdle (110%/yr at the configured
`AGENTIC_DAILY_COST_STOP_USD=3` ceiling); at $5k it is 18–29%/yr. Scaling a negative expectancy
multiplies the loss, so the ordering is not negotiable.

## RESULT — verdict ENTRIES (run 2026-07-27, ahead of the kill date)

Harness: `test/backtest/exit-attribution.spec.ts` (three arms) over
`test/backtest/exit-simulator.ts` (intrabar). Run read-only against the production DB at the frozen
epoch; 175 fills, 24 cycles, 61 entry decisions, 0 unmatched, 0 missing candle series. Zero LLM
calls, zero dollars spent.

Numbers below are the **post-fix** run, after the phantom-dust defect documented in the next section
was corrected. The corrected walk yields 23 cycles with zero phantoms and an Arm 1 of −108.1 bps,
which reproduces the live `agentic_promotion_*` gauges without any manual exclusion. (The first run,
against the defective walk, reported 24 cycles and an Arm 1 of −528.8 bps — a single phantom trip
moved the headline by 420 bps, which is why it was chased down before the verdict was written.)

| Arm | Trips | Hit rate | Mean net bps | stop/tp/hold |
| --- | --- | --- | --- | --- |
| **Arm 1 actual (discretionary)** | 23 | 17.4% | **−108.1** | — |
| **Arm 2 declared plan, mechanical** | 22 | 22.7% | **−78.4** | 12/2/8 |
| Arm 3 stop ×1 tp ×0.5 | 22 | 31.8% | −65.8 | 11/5/6 |
| Arm 3 stop ×1 tp ×1 | 22 | 22.7% | −78.4 | 12/2/8 |
| Arm 3 stop ×1 tp ×2 | 22 | 22.7% | −87.5 | 12/0/10 |
| **Arm 3 stop ×1.5 tp ×0.5 (best cell)** | 20 | 40.0% | **−45.0** | 7/6/7 |
| Arm 3 stop ×1.5 tp ×1 | 20 | 25.0% | −88.6 | 8/2/10 |
| Arm 3 stop ×1.5 tp ×2 | 20 | 25.0% | −98.6 | 8/0/12 |
| Arm 3 stop ×2 tp ×0.5 | 20 | 40.0% | −56.8 | 5/6/9 |
| Arm 3 stop ×2 tp ×1 | 20 | 30.0% | −76.4 | 5/2/13 |
| Arm 3 stop ×2 tp ×2 | 20 | 30.0% | −86.4 | 5/0/15 |
| Arm 3 stop ×3 tp ×0.5 | 20 | 40.0% | −76.2 | 2/6/12 |
| Arm 3 stop ×3 tp ×1 | 20 | 30.0% | −95.8 | 2/2/16 |
| Arm 3 stop ×3 tp ×2 | 20 | 30.0% | −105.8 | 2/0/18 |
| Arm 3 time-stop only | 20 | 30.0% | −84.5 | 0/0/20 |
| Arm 3 no take-profit | 22 | 22.7% | −87.5 | 12/0/10 |

**Verdict: ENTRIES.** Applying the frozen rule in order:

1. **DISCRETION — FAILS on both conditions.** Arm 2 beats Arm 1 by 29.7 bps, just under the ≥30 bps
   margin, and its hit rate is 22.7%, far below the ~34% break-even. Letting the declared plan run
   *is* better than the model's hand, and that effect is real and reportable — but it lands a
   fraction below the pre-registered bar and nowhere near profitability. Recorded exactly as the
   frozen rule reads it, without adjusting the bar after the fact. (Against the defective walk the
   margin read 33.2 bps and would have cleared clause 1's first condition; the second condition
   failed either way, so the verdict is unchanged. Worth noting as a live demonstration of why the
   margin was pre-registered rather than chosen afterwards.)
2. **GEOMETRY — FAILS.** No Arm 3 cell is net-positive. The best of 14 cells still loses 45.0 bps per
   round trip. The chronological-split test was not reached.
3. **ENTRIES — SELECTED.** Every cell in every arm is negative. No exit rule available in this grid
   rescues these entries.

**Secondary patterns, recorded but not acted on.** A shorter take-profit dominates at every stop
multiple (tp ×0.5 is the best cell at ×1, ×1.5, ×2 and ×3), and wider stops raise the hit rate
monotonically (17.4% → 40%) while leaving expectancy negative. Both together are the signature of
entries with no directional edge: hit rate can be bought by shortening the target, but with no drift
to capture the expectancy does not follow. This is consistent with, and independent of, the
2026-07-12 price-technical search that returned zero survivors from 4,562 trials.

**Statistical honesty.** n = 23 usable trips. These arms are paired by construction and are not
independent trials; the ENTRIES verdict rests on the fact that *no* cell is positive rather than on
any single cell's margin, which is the reading that small n best supports.

## DEFECT FOUND AND FIXED — the dust rule minted phantom round trips

Not part of the study design; surfaced by it and reported per the standing "defects are never
deferred" rule.

`walkRoundTrips` (`src/domain/trading/risk/round-trips.ts`) closes a cycle whenever the running
position's notional falls below `PROMOTION_DUST_NOTIONAL` ($5). It applies that test on the way
**in** as well as on the way out. BCH/USDT:USDT's multi-fill backfill opened with 0.022 @ 218.49 =
**$4.81**, under the threshold, so a "closed round trip" was minted at the first fill with cost and
no proceeds — a **−10,004 bps** trip. It then reset the cycle, so the remaining 0.343 bought was
matched against 0.365 sold, corrupting the second cycle's accounting too. True BCH round-trip PnL is
−$1.16; the walk books roughly −$7.3 across the two fragments.

Consequences, both on gauges the promotion gate reads:

- `agentic_promotion_round_trips` is inflated — a phantom trip counts toward the ≥30 floor.
- `agentic_promotion_net_pnl_usd` is distorted. Measured at deploy: **−$40.05 → −$37.74**, i.e.
  $2.31 on a −$40 total (~6%). An earlier estimate in this document put it near $6; the observed
  figure is the one to trust, and it is recorded here rather than the estimate being quietly
  deleted.

It would recur on any multi-fill order whose first fill is under $5 — routine at
`SIZER_EQUITY_CAP=1000` with 0.04 sizing (~$40 positions filling in slices).

**FIXED.** `CycleState` now tracks `peakNotional`, and the dust rule may close a cycle only once that
peak has reached `dustNotional` — so it fires on the way **out** and never while a position is still
building. Fail direction is unchanged and deliberate: a cycle that never reaches dust stays open and
its fills are excluded from the walk, so the promotion gate **under**-counts round trips rather than
admitting a phantom, matching the under-count-never-false-permit discipline the epoch-straddle bound
already documents. Because phantoms inflated the trip count, the fix makes the ≥30-trip floor
strictly harder to reach — the safe direction for a live-arming input.

Two existing specs asserted the old behaviour (a stray 0.01 SELL booking +1 realized, a stray 0.01
BUY booking −1) with no stated rationale; they were characterization tests of the defect and have
been rewritten to encode the corrected semantics, alongside a new BCH-shaped regression that folds a
sub-dust first fill into one cycle. Verified live: the corrected walk yields 23 cycles, zero
phantoms, Arm 1 −108.1 bps — reproducing the production gauges with no manual exclusion.

**Deployed 2026-07-27** (commit `6a84d23`, image rebuilt, `app` recreated while holding six open
positions). Post-deploy gauges confirm the fix end to end: `agentic_promotion_round_trips` 24 → 23,
`agentic_promotion_net_pnl_usd` −$40.05 → −$37.74, `agentic_promotion_win_rate` 0.17391 (= 4/23,
matching this study's Arm 1 exactly), kill switch RUNNING. Two incidental confirmations from the same
boot: **WATCH-V4-3 satisfied** — a redeploy while carrying perp exposure produced zero `perp pin:` /
`START_TRADING_FAILED` / `FLATTENING` lines and zero errors, the first real-conditions test of
`287ef6c` — and `agentic_budget_remaining_usd` read $1.69 rather than a reset $3.00, confirming
`f2d74b6`'s durable budget seed survives a redeploy.

**The verdict above is unaffected**: no arm cell is positive under either walk.

## Production boundary

This study is read-only research under `test/`. Production remains agentic: the LLM proposes every
Signal, Risk sizes and vetoes it, Execution enforces the approved intent. A repair adopted from this
study may constrain the model's exit options or its directive bounds; it may never bypass Risk. The
live flip, the four live gates, and the promotion requirement (≥30 demo round trips, positive
net-of-cost PnL, ≥14 days) remain unchanged.
