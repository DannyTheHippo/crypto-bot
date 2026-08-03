# Out-of-sample SESSION arm — preregistration (2026-08-03)

Frozen before the first scored read. **No read has been scored by this document.** The arm, its
eligibility rule, its cluster unit, its imported constants, its primary and secondary statistics,
its multiplicity denominator, its row-window bookkeeping, its VOID conditions and its scope limits
below cannot change after a result is seen. Any later variation is a new registered trial.

**Amendments are appended and dated; the original text is never edited away.** That is this
program's standing discipline (`research/loop/charter.md` § Gate-override audit — change-discipline
binds every change: pre-register, record what/why, never rewrite history), and it is why the
predecessors this document models on carry their retractions as new sections rather than as edits:
[`playbook-space-followon-2026-07-31.md`](playbook-space-followon-2026-07-31.md) § The sonnet rate
rise, [`entry-rate-rederivation-2026-07-30.md`](entry-rate-rederivation-2026-07-30.md) § 9.

House form: [`edge-tournament-preregistration-2026-07-24.md`](edge-tournament-preregistration-2026-07-24.md)
and [`playbook-space-followon-2026-07-31.md`](playbook-space-followon-2026-07-31.md).

## What the arm is

A **standing out-of-sample arm** in which a Claude _session_ — this agent harness, on the owner's
subscription, effectively free at the margin and running a substantially more capable model than the
one the bot runs — decides on **recorded market payloads**, blind to the live lane's answer for the
same rows. The session's decisions are scored against the live lane's recorded decisions.

Three properties of the arm, stated first because they set every limit below:

- **It is a session, not an API path.** Nothing measured here is a measurement of any model served
  through the Anthropic API, and the arm can never become one (§ What NEITHER outcome supports).
- **It is free at the margin**, which is the only reason a standing arm is affordable at all. Every
  paid arm this program has run was budget-limited to one or two cells
  (`playbook-space-followon-2026-07-31.md` § The funded ladder: Family A funds **one** scored arm at
  $6.80). This one is limited by _time_ and by the _universe_, not by dollars — and those two limits
  point in opposite directions, which is the whole design (§ Rows accrue with time; clusters do not).
- **It cannot be put in the decide path.** See § The one seam, and § This arm is NOT the
  charter-mandated decide-model instrument.

**What it is FOR, stated once here and unpacked in § FAIL:** it is a **ceiling probe on the
payload**, not a verdict on the model axis. If a substantially more capable reasoner, given the same
recorded payloads under the same schema and floor constraints, decides no differently and lands no
better, that bounds what is extractable from **these bytes** — which is the question 4,562 backtests
and a 1,807-cut adversarial search have already answered by non-LLM means, and which reading ability
is the one remaining untried route into.

## THIS ARM IS NOT POWERED AS A MODEL-AXIS TEST ON RETURNS, AND NEVER WILL BE

This section stands before the design because a reader who finishes this document able to mistake
the arm for a test that could resolve "is the bigger model a better decider?" on forward return has
read it wrong, and every later section depends on that not happening.

### The measured size of a decide-model effect

Every decide-model contrast this program has run at h=24, on the incumbent's own playbook text and
on identical rows:

| contrast | h=24 means | effect | source |
| --- | --- | --- | --- |
| sonnet-5 vs kimi-k3, `champion_v8` | **−70.1** vs **−66.1** | **4.0 bps** | `verdicts.md:188-189` |
| sonnet-5 `champion_v8` vs `haiku_single` | **−70.10** vs **−80.30** | **10.20 bps** | `playbook-space-followon-2026-07-31.md` § CONTROL, § DEPLOYMENT bar |

**Measured decide-model effects on the forward-return axis are 4–10 bps.** That is the quantity this
arm would have to resolve, and the next subsection is the arithmetic that says it cannot.

### The arithmetic

The one input is the recorded h=24 cluster standard error. It is read, not assumed:
**SE = 30.51 bps at 20 clusters**, taken off `inverted`'s own bootstrap interval at n=117 / 20
clusters (`playbook-space-followon-2026-07-31.md` § Power — computed there as `(mean − CI_lo)/1.96`).

Per-cluster standard deviation:

```text
sigma = SE * sqrt(k) = 30.51 * sqrt(20) = 30.51 * 4.47214 = 136.44 bps
```

Both arms score the **same rows**, so the contrast is a paired one-sample statistic over the same
clusters. Required cluster count to detect a difference of `delta` at two-sided alpha = 0.05 and 80%
power (`z = 1.9600 + 0.8416 = 2.8016`):

```text
k = (2.8016)^2 * sigma^2 / delta^2 = 7.8490 * 18,615.9 / delta^2
```

| delta to detect | required clusters `k` | vs a 28-asset universe |
| --- | --- | --- |
| **10.0 bps** (round figure) | **1,461** | **52x the universe** |
| 10.20 bps (measured haiku vs sonnet) | 1,404 | 50x |
| 4.0 bps (measured sonnet vs kimi) | **9,132** | **326x** |

Read the other way — the smallest model effect that is detectable **at the universe ceiling of 28
clusters**, on the same convention:

```text
delta_min(28) = 2.8016 * 136.44 / sqrt(28) = 382.25 / 5.29150 = 72.24 bps
```

**Roughly +72 bps — about 7x the largest decide-model effect ever measured here, and 18x the
sonnet-vs-kimi effect.** And 28 is a _ceiling_, not an achievable number: it requires every base
asset in the universe to carry a scored entry in the window.

Two things make the table _generous_ to the arm and are stated so nobody softens them later:

- **The convention above is the loosest one in normal use.** At this arm's own declared
  alpha = 8.33e-3 (§ Multiplicity), `z = 2.639 + 0.8416 = 3.4806`, and the required `k` at
  delta = 10 bps rises to **2,255** while `delta_min(28)` rises to **89.7 bps**.
