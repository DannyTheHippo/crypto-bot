# Playbook-space follow-on — preregistration (2026-07-31)

Frozen before any paid call. **No paid call has been made by this document.** Two families, their
corpora, their arms, their controls, the scoring metric, the horizons, the two bars, the per-family
Bonferroni denominators, the placebo, the underpowered rule, the funded ladder, the spend cap and the
decision rules below cannot change after a result is seen. Any later variation is a new registered
trial.

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
  `inverted` is the incumbent and the Family A control below is `inverted`'s text.
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
   concrete candidates that the existing harness can run for tens of dollars rather than build.
2. **The deployment-bar ranking** — which, unlike the research bar, produces an actionable answer
   whatever the means come out as. It is the part of this trial that cannot fail to be useful.

The architecture memo's own predictions are recorded here as priors so they can be scored: haiku
swarm **NEUTRAL-TO-WORSE** (ensembling reduces variance, not bias, and the finding is a bias —
averaging more draws from a biased predictor converges _on_ the bias); tool use **WEAK** unless it
reaches information genuinely absent from the payload.

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
proposed them and priced their falsification at ~$5 rather than building either.

#### `haiku_swarm` — memo option (a)

- **N = 3** `claude-haiku-4-5` calls per corpus row, the **same playbook text as the incumbent
  control**, so the only thing that varies against the control is the architecture.
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

#### `tool_use_trader` — memo option (b)

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

| scored arms funded | cells | α = 0.05 / cells |
| --- | --- | --- |
| 2 (`haiku_swarm`, `tool_use_trader`) — **the funded design** | **8** | **6.25e-3** |
| 3 | 12 | 4.1667e-3 |
| 4 | 16 | 3.125e-3 |
| 5 | 20 | 2.5e-3 |
| 6 (the full design) | 24 | 2.0833e-3 |

**The funded figure is α = 0.05 / 8 = 6.25e-3**, and it is written to the design JSON by the sizing
step before the first edge call. α may only move along this ladder as arms are **added** by the
declared order in § The funded ladder — never by dropping an arm after something is known about it.

### The control exclusion, and the clause that stops it being a loophole

`incumbent_control` and `haiku_single` are **controls**: they exist to make another arm's number
interpretable, they are never scored against the +13.0 bar, and they contribute nothing to the
denominator. That exclusion is only honest under a rule with teeth, so:

**A control can never PASS. If a control posts a mean above +13.0 with a CI lower bound above +13.0,
that is NOT a pass, NOT a survivor and NOT quotable as an edge.** It becomes the pre-registered
hypothesis of a new trial with its own denominator. The harness refuses to call `verdictFor` on a
control, and the results file marks the tier explicitly — the same discipline the predecessor's lever
tier ran under.

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

| h | SE (bps) | CI clause needs | p-clause at α=6.25e-3 (z=2.498) | binding requirement |
| --- | --- | --- | --- | --- |
| 1 | 3.52 | +19.9 | +21.8 | **+21.8** |
| 4 | 5.97 | +24.7 | +27.9 | **+27.9** |
| 8 | 9.29 | +31.2 | +36.2 | **+36.2** |
| 24 | 30.51 | +72.8 | +89.2 | **+89.2** |

**This is why `inverted` at +47.6 bps failed and why no family size would have rescued it.** At h=24
the cluster interval is so wide that an arm must post roughly **+89 bps** to pass. The gap was 42 bps
of interval width, not a rounding error in α.

## The asymmetry that lets this trial afford more arms than the last one

Widening the family costs **research-bar power** and costs the **deployment bar nothing**, because
"beats the incumbent" is a ranking of measured means, not an α-corrected test against a null.

Quantified on the table above — tripling the family from 8 cells to 24 raises the required mean by:

| h | α=6.25e-3 (8 cells) | α=2.0833e-3 (24 cells) | cost of tripling the family |
| --- | --- | --- | --- |
| 1 | +21.8 | +23.1 | **+1.3 bps** |
| 4 | +27.9 | +30.1 | **+2.2 bps** |
| 8 | +36.2 | +39.6 | **+3.4 bps** |
| 24 | +89.2 | +100.4 | **+11.2 bps** |

At h=1/4/8 a three-fold family costs 1.3–3.4 bps of required mean, which is small against a bar of
+13.0 and an observed spread of −85 to +48. At h=24 it costs 11.2 bps, which is not small — but h=24
already requires +89, so the marginal α cost is irrelevant to any decision anyone would make there.

**So the constraint on arm count in this trial is money, not statistics**, and every arm the budget
buys also buys a deployment-bar data point at zero statistical cost. That is the reverse of the
predecessor's situation and it is why the ladder below adds arms rather than protecting α.

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

