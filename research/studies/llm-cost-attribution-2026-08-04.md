# LLM cost attribution, per trip — measured

_2026-08-04. Instrument: `pnpm loop:llm-attrib` (`scripts/loop-llm-attrib.mjs` +
`scripts/loop-llm-attrib-core.mjs`, pinned offline by
`test/features/strategy/loop-sweep/llm-attrib.spec.ts`). Read-only; carries no gate and emits no
alarms._

## 1. The one-paragraph answer

The book's objective is `net-of-cost PnL = realizedPnl − fees − llmCostUsd`, and until now no
per-trip statistic anywhere contained the LLM term — `promotion-readiness.service.ts:136-139`
deliberately fixes `winRate` on `realizedPnl − feesQuote` and carries LLM cost at BOOK level only.
That term is now measured. Over the promotion evidence window the lane spent **$28.7683109** on LLM
tokens across **49** closed round trips: **$0.587/trip amortized**, or **+69.5 bps** of the $84.43
mean one-way notional. Against the same window's own fee rate of **8.56 bps/trip** that is
**8.13× the fees the book paid** — the LLM bill is the dominant per-trip cost term by a wide margin,
and it was invisible by construction. The recomputation was validated against the promotion gate's
own published figure and agrees **exactly**.

The prior working inference of _~81 bps/trip, ~8.7× the fee floor_ **survives in substance and is
wrong in detail**: the numerator (~$0.59/trip) is right, the denominator was not the one the fee
floor uses. Corrected: **69.5 bps/trip, 7.48× the frozen 9.29 bps floor, 8.13× the window's own
realised fee rate.** See § 6.

## 2. What was measured, as of 2026-08-03T22:12:28Z

Window: `PROMOTION_EVIDENCE_EPOCH` = 2026-07-21T11:21:00Z → 2026-08-03T22:02:24Z, filtered on
`created_at` exactly as `PromotionStatsRepository.tokenTotals` (`promotion-stats.repository.ts:100-192`)
filters it — **not** `event_time`, which is a BIGINT epoch-ms bar-open column.

| model | source | rows | cost | rates | share |
| --- | --- | --- | --- | --- | --- |
| `claude-sonnet-5` | `agent_decisions` | 2109 | $23.7567039 | mapped | 82.6% |
| `claude-opus-4-8` | `llm_usage` | 58 | $4.467794 | **max_of_configured** | 15.5% |
| `claude-opus-5` | `llm_usage` | 11 | $0.543813 | mapped | 1.9% |
| `plan-executor` | `agent_decisions` | 1783 | $0 | max_of_configured | 0% |
| `prescreen` | `agent_decisions` | 40020 | $0 | max_of_configured | 0% |
| **total** | | **43981** | **$28.7683109** | | |

Token sums behind the sonnet line: in 4,320,625 / out 410,712 / cache-read 4,950,523 / cache-write
524,832 at 3 / 15 / 0.3 / 6 USD per Mtok (`.env.app:165-171`).

Context, same window: fees paid **$3.54031828** over $8273.75722170 traded notional across 295
fills; `agentic_promotion_net_pnl_usd` = **−$63.53**. LLM spend is **45%** of the net-of-cost
deficit and **8.13×** the fees.

## 3. The cross-check — it ran, and it is an identity

The instrument recomputes the book cost from raw token columns and compares against
`agentic_promotion_llm_cost_usd`, which is `PromotionReadinessService.evaluate()`'s own
`llmCostUsd` published by `PromotionMetricsService.tick()`. Both folds price the same columns at the
same rates in the same order (`costOf` is byte-identical to
`promotion-readiness.service.ts:167-171`), so agreement is an equality test, not a tolerance.

A raw delta proves nothing on its own — the gauge is a 5-minute sample
(`promotion-metrics.service.ts:79`) of a book that keeps growing. The check therefore peels the cost
curve back one priced row at a time and asks whether the gauge sits _exactly_ on it. Three
independent readings:

| gauge read at | published | recomputed | verdict |
| --- | --- | --- | --- |
| 22:03:01Z | $28.7007443 | $28.7683109 | **EXACT_AT_CUT** — identical after peeling the 1 priced row written at 22:00:31Z ($0.0675666) |
| 22:12:28Z | $28.7683109 | $28.7683109 | **EXACT** — raw delta $0 |
| 22:17:36Z | $28.7683109 | $28.8562685 | **EXACT_AT_CUT** — identical after peeling the 1 priced row written at 22:15:44Z ($0.0879576) |

