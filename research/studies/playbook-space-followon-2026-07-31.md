# Playbook-space follow-on — preregistration (2026-07-31)

Frozen before any paid call. **No paid call has been made by this document.** Two families, their
corpora, their arms, their controls, the scoring metric, the horizons, the two bars, the per-family
Bonferroni denominators, the placebo, the underpowered rule, the funded ladder, the spend cap and the
decision rules below cannot change after a result is seen. Any later variation is a new registered
trial.

**Amended 2026-07-30 to the owner-funded design, before the freeze and before any paid call.** The
amendment narrows the funded set and adds two pre-registrations; it does not touch the metric, the
horizons, the bars, the corpora or the guards. Owner decisions of record:

1. **Funded: `haiku_swarm` ($5.10) + its `haiku_single` control ($1.70) = $6.80. Nothing else in
   Family A.** Family B is unchanged.
2. **`tool_use_trader` is DEFERRED, not cancelled** (§ `tool_use_trader` — deferred, and why).
3. **The four prose arms stay deferred**, as already registered.
4. **The deployment-bar ranking is itself the product** — directly actionable: an arm that beats the
   running playbook ships regardless of its research-bar verdict (§ Decision rules).

Two consequences follow and are registered here rather than discovered later: Family A's denominator
drops to **4 cells, α = 0.0125** (§ Family A α), and the paid `incumbent_control` is replaced by a
zero-cost **sequencing constraint** with a falsifiable check and a stated residual risk
(§ The sequencing constraint).

The direct predecessor is [`playbook-space-replay-2026-07-28.md`](playbook-space-replay-2026-07-28.md).
Its 20-cell family is **SPENT** — every cell it declared was scored and the verdict
(`NO_SURVIVOR`) is published. Nothing here re-uses that denominator, and no arm below may be scored
against the predecessor's α.

## The two bars, and they are never the same bar

This section stands first because the rest of the document is meaningless without it, and because the
predecessor's `NO_SURVIVOR` — correct on the research bar — was briefly mis-applied as a deployment
veto. That specific error is what this pre-registration exists to make impossible.

Both bars are binding at once. A result can FAIL one and CLEAR the other, and when it does, **both
statements are true simultaneously and neither cancels the other.**

### The RESEARCH bar — "does an edge exist?"

An arm PASSES at a horizon only if **every** clause holds:

1. **mean forward return > +13.0 bps** — the required gross edge per trip at demo fees
   (`verdicts.md` § THE ENTRY SIGNAL; +24.2 at live 20 bps, deliberately the easier of the two).
2. **bootstrap 95% CI lower bound > +13.0 bps**, resampling **symbols, not entries** — multiple
   entries on one symbol within hours are not independent observations. 5,000 draws.
3. **p < α against the +13.0 bps null**, where α is **this trial's own per-family Bonferroni figure**
   declared below, never the predecessor's.
4. **random-bar placebo p < α** — same symbols, same long/short mix, bars drawn at random from each
   symbol's own series.
5. **both chronological halves > +13.0 bps.**
6. **trimmed mean (drop best and worst observation) > +13.0 bps.**
7. **n ≥ 12 entries.** Below that the cell is `UNDERPOWERED`: never a PASS, never a FAIL, and never
   the headline. The horizon study's n=11 cell showed +6.3% excess and _reversed_ at n=84.

The research bar governs **every claim of edge and every step toward live money.** Nothing that fails
it may be called an edge, quoted as evidence of skill, or used as promotion evidence.

### The DEPLOYMENT bar — "which of several losing options should run?"

An arm CLEARS the deployment bar if it **beats the currently running playbook** on the SAME corpus,
the SAME metric and the SAME horizon — all three declared before the comparison is looked at (below,
§ Deployment-bar declarations). It is **not α-corrected**, because it is not a hypothesis test
against a null: it is a ranking of measured means among options that all have to be somewhere.

The deployment bar governs **playbook selection and nothing else.** Owner ruling 2026-07-30,
`verdicts.md` first standing verdict: _"if a less-bad playbook is found than the running one, deploy
it. less-bad is always better than dropping it since it is CLOSER to profitability"_.

### The rule that follows, stated so it cannot be misread

**A research-bar FAIL that clears the deployment bar SHIPS.**

- A research-bar FAIL is **not** a deployment veto. It says the arm is not an edge. It says nothing
  whatever about whether the arm is better than what is running.
- The comparison is against the **incumbent**, never against zero and never against the +13.0 bar.
  Every arm in this trial is expected to fail the research bar; that expectation is orthogonal to
  which one runs.
- Shipping on the deployment bar licenses **no** write-up, **no** edge claim, **no** promotion
  evidence and **no** move toward live capital. It is a choice among losers. `verdicts.md`
  Guardrail 1 stays binding word for word.
- **`NO_SURVIVOR` is a research-bar verdict.** If this trial returns `NO_SURVIVOR` and one arm still
  beats the incumbent at the declared horizon, the correct action is to **deploy that arm and record
  `NO_SURVIVOR`**, in the same breath, without hedging either.

### Deployment-bar declarations, fixed here

- **Corpus** — Family A: the frozen 354-row corpus. Family B: the new post-cut corpus. An arm is only
  ever compared to an incumbent measured on the corpus it was itself scored on.
- **Metric** — the forward-return metric in § Metric below, identical to the −16.9 bps finding.
- **Primary horizon: h = 24.** Declared for one reason and it is not a preference: the incumbent
  deployment decision (`verdicts.md` § worked example) was itself argued at h=24, and a challenger
  compared at a _different_ horizon would be re-opening a settled choice on a metric picked after the
  fact. Ranking is horizon-specific — at h=1 the frozen ordering reads `inverted` −0.8 > `champion_v8`
  −12.7 = `momentum_pure` −12.7 > `minimal` −13.3, at h=24 it reads `inverted` +47.6 > `minimal`
  −40.7 > `champion_v8` −70.1 > `momentum_pure` −85.3 — which is exactly why the horizon is declared
  before the comparison rather than chosen after it.
- **Robustness clause:** a challenger ships only if it beats the incumbent at h=24 **and** at ≥3 of
  the 4 horizons. An arm that wins at h=24 alone is reported as **horizon-dependent** and does not
  ship. This is stricter than the owner ruling requires, and the cost is stated plainly: it can leave
  a marginally-better arm un-deployed. The justification is that "less-bad" has to mean less-bad, and
  a single-horizon win at h=24 — where the cluster SE is ~30 bps — is not distinguishable from noise.
- **Incumbent identity is read at comparison time** from `agentic_playbook_info`, not hardcoded here.
  At this document's freeze the running champion is **v8** with **v9** as an unresolved candidate on
  `AGENTIC_PLAYBOOK_AB_PCT=40`% of decides (`STATUS.md`). If `inverted` ships before this trial runs,
  `inverted` is the incumbent and the Family A comparator is `inverted`'s recorded row.
- **The Family A comparator is the PREDECESSOR'S RECORDED ROW, not an in-run re-measure**, because
  `incumbent_control` is unfunded. Both `champion_v8` and `inverted` have recorded rows in the
  2026-07-28 results, so either can serve depending on which is running. **The claim that this
  comparison is prompt-controlled is conditional on the byte-identity check** in § The sequencing
  constraint, and is reported as between-run whenever that check fails.
- **Reverting** a failed deployment falls back to the **next-least-bad** arm at the declared horizon,
  never to `champion_v8` by default (`verdicts.md` Guardrail 5).

## Budget — verified against the predecessor's spend table, not assumed

| account | funded | spent (predecessor § Spend) | remaining |
| --- | --- | --- | --- |
| Anthropic | $100.00 | **$32.51** (calibration ×3, lever ×2, sonnet edge) | **$67.49** |
| Moonshot | $15.00 | **$6.81** metered, ≈$9 conservative | **$8.19** metered, ≈$6 conservative |
| total | $115.00 | **$39.32** (34%) | **$75.68** |

The $39.3 figure in the predecessor's spend table reconciles: $32.51 + $6.81 = $39.32.

**The Moonshot balance is deliberately left unspent, and that is a design decision rather than an
oversight.** `verdicts.md` § THE DECIDE MODEL IS NOT THE LEVER is a standing verdict — two vendors,
entry quality indistinguishable, _"do not re-run a model swap expecting a different sign"_. Spending
the remaining ~$8 on kimi-k3 would re-derive a settled finding. It is also the wrong lane on cost:
measured **$0.026265/call effective vs sonnet's $0.01372, 1.92×**, because Moonshot's
Anthropic-compatible surface returns HTTP 200 with an empty body on **31.5%** of requests (172 of 546
attempts on the kimi edge leg) and every retry is charged conservatively. The cheaper account is the
more expensive lane.

**The Anthropic balance is not all available to research.** The live lane has first claim: measured
$1.86/day mean, $3.63 worst day, `agentic_budget_remaining_usd` capped at $3/day. The allocation
below is a declared split, not a residual.

## Honest prior

**Low, and lower than the predecessor's.** Five arms have now been scored against the research bar on
this corpus and **all five failed on the mean** — `champion_v8`, `minimal`, `momentum_pure`
(sonnet), `champion_v8` (kimi), and `inverted` failed on the interval. Prose has been shown to move
9–55% of decisions **without moving the sign**, and `minimal` — no guidance at all — lands within a
bar of the champion. The prior that a sixth, seventh or eighth prose arm clears +13.0 bps is low
enough that funding prose arms ahead of anything else would be poor use of the balance.

