# Playbook-space replay — preregistration (2026-07-28)

Frozen before any paid call. The corpus, the twelve arms, the scoring metric, the horizons, the bar,
the multiple-comparisons denominator, the placebo, the underpowered rule, the budget and the decision
rule below cannot change after a result is seen. Any later variation is a new registered trial.
Negative evidence is a result — and here it is the expected one.

## The question, stated so it can be answered wrong

**Can runtime learning — demo trading plus the daily loop plus reflection-driven playbook revision —
make this lane profitable?**

The learning loop's whole mechanism is search over **playbook text**: reflection reads outcomes,
drafts a revised playbook, the A/B routes traffic to it, and the promotion gate keeps it if it beats
the champion. Every other component (risk, execution, the venue adapters, the decision contract) is
held fixed by design. So the hypothesis "runtime learning will find profitability" is exactly the
claim that **somewhere in playbook space there is a text whose entries clear the fee.**

That claim is testable offline, today, on recorded data, for tens of dollars. This study tests it by
replaying a deliberately wide span of playbooks — including the two the live objective structurally
forbids — against the same recorded market states that produced the −16.9 bps verdict, scored on the
identical metric.

## Why this replaces a 90-day live run

A 90-day live A/B was planned and approved, then withdrawn. The reasons are recorded in full in the
session plan; the load-bearing ones:

- The promotion gate re-evaluates after **every closed trade** with no alpha spending — roughly 6%
  false-positive per look across 30–60 looks, and roughly 45% power against a genuinely
  break-even-restoring effect. Ninety days buys 1–2 independent draws: **under one bit of
  information**, for ~$240 and a quarter of a year.
- Three blocking defects would have been hit on contact (dead validator path in
  `scripts/playbook-candidate.mjs:42-45`; a lapse deadlock when reflection is disabled; and the
  false premise that the promotion bar had become beat-the-basket instead of net > 0 — both clauses
  block, see state.md).
- The passive-basket bar is dominated by an exogenous variable: required improvement spans ~0 to
  ~190 bps/trip purely on what the basket does over the window.

This study costs ~$46 and two days, has a frozen bar that no market regime can move, and produces a
**decisive** answer either way. If it survives, the live run becomes justified — and only then.

## Honest prior

**Low. The expected outcome is NO SURVIVOR.** The ENTRIES verdict already searched 1,807 conditional
cuts over everything the system records and found 0 of 188 counterfactual cuts positive at n≥8;
family-wise permutation over 120 realised cuts gave p = 0.378. Playbook prose is a **weaker** lever
than a direct attribute filter — anything a playbook can express about "only enter when X", the cut
search already tested mechanically and more thoroughly.

The single genuine uncertainty is the `inverted` arm at h=8/24, and its lead is mostly tautological
(below). This study is worth running not because it is likely to succeed but because it is the
cheapest possible test of the last open claim, and because a clean negative converts "we should keep
iterating" into "we should stop", which is worth far more than $46.

## Corpus (frozen)

Recorded live decisions, `agent_decisions`:

```sql
SELECT id, symbol, event_time, action, close, input_payload
FROM agent_decisions
WHERE input_payload IS NOT NULL
  AND model LIKE 'claude%'
  AND input_payload LIKE '%"side":"FLAT"%'
ORDER BY event_time, id
```

- **n = 386 rows**, 26 symbols, `event_time` 1784646000000 → 1785181500000 (2026-07-21 → 2026-07-27,
  6.35 calendar days).
- **FLAT-position only** — an arm cannot open from a non-flat state, so the 265 in-position rows would
  cost money and yield zero entry observations. 62 of the 63 recorded entries live inside this subset,
  so the corpus still **contains** the population the −16.9 bps finding was drawn from.
- Recorded action mix within it: 321 hold, 43 open_long, 19 open_short, 3 close — a realised entry
  rate of **16.1%** of flat consults, produced by the live MIXTURE of playbook versions, not by any
  single one.
- Frozen by a manifest written **before the first call**: row ids in order plus a SHA-256 over the
  concatenated payloads. A run whose manifest hash does not match is void.

`input_payload` is the market-context JSON **excluding** playbook text by construction
(`buildMarketPayload` has no playbookContent parameter), which is what makes a clean arm swap
possible at all.

### Correction (2026-07-28, before any results existed) — which version is the champion

