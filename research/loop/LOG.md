<!-- Moved 2026-07-24: reports/loop → research/loop (repo organization). Historical path refs inside remain as narrative. -->

# Daily profitability loop — pass log

Append-only, newest last. One dated entry per pass (including empty passes), per
`docs/planning/daily-profitability-loop.md` §6: data window, headline metrics, decision +
rationale, diff summary, gate results, soak verdict, flagged items, next candidates.

Rotation rule (2026-07-30, Pass 48): this file keeps only the **last five pass entries**. When a
sixth lands, the oldest rotates VERBATIM to `research/loop/archive/LOG-through-pass-47.md`, appended
at the end in chronological order — nothing is ever deleted. This replaces the former 30-day rule,
under which the file reached 5,886 lines and every pass paid to rehydrate from it. Entries older
than the five below are in that archive; older still is git history. Current state is
`research/loop/STATUS.md`, never this file.

---

## 2026-08-01 — Pass 55 (the criteria were adopted, and the last unsearched lever refused itself)

**Window:** 2026-07-31T21:48Z → 2026-08-01T08:20Z. Two leases, both taken and released:
`ef54fc6236ea40a2` (21:48Z) and `399762ce0e738cbb` (06:03Z). **Owner-directed session**, continuous
with Pass 54.

### ⚠ COLLISION — the FIFTH occurrence, and this one is characterised

**A concurrent scheduled pass ran at ~00:07Z inside this tree**, between two of this session's turns.
Evidence: a sweep digest `sweep-2026-08-01T00-07-32-287Z.json` this session did not produce, and
`package.json` / `scripts/loop-authoring.mjs` / `loop-authoring-core.spec.mjs` modified at 02:18–02:24
local while this session was idle. It committed nothing and wrote no LOG entry — it left work
in-flight. My lease was taken at 06:03Z, _after_ it ran, so `loop:lock` never had the chance to refuse
it; the lease binds only passes that call it, exactly as documented.

**Its work was NOT committed and NOT discarded.** Per playbook §4 ("stage ONLY files this pass
authored"), the three files were left in the working tree for that pass to claim. **This is the first
occurrence where the other pass's intent is legible, and its work looks correct and valuable:**
`loop:authoring` gains `--env-file-if-exists=.env` (the API key lives in `.env`, not `.env.app` — which
plausibly explains why `loop:authoring` has NEVER minted), `temperature` is removed because this model
family 400s on any non-default sampling parameter, and the HTTP error body is now surfaced instead of
swallowed. A later pass should adopt them; they are not this pass's to commit.

### The owner adopted the success/stop criteria — `1C, 2A, 3A, 4A`

Recorded as Amendment 1 at the top of `research/studies/success-exit-2026-07-31.md`, without rewriting
anything: the original "IT ENACTS NOTHING" paragraph and § 11's "until the owner answers" both stand,
each carrying a superseded-by pointer.

- **G1 re-cut from h ∈ {1,4} to the hold-matched h = 16.** **Recorded plainly: Q4 = A did NOT rebut
  § 10.** The "STOP written in the vocabulary of a success criterion" objection stands unresolved; the
  owner chose to run the criteria with it outstanding.
- **S3 will probably decide this before the window does.** At 2026-08-01T06:10Z: net-of-cost −$48.54
  over 8.47 window-days, LLM $22.04. −$5.73/day reaches the −$200 trigger in **26.4 days ≈ 2026-08-27**,
  four days BEFORE § 8's 2026-08-31 close. The LLM trigger is far out (~49 days). Q2 = A and Q3 = A
  interact that way and neither question showed it alone.

### The h = 16 derivation — control PASSED, and the honest output is a BOUND

**A correction against this session's own first draft:** the claim "the re-cut G1 has no number" was
WRONG. The clause's number is the floor (`mean > +24.2 AND ciLo > +24.2`) and the floor does not move
with the horizon — **G1 at h = 16 is evaluable today.** § 3's table is the FEASIBILITY analysis, not
the clause.

The method was recovered and reproduces all four published rows exactly, including an undocumented
convention (`mean`/`ciLo` rounded to 1dp _before_ the SE subtraction; raw inputs miss by 0.02–0.04).
**A point value at h = 16 is impossible without a fresh paid run:** the offline grid is frozen at
`{1,4,8,24}` and only per-(arm, horizon) aggregates are written to disk. Live is no substitute — v10
reads n = 10 at h = 16, under the floor of 12.

Monotonicity supports only: **req(K=20) ∈ [+45.0, +92.6], interval share ∈ [46.2%, 73.9%].** Even the
FLOOR of that exceeds h = 4's 35.6%, so **h = 16 is never as defensible as h ∈ {1,4}** — at best
"floor-limited like h = 8", which § 3 called _"a stronger reason to exclude it, not a weaker one"_.
Interpolation was forbidden and the data shows why: SE grows 1.70×, 1.56×, then **3.29×**.
`inverted`'s own h = 16 performance is **UNMEASURED** — the powered h = 16 cells (v1 −57.6, v2 −94.5)
are different playbook versions and citing them for `inverted` would be population-mixing.

### `arm-sweep-v1` — SIZING-GATE REFUSAL, $0.92 of $18 (`01f207c`)

The arm space was the last unsearched lever. Pre-registered on `shorts_only` (in no prior record; the
natural counter-hypothesis to a long-biased book with a measured-negative signal) and `meanrev_pure`.
Calibration, 30 rows/arm, transport 100%: **both arms 0 entries**, projected n@386 = 0, **neither full
leg funded**; the gate was verified to fire before any network call. The anticipated risk was wrong —
the corpus is spot=139/perp=247 so the eligible ceiling is 247 rows; the model simply never proposed an
entry under either arm. Recorded against the result: **0/30 is not a proven zero** (rule of three puts
the upper bound near 10%, which on 386 rows would clear n ≥ 12), so this bounds the entry rate rather
than killing the arms.

### G5 shipped; G4 declined to a design question

`agentic_promotion_blocked{reason}` now emits one series per reason, 1/0 over the whole closed set,
zero-seeded via `satisfies Record<PromotionBlockedReason, true>`. **The reason set is EIGHT, not the
seven this repo's prose says** — `NO_STATS_SOURCE` is an early-return branch, and a count that missed
it would have under-seeded exactly the reason that fires when the stats source is gone. Fails OPEN
(mirrors evidence, never feeds back). `test:livegate` 55/55.

**G4 is NOT built, and this is a blocker not a deferral.** `PassiveBenchmarkPort` has **no
implementation anywhere** — `verdicts.md:294-303` already recorded it. Building it requires choosing a
basket, which is a judgement: equal-weight over the 40-symbol universe, over the 28 distinct assets, or
**exposure-matched to the strategy's realised ~50% gross exposure** (the recommendation — an
equal-weight full-notional basket compares a 50%-exposed strategy against a 100%-exposed benchmark).
**Owner question, open.**

### G4 shipped after all — the owner delegated the basket choice (`682b6f6`)

