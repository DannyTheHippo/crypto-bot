# Daily profitability loop — playbook (v3)

Audience: a Claude session executing one pass. Cadence: 2-4 passes/day (owner 2026-07-10 — the
loop runs on subscription, not a per-day API budget). Trigger (owner-run):
`/loop 1d Read docs/planning/daily-profitability-loop.md and execute one pass`, or a scheduled
routine. This document is the task spec for each pass; execute it top to bottom.

Mission: maximize net-of-cost PnL (`realizedPnl − fees − llmCostUsd`) toward the promotion gate.
Every pass runs §1 (rehydrate) and §2 (evidence sweep) unchanged; §3 is a hard gate — any named
sweep alarm forces defect investigation FIRST; only when the sweep is clean does §4 select ONE
pass type. This is an operational playbook, not application code. Rewritten 2026-07-20 (Y4) — the
prior v2 rotted against the stack (retired `agentic_prescreen_total`, expectancy-ladder MAY-knobs,
a $5/day breaker); a playbook is code that rots — re-verify every operational claim against current
code before citing it, and repair drift in the finding pass.

## 1. Rehydrate — from digest history, never a raw log window

Start every pass from the collector's durable history, NOT a 24h `docker logs` window (the
raw-window model is exactly what made R8-7's day-long spot-decide suppression invisible; Y1 §D).

Run all stack commands sandbox-disabled (`dangerouslyDisableSandbox: true`); never `cd` into the
repo (the fnm hook breaks) — use `git -C <repo>` / `corepack pnpm --dir <repo>` / PATH-prefixed
node. Host `psql` and host `curl` are auto-denied; do not attempt them.

Read in this order:

1. This playbook.
2. `date -u` — anchor wall-clock BEFORE any log forensics. Unanchored timestamp comparison
   fabricated a 40-minute phantom-bug chase (Y1 §C.10). Verify the clock before the code.
3. `corepack pnpm --dir <repo> loop:digests <last-pass-ISO>` — every collector digest line since
   the last pass (both the hot dir and `digests/archive/`). This is the rehydration base: per-cycle
   counter deltas, fired alarms, host duty-cycle gaps, bootId provenance.
4. `reports/loop/state.md` — the loop's only mutable memory: open WATCH lines, backlog, last-pass
   pointer, settled owner decisions (NOT re-openable by a pass — a pass that disputes one writes the
   argument into the report, never acts).
5. `git -C <repo> log --oneline -20` — what shipped since the last pass.
6. Project memory index (auto-loaded) — env quirks, validation recipes.

If the digest history has a host-sleep gap (annotated gap line), that window is dark — the stack
runs on a sleeping MacBook; check `pmset -g log`/`uptime` before suspecting a bug (Y1 §D host-state).

## 2. Evidence sweep — `pnpm loop:sweep` IS the sweep

Run `corepack pnpm --dir <repo> loop:sweep` (sandbox-disabled). It is the whole sweep — the
hand-run docker/promtool command list from v2 is RETIRED. The sweep is deterministic and
metrics/DB-first: host duty-cycle state, then per-lane provenance (container health + RestartCount +
StartedAt + bootId + git tip) BEFORE any counter, then bootId-pinned liveness deltas
(`agentic_consult_gate_total` by outcome, `agent_decisions` count + latest `created_at`, fills,
reconciliations tail, kill-switch state, ws forced-reconnects, RSS, LLM cost-vs-breaker proximity).

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
CANDIDATE/PROMOTION/MAINTENANCE-backlog) waits until the alarm is root-caused and cleared. The named
alarms:

- `zero_decides` — decides/journal frozen on a healthy boot (the 8.2h candle-stall class).
- `kill_switch_engaged` — kill-switch metric not RUNNING.
- `reconcile_halt` — latest reconciliation `result=HALT` (never auto-flatten; §7).
- `cost_breaker_proximity` — LLM $/day nearing the per-lane breaker.
- `journal_silence` — agent_decisions not advancing on a live boot.
- `restart_storm` — RestartCount climbing fast (the R8-6 wedge-to-OOM class; a single restart is an
  ordinary redeploy, not an alarm).
- `probe_failed` — a stack read errored (measurement gap; investigate before trusting the sweep).

Before touching anything, run the §C defect-class triage — these are the shapes green surfaces hide.
Each is a named check with its catching probe:

1. Zero-delta-while-green — green health, healthy containers, kill_switch RUNNING, yet zero
   decide/journal/counter deltas. Probe: positive watermark deltas from multiple independent
   counters; read the kill-switch metric + reconcile distribution, never `/health`.
2. Row-count-window shrink — a stats consumer's verdict flips as row volume grows (abstain
   false-positive, unreachable promotion floor). Probe: check window semantics first; shared
   `recent(N)` walks are forbidden; reads epoch-bounded.
3. Silent-catch/park — pending-forever promise, in-memory enum nothing exports, swallowed hot-path
   throw; emits no error line. Probe: hunt state-set-but-never-emitted seams; every gate logs AND
   meters its failure path before enable.
4. Structurally invisible divergence axis — a state/venue axis with no reconciler (Bug B's phantom
   perp position). Probe: on any new rail/venue/axis, name its reconciliation consumer or declare it
   unmonitorable.