Arm 1 was originally labelled `champion_v9`. **v9 is not the champion.** `agentic_playbook_info`
reports the app running **version 8**; v9 is an unresolved `source='reflection'` CANDIDATE sitting
above it and taking `AGENTIC_PLAYBOOK_AB_PCT=40`% of decides through the A/B. The arms now carry the
roles the live system actually assigns — `champion_v8` (active) and `candidate_v9` (on 40% of
traffic). Publishing a table that called v9 "champion" would have misstated which text is in charge.
Nothing else changed: the same two playbook texts are replayed, under correct names, and no result
existed when this was fixed.

The same error reached a commit message (`b9b52a6` calls v9 "the live champion") and `state.md`. The
truncation defect it describes is real and unchanged — v9's entry-rules section still ends mid-sentence
and that text still reaches 40% of live decides — but it is the **candidate's** text, not the
champion's.

## Arms (frozen — 12)

Every arm is a playbook text. The system prompt is `buildSystemPrompt(DEFAULT_FLOOR_PROFILE)`,
byte-identical across arms, so **the playbook is the only thing that varies.** Request shape is
`replayPlanRow` (`entry-rate-floor.ts:120`): one forced-tool `submit_trade` call, thinking disabled,
playbook block cache-controlled — the exact shape the live decide path sends.

| # | arm | what it tests |
| --- | --- | --- |
| 1 | `champion_v8` | the ACTIVE champion (`agentic_playbook_info` version=8) — the true status quo |
| 2 | `candidate_v9` | the unresolved A/B candidate already taking 40% of live decides, verbatim including its truncated entry-rules section — is reflection's revision better than its parent? |
| 3 | `seed_v1` | the original 2026-07-21 seed — a different lineage |
| 4 | `minimal` | a neutral 4-section stub — the model's own priors, unguided |
| 5 | `trade_almost_never` | extreme abstention; "a flat week is a success" |
| 6 | `inverted` | fade the system's own setups — the inversion hypothesis |
| 7 | `high_conviction_only` | enter only on strongest confluence (~1 in 20) |
| 8 | `leaders_only` | BTC/ETH/SOL only |
| 9 | `one_symbol_btc` | BTC only |
| 10 | `momentum_pure` | continuation only; no dip-buying, no fading |
| 11 | `meanrev_pure` | fade extension only |
| 12 | `shorts_only` | short-biased — the long leg carried the loss (−19.9/−29.2/−56.3/−93.5 vs a short leg of n=18 that was not significant on its own) |

**Arms 5 and 6 are the point of the exercise.** Both are structurally forbidden by the live system:
`reflection.service.ts:526-537` states that "a flat week is a FAILING week, not discipline… the
promotion gate needs roughly two closed round trips per day… if it cannot, loosen instead", backed by
a mint-time entry-rate floor and a live-abstention lapse. Against −106 bps/trip, trading less is the
only lever with positive expected effect, and three mechanisms exist to suppress it. If the live
objective forbids the only winning move, the search cannot find it however long it runs — so the
span here must contain what the live span cannot.

## Metric (frozen)

For every row where an arm's parsed action is `open_long` or `open_short`, the **forward return in
basis points** from cached 15m candles:

```text
i    = first bar with ts >= row.event_time      (that symbol's own series ONLY)
fwd  = dir * (close[i+h] - close[i]) / close[i] * 10_000     dir = +1 long, -1 short
```

This is byte-for-byte the metric that produced −16.9 bps (`test/backtest/inversion-test.mjs`,
`fwdBps`). Per-symbol indexing only — the #37 defect (interleaving symbols, scoring BTC→LINK
transitions as −99.99%) is never repeated. Rows with fewer than `h` forward bars are excluded, the
same open-at-end exclusion the original applied.

Candle coverage: all 26 corpus symbols are cached at 15m through 2026-07-27T20:00Z (seven series
backfilled 2026-07-28 specifically so no paid row is scored as missing).

**Horizons: h ∈ {1, 4, 8, 24} bars** (15m / 1h / 2h / 6h).

## The bar (frozen — every clause must hold)

An arm PASSES at a horizon only if **all** of:

1. **mean forward return > +13.0 bps** — the required gross edge per trip at demo fees
   (state.md standing verdict; +24.2 at live 20 bps, deliberately the easier of the two).
2. **bootstrap 95% CI lower bound > +13.0 bps**, where the bootstrap **resamples symbols, not
   entries** — multiple entries on one symbol within hours are not independent observations, and a
   row-level bootstrap would overstate confidence. Cluster resampling is the stricter and correct
   choice. 5,000 draws.
