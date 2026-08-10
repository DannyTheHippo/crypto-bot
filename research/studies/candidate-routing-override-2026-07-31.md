# Candidate routing — owner override of Pass 51's zeroing decision (2026-07-31)

**This is a change-discipline record for a decision the owner made, overriding a decision the loop
made earlier the same day.** Its purpose is preservation, not persuasion: the superseded reasoning is
quoted in full below so that a later pass, re-deriving it from the same evidence, recognises it as
already-considered-and-overridden rather than quietly restoring it.

**Authority.** Owner decision, 2026-07-31. The owner needs no grant to override the loop; the record
exists because change-discipline binds _every_ change in this program — "pre-register, record
what/why, never rewrite history" (`research/loop/charter.md:166-168`).

## 1. The superseded decision, verbatim

Recorded in `research/loop/STATUS.md:159-161` (§ Flagged for human review, item 2 of the three
hook-blocked `.env.app` edits):

> (2) `:159` `AGENTIC_PLAYBOOK_AB_PCT=40` routes NOTHING (proven: all
> 109 sonnet decides since v10 carry `playbook_version=10`) — **decision: set it to 0**; minting a
> v12 candidate instead was considered and rejected on evidence-dilution grounds.

The reasoning, restated so it is not lost with the quote: a knob that routes nothing is dead
configuration, and dead configuration that _looks_ live is a trap for the next reader. The
alternative — mint a v12 so the 40% has somewhere to go — was rejected because splitting decides
between v10 and v12 delays the one measurement the program is currently waiting on
(`WATCH-PLAYBOOK-V10-1`). Zeroing the knob was the cheaper, more honest description of reality.
That reasoning is correct on its own terms. It is overridden on scheduling grounds, not refuted.

The same STATUS.md block also records the arithmetic the override depends on: "Note `maxVersion()`
is 11, so the next mint is v12" (`STATUS.md:162`).

## 2. The override

**Owner, 2026-07-31: mint daily, starting now.** The authoring pass (`pnpm loop:authoring`,
`package.json:23`) is being wired into the pass procedure to run at most once per UTC day. A
candidate therefore exists from today onward, and the 40% routes to it.

## 3. Why the knob "routes nothing" — mechanism, verified against the live table

This section corrects a reading that looks like a bug report. It is not one.

Live state, `agent_playbook_versions`, queried this pass:

```text
 version |     source     | parent_version | length |          created_at
---------+----------------+----------------+--------+-------------------------------
       1 | seed           |                |   4000 | 2026-07-21 11:15:59.476983+00
       2 | seed           |                |   3819 | 2026-07-23 17:30:51.145285+00
       3 | reflection     |              2 |   3911 | 2026-07-24 07:46:54.901164+00
       4 | reflection     |              2 |   3919 | 2026-07-24 10:01:13.957414+00
       6 | seed           |                |   3819 | 2026-07-24 10:31:17.332684+00
       7 | reflection     |              6 |   3999 | 2026-07-24 11:01:16.588935+00
       8 | seed           |                |   3819 | 2026-07-27 08:56:04.815512+00
       9 | reflection     |              8 |   3996 | 2026-07-27 09:47:23.079025+00
      10 | loop-candidate |              8 |   1933 | 2026-07-30 16:56:43.46967+00
      11 | promotion      |             10 |     68 | 2026-07-30 16:56:57.909909+00
(10 rows)
```

The routing rule, `PlaybookAbRoutingProvider.selectCandidate`
(`src/features/trading/composition/agentic-bridge.module.ts:233-238`):

```ts
const candidates = versions.filter(
  (row) => CANDIDATE_SOURCES.has(row.source) && row.version > activeVersion,
);
```

`CANDIDATE_SOURCES` is `{'reflection', 'loop-candidate'}` (`agentic-bridge.module.ts:134`). Active
is 10. The only row above 10 is v11, whose source is `promotion` — a 68-byte pointer row that
_resolves to_ v10 rather than being a distinct playbook. `promotion` is deliberately not a candidate
source: "promotion/seed never route (they ARE, or resolve to, the active version already)"
(`agentic-bridge.module.ts:126-127`).

**So the candidate pool is empty BY CONSTRUCTION. That is the correct and expected state immediately
after a promotion, not a defect.** Promoting v10 consumed the only candidate above the active
version and wrote the pointer row that records it. `selectCandidate` returns `undefined`, `current()`
falls through to active (`:204-205`), and every decide is served v10. The knob is not broken and the
filter is not wrong — there was simply nothing left to route to.

Confirmed in the journal, all decides since the v10 row was written
(`created_at >= 2026-07-30 16:56:43+00`):

```text
 playbook_version | count |              min              |              max
------------------+-------+-------------------------------+-------------------------------
               10 |   128 | 2026-07-30 17:00:25.656475+00 | 2026-07-31 11:15:43.661337+00
                  |  2792 | 2026-07-30 17:00:00.379697+00 | 2026-07-31 11:15:57.067348+00
```

