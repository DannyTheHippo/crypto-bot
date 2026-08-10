# Successor-program charter — DRAFT (2026-08-10)

**This is a DRAFT. It adopts nothing, authorises nothing, enables nothing, and claims no authority
over any gate, constant, lever or deploy.** It is owner-approved at or before the **2026-08-31**
decision-window close — the window adopted by the owner 2026-08-01 (`1C, 2A, 3A, 4A`,
`research/studies/success-exit-2026-07-31.md` § 7) — **or it is nothing**. No pass may cite it as a
verdict, no study may score against it, and nothing in it supersedes a line in
`research/loop/verdicts.md`, `research/loop/charter.md` or the refusal list at
`research/studies/redesign-scoreboard-2026-08-04.md` § 5. Every criterion it proposes is a *shape*
awaiting derivation; where it declines to state a number, that is the point, not an omission.

## Anchors — every figure below carries one, and none is separable from it

| id | what it anchors | as-of / denominator |
| --- | --- | --- |
| **A1** | the scoreboard's book tuple — ONE `PromotionReadinessService.evaluate()` sample | **2026-08-03T22:02:24Z**: `roundTrips=49, windowDays=10.9688, netPnlUsd=−63.5326, llmCostUsd=28.7007, winRate=0.2449` |
| **A2** | the bar operands | anchor **2026-08-03T16:07:00Z**; n=48 closed round trips, 294 fills, Σ one-way notional **$3,996.1492**, **12** base-asset clusters; cluster bootstrap seed 20260731, `N_BOOT` 20,000, floors `MIN_OBS=12` / `MIN_CLUSTERS=5` |
| **P65** | the prior book tuple | **2026-08-06T16:33:53Z**: `windowDays=13.6763003472, roundTrips=61, netPnlUsd=−72.7377983944, llmCostUsd=33.1938887, winRate=0.2622950820` |
| **B** | Checkpoint #1's book tuple, the freshest read this draft carries | **2026-08-10T08:52:03Z**: `windowDays=17.50014773148148, roundTrips=80, netPnlUsd=−81.2138271444, llmCostUsd=40.0934201, winRate=0.275, ready=false`, reasons `[NON_POSITIVE_NET_PNL, BELOW_PASSIVE_BENCHMARK]` |
| **Epoch** | `PROMOTION_EVIDENCE_EPOCH` | **2026-07-21T11:21:00Z** — never moved (refusal list item 4) |
| **Universe** | the cluster ceiling every powered statement inherits | **40 symbol strings over 28 distinct base assets**; twelve bases trade both venues at spot/perp h=24 forward-return correlation **0.9993–0.9999**, so a same-base cross-venue pair is one observation wearing two strings |

Sources read in full before drafting: `research/loop/STATUS.md`,
`research/studies/redesign-scoreboard-2026-08-04.md` (including **Checkpoint #1 — recorded
2026-08-10T08:52:03Z**), `research/studies/break-even-bar-derivation-2026-08-04.md`,
`research/loop/verdicts.md`, `research/studies/oos-session-arm-2026-08-03.md`.

## (i) Entry-policy-centred design — because the measured deficit is hit rate

### The deficit is located, and it is not where the intuitive fixes point

Decomposed over **50 closed round trips** at Pass 62 (`research/loop/LOG.md` § 2026-08-04 — Pass 62,
`walkRoundTrips` mirrored as a recursive CTE, all money math in `NUMERIC(38,18)`; bridge total
**−$66.4746** against the gate's published −66.474, exact to 4 dp):

- **Winners are 1.40× LARGER than losers** — +300.33 bps on n=12 against −214.35 bps on n=38. **The
  exit geometry is fine and every fix aimed at exit sizing is aimed at the wrong organ.** Break-even
  at that payoff needs **41.65%**; actual is **24.00%**, 95% CI **[12.2%, 35.8%]** — an interval that
  excludes the break-even rate. Clearing the all-in bar needs **57.8%**.
- **Discretionary LLM closes must not be "fixed."** 84% of gross loss exits through them, and they
  average **−154.7 bps** against **−279.0 bps** for letting the bracket stop fire — hand-cutting a
  broken thesis **SAVES ~124 bps/trip**.
- **Sizing multiplies a negative edge.** On that lane's own anchor, 87% of its 83.26 bps bar is LLM
  cost scaling with wall-clock rather than notional, so sizing up 12× cuts the bar to ~16.7 bps and
  multiplies a −77 bps gross edge into roughly **−$390**. (That 83.26 bps is Pass 62's own figure at
  its own anchor and is **not** the scoreboard's +78.80 at A2; the two are different reads and neither
  substitutes for the other.) **Gross must cross zero before any cost lever is worth pulling.**
- **The microstructure search returned a NULL.** 64 pre-registered cells; **7** cleared power and a
  Bonferroni-corrected 99.921875% interval excluding 0; **all 7 failed the family-wise random-bar
  placebo at p = 0.3781** (200 realizations, seed 20260804). A measured **anchor-lag** confound puts
  the artifact ceiling at **~9.1 bps** against observed h=1 effects of **+10.4, +9.7, −10.7, −10.6,
  −10.4 bps** — the same size. The data cannot distinguish "entirely artifact" from "real 15-minute
  effect" (`research/studies/payload-microstructure-prereg-2026-08-04.md` R1, R6, R7; git-attested
  freeze at `c48085e`).