3. **p < α = 0.05 / 48 = 1.0417e-3** against the +13.0 bps null, Bonferroni over
   **12 arms × 4 horizons = 48 cells**, denominator fixed here, before any result is seen.
4. **random-bar placebo p < α** — same symbols, same long/short mix, bars drawn at random from each
   symbol's own series. Selection-invariant by construction, which is precisely why it survived the
   schema-filter defect that invalidated other cuts.
5. **both chronological halves > +13.0 bps.**
6. **trimmed mean (drop best and worst observation) > +13.0 bps.**
7. **n ≥ 12 entries.** state.md: *"Never act on a sub-n≥12 cell"* — the horizon study's n=11 cell
   showed +6.3 to +7.2% excess and **reversed** to −5.4% at n=84. That lesson binds here.

### Underpowered is not a pass and not a fail

An arm with **n < 12 entries** at a horizon is reported `UNDERPOWERED` and can never PASS. This is
the expected outcome for `trade_almost_never` and `one_symbol_btc`, and it is itself a finding: an arm
that cannot produce 12 entries across 386 real flat market states cannot accrue the promotion gate's
≥30 closed round trips in any tolerable window either. Reporting it as FAIL would be dishonest;
reporting it as PASS would be the exact error that killed the funding-contrarian frontier.

### Reported but NOT gating

- Action mix per arm (entry rate, hold rate) and **decision change-rate vs `champion_v8`** — a
  candidate that changes <5% of decisions measures nothing in an A/B however many trips accrue.
- Per-arm token spend and USD cost.
- Every arm's full numbers, winners and losers alike. No arm is dropped from the report.

## Budget (frozen)

- 386 rows × 12 arms = **4,632 calls**.
- Sonnet-5 list rates as configured (`.env.app`): $3 / $15 / $0.30 / $6 per Mtok for
  input / output / cache-read / cache-write.
- Estimated **~$46**. **Hard cap $90**, enforced in-harness: a USD meter prices every returned
  `usage` and refuses to start a call that could cross the cap. Mirrors `AttemptScopedBudget`'s
  fail-closed-on-attempt-start discipline (`agent-budget.ts:126`) — the 2026-07-20 Opus runaway spent
  $2.48 against a $1.50 stop because nothing gated the attempt.
- **Chunk-major ordering** (chunk of rows → all 12 arms within it → next chunk) so that a budget abort
  truncates every arm at the same row and cross-arm comparison stays valid. A partial run is reported
  as partial with its true row count, never silently truncated to look complete.

## Decision rule (frozen)

- **≥1 arm passes every clause at any horizon ⇒ SURVIVOR.** The learning hypothesis is alive. Phase B
  follows: fix the six recorded blockers first, then write a *fresh* live-run pre-registration
  requiring out-of-sample confirmation. **No live run starts with any blocker open.**
- **0 arms pass ⇒ NO SURVIVOR.** A 12-arm span that deliberately includes the extremes the live
  objective forbids, scored on the same metric and the same corpus that produced −16.9 bps, contains
  no playbook whose entries clear the fee. **The learning hypothesis is dead**: runtime search over
  playbook text cannot reach profitability, because the reachable space was searched here in two days
  instead of ninety. No live run is justified. The verdict goes into state.md § Standing verdicts and
  the program's honest options become a different horizon/venue class, or stopping.

## Weaknesses, stated before the result

1. **The `inverted` arm's lead is mostly a tautology.** Negating a negative mean yields a positive
   mean of identical magnitude; CI, t, halves and placebo p all mirror by construction. Only
   magnitude-versus-fee is new information, and **h=1 already fails** (+16.9 gross − 20 bps = −3.1
   net; CI lower bound +10.9 is under even the +13.0 requirement). Recorded as a standing non-finding
   in state.md. What *this* study adds is a real test: an arm instructed to fade must actually produce
   entries and clear the bar on its own observations, which is a materially stronger claim than
   flipping a sign on someone else's.
2. **One regime.** 6.35 days, 2026-07-21→27. Nothing here generalises across regimes, and a SURVIVOR
   would be a hypothesis, not a deployable strategy.
3. **In-sample by construction.** The arms are scored on the corpus that generated the finding. This
   is deliberate — it is what makes the comparison apples-to-apples — but it means a PASS is
   in-sample and Phase B's fresh pre-registration MUST require out-of-sample confirmation before any
   capital moves.
