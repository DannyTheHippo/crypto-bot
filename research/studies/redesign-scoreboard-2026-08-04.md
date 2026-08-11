# The redesign scoreboard — preregistration (2026-08-04)

_Frozen before the enables it governs. A set of cost levers is pending; none of them has a declared
magnitude anywhere in the record, which means each one could be graded after the fact against
whatever it happened to do. This document fixes the all-in cost formula, the burn arithmetic and its
dated checkpoints, and — for every pending lever — an expected magnitude with its arithmetic, an
expected-positive signal, and a NAMED defect that triggers rollback. Two of the five levers are
declared NULL before they ship, on measurement, and one is BLOCKED for want of a derivable
magnitude._

**Nothing below may be re-declared after a result is seen.** Amendments are appended and dated; the
body is never edited away — this program's standing discipline (`research/loop/charter.md`
§ Gate-override audit) and the form its predecessors carry
([`oos-session-arm-2026-08-03.md`](oos-session-arm-2026-08-03.md) § Amendments,
[`playbook-space-followon-2026-07-31.md`](playbook-space-followon-2026-07-31.md) § The sonnet rate
rise).

**Anchors, and every figure below carries one:**

- **A1 — the book tuple.** ONE `PromotionReadinessService.evaluate()` sample at
  **2026-08-03T22:02:24Z**: `roundTrips=49, windowDays=10.9688, netPnlUsd=−63.5326,
  llmCostUsd=28.7007, winRate=0.2449`, `reasons=[NON_POSITIVE_NET_PNL, INSUFFICIENT_WINDOW,
  BELOW_PASSIVE_BENCHMARK]`. **SUPPLIED to this record, not recomputed here** — it is one atomic
  tuple and is never quoted from separate reads (`STATUS.md:87-93`'s standing rule).
- **A2 — the bar operands.** [`break-even-bar-derivation-2026-08-04.md`](break-even-bar-derivation-2026-08-04.md)
  and [`book-truth-2026-08-04.md`](book-truth-2026-08-04.md), anchored **2026-08-03T16:07:00Z**,
  n=48 closed trips, 294 fills, Σ one-way notional **$3,996.1492**, 12 base-asset clusters.
- **A3 — this record's own reads.** Read-only `psql` against the live `cryptobot` database and
  `promtool` against the live Prometheus, **2026-08-03T22:40Z–22:45Z**. Every figure marked
  _measured here_ comes from A3 and its query shape is stated inline.
- **Epoch.** `PROMOTION_EVIDENCE_EPOCH` = **2026-07-21T11:21:00Z**.

## Bottom line

| question | answer |
| --- | --- |
| Is the contingency this scoreboard was gated on confirmed? | **Yes, and it is confirmed in BOTH directions** — the asserted +13.0 bar is above the gross CI's upper bound as a venue-cost bar and ~66 bps below the all-in question it was used to answer (§ 0) |
| What does one round trip cost, all in? | **+78.80 bps** book-average (48 trips / 10.85 d / $83.25 mean one-way), **+108.01 bps** on the last three full UTC days' own denominators (§ 1) |
| Is the LLM term getting better or worse? | **Worse.** 70.44 bps book-average, **99.67 bps** over 2026-07-31→08-02 — spend held while turnover fell (§ 1.4) |
| Does cutting LLM spend fix the book? | **No.** Gross alone is **−$34.83**; zero LLM spend leaves the book negative and still fires S3, on **2026-09-25** (§ 2.4) |
| When does S3's −$200 fire? | **2026-08-27 to 2026-09-01**, denominator-dependent; composed forward rate says **2026-08-30** — one day before the § 8 window close (§ 2.2) |
| Which lever moves the 70–100 bps LLM term? | **Turnover per unit time, and nothing else** — and raising it multiplies the dollar loss of a negative-gross book by the same factor (§ 1.3) |
| `SIZER_EQUITY_FRACTION` 0.04→0.10? | **NULL, twice over.** The knob is inert on this book (67/67 entries sized by the model's own `sizeFraction`), and turnover-neutral leaves the ratio invariant by identity (§ 3.2) |
| The perp fee-truth flip? | **NULL, measured.** Its gate has fired **0 times, ever**; its other consumer never reads the perp row (§ 3.5) |

## 0. The contingency is CONFIRMED, and this record cites it rather than assuming it

This scoreboard was written on the contingency that the asserted **+13.0 / +24.2** bar would not
survive derivation. **It did not survive**, and the finding is now on record with its operands
([`break-even-bar-derivation-2026-08-04.md`](break-even-bar-derivation-2026-08-04.md), harness
`test/backtest/break-even.spec.ts`, cluster bootstrap on base assets, seed 20260731, `N_BOOT`
20,000, floors `MIN_CLUSTERS=5` / `MIN_OBS=12`):

| term | value | denominator / power |
| --- | --- | --- |
| venue fees, exact per cycle | **8.6718 bps/round trip** | 48 trips, Σ one-way $3,996.1492; spot 20.0000 (n=7), perp 7.2208 (n=41) |
| slippage, re-derived | **−0.3317 bps/round trip** | 112 of 294 legs inside the 60 s freshness bound; **sign-flipped from the recorded +0.333 and indistinguishable from zero** |
| **GROSS bar** | **+8.3619 bps/round trip**, cluster **CI95 [6.2010, 10.7616]** | n=48, **12 clusters ⇒ EVIDENCE, not a recorded figure** |
| LLM, amortized | **+70.44 bps/round trip** | $28.1473391 ÷ 48 = $0.5864/trip ÷ $83.2531 mean one-way |
| **ALL-IN bar** | **≈ +78.80 bps/round trip** | at 48 trips / 10.85 days / $83.2531 mean one-way — **not separable from that denominator** |

**The asserted +13.0 is wrong in both directions at once.** As a venue-cost bar it sits **above the
gross CI's upper bound of 10.7616** — it demands ~4.6 bps more edge than the venue actually charges.
As an answer to "what must a trip earn to pay for itself" it is **~66 bps too low**. A single number
cannot be both, which is the clearest evidence available that it was never derived for either
question.

**The gap, on the bar's own denominator.** Realised gross is Σ `realizedPnl` −27.933707 over Σ
one-way 3,996.1492 = **−69.9016 bps/round trip**.

```text
gap to the derived GROSS bar    =  8.3619 − (−69.9016)  =   78.26 bps/trip
gap to the book-average ALL-IN  = 78.7981 − (−69.9016)  =  148.70 bps/trip
gap to the FORWARD ALL-IN (§ 1.4) = 108.01 − (−69.9016) = 177.91 bps/trip
```

The record's carried gap is 111–130 bps/trip. **On an all-in basis it is wider than anything the
record holds, and on the forward denominators wider still.**

## 1. The all-in per-trip cost formula, with every denominator printed beside it

### 1.1 The formula

```text
all_in_bps_per_round_trip
  =  fees_bps                                  (Σ fee ÷ Σ one-way notional, per cycle, ×1e4)
  +  slippage_bps                              (Σ signed adverse cost ÷ Σ one-way notional, ×1e4)
  +  llm_total_usd × 1e4 ÷ Σ_one_way_notional  (identically equal to ($/trip) ÷ (notional/trip))
```

**Every term shares one denominator — Σ one-way notional over the same window — and that is what
makes the three addable.** A term quoted against a different Σ is not part of this sum.

### 1.2 The two current values, each with its window

| basis | window | fees | slippage | LLM | **ALL-IN** |
| --- | --- | --- | --- | --- | --- |
| **book-average** | epoch → 2026-08-03T16:07Z; 48 trips; Σ one-way **$3,996.1492**; $28.1473391 LLM | 8.6718 | −0.3317 | **70.44** | **+78.7801 bps/trip** |
| **forward rate** | three full UTC days **2026-07-31 → 2026-08-02**; Σ one-way **$778.2393** (36 fills); decide spend **$7.7570** | 8.6718 | −0.3317 | **99.67** | **+108.01 bps/trip** |

Dollar form of the book-average row, at the measured $83.2531 mean one-way notional: fees $0.072198,
slippage −$0.002762, LLM $0.586403 ⇒ **$0.6558 of cost per round trip**, of which **89.4% is
inference**.

**The forward row's LLM term is measured here (A3), on matched denominators**: daily decide spend
priced from `agent_decisions` token columns at the deployed rate card (3 / 15 / 0.3 / 6 USD per Mtok,
`.env.app`), non-replay, `model='claude-sonnet-5'`; daily one-way notional as `Σ(qty×price)/2` over
`fills where mode='testnet'`. Both sides are the same three UTC days.

| UTC day | decide spend | priced rows | fills | one-way notional |
| --- | --- | --- | --- | --- |
| 2026-07-30 | $2.1856 | 53 | — | — |
| 2026-07-31 | **$2.9707** | 94 | 8 | $300.7782 |
| 2026-08-01 | **$2.4490** | 80 | 17 | $246.8546 |
| 2026-08-02 | **$2.3373** | 87 | 11 | $230.6065 |
| 2026-08-03 (partial, to 22:40Z) | $2.7157 | 72 | 19 | $305.4309 |

`7.7570 × 1e4 ÷ 778.2393 = 99.674 bps`. The four-day variant including the partial 08-03 gives
**96.64 bps** and is biased LOW on this metric — the spend side runs to 22:40Z while the last fill is
17:15:34Z, so the notional side gets more hours than the spend side. The three-day figure is the one
this record carries.

**2026-07-31 spent $2.9707 against a $3.00 breaker — 99.0%.** The lane came within three cents of
tripping its own daily circuit breaker.

### 1.3 The two attributions are different objects, and the corollary is uncomfortable

- **Amortized average — the number the objective needs.** `net-of-cost PnL = realizedPnl − fees −
  llmCostUsd` divides the book cost across the book's trips. $28.7683109 ÷ 49 = **$0.587/trip**
  ([`llm-cost-attribution-2026-08-04.md`](llm-cost-attribution-2026-08-04.md) § 4, validated against
  the promotion gate's own published gauge as an **identity**, three readings, EXACT).
- **Consult-chain marginal — $0.06 to $0.12/trip.** An accounting allocation of the consults that
  bracket a trip.
- **The TRUE marginal is ≈ $0**, because consult cadence is **time-driven**. Direct evidence: of 667
  post-epoch consults, **518 were pure cadence** — 1,008 rows, zero trade actions — and they spent
  **$17.81, 61.9% of the entire LLM bill, with no trade attached**.

**Therefore "trade less to save money" is refuted in advance, and this record refuses it before any
lever is graded.** Fewer trips do not lower the bill; they raise the amortized cost per trip.
`verdicts.md` already binds the same way: _"Do not propose cost work as a profitability lever."_

**What actually moves the ratio, stated as the identity so it cannot be argued around:**

```text
llm_bps_per_round_trip  =  llm_usd_per_day × 1e4 ÷ one_way_notional_usd_per_day
```

Only two quantities appear. **The numerator moves with the timing knobs** (cadence, wake-on-move,
output truncation). **The denominator moves with turnover per unit time — and turnover is turnover:
more entries and bigger entries move it identically.** There is no privileged route: raising Σ
notional by factor `k` divides the LLM term by `k` and multiplies the dollar gross loss by `k` on a
book realising **−69.9016 bps/trip**. Any lever claiming to improve the ratio without touching either
quantity is refuted by this identity before it ships.

**The scale of what turnover would have to do.** At the measured $2.5857/day of decide spend (three
full days), the turnover required to bring the LLM term to a given level:

| target LLM term | required one-way notional/day | vs the measured $259.41/day |
| --- | --- | --- |
| 70.44 bps (book-average) | $367.1 | 1.4x |
| 20 bps | $1,292.9 | 5.0x |
| **8.36 bps (the derived GROSS bar)** | **$3,093.0** | **11.9x** |

Measured time-weighted average gross exposure is **$204.44** against a $1,000 capped book
([`passive-benchmark-truth-2026-08-04.md`](passive-benchmark-truth-2026-08-04.md) § 4). **No knob in
this repository reaches 11.9x turnover inside a $1,000 book without multiplying the dollar loss by the
same factor.** The LLM term cannot be brought to the venue-cost bar by trading harder; it can only be
brought there by spending less or by more capital, and the capital is the one thing this program does
not control.

### 1.4 The direction of travel

The amortized term by trip-count snapshot, each a window-consistent read (numerator and denominator
describing the same window):

| trips | as-of | LLM cost | $/trip | bps/round trip |
| --- | --- | --- | --- | --- |
| 23 | 2026-07-27T15:49:13Z | 15.4759 | 0.6729 | 78.45 |
| 38 | 2026-07-31T17:30:34Z | 20.6730 | 0.5440 | 63.88 |
| 46 | 2026-08-02T16:00:36Z | 25.3853 | 0.5519 | 66.26 |
| 48 | 2026-08-03T14:20:24Z | 27.7936 | 0.5790 | 69.55 |
| 48 | 2026-08-03T16:07Z anchor | 28.1473 | 0.5864 | 70.44 |
| — | forward rate, 07-31→08-02 | — | — | **99.67** |

**The term bottomed at 38 trips and has risen every read since.** Any lever graded against the
book-average 70.44 will look better than it is; the forward figure is what the objective faces.

## 2. Burn targets, with dated checkpoints

### 2.1 The burn arithmetic, derived here rather than copied

From A1 and the epoch:

```text
gross (everything except inference) = netPnl + llmCost = −63.5326 + 28.7007 = −$34.8319
elapsed, epoch → A1 = 2026-07-21T11:21:00Z → 2026-08-03T22:02:24Z = 13.4454 days
```

| rate | arithmetic | value |
| --- | --- | --- |
| net-of-cost, **wall-clock since epoch** | 63.5326 ÷ 13.4454 | **−$4.7252/day** |
| net-of-cost, on the gate's own `windowDays` | 63.5326 ÷ 10.9688 | **−$5.7921/day** |
| gross only, wall-clock since epoch | 34.8319 ÷ 13.4454 | **−$2.5906/day** |
| LLM, epoch average | 28.7007 ÷ 13.4454 | **$2.1346/day** |
| LLM, **measured forward** (three full UTC days, A3) | (2.9707+2.4490+2.3373) ÷ 3 | **$2.5857/day** |
| **composed forward** = gross rate + measured LLM | 2.5906 + 2.6182 | **−$5.2088/day** |

Two notes that are not footnotes. **The two net-of-cost rates differ by 22.5% purely on
denominator** — `windowDays` is a fill-span, wall-clock is calendar time, and S3 is a cumulative
dollar level in calendar time, so **wall-clock is the correct forecasting denominator and
`windowDays` is the conservative one**. And **the composed rate uses the four-day LLM mean $2.6182**
(the three full days plus the 08-03 partial) rather than the three-day $2.5857, because the forward
question is what the lane spends per calendar day and the partial day is real spend.

### 2.2 S3 headroom against the adopted −$200 trigger

S3 fires when cumulative net-of-cost since the epoch reaches **−$200** (−20% of the $1,000 book) or
cumulative LLM spend reaches **$150**, whichever is first — adopted by the owner 2026-08-01 as
`Q2 = A` ([`success-exit-2026-07-31.md`](success-exit-2026-07-31.md) § 7, Amendment 1).

```text
headroom on the −$200 arm = 200 − 63.5326 = $136.4674   (as of A1, 2026-08-03T22:02:24Z)
```

| rate used | days to −$200 | date |
| --- | --- | --- |
| `windowDays` rate −$5.7921/day (conservative) | 23.56 | **2026-08-27** |
| **composed forward −$5.2088/day** | **26.20** | **2026-08-30** |
| wall-clock epoch average −$4.7252/day | 28.88 | **2026-09-01** |

**The S3 date is 2026-08-27 to 2026-09-01, and the § 8 decision window closes 2026-08-31 — inside
that band.** Which of the two fires first is inside the estimation error of the burn rate, and this
record refuses to state one as if it were known. The conservative rate reproduces the projection made
at adoption (~2026-08-27 at −$5.73/day), so nothing here contradicts the record; the composed forward
rate simply lands one day earlier than the window close instead of four.

**The interaction was already flagged at adoption and is now dated:** _"the budget stop lands before
§ 8's close… on current trajectory the program terminates on its own budget trigger rather than on a
written verdict."_ **A pass that sees S3 fire records it as a triggered criterion. It never quietly
extends the window — an extension without a named measurement is itself a stop trigger.**

### 2.3 The LLM arm of S3 does not bind

```text
headroom = 150 − 28.8563 = $121.1437     (LLM total measured here at 2026-08-03T22:40Z, A3:
                                          decide $23.844662 over 668 priced rows since epoch
                                          + llm_usage reflection $4.467794 + $0.543813)
```

| rate | days | date |
| --- | --- | --- |
| measured $2.6182/day | 46.27 | ~2026-09-19 |
| at the $3.00/day breaker ceiling | 40.38 | ~2026-09-13 |
| epoch average $2.1346/day | 56.75 | ~2026-09-29 |

**The −$200 arm binds first under every rate.** The $150 arm is not a live constraint inside the
decision window and no lever should be justified against it.

_The $28.8563 total reconciles to the last digit with the uncapped 22:17:36Z figure recorded in
[`book-truth-2026-08-04.md`](book-truth-2026-08-04.md) — $28.8562685 — which is an independent fold
of the same columns. **$4.467794 of it (15.5%) is `claude-opus-4-8` priced at the fail-closed
component-wise maximum because the operator never declared a rate for that model**, and every figure
here inherits that over-count._

### 2.4 The zero-LLM counterfactual — state it plainly so no reader mistakes cost work for a fix

**Gross alone is −$34.83.** Setting LLM spend to exactly zero, today:

```text
days to −$200 at the gross-only rate  =  136.4674 ÷ 2.5906  =  52.68 days  →  2026-09-25
```

**A perfectly free lane still fires S3, 25 days after the decision window has already required a
written verdict.** Eliminating 100% of inference spend postpones the budget stop by ~26 days and
changes no verdict, because the thing that is negative is the trading, not the billing. Every cost
lever in § 3 is a lever on the _rate of a loss_, never on its sign.

### 2.5 Dated checkpoints — pre-declared, so a later read cannot be graded against a moving target

Projected net-of-cost at the composed forward rate −$5.2088/day from A1:

| checkpoint | elapsed from A1 | projected net-of-cost | S3 status |
| --- | --- | --- | --- |
| **2026-08-11T12:00Z** | 7.58 d | **−$103.02** | 51.5% of the way to −$200 |
| **2026-08-18T12:00Z** | 14.58 d | **−$139.49** | 69.7% |
| **2026-08-25T12:00Z** | 21.58 d | **−$175.95** | 88.0% |
| **2026-08-31T12:00Z** (window close) | 27.58 d | **−$207.20** | **past the trigger** |

**The rule at each checkpoint, declared now:**

1. Read the book as ONE `evaluate()` sample and record its instant. Never assemble it from separate
   reads.
2. Compare measured net-of-cost against the row above. **Better than projection ⇒ re-derive the rate
   and restate the S3 date, showing the arithmetic. Worse ⇒ say so and restate the date, which will
   be nearer.** Both directions are reported; only reporting the favourable one is the failure this
   table exists to prevent.
3. **A checkpoint may not extend the window and may not adjust the −$200 trigger.** It re-derives a
   date; it never re-derives a criterion.
4. If a lever from § 3 was enabled since the previous checkpoint, its declared expected magnitude is
   compared against measurement **at the number declared in § 3**, not at a number chosen afterwards.

## 3. The levers — magnitude, expected-positive and named rollback defect, all declared BEFORE enable

**Standing rule for this family: no lever ships without a pre-declared magnitude.** A lever whose
magnitude cannot be derived is BLOCKED, not shipped-and-watched — because a lever with no declared
magnitude cannot fail, and a thing that cannot fail is not a measurement.

Each lever below carries a **failure direction**. All five are economics/measurement levers, none is
a permission or safety gate, so all fail OPEN — a lever that does not transmit is rolled back, never
left set in the hope that it did something.

### 3.1 L1 — `AGENTIC_OUTPUT_EFFORT`, the flag-off truncation lever

**Mechanism.** WATCH-V4-12: decide responses truncate at exactly `output_tokens = 4096`, the whole
output budget spent on reasoning that is then discarded. Priced Pass 59 at **$0.6148/day = 20.5% of
the $3.00 breaker, 30.2% of decide spend, ~11 symbol-decides/day, all paid and discarded, running
since 2026-07-23**. The lever `output_config: { effort }` is WIRED FLAG-OFF (`ea68379`);
`AGENTIC_OUTPUT_EFFORT` is an optional enum `low|medium|high|xhigh|max` with **no default**, so the
request is byte-identical until it is set (`environment.config.ts:285`,
`anthropic-agent-client.ts:2162`). Both alternatives stay refuted: `budget_tokens` 400s on sonnet-5,
and raising `AGENTIC_MAX_TOKENS` breaks the 75 s batch budget.

**Registered level: `medium`.** `low` is a larger behavioural step and risks starving the tool call
rather than the discarded reasoning; it is a SEPARATE enable with its own record if `medium` under-
delivers. **The enable is a separate commit plus the $0 offline review** the charter requires.

**Expected magnitude, with the arithmetic.** Baseline decide spend $2.5857/day (three full UTC days,
§ 1.2). Removing the priced-and-discarded fraction:

```text
2.5857 − 0.6148 = $1.9709/day              (−23.8% of the daily bill)
forward LLM term  99.67 × (1.9709 ÷ 2.5857) = 75.97 bps/round trip
forward ALL-IN    8.6718 − 0.3317 + 75.97  = 84.31 bps/round trip
composed burn     −5.2088 + 0.6148 = −$4.5940/day
S3 −$200          136.4674 ÷ 4.5940 = 29.71 days  →  2026-09-02
```

**So the single largest declared cost lever in the program buys about three days of S3 headroom and
moves the all-in bar from 108.01 to 84.31 bps against a realised gross of −69.90.** That is the whole
size of it, stated before it ships so nobody can grade it as a rescue.

**Expected-positive, over the first TWO FULL UTC days after the enable:**

- Zero rows whose `rationale` begins `truncated_max_tokens:` with `output_tokens = 4096` (baseline:
  42 such rows since 2026-07-31, ~11/day).
- Decide spend **≤ $2.20/day**, priced by the § 1.2 query.
- Schema-valid share and entry rate unchanged inside their declared bands.

**The entry-rate band, derived now.** The incumbent v10 lane runs **23 / 551 = 4.1743%** (FLAT-marker
candle rows, non-replay, measured here at 2026-08-03T22:44Z). Over the first **400** post-enable FLAT
rows (≈3 days at the measured 134.7 FLAT rows/day), the 99% binomial band is
`0.041743 ± 2.576 × sqrt(0.041743 × 0.958257 / 400) = 0.041743 ± 0.02576` ⇒ **[1.60%, 6.75%]**.

**Named defects, ANY of which triggers rollback:**

1. **A `schema_rejected:` degrade attributable to the effort cap.** Baseline since 2026-07-31: 27
   `schema_rejected: sizeFraction:` + 15 `schema_rejected: decisions:` rows. An increase means the cap
   is truncating the tool call rather than the discarded reasoning — the exact failure this lever
   exists to avoid.
2. **Decide latency p95 past the 75 s batch budget, or any `AGENTIC_TIMEOUT_MS=90000` abort.**
3. **Entry rate outside [1.60%, 6.75%] on the first 400 FLAT rows.** A cost lever that changes
   behaviour is a strategy change wearing a cost label, and it is not admissible as either.
4. **Decide spend does not fall by ≥ $0.40/day over two full UTC days ⇒ NO-OP rollback.** The lever
   did not transmit; an unexplained knob left set is a future reader's landmine.

**Exact diff for the orchestrator (`.env*` edits are hook-blocked to this agent):**

```text
# .env.app, § Strategy block, adjacent to AGENTIC_MAX_TOKENS=4096:
AGENTIC_OUTPUT_EFFORT=medium
```

### 3.2 L2 — `SIZER_EQUITY_FRACTION` 0.04 → 0.10, "turnover-neutral" sizing: **declared NULL, twice**

**This lever was proposed as the only one that moves the 70 bps LLM term. It moves nothing, for two
independent reasons, and both are measured rather than argued.**

**Refutation 1 — the knob is inert on this book.** `PositionSizerService.sizeEntry`
(`src/features/trading/risk/position-sizer.service.ts:343-356`) gives **strict priority** to
`signal.sizeFraction`: when the model supplies one, `equityFraction` is _"ignored entirely"_ — the
code's own words at `:311-312`. The agentic lane is the only lane and `sizeFraction` **is** its
conviction channel (`agentic.strategy.ts:954-956`). Measured here (A3):

| receipt | value |
| --- | --- |
| post-epoch entry intents (`order_intents`, `reduce_only=false`) | **67** |
| their notional `qty × ref_price` | min **$23.3916**, mean **$80.1306**, max **$137.3933** |
| `signals.strength` across all 574 post-epoch rows | **exactly 1.0000**, min = max |
| `cappedEquity` = min(equity 4966.77, `SIZER_EQUITY_CAP` 1000) | **$1,000** |
| what the equity-fraction path would produce | `1000 × 0.04 × 1.0000` = **exactly $40.00, every entry** |
| entries within ±$0.51 of $40.00 | **1 of 67** |

**66 of 67 entries could not have come from the equity-fraction path.** Changing 0.04 → 0.10 changes
`$40.00 → $100.00` on a path that sizes essentially nothing. **Declared expected magnitude: 0 bps,
$0/day, 0 entries affected.**

**Refutation 2 — turnover-neutral is invariant by identity.** From § 1.3,
`llm_bps = llm_usd_per_day × 1e4 ÷ one_way_notional_usd_per_day`. "Turnover-neutral" means holding
`one_way_notional_usd_per_day` constant. **Both operands are then unchanged, so the LLM term is
unchanged — exactly, not approximately.** Pairing a 2.5x size increase with a 2.5x lower daily entry
cap raises `$/trip` by 2.5x and `notional/trip` by 2.5x; the ratio is identical. **A turnover-neutral
resize cannot move a ratio whose denominator is turnover.**

**The turnover-RAISING version is REFUSED, with its arithmetic, so it cannot be proposed later as
though it were new.** At `k = 2.5` turnover with edge unchanged:

```text
LLM term        99.67 ÷ 2.5 = 39.87 bps/round trip          (the ratio improves)
gross burn      −2.5906 × 2.5 = −$6.4765/day                (the dollars get worse)
composed burn   −6.4765 − 2.6182 = −$9.0947/day
S3 −$200        136.4674 ÷ 9.0947 = 15.00 days  →  2026-08-18
```

**The lever that "fixes" the ratio fires the stop twelve days earlier.** Scaling a book realising
−69.9016 bps/trip scales the loss; the ratio improves because the denominator grew, not because
anything got cheaper.

**Named defect if it is enabled anyway:** any claim that the ratio improved must be accompanied by
the measured `one_way_notional_usd_per_day` on both sides. **If Σ notional/day is unchanged, the
ratio cannot have moved and the claim is refuted by identity, whatever the reported number says.**

**Exact diff: NONE. This record authorises no change to `SIZER_EQUITY_FRACTION`.**

### 3.3 L3 — spot-menu eligibility: **BLOCKED, magnitude UNDERIVABLE from the current record**

**Mechanism.** `VENUE_FLOOR = 2` (`src/features/strategy/agentic/universe-scanner.service.ts:49`, a
fixed constant, deliberately not a knob) reserves at least two of the eight
`AGENTIC_ACTIVE_MENU_SIZE` slots for the spot venue after ranking, hysteresis and pinning.

**The spot evidence, with denominators:** 0 entries over 232 v10 FLAT consults (P(0) ≈ 3.8e-4 against
the perp rate); **14 lifetime entries over 392 spot FLAT consults = 3.5714%**, all `open_long`, zero
`open_short` ever; last spot entry **2026-07-30T10:15:00Z**; **7 closed spot round trips, gross
realised −$8.9557, net of fees −$9.8632**
([`entry-rate-denominator-2026-08-03.md`](entry-rate-denominator-2026-08-03.md) § 6).

**Why the cost framing is declared dead on arrival.** The menu size is FIXED at 8. Slots freed by
spot are **refilled by perp symbols**, so the per-consult payload does not shrink — only its
composition changes. Even the upper bound is small: of the $23.76 sonnet decide spend, the
per-symbol payload rides in the input class ($12.96, 54.5%); the cache-read and cache-write classes
are the shared system prompt and playbook and do not shrink at all. **Declared expected cost
magnitude: ≈ $0/day.** `verdicts.md` and backlog 58 already require this lever be justified on
**expectancy**, never on cost, and this record enforces that.

**Why the expectancy framing has no derivable magnitude today.** The lever's real effect is that two
slots move from a venue that has not entered in four days to perp symbols. Whether that helps depends
on the per-symbol expectancy of the symbols that would receive the slots — and **16 of the 28 base
assets have never traded at all**, so for them there is no evidence of any kind. The book has 12
traded base assets and 48–49 closed trips; a per-symbol expectancy read on that population is
cluster-degenerate before it starts.

**So this lever is BLOCKED, and the exact measurement that would unblock it is registered here:**
realised gross bps/round trip **per base asset**, with per-asset trip counts and the cluster floors
`MIN_OBS = 12` / `MIN_CLUSTERS = 5` applied, over the closed-cycle population — reported with every
cell that fails the floors labelled UNDERPOWERED and its point estimate never quoted separated from
that label. **Until that read exists, no spot re-scope ships**, and a re-scope shipped without it is
an unregistered change.

**Two named defects to carry into any future enable:**

1. **The spot zero is confounded with v10.** `inverted` shipped 2026-07-30T16:57Z with no control
   arm, and the spot silence begins the same day. A permanent structural change baked on a
   v10-conditional observation is a playbook change wearing a universe change's clothes. **Any spot
   re-scope must be reversible and re-examined on every playbook change.**
2. **The venue floor is also the promotion evidence base's cross-venue coverage.** Removing spot makes
   the book single-venue; the passive benchmark is equal-weight over **28 distinct base assets** and
   the promotion verdict is one book. That is a change to what the gate's evidence covers, not just to
   where orders go.

**Exact diff: NONE authorised.** For a future step, note that there is **no env-only path**: the
venue floor is a source constant, and surgery on `TRADING_SYMBOLS` alone will refuse boot —
`environment.config.ts` requires `VENUES` to exactly cover the venues implied by `TRADING_SYMBOLS`,
and `VENUE_CAPITAL_SPLIT` keys to exactly equal `VENUES` ids. Config refusal at construction is
working as designed here; do not route around it.

### 3.4 L4 — `AGENTIC_WAKE_MOVE_PCT` 0.008 → 0.012

**Mechanism.** `evaluateConsultSchedule` (`agentic.strategy.ts:348-355`) returns `forced_move` when
`|lastClose − lastConsultPrice| / lastConsultPrice >= wakeMovePct`, forcing an immediate re-consult
regardless of schedule.

**Measured here (A3, `promtool` against `agentic_consult_gate_total`, 2026-08-03T22:42Z) — and this
is the finding, not the lever:**

| window | `consulted` | `forced_fallback` | `forced_move` | `forced_rearm` | consult-triggering total | forced_move share |
| --- | --- | --- | --- | --- | --- | --- |
| 24h | 35.01 | 29.00 | **94.02** | 5.00 | 163.03 | **57.7%** |
| 3d | 143.01 | 54.00 | **263.01** | 21.00 | 481.02 | **54.7%** |

**Wake-on-move is the dominant consult trigger — it produces more consults than the schedule, the
fallback and the re-arm combined.** No record in this program states that.

**Expected magnitude, with the arithmetic and its declared imprecision.** Single-bar move
distribution over **11,680 distinct symbol-bars** carrying a `close`, ~3.07 days to 22:42Z: **284
bars (2.432%) moved ≥ 0.8%**, **97 bars (0.830%) moved ≥ 1.2%** ⇒ raising the threshold removes
**65.8%** of single-bar qualifying moves. **The realised reduction is SMALLER than that**, because
the gate compares against `lastConsultPrice`, not the previous bar, so a symbol that fails the 1.2%
test on one bar can still accumulate to it across several. **Declared band: 30–66% of `forced_move`
triggers removed.**

```text
fan-out           163.03 trigger events ÷ 72 priced calls (2026-08-03) = 2.26 events per API call
cost per call     $0.035484  (mean token-bearing decide row, llm-cost-attribution § 4.3)
events removed    30%–66% of 94/day = 28.2–62.1 events/day
calls removed     ÷ 2.26 = 12.5–27.5 calls/day
upper arithmetic  × $0.035484 = $0.44–$0.97/day
```

**Declared expected magnitude: $0.15–$0.60/day**, deliberately BELOW the arithmetic band, because
batching means a batch still fires if any member triggers — the marginal symbol costs its payload
block, not a whole call. The $0.97/day upper bound is printed so an over-delivery is as falsifiable
as an under-delivery.

**Expected-positive, over the first TWO FULL UTC days:**

- `increase(agentic_consult_gate_total{outcome="forced_move"}[24h])` falls by **≥ 30%** against the
  94/day baseline.
- Decide spend falls by **≥ $0.15/day**.
- **Σ one-way notional/day falls by a SMALLER fraction than decide spend.** This is the only clause
  that makes the lever an economic improvement rather than merely less trading, and it follows
  directly from the § 1.3 identity.

**Named defects ⇒ rollback:**

1. **Σ one-way notional/day falls at least as fast as spend** ⇒ the forward LLM term does not improve
   ⇒ the lever bought less trading, not cheaper trading. **This is the defect most likely to occur**
   and it is the one the § 1.3 refutation predicts.
2. **`forced_fallback` rises to absorb the removed wakes** — the 8-bar `AGENTIC_FALLBACK_CONSULT_BARS`
   floor simply fires instead — so spend does not fall ⇒ NO-OP rollback.
3. **Not measurable, therefore not claimable:** an entry the lane would have taken on a 0.9% move that
   it now misses. There is no counterfactual instrument for it. **No write-up of this lever may claim
   the missed entries were good or bad**; the absence of the measurement is recorded rather than
   argued around.

**Exact diff for the orchestrator:**

```text
# .env.app:
- AGENTIC_WAKE_MOVE_PCT=0.008
+ AGENTIC_WAKE_MOVE_PCT=0.012
```

### 3.5 L5 — the perp fee-truth flip: **declared NULL, and measured**

**Mechanism.** `VENUE_FEE_SCHEDULES` (`src/domain/trading/fees.ts:42-45`) carries the **SPOT**
schedule `{makerBps:'10', takerBps:'10'}` for the perp venue, deliberately, with its own comment
naming the flip to `{makerBps:'2', takerBps:'5'}` as a separate enable. The table has exactly two
consumers:

1. **The take-profit floor gate** — `anthropic-agent-client.ts:1805-1833` rejects any directive set
   whose `takeProfitPct` is below `roundTripFeeFraction(venueForSymbol(symbol))`.
2. **The static `AgentTradingProfile`** rendered into the system prompt —
   `agentic-bridge.module.ts:616-631`, built from **`config.strategy.symbols[0]`**, which is
   `BTC/USDT`, a **SPOT** symbol.

**Measured expected magnitude: ZERO, on both consumers.**

- **The gate has never fired.** Measured here (A3):
  `count(*) from agent_decisions where rationale like '%rejected: tp below fee floor%'` = **0 rows,
  all time, all strategies, all modes**. A gate that has never bound cannot be loosened into an
  effect.
- **The prompt never reads the perp row.** The static profile keys off `symbols[0]` = spot, so
  flipping the perp entry leaves the rendered profile byte-identical.

**Declared magnitude: 0 entries admitted, $0/day, 0 bps. Any post-enable improvement attributed to
this flip is refuted in advance.**

**The real finding underneath it, registered so it is not lost.** The model is told its round trip
costs **20 bps** on a book that is **88.65% perp at a measured 7.2208 bps/round trip** — a 2.8x
overstatement of its own cost on the dominant venue, on a lane whose defining behaviour is that it
holds. **That is a plausible suppression channel and this record neither confirms nor dismisses it.**
Fixing it requires making the rendered profile per-symbol or per-venue — a change in the prompt path,
not a table row — and that is a **separate, unregistered lever with no magnitude**. It does not ship
on this record.

**And a bar-side refusal, declared before any such change:** the take-profit floor may never be set
**below the derived GROSS bar of +8.3619 bps/round trip (CI95 [6.2010, 10.7616], n=48, 12 clusters)**.
Setting the perp floor to the venue's own 7 bps would admit trades whose entire best case sits below
the lower CI bound of the cost they must clear, and ~100 bps below the forward all-in bar. **If the
floor moves at all it moves UP toward the derived bar, never down to the schedule.**

**Exact diff: NONE authorised.**

## 4. The corrected bars bind NEW families only — forward-only supersession

**No completed study, verdict, scorecard, WATCH or registry row is re-scored against anything in this
record.** The +8.36 gross bar, the +78.80 book-average all-in bar and the +108.01 forward all-in bar
apply **only to families registered on or after 2026-08-04**.

Three reasons, each independently sufficient:

- **Re-scoring a completed study against a bar derived after it is retro-fitting**, and it is
  retro-fitting in whichever direction the person doing it prefers. That is precisely what this
  program's preregistration discipline forbids.
- **The all-in bar is not a constant.** It is a function of trade rate and notional (§ 1.2): 78.80 at
  the book's average, 108.01 on the last three days. It cannot be pasted into code as a threshold the
  way +13.0 was, and a study scored against "the all-in bar" without its denominator is scoring
  against a number that does not exist.
- **The gross bar moved by only ~1 bps in the conservative direction** (13.0 → 8.36), so re-scoring
  would change no completed verdict's sign while manufacturing an appearance of revision.

**`REQUIRED_EDGE_BPS = 13.0` is NOT changed by this record.** Its three homes —
`test/eval/agentic/playbook-space-replay.ts:47-48`, `test/backtest/inversion-test.mjs:27`,
`scripts/loop-authoring-core.mjs:519-524` — stay as they are. It is a pre-registered bar inside live
studies; lowering a bar after seeing results is the thing the discipline exists to prevent, and the
current value errs conservative on the gross question. **Any change is a new dated pre-registration,
never an unattended edit.**

## 5. The refusal list — written down so a later pass cannot discover it as an option

1. **Never raise `SIZER_EQUITY_CAP` above 1000.** It is the live-capital mirror: production capital
   is ~$1k, and the demo book exists to run at the size live money would.
2. **Never raise the `AGENTIC_DAILY_COST_STOP_USD=$3/day` breaker.** The charter is explicit —
   breaker exhaustion mid-day is economized via prompt or cadence, never by raising the breaker.
3. **No decide-model swap outside the $0 offline harness** (`test/eval/agentic/candidate-model-eval.spec.ts`),
   never a blind flip. Note the charter's `$0` means zero live-trading risk, not zero API spend: that
   harness costs one real API call per replayed row.
4. **Do not move `PROMOTION_EVIDENCE_EPOCH`.** Re-stamping it reintroduces the epoch-straddle
   uncertainty that is currently **exactly zero** (measured: no fill predates the epoch) and resets an
   evidence clock the § 8 window depends on.
5. **Do not touch the promotion gate, the four live gates, the bootId arming ceremony, or
   `MIN_WINDOW_DAYS`.** `PromotionReadinessService` is named in the KEPT set of the 2026-07-22
   gate-override grant and sits outside autonomy grant 6. The `MIN_WINDOW_DAYS` 14→10
   pre-authorization requires net-of-cost > 0, which is false, so it is UNFIRED and stays unfired.
6. **No maker-economics conclusion from demo fills without the live-frame check.** The demo/live
   decoupling artifact measures **+21.0 bps/trip** and is **concentrated in maker fills (+121.3, n=8)
   against taker (−5.8, n=30)** — a maker conclusion drawn from demo fills is measuring the artifact.
7. **Never re-declare a band, a baseline or a threshold after seeing what trips it.** Amendments are
   dated and appended; bodies are never edited.

### The clause that binds against the person writing it

**Cutting spend purely to postpone the S3 stop, while gross stays negative, is gerrymandering the
stop.** The arithmetic makes the temptation concrete: L1 buys ~3 days, L4 buys ~1–3 days, and a
perfectly free lane still fires S3 on 2026-09-25 (§ 2.4). It is possible to spend this entire window
buying stop-headroom and end it having learned nothing about whether the book can trade.

**So: every cost lever in § 3 is justified on per-trip economics — does it lower LLM dollars per unit
of turnover, at unchanged behaviour? — or it is not justified at all.** "It postpones S3" is not a
justification and is refused as one here, in advance.

**And if the burn still trends to −$200, S3 firing is the criteria working.** It is a triggered
criterion, recorded as such, not a failure to be engineered around. A pass that sees it fire writes
the verdict; it does not go looking for another $0.60/day.

## What this record cannot answer

- **It measures cost and burn, never edge.** Nothing here says whether the entries have signal, and
  nothing here rescues or damages the ENTRIES / NO_SURVIVOR verdicts. The single largest fact in it —
  gross is −$34.83 with zero inference — is a statement about trading that this record does not
  explain.
- **The A1 tuple is SUPPLIED, not recomputed.** It is one `evaluate()` sample at 2026-08-03T22:02:24Z.
  A sample taken inside the funding poller's ~37-minute ingest lag reads **less negative than settled
  truth** (`book-truth-2026-08-04.md` § 1), so the burn rates here are, in that one axis, marginally
  flattering.
- **The forward rates are three- and four-day windows, and they are rates, not forecasts.** They
  improve automatically if PnL improves. Every S3 date in § 2 inherits that and none of them is a
  prediction.
- **L3's magnitude is UNDERIVABLE today and the lever is BLOCKED, not deferred.** § 3.3 names the
  exact measurement; this record does not perform it.
- **The L4 counterfactual is a single-bar proxy for an accumulating gate.** The 65.8% figure is an
  upper bound on the reduction, and the declared 30–66% band is a judgement about accumulation that
  this record does not measure.
- **The consult-gate counters are per symbol-bar, not per API call.** The 2.26 fan-out is measured on
  one day against one day's priced-call count; it is not a stable constant and the § 3.4 dollar band
  inherits that.
- **$4.467794 of the LLM spend (15.5%) is priced at a rate the operator never declared** for
  `claude-opus-4-8`. Every cost figure here inherits that fail-closed over-count.
- **No lever in § 3 has a control arm, and the lane already carries an uncontrolled live change** (v10
  `inverted` plus `AGENTIC_PLAN_AUTHORITATIVE_EXITS`, same boot, 2026-07-30). **Nothing measured after
  an enable can be attributed to that enable alone**, which is why every lever above is graded on a
  mechanical quantity — spend, trigger counts, truncation rows — and never on PnL.
- **One book, one 10.85–13.4 day window, one regime, 12 traded base assets, all demo.** No figure here
  is out-of-sample and none of it is evidence about live capital.

## Amendment 2026-08-04 — L1's "$0 offline review" precondition replaced, with the reasons, before the enable

_Dated and appended before the enable commit it governs. The frozen body above is untouched._

§ 3.1 bound the L1 enable to "a separate commit plus the $0 offline review the charter requires."
That clause cannot survive contact with what it is reviewing, and it is replaced — not waived — by
the live watch already registered in § 3.1, on four grounds:

1. **A $0 offline review of this lever is structurally vacuous.** `output_config.effort` is an API
   _request parameter_. Both $0 harnesses — the fixture-`fetchFn` replay (`pnpm eval:agentic`) and
   the session-based OOS decide leg — never emit an API request, so the parameter has no effect in
   either. A $0 review would pass while measuring nothing, which is worse than no review: it would
   stamp the enable with an approval that contains no information. The charter clause this inherited
   ("decide-model changes ONLY via the $0 offline harness") was written for _model identity_
   changes, which the $0 harnesses can measure; a request param is outside its mechanism.
2. **The paid variant is self-defeating on the enable day.** A real measurement needs ~100 rows × 2
   arms against the live API (≈ $2, ~3 days of the lever's own declared saving) — and per the B2
   breaker accounting (`llmSpendTotalsAllSources` counts replay rows), the enable-day boot re-seed
   would then latch the $3/day breaker and starve the live lane for the rest of the UTC day.
3. **The live watch became the stronger instrument after the clause was written.** The
   `+eff-<level>` promptHash tag (shipped 70a2939, after § 3.1's registration) cleanly partitions
   post-enable rows, every § 3.1 rollback trigger is journal-measurable, and rollback restores
   byte-identical requests by construction. An offline A/B would measure the same model on the same
   rows _without_ the batch context, i.e. a weaker external-validity signal than the watch.
4. **Owner instruction 2026-08-04** directed placement of both surviving levers this pass.

Also recorded here so no later reader trips on them: the original task-form of L4 carried a
"forced-wake dominance ≥ 60%" precondition; the measured shares are **57.7% (24h) / 54.7% (3d)**,
and § 3.4 deliberately superseded the round-number threshold with the priced band
($0.44–$0.97/day arithmetic, $0.15–$0.60/day declared) — dominance is established by "more than
schedule + fallback + re-arm combined", not by clearing 60.000%. And the two levers land in ONE
pass on owner instruction; the 2026-07-17 "never two money-path items per pass" rule is not
touched — both knobs are LLM cadence/cost levers, neither alters the Strategy → Risk → Execution
money path.

## Checkpoint #1 — recorded 2026-08-10T08:52:03Z, 27h08m EARLY against the 2026-08-11T12:00Z row

_Appended under § 2.5. The frozen body above is untouched. This checkpoint extends nothing and
adjusts nothing (§ 2.5 rule 3); it re-derives a date._

**Why early.** The pass that carries this checkpoint ran on 08-10. The § 2.5 line is a pure function
of elapsed time from A1, declared before any result was seen, so evaluating it at this read's instant
is not moving a target — it is reading the same line at a different `x`. The 08-11T12:00Z row is
restated below as well, and the loop re-reads it on time.

**Tuple B — ONE `PromotionReadinessService.evaluate()` sample, 2026-08-10T08:52:03Z** (never
assembled from separate reads, § 2.5 rule 1):

```text
windowDays=17.50014773148148  roundTrips=80  netPnlUsd=−81.2138271444
llmCostUsd=40.0934201         winRate=0.275  ready=false
reasons=[NON_POSITIVE_NET_PNL, BELOW_PASSIVE_BENCHMARK]
```

**`INSUFFICIENT_WINDOW` has cleared** (17.50 > 14 days) — and the gate still does not open, exactly
as § 2 predicted: `NON_POSITIVE_NET_PNL` was never touched by the window.

### The comparison, in both directions (§ 2.5 rule 2)

```text
elapsed A1 → B          = 2026-08-03T22:02:24Z → 2026-08-10T08:52:03Z = 6.4511458 d
projected at −$5.2088/d = −63.5326 − 5.2088 × 6.4511458 = −$97.1352
measured                =                                 −$81.2138
```

**BETTER than projection by $15.92 (16.4%).** Carried to the declared 08-11T12:00Z row at the
measured forward rate below, the book lands ≈ **−$83.7** against the declared **−$103.02** — ahead by
≈ $19.3. Reported in the favourable direction here because that is the direction it went; the rule
exists to force the unfavourable one, and it binds identically.

### Re-derived rates, each with its denominator named

```text
gross = net + llm = −81.2138271444 + 40.0934201 = −$41.1204070444
wall-clock since epoch (2026-07-21T11:21:00Z → B) = 19.8965625 d
forward window  (P65 tuple 2026-08-06T16:33:53Z → B), wall-clock = 3.6792824 d
  Δnet = −$8.4760287500   Δllm = +$6.8995314   Δgross = −$1.5764973500   Δtrips = 19
```

| rate | arithmetic | value |
| --- | --- | --- |
| net-of-cost, wall-clock since epoch | 81.2138271444 ÷ 19.8965625 | **−$4.0818/day** |
| net-of-cost, on the gate's own `windowDays` (conservative) | 81.2138271444 ÷ 17.50014773 | **−$4.6407/day** |
| gross only, wall-clock since epoch | 41.1204070444 ÷ 19.8965625 | **−$2.0667/day** |
| LLM, epoch average | 40.0934201 ÷ 19.8965625 | **$2.0151/day** |
| **net-of-cost, forward window** | 8.4760287500 ÷ 3.6792824 | **−$2.3037/day** |
| LLM, forward window | 6.8995314 ÷ 3.6792824 | **$1.8752/day** |
| gross only, forward window | 1.5764973500 ÷ 3.6792824 | **−$0.4285/day** |

### Restated S3 date — and it has moved past the window close

```text
headroom on the −$200 arm = 200 − 81.2138271444 = $118.7861728556
```

| rate used | days to −$200 | date |
| --- | --- | --- |
| forward window −$2.3037/day | 51.56 | **2026-09-30** |
| wall-clock epoch average −$4.0818/day | 29.10 | **2026-09-08** |
| gate `windowDays` −$4.6407/day (conservative) | 25.60 | **2026-09-04** |
| the pre-declared composed −$5.2088/day | 22.81 | **2026-09-02** |

**§ 2.2 declared the band 2026-08-27 → 2026-09-01, straddling the 2026-08-31 close. Every restated
rate now lands AFTER the close; the earliest is 2026-09-04.** The window still closes 2026-08-31 and
the −$200 trigger is still −$200 — what changed is which mechanism is expected to fire first. **The
program should now be expected to end on the written verdict, not on a triggered S3.** That flips
§ 2.2's flagged interaction ("on current trajectory the program terminates on its own budget trigger
rather than on a written verdict") and the flip is recorded here rather than discovered at the close.

The LLM arm remains slack: headroom `150 − 40.0934201 = $109.9066`; at the forward $1.8752/day that
is 58.6 days (~2026-10-08). **The −$200 arm still binds first; the $150 arm is still not a live
constraint** (§ 2.3 unchanged).

### Where the improvement came from — and every reason not to bank it

```text
forward-window gross per round trip = −1.5764973500 ÷ 19 = −$0.0830/trip
book-average realised (P65 tuple)   = −39.5439096944 ÷ 61 = −$0.6483/trip
hit rate on the 19 forward trips    = (0.275×80 − 0.2622950820×61) ÷ 19 = 6 ÷ 19 = 31.58%
```

**Gross per trip improved ~87% in dollar terms, and the hit rate rose to 31.58% from 24.49% (A1) and
26.23% (P65). It is still below the derived gross break-even of 41.65%**, and four things must travel
with those numbers or they will be misread:

1. **n = 19, one window, clusters unread.** The powered bar is n≥12 AND clusters≥5 on base assets;
   n clears and clusters were not computed. **This is not a POWERED result and may not be quoted as
   one.**
2. **The bps form is an estimate, not a measurement.** Converting −$0.0830/trip needs a Σ one-way
   notional this read does not carry. At the stale $83.2531 book-average one-way notional it is
   ≈ **−10.0 bps/trip** against the recorded −69.9016 — a denominator from a different window, and
   labelled an estimate wherever it appears.
3. **Nothing in the configuration changed during this window.** The container has run `5deaac5`
   since 2026-08-06T17:39:41Z with RestartCount 0; no deploy, no lever, no env edit — the _loop_ was
   dark, the _app_ was not. So the improvement carries **no lever confound and full regime
   confound**, and the parsimonious reading is a different market window, not a different strategy.
4. **The forward-return instrument agrees with the regime reading, not with a skill reading** —
   v10's adverse edge weakened toward zero as its population grew (below), which is what a
   small-sample artifact does when it accrues.

**Nothing here rescues or damages the ENTRIES verdict**, and nothing here is admissible against the
promotion gate: `ready=false` on `NON_POSITIVE_NET_PNL` and `BELOW_PASSIVE_BENCHMARK`, and a
31.58% hit rate on 19 trips does not reach a 41.65% break-even, let alone the 57.8% all-in figure.

### Forward-return recomputation — the adverse-POWERED reading did NOT survive population growth

Fresh `pnpm loop:forward-return`, 2026-08-10T08:53Z, playbook v10 (inverted), population
`flat_only` (byte-identical to `all` at 55/55 and 54/54, as in both earlier sweep digests):

| horizon | power | mean | n / clusters | 95% CI | vs replay |
| --- | --- | --- | --- | --- | --- |
| h=1 | POWERED | −7.6 bps | 55 / 10 | [−19.5, +6.9] | −0.8 — consistent |
| h=4 | POWERED | −9.3 bps | 55 / 10 | [−32.1, +15.7] | +0.8 — consistent |
| h=8 | POWERED | −20.8 bps | 54 / 10 | [−45.1, +3.9] | +19.3 — **DIVERGENCE** |
| h=24 | POWERED | −15.5 bps | 54 / 10 | [−44.6, +29.2] | +47.6 — **DIVERGENCE** |

**Every interval includes zero.** The 2026-08-04 amendment recorded v10 EXCLUDING zero at h=4 and
h=8 (−45.3 [−122.0, −0.3] and −52.8 [−134.9, −1.5]) on n=21. On n=55 — 2.6× the population — the
point estimates moved to −9.3 and −20.8 and both intervals now straddle zero. **The adverse-POWERED
signature that would have justified minting away from v10 has not survived accrual. It was a
small-population reading.** The honest statement is that v10's forward edge is **indistinguishable
from zero**, not that it is good: the point estimate is negative at all four horizons.

**WATCH-PLAYBOOK-V10-1 tier 2's "excludes zero at h=4/h=8" is SUPERSEDED by this read and must not
be re-quoted from the amendment.** The n=21/k=8 vs n=26/k=9 discrepancy the record never reconciled
is **accrual, not filters**; the authoritative cut is each pass's own fresh recomputation as of its
own instant, and no earlier cut is re-quotable.

**The replay divergence is unchanged and still fires** at h=8 and h=24, both intervals excluding the
replay prediction. Replay continues to predict a positive edge the live lane does not realise.

**Consequence for the event-driven mint gate shipped this pass:** it permits a mint only on
`powered ∧ ciHi < 0` in `flat_only` at h=4 or h=8. Here `ciHi` is **+15.7** and **+3.9**. **The
trigger does not fire, and minting nothing today is the trigger working.**

## L1 and L4 adjudicated — 2026-08-10 (Pass 66), six days late, on a re-based window

_Appended under § 3.1 and § 3.4. Frozen bodies untouched. Both levers went live in one instant,
**2026-08-04T08:00:23Z**, confirmed to the second by the prompt-hash partition switching to
`aefafb3c…` at `2026-08-04T08:00:23.693878Z`._

### The registered two-day window is unusable, and it is re-based rather than waived

§ 3.1 and § 3.4 both read "the first TWO FULL UTC days after the enable" — **2026-08-05 and
2026-08-06. Both days are corrupted by the Pass-65 feed wedge**: `agent_decisions` rows land at
**2920** and **2560** against **3840** on an intact day (76.0% and 66.7%). A spend read across a
lane that was dead for a quarter to a third of the day measures the outage, not the lever.

**Re-based window, declared here before the numbers below are read against it:** the three CLEAN
post-enable UTC days **2026-08-07, 08-08, 08-09**, each carrying the full 3840 rows. The pre-enable
baseline is unchanged from § 1.2 — the three full days **2026-07-31 → 08-02**. This substitutes a
window, not a threshold; every declared magnitude and every named defect is graded at the number
§ 3 declared.

**One basis note that must travel with the notional figures.** § 1.2's Σ one-way notional keys on
the fill's own time; the reads below key on `fills.ingested_at`, which differs for 2026-07-31
($459.7588 here vs $300.7782 there). **Both sides of every comparison below use the `ingested_at`
basis**, so the comparison is internally consistent and is **not** mixable with § 1.2's figures.

### The measurements

| quantity | pre-enable (07-31→08-02) | post-enable clean (08-07→08-09) | change |
| --- | --- | --- | --- |
| decide spend | **$2.5857/day** | **$1.9013/day** | **−26.5%** (−$0.6844/day) |
| priced decide rows | 169.33/day | 107.67/day | **−36.4%** |
| Σ one-way notional | $312.4066/day | $316.9294/day | **+1.45%** |
| **cost per priced decide** | $0.015271 | **$0.017659** | **+15.6%** |
| **LLM term** (`spend × 1e4 ÷ notional`) | **82.77 bps/trip** | **59.99 bps/trip** | **−27.5%** |

### L4 — `AGENTIC_WAKE_MOVE_PCT` 0.008 → 0.012: **all three clauses MET, no rollback**

1. **`forced_move` falls ≥ 30%** — 105 events over the 3.6335 days since boot `815e01b8` =
   **28.9/day** against the 94/day baseline: **−69.3%. MET.** (Since-boot counter, post-enable only;
   there is no within-boot before/after and none is claimed.)
2. **Decide spend falls ≥ $0.15/day** — **−$0.6844/day. MET, and it OVER-delivers**, landing above
   the declared $0.15–$0.60/day band. Recorded as an over-delivery because § 3.4 printed its upper
   bound precisely so that over-delivery would be as falsifiable as under-delivery.
3. **Σ one-way notional falls by a SMALLER fraction than spend** — spend **−26.5%**, notional
   **+1.45%** (it rose). **MET decisively.**

**Named defect 1 — the one § 3.4 called most likely ("the lever bought less trading, not cheaper
trading") — does NOT fire.** **Named defect 2 does NOT fire**: `forced_fallback` is 27 over 3.6335
days = **7.4/day** against the 29/day baseline, so the fallback did not rise to absorb the removed
wakes; it fell too. **Named defect 3 stays unmeasurable and nothing is claimed about missed entries.**

**This is the first lever in this program to move the § 1.3 identity in the right direction for the
right reason: spend fell while turnover did not.** On these denominators the all-in bar reads
`8.6718 − 0.3317 + 59.99 = 68.33 bps/round trip`, against 78.80 book-average and 108.01 forward.
**It is still a lever on the rate of a loss, never on its sign** (§ 2.4 unchanged), and gross must
cross zero before any of it matters.

### L1 — `AGENTIC_OUTPUT_EFFORT=medium`: **primary FALSIFIED; the cost clause passes only through a confound**

- **Registered expected-positive #1 — zero `truncated_max_tokens:` rows at `output_tokens = 4096`
  over the registered days — FALSIFIED** (4 on 08-05, 3 on 08-06). On the re-based clean window the
  4096-pinned rate is 7/323 = **2.17%** of priced decides against 17/508 = **3.35%** pre — a ~35%
  relative fall on 17 vs 7 rows, **not distinguishable from noise and not the registered zero**.
  Full cross-tab, and the separate falsification of this watch's "all pinned at exactly 4096"
  invariant: `research/loop/watches.md` § WATCH-V4-12, amendment 2026-08-10.
- **Expected-positive #2 — decide spend ≤ $2.20/day — MET** ($1.9013). **But it is not L1's.**
  Spend fell because the lane made **36.4% fewer priced calls**, which is L4's mechanism; **cost per
  decide ROSE 15.6%**. A lever that was supposed to make each call cheaper is sitting on a window
  where each call got dearer.
- **Named defect 1 (a `schema_rejected:` rise attributable to the cap) does NOT fire** — 18/day pre
  (07-31→08-02) against **7.67/day** on the clean window.
- **Named defect 2 (latency past the 75 s batch budget, or a 90 s abort) does NOT fire** — p95
  **30,556 ms** post (n=567) vs **29,009 ms** pre (n=841), max 67,251 ms, **zero rows ≥ 75 s, zero
  ≥ 90 s**.
- **Named defect 3 (entry rate outside [1.60%, 6.75%]) — read on a PROXY denominator and does not
  fire on it.** The registered denominator is FLAT-marker candle rows; `input_payload` is empty on
  the current rows, so the marker was **not reconstructible this pass**. Proxy: entries per candle
  row, **34/26722 = 0.1272%** over the 7 days before the enable against **28/20951 = 0.1337%**
  after — a +5.1% relative change, which lands the registered rate near 4.39% against a 4.1743%
  baseline, well inside the band **if** the FLAT fraction of candle rows is stable across the two
  windows. That "if" is untested. **This is a proxy reading and is labelled one.**
- **Named defect 4 (spend does not fall ≥ $0.40/day ⇒ NO-OP rollback) does not fire on its literal
  test** — and passing it is **not** evidence that L1 transmitted, because the fall is attributable
  to L4.

**Decision: L1 is NOT unset today, and the reason is not optimism.** Its own mechanism is falsified;
what remains unanswerable from these columns is whether `effort` reaches the model at all, because a
request-parameter effect and a payload-size effect produce an identical row — and the payload grew
independently when the liquidation and perp trade-flow channels went live on 2026-08-04, which is an
equally good explanation for the +15.6% per-decide cost and the +5.3% p95. **`stop_reason` is
journalled from this pass** (`agent_decisions.stop_reason`, migration `0003`) and separates them.
**Registered read: the `max_tokens` share of `stop_reason` on the `+eff-medium` prompt-hash
partition over 7 days of post-deploy rows. Unchanged-or-higher ⇒ `effort` is not transmitting ⇒
unset `AGENTIC_OUTPUT_EFFORT`. Deadline 2026-08-17. The default outcome on a silent, empty or
unreadable instrument is the unset, not the status quo.**

### L6 — the fee-truth PROMPT path: registered 2026-08-10 BEFORE its enable, magnitude declared ZERO and DERIVED

_§ 3.5 declared L5 (the table row flip) NULL and measured, and explicitly deferred the prompt-path
change: "a separate, unregistered lever with no magnitude. It does not ship on this record." This
registers it. Written and committed **before** the enable commit, per § 3's standing rule and
`rules` rail 4. § 3's rule that a lever with no derivable magnitude is BLOCKED is satisfied here
the way § 3.2 and § 3.5 satisfied it: the magnitude **is** derivable, and it is **zero**._

**Mechanism.** The model is told its round trip costs **20 bps** (the SPOT schedule `10/10`) on a
book that is **88.65% perp at a measured 7.2208 bps** — a 2.8× overstatement of its own cost. The
table row is one half; the other half is that `agentTradingProfileFor` builds the rendered profile
from `config.strategy.symbols[0]` = `BTC/USDT`, a SPOT symbol, **so the prompt never reads the perp
row at all**. L6 flips the perp schedule to `{makerBps:'2', takerBps:'5'}` (the file's own
pre-registered round-up of the measured 4.5216), renders **both** venues' schedules, floors the
take-profit gate at `max(roundTripFeeFraction(venue), +8.3619 bps)`, and rewrites the
20-bps-derived "sub-0.6% targets" sentence.

**Measured here, 2026-08-10T09:12Z — and it substantially dismisses the suppression hypothesis
§ 3.5 left open.** Proposed `takeProfitPct` on non-replay entry decisions, from `plan_json`:

| venue | n | min | p25 | median | p75 | max | proposals < 0.002 | < 0.001 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| binanceusdm (perp) | 112 | **0.012** | 0.025 | **0.035** | 0.045 | 0.070 | **0** | **0** |
| binance (spot) | 14 | 0.020 | 0.0285 | 0.031 | 0.035 | 0.045 | **0** | **0** |

**The model has never proposed a take-profit anywhere near the floor.** Its perp minimum is
**0.012 — six times the current 0.002 floor and twelve times the post-flip 0.001 floor** — and its
median 0.035 is **17.5× the overstated round-trip cost and 48× the true one**. And the TP-floor
gate's all-time rejection count was **re-verified at 0** in the same read (`%rejected: tp below fee
floor%`, all strategies, all modes, all time), which is now explained mechanically rather than
merely observed.

**So § 3.5's open question — "a plausible suppression channel, this record neither confirms nor
dismisses it" — is answered in the direction of dismissal, on the exit-target axis.** A 2.8×
overstatement of a cost cannot plausibly bind a target that already clears the true cost by 48×.
The one axis where fee truth could still matter is the **entry** decision (whether to trade at
all), and this read says nothing about that. **The "fee misinformation suppresses targets"
hypothesis carried in the redesign plan is refuted for targets and untested for entries.**

**Declared magnitude: 0 bps, $0/day, 0 entries admitted, 0 gate rejections changed.** Derived, not
asserted. **Any post-enable improvement attributed to this flip is refuted in advance**, on the
same terms § 3.5 refuses it for L5.

**So why ship it.** Not as an improvement. **As a correctness fix and a confound removal**: every
future entry-side study on this lane would otherwise be run against a model that was told a false
fact about its own book, and that confound is unremovable after the fact. It is admissible under
the redesign plan's stance sentence as _evidence for the successor program_, and under no other
heading.

**Expected-positive — TRANSMISSION, which is deterministic, not behaviour, which is declared null:**

1. The rendered system prompt on the **v6** template carries the perp schedule `2/5` and the spot
   schedule `10/10` as **distinct facts**, and no longer contains the 20-bps-derived "sub-0.6%"
   sentence. Verified by `pnpm eval:agentic`'s rendered fixture and by the prompt-hash partition
   moving off `aefafb3c…`.
2. `takeProfitFloorFraction` never returns below `0.00083619` for any venue.

**Named defects ⇒ rollback:**

1. **The rendered prompt does not change** (hash partition does not move, or the fixture still
   carries one schedule) ⇒ the lever did not ship at all ⇒ revert the single commit. This is the
   only clause on which "does not transmit ⇒ roll back" applies, because transmission here is a
   property of the rendered bytes, not of the model's behaviour.
2. **First 20 perp trips under v5 carrying `takeProfitPct < 0.002` realise a mean net below
   +8.3619 bps** ⇒ revert. **This cohort is expected to be EMPTY** — the pre-enable minimum
   proposal is 0.012 — and **an empty cohort is UNFIRED FOR WANT OF POPULATION, never a pass.** Say
   so at every read; an unrun check is not a passing one.
3. **The proposed-TP distribution is declared NOT to move.** Post-enable perp median outside
   [0.030, 0.040], or minimum below 0.010, over the first 50 v5 perp proposals is a **FINDING to
   report in whichever direction it points** — not a rollback and not a success. If it moves down
   toward the newly-legal band, the suppression hypothesis is alive on a channel this read could
   not see; if it does not move, the null declared above is confirmed.

**`TRADE_TEMPLATE_VERSION` goes v4 → v6, and v5 is SKIPPED deliberately.** `PROMPT_TEMPLATE_VERSION`
in the same file already holds `'v5'`; reusing that string for a different template composition is
exactly the collision `computePromptHash`'s distinctness spec exists to catch. **`v5` is retired for
this lineage — do not reintroduce it**, and read every "v5" in the plan that authorised this enable
as "v6".

**Confound stack, declared before the enable.** The v4→v6 partition is clean, but the container
recreate that deploys it also carries: **migration `0003` + `stop_reason` journaling** (`fe84c61`),
**per-symbol fill watermarks**, **the reconciliation repair path for orphaned algo-rail stops**, and
**the authoring budget/mint gate**. Standing alongside: **L1 and L4 still live** since 2026-08-04,
the **liquidation and perp trade-flow payload channels** live since 2026-08-04, and — the largest —
**the regime shift measured in § Checkpoint #1**, where gross per trip improved ~87% with zero
configuration changes. **Nothing measured after this deploy is attributable to L6 alone**, which is
why every clause above is graded on a mechanical quantity — rendered bytes, floor values, proposal
distributions — and **never on PnL**.

### The confound stack, stated so no later reader credits either lever alone

**L1 and L4 shipped in the same instant.** Nothing measured after 2026-08-04T08:00:23Z is
attributable to one of them. A third change lands in the same window — the liquidation and perp
trade-flow payload channels going live 2026-08-04 — and a fourth sits under the whole comparison:
**the market regime changed** (§ Checkpoint #1: gross per trip improved ~87% with **zero**
configuration changes in the 08-06 → 08-10 window). The decomposition above assigns the _mechanism_
— fewer calls, not cheaper calls — which is what distinguishes the two levers; it does not assign
the _credit_, and this record does not claim to.

## Checkpoint #2 — recorded 2026-08-11T16:08:01.978Z, 4h08m LATE against the 2026-08-11T12:00Z row

_Appended under § 2.5. The frozen body above is untouched, as is § Checkpoint #1. This checkpoint
extends nothing and adjusts nothing (§ 2.5 rule 3); it re-derives a date. Recorded by Pass 70 — the
first pass to run after the 12:00Z gate, which Passes 68 and 69 both correctly declined to pull
forward._

**Why late, and why that is not a moving target.** The § 2.5 line is a pure function of elapsed time
from A1, declared before any result was seen, so evaluating it at this read's instant is reading the
same line at a different `x` — the identical justification § Checkpoint #1 gave for being 27h08m
EARLY. Both the elapsed-time evaluation and the literal declared row are reported below, so neither
framing can flatter the result.

**Tuple C — ONE `PromotionReadinessService.evaluate()` sample, 2026-08-11T16:08:01.978Z** (never
assembled from separate reads, § 2.5 rule 1; taken from `loop:sweep`'s own `_promotion_evidence_`
annotation, which samples all seven fields from a single `evaluate()` call):

```text
windowDays=18.90106894675926  roundTrips=88  netPnlUsd=−82.0551198244
llmCostUsd=42.4896401         winRate=0.3068181818181818  ready=false
reasons=[NON_POSITIVE_NET_PNL, BELOW_PASSIVE_BENCHMARK]
```

`INSUFFICIENT_WINDOW` stays cleared (18.90 > 14 days) and the gate still does not open — the same
structural point § 2 made and § Checkpoint #1 confirmed: the window was never what held it shut.

### The comparison, in both directions (§ 2.5 rule 2)

```text
elapsed A1 → C         = 2026-08-03T22:02:24Z → 2026-08-11T16:08:01.978Z = 7.7539118 d
projected at −$5.2088/d = −63.5326 − 5.2088 × 7.7539118 = −$103.9212
measured                =                                  −$82.0551
```

**BETTER than projection by $21.87 (21.0%).** Against the literal declared 2026-08-11T12:00Z row of
**−$103.02**, the measured book 4h08m later is ahead by **$20.96**. Both readings agree in sign and
magnitude, so the lateness does not carry the result.

**This is the second consecutive checkpoint to come in ahead of projection**, and the gap widened
from $15.92 (16.4%) to $21.87 (21.0%). § Checkpoint #1's instruction not to bank it applies here
unchanged and with more force, because the mechanism named there — a regime shift, not a lever — is
still the leading explanation and is still not under this program's control.

### Re-derived rates, each with its denominator named

```text
gross = net + llm = −82.0551198244 + 42.4896401 = −$39.5654797244
wall-clock since epoch (2026-07-21T11:21:00Z → C) = 21.1993284 d
forward window (§ Checkpoint #1's own anchor, P65 tuple 2026-08-06T16:33:53Z → C) = 4.9820484 d
  Δnet = −$9.3173214   Δllm = +$9.2957514   Δgross = −$0.0215700   Δtrips = 27
```

| rate | arithmetic | value |
| --- | --- | --- |
| net-of-cost, wall-clock since epoch | 82.0551198244 ÷ 21.1993284 | **−$3.8706/day** |
| net-of-cost, on the gate's own `windowDays` (conservative) | 82.0551198244 ÷ 18.9010689 | **−$4.3413/day** |
| gross only, wall-clock since epoch | 39.5654797244 ÷ 21.1993284 | **−$1.8664/day** |
| LLM, epoch average | 42.4896401 ÷ 21.1993284 | **$2.0043/day** |
| **net-of-cost, forward window** | 9.3173214 ÷ 4.9820484 | **−$1.8702/day** |
| LLM, forward window | 9.2957514 ÷ 4.9820484 | **$1.8659/day** |
| gross only, forward window | 0.0215700 ÷ 4.9820484 | **−$0.0043/day** |

**⛔ THE ONE LINE IN THIS TABLE THAT IS NOT A ROUNDING DETAIL: over the last 4.98 days and 27 closed
round trips, GROSS IS FLAT — total Δgross −$0.0216, a rate of −$0.0043/day.** Across the same window
the book lost **$9.3173** net-of-cost, of which **$9.2958 (99.77%) is the LLM bill**. On this window
the strategy neither made nor lost money before costs, and the entire deficit is the cost of deciding.
That is § Standing Finding 2 ("the LLM bill is the dominant per-trip cost") reproduced on a fresh,
independent window — reported, **not banked**: 27 trips is a small denominator, the window is fully
confounded (regime, L6, and the Pass 69 `nextConsultBars` clamp all land inside it), and a flat gross
is not a positive edge. **It does not license cost work as a profitability lever** — `verdicts.md`'s
prohibition stands, and § 2.4's zero-LLM counterfactual already showed that zeroing the bill leaves a
book that still does not clear the bar.

### Restated S3 date — every rate still lands after the window close

```text
headroom on the −$200 arm = 200 − 82.0551198244 = $117.9448801756
```

| rate used | days to −$200 | date |
| --- | --- | --- |
| forward window −$1.8702/day | 63.07 | **2026-10-13** |
| wall-clock epoch average −$3.8707/day | 30.47 | **2026-09-11** |
| gate `windowDays` −$4.3413/day (conservative) | 27.17 | **2026-09-07** |
| the pre-declared composed −$5.2088/day | 22.64 | **2026-09-03** |

**§ Checkpoint #1's central finding is CONFIRMED on an independent read and strengthened.** Every
restated rate lands after the **2026-08-31** close; the nearest is **2026-09-03** and the forward-rate
reading has moved further out (2026-09-30 → 2026-10-13). The window still closes 2026-08-31 and the
−$200 trigger is still −$200 (§ 2.5 rule 3). **Expect this program to end on the written verdict, not
on a triggered S3** — now the settled expectation across two checkpoints rather than one.

The LLM arm remains slack and non-binding (§ 2.3 unchanged): headroom `150 − 42.4896401 = $107.5104`;
at the forward $1.8659/day that is 57.6 days (~2026-10-08). **The −$200 arm still binds first.**

### § 2.5 rule 4 — the one lever enabled since Checkpoint #1, compared at its declared number

**L6 (the fee-truth prompt path, `917e542`) went live at boot 2026-08-10T09:49:33Z — 57 minutes AFTER
Checkpoint #1's 08:52:03Z instant** — so rule 4 binds at this checkpoint and is discharged here.

**Declared magnitude, quoted from § L6 verbatim and not chosen afterwards: "0 bps, $0/day, 0 entries
admitted, 0 gate rejections changed."**

Measurement over the only window that is post-enable throughout (Checkpoint #1's tuple B → C):

```text
elapsed B → C = 2026-08-10T08:52:03Z → 2026-08-11T16:08:01.978Z = 1.3027660 d
Δnet = −$0.8412927   Δllm = +$2.3962200   Δgross = +$1.5549273   Δtrips = 8
```

**Verdict: compared, and NOT RESOLVABLE AT THIS n — which is the expected outcome for a magnitude
declared zero, not a failure of the lever or of the test.** Δgross is +$1.55 over **8 round trips and
1.30 days**; at this book's per-trip dispersion that is indistinguishable from zero, and the window
additionally contains the Pass 69 `nextConsultBars` clamp (`76dbbed`, deployed 2026-08-11T09:17:55Z)
and the same unresolved regime term. **§ L6's own clause governs and is applied here: "Any post-enable
improvement attributed to this flip is refuted in advance." The +$1.55 is therefore NOT credited to
L6**, and no later reader may pick it up as evidence that L6 delivered. L6's admissible
expected-positive was always the deterministic TRANSMISSION check, not PnL.

### What this checkpoint does not claim

It does not extend the window, does not touch the −$200 or $150 triggers, does not re-adjudicate L1
or L4, and does not treat two consecutive better-than-projection reads as a trend: `roundTrips` grew
80 → 88 between the checkpoints, and **n=8 is a window delta, never a trajectory**. The next
checkpoints are **2026-08-18T12:00Z** and **2026-08-25T12:00Z**, read against the same frozen § 2.5
table.