**This trial's value is therefore two things, and neither is "find an edge in prose":**

1. **The architecture axis** — the one axis with no evidence against it. Model is settled (two
   vendors, indistinguishable). Prose is settled for SIGN (`minimal` ≈ champion). Architecture has
   never been measured on this corpus at all, and `architecture-options-2026-07-28.md` names two
   concrete candidates that the existing harness can run for tens of dollars rather than build. The
   funded design buys **one** of them.
2. **The deployment-bar ranking** — which, unlike the research bar, produces an actionable answer
   whatever the means come out as. **Owner ruling 2026-07-30: the ranking is itself the product.** It
   is not a consolation output of a failed edge hunt; it is a directly actionable result, and it is
   the part of this trial that cannot fail to be useful.

### The architecture screen as a SCORED PRIOR — what it is, and what it is not

[`architecture-options-2026-07-28.md`](architecture-options-2026-07-28.md) (committed `c1206fc`,
2026-07-28) predicted **BOTH** arms negative before either was funded: haiku swarm
**NEUTRAL-TO-WORSE** (ensembling reduces variance, not bias, and the finding is a bias — averaging
more draws from a biased predictor converges _on_ the bias); tool use **WEAK** unless it reaches
information genuinely absent from the payload.

Its evidentiary class is stated here in the memo's own words so no reader upgrades it:
**reasoned-but-unmeasured.** _"No new measurement was made — both provider accounts are unfunded — so
nothing here is a finding. It is a screen."_ A screen is a prior. It cannot settle an arm, and this
trial does not treat it as having settled one.

Three things follow, and all three are registered before the result:

- **The anti-swarm argument is MODEL-AGNOSTIC.** "Ensembling reduces variance, not bias" is a
  property of averaging, not a property of haiku. It is therefore **genuinely separate** from the
  haiku-4.5 single-model decide verdict, and a reader must not collapse the two: a swarm could fail
  because averaging is the wrong lever, or because haiku is a worse decider than sonnet, and those
  are different findings with different consequences. **`haiku_single` exists to tell them apart**,
  and that is its whole job.
- **The 2026-07-30 `NO_SURVIVOR` verdict STRENGTHENS the screen, it does not weaken it.** The
  predecessor measured the failure as a **bias** — worse than a random-bar placebo, negative in both
  chronological halves, more negative under trimming. A variance-reduction instrument aimed at a bias
  is the exact configuration the screen said would not help. The prior is now better-supported than
  when it was written.
- **The memo nevertheless recommended running this test at this price** — _"it is a ~$5 question, so
  it can simply be answered"_ — and that recommendation is why the arm is funded despite a negative
  prior. **Scoring a pre-registered prediction is strictly stronger than leaving it unscored.** A
  screen that is never tested stays an opinion however well-argued; a screen that is tested becomes
  either a validated instrument for the next screening decision or a corrected one. Both outcomes are
  worth $5.10, and the negative prior is the reason the spend stops at one arm rather than two.

### The enhanced-loop interaction — pre-registered BEFORE the result

Concurrent work moves authoring, decision-history curation and entry policy onto the **free daily
loop**. That changes what a paid swarm is worth, and the direction is **down**. Three named mechanisms
are registered here **before the swarm arm runs**, for one reason: an explanation produced after a
negative result is a story, and the same explanation registered beforehand is a prediction.

1. **Wrong instrument for the measured failure.** The loop is a **bias-correction** instrument — it
   revises the text in response to realised outcomes. A swarm is a **variance-reduction** instrument
   — it averages draws at fixed text. The measured failure is a **bias**: worse than a random-bar
   placebo, negative in **both** chronological halves, and **more** negative under trimming. Trimming
   removing the tails and making it worse is the signature of a centre that is displaced, not of a
   spread that is wide. Averaging more draws from a displaced centre converges **on** the
   displacement.
2. **They actively interfere, they do not merely fail to help.** Majority vote collapses minority
   actions to the mode. That produces **fewer distinct action/outcome pairs** in the very corpus the
   loop learns from — a swarmed lane records a narrower slice of the action space per unit time, so
   the free instrument that does address bias gets a thinner diet. Buying variance reduction
   therefore costs the bias-correction channel its raw material.
3. **The price comparison is not close.** The loop aggregates **hundreds of REALISED outcomes at
   $0**. The swarm buys **N=3 views of one UNREALISED payload at 3× the call cost per decide** and,
   in live operation, 3× the rate-limit and latency footprint. Even granting the swarm its best case,
   it is the more expensive instrument aimed at the smaller share of the error.

**The honest counter, and it is a real one.** The loop is **retrospective and between-decides**; a
swarm is **per-decide**. If the failure were per-decide sampling noise — the model landing on a bad
draw at the moment of decision — the loop structurally could not reach it and only a swarm could.
That argument is sound as far as it goes.

**What closes the gap is the measurement, not the argument.** Both chronological halves negative and
the result worsening under trimming is not what per-decide sampling noise looks like; it is what a
displaced centre looks like. So the counter survives as a mechanism and fails as an explanation of
**this** corpus's numbers.

**Registered consequence, both directions:** a negative swarm result may cite these three mechanisms
as pre-registered rather than post-hoc. A **positive** swarm result puts mechanism 2 into live
conflict with the loop and MUST be reported as an unresolved interaction, not as a clean win.

## Family A — in-sample, the frozen 354-row corpus

### Corpus (frozen, verified)

The predecessor's corpus, unchanged, at the row depth its edge tier actually ran:

- **354 of the 386 recorded FLAT rows**, 26 symbols, `event_time` 1784646000000 → 1785181500000
  (2026-07-21 → 2026-07-27, 6.35 calendar days).
- **sha256 `f1dd13c695f8009ed64f0e0f0b1f0ed82327e0cabfd716a6674859092125d229`** — verified present in
  [`research/candidates/playbook-space-design.json`](../candidates/playbook-space-design.json) and in
  both calibration artifacts. A run whose manifest hash does not match is **void**.
- `input_payload` is market-context JSON excluding playbook text by construction, which is what makes
  a clean arm swap possible.

This corpus is **in-sample by construction** and that is deliberate: it is the only way the new arms
are apples-to-apples with the five already scored. It is also why Family B exists.

### The four remaining TESTABLE prose arms

Post-fix entry rates from the predecessor's lever tier, verified against
[`playbook-space-lever-claude-sonnet-5-2026-07-28.json`](../candidates/playbook-space-lever-claude-sonnet-5-2026-07-28.json):

| arm | entries / parsed | entry rate | naive n at 354 rows | haircut n (below) |
| --- | --- | --- | --- | --- |
| `candidate_v9` | 10 / 31 | 32.3% | 114 | 74 |
| `seed_v1` | 7 / 31 | 22.6% | 80 | 52 |
| `shorts_only` | 7 / 33 | 21.2% | 75 | 49 |
| `high_conviction_only` | 3 / 33 | 9.1% | 32 | 21 |

**The haircut is measured, not invented.** The lever tier projected `champion_v8` at n=107 for 354
rows and the edge run measured **n=70** — the 33-row projection over-estimated by **1.53×**.
`inverted` projected 126 and measured 117 (1.08×). The haircut column applies the champion's 0.65
factor as the pessimistic case. Every one of the four clears MIN_ENTRIES=12 even haircut, so none is
excluded on power; `high_conviction_only` at 21 is the only marginal one.

### Recorded outcome — three arms produce zero entries on this corpus

This is a **result**, not an omission, and it is stated as one:

| arm | entries / parsed | measured rate | one-sided 95% upper bound (rule of three) |
| --- | --- | --- | --- |
| `meanrev_pure` | 0 / 32 | 0.0% | 9.4% |
| `leaders_only` | 0 / 32 | 0.0% | 9.4% |
| `one_symbol_btc` | 0 / 32 | 0.0% | 9.4% |

**Recorded outcome: ZERO ENTRIES ON THIS CORPUS.** All three still changed 30.3% of decisions against
the champion, so they are not inert — they abstain. Funding any of them on this corpus is a bet on
the upper tail of a rule-of-three bound (3/32 = 9.4%, which at 354 rows would be 0–33 entries), and
the honest phrasing is that they are **untestable here at any budget the program has**, not that they
are "unrun". They are excluded from Family A and from its denominator.

### The architecture arms — the one axis with no evidence against it

Both come from [`architecture-options-2026-07-28.md`](architecture-options-2026-07-28.md), which
proposed them and priced their falsification at ~$5 rather than building either. **One is funded
(`haiku_swarm`); the other is deferred with its reason on the record and its specification intact.**

#### `haiku_swarm` — memo option (a) — **FUNDED, $5.10**

- **N = 3** `claude-haiku-4-5` calls per corpus row, on the **incumbent's own playbook text**
  (`champion_v8` as the predecessor measured it), so the only thing that varies against the
  comparator is the architecture.
- Majority vote over the parsed action ∈ {`open_long`, `open_short`, everything-else}. Entry side is
  the majority side. **No majority, or a tie, resolves to hold** — declared here because a 3-way vote
  over 3 voters can genuinely tie.
- **N=3 rather than 5**, and the reason is the memo's own: variance reduction from 3→5 is
  sqrt(3/5) = 0.77, marginal, and the predicted failure mode is that variance is the wrong lever
  entirely. N=3 is the cheapest configuration that can answer "does ensembling help at all".
- **Cost is a multiple, not a peer, at the call level** — 3 calls per row against every other arm's
  one — but haiku's rates make its per-row dollar cost roughly a peer. Both figures are in § Costs.
