# Payload-microstructure subgroup search — PRE-REGISTRATION, 2026-08-04

_Written and frozen BEFORE any scoring code existed and before a single forward return was computed.
Everything above the `## Results` divider was authored first; results are appended below it, unedited
above. A cut chosen after seeing an outcome is worthless, so the cut list, the family list, the
multiplicity denominator, the power gate and the verdict rule are all fixed here._

**Authored:** 2026-08-04. **HEAD at authorship:** `8c753d2`.
**Data as-of for the presence/degeneracy re-verification below:** 2026-08-04, live `cryptobot`
database, read-only via `docker exec crypto-bot-postgres-1 psql`.

## 0. Why this study exists, and what a positive would and would not mean

The standing verdict — _no edge in anything the system records_ — rests on a 1,807-cut subgroup
search whose search space was bounded by **persisted pgTable columns**. Four microstructure channels
plus funding term structure are computed live, rendered into the user message on every consult, and
land in **no table**. That search therefore structurally _could not_ condition on them, and its
negative result carries no evidence about microstructure in either direction.

`agent_decisions.input_payload` embeds those very blocks on every payload-bearing row, so the search
is possible today at **$0** — no API calls, no network, no LLM, historical rows only.

**A powered positive here would LOCALIZE the standing claim, not contradict it.** The claim was
scoped to recorded columns; microstructure is not a recorded column. A hit would say "the negative
verdict is a statement about the persisted feature set, not about the information the model was
shown" — it would not say the earlier search was wrong.

**A null is the expected outcome and is a perfectly good one.** It is reported whichever way it
points.

## 1. Population — frozen

| element | frozen value |
| --- | --- |
| table | `agent_decisions` |
| filter | `action IN ('open_long','open_short') AND trigger_kind='candle' AND strategy_id NOT LIKE 'replay-%' AND input_payload IS NOT NULL` |
| window | **lifetime — no time filter** |
| timestamp column used | **`event_time`** (BIGINT epoch-ms), never `created_at` |
| n at authorship | **94** entries (56 `open_long`, 38 `open_short`) |
| distinct symbols | 17 |
| distinct BASE assets (the cluster unit) | **13** |
| event_time span | 2026-07-22T17:30:00Z → 2026-08-03T21:45:00Z (12.18 days) |
| rows off the 15m bar grid | **0** |

**Which timestamp, and why it matters.** The promotion gate and several sibling instruments filter on
`created_at`; this study uses **`event_time` only**. `event_time` is the OPEN of the 15m bar whose
close the row stamps (verified chain in `scripts/loop-forward-return-core.mjs:16-38`), and the
forward-return anchor is that bar — `created_at` is a write time and is not bar-aligned, so anchoring
on it would silently mislabel every horizon. Both are epoch-ms `BIGINT`, so every constant here is
round-tripped through `to_timestamp(x/1000.0)` before use (the trap recorded in
`research/studies/census-2026-08-03.md`).

**The census's 92 is not stale-wrong, it is earlier.** `census-2026-08-03.md` §3 counted 92 entries
as of 2026-08-03T18:25Z; two further entries landed before this study's read. `n=94` is the count
this pre-registration freezes, and the population is defined by the filter above rather than by the
number, so a later re-read is a re-read of the same definition.

## 2. Family survival — re-verified, not inherited

`census-2026-08-03.md` §4 measured block presence on 92 entry rows and is explicitly census-grade
(text scans that can be inflated by a block name inside a string value). Presence is therefore
**re-verified here on the 94**, and a second, independent gate is applied that the census did not
run: **degeneracy**.

### 2.1 Presence (bar: ≥80% of entry rows)

| block | present / 94 | share | verdict |
| --- | --- | --- | --- |
| `bookStructure` | 94 | 100.0% | **SURVIVES** |
| `liquidation` | 94 | 100.0% | present, but see §2.2 |
| `positioning` | 80 | 85.1% | **SURVIVES** |
| `derivatives` | 80 | 85.1% | **SURVIVES** |
| `fundingHistory` | 80 | 85.1% | **SURVIVES** |
| `tradeFlow` | 14 | 14.9% | **DROPPED — below the 80% bar** |

