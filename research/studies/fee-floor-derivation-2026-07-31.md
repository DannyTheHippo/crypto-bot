# Fee-floor derivation audit (2026-07-31)

An audit of the constant every research threshold in this program rests on: the break-even floor
**+13.0 bps/trip (demo)** / **+24.2 bps/trip (live)**. The question was whether it is correctly
derived. It is not derived at all, and the measured demo cost is about 30% lower than the demo floor
claims.

**No verdict moves.** That conclusion is stated up front and the arithmetic for it is in § 5.

## Bottom line

| Question | Answer |
| --- | --- |
| Does a derivation of +13.0 / +24.2 exist anywhere? | **No.** Both numbers appear fully formed in one sentence in commit `7b3e977` (2026-07-27) and every later occurrence cites it. |
| What is the real demo fee rate? | **4.6473 bps per leg / 9.2947 bps per round trip**, blended over the live book since the evidence epoch (§ 2). |
| Is `edge-verdict-2026-08-10.md:93` ("flat 20 bps per round trip") right? | Right for **binance spot only** (exactly 10.0000 bps/leg, maker = taker). Wrong for the book, which is 85% `binanceusdm` at 2/4/5 bps per leg. |
| Is `edge-verdict-2026-08-10.md:37` ("≈4 bps") right? | It is a **per-leg** rate, not per round trip, and it drops base-asset fees. Correct per-leg figure at freeze time is **4.754 bps**, not 3.964 (§ 3). |
| Does any verdict change? | **No.** The performance gap is 111–126 bps/trip under the corrected floor against 115–130 under the old one (§ 5). |

## 1. The derivation does not exist

Both constants enter the repo in a single commit, already formed, with no operands and no operator.

**First appearance — `7b3e977`, 2026-07-27, "docs(loop): the entry signal is significantly negative —
and worse than random".** It added the sentence in `research/loop/state.md` (migrated verbatim to
`research/loop/verdicts.md:345-350` at the 2026-07-30 compaction) and in `research/loop/LOG.md` (now
`research/loop/archive/LOG-through-pass-47.md:4889-4891`). The verdicts.md copy reads:

> Required gross edge for net-of-cost break-even under the BEST achievable cost structure is
> **+13.0 bps/trip** (demo fees) or **+24.2** (live 20 bps).

The qualifier *"under the BEST achievable cost structure"* is the only explanation attached to either
number, and that phrase is defined nowhere in the repo.

**Every later occurrence is a citation, and the citation graph is circular.**

- `research/loop/verdicts.md:635-636` sources the pair to `playbook-space-followon-2026-07-31.md`
  § The RESEARCH bar and `entry-rate-rederivation-2026-07-30.md`.
- `research/studies/playbook-space-followon-2026-07-31.md:43-44` sources it to `verdicts.md`
  § THE ENTRY SIGNAL.
- `research/studies/entry-rate-rederivation-2026-07-30.md:247-248` sources it to `verdicts.md:202-203`
  — which is the middle of the Moonshot empty-body-HTTP-200 verdict. The fee-floor text is at
  `verdicts.md:346-350`. The one line-precise citation in the program points at the wrong lines.
- `research/studies/nonprice-channels-2026-07-27.md:15`,
  `research/studies/architecture-options-2026-07-28.md:16`,
  `research/studies/playbook-space-replay-2026-07-28.md:155-156` — all cite `state.md`
  § Standing verdicts, i.e. the `7b3e977` sentence.

**In code, the constant is asserted, never computed.**

- `test/eval/agentic/playbook-space-replay.ts:47-48` — the comment is the whole explanation:

  ```text
  /** Required gross edge per trip at demo fees — state.md standing verdict. */
  export const REQUIRED_EDGE_BPS = 13.0;
  ```

- `test/backtest/inversion-test.mjs:27` — `const REQUIRED_EDGE_BPS = 13.0; // state.md: required
  gross edge/trip at demo fees`.
- `scripts/loop-authoring-core.mjs:519-524` — the doc comment says what the figure is *not*, never
  where it came from, and its own claim is falsifiable and false:

  ```text
   * Break-even GROSS forward return per trip, by lane. NOT a flat 20 bps — that figure appears nowhere
   * in this program's own cost model, ...
  ```

  A flat 20 bps *does* appear in this program's cost model — `edge-verdict-2026-08-10.md:93` states
  it as the frozen cost model of a pre-registered study, and § 2 below confirms it is the exact
  binance-spot schedule.

- `test/features/common/scripts/loop-authoring-core.spec.mjs:469-471` is the only arithmetic in the
  repo involving 13.0, and it **consumes** the constant rather than producing it.

**Finding: the floor is an assertion, not a derivation.** Nothing in the repo decomposes +13.0 or
+24.2 into fee, slippage, funding or inference components. A search over all of `research/`,
`test/`, `scripts/`, `src/`, the loop archive, and `git log -S` across all history found no operator
adjacent to either number.