Asked to "handle G4 as you think is best", so the design calls were made and recorded rather than
deferred: equal-weight over **28 distinct underlying assets, not the 40 strings** (the universe lists
`BTC/USDT` and `BTC/USDT:USDT` separately, so string-weighting holds ~12 assets twice), spot preferred,
**exposure-matched** (`benchmarkPnl = avgGrossExposure × basketReturn` — an unmatched full-notional
basket flatters a ~50%-exposed strategy in a drawdown exactly as much as it punishes it in a rally).

**The price source was the load-bearing redirect.** A first attempt STOPPED correctly, reporting that
production could not supply a historical price at an arbitrary past instant and proposing to widen
`FeedHealthPort.fetchCandles` with a `since` param plus touch the ccxt adapter. That was not necessary:
**`agent_decisions.close` is already a dense 15m grid** that `loop-forward-return-core` validates with
five cited reasons, so the whole thing lands with no port change, no ccxt work and no new schema.
Verified independently at the orchestrator AND in the adapter: **40/40 symbols ⇒ 28/28 distinct assets
have a usable price at BOTH window ends, 100%.** The clause blocks on evidence, never on a data gap.

**FAILS CLOSED, and where matters.** The service's existing contract reads a `null` from a bound port
as "measurement gap, drop the clause" — fail OPEN — and that test predates this work and lives in
mode-control, which the 2026-07-22 grant's KEPT set forbids re-wording. So fail-closed lives entirely in
the **adapter**: every data problem returns an `Infinity` sentinel rather than `null`, and
`netPnl.lte(Infinity)` blocks unconditionally; one missing asset voids the whole basket. `reasons` is
push-only and tests pin both directions, so it **can never manufacture a permit**.

**Honest caveat:** testnet fills span ~8.6 days against `MIN_WINDOW_DAYS=14`, so `INSUFFICIENT_WINDOW`
is already the binding blocker and this clause is not yet exercised end-to-end. That is a window
shortfall, not a price shortfall — price coverage is already complete.

**With G4 and G5 both bound, the adopted criteria are fully instrumented** — no clause is decorative.

### The soak produced a NEW FINDING, and it is the worst one on the board

Deployed `682b6f6` (boot `cdc2da19`, healthy, RestartCount 0). `agentic_promotion_blocked` reads for
the first time — the gate's binding clauses are visible instead of hand-inferred, which is precisely
what § 9 asked for:

```text
NON_POSITIVE_NET_PNL     1      INSUFFICIENT_WINDOW      1
BELOW_PASSIVE_BENCHMARK  1      (five others)            0   ← all 8 present, zero-seeded
```

**`BELOW_PASSIVE_BENCHMARK = 1` was ambiguous on arrival and was disambiguated before being recorded**
— a fired clause could equally have been the `Infinity` fail-closed sentinel tripping on a data
problem, which would be an instrument reading, not evidence. It is evidence. The equal-weight 28-asset
basket returned **−2.175%** over the evidence window (worst −11.15%, best +17.19%), so the benchmark
PnL is a small negative: ≈ −$11 at ~50% exposure, ≈ −$22 at full notional, ≈ −$44 even at 2× the book.
Against `netPnl = −$48.54`, **the lane underperforms passive at every plausible exposure.**

Stated plainly, because it is the sharpest single number this program has produced: **the lane lost
~4.9% of the book over a window in which simply holding the same basket at matched exposure would have
lost ~2.2%.** Roughly **$37 of the $48.54 loss is not market beta — it is the strategy.** Every prior
measurement compared the lane against ZERO; this is the first against OPPORTUNITY COST, and it is
worse. It also independently corroborates the horizon finding above from a completely different
direction: both say the entries are not merely unprofitable but actively value-destroying.

### Gate

format/lint/lint:md/typecheck green · **3433 tests / 185 files** · livegate **55/55** · build clean.
No deploy: nothing shipped changes runtime behaviour (the benchmark only adds a blocking reason to a
gate already returning `permitted: false`).

---

## 2026-08-01 — Pass 56 (the reconciler halted the book over an order it had cancelled itself)

**Window:** 2026-08-01T00:07Z → 08:05Z. Lease `744d853ec7a088c4` taken 00:07:22Z — **it EXPIRED
mid-pass** (2h, time-based) across a ~5h host sleep; re-taken as `3869d9bfd9feb8a2` at 07:04:37Z.
**COLLISION #5:** Pass 55 ran 06:15–07:01Z inside that gap and landed four commits on `main`. Zero
file overlap with this pass's ten (verified `git diff --name-only 01f207c..HEAD` against my set), so
nothing was clobbered in either direction — but Pass 55 also took the number 55, which is why this
entry is 56. Pass 55 saw the uncommitted tree and logged it as COLLISION #5 from its side.

**Pass type:** DEFECT INVESTIGATION, forced by §3. The sweep's _alarm_ list was clean of it; the
incident arrived as two `prometheus_alert_resolved_critical` **annotations** — `KillSwitchEngaged` and
`ReconciliationHalt`, both fired and resolved inside the 12h lookback. That annotation kind (added
Pass 45) is the only reason this was seen at all.

**Book at 08:00Z:** 40 closed round trips, net-of-cost **−$48.60**, LLM $22.096, window 8.47/14 days,
win rate 25.0%, `promotion_ready` 0, `equity_usdt` 4974.96, kill switch RUNNING, budget $2.258/$3.
Four mandatory checks green all pass. WATCH-V3-1: RSS well under the ~900 MiB bound.

### The headline — a 65-second halt nobody would have seen

At **17:30:59.911Z** on 2026-07-31 the kill switch engaged on
`RECONCILE_MISMATCH:UNKNOWN_OURS_OPEN`, drained open orders, and auto-resumed 65s later. The
offending order was a BTC LIMIT **the strategy itself had cancelled at 17:30:32.611 — terminal at the
venue 27.3 seconds before the halt fired.**

`reconcileOpenOrders` accumulates venue truth incrementally inside a per-symbol `await` loop but reads
its local comparand **once, after** the loop. An order resting at the venue when its symbol was
fetched that goes terminal locally before the loop ends reads as "our prefix, present at venue, absent
locally" ⇒ unconditional HALT. That window was **44,940 ms** here against **15,769–16,365 ms** on every
neighbouring pass, because the strategy was concurrently cancelling on the shared rate-limited client.
binanceusdm sweeps `BTC/USDT:USDT` first, so the widest window landed on the cancelled order.

The KAITO cancel is a **consequence**, not the cause: `order_events` payload reason `HALT`, ts
17:31:00.246 > engage 17:30:59.911, and the drain iterates exactly the set the offending order was
defined by being absent from.

**It was also unreconstructible.** `UNKNOWN_OURS_OPEN` was the only halting class in the file pushing
no discriminator into `acc.halts`, so `reconciliations.detail` recorded the bare string with no order
id. A whole-boot grep for `UNKNOWN_OURS` returns five lines, none naming the coid (positive control:
1302 `reconcile.pass` matches in the same file).