`tradeFlow`'s exclusion is disclosed here rather than silently averaged: 14.9% presence means a
`tradeFlow` cut would be a cut on _which boot era the entry came from_ (the block is flag-gated per
boot), not on trade flow. The census recorded 15.2% on its 92; the drop stands unchanged on 94.

`fundingHistory` was scored `—` for entry rows in the census (it measured that block only on the full
1,731-payload population). It is measured here for the first time on entries: **80 / 94**. It
survives, and it carries the funding-term-structure channel — see §2.3.

### 2.2 Degeneracy — `liquidation` DROPS despite 100% presence

A block present on every row conveys nothing if its fields never vary. Measured over the 94:

| field | distinct values | content |
| --- | --- | --- |
| `liquidation.liqNotionalUsd` | **1** | `0` on all 94 |
| `liquidation.count` | **1** | `0` on all 94 |
| `liquidation.longShareOfLiqs` | — | **`null` on all 94** |
| `liquidation.windowMin` | **1** | `60` on all 94 (a config constant) |

**`liquidation` is DEGENERATE and drops from the family.** Zero variance means neither a median split
nor a sign split exists — there is no cut to register. This is a finding in its own right and is
recorded, not buried: the model has been shown a constant "no forced liquidations in the trailing 60
minutes" reading on **every one of the 94 entries it ever took**, so whatever that block is costing
in prompt tokens, it has never carried a bit of information into a single entry decision. Whether
that is a dead feed or a genuinely quiet 12 days is outside this study's scope (see §9).

**Four families survive, not five, and not the four the brief named.** `liquidation` is out;
`fundingHistory` is in.

### 2.3 The named derivatives-v2 fields DO NOT EXIST in this population

The channels this study was commissioned to test included _funding trend delta, OI change pct,
spot-perp basis_. Measured over the 94 entry rows:

| field | present / 94 |
| --- | --- |
| `derivatives.spotPerpBasisBps` | **0** |
| `derivatives.oiChangePct` | **0** |
| `derivatives.fundingTrendDelta` | **0** |

All three are gated behind `derivativesV2Enabled` (`agent-prompt.ts:972-979`), which has been OFF for
the entire entry history. **They are not in the data and cannot be scored.** The `derivatives` family
is therefore restricted to the v1 four fields, and the funding-trend channel is **reconstructed from
`fundingHistory`** instead — `predicted − mean(recent)` is the same quantity
`derivatives.fundingTrendDelta` would have carried, computed from the block that does render. That
substitution is declared here, before scoring, and is the reason `fundingHistory` is a family.

## 3. Features — frozen, 8 total

Field names are read from the rendered builders in
`src/features/strategy/agentic/agent-prompt.ts` (`buildBookStructureBlock` :869-940,
`buildDerivativesBlock` :952-981, `buildFundingHistoryBlock` :990-997,
`buildPositioningBlock` :1028-1048) and confirmed against live payload text.

| id | family | feature | definition |
| --- | --- | --- | --- |
| A1 | `bookStructure` | `micropriceBps` | qty-weighted microprice as a bps offset from mid |
| A2 | `bookStructure` | `depthWeightedImbalance10` | linear-decay-weighted top-10 imbalance, −1..1 |
| A3 | `bookStructure` | `depthImbalance25bps` | `(bid − ask) / (bid + ask)` over `bidDepthNotional25bps` / `askDepthNotional25bps` |
| B1 | `positioning` | `longShortRatio` | global long/short ACCOUNT ratio |
| B2 | `positioning` | `takerBuySellRatio` | recent taker buy/sell VOLUME ratio |
| C1 | `derivatives` | `fundingRate` | current funding rate, raw fraction |
| C2 | `derivatives` | `basisBps` | mark/index basis in bps |
| D1 | `fundingHistory` | `fundingTrendDelta` | `predicted − mean(recent)` over the last up-to-3 settled rates |

