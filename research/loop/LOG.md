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

## 2026-07-29 — Pass 46 (a NOT NULL column that never measured anything, and a redeploy that erased an outage)

**Window:** 2026-07-29T07:37Z → 09:15Z (pass lease `1b42f3614efda993`, taken 07:37:22Z).
**Boots this window: four.** `899d4a09` (the 22h boot) → `f9dc22ef` at 08:17:56Z, deployed by a
CONCURRENT session, not this pass → `2ceaae5b` at 09:05:26Z (this pass's fix) → `f7a477f3` at
09:09:12Z (rebuild to restore build provenance).

### ⛔ Headline: the Anthropic account is not funded — that is why every LLM request fails

Re-confirmed live at 09:00Z, verbatim from the API:
`400 invalid_request_error: "Your credit balance is too low to access the Anthropic API."`

Nothing in the code is broken. The lane calls, receives a FATAL 400, latches for 30 minutes, retries,
receives the same 400, re-latches — which is correct behaviour against an unfunded account. The
Moonshot fallback is unfunded too (`429 suspended — insufficient balance`). **Zero LLM decides ⇒ zero
trades ⇒ zero promotion progress, continuously since 2026-07-27T21:16Z.** Adding credit is a financial
action no automated pass may take; it is the single owner action the whole program waits on. On
resumption nothing needs redeploying — the latch self-heals within 30 min of credit landing
(proven live, WATCH-V4-5).

Scoreboard, unmoved and unmovable while this holds: **28 of 30** closed round trips, net-of-cost
**−$39.6370**, win rate 0.179, LLM cost $16.1979, trade-anchored window **4.30 of 14 days**,
`agentic_promotion_ready` **0**. Champion playbook **v8**, +$6.77 over 5 trips — the only lineage
meaningfully positive at n>3; v2 alone is −$24.76 over 14 and accounts for most of the book's loss.

### The sweep went from one critical alarm to zero, and nothing was fixed

07:37Z: `AgentClientFatalLatch` (critical), firing since 07-28T10:45:25Z. 08:37Z: **Alarms (0)**.

Between them, a concurrent session redeployed. That reset `agent_client_latched` to 0, cleared the
alert, and wiped the boot-scoped `agent_decide_total` series entirely — `error_fatal 67` and
`client_latched 197` became **no series at all** (verified with a positive control: 88 series scraped,
19 `agent*` present, that one absent). The unfunded condition underneath was completely unchanged.

**A redeploy launders a persistent lane outage into a green board.** The blind window is bounded but
wide: `AGENTIC_FALLBACK_CONSULT_BARS=8` at 15m bars puts the first consult attempt — the only thing
that can re-latch — ~2h out, and `AgenticLaneSilent`'s 6h range selectors still see the previous boot's
samples, so neither guard fires. **The playbook's mandated 15-30 min post-deploy soak sits entirely
inside that window.** A pass could deploy, soak green, and sign off on a dead lane. The only surface
naming the outage at 08:37Z was Pass 45's day-old `prometheus_alert_resolved_critical` annotation —
shipped yesterday, earning its keep on its first full day. Recorded as **WATCH-V4-8**, with the fix
shape (seed a last-success timestamp from the durable ledger at boot, exactly as `f2d74b6` did for the
cost breaker and as `reconciliation_last_success_timestamp_seconds` already does). Not shipped — see
§ Not shipped, and why.

### Shipped — `c50db12`: an audit table whose measurement columns were all a literal zero

`reconciliations` carries four NOT NULL measurement columns. The only persisting store wrote `0` into
all four because `ReconciliationRow` never carried them. **23,973 rows since the v3 cutover, zero
non-zero values in any of the four, ever.**

What surfaced it was a contradiction, not a hunch: `duration_ms` read 0 while the same subsystem logged
**865** `reconcile pass still in flight — skipping this tick` warnings in 14h — which only happens when
passes overrun their tick — and the service's own comment says a pass issues "dozens of sequential REST
calls over ~60s". A pass cannot both take 0ms and overrun its tick.

It was worse than a dead field, because it had already been read as evidence. Pass 45's hand-off and
state.md both concluded _"there are no resting protective orders … the venue reports
`open_orders_checked=0` on every reconcile"_ — from a hardcoded constant. And the falsification goes
deeper than the constant: that axis sweeps the REGULAR rail via `fetchOpenOrders`, while protective/algo
stops live behind `fetchOpenAlgoOrders`, which it never calls — so **no value of that field is evidence
about protective orders**. The conclusion survives on independent gauges (`open_orders{venue}`=0,
`venue_capital_headroom_usdt`=500); the citation was void. Struck and corrected in state.md rather than
quietly rewritten, because it had already been inherited once.

**The adversarial review changed the fix, and that half matters more than the first.** Version one
threaded real counts and would still have written `balances_checked=0` forever **on the only
configuration that runs** — every configured venue is `demo`, so `venueReconConfig` turns `balanceAxis`
off on all of them. A disabled axis now writes `AXIS_NOT_RUN` (−1). The review also caught that the new
gate test asserted `tradesChecked` `toBe(0)`, which would have passed with the increment deleted, and
that the store dropped `ReconciliationRow.ts` entirely (the column's `now()` default stamped every row
at INSERT time) — the same defect class one field over. Both fixed before commit.

**Live-verified post-deploy**, which is the whole point:

| | before | after |
| --- | --- | --- |
| `duration_ms` | 0 on all 23,973 rows | 14,291-23,268 ms |
| `trades_checked` | 0 always | 458, then 7 |
| `balances_checked` | 0 always | −1 (`AXIS_NOT_RUN`) |
| `open_orders_checked` | 0 (constant) | 0 (now a _measured_ zero) |

Two venue passes at 14-23s each ≈ 37s against a 30s tick — the 865 skips are explained arithmetically
for the first time, and the field that explains them now exists.

**Gates:** format, lint, typecheck, **3092** unit+livegate, build, plus `test:db` 64/64 against live
Postgres. **Soak:** clean — 0 alarms, container healthy, `RestartCount` 0, kill switch RUNNING, both
venues CLEAN, 5 warn lines all benign.

### Also fixed: the build-provenance probe read `unknown` on its first real deploy

`af67acf` (shipped ~50 min earlier by the concurrent session) added a `running build:` probe so a pass
can tell which build is live. The Dockerfile takes `ARG GIT_SHA=unknown`, but the documented deploy
command — `docker compose build app`, playbook §5 step 3 — does not pass `--build-arg`. So the first
deploy following the documented procedure (mine) produced `running build: unknown`, defeating the
probe. Rebuilt with `--build-arg GIT_SHA=$(git rev-parse --short HEAD)`; now reads
`running build: c50db12`. **The deploy procedure in the playbook and runbook still omits the flag** —
left to the session that owns those files this morning, noted here so it is not lost.

### Not shipped, and why — a concurrent unleased session held the tree

I acquired the pass lease cleanly at 07:37:22Z. Between 08:16:55Z and 08:29:16Z another session landed
**`af67acf` and `f630f63` on `main`**, redeployed the app at 08:17:56Z, and force-recreated Prometheus
(20 → 21 rules). This is the **fourth** recorded concurrency occurrence and **the first with production
blast radius**: previous ones touched only `test/eval`, which the gate glob excludes, while these
rewrote `src/features/common/observability/**`, `src/config/**`, `observability/alerts.rules.yml` and
the sweep itself.

Damage assessment before trusting anything, per the standing procedure: zero file overlap with this
pass, and both commits were fully committed with a clean tree before my gate ran — so the 3092-test
result stands. **WATCH-V4-8's fix was not shipped for a specific reason, not a priority one:** it
touches `metrics.service.ts` and `alerts.rules.yml`, both rewritten 50 minutes earlier by that session
while its own deploy soak was still running, and a rules-file edit requires a Prometheus
`--force-recreate` that would have destroyed that soak. That is a blocked state with a named blocker.
**The scheduler config that lets two passes co-fire remains owner-owned and open** — it has now caused
four collisions and this one deployed twice under another pass's feet.

### Flagged / next pass

1. **THE ACCOUNT IS UNFUNDED.** Owner action. Everything else is downstream of it.
2. **WATCH-V4-8** — ship the durable last-success gauge on an uncontended tree.
3. **The deploy procedure omits `--build-arg GIT_SHA`** — playbook §5 step 3 and `docs/runbook.md`.
4. **WATCH-V4-6** — unchanged, still exactly 4 non-terminal orders from 07-24, not growing.
5. Provider failover is **not** reachable by config alone — `AnthropicAgentClientConfig` has an optional
   `baseUrl` honored at the fetch, but no production code path ever assigns it, and `MOONSHOT` /
   `AGENTIC_EVAL_*` appear nowhere in `src/**` (positive control: `ANTHROPIC_API_KEY` hits 6 files).
   Moot while both accounts are unfunded; recorded so the next pass does not re-derive it.

## 2026-07-29 — Pass 47 (four measurement lies, one of them the alarm that was supposed to catch the other three)

**Window:** 2026-07-29T09:15Z → 11:15Z. Lease `25798a2449a344ac` taken 09:15:21Z, tree uncontended.
Pass 46 released its lease at ~09:15Z, so this pass began **21 seconds after the previous one ended** —
back-to-back, not concurrent. Consequence recorded below.

**Sweep:** 0 alarms at open. Two annotations: `prometheus_alert_resolved_critical`
(`AgentClientFatalLatch`, 662 firing samples) and `short_interval` (gap 167s). Playbook §3 makes a
resolved critical a defect investigation anyway, which is where this pass started.

**Book — unchanged, independently re-derived from metrics rather than copied from Pass 46:**
`agentic_promotion_round_trips` 28, `agentic_promotion_net_pnl_usd` −39.6370,
`agentic_promotion_llm_cost_usd` 16.1979, `agentic_promotion_win_rate` 0.1786,
`agentic_promotion_window_days` 4.2953 of 14, `agentic_promotion_ready` 0. 0 fills this window.
Champion v8 remains the only meaningfully positive lineage (+$6.77/5 trips) against v2's −$24.76/14 —
n=5 is far under this loop's own "never act on a sub-n≥12 cell" bar, so it stays an observation.
`equity_usdt` 4978.17. RSS 711.5 MiB (WATCH-V3-1: under the 900 MiB line).

**Pass type:** defect investigation. No improvement work was eligible and that is not a scheduling
excuse — every open backlog row is DATA-GATED on closed trips that cannot accrue while the lane is
dead, and § Standing verdicts forecloses the rest (entry signal worse than a random-bar placebo; exit
sweeps closed; "do not propose cost work as a profitability lever"). The one unblocked lever is owner
funding. Stated plainly because the playbook asks for it: **this pass shipped no profitability work
because none exists that funding does not gate.**

### The four defects, all shipped

All four are the same disease at four sites: **a value supplied by its own writer as a constant, or a
counter that counts non-events, is indistinguishable from a measurement at every query, forever.**
Pass 44 recorded it for prom-client children; Pass 46 for a NOT NULL column. This pass found four more.

**1. Deploy provenance read `unknown` for anyone following the playbook** (owner-raised mid-pass).
The Dockerfile takes `GIT_SHA` as a build arg; the compose `build:` block declared no `args:`. So the
arg was reachable only via `docker compose build --build-arg` — the runbook's form. The playbook's §5
form supplied nothing, and the scheduled task's form (`up -d --build`) **cannot** supply it:
`docker compose up` rejects `--build-arg` outright ("unknown flag"), verified live. Every automated
deploy baked the literal `unknown`; the runbook path baked a real sha. That is why the metric read
`c50db12` today and the gap stayed invisible — Pass 46 happened to use the runbook form.
Compose now interpolates `${GIT_SHA:-unknown}`, the one mechanism both subcommands accept (proven
end-to-end on compose v5.3.1 with a throwaway image before any repo edit), and all four documented
deploy commands collapse to that form. **The actual driver was outside the repo** — the scheduled
task's own `SKILL.md` — and was fixed too, along with two other rots in it: it still told every pass
to rehydrate with `loop:digests`, which Pass 46 deleted, and it never mentioned the pass lease.
Two further defects fell out of the fix: `build_info` was resolved by **array order** (the identical
`boot_info` defect found 2026-07-29, one metric over — after a redeploy Prometheus serves both boots'
series and the probe took `[0]`), and `APP_GIT_SHA` now fails OPEN on a **malformed** value, not just
an absent one, because compose interpolates the deployer's ambient `GIT_SHA` and an over-long export
would have thrown in zod, crash-looped under `restart: unless-stopped`, and raised `restart_storm` —
an observability input blocking the deploy it exists to record. It degrades to `unknown` rather than
truncating, because a truncated string is indistinguishable from a real sha.

**2. `zero_decides` cannot fire on a dead lane — the most consequential finding.**
`probes.decides` is an unfiltered `select count(*) from agent_decisions`, but that table takes a row
per symbol per scheduled skip, where no model call happens. Measured over the 12h before the fix:

| hour (UTC) | all rows | scheduled skips | errors | REAL decides |
| ---------- | -------- | --------------- | ------ | ------------ |
| 08:00 | 160 | 154 | 6 | **0** |
| 07:00 | 160 | 153 | 7 | **0** |
| 06:00 | 160 | 147 | 13 | **0** |
| … every hour identical … | 160 | ~150 | ~13 | **0** |

160 rows/hour, every hour, zero real decides — through a lane dead since 2026-07-27T20:15:31Z.
`agentic_consult_gate_total` is incremented by `skipped_scheduled` the same way, so both halves of the
alarm's condition are permanently false. **The alarm the playbook names as the primary dead-lane
detector has never been able to fire on a dead lane.** The total is kept (it does detect a stalled
scheduler — the real 8.2h candle-stall class); a separate `realDecides` probe now counts genuine model
calls with the same structural predicate the app uses to seed its gauge, so the two cannot disagree.
Annotation only, never an alarm — reasoning under defect 3.

**3. WATCH-V4-8 — a redeploy launders a standing outage into a green board.** Queued by Pass 46 with
the deadline "next pass with an uncontended tree"; this was it. Reproduced live at pass open: with the
lane 34h dead, `agent_client_latched` 0, budget $3, 21 rules loaded / 0 firing, 0 sweep alarms.
`agent_last_success_timestamp_seconds` is now seeded at boot from `agent_decisions`, so it reads the
TRUE age on the first scrape of every boot. The success predicate is structural rather than a
rationale string match — `prompt_hash <> '' AND latency_ms IS NOT NULL AND strategy_id NOT LIKE
'replay-%'`, two columns written together and only by code that already parsed a response body — so
skips, latched suppressions and thrown errors are excluded by the shape of the write path. Review
narrowed it further (a post-200 degrade is not a decide either), which is why the lifetime count reads
575 and not the 660 the first predicate selected.
`AgenticNoSuccessfulDecideSustained` is **severity warning, deliberately**: `loop:sweep` promotes only
`critical` to the blocking alarm and §3 blocks improvement work until alarms clear, so a critical here
would wedge every future pass on a condition no pass can fix. `for: 5m` and not the soak length —
the sweep reads only rules already `firing`, so a `for:` equal to the playbook's 15-min MINIMUM soak
would still be `pending` when the soak-ending sweep runs, invisible on the very pass that shipped it.
9h threshold: the model self-schedules up to 32 bars × 15m = 8h, and the widest real decide gap with
the app actually running is 270min.

**4. Three counters whose zero was a void read.** `reconciliation_mismatch_total`,
`agentic_schema_rejections_total` and `agentic_capability_violations_total` were registered with
**zero children** — HELP/TYPE present, no series — so every query returned an empty vector, not a zero.
`reconciliation_mismatch_total{class="adopt_non_adoptable"}` and `{class="fill_overflow"}` are the
literal expected-positive signatures of WATCH-V4-1 and WATCH-V4-2: **successive passes have confirmed
both against an instrument that could not answer.** Both re-verified this pass directly against
`audit_log` (zero rows) — the verdicts stand, the citation never should have been made. All 13 mismatch
classes and 4 schema kinds are now seeded from their own type unions; the capability counter is seeded
at the single kind its call sites actually produce, verified by enumerating them, because a guessed
label would be a fabricated child — the same lie one level down. Pass 44 fixed exactly this on
`market_stream_forced_reconnects_total` and left three siblings.

### Gates, commits, deploy, soak

Gates green on the full tree: `format:check`, `lint:md` (0 errors), `lint`, `typecheck`,
**`test` 3147/3147 across 175 files**, `build`, **`test:livegate` 55/55**.
Commits: `1cb2253` (defects 1+2 — sweep tooling, compose, docs) and `446e1da` (defects 3+4 — app
metrics). **Two commits for four defects, not four**: defects 1/2 both rewrite
`scripts/loop-sweep{,-core}.mjs` and 3/4 both rewrite `agent-metrics-recorder.service.ts`, so a
four-way split needed per-hunk staging that could produce an intermediate commit failing its own spec.
The seams are where the files actually separate. Each defect got its own adversarial review regardless.
Deployed 11:03:17Z, boot `1d68a57c`, `RestartCount` 0, `GIT_SHA=446e1da` via the playbook's own
`up -d --build` form; Prometheus force-recreated (rules file changed) → **22 rules loaded**.

**Soak — every fix verified live, not inferred from tests:**

- `build_info{git_sha="446e1da"}`; digest reads `running build: 446e1da (working tree 446e1da)`.
- `agent_last_success_timestamp_seconds` = 1785183331.331 → **38.80h stale on a boot minutes old**,
  in the same scrape where `agent_client_latched` reads 0. The defect and its fix, side by side.
- **`AgenticNoSuccessfulDecideSustained` FIRING at 11:04:25Z on an 8-minute-old boot** — the signal
  that did not exist before this pass, since every other rule reads green on a fresh boot.
  It lands as `prometheus_alert_firing_nonblocking`, so **sweep alarms stayed 0** and §3 is not wedged:
  exactly the designed failure direction.
- 13 + 4 + 1 counter series now publishing true zeros.
- `kill_switch_state` RUNNING, reconciles CLEAN both venues, `ReconciliationNeverCleanSustained`
  self-cleared once the first post-boot reconcile landed, 0 loop errors, RSS 711.5 MiB.

### Standing WATCH lines, verified against DB truth (not against the metrics that were void)

WATCH-V4-1 holds (clean stamp 105s; no `adopt_non_adoptable` in `audit_log`). V4-2 holds (no
`FILL_OVERFLOW`). V4-3 holds (boot at `RestartCount` 0, kill switch RUNNING, no `perp pin:` line).
V4-4 holds (0 `cum_qty`-vs-fills mismatches; 197 perp fills → perp orders, 12 spot → spot orders,
**zero cross-venue folding**). V4-6 holds (still exactly the 4 non-terminal orders from 07-24,
`cum_qty` 0, not growing). V4-7 holds. **WATCH-V4-8 RESOLVED** — expected-positive confirmed live above.
Pass 46's `c50db12` confirmed in production: `duration_ms` 16–22s per venue pass (was a literal 0),
`balances_checked` −1 (AXIS_NOT_RUN); two venues ≈39s against a 30s tick, which explains the
"reconcile pass still in flight" warns arithmetically for the first time.

### Flagged / next pass

1. **Funding remains the only thing standing between this program and progress.** Unchanged and
   owner-only. Last real model decide 2026-07-27T20:15:31Z; the lane has now been dead ~39h.
2. **Back-to-back passes are a measurement problem, not just waste.** This pass started 21s after
   Pass 46 ended, which tripped the `short_interval` floor and **suppressed delta-starvation alarms
   for the whole pass**. Combined with defects 2 and 3, that made three independent mechanisms capable
   of hiding a dead lane from a single pass. Two are now fixed; the scheduling one is owner-owned
   (§ Flagged, the co-fire item). Recommend the 3×/day schedule be checked for double-firing.
3. **Owner research request, queued 2026-07-29:** whether the daily loop (or a similar
   subscription-based path) could call app endpoints to execute trades as the bot would — routing
   around the funding blocker entirely. Not started this pass. First constraint to design against:
   hard rule 2 forbids bypassing Risk, so the entry point must be the Signal boundary, not the order
   boundary, and the promotion-evidence question (whose decider is the gate measuring?) needs an
   answer before any such trades are allowed to count.

## 2026-07-29 — Pass 47 addendum b (RECONSTRUCTED by Pass 49: it ran, it left no record, and what it decided is gone)

**Window:** 2026-07-29T16:07Z → 19:47Z. **This entry was NOT written by the pass it describes.** It was
reconstructed on 2026-07-30 by Pass 49 from the three sweep digests that pass (or passes) left behind,
because the unrecorded-pass detector shipped in `0fc3bd1` named them and would otherwise keep naming
them forever. **Everything below is read off `research/loop/digests/`, git, or the DB. Nothing here is
inferred about intent.**

**What ran, and it is exactly three sweeps:** `2026-07-29T16:07:26.407Z` (the day's third scheduled
slot), `19:33:03.572Z` and `19:46:38.834Z`. The detector names these three and nothing else, against
the committed `LOG.md` and all 198 digests.

**What they observed — identical across all three, which is the whole story:**

| | 16:07:26Z | 19:33:03Z | 19:46:38Z |
| --- | --- | --- | --- |
| git tip | `14d197f` | `14d197f` | `14d197f` |
| bootId | `1d68a57c` | `1d68a57c` | `1d68a57c` |
| container | healthy, `RestartCount` 0 | healthy, `RestartCount` 0 | healthy, `RestartCount` 0 |
| blocking alarm | `AgentClientFatalLatch` (critical) | same | same |
| Δ raw `decides` | 800 | 560 | 40 |
| **Δ REAL decides** | **0** | **0** | **0** |
| Δ fills | 0 | 0 | 0 |

`AgentClientFatalLatch` had been firing since 2026-07-29T13:00:25Z — the unfunded-account condition.
Lifetime real decides sat frozen at **575**, newest `2026-07-27T20:15:31Z`, across all three. The lane
was dead for the whole window and the book could not move.

**What CANNOT be reconstructed, stated plainly rather than guessed at: what any of them decided,
attempted or concluded.** They left no `LOG.md` entry, no commit — **`main` has no commit between
`14d197f` (2026-07-29T11:15Z) and `8c6d098` (2026-07-30T15:23Z)** — and no artefact under
`research/`. A digest records what the stack looked like, never what the pass thought. That is
irrecoverable and no future pass should spend time trying.

**The one thing that can be said about the shape of the work, and it is inference from policy rather
than from evidence, so it is labelled as such:** playbook §3 forces a defect investigation while any
critical alarm fires, and one was firing throughout. So all three windows were almost certainly spent
re-deriving the unfunded-account blocker — the seventh, eighth and ninth times, after Passes 42-47.
That is precisely the waste Pass 48's `8002888` latch-cause split exists to end, and it is the
strongest available argument that the split was worth shipping.

**Corroborating trace:** Pass 48's lock **broke a stale lease** labelled _"pass 47b research:
loop-as-decider"_, taken ~19:44Z on 07-29 and never released — which places the 19:33/19:46Z pair with
an owner-queued research question rather than with the scheduled slot. That question was later
answered properly, with a verdict, inside Pass 48 (**NO-GO on loop-originated trading**). So the work
was not lost, only its record; the 16:07Z scheduled slot has no such trace and nothing survives of it.

**Why the heading says "Pass 47 addendum b" and not "Pass 47b".** The detector's own heading regex is
`/^##\s+(\d{4}-\d{2}-\d{2})(?:\/\d{1,2})?\s+—\s+Pass\s+(\d+)\b/`
(`scripts/loop-sweep-core.mjs:858`), so a `\d+` must follow `Pass` — `Pass 47b` does not parse and
this entry would not have covered anything. The session's own lease called itself _47b_; the heading
is shaped for the matcher, and this sentence records the discrepancy rather than hiding it.

**This entry exists so the annotation has a resolution instead of becoming permanent noise.** The
sweeps are now covered by a pass entry, which is what the detector checks — verified by re-running
`pnpm loop:sweep` after writing it, not assumed. **Do not re-investigate them.** The standing lesson is the one Pass 48 already drew: a pass that writes nothing is
indistinguishable from a pass that never ran, and the loop could not audit its own cadence until
`0fc3bd1`.

## 2026-07-30 — Pass 48 (four alarms that could not fire, and the account funded itself mid-pass)

**Window:** 2026-07-30T07:45Z → 11:10Z. Lease `93440505ff45f0f3`. The lock **broke a stale lease**
("pass 47b research: loop-as-decider", 721 min old) — that session took the lease at ~19:44Z on 07-29
and never released it. Two sweeps ran on 07-29 (16:07Z scheduled, 19:33/19:46Z) that left **no LOG
entry at all**. The loop has no detector for its own unrecorded passes; noted as a finding, not fixed.

**Sweep at open:** 1 alarm — `AgentClientFatalLatch` (critical, firing since 07-29T13:00:25Z), the
known unfunded-account condition. Annotations: `AgenticNoSuccessfulDecideSustained` (warning) and
`no_real_decides_in_window` — Δ1920 raw `agent_decisions` rows against **Δ0 real model decides**,
Pass 47's new probe doing exactly its job.

**Pass type:** defect investigation, forced by §3, then owner-directed work. Five parallel
investigations plus adversarial verification of every claim (20 agents).

### THE HEADLINE, and it was not the plan: the account was funded mid-pass

At 07:45Z the 400s were live and confirmed from the container log (28 latches / 27 expiries on boot
`1d68a57c`, 100% `credit balance too low`, newest 07:45:18Z). By the post-deploy check the lane was
**alive**: first real decide **2026-07-30T09:01:01Z** (45.6s, full thesis), first proposes 09:15:31Z
(`open_long` ZEC spot + perp), 597 lifetime real decides against 575 in the morning, 6 fills in 24h,
`open_orders` 3 per venue where it was 0, $0.60 of the $3 breaker spent. Credit landed between 07:45Z
and 09:01Z and **the lane self-healed with no redeploy**. That closes the one clause of WATCH-V4-5
that could never be tested without credit — the funded-resumption path is now proven live.

**The scoreboard moved for the first time since 07-27, and the direction matters more than the
motion:** 29 closed trips (was 28), window **6.71 of 14 days** (was 4.30), net-of-cost **−$41.1723**
(was −$39.6370). One trip advanced the window 2.4 days and cost $1.54. That is precisely what
`verdicts.md` predicts: every additional trip on the present entry signal moves the trip count toward
the bar while moving net-of-cost away from it.

### Four defects shipped, all four measurement lies, two of them CRITICAL alerts that could not fire

**1. `8002888` — six passes investigated one unfunded account because the alarm could not say so.**
Owner directive, verbatim: _"lack of trading is because of the anthropic api account being unfunded.
this should not have to turn into investigations on each pass."_ The cause was structural:
`AgentClientFatalLatch` is `critical`, `loop:sweep` promotes every firing critical to a blocking
alarm, and §3 makes any alarm force a defect investigation. A permanent owner-blocked fact wedged
every pass. `classifyLatchCause` now reads the provider's own error body — 401/403 ⇒ `auth`, 400 +
`invalid_request_error` + `/credit balance/i` ⇒ `insufficient_credit`, everything else ⇒ `other` —
and the alert splits, with the known cause landing at `warning`. **Fails CLOSED**: only a positive
match demotes. Review found three defects in the first cut, each in the new guard's own failure
direction: the `and`-shaped expr collapsed to empty when the cause series was absent (silencing the
critical over a dead lane — the void-read disease reintroduced in the alert that catches a dead
lane; now `unless`); the banner keyed on an instant gauge measuring `avg_over_time` **0.836** over
24h, so one sweep in five would print nothing over the exact condition it announces (now a 6h
`max_over_time`); and the `cause=` tag was model-spoofable into **false reassurance** (now anchored
to the emitted string).

**2. `a03b35d` — the two critical alerts guarding hard rule 6 could not fire.**
`ReconciliationHalt` selects `{result="halt"}`, a child that was never seeded — measured live, the
selector returned an EMPTY vector against a positive control returning three series. A prom-client
child born lazily sits at its first value forever, so `increase()` reads 0: demonstrated on a live
sibling reading **1** with `increase([24h])` = **0**. Precision, because the first draft overstated
it: the alert is not dead in general (it fired 9 consecutive evaluations on 07-26) — what is
invisible is a halt whose child receives exactly ONE increment, and WATCH-V4-2 records that
`FILL_OVERFLOW` is precisely that. `ReconcilerStalled` used `result!="error"`, which includes the
re-entrancy `skipped` child — the counter that RISES when passes stop completing. Measured: old
selector 27.95, of which skip alone 10.26; narrowed selector 18.46 on a healthy reconciler.

**3. `e1ce4e1` — the loop's memory was its largest fixed cost.** Owner directive: _"clean up log.md
and state.md … you can find a better way to keep the loop hydrated."_ state.md 1,932 lines + LOG.md
5,886, read three times a day. Split by one question — what must a pass read before it can act:
`STATUS.md` (152 lines, capped 200) always; `charter.md` / `verdicts.md` / `watches.md` on demand;
archives for the rest. **Nothing deleted, proven two ways**: 50/50 moved blocks byte-identical in
their destinations, and every non-blank source line present in the new set. The actual fix is the
rotation rule in §6 — a one-off compaction just re-grows.

**4. `e091ba5` — seven more instruments whose zero nobody could read**, enumerating the siblings of a
known class. Review caught this commit committing the very defect it removes, twice:
`agentic_venue_stop_total` was seeded over both venues while the only writer passed no venue and
always resolved `'unknown'` (live: the sole three series were `venue="unknown"`), so it fabricated 24
dead children **and the new spec pinned the inversion**; fixed at the writer, and `onVenueTp` had the
identical defect. `playbook_validator_rejections_total` was seeded at an unreachable pair.

### Gates, deploy, soak

Gates green at every commit: `format:check`, `lint`, `lint:md` 0 errors, `typecheck`, `build`,
`test` **3205/3205 across 176 files** (3147 at pass start), `test:livegate` **55/55**,
`promtool check rules` SUCCESS 23 rules. Deployed 11:02:19Z, boot `4a43ac63`, `RestartCount` 0,
`GIT_SHA=e091ba5` — `build_info{git_sha="e091ba5"}` confirmed; Prometheus force-recreated (rules
changed) → 23 loaded, 0 firing. **Soak: 0 alarms.** Verified live rather than inferred: every seeded
child publishing a true zero, including `reconciliation_runs_total{result="halt"}` on both venues;
`kill_switch_state` RUNNING; `agentic_consult_gate_total` now exports all six outcomes (three
before). The new banner correctly stays SILENT — the lane is not latched. Worth recording: the prose
banner in STATUS.md went stale within 90 minutes of being written, while the metric-driven banner
self-corrected. That is the "what wrote it" discipline paying out on the same day it was written.

### Research: loop-as-decider — NO-GO, with a positive recommendation

Owner-queued 2026-07-29, answered by a dedicated opus pass. **Verdict NO-GO on loop-originated
trading, live and demo, on evidentiary not mechanical grounds.** Free inference is a COST lever, and
the gate's own arithmetic bounds it: LLM spend is 68.3 bps/trip of an ~183 bps/trip deficit, so it
removes **37% of the requirement and 0% of its cause** — the residual gap is the 115–130 bps
`verdicts.md` already binds. For a loop decider to be anything else, its entries would have to beat
the production decider by **≥115 bps/trip**, against an incumbent measuring ~100 bps BELOW a
martingale; the one measured decider swap in this repo moved ~10 bps on a proxy. Two corrections to
the first-pass read: the promotion gate **is** decider-blind structurally (`fillsForMode` has no
decider predicate, unlike the existing replay exclusion) even though the data is decider-attributable
via `prompt_hash`; and a subscription decider **does not route around the funding blocker** — the
study's `aggregateVerdict` returns `INCOMPLETE` unless both declared models run, so it adds a
prerequisite in front of it. **Recommendation: fund the ~$110 frozen 12-arm replay study, not the
trading lane** — it is pre-registered, frozen, and decisive in both directions.

### Flagged / next pass

1. **The scheduler does NOT double-fire** — checked: `0 2,10,18 * * *` with 414s jitter, one fire per
   slot. Pass 47's open recommendation is closed. The 07-28 collisions came from interactive sessions
   overlapping scheduled ones, which the lease binds only if they call it.
2. **Two passes on 07-29 left no LOG entry**, and one left a lease dangling 12h. The loop cannot
   detect its own unrecorded passes; a sweep annotation comparing the newest digest against the
   newest LOG entry would close it. Not built this pass.
3. **A research agent wrote to the working tree** despite a read-only instruction (it was dispatched
   as `general-purpose`, which carries Write). Two out-of-scope files were reverted, copies
   quarantined. Read-only research must be dispatched to an agent type without write tools.
4. **`agent_last_success_timestamp_seconds` is now the single best lane-liveness read** — it caught
   the resumption within one scrape of the deploy, from the durable ledger, with no dependence on
   whether the client had tried yet.
5. **The funding question the owner now faces is not "is it funded" but "should the lane spend it"** —
   `verdicts.md` says the present entry signal cannot clear the gate, and Pass 48's research names the
   study as the better use of the next $110.

## 2026-07-30 — Pass 49 (a research-bar failure deployed on deployment-bar grounds, and two live behaviour changes nobody will be able to tell apart)

**Window:** 2026-07-30T15:23Z → 17:16Z. Eleven commits, `8c6d098` … `4218d78`, plus one live
database action that is in no commit at all (the playbook mint + promotion). Two deploys: boot
`181b2965` at 16:51:44Z on `9a63edf`, then boot `b894ce22` at **16:57:19.888Z on `4218d78`**,
`RestartCount` 0, container healthy. `build_info{git_sha="4218d78"}` confirmed live.

**Sweep at 17:08:20Z: `Alarms (0)`.** 21 alert rules loaded across 5 groups, **every rule
`health":"ok"` and every rule `state":"inactive"`** (read off `/api/v1/rules`, not inferred from the
sweep's count line); `count(ALERTS)` returns an empty vector. Five annotations: `boot_changed`, three
`prometheus_alert_resolved*` for alerts that fired and cleared during the 60-hour outage, and
`sweeps_unrecorded_in_log` — the detector shipped in this pass, on its first production sweep.

**Book, re-derived from the gauges at 17:15:42Z and NOT copied from Pass 48:** **32** closed round
trips (was 29), net-of-cost **−$41.8850** (was −$41.1723), win rate **0.1875**, LLM cost
**$17.8605** (was $16.7940), trade-anchored window **6.9663 of the 14 days** required,
`agentic_promotion_ready` **0**, `equity_usdt` **4978.39**, `agentic_budget_remaining_usd` **$1.3221**
of $3, RSS **711.4 MiB** (WATCH-V3-1 fine), `kill_switch_state` RUNNING, `open_orders` binance 3 /
binanceusdm 2. Champion playbook is no longer v8 — see below.

**Read the book carefully: it moved twice in one hour, and the two moves say different things.**
At 17:07Z it read 31 trips at **−$39.0415** — a `$2.13` IMPROVEMENT over Pass 48 across two trips.
At 17:15Z it read 32 at **net −$41.8850** — a `$2.84` loss on one trip. n=1 and n=2. Neither number
is evidence about anything shipped today, and the first one is the more dangerous of the two: those
two trips closed BEFORE the 16:51/16:57Z deploys, so they ran under v8/v9 and under the model's own
discretionary `close`. **Exactly one closed round trip has run under either change** — KAITO/USDT:USDT,
entered 16:30:38Z, closed **17:11:55Z by its declared venue `STOP_MARKET`**, which is the behaviour the
enable predicts and a −$2.84 sample of it.

### 1. `inverted` is the live playbook (v10) — A RESEARCH-BAR FAIL, SHIPPED ON DEPLOYMENT-BAR GROUNDS

`agentic_playbook_info` reads **`version="10"`**. `agent_playbook_versions` now carries ten rows:
version **10, `source='loop-candidate'`, `parent_version=8`**, minted 16:56:43.469Z; version **11,
`source='promotion'`, `parent_version=10`**, written 16:56:57.909Z with the content
`promoted version 10 via playbook:promote on 2026-07-30T16:56:57.909Z`. The v10 content is the
`inverted` arm's prose verbatim (1,933 chars, opening `## regime notes` / "Treat the obvious read of a
chart here as a contrary indicator rather than a signal").

**Say it in these words, because a later pass will otherwise read the deployment as a claim of edge:
this is a RESEARCH-BAR FAIL deployed on DEPLOYMENT-BAR grounds.** On the identical 354-row corpus and
the identical forward-return metric (`research/studies/playbook-space-replay-2026-07-28.md:749-756`),
`inverted` beats `champion_v8` at **every** horizon —

| h | `champion_v8` | `inverted` | delta |
| --- | --- | --- | --- |
| 1 | −12.7 (n=70) | −0.8 (n=117) | **+11.9 bps** |
| 4 | −36.3 (n=70) | +0.8 (n=117) | **+37.1 bps** |
| 8 | −32.7 (n=70) | +19.3 (n=117) | **+52.0 bps** |
| 24 | −70.1 (n=69) | +47.6 (n=117) | **+117.7 bps** |

— and fails the research bar anyway, on **interval width**: h=24 CI lower bound **−12.2**, h=8 **+1.1**,
both under the pre-registered +13.0 bps, `p vs bar` 0.1947 / 0.2215. The deltas are arithmetic on two
measured means, not a fifth measurement.

**Three things this deployment does NOT license, each one a way a future pass could overclaim:**

- **Never quote +47.6 as an edge.** The hedge in the NO_SURVIVOR verdict stands unsoftened. Deployment
  is a choice among losers; it licenses no write-up, no promotion evidence, no move toward live money.
- **In-sample, one regime.** The arms are scored on the corpus that generated the finding: 6.35
  calendar days, 2026-07-21 → 27.
- **Adverse selection may not invert, and offline replay structurally CANNOT measure whether it does.**
  The recorded entries were maker-side at **76% fill**. Being reliably on the wrong side of a print
  does not imply the other side of that print was available at the same terms; the study's "the bias is
  identical across arms" argument covers the entry PRICE level, not whether the faded side fills at all.
  **A divergence between replay-predicted and live-realised entry return is therefore a FINDING to
  report, whichever way it points** — a live result WORSE than the replay is the adverse-selection
  hypothesis confirming, and a live result BETTER than it is equally a finding about the replay.

### 2. `AGENTIC_PLAN_AUTHORITATIVE_EXITS=true` — the model no longer owns the exit

`.env.app:261`. Step one shipped dark in `9a63edf` and booted clean at 16:51:44Z; this is step two.
While a positioned symbol carries enforced `directives`, the model's `close` emits no exit signal and
is journalled as a `hold` tagged `plan_authoritative_close:`. Positions then exit ONLY via the declared
stop, take-profit or maxHold.

**Measured basis, unchanged and not re-derived here:** the declared plan run mechanically is
**−78.4 bps/trip at 22.7% hit** against **−108.1 bps at 17.4%** for the model's actual discretionary
hand, over the same 23 recorded round trips — **29.7 bps**, with 16 of 22 live closes being the model's
own `close`. Research-bar FAIL (under the pre-registered 30 bps bar), deployment-bar win.

**BASELINE FOR THE NEXT MEASUREMENT: −108.1 bps/trip at 17.4% hit.** Nothing else.

**The failure mode this creates, named before it happens: a plan lost to a restart.** The gate fails
toward EXITING — no context, absent `directives`, or FLAT ⇒ the close executes unchanged — and
`AGENTIC_VENUE_STOP`/`_TP` are both `true`, with venue stop/TP resting confirmed live (6 `ACKED`
protective orders across both venues at 17:13Z, every one carrying a `venue_order_id`). Live
corroboration on the first trip: KAITO exited by its `STOP_MARKET`, not by a `close`. Zero
`plan_authoritative_close:` rows exist yet — the four real decides since the deploy were all `hold`.

### 3. THE ATTRIBUTION LIMIT — stated now rather than discovered later

**Both changes above are live simultaneously, and the realised book cannot separate them.** Record it
explicitly so no later pass claims otherwise: **no future pass may claim either change moved the book
on its own.** There is no A/B arm; both went live inside six minutes of each other on the same boot.

What IS separable is their **evidence**, and that is the reason both were allowed to ship together:
the playbook promotion is measured on **entry forward return**, which does not depend on how a position
is exited, and the exits change is measured on **exit behaviour GIVEN entries**, which does not depend
on which bar was chosen. Each therefore carries an independent replay-measured basis. Their
realised-PnL contributions do not decompose, and at any observed trip rate they will not.

**Correction to the trip-rate figure that framed this:** the ~3.8 trips/day used when the change was
written is not reproducible from the live gauges. 32 trips over a 6.9663-day trade-anchored window is
**4.6/day** as a lifetime average, and the funded stretch is far faster than that — 29 → 32 trips
between 11:04Z and 17:15Z is **~11.7/day**, and the window advanced 0.256d while 3 trips closed. The
attribution limit does not depend on the rate and is not weakened by the correction: two simultaneous
changes with no control arm are inseparable in realised PnL at any frequency. What the higher rate DOES
change is the timeline — enough trips to compare the exit mix against the −108.1 baseline may accrue in
days rather than weeks, so the first re-measure is nearer than "weeks" implied.

### 4. The first `source='loop-candidate'` row ever minted, and it caught a live corruption on first use

`agent_playbook_versions.source` read `reflection` 4, `seed` 4, `loop-candidate` **0**: the
loop-to-lane authoring channel had never produced a single row in the program's life. `2c4e339` fixed
three defects in `pnpm playbook:candidate`, and **the one that mattered was not derivable from source
and had to be settled against the live database.** `playbook-shared.mjs` resolved the active version
via the FIRST seed row by version, while `PlaybookStoreAdapter.ensureSeed` looks up `seed.version`
specifically and the composition root binds `SEED_PLAYBOOK_V3` at **8**. On a clean v3 database those
agree. **The live table is not clean:** four seed rows survive at versions **1, 2, 6 and 8**, no
promotion row, empty pin. The helper returned **1** while the running process resolved **8**.

So the first candidate this CLI ever minted would have written `parent_version=1` into an **append-only
table that cannot be corrected afterwards** — a false lineage for the live playbook, permanently. The
fix takes the newest seed row (justified by the documented bump-above-all-prior-rows rule at
`agentic-strategy.module.ts:426-438`). **Verified in the shipped row: v10 carries `parent_version=8`,
not 1.** The defect and its first production use were the same event.

**v9 superseded, nothing deleted.** The candidate-lapse deadlock (`verdicts.md`) is resolved as a
consequence: `--supersede` recorded the supersession in `experiments` — id 8, family
`playbook-supersede`, label `v9 (reflection) superseded by v10 via --supersede`, metrics
`{"lapseHours":336,"newVersion":10,"activeVersion":8,"supersededSource":"reflection",`
`"supersededVersion":9,"supersededAgeHours":79}` — and **no row was removed**: the table still holds
all ten versions including 9. v9 took 40 of the last 24h's 88 real decides; since the deploy all four
real decides read `playbook_version=10`.

### 5. WATCH-V4-6 CLOSES — four orders that could never become terminal, terminal on the first tick

Open since 2026-07-24. `83eae1f` shipped `sweepStrandedNew`; the four rows terminalized on the first
tick after the 16:51:44Z deploy, **with nothing run by hand**. Verified against the DB, not the metric:

| symbol | state | `cum_qty` | fills | `venue_order_id` | terminal at |
| --- | --- | --- | --- | --- | --- |
| ZEC/USDT:USDT | CANCELED | 0 | 0 | NULL | 16:52:47Z |
| SOL/USDT:USDT | CANCELED | 0 | 0 | NULL | 16:52:49Z |
| KAITO/USDT:USDT | CANCELED | 0 | 0 | NULL | 16:52:49Z |
| NEAR/USDT:USDT | CANCELED | 0 | 0 | NULL | 16:52:49Z |

`order_events` carries exactly **four** `CANCEL_REQUESTED` rows with payload
`{"type":"CANCEL_REQUESTED","reason":"STRANDED_NEW_NEVER_LANDED"}`, each appended as the 4th event
after the unchanged `SUBMIT_SENT → SUBMIT_AMBIGUOUS → QUERY_NOT_FOUND` chain from 2026-07-24. Nothing
was rewritten; the journal is append-only and stayed that way.

**The join is on `order_events.order_id` = the intent UUID, NOT the `client_order_id`.** Stated because
it cost a wrong query in this pass and will cost the next one the same if it is not written down: the
`orders` row keys on both, and `order_events` keys only on the intent id.

The book-wide check now reads **zero** non-terminal orders lacking a `venue_order_id`. The 6 orders
still `ACKED` are genuine resting protective orders placed today, every one with a venue id.

### 6. Reflection deleted, and the cost saving stated honestly rather than banked

`193107e` turned it off (`AGENTIC_REFLECTION_EVERY_N_TRADES` 2 → 0, the schema's documented off switch,
`.min(0)`), `9a63edf` deleted it: `reflection.service.ts`, `version-pnl-digest.ts`,
`decision-postmortem.ts` and their three specs — **6,596 deleted lines, −149 tests / −3 test files**
(3146 passed across 177 files at the commit, inside the predicted −154/−3). Two alerts,
`AgenticReflectionRejects` and `AgenticReflectionNeverMinted`, were DELETED rather than rewritten
because both select label values only reflection ever wrote and would otherwise select empty series
forever — **23 rules → 21, confirmed live, with zero `AgenticReflection*` rules in the API response.**
`agentic_reflection_trigger_total` has no series at all.

**`AGENTIC_REFLECTION_MODEL=claude-opus-5` (`.env.app:84`) and the `claude-opus-5` entry in
`AGENTIC_TOKEN_PRICES_JSON` (`.env.app:169`) are KEPT ON PURPOSE. Boot REFUSES without them** —
`environment.config.ts`'s superRefine demands a price entry when the reflection model differs from the
decide model, and `PromotionReadinessService` re-prices the 69 historical Opus rows through the same
map on every evaluation. Deleting the price entry breaks the process, not the gate.

`agent_tokens_total{model="claude-opus-5"}` is now **ABSENT** rather than a permanently-zero seeded
child: the only series are the four `claude-sonnet-5` kinds. That is the intended shape — the child was
never seeded, and there is nothing left to write it.

**The honest cost note, because the saving is easy to overclaim.** `agent_tokens_total{claude-opus-5}`
read **0 on the pre-deploy boot**, so the **$5.01** reflection figure is a HISTORICAL accumulation, not
a guaranteed forward daily rate. `llm_usage` bears that out and then some: 69 reflection rows total
(58 `claude-opus-4-8` + 11 `claude-opus-5`), and the **newest is 2026-07-27T09:47:23Z** — three days
before deletion, with zero reflection calls in between. Reflection fires on closed trades and trades
are infrequent. **Do not book $5.01/day, or any daily rate, as saved.** The real value of the deletion
is the one `9aa8400` names: it permanently removes the ANTI-RATCHET objective, which pre-committed the
loop against the only lever with positive expected effect. The 118-line authoring prompt survives
verbatim at `research/loop/playbook-authoring.md`, byte-identity established programmatically.

### 7. The unrecorded-pass detector fired on its first sweep, and here is the resolution it was owed

`0fc3bd1`. Pass 48 recorded that two sweeps on 2026-07-29 left no LOG entry and did not fix it. The
detector shipped this pass named **exactly three** sweeps and nothing else, on the 16:52:18Z sweep and
again at 17:08:20Z: **2026-07-29T16:07:26.407Z, 19:33:03.572Z and 19:46:38.834Z**.

**That annotation will keep firing until those three are written up or explained, so here is the
explanation — and it is not a happy one.** From their digests, all three:

- ran on git tip **`14d197f`** (Pass 47's own LOG commit) against boot **`1d68a57c`**, container
  healthy, `RestartCount` 0, one unbroken boot across all three;
- carried the SAME blocking alarm: **`AgentClientFatalLatch` (critical), firing since
  2026-07-29T13:00:25Z** — the unfunded-account condition;
- measured **`realDecides` delta 0** on every one, against raw `decides` deltas of 800 / 560 / 40. The
  lifetime real-decide count sat frozen at **575**, newest 2026-07-27T20:15:31Z. **Zero fills.**

**No commit landed on `main` between `14d197f` (2026-07-29T11:15Z) and `8c6d098` (2026-07-30T15:23Z).**
So what CAN be reconstructed is the state each pass observed; what CANNOT is what any of them decided,
attempted or concluded, because they left no commit, no LOG entry and no artefact. Under playbook §3 a
firing critical alarm forces a defect investigation, so all three were almost certainly spent
re-deriving the unfunded-account blocker — the seventh, eighth and ninth times that had happened, and
precisely the waste Pass 48's `8002888` latch-cause split exists to end. **They ran unrecorded and
cannot now be reconstructed. This paragraph is the resolution: the annotation has an answer, not a
permanent noise source.** The 19:33/19:46Z pair matches the "pass 47b research: loop-as-decider" lease
that Pass 48 found dangling 721 minutes; that question was later answered properly inside Pass 48.

### 8. Two findings this pass did NOT fix, both surfaced while verifying something else

**(a) WATCH-V4-1's `adopt_non_adoptable` clause has been read against a table that can never carry
it.** Passes 47 and 48 both recorded "no `adopt_non_adoptable` in `audit_log`". That is true and
worthless: `audit_log` holds **zero** rows of that class over its entire history, because the class is
written to `reconciliations.discrepancies` and to the boot-scoped
`reconciliation_mismatch_total{class="adopt_non_adoptable"}` counter, never to `audit_log`. Read on the
right surface, the clause **is breached**: 101 rows carry it, including one on **2026-07-30T09:30:15Z,
`binance`, boot `1d68a57c`** — a single pass, not sustained, self-cleared, with 825 `CLEAN` binance
passes in the same 14h window and the clean stamp 86s old at 17:09Z. The 100-row 2026-07-27 run on
`binanceusdm` is the already-diagnosed BCH fold defect (`reconciliation.service.ts:969-977`), fixed.
The V4-1 **named defect outcome did not fire** — the stamp never went stale — but the expected-positive
did, once, and no pass has ever recorded it. WATCH-V4-1's verification surface is corrected in
`watches.md`; the single 09:30Z event is **not** root-caused here and is left as an open check.

**(b) An orphaned perp algo stop has been resting against a flat book for 73+ minutes.**
`HYPE/USDT:USDT` `BUY STOP_MARKET`, submitted 13:00:31Z as protection for a SHORT that closed at
16:00:31Z, still `ACKED` at 17:13Z and still resting through two boots. `cancelPerpAlgoStopIfResting`
(`agentic.strategy.ts:2096-2101`) returns silently when its `entry` snapshot is `undefined` — the
`planStopRegistry` row is read BEFORE `clearPlan()`, so a plan already cleared leaves nothing to read
and the cancel is a no-op **with no counter incremented**. `agentic_venue_stop_total{event="orphan_cancel"}`
reads 0 on this boot, which is consistent with both "never needed" and "silently skipped" — the same
void-read shape Passes 44/47/48 have now fixed at six other sites. **Bounded, not dangerous:** the
resting stop is `reduceOnly` by construction (`agentic.strategy.ts:2086`), so triggering it against a
flat book reduces nothing rather than opening an unintended long. **Mechanism NOT established** — this
pass observed the state and the one code path that can produce it, and did not prove that path is what
happened. New **WATCH-V4-10**, `watches.md`.

### 9. The funded architecture arm RAN, and it is decisive: the swarm does NOT ship

Family A of `research/studies/playbook-space-followon-2026-07-31.md`, run by the peer arm during this
pass. Verified against its own artifacts
(`research/scorecards/playbook-space-followon-2026-07-31.json`), not transcribed from the hand-off.

**Deployment bar — the swarm loses the PRIMARY horizon, so the incumbent stays.** Against
`champion_v8` on the identical 354-row corpus and the identical metric: h=1 −12.15 vs −12.69
(beats), h=4 −22.58 vs −36.34 (beats), h=8 −35.38 vs −32.70 (loses), **h=24 primary −71.83 vs −70.10
(LOSES)**. Wins 2 of 4 and not even horizon-dependently — there is no horizon story to tell.

**Research bar — `NO_SURVIVOR`, 4 of 4 cells scored at α=0.0125, 0 passes, and every cell POWERED**
(n=78–82 over 15 clusters, against `MIN_ENTRIES=12`). Every cell fails the FIRST clause, the mean:
**−12.15 / −22.58 / −35.38 / −71.83** against a required **+20.9 / +26.4 / +33.8 / +81.4**. These are
real failures, not absent measurements.

**The pre-registered screen scored CORRECT, on the mechanism as well as the direction.**
`architecture-options-2026-07-28.md` called the haiku swarm NEUTRAL-TO-WORSE before a dollar was
spent, reasoning that ensembling reduces variance rather than bias while the measured failure is a
bias. The swarm is worse than its own single-call control at **3 of 4** horizons, at **3.00× the
calls** (`$0.010506` vs `$0.003502` per decide — exactly 3 voters) for near-identical entry rates
(**24.58% vs 24.86%**), and the placebo p is **0.9902 / 0.9946 / 0.9980 / 1.0000** at h=1/4/8/24 — a
displaced centre, which is precisely what a variance-reduction instrument structurally cannot move.
The screen is now a validated instrument rather than a well-argued opinion, and that is worth more
than the arm was.

**Pre-registered mechanism 2 got MEASUREMENT rather than argument:** of 354 rows, **282 unanimous,
71 with split votes collapsed to the mode, and 53 where the swarm's action differed from the
single-call control's.**

**Blob-pinned attribution HELD, so the in-run sonnet control was genuinely unnecessary.**
`src/features/strategy/agentic/agent-prompt.ts` is blob `c471c33055abad7c7ec0cb9978f81c61bc3c487d` at
HEAD, on disk, and at the pin — **independently re-verified here at all eight commits of this pass**,
including the two peer commits that landed mid-run, neither of which touched it. The comparison is
therefore PROMPT-CONTROLLED, and the `$4.86` an in-run control would have cost was correctly not
spent. What this does NOT remove, and the study says so itself: provider-side model drift and re-run
variance.

**Spend `$6.1728` of `$7.93` authorised** (calibration `$1.2142` + paid run `$4.9586`), 6.6% under
the sized projection, hard cap `$21` not approached, `rowsCovered = 354/354`, `aborted = false` — so
both arms cover the identical row set.

**A LEAD, recorded so a future pass CANNOT mistake it for a finding.** A single haiku call beat the
sonnet incumbent at h=1/4/8 (**−7.12 / −10.77 / −30.30** against −12.69 / −36.34 / −32.70) and **LOST
the declared primary h=24: −80.30 against −70.10.** It does not ship, for three independent reasons
and any one of them is sufficient: (1) the pre-registered robustness clause requires h=24 **AND**
≥3 of 4 — both, not either; (2) acting on "wins 3 of 4" is cherry-picking against a primary that was
declared before the numbers were seen; (3) it would be a **model** change, on an axis `verdicts.md`
§ THE DECIDE MODEL IS NOT THE LEVER has already settled `NO_SURVIVOR`. **It is a lead. It is not
evidence, and it is not a licence to swap the decide model.**

**Two things this pass adds that the arm could not know, both worth carrying forward:**

- **The incumbent it was measured against is no longer the incumbent.** The study read the champion as
  `champion_v8` at comparison time, correctly — `inverted` had not shipped yet. It shipped 16 minutes
  later. Against the ACTUAL live playbook the swarm's h=24 −71.83 sits against `inverted`'s replayed
  **+47.6**, i.e. **~119 bps worse**, and it loses at every horizon rather than two. The comparison
  crosses models (haiku arm vs sonnet arm) so it is weaker than the like-for-like one the study ran —
  but it points the same way and it makes the NO-GO stronger, not weaker. **Nobody should re-open the
  swarm on the grounds that it "nearly beat the champion".**
- **The `0.273×` haiku ratio is against the PREDECESSOR's sonnet price, not the re-checked one.**
  Measured haiku `$0.0037475`/call against `$0.013717` is 0.273× — inside the pre-registered 0.21–0.33
  band, as recorded. Against the re-checked sonnet rate `$0.0191125` the same numerator is **0.196×**,
  i.e. BELOW that band. Both are true; the band was declared against the older figure and the study
  used it correctly. Stated so a later reader does not recompute 0.196 and conclude the calibration
  broke its own gate.

**ROUTED ONWARD, not absorbed silently — a cost input the next study must re-size against.** The
sonnet re-check measured **`$0.0191125`/call, 1.39× the predecessor's `$0.013717`** on the same prompt
surface and model alias. The likely mechanism is **cache amortisation over a single 40-row chunk**
against a predecessor that spread its cache writes over 354 rows and four arms — so it is a caution,
not a price rise, and it is not evidence of provider repricing. **Family A is unaffected** (priced
entirely off the haiku probe). **Family B is not:** its two sonnet legs were budgeted at `$4.86` each
on the older figure and would land nearer **`$6.77`** each. Anyone sizing Family B re-derives from the
re-checked rate or explains why not. Related and equally inconclusive: the re-check entered on 3 of 34
parsed rows (8.8%) against the predecessor's 19.8% for the same arm — at n=34 the 95% interval on 8.8%
reaches roughly 23%, which contains 19.8%, so **that is within sampling error and is evidence of
nothing in either direction.**

### Gates, deploy, soak

Gates were run and recorded per commit by the sessions that shipped them: `format:check`, `lint`,
`lint:md`, `typecheck`, `build`, `test` (3217/3217 across 177 files at `8c6d098`/`2f1c917`; 3146/177
after the reflection deletion), `test:livegate` **55/55**, `test:paper` 17. `execution/**` stays
coverage-gated at 100% and `83eae1f` verified by stash-diff that the uncovered set is exactly the
pre-existing baseline shifted +26 lines. **This pass added no code and ran no gate of its own beyond
`lint:md`** — it is a records pass; the numbers above are the shipping sessions', attributed to them.

Deploy 16:57:19.888Z, boot `b894ce22`, `RestartCount` 0, `GIT_SHA=4218d78`. Prometheus force-recreated
(rules file changed) → **21 rules, 5 groups, all `health: ok`, 0 firing**. Soak: **0 alarms**, kill
switch RUNNING, both venues CLEAN (22 clean / 12 skipped / 0 mismatch / 0 halt / 0 error on this boot),
clean stamp 86s, 14 warn lines this boot and all three categories benign (11× reconcile-in-flight skip,
2× unsupported route path, 1× the standing `ACTIVE_STRATEGY=agentic` unvalidated banner).

**Standing WATCH lines, checked against DB truth:** V3-1 holds (711.4 MiB, under 900). V4-1 holds on
its stamp clause (86s) and is **breached once** on its `adopt_non_adoptable` clause — above. V4-2 holds
(zero `fill_overflow` anywhere, ever). V4-3 holds (two redeploys with perp stops resting, both to
`RestartCount` 0 / RUNNING, no `perp pin:` line). V4-4 holds (0 orders whose fills sum disagrees with
`cum_qty`; 218 perp→perp and 14 spot→spot, **zero cross-venue folding**). **V4-6 RESOLVED.** V4-7 holds.
V4-9 holds (the study ran with `capsSource: 'recorded'` on 100% of rows).

### Flagged / next pass

0. **Do NOT re-run a multi-call/ensemble architecture arm, and do NOT swap the decide model to
   haiku.** § 9: the swarm loses the declared primary and fails 4 of 4 research cells; the single-haiku
   lead loses the primary too and would be a model change on a settled axis. The next study re-sizes
   its sonnet legs off `$0.0191125`/call, not `$0.013717`.
1. **The first real measurement to take is the exit mix, against −108.1 bps/trip at 17.4% hit.** Look
   for `plan_authoritative_close:` holds at roughly the historical close rate (~16 per 22 exits) and the
   exit mix shifting toward venue stop / TP / max_hold. A storm of positions running to `max_hold` with
   realised bps WORSE than −108.1 ⇒ revert the flag and record it. WATCH-PLAN-AUTHORITY-1 is now FIRED,
   not pending.
2. **The second is entry forward return under v10, and it is the one that can produce a genuine
   finding** — replay-predicted vs live-realised. Report the divergence whichever way it points; the
   adverse-selection question is the whole reason it is worth measuring.
3. **Neither may be claimed to have moved the book on its own.** § The attribution limit.
4. **WATCH-V4-10** (orphaned perp algo stop) and the single 09:30Z `adopt_non_adoptable` — both
   observed, neither root-caused.
5. **`AGENTIC_PLAYBOOK_AB_PCT=40` now routes nothing.** v9 is superseded and sits below the active
   version, so there is no unresolved candidate above v10 for the A/B to route to. That is correct
   today and is a **live knob describing a state that no longer exists** — worth a decision next pass:
   mint a genuine v11 candidate to compare against `inverted`, or set the knob to 0 and say so.
6. **Only the Anthropic account is funded.** Moonshot is untested since and presumed still suspended;
   `agent_client_latch_cause{cause="insufficient_credit"}` is the read, not an investigation.