The 128 (Pass 51 saw 109; the count has advanced, the finding has not) are every
`model='claude-sonnet-5'` row, and not one carries a version other than 10. The 2792 version-less
rows are `prescreen` (2577) and `plan-executor` (215) — paths that never resolve a playbook and so
never carry one. No decide has ever been routed to a candidate under this active version.

## 4. Executing the override requires NO env edit

`.env.app:159` still reads, verbatim:

```text
AGENTIC_PLAYBOOK_AB_PCT=40 # W4.1 champion/candidate A/B: % of decides routed to the newest INACTIVE reflection candidate for per-version attribution; 0 disables
```

Pass 51's zeroing was never applied — all `.env*` edits are blocked by a global PreToolUse hook and
passes run unattended, so no agent could apply it (`STATUS.md:156-158`). The pending change is
pending, not landed.

**The override therefore executes by doing nothing: do NOT set it to 0.** A minted v12 lands above
active 10 with `source='loop-candidate'`, clears the filter at `agentic-bridge.module.ts:236`, and
routes at 40% immediately — no deploy, no restart, no config change. A pass that "tidies up" the dead
knob before the first mint silently cancels the owner's decision.

## 5. The accepted cost, stated without hedging

`WATCH-PLAYBOOK-V10-1` reads nothing until its stated bar is met: "first pass with ≥12 entries
attributable to `playbook_version=10` (this loop's own 'never act on a sub-n≥12 cell' bar)"
(`research/loop/watches.md:244-245`).

Once v12 routes at 40%, v10 receives ~60% of decides, so v10-attributable entries accrue at ~0.6x
their current rate and the bar is reached roughly **1.7x later** (1 / 0.6 ≈ 1.67). Concretely: in the
18.25h since the v10 boot the lane produced 4 entry decides (`open_short` 3, `open_long` 1, against
124 `hold`) and 9 fills across 5 symbols — an accrual of a few entries per day, against a bar of 12.
Days, not hours, are being added to a measurement already in progress.

That is precisely the evidence dilution Pass 51 was protecting against, and it is real. The override
accepts it; it does not dissolve it. Any pass tempted to record the delay as a surprise should read
this paragraph first — it was priced in on 2026-07-31.

**Correction to the bar as it has been paraphrased:** `WATCH-PLAYBOOK-V10-1` states an entry-count
deadline only. It carries no symbol-cluster clause. The neighbouring "≥5" belongs to
`WATCH-PLAN-AUTHORITY-1` — "≥5 closed round trips under the flag" (`watches.md:217`) — a different
watch with a different subject. Do not merge them.

## 6. Assignment is NOT randomized — binding on every future pass

`PlaybookAbRoutingProvider.current()` (`agentic-bridge.module.ts:201-202`, with
`BUCKET_MS = 60_000` at `:168`):

```ts
const bucket = Math.floor(Date.now() / PlaybookAbRoutingProvider.BUCKET_MS) % 100;
if (bucket >= this.pct) return active;
```

At `pct = 40` this sends minutes 0–39 of every 100-minute wall-clock cycle to the candidate and
minutes 40–99 to active. That is a **deterministic time pattern, not randomization.** Two decides one
minute apart get different arms; two decides 100 minutes apart get the same arm, always.

Any effect with time-of-cycle structure — funding stamps, session opens, scheduled consults, the
duty cycle of a sleeping host — is confounded with arm assignment. The split cannot separate "v12 is
better" from "the minutes v12 happens to own are better".

**No pass may report the v10-vs-v12 split as a clean A/B, or quote a v12-minus-v10 delta as a causal
effect of the playbook.** The split is usable for detecting gross breakage in a new candidate
(validation failures, collapsed entry rate, malformed plans) and for nothing that requires unbiased
attribution. Stating an attribution claim from it requires first fixing the assignment mechanism —
e.g. hashing a per-decide identifier instead of the clock — which is a code change with its own
record, not a reinterpretation of this one.

## 7. What would reverse this

Return to withholding candidates (mint pause, or `AGENTIC_PLAYBOOK_AB_PCT=0`) on any of:

1. **The v10 reading is imminent and would be lost.** v10 sits within ~2 entries of the n≥12 bar and
   a pass can show that continued splitting is what keeps it short. Finishing a measurement in flight
   beats starting a new one.
2. **Routed candidates degrade the book.** A minted candidate posts materially worse realised
   net-of-cost PnL per closed trip than active across ≥2 daily mints — the dilution buys damage, not
   information. Note the §6 caveat cuts both ways: a gross, repeated, same-direction degradation is
   readable; a marginal delta is not.
3. **The mints stop differing.** Successive daily candidates arrive materially identical to active
   (near-duplicate prose, or rejected by `validatePlaybook` at `agentic-bridge.module.ts:211-212` and
   falling back to active). Routing to a candidate that is not meaningfully a different arm pays the
   dilution and buys nothing.
4. **Owner instruction.** This override is the owner's; so is its reversal.

Absent one of those, daily minting stands, and the 40% stands with it.

## 8. Owner decision, 2026-08-10 — event-driven minting supersedes the DAILY CADENCE

**This supersedes ONE clause of § 2 (the CADENCE — "mint daily, starting now") and closes the
`research/loop/STATUS.md:117` OWNER DECISION OWED line**, verbatim:

> **OWNER DECISION OWED: daily minting and powered evidence are mutually exclusive**
> (`candidate-routing-override-2026-07-31.md`).

That line was owed because the mechanism it names is real and was never adjudicated: minting once per
UTC day divides the live entry population across playbook versions on a fixed calendar, independent of
whether any version has accrued enough evidence to be judged. Measured (`STATUS.md:117`): **only v1 and
v2 of eight versions ever reached `n≥12 AND clusters≥5`, both the oldest** — every version minted after
them was diluted below the powered floor before it could be read, by the SAME daily cadence this record
put in place. "NOTHING HERE CAN CURRENTLY BE SHOWN TO LEARN — the mechanism is DIVISION, not
suppression" (`STATUS.md:117`) is the diagnosis; this section is the resolution. Precise denominator —
**eight** live versions, not the `agent_playbook_versions` mint-ledger's larger row count (that table
never deletes a row, so it is not the same count): `research/studies/learning-capacity-2026-07-31.md`
§ 2 measures 78 entries shared across those eight versions, 9.75/version against the `MIN_ENTRIES=12`
bar, with v1 (28 entries, 13 clusters) and v2 (18 entries, 11 clusters) the only two ever POWERED — the
two that "had the book largely to themselves" before the next mint arrived.

