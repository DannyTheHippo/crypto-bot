# Deployment bar — chronological-halves clause (change-discipline record, 2026-07-31)

**This is a pre-registration, not a report.** It records — before the code change is made — that the
deployment bar is gaining a third conjunct: an arm must beat the incumbent at the primary horizon in
**both chronological halves** of the scoring window. It is written first because the bar it changes
was itself pre-registered, and a record written after the code is a rationalisation.

**Authority: owner autonomy grant 6 (2026-07-22).** Any owner gate or criterion in this program is
changeable by the loop *provided a dated, pre-registered change-discipline record exists before the
change* — "change-discipline binds every change — pre-register, record what/why, never rewrite
history" (`research/loop/charter.md:166-168`, carrying the owner's verbatim grant "You are welcome to
change any owner gate/decision (not live flip; that's only me)"; the widest facet is labelled grant 7
at `charter.md:183`). The single exception, unchanged and untouched here, is the live-money flip.

**What makes a record mandatory rather than advisable.** The deployment bar is not folklore; it is
fixed text in a frozen pre-registration — `research/studies/playbook-space-followon-2026-07-31.md:86-113`,
§ "Deployment-bar declarations, fixed here", whose own opening states that the corpora, metric, bars
and decision rules "cannot change after a result is seen" (`:3-7`). Adding a conjunct is a change to
that bar. It is being made **before the Family A run**, which is the only time it can legitimately be
made at all.

**Ordering constraint this record creates:** no deployment comparison, mint or deploy may run under
the new bar before this file exists. Any comparison already scored under the two-conjunct rule stays
scored under the two-conjunct rule; this clause is not applied retroactively to a result already
seen.

## 1. What is being changed

`compareToIncumbent` (`test/eval/agentic/playbook-space-replay.ts:1744-1779`). Its ship rule today,
quoted verbatim from `:1766`:

```ts
  const ships = beatsAtPrimary && horizonsWon >= DEPLOYMENT_MIN_HORIZONS_WON;
```

The two conjuncts are the pre-registered ones, and both stay exactly as they are:

- `beatsAtPrimary` — the arm's mean exceeds the incumbent's at `DEPLOYMENT_PRIMARY_HORIZON = 24`
  (`:1499`), computed at `:1764` off the per-horizon table built at `:1751-1763`.
- `horizonsWon >= DEPLOYMENT_MIN_HORIZONS_WON`, with `DEPLOYMENT_MIN_HORIZONS_WON = 3` (`:1501`) —
  the prereg's robustness clause (`playbook-space-followon-2026-07-31.md:98-102`).

**The change is one added conjunct**, and nothing else in the function moves: not the horizon, not
the metric, not the 3-of-4 rule, not `horizonDependent` (`:1776`), not the attribution passthrough
(`:1777`).

The function's docstring, which the change must keep true, verbatim from `:1739-1743`:

```text
The DEPLOYMENT bar: a ranking of measured means among options that all have to be somewhere. Not
alpha-corrected, because it tests no hypothesis against a null — and evaluated independently of,
and regardless of, the research-bar outcome.
```

**That docstring is not weakened by this change, and the distinction is load-bearing.** The new
conjunct introduces no null, no p-value and no α. It compares the same two measured means twice on
disjoint subsets of the same rows. The bar remains a ranking; it becomes a ranking that has to hold
on both halves of the window rather than on the window's average alone. No alpha correction is
owed and none is added.

## 2. Why — one static corpus, repeated selection against it, and nothing counting the attempts

Every candidate this program scores is measured against **one** corpus:
`test/eval/agentic/data/corpus-v3-flat.jsonl`, loaded by `loadCorpus`
(`playbook-space-replay.ts:454-467`), stride-sampled at run time to the budgeted row count by
`strideSample` (`:857-862`), and pinned by `corpusManifest`'s `payloadSha256` (`:470-486`) with
`assertDesignMatchesCorpus` (`:377-380`) refusing a run whose corpus does not match the design's.