- **The pairing is assumed perfect.** An unpaired two-sample comparison doubles every `k` in the
  table (2,922 at delta = 10 bps; 18,265 at delta = 4 bps).

**The figure carried in the arm's own specification is ~1,288 clusters at delta = 10 bps.** My
derivation from the recorded SE lands at **1,461** under the stated convention, and I could not
recover the alpha/power convention that reproduces 1,288 exactly — recorded as **SUPPLIED**, not
re-derived (§ Figures this document could not verify). The two differ by 12%; both are two orders of
magnitude past 28, and no choice between them changes any decision anyone would make.

### Rows accrue with time; clusters do not

This is the structural reason the arm is aimed where it is aimed.

- **Cluster count is capped by the universe**, at 28 distinct base assets. Waiting longer adds rows
  to existing clusters; it does not add clusters. A cluster-limited bar is therefore **not fixable by
  running the arm longer** — running it for a year and running it for a week hit the same ceiling.
- **Row count is capped only by time.** A row-level statistic that needs several hundred observations
  is reachable in days at any plausible cadence.

This is not a new observation in this program, and it is already on record for a different quantity:
`STATUS.md:164-168` records that the +13.0 bps research bar at h=1/4 is **unreachable at ANY cluster
count** and that h=8/24 need 64–219 clusters against the same universe. **This arm inherits that
finding rather than re-deriving it, and adds only the model-axis instance of it.**

**So the arm is aimed at the axis where n is large enough to say something — and that axis is
behaviour, which is exactly what the E2 and kimi verdicts actually turned on.** Neither of those
verdicts was decided on forward return: E2 turned on schema-valid 0.83, hold-agreement 0.78 against
a 0.85 bar, and a propose ratio that moved 1.8 → 0.8 (`verdicts.md:563-572`); kimi-k3 turned on
schema-valid 0.85 against 1.00 and hold-agreement 0.17 (`verdicts.md:573-578`). The forward proxy
appears in both as one line among five criteria, never as the deciding one.

## PRIMARY — behavioural agreement, n = rows

### The scored statistic

**One primary scored statistic per read: the session arm's entry rate against the live lane's
recorded baseline on the same rows.** A two-sided one-sample proportion test at the declared alpha.

The live baseline is **13.29%**. **UNVERIFIED** — this figure was supplied to this document and I
could not locate it in the repository (§ Figures this document could not verify). The repo-readable
neighbours, for the reader's calibration, all sit in the same band:

| figure | value | source |
| --- | --- | --- |
| live-recorded entry rate, study corpus | 16.1% | `verdicts.md:273` |
| repaired replay, same corpus | 19.1% | `verdicts.md:273-276`; `playbook-space-replay-2026-07-28.md:703` |
| `champion_v8` sonnet replay, 354 rows | 21.8% | `verdicts.md:190` |
| `champion_v8` kimi-k3 replay, 354 rows | 62.0% | `verdicts.md:190` |
| `haiku_swarm` / `haiku_single`, 354 rows | 24.58% / 24.86% | `verdicts.md:227` |
| sonnet re-check probe, 34 parsed rows | 8.8% | `playbook-space-followon-2026-07-31.md` § Calibration |

### Powered in days, and here is the day count

Required rows to detect an absolute entry-rate difference `d` at two-sided alpha = 8.33e-3 and 80%
power (`z = 3.4806`), at `p0 = 0.1329`, `p0*q0 = 0.115234`:

```text
n = (3.4806)^2 * p0 * q0 / d^2 = 12.1146 * 0.115234 / d^2 = 1.39598 / d^2
```

| `d` (absolute) | required rows | days at 60.8 rows/day |
| --- | --- | --- |
| 10 pp | **140** | **2.3** |
| 5 pp | **558** | **9.2** |
| 3 pp | **1,551** | **25.5** |

**60.8 qualifying FLAT rows/day is a PLANNING figure, not a measurement of this arm**, read from
`playbook-space-followon-2026-07-31.md` § When it triggers (386 FLAT of 651 payload-carrying decides
over 6.35 days = 102.5 decides/day at a 59.3% FLAT share). **The first sealed window replaces it with
this arm's own measured rate**, and the day column is re-stated at that rate in an amendment rather
than silently kept.

Contrast the two axes on one line, because it is the design in a sentence: **a 5-percentage-point
behavioural difference is powered in about nine days; a 10 bps return difference is not powered in
any number of days.**

### The four reported companions — never scored, never a PASS

Reported with every read, with pre-registered expected-positive and named-defect statements in the
house WATCH form. **They are descriptive. They are never alpha-corrected, never enter the
denominator, and can never produce a PASS**, under the same discipline that governs controls in
`playbook-space-followon-2026-07-31.md` § The control exclusion ("a control can never PASS").

| companion | reported as | recorded comparators |
| --- | --- | --- |
| **schema compliance** | share of transported reads returning a `tradeDecisionSchema`-valid decision | sonnet 92.9% / kimi 48.7% (`verdicts.md:189`); haiku 100.0% (followon § Run health); E2 haiku 0.83, kimi 0.85 (`verdicts.md:566`, `:574`) |
| **hold agreement** | share of rows where session and live lane both hold | E2 bar **0.85**, haiku measured **0.78**; kimi **0.17** (`verdicts.md:566`, `:575`) |
| **action change** | share of rows where the session's parsed action differs from the live lane's | prose arms moved **9–55%** of decisions without moving the sign (`verdicts.md:196-197`) |
| **direction mix** | long/short split of the session's entries | kimi's 12 shorts of 76 proposes (`verdicts.md:585`); the short leg at n=18 "is not significant on its own" (`entry-rate-rederivation-2026-07-30.md` § 3.1) |

**If a later amendment wants to score a second measure, the denominator moves along a declared
ladder and alpha tightens with it — never the other way, and never after a result is seen:**

