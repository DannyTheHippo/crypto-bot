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
[`research/loop/playbook-authoring.md`](../loop/playbook-authoring.md) — the ANTI-RATCHET OBJECTIVE,
preserved verbatim from its original source `reflection.service.ts:526-537` — states that "a flat
week is a FAILING week, not discipline… the promotion gate needs roughly two closed round trips per
day… if it cannot, loosen instead", backed by a mint-time entry-rate floor and a live-abstention
lapse. Against −106 bps/trip, trading less is the
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

## Amendment 5 (2026-07-30, before any edge call) — the funded design, sized from measured cost

**Owner funded both accounts (Anthropic $100, Moonshot $15) with an explicit constraint:** *"we should
not consume the full funding amounts (moonshot 15 usd can be consumed)"*, and, when the arithmetic was
put to them, *"if the funding is not enough for full row depth: use less rows"*.

The Amendment-4 design costs ~$110–160 and its kimi leg alone needs ~$35–80 against a $15 balance, so
it is **not fundable**. This amendment replaces it with a design sized from a **measured** per-call
cost. Nothing about the bar moves: **+13.0 bps, the 95% CI clause, MIN_ENTRIES=12, the placebo and the
trimming battery are all unchanged.**

### The lever that was chosen, and why it is the right one

Cost is `rows x arms`. Power is a function of **rows** alone (entries per cell). The Bonferroni family
is a function of **arms** alone. So the two ways to spend less are not equivalent:

| cut | effect on cost | effect on the mean an arm must post to pass |
| --- | --- | --- |
| halve **rows** | halves it | 1/sqrt(n): about 26 bps → about 33 bps, and low-entry-rate arms drop below MIN_ENTRIES |
| halve **arms** | halves it | slightly **easier** — a smaller family raises alpha |