Measured directly against the file on disk (386 rows, 26 symbols):

| property | value |
| --- | --- |
| rows | 386 |
| symbols | 26 |
| first event | 2026-07-21T15:00:00Z |
| last event | 2026-07-27T19:30:00Z |
| span | **6.19 days** |
| chronological? | **yes — 0 order inversions across all 386 rows** |

Two of those deserve comment. The **6.19 days** is a correction: the predecessor study and the
prereg describe the window as 6.35 days
(`playbook-space-replay-2026-07-28.md:69-70`, quoted onward in
`entry-rate-rederivation-2026-07-30.md:321-322`). The difference is immaterial to every conclusion
drawn from it and is noted only so this record's own numbers are reproducible. The **chronology** is
what makes this clause possible at all, and it was until now only an unchecked assertion in a
docstring — "The corpus is chronological" (`:852`). It is true; it is now measured.

**The problem this creates.** The deployment bar asks "does this arm beat the incumbent on this
sample?" Ask it repeatedly, keep the winners, and the surviving arm is selected partly for fitting
*this sample's* noise — a 6.19-day, 26-symbol, single-regime window. The bar is doing exactly what it
was designed to do, honestly, each time; the walk is a property of the repetition, not of any one
comparison.

**And nothing counts the repetitions.** There is no attempt counter anywhere in the mint path:
`classifyMintGate` (`scripts/loop-authoring-core.mjs:355-365`) reads the current comparison's
`ships` field and nothing about how many comparisons preceded it. § 7 proposes the counter and is
honest about the hole in it.

**Why halves are the right cheap guard.** A mean over the whole window can be carried entirely by
one stretch of it. Splitting the window and requiring the arm to win on both sides costs no extra
calls, no extra corpus and no α, and it converts "won on average" into "won early and won late". It
is the same instrument the research bar already uses at clause 5, "both chronological halves > +13.0
bps" (`playbook-space-followon-2026-07-31.md:51`, implemented at `playbook-space-replay.ts:665`) —
applied to a comparison instead of to an absolute threshold.

**What it does not do, stated so it cannot be over-read.** It does not correct for multiplicity, it
does not make a deployment an edge claim, and it does not make one regime into two. It removes one
specific failure shape: a win that exists only in half the window.

## 3. The load-bearing section — why the EXISTING halves cannot be reused

`CellStats` already carries `firstHalf` and `secondHalf` (`playbook-space-replay.ts:548-549`). Reusing
them would be a two-line change. **It would be wrong**, and this section is the reason. *The claim in
the task that prompted this record is correct; the verification below is mine, and it strengthens the
claim in one place and corrects its emphasis in another.*

### 3.1 The existing split is by INDEX, into each arm's own observation vector

`computeCell` (`:615-641`):

```ts
  const half = Math.floor(bps.length / 2);
```

at `:626`, feeding `:637-638`:

```ts
    firstHalf: mean(bps.slice(0, half)),
    secondHalf: mean(bps.slice(half)),
```

`bps` is that arm's own observation vector. The split point is the midpoint of *its own entry count*.

### 3.2 The vector is chronological — so these ARE chronological halves, per arm

Worth stating plainly, because it is what makes the fields look reusable. Observations are built in
row order (`playbook-space-replay.spec.ts:902-906`) from `entries`, itself built in row order
(`:888-894`); per-arm results are appended in chunk order (`playbook-space-replay.ts:1425-1431`) and
`mapWithConcurrency` writes results by index, not completion (`:1285-1301`); and the corpus is
chronological (§ 2, measured). So `firstHalf` really is "this arm's earlier entries" and
`secondHalf` "its later ones". The fields are not junk. They are exactly what the research bar needs.

### 3.3 Why that is fine for the research bar and fatal for the deployment bar

The research bar compares **one arm against a constant** (+13.0 bps, `:48`). Each arm may be split
wherever its own data says its midpoint is; no cross-arm comparability is required. Clause 5 is
sound.