4. **Entry price is the bar close, not the arm's own limit.** Live entries were maker-side at 76%
   fill, so a real arm might not be filled at the price scored here. The bias is **identical across
   arms**, so cross-arm comparison is sound; absolute levels are optimistic for every arm alike.
5. **No exit modelling.** A fixed-horizon forward return is not the arm's own stop/TP geometry. This
   is deliberate: the exit study already settled that no exit rule rescues these entries (16/16 cells
   negative, best −45.0 bps), so isolating entry quality is the correct decomposition, not a shortcut.
6. **Playbook prose is a blunt instrument.** An arm told "only enter on strongest confluence" may not
   actually become more selective. Entry rate is therefore reported per arm, and an arm whose entry
   rate is indistinguishable from the champion's did not test what its label claims — that is a
   finding about the lever, not about the market, and it will be reported as such.

## Provenance

- Harness: `test/eval/agentic/playbook-space-replay.mjs` (research; OFF the production gate).
- Replay shape: `replayPlanRow`, `src/features/strategy/agentic/entry-rate-floor.ts:120-225`.
- Prompt builders: `buildSystemPrompt` / `buildPlaybookBlock`, `agent-prompt.ts`.
- Scoring: this document's metric, implemented in the harness.
  **Scorer sanity gate, run before any paid call and void-on-failure:** score the **full recorded
  entry population** (`test/eval/agentic/data/recorded-entries-v3.jsonl` — every `open_long` /
  `open_short` row, no payload, model or FLAT filter) by its own recorded actions, and require
  **n = 61 and −16.9 bps at h=1 to within 0.5 bps** of `test/backtest/inversion-test.mjs`. This is an
  **agreement check between two independent implementations on an identical row set**, which is what
  validates arithmetic.
  It deliberately does **not** ask the `champion_v8` arm to reproduce those entries — the recorded
  entries are a mixture over ~9 playbook versions, so a single-playbook replay reproducing them is
  neither expected nor required.

### Amendment 1 (2026-07-28, before any paid call) — the first version of this gate was wrong

As first written, the gate scored the **study corpus** (FLAT-only, a strict subset) against the −16.9
constant computed on the **full entry population**, and failed at **−16.23 bps, n=60**. The subset is
smaller by one entry — one recorded `open_long` came from a non-flat row — and its mean is legally its
own quantity; the 0.5 bps tolerance was fixed against a number from a different population.

**The assertion was wrong, not the arithmetic.** This is the identical mis-specification the horizon
study made in Amendment 3 (`lo_all` flagged SANITY-FAIL for paying a fee drag the benchmark did not),
and it is recorded here rather than quietly repaired because making the same class of error twice is
itself worth knowing. Corrected as above: agreement between implementations on the same rows.

Two facts surfaced by the failure, both now pinned:

- The study corpus's own baseline is **−16.23 bps at n=60**, not −16.9. That is the number this
  study's arms are actually competing against, and it is reported as such rather than silently
  inheriting the population figure.
- **The corpus is a moving target.** The live stack journaled a new entry mid-investigation
  (`open_long` 44 → 45; entry population 63 → 64). Both data files are point-in-time dumps and the
  **manifest hash is what pins a run to its data** — which is exactly why the freeze is a hash and not
  a row count.
- Registry row via `scripts/log-eval-experiment.mjs --source study`.

## Amendment 2 (2026-07-28) — runs 1 and 2 are VOID; the account ran out of credit

**No verdict has been produced. The bar above has not moved and no arm has been scored.**

### What happened

| run | concurrency | calls | spend | completion | status |
| --- | --- | --- | --- | --- | --- |
| smoke | 4 | 61 | $0.9943 | healthy | budget-capped as designed |
| 1 | 6 | 4,632 | $7.5004 | **~13%** | **VOID** |
| 2 | 3 | 4,632 | $0.0000 | **0%** | **VOID** |

Run 1 completed all 386 rows × 12 arms, reported `aborted=false`, and wrote a clean-looking
`NO_SURVIVOR` table. **It was worthless.** Only ~500 of 4,632 calls carried any `usage`, and the
$7.50 spend against a ~$75 estimate is what gave it away: roughly 87% of calls failed at the HTTP
layer before the model ever ran. Run 2, at lower concurrency, failed 100%.

Cause, confirmed by a direct one-call probe:

```text
HTTP 400 invalid_request_error
"Your credit balance is too low to access the Anthropic API."
```

The Anthropic credit balance was exhausted **during run 1** — the smoke run and the first ~500 calls
of run 1 spent it (~$8.49 total this session). Every call after that point returned 400.

