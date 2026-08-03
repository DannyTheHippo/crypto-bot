# The break-even bar, derived (2026-08-04)

_The +13.0 / +24.2 pair was never derived — it enters the repo fully formed in commit `7b3e977` and
every later citation is circular (`fee-floor-derivation-2026-07-31.md` § 1). This study composes a bar
from measured operands instead, and finds that the asserted pair is simultaneously too HIGH for the
question it was implicitly asked and far too LOW for the question that decides whether the book pays
for itself._

**Harness:** `test/backtest/break-even-bar.spec.ts` over pure `test/backtest/break-even.ts`, gated
`BREAK_EVEN_BAR=1` + `DATABASE_URL`, read-only, self-skipping, off the production gate.
**Population:** `research/studies/book-truth-2026-08-04.md` — 48 closed round trips, 294 fills,
Σ one-way notional $3,996.1492, 12 base-asset clusters.
**Anchor as-of:** 2026-08-03T16:07:00Z. **Epoch:** 2026-07-21T11:21:00Z.
**Statistics:** cluster bootstrap on **base assets** (never symbol strings), seed **20260731**,
`N_BOOT` **20,000**, floors `MIN_CLUSTERS=5` / `MIN_OBS=12`.

## Bottom line

| question | answer |
| --- | --- |
| What is the true GROSS bar (venue fees + slippage)? | **+8.36 bps/round trip**, cluster CI95 **[+6.20, +10.76]**, n=48, 12 clusters |
| What is the true ALL-IN bar (gross + inference)? | **+78.80 bps/round trip** |
| Is the asserted **+13.0** right? | **No — it is ~4.6 bps too HIGH as a gross bar** (above the CI's upper bound), and **~66 bps too LOW as an all-in bar** |
| Is the asserted **+24.2** right? | **UNDERIVABLE.** No live book, no authoritative live schedule in the repo |
| Did the ~81 bps/trip LLM inference survive? | **Substantively yes, numerically no — it is ~70 bps**, because the `$72` notional understates the measured $83.25 |
| Does any of this rescue the book? | **No.** The gap widens: realised gross **−69.90 bps/trip** against an all-in bar of **+78.80** is a **148.70 bps/trip** gap, worse than the recorded 111–130 |

## 1. Term 1 — venue fees, exact per cycle

Computed as each cycle's OWN `feesQuote ÷ (turnover / 2)`. **No `×2` per-leg approximation appears
anywhere in this study**, and § 1.2 shows the approximation is not exact.

### 1.1 The measurement

| scope | trips | Σ one-way notional | bps/round trip |
| --- | --- | --- | --- |
| book | 48 | 3996.1492 | **8.6718** |
| `binance` (spot) | 7 | 453.72 | **20.0000** |
| `binanceusdm` (perp) | 41 | 3542.43 | **7.2208** |

Per-cycle mean **8.9878** bps, median **7.5308** bps. The mean exceeds the book rate because the
smaller cycles are disproportionately spot.

Perp share of one-way notional: **88.65%** — matching the census's 89.0%-by-fill-notional on a
different denominator.

Per-leg cross-check off the same fills, confirming these are the published venue schedules and not a
paid-versus-published discrepancy:

| venue | liquidity | fills | notional | bps/leg |
| --- | --- | --- | --- | --- |
| `binance` | maker | 3 | 160.4085 | 10.000000 |
| `binance` | taker | 13 | 747.0353 | 10.000000 |
| `binanceusdm` | maker | 194 | 2779.3401 | 1.999998 |
| `binanceusdm` | taker | 84 | 4524.7862 | 4.521570 |

This reproduces `census-2026-08-03.md` § 1 exactly (the perp-taker cell reads 4.528056 over the full
295-fill window; 4.521570 is the same cell at the 294-fill anchor).

### 1.2 Why the `×2` approximation is not exact, demonstrated

Spot's exact per-cycle rate is **20.0000** bps — identical to `2 × 10.0000`, because binance spot
charges maker = taker and the identity holds trivially.

Perp's exact per-cycle rate is **7.2208** bps, against `2 × 3.574209 = 7.1484` from the per-leg
aggregate. The **0.072 bps** difference is not noise: the two legs of a cycle differ in notional by
the price move, and the maker/taker mix is not the same on the entry leg as on the exit leg. Small
here; not zero, and not guaranteed small on a book with a different exit mix. **The per-cycle form is
used throughout, and the per-leg aggregate appears only as the cross-check above.**

## 2. Term 2 — slippage, re-derived (and it does not reproduce the recorded figure)

**Definition used:** signed adverse slippage of fill price against the intent's `ref_price`, on ENTRY
legs (`reduce_only = false`) whose fill landed **within 60 s** of the intent being written. The
freshness bound is what makes this an execution measurement: beyond it, `ref_price` is a stale mark
and the difference is position PnL. The 2026-07-31 audit's `STOP_LOSS_LIMIT` row (+221.8 bps at a
7-hour lag) is that failure mode in the record already.