| item | cost |
| --- | --- |
| **Calibration** — haiku shape (40 rows × 3), tool-use shape (40 × 2.4×), sonnet re-check (40) | **$2.45** |
| **Family A — `incumbent_control`** (sonnet, 354 rows) | $4.86 |
| **Family A — `tool_use_trader`** | $11.66 |
| **Family A — `haiku_swarm`** (N=3) | $5.10 |
| **Family A — `haiku_single`** control | $1.70 |
| **Family A — `candidate_v9`** | $4.86 |
| **Family A — `shorts_only`** | $4.86 |
| **Family A — `seed_v1`** | $4.86 |
| **Family A — `high_conviction_only`** | $4.86 |
| **Family B — `inverted`** | $4.86 |
| **Family B — `champion_v8`** control | $4.86 |
| **FULL DESIGN TOTAL** | **$54.93** |

**$54.93 against $67.49 remaining Anthropic is 81% of the balance**, leaving $12.56 — about **4.2 days**
of live lane at the $3/day cap. **The full design fits the balance and does not fit the allocation.**
That distinction is the whole content of the next section: a study that starves the bot it is
studying is not a saving.

## The funded ladder — what is cut, and why

### The allocation, declared

- **Research allocation: $37.00.**
- **Live-lane reserve: $30.49** — about **10 days** at the $3/day cap, **16 days** at the $1.86/day
  measured mean.

The reserve is smaller than the predecessor's 35 days, and the reason is on the record rather than
implied: `verdicts.md` establishes that the live lane accumulates evidence for a gate the present
entry signal provably cannot pass, at ~$2.6/day. Lane runway has real but declining value; the
architecture axis has never been measured. The split is a loop-domain measurement decision, recorded
here with its date and its reasoning so it can be disputed against something concrete.

### The frozen ladder — declared before any cost is measured

Order first, count second. That makes the count the only free parameter and removes every opportunity
to pick arms once something is known about them.

| rank | unit | cost | cumulative | funded? |
| --- | --- | --- | --- | --- |
| 0 | **Calibration** (mandatory; sizing reads it) | $2.45 | $2.45 | **yes** |
| 1 | **Family B** — `inverted` + `champion_v8` control | $9.72 | $12.17 | **yes** |
| 2 | Family A — `incumbent_control` | $4.86 | $17.03 | **yes** |
| 3 | Family A — `tool_use_trader` | $11.66 | $28.69 | **yes** |
| 4 | Family A — `haiku_swarm` | $5.10 | $33.79 | **yes** |
| 5 | Family A — `haiku_single` control | $1.70 | $35.49 | **yes** |
| 6 | Family A — `candidate_v9` | $4.86 | $40.35 | no |
| 7 | Family A — `shorts_only` | $4.86 | $45.21 | no |
| 8 | Family A — `seed_v1` | $4.86 | $50.07 | no |
| 9 | Family A — `high_conviction_only` | $4.86 | $54.93 | no |

**Funded total: $35.49 of the $37.00 allocation. Hard cap $40.00**, enforced in-harness by a USD
meter that prices every returned `usage` and **refuses to start a call that could cross the cap** —
fail-closed on attempt start, mirroring `AttemptScopedBudget` (`agent-budget.ts:126`) after the
2026-07-20 Opus runaway spent $2.48 against a $1.50 stop. The $4.51 of headroom between estimate and
cap is not decoration: it is what absorbs a calibration coming in above the planning rate, which is
precisely what happened to the predecessor's kimi figure.

### What is cut, and why it is the right cut

**Four prose arms — `candidate_v9`, `shorts_only`, `seed_v1`, `high_conviction_only` — are cut.**
They are fully specified above so that a later trial can fund them without re-deciding anything.

- **Arms before rows, always.** Cost scales as rows × arms; power comes from rows; and a smaller
  family _loosens_ α. Cutting rows would raise the required mean by 1/sqrt(n) on every remaining cell
  and push `high_conviction_only` under MIN_ENTRIES, for the same money.
- **Prose is cut before architecture** because prose is the axis with five recorded failures and
  architecture is the axis with no evidence against it. Paying $19.44 for four more draws from a
  distribution that has produced five failures, instead of $16.76 for the first measurement of an
  untested axis, would be spending on the question already answered.
- **The three zero-entry arms are not in the ladder at all.** They are a recorded outcome, not a
  deferred cut.