- **Paired control `haiku_single`** (1 haiku call per row, same playbook) is funded alongside it,
  because `haiku_swarm` vs a sonnet incumbent would confound architecture with model. The swarm's
  claim is only interpretable against a single haiku on the same rows.

#### `tool_use_trader` — memo option (b) — **DEFERRED, not cancelled**

**Owner decision 2026-07-30: deferred.** The reason is recorded because it is the reason, not a
budget excuse — the arm was cut on its argument first and its price second:

- **The arm serves `get_candles` over a cached price series. That is price history.** The class is
  settled empty: **4,562 backtests, zero survivors at any fee level including 0 bps.** Extended
  history and full-resolution higher timeframes are genuinely absent from the payload, but absence
  from the payload is not the same as presence of information — they are still price.
- **It is the category error the memo itself warned against.** By
  `architecture-options-2026-07-28.md`'s own test — _"tools add access, not information"_; _"never
  build tool use to discover whether a channel works"_ — an arm that spends a tool round-trip to
  reach more of an exhausted channel is exactly the build the memo said not to make. The screen's
  authority is not selectively applied: it is used to fund `haiku_swarm` (a ~$5 question worth
  answering) and to defer this arm (a $11.66 question already answered) in the same breath.
- **It was the most expensive funded arm** at **2.40×** a sonnet arm, which makes the category error
  the costliest line in the previous ladder.
- **The memo's genuine target class is not testable here at any price.** Order-book depth, trade
  flow, cross-venue spread and funding term structure are the channels a tool could reach that price
  history cannot — and **this system does not record any of them.** No arm built on this corpus can
  test that class, so deferring this arm forecloses nothing that was reachable. Building the
  recording first is the prerequisite, and it is out of scope here.

**The specification below is kept complete and unchanged so a later trial can fund the arm without
re-deciding anything** — the same treatment the four prose arms get. What it would cost, what it
would need calibrated, and where it sits in the ladder are all still declared.

The memo's verdict is that tools add **access**, not **information**, and that tool use aimed at data
the payload already carries is searching an exhausted space more expensively. So the arm is
specified to reach only what the payload genuinely lacks:

- One additional tool, `get_candles(symbol, interval ∈ {15m, 1h, 4h}, lookback ≤ 200)`, served
  **offline** from the cached series in `test/backtest/data`. The payload caps at **MAX_CANDLES = 30**
  15m bars (7.5 hours) plus summarised h1/h4 context, so extended history and full-resolution higher
  timeframes are information the payload does not contain. Nothing is fetched from a venue.
- **LOOK-AHEAD GUARD, fail-closed and run-voiding.** Every returned bar must have
  `closeTime <= row.event_time`. The clamp is normal operation; an assertion that no returned bar
  violates it is not, and a single violation **voids the run** rather than truncating quietly. A
  look-ahead leak here would manufacture exactly the edge the trial is looking for, which makes this
  the one guard whose failure would be indistinguishable from success.
- **Turn budget: 1 tool round-trip.** Turn 1 sends both tools with `tool_choice: auto`; turn 2 sends
  the tool result with `tool_choice` forced to `submit_trade`, so the decision shape of the final
  call matches every other arm. A model requesting a second tool call gets the forced turn anyway —
  fail-closed to a decision, never an unbounded loop.
- **Declared prose delta:** the arm's playbook is the incumbent's text plus one pre-registered
  sentence stating the tool exists. This is unavoidable — a tool the model is not told about is not a
  tool-use architecture — and it is recorded as a confound rather than hidden.

### Family A α — the arithmetic

Cells = scored arms × 4 horizons. **Controls are excluded** (see § The control exclusion, and the
clause that keeps it honest).

The funded design scores **one** arm: `haiku_swarm`. `haiku_single` is a control and
`incumbent_control` is not funded at all (§ The sequencing constraint), so neither enters the
denominator.

**Scored arms = 1. Horizons = 4. Cells = 1 × 4 = 4. α = 0.05 / 4 = 0.0125.**

| scored arms funded | cells | α = 0.05 / cells |
| --- | --- | --- |
| 1 (`haiku_swarm`) — **the funded design** | **4** | **0.0125** |
| 2 (+ `tool_use_trader`) | 8 | 6.25e-3 |
| 3 (+ `candidate_v9`) | 12 | 4.1667e-3 |
| 4 (+ `shorts_only`) | 16 | 3.125e-3 |
| 5 (+ `seed_v1`) | 20 | 2.5e-3 |
| 6 (+ `high_conviction_only`) — the full design | 24 | 2.0833e-3 |

**The funded figure is α = 0.05 / 4 = 0.0125**, and it is written to the design JSON by the sizing
step before the first edge call. α may only move along this ladder as arms are **added** by the
declared order in § The funded ladder — never by dropping an arm after something is known about it.
The ladder now starts at the funded design rather than in the middle of it, so the only legal
direction of travel is tighter.

**Family A and Family B both land on α = 0.0125, and that is a coincidence of arithmetic, not a
pooled family.** Each is 1 scored arm × 4 horizons in its own corpus. They are corrected separately
and the equality carries no meaning; a result in one is never quoted against the other's α.

### The control exclusion, and the clause that stops it being a loophole

`haiku_single` (Family A) and `champion_v8` (Family B) are **controls**: they exist to make another
arm's number interpretable, they are never scored against the +13.0 bar, and they contribute nothing
to the denominator. `incumbent_control` was a third and is no longer funded (§ The sequencing
constraint). That exclusion is only honest under a rule with teeth, so:

**A control can never PASS. If a control posts a mean above +13.0 with a CI lower bound above +13.0,
that is NOT a pass, NOT a survivor and NOT quotable as an edge.** It becomes the pre-registered
hypothesis of a new trial with its own denominator. The harness refuses to call `verdictFor` on a
control, and the results file marks the tier explicitly — the same discipline the predecessor's lever
tier ran under.

**A control's mean IS admissible to the deployment ranking**, and that needs saying now that a
control is half the funded Family A spend. The deployment bar is a ranking of measured means among
options that all have to be somewhere, so `haiku_single`'s mean is reported in the ranking like any
other. But **deploying `haiku_single` would be a MODEL swap, not a playbook swap**, and
`verdicts.md` § THE DECIDE MODEL IS NOT THE LEVER already stands against it. So it ships only under
the full robustness clause (h=24 **and** ≥3 of 4 horizons), is logged as a **model change** with its
own live cost delta, and never as a playbook selection. It still cannot PASS the research bar under
any outcome.

## The sequencing constraint — what replaces the paid `incumbent_control`

`incumbent_control` was $4.86 to re-measure `champion_v8` **inside this run**, so that the deployment
comparison — the one comparison this trial has to get right — carried no between-run confound. The
owner funded $6.80, which does not include it. The choice was therefore between dropping the control
(and quietly accepting a confound) or overspending. **Neither. It is replaced by a zero-cost ordering
constraint, and its limits are stated rather than glossed.**

### Why ordering can substitute at all

The replay harness does **not** replay a recorded request. It rebuilds the prompt from live source
every run: `test/eval/agentic/playbook-space-replay.ts` imports `buildPlaybookBlock` and
`buildSystemPrompt` from `src/features/strategy/agentic/agent-prompt.ts`, and `replayPlanRow`
(`src/features/strategy/agentic/entry-rate-floor.ts`) composes the system prompt, the playbook block
and the `buildTradeTool(caps)` schema at call time around the frozen recorded payload string.

So the predecessor's `champion_v8` numbers are reproducible **only** while that file is unchanged.
Run the swarm arm first and it shares the predecessor's exact prompt surface; the recorded
`champion_v8` row from the 2026-07-28 study is then directly comparable and no re-measure is needed.
Run it after any edit to that file and the $4.86 is owed again.

### The constraint, stated as a falsifiable check rather than a promise

> **The `haiku_swarm` arm MUST run at a commit where
> `src/features/strategy/agentic/agent-prompt.ts` is BYTE-IDENTICAL to that file as it stood at the
> commit the predecessor's `champion_v8` leg ran at. The run records its own commit SHA in the result
> file. The check is `git rev-parse <run-SHA>:src/features/strategy/agentic/agent-prompt.ts` against
> the predecessor's blob `c471c33055abad7c7ec0cb9978f81c61bc3c487d`. EQUAL ⇒ the deployment
> comparison against the recorded `champion_v8` row may be claimed as prompt-controlled. NOT EQUAL ⇒
> the comparison degrades to BETWEEN-RUN and MUST be reported as between-run — no exception, no
> partial credit, and no argument that the differing hunk "does not matter".**

Three deliberate properties:

- **The gate is the whole file, not an enumeration of known-pending edits.** Reasoning per change
  about which export lands on the replayed request has to be redone correctly every time and is
  exactly the reasoning that gets waived under time pressure. Byte-identity needs no judgement.
- **The SHA check is scoped to that ONE file, not to the repository HEAD.** A repo-wide SHA match
  would fail on unrelated commits, which would make the constraint unusable in practice and would
  itself become the argument for waiving it.
- **`c471c33055abad7c7ec0cb9978f81c61bc3c487d` is the blob at `2f1c917`** — the commit that published
  the predecessor's `NO_SURVIVOR` results — **and it is still the blob at this document's freeze**, so
  the constraint is satisfiable today. It is recorded as a literal because the predecessor's result
  artifact is gitignored (`.gitignore` `research/candidates/**`) and carries no commit field, so the
  run SHA cannot be recovered from the artifact later. Two adjacent files are also currently
  unchanged from that commit — `test/eval/agentic/playbook-space-arms.ts` (already hash-frozen in the
  manifest) and `test/eval/agentic/playbook-space-replay.ts` — recorded as observation, not added as
  further gates.