- **The entry signal itself is significantly negative and worse than random** (`verdicts.md` § THE
  ENTRY SIGNAL): −16.9 bps at h=1, t=−4.58, CI [−25.2, −8.6], n=61 — **corrected to −13.75 on the
  complete n=64 population**; random-bar placebo p = 0.0013–0.0037; **1,807 cuts examined, 0 of 188
  counterfactual cuts positive at n≥8**, BH at q=0.05 yielding zero discoveries.

**Therefore a successor puts candidate *entry policy* generation at the centre.** Exits are measured
and adequate; sizing is refuted as a lever while gross is negative; the recorded non-price and
microstructure channels are exhausted. Entry policy is the one organ the record locates the deficit
in and has never been able to read.

### Powered per-version evidence, via the OOS session arm

Each candidate entry policy is evaluated with **per-version evidence that clears the program's own
power floors** (`MIN_OBS = 12` **and** `MIN_CLUSTERS = 5`, both required, imported never redefined),
and the instrument for that is the standing arm registered at
`research/studies/oos-session-arm-2026-08-03.md`, as amended 2026-08-04:

- **PRIMARY:** a two-sided **two-proportion test** of the arm's entry rate against the live lane's
  entry rate **on the same sealed rows**, at `alpha = 0.05 / 6 = 8.3333e-3`; Fisher's exact when
  either arm's entry count is below 5 (a pre-declared substitution). Both arms score the same rows, so
  the unpaired form **overstates the variance of the difference and under-rejects** — chosen because
  the arm's named failure mode is a false PASS.
- **Powered in days, and the day count is stated:** at the planning baseline `p = 0.041743`, 10 pp
  needs **202** rows (1.50 d), 5 pp needs **604** rows (**4.49 d**), 3 pp needs **1,441** rows
  (10.70 d) at the measured **134.7 FLAT rows/day** — 1.63 / 4.88 / 11.63 d at the named **8%/24h**
  host-sleep haircut (123.9 rows/day).
- **The return axis is not powered and never will be.** `delta_min(28) ≈ 72 bps` at the universe
  ceiling, against measured decide-model effects of **4–10 bps**; detecting 10 bps needs **1,461**
  clusters, 52× the universe. The secondary h=24 read is declared a **BOUND**, never a test that can
  pass.
- **The arm is UNSTARTED.** No window has been sealed and no read has been scored, because the hourly
  trigger is an owner-side scheduler change that does not exist (§ (v)).

**A successor's per-version claim is powered or it is labelled UNPOWERED with its true n, its cluster
count and its achieved power — never a point estimate in a sentence separated from that label.**

### Event-driven succession replaces calendar minting

**Calendar minting was self-defeating, and the mechanism is DIVISION, not suppression.** Measured
2026-07-31 (`research/studies/learning-capacity-2026-07-31.md` § 2): **eight playbook versions had run
live**, sharing **78 entries** — **9.75 entries/version against a bar of 12** — and **only v1 (28
entries / 13 clusters) and v2 (18 / 11) ever reached n≥12 AND clusters≥5**, both the oldest. The
confound was checked and inverts nothing: **2026-07-24 was simultaneously the highest-volume day in
the program's history (24 entries) and its heaviest minting day (four versions live)** — ~6 entries
per arm on the best day there has ever been. Daily minting divided the entry population across
versions so finely that the two POWERED versions are simply the two that had the book largely to
themselves. **Live, the learning hypothesis has never been tested; it has been overwritten.**

(The **ten** rows in `agent_playbook_versions` are the mint ledger, not the live-run count — v10
`source='loop-candidate'` and v11 `source='promotion'` both landed 2026-07-30 and **no row was ever
deleted**, `verdicts.md`. Eight is the number that ran; ten is the number that exists. Neither
substitutes for the other.)

