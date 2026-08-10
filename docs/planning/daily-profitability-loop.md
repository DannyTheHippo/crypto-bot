# Daily profitability loop — playbook (v4)

> **The v2 freeze is LIFTED and this v4 procedure is FULLY ACTIVE — §4's whole pass-type menu is
> live, with no further human gate.** The condition the freeze named has been satisfied since
> 2026-07-21: the cutover record is `research/loop/archive/state-2026-07-30.md:59`, which opens
> "v3 LOCAL DEMO CUTOVER — LIVE (2026-07-21, owner session; this is the cutover record the …" and
> continues past that line — with its pre-cutover gates all landed (Grafana Overview strip +
> regression pass, `8014a1d`).
>
> Corrected Pass 65 (2026-08-06), because the banner had rotted into self-contradiction: its lead
> text still said cutover "has NOT yet been recorded" and ordered every pass to treat §4 as
> MAINTENANCE-only, while its own closing parenthetical said the record "IS present". A pass reading
> top-to-bottom would have wrongly refused itself CANDIDATE and PROMOTION work — and passes 51-64 in
> fact ran CANDIDATE throughout, so the text was not merely stale but contradicted by the loop's own
> behaviour for six weeks. This is the §0 "a playbook is code that rots" rule applied to the
> playbook's own first paragraph.

Audience: a Claude session executing one pass. Cadence: 2-4 passes/day (owner 2026-07-10 — the
loop runs on subscription, not a per-day API budget). Trigger (owner-run):
`/loop 1d Read docs/planning/daily-profitability-loop.md and execute one pass`, or a scheduled
routine. This document is the task spec for each pass; execute it top to bottom.

Mission: maximize net-of-cost PnL (`realizedPnl − fees − llmCostUsd`) toward the promotion gate,
now walked over the ONE unified book. Every pass runs §1 (rehydrate) and §2 (evidence sweep)
unchanged; §3 is a hard gate — any named sweep alarm forces defect investigation FIRST; only when
the sweep is clean does §4 select ONE pass type. This is an operational playbook, not application
code. Rewritten 2026-07-21 (v4, the v3 one-book consolidation) — the prior v3 text described a
two-container, two-database, two-Prometheus, per-lane-breaker stack that the v3 program replaced
with a single process/single book; a playbook is code that rots — re-verify every operational
claim against current code before citing it, and repair drift in the finding pass.

## 0. The v3 stack, in one paragraph

Exactly 4 containers (`docker-compose.yml`): `crypto-bot-app-1`, `crypto-bot-postgres-1`,
`crypto-bot-prometheus-1`, `crypto-bot-grafana-1`. No `-perp` siblings, no compose profile — the
`app-perp`/`postgres-perp`/`prometheus-perp` services and the `perp` profile mechanism were
deleted at the v3 cutover (`plans/2026-07-v3-consolidation-spec.md` §9). ONE process runs BOTH
venues (spot `binance`, perp `binanceusdm`) against ONE Postgres (`cryptobot`) and ONE Prometheus
(`:9090`). Metrics policy (spec §8): `venue`-labeled where the fact is venue-scoped
(`reconciliation_runs_total{venue,result}`, `market_channel_staleness_seconds{venue,symbol,
channel}`, `venue_free_cash_usdt{venue}`, `venue_capital_headroom_usdt{venue}`); account/book
gauges are label-less (`equity_usdt`, `kill_switch_state`, `agentic_budget_remaining_usd`,
`agentic_active_menu`, ...) because there is only one book now. One promotion verdict, one
playbook lineage (seed v1 — `SEED_PLAYBOOK_V3`, `agentic-strategy.module.ts:426`), one champion/
candidate A/B, one unified `AGENTIC_DAILY_COST_STOP_USD=$3/day` breaker. NOTE: the spec file
`plans/2026-07-v3-consolidation-spec.md` is git-history-only (2026-07-21 owner md prune) — read
any "spec §N" citation in this playbook via `git show`.

## 1. Rehydrate — from durable metrics, never a raw log window