| cut | legs | notional-weighted bps/leg | unweighted mean bps/leg |
| --- | --- | --- | --- |
| entry legs, lag < 60 s **(this study)** | 112 of 294 | **−0.4838** | −0.1117 |
| entry legs, lag < 60 s, taker only | 32 | −0.8610 | −1.5455 |
| entry legs, lag < 60 s, maker only | 80 | +0.8631 | +0.4619 |
| `reduce_only=f, type=LIMIT` **(the recorded cut)** | 77 | **−0.0821** | — |
| all entry legs, no freshness bound | 194 | −2.7649 | −2.9805 |

Cycle-level: Σ slippage cost **−0.13256677** quote over Σ one-way 3996.1492 ⇒ **−0.3317 bps/round
trip**; per-cycle mean **−0.6259** bps, median **0.0000** bps. **33 of 48 cycles carry at least one
fresh leg** — the median is exactly zero because the other 15 carry none and contribute a structural
zero, not a measured one. The per-cycle mean and the book-weighted rate agree to 0.02 bps at the bar
level (§ 3), so nothing turns on the choice between them here.

**The recorded `+0.333 bps/leg` does not reproduce, and its SIGN has flipped.** On the recorded cut
itself (`reduce_only=f, type=LIMIT`, which was 74 legs at freeze and is 77 now) the figure is now
**−0.0821**. This is a population change, not a methodology dispute — the recorded value was correct
when taken.

**The honest reading is not "slippage is favourable"; it is that slippage is indistinguishable from
zero at this book size and its sign is not stable across a 3-leg population increment.** Every cut
above is under 1 bps/leg in magnitude except the stale-ref ones, which are not slippage measurements.
It is carried into the bar at its measured value (−0.33 bps/round trip) with that instability
declared, and it changes no conclusion: dropping the term entirely moves the gross bar from 8.36 to
8.69 bps.

**Under-count declared:** legs failing the freshness bound contribute exactly zero to their cycle's
slippage cost rather than an imputed value. That biases the slippage term toward zero. Fail direction
is OPEN by design — this is a measurement, not a gate, and imputing execution cost onto a leg whose
reference is stale would manufacture the very number the freshness bound exists to exclude.

## 3. The GROSS bar

Fees + slippage, per round trip, against one-way notional.

| statistic | value |
| --- | --- |
| book-weighted (Σ cost ÷ Σ one-way) | **8.3400** bps |
| per-cycle mean | **8.3619** bps |
| cluster bootstrap CI95 | **[6.2010, 10.7616]** |
| n | 48 |
| clusters (base assets) | **12** |
| power | **n ≥ 12 and clusters ≥ 5 — this cell is EVIDENCE, not merely recorded** |

**The asserted +13.0 sits ABOVE the CI's upper bound (10.76).** As a gross bar it is not merely
imprecise, it is outside the measured interval — it demands ~4.6 bps more edge than the venue
actually charges. That is the **conservative** direction, and it confirms and sharpens the 2026-07-31
audit's finding (which put the demo cost at 9.29 bps using the `×2` per-leg form and a `+0.67`
slippage add; the two corrections here — exact per-cycle fees, and re-measured slippage that is now
mildly favourable — account for the move from 9.96 to 8.36).