### Why it produced a plausible-looking table instead of an error

`replayPlanRow` (`entry-rate-floor.ts:174`) collapses **every** failure mode to `{ok:false}` — a
deliberate degrade-not-abort choice that is correct for its own callers, where one bad row must never
kill a batch. But `{ok:false}` is also what a genuine `hold` looks like to the scoring layer, so a
run in which the API refused 87% of calls is arithmetically indistinguishable from a run in which the
model simply declined to trade. The arm means were computed over whichever small, non-random
subsample of calls happened to land before the money ran out.

**This is the most dangerous failure this study could have had**: not a crash, but a confident
answer. Had the completion rate not been cross-checked against the spend, run 1's `NO_SURVIVOR` would
have been written into `state.md` as the verdict that ended the program.

### Guards added, all fail-closed

1. **`preflightCanSpend`** — one 1-token call before the run. Any non-2xx aborts before the first paid
   call, quoting the API's own error body. The previous pre-flight verified a key *existed*; it never
   verified the key could *spend*, which is the check that actually mattered. Verified: aborts in
   0.5 s with the credit message and zero paid calls.
2. **`instrumentedFetch`** — wraps the transport to count `ok` / 429 / 5xx / other-4xx / network
   failures and retry 429s and 5xx with `retry-after`-aware backoff. Instrumenting at the fetch layer
   keeps the distinction `replayPlanRow` legitimately discards, without changing production code.
3. **`MIN_COMPLETION_RATE = 0.9`** — a run whose parsed fraction falls below 90% is marked
   `voided: true` and the harness **throws instead of publishing a table**. This is the guard that
   would have caught run 1 on its own, without anyone noticing the spend discrepancy.

### Status

**BLOCKED on an owner-only capability.** Purchasing API credit is not something this program can do
for itself — the same class as a dedicated org key or live capital. The corpus, the arms, the bar and
the harness are all frozen and committed; the study is one funded API key away from running, and
nothing about it needs to be re-decided.

Estimated cost to complete, revised down from measurement rather than guessed: run 1's ~500 real
calls cost $7.50, but that figure is inflated by cold caches and failed-call overhead. The smoke run's
$0.0163/call over 4,632 calls gives **~$75**; the observed cache behaviour at `chunk=40` suggests
materially less. **Budget $90, the pre-registered cap, unchanged.**

## Amendment 3 (2026-07-28) — the KIMI leg is a SEPARATE TRIAL, not a substitute

Owner direction, with Anthropic credit to be purchased shortly: run the study on the Moonshot key in
the meantime. Moonshot exposes an **Anthropic-compatible surface** (`https://api.moonshot.ai/anthropic`),
so `replayPlanRow` reaches `kimi-k3` with nothing but a `baseUrl` + key swap — the identical request
shape, no second code path, and therefore no chance of the two legs drifting apart. Probe-verified
2026-07-28: `kimi-k3` → HTTP 200; `kimi-k2-0905-preview` and `kimi-latest` → 404.

**This does not answer the question the study was written to answer**, and the distinction is the
whole reason this is a separate registration rather than a parameter tweak. The decide model is a
pre-registered constant, because the champion IS `claude-sonnet-5` and the learning hypothesis is a
claim about the deployed system.

| | |
| --- | --- |
| **Trial id** | `playbook-space-replay-kimi-2026-07-28` |
| **Answers** | Is there a playbook text such that **kimi-k3's** entries on these 386 states clear +13.0 bps? |
| **Does NOT answer** | Whether the champion's learning hypothesis is alive. A NO SURVIVOR here does **not** kill it; a SURVIVOR here does **not** establish it. |
| **Changed** | decide model `claude-sonnet-5` → `kimi-k3`; base URL |
| **Unchanged** | corpus + manifest hash, all 12 arms, metric, horizons, +13.0 bps bar, Bonferroni 48, cluster bootstrap, placebo, halves, trimming, n≥12 |

### Why this is worth running on its own merits, not as a consolation prize

1. **It is a replication test of the central finding.** The ENTRIES verdict says this lane's entries
   are *anti-predictive*. If that is a property of the **architecture** — the payload, the contract,
   the 15m horizon, the symbol menu — kimi should reproduce it. If kimi's entries are **not**
   negative, the defect localises to the model rather than the design, which is a materially
   different diagnosis than anything on record and would reopen a frontier the program has closed.