### 3.1 Fields deliberately EXCLUDED, and why (disclosed, not silently dropped)

**Collinear** — an exact transform of a feature already listed, so scoring it would inflate the
multiplicity denominator with a duplicate rather than test anything new:

- `positioning.longAccountPct`, `positioning.shortAccountPct` — deterministic transforms of B1.
- `derivatives.fundingAnnualizedPct` — an exact linear transform of C1.

**Scale-dominated by symbol identity** — a median split on a raw notional or volume is a split on
_which symbol_ (a BTC book against a NEAR book), not on book or flow state, and the cluster bootstrap
would then be resampling the very thing the cut encodes:

- `bookStructure.bidDepthNotional25bps` / `askDepthNotional25bps` in raw form — entering only through
  the scale-free normalization A3.
- `derivatives.openInterest`; `positioning.takerBuyVol` / `takerSellVol` — the scale-free contrast of
  the latter pair is B2.

**Constant** — `liquidation.*` (§2.2), `fundingHistory.recent` length (3 on every row),
`liquidation.windowMin`.

**Absent** — the three `derivatives` v2 fields (§2.3).

## 4. The frame — direction-aligned, and it is the ONLY frame scored

The population mixes 56 longs and 38 shorts. A raw-feature cut on a mixed population is partly a cut
on **direction**, because the model plausibly enters long when the book is bid-heavy — so a raw
median split would confound "bid-heavy book" with "long trade" and measure the long/short skew of the
window rather than a microstructure effect.

Frozen, for every feature and every cut:

- `dir = +1` for `open_long`, `dir = −1` for `open_short`.
- **Signed feature** `x_s`: the raw value for the neutral-zero features (A1, A2, A3, C1, C2, D1);
  `x − 1` for the neutral-one RATIO features (B1, B2), whose definitional balance point is 1.0
  (equal long/short accounts; equal taker buy/sell volume). One is a definitional neutral, not a
  tuned threshold — no threshold in this document was chosen by looking at an outcome.
- **Aligned feature** `x_a = dir × x_s`. A long with a bid-heavy book and a short with an ask-heavy
  book land in the same cell, which is what makes the two halves of a cut comparable.
- **Outcome** `y = dir × ((c_h − c_0) / c_0) × 10000`, in bps.

**Exactly one frame is scored.** A second (raw-feature) frame would double the multiplicity and
invite reporting whichever frame came out better; it is excluded here so it cannot be added later.

## 5. Cuts — median and sign ONLY

Two cut types per feature. No tuned thresholds, ever.

- **MEDIAN** — `x_a` above vs at-or-below the sample median of `x_a`, computed within that feature's
  own present-population (94 for family A, 80 for B/C/D). Ties: a value exactly equal to the median
  goes to the **LOW** group. Declared here so the tie rule cannot be chosen later.
- **SIGN** — `x_a ≥ 0` vs `x_a < 0`.

## 6. Horizons

`[1, 4, 8, 24]` bars of 15 minutes — ported from `scripts/loop-forward-return-core.mjs:46`
(`HORIZONS`) so this study is scored at the same horizons as every sibling instrument.

## 7. Multiplicity — the denominator, as a number

**8 features × 2 cut types × 4 horizons = 64 cells.**

- Family-wise α = **0.05**.
- **Bonferroni per-cell α = 0.05 / 64 = 0.00078125.**
- Two-sided ⇒ the reported interval per cell is the **99.921875%** cluster-bootstrap interval
  (quantiles 0.000390625 and 0.999609375).

The denominator is 64 and is fixed before any scoring. Adding a feature, a cut type or a horizon
later would change it, which is precisely why all three lists are frozen above.