## 4. Term 3 — LLM cost per trip, under BOTH attributions

### 4.1 The composition of the spend

| source | model | rows | token-bearing rows | cost (USD) |
| --- | --- | --- | --- | --- |
| decide | `claude-sonnet-5` | 2,073 | 652 | 23.135732 |
| decide | `plan-executor` | 1,739 | 0 | 0.000000 |
| decide | `prescreen` | 39,180 | 0 | 0.000000 |
| reflection | `claude-opus-4-8` | 58 | 58 | 4.467794 |
| reflection | `claude-opus-5` | 11 | 11 | 0.543813 |
| **total** | | | **721** | **28.1473391** |

`claude-opus-4-8` appears in no configured price map and therefore prices at the fail-closed
component-wise maximum (5/25/0.5/10). **$4.47 of the $28.15 — 15.9% — is priced at a rate the
operator never declared for that model.** It is deliberately an over-count inside a permission gate;
it is named here because a bar built on it inherits the over-count.

### 4.2 AMORTIZED — book cost ÷ closed trips. **This is the number the bar uses.**

Each row is a **window-consistent snapshot**: the LLM cost is re-read up to the instant that trip
count was reached, so the numerator and denominator describe the same window. (Pairing the full
$28.15 with an early trip count would charge trips for spend that had not happened yet — the exact
class of error this pass exists to remove, and the first version of this harness made it.)

| trips | as-of | LLM cost | $/trip | Σ one-way | **bps/round trip** |
| --- | --- | --- | --- | --- | --- |
| 23 | 2026-07-27T15:49:13Z | 15.4759 | 0.6729 | 1972.61 | **78.45** |
| 38 | 2026-07-31T17:30:34Z | 20.6730 | 0.5440 | 3236.29 | **63.88** |
| 46 | 2026-08-02T16:00:36Z | 25.3853 | 0.5519 | 3831.45 | **66.26** |
| 48 | 2026-08-03T14:20:24Z | 27.7936 | 0.5790 | 3996.15 | **69.55** |
| 48 | 16:07Z anchor (full window cost) | 28.1473 | 0.5864 | 3996.15 | **70.44** |

**Range across the denominator choices: 63.88 – 78.45 bps/round trip**, converging near **70**.

**This is a RANGE and not a bootstrap CI, deliberately.** The LLM term is one book-level scalar
divided by one contested count. There is no sample and no sampling distribution; attaching a CI to it
would invent precision it does not have, which is the specific failure this pass exists to remove.
The honest uncertainty is which denominator you mean, and that is what the table shows.

**`27` is excluded from this table** because it is not a closed-trip count (23 closed + 4 open marked
— `book-truth-2026-08-04.md` § 2). Dividing a realised cost by a part-unrealised count has no
interpretation.

### 4.3 CONSULT-CHAIN MARGINAL

Mean cost of a token-bearing decide row: **$0.035484**. A single trip consumes two — the consult that
opened it and the consult that closed it — so the consult-chain marginal is **$0.070969/trip ⇒ 8.52
bps/round trip** at the mean one-way notional.

**But the true marginal cost of one more trip is ≈ 0, and both halves of that sentence matter.**

- **Marginal ≈ 0.** Cadence is time-driven, not entry-driven: 39,180 `prescreen` rows and 2,073
  decide rows were produced on a candle schedule that runs whether or not the model enters. The
  consult that opened a trip would have happened anyway and would have been billed anyway. **So a
  cost argument against trading MORE is wrong** — extra trips are nearly free at the margin, and the
  8.52 bps figure above is an accounting allocation, not an avoidable cost.