### The four pending changes are instances of the rule, not the rule

Four plan steps currently queued edit that file. They are listed so the critical path is visible, and
the rule binds on a fifth that nobody has written yet:

| # | pending change | site |
| --- | --- | --- |
| 1 | `recentDecisions` render — `MAX_DECISION_HISTORY` 30→12, 120-char rendered-reason cap | `renderDecisionLines`; the constant lives in `agentic.strategy.ts` |
| 2 | tool schema — drop the `anyShorts` branch in `buildTradePortfolioTool` and the capability sentence in `buildTradeTool` | `agent-prompt.ts` |
| 3 | `nextConsultBars` tool-description fix | `agent-prompt.ts:456-459` |
| 4 | `quoteAssetOf` — the `USDT:USDT` render on perp symbols | `agent-prompt.ts:691-694`, feeding `renderDecisionLines` |

Only part of change 2 (the `buildTradeTool` capability sentence) demonstrably alters **this replay's**
request, because `replayPlanRow` uses `buildTradeTool`, not the portfolio tool, and replays the
recorded payload verbatim rather than re-rendering decision history. **That observation is not a
licence to run after it.** It is per-change reasoning of exactly the kind the byte-identity gate
exists to make unnecessary, and it is incomplete on its own terms: changes 1 and 4 alter the
`input_payload` the live lane RECORDS, which is the corpus **Family B** will freeze — so they are not
free even where Family A's replay is untouched.

### The practical consequence, stated plainly

**The swarm arm is now on the critical path ahead of four separate plan steps.** It either runs soon
— before any of them lands — or the $4.86 `incumbent_control` has to be funded after all, taking
Family A from $6.80 to $11.66 and requiring a new owner decision on the spend. That is the real
trade, and it is visible here rather than implied. It is registered as rank 5 of the ladder,
**contingent**: funded if and only if the byte-identity check fails.

### What sequencing CANNOT control

The constraint removes the prompt-surface confound. It does not remove:

- **Provider-side model drift between the two run dates.** `claude-sonnet-5` on 2026-07-28 and
  whatever the same alias serves on the swarm arm's run date are not guaranteed to be the same
  weights or the same serving stack. **No sequencing constraint can remove this**, an in-run control
  would have removed it, and it is the residual price of the substitution.
- **Re-run variance at fixed prompt and fixed model** — sampling noise across two executions of the
  same configuration, still unquantified (it was never measured, and this trial does not measure it).
- Neither is fixable within $6.80. Both are reported alongside any deployment claim this comparison
  supports.

## Family B — out-of-sample, a NEW corpus

**This is a separate family with its own denominator, and pooling it with Family A would be
methodologically wrong.** Different corpora answer different questions: Family A asks "is there a
better-behaving arm on the states we already have?"; Family B asks "does the arm the program is
deploying survive contact with states it has never seen?" A single Bonferroni denominator over both
would penalise each question for the other being asked.

### Why it exists, stated bluntly

**A deployment is going live on in-sample evidence.** `inverted` beats the incumbent at every horizon
on the corpus that produced the finding, over 6.35 calendar days of one regime, with a research-bar
FAIL on the interval. That is a defensible deployment decision under the owner ruling and a
completely untested one out-of-sample. **Family B is the falsification test for that deployment**, and
it is registered before the deployment's result is known so it cannot be quietly skipped if the live
numbers happen to look fine.

### Corpus (trigger, not schedule)

- Same query as the frozen corpus (`agent_decisions`, `input_payload IS NOT NULL`,
  `model LIKE 'claude%'`, FLAT position), restricted to **`event_time` strictly after
  1785181500000** — the frozen corpus's own cut.
- **≥ 354 qualifying rows.** The manifest is frozen — row ids in order plus a fresh sha256 over the
  concatenated payloads — **the moment the count is met**, before the first call, and that hash pins
  the run exactly as the predecessor's did.
- **Additional freeze condition:** only rows with **≥ 24 forward 15m bars already cached** enter the
  manifest. Without it the newest rows all drop at h=24 and the exclusion becomes systematic rather
  than incidental. The candle backfill runs before the freeze, not after.

### When it triggers — the arithmetic, computed rather than copied

Rows accrue from **DECIDES**, not from trips, so the wait is not a function of trade frequency:

- The frozen corpus held **386 FLAT rows and 265 in-position rows** over 6.35 days — **651
  payload-carrying decides, 102.5/day**, of which the FLAT share is **386/651 = 59.3%**, i.e.
  **60.8 qualifying rows/day.**
- 354 qualifying rows ⇒ **≈ 5.8 days of healthy-lane operation.** The ~3.4-day figure you get from
  dividing 354 by the raw ~104 decides/day is **wrong for this corpus**, because the corpus filter is
  FLAT-only and roughly two decides in five are in-position.
- **Accrual restarted 2026-07-30T09:01Z**, not at the 07-27 cut — the lane was dead for 60 hours on
  an unfunded account. So the earliest realistic trigger is **≈ 2026-08-05**, and it is later if the
  host sleeps (worst measured duty cycle 8%/24h).
- **A deployed `inverted` lengthens the wait**, and this is worth stating because it is
  counter-intuitive: `inverted`'s entry rate is ~35% against the champion's ~30%, so more decides
  land in-position and the FLAT share _falls_.

**Trigger, not schedule:** the run starts when the count is met and the manifest freezes. It does not
start on a date, and it does not start early on a smaller corpus — a shortfall is a wait, never a
row-depth cut, because Family B's whole value is being an independent draw at comparable power.

### Family B arms

| unit | role | scored against the research bar? |
| --- | --- | --- |
| `inverted` | the deployed arm, out-of-sample | **yes** |
| `champion_v8` | regime control + deployment comparator on the new corpus | no |

`champion_v8` earns its cost twice: it supplies the deployment-bar comparator on a corpus where the
incumbent has no measured number, and it is the **regime control** — if both arms shift by a similar
amount against their in-sample values, the shift is the regime, not the arm. Without it a Family B
result is uninterpretable in either direction.

### Family B α — the arithmetic

Scored arms = 1 (`inverted`). Horizons = 4. Cells = 1 × 4 = 4.

**α = 0.05 / 4 = 0.0125.**

If the ladder later funds `champion_v8` as a scored arm rather than a control, cells = 8 and
α = 6.25e-3. It is registered as a control, so **0.0125 is the figure.**

### The zero-cost component that Guardrail 3 requires

If `inverted` is live during the Family B window, the recorded rows carry its **own live decisions**
and their realised forward returns. Comparing replay-predicted against live-realised entry return on
those rows costs **nothing** and is required by `verdicts.md` Guardrail 3: the recorded entries were
maker-side at 76% fill, and being reliably on the wrong side of a print does not imply the other side
of that print was available at the same terms. **A divergence there is a FINDING to report, not noise
to explain away.** It is reported, never α-corrected — it tests no hypothesis against the bar.

## Metric (frozen, identical to the −16.9 bps finding)

For every row where an arm's parsed action is `open_long` or `open_short`:

```text
i    = first bar with ts >= row.event_time      (that symbol's own series ONLY)
fwd  = dir * (close[i+h] - close[i]) / close[i] * 10_000     dir = +1 long, -1 short
```

Per-symbol indexing only — the #37 defect (interleaving symbols, scoring a BTC→LINK transition as
−99.99%) is never repeated. Rows with fewer than `h` forward bars are excluded, the same open-at-end
exclusion the original applied. **Horizons: h ∈ {1, 4, 8, 24} bars** (15m / 1h / 2h / 6h).

For the swarm arm the scored action is the **majority-vote** action, not any individual voter's; for
the tool-use arm it is the turn-2 `submit_trade` action.

## Power — what an arm actually has to post, computed from this study's own intervals

The α figures above are not the binding constraint and it is important to say so before results
exist. Required mean = `13.0 + z × SE`, taken at whichever of the two clauses binds: the CI clause
uses a **fixed z = 1.96 regardless of α**, the p-clause uses the family's z.

Cluster SEs are read off the predecessor's own bootstrap intervals for `inverted`, its best-powered
arm (n=117, 20 clusters), as `(mean − CI_lo) / 1.96`:

| h | SE (bps) | CI clause needs | p-clause at α=0.0125 (z=2.2414) | binding requirement |
| --- | --- | --- | --- | --- |
| 1 | 3.52 | +19.9 | +20.9 | **+20.9** |
| 4 | 5.97 | +24.7 | +26.4 | **+26.4** |
| 8 | 9.29 | +31.2 | +33.8 | **+33.8** |
| 24 | 30.51 | +72.8 | +81.4 | **+81.4** |

**This is why `inverted` at +47.6 bps failed and why no family size would have rescued it.** At h=24
the cluster interval is so wide that an arm must post roughly **+81 bps** to pass even at this
trial's loosest possible α — the narrowest funded family the design permits. The gap was ~34 bps of
interval width, not a rounding error in α. Both families use these figures: their α is the same
0.0125 and the SEs are read off the same best-powered arm.

## The asymmetry that lets this trial afford more arms than the last one

Widening the family costs **research-bar power** and costs the **deployment bar nothing**, because
"beats the incumbent" is a ranking of measured means, not an α-corrected test against a null.