**Nothing was lost.** No money moved wrongly, no position went naked, venue state matched the local
book byte-for-byte, and both BTC orders carry complete terminal event chains.

### Shipped — three commits, gates green, deployed

`13407c4` **`loop:authoring` could never read the key it required.** It loaded only `.env.app`, which
by the standing config rule holds no secrets; `ANTHROPIC_API_KEY` is in the gitignored `.env`. That is
why `playbook-authoring-attempt` had **zero rows lifetime** — the cause STATUS attributed to the
`633f901` registry gate. Verified empirically on node v24.4.1 that a later `--env-file-if-exists`
overrides an earlier one and a real env var still overrides both.

`b54aae7` **the drafting call sent a parameter the model no longer accepts.** Both calls returned
HTTP 400 `"temperature is deprecated for this model"` — sampling params are removed on
claude-sonnet-5. Isolated with a positive control (same request minus `temperature` ⇒ 200), so the
account/key/model were never the problem. The 0.2/0.8 spread moved into the prompt as an explicit
per-variant stance; **verified live** against the real 15.8k-char prompt: both stances return 200,
`stop_reason=tool_use`, complete blocks (2904 and 3232 chars), materially different drafts. Failed
calls now log the response BODY — discarding it is what made this cost a day's slot to diagnose.

`62f9738` **the reconciler fix.** A second resolution tier before halting (order book, then a
venue-scoped durable read), mirroring the fill axis's existing precedent. Durably terminal ⇒ new
`stale_venue_open`, no halt; durably NON-terminal ⇒ still halts (the genuine-corruption shape).
Miss / wrong-venue / throw all fall through to the halt. `stale_venue_open` is deliberately NOT
non-actionable, so it still withholds the clean stamp, and it **escalates per-coid** — streak keyed
`venue|coid`, reset when the coid leaves that venue's open list, halt past `driftPasses`. A race
cannot survive a second independent venue read; a genuine orphan always will. Halt string now carries
the coid.

**The review earned its place.** It found three real defects in the first implementation: the class
had no escalation at all (turning a permanent orphan into a permanently _silent_ one); the declared
FAIL CLOSED did not match the code (`venueForSymbol` outside the `try` — one unparseable symbol would
have killed the whole pass with the kill switch never engaged, i.e. fail OPEN); and `test:cov` was red
on the durable tier's own branch, the single reason that tier exists.

**Gates (run by the orchestrator, not self-reported):** format ✓ lint ✓ lint:md ✓ typecheck ✓ build ✓
`test` **185 files / 3444 tests** incl. sacred `test:livegate` ✓. `test:cov`: execution glob 100% on
all four metrics. **Deploy:** `62f9738`, `build_info{git_sha}` confirmed, bootId `3f93c971`,
StartedAt 07:54:53Z, RestartCount 0, healthy, 23 rules loaded / 0 firing, fatal=0 error=0 this boot.
Prometheus force-recreated (alerts.rules.yml changed); rules validated by copy-in first, per the §5.3
dangling-inode trap. **Soak: clean, no new alarm.**

### The authoring slot — the gate fired correctly for the first time in program history

`ONCE-PER-UTC-DAY: SLOT_OPEN` → claimed `public.experiments` **id=16**
(`family=playbook-authoring-attempt`), the **first such row ever written**. So Pass 52's registry gate
`633f901` is now **VERIFIED**. The run then died on the 400 above, so **today's slot is SPENT with
zero variants** — the env check correctly sits _before_ the day gate, but the drafting call does not,
so an API-shape failure burns the day. `WATCH-DEPLOY-HALVES-1` stays at SAMPLE ZERO until 2026-08-02.

### Four more findings, root-caused and NOT shipped — each names its blocker

Full text, evidence and proposed diffs: `incidents/2026-08-01-spurious-unknown-ours-halt.md`.

1. **The clean stamp credits zero observation as "clean."** The auto-resume gate itself is _correct_
   (nine conditions, no timer; the 17:32:04 resume was genuinely earned). One layer down,
   `sweep_failure` sits in `NON_ACTIONABLE_CLASSES`, so a pass where _every_ symbol's fetch throws
   stamps CLEAN off zero observation — 93,738 such increments over 39h on 2026-07-27, so this is a
   demonstrated shape. **Blocker:** the pre-Task-C3 rule that this would partially restore left the
   bot wedged 39h; needs its own pass and soak.
2. **A frozen order leaves every escalation surface, permanently.** Two brief premises were wrong and
   the investigation corrected them: `order_events` has **five** rows, so the order was
   `CANCEL_UNKNOWN` for only **6.26 s** and the 60 s watchdog was never _eligible_ (it did not fail);
   and the stuck order is the **take-profit**, not the stop — the algo-rail stop is present, so hard
   rule 5 was not violated and the position was never unprotected. **Blocker:** the escalation shipped
   alone would permanently wedge auto-resume, because `RECONCILE_REQUIRED` is in the unresolved set
   and the state has no exit arm. Must ship with the state-model fix.