- **Average is what answers "does this book pay for itself".** The $28.15 is spent, it is real, and
  something has to earn it. Amortized over what the lane actually closed, that is ~70 bps/trip. **So
  a cost argument against the CURRENT trade rate is right** — at 48 trips over 10.85 days the lane
  must clear ~70 bps/trip of gross edge purely to cover inference.

The two numbers answer different questions and neither is the honest one on its own. **The lever the
pair implies is not "cut the model" — it is trade rate: the amortized term falls roughly as 1/trips
at fixed cadence.** Between the 23-trip and 38-trip snapshots the term fell 78.45 → 63.88 bps on
exactly that mechanism. This study names the lever and does not evaluate it; whether more trades at
this entry quality helps or hurts is an edge question, and the edge verdicts are unmoved by anything
here.

### 4.4 Did the ~81 bps inference survive?

**Substantively yes; numerically no.** The inference was $0.59/trip on a ~$72 one-way notional ⇒
~81.9 bps. Both operands check out except the notional:

- $/trip: **$0.5864** measured at the anchor — the $0.59 is right.
- one-way notional: measured mean **$83.2531**, median **$80.1664** (`book-truth-2026-08-04.md` § 5).
  **`$72` reproduces as no statistic of this distribution** — not the mean, median, or either venue's.

At the measured notional the term is **70.44 bps**, not 81. **The inference is ~14% high, and the
conclusion it was drawn to support is untouched:** the LLM term is still ~8.4× the derived gross bar
and ~5.4× the asserted +13.0. Reported this way because the brief required reporting whichever way it
moved, and it moved down.

### 4.5 Cross-check against the parallel LLM-attribution lane

`research/studies/llm-cost-attribution-2026-08-04.md` derived the same term independently, on the
**49-trip uncapped** population rather than this study's 48-trip anchor. **The two agree, and the one
divergence resolves exactly.**

| quantity | that study | this study (uncapped, n=49) | status |
| --- | --- | --- | --- |
| $/trip amortized | **$0.587** | **$0.58710838…** (28.7683109 ÷ 49) | **identical** |
| mean one-way notional | $84.43 | **$82.7969** | differ by $1.63 |
| LLM bps/round trip | **+69.5** | **+70.91** | differ by 1.4 bps |
| ~81 bps inference | survives in substance, ~14% overstated | same | **agree** |
| marginal ≈ 0, cadence time-driven | yes | yes | **agree** |
| `$72`-ish implied denominator not reproducible | yes ($72.84) | yes | **agree** |

**The divergence is a denominator definition and that study already named its own direction.** $84.43
is Σ notional over ALL 295 fills ÷ 2 ÷ 49 = $84.4261. $82.7969 is Σ over the fills that are MEMBERS of
a closed cycle only. The gap is exactly the $159.67 of fill notional sitting in still-open cycles
(8273.7572 − 2 × 4057.0468 = 159.6636). That study calls $84.43 an _"UPPER bound on the notional
belonging to the 49 closed trips"_ making +69.5 a **lower** bound — correct, and this study's
closed-members figure is the tighter one. Its fee rate of 8.56 bps/trip differs from § 1's 8.65 on
exactly the same denominator, in the same direction, by the same mechanism.

**No disagreement of substance exists between the two lanes.**

## 5. The bars

| bar | value | what it means |
| --- | --- | --- |
| **GROSS research bar** | **+8.36 bps/round trip** (CI95 [6.20, 10.76]; n=48, 12 clusters; per-cycle mean; book-weighted variant 8.34) | what "beats venue cost" actually requires — fees + slippage |
| **ALL-IN book bar** | **+78.80 bps/round trip** (= 8.36 + 70.44; book-weighted variant 78.78) | what the book must earn to pay for itself, inference included, **at 48 trips over 10.85 days on $83.25 mean one-way notional** |
| asserted research | +13.0 | never derived |
| asserted deployment | +24.2 | never derived; **UNDERIVABLE** (§ 6) |

**Denominators are printed beside each bar and are not separable from it.** The all-in bar is a
function of trade rate and notional; at a different cadence it is a different number, and quoting it
without "at 48 trips / 10.85 days / $83.25" is quoting a figure that does not exist.