## 2. Measured fee rate from the live book

Source of truth: the `fills` table (`src/database/schemas/trading/trading.schema.ts:130-151`), which
carries `price`, `qty`, `fee_ccy`, `fee_amount` and `liquidity` per fill. Fees are converted to quote
units exactly as `sumFeesQuote` does it
(`src/domain/trading/risk/round-trips.ts:216-233`, used at
`src/features/trading/mode-control/promotion-readiness.service.ts:87`): quote-asset fees subtract
directly, base-asset fees convert at that fill's own price.

Window: `mode = 'testnet'` (the demo lane — `DEMO_MODE = 'testnet'` at
`promotion-readiness.service.ts:16`), from `PROMOTION_EVIDENCE_EPOCH = 2026-07-21T11:21:00Z`. The
first post-epoch fill is 2026-07-23 15:45:22Z, so the epoch bound is non-binding; the window is the
whole book.

```sql
WITH b AS (
  SELECT venue, liquidity, price*qty AS notional,
         CASE WHEN fee_ccy='USDT' THEN fee_amount ELSE fee_amount*price END AS fee_q
  FROM fills
  WHERE mode='testnet'
    AND venue_timestamp >= extract(epoch FROM timestamptz '2026-07-21 11:21:00+00')*1000
)
SELECT venue, count(*) AS fills, round(sum(notional),4) AS traded_notional,
       round(sum(fee_q),8) AS fees_quote,
       round(10000*sum(fee_q)/sum(notional),4) AS bps_per_leg,
       round(2*10000*sum(fee_q)/sum(notional),4) AS bps_per_round_trip
FROM b GROUP BY venue
UNION ALL
SELECT 'ALL', count(*), round(sum(notional),4), round(sum(fee_q),8),
       round(10000*sum(fee_q)/sum(notional),4), round(2*10000*sum(fee_q)/sum(notional),4)
FROM b;
```

| venue | fills | traded notional | fees (quote) | bps/leg | bps/round trip |
| --- | --- | --- | --- | --- | --- |
| `binance` (spot) | 16 | 907.4438 | 0.90744384 | **10.0000** | **20.0000** |
| `binanceusdm` (perp) | 225 | 5276.5892 | 1.96649265 | **3.7268** | **7.4537** |
| **ALL** | 241 | 6184.0331 | 2.87393649 | **4.6473** | **9.2947** |

`bps_per_round_trip` is `2 ×` the per-leg rate — a round trip is two legs of approximately equal
notional. It is an approximation only in that the two legs' notionals differ by the price move.

The per-fill rates are exact venue-schedule constants, not noise. Same query grouped by
`venue, liquidity` and by the per-fill rate:

| venue | liquidity | bps/leg | fills | notional |
| --- | --- | --- | --- | --- |
| `binance` | maker | 10.000 | 3 | 160.41 |
| `binance` | taker | 10.000 | 13 | 747.04 |
| `binanceusdm` | maker | 2.000 | 156 | 1670.74 |
| `binanceusdm` | taker | 4.000 | 41 | 1705.79 |
| `binanceusdm` | taker | 5.000 | 28 | 1900.06 |

**Reading.** The demo spot venue charges exactly 10 bps per leg with maker = taker — precisely the
schedule `edge-verdict-2026-08-10.md:93` asserts, and precisely what
`research/loop/archive/LOG-through-pass-47.md:2126` measured on 2026-07-12 (*"demo fees are REAL,
exactly 10bps per leg, maker=taker, no discount (measured from the fills table…)"*). **That
measurement was correct when taken and is now unrepresentative**: the book has since become 93% perp
by fill count and 85% by notional, and the perp venue charges 2 bps maker / 4–5 bps taker. The
program carried the spot-only schedule forward as if it were the book's schedule.

### Slippage is not the missing component

Tested as a candidate for the unexplained residual, since *"BEST achievable cost structure"* could
mean fees plus execution slippage. Signed slippage of fill price against the intent's `ref_price`,
split by `reduce_only` and order type:

| reduce_only | type | legs | mean lag (s) | notional-wtd slippage (bps) |
| --- | --- | --- | --- | --- |
| f | LIMIT | 74 | 6.9 | **+0.333** |
| f | LIMIT_MAKER | 86 | 694.8 | −6.565 |
| t | LIMIT | 71 | 1913.5 | −67.996 |
| t | STOP_LOSS_LIMIT | 4 | 25251.0 | +221.831 |
| t | STOP_MARKET | 6 | 23243.0 | +123.436 |

Only the first row is a slippage measurement. The rest have fill lags of 12 minutes to 7 hours, so
`ref_price` is stale and the figure is position PnL, not execution cost. On the marketable entry legs
(74 fills, 6.9 s mean lag) realised slippage is **+0.33 bps per leg** — negligible. Slippage does not
supply the ~3.7 bps gap between the measured 9.29 bps round trip and the asserted +13.0 floor.

## 3. Reconciling `:37` against `:93`

The two figures in `edge-verdict-2026-08-10.md` are 5× apart. They are measuring three different
things at once, and the 5× decomposes cleanly.

- **`:93` — "flat 20 bps per round trip (10 bps per leg, maker = taker — the verified demo venue
  schedule)"** is a **published-schedule, per-round-trip, spot-only** figure. Verified exact for
  `binance` spot (§ 2). It is not the schedule of the venue that carries 85% of the book.