Quantified on the table above — going the whole way from the funded 4 cells to the full design's 24,
a **six-fold** widening, raises the required mean by:

| h | α=0.0125 (4 cells, funded) | α=2.0833e-3 (24 cells, full design) | cost of six-folding the family |
| --- | --- | --- | --- |
| 1 | +20.9 | +23.1 | **+2.2 bps** |
| 4 | +26.4 | +30.1 | **+3.7 bps** |
| 8 | +33.8 | +39.6 | **+5.8 bps** |
| 24 | +81.4 | +100.4 | **+19.0 bps** |

At h=1/4/8 a six-fold family costs 2.2–5.8 bps of required mean, which is small against a bar of
+13.0 and an observed spread of −85 to +48. At h=24 it costs 19.0 bps, which is not small — but h=24
already requires +81, so the marginal α cost is irrelevant to any decision anyone would make there.

**So the constraint on arm count in this trial is money, not statistics**, and every arm the budget
buys also buys a deployment-bar data point at zero statistical cost.

**The funded family is nonetheless the narrowest the design permits, and that is a funding outcome,
not a power win.** α sitting at its loosest is a consequence of buying one scored arm; it buys ~2 bps
of required mean at the horizons anyone would act on, and it costs five arms' worth of
deployment-bar data points, which cost nothing statistically. Stating it the other way round would
be dressing a budget cut as a design choice.

The direction deserves scrutiny, so the same guard the predecessor wrote applies unchanged: the
clauses that do **not** depend on α — `mean > 13.0` and a 95% CI lower bound above 13.0 — are
untouched by any budget decision. **A cheaper or wider study cannot argue the fee floor down.**

## Costs — computed from repo-measured rates

### Per-call rates

| model / shape | $/call | source |
| --- | --- | --- |
| `claude-sonnet-5`, single forced-tool call | **$0.013717** | $19.4220 / 1,416 calls, predecessor's sonnet edge leg — measured at exactly this shape and scale |
| `claude-sonnet-5`, calibration cross-check | $0.0136725 | [`playbook-space-calibration-claude-sonnet-5.json`](../candidates/playbook-space-calibration-claude-sonnet-5.json), 40 rows — agrees to 0.3% |
| `kimi-k3` effective | $0.026265 | [`playbook-space-calibration-kimi-k3.json`](../candidates/playbook-space-calibration-kimi-k3.json) — **1.92× sonnet**, the empty-body retry burden charged conservatively. Not used |
| `claude-haiku-4-5`, single call | **$0.004802 (ASSUMED)** | 0.35 × sonnet. Haiku lists at $1/$5 per Mtok against sonnet's $3/$15 (repo reference: `candidate-model-eval.spec.ts:30`), cache-read $0.10 vs $0.30, cache-write $1.25 vs $6 — a true ratio of 0.21–0.33, rounded **up** to 0.35 so the estimate errs expensive |

**The haiku rate is the one number here that is not measured**, and the calibrate→size→run discipline
binds on it: the design JSON is written from the **measured** haiku cost, and the edge run refuses to
start without that file. The predecessor's kimi estimate reversed from 0.61× to 1.9× between two
calibrations — a planning-constant assumption carried into a budget is exactly the failure that
produced.

### Per-arm cost at 354 rows

| unit | calls/row | $/row | 354 rows | vs a sonnet arm |
| --- | --- | --- | --- | --- |
| sonnet single-call arm | 1 | $0.013717 | **$4.86** | 1.00× |
| `haiku_single` control | 1 | $0.004802 | **$1.70** | 0.35× |
| `haiku_swarm` (N=3) | **3** | $0.014406 | **$5.10** | **1.05×** |
| `tool_use_trader` (1 round-trip) | 2, weighted **2.4×** | $0.032921 | **$11.66** | **2.40×** |

**The swarm arm makes 3× the calls and costs 1.05× the dollars.** Both figures are stated because
only the second is a budget constraint and only the first is a rate-limit and latency constraint. At
N=5 it would be $0.024010/row, **1.75×** a sonnet arm — which is the honest reason N is 3.

The tool-use **2.4×** is a weighted multiplier, not a call count: turn 2 carries turn 1's output plus
the tool result, so it is more expensive than turn 1 (~1.4×), giving 1 + 1.4 = 2.4× when every row
uses its round-trip. This is an **estimate** and it is what the tool-use calibration probe measures
before sizing.

### Totals

Calibration is itemised because two of its three probes travel with arms that are no longer funded or
were never funded:

| calibration probe | calls | cost | funded? |
| --- | --- | --- | --- |
| haiku shape (40 rows × 3 calls) | 120 | $0.58 | **yes** |
| sonnet re-check (40 rows) | 40 | $0.55 | **yes** — Family B runs two sonnet legs |
| tool-use shape (40 rows × 2.4×) | 96 equiv. | $1.32 | no — travels with `tool_use_trader` |
| **funded calibration** | | **$1.13** | |
| **full-design calibration** | | **$2.45** | |

| item | cost | funded? |
| --- | --- | --- |
| **Calibration** — funded probes (haiku shape + sonnet re-check) | **$1.13** | **yes** |
| **Family B — `inverted`** | $4.86 | **yes** |
| **Family B — `champion_v8`** control | $4.86 | **yes** |
| **Family A — `haiku_swarm`** (N=3) | $5.10 | **yes** |
| **Family A — `haiku_single`** control | $1.70 | **yes** |
| **FUNDED TOTAL** | **$17.65** | |
| — of which **Family A: $5.10 + $1.70 = $6.80** | | |
| Calibration — tool-use probe | $1.32 | deferred with the arm |
| **Family A — `tool_use_trader`** | $11.66 | deferred |
| **Family A — `incumbent_control`** (sonnet, 354 rows) | $4.86 | contingent (§ The sequencing constraint) |
| **Family A — `candidate_v9`** | $4.86 | deferred |
| **Family A — `shorts_only`** | $4.86 | deferred |
| **Family A — `seed_v1`** | $4.86 | deferred |
| **Family A — `high_conviction_only`** | $4.86 | deferred |
| **FULL DESIGN TOTAL** | **$54.93** | |

Arithmetic, so it can be checked rather than trusted: funded = $1.13 + $4.86 + $4.86 + $5.10 + $1.70
= **$17.65**, of which Family A is **$6.80**. Full design = $17.65 + $1.32 + $11.66 + $4.86 +
(4 × $4.86 = $19.44) = **$54.93**, unchanged from the pre-amendment figure.

**$54.93 against $67.49 remaining Anthropic is 81% of the balance. $17.65 is 26% of it**, leaving
**$49.84** — about **16.6 days** of live lane at the $3/day cap, **26.8 days** at the $1.86/day
measured mean. The full design fits the balance and does not fit the allocation; the funded design
fits both with room, and the difference is five deferred arms rather than any weakening of the study
it actually runs.

## The funded ladder — what is cut, and why

### The allocation, declared

- **Research allocation: $18.00** — funded estimate **$17.65**, owner decision 2026-07-30.
- **Live-lane reserve: $49.84** — about **16.6 days** at the $3/day cap, **26.8 days** at the
  $1.86/day measured mean.

The pre-amendment split was $37.00 research / $30.49 reserve, argued on the grounds that
`verdicts.md` establishes the live lane accumulating evidence for a gate the present entry signal
provably cannot pass, at ~$2.6/day — declining runway value against an unmeasured architecture axis.
**The owner decision reverses the emphasis and the document records that rather than re-arguing it:**
research drops to $18.00, the reserve roughly doubles, and the axis is still measured because the
question the memo priced at ~$5 is the cheap half of what $37.00 would have bought. Both figures are
loop-domain measurement decisions carrying their date, disputable against something concrete.

### The frozen ladder — declared before any cost is measured

Order first, count second. That makes the count the only free parameter and removes every opportunity
to pick arms once something is known about them.

| rank | unit | cost | cumulative | funded? |
| --- | --- | --- | --- | --- |
| 0 | **Calibration** — haiku shape + sonnet re-check (mandatory; sizing reads it) | $1.13 | $1.13 | **yes** |
| 1 | **Family B** — `inverted` + `champion_v8` control | $9.72 | $10.85 | **yes** |
| 2 | Family A — `haiku_swarm` | $5.10 | $15.95 | **yes** |
| 3 | Family A — `haiku_single` control | $1.70 | $17.65 | **yes** |
| 4 | Family A — `tool_use_trader` (+ its $1.32 calibration probe) | $12.98 | $30.63 | no — deferred |
| 5 | Family A — `incumbent_control` | $4.86 | $35.49 | **contingent** |
| 6 | Family A — `candidate_v9` | $4.86 | $40.35 | no |
| 7 | Family A — `shorts_only` | $4.86 | $45.21 | no |
| 8 | Family A — `seed_v1` | $4.86 | $50.07 | no |
| 9 | Family A — `high_conviction_only` | $4.86 | $54.93 | no |

**Rank 5 is the one conditional entry in the ladder and its condition is mechanical, not
discretionary:** `incumbent_control` is funded **if and only if** the byte-identity check in
§ The sequencing constraint fails — i.e. the swarm arm could not run before `agent-prompt.ts`
changed. It is not available for any other reason, and its condition cannot be evaluated after
seeing a result because the check runs on the run's own recorded SHA before scoring.