The deployment bar compares **two arms against each other**. An index split gives each arm its own
boundary, and the arms post different entry counts on the same rows. From the frozen 2026-07-28
artifact (`research/candidates/playbook-space-replay-claude-sonnet-5-2026-07-28.json`), read directly:

| arm | h=1 | h=4 | h=8 | h=24 |
| --- | --- | --- | --- | --- |
| `champion_v8` | n=70 | n=70 | n=70 | **n=69** |
| `inverted` | n=117 | n=117 | n=117 | n=117 |

(Means as recorded, consistent with `verdicts.md:38-42`: `champion_v8` −12.7 / −36.3 / −32.7 / −70.1;
`inverted` −0.8 / +0.8 / +19.3 / +47.6.)

So on the identical 354 common rows, `champion_v8`'s h=24 split falls after its 34th entry and
`inverted`'s after its 58th. **Equal rank in unequal sequences is not equal time.** The two
"first halves" cover different calendar windows, and comparing them compares an arm's early-ish
period against an incumbent's differently-early period. A clause built this way would have the
shape of a robustness guard and the content of an arithmetic accident.

Two details sharpen it further:

- The boundary drifts for a second, independent reason: an entry whose forward return is unavailable
  (`fwdBps` returns `null` at the end of a symbol's series, `:516-531`) is dropped from `obs` but not
  from `entries` (`spec:902-906`), so the split index is the midpoint of the *scored* subset, which
  differs per arm per horizon. That is why `champion_v8` is n=69 at h=24 and n=70 elsewhere — its
  split instant moves between horizons *for the same arm*.
- `LaneCell`, the type `compareToIncumbent` actually consumes (`:674-682`, parameters at `:1746-1748`),
  **does not carry `firstHalf`/`secondHalf` at all.** The fields exist on `CellStats`, not on the
  deployment comparison's input. So the "two-line change" is not even available without widening
  `LaneCell` first — a small mercy, and not one to rely on (see § 6.3).

### 3.4 What the clause therefore requires

A **single, arm-independent split instant**: the median `eventTime` of the common row set — the rows
every arm answered, as produced by `truncateToCommonRows` (`:1266-1283`). One instant, both arms,
both halves defined by calendar time rather than by rank.

`ArmRowResult` already carries `eventTime` (`:1184`, populated at `:1400` and `:1414`), so the
information exists in the run. It is discarded at exactly one line — `spec:905`:

```ts
              if (v !== null) obs.push({ symbol: e.symbol, bps: v });
```

`Observation` is `{ symbol, bps }` (`:534-537`); the entry's `eventTime`, present on `e`, is dropped
here. **This is the only place the time is lost**, and carrying it forward is the whole
implementation cost of the honest version of this clause.

## 4. The clause, stated so it can be re-derived from this record alone

**Definitions.**

1. **Common row set `C`** — the rows retained by `truncateToCommonRows` (`:1266-1283`), i.e. the row
   ids every arm in the run answered. Not the arm's entries; the rows.
2. **Split instant `T`** — sort `C` ascending by `eventTime`; `T` is the `eventTime` at index
   `Math.floor(|C| / 2)`. For odd `|C|` this is the median row's time; for even `|C|` it is the upper
   of the two central times. Deterministic, arm-independent, horizon-independent, and computed before
   any comparison is read.
3. **Half assignment** — an observation belongs to the **early** half if its entry row's `eventTime`
   `< T`, and to the **late** half otherwise. Both arms use the same `T`.
4. **Half means** — `armEarly`, `armLate`, `incumbentEarly`, `incumbentLate`, each the mean of its
   half, at the **primary horizon only** (`DEPLOYMENT_PRIMARY_HORIZON = 24`, `:1499`). The clause is
   not evaluated at the other three horizons; the 3-of-4 conjunct already covers horizon breadth.

**Determination.** The clause is `DETERMINED` if and only if all four half-means are
`Number.isFinite` **and** each of the four halves contains at least `DEPLOYMENT_HALF_MIN_ENTRIES`
observations (§ 8). Otherwise it is `UNDETERMINED`.

**Outcome**, a three-valued result, not a boolean:

| outcome | condition |
| --- | --- |
| `BOTH_WON` | `DETERMINED` and `armEarly > incumbentEarly` and `armLate > incumbentLate` |
| `HALF_LOST` | `DETERMINED` and at least one half not won |
| `UNDETERMINED` | not `DETERMINED` |

**The new ship rule**, replacing `:1766`:

```ts
  const ships =
    beatsAtPrimary && horizonsWon >= DEPLOYMENT_MIN_HORIZONS_WON && halves !== 'HALF_LOST';
```

Ties (`armEarly === incumbentEarly`) are **not** wins, matching `beats: a.mean > i.mean` at `:1761`.

The comparison object gains the outcome and the four half-means; nothing existing is removed, so
`classifyMintGate`'s existing reads of `ships` / `horizonDependent` / `beatsAtPrimary`
(`loop-authoring-core.mjs:355-365`) keep working unchanged.

## 5. Failure directions, declared

Per `~/.claude/rules/code-hygiene.md` § Code changes, every gate states its direction and why.

### 5.1 A MEASURED half-loss fails CLOSED — the arm does not ship

An arm that beats the incumbent on the window average while losing one half of it has a win located
in half a single-regime window. The justification is the prereg's own, in its own idiom: the 3-of-4
robustness clause is already "stricter than the owner ruling requires", accepting that "it can leave
a marginally-better arm un-deployed", because *"'less-bad' has to mean less-bad"*
(`playbook-space-followon-2026-07-31.md:98-102`). The same sentence covers halves: a win carried by
one half is not distinguishable from a regime artifact, and this clause is the same trade the prereg
already made and already priced.

**This does not contradict the owner ruling.** *"if a less-bad playbook is found than the running
one, deploy it"* (`verdicts.md`, quoted at `playbook-space-followon-2026-07-31.md:66-68`) governs
**what to do with a found improvement**. It does not define **what counts as finding one**. This
clause operates entirely upstream of the ruling, on the second question. Once an arm is found
less-bad under the declared bar, the ruling applies with full force and this record does not touch
it.

### 5.2 An UNDETERMINED half fails OPEN — reported, never a blocker

An unmeasurable clause is not a failed clause. Two precedents in this program, both cited by line
because both were written for exactly this situation:

- `classifyEntryRateFloor` (`scripts/loop-authoring-core.mjs:284-294`): below the row minimum it
  returns `pass: true` with the reason "too little to distinguish abstention from transport failure,
  so the floor does not fire (fails OPEN, as the deleted measureEntryRate did)". *A transport failure
  is not an abstention.*
- `checkPromptSurface` (`playbook-space-replay.ts:1520-1528`): "a measurement-QUALITY gate, so a
  mismatch downgrades the reported attribution to BETWEEN-RUN rather than voiding a run that already
  cost real money. An unreadable git tree lands in the same place."

The halves clause is a measurement-quality gate of the same family, and refusing on it would do
active harm: `verdicts.md:34-36` — *"Do NOT re-derive 'research-bar FAIL ⇒ do not deploy'. It is
FALSE, and applying it throws away everything the study measured while leaving the worst-measured
option running."* Blocking a deployment because a robustness clause could not be computed leaves the
worst-measured option running for a reason that is not evidence about the arms.

`UNDETERMINED` is therefore reported on the comparison, printed in the run's deployment line, and
carried into the scorecard. It is never silent.

### 5.3 The exception: the UNATTENDED MINT refuses on UNDETERMINED

`classifyMintGate` (`scripts/loop-authoring-core.mjs:355-365`) gains a blocker when the halves
outcome is `UNDETERMINED`.

The asymmetry is deliberate and is about **authority, not about evidence**. A human reading a
comparison can weigh an unverifiable clause against everything else in front of them and ship anyway;
that is a judgement call and it is theirs to make. An unattended pass writing a mint to an
append-only registry has no such standing — the row it writes cannot be retracted (root
`CLAUDE.md` hard rule 6: `audit_log` and `order_events` are append-only), and "the robustness clause
could not be computed" is precisely the condition under which an automated selection walk would be
invisible. So: *a human may ship on an unverifiable clause; a pass writing on its own authority may
not.*

This is the one place where the clause's two failure directions differ by caller, and it is stated
here rather than discovered in the diff.

## 6. What it costs, stated plainly

### 6.1 It can leave a marginally-better arm undeployed

Same cost the 3-of-4 clause already carries and already declared
(`playbook-space-followon-2026-07-31.md:100-101`). An arm that genuinely is less-bad, whose advantage
happens to concentrate in one half of a 6.19-day window, does not ship. Under the owner ruling that
is a real loss, accepted for the reason in § 5.1.

### 6.2 The recorded-incumbent path can NEVER satisfy the clause

`loadRecordedIncumbentCells` (`playbook-space-replay.ts:1786-1805`) reads the frozen 2026-07-28
artifact, because `incumbent_control` is unfunded and the prereg designates the predecessor's
recorded row as the Family A comparator
(`playbook-space-followon-2026-07-31.md:108-111`). That artifact is frozen and cannot grow fields.

Verified against the file: its top-level keys are `study, model, baseUrl, manifest, design, armsRun,
run, bar, cells, passes, legOutcome` — **there is no per-row data anywhere in it**, so the
incumbent's per-entry `eventTime`s cannot be recovered and its time-halves cannot be computed
retroactively at any effort.

**Consequence, accepted:** whenever the comparator is the recorded row, the halves clause reads
`UNDETERMINED` **by construction**, fails open per § 5.2, and the deployment decision runs on the two
original conjuncts exactly as it does today. The clause binds only when the incumbent is re-measured
in-run. This makes the clause inert for Family A as currently funded. That is an honest description
of a guard that costs nothing to carry and starts working the moment an in-run incumbent exists — not
a reason to fake it.

### 6.3 The substitution that must not happen

The frozen artifact's cells **do** carry `firstHalf` and `secondHalf` — verified; its cell keys are
`model, arm, tests, h, rowsParsed, entryRate, decisionsChangedVsReference, n, clusters, mean, ciLo,
ciHi, pVsBar, placeboP, firstHalf, secondHalf, trimmed, verdict, failedClause`. They are the
**index-split** fields of § 3.1, and `loadRecordedIncumbentCells` types its parse as
`(LaneCell & { arm: string })[]` (`:1800`) — a type that does not declare them, so they arrive at
runtime while being invisible to the compiler.

**They must not be used to satisfy this clause.** Doing so would make § 6.2's `UNDETERMINED` go away,
turn the comparison green, and measure the arm-relative rank artifact of § 3.3 while carrying the
name of a robustness guard. That is worse than not having the clause, because it would be *reported*
as a guard that had passed. An `UNDETERMINED` that is honest is the correct output here; a
`BOTH_WON` obtained this way is a false one.

## 7. The attempt counter, and the hole in it

### 7.1 The key

`metrics->>'corpusFingerprint'` in the experiments registry. It is written by `buildScorecard`
(`scripts/loop-authoring.mjs:395-409`) as `corpusFingerprint: score.corpus.payloadSha256` (`:399`),
and lands in the registry row's `metrics` at `scripts/log-eval-experiment.mjs:244`.

It is the right key because it is computed by `corpusManifest` (`playbook-space-replay.ts:470-486`)
over the **full loaded manifest** — every row's id and payload (`:478`) — and is therefore invariant
to the row budget a given run actually replays. Two runs that stride-sample 60 and 354 rows from the
same corpus share one fingerprint. Counting rows grouped by that key answers "how many times has
something been scored against this exact corpus", which is the multiplicity nobody currently tracks.

### 7.2 Why `dataset_hash` does NOT work

`datasetHash` (`scripts/log-eval-experiment.mjs:232-239`) folds the run's own shape into the hash:

```js
      rowsLoaded: scorecard.window.rowsLoaded,
      rowsReplayed: scorecard.window.rowsReplayed,
```

(`:235-236`.) `rowsReplayed` is `score.rowsCovered` (`loop-authoring.mjs:408`) — the number of rows that run
actually covered. **Two runs against the identical corpus at different row budgets get different
`dataset_hash` values**, so grouping by it counts run configurations, not corpus reuse, and would
report a fresh corpus every time the budget moved. It is the correct key for "was this the same
run setup"; it is the wrong key for "how many bites at this apple".

### 7.3 The re-dump loophole — a known, unclosed hole, and it has ALREADY fired

`corpus-v3-flat.jsonl` is gitignored (`.gitignore:44`, `test/eval/agentic/data/*.jsonl`, with an
explicit exception at `:45-49` for the 6 KB recorded-entry index only). It is a local, reproducible
dump from the live `agent_decisions` source. **A re-dump changes the payload bytes, changes the sha,
and silently resets the count to zero on what every human descriptor would call the same corpus.**

This is not a hypothetical. Measured today:

| quantity | value |
| --- | --- |
| `corpusManifest` recomputed over the on-disk corpus | `030367ba…d417ff` |
| recorded in `playbook-space-replay-claude-sonnet-5-2026-07-28.json` `manifest.payloadSha256` | `f1dd13c6…25d229` |
| recorded in `playbook-space-design.json:13` | `f1dd13c6…25d229` |
| recorded in `playbook-space-followon-design.json:4` | `f1dd13c6…25d229` |
| rows / symbols / firstEventTime / lastEventTime | **identical** (386 / 26 / 1784646000000 / 1785180600000) |

Every identity field matches to the millisecond; only the payload hash differs. The recipe was not
the variable: `corpusManifest`'s hash line is byte-identical at the results commit `2f1c917:443` and
at `HEAD:478`, and none of five alternative recipes (whole-file, whole-line, JSON-stringified
payload, id-sorted, numeric-id-sorted) nor three row subsets (stride-354, first-354, last-354)
reproduces the recorded value. The file itself is untouched since creation
(`mtime == ctime == birthtime == 2026-07-27T20:12:42Z`), which makes the drift harder to explain, not
easier.

**Cause not established, and this record does not pretend otherwise.** The two candidates are (a) the
scored runs read a corpus dump that no longer exists on this disk — e.g. a re-dump inside a
short-lived worktree, where a gitignored file would not have been carried over and would have been
regenerated from a later DB state; or (b) a hashing input differed in a way this investigation did not
find. Both are consistent with every fact above. Distinguishing them requires evidence that is gone.

**Consequence for the counter, which holds under either cause:** an attempt counter keyed on
`corpusFingerprint` would today report **zero prior attempts** against the corpus a new run
fingerprints, on a corpus that has already been scored across 20 declared cells. The loophole is not
a future risk to the counter; it is the counter's present state.

**Named, not closed.** Closing it means committing the manifest triple (rows, first/last event time,
payload sha) as a checked-in pin, or keying the counter on the identity fields rather than the payload
bytes, or committing the dump itself against the reason `.gitignore:41-44` gives for excluding it
(multi-MB payloads in git history). Each is a separate change with its own trade, none is authorised
by this record, and the counter ships with this defect documented rather than hidden.

## 8. The n-floor, declared here because declaring it later would be post-hoc

**`DEPLOYMENT_HALF_MIN_ENTRIES = 12`.** Each of the four halves (arm-early, arm-late,
incumbent-early, incumbent-late) must contain at least 12 observations for the clause to be
`DETERMINED`. Below that, `UNDETERMINED` → fails open (§ 5.2).

**Derivation, not preference.** A half-mean is a mean, and this program has one declared minimum n
for reading a mean: `MIN_ENTRIES = 12` (`playbook-space-replay.ts:67`), the research bar's clause 7,
whose own justification is empirical rather than conventional — *"Below that the cell is
UNDERPOWERED… The horizon study's n=11 cell showed +6.3% excess and reversed at n=84"*
(`playbook-space-followon-2026-07-31.md:53-54`). A half is a cell-shaped quantity, so it inherits the
cell-shaped floor. No new number is invented.

**Alternative considered and rejected:** a smaller floor such as 6. It has no derivation in this
program — 6 appears as `DEFAULT_MINT_FLOOR_MIN_ROWS`, a count of *replay rows*, not of scored entries
(`loop-authoring-core.mjs:279`), and borrowing it across quantities would be numerology.

**Declared before any run under the new bar, and here is the proof it was not chosen to fit:** at
`DEPLOYMENT_HALF_MIN_ENTRIES = 12` the clause is determinable for the arms whose counts are already
public — `champion_v8` (n=69–70, halves ≈ 34/35) and `inverted` (n=117, halves ≈ 58) — and its
determinability for `haiku_swarm` and `haiku_single` is **unknown at freeze time**, because those
arms have never been run and their entry rates are not measured. If they post fewer than 24 scored
entries the clause reads `UNDETERMINED` for them and does not bind. That outcome is accepted in
advance rather than treated as a reason to lower the floor after seeing it.

**Consequence worth naming:** the floor makes the clause bind harder on arms with more entries. That
is the correct direction — more data is more checkable — but it does mean a low-frequency arm faces a
weaker deployment bar than a high-frequency one. Recorded as a property, not defended as a virtue.

## 9. Weaknesses of this record, stated against itself

1. **The clause is inert for the run it is being written for.** Family A's comparator is the frozen
   recorded row (§ 6.2), so the clause will read `UNDETERMINED` and change nothing about whether
   `haiku_swarm` ships. A guard whose first application is a no-op has not been tested by that
   application, and no claim is made that it works beyond the arithmetic in § 4.
2. **Halves do not address multiplicity, which is the actual problem in § 2.** Splitting a window is
   a robustness check within one comparison; the selection walk is across comparisons. The counter
   in § 7 is the instrument aimed at multiplicity, and it is a *report*, not a gate — no threshold is
   declared here, because a threshold chosen after seeing the counts would be exactly the post-hoc
   bar-setting § 8 refuses. Any future threshold needs its own record.
3. **Two halves of one regime are still one regime.** The corpus spans 6.19 days in a single market
   period. An arm that wins both halves has won two adjacent slices of the same regime, which is
   strictly more than winning one but is not out-of-sample and must never be described as such. The
   research bar's out-of-sample requirement (`entry-rate-rederivation-2026-07-30.md:244-269`) is
   untouched and remains the only route to an edge claim.
4. **The split instant is defined on the common row set, not on entries.** If one arm's entries
   cluster early and the other's late — which is a real difference between arms, not noise — both
   halves are still calendar-aligned, but the two arms' half-*counts* can be very unequal, and a
   mean over 13 observations is being compared to a mean over 45. The clause tolerates this
   deliberately: the alternative (matching counts) would reintroduce the arm-relative split that
   § 3.3 rejects. The n-floor bounds the smaller side; it does not equalise the two.
5. **The re-dump finding is unresolved, and it sits underneath everything.** § 7.3 establishes that
   the on-disk corpus does not reproduce the fingerprint three frozen artifacts record, and does not
   establish why. If the cause is (a), then the corpus scored on 2026-07-28 is not the corpus on this
   disk, and every "identical corpus" statement in the deployment-bar chain — including the prereg's
   "An arm is only ever compared to an incumbent measured on the corpus it was itself scored on"
   (`playbook-space-followon-2026-07-31.md:88-89`) — is currently unverifiable rather than false.
   This record does not resolve that, and no reader should treat the corpus pin as proven while it
   stands.