- **`:37` — "Measured fees as fraction of traded notional | ≈4 bps"** is a **realised, per-leg,
  whole-book** figure. `traded notional` sums every fill, so both legs of a round trip appear in the
  denominator; dividing total fees by it yields a per-**leg** rate.

Reproducing `:37` at the study's freeze time (fills before 2026-07-27T12:00:00Z):

```sql
WITH b AS (
  SELECT price*qty AS notional,
         CASE WHEN fee_ccy='USDT' THEN fee_amount ELSE fee_amount*price END AS fee_q,
         CASE WHEN fee_ccy='USDT' THEN fee_amount ELSE 0 END AS fee_usdt_only
  FROM fills
  WHERE mode='testnet'
    AND venue_timestamp >= extract(epoch FROM timestamptz '2026-07-21 11:21:00+00')*1000
    AND venue_timestamp <  extract(epoch FROM timestamptz '2026-07-27 12:00:00+00')*1000
)
SELECT round(10000*sum(fee_q)/sum(notional),3)         AS all_fees_over_all_legs,
       round(10000*sum(fee_usdt_only)/sum(notional),3) AS usdt_fees_only_over_all_legs,
       round(sum(fee_q),4) AS fees_quote, round(sum(notional),2) AS traded_notional
FROM b;
```

```text
 all_fees_over_all_legs | usdt_fees_only_over_all_legs | fees_quote | traded_notional
------------------------+------------------------------+------------+-----------------
                  4.754 |                        3.964 |     1.7999 |         3785.96
```

The correct per-leg figure at freeze time is **4.754 bps**. The stated "≈4 bps" matches **3.964**,
the variant that drops base-asset fees from the numerator while keeping full notional in the
denominator — the spot legs pay in AAVE / BTC / SOL / ZEC, which `sumFeesQuote` converts but a naive
`fee_ccy='USDT'` sum does not. That is a reconstruction of the likely method, offered because it
matches to the stated precision; `:37` documents no method, so it cannot be confirmed.

**The 5× gap, decomposed:**

```text
20.0 bps (:93)  =  4.6473 bps (:37 corrected, per leg)
                   × 2.0000   (per leg → per round trip)
                   × 2.1518   (spot-only 10 bps/leg schedule ÷ blended 4.6473 bps/leg actual)
                =  20.0000 bps
```

So: **a factor of 2 is per-leg versus per-round-trip, and a factor of 2.15 is applying the spot
venue's schedule to a book that is overwhelmingly perp.** Neither figure is a maker-rebate effect —
there are no negative fees in the book — and neither is a paid-versus-published discrepancy: the
demo venue charges its published schedule to four decimal places on both venues. All three candidate
explanations named in the brief were tested; two (per-leg vs per-round-trip, different denominator)
are confirmed contributors, and maker rebates are ruled out.

## 4. What the floor should be, if it were derived

On the measured book, the demo break-even gross edge is:

```text
fees        9.2947 bps/round trip  (§ 2, measured)
slippage  + 0.67   bps/round trip  (2 × 0.333, marketable entry legs only)
          ------
          ≈ 9.96   bps/round trip
```

against an asserted **+13.0**. The floor is therefore **conservative by roughly 3 bps** — it demands
more edge than the venue actually costs. It is mis-derived, but in the safe direction.

The **+24.2 live** figure cannot be measured: there is no live book, and this repo holds no
authoritative live fee schedule. What can be said is structural — `24.2 − 20.0 = 4.2`, and the live
figure carries the parenthetical *"(live 20 bps)"* at `verdicts.md:348-349`, so it appears to be the
spot round-trip schedule plus an unexplained 4.2 bps. **Flagged, not concluded**: if that 4.2 is the
"≈4 bps" measured fee figure from `:37`, the live floor double-counts fees. No evidence in the repo
confirms or refutes this, and the arithmetic coincidence is not proof.

## 5. Does anything move? No

**It does not.** The floor sits on one side of a gap that is an order of magnitude larger than any
fee correction.

**The gap, as the program states it** (`verdicts.md:345-350`): gross realised **−101.9 bps/trip**
(n=23), or **−106.0** (n=27, marking the four open cycles). The stated gap of "115–130 bps/trip"
reproduces exactly as the two endpoints:

```text
101.9 + 13.0 = 114.9  →  115   (best case: n=23, demo floor)
106.0 + 24.2 = 130.2  →  130   (worst case: n=27, live floor)
```

**The gap under the corrected floor:**