2. **It is far better powered.** Measured head-to-head (state.md, 2026-07-22): kimi's propose rate is
   **0.38 vs sonnet's 0.07**, ~5×. The sonnet leg risked most arms landing UNDERPOWERED at n<12;
   kimi should clear n≥12 on most arms, so more of the 48 cells are actually decidable.
3. It is roughly half the cost (head-to-head: cost −54%).

### Known properties of this model that the design must respect

- **Schema-valid 0.71** (head-to-head; "kimi's mode is thesis >300 chars"). A naive 90% *parsed*-rate
  floor would have voided this run for the sole reason that kimi writes long theses. The guard is
  therefore split: **transport rate** (HTTP 200 + parseable envelope) gates and voids at <90%;
  **schema-valid rate** is reported per arm and never gates. A model that breaks the contract is
  data, not a broken harness.
- Prior verdicts on this model are **HOLD / NO FLIP** for the live lane (offline replay 2026-07-21;
  head-to-head 2026-07-22). Nothing here reopens that; the loop stays on Claude regardless of this
  trial's outcome.
- **USD figures on this leg are nominal at sonnet rates.** The meter prices kimi tokens at $3/$15 per
  Mtok because this program has no authoritative kimi-k3 price. Since kimi measured ~54% cheaper,
  the meter **over-estimates**, which is the safe direction for a spend cap — it stops early rather
  than overspending. Reported spend is an upper bound, not a measurement.

## Amendment 4 (2026-07-28) — the MODEL is a first-class axis; the question is which lane, not whether one lane

**Owner correction, and it changes the design, not just the budget:** *"the question is **which** lane
is best and can become profitable; not whether the current one can become profitable."*

As originally written this study held the decide model fixed at the champion and registered kimi as a
**separate trial** (Amendment 3). That answers "can THIS lane become profitable" — the wrong question.
Amendment 3's separation is hereby **superseded**: kimi is not a side trial, it is an arm of the
primary study.

| | before | after |
| --- | --- | --- |
| factors | 12 arms × 4 horizons | **2 models × 12 arms × 4 horizons** |
| family / Bonferroni denominator | 48 | **96** |
| α | 1.0417e-3 | **5.2083e-4** |
| verdict rule | per-model | **joint across the axis** |

`MODEL_AXIS = ['claude-sonnet-5', 'kimi-k3']`, declared in code **before any result exists** — a
denominator chosen after seeing which models happened to run is not a correction at all. Each model
runs as its own process for operational convenience; the statistics are joint and `aggregateVerdict`
decides.

### Three rules this forces, each with a test

1. **A partial axis is `INCOMPLETE`, never `NO_SURVIVOR`.** If only one model runs and finds nothing,
   the honest statement is "the other lane is untested" — not "no lane works". This is the same error
   shape as reading a rate-limited run as a finding, and it is now impossible to express.
2. **Ranking is not passing.** `bestPowered` names the best lane even when every lane fails, so
   "which is best" always has a defensible answer — but the bar is **absolute** (+13.0 bps), not
   relative. A field of failures has a winner and that winner is still a failure.
3. **An underpowered cell can never be "best".** `bestPowered` is restricted to n ≥ 12, so a 3-entry
   cell with a spectacular mean cannot become the headline.

### Power is barely affected; cost is what changes

Doubling the family moves the Bonferroni z from ≈3.48 to ≈3.66. At n≈62 entries/arm and the observed
SD of ≈29 bps (SE ≈ 3.7), the mean needed to clear the bar moves from ≈25.9 to ≈26.5 bps — **a 0.6 bps
difference.** The correction is not the binding constraint; **the corpus is.** So adding the model axis
buys a direct answer to the owner's question at essentially no statistical cost.

### Budget, measured

Per-call cost is measured from the $1 smoke run (61 calls, $0.9943) at this exact request shape:
**$0.0163/call**. The kimi ratio is measured from the 2026-07-22 head-to-head ($0.012446 vs
$0.027210 per decide = **0.457×**).

| leg | calls | est. cost | cap |
| --- | --- | --- | --- |
| `claude-sonnet-5` | 4,632 | **~$75** | $90 |
| `kimi-k3` | 4,632 | **~$35** | $45 |
| **total** | 9,264 | **~$110** | $135 |

## Results

*Not yet produced for the champion (`claude-sonnet-5`) leg — see Amendment 2; runs 1 and 2 are VOID
and no arm has been scored on it. The bar above does not move. The kimi leg's results are recorded
below under their own trial id and do not substitute for it.*
