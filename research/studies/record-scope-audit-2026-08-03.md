# Record scope audit (2026-08-03)

An audit of five headline verdicts whose wording is broader than what they measured, and of one
verdict that has no wording at all beyond its conclusion.

**No verdict moves, and nothing is rewritten.** The five headlines were expected to need
re-qualifying. They do not: every one already carries its scope qualifier inline, in the prose that
first recorded it. This record is the review that confirms it — the qualifiers were incidental to
original authorship, never checked, and are checked here.

**The finding is the sixth item.** `research/loop/verdicts.md:570` closes the decide-model axis at
its top end with a bare clause carrying no figures, and **no artifact for that rejection survives
anywhere in the repo or its git history.** § 3.

## Bottom line

| Question | Answer |
| --- | --- |
| Do the five headlines need re-qualifying? | **No.** All five carry an inline scope qualifier already (§ 1). One gap: (a) does not name the architecture arm that was never run. |
| Did Passes 53–56 touch, reword or re-qualify any of them? | **No.** One commit touched the file in that range: `e20e7cd`, **+46/−0**, one contiguous insert above all five (§ 2). |
| Does a scorecard for the Opus-4.8 decide rejection survive? | **No.** Its origin text says the JSON was "archived in the session scratchpad"; no path in any commit on any branch has ever matched `opus` (§ 3). |
| Do the rejection's figures survive? | **Yes, in git only** — `be2f4fa`, deleted the same day by `66c3fac`: *0 proposes in 50 rows at 3.1× champion cost*. Nothing behind them survives. |
| Does any verdict change? | **No.** One amendment to `verdicts.md:570` is proposed (§ 6); it adds provenance and removes nothing. |

## 1. The five headlines, quoted, with their true scope

Each subsection quotes the current text verbatim, states what was actually measured, and names the
inline qualifier that is already present. Line numbers are against `research/loop/verdicts.md` at
`dbb3051`.

### (a) "ARCHITECTURE IS NOT THE LEVER EITHER" — `:210-214`

> **ARCHITECTURE IS NOT THE LEVER EITHER — the haiku 3-vote swarm does NOT ship, and the screen that
> predicted it is now VALIDATED (2026-07-30, Pass 49; Family A of
> `research/studies/playbook-space-followon-2026-07-31.md`, scorecard
> `research/scorecards/playbook-space-followon-2026-07-31.json`).**

**True scope: one N=3 haiku majority-vote configuration, on 354 in-sample rows, at four horizons.**
The study says so in terms at `playbook-space-followon-2026-07-31.md:936-937`:

> A `NO_SURVIVOR` here is a statement about `haiku_swarm` at h ∈ {1, 4, 8, 24} on 354 in-sample rows
> and about nothing else.

**Inline qualifier present:** the headline names the arm in its own clause — *"the haiku 3-vote
swarm does NOT ship"* — and `:217` pins *"the identical 354-row corpus"*, `:220` *"4 of 4 declared
cells"*. A reader cannot take "architecture" for a span it did not measure without ignoring the
second half of the same sentence.