**If the budget stretches further** — a top-up, or a calibration cheaper than the planning rate —
the ladder adds ranks 6→9 **in that order**, and Family A's α tightens along the published table
(8 → 12 → 16 → 20 → 24 cells). **If it does not stretch**, the ladder drops from the bottom of the
funded set upward: rank 5, then 4, then 3. Rank 1 (Family B) and rank 2 (the incumbent control) are
never dropped — without them the trial has neither an out-of-sample test nor a deployment comparison,
which are its two reasons to exist.

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
   there is indistinguishable from the result the trial is looking for.
8. **Every arm must pass the live `validatePlaybook` gate**, asserted in the runner. An arm the live
   validator would reject is not a reachable point in playbook space.

## Weaknesses, stated before the result

1. **Family A is in-sample, on one regime.** 6.35 days, 2026-07-21 → 27, on the corpus that generated
   the finding. A deployment decision may rest on it; an edge claim may not. Family B exists because
   of this and does not retroactively fix Family A.
2. **The swarm arm confounds architecture with model** — haiku voters against a sonnet incumbent.
   `haiku_single` decomposes it, but only partially: a swarm-vs-single-haiku contrast is clean, while
   a swarm-vs-sonnet-incumbent contrast is not, and the deployment-bar comparison necessarily uses
   the latter.
3. **The tool-use arm changes the request shape**, not only the information available. Turn 1 runs
   `tool_choice: auto` where every other arm runs a single forced call. Turn 2 is forced so the
   decision shape matches, but the first turn's freedom is a real difference between this arm and the
   rest, and a difference in its result cannot be cleanly attributed to the tool alone.
4. **The tool may reach nothing that matters.** The memo's own screen says tools add access, not
   information, and the 1,807-cut adversarial search already covered everything the system records
   (0 of 188 counterfactual cuts positive at n≥8). Extended candle history is genuinely absent from
   the payload, but it is still _price_, and price TA is settled empty across 4,562 backtests at
   every fee level including zero. **This arm's honest prior is that it measures a null.**
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
9. **Re-run variance between the frozen study and this one is not quantified.** It is why
   `incumbent_control` is re-measured **in the same run** rather than read off the predecessor's
   table — reusing those numbers would have saved $4.86 and introduced an uncontrolled between-run
   confound into the one comparison the trial has to get right.

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

- Evaluated **independently of, and regardless of, the research-bar outcome.**
- The arm with the best mean at h=24 that also beats the incumbent at ≥3 of 4 horizons **ships**,
  including — especially — when it has just been recorded as a research-bar FAIL.
- No arm beats the incumbent ⇒ the incumbent stays. That is a result, not a default.
- Shipping is logged as a choice among losers, with `verdicts.md` Guardrails 1–5 attached.

### Scope limit, carried forward VERBATIM from the predecessor

> **0 passes ⇒ the learning hypothesis is UNSUPPORTED on the funded arms, NOT proven dead.**

Four prose arms are cut from Family A by budget, and three more produce zero entries on this corpus
and are untestable here at any budget. Any write-up that reads this trial's `NO_SURVIVOR` as
"playbook space is empty" is overclaiming, and the same sentence that bound the predecessor binds
this trial without softening.

## Provenance

- Harness: `test/eval/agentic/playbook-space-replay.ts`, driven by
  `test/eval/agentic/playbook-space-replay.spec.ts` (research; **OFF** the production gate,
  `pnpm backtest` / `pnpm eval:*` family).
- Arms: `test/eval/agentic/playbook-space-arms.ts` — new arms appended, existing twelve unchanged and
  still frozen by that file's content hash in the manifest.
- Replay shape: `replayPlanRow`, `src/features/strategy/agentic/entry-rate-floor.ts`, with per-row
  `recordedCapabilities` (the 2026-07-30 fix) and `capsSource` reported per call.
- Prompt builders: `buildSystemPrompt` / `buildPlaybookBlock`, `agent-prompt.ts`.
- Design file: `research/candidates/playbook-space-followon-design.json`, written by the sizing step
  from the **measured** calibration and **read** by the edge run, which refuses to start without it.
  A design file that exists before the first edge call is the evidence that the families were fixed
  before any hypothesis was tested.
- Registry row via `scripts/log-eval-experiment.mjs --source study`.
- Binding context: [`research/loop/verdicts.md`](../loop/verdicts.md) § Standing verdicts (the two-bar
  rule stands first), [`playbook-space-replay-2026-07-28.md`](playbook-space-replay-2026-07-28.md)
  (predecessor, Amendment 5 and § What this does and does not settle), and
  [`architecture-options-2026-07-28.md`](architecture-options-2026-07-28.md) (the two architecture
  arms and their predicted outcomes).