| scored measures x reads | cells | alpha = 0.05 / cells |
| --- | --- | --- |
| **1 x 6 — this design** | **6** | **8.3333e-3** |
| 2 x 6 | 12 | 4.1667e-3 |
| 3 x 6 | 18 | 2.7778e-3 |
| 5 x 6 — all five behavioural measures | 30 | 1.6667e-3 |

## SECONDARY — an h=24 forward-return BOUND, declared as a bound

**This is declared in advance as a BOUND, not as a test that can pass.** It carries no verdict
function, no PASS state and no research-bar clause. Its job is to catch a catastrophe — an arm two
orders of magnitude off the recorded band — not to resolve the model question, which § THIS ARM IS
NOT POWERED has already established it cannot.

- **What is reported:** the h=24 mean and its cluster-bootstrap 95% interval, computed by
  `computeCell` from `scripts/loop-forward-return-core.mjs`, over the read's own rows.
- **What is not computed, deliberately:** no p-value against +13.0 bps, no placebo, no halves clause,
  no trimmed mean, no `verdictFor`. Computing them would produce a table that reads like a research-bar
  row and is not one.
- **A powered cell here is a bound on the arm's own level, and nothing else.** At 28 clusters the
  detectable difference is ~72 bps (§ The arithmetic), so any statement of the form "the session
  decides better/worse than the live lane by X bps" for X under ~72 is unsupported by construction
  and is forbidden in any write-up of this arm.
- **A cell below `MIN_ENTRIES = 12` or `MIN_CLUSTERS = 5` is UNDERPOWERED**: never a bound, never a
  headline, and its point estimate never appears in a sentence separated from that label — the rule
  `loop-forward-return-core.mjs` § `summarise` already enforces for the live measurement.

**Two standing cautions bind this read and are carried rather than re-litigated:**

1. **The horizon grid flatters every result.** `h ∈ {1,4,8,24}` was never matched to holding
   behaviour (median hold 15.6 bars, mean 54.5); re-scored, the gap to the +13.0 bar is ~70–125 bps,
   not ~30, and h=1 brackets no realized figure (`STATUS.md:48-51`;
   `research/studies/learning-capacity-2026-07-31.md`). The horizons are nevertheless **imported
   unchanged** (§ Imported constants) because comparability with every recorded cell is worth more
   here than a better-matched grid, and a new grid would make this arm incomparable to the corpus it
   exists to be scored against.
2. **The `−16.9 bps` ENTRIES figure is superseded — it is `−13.75` (n=64, not 61)**; five
   `verdicts.md` citations are stale and the mirror is UNVERIFIED beyond h=1 (`STATUS.md:80-82`).
   **No read of this arm may quote −16.9.**

## Eligibility: `k <= 3`, and the leak it carries

### The correction, and it is load-bearing

An earlier framing of this arm claimed that a row whose forward window is still open is thereby
"blind". **That was wrong.** The property protects the **endpoint** — the h=24 outcome has not
printed — but it does not protect the **path**. A row with `k` forward bars already printed carries
the first `k/24` of the very return the secondary read scores.

For a series with independent per-bar increments of equal variance, the correlation between the
realised first `k` bars and the full 24-bar outcome is closed-form:

```text
corr(r[0..k], r[0..24]) = k / sqrt(k * 24) = sqrt(k / 24)      R^2 = k / 24
```

Measured over the journal grid at **n ≈ 29,800** rows (**SUPPLIED** — § Figures this document could
not verify), the measurement tracks that form:

| `k` bars printed | closed-form `r` | closed-form `R^2` | measured `r` | measured `R^2` |
| --- | --- | --- | --- | --- |
| 0 | 0.000 | 0.000 | — | — |
| 1 | 0.204 | 0.042 | — | — |
| 2 | 0.289 | 0.083 | — | — |
| 3 | 0.354 | 0.125 | — | — |
| **23** | **0.979** | **0.958** | **0.976** | **0.953** |
| mean over k = 0..23 (a 6-hour window) | — | **0.479** | — | **0.479** |
| mean over k = 0..3 (this arm) | — | **0.0625** | — | **0.065** |
| max over k = 0..3 (this arm) | — | **0.125** | — | **0.132** |

The two columns agree exactly to three decimals on the 6-hour average (0.479 both ways) and to
within 0.006 of `R^2` at k=23. **The arm's specification states the agreement holds "to three
decimals" at every `k`; at k=23 the two differ in the third decimal (0.979 vs 0.976), so that
stronger claim is recorded as UNVERIFIED and the weaker, checkable one is what this document
asserts.**

### The three consequences, all declared before the first read

- **Only `k = 0` is truly blind.** Any positive `k` leaks. There is no eligibility rule short of
  `k = 0` that makes a row blind, and this document does not pretend otherwise.
- **`k = 23` is not an eligibility rule anyone should reach for.** `R^2 = 0.953` means a row one bar
  short of its own horizon is, to within 5% of variance, its own answer. **Averaged over a 6-hour
  window the leak is 0.479** — half the variance of the thing being predicted, handed to the
  predictor.
- **`k <= 3` leaks a mean `R^2` of 0.065 (max 0.132), and that is the whole point of choosing it.**
  It is small, and — more importantly — it is **declarable in advance and constant across reads**,
  because the hourly cadence pins `k` to {0,1,2,3} by construction (§ Cadence). **It is recorded as a
  known, quantified limitation, never as an absence.** A write-up that describes this arm's rows as
  "blind" without the 0.065 is overclaiming, and a reviewer should treat the omission as a defect in
  the write-up rather than a property of the arm.

**The leak bears on the SECONDARY read only.** The primary statistic is an entry-rate proportion, and
a partially-printed forward path does not tell the deciding session what the live lane chose — the
live lane's own recorded action is what the primary is scored against, and it is never in the
payload.