```text
101.9 +  9.29 = 111.2   (best case: n=23, measured demo floor)
106.0 + 20.00 = 126.0   (worst case: n=27, spot-schedule live floor)
```

The gap moves from **115–130** to **111–126** bps/trip: a change of **≈4 bps on a gap exceeding
110 bps**. The verdict at `verdicts.md:345-350` — *"Do not propose cost work as a profitability
lever"* — is strengthened, not weakened. Correcting the floor removes 3.7 bps of a 115 bps deficit.

**No playbook-space cell flips.** The research bar (`verdicts.md:22`) requires the mean **and** the
bootstrap 95% CI lower bound above the floor. The measured CI lower bounds are h=24 **−12.2** and h=8
**+1.1** (`verdicts.md:46`), both below 9.29 as well as below 13.0, and
`playbook-space-followon-2026-07-31.md:951` records that no cell *"comes within 25 bps of the +13.0
bar"*. A 3.7 bps reduction in the bar changes no cell's outcome.

## 6. The one place the correction bites — and why the verdict still holds

Stated explicitly rather than buried, because it is the only cell in the program whose clause
outcomes change.

`verdicts.md:243-244`, on the inversion test's h=1 arm:

> **h=1 FAILS the fee**: +16.9 gross against a 20 bps round trip is **−3.1 net**, and the bootstrap
> lower bound (+10.9) sits under even the optimistic +13.0 bps demo-fee requirement.

Both halves of that sentence change under the measured demo cost:

```text
net at the asserted flat 20 bps :  +16.9 − 20.00 = −3.1   (as recorded)
net at the measured demo cost   :  +16.9 −  9.29 = +7.6   (sign flips)

CI lower bound   +10.9  vs  floor 13.00  →  FAILS  (as recorded)
CI lower bound   +10.9  vs  floor  9.29  →  clears
```

So the mean clause and the CI-lower-bound clause both clear a corrected demo floor, where at +13.0
the CI clause failed. **The verdict does not move**, for reasons that are independent of the floor:

1. **The verdict's grounds are tautology, not fees.** `verdicts.md:236-242` rules the inversion test
   NOT A FINDING because negating every observation *"negates the mean and mirrors the CI, the
   t-statistic, both chronological halves and the placebo p by construction — a run that did NOT
   reproduce them would mean the harness was broken."* Lowering a bar cannot convert an arithmetic
   mirror into evidence. `playbook-space-replay-2026-07-28.md:213-216` says the same and calls the
   arm's lead *"mostly a tautology"*.
2. **Two clauses are not the bar.** The research bar (`verdicts.md:22`) also requires `p` against the
   bar under the pre-registered Bonferroni α, the random-bar placebo, both chronological halves and
   the trimmed mean. `p vs bar` has never been computed against 9.29 for this arm, and the placebo p
   mirrors by construction. **No pass can be claimed**, only that two clauses change state.
3. **The standing prohibitions are unaffected.** `verdicts.md:241` — *"Do NOT cite +66.5 bps, or any
   inverted figure, as an edge"* — and `verdicts.md:245-249` (n=61, a single ~4-day regime, a mixture
   over ~9 playbook versions, and adverse selection that may not invert) all stand untouched.

The honest statement is: **the floor may be mis-derived, and no existing verdict changes.** One
supporting sub-clause inside one already-negative verdict is arithmetically wrong and needs
amending (§ 7).

## 7. Amendments required

None of these change a verdict; they correct arithmetic that is currently wrong on its face.

1. `research/loop/verdicts.md:243-244` — the `−3.1 net` figure and the *"sits under even the
   optimistic +13.0"* clause are both computed on cost bases the demo book does not charge. Amendment
   text is in the return note for this study.
2. `research/loop/verdicts.md:348-349` — the +13.0 / +24.2 pair should be marked as **asserted, not
   derived**, with the measured demo cost recorded alongside it.
3. `research/studies/edge-verdict-2026-08-10.md:93` — the frozen cost model of a completed
   pre-registered study. **Do not edit it.** The 20 bps assumption is conservative (it overstates
   demo cost by 2.15×) and every arm in that study was negative, so the assumption cannot have
   manufactured its result. Note the discrepancy here and leave the preregistration frozen.
4. `scripts/loop-authoring-core.mjs:519-522` — the claim that a flat 20 bps *"appears nowhere in this
   program's own cost model"* is false (`edge-verdict-2026-08-10.md:93`), and the comment asserts
   provenance for 13.0/24.2 that does not exist.
5. `research/studies/entry-rate-rederivation-2026-07-30.md:247-248` — the citation `verdicts.md:202-203`
   points at the Moonshot HTTP-200 verdict; the fee floor is at `verdicts.md:346-350`.

## What this study does not claim

- It does not claim the floor should be changed to 9.29 in code. `REQUIRED_EDGE_BPS` and
  `COST_FLOOR_BPS` are pre-registered bars in live studies; lowering a bar after seeing results is
  exactly what this program's preregistration discipline forbids. Any change is a new dated
  pre-registration, and the current value errs conservative.