**The one real gap, and it is the only one in this audit.** The bullet at `:210-267` never mentions
that the *other* architecture option was deferred. `tool_use_trader` — the memo's option (b), the
arm that lets the model choose what to look at rather than receive a fixed payload — is
**DEFERRED, not cancelled, and was never run** (`playbook-space-followon-2026-07-31.md:15`, `:304`,
`:1236`; carried onto the frontier ledger at `success-exit-2026-07-31.md:430` as *"deferred, not
cancelled | unset | unset — **does not reset the clock**"*). So the headline "architecture is not
the lever" rests on one of the two architecture arms that were specified, and the reader must
follow the citation one hop to learn that. **This is a scope note, not an error**: the study's own
§ 15 states it, the verdict cites the study by path, and no figure in the bullet is wrong.

### (b) Price-TA "settled EMPTY" — `:548-553`

> - **Price-TA edge search is settled EMPTY** (2026-07-12 ultracode session: 4,562 backtests, 8
>   families, long+short, 15m–1d, fees 0→20bps — ZERO honest survivors at any fee level incl.
>   0bps; `reports/loop/multi-strategy-search-2026-07-12.md`). The LLM lane cannot profit by
>   reading price better; its only possible edge is information the price series does not contain.
>   **Do NOT re-run price-TA edge searches.** (Frontier if ever wanted, forward-test-only:
>   long-short daily cross-sectional momentum on perps.)

**True scope: 8 families at timeframes 15m through 1d.** Multi-day is outside the search entirely.

**Inline qualifier present, twice.** The bar `15m–1d` sits in the parenthetical that opens the
bullet, and the closing parenthetical names the untested frontier by name —
*long-short daily cross-sectional momentum on perps* — as forward-test-only. The headline word
"EMPTY" is bounded by its own sentence in both directions.

**One provenance note.** The cited report `reports/loop/multi-strategy-search-2026-07-12.md` was
deleted at `098b86d` (2026-07-21, owner-directed md prune, 38 files to git-history-only), as was
`reports/loop/nonprice-sweep-2026-07-12.md` cited at `:557`. Both are recoverable from git by path.
That is materially different from § 3, where nothing was ever committed to recover.

### (c) Non-price "15/15 FAIL" — `:366-397`

> - **NON-PRICE CHANNELS — Wikipedia attention and Deribit DVOL/VRP TESTED AND FAILED; GDELT
>   UNTESTED** … **15 of 15 runnable cells FAIL.**

and its closing line, `:397-398`:

> **The non-price study is CLOSED at 15/15 FAIL + 12 permanently untested.**

**True scope: 15 runnable cells across two channels, one of them explicitly underpowered, plus 12
cells that were never testable.** The DVOL arm's own admission sits three lines under the headline
number, at `:373-374`:

> Wikipedia (n≈2,350, 10 assets over ~9 months, ≥100 views/day floor) is a genuinely powered null;
> DVOL (n≈440–480, BTC/ETH only) is a weak test, so a modest DVOL effect could still hide inside its
> intervals.

**Inline qualifier present, three times.** The headline itself splits *TESTED AND FAILED* from
*GDELT UNTESTED*; the count is qualified as *"15 of 15 **runnable** cells"*; and the closing line
carries the untested 12 in the same sentence as the 15. The number and its exclusions are never
separated by more than a clause.

### (d) "Two vendors indistinguishable" — `:188-191`

The claim is not worded as stated in the brief. The actual text is:

> - **`champion_v8` on identical rows: sonnet −12.7 / −36.3 / −32.7 / −70.1 bps at h=1/4/8/24 (n=70);
>   kimi-k3 −10.7 / −29.6 / −44.1 / −66.1 (n=100).** Two vendors, schema compliance 92.9% vs 48.7%,
>   entry rate 21.8% vs 62.0% — **entry quality indistinguishable, every cell failing on the mean.**

**True scope: mean entry quality only, between claude-sonnet-5 and kimi-k3.** The two vendors are
*not* indistinguishable — they differ nearly two-to-one on schema compliance (92.9% vs 48.7%) and
nearly three-to-one on entry rate (21.8% vs 62.0%), and both figures appear in the same sentence as
the word "indistinguishable". **Neither model is opus-tier.** The claim says nothing about the
frontier of the model axis; the only verdict that does is § 3.

**Inline qualifier present:** the noun is *entry quality*, not *the vendors*, and the two dimensions
on which they visibly differ are printed immediately before it.

### (e) The 1,807-cut exhaustion — `:421-424`

> - **No conditional subgroup rescues it: 1,807 cuts examined, 0 of 188 counterfactual cuts positive
>   at n≥8.** Smallest p among ALL positive-mean cuts is 0.302; BH at q=0.05 yields zero discoveries;
>   family-wise permutation over 120 realised cuts gives p = 0.378. **There is no attribute-based
>   entry filter to deploy** — the search is exhausted over everything the system records.

**True scope: the attributes this system persists, and nothing else.** The persisted surface is 22
tables in `src/database/schemas/` (`order_intents`, `orders`, `order_events`, `fills`, `positions`,
`balances`, `fee_ledger`, `signals`, `risk_decisions`, `exec_outbox`, `outbox_consumer_acks`,
`equity_curve`, `config_snapshots`, `reconciliations`, `mode_transitions`, `audit_log`,
`agent_decisions`, `agent_playbook_versions`, `llm_usage`, `funding_events`, `funding_payments`,
`experiments`). Verified by enumerating every `pgTable(` declaration in the schema tree.

**What has no table at all:** order-book depth, public trade flow, and cross-venue spread. No
schema file contains the strings `orderbook`, `order_book`, `depth` or `spread`. Funding is the one
partial case and should be stated precisely: realised funding **is** recorded, as
`funding_events` / `funding_payments`; the funding **term structure** is not.

**Inline qualifier present:** the sentence ends *"over everything the system records"*, which is the
exact bound. "Exhausted" is never asserted over microstructure — but nor is the exclusion listed, so
the reader must know what the schema holds to size the claim. This audit lists it.

## 2. Passes 53–56 did not touch any of the five

Verified, because the brief's expectation was that they had.

```text
git log  --oneline 7d2e1d2..HEAD -- research/loop/verdicts.md   →  e20e7cd  (one commit)
git diff --stat    7d2e1d2..HEAD -- research/loop/verdicts.md   →  46 ++++, 1 file, 46 insertions(+)
```

`7d2e1d2` is Pass 53's own commit (2026-07-31); `HEAD` is `dbb3051` (Pass 56). Fourteen commits land
in that range and exactly one touches `verdicts.md`. Its diff is **+46 / −0** — a single contiguous
insert at `@@ -134,6 +134,52 @@`, adding the horizon-grid verdict and the `−16.9 → −13.75`
correction. Both new blocks sit **above** claim (d) at `:188` and above every other claim audited
here.

**Zero deletions across the range means no line of any of the five was reworded, re-qualified or
re-scoped.** The qualifiers documented in § 1 are the original authors' own, written at first
recording and never reviewed since. This record is that review.

## 3. The load-bearing finding — a rejection with no surviving artifact

### 3.1 The clause

`research/loop/verdicts.md:570`, mid-paragraph, between the E2/haiku re-test and the thinking-on
sentence:

> Opus-4.8 decisively rejected (07-13).

That is the entire record. **No n, no cost, no schema-compliance rate, no hold-agreement, no
forward proxy, no scorecard path.** Every other model verdict in the same section carries figures:

| verdict | figures carried at the verdict | committed artifact |
| --- | --- | --- |
| haiku-4.5, E2 re-test (`:563-570`) | schema-valid 0.83, hold-agree 0.78 < 0.85, forward proxy −27.9 vs +17.8 bps, n=100, corpus 728 | `research/scorecards/e2-model-eval-2026-07-17.json` |
| kimi-k3 offline replay (`:573-578`) | schema-valid 0.85 < 1.00, hold-agreement 0.17, cost −32% vs a −50% bar, plan-sanity 1.0, n=100 | `research/scorecards/kimi-k3-model-eval-2026-07-21.json` |
| trade-model head-to-head (`:579-591`) | five criteria itemised, n=200/leg | `research/scorecards/trade-model-eval-headtohead-hardened-2026-07-22.json` |
| **Opus-4.8 (`:570`)** | **none** | **none** |

### 3.2 What the search returned

Four searches, all negative for an artifact.

- **`research/scorecards/`** — 17 files. Four are model evals (`e2-model-eval-2026-07-17.json`,
  `kimi-k3-model-eval-2026-07-21.json`, two `trade-model-eval-*`). None contains an opus arm;
  `e2-model-eval-2026-07-17.json` has exactly one candidate, `claude-haiku-4-5-20251001`, and zero
  occurrences of the string `opus`.
- **`research/studies/`** — 20 files. The three that mention Opus mention the 2026-07-20 **reflection
  budget runaway** (`playbook-space-followon-2026-07-31.md:763`,
  `playbook-space-replay-2026-07-28.md:193`) or opus rows in `llm_usage`
  (`success-exit-2026-07-31.md:345`). None concerns a decide-model evaluation.
- **`git log --all --diff-filter=D --name-only`** — no deleted path relates. The deleted
  `candidates/e2-model-eval-2026-07-12.json` (pruned at `fa2d3dc`) predates the 07-13 rejection and
  is the haiku-only 07-12 run.
- **Every path ever added on any branch** — enumerated via
  `git log --all --pretty=format: --name-only --diff-filter=A | sort -u`, filtered for `opus`:
  **zero matches.** No file with `opus` in its name has ever existed in this repository.

### 3.3 What does survive, and where

The figures survive. The artifact does not, and the origin text says why.

`git log --all -S'0 proposes in 50'` returns exactly two commits, both 2026-07-13: `be2f4fa` added
the text, `66c3fac` removed it the same day. The added text, in `reports/loop/state.md`:

> `claude-opus-4-8`: 0 proposes in 50 rows at 3.1× champion cost — decisively rejected for decide.
> Scorecard JSON archived in the session scratchpad; harness `test/eval/agentic/
> candidate-model-eval.spec.ts` (read-only vs prod DB via DB_SUITE_ALLOW_RESET=1, verified).

**"Archived in the session scratchpad" is the whole answer.** The scratchpad is session-local and
ephemeral; the JSON never entered the repository, so there is nothing for a prune to have removed
and nothing for `git` to recover. `66c3fac` — a same-day state.md compaction — reduced the
five-line entry to *"opus-4.8 decisively rejected"*, and that compacted form is what migrated into
`verdicts.md` and reads at `:570` today.

So the honest statement is two-part, and both parts matter:

1. **The figures are recoverable** — `n=50`, `0 proposes`, `3.1× champion cost` — from `be2f4fa`.
2. **Nothing behind them is.** No per-row output, no scorecard, no criteria table, no prompt
   surface, no cost breakdown. The three numbers cannot be checked against anything.

This is a different failure from § 1(b)'s pruned reports: those were committed, then deleted, and
`git show` returns them intact. This one was never committed.

## 4. The charter clause, quoted exactly

`research/loop/charter.md:102-105`:

> - **Models/cost (2026-07-08, "improve aggressively" mandate):** "Sonnet-5-only" and "≤$1/day"
>   framings lifted. Reflection runs Opus-4.8; decide model changes ONLY via the $0 offline
>   harness (never a blind flip); ceiling = `AGENTIC_DAILY_COST_STOP_USD=$5/day` breaker
>   (expected true spend ~$2.2–2.5/day at 5 symbols).

The harness that clause names still exists and still runs: `test/eval/agentic/candidate-model-eval.spec.ts`,
which produced both surviving scorecards. Its own usage header, at `:26`, names the model in
question:

```text
//   AGENTIC_EVAL_CANDIDATE_MODELS=claude-haiku-4-5-20251001,claude-opus-5   (optional, comma-sep)
```

**The live route is closed, which leaves the offline harness as the only one.** `STATUS.md:105-107`
records that the decide-model A/B config gate shipped flag-off at `3958c8c` and *"is NOT a working
A/B"* — the arm is drawn once per boot and attribution journals every arm-B decide as arm A, so
`AGENTIC_MODEL_AB_PCT` stays 0. A blind flip is forbidden by charter and impossible in practice.

## 5. Conclusion — the axis is foreclosed on evidence that cannot be examined

A rejection verdict with no surviving artifact is **unfalsifiable**. It cannot be re-derived,
re-scored under the corrected horizon grid, or checked against the corpus it ran on. It can only be
believed or ignored.

Three facts make that structural rather than tidy-up:

1. **It closes the top of the axis.** `verdicts.md:244-245` refuses the haiku lead partly because
   *"it is a **model** change on the axis § THE DECIDE MODEL IS NOT THE LEVER already settled
   `NO_SURVIVOR`"*. That axis was settled on sonnet-vs-kimi (§ 1(d)) at the middle of the range and
   on haiku below it. **The only recorded reason not to look above sonnet is `:570`.**
2. **It is measured on a grid the program has since disowned.** `verdicts.md:134-157` (Pass 54)
   rules that *"every arm ever scored … was scored on its most flattering horizon"* and that a prior
   result *"may not be quoted as a horizon-general finding without re-reading it against this"*. The
   opus rejection cannot be re-read. It is a verdict exempt from a correction that binds every other
   verdict in the file, purely because there is nothing left to correct.
3. **The axis is not on the frontier ledger that a program stop must exhaust.**
   `success-exit-2026-07-31.md:419-437` freezes S1's ledger at nine rows — `haiku_swarm`,
   Family B `inverted`, `tool_use_trader`, four prose arms, Wikipedia, DVOL, GDELT ×2, symbol
   rotation, CryptoPanic. **No decide-model row appears.** S1 fires *"when the funded arms return
   and no ledger row remains with both a cost and a prior"*, and § 5 of that study projects that as
   a live possibility within weeks. So the program can reach a recorded STOP while an entire axis
   sits closed on three numbers whose backing was thrown away — never appearing on the ledger whose
   exhaustion is the stop's justification.

**The remedy is cheap and already specified.** A pre-registered offline run through the harness
charter § Models/cost mandates is the artifact that does not exist. **A FAIL there *is* the
artifact** — it converts an unfalsifiable clause into a checkable one at the cost of one gate under
the ≤$20 budget (`charter.md:106-107`). A PASS would mean the axis was closed on no recorded
evidence, and that the closure propagated into three later verdicts and one stop criterion.

Either outcome is worth more than the current state, which is a claim that cannot be wrong.

## 6. Amendment proposed

One, to `research/loop/verdicts.md`. It deletes nothing and changes no verdict; it restores the
provenance that `66c3fac` compacted away and states the artifact status on the record.

**Replace `research/loop/verdicts.md:570`:**

```text
  blocks). Opus-4.8 decisively rejected (07-13). **Thinking-on: NO FLIP** by pre-registered
```

**with:**

```text
  blocks). **Opus-4.8 rejected 07-13 on n=50 rows — 0 proposes at 3.1× champion cost** (figures
  recoverable only from `be2f4fa` `reports/loop/state.md`, compacted away the same day by
  `66c3fac`). **NO ARTIFACT SURVIVES:** the origin text records the scorecard JSON as "archived in
  the session scratchpad", so it never entered the repo — no path in any commit on any branch has
  ever matched `opus`. Alone among the model verdicts in this section it carries no checkable
  evidence and **cannot be re-scored under § THE DECLARED HORIZON GRID**. It is the only recorded
  reason not to test above sonnet, and no decide-model row appears on the S1 frontier ledger
  (`success-exit-2026-07-31.md:426-437`). Re-running the harness `charter.md:103-104` mandates
  (`test/eval/agentic/candidate-model-eval.spec.ts`, `AGENTIC_EVAL_CANDIDATE_MODELS=claude-opus-5`)
  is the only way to make it falsifiable — **a FAIL there IS the missing artifact**. See
  `research/studies/record-scope-audit-2026-08-03.md` § 3. **Thinking-on: NO FLIP** by pre-registered
```

**No amendment is proposed for any of the five headlines in § 1.** Their qualifiers are present and
correct; § 1 is the review that establishes it, and re-wording verified-correct prose would be
churn.

## What this record does not claim

- It does not claim Opus-4.8 was wrongly rejected. Three numbers with no backing are not evidence
  the rejection was wrong — they are the absence of evidence that it was right.
- It does not authorise a decide-model change, a spend, or a flip. `charter.md:102-105` and the
  ≤$20/gate ceiling bind unchanged; any run is a new dated pre-registration.
- It does not re-open § THE DECIDE MODEL IS NOT THE LEVER. That verdict's sonnet/kimi and haiku
  cells have committed artifacts and stand on them.
- It does not re-derive any of the five headline results. It audits their wording against their
  measured scope, and reports one gap — (a)'s deferred second architecture arm — as a scope note.