**The successor extends a gate that already ships — it does not invent the mechanism.** Checkpoint #1
records the **event-driven mint gate live as of that pass**: it permits a mint only on
`powered ∧ ciHi < 0` in the `flat_only` population at h=4 or h=8. On the fresh
`pnpm loop:forward-return` of **2026-08-10T08:53Z** it read `ciHi` **+15.7** (h=4) and **+3.9** (h=8),
**so the trigger did not fire, and minting nothing that day is the trigger working.** A successor's
succession rule is that gate's shape generalised: a version is superseded when its own accrued
evidence clears power AND excludes the incumbent, never when a calendar day rolls over.

**The same read is why succession must be event-driven rather than schedule-driven.** On n=55 / 10
clusters — 2.6× the n=21 population of the 2026-08-04 amendment — v10's h=4 and h=8 point estimates
moved to **−9.3** and **−20.8 bps** and **both intervals now straddle zero**. The adverse-POWERED
signature that would have justified minting away from v10 **did not survive accrual**;
**WATCH-PLAYBOOK-V10-1 tier 2's "excludes zero at h=4/h=8" is SUPERSEDED and must not be re-quoted
from the amendment.** A schedule would have minted on a small-population reading.

## (ii) The honest bars, carried forward unchanged

| bar | value | denominators — inseparable from the figure |
| --- | --- | --- |
| **GROSS** | **+8.3619 bps/round trip**, cluster CI95 **[6.2010, 10.7616]** | n=48, **12** base-asset clusters ⇒ **EVIDENCE, not a recorded figure**; per-cycle `feesQuote ÷ (turnover/2)`, no ×2 leg approximation; fees 8.6718 (spot 20.0000 n=7, perp 7.2208 n=41, 88.65% perp by notional) + slippage −0.3317; book-weighted variant 8.3400 |
| **ALL-IN (book-average)** | **+78.80 bps/round trip** | **only** at **48 trips / 10.85 days / $83.2531 mean one-way notional / $28.1473391 book LLM cost**, epoch → 2026-08-03T16:07Z, Σ one-way $3,996.1492 |
| **ALL-IN (forward rate)** | **+108.01 bps/round trip** | three full UTC days **2026-07-31 → 2026-08-02**; Σ one-way **$778.2393** over 36 fills; decide spend **$7.7570** ⇒ LLM term 99.67 bps |

**The ALL-IN figure is not a constant.** It is a function of trade rate and notional: +78.80 at the
book's average, +108.01 on the forward denominators, and 63.88–78.45 bps across the window-consistent
snapshots at 23 / 38 / 46 / 48 trips. **It may never be quoted without its denominators, and it may
never be pasted into code as a threshold.** That exact error is what produced the refuted **+13.0** —
which enters the repo fully formed in `7b3e977` with no operands, sits **above the gross CI's upper
bound of 10.7616** as a venue-cost bar, and is **~66 bps too low** as an all-in bar. A single number
cannot be both, which is the clearest evidence available that it was never derived for either
question. **+24.2 is UNDERIVABLE** — no live book (all 295 fills `mode='testnet'`), no authoritative
live schedule in the repo.

**Supersession is FORWARD ONLY and this draft does not widen it.** No completed study, verdict,
scorecard, WATCH or registry row is re-scored. The three code homes stay untouched by anything here:
`test/eval/agentic/playbook-space-replay.ts:47-48`, `test/backtest/inversion-test.mjs:27`,
`scripts/loop-authoring-core.mjs:519-524`. Any change to them is a new dated pre-registration, never
an unattended edit.

**Two properties of the LLM term travel with it permanently.** It carries **no confidence interval
and never will** — it is one book-level scalar over one contested count, and its honest uncertainty is
definitional (which denominator) rather than statistical. And **$4.467794 of the $28.85 total (15.5%)
is `claude-opus-4-8` priced at the fail-closed component-wise maximum because the operator never
declared a rate for that model**; every cost figure in this draft inherits that over-count.

**The gap, on the bar's own denominator (A2, 48 trips):** realised gross is Σ `realizedPnl`
−27.933707 over Σ one-way 3,996.1492 = **−69.9016 bps/round trip**.

```text
gap to the derived GROSS bar      =   8.3619 − (−69.9016)  =   78.26 bps/trip
gap to the book-average ALL-IN    =  78.7981 − (−69.9016)  =  148.70 bps/trip
gap to the FORWARD ALL-IN         = 108.01   − (−69.9016)  =  177.91 bps/trip
```