- It does not measure a live fee rate. There is no live book.
- It does not revisit the ENTRIES verdict, the NO_SURVIVOR verdict, or any deployment decision.

## Amendment 2026-08-03 — the blend describes no trip anyone took

*Appended, not merged. Nothing above this line is edited.* This amendment restates § 2's single
blended figure as two venue floors, replaces the `× 2` leg-to-trip conversion with the exact
per-cycle rule wherever a cycle closes, censuses the one place a liquidity label could be wrong, and
records a sourcing decision for `src/domain/trading/fees.ts`.

**As-of** 2026-08-03T22:00Z, HEAD `4eeefd5`. Same predicate as § 2 (`mode='testnet'`,
`venue_timestamp >= 1784632860000`); the population has grown from 241 fills to **295**.

### A0. Bottom line

| Question | Answer |
| --- | --- |
| Is **9.2947 bps/round trip** still the book's cost? | On today's population the same construction gives **8.5579** (× 2 leg) / **8.6476** (exact, closed cycles). But the staleness is not the point. |
| What *is* the point? | **The blend describes no trip anyone took.** Of 49 closed round trips, 42 cost 4.00–10.00 bps and 7 cost exactly 20.00. Exactly **one** lies within 1 bps of 9.2947. |
| The two venue floors, separately? | `binance` spot **20.0000 bps/trip, exact** (16 fills, $907.4438). `binanceusdm` perp **7.1669 bps/trip** under the observed leg mix (279 fills, $7,366.3134). |
| Could the `× 2` conversion be replaced with the exact rule? | **Yes — the production `walkRoundTrips` was driven, not reimplemented** (§ A3). 49 cycles closed. |
| How much did `× 2` cost? | **Nothing, in aggregate** — `Σf / (Σt/2)` is algebraically `2Σf / Σt`. Its errors are *population* (0.09 bps) and *dispersion* (4.00 to 20.00 bps across cycles). |
| Is the ccxt `takerOrMaker` default a measurement risk? | **Bounded at 13 fills / 4.4% of count / 9.0% of notional, all on the venue where maker = taker, so the measured effect is exactly zero.** On perp, 279 of 279 labels are corroborated by the fee actually charged (§ A4). |
| Does any verdict move? | **No.** § 5's gap moves from 111–126 to ~111–126 bps/trip; a 0.6 bps change on a 110 bps deficit. |

### A1. The venue split, restated on 295 fills

Conversion rule upgraded to the production one — `fee_ccy` compared against *the symbol's own*
quote/base (`round-trips.ts:99-114, 226-231`) rather than the literal `'USDT'` § 2 used. On this book
the two agree to twelve decimals (`Σ = 3.5403182844` either way) because every traded symbol quotes
in USDT; the general form is stated so a future non-USDT pair does not silently fall through.

```sql
WITH b AS (
  SELECT venue, liquidity, price*qty AS notional,
         CASE WHEN fee_ccy = split_part(split_part(symbol,'/',2),':',1) THEN fee_amount
              WHEN fee_ccy = split_part(symbol,'/',1)                   THEN fee_amount*price
              ELSE NULL END AS fee_q
  FROM fills
  WHERE mode='testnet' AND venue_timestamp >= 1784632860000
)
SELECT venue, liquidity, count(*), round(sum(notional),4), round(sum(fee_q),8),
       round(10000*sum(fee_q)/sum(notional),6) FROM b GROUP BY venue, liquidity;
```

| venue | liquidity | fills | notional (USDT) | fees (quote) | bps/leg |
| --- | --- | --- | --- | --- | --- |
| `binance` | maker | 3 | 160.4085 | 0.16040852 | **10.000000** |
| `binance` | taker | 13 | 747.0353 | 0.74703532 | **10.000000** |
| `binanceusdm` | maker | 194 | 2779.3401 | 0.55586736 | **1.999998** |
| `binanceusdm` | taker | 85 | 4586.9732 | 2.07700708 | **4.528056** |
| `binance` | all | 16 | 907.4438 | 0.90744384 | **10.000000** |
| `binanceusdm` | all | 279 | 7366.3134 | 2.63287444 | **3.574209** |
| **ALL** | all | **295** | **8273.7572** | **3.54031828** | **4.278973** |

Perp notional share: **7366.3134 / 8273.7572 = 89.0323%** — up from the 85% § 2 recorded.

**Per-fill tiers, because the blends above hide a two-tier schedule.** Spot is exactly 10.0000 on all
16 fills. Perp maker is 2.0000 on 193 fills and 1.9999 on one (a $0.57 fill, rounding). Perp taker is
**4.0000 on 47 fills / $2,164.79** and **5.0000 on 38 fills / $2,422.18** — 8 symbols on the 4 bps
tier, 3 on the 5 bps tier. The blended 4.528056 is therefore a *notional-weighted mix of two exact
constants*, and it moves whenever the symbol mix moves. Count-weighted it is 4.4471.