**Funded total: $17.65 of the $18.00 allocation. Hard cap $21.00**, enforced in-harness by a USD
meter that prices every returned `usage` and **refuses to start a call that could cross the cap** —
fail-closed on attempt start, mirroring `AttemptScopedBudget` (`agent-budget.ts:126`) after the
2026-07-20 Opus runaway spent $2.48 against a $1.50 stop. The $3.35 of headroom between estimate and
cap is not decoration and it is sized against the one unmeasured number in the design: if haiku
calibrates at **0.50× sonnet** instead of the assumed 0.35× — a 43% overrun — the funded set costs
$0.82 (haiku probe) + $0.55 + $9.72 + $7.28 (swarm) + $2.43 (single) = **$20.80**, still under the
cap. A worse overrun than that is refused mid-run rather than discovered in the invoice, which is
precisely what the predecessor's kimi figure taught.

### What is cut, and why it is the right cut

**Five arms are cut and one paid control is replaced.** All are fully specified above so that a later
trial can fund them without re-deciding anything.

- **Four prose arms** — `candidate_v9`, `shorts_only`, `seed_v1`, `high_conviction_only`.
- **`tool_use_trader`**, on the argument in its own section, not on price alone.
- **`incumbent_control`**, replaced by a zero-cost sequencing constraint with a stated residual risk
  (§ The sequencing constraint) rather than dropped silently.

The reasoning behind that shape:

- **Arms before rows, always.** Cost scales as rows × arms; power comes from rows; and a smaller
  family _loosens_ α. Cutting rows would raise the required mean by 1/sqrt(n) on every remaining cell
  and push `high_conviction_only` under MIN_ENTRIES, for the same money.
- **Prose is cut before architecture** because prose is the axis with five recorded failures and
  architecture is the axis with no evidence against it. Paying $19.44 for four more draws from a
  distribution that has produced five failures, instead of $6.80 for the first measurement of an
  untested axis, would be spending on the question already answered.
- **The tool arm is cut ahead of the swarm despite both sitting on the architecture axis**, because
  only one of them is aimed at a channel the system has never measured. The other is aimed at price
  history, which is measured, settled and empty. Same axis, different questions.
- **The three zero-entry arms are not in the ladder at all.** They are a recorded outcome, not a
  deferred cut.

**If the budget stretches further** — a top-up, or a calibration cheaper than the planning rate —
the ladder adds ranks 4, then 6→9 **in that order**, and Family A's α tightens along the published
table (4 → 8 → 12 → 16 → 20 → 24 cells). Rank 5 is skipped in that traversal: it is
condition-triggered, not budget-triggered. **If it does not stretch**, the ladder drops from the
bottom of the funded set upward: rank 3, then 2. Rank 1 (Family B) is never dropped, and rank 2 is
the trial's only scored Family A arm — dropping both leaves the trial with neither an out-of-sample
test nor the architecture measurement, which are its two reasons to exist.

## Guards carried forward, all fail-closed

Each one was earned by a failure and none is re-litigated here:

1. **`preflightCanSpend`** — one 1-token call before the run; any non-2xx aborts before the first
   paid call, quoting the API's own error body. Verifies the key can _spend_, not merely that it
   exists.
2. **`instrumentedFetch`** — counts `ok` / 429 / 5xx / other-4xx / `emptyBody` / network failures at
   the transport layer, retrying 429s and 5xx with `retry-after`-aware backoff and empty-body 200s
   after a short fixed delay. `replayPlanRow` collapses every failure to `{ok:false}`, which is also
   what a genuine `hold` looks like — instrumenting below it keeps the distinction the scoring layer
   legitimately discards.
3. **`MIN_COMPLETION_RATE = 0.9`** on **transport**, never on schema — a run below it is `voided` and
   the harness **throws instead of publishing a table**. Predecessor run 1 produced a clean-looking
   `NO_SURVIVOR` while 87% of its calls were being refused for lack of credit; that is the most
   dangerous failure this class of study can have, because it is a confident answer rather than a
   crash.
4. **`capsSource: 'recorded'` on 100% of rows** — a single non-`recorded` row voids the run
   (WATCH-V4-9). The capabilities defect moved the measured entry rate from 2.5% to 19.1%, and it
   reached two production mint-time gates.
5. **Scorer sanity gate, before any paid call, void-on-failure** — agreement between two independent
   implementations on an **identical** row set, not a comparison against a constant computed on a
   different population. The predecessor's first version of this gate made exactly that
   mis-specification and had to be corrected.
6. **Chunk-major ordering** (chunk of rows → all arms within it → next chunk) so a budget abort
   truncates every arm at the same row and cross-arm comparison stays valid. A partial run is
   reported as partial with its true row count.
7. **Look-ahead assertion on `get_candles`** (§ `tool_use_trader`) — run-voiding, because a leak
   there is indistinguishable from the result the trial is looking for. Dormant while that arm is
   deferred; it is part of the kept specification and binds the moment the arm is funded.
8. **Every arm must pass the live `validatePlaybook` gate**, asserted in the runner. An arm the live
   validator would reject is not a reachable point in playbook space.
9. **Prompt-surface byte-identity check** (§ The sequencing constraint) — the run records its own
   commit SHA and the `agent-prompt.ts` blob hash. **This guard fails OPEN by design and is the one
   exception in this list:** it is a measurement-quality gate, not a safety gate, so a mismatch
   **downgrades the reported attribution to between-run** rather than voiding the run. Voiding on
   mismatch would let a routine unrelated edit destroy $6.80 of already-collected data, which is the
   wrong failure direction for a gate that measures nothing about correctness of the numbers
   themselves. The downgrade is mandatory and machine-recorded, never a reporting judgement.

## Weaknesses, stated before the result

1. **Family A is in-sample, on one regime.** 6.35 days, 2026-07-21 → 27, on the corpus that generated
   the finding. A deployment decision may rest on it; an edge claim may not. Family B exists because
   of this and does not retroactively fix Family A.
2. **The swarm arm confounds architecture with model** — haiku voters against a sonnet incumbent.
   `haiku_single` decomposes it, but only partially: a swarm-vs-single-haiku contrast is clean, while
   a swarm-vs-sonnet-incumbent contrast is not, and the deployment-bar comparison necessarily uses
   the latter.
3. **The tool-use arm changes the request shape** (deferred arm; weakness retained against the kept
   specification). Turn 1 runs `tool_choice: auto` where every other arm runs a single forced call.
   Turn 2 is forced so the decision shape matches, but the first turn's freedom is a real difference
   between this arm and the rest, and a difference in its result cannot be cleanly attributed to the
   tool alone.
4. **The tool may reach nothing that matters** (deferred arm). The memo's own screen says tools add
   access, not information, and the 1,807-cut adversarial search already covered everything the
   system records (0 of 188 counterfactual cuts positive at n≥8). Extended candle history is
   genuinely absent from the payload, but it is still _price_, and price TA is settled empty across
   4,562 backtests at every fee level including zero. **This arm's honest prior is that it measures a
   null** — which is why it is deferred rather than funded, and the weakness is now the deferral's
   stated reason as well as the arm's.
5. **Family B's corpus is conditioned on the deployed policy.** Which rows are FLAT depends on what
   the live arm entered, so the post-cut FLAT population is not an independent draw from the same
   population as the frozen corpus. `champion_v8` as regime control mitigates but does not remove
   this.
6. **Entry price is the bar close, not the arm's own limit**, and there is **no exit modelling** —
   both unchanged from the predecessor, both deliberate, and both identical across arms so cross-arm
   comparison stays sound while absolute levels stay optimistic for everyone alike.
7. **Adverse selection may not invert, and offline replay structurally cannot measure it**
   (`verdicts.md` Guardrail 3). The "bias is identical across arms" argument covers the entry price
   level, not whether the faded side fills at all.
8. **The haiku per-call rate is assumed, not measured.** The calibration gate is what turns it into a
   number, and the design is not sized until it does.
9. **Re-run variance between the frozen study and this one is not quantified, and the funded design
   no longer buys the control that would have removed it.** The pre-amendment design re-measured
   `incumbent_control` **in the same run** for exactly this reason. The owner-funded $6.80 does not
   include it, so it is **substituted, not deleted**: a zero-cost byte-identity constraint on
   `src/features/strategy/agentic/agent-prompt.ts` between this run and the predecessor's
   `champion_v8` leg (§ The sequencing constraint). What the substitution buys and what it does not:

   - **Removed by sequencing:** the prompt-surface confound. If the blob check passes, both legs saw
     the same system prompt, the same playbook block and the same tool schema.
   - **NOT removed, and no ordering can remove it:** provider-side model drift between the two run
     dates, and plain re-run sampling variance at fixed prompt and fixed model. An in-run control
     would have absorbed both. This is the residual risk of taking the $4.86 back, and any deployment
     claim resting on this comparison carries it explicitly.
   - **Escape hatch, pre-registered:** if the blob check fails, the comparison is reported as
     between-run **and** `incumbent_control` becomes fundable at ladder rank 5. The failure mode is a
     known cost with a known price, not a silent degradation.

## Decision rules (frozen)

### Research bar

- **≥1 scored arm passes every clause at any horizon in its own family ⇒ SURVIVOR for that family.**
  Phase B follows: a _fresh_ pre-registration requiring out-of-sample confirmation before any capital
  moves. No live-money step on a Family A pass alone — Family A is in-sample.
- **0 passes ⇒ `NO_SURVIVOR` for that family**, subject to the scope limit below.
- **A family whose declared cells did not all score is `INCOMPLETE`, never `NO_SURVIVOR`.** The honest
  statement for an unrun arm is "untested", not "does not work".