Both folds land on the same number to the last digit, including the `max_of_configured` pricing of
`claude-opus-4-8`. Any other rate assignment for that model would have missed. **The two
sides agree; nothing was reconciled away.**

Comparison is performed at float64 resolution because the gauge is itself the float64 image of the
gate's Decimal (`promotion-metrics.service.ts:141` calls `.toNumber()`). That lossy step belongs to
the gate's publication path, not to the instrument; the full-precision Decimal delta is reported
alongside regardless.

## 4. The two per-trip attributions — both true, not interchangeable

Denominator: **49** closed round trips, taken from `agentic_promotion_round_trips` — which is
`walkRoundTrips`'s (`src/domain/trading/risk/round-trips.ts`) own published output, **read rather
than re-derived**. The instrument never walks fills itself; a second walk would be a second truth,
and the whole value of § 3 is that both sides divide the same book by the same denominator.

### Amortized average — $0.587/trip (+69.5 bps)

`$28.7683109 ÷ 49 = $0.58710838571428571429`. **This is the number the objective function needs.**
`net-of-cost PnL = realizedPnl − fees − llmCostUsd` divides the book cost across the book's trips;
this is the figure to set against the fee rate and against any break-even bar.

### Consult-chain marginal — $0.06 to $0.12/trip (+7.1 to +14.4 bps)

One `consult_id` is one Anthropic call that fans out to N per-symbol decision rows. Of 667
post-epoch consults, **149 emitted at least one trade action** (428 rows, 190 of them trade actions)
and **518 were pure cadence** (1008 rows, zero trade actions). Charging the 149 trade-bearing
consults in full gives $0.12/trip; slicing each by `tradeActionRows / fanout` gives $0.06/trip.

### The counterfactual marginal is near ZERO, and that is the point

**The marginal cost of one more trip is approximately zero, because consult cadence is TIME-driven,
not trade-driven.** A consult fires when a bar closes, whether or not a position exists. One more
trip does not buy one more consult. The direct evidence is the cadence-only line: **$17.81 —
61.9% of the entire LLM bill — was spent by consults that produced no trade action at all.**

These two numbers answer different questions and the record has repeatedly conflated them:

- _Does this book pay for itself?_ → **amortized, $0.587/trip.** The book must clear this.
- _What does one more trip cost?_ → **≈ $0.** Trading more does not raise the bill; trading less
  does not lower it.

Substituting the marginal for the amortized understates the book cost **by design**, which is why
the instrument prints the amortized figure first and never prints either one alone. The corollary is
uncomfortable and worth stating plainly: because the bill is time-driven, **the only levers that
lower cost per trip are trading MORE trips per unit time, or cutting the cadence/prompt size** —
not trading better.

## 5. What could not be priced

`unpriceable_rows` = **0**, and it is a MEASURED zero, not an absent probe.

The naive classification would have been badly wrong here and is worth recording as a trap. 769
rows in the window carry `latency_ms` and a non-empty `prompt_hash` — they look like calls — yet have
NULL token columns. They are **not** unmeasured spend: they are fan-out siblings of a consult whose
single token-bearing row is already priced. Verified structurally across all 667 post-epoch consults:
rows-per-consult equals distinct `(symbol, venue)` per consult exactly (1..8), and **exactly one row
per consult carries the token columns**, with no exceptions. Counting those 769 as billable would
have invented a four-figure phantom cost tail.

| class | rows | billable | why |
| --- | --- | --- | --- |
| `consult_sibling_of_priced_call` | 769 | no | same Anthropic call, already priced |
| `no_client_call` | 42476 | no | `prescreen`/`plan-executor` rows and pre-call errors — no latency, empty prompt hash |
| `consult_with_no_priced_row` | 0 | **yes** | would mean a call whose usage was never journaled |
| `client_called_no_consult_id` | 0 | **yes** | would mean unattributable spend |
| `reflection_null_tokens` | 0 | **yes** | `llm_usage` row with no usage recorded |

Both billable classes read zero today. If either goes positive, every cost figure above becomes a
lower bound by that many calls.

## 6. Does the ~81 bps/trip inference survive?