## Cluster = BASE asset, never symbol string

The cluster unit is the **base asset**, taken as the part of a ccxt symbol string before the first
`/` (`loop-forward-return-core.mjs` § `baseAsset`). `BTC/USDT` and `BTC/USDT:USDT` are **one**
cluster.

**This is stricter than the live measurement was until today.** The trading universe is **40 symbol
strings over 28 distinct base assets** — twelve bases trade on both venues, and the measured
spot/perp h=24 forward-return correlation for the same base is **0.9993–0.9999**
(`loop-forward-return-core.mjs` § `MIN_CLUSTERS`). A same-base cross-venue pair is one observation
wearing two symbol strings. Clustering on the raw symbol let a 3-base cell clear a 5-cluster floor by
counting to five or six distinct strings first.

The same 28-asset unit is what the shipped passive benchmark uses: G4 (`682b6f6`) is equal-weight
over **28 distinct assets, not 40 strings**, exposure-matched, coverage 28/28, failing CLOSED in the
adapter (`STATUS.md:116-119`). **The universe ceiling in § The arithmetic is 28 for this reason, and
28 is a ceiling rather than an expectation.**

## Imported constants — every one read from source, none redefined

**A redefined constant is a silently different study.** Every constant below is imported from
`scripts/loop-forward-return-core.mjs`; this table records the value as read on 2026-08-03 so a
future drift is visible, and the **import**, not the table, is authoritative.

| constant | value as read | line |
| --- | --- | --- |
| `HORIZONS` | `[1, 4, 8, 24]` | `:46` |
| `MIN_ENTRIES` | `12` | `:52` |
| `MIN_CLUSTERS` | `5` | `:76` |
| `N_BOOT` | `20_000` | `:89` |
| `BOOTSTRAP_SEED` | `20260731` | `:95` |
| `MAX_GAP_SHARE` | `0.2` | `:106` |
| `BAR_MS` | `900_000` | `:43` |
| `FLAT_MARKER` | `"position":{"side":"FLAT"` | `:134` |
| `POPULATIONS` | `['all', 'flat_only']` | `:136` |
| `REPLAY_REFERENCE[10]` | `inverted`, predicted `{1: −0.8, 4: 0.8, 8: 19.3, 24: 47.6}` | `:120-126` |

Four notes, each recorded because it is a place a future reader could be misled:

- **`N_BOOT = 20_000`, not 5,000.** `playbook-space-followon-2026-07-31.md` § The RESEARCH bar names
  **5,000 draws**, and `entry-rate-rederivation-2026-07-30.md` § 6 clause 2 repeats it. This arm
  imports the core module's figure, so its intervals are drawn at **20,000**. The discrepancy is
  recorded, not resolved here: it is a difference between two harnesses, and re-pointing either at
  the other is out of scope for a pre-registration.
- **`BOOTSTRAP_SEED` exists so a pass cannot re-roll an interval until it likes it.** Two reads over
  identical rows must produce byte-identical intervals.
- **`MAX_GAP_SHARE = 0.2` fails toward UNDETERMINED, not toward a subsample.** Gaps are not
  missing-at-random — the lane goes down during incidents, incidents correlate with market events, so
  a surviving subsample is biased toward calm bars. A horizon over the share reads UNDETERMINED.
- **`REPLAY_REFERENCE` carries `+47.6` and it is NOT an edge claim.** v10 is a research-bar FAIL
  deployed on deployment-bar grounds; the module says so at `:116-118` and `STATUS.md:53-56` repeats
  it. **Never quote +47.6 as an edge.**

## Multiplicity — 6 disjoint scored reads, alpha = 8.33e-3

**A standing arm re-scored every pass is sequential testing.** Left uncontrolled it is the single
most likely way this arm produces a false positive, because the arm never ends: a statistic recomputed
on an accumulating row set crosses any fixed threshold eventually. So:

```text
alpha = 0.05 / 6 = 8.3333e-3
```

**Six scored reads. One primary statistic each. NO ROW MAY EVER BE SCORED TWICE.**

### Row-window bookkeeping — what actually enforces it

- Each scored read owns a **half-open window** `[t_start, t_end)` on `agent_decisions.event_time`.
- `t_start` of read `i+1` **is** `t_end` of read `i`, by construction. Read 1's `t_start` is the first
  `event_time` at or after the arm's activation instant, recorded in the first seal.
- **The window is fixed in its seal BEFORE the read is scored**, so a window can never be extended
  after a look. A read whose window is unsealed at scoring time is VOID
  (§ VOID conditions, condition 5).
- **A row that falls outside every sealed window is never scored at all.** Gaps between windows are
  permitted and are a wait, never a backfill: rows that accrue while no read is open are simply not
  in the family. Retro-fitting a window over them is a new trial with its own denominator.
- The seal records the window bounds, the row ids **in order**, and a sha256 over the concatenated
  payloads. **Row order is pinned explicitly** because an unpinned order among `event_time` ties has
  already broken a fingerprint check in this program and blocked a family
  (`STATUS.md:83-86`; `research/studies/corpus-fingerprint-drift-2026-07-31.md`).
- **After the sixth seal the family is SPENT.** A seventh read is a new pre-registration with its own
  denominator, and it may not be scored against this document's alpha — the same rule
  `playbook-space-followon-2026-07-31.md` applies to its own predecessor's spent 20-cell family.

### Underpowered and incomplete

- A read whose primary statistic lands below the row count its own seal projected is reported with
  its true `n` and its achieved power. It is **not** dropped and its window is **not** re-opened.
- **A family whose six declared reads did not all score is `INCOMPLETE`, never a verdict.** The honest
  statement for an unrun read is "untested", not "does not work" — carried from
  `playbook-space-followon-2026-07-31.md` § Decision rules.

## Cadence — and the owner-side change it requires