- **Ranking is not passing.** `bestPowered` names the least-bad cell even when every cell fails, and
  it is restricted to n ≥ 12 so a 3-entry cell with a spectacular mean can never become the headline.
- **A `NO_SURVIVOR` in one family says nothing about the other.** Different corpora, different
  questions, different denominators.

### Deployment bar

**Owner ruling 2026-07-30: the deployment-bar ranking is itself the product of this trial, and it is
directly actionable.** It is not a by-product of a failed edge hunt and it is not advisory. An arm
that beats the running playbook **ships, regardless of its research-bar verdict** — the research bar
has no veto here, and a `NO_SURVIVOR` alongside a shipped arm is the expected outcome, not a
contradiction to be reconciled.

- Evaluated **independently of, and regardless of, the research-bar outcome.**
- The arm with the best mean at h=24 that also beats the incumbent at ≥3 of 4 horizons **ships**,
  including — especially — when it has just been recorded as a research-bar FAIL.
- **A control's mean enters the ranking** (§ The control exclusion), but a `haiku_single` win ships
  as a logged **model change** under the same robustness clause, never as a playbook selection.
- The comparison uses the predecessor's recorded incumbent row, and its controlled-vs-between-run
  status is reported per § The sequencing constraint. **A between-run comparison still produces a
  ranking and still ships** — it is reported with the weaker attribution, not suppressed.
- No arm beats the incumbent ⇒ the incumbent stays. That is a result, not a default.
- Shipping is logged as a choice among losers, with `verdicts.md` Guardrails 1–5 attached.

### Scope limit, carried forward VERBATIM from the predecessor

> **0 passes ⇒ the learning hypothesis is UNSUPPORTED on the funded arms, NOT proven dead.**

**Family A now funds exactly ONE scored arm, so this limit binds harder than it did on the
predecessor, not softer.** Four prose arms are cut by budget, `tool_use_trader` is deferred on
argument, three more produce zero entries on this corpus and are untestable here at any budget, and
the memo's genuine target class — order-book depth, trade flow, cross-venue, funding term structure —
**is not recorded by this system at all** and so is untestable on any corpus it can currently build.
A `NO_SURVIVOR` here is a statement about `haiku_swarm` at h ∈ {1, 4, 8, 24} on 354 in-sample rows and
about nothing else. Any write-up that reads it as "playbook space is empty" or "architecture is
settled" is overclaiming, and the same sentence that bound the predecessor binds this trial without
softening.

## Results — Family A, run 2026-07-30

**Nothing above this line changed.** This section records what the frozen design returned; it amends
no arm, no bar, no horizon, no denominator and no guard. Family B has not run — its corpus has not
accrued (§ When it triggers) — so **Family B is UNTESTED, not failed**, and nothing here speaks to
it.

**Headline, both bars at once, neither cancelling the other:**

- **RESEARCH bar: `NO_SURVIVOR`.** 4 of 4 declared cells scored, 0 passes. Every `haiku_swarm` cell
  is negative and none comes within 25 bps of the +13.0 bar, let alone the +20.9/+26.4/+33.8/+81.4
  the power table says a pass needs.
- **DEPLOYMENT bar: the swarm does NOT ship. The incumbent `champion_v8` stays.** The swarm loses at
  the declared primary horizon h=24 and wins only 2 of 4 horizons. That is a result, not a default.
- **The architecture screen's pre-registered prediction scored CORRECT.**

### Calibration — the one unmeasured number, measured

| probe | calls | spend | $/call metered | $/call effective | transport | schema | entry rate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| haiku swarm shape (40 rows x 3) | 120 | $0.4497 | **$0.0037475** | $0.0037475 | 100.0% | 100.0% | 20.0% |
| sonnet re-check (40 rows x 1) | 40 | $0.7645 | $0.0191125 | $0.0191125 | 100.0% | 85.0% | 8.8% |
| **funded calibration total** | **160** | **$1.2142** | | | | | |

Zero retries, zero empty bodies, zero 429s on either probe — the transport floor was met with room,
so neither probe is VOID.

**The haiku rate came in CHEAPER than the planning constant, and inside the band the design
predicted.** Measured $0.0037475 against the assumed $0.004802 is **0.78x the assumption**, and
against the predecessor's measured sonnet rate ($0.013717) it is **0.273x** — inside the 0.21–0.33
true-ratio band § Per-call rates named, which confirms the round-up to 0.35 erred expensive exactly
as intended. The overrun gate therefore never fired; had the rate landed past
$6.80 x 1.43 = $9.72 of projected Family A spend, the harness would have refused to start.

**One observation recorded because it is not free, and it is a caution rather than a finding:** the
sonnet re-check measured **$0.0191125/call, 1.39x the predecessor's $0.013717** on the same prompt
surface and model alias. The likely mechanism is cache amortisation — this probe is a single 40-row
chunk carrying one cache write, where the predecessor's edge leg spread its writes over 354 rows and
four arms — and it does not touch Family A, which is priced entirely off the haiku probe. **It does
bear on Family B's sizing**, whose two sonnet legs were budgeted at $4.86 each on the older figure.

The same probe entered on **3 of 34 parsed rows (8.8%)** against the predecessor's 70 of 354
(19.8%) for the same arm. At n=34 the 95% interval on 8.8% runs to roughly 23%, which contains
19.8% — so this is **within sampling error and is evidence of nothing in either direction.** It
neither shows provider-side drift nor rules it out, which is precisely the residual the funded design
declined to buy out (§ What sequencing CANNOT control).

### Spend — metered, against the authorisation and the cap

| item | authorised | metered |
| --- | --- | --- |
| Calibration (haiku shape + sonnet re-check) | $1.13 | **$1.2142** |
| `haiku_swarm` + `haiku_single`, 1,416 calls | $6.80 | **$4.9586** |
| **Family A total** | **$7.93** | **$6.1728** |
| Hard cap | | **$21.00 — not approached** |

The sized design projected $5.3065 for the paid run and it came in at $4.9586, **6.6% under
projection**. The run was never budget-aborted: `rowsCovered = 354/354`, `aborted = false`, so both
arms cover the identical row set and the cross-arm contrast is on identical rows.

### The sequencing constraint — the check, both ways

| | value |
| --- | --- |
| run SHA | `9a63edf7e565b99eee7579bb26dc095763af172b` |
| `agent-prompt.ts` blob at the run SHA | `c471c33055abad7c7ec0cb9978f81c61bc3c487d` |
| same file in the working tree at run time | `c471c33055abad7c7ec0cb9978f81c61bc3c487d` |
| pinned predecessor blob | `c471c33055abad7c7ec0cb9978f81c61bc3c487d` |
| **attribution** | **PROMPT-CONTROLLED** |

**EQUAL, checked before the first paid call and again after the last one.** The check was run three
times against three different HEADs and returned the same blob every time: at `193107e` before the
harness was launched, at the run's own recorded SHA `9a63edf` (the reflection deletion, which landed
between launch and the run's first call), and at `4218d78` (the plan-authoritative exit flip, which
landed mid-run) afterwards. Neither concurrent commit touched the checked file.
The worktree hash is recorded alongside HEAD's because HEAD's is what the constraint's command reads
while the worktree's is what the process actually loaded — a dirty checkout would otherwise satisfy
the letter of the constraint while replaying different bytes.

So the deployment comparison against the recorded `champion_v8` row **may be claimed as
prompt-controlled**, and `incumbent_control` (ladder rank 5) is **not** triggered. What this does not
remove is unchanged and carried here explicitly: provider-side model drift between 2026-07-28 and
2026-07-30, and plain re-run variance at fixed prompt and fixed model. Neither was fixable within
$6.80.

### Run health

`rowsCovered` 354/354 · calls 1,416 · **transport 1,415/1,416 = 99.93%** (VOID floor 90%) ·
schema-valid **100.0%** · `capsSource: 'recorded'` on 100% of rows · 0 rate-limited, 0 5xx, 0
empty-body 200s, 6 transient network errors of which 5 were retried successfully and 1 call was lost.
No billing stop. The run is not voided on any guard.

The 100% schema rate is worth one line because the predecessor's kimi leg made the opposite case:
`claude-haiku-4-5` answered the v2 rich decision contract cleanly on every single transported call.
Whatever is wrong with this lane, it is not that haiku cannot fill in the form.

### RESEARCH bar — `haiku_swarm`, alpha = 0.0125, 4 cells

| h | n | clusters | mean | 95% CI | p vs bar | placebo p | halves | trimmed | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 82 | 15 | **-12.15** | [-16.70, -7.87] | 1.0000 | 0.9902 | -18.13 / -6.17 | -11.83 | **FAIL** |
| 4 | 82 | 15 | **-22.58** | [-33.90, -13.66] | 1.0000 | 0.9946 | -27.44 / -17.72 | -21.61 | **FAIL** |
| 8 | 82 | 15 | **-35.38** | [-48.87, -18.61] | 1.0000 | 0.9980 | -32.71 / -38.04 | -33.83 | **FAIL** |
| 24 | 78 | 15 | **-71.83** | [-122.05, -18.52] | 1.0000 | 1.0000 | -55.85 / -87.81 | -68.95 | **FAIL** |