**Reconciling the 4.5787 restatement.** `exit-attribution-restated-2026-08-03.md:75` reports perp
taker at **4.5787** over 59 fills. That is **the same quantity over a narrower population**, and it
reproduces exactly by restricting to that study's own frozen window
`[1784632860000, 2026-07-27T16:00:00Z)`:

| venue | liquidity | fills | notional | bps/leg |
| --- | --- | --- | --- | --- |
| `binance` | maker | 2 | 79.96 | 10.0000 |
| `binance` | taker | 8 | 393.47 | 10.0000 |
| `binanceusdm` | maker | 106 | 1044.92 | 2.0000 |
| `binanceusdm` | taker | 59 | 2733.25 | **4.5787** |

175 fills, matching that study's declared population exactly. **Neither figure is wrong and neither
supersedes the other**; the perp taker rate is a mix, 4.5787 is its value on the 175-fill window and
4.5281 its value on the 295-fill book. A study must state which.

### A2. Per-venue floors, and the perp round trip under a stated leg mix

**`binance` spot: 20.0000 bps per round trip, exact.** Maker = taker = 10.0000, so every leg mix
gives the same answer and there is nothing to choose. All 7 closed spot cycles measure exactly
20.0000 (§ A3), with zero dispersion. **The 10/10 spot entry in `src/domain/trading/fees.ts` is
correct as shipped.**

**`binanceusdm` perp: 7.1669 bps per round trip** under the observed leg mix. Measured by splitting
legs on the intent's `reduce_only` flag — an opening leg and a closing leg are different populations
with different liquidity habits, and averaging them is what hides the mix:

| venue | leg | legs | notional | bps/leg |
| --- | --- | --- | --- | --- |
| `binanceusdm` | opening (`reduce_only = f`) | 186 | 3764.13 | **3.1639** |
| `binanceusdm` | closing (`reduce_only = t`) | 93 | 3602.18 | **4.0030** |
| `binance` | opening | 8 | 458.20 | 10.0000 |
| `binance` | closing | 8 | 449.24 | 10.0000 |

**The mix, stated rather than assumed:** perp opening legs are **160 maker / 26 taker** by count
(86.0% maker) and 53.2% maker by notional; perp closing legs are **34 maker / 59 taker** by count
(36.6% maker) and 21.6% maker by notional. The lane enters mostly passive and exits mostly
aggressive — which is what a stop-driven exit population looks like, and it is why the closing leg
costs 27% more than the opening one.

Alternatives, so the choice above is visible rather than buried:

| basis | perp bps/round trip | comment |
| --- | --- | --- |
| **observed leg mix (recommended)** | **7.1669** | opening 3.1639 + closing 4.0030, both measured |
| `2 ×` blended leg rate | 7.1484 | § 2's method on today's perp population |
| exact per-cycle, 42 closed cycles | 7.2182 | § A3 |
| `roundTripBps` model (one maker + one taker) | 6.5281 | `2.0000 + 4.5281`; **0.64 bps optimistic** |
| all-taker | 9.0561 | the pessimistic bound |
| all-maker | 4.0000 | the optimistic bound |

The five plausible bases span 6.53 to 7.22 bps — a 0.69 bps spread, which is under 6% of the smallest
figure. **The venue split matters (20.00 vs 7.17); the choice of leg mix inside a venue does not.**

### A3. The exact per-cycle rule — the production walk WAS driven

`walkRoundTrips` was **imported and executed**, never reimplemented, so this cannot become a second
source of truth for the number the promotion gate returns.

**Method.** `PromotionStatsRepository.fillsForMode('testnet', 1784632860000)`
(`src/database/repositories/trading/promotion-stats.repository.ts:46-85`) reproduced as SQL — same
`LEFT JOIN order_intents ON fills.intent_id`, same projection, same
`ORDER BY venue_timestamp ASC, fill_id ASC` — dumped to JSON and handed to
`walkRoundTrips(rows, new Decimal('5'))` from `src/domain/trading/risk/round-trips.ts`, with
`dustNotional = 5` from `PROMOTION_DUST_NOTIONAL` (`environment.config.ts:538`, `.env.app:179`).
Per-cycle cost is `feesQuote / (turnover / 2)`, where `turnover = entryVwap × boughtQty +
exitVwap × soldQty` — i.e. the cycle's own two legs, not a population average.

**Agreement check that makes the rest trustworthy:** the walk reports `unconvertibleFeeAsset = false`
and `sumFeesQuote` over all 295 rows returns **3.5403182844**, matching the § A1 SQL total to ten
decimals. Two independent paths, one number.