- **Hourly decide leg.** One decide pass per hour over the rows eligible at that instant.
- **`k <= 3` follows from the cadence rather than being enforced on top of it.** At a 15-minute bar
  (`BAR_MS = 900_000`) an hourly leg reaches each row with at most four bars elapsed since its
  `event_time`, so `k ∈ {0,1,2,3}` by construction. The eligibility filter is nevertheless asserted
  per row and **fails closed**: a row presented at `k > 3` is refused, not clamped.

**The hourly trigger does not exist and this document does not assume it does.** It is an
**owner-side scheduler change, outside this repository** — the loop's own scheduler is owner-owned
and has already produced five concurrent-pass collisions on this host (`STATUS.md:120-123`,
`:176-178`). What is needed, stated so it can be actioned without re-deriving it:

1. An hourly trigger that invokes the session decide leg, independent of the 3x/day loop pass
   cadence and holding no loop lease (this arm writes no loop file and must never contend for one).
2. Tolerance for the host's sleep duty cycle — worst measured **8%/24h** (`STATUS.md:181-182`). A
   missed hour is a **gap between windows**, not a backfill (§ Row-window bookkeeping), and it
   lengthens the day counts in § Powered in days rather than degrading a read.
3. No change to the live lane's own cadence, cost breaker, or arming path. This arm adds a reader;
   it does not touch the runtime.

**Until that trigger exists the arm is UNSTARTED, not failed**, and no read may be sealed.

## VOID conditions — any one of these voids the read

Fail-closed, each one earned by a recorded failure elsewhere in this program:

1. **`capsSource !== 'recorded'` on any row.** A single non-`recorded` row voids the read (WATCH-V4-9,
   `STATUS.md:137`). The capabilities defect moved a measured entry rate from **2.5% to 19.1%** and
   reached two production mint-time gates (`verdicts.md:273-276`) — a caps mismatch does not perturb
   an entry rate, it manufactures one.
2. **System-prompt fidelity mismatch.** The decide leg must compose the same system prompt, playbook
   block and tool schema the live lane composes — `buildSystemPrompt` / `buildPlaybookBlock` /
   `buildTradeTool(caps)` from `src/features/strategy/agentic/agent-prompt.ts`, the same surface
   `replayPlanRow` (`src/features/strategy/agentic/entry-rate-floor.ts`) builds. The read records the
   `agent-prompt.ts` blob hash next to its own commit SHA. **Mismatch VOIDS this read** — deliberately
   stricter than the sequencing constraint in `playbook-space-followon-2026-07-31.md` § Guards item 9,
   which downgrades attribution rather than voiding, because that guard protected a $6.80 sunk paid
   run and this arm's reads cost nothing to redo.
3. **Entry rate outside `[4%, 40%]`.** Below 4% the read is an abstention study with no entry
   population to speak of; above 40% it is outside every sonnet-family figure ever recorded here and
   into the kimi 62.0% regime, which the program already classes as a different behaviour, not a
   different quality (`verdicts.md:190`). Either end voids the read rather than being reported as a
   finding — a rate that far out is evidence the prompt surface or the payload changed.
4. **A transcript showing the deciding session read anything beyond the offered payload** — in
   particular `agent_decisions`, anything under `research/loop/`, or candle data past what the payload
   carries. This is the blindness condition, and § Blindness is procedural states plainly what it is
   and is not.
5. **A missing batch seal.** No seal, no score. A read scored without a pre-existing seal is void
   whatever its numbers say, because the seal is the only evidence the window was fixed before the
   look.

**A VOID read consumes its window and does not consume a family slot.** The rows in it are spent —
they may never be re-scored — but the read is re-declared with a fresh window against the remaining
denominator. That asymmetry is deliberate: it removes any incentive to void a read one dislikes,
because voiding costs rows and buys nothing.

### Blindness is procedural, and this document says so rather than implying otherwise

**A session cannot be sandboxed by this study.** The deciding session has tools; nothing in this
pre-registration mechanically prevents it reading the live lane's answer. The enforcement is the
**transcript**, checked before the seal is written, and condition 4 is the rule it is checked
against. That is weaker than a mechanical guard and it is recorded as weaker (§ Weaknesses). It is
also why the primary statistic is an entry **rate** rather than a per-row agreement score: a rate is
robust to a single leaked row in a way a paired agreement count is not.

## The one seam — and why no outcome here is a deployment claim

**The subscription cannot reach the runtime.** There is exactly **one** seam by which anything a
session produces reaches the running system: **playbook prose, written to `agent_playbook_versions`**
(`src/database/schemas/trading/trading.schema.ts:455-456`, written through
`src/database/repositories/strategy/playbook-version.repository.ts`, uniqueness enforced by
`agent_playbook_versions_version_uidx`). Prose, and nothing else.

**A session cannot be put in the decide path**, and that is not a preference:

- The runtime decide client is an API-keyed client; a subscription session is not a credential the
  runtime can hold, call, meter against `AGENTIC_DAILY_COST_STOP_USD`, or latch on
  (`agent_client_latch_cause`).
- `charter.md:102-105` is explicit: **decide model changes ONLY via the $0 offline harness, never a
  blind flip** — and that harness is `test/eval/agentic/candidate-model-eval.spec.ts`, not this arm
  (§ This arm is NOT the charter-mandated decide-model instrument).
- **"$0" in the charter's phrase means zero LIVE-TRADING RISK, not zero API spend, and the wording
  invites the error.** `candidate-model-eval.spec.ts:27-28` is explicit that "each replayed row costs
  one real API call per model", and `:1-3` replays the rows "against the REAL Anthropic API". Neither
  instrument may be described as free of cost without that distinction: the mandated harness costs API
  dollars, and this arm costs subscription capacity and owner attention.