Start every pass from durable, queryable history, NOT a 24h `docker logs` window (the raw-window
model is exactly what made R8-7's day-long spot-decide suppression invisible; Y1 §D).

**The hourly collector daemon was RETIRED 2026-07-29** and `loop:digests`/`loop:collect` no longer
exist. It scraped from outside what the app can publish itself — `pmset`/`sysctl`/`uptime` for host
state, a `docker logs` tail for the error picture, the working-tree tip for the deployed commit —
and it failed silently twice in nine days (nine cycles of `deltas:null` after surviving the v3
cutover; then 49.6h dead with no host reboot). The app now emits all three as metrics
(`app_log_events_total`, `app_suspend_events_total` + `app_wall_clock_skew_seconds`, `build_info`),
Prometheus retains them for 90d, and `loop:sweep` reads them. Rehydration is therefore ONE command
(§2) instead of a daemon plus a reader.

What the retirement cost, stated plainly: there is no longer a per-hour series of counter deltas —
the sweep sees the window between passes, not each hour inside it. Nothing consumed that series (the
180 hourly `sweep-*.json` files were written and read by nothing), but a future question that needs
per-hour resolution must go to Prometheus range queries, not to a digest file.

Run all stack commands sandbox-disabled (`dangerouslyDisableSandbox: true`); never `cd` into the
repo (the fnm hook breaks) — use `git -C <repo>` / `corepack pnpm --dir <repo>` / PATH-prefixed
node. Host `psql` and host `curl` are auto-denied; do not attempt them.

Read in this order:

1. This playbook.
2. `date -u` — anchor wall-clock BEFORE any log forensics. Unanchored timestamp comparison
   fabricated a 40-minute phantom-bug chase (Y1 §C.10). Verify the clock before the code.
3. `corepack pnpm --dir <repo> loop:lock "pass <N>"` — take the pass lease BEFORE any edit, and KEEP
   the `nonce=` it prints; §6 needs it. A refusal means another pass is live in this same working
   tree: end this pass, record the collision, and **do NOT run `loop:unlock`** — you do not hold that
   lease, and freeing it would re-enable the very collision you just detected (the release is
   nonce-gated so it will refuse, but do not try). On 2026-07-28 two scheduled passes overlapped, one
   committed the other's in-flight work twice, and a gate run read the test count moving
   mid-verification (`research/loop/watches.md` § Flagged). Two honest limits: the lease is
   time-based (2h, fails OPEN
   — it cannot detect a dead holder, only an expired one), and it binds only passes that call it, so
   a refusal is evidence of overlap while a clean acquire is NOT proof of its absence.
4. `corepack pnpm --dir <repo> loop:sweep` — the rehydration base AND the evidence sweep, one run
   (§2). It carries counter deltas since the last sweep, everything Prometheus fired and resolved in
   the last 12h, the error/warn breakdown from the log-event counter, host duty cycle from
   `app_suspend_events_total`, and bootId + running-build provenance.
5. `research/loop/STATUS.md` — **the ONE state file a pass reads at start**, and the only one it
   always reads: the ⛔ owner-blocked banner, current order & status (live build/boot, the book, the
   promotion scoreboard, what is deployed, last-pass pointer), the open WATCH lines one line each,
   the open backlog table, the open flagged items, and an index of every other loop file. It is
   capped at 200 lines so this step stays cheap; it replaced `state.md` (1,932 lines) on 2026-07-30
   because rehydration had become the largest fixed cost in the pass. `state.md` is now a 17-line
   stub and holds nothing.
6. The rest of `research/loop/` is read **on demand only**, when STATUS points you at it:
   - `charter.md` — before deciding whether something is loop-domain or owner-gated, before firing a
     pre-authorization, and whenever a settled owner decision is in play (NOT re-openable by a pass
     — a pass that disputes one writes the argument into the report, never acts).
   - `verdicts.md` — before proposing work in an area it covers (entry signal, exit rules, cost
     levers, decide-model choice, price TA, non-price channels, promotion benchmark, playbook
     lineage). Binding: do not re-derive, do not act against one without new evidence of equal weight.
   - `watches.md` — when a WATCH's exact expected-positive or named defect outcome matters, or an
     open flagged item is needed in full.
   - `LOG.md` — the last five pass entries. Older entries: `archive/LOG-through-pass-47.md`. The
     record behind any STATUS/watch/verdict line: `archive/state-2026-07-30.md`. Read an archive only
     when a pointer sends you there.
7. `git -C <repo> log --oneline -20` — what shipped since the last pass. Re-run this BEFORE
   committing: on 2026-07-28 two foreign commits landed on `main` mid-pass (§ the lease above).
8. Project memory index (auto-loaded) — env quirks, validation recipes.

If the sweep carries an `app_suspended` annotation, that window is dark — the stack runs on a
sleeping MacBook and the app process was frozen with it; treat counter gaps across it as duty cycle
before suspecting a bug (Y1 §D host-state). That annotation is measured from inside the suspended
process (wall-clock advance minus monotonic advance), so unlike the old `pmset` read it describes
the thing that actually stopped.

## 1a. Out-of-sample session-arm decide leg (fires at pass start AND pass end)

Machinery: `research/studies/oos-session-arm-2026-08-03.md` (the pre-registration; binds — read its
§ Cadence and its 2026-08-10 amendment before touching this step), `test/eval/agentic/oos-arm-
{decide,record,prompt,run}.ts`, `scripts/loop-oos-arm-gather.mjs`. **This step is the decide leg
only.** It gathers candidate rows and records this session's blind decisions. It never seals a
window (sealing is a separate, later action — see the note at the end of this section) and it never
scores a read.

**Carrier, not a new daemon** (owner constraint, 2026-08-10: no new daemons, crons, or background
tasks). This step is TWO firings inside the existing pass — once here, right after §1 step 4
(`loop:sweep`), and once again at the very end of the pass, immediately before §6 step 5's
`loop:unlock`. A missed firing (pass skipped, pass failed before reaching this step) is a GAP,
recorded as a gap in LOG.md — **never backfilled** (pre-registration § Row-window bookkeeping: "Gaps
between windows are permitted and are a wait, never a backfill").

Run each firing as follows:

1. **Gather** (read-only, no daemon):
   `OOS_ARM_CANDIDATES_FILE=<scratch path> corepack pnpm --dir <repo> loop:oos-gather`. This queries
   `agent_decisions` for rows with `trigger_kind='candle'`, non-replay
   (`strategy_id NOT LIKE 'replay-%'`), a FLAT position marker (the same literal
   `loop-forward-return.mjs` uses), and `event_time > (DB clock now()) − 4·900000` ms — the arm's own
   k∈{0,1,2,3} eligibility window, read off the DATABASE clock in the SAME round trip the query itself
   uses, never the host clock. It excludes any rowId already present in
   `research/oos-arm/decisions-*.jsonl` (dedupe) and REFUSES — throws, writes nothing — if the
   gathered rows span more than one `agent_playbook_versions.version`: a promotion landing mid-window
   is a gap for THIS firing, never a guess at which version applies to which row. **The output file
   structurally never carries `action` or any other field naming the live lane's decision** — the
   gather SQL never selects `action`, so there is nothing in the file to leak.
2. **Blind decide, in a dispatched subagent — this is the VOID-4 artifact.** Dispatch a subagent
   whose ENTIRE input is the candidates file's contents plus the composed prompt surface (the same
   `buildLiveSystemPrompt`/`buildPlaybookBlock` output the harness itself builds — never hand-compose
   a different one) — **never `action`, never a pointer into `research/loop/`, `agent_decisions`, or
   candle data beyond what the candidates file already carries** (pre-registration VOID condition 4:
   "a transcript showing the deciding session read anything beyond the offered payload ... is the
   blindness condition"). The subagent decides each row exactly as the live trading tool schema
   requires (one `submit_trade`-shaped tool call per row) and writes its answers to a scratch JSONL,
   one line per row: `{"rowId": "...", "toolInput": {...}}`. **That subagent's own transcript is the
   artifact this pre-registration's blindness check reads** — never summarized, redacted, or
   regenerated; the dispatching pass keeps the transcript reference in its own LOG.md entry.
3. **Record** (env-gated, no daemon):
   `OOS_ARM_RUN=1 OOS_ARM_CANDIDATES_FILE=<same path> OOS_ARM_ANSWERS_FILE=<answers path> corepack pnpm --dir <repo> exec vitest run test/eval/agentic/oos-arm-run.spec.ts`
   (`pnpm --dir <repo> vitest …` fails EACCES — `exec` is required, same as every other ad hoc vitest
   invocation in this playbook). Decides every ELIGIBLE, ANSWERED row via the file-backed replay path
   (zero network egress beyond what the dispatched subagent itself made in step 2), reports the count
   of rows skipped for a missing answer, runs the caps-faithfulness and entry-rate VOID checks, and —
   only if both are clean — appends one line per decided row to
   `research/oos-arm/decisions-YYYY-MM-DD.jsonl` (dated off the gather instant). An ineligible row in
   the candidates file (the gather step's own bound should prevent this, but the runner asserts it
   independently) ABORTS the whole firing; a VOID caps/entry-rate check writes nothing. Either way, do
   not retry the same candidates file — re-gather fresh at the next firing.

**Sealing is a SEPARATE, later action this step does not perform.** Per the pre-registration's
2026-08-10 amendment (§ Seal targets), a window is sealed only once it reaches its target row count
(202 rows for reads 1-2) — most firings of this step accumulate rows toward that target without
sealing anything. A pass that determines a window HAS reached target seals it via `sealBatch`
(`test/eval/agentic/oos-arm-record.ts`) as its own explicit, reported action, computing
`liveFlatRows`/`liveEntryCount` per the registered denominator over exactly that window's rows before
calling it — never as an implicit side effect of this decide-leg step, and never for a window that has
not reached target.

## 2. Evidence sweep — `pnpm loop:sweep` IS the sweep

Run `corepack pnpm --dir <repo> loop:sweep` (sandbox-disabled). It is the whole sweep — the
hand-run docker/promtool command list from the pre-Y2 era was RETIRED, and the tool was itself
rebuilt single-app-shaped for v3 (`scripts/loop-sweep.mjs` header). It is deterministic and
metrics/DB-first: host duty-cycle state, then the one app container's provenance (health +
RestartCount + StartedAt + bootId + running build + git tip) BEFORE any counter, then bootId-pinned
liveness deltas (`agentic_consult_gate_total` by outcome, `agent_decisions` count + latest
`created_at`, fills, per-venue reconciliations tail, kill-switch state, ws forced-reconnects,
single-process RSS, LLM cost-vs-breaker proximity against the ONE $3/day breaker), plus the
app-emitted replacements for the retired collector: the log-event counter, suspend evidence, and the
deployed git sha.

The log-event counter is reported TWICE and the two numbers legitimately differ — `increase()` over
the 12h window undercounts a message class first seen inside that window (prom-client creates a
label child lazily, so its first and last sample are equal), while the since-boot cumulative is exact
but blind before the last restart. Read the larger as the floor; neither over-reports.

The digest's alarms and annotations ARE the pass's evidence base. Rules that bind every sweep:

- `docker logs --since` is FORBIDDEN — it returns silently empty across rotated segments and after
  Docker Desktop restarts, voiding negative reads (Y1 §C.9). The sweep reads durable counters and
  DB rows that survive restarts and are immune to NOOP_LOGGER.
- Never trust a negative read. An empty probe result is VOID unless paired with a positive control
  known to return data (Y1 §C.9). `probe_failed` annotations are measurement failures, not "quiet
  health" — a failed probe fails OPEN (partial digest, failure named), never masquerades as clean.
- State-only greens are never accepted. A healthy `/health` endpoint proves nothing — read the
  kill-switch METRIC and the reconciliation result distribution, demand positive watermark deltas.
- Deltas only across a matching bootId (§C.6). A boot change resets counters — the sweep suppresses
  delta-starvation alarms on a fresh boot and on sub-30-min windows (short-interval floor).

Harness-health: a pass that ships an agentic-lane change runs
`corepack pnpm --dir <repo> eval:agentic` as a candidate/regression gate ($0 offline replay; not in
the gated `test` suite, so it rots silently — a RED harness is itself a flagged finding).

## 3. Incident-first gate — any alarm forces defect investigation FIRST

If `loop:sweep` fires ANY named alarm, this pass IS a defect investigation. Improvement work (§4
CANDIDATE/PROMOTION/MAINTENANCE-backlog) waits until the alarm is root-caused and cleared.

> ### ⛔ THE ONE EXCEPTION: A KNOWN, OWNER-BLOCKED CONDITION IS NOT AN INCIDENT
>
> **The LLM provider account is unfunded. That is why there are no trades. Do NOT investigate it.**
> Since 2026-07-27T21:16Z every decide attempt returns `400 invalid_request_error: "Your credit
> balance is too low to access the Anthropic API."`; the Moonshot fallback account is suspended for
> the same reason. The code is behaving correctly — it latches, waits out a 30-min cooldown, retries,
> and re-latches. Passes 42 through 47 each re-derived this from scratch, and passes 43/46/48 each
> re-confirmed it live. That is six passes spent on one already-answered question.
>
> `loop:sweep` now names this condition in a banner ABOVE the alarms section, and the
> `AgentClientLatchedUnfundedAccount` rule carries severity `warning` on purpose so it annotates
> instead of blocking. **A pass that sees that banner is done with the subject.** The one-command
> re-confirmation, if you want it, is `agent_client_latch_cause` on the metrics endpoint — the child
> reading 1 tells you the cause, and `insufficient_credit` means owner-blocked.
>
> **Fails CLOSED by construction, which is what makes the exemption safe:** the demotion applies only
> to a positive match on the provider's own credit-exhaustion error. A latch for ANY other cause —
> auth failure, an unrecognised fatal, a real code defect — classifies as `other`, keeps
> `AgentClientFatalLatch` at severity `critical`, and is a full incident under the rule above.
> **Generalise the shape, not the special case:** an alarm whose cause is recorded, whose remedy is
> outside what a pass may do, and whose signature is positively identified is annotated and named, not
> re-investigated. Any condition that does not meet all three tests is an incident.

The sweep's alarm kinds, read from `scripts/loop-sweep-core.mjs`'s `computeSweep`/`computeApp` (the
authoritative list — re-verify against that file before citing, per this playbook's own standing
rule). 24 kinds total as of this refresh (2026-08-06, Pass 65): the 12 liveness/venue alarms below,
plus the 12 DB-integrity kinds in their own group further down.

**Liveness and venue-health alarms:**

- `zero_decides` — decides/consult-gate liveness counters unchanged since watermark on a healthy
  boot (the 8.2h candle-stall class).
- `kill_switch_engaged` — kill-switch metric not RUNNING.
- `reconcile_halt` (per venue) — latest reconciliation `result=HALT` for that venue (never
  auto-flatten; spec §7). A HALT on one venue is never masked by the other venue's clean rows —
  the check is per-venue by construction, not a global "latest row" read.
- `reconcile_halt_in_boot` / `reconcile_halt_in_boot_unreadable` (per venue, added Pass 65,
  2026-08-06) — the current boot's COUNT of `result=HALT` rows, pinned to the resolved bootId.
  `reconcile_halt` above is a point-in-time read of ONE row, so a halt followed by any CLEAN row is
  invisible to it: **2155 lifetime HALT rows across 8 boots had produced exactly ZERO alarms**,
  including 427 on the boot that was live when this was written, during which the kill switch really
  did engage twice and the book was HALTED for 7h07m while the sweep reported a clean bill of health.
  Fires only when the count is readable, provenance-matched, `> 0`, AND the latest row is not itself
  the HALT — one episode raises one kind, never both. **Fails CLOSED** (health probe, not a
  measurement/veto gate): unreadable, unparseable, or carrying a stale bootId all raise the
  `_unreadable` kind rather than passing silently. Deliberately STICKY for the life of a boot — a
  halt is the most serious event class in this system (hard rule 6) and a redeploy clears it; it is
  boot-scoped precisely so it cannot wedge §3 permanently the way a fixed lookback would.
- `cost_breaker_proximity` — spend ≥80% of the ONE unified `$3/day` breaker
  (`AGENTIC_DAILY_COST_BREAKER_USD`, `.env.app`'s `AGENTIC_DAILY_COST_STOP_USD`). NOT raised on a
  container younger than `BUDGET_GAUGE_INIT_GRACE_MS` (5 min) whose `remainingUsd` reads exactly 0 —
  `agentic_budget_remaining_usd` is only `set()` on the lane's first budget evaluation, so a fresh
  boot's uninitialised 0 would otherwise read as "the entire breaker already spent". That case emits
  the `budget_gauge_uninitialised` ANNOTATION instead; past the grace window a 0 reading is real
  exhaustion and alarms as usual.
- `journal_silence` (per venue) — that venue's reconciliations journal produced no new rows since
  watermark while the container is healthy.
- `restart_storm` — more than `RESTART_STORM_THRESHOLD` (1) restart since watermark, i.e. it fires at
  ≥2 restarts (the R8-6 wedge-to-OOM class; a single restart is an ordinary redeploy, not an alarm).
- `reconcile_clean_stamp_stale` — `reconciliation_last_success_timestamp_seconds` older than 30 min
  (`RECONCILE_CLEAN_STAMP_STALE_MS`; added Pass 40, 2026-07-27; this list omitted it until Pass 44
  re-verified against the core). Read the GAUGE, never a `CLEAN` row age: `reconciliations.result` is
  written off the RAW mismatch total, so a row-age check fires forever on benign shared-wallet noise
  (WATCH-V4-1). A gauge reading exactly 0 (never stamped this boot) is aged from the container's
  `StartedAt` instead of the epoch, so a fresh boot gets the same runway as an established one; a
  negative or future-dated age (container/host clock skew) is NOT this alarm — it lands as a
  `probe_failed` ANNOTATION naming the skew, since an incoherent age is undetermined, not clean.
- `prometheus_alert_firing` (added Pass 43, 2026-07-28) — a **critical**-severity rule in
  `observability/alerts.rules.yml` is firing. The sweep reads Prometheus' own `/api/v1/rules`, so this
  alarm kind inherits every rule in that file, including rules written after the sweep code. Only
  `critical` becomes an alarm; `warning`/`info` land as `prometheus_alert_firing_nonblocking`
  annotations, because ≥1 rule was firing 58.4% of the last 7 days when this was measured and
  promoting those would wedge this very gate (`EffectiveModeLive` is severity `info` and fires
  permanently once live is armed). To make a warning blocking, raise its severity in the rules file —
  that judgement belongs there, not in the sweep. NOTE the probe's own positive controls: a stale rules
  file (a committed alert the running Prometheus never loaded), an unhealthy rule, or a rule group that
  has stopped evaluating all FAIL the probe rather than reading as "nothing firing".
- `venue_reject_rate_high` (per venue) — ≥20% (`VENUE_REJECT_RATE_ALARM_THRESHOLD`) of the most
  recent `VENUE_REJECT_WINDOW_SUBMITS` (20) SUBMIT_SENT events for that venue were rejected by the
  venue, once at least `VENUE_REJECT_MIN_SUBMITS` (6) submits exist in the window and the window is
  under `VENUE_REJECT_WINDOW_MAX_AGE_MS` (7 days) old — orders manufactured and thrown away, which
  every liveness counter in this sweep would otherwise read as a working lane. A determinate reading
  below the 6-submit floor is the `venue_reject_rate_undetermined` ANNOTATION, not a pass.
- `venue_reject_rate_unreadable` — the reject-rate probe failed, returned the wrong shape, or
  produced an incoherent submits/rejects pair for a venue. This is a HEALTH probe and fails CLOSED,
  unlike the forward-return measurement/veto-only gates, which fail OPEN.

**DB-integrity invariants (5 checks, 12 kinds, all fail CLOSED — added by `1f68d6f` on 2026-08-03):**
distinct from the liveness alarms above, these guard the durable Postgres journal itself rather than
process/container liveness. I3 (recomputing the round-trip walk) and I5 (equity reconciliation) were
deliberately left OUT of this set — I3 needs the TypeScript `walkRoundTrips` outside this stdlib-only
`.mjs`'s reach, and I5 carries a built-in demo/live frame residual that is expected to fire.

- `fill_ordering_violation` / `fill_ordering_unreadable` (W1) — a fill reads out of `venue_timestamp`
  order within its `(strategy_id, symbol)` ingestion group, breaking `walkRoundTrips`'
  (`domain/trading/risk/round-trips.ts`) prefix-determinism assumption — `fills` carries no
  append-only trigger, so nothing in the DB enforces ingestion order matching venue execution order.
- `unresolved_fill_intent` / `unresolved_fill_intent_unreadable` (I1) — any `fills.intent_id IS NULL`,
  which silently trips `PromotionReadinessService`'s `UNRESOLVED_FILL` reason with no series naming
  which fills, how many, or since when.
- `cum_qty_mismatch` / `cum_qty_mismatch_unreadable` (I2, WATCH-V4-4) — a terminal order's `cum_qty`
  disagrees with the exact `NUMERIC(38,18)` sum of its own fills' qty; the comparison runs inside
  Postgres, never brought into JS as a float.
- `unconvertible_fill_fee` / `unconvertible_fill_fee_unreadable` (I4) — a fill's fee is NULL, or its
  `fee_ccy` is neither the traded symbol's base nor quote asset — a fee the promotion gate cannot
  price into net PnL.
- `config_snapshot_missing` / `config_snapshot_unreadable` / `config_snapshot_shape_unknown` /
  `config_snapshot_drift` (W3) — the running promotion config (`PROMOTION_DUST_NOTIONAL` /
  `PROMOTION_EVIDENCE_EPOCH`) must match the newest `config_snapshots` row, tried against the flat
  env-var spelling, the flat camelCase spelling, and the nested canonical AppConfig location the
  writer actually stores (`agentic.promotionDustNotional` / `agentic.promotionEvidenceEpoch`,
  `src/ports/common/app-config.ts:128`, `:189`). A 0-row table, an unparseable/unrecognised row, and a
  genuine mismatch are each their own kind rather than one shared "drift" alarm.

`probe_failed` is technically an ANNOTATION kind in the core (not pushed to the `alarms` array — verify
by searching `loop-sweep-core.mjs` for `kind: 'probe_failed'` before treating it otherwise, never by
line range: this is the THIRD stale line-range citation on this exact sentence — first `:117-133`
pointed at `extractCounters`, then `~L182-220` rotted as the file kept growing pass over pass (632
lines when first measured, well past 1900 by 2026-08-03, and different again by the time this
sentence is next read), and a line-range citation would only rot again from here. Verified this pass: 10 push
sites, all into `annotations`, zero into `alarms`), but it still forces the same investigation
posture: a stack read errored, so nothing downstream of it can be trusted this sweep (§C.9
negative-read-void discipline).

**Read the annotations, not just the alarms — these kinds carry incidents the alarm list CANNOT show**
(added Pass 45, 2026-07-28, after a 49-min demo-fapi outage fired two rules and had fully resolved
before the pass ran, leaving the sweep reporting one unrelated alarm and naming the outage nowhere):

- `prometheus_alert_resolved` / `prometheus_alert_resolved_critical` — a rule that fired at some point
  in the last `ALERT_LOOKBACK_MS` (12h) and is no longer firing. Deliberately NOT alarms: a fixed
  lookback would make them sticky for 12h, and §3 blocks improvement work until an alarm clears, which
  history can never do. **A resolved critical is a defect investigation anyway** — treat it as one.
- `probe_voided` — a sibling of `probe_failed` with a distinct meaning: the probe itself SUCCEEDED, but
  a control it depends on did not, so its result carries no evidential weight. Today the only case is
  the alert history when the live rules probe failed: nothing is available to subtract currently-firing
  alerts against, so the list may name alerts that are firing right now. Treat as a failed read.
- `alert_window_partial` / `alert_window_unverified` — the retrospective control on the above. The live
  rules probe is present-tense; if Prometheus was down, restarted or host-slept inside the 12h window it
  wrote no `ALERTS` samples for that stretch, so "nothing fired" would be a hole wearing a passing
  control. Scrape coverage is measured against `up`; below 90% the window has gaps. **Positive findings
  still stand** — only the empty reading weakens.
- `log_window_short` / `log_window_unknown` — the warn scan is a fixed LINE tail, so a chatty INFO
  stream shrinks the TIME it covers. When it covers less than the alert lookback, warnings older than
  the stated span are UNREAD, not absent. Suppressed only when the tail reaches the container's own
  start (within 60s either way — docker does not truncate the log on an in-place restart, so a tail can
  legitimately predate `StartedAt`). `log_window_unknown` means no line carried a usable timestamp, so
  the warn count describes no span at all.

Before touching anything, run the §C defect-class triage — these are the shapes green surfaces hide.
Each is a named check with its catching probe:

1. Zero-delta-while-green — green health, healthy container, kill_switch RUNNING, yet zero
   decide/journal/counter deltas. Probe: positive watermark deltas from multiple independent
   counters; read the kill-switch metric + reconcile distribution, never `/health`.
2. Row-count-window shrink — a stats consumer's verdict flips as row volume grows (abstain
   false-positive, unreachable promotion floor). Probe: check window semantics first; shared
   `recent(N)` walks are forbidden; reads epoch-bounded.
3. Silent-catch/park — pending-forever promise, in-memory enum nothing exports, swallowed hot-path
   throw; emits no error line. Probe: hunt state-set-but-never-emitted seams; every gate logs AND
   meters its failure path before enable.
4. Structurally invisible divergence axis — a state/venue axis with no reconciler (Bug B's phantom
   perp position, pre-v3). Probe: on any new rail/venue/axis, name its reconciliation consumer or
   declare it unmonitorable.
5. Venue/ccxt shape divergence — code built on a declared shape the live venue returns differently
   (four incidents pre-v3). Probe: keyed live shape probe before any code depends on a new endpoint
   (#54 pattern).
6. Boot-scoped counters masquerading as cumulative — a counter "drops" across the window. Probe: pin
   every counter read to a bootId; `increase()` only within one boot's span (loop:sweep enforces).
7. Three-ledger divergence — gate metrics, the consult journal, and actual API spend disagree.
   Probe: reconcile all three before tuning any cadence knob; divergence is defect-until-disproven.
8. Attempt-level fail-open budget gate — post-breach blackout, `with_tokens=0` after the shared
   pool zeroes. Probe: check gates for pre-attempt reservation vs start-only; alarm on pool-zeroed
   states.
9. Negative-read voids — an empty grep/log/promtool result. Probe: every empty read is void unless
   paired with a positive control + a bootId-matched tail (`docker logs --since` never qualifies).
10. Unanchored log-time forensics — a defect narrative from timestamp comparison with no wall-clock
    anchor. Probe: `date -u` before any timestamp comparison (the §1 pre-step).
11. Fail-open polarity / config coercion — nothing at runtime until the bad branch is exercised
    (three defects survived every green pass pre-v3). Probe: adversarial polarity audit — state the
    failure direction, test the bad branch.
12. Non-consuming-trigger hot loop — attempt-started counters racing ahead of fire stamps; burn
    spikes in minutes (R8-8: 91 Opus calls / $2.30 in 46 min). Probe: compare attempt-started vs
    consumed-stamp counters per window; burst-rate alarms on spend.

An N-recurrences rule binds: a metric-visible anomaly seen across ≥2 sweeps is root-caused, never
normalized as background noise (the ~10-min STALE_DATA blackouts, the unflagged uptime churn).

## 4. Pass types and autonomy

When the sweep is clean, select exactly ONE pass type — highest-priority eligible. Priority:
correctness bugs on the trading path > promotion-ready evidence > candidate work > maintenance.

CANDIDATE is eligible only while today's authoring slot is UNSPENT: a UTC day whose
`playbook-authoring-attempt` row already exists in `public.experiments` falls through to MAINTENANCE,
and a pass that runs `loop:authoring` anyway gets a refusal rather than a second mint. That day slot
replaced the old "eligible only when no unresolved candidate sits in A/B" condition, which daily
minting makes permanently false (owner override,
`research/studies/candidate-routing-override-2026-07-31.md`). The ceiling is enforced in code, so a
pass need not — and must not — decide for itself whether it has already run today; ask the gate.

Pass-type selection governs the IMPROVEMENT the pass chooses. It never gates defect repair: any
defect found along the way is fixed in this pass on top of the chosen type (§ DEFECTS ARE NEVER
DEFERRED). A pass whose defect work crowds out the improvement entirely says so in LOG.md — and if
that happens on consecutive passes, the report recommends what to change about the system so passes
stop being consumed by repair, because repair is not what this loop is for.

Autonomy (owner 2026-07-17): ALL demo money-path work — risk, execution, OMS, exchange adapters,
defect fixes AND new capability — is loop-domain. Measurement, config, and deploy decisions are
loop-domain too: decide, apply, record — do not flag. The live-money flip (four gates + bootId
arming ceremony) is the ONLY human gate. Evidence gates stay in full force.

Loop-domain work carries: mandatory adversarial reviewer dispatch before commit (multi-lens for
OMS-semantics); full gates + `test:livegate` + `test:paper` green; deploy soak per §5; a dated
decision record + a WATCH line (full text in `research/loop/watches.md`, one line in
`research/loop/STATUS.md`; change-discipline shape — every WATCH carries an
explicit expected-positive signature, a named defect outcome, and a resolution deadline/owner-pass);
behavior-changing capability additionally ships two-step (code flag-off, then a separate enable
commit with its own review).

### DEFECTS ARE NEVER DEFERRED (owner, 2026-07-27 — this overrides everything below it)

**This loop is a profitability engine. It is not a bug tracker, and it is not a maintenance run.**
A defect the pass finds is fixed IN that pass — however many there are, and regardless of which
subsystem they touch. There is no "next pass will take it", no ranked defect queue, no defect rows
in the backlog. The backlog holds **profitability work ONLY**.

The one-money-path-item-per-pass limit applies to **improvements and new capability** — things the
pass chose to build. It has never applied to defect fixes and MUST NOT be used to justify deferring
one: a pass that finds five defects fixes five defects, each as its own commit, each with its own
review, gates, and soak. (This rule was written down because Pass 40 did exactly the wrong thing —
it shipped two fixes, then deferred four more defects to "the next pass's ranked work" by citing the
per-pass limit. Owner correction, verbatim: "do not defer defects … those must get fixed immediately
if possible".)

The ONLY sanctioned deferral is a fix that cannot be made without crossing the MUST-NOT rails below
(live gates + arming, append-only tables, secrets/redaction). That one goes to "Flagged for human
review" with evidence + the exact proposed diff — never to the backlog.

If a defect genuinely cannot be fixed in the pass, that is a **blocked** state, not a scheduling
choice: say so explicitly in LOG.md with the specific blocker (missing capability, missing owner
credential, an unreproducible shape), not with a priority argument. "It was a big change" and "the
pass already shipped something" are not blockers.

Pass types, reframed for the unified book:

- CANDIDATE — run `pnpm loop:authoring`, AT MOST ONCE PER UTC DAY. The pass does NOT hand-draft and
  does NOT hand-score: the script drafts, validates against the real `validatePlaybook`, scores
  through the playbook-space replay engine, logs EVERY scored variant (winners AND losers) to
  `public.experiments`, gates on the deployment bar, and mints via `playbook:candidate` — end to end,
  in that order. A pass that drafts a variant by hand is not doing this pass type; it is doing a
  superseded one.

  **The once-per-UTC-day ceiling is MECHANICAL, not remembered.** `classifySameDayGate`
  (`scripts/loop-authoring-core.mjs`) refuses a second run on a `playbook-authoring-attempt` row
  already written for the current UTC day, and the day boundary comes from the **DATABASE clock, not
  the host's** — this stack runs on a laptop that sleeps, so a host-derived UTC midnight is a skewed
  boundary. The gate sits after the cheap preconditions (stale dist, unreachable DB, unresolvable
  incumbent, retired-objective assertion, split-brain guard) so an environmental failure does not burn
  the day's slot, and before the first paid drafting call so it actually bounds spend. There is **no
  override flag** — an escape hatch would turn it back into a rule a pass can forget. `--dry-run` is
  exempt (spends nothing, writes nothing); `--draft-file` is NOT (it still spends the full stage-4
  replay budget).

  **`MINT GATE: REFUSED` on a measured bar IS this pass working, not failing.** The deployment bar is
  "beats the currently running playbook on the same corpus, metric and horizons"; most drafts will not.
  Record the refusal and its blockers verbatim in LOG.md, with the experiments-registry row ids of
  every scored variant — a refusal that was measured and logged is the pass's deliverable, and a pass
  that reports a refusal as an incident is misreading it. The pass exits 0 on that path deliberately.

  Daily minting is an OWNER DECISION that overrode Pass 51's "set `AGENTIC_PLAYBOOK_AB_PCT=0` and
  withhold v12" — read `research/studies/candidate-routing-override-2026-07-31.md` before acting on
  the routing knob. § 4 of that record is binding: executing the override requires NO env edit, and a
  pass that "tidies up" the dead-looking 40% knob silently cancels it. Its § 6 is binding too — the
  A/B split is a deterministic time pattern, not randomization, so no pass may quote a v12-minus-v10
  delta as a causal effect.

  Host invocation (`.env.app:294` names the compose-internal host `postgres`, which does not resolve
  from the host — hence `127.0.0.1`; and the registry write needs both variables, spelled IDENTICALLY
  or the split-brain guard refuses, which is why they come from one shell variable):

  ```bash
  DB=postgres://cryptobot:cryptobot@127.0.0.1:5432/cryptobot   # .env.app:294, host swapped
  DATABASE_URL="$DB" REGISTRY_DATABASE_URL="$DB" REGISTRY_ALLOW_PRODUCTION_DB=1 \
    corepack pnpm --dir <repo> loop:authoring --label "authoring-$(date -u +%F)"
  ```

  `REGISTRY_ALLOW_PRODUCTION_DB=1` is required and expected: the registry IS the production
  `public.experiments` table, and the flag exists to make the operator name that target deliberately
  (`scripts/log-eval-experiment.mjs` header). One playbook lineage — no per-venue split. The live A/B
  and its attributed auto-promotion take over; a candidate pass never manually promotes.
- PROMOTION — eligible when a live candidate has enough attributed round trips. Verify the
  evaluator's verdict against `agentic_version_net_pnl_usd{version}` /
  `agentic_version_round_trips{version}`, walked over the ONE book (no lane split to reconcile).
  Manual `playbook:promote` ONLY when auto-promotion is legitimately stuck (record why). Rollback
  via `AGENTIC_PLAYBOOK_PIN`.
- MAINTENANCE — default. The current stage's open items; the backlog (re-verify each against current
  code before implementing — inherited items go stale); new ideas from today's evidence (add to
  backlog even when not chosen). Note this pass type is NOT where defects live: trading-path
  correctness bugs are repaired in whatever pass finds them, not scheduled into a maintenance slot,
  and the backlog they are never added to is profitability-only.

Scanner/menu shape (spec §5): one `UniverseScannerService` ranks the combined 40-symbol basket (24
spot + 16 perp) — score = 24h-quote-volume rank × ATR% rank, cross-venue-comparable by
construction. `AGENTIC_ACTIVE_MENU_SIZE=8` (menu-8 cross-venue scanner), sized against the combined
promotion pacing derived in spec §5.2: ≥30 closed round trips over ≥14 trade-anchored days ⇒
≥2.14 closed trips/day; at menu-8 and the planning-band 12-24 wakes/day, expected entries/day run
4.8-9.6 (≥2.2× the pace floor) against the unified $3/day breaker (menu-8 × 16 wakes ≈ $2.40/day).
A pass reviewing menu/cadence math re-derives it from spec §5.2 rather than trusting this summary
verbatim — the arithmetic depends on live entry-fraction and per-wake cost measurements that drift,
and note that it is derived at `menuSize`, not at live menu cardinality (see the venue-floor note
below): `isActive()` gates LLM spend per symbol directly (`batching-agent-client.ts:133`), so at a
live count above 8 this estimate under-states actual per-wake cost.
Venue-floor-2 watch (spec §5.3): the floor is evaluated AFTER ranking, hysteresis retention, and
pinning — against the post-pin active set, not the fresh top-8 (`universe-scanner.service.ts:373`
filters `candidateActive`, which pinning at `:350-354` already populated; the code's own comment at
`:360` documents this ordering deliberately). Live menu size is therefore `menuSize` + pins +
hysteresis-band overflow, unbounded above by the pin set — an open-position/resting-order symbol is
ALWAYS active independent of rank or hysteresis, "a position must never lose its consult" (`:350-352`)
— not the `menuSize`+2 ceiling an earlier draft of this doc claimed; the live menu holds 14 symbols
(8 ranked plus 6 pinned) at time of writing. A pass must confirm neither venue is starved of menu slots across a
sustained ranking run; the floor only ever ADDS symbols (fails OPEN toward coverage), so its absence
from a digest is not itself alarming, but a sustained one-venue rank sweep with zero floor
promotions on the OTHER venue when that venue's raw ranks are genuinely outside the post-pin active
set is the signature to watch for.

Capability-violation counter watch: `agentic_capability_violations_total{kind}` — an `open_short`
proposed against a spot symbol (`capabilities.shorts=false`) degrades to `hold`, journals
`action=error`/`capability_violation:open_short_on_spot`, and increments this counter (spec §4.3,
named-degrade discipline, never silent). A non-zero count is not itself a HALT-class alarm but is a
finding: it means either a prompt/mandate defect (the model attempting shorts on a non-perp symbol)
or a capability-map bug — re-verify `capabilities.shorts` wiring for the symbol before dismissing it
as model noise.

Playbook lineage / A/B: one lineage now (seed v1, `SEED_PLAYBOOK_V3`) — the champion/candidate A/B
mechanism itself is UNCHANGED from the pre-v3 shape (`AGENTIC_PLAYBOOK_AB_PCT`, attributed
auto-promotion, symmetric 10-trip floors); what changed is there is no longer a second, separate
per-venue lineage to reconcile.

Pre-authorizations fire ONLY on their stated conditions and are then CONSUMED — no scope drift.
Re-verify every inherited pre-auth against the current (v3) code and config before firing it — the
v3 rebuild deleted some of the config surface pre-auths were written against (e.g.
`AGENTIC_SHORTS_ENABLED` no longer exists; shorts are a per-symbol capability derived from venue,
spec §3.4); a pre-auth whose trigger references a deleted knob needs re-expression against the
current mechanism before it can fire, not a literal application of stale text.

If nothing clears the bar, ship nothing — record why. Two consecutive UTC days of all-empty passes
→ recommend a cadence/scope change in the report instead of forcing one.

MUST NOT touch (report-only, with evidence + exact proposed diff): the four live gates, mode
resolution, arming interlock, `test:livegate` (sacred); append-only tables/triggers (`audit_log`,
`order_events`, `funding_events`, `funding_payments`, `experiments`) and money-table schema/
migrations; secrets, `.env` (the example file is fine), pino redact lists. `PROMOTION_EVIDENCE_EPOCH`
is loop-domain (declare only at a verified flat instant, over the ONE book — no per-venue epoch
split anymore), but never mid-window. Hard rules 1-7 in the project `CLAUDE.md` bind in full. Never
push to any remote; commit gates-green work to local `main`, one commit per improvement,
conventional message. Dirty tree at pass start: note it, stage ONLY files this pass authored
(`git add <paths>`, never `-A`/`-u`).

### 4.6 Fan-out declaration and lane discipline

A pass MAY fan a §3 investigation or a §4 improvement out to parallel sub-agents. The gap this
section closes is not detection — both recorded fan-out incidents so far were detected and honestly
reported. The gap is a **declared denominator**: nothing recorded what lanes were declared before
dispatch, so a partial fan-out reads identically to a complete one, and no later pass could falsify a
completion claim. `scripts/loop-fanout.mjs` (`pnpm loop:fanout declare|join`, core in
`scripts/loop-fanout-core.mjs`) fixes that; this section is the procedure around it.

- **The orchestrating pass exclusively owns the four loop files (`research/loop/STATUS.md`,
  `LOG.md`, `verdicts.md`, `watches.md`) and `loop:sweep`.** This is currently written down nowhere
  else. Two concurrent sweeps corrupt the watermark every delta in `loop-sweep-core.mjs` is computed
  against — a lane never runs `loop:sweep`, and no lane touches a loop file; the orchestrator writes
  the report and the state at §6, after the join, once.
- **One lease per pass; lanes never call `loop:lock`.** The pass lease taken at §1 step 3 already
  covers the whole working tree for the whole pass, fan-out included — a lane taking its own lease
  would either collide with the pass's own lease or silently expire it early.
- **Read-only research dispatches to an agent type carrying no write tools — never
  `general-purpose`.** A §3 investigation lane must not be able to touch the working tree at all.
  This rail existed only inside `research/loop/archive/LOG-through-pass-47.md` (Pass 48's finding: a
  research agent dispatched as `general-purpose` wrote to the tree despite a read-only instruction;
  two out-of-scope files were reverted, copies quarantined) — an archive nothing reads by default.
  Surfacing it here is half the value of this section.
- **Declare before dispatch.** Write the lane roster — `[{ "name": "...", "scopes": ["..."] }, ...]`
  — to a scratch file and run `pnpm loop:fanout declare --file <path>`. A trailing `/` on a scope
  means "this subtree"; without one the scope names exactly one path, never its children (no globs —
  see the core's header for why). `declare` **exits non-zero** on any pairwise scope overlap between
  lanes or any lane claiming an `ORCHESTRATOR_OWNED` path (the four loop files above, `package.json`,
  `.env.app`, the `observability/` configs, and the toolchain configs — `tsconfig*.json`,
  `eslint.config.mjs`, `.prettierrc`/`.prettierignore`, `.markdownlint-cli2.jsonc`) and writes
  nothing on refusal. The toolchain configs are the nastiest race: agent A editing
  `eslint.config.mjs` mid-flight silently changes what agent B's leaf-scoped `pnpm lint` MEANS, so
  B's later green is not evidence of anything.
- **Leaf-scoped validation while peers are in flight.** Each write lane runs only its own spec (and
  `lint`/`format:check` scoped to the files it touched) before reporting back — a full `pnpm test`
  or `pnpm checks` mid-fan-out measures the peers' in-flight edits, not the lane's own change, and a
  red result could belong to anyone.
- **No commits until the join.** The husky pre-commit hook validates the WHOLE repo, so a hook
  failure naming a file the current lane never touched is a **straggler** — a peer's file, not a
  defect in this lane's work — and is never "fixed" by the lane that hit it. Wait for the join, then
  commit once the roster confirms every lane that needs to land has actually returned. A straggler
  hook failure does not count toward §5's 3-consecutive-validation-failure cap, which is a
  count on THIS lane's own work — a peer's mid-edit file failing someone else's hook run is not one
  of those three.
- **One re-dispatch per lane.** A lane that dies silently (no report, no error) gets one re-dispatch,
  decomposed into smaller steps. A lane that returns but breaks its output contract (wrong shape, no
  evidence, claims without artifacts) gets one re-dispatch, re-issued contract-free (plain
  instructions, no schema to satisfy). A lane that stalls (no response within the pass's own budget)
  is **stopped before the join** — never left running past it, and never joined as if it had
  returned.
- **§3 investigations fan out read-only; §4 improvements fan out with write lanes.** A single pass
  never mixes the two in one fan-out: a read-only investigation roster carries no `ORCHESTRATOR_OWNED`
  conflicts by construction (nothing is being written), while a write roster is exactly what
  `declare` exists to police.
- **Join, then disclose.** `pnpm loop:fanout join <lane-name> [<lane-name> ...]` (the names of lanes
  that actually returned) always exits 0 — it is a reporting step, not a gate — and prints a
  copy-pasteable line naming any declared lane that did not return. That line goes into the LOG.md
  entry verbatim; a pass that omits it is not entitled to claim the fan-out complete.

**Two refutations, so no future pass re-derives them:**

1. **Per-agent git worktrees — REFUTED, already tried here.** `.claude/worktrees/` exists and is
   empty. It left a permanent scar at `vitest.config.ts:8-10` (excluding `**/.claude/**` from the
   test glob) and three sibling excludes (`.markdownlint-cli2.jsonc`, `.prettierignore`,
   `eslint.config.mjs`, commit `4ffd668`, 2026-07-10): without them, eslint crashed on project-less
   files, markdownlint re-linted archived copies, prettier re-checked everything, and vitest
   positional filters matched the copies too (5× test counts) — the same four tools the pre-commit
   hook runs on every commit. `node_modules` is 432 MB and is not shared by `git worktree`, so N
   worktrees pay that cost N times. The disqualifier: there is **one** Postgres for this stack, so N
   worktrees do not get N databases — they get N resets of the SAME one, which worktrees make *look*
   isolated while leaving them exactly as shared as a single tree.
2. **A retry wrapper as code — structurally impossible.** A node script cannot dispatch, observe, or
   kill a Claude sub-agent; it can only run after the fact on artifacts a lane chose to leave behind.
   The retry policy above (one re-dispatch, decomposed or contract-free, a stall stopped before the
   join) is procedure the orchestrating pass follows, not code this repo could ship.

Full lane-template text and worked declare/join examples: `docs/planning/loop-fan-out.md`.

## 5. Validate, then deploy

1. Gates (all green before commit): `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` — via
   `corepack pnpm --dir <repo>`, sandbox-disabled, `pipefail` on chains. An agentic-lane change also
   runs `pnpm eval:agentic`. `test:db` needs `DB_SUITE_ALLOW_RESET=1` +
   `DATABASE_URL=postgres://cryptobot:cryptobot@127.0.0.1:5432/cryptobot_test`. Report files gate on
   `pnpm lint:md` (markdownlint owns `.md`; the `research/loop/` backlog table is MD060-aligned —
   `--fix` does not repair it).
2. Cap: 3 consecutive validation failures → revert the working tree, record it, end the pass.
3. Deploy: `GIT_SHA=$(git -C "<repo>" rev-parse --short HEAD) docker compose -f "<repo>/docker-compose.yml" up -d --build app`
   — one build, one service; there is no `--profile perp` variant anymore (the perp compose profile
   and its three services were deleted at the v3 cutover, spec §9). Both `<repo>` placeholders are
   QUOTED because this repo's path contains spaces: unquoted, the `git -C` word-splits, exits
   non-zero with empty stdout, and — being an assignment prefix — takes that failure nowhere, so
   `${GIT_SHA:-unknown}` bakes the literal `unknown` and the deploy still succeeds. The `GIT_SHA`
   prefix is not bookkeeping: `up` rejects `--build-arg`, so the prefix is the ONLY mechanism that
   stamps `build_info{git_sha}`, and a prefix-less deploy loses the pass's record of which build
   served the window. `loop:sweep` annotates that as `build_provenance_void`
   (annotation, never an alarm). **If the pass touched `observability/alerts.rules.yml` or
   `prometheus.yml`, it MUST also run `docker compose up -d --force-recreate prometheus`** — that file
   is a read-only bind mount read once at process start, there is no `--web.enable-lifecycle` reload
   endpoint, and a plain `up -d prometheus` is a no-op. Skipping it is how the four alerts added
   2026-07-27 sat unloaded for 36h (Pass 43); `loop:sweep`'s `promAlerts` probe now names any committed
   alert the running Prometheus has not loaded.
   **Validating a rules edit: `promtool check rules /etc/prometheus/alerts.rules.yml` is VOID after any
   host-side edit of that file** and fails with a YAML "unexpected end of stream" that reads exactly
   like corruption. It is not — a single-FILE bind mount leaves the container resolving a dangling
   inode once the host replaces it (Pass 53 chased this; the committed bytes parsed fine and all 22
   running rules were healthy throughout). Check the edit by copying it in first:
   `docker cp "<repo>/observability/alerts.rules.yml" crypto-bot-prometheus-1:/tmp/new-rules.yml &&
   docker exec crypto-bot-prometheus-1 promtool check rules /tmp/new-rules.yml`. After the recreate,
   confirm the count moved via Prometheus' own `/api/v1/rules`, not via the mounted path.
4. Soak (15-30 min): run `loop:sweep` post-deploy and confirm the change's expected observable
   named in its WATCH line — health 200, decides flowing on both venues, no `EXPIRED` signals, cost
   rate sane against the ONE $3/day breaker, no new alarm, protective exits present. Regression →
   redeploy the previous image (or revert), record the rollback. A green suite is not a soak — the
   W4 reconciliation fix minted R8-7 while 2452/2452 tests passed.

## 6. Report and state (every pass, even empty ones)

1. Append a dated entry to `research/loop/LOG.md`: data window, headline metrics (gate scoreboard +
   $/day against the ONE breaker) + WATCH-V3-1 status (spot heap slope: paper plateau ~673MiB
   reference, a demo-mode sustained climb past ~900MiB before soak end is a defect signal), pass
   type, decision + rationale, diff (files + commit hash), gate results, soak verdict, flagged
   items, next-pass candidates. CANDIDATE passes record the experiments-registry row id of EVERY
   scored variant (honest-N).
2. Update `research/loop/STATUS.md` — it is the file the NEXT pass reads, and the only one it is
   guaranteed to read: current order & status (live build/boot, the book, the promotion scoreboard,
   what is deployed, last-pass pointer), the open WATCH lines ONE LINE EACH, the backlog table, the
   open flagged items. Anything longer than a line goes to the file that owns it — `charter.md` (a
   new owner decision, grant or pre-authorization), `verdicts.md` (a new binding do-not-re-derive
   verdict), `watches.md` (a new or changed WATCH, a new flagged item) — and STATUS keeps the
   one-liner plus the pointer. **STATUS.md is capped at 200 lines: if an edit pushes it over, move a
   body out, never trim the fact.** Keep STATUS + LOG current enough that the next pass needs
   nothing else at start.
3. **Rotate, so the hot files cannot grow without bound again.** `LOG.md` keeps only the LAST FIVE
   pass entries. When this pass's entry makes six, move the OLDEST verbatim to
   `research/loop/archive/LOG-through-pass-47.md` — appended at the end, chronological order
   preserved, byte-identical. Nothing is ever deleted from a loop file: content MOVES, and a pointer
   is left where it was. This rule is the actual fix for rehydration cost; a one-off compaction just
   re-grows (`state.md` reached 1,932 lines and `LOG.md` 5,886 under the old 30-day rule).
4. `pnpm lint:md` green after writing LOG.md/STATUS.md (markdownlint owns `.md`; the STATUS backlog
   table is MD060-aligned — `--fix` does not repair it).
5. `corepack pnpm --dir <repo> loop:unlock <nonce>` — release the pass lease taken at §1 step 3,
   using the nonce that step printed. Last action of the pass, after the report is written. A pass
   that TOOK the lease releases it, including one ending early; a pass REFUSED at §1 step 3 never
   holds it and must not try.

## 7. Stop conditions (report-only, change nothing)

- Kill switch tripped, reconciliation HALT on either venue, or any reconciliation mismatch (never
  auto-flatten).
- Unexplained drawdown (equity move the fills don't account for) — one book, one equity curve now.
- The gate scoreboard contradicts the DB/logs — measurement can't be trusted; fixing measurement
  becomes the only eligible improvement.
- Context usage >70% mid-pass → dispatch `context-transfer` for HANDOFF.md, finish the report with
  what is known, end the pass.

## Current program context (2026-07-21)

Volatile — re-verify against current code before citing (verify-before-cite is this playbook's own
standing rule).

- **Program status:** v3 one-book consolidation program (`plans/2026-07-v3-consolidation-spec.md`,
  owner plan `how-can-we-save-snuggly-grove`) BUILD COMPLETE and gated on `main` — commits `4178b6a`
  (config), `64e588a` (schema), `d351cbc` (checkpoint), `08f23c2` (streams), `cef43ee` (tool
  contract), `36071e5` (wiring), `20762a9` (assembly), `a7be88b` (gate fixes); `app.module.ts`
  2,427→72 lines, one process/one book/4-container compose
  (`research/loop/archive/state-2026-07-30.md`, 2026-07-21 record). Footprint
  verdict: e2-medium PASS — full 40-symbol dual-venue graph, live feeds, 15-min host paper boot: RSS
  plateau ~673MiB flat, health 200 throughout, `--max-old-space-size=1024` held.
- **Cutover status: RECORDED AND LIVE since 2026-07-21** (`research/loop/archive/state-2026-07-30.md:59`);
  its pre-cutover gates — Grafana Overview strip and the dashboard-regression pass — landed in
  `8014a1d`. The stale "NOT YET RECORDED" text that stood here was corrected Pass 65 (2026-08-06)
  together with the freeze banner at the top of this document; both had been contradicted by the
  loop's own CANDIDATE passes for six weeks.
- **Evidence epoch:** `PROMOTION_EVIDENCE_EPOCH` is ONE knob now (no per-venue split); `.env.app`'s
  current value is explicitly marked "RE-STAMP AT CUTOVER — do not treat this value as final" — a
  pass must NOT walk the promotion scoreboard against it until the cutover re-stamp lands.
  Declaring the re-stamp itself is loop-domain (declare only at a verified flat instant, one stamp
  for the whole book).
- **Cost breaker:** ONE unified `AGENTIC_DAILY_COST_STOP_USD=$3/day`
  (`AGENTIC_DAILY_COST_BREAKER_USD` in `loop-sweep-core.mjs`, verified against `.env.app:96`) — the
  prior per-lane `$1.50 spot + $1.50 perp` split is retired. Breaker exhaustion mid-day → economize
  via prompt/cadence, never raise the breaker.
- **Universe:** 40 symbols (24 spot + 16 perp), one `VENUES` list
  (`binance`+`binanceusdm`, `.env.app:37`), menu-8 cross-venue scanner (§4 above).
- **Promotion gate:** ≥30 closed demo round trips AND positive net-of-cost PnL over ≥14 days,
  walked over the ONE book (`PromotionReadinessService`).

WATCH lines a pass must check (one line each in `research/loop/STATUS.md`, full text in
`research/loop/watches.md`; the pre-v3 lane-scoped WATCH-XA1/X2/XA6/XA7/X7-X8/Y2-Y3/X9 lines
describe the BUILD that led here and are historical record, not standing checks against the current
build — they stayed with their decision records in `research/loop/archive/state-2026-07-30.md`):

- WATCH-V3-1 — spot heap slope on the demo soak: paper plateau ~673MiB is the reference; a
  demo-mode sustained climb past ~900MiB before the soak ends is a defect signal.
- Post-cutover, expect a fresh set of v4-era WATCH lines (evidence-epoch re-stamp confirmation,
  first cross-venue menu-8 consult, capability-violation counter baseline) — a pass finding none yet
  recorded should add them from its own sweep evidence rather than treating their absence as a gap
  in this playbook.