## (iii) The cost-structure inversion axis — the one structural idea that changes the arithmetic

### 89.4% of per-trip cost is inference, and that is the whole opportunity

Dollar form of the book-average all-in row, at the measured $83.2531 mean one-way notional: fees
$0.072198, slippage −$0.002762, LLM $0.586403, giving **$0.6558 of cost per round trip, of which
89.4% is inference.** In bps: of the **+78.80** bar, **70.44 bps is LLM amortization at API
metering** — $28.1473391 ÷ 48 = $0.5864/trip ÷ $83.2531.

The identity that governs the term, stated so it cannot be argued around:

```text
llm_bps_per_round_trip  =  llm_usd_per_day × 1e4 ÷ one_way_notional_usd_per_day
```

**The denominator route is refused, with its arithmetic already on record.** Bringing the LLM term to
the +8.36 gross bar by turnover needs **$3,093.0/day of one-way notional against the measured
$259.41/day — 11.9×** — inside a $1,000-capped book whose measured time-weighted average gross
exposure is **$204.44**. And scaling turnover by `k` multiplies the dollar loss of a −69.9016 bps/trip
book by the same `k`: the scoreboard's own worked case at `k = 2.5` improves the ratio to 39.87 bps
and **fires the S3 stop twelve days earlier**.

**So a successor attacks the numerator** — and **one of the three mechanisms this draft originally
listed has since been REFUSED on the merits** (owner delegated the call 2026-08-10; ruling in Gate 2
below). The refused one was "subscription-scale economics": a **Claude-Code-session or other
consumer-subscription decide backend**. What survives is the legitimate numerator work — **prompt-cache
maximisation, fewer decides per trip, and a cheap prescreen tier** — which shaves the term rather than
collapsing it. **The collapse-to-the-gross-bar framing below is therefore an ILLUSTRATION of what the
cost structure dominates, not a route this program has.** Read it as the reason entry policy is worth
attacking at all, never as an available lever:

- **Against +78.80** (at 48 trips / 10.85 d / $83.2531), a book realising −69.9016 bps/trip is
  **148.70 bps short** and the gate is unreachable — no entry-quality improvement the record can
  imagine closes 149 bps.
- **Against +8.36** (n=48, 12 clusters, CI95 [6.2010, 10.7616]), a cohort trading near break-even
  gross is **tens of bps short** — a target an entry-policy program can at least aim at and be
  measured against.

### The arithmetic, worked on Checkpoint #1's forward window — an ILLUSTRATION, not a claim

```text
forward window: P65 tuple 2026-08-06T16:33:53Z → B 2026-08-10T08:52:03Z = 3.6792824 d
Δgross = −$1.5764973500   Δtrips = 19   ⇒   gross per round trip = −$0.0830/trip
bps form, at the STALE $83.2531 book-average one-way notional ⇒ ≈ −10.0 bps/trip   (ESTIMATE)
  gap to the ALL-IN  +78.7981 bar  ≈  88.8 bps/trip
  gap to the GROSS    +8.3619 bar  ≈  18.4 bps/trip
hit rate = (0.275 × 80 − 0.2622950820 × 61) ÷ 19  =  6 ÷ 19  =  31.58%
  vs the gross break-even hit rate  41.65%  ⇒  10.07 pp short
  vs the all-in break-even hit rate 57.8%   ⇒  26.2  pp short
```

**Everything that must travel with those numbers, per Checkpoint #1's own four clauses:**

1. **UNPOWERED. n = 19, one window, clusters unread.** The powered bar is n≥12 **AND** clusters≥5 on
   base assets; n clears and clusters were never computed. **This may not be quoted as a POWERED
   result.**
2. **The bps form is an ESTIMATE, not a measurement** — converting −$0.0830/trip needs a Σ one-way
   notional that read does not carry, so it borrows a denominator from a different window.
3. **Regime-confounded, with zero lever confound.** The container has run `5deaac5` since
   **2026-08-06T17:39:41Z** with `RestartCount` 0 — no deploy, no lever, no env edit. The loop was
   dark; the app was not. **The parsimonious reading is a different market window, not a different
   strategy.**
4. **The forward-return instrument agrees with the regime reading, not a skill reading** — v10's
   adverse edge weakened toward zero as its population grew, which is what a small-sample artifact
   does when it accrues.

**And the 148.70 bps book gap must not be glued to this 19-trip cohort** — it is the A2 population's
own figure on its own denominator. Two different denominators, two different windows, no arithmetic
between them.

