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

## 2026-07-31 — Pass 53 (a position that could not be exited, and the 45 minutes nobody could have seen)

**Window:** 2026-07-31T16:07Z → 17:15Z. Lease `195186b5400588b5`, taken 16:07:30Z, no collision.
Pass type: **DEFECT INVESTIGATION** — forced by §3, two named alarms. Live build at pass start
`c78d193` (deployed by Pass 52 at 12:33Z, after that pass wrote its STATUS; the "A DEPLOY IS DUE"
banner was already stale when it was read).

### Headline

| metric | now | at Pass 52 |
| --- | --- | --- |
| closed round trips | **37** | 35 |
| net-of-cost PnL | **−$40.7534** | −$42.3358 |
| LLM cost (epoch) | $20.598 | $19.41 |
| trade-anchored window | 7.891 / 14 days | 7.329 |
| win rate | 27.03% | — |
| `agentic_promotion_ready` | 0 | 0 |
| `equity_usdt` | 4981.69 | 4978.33 |
| day budget left at 16:07Z | $0.786 of $3 | $0.978 |

**WATCH-V3-1 holds.** RSS 752.4 MiB (788,971,520 B) at 3.6h into the `93e21a99` boot — _below_ Pass
52's 763 MiB reading, against the ~673 MiB paper reference and the ~900 MiB defect line. Not a climb.

### The alarm that mattered

`loop:sweep` fired `venue_reject_rate_high` on BOTH venues. `binance` 16/20 is the known pre-`f5abf8a`
window (unchanged, all 20 submits predate the fix; still clears itself). **`binanceusdm` 12/20 = 60%
was new, and it is a real trading-path defect.** Full forensics:
`research/loop/incidents/2026-07-31-perp-exit-band-rejects.md`.

Between 13:00:36Z and 13:06:10Z the app made 13 attempts to exit a 70.3 KAITO/USDT:USDT long. Twelve
were terminal-rejected `BadRequest -4024 "Limit price can't be lower than X"`; the thirteenth
stranded (`SUBMIT_AMBIGUOUS` → `QUERY_NOT_FOUND` → `STRANDED_NEW_NEVER_LANDED` at 13:11:14).

**The cause is a frame mismatch, not a pricing bug.** `market-streams.module.ts:77-79` builds market
data against `FEED_ENV=live` while orders execute against `SANDBOX_ENV=demo`. Binance `-4024` is the
`PERCENT_PRICE` SELL lower bound evaluated against **the venue's own mark**, and the demo perp book
was stalled 5.7% above the live tape (demo 5m volume 281–300 vs production 223k–644k). Reconstructed
to six decimals off testnet `markPriceKlines`: mark 1.124900 × `multiplierDown` 0.9500 = 1.068655 —
the exact floor returned at 13:01:09, 13:01:39 and 13:04:40. **Our reference price was itself below
the floor on all 12 attempts** (shortfall 10.6–39.4 bps), so `EXIT_CROSS_BUFFER_BPS=25` was 40–70% of
each shortfall but removing it prevents **zero** rejects. There is no venue price-band clamp anywhere
on the order path: `SymbolFilters` carries only tick/step/minQty/minNotional, `PERCENT_PRICE` appears
nowhere in `src/`, and `evaluate.ts:174-194` measures deviation against **our own** `refMid`.

**The cost was not the rejects.** The first attempt was a `plan exit: stop`, so `cancelFirstEligible`
cancelled the resting `STOP_MARKET` at 13:00:38.029 — two seconds after the signal and _before_ the
replacement was known to be accepted — and `clearPlan()` dropped the plan stop. The position carried
no venue stop and no plan stop until 13:45:34: **45 minutes**. A second, independent gap: the stranded
order held `inFlightSymbols`, which suppressed the 1s protective backstop entirely from 13:06:40 to
13:11:14. A third: `protective_exits_total` counts FIRES, not fills, so it read a healthy `12` while
nothing exited, and the retry cooldown stamps on fire — hence 30s forever, no backoff, no cap.

**Mitigating, and it cuts both ways:** the cancelled stop's trigger (1.0797) was priced off the LIVE
feed and could never have fired against a demo mark of 1.1249. The protection lost was already
notional on this venue split.

### What shipped