Every cell is powered (n >= 12), so none is `UNDERPOWERED` and none can be dismissed on depth. The
binding failure is the **first** clause every time — `mean <= bar` — so no later clause is even
reached, and the CI upper bound is below the bar at every horizon too. **The placebo is the sharpest
statement in the table:** at p = 0.99–1.00 the swarm's entries are worse than bars drawn at random
from the same symbols with the same long/short mix, at all four horizons. That is the signature of a
displaced centre, not a wide spread, and it is the same signature the predecessor measured.

**Verdict, computed by the aggregator and not asserted here: `NO_SURVIVOR`,** with 4 of 4 declared
cells scored so the family is complete rather than `INCOMPLETE`. `bestPowered` is
`haiku_swarm@h=1` at -12.15 bps — **and ranking is not passing.**

**Scope limit, binding verbatim:** 0 passes ⇒ the learning hypothesis is UNSUPPORTED on the funded
arms, NOT proven dead. This is a statement about `haiku_swarm` at h in {1,4,8,24} on 354 in-sample
rows and about nothing else. Four prose arms remain cut by budget, `tool_use_trader` deferred on
argument, three arms untestable here at any budget, and the memo's genuine target class — order-book
depth, trade flow, cross-venue spread, funding term structure — is still not recorded by this system
at all.

### CONTROL — `haiku_single`, reported and never scored

| h | n | clusters | mean | 95% CI | placebo p | halves | trimmed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 84 | 16 | -7.12 | [-14.81, 0.45] | 0.9306 | -12.99 / -1.25 | -6.69 |
| 4 | 84 | 16 | -10.77 | [-26.79, 3.25] | 0.9016 | -19.79 / -1.75 | -10.32 |
| 8 | 84 | 16 | -30.30 | [-47.65, -8.28] | 0.9912 | -24.81 / -35.80 | -28.67 |
| 24 | 77 | 15 | -80.30 | [-142.20, -21.29] | 1.0000 | -79.30 / -81.27 | -77.61 |

**This is a CONTROL. It carries no verdict, entered no denominator, and could not have PASSED under
any outcome** — the harness refuses to call `verdictFor` on it and throws if asked. Its means are
admissible to the deployment ranking and to nothing else.

### The decomposition the control was bought for

The whole job of `haiku_single` was to tell "the swarm shape hurts" apart from "haiku is a worse
decider". It lands cleanly, and the answer is the first one:

| h | `haiku_swarm` | `haiku_single` | swarm minus single |
| --- | --- | --- | --- |
| 1 | -12.15 | -7.12 | **-5.03** |
| 4 | -22.58 | -10.77 | **-11.81** |
| 8 | -35.38 | -30.30 | **-5.08** |
| 24 | -71.83 | -80.30 | +8.47 |

**Ensembling three haiku voters is WORSE than one haiku voter at 3 of the 4 horizons**, at a
strictly higher price — 3x the calls for 1.06x the measured dollars and 3x the live rate-limit and
latency footprint. The two arms' entry rates are nearly identical (24.58% vs 24.86%), so the swarm is
not buying selectivity either; it is taking the same number of trips and losing more on them.

And the model is not the culprit: `haiku_single` **beats** the sonnet `champion_v8` at h=1, 4 and 8.
Whatever `verdicts.md`'s forward-proxy reading of haiku-4.5 established elsewhere, on this corpus a
single haiku call on the champion's text is not the worse decider — so the swarm's deficit cannot be
attributed to the model, which is exactly the confound the control existed to remove.

### DEPLOYMENT bar — vs `champion_v8`'s recorded 2026-07-28 row, PROMPT-CONTROLLED

Incumbent identity read at comparison time: **`champion_v8`** (`STATUS.md`: "Champion playbook v8
active", v9 still an unresolved candidate on 40% of decides). `inverted` had not shipped, so the
comparator is `champion_v8`'s recorded row on the identical 354-row corpus and the identical metric.

| h | `haiku_swarm` | `champion_v8` | delta | | `haiku_single` | delta | |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | -12.15 | -12.69 | +0.54 | BEATS | -7.12 | +5.57 | BEATS |
| 4 | -22.58 | -36.34 | +13.76 | BEATS | -10.77 | +25.57 | BEATS |
| 8 | -35.38 | -32.70 | -2.67 | loses | -30.30 | +2.40 | BEATS |
| **24 (primary)** | -71.83 | -70.10 | **-1.73** | **loses** | -80.30 | **-10.20** | **loses** |

- **`haiku_swarm`: does NOT ship.** It loses at the declared primary horizon and wins 2 of 4. It is
  not even horizon-dependent — there is no horizon story to tell.
- **`haiku_single`: does NOT ship either.** It wins 3 of 4 but loses at h=24, and the robustness
  clause requires h=24 **and** >= 3 of 4. Both conditions, not either. It would in any case have
  shipped as a logged **model change** under `verdicts.md` § THE DECIDE MODEL IS NOT THE LEVER, never
  as a playbook selection.
- **No arm beats the incumbent, so the incumbent stays. That is a result, not a default.**

**The two bars agree here, and that is a coincidence rather than a rule.** Both arms fail both bars.
Had either cleared the deployment bar it would have shipped on a research-bar FAIL without
hedging — the rule did not bind this time because no arm reached it.

### The architecture screen, scored as a pre-registered prior

[`architecture-options-2026-07-28.md`](architecture-options-2026-07-28.md) predicted the haiku swarm
**NEUTRAL-TO-WORSE** before it was funded, reasoning that ensembling reduces variance rather than
bias and that the measured failure is a bias.

**SCORED CORRECT, and on the mechanism as well as the direction.** The swarm is worse than its own
single-call control at 3 of 4 horizons; it fails the deployment bar against the incumbent; and the
placebo p of 0.99–1.00 at every horizon says the residual failure is still a displaced centre, which
is the thing a variance-reduction instrument structurally cannot move. The screen is now a
**validated** instrument for the next screening decision rather than a well-argued opinion, which is
what the $6.17 bought and is worth more than the arm itself was.

The three enhanced-loop mechanisms registered before the run may therefore be cited as
pre-registered rather than post-hoc. Mechanism 2 in particular has measured raw material rather than
an argument: **71 of 354 rows had split votes collapsed to the mode, and on 53 rows the swarm's
action differed from the single-call control's** — so majority vote demonstrably narrows the recorded
action space, which is the diet the free bias-correction loop feeds on. 282 of 354 rows were
unanimous, so the swarm was inert on 80% of rows and actively harmful on the remainder.

The registered positive-result clause (a swarm win would have put mechanism 2 into live conflict with
the loop and had to be reported as an unresolved interaction) **did not trigger.**

### What this does and does not settle

- **Settles:** the architecture axis is no longer unmeasured. Ensembling at fixed text, on this
  corpus, is worse than not ensembling — measured, not argued.
- **Does not settle:** `tool_use_trader` (deferred, specification intact), the four cut prose arms,
  and the channels this system does not record. Family B is untested and its `INCOMPLETE` status is
  unchanged by anything here.
- **Licenses nothing.** No edge claim, no promotion evidence, no move toward live capital.
  `verdicts.md` Guardrails 1–5 stand word for word.

### Artifacts

- Result: `research/candidates/playbook-space-followon-2026-07-31.json` (gitignored)
- Design, written before the first edge call: `research/candidates/playbook-space-followon-design.json`
- Calibration: `research/candidates/playbook-space-followon-calibration-{claude-haiku-4-5,claude-sonnet-5}.json`
- Scorecard + registry row: `research/scorecards/playbook-space-followon-2026-07-31.json`,
  `scripts/log-eval-experiment.mjs --family playbook-space-followon --source study`

## Provenance

- Harness: `test/eval/agentic/playbook-space-replay.ts`, driven by
  `test/eval/agentic/playbook-space-replay.spec.ts` (research; **OFF** the production gate,
  `pnpm backtest` / `pnpm eval:*` family).
- Arms: `test/eval/agentic/playbook-space-arms.ts` — new arms appended, existing twelve unchanged and
  still frozen by that file's content hash in the manifest.
- Replay shape: `replayPlanRow`, `src/features/strategy/agentic/entry-rate-floor.ts`, with per-row
  `recordedCapabilities` (the 2026-07-30 fix) and `capsSource` reported per call.
- Prompt builders: `buildSystemPrompt` / `buildPlaybookBlock`, `agent-prompt.ts`, imported directly
  by the replay harness and rebuilt at call time (`replayPlanRow` also builds `buildTradeTool(caps)`).
  **This file's blob hash is the sequencing constraint's checked object**, pinned at
  `c471c33055abad7c7ec0cb9978f81c61bc3c487d` (the blob at `2f1c917`, the commit that published the
  predecessor's results, and still the blob at this document's freeze). The run records its own
  commit SHA next to it.
- Design file: `research/candidates/playbook-space-followon-design.json`, written by the sizing step
  from the **measured** calibration and **read** by the edge run, which refuses to start without it.
  A design file that exists before the first edge call is the evidence that the families were fixed
  before any hypothesis was tested.
- Registry row via `scripts/log-eval-experiment.mjs --source study`.
- Binding context: [`research/loop/verdicts.md`](../loop/verdicts.md) § Standing verdicts (the two-bar
  rule stands first), [`playbook-space-replay-2026-07-28.md`](playbook-space-replay-2026-07-28.md)
  (predecessor, Amendment 5 and § What this does and does not settle), and
  [`architecture-options-2026-07-28.md`](architecture-options-2026-07-28.md) (committed `c1206fc`,
  2026-07-28 — the two architecture arms and their predicted outcomes, scored as a prior by this
  trial per § The architecture screen as a SCORED PRIOR).