Nothing here rescues or damages the ENTRIES verdict, and nothing here is admissible against the
promotion gate: at B, `ready=false` on `NON_POSITIVE_NET_PNL` and `BELOW_PASSIVE_BENCHMARK`.

### Two gates on this axis, both BLOCKING

**Gate 1 — deployed-model fidelity. Fails CLOSED.** A decide backend that is not the deployed model
**measures a different system, and every prior finding would have to be re-earned.** This is not
hypothetical caution; the record already carries the mechanism:

- **The subscription cannot reach the runtime today.** The runtime decide client is API-keyed; a
  session is not a credential the runtime can hold, meter against `AGENTIC_DAILY_COST_STOP_USD`, or
  latch on (`agent_client_latch_cause`). There is exactly **one** seam by which anything a session
  produces reaches the running system — **playbook prose written to `agent_playbook_versions`** — and
  prose is not a decide backend.
- **No session measurement is a measurement of any API-served model.** The serving stack, sampling
  parameters, tool surface and retry behaviour differ; the program has already recorded that even the
  *same alias* across two dates is not guaranteed to be the same weights or the same serving stack.
- **The mechanism that would make a swap measurable in production does not work.** The shipped
  decide-model A/B gate draws once per boot and journals every arm-B decide as arm A, so
  `AGENTIC_MODEL_AB_PCT` stays 0.
- **The charter route is unchanged:** decide-model changes go only through
  `test/eval/agentic/candidate-model-eval.spec.ts`, and its `$0` means zero **live-trading risk**, not
  zero API spend — "each replayed row costs one real API call per model".

**So the successor either runs the deployed model on the cheaper transport, or it declares itself a
different system and re-earns the record.** There is no third option, and "close enough" is the
failure this gate exists to refuse.

**Gate 2 — Terms-of-Service / fair-use. REVIEWED AND REFUSED 2026-08-10. The gate did not clear, so
per its own terms THE AXIS IS DEAD.**

_The owner delegated this call ("your call; ONLY live flip is my call"). It is decided here, not
deferred, and it is decided against.*

**The ruling.** A **Claude Agent SDK** implementation is legitimate and is not what was refused — it
bills through the API like any other client. What is refused is a **consumer-subscription or
Claude-Code-session decide backend**: an unattended trading loop issuing on the order of a hundred
inference calls a day on a 15-minute bar schedule is **not interactive developer use**, and routing it
through a subscription product is using that product as an **unmetered API**. That is circumvention of
usage-based pricing. **The fact that it is the only thing that makes the arithmetic work is the motive
the rule exists to catch, not a mitigating circumstance** — and this program's own standing discipline
already refuses conclusions reached by choosing the frame that flatters them.

**It also fails Gate 1 independently**, which is worth stating so nobody re-opens it on a ToS
technicality: a session is not a credential the runtime can hold, meter against
`AGENTIC_DAILY_COST_STOP_USD`, or latch on. Even if the licensing question vanished, the thing could
not be wired without becoming a different, unmeasured system.

**Nothing subscription-backed or session-backed is built, wired, flag-gated, or prototyped against
live rows. Not as an experiment, not behind a flag, not "to size the prize."** A future owner may
overturn this; overturning it requires a dated amendment that states what changed, and it may not be
overturned by re-deriving the arithmetic — the arithmetic was never the disputed part.

**So the successor needs a different cost structure**, and the record already names the candidates —
all of which shave the numerator honestly and **none of which reaches the gross bar**:

- **Fewer decides per trip.** Of 667 post-epoch consults, **518 were pure cadence** — 1,008 rows,
  zero trade actions — spending **$17.81, 61.9% of the entire LLM bill, with no trade attached**. That
  is the measured size of the target, and it is the numerator, not the denominator.