3. **The algo/stop rail has no reconciliation consumer at all** (defect class 4). The DB→venue leg
   exists but sources `portfolio.snapshot().openOrders`, which algo orders are never registered into.
   **And there is NO stop stacking** — a keyed live probe returns exactly two open algo orders, both
   `reduceOnly`; the other four are `TRIGGERING` with empty `actualOrderId`, and venue positions match
   the local book exactly. The "39 units of stop on a 13-unit position" was a stale-row artifact, not
   exposure. `TRIGGERING` is unmapped in `ccxt-normalize.ts` (#54 pattern). **Blocker:** the safe part
   retires nothing; the part that clears the rows can book a phantom position.
4. **`balances_checked = -1` means the axis never ran** — so `balance_drift`/`balance_leak` zeros are
   meaningless zeros, seeded by the 2026-07-29 void-read fix and unreachable since. **Blocker:** none;
   measurement-only, deferred so the availability predicate is derived from the same source
   `reconcileOnce` uses rather than a second one.

### The through-line worth carrying forward

Three of the five are the same shape: **a surface reporting health it never established** — a clean
stamp written off an unobserved axis, a zeroed counter for an axis that never ran, an order rail with
no consumer. The 2026-07-29 fix taught the _sweep_ to distrust an empty read; the _reconciler_ has not
learned it about its own axes. That is a bigger lever than any single one of the four repairs.

### Flagged

- **A fifth concurrent-pass collision**, first one where both passes did substantive work in the same
  tree. The 2h time-based lease cannot survive this host's sleep cycle; a pass that sleeps loses its
  lease and its number. Scheduler co-firing is owner-owned.
- **Pre-existing coverage red, NOT this pass's:** `src/domain/trading/risk/gross-exposure.ts:74-80`,
  branches 85.71% against a 100% threshold — arrived with Pass 55's `682b6f6`/`6dcb45f`. `pnpm test`
  is green (it omits `--coverage`; backlog 56), so no gate blocks, but `test:cov` is red on `main`.

## 2026-08-03 — Pass 57 (four recorded findings were wrong, and one of them was blocking the falsification test)

**Window:** 2026-08-03T06:43Z → 08:05Z. **No lease taken** — owner-directed session, not a scheduled
pass. Lane collisions were prevented by scope declaration instead (the mechanism this pass shipped),
with the orchestrator holding all four loop files as single-writer. Four sweeps ran inside the window
(07:19:53Z, 07:20:02Z, 07:53:32Z, 07:54:27Z), all from lanes verifying their own instruments.

**Owner-directed session, not a scheduled pass.** A 15-step plan, executed by nine parallel lanes over
disjoint file scopes. Full gate green. **The through-line is not what shipped — it is how much of the
record turned out to be unfalsifiable or simply wrong**, and that four of the corrections came from
agents refusing a premise the orchestrator handed down as established.

### Four recorded claims refuted by measurement

1. **THE CORPUS NEVER DRIFTED, AND FAMILY B WAS NEVER BLOCKED BY IT.** `corpusManifest`'s separator is
   a genuine **NUL byte**; `corpus-fingerprint-drift-2026-07-31.md` typed a **space** into its own
   reimplementation and attributed the resulting mismatch to unpinned row order among `event_time`
   ties. Measured four ways: NUL + file order = `f1dd13c6…` (**= the recorded design pin**), space +
   file order = `030367ba…` (**= that study's claimed "on-disk" value**), and the
   `(eventTime, id-numeric)` tie-break is a **no-op**. Its whole § 2.6 reordering table is the same
   artifact. `assertDesignMatchesCorpus` verified **not throwing**. **Transferable lesson: a
   reimplementation of a hash function is a second source of truth — import it, or do not compute it.**
2. **THE DUPLICATED CANDLE WAS A PARTIAL BAR STAMPED CLOSED.** `feed-health.service.ts:224` marked
   **every** backfilled bar `closed: true`, most-recent included, and its own comment admitted the live
   feed re-emits that bar's close. One duplicate, consistently, every boot, with differing OHLCV. The
   justification cited the **retired** EMA-cross lane ("washed out by the bounded indicator window") —
   for the surviving LLM lane nothing washes out; it lands in the prompt. Two competing hypotheses were
   refuted first (stream redelivery cannot be _consistent_; re-init is unreachable **and** structurally
   impossible — `initStrategy` allocates a fresh Map).
3. **THE CLUSTER FLOOR COUNTED VENUES, NOT ASSETS.** `MIN_CLUSTERS=5` was satisfiable by **three**
   independent assets — 40 symbol strings are only **28 bases**, and same-base cross-venue pairs
   correlate 0.9993–0.9999 at h=24. Fixed. **The re-read is an honest null: no POWERED cell flips**, and
   v10 — the arm `WATCH-PLAYBOOK-V10-1` watches — is byte-identical. A forward guarantee, not a
   retroactive correction. It does make the promotion bar **harder** than recorded.
4. **DEMO/LIVE DECOUPLING FLATTERS THE BOOK.** Backlog 57 closed with a number: artifact **+21.0
   bps/trip**, CI **[+1.4, +39.8]**, n=38 of 46. Correcting for it makes the book **worse** (demo −70.3
   vs live −91.2), so decoupling cannot be what makes the numbers negative. KAITO reproduces (+609.2 vs
   +611); **TRUMP does not** (−11.0 vs −207) and is recorded as an unresolved contradiction.

### Three surfaces reporting health they never established

`fee_resolved` (two write sites, **zero readers**) and the `fee_ledger` table (**zero writers** — the
same-named service is an in-memory Map) are vestigial; two comments asserting consumers that do not
exist were corrected. `config_snapshots` has **zero rows and zero writers** — found because the new W3
invariant alarms on it truthfully rather than being tuned away. This is the same shape as Pass 56's
through-line, now three times over.

### What shipped

Promotion evidence as **one atomic tuple** from a single `evaluate()` sample — voids whole, never
partial — which closes the window/count discrepancy structurally (it was a **transcription desync**, not
a code defect). **Five DB integrity invariants** failing CLOSED, the load-bearing one being W1: `fills`
carries **no append-only trigger** (the 0001 hardening covers five tables and not that one), and
prefix-determinism is what the whole walk rests on. **Fan-out becomes a declared capability** —
`loop:fanout declare` refuses lane collisions and an `ORCHESTRATOR_OWNED` reserved set, failing CLOSED,
deliberately opposite `loop:lock`'s fail-open; plus playbook §4.6. And the **standing out-of-sample
session arm**: pre-registered, decide leg with a **passing** \$0-egress proof, and a score leg that fails
OPEN.

### Two things deliberately NOT done

**The ~\$22 Family B paid run.** Its blocker is refuted and the account can spend, but the paid block is
atomic — it cannot be probed without committing the spend. Surfaced as an owner go/no-go rather than
triggered as a side effect of a hash fix. **It is the deployment's own falsification test.**

**The `entryVwap` short-side fix.** `round-trips.ts` builds it BUY-side unconditionally, so on a SHORT
trip it is the **cover** price (TRUMP: 16 SELL @1.561 entering, one BUY @1.593 covering, `entryVwap` =
1.593). That biases Arm2/Arm3 anchoring in `edge-verdict-2026-08-10.md`, **whose verdict lands in days**,
and may explain TRUMP's non-reproduction above. It needs a dated review and a pre-registration
amendment — never a silent edit to a frozen study.

### Method note

Nine lanes, disjoint scopes, orchestrator holding all four loop files as single-writer. **Agents
corrected the orchestrator on: the corpus premise, the `13.29%` entry-rate baseline (not in the repo at
all), `N_BOOT` (20,000, not the 5,000 two records name), the cluster-count arithmetic (1,461, not
1,288), the `sqrt(k/24)` leak claim (fails at k=23), the live feed-flag count (10 of 13, not 9), and
what a FAIL in the session arm actually supports** — it is a ceiling probe on payload information, and
the charter-mandated decide-model instrument is `candidate-model-eval.spec.ts`, not this. Two lanes
stopped mid-task on a statement of intent and were resumed. One lane tried `allowJs` to fix a `.mjs`
import, found it broke typecheck project-wide, and **reverted it** rather than leaving a config landmine.
Also relearned the hard way: **a full gate run mid-fan-out measures your peers, not you** — which §4.6
now says out loud.

## 2026-08-03 — Pass 58 (a table that never had a writer, and a repair withdrawn at the last gate)

**Window:** 2026-08-03T06:41Z → 09:50Z. Lease `06e93e2925ed1e27`, taken 06:41:43Z — it BROKE a
stale lease **2,796 min (46.6h) old**: Pass 56 took a lease on 08-01 and never released it.

### COLLISION #6 — an owner-directed session ran inside this pass's lease and took its number

A full interactive session ran **06:43Z → 08:05Z**, entirely inside a lease this pass already held,
and committed eleven commits (`dbb3051`..`355eab1`) plus the `Pass 57` LOG entry. Its own entry says
why the lock did not stop it: _"No lease taken — owner-directed session, not a scheduled pass."_ The
lease binds only callers, so this is not a lock defect — it is the fifth demonstration that the lock
cannot bind what does not call it, and the **sixth** concurrent-pass occurrence overall.

**No work was lost and no file was contended.** That session's commits all landed 08:04–08:11Z,
before this pass made its first edit, and this pass re-verified the tip immediately before staging.
This pass is numbered **58**; `57` is spent. One live consequence worth keeping: the dirty tree at
06:41Z (`gross-exposure.ts` + spec) was that session's in-flight work, and staging `-A` would have
committed it. Staging only files this pass authored is what prevented it — the rule earned its keep.

### The pass type was chosen by the §3 gate, not by preference

`loop:sweep` fired **two** alarms. One (`venue_reject_rate_high [binance]`) is the known frozen
window. The other, `config_snapshot_missing`, was **new, unclaimed, and named by the session that had
just ended without fixing it** — its own entry records `config_snapshots` as having "zero rows and
zero writers". §3 makes that a defect investigation, and it was.

### What was actually wrong: the table never had a writer, and the number it guards had no provenance

`ConfigSnapshotRepository.upsert()` shipped in the **initial commit, 2026-06-14**, bound at
`CONFIG_SNAPSHOT_REPO`, and has never been called by anything. Eleven independent searches over
`src/` return no `.upsert(` call site; `git log -S 'configSnapshots'` returns exactly one commit;
the live table read 0 against `agent_decisions` at 41,752 as a positive control. Not a lost writer —
**a writer that was specified in the design plan and never built.**

That matters because `PROMOTION_EVIDENCE_EPOCH` and `PROMOTION_DUST_NOTIONAL` jointly define what
counts as a closed round trip and which fills sit in the evidence window. The whole earned-live gate
is computed from them, and there was **no record that the scoreboard's numbers were produced under
the knobs they are compared against** — a redeploy with an edited `.env.app` rewrote history
invisibly.

Two design calls, both made because the obvious version was wrong:

- **Payload = the full canonical `AppConfig`, not a two-knob projection.** The `hash` PK is computed
  over the whole canonical object, so a projection makes the row's own key unverifiable against its
  content. It is built through the same `canonicalObjectWithoutSecrets` the hash uses, so the row is
  self-verifying.
- **`onConflictDoNothing` → `onConflictDoUpdate` bumping `activatedAt`.** The reader picks by
  `order by activated_at desc limit 1`; under do-nothing, a config A→B→A leaves A stamped at its
  first activation and the reader returns **B, which is not running** — a false drift alarm on a
  correct config. First-activation time is deliberately traded for current-activation correctness.

Review caught two more before they shipped: the payload carried `bootId`/`gitSha`, which the hash
excludes, so a PK collision would have frozen the first boot's identity against a fresh
`activated_at`; and an unset `PROMOTION_EVIDENCE_EPOCH` — a documented, supported "all-time"
configuration — would have dropped the key and wedged the reader on a permanently unknown shape.

**Verified in production, not just in tests.** First row ever: `hash 3a12218…`, `mode testnet`,
`activated_at 2026-08-03T09:37:08Z`, `promotionDustNotional 5`, `promotionEvidenceEpoch
2026-07-21T11:21:00Z`, `config ? 'db'` **false**, `app ? 'bootId'` **false**, `app ? 'gitSha'`
**false**. The alarm cleared, and neither `config_snapshot_drift` nor `config_snapshot_shape_unknown`
replaced it — the writer and the reader agree end to end.

### Three surfaces were asserting things they had never established

The through-line of Passes 56 and 57 held for a third pass, and this time one of them was ours.

1. **The alarm's own diagnosis would have misdirected the operator it summoned.** Its text said
   `upsert()` "is bound … but never invoked … so no snapshot has ever been written". True when
   written; false from this pass on. Left alone it would have told whoever it woke to **build a
   writer that already exists**. Corrected to name the real post-fix diagnosis (fail-open writer ⇒
   zero rows means the write failed this boot ⇒ read the app log). The old wording turned out to be
   load-bearing in four spec files that asserted against it.
2. **The harness monitor lied about a third of its own set.** `MONITORED_HARNESSES` claimed all three
   monitored suites are "deliberately OFF the production gate". `pnpm test` is
   `vitest run test/features …`, and `test/features/strategy/loop-sweep` is matched by that
   positional — `loop-sweep-specs` is **on** the gate. Gate membership is now a per-harness fact.
3. **The playbook triaged against 8 of 22 alarm kinds.** §3 listed 8; the code pushes 22 across 38
   push sites — 12 added the same day by `1f68d6f`, 2 undocumented since 07-31. **64% of the alarms a
   pass can meet were missing from the list it is told to triage against**, in a document carrying its
   own verify-before-cite rule. Four thresholds were also wrong or incomplete (the
   `budget_gauge_uninitialised` carve-out, the clean-stamp zero-gauge fallback, `restart_storm`'s
   `> 1`, and the fourth stale citation on the `probe_failed` paragraph).

### A repair that was written, reviewed, and then withdrawn — the dust pin leak

**Found and measured:** four spot dust positions permanently hold consult-menu slots —
`AAVE/USDT` ($0.06, stuck **9.3 days**), `SOL/USDT` ($0.04), `ZEC/USDT` ($0.35), `BTC/USDT` ($0.49).
The money path uses **two different definitions of flat**: the fill path closes a round trip
economically at `dustNotional`, the pin predicate tests exact zero. Sub-`stepSize` residue is below
any venue `minNotional`, so **the pin is permanent by construction**. Cost **≈$0.33/day — 11% of the
$3/day breaker** — for 148 consults over 4 days that produced **148 `hold`s and nothing else**.

**Not shipped, and this is a blocked state, not a scheduling choice.** Both canonical dust sites
carry a _"the position was once real"_ guard — `portfolio-state.service.ts`'s `reduced`, and
`round-trips.ts`'s `peakNotional.gte(dustNotional)`, the latter added after a measured BCH/USDT
defect. The first draft dropped it, which would have unpinned **a position being built** (an opening
fill still under the threshold) — precisely the input those guards exist to reject. No signal at that
seam can reconstruct it: `Position` carries only `signedQty`/`avgEntry`/`realizedPnl`, and
`PortfolioViewPort` is a point-in-time read. The blocker is specific: persisting a high-water mark is
a **money-table schema change (report-only, not loop-domain)**, and an in-memory one resets on
restart, so it would never release positions stuck for days _across_ restarts. The sound route is a
durable round-trip-cycle reader — **new capability, not a repair**. The unwired helper was deleted
rather than left exported, so nothing advertises a capability that is not connected.

**One genuine fix did survive from that work**, and it is independent of dust: an **in-flight entry
intent could lose its consult mid-entry**. If the daily recompute lands after an intent is submitted
but before it produces a position or open-order row, the symbol is unpinned, and with
`AGENTIC_PORTFOLIO_CONSULT=true` every off-menu symbol gets a hard `off_menu` hold — for the rest of
the UTC day, since `isPinned` is only evaluated inside `recompute()`. Pre-existing; now pinned.
Protective exits were never at risk (`ProtectiveExitService` runs on its own tick and `runActivePlan`
precedes the consult gate) — the LLM consult genuinely was.

### The spot lane: a strong claim, verified, and the load-bearing half refuted

Investigated because STATUS asserts the binance reject alarm _"resolves on the first real spot
entry"_. That clearing path is unreachable: **zero binance submits for 3d 7h**, zero spot entries
since 2026-07-30T10:30Z, and 7 spot entries lifetime against 189 reduce-only exit legs. The alarm
will not clear by accumulation — it will **age out at ~2026-08-07T01:45Z** into the
`venue_reject_rate_undetermined` annotation, which is silence, not health.

The proposed mechanism — that `residual20-volbeta` builds its cohort from perps only, so spot gets
`sideEligibility {long:false, short:false}` and can never enter — is **half right and was refuted on
the half that mattered**. `sideEligibility` has exactly one consumer, which copies it into the
prompt; Risk has no awareness of it. **It is prompt payload, not a code gate**, and the model has
entered against it: two spot entries on 07-30 with both flags false, and 3 of 15 perp entries since
07-31. What survives is severe _emergent_ suppression — 191 spot consults → 0 entries where the perp
rate predicts ~7.7, P(0) ≈ 3.8e-4 — and it is **confounded with v10 `inverted`**, live from
2026-07-30T16:57Z with no control arm.

**Deliberately not acted on.** `verdicts.md` § entry signal is binding: _"Do not propose cost work as
a profitability lever."_ Five spot symbols currently cost $0.53–1.00/day, but that framing is
forbidden and the confound is real. Recorded as backlog work justified on **expectancy** — spot
realized PnL is **−$8.01 over its 7 lifetime entries** — not on cost.

### `llm_usage` looked like a lost writer and is not one

69 rows, nothing since 2026-07-27, while the lane bills daily. **Vestigial by design:** its only
writer was `reflection.service.ts`, deleted deliberately in `9a63edf`; writes stopped three days
earlier because `bf06d26` fixed a re-arm bug and the weekly trigger correctly stopped firing.
**The promotion cost figure is CORRECT** — `PromotionStatsRepository.tokenTotals` UNIONs
`agent_decisions` (verified populated daily) with the reflection rows; spend that never happened
cannot be missing. The rows are **not** dropped: they sit inside the epoch and are re-priced every
gate run, so deleting them would understate cost and loosen a permission gate. Three comments naming
the deleted service were corrected — they are what sends an investigator hunting a writer.

### Headline metrics — the bleed is on trend

| | Pass 56 (08-01T08:00Z) | Pass 58 (08-03T09:45Z) | Δ |
| --- | --- | --- | --- |
| closed round trips | 40 | 46 | +6 |
| net-of-cost PnL | −$48.60 | **−$59.93** | **−$11.33** |
| LLM cost | $22.096 | $26.965 | +$4.87 |
| window | 8.47 / 14 d | 9.92 / 14 d | +1.45 |
| win rate | 25.0% | 23.9% | −1.1pp |

**−$5.6/day**, tracking the recorded −$5.73/day almost exactly. `agentic_promotion_blocked` names
three live reasons: `NON_POSITIVE_NET_PNL`, `INSUFFICIENT_WINDOW`, `BELOW_PASSIVE_BENCHMARK`.
`equity_usdt` 4969, kill switch RUNNING, `promotion_ready` 0. **S3's −$200 trigger still lands
~2026-08-27**, before the 08-31 close. WATCH-V3-1: RSS holds, no climb toward the ~900MiB signal.

### Diff, gates, soak

`118132c` config-snapshot writer · `6149861` sweep reader + alarm/harness honesty · `7e1306c`
playbook §3 inventory · `548376c` in-flight-intent pin · `9082f89` `llm_usage` comment corrections.

Gates all green on the combined tree: `format:check`, `lint:md`, `typecheck`, `lint`, `build`,
`test` **192 files / 3595 tests** (baseline 189/3572, so +23 tests), `test:livegate` **55/55**
(untouched), `eval:agentic` 95. `loop:harness` 3/3 PASS — all three harnesses had been **STALE 68.4h**
at pass start and are now `harness_ok`.

Deployed `9082f89`, boot 09:37:08Z, `build_info` matches the tip. **Soak: alarms 2 → 1**,
`config_snapshot_missing` cleared and not replaced by a drift or shape alarm, health 200/200,
`RestartCount` 0, reconcile clean stamp 1.2 min, decides flowing. The one remaining alarm is the
known frozen binance window.

An honest artifact of this pass: the single `error` log line on the 08:27Z boot was
`Cannot GET /health` — **this pass's own bad probe** (the endpoints are `/health/live` and
`/health/ready`), not a stack defect.

### Flagged / next

1. **The dust pin leak is a blocked defect**, not backlog — ≈$0.33/day, root-caused, measured, with
   the exact missing signal named above. First item for the next pass.
2. **Six concurrent-pass occurrences.** The lease cannot bind sessions that do not call it; scheduler
   and session co-firing remains owner-owned.
3. **Pass 56 never released its lease** (46.6h stale). A pass that ends without `loop:unlock` leaves
   the next one to break it — which fails open by design, but the break is the only signal.
4. Spot-lane suppression → backlog, expectancy-framed, confounded with v10 until that is controlled.
5. `charter.md` says the cost breaker is $5/day; `.env.app:97` deploys `3`. Unreconciled drift.

## 2026-08-03 — Pass 59 (three surfaces asserted things they had never established, and one of them was the watch)

**Window:** 2026-08-03T16:07Z → 17:15Z. Lease `3eabb3a04009f7d6`, taken 16:07:38Z, no collision —
tip re-verified `a23141a` immediately before staging and it had not moved.

### The pass type was forced by §3, and the alarm was not the reason

`loop:sweep` fired **one** alarm, the known frozen `venue_reject_rate_high [binance]` window. It was
re-verified rather than assumed — newest binance submit **2026-07-31T01:45:02Z**, all 16 rejects one
`ZEC/USDT SELL LIMIT 0.167` retried half-hourly — and then left alone per Pass 58's ruling.

What made this a defect pass was the **annotations**, which is exactly what Pass 45 added them for.
Three separate incidents were sitting in them, none of which the alarm list could show.

### The 40-minute sweep failure that happened inside the previous pass's own window

Nine `binanceusdm` MISMATCH rows, `sweep_failure:1..3`, **06:44:42Z → 06:55:43Z** on boot `3f93c971`,
escalating to `ReconciliationSweepFailureSustained` **07:00Z → 07:25Z** (26 samples). Pass 58 ran
06:41Z → 09:50Z and never named it.

**Root-caused: the `trades` axis failed on 13 of 192 symbol-sweeps (~7%) against a healthy venue.**
`reconciliation_axis_error_total{axis=trades}` did not exist before 06:44:42 and reached exactly 13 —
matching the 13 mismatches — while `{axis=openOrders}` stayed flat at 1 and `{axis=positions}` at 0.
AUTH_FATAL is positively ruled out: `key_check` succeeded every 60s straight through the window.
**Nothing was masked**: the open-orders and positions axes completed on all nine passes, so the
halting classes were checked throughout, and the trade checkpoint is advanced only inside the trades
loop, so a failed sweep re-issues from the identical `since`. `MISMATCH` (not HALT, not ERROR) and
`warning` are all correct — an unmade measurement is not a proven divergence, and a measurement gate
fails OPEN by design.

**The real defect was that it was almost undiagnosable.** `errorClassName` returned
`err.constructor.name`, but every ccxt sweep call rethrows `toAdapterError(e)`, so the label was
ALWAYS the literal `AdapterError` — Prometheus `/label/error_class/values` returns exactly
`["AdapterError","none"]` across full retention. The unit test **concealed** it: `FakeVenueTimeout
extends Error` exercised a branch production cannot reach. The WARN's durable shadow was eaten too —
`MAX_EVENT_KEYS = 60` was fully consumed, 50 of them by four per-symbol families, so the trades key
folded into `other`. Fixed in `88a43b3`; the specific ccxt error for THIS burst is permanently
unrecoverable and no retrospective read can settle it.

### A first-ever `position_drift` — benign, and correctly non-halting

`KAITO/USDT:USDT`, local 0 vs venue **−91.3** (~$89.90), 11:46:46.911Z. A pure in-flight race: the
venue filled all 91.3 in five trades at 11:46:41.5–42.8, the reconciler compared at :46.9, and the
demo fill poller folded at :52.5 — 5.6s later. Local converged to `-91.3@0.9847`, cash +89.89, next
pass CLEAN. Not halting is **deliberate**: a `streak >= 2` debounce shipped in `1ff1fc7` on
2026-07-17, ten days before the last recorded halt, and is test-pinned three ways. **No regression.**

**But `watches.md` was wrong about halts, and Pass 59 corrected it.** That file states all 1,727
recorded HALTs came from `POSITION_DRIFT`, `UNKNOWN_OURS_OPEN` or `FILL_FOR_UNKNOWN_ORDER`. Over
`audit_log`'s full retained range (07-21 → 08-03, 32,579 rows) **all 18 `RECONCILE_MISMATCH`
transitions carry `UNKNOWN_OURS_OPEN`. Zero of the other two.** Positive control: the same predicate
returns those 18. **`POSITION_DRIFT` has never halted this system in retained history.**

**And the diagnostic gap was real**: because the debounce makes the first pass the ONLY record
whenever a drift self-heals — the common case — that record carried no symbol and no quantities. This
incident survived only in a container log that dies on redeploy. Fixed in `88a43b3`.

### The perp trades axis is dead, and that is a BLOCKED defect

**VERIFIED, twice, with positive controls.** Over 13h: `binanceusdm` `sum(trades_checked)` = **0**
across 777 passes; `binance` = **6,356** across 778. Corroborating: **zero `FILL_FOR_UNKNOWN_ORDER`**
halts in 32,579 `audit_log` rows — that detector cannot fire on a venue whose trades axis never
returns a trade.

**Consequence: the reconciler's fill-backfill and its `FILL_FOR_UNKNOWN_ORDER` corruption detector
are inert on the venue holding every current position.** This also **refutes one line** of the
sweep-failure finding above: trade-axis detectors were not merely _delayed_ by the burst, they are
permanently dead on perp, so "re-swept from the preserved checkpoint" recovers nothing there.

Leading hypothesis, **explicitly unproven**: the checkpoint seeds to `0`, advances only inside the
trades loop, and Binance USD-M `fapi/v1/userTrades` constrains startTime to a 7-day window (empty at
`startTime=0`) while spot `api/v3/myTrades` does not — matching the venue split exactly. The demo
fill poller calls the same adapter method and succeeds, differing only in passing a real timestamp.

**Why this is BLOCKED and not deferred by choice:** proving it needs the #54 keyed live-venue probe
(in-container, app credentials), and the fix **reactivates a dormant halting detector** on the live
money path — 13h of unobserved perp trades could halt the book on first activation. That is a
two-step observation-only enable, not a repair. **First item for the next pass.**

### A $0.61/day leak that has been running since 2026-07-23

Eight `submit_portfolio payload failed schema validation … payload: {}` warns this boot. **Output-budget
truncation, not malformed model output**: the lane sends `thinking:{type:'adaptive'}` on every call
and no `output_config`, so it runs at API default effort `high`, spends the entire 4096-token budget
on thinking, and the API closes the `tool_use` block with no JSON. Bimodal and unambiguous —
successful decides p50 **288** / max **1548** output tokens, every failure pinned at exactly **4096**.

Cost **$0.6148/day — 20.5% of the breaker, 30.2% of actual decide spend — and ~11 symbol-decides
lost/day**, all fully paid for and discarded. The pricing model was validated against the live
breaker to five decimals ($3.00 − $2.03466 = $0.96534, the gauge read `0.9653394`).

The _handling_ is exemplary — correct `truncated_max_tokens:` tag, two metrics, full journal coverage,
excluded from real-decide liveness. **Correctly named is not acceptable.** Fixed in `ea68379`,
FLAG-OFF. **Both obvious fixes were refuted before shipping:** `thinking.budget_tokens` is not a field
of `type:'adaptive'` and `'enabled'` is unavailable on `claude-sonnet-5` (would 400), and raising
`AGENTIC_MAX_TOKENS` is refuted by WATCH-V4-12. `output_config:{effort}` is **GA on sonnet-5, no beta
header** — so the enable commit needs no probe for that question.

### WATCH-PLAYBOOK-V10-1 fired powered — and is UNADJUDICABLE AS WRITTEN

n=21, clusters=8, `flat_only` identical, gap=0. **The expected-positive sets a LIVE cell against a
REPLAY cell**, confounding four axes that do not decompose: v10-vs-v8, live-vs-replay, disjoint windows
(replay 07-21→27, basket −438.4 bps; live 07-30→08-03, −70.5 bps), and venue mix (replay drew on 139
spot corpus rows; live is **21 of 21 perp, zero spot** — itself confounded with v10). It is not even
v8-vs-v8: the −36.3 is **70 replayed** entries, not v8's **8 live** ones.

**The framing is load-bearing — the verdict flips three ways.** vs v8 _replay_ v10 is worse at
h=1/4/8; vs v8 _live_ v10 is **BETTER at h=4 (+52.0) and h=8 (+16.2)** — the two horizons the digest
flags as failures; market-neutralised, worse at all four. And **h=24, the parent study's DECLARED
PRIMARY horizon, is `consistent`** — the divergence is 2 of 4, not a uniform failure.

**What IS established:** `inverted` did not reproduce out of sample at h=4/h=8 against its OWN
prediction; and market-neutral, v10's entries are worse than the market it traded (h=4 **−48.6**
CI [−123.8, −1.7], h=8 **−65.0** CI [−148.5, −10.1], powered). Beta _helped_ v10, so that is the
honest adverse reading.