| venue | closed cycles | turnover | fees (quote) | weighted bps/trip | mean | median | min | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `binance` | 7 | 907.4438 | 0.90744384 | **20.0000** | 20.0000 | 20.0000 | 20.0000 | 20.0000 |
| `binanceusdm` | 42 | 7206.6498 | 2.60094173 | **7.2182** | 7.1067 | 7.0297 | 4.0000 | 10.0000 |
| **ALL** | **49** | 8114.0936 | 3.50838557 | **8.6476** | 8.9486 | 7.0635 | 4.0000 | 20.0000 |

**What the exact rule actually buys — stated against my own expectation, which was wrong.** The
aggregate weighted figure is *algebraically identical* to `2 ×` the leg rate over the same fills,
because `Σf / (Σt/2) ≡ 2Σf / Σt`. So `× 2` is **not an aggregation error**. Its two real errors are:

1. **Population.** `× 2` over all 295 fills gives 8.5579; over the fills belonging to the 49 closed
   cycles it gives 8.6476. The 0.0897 bps gap is the still-open cycles' $159.66 of notional, which is
   cheaper per unit than the closed book.
2. **Dispersion — the one that matters.** The 49 closed trips, sorted:

   ```text
   4.0000 x7   5.9484 5.9512 5.9655 5.9745 5.9954 6.0055 6.0079 6.0120 6.0144
   7.0115 7.0128 7.0171 7.0253 7.0290 7.0304 7.0444 7.0616 7.0635
   8.0000 x8   9.3098   10.0000 x8   20.0000 x7
   ```

   **Exactly one of 49 closed round trips lies within 1 bps of 9.2947** — a HYPE/USDT:USDT cycle at
   9.3098. Seven cost exactly 20.0000 and forty-two cost 4.00–10.00. A single blended scalar sits in
   the empty gap between two venue clusters and describes neither.

**So § 2's headline restates as:** the demo book's realised cost is **20.0000 bps/trip on spot and
7.17–7.22 bps/trip on perp**, over a book that is 89.0% perp by notional. The whole-book scalar, if
one is still wanted, is **8.5579** (`× 2` leg, 295 fills) or **8.6476** (exact, 49 cycles). Quoting
it without the split is the error § 2 identified in `edge-verdict-2026-08-10.md:93` and then
committed in its own way.

**No verdict moves.** § 5's gap endpoints become `101.9 + 8.65 = 110.6` and `106.0 + 20.00 = 126.0`
against the recorded 111–126: a change of 0.6 bps on a deficit exceeding 110. § 6's h=1 arithmetic
moves in the same direction it already moved (its population is 20 of 23 trips perp, so its true cost
is nearer 7.17 than 9.29, and both clauses already cleared at 9.29). § 4's "conservative by roughly
3 bps" becomes conservative by roughly 4 bps. Nothing here is a reason to change a pre-registered
bar, and § What this study does not claim binds unchanged.

### A4. Census — the ccxt liquidity default

`src/features/venue/exchange/ccxt-normalize.ts:109-110`:

```text
// takerOrMaker can be absent; default to 'taker' as the conservative assumption for fees.
const liquidity: 'maker' | 'taker' = t.takerOrMaker === 'maker' ? 'maker' : 'taker';
```

Any absent, empty or unexpected value silently becomes `'taker'`.

**Exposure is total, so the question is worth asking.** All 295 fills carry `source =
'rest_reconcile'`; zero `ws`, zero `paper`. Every `rest_reconcile` writer
(`reconciliation.service.ts:1472`, `unknown-resolver.service.ts:724`,
`demo-fill-poller.service.ts:184`, `algo-stop-recovery.service.ts:311`) is fed by
`CcxtExchangeAdapter.fetchMyTrades` → `normalizeTrade` (`ccxt-exchange.adapter.ts:216`). **100% of
the book's liquidity labels came through that one line.**

The database stores only the resolved value, so a defaulted label is not directly countable. **The
fee actually charged is an independent witness wherever the two rates differ:**

| venue | can the fee falsify the label? | result |
| --- | --- | --- |
| `binanceusdm` | **Yes** — maker 2.0000 vs taker 4.0000/5.0000 | **0 of 279 misattributed.** No `taker`-labelled perp fill is charged 2.0000; no `maker`-labelled one is charged 4 or 5. |
| `binance` | **No** — maker = taker = 10.0000 | **13 `taker` fills unfalsifiable** = 4.4% of fills, 9.0% of notional ($747.0353 of $8,273.7572). |

Two further facts that bound it:

- The 3 spot `maker` fills prove `takerOrMaker` *is* populated at least sometimes on spot — the
  default can only ever produce `taker`, so a universally-absent field is ruled out.
- **The measured effect on every maker/taker split in this study is exactly zero.** Worst case — all
  13 spot takers are defaulted makers — moves spot to 16 maker / 0 taker at an unchanged 10.0000
  bps/leg and moves no other number at all.