**Arms absorb the budget; rows are held at full depth.** Cutting arms costs *coverage of playbook
space*, not sensitivity. Row depth gives way only if the model axis cannot otherwise be funded at all
(the owner's ordering above) — and never below a **150-row floor**, since at the corpus entry rate no
cell could reach MIN_ENTRIES beneath it. In the event, **row depth did not have to give way.**

### Frozen arm priority — declared before any cost was known

The arm COUNT falls out of measured cost, so the arm ORDER is frozen first; that makes the count the
only free parameter and removes every opportunity to pick arms once something is known about them.

`champion_v8`, `inverted`, `minimal`, `momentum_pure`, `meanrev_pure`, `shorts_only`, `candidate_v9`,
`seed_v1`, `leaders_only`, `high_conviction_only`, `trade_almost_never`, `one_symbol_btc`

Ranking is on prior and on **expected power**, both computable before any call. The last three rank
last because a pre-run power calculation says they cannot produce a powered cell on this corpus
(`high_conviction_only` fires ~1 in 20; `trade_almost_never` is built to abstain; `one_symbol_btc` is
capped by the ~15 BTC rows the corpus holds) — **not** because of anything observed. The lever tier
below still covers all twelve.

### Two tiers

- **EDGE tier** — the hypothesis test. Full row depth. Shared arms run on *every* model in the axis, so
  the model comparison is on identical arms and identical rows.
- **LEVER tier** — all twelve arms, few rows, measuring **entry rate and decision-change only**. This
  answers pre-registration weakness 6 (is playbook prose a lever on behaviour at all?), which is a
  question about *proportions* — 33 rows pins one to about ±9 points, while pinning a 29 bps-SD return
  mean needs hundreds. It tests **no hypothesis against the bar and contributes nothing to the
  Bonferroni family**; that exclusion is only honest because `verdictFor` is never called on it. Capped
  at 20% of the lead budget so the diagnostic can never outbid the study.

### Calibration (2026-07-30) — measured, not assumed

Two costs were on record and they disagreed by 2.4x ($0.0163/call smoke, $0.039668/call live decide
path), so the budget could not be allocated without measuring. One arm, 40 spanning rows, per model:

| | `claude-sonnet-5` | `kimi-k3` |
| --- | --- | --- |
| USD/call metered | $0.017305 | $0.007967 |
| **USD/call effective** (sizing basis) | **$0.017305** | **$0.010557** |
| transport | 100% | 100% (after the fix below) |
| schema-valid | 80% | 50% |
| empty-body 200s | 0 | 13 of 53 attempts |

The **live** figure was the outlier: the replay amortises its cache write across a 40-row chunk, the
live path re-warms far more often. The smoke figure held.

`usdPerCallEffective` scales the metered cost by attempts-per-usable-response. The meter can only price
a response that carried a `usage` block, so retried attempts cost it nothing while quite possibly
costing the account something. Whether Moonshot bills them is not observable from here, so **the budget
assumes it does** — wrong in the safe direction.

**The measured kimi ratio is 0.61x sonnet, not the 0.457x Amendment 4 assumed.** kimi-k3 lists at the
same $3/$15/$0.30 per Mtok as sonnet-5, so the earlier ratio was never a rate difference; it was a
token-count artefact of two non-comparable configurations, and it should not have been carried forward
as a planning constant.

### DEFECT found by the calibration gate: HTTP 200 with an empty body

The first two kimi probes returned **transport 72.5% and 55%**, below the 90% floor, and were correctly
voided. The cause was not rate limiting, latency, or billing: `ok: 40` of 40 attempts, zero 429s, zero
5xx, zero retries. **Moonshot's Anthropic-compatible surface returns HTTP 200 with a zero-length body on
roughly 30–45% of these requests.** `res.json()` throws, `replayPlanRow` collapses that to
`{ok:false}` with no usage, and the calibration reads it as transport failure.

It is **non-deterministic** — the same corpus row returned an empty body on one run and 2,365 bytes on
the next — which is what makes it retryable and what proves it is provider-side rather than
payload-dependent. `instrumentedFetch` now counts `emptyBody` separately and retries it after a short
fixed delay (not the exponential 429 backoff; there is nothing to back off from). **Transport went 55%
→ 97.5% → 100%.** Note this makes lowering concurrency counter-productive: probe 2 at concurrency 2 and
a 300s timeout was *worse* (55%) than probe 1 at concurrency 4 (72.5%).

Two further guards were added, both fail-closed: a calibration below the transport floor is **unusable
for sizing** (it is the one input every later decision rests on), and a calibration file written by an
older harness is rejected by name rather than surfacing three frames down as an arithmetic complaint.

**Also measured, and it is not a harness bug:** Moonshot does not honour forced `tool_choice`. Roughly
a third of responses come back `stop_reason: "end_turn"` with a bare text block and no `tool_use`
block, despite `tool_choice: {type:'tool'}`. That is why kimi's schema-valid rate is 50% against
sonnet's 80%. It is reported, never gating — provider behaviour is data, not a broken run.

### The funded design

| | value |
| --- | --- |
| edge rows/arm | **386 — full depth** (the axis could afford it) |
| shared edge arms (both models) | **3** — `champion_v8`, `inverted`, `minimal` |
| `claude-sonnet-5`-only edge arms | **1** — `momentum_pure` |
| lever tier | 12 arms x **33** rows, `claude-sonnet-5` |
| **family / Bonferroni denominator** | **28** (2x3x4 + 1x4), against 96 for the full grid |
| **alpha** | **1.7857e-3** |
| est. spend, `claude-sonnet-5` | **$33.57** of the $35 allocation |
| est. spend, `kimi-k3` | **$12.23** of the $13 allocation |

Total ≈ **$45.80 of the $115 funded** — about 40%, honouring the owner's constraint. The Anthropic
allocation is $35 rather than the $100 balance because **the live lane has first claim on that account**:
measured decide-path spend is $1.86/day mean and $3.63 worst day (`agent_decisions`, 282 calls at
$0.039668/call), so leaving $65 is roughly 35 days of lane runway. A study that starves the bot it is
studying is not a saving.

The design is written to `research/candidates/playbook-space-design.json` by the sizing step and
**read** by the edge run, which refuses to start without it. That ordering is the point: a design file
that exists before the first edge call is evidence the family was fixed before any hypothesis was
tested.

### Shrinking the family makes passing easier — stated plainly

Going from 96 cells to 28 raises alpha from 5.2083e-4 to 1.7857e-3. **That direction deserves
scrutiny**, so: the justification is that **fewer hypotheses are actually being tested**, not that an
easier bar was wanted. An untested arm is not a suppressed test. The clauses that do *not* depend on
alpha — `mean > 13.0` and a 95% CI lower bound above 13.0 — are untouched by any budget decision, and
there is a test asserting that a cell missing the bar fails under **any** family size. So a cheaper
study cannot argue the fee floor down.

### What the reduced design costs, honestly

**A NO_SURVIVOR verdict is now weaker than Amendment 4's would have been.** Four arms on sonnet and
three on kimi is not "a deliberately wide span of twelve"; it is seven cells of playbook space. The
decision rule is therefore weakened to match: **0 passes ⇒ no playbook among the FUNDED arms clears the
fee, and the learning hypothesis is unsupported — not proven dead.** The five unfunded arms remain
untested, and any write-up saying otherwise is overclaiming. The lever tier still covers all twelve for
the behavioural question.

### Entry-rate instability — a power risk, recorded before the edge run

Two identical 40-row probes of `champion_v8` on `claude-sonnet-5` (same rows, same prompt, same
harness) produced **8 entries of 39 parsed** and then **0 of 32**. Under a binomial at p=0.2, zero in 32
has probability ~0.08%, so these two measurements are not reconcilable as sampling noise on a stable
rate.

This matters because n per cell is what decides whether any cell can be powered: at 20.5% the champion
gives n≈77 on 386 rows, at 0% it gives n=0 and returns UNDERPOWERED. It is also **consistent with the
live system's own known behaviour** — the live objective carries an entry-rate floor precisely because
the model abstains more than the promotion gate can tolerate, and sonnet's live figure rests on only 14
proposes.

**Consequence for the run order:** the **LEVER tier runs first**, as a power check, for $6.85 rather
than discovering n=0 after $27 of edge calls. Its only permitted consequence is to report which arms
will return UNDERPOWERED. **The frozen priority order does not move on the strength of it** — swapping
an arm in because its measured entry rate looks better is exactly the cherry-picking the freeze exists
to prevent. Any change to the order must be its own dated amendment, made before the edge run, and must
say why.

## Results

### LEVER tier — `claude-sonnet-5`, 12 arms x 33 rows, 396 calls, $5.3996, transport 100%

| arm | parsed | entries | entry rate | changed vs champion | projected n at 386 rows |
| --- | --- | --- | --- | --- | --- |
| `champion_v8` | 22 | 1 | 4.5% | — | 18 |
| `inverted` | 21 | 0 | 0.0% | 36.4% | **0** |
| `minimal` | 21 | 1 | 4.8% | 9.1% | 18 |
| `momentum_pure` | 24 | 3 | 12.5% | 15.2% | 48 |
| `meanrev_pure` | 33 | 0 | 0.0% | 36.4% | **0** |
| `shorts_only` | 25 | 0 | 0.0% | 30.3% | **0** |
| `candidate_v9` | 24 | 2 | 8.3% | 9.1% | 32 |
| `seed_v1` | 24 | 1 | 4.2% | 6.1% | 16 |
| `leaders_only` | 32 | 0 | 0.0% | 33.3% | **0** |
| `high_conviction_only` | 30 | 0 | 0.0% | 27.3% | **0** |
| `trade_almost_never` | 32 | 0 | 0.0% | 33.3% | **0** |
| `one_symbol_btc` | 32 | 0 | 0.0% | 33.3% | **0** |

**Weakness 6 is answered, affirmatively: playbook prose IS a lever on behaviour.** Zero inert arms —
every arm changed 6–36% of decisions against the champion. What it does *not* move is entries: **8
entries across 320 parsed rows, 2.5%.**

### The edge tier was NOT run, and must not be run as designed

Seven of twelve arms produce **zero** entries. Of the four funded edge arms, `inverted` — a shared arm
and the one carrying the only positive-prior lead — projects **n=0**, and `champion_v8`/`minimal`
project n=18 off a **single observed entry each** (the 95% CI on 1/22 spans roughly 0–89). The design
would have bought $45.80 of mostly UNDERPOWERED cells. This is exactly what the pre-run power check
exists to prevent, and it cost $5.40 instead of $45.80 to learn.

### The replay under-enters by 4x against live, and the cause is NOT yet identified

On the identical 33 sampled rows the **live** system entered **6 times (18.2%)**; the replay of the
same champion entered **once (4.5%)**. Across the full corpus the live recorded distribution is
`hold` 83.2%, `open_long` 11.1%, `open_short` 4.9%, `close` 0.8% — a **16.1% entry rate**. The replay
under-enters by **4x on the same market states with nominally the same playbook.** That is a measured
fact and it is what blocks the edge tier.

#### A DEFECT was found and fixed, but it is not established as the cause

`replayPlanRow` built its capabilities object from **constants** while the recorded row payload carried
the real ones, so the replay contradicted its own input. The corpus records **three** distinct
capability profiles (153 rows perp/shorts/lev 2/0.35, 139 rows spot/no-shorts/lev 1/0.15, 18 rows
lev 5) plus per-row cash of $380–700; the harness replaced all of it with one constant set.

Three of those four values **do** reach the model, via the tool description:

| recorded | harness sent | reaches the model? |
| --- | --- | --- |
| `maxSizeFraction` 0.35 perp / 0.15 spot | `0.25` (caller's) | **yes** — as the stated `sizeFraction` ceiling *and* the zod bound |
| `shorts` false on 139 spot rows | `true` (study's flag) | **yes** — "shorts are enabled for this symbol" |
| `leverage` 1 / 2 / 5 | `'2'` | **yes** — "leverage is capped at 2x" |
| `venueFreeCash` $380–700 | `'0'` | **no** |

**Correction to this document's first diagnosis, which was wrong.** I initially recorded that
`venueFreeCash: '0'` told the model it had no money and caused the abstention. The regression test
written to protect that claim **refuted it**: `buildTradeTool` renders shorts, leverage and
maxSizeFraction only — never free cash. The sole free-cash figure a replay shows the model is the true
one already inside the recorded payload. The claim is retracted; the test
(`entry-rate-floor-capabilities.spec.ts`) now asserts the absence so it cannot be re-derived.

The real contradiction was the **sizeFraction ceiling**: the tool advertised `[0.005, 0.25]` and bounded
the schema at 0.25 while the payload advertised 0.35, so a model that believed its payload and proposed
0.30 was schema-rejected — abstention manufactured by the harness's own inconsistency. Plus shorts
offered on 139 spot rows where live forbade them, and the wrong leverage on 28 rows.

**Fixed** by deriving capabilities per-row from the recorded payload (`recordedCapabilities`), with the
zod bound taken from `caps` rather than `cfg` so the bound and the advertised limit can no longer
disagree. Fails OPEN to the config path when a payload carries no capabilities (synthetic fixtures),
and reports `capsSource` per call so the **caller** fails closed — the study now voids any run with a
single non-`recorded` row. 12 regression tests.

**Not confined to this study.** `replayPlanRow` is the shared call-builder for two MINT-TIME production
gates — `measureEntryRate` (`entry-rate-floor.ts`), the floor requiring >=1 entry in 12 replays before a
candidate may be minted, and the candidate expectancy backtest (`candidate-backtest.ts:255,264`). Both
were measuring candidate behaviour against a 0.25 ceiling and uniform shorts/leverage regardless of what
each row recorded.

**Still unexplained:** whether fixing this closes the 4x gap. The remaining untested candidate is the
system prompt — the replay builds it from `DEFAULT_FLOOR_PROFILE`, which may differ materially from the
live prompt — followed by the live mixture over ~9 playbook versions against this replay's single arm.
**Re-measure before attributing anything.**

### The fix closed the gap — the capabilities mismatch WAS the cause

Post-fix lever tier, same 33 rows, same arms, 396 calls, $5.7551, transport 100%:

| arm | pre-fix entry rate | **post-fix** | projected n at 386 rows |
| --- | --- | --- | --- |
| `champion_v8` | 4.5% | **30.3%** | 117 |
| `inverted` | 0.0% | **35.5%** | 137 |
| `minimal` | 4.8% | **40.6%** | 157 |
| `momentum_pure` | 12.5% | **34.4%** | 133 |
| `candidate_v9` | 8.3% | **32.3%** | 125 |
| `seed_v1` | 4.2% | **22.6%** | 87 |
| `shorts_only` | 0.0% | **21.2%** | 82 |
| `high_conviction_only` | 0.0% | **9.1%** | 35 |
| `trade_almost_never` | 0.0% | **3.2%** | 12 |
| `meanrev_pure` / `leaders_only` / `one_symbol_btc` | 0.0% | 0.0% | 0 |

**All arms: 8/320 = 2.5% → 73/383 = 19.1%**, against the live recorded **18.2%** on the same 33 rows and
**16.1%** across the corpus. The replay now reproduces live entry behaviour. Parse rates rose too
(31–33 of 33, against 21–33 pre-fix), which is the signature of the `sizeFraction` bound contradiction
being the mechanism: fewer legal proposals were being rejected as schema failures.

Still zero inert arms — every arm changes 9–55% of decisions against the champion.

### Post-fix calibration, and a reversal on cost

| | `claude-sonnet-5` | `kimi-k3` |
| --- | --- | --- |
| USD/call metered | $0.013673 | $0.016945 |
| **USD/call effective** | **$0.013673** | **$0.026265** |
| transport | 100% | 100% |
| schema-valid | 97.5% | 47.5% |
| empty-body 200s | 0 | 15 of 55 attempts |

**kimi is now 1.9x sonnet, not 0.61x.** The reversal is entirely the empty-body retry burden, charged
conservatively on the assumption Moonshot bills a response it never delivered. Kimi's schema-valid rate
stays near half sonnet's, which is the forced-`tool_choice` non-compliance already recorded.

### Re-sized design (family fixed 2026-07-30, before the first edge call)

Budgets are what REMAINED of each allocation after calibration and the two lever runs ($21.91 lead,
$9.30 follow) — a re-size mid-study must budget what is left, not what it started with.

| | value |
| --- | --- |
| edge rows/arm | **354 of 386** — REDUCED; the axis could not afford full depth at kimi's effective cost |
| shared edge arms (both models) | **1** — `champion_v8` |
| `claude-sonnet-5`-only edge arms | **3** — `inverted`, `minimal`, `momentum_pure` |
| **family / Bonferroni denominator** | **20** (2x1x4 + 3x4) |
| **alpha** | **2.5e-3** |

The row reduction is the owner's declared fallback firing for the first time. **Consequence, stated
plainly: the cross-model comparison now rests on `champion_v8` alone.** The declared rule spends on depth
before breadth and it was followed rather than re-decided after seeing the number — but it means "which
lane is best" is answered on the status-quo playbook only, not on each model's best arm.

## Results — `claude-sonnet-5` leg (complete)

354 rows, 4 arms, 1,416 calls, **$19.4220**, transport **100%**, schema **92.9%**, no abort, no
unfaithful-capability rows.

| arm | h | n | clusters | mean bps | CI lo | p vs bar | placebo p | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `champion_v8` | 1 | 70 | 16 | −12.7 | −24.3 | 1.0000 | 0.9828 | FAIL (mean) |
| `champion_v8` | 4 | 70 | 16 | −36.3 | −54.2 | 1.0000 | 0.9990 | FAIL (mean) |
| `champion_v8` | 8 | 70 | 16 | −32.7 | −54.2 | 1.0000 | 0.9854 | FAIL (mean) |
| `champion_v8` | 24 | 69 | 16 | −70.1 | −119.5 | 0.9994 | 0.9976 | FAIL (mean) |
| `inverted` | 1 | 117 | 20 | −0.8 | −7.7 | 1.0000 | 0.5030 | FAIL (mean) |
| `inverted` | 4 | 117 | 20 | +0.8 | −10.9 | 0.9873 | 0.3408 | FAIL (mean) |
| `inverted` | 8 | 117 | 20 | **+19.3** | +1.1 | 0.2215 | 0.0228 | FAIL (CI lower bound) |
| `inverted` | 24 | 117 | 20 | **+47.6** | −12.2 | 0.1947 | **0.0020** | FAIL (CI lower bound) |
| `minimal` | 1 | 91 | 18 | −13.3 | −16.8 | 1.0000 | 0.9964 | FAIL (mean) |
| `minimal` | 4 | 91 | 18 | −27.0 | −36.3 | 1.0000 | 0.9984 | FAIL (mean) |
| `minimal` | 8 | 91 | 18 | −27.2 | −40.2 | 1.0000 | 0.9828 | FAIL (mean) |
| `minimal` | 24 | 89 | 18 | −40.7 | −83.1 | 0.9758 | 0.9770 | FAIL (mean) |
| `momentum_pure` | 1 | 55 | 16 | −12.7 | −22.0 | 1.0000 | 0.9746 | FAIL (mean) |
| `momentum_pure` | 4 | 55 | 16 | −31.5 | −42.4 | 1.0000 | 0.9930 | FAIL (mean) |
| `momentum_pure` | 8 | 55 | 16 | −46.4 | −62.7 | 1.0000 | 0.9948 | FAIL (mean) |
| `momentum_pure` | 24 | 53 | 16 | −85.3 | −137.6 | 1.0000 | 0.9986 | FAIL (mean) |

**0 of 16 cells pass. Every cell is POWERED** (n = 53–117 against MIN_ENTRIES=12), so these are real
failures, not absent measurements — which is the first time this study has been able to say that.

Three readings worth recording:

1. **The original verdict reproduces under the FIXED harness.** `champion_v8` at h=1 is **−12.7 bps**
   against the −16.9 bps ENTRIES verdict, on a different row sample and a single playbook rather than the
   live 9-version mixture. So the capabilities defect did not manufacture the negative finding — the
   finding survives its repair, and the harness now agrees with live entry behaviour while still
   producing it.
2. **`inverted` is the only arm that is not flatly dead, and it still fails.** Mean **+19.3** at h=8 and
   **+47.6** at h=24 clear the +13.0 bar; both fail on the **CI lower bound** (+1.1 and −12.2), and both
   fail `p vs bar`. Its h=24 placebo p of **0.0020 is below alpha** — so the entry TIMING carries
   information beyond side-and-symbol drift, which a pure-beta explanation would not produce. This is
   "not proven", not "disproven": at n=117 across 20 clusters the interval is simply too wide to call,
   exactly as pre-registration weakness 1 anticipated. **It is a FAIL under the frozen rule and must not
   be quoted as an edge.**
3. **Unguided is no better than guided.** `minimal` (−13.3 at h=1) sits within a bar of the champion, and
   `momentum_pure` is the worst arm at long horizons (−85.3). Prose changes behaviour — 9–55% of
   decisions — without changing sign.

## Results — `kimi-k3` leg (complete)

354 rows, 1 shared arm, 354 calls, **$4.3953 metered**, transport **99.2%**, schema **48.7%**, no abort.
**172 empty-body 200s across 546 attempts (31.5%)**, all retried through — the defect rate measured in
calibration, reproduced at scale, and handled. Conservative real cost ≈ $6.78; the meter cannot price a
response the provider never delivered.

| arm | h | n | clusters | mean bps | CI lo | p vs bar | placebo p | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `champion_v8` | 1 | 100 | 19 | −10.7 | −17.5 | 1.0000 | 0.9884 | FAIL (mean) |
| `champion_v8` | 4 | 100 | 19 | −29.6 | −45.0 | 1.0000 | 0.9994 | FAIL (mean) |
| `champion_v8` | 8 | 100 | 19 | −44.1 | −59.1 | 1.0000 | 1.0000 | FAIL (mean) |
| `champion_v8` | 24 | 96 | 18 | −66.1 | −99.3 | 1.0000 | 0.9998 | FAIL (mean) |

## STUDY VERDICT: NO_SURVIVOR

Computed by `aggregateVerdict`, not by hand
(`research/candidates/playbook-space-joint-verdict-2026-07-28.json`):

- **complete: true** — both declared models ran; **20 of 20 declared cells scored**
- **passes: 0**
- **best POWERED cell: `claude-sonnet-5`/`inverted`@h24, mean +47.6 bps, CI lo −12.2, n=117** — ranking
  is not passing; this is the least-bad cell in a field of failures, and it fails.

### The model is not the lever — and this is the cleanest result in the study

`champion_v8` is the one arm both models ran, on identical rows:

| h | `claude-sonnet-5` (n=70) | `kimi-k3` (n=100) |
| --- | --- | --- |
| 1 | −12.7 | −10.7 |
| 4 | −36.3 | −29.6 |
| 8 | −32.7 | −44.1 |
| 24 | −70.1 | −66.1 |

Two different models, different vendors, different schema-compliance (92.9% vs 48.7%), different
willingness to trade — and **entry quality is indistinguishable.** Every cell fails on the mean, none is
close. Swapping the decide model does not move the sign.

**And on net terms, the higher-frequency lane is strictly worse.** kimi entered **62.0%** of parsed rows
against sonnet's **21.8%** — roughly 3x the round trips for the same gross expectancy, which is 3x the
fee drag. So the answer to *"which lane is best"* is: **sonnet, and only because it trades less.**
Neither is profitable, and "trades less" is the same lever the live objective is built to suppress.

### What this does and does not settle

**Settles:** entry quality is invariant to (a) the decide model, across two vendors; (b) playbook prose,
across four deliberately divergent texts that changed 9–55% of decisions; (c) horizon, across h ∈
{1,4,8,24}. `minimal` — no guidance at all — lands within a bar of the champion. The −16.9 bps ENTRIES
verdict **reproduces under the repaired harness** at −12.7 (sonnet) and −10.7 (kimi).

**Does not settle, and must not be written up as settled:** Amendment 5's weakened decision rule binds
here. Four arms on sonnet and one on kimi is **not** the twelve-arm span the original rule was calibrated
on, so **0 passes means no playbook among the FUNDED arms clears the fee — the learning hypothesis is
UNSUPPORTED, not proven dead.** Seven arms were never edge-tested; three of them
(`meanrev_pure`, `leaders_only`, `one_symbol_btc`) produce zero entries on this corpus and are untestable
here regardless.

**The one live thread:** `inverted` at h=8/24 has a mean above the bar (+19.3, +47.6) and an h=24 placebo
p of 0.0020 — below alpha — so its entry timing carries information beyond side-and-symbol drift. It
fails on interval width (CI lo +1.1 and −12.2) at n=117 across 20 clusters, exactly as pre-registration
weakness 1 predicted. That is **not proven**, not **disproven**, and under the frozen rule it is a FAIL.
It is also in-sample on one 6.35-day regime and mostly a sign-flip of a known negative, so it is a
hypothesis for an out-of-sample test, never an edge to deploy.

### Spend

| leg | metered |
| --- | --- |
| Anthropic — calibration x3, lever x2, sonnet edge | **$32.51** |
| Moonshot — calibration x5, diagnosis, kimi edge | **$6.81** (≈$9 conservative) |
| **total** | **≈$39.3 of $115 funded (34%)** |

Inside both allocations. The $45.80 originally projected for a 4-arm/3-arm design was not needed, because
row depth fell to 354 and kimi funded one arm.
