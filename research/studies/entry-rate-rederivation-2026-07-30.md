# Entry-objective re-derivation — change-discipline record (2026-07-30)

**This is a pre-registration, not a report.** It records — before the change is made — that the
agentic lane's entry objective is being inverted: from _a flat week is a failing week_ to _abstention
is a permitted terminal state_. It is written first because the authority under which the change is
made requires it to exist first.

**Authority: owner autonomy grant 6 (2026-07-22).** Any owner gate or criterion in this program is
changeable by the loop **provided a dated, pre-registered change-discipline record exists before the
change** — "change-discipline binds every change — pre-register, record what/why, never rewrite
history" (`research/loop/charter.md:166-168`, carrying the owner's verbatim grant "You are welcome to
change any owner gate/decision (not live flip; that's only me)"). The single exception, unchanged and
untouched here, is the live-money flip.

Note on the numbering: `charter.md` does not number its grants. Grant 6 is the loop's own ledger
label for the change-discipline clause of the 2026-07-22 gate-override entry; the charter labels the
widest facet of the same entry "grant 7" (`charter.md:183`). Both facets sit in
`charter.md` § Gate-override audit + classification (`:160-183`).

**Ordering constraint this record creates:** no step that mints, promotes or deploys a playbook
written against the new objective may run before this file exists. That is the whole point of a
pre-registration; a record written after the fact is a rationalisation.

## 1. What is being changed

The **ANTI-RATCHET OBJECTIVE**, currently the X6 block of the reflection system prompt at
`src/features/strategy/agentic/reflection.service.ts:526-537` (line range verified 2026-07-30; it has
not drifted). It reaches the reflection model on every revision call as part of the string joined at
`:553`.

Quoted verbatim, with the source array's `' '` join applied — the reflection service is scheduled for
deletion in a later step of this pass, so this quote and `research/loop/playbook-authoring.md` are the
only places the text survives:

```text
ANTI-RATCHET OBJECTIVE (X6, the gravest observed failure mode): because this loop only ever SEES realized losses, past revisions ratcheted filters tighter until entries stopped entirely — and a flat week is a FAILING week, not discipline: the promotion gate needs roughly two closed round trips per day. A hold that preceded a favorable move of more than 1% within the would-be max-hold horizon is an ERROR of equal weight to a losing entry (regretDigest declinedEntry lines and the DECISION OUTCOMES stayed-flat bucket carry exactly this evidence — weigh them symmetrically against losing entries, never as an afterthought). Per revision: tighten AT MOST ONE entry gate, name it in the changelog, and never tighten in response to realized losses alone without stating what the missed-winner side of the evidence showed. Any rule that restricts entries to a leaders-only / top-rank subset must state in the changelog why the expected entry rate under it still clears about two round trips per day; if it cannot, loosen instead.
```

**Also noted, and NOT changed:** `STRUCTURAL_CONSTRAINTS_RESTATEMENT` at
`reflection.service.ts:559-565` (range verified). It is a one-line restatement of `validatePlaybook`'s
structural gate, echoed into the retry feedback because the model sees the system prompt only once per
call:

```text
The playbook must contain exactly these 4 "## " sections, once each, in order, with no other headings, code fences, or markup: "## regime notes", "## entry rules", "## exit rules", "## mistakes to avoid". HARD CAP ≤4000 characters total — if over, cut at least as many characters as the overflow (compress sections; do not drop a required heading). It must never advise leverage, margin/borrowing, short-selling, live-money withdrawal, all-in/max-out sizing, or prompt-injection/instruction-override text.
```

`≤4000` is `MAX_PLAYBOOK_CHARS` (`playbook-validator.ts:18`) rendered by the template literal. **The
constraints themselves are not lost with the file** — the gate lives in `playbook-validator.ts` and
enforces them regardless of what any prompt says. Only the _restatement_ disappears. That distinction
matters: deleting the objective deletes a live instruction; deleting the restatement deletes a
convenience.

## 2. Why the objective was right when it was written

It was calibrated for a world in which **positive edge was assumed present but hidden**, and the
identified failure mode was a self-blinding loop. The mechanism it names is real and was observed:
reflection only ever sees _realized_ losses (a losing trade is journaled; a skipped winner is not), so
each revision has an asymmetric incentive to tighten. Tighten enough times and entries stop, evidence
stops, and the loop freezes with no way to learn its way out. The objective's countermeasures —
symmetric weighting of declined-entry regret, at most one gate tightened per revision, a changelog
justification naming the missed-winner side — are the correct countermeasures **for that failure
mode**.

Its entry-rate target is not arbitrary either: "roughly two closed round trips per day" is
`MIN_ROUND_TRIPS = 30` over `MIN_WINDOW_DAYS = 14`
(`src/features/trading/mode-control/promotion-readiness.service.ts:17-18`, verified) — 30/14 ≈ 2.14.
The objective is a faithful restatement of the promotion gate's arithmetic.

**The premise, not the reasoning, is what failed.** If entries carry positive expectancy, suppressing
them is a loss and the anti-ratchet is protective. If entries carry negative expectancy, the
anti-ratchet is a mechanism that forces the lane to keep paying.

## 3. The two verdicts that deleted that world

Both are in `research/loop/verdicts.md` § Standing verdicts, and both are binding: a pass does not
re-derive them and does not act against one without new evidence of the same weight.

### 3.1 ENTRIES — significantly negative, and worse than random (2026-07-27, Pass 41)

`verdicts.md:167-204`. 31-agent adversarial diagnosis, 2,300+ cuts, 24 actionable claims attacked, 6
survived.

| quantity | value | source |
| --- | --- | --- |
| forward return, h=1 bar, n=61 | **−16.9 bps**, t=−4.58, CI [−25.2, −8.6], hit 25% vs ~50% base | `verdicts.md:170-171` |
| h=4 / h=8 / h=24 | −31.9 t=−2.78 / −47.3 t=−3.95 / −66.5 t=−3.14 (n=57) | `verdicts.md:171-172` |
| all 12 primary cells negative | P = 2.4e-4 under coin flips; survives Bonferroni over 195 cuts (α=2.56e-4) at four cells | `verdicts.md:172-173` |
| random-bar placebo, same symbols and long/short mix | **p = 0.0013–0.0037** | `verdicts.md:179-180` |
| conditional-subgroup search | 1,807 cuts, **0 of 188 counterfactual cuts positive at n≥8**; BH at q=0.05 yields zero discoveries; family-wise permutation p = 0.378 | `verdicts.md:190-192` |

Two hedges in that verdict survive quotation here and are not softened: the market-neutral residuals
are "~half the size and still significant at h=1/8/24 … but NOT at h=4 — so the causal 'picks bad
bars' reading holds net-of-beta at three of four horizons, not all four" (`verdicts.md:176-178`), and
the short leg (n=18) "is not significant on its own" (`:175-176`).

The load-bearing clause is the placebo. Negative expectancy alone would be consistent with "no edge,
paying fees". **Worse than a coin flip on the same symbols and the same long/short mix** is a
different claim: the selection is actively costly.

### 3.2 NO_SURVIVOR — playbook-space replay (2026-07-30, Pass 48)

`verdicts.md:17-42`; full study `research/studies/playbook-space-replay-2026-07-28.md`. 20 of 20
pre-registered cells scored, **0 passes**, across 2 models × 4 playbook arms × 4 horizons, 354 recorded
FLAT rows, α = 2.5e-3, joint verdict computed by `aggregateVerdict`
(`research/candidates/playbook-space-joint-verdict-2026-07-28.json`). Cost $39.3 of the $115 funded.

- **The model is not the lever.** `champion_v8` on identical rows: sonnet −12.7 / −36.3 / −32.7 / −70.1
  bps at h=1/4/8/24 (n=70); kimi-k3 −10.7 / −29.6 / −44.1 / −66.1 (n=100). Two vendors, schema
  compliance 92.9% vs 48.7%, entry rate 21.8% vs 62.0% — entry quality indistinguishable, every cell
  failing on the mean (`verdicts.md:22-25`).
- **Prose is not the lever.** `minimal` (no guidance at all) is −13.3 bps at h=1, within a bar of the
  champion; `momentum_pure` runs −12.7 → −85.3. All arms changed 9–55% of decisions against the
  champion, so the prose moved behaviour without moving the sign. Zero inert arms
  (`verdicts.md:29-31`).
- **The ENTRIES verdict reproduces under the repaired harness** (−12.7 sonnet, −10.7 kimi), so the
  capabilities defect fixed mid-study did not manufacture it (`verdicts.md:32-33`).

**Both hedges from that verdict are reproduced intact, because dropping them would overstate this
record's own foundation:**

> **SCOPE LIMIT, binding on any write-up:** four arms on sonnet and one on kimi is not the twelve-arm
> span the original decision rule assumed. **0 passes ⇒ the learning hypothesis is UNSUPPORTED on the
> funded arms, NOT proven dead.** (`verdicts.md:34-36`)

And the one cell that is not flatly dead, quoted with its own hedging intact:

> **One live thread, and it is a FAIL:** `inverted` at h=8/24 posts means of **+19.3 / +47.6 bps**
> above the +13.0 bar with an h=24 placebo p of **0.0020 (below α)** … It fails on interval width (CI
> lo +1.1, −12.2) at n=117 / 20 clusters. In-sample, one 6.35-day regime, and largely a sign-flip of a
> known negative. **Never quote +47.6 as an edge** (`verdicts.md:38-42`).

So this record does not rest on "the lane is proven dead". It rests on the narrower and better-evidenced
claim: **across everything actually tested, entries are negative, the negativity is invariant to model,
prose and horizon, and no attribute-based filter exists to fix it.**

## 4. The arithmetic that makes "trade less" the only lever with positive expected effect

All figures from `verdicts.md:181-204`.

| quantity | value |
| --- | --- |
| realised gross, n=27 (4 open cycles marked, all four losing) | **−106.0 bps/trip** |
| realised gross, n=23 closed only, on $1,982.66 notional | −101.9 bps/trip, CI [−185, −8], P(gross > 0) = 0.018 |
| **random** entry at the model's own declared 2%/4%/48-bar geometry | **gross −1.07 bps** — a martingale — and **net −21.07 bps, i.e. exactly the fee** (34 symbol×side cells, 32,368 overlapping windows, intrabar resolution, cluster-robust t = −12.83) |
| six-bracket geometry sweep (1/2, 1.5/3, 2/4, 3/6, 2/2, 4/2) | every bracket in [−24.32, −18.93] bps net |
| required gross edge for net-of-cost break-even | **+13.0 bps/trip** demo, **+24.2** live (20 bps) |
| the gap | **115–130 bps/trip** |
| LLM spend as a share of the loss | $15.48 of the $37.56 net loss — **free inference still leaves −$22.08** |

**The subtraction that decides this record.** Gross of the realised book is −106.0 bps/trip; gross of a
random bar at the same geometry is −1.07 bps. Both are gross, both at the same bracket geometry, so
they subtract:

```text
-106.0  −  (-1.07)  ≈  -105  bps per round trip
```

**Entering at the bars this lane picks, and exiting the way it exits, costs roughly 105 bps per round
trip against picking bars at random.** Fees are not the problem — a random entry pays the same fee and
lands at exactly −fees. **Read this figure with § 8.4: roughly 30 of those 105 bps are attributable to
discretionary exits rather than to bar selection**, because the realised leg carries the model's own
early closes while the random baseline is mechanical. That splits the lever in two — ~77 bps of bar
selection and ~30 bps of exit drift — and both are addressable separately. The lever conclusion
survives either attribution; the precise split does not, so no downstream decision should rest on it. Under any bracket in the sweep a random entry earns ≈0 gross, so **only entry
alpha exceeding fees can produce profit** (`verdicts.md:185-186`), and there is none to be found: the
1,807-cut search is exhausted, and the 20-cell playbook-space grid found no text that changes the sign.

There is a second, independent measurement of the same lever. The playbook-space study's net-terms
corollary (`verdicts.md:26-28`): at equal gross expectancy the higher-frequency lane is strictly worse —
kimi took ~3× the round trips for the same edge, so ~3× the fee drag. "Which lane is best" resolves to
"**sonnet, and only because it trades less** — the very lever the live objective suppresses."

**Three mechanisms currently suppress that lever, and all three are deliberate:**

1. **The objective itself** (`reflection.service.ts:526-537`) — "a flat week is a FAILING week", plus
   the standing instruction that a leaders-only restriction must justify clearing ~2 round trips/day
   "if it cannot, loosen instead".
2. **The mint-time entry-rate floor** — `measureEntryRate`
   (`src/features/strategy/agentic/entry-rate-floor.ts:320-348`) replays a candidate against
   `DEFAULT_MINT_FLOOR_ROWS = 12` recent real FLAT-position states and vetoes the mint unless
   `DEFAULT_MINT_FLOOR_MIN_ENTRIES = 1` entry fires (`reflection.service.ts:121-123`, invoked
   `:1711-1752`). It fails OPEN below `DEFAULT_MINT_FLOOR_MIN_ROWS = 6` parseable replays, correctly —
   a transport failure is not an abstention. **A playbook whose entry rules never fire cannot be
   minted.**
3. **The live-abstention lapse** — `DEFAULT_ABSTAIN_LAPSE_DECIDES = 15` (`reflection.service.ts:124-128`,
   `.env.app:133`): an unresolved candidate with ≥15 attributed real decides and zero entries lapses
   immediately, ahead of the `AGENTIC_CANDIDATE_LAPSE_HOURS=336` age lapse (`.env.app:129`). **A
   playbook that abstains in production is discarded for abstaining.**

A falsifiable claim inside mechanism 2 that is now wrong and should be corrected or deleted with it: the
veto feedback text asserts "champion enters ~28% of such consults" (`reflection.service.ts:1748`). The
live recorded rate across the study corpus is **16.1%**, and the repaired replay measures **19.1%**
(`playbook-space-replay-2026-07-28.md:703`). The prompt overstates the champion's own entry rate to the
model it is judging.

## 5. The accepted cost, stated plainly

**At a reduced entry rate the promotion gate becomes UNREACHABLE. This is intended, not a side
effect.**

The gate requires ≥30 closed round trips within a ≥14-day trade-anchored window AND positive
net-of-cost PnL (`promotion-readiness.service.ts:17-18`). Fewer entries means fewer closed round trips
means the 30-trip clause is never satisfied within any window the 14-day clause admits. There is no
reading of the new objective under which the gate is still reachable, and this record does not offer
one. The lane will not become promotable while this objective is in force.

**Why that is the right trade, and the justification is already on record.** From
`research/loop/STATUS.md:35-39`:

> **Before treating resumed trading as unambiguously good, read `verdicts.md`.** Entries measure
> significantly negative and worse than a random-bar placebo, so a live lane spends ~$2.6/day
> accumulating evidence for a gate the present signal provably cannot pass.

The gate has two clauses and the present signal fails the second by 115–130 bps/trip. Trips accrued at
−106 bps/trip move the trip counter toward 30 **while moving net-of-cost away from zero**. STATUS.md's
Pass-48 book reading is this mechanism observed directly (`STATUS.md:61-70`): the window advanced 2.4
days and 29 closed round trips (was 28) while net-of-cost went **−$39.6370 → −$41.1723**, `$1.54`
worse, `agentic_promotion_ready` 0 — "every additional trip on the present entry signal moves the first
number toward the bar while moving the second away from it."

So the thing being given up is **the ability to satisfy clause 1 of a gate whose clause 2 the signal
cannot satisfy at any trip count**. Preserving reachability would mean continuing to spend ~$2.6/day of
LLM budget plus ~106 bps per trip of book to accumulate a counter that cannot unlock anything. We are
choosing not to. Unreachable is the accepted outcome, chosen with the arithmetic in front of us.

Two consequences that follow and are accepted with it:

- **The lane cannot earn live access while this holds.** Hard rule 4's `assertAgenticLaneNotLive` will
  keep refusing a live boot because `PromotionReadinessService` will keep returning a non-permitted
  verdict. Nothing about the four live gates or the bootId arming ceremony changes, and nothing here
  touches the live-money flip.
- **The promotion gate is not being weakened to compensate.** No clause is relaxed, no threshold moved,
  no port bound. The 2026-07-07 `MIN_WINDOW_DAYS` 14→10 pre-authorization stays UNFIRED
  (`charter.md:111-113`) — its trigger requires net-of-cost > 0, which is exactly what does not hold.
  Making an unreachable gate reachable by lowering it would be the failure mode this program exists to
  avoid.

## 6. Reversal condition — pre-registered, testable, not re-litigable

A future pass that wants a pro-entry objective back **runs this trial. It does not argue.** Restating
the case for entries without new measurement is not evidence and does not reopen this record.

**The pro-entry objective is restored if and only if a named entry signal posts, on a corpus disjoint
from any corpus used to select or tune it, all of:**

1. **mean forward return > +13.0 bps** per round trip at the pre-registered horizon (the demo fee floor,
   `verdicts.md` § THE ENTRY SIGNAL "Cost cutting cannot close the gap"; +24.2 bps if the intended
   venue is live). _Citation corrected 2026-07-31 — this previously pointed at `verdicts.md:202-203`,
   which is the Moonshot HTTP-200 verdict, not the fee floor. The threshold is deliberately left at
   +13.0 even though the measured demo cost is **9.29 bps/round trip**
   (`research/studies/fee-floor-derivation-2026-07-31.md`): this is a REVERSAL condition, so a
   conservative floor is the correct direction and lowering it would weaken the trial this record
   exists to require._
2. **bootstrap 95% CI lower bound > +13.0 bps**, resampling **symbols, not entries** (5,000 draws) —
   multiple entries on one symbol within hours are not independent observations;
3. **random-bar placebo p < the trial's pre-registered Bonferroni α**, same symbols and same long/short
   mix — the signal must beat a coin flip, not merely beat zero;
4. **both chronological halves > +13.0 bps**;
5. **trimmed mean (drop best and worst observation) > +13.0 bps**;
6. **n ≥ 12 entries across ≥ 12 symbol clusters** ("never act on a sub-n≥12 cell",
   `playbook-space-replay-2026-07-28.md:166-167`);
7. all of the above under a **dated pre-registration frozen before the first scored call**, naming the
   corpus hash, the horizon, the family size and the α.

Clauses 1–7 are the frozen playbook-space bar (`playbook-space-replay-2026-07-28.md:149-167`, α re-set
to 2.5e-3 at `:724-736`) plus one addition: **out-of-sample is mandatory.** That study was in-sample by
construction and said so (weakness 3, `:220-223`). A reversal is a decision to spend book and budget
again, so it does not get the same latitude.

**Explicitly NOT a reversal** — each of these is a shape already seen and already rejected:

- A positive point estimate whose CI spans the bar. `inverted`@h24 is exactly this: mean **+47.6 bps**,
  CI lo **−12.2**, placebo p 0.0020 — and it is a **FAIL** under the frozen rule. "Never quote +47.6 as
  an edge" (`verdicts.md:38-42`).
- A positive result on the corpus that generated the hypothesis.
- An arm beating another arm without clearing the absolute bar. "Ranking is not passing"
  (`playbook-space-replay-2026-07-28.md:414-416`) — a field of failures has a winner and that winner is
  still a failure.
- A sign flip of a known negative, absent its own out-of-sample entries (`verdicts.md:90-105`: the
  inversion test is "arithmetic, not evidence").
- "The promotion gate is unreachable" offered as an argument on its own. That is this record's accepted
  cost, not a finding against it.

**Until a reversal fires, the objective's target is:** minimise entries subject to the lane remaining
observable. Abstention is a permitted terminal state, and a flat week is a correct week.

## 7. Scope — what this record does and does not authorise

**Authorised:** changing the entry OBJECTIVE, and the mechanisms whose sole purpose is to enforce it
(the mint-time entry-rate floor and the live-abstention lapse, § 4 mechanisms 2 and 3).

**NOT claimed, by this record, at all:** that any replacement playbook has edge. Nothing here measures
one. A playbook that abstains more is expected to lose less **arithmetically** — it pays the ~105
bps/trip selection cost fewer times — and that is a cost argument, not an alpha claim. Any document
reading this record as evidence that a new playbook works is over-reading it.

**Two different bars are in play in this pass and they must not be conflated:**

| bar | question it answers | threshold |
| --- | --- | --- |
| **research bar** | does this signal have edge? | mean > +13.0 bps **and** CI lower bound > +13.0 bps **and** p < the pre-registered Bonferroni α, out-of-sample (§ 6) |
| **deployment bar** | is this better than what is running right now? | beats the currently running playbook |

The accompanying deployment decision, recorded separately in this pass, runs on the **deployment bar**.
**A research-bar FAIL can still be a correct deployment**, because the comparator is not zero and not
+13.0 bps — it is a champion measured at −12.7 bps at h=1 on the repaired harness. Replacing a
negative-expectancy incumbent with something that loses less is a defensible deployment and an
indefensible edge claim. This record authorises the first reading and forbids the second.

Nothing here touches: the four live gates, the bootId-bound arming ceremony, the promotion gate's
thresholds or clauses, hard rules 1–7, or the §4 MUST-NOT structural invariants.

## 8. Weaknesses of this record, stated against itself

1. **The evidence base is narrower than the change.** The playbook-space grid funded 4 sonnet arms and
   1 kimi arm, not the 12-arm span its decision rule was calibrated on. Seven arms were never
   edge-tested, and three of them (`meanrev_pure`, `leaders_only`, `one_symbol_btc`) yield zero entries
   on this corpus and are untestable there at any budget (`verdicts.md:34-37`). This record changes a
   standing objective on evidence its own source labels **UNSUPPORTED, not proven dead**.
2. **One regime.** The corpus is 6.35 calendar days, 2026-07-21 → 07-27, 26 symbols
   (`playbook-space-replay-2026-07-28.md:69-70`). The ENTRIES verdict's realised book is n=27 trips.
   Neither generalises across regimes, and a regime in which this lane's entries are merely _flat_
   rather than _anti-predictive_ would change the arithmetic of § 4 substantially — though not its
   sign, since flat gross still nets −fees.
3. **A self-fulfilling measurement risk, and it is real.** Under the new objective the lane produces
   fewer entries, so the corpus that would have to falsify this record grows more slowly. That is why
   § 6 is written against an **external, disjoint** corpus and not against the live journal: the
   reversal test must not depend on evidence the change itself suppresses.
4. **The −106.0 vs −1.07 subtraction assumes the two are commensurable.** They are both gross and both
   at the model's own declared bracket geometry, which is why it is stated as gross-vs-gross. But the
   realised figure carries discretionary early closes (16 of 22 closes were the model's own `close`
   action, `verdicts.md:215-216`) while the random baseline is mechanical. The exit study bounds that
   gap: running the model's own declared plan mechanically instead of its hand is worth +29.7 bps —
   real, but "under the pre-registered 30 bps bar and nowhere near profitability"
   (`verdicts.md:214-215`). So the selection cost is ~105 bps with roughly 30 bps of it attributable to
   discretionary exits rather than to bar selection. **The lever conclusion survives either
   attribution**; the precise split does not.
5. **`inverted` remains genuinely unresolved.** Its h=24 placebo p of 0.0020 is below α, which a
   pure-beta explanation would not produce, so its entry timing carries _some_ information. It fails
   the frozen bar on interval width, it is in-sample, and it is largely a sign-flip of a known
   negative. If it were ever tested out-of-sample and passed § 6, that would reverse this record — and
   that is the correct way for this record to be overturned.

## 9. AMENDMENT 2026-07-31 — §5 described a rolling window that does not exist

**Nothing above this line has been edited.** This program amends records; it never rewrites them. §5
stands as written and is now read together with this section.

**What is corrected:** the MECHANISM §5 gives for the gate being unreachable (`:203-206`), and one
consequence of the same misreading in §2 (`:65-68`). **What is NOT corrected:** the conclusion. The
promotion gate is not reachable on this edge. That survives intact, on arithmetic that is cleaner than
the arithmetic the record originally offered.

### 9.1 What this amendment is, and the three things it is not

§6 (`:276-277`) excludes "The promotion gate is unreachable" offered as an argument on its own from
being grounds to restore the pro-entry objective. **This amendment is not that argument and must not be
read as an opening for it.** Stated explicitly, because the failure mode is foreseeable:

- **Correcting a stated mechanism against the live gauges is a MEASUREMENT of the gate's own code, not
  the excluded argument.** It reports what `PromotionReadinessService` computes. It moves no evidence
  about whether entries are profitable, and it is offered as a repair to this record, not as a case
  against it.
- **§3 and §4 are UNDISTURBED.** Entries measure −16.9 bps at h=1, t=−4.58, hit 25% against a ~50% base
  (`:86`), and lose to a random-bar placebo on the same symbols and the same long/short mix at
  p = 0.0013–0.0037 (`:89`). The ~105 bps/trip gross-vs-gross selection cost (`:155-165`) and its
  attribution hedge (`:324-332`) are untouched. Not one figure in either section depends on how the
  window clause is computed, and nothing below re-opens either.
- **Nothing here licenses "so trade more."** See § 9.5. The corrected mechanism makes the "trade more"
  reading _worse_ founded than the wrong mechanism did, not better.

### 9.2 What the code actually does — verified 2026-07-31, with line numbers

All in `src/features/trading/mode-control/promotion-readiness.service.ts` unless stated.

| fact | line | what is there |
| --- | --- | --- |
| evidence fetch | `:75-80` | `this.stats.fillsForMode(DEMO_MODE, epochMs)` inside the `Promise.all` — **every** fill at/after the epoch. The port contract says so verbatim: "sinceMs, when set, filters to fills executed at/after that instant (evidence-epoch gating); absent ⇒ all-time" (`src/ports/trading/promotion.ts:92-95`). There is no upper bound and no trailing period. |
| cycles | `:83` | `walkRoundTrips(fills, dustNotional)` over that whole set — cumulative since epoch, never a slice. |
| window | `:100-112` | `firstClosedAt`/`lastClosedAt` are `Math.min`/`Math.max` of `closedAt` over **all** cycles; `windowStart = Math.max(firstClosedAt, epochMs)` (`:107-110`); `windowDays = (lastClosedAt! - windowStart) / DAY_MS` (`:111-112`). A single span from first close to last close. |
| count clause | `:129` | `if (cycles.length < MIN_ROUND_TRIPS) reasons.push('INSUFFICIENT_ROUND_TRIPS')` — a cumulative count, compared to a constant. |
| window clause | `:131` | `if (windowDays < MIN_WINDOW_DAYS) reasons.push('INSUFFICIENT_WINDOW')` — a **separate** `if`, on a **separate** quantity. |
| thresholds | `:17-18` | `const MIN_ROUND_TRIPS = 30;` `const MIN_WINDOW_DAYS = 14;` |
| verdict | `:156` | `reasons.length === 0 ? { permitted: true … }` — every clause must be clear **at one and the same evaluation**. |

**The two counters are independent conjuncts, both cumulative since the evidence epoch
(`PROMOTION_EVIDENCE_EPOCH=2026-07-21T11:21:00Z`, `.env.app:178`), and both monotone non-decreasing:**
`cycles.length` only grows as closing fills append, and `windowDays` only grows because `windowStart`
is pinned while `lastClosedAt` is a running maximum.

Two boundary conditions on that monotonicity, stated so the claim is not stronger than the code: it
holds **for a fixed evidence epoch over an append-only fill history**. Moving `PROMOTION_EVIDENCE_EPOCH`
forward would cut both counters, and the service's own straddle note (`:53-70`) documents that an epoch
declared mid-position suppresses trips — in the fail-closed direction, never a false permit.

**Therefore §5's sentence at `:203-204` — "fewer entries means fewer closed round trips means the
30-trip clause is never satisfied within any window the 14-day clause admits" — describes a rolling
14-day window inside which 30 trips must land. No such window exists in the code.** The 30 and the 14
are never composed into a rate. `:129` never reads `windowDays`, and `:111-112` never reads
`cycles.length` beyond the non-empty guard.

### 9.3 The correct derivation, and its source

Re-derived by the loop at `research/loop/STATUS.md:78-85` and reproduced here rather than restated
loosely. Live book at 2026-07-31T09:52Z (`STATUS.md:62-65`):

| gauge | value | clause |
| --- | --- | --- |
| closed round trips | **35** against a floor of 30 | `INSUFFICIENT_ROUND_TRIPS` (`:129`) is **NOT FIRING**, and being monotone it cannot fire again |
| trade-anchored window | **7.329** of 14 days | `INSUFFICIENT_WINDOW` (`:131`) **IS FIRING** |
| net-of-cost PnL | **−$42.3358** (LLM cost $19.41) | `NON_POSITIVE_NET_PNL` (`:130`) **IS FIRING** |
| `agentic_promotion_ready` | **0** | `reasons.length !== 0` (`:156`) |

So the count clause was already satisfied before this record was written, and the record's §5 argued
against a clause that had stopped binding. **The window binds, not the count.** `windowStart` pins to
the first closed trip at **2026-07-23T18:00:26Z**, so `windowDays` cannot reach 14 before
**2026-08-06T18:00Z** whatever happens in between (`STATUS.md:79-81`) — the pin is `Math.max` of a fixed
first close and a fixed epoch, so no trading pattern moves it.

**The binding clause on the merits is `NON_POSITIVE_NET_PNL` at −$42.3358.** For `permitted` to be true
at the earliest arithmetically possible instant, net-of-cost must also cross zero by then: **+$55 to
+$62 over ~6.3 days, i.e. +5.5% to +6.2% on the $1000 effective book**, about +$2.4 to +$2.8 per trip
against a trailing −$0.72 (`STATUS.md:81-83`). Gross trading is negative (−$24.86), so **cutting LLM
spend to zero cannot make net-of-cost positive** — LLM spend is a tax on a losing edge, not its cause
(`STATUS.md:83-85`). That is the same conclusion §5 reached at `:216-220`, reached correctly.

**One further correction while the clause list is open.** §5 says at `:215-216` that "the gate has two
clauses". It has **seven** reason clauses (`:127-133`): `UNRESOLVED_FILL`, `UNCONVERTIBLE_FEE_ASSET`,
`INSUFFICIENT_ROUND_TRIPS`, `NON_POSITIVE_NET_PNL`, `INSUFFICIENT_WINDOW`, `FUNDING_DATA_MISSING`,
`BELOW_PASSIVE_BENCHMARK`. Two are firing today. `BELOW_PASSIVE_BENCHMARK` (`:133`) is **dark**:
`PASSIVE_BENCHMARK` appears nowhere outside the port and this service, so `this.benchmark` is
`undefined`, `passivePnlQuote` is `null` (`:119-122`) and `belowPassiveBenchmark` is `false`
(`:123-124`) — the documented land-dark posture at `:36-39`. Binding it at the composition root would
make the gate strictly harder, never easier. §5's conclusion is unaffected either way.

### 9.4 The same misreading is upstream, in §2 — and it cuts against the objective, not for it

§2 (`:65-68`) derives the ANTI-RATCHET OBJECTIVE's entry-rate target as "`MIN_ROUND_TRIPS = 30` over
`MIN_WINDOW_DAYS = 14` … 30/14 ≈ 2.14" and calls the objective "a faithful restatement of the promotion
gate's arithmetic". **Under the code as it actually reads, it is not a restatement of anything.** The
gate never divides one constant by the other. 30 trips whose first and last closes are 60 days apart
clear both clauses at 0.5 trips/day; 30 trips inside 13 days clear neither. **2.14/day is the rate
required only in the single limiting case where the window is exactly 14 days — a ceiling on the
required rate, which the objective encoded as a floor.**

This is recorded because it is an error in this record's own reasoning, and because of its direction:
the deleted objective's most concrete-sounding justification — that the promotion gate _demanded_ ~2
round trips per day — was not a property of the promotion gate. It never was. That makes §4's account
of the three suppression mechanisms (`:174-189`) stronger, not weaker.

### 9.5 What this does NOT license, stated so it cannot be quoted out of context

**"The window is trade-anchored, so trade more to advance it" is refuted by the same code that
establishes the correction.** `closedAt` is the closing fill's own `executedAt`
(`src/domain/trading/risk/round-trips.ts:200`), so `lastClosedAt` — and with it `windowDays` — advances
**only when a round trip closes**, never with wall-clock. Under the amended objective a fully
abstaining lane freezes `windowDays` at 7.329 and `INSUFFICIENT_WINDOW` fires forever. That reads like
an argument for trading. It is not, for three reasons that are all in the code and the book:

1. **Both clauses must be clear at one evaluation** (`:156`), and both are cumulative since the same
   epoch. `netPnl` (`:92`) carries every loss already taken. Trading to advance the window does not
   reset the −$42.3358; it must be earned back _on top of_ whatever the new trips cost.
2. **Each additional trip moves the two numbers in opposite directions.** At the realised −106.0
   bps/trip of §4 (`:144`), a trip advances the window while pushing `netPnl` further below zero. §5
   already recorded this observed directly (`:216-220`): the window advanced 2.4 days and the trip
   count 28 → 29 while net-of-cost went −$39.6370 → −$41.1723.
3. **The requirement that follows is a reversal test, not a trading decision.** Clearing both clauses by
   2026-08-06 needs +5.5% to +6.2% on the effective book from an entry signal measured at −16.9 bps and
   below a random-bar placebo. Producing that is precisely § 6, on a disjoint corpus, with a frozen
   pre-registration. **Trading more is not a way to obtain it.**
4. **Added 2026-07-31 (`research/studies/success-exit-2026-07-31.md`) — abstention is not neutral
   either, and this is the reason the section above is not the whole answer.** The two clauses run on
   **different clocks**: `netPnl` (`:92`) subtracts `llmCostUsd`, which accrues on **wall-clock**,
   while `windowDays` advances only on **closes**. So a lane that stops trading entirely **freezes the
   window while still burning net-of-cost — both firing clauses worsen together.** Measured live
   between two reads 1.62h apart: trip count unchanged at 35, LLM **+$0.3172**, net **−$0.2320**.
   The honest consequence: neither trading more nor trading less reaches this gate. It is not a dial
   to be turned in either direction — it is a gate that only new evidence opens, which is § 6.

**Standing after this amendment.** §5's conclusion — the gate is unreachable on this edge, and that is
the accepted, chosen cost — is unchanged and is now better founded. §6's exclusion at `:276-277` binds
exactly as before: this section is a mechanism repair against live gauges, and no pass may cite it,
alone or with §5, as grounds to restore a pro-entry objective. The only route back is the § 6 trial.
**Until it fires, the target remains: minimise entries subject to the lane remaining observable.**