- **Larger notional per decide** — which is the denominator route, and is **refused as stated** unless
  gross has crossed zero first (§ (iii), and `verdicts.md`'s standing "sizing multiplies a negative
  edge").
- **Non-LLM candidate filtering ahead of the LLM**, so inference is spent only on rows a cheap filter
  has already admitted. **This has no derived magnitude in the record and would need one before it
  ships** — a lever with no declared magnitude cannot fail, and a thing that cannot fail is not a
  measurement.
- **A cheap prescreen tier gating which symbols reach the expensive decide.** The seam already exists
  rather than needing invention: `agent_decisions.model` already carries `prescreen` and
  `plan-executor` alongside `claude-sonnet-5`. Same magnitude requirement as the row above — **derive
  it or do not ship it.**
- **Prompt-cache maximisation.** Measured split (scoreboard § 3.3): of $23.76 sonnet decide spend the
  per-symbol payload rides the **input** class at **$12.96 (54.5%)**, while the shared system prompt
  and playbook ride cache-read and cache-write. **Cache WRITE is the expensive class** — a template or
  playbook that churns re-pays it. **`TRADE_TEMPLATE_VERSION` moved v4 → v6 this pass, which is
  exactly such a churn**, so the honest first measurement here is how often the cache is being
  re-written and why, not an assumed saving.
- **The batch API does NOT fit the decide path, and this is a latency fact rather than a policy one.**
  The lane decides on a 15-minute bar; an asynchronous batch queue cannot answer inside that bar. It
  **does** fit the offline research harnesses (`candidate-model-eval`, `playbook-space-replay`), whose
  spend the charter's own `$0` clause already concedes is real API spend. **So batch is a research-cost
  lever, never a decide-cost lever** — do not carry it as one.

**The binding clause from the scoreboard applies to this entire section and is not softened here:**
*"cutting spend purely to postpone S3, while gross stays negative, is gerrymandering the stop."* The
cost-inversion axis is justified **only** because it changes which bar an entry-policy program is
measured against — never because it buys burn-rate headroom.

## (iv) Promotion-gate redesign — derived, not asserted

### The current gate is arithmetically unpassable, and that is the unrebutted reading

- **An arm must post +20.9 / +26.4 / +33.8 / +81.4 bps** at h=1/4/8/24 to clear the research bar
  (mean **and** bootstrap CI lower bound above the bar, under the pre-registered Bonferroni α;
  measured against Family A's −12.15 / −22.58 / −35.38 / −71.83 at α=0.0125, n=78–82 over 15
  clusters, 4 of 4 cells POWERED, **0 passes**). **The best cell ever recorded anywhere in this
  program is −7.12 bps.**
- **The bar is CLUSTER-limited and unreachable at h=1 and h=4 at ANY cluster count**; h=8/24 need
  **64–219 clusters**. **Rows accrue with time; clusters do not.** Waiting longer adds rows to
  existing clusters — running the arm for a year and running it for a week hit the same ceiling.
- **The universe is 28 distinct base assets, not 40 symbol strings**, and 28 is a *ceiling* requiring
  every base asset to carry a scored entry in the window, not an expectation. The shipped passive
  benchmark uses the same 28-asset unit (`682b6f6`, equal-weight, exposure-matched, coverage 28/28,
  failing CLOSED in the adapter).
- **"STOP with extra steps", unrebutted.** The mechanism, stated plainly: **a 24.00% hit rate against
  a 41.65% gross break-even is what "cannot be passed" means** — and **that bar was itself never
  derived** (§ (ii)).
- **The deployment-side gate is separately blocked, and not by the window.** At B (2026-08-10T08:52:03Z)
  `INSUFFICIENT_WINDOW` has **cleared** at 17.50 > 14 days — and the gate still does not open, because
  `NON_POSITIVE_NET_PNL` and `BELOW_PASSIVE_BENCHMARK` were never touched by the window.

### What a successor's gate must be, stated as a derivation shape

**No thresholds are invented here.** A successor gate is derived from what a finite program can
actually accumulate, in this order, each step dated and frozen before the next is taken:

1. **Declare the window and measure the accrual rate on the successor's own rows** — FLAT rows/day,
   entries/day, and **distinct base-asset clusters/day** — each with its own as-of instant and its own
   denominator. Planning figures are labelled as such and replaced by the first sealed measurement, in
   an amendment, never silently.
2. **Compute the cluster ceiling for the universe as configured**, on base assets and never on symbol
   strings, and state it as a ceiling. If the ceiling is below what any candidate criterion needs, the
   arithmetic has already answered the question.
3. **Solve for `delta_min` — the smallest effect detectable at that ceiling over that window at the
   declared alpha and power — and publish it BEFORE the criterion is chosen.** Publishing the
   detectable effect after choosing the threshold is how a gate becomes unpassable without anyone
   noticing.
4. **Set the criterion at or above `delta_min`, dated and frozen.** If no criterion exists that is
   both meaningful and reachable, **the honest output is that the gate cannot be set on this universe**
   — which is itself a decision the owner can act on, and is a better deliverable than a gate that
   reads as a criterion and functions as a stop.
5. **Declare the multiplicity ladder up front.** Alpha tightens as scored measures are added; it never
   loosens, and never after a result is seen. A standing arm re-scored every pass is sequential
   testing and must carry a spendable, finite read budget.
6. **Declare failure directions.** The permission gate for live capital fails **CLOSED**; the
   measurement that feeds it fails **OPEN** — a broken measurement must never block the thing it
   measures, and a permission gate must never open on an absent one.

**Refusal list item 5 binds this section in full and this draft does not touch it:** do not touch the
promotion gate, the four live gates, the bootId-bound arming ceremony, or `MIN_WINDOW_DAYS`. A
successor gate is a **new** instrument requiring its own owner decision; it is not an edit to the
running one.

## (v) Operating constraints carried forward

### The feed wedge, and the emergency lever

**A host suspend caused the Pass-65 feed wedge, and nothing in-process could recover it.** Pinned
**ccxt 4.5.58 memoises the REJECTED markets-load promise forever** — `Exchange.js:891-903` resets only
`reloadingMarkets`, while `marketsLoading` is cleared exactly once, in the constructor at `:135`.
Every `watch*` starts `loadMarkets()` at `reload=false`, so ONE failed load makes every later call
replay the rejection: **instant rejection, ZERO network I/O**. A suspend at 09:52Z drove 3
recreations, the last two inside the outage; both wedged **6.25 h** — **19,057 identical `fetch
failed` lines, 91 dead channels, both venues** — and `close()` is a NO-OP on a never-connected
instance (it iterates an empty `clients`), so it minted no `ExchangeClosedByUser` and never re-entered
recreation: **222 watchdog fires, zero recreations**. Verified in-process, not network: `wget` to both
exchangeInfo URLs from inside the container returned REACHABLE. **A plain `docker compose restart app`
clears it — pure in-process state — and that is the emergency lever.** The container healthcheck is
**not** a rung: compose probes only `/health/live`, which stayed 200 through all 6.25 h with
`RestartCount` 0.

**Carried into any successor:** ccxt stays PINNED, a bump requires the sandbox-URL and
error-classifier regression tests, and `hasNoMarkets` reads `exchange.symbols.length` — re-verify it
on any bump (WATCH-V4-21).

### No new daemons, crons, or background tasks

**This is the owner constraint, and it has a measured precedent rather than being a preference.** The
hourly collector daemon was **RETIRED 2026-07-29** after failing silently twice in nine days — nine
cycles of `deltas:null` after surviving the v3 cutover, then **49.6 h dead with no host reboot**. The
app now emits what the daemon scraped (`app_log_events_total`, `app_suspend_events_total`,
`app_wall_clock_skew_seconds`, `build_info`), Prometheus retains 90 d, and `loop:sweep` reads them;
rehydration is ONE command instead of a daemon plus a reader. **The retirement's cost is stated
plainly and not smoothed: there is no longer a per-hour series of counter deltas** — a question
needing per-hour resolution goes to Prometheus range queries.

**So successor automation folds into the app runtime or into the existing 3×/day loop pass, and
nothing else.** The concrete bill this presents: **the OOS session arm's hourly decide trigger is
owner-side, does not exist, and until it does no read may be sealed** — so a successor that depends on
powered per-version evidence (§ (i)) must either fold that trigger into the app runtime, or accept the
3×/day cadence and re-derive its day counts against it. A missed hour is a **gap between windows,
never a backfill**, and the worst measured host availability loss is **8% per 24 h**.

### Lease hardening is a named successor requirement

**The pass lease is time-based (2 h), binds only callers, and fails OPEN — so a dead holder is
undetectable.** **Seven collisions are on record.** P56's holder was **46.6 h stale**; **P64's was
2,398 min stale with its whole report uncommitted in the tree** (recovered by P65 as `af22c6d`);
**collision #7 landed an interactive session's `b2f7f53` mid-pass, unseen**, which is why `git log` is
run at rehydration and not only before committing. Adjacent standing hazards: `loop:fanout declare`
**OVERWRITES a live roster** (declare once per pass or join first), and staging must cover only files
the pass authored.

**Name it as a requirement, not a nicety: a successor running more concurrent lanes multiplies this
failure mode.** The design question a successor owes an answer to is the failure direction — a
mutual-exclusion lease over an append-only record has a case for failing **CLOSED** on an unreadable
or expired holder, and today it fails OPEN. **Changing that is a behaviour change and needs its own
dated record**; this draft names the requirement and declines to make the change.

### Availability, and what it bounds

The stack runs on the owner's MacBook. **Host sleep throttles everything and a suspend is what
triggered the Pass-65 wedge.** A shared-org rate limit applies. Every day count in this draft — the
4.49-day 5 pp read, the accrual rates in § (iv) — inherits the 8%/24 h haircut and is conservative by
that much or optimistic by more if the duty cycle worsens.

### One expectation this draft corrects rather than inherits

`STATUS.md` (last updated Pass 65, 2026-08-06) records **"S3 WILL LIKELY DECIDE THIS FIRST (−$200
lands ~2026-08-27)"**. **Checkpoint #1 supersedes that line.** At B the measured book is
**−$81.2138271444** against a projected −$97.1352 — **better than projection by $15.92 (16.4%)** — and
every restated rate now lands **after** the 2026-08-31 close: forward-window −$2.3037/day →
2026-09-30; wall-clock epoch −$4.0818/day → 2026-09-08; gate-`windowDays` −$4.6407/day → 2026-09-04;
the pre-declared composed −$5.2088/day → 2026-09-02. **The window still closes 2026-08-31 and the
−$200 trigger is still −$200; what changed is which mechanism is expected to fire first.** The program
should now be expected to **end on the written verdict, not on a triggered S3** — and a successor
charter is therefore a document the owner is expected to actually decide on, rather than one a budget
stop pre-empts.