1. **`VenueTerminalRejectBurst`** (`observability/alerts.rules.yml`) — `sum by (code)
   (increase(orders_rejected_total{stage="exchange"}[15m])) >= 3`, `for: 5m`, **`severity: warning`**.
   Warning is load-bearing: the sweep promotes only `critical` to a blocking alarm, and a critical here
   would wedge §3 on a self-resolving condition. Threshold checked against both known reject axes — the
   13:00Z hour spikes to 12 (fires); the spot `InsufficientFunds` bleed runs a measured 2/hour (does
   not). Fails OPEN. `WATCH-V4-14`.
2. **The reconcile guard stopped shouting.** 214 warns/3.6h of "reconcile pass still in flight" is
   expected behaviour confirmed by three verifiers: one pass costs ~38.6s p50 (binance 22.04 +
   binanceusdm 16.62, n=479 over 4h) against a 30s timer, so the measured gap between COMPLETED passes
   is 60.00s p50 / 90.46s max over 239 intervals. Demoted to `debug`; visibility stays in
   `reconciliation_runs_total{result="skipped"}`, which `ReconcilerStalled` deliberately excludes
   (`a03b35d`). Also corrected `trading-runtime.module.ts`, which called 30s the cadence — it is the
   timer period, and mismatch-detection latency is ~60s.
