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