**ROLLBACK REFUSED.** `AGENTIC_PLAYBOOK_PIN=8` is not a rollback: it re-arms v9 AND v10 as candidates,
**activates Thompson sampling for the first time in this program's history**, and silently cancels the
owner's daily-minting override (a fresh v12 has 0 trips ⇒ ineligible ⇒ never routed). `verdicts.md`
guardrail 5 forbids defaulting to `champion_v8`. Evidence for preferring v8 is an **n=8/k=5** cell that
fails the power bar, and the window confound runs _against_ v10 (v8 made money into a −240.3 bps
headwind; 76%-short v10 had a −70.5 bps tailwind).

**The sweep's own adverse-selection annotation is FALSE for this metric** — `ENTRY_SQL` selects
decisions filled or not and `forwardBps` anchors on the decision bar's close, construction identical
to replay's `fwdBps`. Replay's blindness to fills cannot move a statistic that ignores fills on both
sides. The sentence was written about realised PnL. **Not yet fixed in code — next-pass item.**

### Headline metrics — gross trading was positive, the LLM bill ate it

At 16:07Z, one atomic `evaluate()`: `roundTrips=48, windowDays=10.85, netPnlUsd=−60.34,
llmCostUsd=28.15, winRate=0.25, ready=false`, reasons `NON_POSITIVE_NET_PNL / INSUFFICIENT_WINDOW /
BELOW_PASSIVE_BENCHMARK`. `equity_usdt` 4966.77, kill switch RUNNING.