- `verdicts.md:242-245` forbids citing a cross-model deployment-bar win as evidence for a
  decide-model swap in terms this arm inherits: **"Never cite it as evidence for a decide-model
  swap."**
- The shipped decide-model A/B config gate is **not a working A/B** — the arm is drawn once per boot
  and attribution journals every arm-B decide as arm A, so `AGENTIC_MODEL_AB_PCT` stays 0
  (`STATUS.md:105-107`). Even the mechanism that would make a model swap measurable in production
  does not currently work.

## What a PASS supports, what a FAIL supports, and what NEITHER supports

### PASS — the session's entry rate differs from the live baseline at alpha = 8.33e-3

Supports exactly one claim: **a substantially more capable model, on the same payload and the same
prompt surface, produces a measurably different entry-selection behaviour.** That is a behavioural
finding about the model axis. It is the finding E2 and kimi were decided on, and it would be the
first time this program measured it against the live lane rather than against another replay arm.

It licenses: a **new** pre-registration asking whether the behavioural difference carries any return
consequence — which would need its own corpus, its own denominator, and a power design that
§ THIS ARM IS NOT POWERED says cannot be met on 28 clusters. **It is not decide-model evidence under
`charter.md:102-105` and cannot become it** (§ This arm is NOT the charter-mandated decide-model
instrument). It licenses nothing else.

### FAIL — no detectable behavioural difference

**This is the outcome the arm exists for, it is the more likely one, and it is a CEILING PROBE
rather than a model-axis verdict.** The claim it supports is about the **payload**, not about any
model:

> A substantially more capable reasoner, given the **same** recorded payloads under the **same**
> schema and floor constraints, produced no measurably different entry-selection behaviour and no
> h=24 level outside the recorded band. That bounds what is extractable from **this payload**.

**Why the payload is the right object.** Every prior search of this payload's channels was run by
non-LLM means and came back empty: **4,562 price-TA backtests, 8 families, long+short, 15m–1d, fees
0→20 bps, ZERO honest survivors at any fee level including 0 bps** (`verdicts.md:548-553`); a
**1,807-cut** conditional-subgroup search with **0 of 188 counterfactual cuts positive at n>=8**, BH
at q=0.05 yielding zero discoveries (`entry-rate-rederivation-2026-07-30.md` § 3.1); and a random
entry at the model's own declared bracket geometry earning **gross −1.07 bps — a martingale — and
net −21.07 bps, i.e. exactly the fee** (`entry-rate-rederivation-2026-07-30.md` § 4). The open
question a stronger reasoner could still answer is whether _reading ability_, rather than search,
finds something in the same bytes. **A FAIL says it does not, at this arm's resolution.** That is
consistent with the standing reading that the binding constraint is the fee floor rather than trader
intelligence, and it is genuinely useful because it is the cheapest available bound on that reading.

**What the ceiling does NOT establish, stated with the same emphasis:**

- **Not "the payload contains no information."** It bounds extraction at this arm's resolution: a
  behavioural difference smaller than the primary's detectable `d`, and an h=24 level difference
  under the ~72 bps `delta_min(28)` of § The arithmetic, are both invisible here and remain
  possible.
- **Not a statement about channels this system does not record.** Order-book depth, trade flow,
  cross-venue spread and funding term structure are **not recorded at all**
  (`playbook-space-followon-2026-07-31.md` § Scope limit), so no arm built on this corpus — including
  this one — can speak to them. The ceiling is a ceiling **on the payload as it exists**, nothing
  wider.
- **Not a clean statement against a derived bar.** The +13.0 / +24.2 bps floor this program gates on
  **was never derived** — it enters the repo fully formed in `7b3e977` with no operands and every
  later citation is circular; the measured demo cost is **9.29 bps/round trip**
  (`STATUS.md:77-79`; `research/studies/fee-floor-derivation-2026-07-31.md`). A ceiling stated
  against that bar inherits the bar's own unresolved provenance and must say so.

### The missing Opus-4.8 artifact — motivation and context, NOT this arm's deliverable

The gap is real, it is why the arm was proposed, and **this arm is not its remedy.** Both halves are
recorded because a later pass reading only the first half would substitute one instrument for the
other.

`verdicts.md:570` records, in full, _"Opus-4.8 decisively rejected (07-13)."_ — **no n, no metric,
no threshold, no scorecard path.** Every other decide-model verdict in that same section carries all
four:

| verdict | figures | artifact |
| --- | --- | --- |
| E2 / haiku-4.5 (`verdicts.md:563-572`) | n=100, schema-valid 0.83, hold-agree 0.78 vs 0.85, forward proxy −27.9 vs +17.8 bps, propose ratio 1.8→0.8 | registry row 129, `candidates/e2-model-eval-2026-07-17.json` |
| kimi-k3 (`verdicts.md:573-578`) | n=100, schema-valid 0.85 vs 1.00, hold-agree 0.17, cost −32% vs a −50% bar, plan-sanity 1.0 | v3 registry row 1, `candidates/kimi-k3-model-eval-2026-07-21.json` |
| head-to-head hardened (`verdicts.md:579-591`) | n=200/leg, five criteria each evaluated | `candidates/trade-model-eval-headtohead-hardened-2026-07-22.json` |
| **Opus-4.8 (`verdicts.md:570`)** | **none in any loop file** | **none, on any branch** |

**Three facts about that gap, verified in git rather than asserted:**