## What this draft cannot answer

- **It has no out-of-sample evidence, and neither does anything it cites.** Every figure above comes
  from one book, one 10.85–19.90 day window, one regime, **12 traded base assets of 28**, all demo
  (`mode='testnet'`, 295 of 295 fills). **The OOS session arm — the instrument § (i) puts at the
  centre — has never run**: it is UNSTARTED, no window sealed, no read scored. This draft's central
  measurement device has produced exactly zero readings.
- **It does not know whether entry policy is learnable at all on this universe.** `NO_SURVIVOR` is
  **UNSUPPORTED, not proven dead** — but the searches that came back empty were large: **4,562
  price-TA backtests, 8 families, long+short, 15m–1d, fees 0→20 bps, ZERO honest survivors at any fee
  level including 0 bps**; a **1,807-cut** subgroup search with **0 of 188 counterfactual cuts positive
  at n≥8**; a random entry at the model's own bracket geometry earning **gross −1.07 bps (a
  martingale) and net −21.07 bps, i.e. exactly the fee**. Against that, six of eight live playbook
  versions were never powered enough to read. **Whether the eighth thing to try is different in kind
  from the first seven is precisely what this draft cannot establish.**
- **The cost-inversion axis is DEAD, not unpriced — and the successor is worse off for it, honestly.**
  The ToS/fair-use gate was reviewed and **refused** 2026-08-10 (Gate 2). No dollar, bps or
  S3-headroom figure for a subscription-scale decide backend appears anywhere above, and now none ever
  will. **What remains cannot reach the gross bar.** The surviving numerator levers — fewer cadence
  decides, a prescreen tier, cache discipline — shave a term whose measured size is $17.81 of pure
  cadence spend against a gap of ~88.8 bps/trip to the all-in bar. **They do not turn the unreachable
  bar into a reachable one; they make it slightly less unreachable.** A successor charter that
  pretends otherwise is doing the thing this program exists to refuse.