**Resolution honesty about that interval.** At `N_BOOT = 20000`, the 0.0390625% quantile is order
statistic ~#7.8 of the sorted draws — the corrected endpoint is itself resolution-limited, and at
k ≤ 13 clusters the bootstrap distribution lives on a coarse lattice. The corrected interval is
therefore reported as a **bound**, never as a precision claim.

## 8. Statistics — frozen

| knob | frozen value | provenance |
| --- | --- | --- |
| cluster unit | **BASE asset** (13 available), never the symbol string | `loop-forward-return-core.mjs:76-90` (`MIN_CLUSTERS` rationale) |
| `N_BOOT` | 20000 | `loop-forward-return-core.mjs:93` |
| bootstrap seed | **20260731** | `loop-forward-return-core.mjs:99` |
| `MIN_ENTRIES` | 12 | `loop-forward-return-core.mjs:52` |
| `MIN_CLUSTERS` | 5 | `loop-forward-return-core.mjs:76` |
| `MAX_GAP_SHARE` | 0.2 | `loop-forward-return-core.mjs:110` |
| placebo seed | **20260804** | this study |
| `N_PLACEBO` | 200 | this study |

**Statistic.** `Δ = mean(y | HIGH) − mean(y | LOW)`, in bps.

**Interval.** A **paired-by-resample** cluster bootstrap: each draw resamples the base-asset list WITH
replacement once and applies the SAME resampled list to both groups, then takes the difference of the
two group means. Ported from `pairedClusterBootstrapDelta`
(`loop-forward-return-core.mjs:214-254`) — subtracting two independently-resampled intervals would
overstate the variance of a difference computed on the same rows. Clusters are **sorted before
resampling**, so the frozen seed actually buys byte-identical reruns regardless of psql row order.

**Degenerate draws** — a resample landing entirely on assets absent from one group — are **COUNTED
and reported**, never dropped. Dropping them narrows the interval exactly as if every draw had been
well behaved.

**Power gate, per cell.** A cell is POWERED only if **both** groups satisfy `n ≥ 12` **and**
`clusters ≥ 5`. The two clauses are independent by design: 20 entries concentrated on 3 assets is 3
effective observations for a cluster bootstrap.

**Gap rule.** Applied at the horizon level over the whole population, reusing the core's convention:
non-benign misses are `gap` / `no_series` / `bad_price` / `no_entry_bar`; `pending` (the forward bar
has not happened yet) is benign and excluded from the denominator. A horizon whose non-benign miss
share exceeds 0.2 reads **UNDETERMINED for all 16 of its cells** — gaps are not missing-at-random
(the lane goes down during incidents, which correlate with market events), so the surviving subsample
is a different population, biased toward calm.

**Forward-return anchor.** Anchored on the **decision-bar close**, exactly as
`scripts/loop-forward-return{,-core}.mjs` does: `c_0` is the `agent_decisions.close` stamped at the
entry's own `event_time`, `c_h` is the close at `event_time + h × 900000ms`, looked up **by time
target** and refused (as a `gap`) if the nearest match is more than one bar past target. No fill
price, no fee, no slippage model — the same instrument sits on both sides of every cut, so costs
cancel exactly and adding them would only add noise.

## 9. Placebo — random-bar, frozen

For each entry `i`, the anchor `t0` is replaced by a bar drawn uniformly from **that entry's own
`(venue, symbol)` price series**. The feature value, the cut memberships, the direction and the base
asset all stay attached to entry `i`, unchanged. Group sizes, cluster composition and feature
marginals are therefore **identical** to the real run; only the timing link between the feature and
the return is destroyed.

200 placebo realizations, seed 20260804, no bootstrap (the placebo calibrates the family-wise error
rate, which the bootstrap does not measure). The statistic is
`maxAbsDelta = max over the 64 cells of |Δ|`.

**Family-wise placebo p** = `(1 + #{realizations with maxAbsDelta ≥ observed maxAbsDelta}) / (1 + 200)`.

## 10. The verdict rule — frozen before scoring

A cell is **POSITIVE** only when all three hold:

1. it is POWERED (§8), and
2. its 99.921875% paired cluster-bootstrap interval **excludes 0**, and
3. the family-wise placebo p ≤ 0.05.

Anything else is **NULL** or **UNDERPOWERED**. There is no fourth category and no "suggestive".

## 11. Power honesty, stated up front

With n ≈ 94 entries, a median split yields cells of **n ≈ 47** and **k ≤ 13** base-asset clusters —
and for families B/C/D, n ≈ 40 per cell. At that size the detectable effect is on the order of the
full-sample CI width, before the ×64 Bonferroni correction widens the per-cell interval further.

**The registered deliverable is therefore BOUNDS and DIRECTION-CONSISTENCY, not a deployable
filter.** No result in this document may be turned into a live entry filter, and none of it is
intended to be.

### How a "PRESENT but underpowered" cell reads — verbatim, and this wording is binding

> Recorded, not evidence; no point estimate may be quoted; the cell re-reads when it reaches n ≥ 12
> and k ≥ 5, and this pre-registration's α already covers that re-read.

That last clause is the point: the re-read is pre-paid out of the 64-cell denominator fixed in §7, so
accumulating more entries and looking again cannot become silent multiple testing later.

## 12. Implementation contract

- Spec: `test/backtest/payload-subgroup.spec.ts`, DB-gated exactly like `test/backtest/frame-audit.spec.ts:36-38`
  — `describe.skipIf(!RUN || !DB_URL)`, read-only `pg.Pool`, self-skipping so a clean clone stays
  green. Flag: `PAYLOAD_SUBGROUP=1`. **Off the production test gate** (`pnpm test` covers
  `test/features test/domain test/ports test/livegate`; this lives under `test/backtest`).
- Pure extraction + statistics: `test/backtest/payload-features.ts`.
- **`input_payload` is a `TEXT` column, not `jsonb`.** A bare `::jsonb` cast throws on the first
  unparseable row and takes the whole read with it, so parsing happens in JS inside a guard and
  **unparseable rows are reported as a named count**, never dropped silently.
- Read-only throughout: no write, no migration, never `DB_SUITE_ALLOW_RESET`.
- $0: no API calls, no network, no LLM.

## 13. What this study cannot answer

- **Whether any of this is deployable.** §11 — the deliverable is bounds; n ≈ 94 over 12.2 days
  cannot support an entry filter, and a POSITIVE cell under §10 would license a re-read, not a change
  to the lane.
- **Whether the model USED the block.** It measures whether the block's value at entry time separates
  forward returns. A block the model ignored entirely would look identical to one it used badly.
- **Anything about `tradeFlow`.** 14.9% presence (§2.1). It is not scored, and its absence from the
  results is not evidence about trade flow.
- **Anything about the three `derivatives` v2 fields.** They were never rendered on a single entry
  row (§2.3). D1 reconstructs the funding-trend channel from a different block; it is not the same
  measurement the absent field would have been.
- **Whether `liquidation` is a dead feed or a quiet market.** §2.2 establishes only that the field is
  constant across all 94 entries. Distinguishing a broken stream from 12 genuinely quiet days needs
  the feed's own health record, which this study does not read.
- **Selection into the population.** These are the bars the lane CHOSE to enter on, not a random
  sample of bars. Any effect found is conditional on the model's own entry selection, and the study
  cannot separate a microstructure effect from a selection effect.
- **Whether the standing no-edge verdict is right.** A positive would localize its scope (§0); a null
  adds a channel to the set it already covers. Neither outcome adjudicates the verdict itself.
- **Costs, fills, slippage, or PnL.** The outcome is a mid-to-mid forward return on the decision-bar
  close (§8). It is not a tradeable return and must never be quoted as one.

---

## Results

_Appended after execution. Nothing above this divider was edited after the scoring code was written._

Filled in below on 2026-08-04 after `PAYLOAD_SUBGROUP=1` ran against the live database.
</content>