**Substance yes, arithmetic no.** The claim was built from two figures on different denominators
(48 trips vs 38 measurable) and is now replaced by a single consistent measurement.

| | inferred | measured | note |
| --- | --- | --- | --- |
| cost per trip | ~$0.59 | **$0.587** | holds |
| one-way notional | ~$72 | **$84.43** | the gap |
| bps per trip | ~81 | **69.5** | 14% overstated |
| × the fee floor | ~8.7× | **7.48×** (vs the frozen 9.29 bps) / **8.13×** (vs this window's own 8.56 bps) | holds in magnitude |

The denominator is the whole discrepancy. This study uses the **per-leg** basis
`Σ(price×qty) ÷ (2 × trips)` = `$8273.76 ÷ 98` = **$84.43**, which is exactly the denominator
`fee-floor-derivation-2026-07-31.md:104-109` uses: its `bps_per_round_trip = 2 × 10000 × Σfee ÷
Σnotional` is algebraically `(Σfee ÷ trips) ÷ (Σnotional ÷ 2×trips)`. Using the same denominator is
what makes the LLM bps directly comparable to the fee bps rather than merely similar-looking. A
self-consistency check confirms it: the same construction applied to this window's fees returns
**8.56 bps/trip**, a fee rate — and the LLM/fee ratio then comes out identical whether computed in
dollars ($28.77 / $3.54) or in bps (69.5 / 8.56), as it must when the denominator cancels.

$72.84 is the denominator the ~81 bps figure implies. It is not reproducible from the current fills
fold under any construction this study could find; the most likely explanation is that it came from
an earlier, smaller window (the fee-floor study's own fold was $6184.03 over 241 fills) whose trip
count and notional have both since grown. Stated as an unconfirmed reading of the prior number, not
as a finding.

**Direction of bias, named:** the fill sum includes legs of cycles still open, so $84.43 is an
UPPER bound on the notional belonging to the 49 closed trips, and 69.5 bps is therefore a **LOWER**
bound. This is the one axis on which the instrument under-states. The USD-per-trip figures do not
depend on it.

## 7. Two findings the instrument surfaced on the way

**`claude-opus-4-8` has no configured rate.** It carries 58 reflection rows / 693k tokens in
`llm_usage` and no entry in `AGENTIC_TOKEN_PRICES_JSON`, so it prices at the most-expensive
configured rate per component (5/25/0.5/10). That is **$4.467794 — 15.5% of the book cost — carried
as an upper bound rather than a measurement**, and this is not the instrument's convention alone:
`PromotionReadinessService.ratesFor` applies the identical rule, so the live-arming gate is running
on the same upper bound. At the sonnet default rates the same tokens would cost $2.6806764. Pricing
the model in `AGENTIC_TOKEN_PRICES_JSON` converts $1.79 of upper bound into measurement. Not done
here — a config change is out of this study's scope.

**`prescreen` and `plan-executor` are unpriced pseudo-model names** carrying 41,803 token-free rows.
They cost $0 only because their token totals are zero, not because they are known to be free. The
moment any writer stamps tokens on one of those names it prices at the most-expensive configured
rate with no further warning. Named by the instrument on every run.

## 8. Failure direction

MEASUREMENT, fails toward **OVERSTATEMENT**, loudly. No gate, no alarms, no exit code that can stop
a pass — a broken measurement must never block the thing it measures. Unknown model ⇒ most expensive
configured rate. Rows that cannot be accounted for ⇒ a named `unpriceable_rows` count, never a silent
zero. Transport failure, unreadable rates, or an unpriceable model ⇒ `MEASUREMENT-VOID`, never
`$0.00`. Unknown trip count ⇒ per-trip figures voided **by name** while the book cost still prints.
A zero always means a measured zero. The single under-stating axis is the bps denominator (§ 6),
disclosed on every render.

Money is decimal.js throughout; token counts are exact integers summed by the database. The only
native floats are counts, the dimensionless bps ratio, and the one float64 comparison in § 3 that
exists because the gauge is a float64 image.

## 9. Reproduce

```bash
pnpm loop:llm-attrib
```

Requires the postgres and prometheus containers up. Reads only. The offline core spec
(`pnpm exec vitest run test/features/strategy/loop-sweep/llm-attrib.spec.ts`, 28 tests) needs no
database and pins the figures in § 2 and § 3 as exact strings.