3. **The sweep can audit its own coverage again.** Pass 52 left no `**Window:**` line (owner-directed
   session), and ONE unparseable entry blanks the WHOLE verdict by construction. Reconstructed from
   evidence — first/last digest of that session bracketing its nine commits. Its non-vacuity test then
   failed honestly, because the reconstruction closed the gap it was exercising; the `4 ×
   PASS_WINDOW_END_TOLERANCE_MS` bound was arbitrary and its premise ("a 3×/day cadence always leaves
   hours between passes") is false once passes run back-to-back. Tightened to the **derived** bound: a
   midpoint orphan escapes iff gap > 2 × tolerance. Still a real guard — it fails if entries ever close
   to within an hour.

### WATCH-V4-12 — first reading, expected-positive CONFIRMED

The `submit_portfolio` warns are two unrelated failures with opposite verdicts. The "payload failed
schema validation" class is **output-budget truncation**, correctly re-tagged. Measured:

| tag | rows (boot) | `output_tokens` (boot) | rows (14d) | at exactly 4096 |
| --- | --- | --- | --- | --- |
| `truncated_max_tokens:` | 7 | min = max = **4096** | 11 | 7 |
| `schema_rejected:` | 8 | 168 – **358** | 137 | 12 |

Every measurable `truncated_max_tokens:` row carries exactly 4096; **zero sit "well below 4096", so
the named defect outcome did not occur.** Disclosed rather than counted: 4 of the 11 carry NULL
`output_tokens` (usage is recorded on a batch's first symbol only) — unreadable, not contradicted.

**The obvious response was refuted and must not be re-proposed.** Raising `AGENTIC_MAX_TOKENS` to
12288 is adversarial to the one budget currently ~30% from tripping (the $3/day USD breaker, not the
token/day cap), and the batch HTTP budget is 75s against a projected ~83–91s at that ceiling — an
abort THROWS rather than soft-holding, and three strikes auto-DRAIN the lane. The stated fallback
(`thinking: {budget_tokens}`) is a 400 on this model, and 400 is in `FATAL_STATUSES` — an immediate
latch. The in-contract lever is `output_config: {effort: …}`, which appears nowhere in
`anthropic-agent-client.ts`, so the lane pays for default thinking depth. Cost-negative and reversible;
that is the experiment to run, not the ceiling raise.

### Gates, deploy, soak

`format:check` ✓ · `lint` ✓ · `lint:md` 0 errors ✓ · `typecheck` ✓ · `test` **3384/3384, 183 files** ✓
· `build` ✓ · `test:livegate` **55/55** ✓. Deployed `35042cc`, `build_info{git_sha}` confirmed,
new bootId `4753ef53`, `RestartCount` 0, healthy. Prometheus force-recreated (the rules file changed):
**23 rules loaded**, 0 unhealthy, `VenueTerminalRejectBurst` present, none firing. Kill switch RUNNING.

**A trap worth recording.** `promtool check rules /etc/prometheus/alerts.rules.yml` FAILED mid-pass
with "line 448: found unexpected end of stream", which reads exactly like a corrupt rules file. It was
not. A host-side rewrite of a **single-file bind mount** leaves the container's path pointing at a
dangling inode — the committed bytes parsed cleanly (22 rules) and all 22 running rules were healthy
throughout. Validate an edit by `docker cp`-ing it in and checking the copy; a check against the
mounted path after a host edit is VOID.

### Not done, and why — stated as a blocker, not a priority

**The `-4024` repair itself did not ship.** This is a blocked state, not a scheduling choice. The
leading sub-fix ("retain the plan-stop registry row until the exit is accepted") was **refuted on
evidence**: `manageVenueStop` is gated on `this.activePlan`, not the registry, so retention re-arms
nothing, and it would additionally disable the `orphan_readopt` recovery path and make the stand-down
defer to a stop that does not exist. The two correct seams (defer the algo-stop cancel until the exit
ACKs; or a plan-independent re-arm) both require first resolving the margin/base-lock rationale at
`agentic.strategy.ts:1434-1438`, and the root cause sits behind a `FEED_ENV` choice with a very wide
blast radius. Shipping a half-understood lifecycle change on the protective-exit path is the specific
thing this repo's rules forbid. The exact proposed diffs, the refutation, and the two corrections
(`-4023` not `-4025`; prefer a `markPrice × multiplierDown` bound over parsing the venue's error
string) are in the incident note.

**CANDIDATE was not run and today's authoring slot is still UNSPENT** — the incident gate took the
pass. Worth flagging loudly: `loop:authoring` has **never minted, 0 `playbook-authoring-attempt` rows
lifetime**, because the registry gate `633f901` fixed in Pass 52 made it impossible. That fix is
therefore **unverified**, and `WATCH-DEPLOY-HALVES-1` sits at SAMPLE ZERO for the same reason. The
first authoring run is the highest-value single action available to the next pass.

**One investigation returned nothing.** The fourth agent (RSS trajectory + menu-composition/pin-leak
audit) died on its structured-output contract after 52 tool calls. RSS was re-read directly and holds;
**the pin-leak question — whether any of the 14 active-menu symbols is pinned with no open position
and no resting order — is UNREAD**, and an unread check is not a passing one.

### Next-pass candidates

1. `loop:authoring` — unspent slot, unverified `633f901`, SAMPLE-ZERO watch. First.
2. Quantify the demo/live divergence across all 37 closed round trips. The divergence is **episodic,
   not a standing offset** (3 bps apart at this trip's entry, 21 bps at its partial exit, 572 bps
   during the stall), so "demo PnL is fictional" is NOT supported by this incident — but how much
   recorded PnL is attributable to decoupling is unmeasured, and it conditions the whole promotion
   scoreboard. Worth more than any single fix above.
3. The `-4024` repair, via one of the two correct seams.
4. The pin-leak audit the failed agent owed.
5. `output_config: {effort: …}` as a cost-negative truncation experiment.

## 2026-07-31 — Pass 54 (the grid was flattering, and nothing here can be shown to learn)

**Window:** 2026-07-31T20:40Z → 21:15Z. Lease `30c1a5be616fd056`, taken 20:40:39Z, no collision.
**Owner-directed research session**, not a scheduled pass — recorded with a `**Window:**` line because
Pass 53 spent effort reconstructing the one Pass 52 omitted.

**The question asked:** could a vastly more intelligent but cheaper decide model (GPT-5.6 after its
price cut, or kimi-k3) push the book toward profitability. **The owner then reframed it** to: the
least-bad config / model / architecture that can potentially LEARN an edge. The reframe is what
produced the findings; the original question was answerable from the record alone.

Full record: `research/studies/learning-capacity-2026-07-31.md`.

### Headline — the declared horizon grid was measuring the wrong thing

Forward return is scored at h ∈ {1,4,8,24} bars. That grid was never matched to holding behaviour.
Measured, n=40 closes over 10 days: **median hold 234.4 min ≈ 15.6 bars, mean 817.3 min ≈ 54.5 bars.**
Re-scored at hold-matched horizons ($0, no new model calls, control reproduces `loop:forward-return`
exactly at h=1):

| version | h=1 | h=8 | h=24 | **h=16** | **h=54** |
| --- | --- | --- | --- | --- | --- |
| v1 | −16.9 | −47.4 | −58.5 | **−57.6** | **−111.3** |
| v2 | −15.9 | −70.8 | −155.6 | **−94.5** | **−174.8** |

**This reconciles two ledgers that have disagreed for a week.** Realized gross is **−69.1 bps/round
trip** on the current book (−$23.17 over $3,353.99 notional, 38 trips) and −101.9/−106.0 in the older
record; h=1 said −16.9. **The hold-matched horizons bracket every realized figure; h=1 brackets none.**
Order-of-magnitude agreement only — the cells are v1/v2 while realized spans all eight arms, and
forward return measures entry drift not round-trip PnL. Consequence: the gap to the +13.0 bps bar is
**~70–125 bps at the horizon that counts**, not the ~30 the old grid implied. No ordering flips.

### Nothing here can currently be SHOWN to learn

Eight live playbook versions; **only v1 (n=28,k=13) and v2 (n=18,k=11) ever reached the power bar, and
they are the two oldest.** 78 entries / 8 versions = 9.75 against a bar of 12.

**The mechanism is DIVISION, not suppression — the obvious confound was checked and would have
inverted the story.** Trading did not slow: **2026-07-24 was simultaneously the highest-volume day in
the program's history (24 entries) and its heaviest minting day (v2,v3,v6,v7 all live)** — four arms
sharing 24 entries is ~6 each, half the bar, on the best day there has ever been. The two POWERED
versions are the two that had the book largely to themselves. 07-26/07-28/07-29 produced zero decides
(outage, host sleep), compounding but not causing it.

### The model question, on the reframed terms

No model supplies edge (best cell ever: −7.12 bps vs a +13.0 bar). In a learning architecture the
model is a **substrate for running many experiments**, so price buys **search rate, not PnL** — haiku
~4–5× more arms per dollar, GPT-5.6 Luna ~15× on rate. The cost thesis is dead on its own terms:
**gross with inference FREE is −$23.17.** kimi-k3 excluded — quality disqualification, and Moonshot's
~31.5% empty-200 rate makes it 1.9× MORE expensive. **The haiku question is NOT settled and cannot be
settled offline for free:** the replay cells persist only per-(arm,horizon) aggregates, so re-scoring
haiku at h=16 needs a fresh paid run. Verified in the spec, not assumed.

### Shipped — three commits, gate green (3414 tests / 184 files, livegate 55/55, build clean)

`1064503` the hold-matched re-score tool. `4b7e021` a corpus builder — v4 is 587 rows (+52%) but
**currently INERT**: the OHLCV cache stops at ~07-27 so 34% of rows score null at every horizon (the
known `279713e` truncation; a $0 re-fetch is the unlock). `3958c8c` a decide-model A/B config gate,
**flag-off**, with a fail-closed boot refusal.

**The A/B gate is NOT a working A/B and the commit says so.** Three findings recorded against its own
interest: `abArm` had **zero production call sites** before it (playbook routing uses its own inline
bucket — the "independent salt" requirement was vacuous); the arm is drawn **once per BOOT** because
the client pins one model per instance and `AGENT_CLIENT` is a singleton, so the claimed benefit is
**not delivered**; and attribution journals/meters every arm-B decide **as arm A**, which would poison
the promotion gate's own cost and PnL inputs. `AGENTIC_MODEL_AB_PCT` stays 0.

### Also found

`leaders_only` and `one_symbol_btc` are **structurally unscoreable** — capped at 3 and 1 symbol-clusters
by their own playbook text against a floor of 5. The untested search space is 5 arms, not 7.

### The decision this turns on — OWNER

**Daily minting and powered evidence are mutually exclusive.** Holding an arm to n≥12 AND k≥5 takes
2–4 days; daily minting guarantees no arm is ever readable. That override is a dated owner decision
(`candidate-routing-override-2026-07-31.md`) and change-discipline forbids reopening it silently.
Recommendation: suspend daily minting for the live lane, move iteration offline (~$5/arm, hours). If
kept, record explicitly that the live lane is a **corpus generator, not an evidence source**.

### Next

1. Refresh the OHLCV cache ($0) — nothing downstream is scoreable without it.
2. Close the attribution gap and the per-call-model constraint before any A/B enable.
3. Then a pre-registered paid re-run of haiku vs sonnet at the hold-matched horizon.
4. **Re-read every prior study against the horizon finding** — all were scored on the flattering grid.

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