Against Pass 58 (09:45Z: 46 / 9.92d / −59.93 / 26.96 / 0.239) over 6.37h: **+2 trips, netPnl −$0.41,
LLM +$1.19**. So realized-minus-fees moved **+$0.78** while the lane billed $1.19 — over a window this
short that is noise, but it is the first read in weeks where gross was not the negative term. Gross
remains −$32.19 lifetime, so **zero LLM spend still cannot make the book positive**.

**WATCH-V3-1: holds, with a slope worth re-reading.** RSS ramped to 737.6 MiB by 09:52 then plateaued;
09:52→16:07 drift was +25.3 MiB (4.0 MiB/h), but 16:07→18:44 local ran +37.9 MiB (**14.6 MiB/h**). Well
under the ~900 MiB signal and the redeploy reset it to 335 MiB, but the acceleration is recorded rather
than smoothed.

**Budget:** opened the UTC day at 2.985, read 0.993 at 16:12Z — ~$0.123/h, projecting **~$2.96** against
the $3/day breaker. It self-paces to almost exactly the cap.

### Fan-out disclosure — the denominator was destroyed by my own second declare

Four read-only lanes were declared and **all four returned** (`recon-sweep-failure`, `position-drift`,
`portfolio-payload`, `v10-forward-return`). But declaring the later write roster **silently overwrote**
the read-only roster, so `loop:fanout join` reported them as _"4 lane name(s) returned that were never
declared"_. The work is intact and all four reports are in this entry; **the ledger can no longer prove
the read-only fan-out was complete**, which is precisely what §4.6 exists to prevent. Verbatim:

> `loop-fanout: DISCLOSURE — 2 of 2 declared lane(s) did NOT return: recon-diagnostics, agentic-effort.`
> `loop-fanout: NOTE — 4 lane name(s) returned that were never declared: recon-sweep-failure, position-drift, portfolio-payload, v10-forward-return.`

The write roster then joined clean: `COMPLETE — all 2 declared lane(s) returned`. **Tool gap:
`loop:fanout declare` overwrites a live roster with no refusal and no versioning** — a second declare
should refuse, or version, while lanes are outstanding.

### Diff, gates, soak

`88a43b3` reconcile axis-error label + first-pass drift identity + runbook · `ea68379` agentic
`output_config.effort` flag-off · `<docs>` this entry, STATUS, the two `watches.md` corrections, the
`charter.md` breaker drift.

**Adversarial review returned MUST-FIX and it was a real, measured defect** — the new `MAX_ACC_NOTES`
cap branch left `test:cov` at **99.5% branches (201/202)** against the mandated 100% for
`src/features/trading/execution/**`. Fixed and re-verified: **100% branches (795/795)**. Two further
review concerns were refuted from the API contract (`output_config` is GA, not beta-gated; `high` is
the documented default). A `positionsChecked` field was **removed rather than shipped** — it had no
reader, which is the exact inverse of the anti-pattern Pass 58 just fixed.