5. Venue/ccxt shape divergence — code built on a declared shape the live venue returns differently
   (four incidents). Probe: keyed live shape probe before any code depends on a new endpoint (#54).
6. Boot-scoped counters masquerading as cumulative — a counter "drops" across the window. Probe: pin
   every counter read to a bootId; `increase()` only within one boot's span (loop:sweep enforces).
7. Three-ledger divergence — gate metrics, the consult journal, and actual API spend disagree.
   Probe: reconcile all three before tuning any cadence knob; divergence is defect-until-disproven.
8. Attempt-level fail-open budget gate — post-breach blackout, `with_tokens=0` after a shared pool
   zeroes. Probe: check gates for pre-attempt reservation vs start-only; alarm on pool-zeroed states.
9. Negative-read voids — an empty grep/log/promtool result. Probe: every empty read is void unless
   paired with a positive control + a bootId-matched tail (`docker logs --since` never qualifies).
10. Unanchored log-time forensics — a defect narrative from timestamp comparison with no wall-clock
    anchor. Probe: `date -u` before any timestamp comparison (the §1 pre-step).
11. Fail-open polarity / config coercion — nothing at runtime until the bad branch is exercised
    (three defects survived every green pass). Probe: adversarial polarity audit — state the failure
    direction, test the bad branch.
12. Non-consuming-trigger hot loop — attempt-started counters racing ahead of fire stamps; burn
    spikes in minutes (R8-8: 91 Opus calls / $2.30 in 46 min). Probe: compare attempt-started vs
    consumed-stamp counters per window; burst-rate alarms on spend.

An N-recurrences rule binds: a metric-visible anomaly seen across ≥2 sweeps is root-caused, never
normalized as background noise (the ~10-min STALE_DATA blackouts, the unflagged uptime churn).

## 4. Pass types and autonomy

When the sweep is clean, select exactly ONE pass type — highest-priority eligible. Priority:
correctness bugs on the trading path > promotion-ready evidence > candidate work > maintenance.

Autonomy (owner 2026-07-17): ALL demo money-path work — risk, execution, OMS, exchange adapters,
defect fixes AND new capability — is loop-domain. Measurement, config, and deploy decisions are
loop-domain too: decide, apply, record — do not flag. The live-money flip (four gates + bootId
arming ceremony) is the ONLY human gate. Evidence gates stay in full force.

Loop-domain work carries: mandatory adversarial reviewer dispatch before commit (multi-lens for
OMS-semantics); full gates + `test:livegate` + `test:paper` green; deploy soak per §5; a dated
decision record + a WATCH line in state.md (change-discipline shape — every WATCH carries an
explicit expected-positive signature, a named defect outcome, and a resolution deadline/owner-pass);
behavior-changing capability additionally ships two-step (code flag-off, then a separate enable
commit with its own review). Never two money-path items in one pass. Bugs are NEVER backlog material
— a defect found by a pass is fixed IN that pass; the only sanctioned deferral is a fix that exceeds
the MUST-NOT rails below, which goes to "Flagged for human review" with evidence + exact diff.

Pass types:

- CANDIDATE — eligible only when no unresolved candidate sits in A/B. Draft 1-3 playbook variants
  in-session grounded in sweep evidence (each rationale cites a specific metric/row, never a hunch);
  score each offline (`AGENTIC_CANDIDATE_PLAYBOOK_FILE=<file>` against
  `recorded-payload-live-compare.spec.ts`, ≤$20/gate); log EVERY scored variant (winner and losers)
  to the experiments registry; inject only the best if it beat the champion
  (`playbook:candidate <file> --metrics <scorecard.json>`). The live A/B + attributed
  auto-promotion take over — a candidate pass never manually promotes.
- PROMOTION — eligible when a live candidate has enough attributed round trips. Verify the
  evaluator's verdict against `agentic_version_net_pnl_usd{version}` /
  `agentic_version_round_trips{version}`. Manual `playbook:promote` ONLY when auto-promotion is
  legitimately stuck (record why). Rollback via `AGENTIC_PLAYBOOK_PIN`.
- MAINTENANCE — default. Trading-path correctness bugs (outrank everything); the current stage's
  open items; the backlog (re-verify each against current code before implementing — inherited items
  go stale); new ideas from today's evidence (add to backlog even when not chosen).

Pre-authorizations fire ONLY on their stated conditions and are then CONSUMED — no scope drift. The
live example: the X2 stage-2 flip (16 symbols / menu-6) may be applied after one clean 24h soak
inside ceilings (CPU <250% combined, RSS <2GiB/lane, zero 1008 mass-closes, recreations under half
the rolling cap) — UNFIRED as of 2026-07-20.

If nothing clears the bar, ship nothing — record why. Two consecutive UTC days of all-empty passes
→ recommend a cadence/scope change in the report instead of forcing one.

MUST NOT touch (report-only, with evidence + exact proposed diff): the four live gates, mode
resolution, arming interlock, `test:livegate` (sacred); append-only tables/triggers (`audit_log`,
`order_events`) and money-table schema/migrations; secrets, `.env` (the example file is fine), pino
redact lists. `PROMOTION_EVIDENCE_EPOCH` is loop-domain (declare only at a verified flat instant),
but never mid-window. Hard rules 1-7 in the project `CLAUDE.md` bind in full. Never push to any
remote; commit gates-green work to local `main`, one commit per improvement, conventional message.
Dirty tree at pass start: note it, stage ONLY files this pass authored (`git add <paths>`, never
`-A`/`-u`).

## 5. Validate, then deploy

1. Gates (all green before commit): `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` — via
   `corepack pnpm --dir <repo>`, sandbox-disabled, `pipefail` on chains. An agentic-lane change also
   runs `pnpm eval:agentic`. `test:db` needs `DB_SUITE_ALLOW_RESET=1` +
   `DATABASE_URL=postgres://cryptobot:cryptobot@127.0.0.1:5432/cryptobot_test`. Report files gate on
   `pnpm lint:md` (markdownlint owns `.md`; the `reports/loop/` backlog table is MD060-aligned —
   `--fix` does not repair it).
2. Cap: 3 consecutive validation failures → revert the working tree, record it, end the pass.
3. Deploy: `docker compose build app && docker compose up -d app` (perp needs
   `--profile perp build app-perp`).
4. Soak (15-30 min): run `loop:sweep` post-deploy and confirm the change's expected observable
   named in its WATCH line — health 200, decides flowing, no `EXPIRED` signals, cost rate sane, no
   new alarm, protective exits present. Regression → redeploy the previous image (or revert), record
   the rollback. A green suite is not a soak — the W4 reconciliation fix minted R8-7 while
   2452/2452 tests passed.

## 6. Report and state (every pass, even empty ones)

1. Append a dated entry to `reports/loop/LOG.md`: data window, headline metrics (gate scoreboard +
   $/day), pass type, decision + rationale, diff (files + commit hash), gate results, soak verdict,
   flagged items, next-pass candidates. CANDIDATE passes record the experiments-registry row id of
   EVERY scored variant (honest-N).
2. Update `reports/loop/state.md`: current stage, backlog with statuses, last-pass pointer, open
   WATCH lines, flagged items awaiting the owner. Keep both files current enough that the next pass
   needs nothing else.
3. `pnpm lint:md` green after writing LOG.md/state.md.

## 7. Stop conditions (report-only, change nothing)

- Kill switch tripped, reconciliation HALT, or any reconciliation mismatch (never auto-flatten).
- Unexplained drawdown (equity move the fills don't account for).
- The gate scoreboard contradicts the DB/logs — measurement can't be trusted; fixing measurement
  becomes the only eligible improvement.
- Context usage >70% mid-pass → dispatch `context-transfer` for HANDOFF.md, finish the report with
  what is known, end the pass.

## Current program context (2026-07-20)

Volatile — re-verify against current code before citing (Y4 verify-before-cite). Corrected metric
names: the consult counter is `agentic_consult_gate_total` (v2's `agentic_prescreen_total` is
retired); expectancy-ladder MAY-knobs are retired.

- Live build: v2 contract + the XA activation bundle (XA1-XA6) + X6/X7/X8 + X2 stage-1, both lanes.
- Evidence epochs (`PROMOTION_EVIDENCE_EPOCH`): spot `2026-07-20T09:36:00Z`, perp
  `2026-07-20T10:42:00Z`. The scoreboard walks only post-stamp evidence; a pre-stamp trip/spend in
  the walk is a defect.
- Cost breakers: `$1.50/day` spot, `$1.50/day` perp (post-X2). Breaker exhaustion mid-day →
  economize via prompt/cadence, never raise the breaker.
- X2 stage-1: perp universe 8 symbols (BTC ETH SOL ZEC AAVE NEAR HYPE KAITO), menu-4, fraction
  0.35. Stage-2 pre-auth (16/menu-6) UNFIRED — see §4 conditions.
- Promotion gate: ≥30 closed demo round trips AND positive net-of-cost PnL over ≥14 days
  (`PromotionReadinessService`).

WATCH lines a pass must check (full text in state.md):

- WATCH-XA1 — ≥8 batched consults/day for 3 awake days at ≤$1.50.
- WATCH-X2 — ≥1 closed perp trip/day once entries begin; a funding row lands within one poll
  interval of a held-across-boundary position; batch soft-hold rate stays <5% of elements.
- WATCH-XA6 — zero 1008 mass-closes; forced-reconnect rate ≤ R8-2 baseline; spot RSS trend flat
  (level 1.34GiB accepted; >20% growth between sweeps without a deploy = R8-6 precursor); no
  STALE_DATA veto storm on active-menu symbols.
- WATCH-XA7 (spot) — the scoreboard walks only post-09:36Z evidence.
- WATCH-X7/X8 — the first reflection on this build renders postMortems + versionPnl blocks;
  versionPnl shows all-unattributed until post-stamp trips close (expected, not a defect).
- WATCH-Y2/Y3 — the first scheduled pass rehydrates from `loop:digests` and runs `loop:sweep`;
  the collector survives the next host sleep with an annotated gap.