- **So the honest statement of the successor's problem is harder than this draft's § (iii) originally
  implied:** it must find entry quality good enough to clear an **all-in** bar, on API economics, or
  it must find capital — the one input the program does not control and the only other denominator in
  the identity. **Neither is a lever; both are preconditions.** Whether that is worth attempting at
  all is the owner's call at the 08-31 verdict, and this draft deliberately does not pre-empt it.
- **It proposes no promotion threshold, and cannot.** § (iv) gives a derivation shape; the numbers it
  would produce depend on an accrual rate measured on rows a successor has not yet generated. A gate
  asserted here would repeat the exact defect it is written to correct.
- **It carries no control arm and can attribute nothing.** The lane already runs an uncontrolled live
  change — v10 `inverted` and `AGENTIC_PLAN_AUTHORITATIVE_EXITS`, same boot, 2026-07-30, no control —
  and the forward-window improvement in § (iii) has **full regime confound and zero lever confound**.
  **Nothing measured after any enable can be attributed to that enable alone.**
- **It measures no edge and rescues no verdict.** The ENTRIES and `NO_SURVIVOR` verdicts, the two-bar
  rule, guardrails 1–5, and the entire refusal list stand untouched by every word above. **The single
  largest fact this draft inherits — that gross is negative with inference free — is a statement about
  trading that no cost architecture explains.**
- **It authorises nothing.** No code change, no deploy, no spend, no enable, no live-money step. It is
  owner-approved at or before 2026-08-31, or it is nothing.