1. **The figures survive only in history.** Commit **`be2f4fa`** (2026-07-13, _"feat(agentic):
   venue-resting take-profit (maker, intra-bar capture) + S3 busy-set fix"_) added one line to
   `reports/loop/state.md`: `` `claude-opus-4-8`: 0 proposes in 50 rows at 3.1x champion cost —
   decisively rejected for decide. `` — the model id being `claude-opus-4-8`, not the `Opus-4.8` of
   the surviving prose.
2. **It was compacted away the same day.** Commit **`66c3fac`** (2026-07-13, _"docs(loop): state.md
   deep clean — backlog verified row-by-row, seeds promoted (#41-#52), history compacted to
   pointers"_) removes that exact line. The scorecard JSON was recorded as archived in the session
   scratchpad and never entered the repository: `git log --all --diff-filter=A -- '*opus*'` returns
   **nothing** — no path matching `opus` has ever been added on any branch. The same commit is also
   where the charter's `` `$0` offline harness `` phrasing was introduced, which is worth noting
   given how that phrase reads (§ The one seam).
3. **It is the one model verdict that cannot be re-scored.** Pass 54's horizon-grid correction
   (`STATUS.md:48-51`) binds every other verdict in that section — they have recorded rows and
   recorded actions, so they can be re-scored on a corrected grid. The opus leg has neither, so it
   is uniquely unrecoverable.

**The remedy is `test/eval/agentic/candidate-model-eval.spec.ts`, and this arm is not a substitute
for it** (§ This arm is NOT the charter-mandated decide-model instrument). A FAIL here is a ceiling
statement about the payload; it is **not** the missing opus scorecard and may never be filed as one.

### The five things NEITHER outcome supports

1. **Nothing about opus served through the API.** This is a **session**, on a subscription, with a
   harness around it. The serving stack, the sampling parameters, the tool surface and the retry
   behaviour are not the runtime's, and this program has already recorded that even the _same alias_
   across two dates is not guaranteed to be the same weights or the same serving stack
   (`playbook-space-followon-2026-07-31.md` § What sequencing CANNOT control). **No result here may
   be quoted as a measurement of any API-served model.**
2. **No deployment claim, in either direction.** Not "deploy it" and not "do not deploy it" — the
   question is malformed, because there is nothing to deploy. § The one seam: the subscription cannot
   reach the runtime, the single seam is playbook prose in `agent_playbook_versions`, and a session
   cannot be put in the decide path. A PASS does not make a session deployable and a FAIL does not
   argue against a deployment nobody could perform.
3. **No PnL claim.** The primary is a behavioural proportion and the secondary is an explicitly
   under-powered bound with no exit modelling and entry priced at the bar close. `verdicts.md`
   Guardrails 1–5 stand word for word, and nothing here is promotion evidence or a step toward live
   capital.
4. **No pooling with Family A or Family B.** Different corpus, different unit, different denominator,
   different question. Family A is in-sample on a frozen 354-row corpus; Family B is blocked on
   `assertDesignMatchesCorpus` (`STATUS.md:83-86`). **A result in this arm is never quoted against
   either family's alpha, and neither family's result is quoted against this one's.** A single
   denominator over all three would penalise each question for the others being asked.
5. **This arm is NOT the charter-mandated decide-model instrument and may never be cited as one** —
   see the subsection immediately below, which exists so that a later pass reading this arm's results
   cannot substitute one instrument for the other.

### This arm is NOT the charter-mandated decide-model instrument

`charter.md:102-105` mandates that **decide model changes go ONLY through the offline candidate
harness, never a blind flip.** That harness is a specific file, and it is not this arm:

**`test/eval/agentic/candidate-model-eval.spec.ts`** — read directly, not inferred:

| property | source |
| --- | --- |
| replays **>= 200** real recorded `agent_decisions.input_payload` rows through candidate models **against the REAL Anthropic API** in PLAN MODE; the champion never makes a network call, its scorecard coming from the rows' own persisted action/confidence/usage | `:1-6` |
| **triple-gated** — `EVAL_CANDIDATES=1`, plus `ANTHROPIC_API_KEY` (or `AGENTIC_EVAL_API_KEY`), plus `DATABASE_URL` under a read-only DB gate; any one missing skips the whole suite | `:8-17` |
| already parameterised for the model in question — `AGENTIC_EVAL_CANDIDATE_MODELS=claude-haiku-4-5-20251001,claude-opus-5` | `:26` |
| **"each replayed row costs one real API call per model"** | `:27-28` |

**The two instruments measure different objects, and that is the whole distinction:**

| | `candidate-model-eval.spec.ts` | this arm |
| --- | --- | --- |
| object measured | a model **served over the API** | a **Claude session on a subscription**, harness and all |
| can enter the decide path | **yes** — it is the mandated route | **no** (§ The one seam) |
| what the 2026-07-13 opus verdict was about | **this one** | not this one |
| cost | real API dollars per replayed row | subscription capacity and owner attention |

**So the mandated harness — not this session arm — is the instrument that would produce the missing
opus artifact**, because it replays recorded rows through the candidate model served over the API,
which is precisely the object the rejected verdict was about. This arm cannot be put in the decide
path, so it can never be the mandated decide-model evidence, whatever it measures.

## Weaknesses, stated before the result

1. **Blindness is procedural, not mechanical** (§ Blindness is procedural). A transcript check is
   weaker than a sandbox, and this arm has no sandbox.
2. **The `k <= 3` leak is real, not zero.** Mean `R^2` 0.065, max 0.132 on the secondary read. It is
   declared and bounded; it is not absent.
3. **The 13.29% baseline is unverified in-repo** (§ Figures this document could not verify). The
   primary's alpha and power depend on `p0` only weakly — at `p0 = 0.161` the required rows for a
   5-point difference move from 558 to 654, a 17% change and no change in the day-scale conclusion —
   but the _comparison_ is meaningless if the baseline is not the live lane's own rate on the same
   rows. **The first seal must record the live baseline measured on that seal's own rows**, and if it
   disagrees materially with 13.29% the disagreement is reported as a finding about the supplied
   figure rather than absorbed.
4. **The universe is 28 and there is no way to enlarge it.** Every cluster-limited statement in this
   document is permanent for as long as the trading universe is what it is.
5. **The secondary read inherits a horizon grid that flatters every result** (`STATUS.md:48-51`), and
   this arm keeps it for comparability rather than fixing it.
6. **The arm conditions on the live lane's own behaviour.** Which rows are FLAT depends on what the
   live lane entered, so the eligible population is not an independent draw — the same weakness
   `playbook-space-followon-2026-07-31.md` § Weaknesses item 5 records for Family B, and it is not
   mitigated here by a regime control.
7. **A standing arm invites the exact failure its denominator is built against.** Six reads is a
   small, spendable budget precisely so the arm cannot quietly become a sequential test; the discipline
   holds only as long as nobody re-opens a sealed window, and nothing but this document prevents that.
8. **The hourly trigger does not exist** (§ Cadence). The arm is UNSTARTED until an owner-side
   scheduler change lands, and this document cannot make it land.
9. **The ceiling probe confounds the model with its harness, and cannot be decomposed here.** A
   session is not "the same model, bigger": it carries tools, a different sampling and turn regime,
   and an agent loop the runtime does not have. A FAIL is therefore a ceiling on **this session
   configuration reading this payload**, and a difference — in either direction — could come from
   the harness rather than the model. The paired control that would decompose it is
   `candidate-model-eval.spec.ts` on the same rows (§ This arm is NOT the charter-mandated
   decide-model instrument), which is a different, API-costed instrument and is out of scope here.
10. **The ceiling is stated against an underived bar.** +13.0 / +24.2 bps has no operands in the repo
    and every citation of it is circular (`STATUS.md:77-79`). Any sentence of the form "not even a
    stronger reasoner clears the floor" inherits that, and must carry the measured 9.29 bps/round-trip
    demo cost alongside the quoted bar rather than in place of it.

## Figures this document could not verify

Recorded rather than dropped or silently used, per this program's standing rule that an absence which
reads as a clean reading is a defect class in itself.

| figure | status | what I did |
| --- | --- | --- |
| **13.29% live entry-rate baseline** | **UNVERIFIED** | Searched the full repository for `13.29`; the only occurrences are unrelated (an `equityUsd` string in `research/scorecards/edge-tournament-xsec20-ew-2026-07-24.json:2611` and three OHLCV values in `test/backtest/data/BTCUSDT-15m.json`). It is **not** in `entry-rate-rederivation-2026-07-30.md` (read in full, 486 lines), `verdicts.md`, `STATUS.md`, `charter.md`, `watches.md`, `LOG.md`, or the four newest digests. Repo-readable neighbours are tabulated in § The scored statistic. |
| **~1,288 clusters at delta = 10 bps** | **SUPPLIED** | My own derivation from the recorded SE = 30.51 bps at 20 clusters gives **1,461** at two-sided alpha = 0.05 / 80% power. I could not recover the convention that reproduces 1,288. Both figures and the derivation are shown in § The arithmetic; the conclusion is invariant between them. |
| **n ≈ 29,800 journal-grid rows** for the leak measurement | **SUPPLIED** | The measurement requires the live database, which is outside this scope. The closed-form column in § The correction is derived here and agrees with the supplied measured column to three decimals on the 6-hour average. |
| **measured leak `r`/`R^2` at k=23, and the k<=3 mean/max** | **SUPPLIED** | Same reason. The specification's stronger claim — agreement with `sqrt(k/24)` "to three decimals" at every `k` — does **not** hold at k=23 (0.979 closed-form vs 0.976 measured) and is recorded as UNVERIFIED; the checkable weaker claim is what this document asserts. |
| **60.8 qualifying FLAT rows/day** | **PLANNING FIGURE** | Read from `playbook-space-followon-2026-07-31.md` § When it triggers, measured on the live lane, not on this arm. Replaced by this arm's own measured rate at the first seal. |

## Provenance

- **Statistics and constants:** `scripts/loop-forward-return-core.mjs` — imported, never redefined
  (§ Imported constants). Pure, no I/O, never throws, emits annotations rather than alarms, and fails
  OPEN as a measurement (`:8-14`).
- **Prompt surface:** `buildSystemPrompt` / `buildPlaybookBlock` / `buildTradeTool(caps)`,
  `src/features/strategy/agentic/agent-prompt.ts`; replay shape `replayPlanRow`,
  `src/features/strategy/agentic/entry-rate-floor.ts`.
- **Corpus source:** `agent_decisions` (`src/database/schemas/trading/trading.schema.ts:360`),
  `trigger_kind = 'candle'` only — an `exec`-triggered row stamps a fill time whose close belongs to
  an earlier bar (`loop-forward-return-core.mjs:33-38`).
- **The one seam:** `agent_playbook_versions`
  (`src/database/schemas/trading/trading.schema.ts:455-456`).
- **Binding context, read before this document was written:** `research/loop/verdicts.md`
  § Standing verdicts (the two-bar rule stands first, `:17-56`; § THE DECIDE MODEL IS NOT THE LEVER,
  `:183-203`; the decide-model verdict block, `:563-591`; **the Opus-4.8 line, `:570`**);
  `research/loop/charter.md:102-105` (decide-model changes only via the $0 offline harness);
  `research/loop/STATUS.md` (live gauges, the cluster-limited bar at `:164-168`, the horizon caution
  at `:48-51`, the −13.75 correction at `:80-82`).
- **Form modelled on:** [`edge-tournament-preregistration-2026-07-24.md`](edge-tournament-preregistration-2026-07-24.md),
  [`playbook-space-followon-2026-07-31.md`](playbook-space-followon-2026-07-31.md).
- **Research lane. OFF the production gate** (`pnpm backtest` / `pnpm eval:*` / `pnpm loop:*`
  family). This document authorises no code change, no deploy, no spend, and no live-money step.

## Amendments

None. Amendments are **appended below this line with their date, and nothing above is ever edited**.
An amendment that rewrites prior text is a rationalisation, not a record.