**The resolution: minting is no longer calendar-driven. It is EVENT-driven.** A mint attempt is now
permitted ONLY when a FRESH read of the INCUMBENT playbook's own live forward return is
adverse-POWERED — `cell.powered === true && cell.ciHi < 0` — on the `flat_only` population at h=4 or
h=8 (`classifyMintTrigger`, `scripts/loop-authoring-core.mjs`; called from `scripts/loop-authoring.mjs`
before `claimTodaysSlot()`, with no override flag and `--dry-run` as the sole exemption). This is what
"the incumbent is measured harmful" means operationally, and it is a STRICTLY HIGHER bar than the
once-per-day ceiling it replaces: a version now accrues evidence for as long as it takes to reach a
verdict — powered or not, adverse or not — rather than being diluted every 24 hours by a fresh
candidate regardless of whether the standing one has been read yet. This is precisely what
**dissolves** the mutual exclusivity `STATUS.md:117` recorded: daily minting and powered evidence were
exclusive only because the CADENCE was the fixed point; once the cadence is removed and minting instead
waits on the incumbent's own adverse-POWERED reading, the two are no longer in tension by construction.

A second, independent defect in the same daily-cadence mechanism is fixed alongside this one and is
NOT a cadence change in its own right: the declared run shape (3 arms × 150 rows, $6.4674 against the
$5.00 cap — `research/loop/LOG.md`, Pass 65) guaranteed a budget abort on every attempted run, so even
absent the dilution problem the daily cadence was separately unable to complete a run most days.
`classifyDeclaredBudget` (`scripts/loop-authoring-core.mjs`) now refuses a declared-over-budget shape
BEFORE `claimTodaysSlot()`, and the default shape is cut to 2 arms × 150 rows ($4.3116 declared). This
does not change WHO gets to mint or WHEN in the sense § 8's cadence change does — it only stops a run
that would have been attempted from being arithmetically doomed on arrival.

**Authority.** Per § 7 item 4 above — "This override is the owner's; so is its reversal" — the owner
needs no further grant to amend one of the override's own clauses. This is that amendment, made
2026-08-10, to the CADENCE clause of § 2 only.

**What is UNCHANGED by this section, stated so it cannot be read as reviving § 1's superseded
decision:**

- `AGENTIC_PLAYBOOK_AB_PCT` **stays 40, untouched.** § 4's finding still holds — the override executes
  by doing nothing to that knob — and this section does not edit `.env.app` or propose editing it.
  Nothing here re-opens § 1's zeroing decision, which remains superseded.
- § 6's assignment mechanism (deterministic 100-minute wall-clock buckets, NOT randomized) is unchanged
  and its caveats bind exactly as before — this section changes WHEN a candidate is minted, never HOW a
  decide is routed to one once it exists.
- § 7 items 1–3 remain the reversal triggers for the ROUTING OVERRIDE itself (whether candidates route
  at all). They are a different question from the cadence this section replaces, and none of them is
  triggered or addressed by it.