**The defect is latent, and its failure direction is asymmetric.** `taker` is genuinely conservative
for a *cost floor* on a venue whose taker ≥ maker, which is what the comment claims. It is **not**
conservative for a maker-rebate schedule — a negative maker fee booked as a positive taker fee turns
a credit into a charge — and it is not conservative at all for a consumer that reads `liquidity` as
*execution style* rather than cost. § A2's opening/closing leg mix is exactly such a consumer.
**Surfaced, not actioned, and out of this study's file scope:** making the absent case explicit
rather than silently coerced would remove the whole class, and the perp evidence above says nothing
in the current book depends on it.

### A5. DECISION — how the fee table stays true

`src/domain/trading/fees.ts` shipped this session (`70a2939`) with `VenueFeeSchedule { makerBps,
takerBps, measuredAt, sourceStudy }`, both consumers reading it, and **both venue entries
deliberately carrying 10/10** so behaviour is unchanged. This is the recommendation for how that
table is kept honest. **It edits no source file.**

**Recommended: measured-from-fills domain constants carrying `measuredAt` + `sourceStudy`, refreshed
only by a dated study, with a drift band in `loop:sweep`. Config/env indirection is the wrong home.**

Three reasons, in order of weight:

1. **A venue fee schedule is a fact about the venue, not an operator preference.** Config is the
   right home for what an operator legitimately *chooses* per deployment — `SIZER_EQUITY_CAP`,
   `PROMOTION_DUST_NOTIONAL`, cadence, breaker budgets. A number that is simply *wrong* when it
   disagrees with reality is not a knob, and making it one invites someone to tune it. There is no
   deployment of this bot for which binance spot charges something other than what binance spot
   charges.
2. **Config invites undated drift, and this program has the worked example.** An env var carries no
   `measuredAt` and no `sourceStudy`. The moment one is edited the provenance that made it checkable
   is gone and the value becomes exactly the kind of free-floating assertion § 1 of this study spent
   its length documenting: +13.0 / +24.2 entered the repo fully formed, and every later citation was
   circular. A constant that carries the query that produced it cannot decay into that, because the
   `sourceStudy` string is a falsifiable claim a reviewer can open.
3. **Config has a lifecycle designed for credentials.** Live secrets are stripped from config by
   design (root `CLAUDE.md` hard rule 3, and `environment.config.ts`'s live-secret stripping). A fee
   schedule routed through that surface inherits a strip-and-reload lifecycle built for keys, not for
   facts — and a *stripped* fee schedule fails in the direction of "no cost model" on the exact
   boundary where cost matters most.

**Concrete shape:**

- Keep `makerBps` / `takerBps` as exact decimal strings and keep `measuredAt` + `sourceStudy` as
  they are. Add nothing else to the type; a schedule with more fields is a schedule people fill in
  from memory.
- A refresh is a **dated study that re-runs § A1's query and edits the constants in the same commit
  that adds the study.** No other path edits them.
- **A drift band in `loop:sweep`, failing OPEN.** Re-measure per-(venue, liquidity) bps from `fills`
  over a trailing window and annotate when the measured rate leaves **±10%** of the table's value.
  *Annotate, never gate* — a fee measurement is a measurement, and a broken measurement must never
  block the trading it measures, which is the same failure direction `loop-forward-return.mjs:6-10`
  declares for itself. The band is wide deliberately: perp taker is a notional-weighted mix of a
  4 bps and a 5 bps tier (§ A1), so it legitimately moves with the symbol mix — a tight band would
  fire on composition and be trained away.
- **The drift check must never auto-edit the table.** An automatic refresh makes the constant
  untraceable in precisely the way this recommendation exists to prevent; the annotation's job is to
  make a human open the study, not to keep a number quietly current.

**Sizing the separate perp enable, so it is not re-derived later.** `roundTripBps` returns 20 bps for
every symbol today. At `{ makerBps: '2', takerBps: '5' }` it returns **7** bps, against a realised
perp round-trip cost of **7.1669** (§ A2) — so the proposed pair is **0.17 bps optimistic**, while
the present 10/10 is **12.83 bps pessimistic** on 89% of the book. **Sizing only. This amendment
does not authorise the flip**, which remains a separately-recorded enable per the header comment in
`fees.ts:27-33`.

### What this amendment cannot answer

- **It closes no round trip the production walk does not close.** 49 cycles closed under the dust
  rule; fills belonging to still-open cycles ($159.66 of notional, $0.0319 of fees) are outside every
  per-cycle number here and inside every leg-level one. That difference is stated, not corrected.
- **It cannot count a defaulted `takerOrMaker`.** The database stores the resolved label. § A4 bounds
  the exposure and proves the perp half is corroborated; it does not observe the raw ccxt field.
- **It measures no live fee rate.** There is no live book, and § 4's +24.2 remains unmeasurable for
  the reason recorded there.
- **It does not re-derive `REQUIRED_EDGE_BPS` or `COST_FLOOR_BPS`,** and lowering a pre-registered
  bar after seeing results remains forbidden. § What this study does not claim binds unchanged.
- **It says nothing about slippage or funding.** § 2's +0.33 bps/leg marketable-entry slippage was
  not re-measured on the larger population.