## 6. The +24.2 live figure is UNDERIVABLE

Not "unverified" and not "approximately right" — **the repo cannot state it.**

- There is no live book. Every fill in `fills` is `mode='testnet'`, all 295 of them
  (`book-truth-2026-08-04.md` § 2).
- The repo holds no authoritative live fee schedule. The 2026-07-31 audit could only observe that
  `24.2 − 20.0 = 4.2` and that the parenthetical reads "(live 20 bps)", i.e. it appears to be the
  spot round-trip schedule plus an unexplained 4.2 — with the flag, never concluded, that if the 4.2
  is the "≈4 bps" measured fee figure then the live floor double-counts fees.
- Nothing in this study changes that. No live rate was measured because none is measurable here.

**A bar the record cannot state is recorded as exactly that.** The live bar is not replaced with a
number; it is marked UNDERIVABLE, and the deployment path that consumes it must either source an
authoritative schedule or carry the gap explicitly.

## 7. The gap, on the bar's own denominator

Realised gross: Σ `realizedPnl` **−27.933707** over Σ one-way **3996.1492** = **−69.9016 bps/round
trip**.

```text
gap to the derived GROSS bar   =  8.3619 − (−69.9016)  =   78.26 bps/trip
gap to the derived ALL-IN bar  = 78.7981 − (−69.9016)  =  148.70 bps/trip
```

The record's stated gap is **111–130** bps/trip (**111–126** under the 2026-07-31 correction), built
from `−101.9` / `−106.0` bps at n=23 / n=27 against the asserted floors. **On the current 48-trip
population the realised side is less negative (−69.90 vs −101.9) and the honest bar is much higher, so
the gap on an all-in basis is WIDER than anything the record carries: 148.70 bps/trip.**

Both halves of that moved, in opposite directions, and neither should be quoted alone.

## 8. Code homes a later step must update — listed, NOT edited

This study changes no code and no pre-registered constant. These are the three places the constant
lives, for whoever files the follow-up:

- `test/eval/agentic/playbook-space-replay.ts:47-48` — `REQUIRED_EDGE_BPS = 13.0`, whose doc comment
  is the entire provenance ("state.md standing verdict").
- `test/backtest/inversion-test.mjs:27` — `const REQUIRED_EDGE_BPS = 13.0;`
- `scripts/loop-authoring-core.mjs:519-524` — a doc comment asserting a provenance that does not
  exist, and containing a falsifiable claim that is false (`fee-floor-derivation-2026-07-31.md` § 1).

**They must not be changed by an unattended edit.** `REQUIRED_EDGE_BPS` is a pre-registered bar inside
live studies; lowering a bar after seeing results is precisely what this program's preregistration
discipline forbids, and the current value errs conservative on the gross question. Any change is a new
dated pre-registration.

## What this study cannot answer

- **It cannot state a live bar.** § 6. The +24.2 is recorded UNDERIVABLE, not corrected.
- **It measures cost, never edge.** Nothing here says whether the entries have signal, and nothing
  here rescues or damages the ENTRIES / NO_SURVIVOR verdicts.
- **The slippage term is unstable at this population size.** § 2 — sign-flipped against the recorded
  value on the recorded cut. It is under 1 bps/leg either way and changes no conclusion, but it is not
  a settled number and must not be quoted as one.
- **The all-in bar is not a constant.** It is a function of trade rate and notional (§ 5), so it
  cannot be pasted into code as a threshold the way +13.0 was.
- **The LLM range has no CI and never will.** § 4.2. Its uncertainty is definitional, not statistical.
- **$4.47 of the inference spend is priced at a rate the operator never declared** for
  `claude-opus-4-8` (§ 4.1). The bar inherits that fail-closed over-count.
- **One book, one 10.85-day window, one regime, 12 base-asset clusters, all demo.** The cluster CI is
  cluster-robust within this window and says nothing about any other. No result here is
  out-of-sample.