Gates: `format:check`, `lint:md` 0 errors, `typecheck`, `lint`, `build`, `test` **192 files / 3600
tests** (Pass 58 baseline 3595, +5), `test:livegate` **55/55** untouched, `eval:agentic` 95 passed.

Deployed `ea68379`, boot **17:00:03Z**, `build_info` matches the tip, health **200/200**,
`RestartCount` 0, kill switch RUNNING, latch causes all zero. The fresh-boot
`reconciliation_last_success_timestamp_seconds 0` and `agentic_budget_remaining_usd 0` are the
documented carve-outs (clean stamp aged from `StartedAt`; budget gauge inside the 5-min
`BUDGET_GAUGE_INIT_GRACE_MS`), not exhaustion.

**Soak (`loop:sweep` 17:09Z): PASS. Alarms 1 → 1 — no NEW alarm**, the survivor being the frozen
binance window that cannot clear before ~08-07. `running build: ea68379 (working tree ea68379)`, so
provenance is stamped and `build_provenance_void` did not fire; 23 rules loaded / **0 firing**;
container healthy, `RestartCount` 0; **reconciliation CLEAN 9/9 on BOTH venues**; warn this boot 3,
`fatal=0 error=0`.

**Two honest limits on that verdict.** At 9 minutes the boot had **0 decides** — unremarkable at this
cadence (the prior boot averaged one real decide per ~9 min against a consult gate that skips ~94% of
wakes) but **not positive evidence**; the decide-liveness read is deferred to the next pass, and
`AgenticNoSuccessfulDecideSustained` is the rule that would catch a genuine stall. And the 3 warns carry
**zero** `submit_portfolio` truncations, which at 0.2h of runtime says nothing either way — the knob
shipped flag-off, so the leak should be **unchanged**, not fixed, until a separate enable commit.

### Flagged / next

1. **The dead perp trades axis is a BLOCKED defect** — verified, mechanism unproven, needs the #54
   keyed probe then a two-step observation-only enable. First item next pass.
2. **The false adverse-selection annotation** in the forward-return core — a wrong sentence that will
   misdirect the next reader. Text fix, not shipped this pass.
3. **Restate WATCH-PLAYBOOK-V10-1 against a like-for-like comparator.** `REPLAY_REFERENCE.incumbent`
   is already loaded and never rendered.
4. **`loop:fanout declare` overwrites a live roster** — see the disclosure above.
5. **The dust pin leak** (Pass 58's first item) was NOT reached — this pass's defect load consumed it.
6. **The daily-mint override has produced zero candidates in three days** — one authoring row (id 16,
   08-01), none 08-02 or 08-03. Today's slot was still UNSPENT at pass end.
