<!-- Moved 2026-07-24: reports/loop → research/loop (repo organization). Historical path refs inside remain as narrative. -->

# Daily profitability loop — state

Playbook (durable procedure): `docs/planning/daily-profitability-loop.md`

This file holds CURRENT state only — strategic frame, stage, backlog, open flags, latest pass.
Per-pass history lives in `reports/loop/LOG.md` (every pass has a dated entry). Compacted
2026-07-13 (owner-directed housekeeping, see the LOG entry of that date): pruned blocks survive
in LOG.md and git history; every open item below was re-verified against code that day.

Compacted again 2026-07-20 (Y4 state hygiene): resolved/superseded pre-2026-07-20 decision
records — the Push II program, Push 3 completion records, the v2 cutover / Round-8 / Y-series
records, the Last-pass narrative, the backlog closed ledger, and the resolved provenance index —
were MOVED VERBATIM to `reports/loop/archive/state-2026-07.md` (append-only; provenance list at
the foot of this file; the archive file itself is GIT-HISTORY-ONLY since the 2026-07-21 owner
prune — read it via `git show`). Nothing load-bearing pruned: all open WATCHes, pre-authorizations,
flagged defects, and standing verdicts remain here.

## Strategic frame

The mutable strategy the playbook deliberately does not embed. Passes update stage status here;
when the owner approves a new spec, replace the pointer (and archive the old spec) — the playbook
never changes for strategy evolution.

- **Active spec:** `docs/specs/2026-07-06-profitability-design.md` (owner-approved 2026-07-06;
  git-history-only since the 2026-07-21 prune).
- **Goal:** real live profitability at **$1k–$5k capital** (owner, 2026-07-06). Objective
  function: net-of-cost PnL = `realizedPnl − fees − llmCostUsd`.
- **Active frame (owner decisions 2026-07-10):** the LLM agentic lane is the program centerpiece —
  it trades AND self-learns. The daily loop (a Claude session on subscription, ~zero marginal
  cost) is the heavyweight researcher driving that self-learning: **"LLM proposes, backtest
  disposes."** Playbook v2 codifies the pipeline: draft candidate playbooks IN-SESSION → score
  offline (`AGENTIC_CANDIDATE_PLAYBOOK_FILE` recorded-payload live-compare eval, ≤$20/gate) → log
  EVERY scored variant (winner and losers) to the append-only experiments registry (migration
  0009, `test/backtest/experiment-log.ts`) → inject champion-beaters via `pnpm playbook:candidate`
  → live A/B (`AGENTIC_PLAYBOOK_AB_PCT`) + attributed auto-promotion decide. Cadence
  **2–4 passes/day**. The funding-carry sub-plan is resolved NO-GO (§ Standing verdicts).
- **Standing owner decisions 2026-07-10 (policy, still operative):** (1) no owner gate on redeploy
  — validated-better versions are committed AND deployed autonomously (demo/paper stack; ship
  criterion unchanged: gates green + out-of-sample/net-of-cost evidence + §5 soak); (2) the daily
  loop (or equivalent automated process) drives the program; (3) the ONLY human touch is the
  live-money flip — four live gates, bootId arming ceremony, promotion gate unchanged;
  (4) `BINANCE_DEMO_*` keys cover futures-demo (demo-fapi) testing.
- **OWNER DECISION 2026-07-12 (verbatim: "No owner decisions; this is your domain and the aim of
  these passes is profitability. Just do what you have to."):** demo-stack measurement and
  configuration decisions previously routed as owner proposals — evidence-epoch declarations
  included, and the named pre-authorizations below once their stated trigger conditions are met —
  are **loop-domain**: a pass decides, applies, and records the decision + rationale in
  LOG.md/state.md instead of flagging and waiting. This extends the 2026-07-10 decisions above;
  decision (3) is UNCHANGED — the live-money flip remains the sole human checkpoint, and the
  playbook §4 MUST-NOT boundaries (risk/execution/OMS semantics, live gates, append-only tables,
  secrets) are structural rails, not preferences — delegation does not relax them.
- **OWNER DECISION 2026-07-16 — bug-routing discipline (encoded in playbook §3):** the backlog,
  the loop, and similar mechanisms are NOT bug collectors — a bug found by a pass is FIXED in that
  pass; the backlog holds only improvements that move net-of-cost PnL or measurement trust. Fixes
  exceeding the §4 rails go to "Flagged for human review" as OPEN DEFECTS (evidence + exact diff),
  never to the backlog. Applied retroactively: #49 reclassified from backlog seed to § Flagged.
- **OWNER DECISIONS 2026-07-17 (interactive session; plan `should-we-not-just-elegant-locket`):**
  (1) **Full money-path delegation, encoded in playbook §4 — the ONLY owner gate in the program
  is the live-money flip.** Demo-lane risk/execution/OMS/adapter work — defect fixes AND new
  capability — is loop-domain under the standing discipline: mandatory adversarial reviewer
  dispatch, full gates + livegate/paper, deploy soak, decision record + WATCH, two-step enables
  for behavior-changing capability, never two money-path items per pass. The §4 MUST-NOT list
  shrinks to the live-flip/audit invariants (live gates + arming, append-only tables +
  money-table schema, secrets/redaction) — invariants on what a change may do, not gates on who
  approves it. Supersedes the 2026-07-07 scoped exceptions and the 2026-07-10 perp-venue
  owner-scope note. (2) Both § Flagged defects (perp phantom position; #49 atomicity) AUTHORIZED
  — sequenced, phantom first. (3) app-perp stays RUNNING until the fix deploys (containment
  holding per Pass 31). (4) Evidence gates re-affirmed exactly as pre-registered (promotion
  floors, factorial floor, shorts soak, watcher study) — no loosening; v2's runway is protected
  via config instead (lapse 168→336h, playbook A/B 25→40). (5) The 5→8 universe pre-auth is
  FIRED this session (see § Pre-authorizations).
- **OWNER DECISIONS 2026-07-20 (interactive session; plan `how-can-we-save-snuggly-grove`) — the
  v3 consolidation program.** (1) The two lane processes MERGE into one process trading ONE
  unified book (one portfolio/risk/kill-switch/equity, one promotion verdict, one playbook
  lineage, one batched cross-venue consult) — greenfield deploy, fresh DB, evidence clock
  restarts; only the ACTIVE playbook text carries over (folded into v3 seeds). (2) **v2 is FROZEN
  at tag `v2-final` (commit `2e49dfa`, full gate green: 2619 tests)**; branch `v2-maintenance`
  carries critical fixes only — rebuild the running image from that branch, never from main.
  main is v3 from the next commit onward. (3) **X2 stage-2 is CANCELLED on v2** — the 16-perp
  universe becomes v3's launch basket. (4) Scheduled passes are v2-maintenance-only until the v3
  local demo cutover (playbook banner); the v3 program executes in the owner's interactive
  session, not the loop. (5) Fixed capital split across the two wallets (default 500/500 of
  `SIZER_EQUITY_CAP`); one arming ceremony flips both venues (either venue's key validation
  failing refuses arming — fail CLOSED). (6) Deploy target after local soak: GCP e2-medium
  (X1-FINAL executes on v3; owner commits first, unchanged). Full decision ledger + design:
  the plan file and `plans/2026-07-v3-consolidation-spec.md` (spec lands next).
- **v3 BUILD COMPLETE + VALIDATION GATE (2026-07-21, owner session).** All seven workstreams
  landed on main (config `4178b6a`, schema `64e588a`, checkpoint `d351cbc`, streams `08f23c2`,
  tool contract `cef43ee`, wiring `36071e5`, assembly `20762a9`, gate fixes `a7be88b`):
  app.module.ts 2,427→72 lines, one process/one book/4-container compose. Full gate green at
  every step (final: 2672 unit+livegate, 64/64 test:db on live Postgres, lint/typecheck/format
  clean). **Footprint verdict: e2-medium PASS** — host paper boot, full 40-symbol dual-venue
  graph, live feeds, 15 min: RSS plateau ~673 MiB (flat), health 200 throughout,
  `--max-old-space-size=1024` held; projected 4-container stack ~1.7 GiB on a 4 GiB VM.
  `AppMemoryHigh` stays at 1.2 GiB for the demo soak; tighten toward plateau+30% (~0.9 GiB)
  after soak data. Stage-2 perp filters probe-verified (demo-fapi, 2026-07-21). Remaining
  before cutover (owner, 2026-07-21): Grafana overview row + principled dashboard-regression
  pass, aggressive stale-file cleanup (loop-core exempt), daily-loop playbook v4 rewrite for
  one-book ops. WATCH-V3-1: spot heap slope on the demo soak (paper plateau 673 MiB is the
  reference; a demo-mode sustained climb past ~900 MiB before the soak ends is a defect signal).
- **v3 LOCAL DEMO CUTOVER — LIVE (2026-07-21, owner session; this is the cutover record the
  playbook v4 freeze banner keys on — from this record onward the v4 pass-type menu is fully
  active).** Pre-cutover gates all landed: Grafana Overview strip + regression pass (`8014a1d`),
  `reconciliation_runs_total` venue label (`9367285`, spec-§8 gap surfaced by the dashboard
  expr-vs-emitter cross-check), stale-file sweep, playbook v4 (`16188a7`). v2 stack stopped
  2026-07-21T11:15:05Z — both lanes flat (perp zero positions/orders; spot dust-only ledger
  residuals, no venue axis), final reconciles CLEAN on both lanes. v3 booted greenfield from the
  same compose project on NEW volumes (`postgres_data_v3`/`prometheus_data_v3` — v2's
  `crypto-bot_postgres_data`/`_prometheus_data` left intact on disk; pruning those v2 volumes is
  loop-domain, deferred until after the GCP lift). 4 containers up, app healthy; effective mode=testnet, downgrades=[];
  playbook seeded once (version 1, single row); 23 tables migrated on the empty DB; funding-ingest
  first-poll race self-healed (WARN + retry, correct fail direction).
  **`PROMOTION_EVIDENCE_EPOCH=2026-07-21T11:21:00Z`** stamped at the log-verified flat instant
  (fresh DB, `reconciliation_runs_total{venue,result}` all-clean on BOTH venues, kill switch
  RUNNING, zero positions/open orders) and verified inside the final boot's container env
  (bootId `948a2122`). Capital split observable live: `venue_free_cash_usdt` 500/500. Soak now
  running per WATCH-V3-1 + the v4 §5 soak checklist; lift-readiness call follows the soak.
- **Soak defect #1 FOUND+FIXED (2026-07-21, first soak check — the incident-first gate working as
  designed).** First sweep raised 0 alarms but 411 warn lines: ~3.5-min waves of market-stream
  loop errors on BOTH venues (closedByUser + server 1008, 269 errors/20 min), recreation seam
  escalated to its 600s gate on perp. Root cause (probed live, #54 pattern): the demo venue's
  kline streams are TRADE-DRIVEN on thin symbols — APT/WIF/DOT/NEAR/OP candles sat 150-307s
  silent while tickers stayed fresh — so the watchdog's single 180s threshold read normal
  thin-symbol quiet as a dead subscription, forced a CONNECTION-WIDE close(), and the resubscribe
  herd tripped the demo ws rate limit (1008): self-sustaining storm. v2 never hit it (8 liquid
  perps; v3 runs 16 with a thin tail). NOT a total outage: journal stayed complete (40 symbols
  every bar, both venues; 4 stragglers ≤2 min), reconcile stayed clean, RSS 627 MiB. Fix
  `624f30c`: per-channel-type stall threshold — candle:* stalls at 20 min (one full 15m bar +
  margin; the 2026-07-16 8.2h class still caught), book/ticker/trades keep 180s; regression spec
  pins candle-silent-3min-no-close. Redeployed 11:28:29Z (bootId `46c90e17`), epoch unchanged
  (flat book, maintenance redeploy). **WATCH-V3-2:** expected-positive = loop-error rate ~0 and
  `market_stream_forced_reconnects_total` flat over ≥1h with journal every bar on both venues;
  defect outcome = waves persist past the first hour ⇒ the candle threshold was not the (only)
  initiator — reopen with a raw demo-ws probe before touching anything else. Owner-session soak
  wakeups own the check; resolution before the lift-readiness call.
- **Soak defect #2 FOUND+FIXED (2026-07-21, soak check #2 — WATCH-V3-2's defect outcome fired
  exactly as written: waves persisted, perp-only, so the reopened investigation ran the raw-probe
  chain).** Post-fix-#1 the storm went perp-only (~30 errors/min waves; spot fully clean —
  defect #1's fix verified). Watchdog stall lists fingered BTC/ETH perp BOOKS — books yielded
  exactly ONCE (the REST snapshot) then never a ws frame, from the very first minute of a fresh
  boot. Probe chain (#54): fresh default-option ccxt client on the same host = ~6 book events/s
  (venue+ccxt innocent); unwatch-14-keep-2 repro = remaining books unaffected (tier demotion
  innocent — parks also postdated the death); A/B on `options.watchOrderBookRate` = **rate 1000 ⇒
  1 yield/30s, rate 500 ⇒ 50 yields/30s**. Root cause: XA6's `watchOrderBookRate: 1000` was a
  v2 SPOT-lane option; v3's unified `buildCcxtExchange` applied it to both venues, but Binance
  futures stream servers serve only `@depth@100/250/500ms` — an unknown suffix is accepted at
  subscribe and never sent a frame (pinned ccxt builds the stream name verbatim, no validation).
  Fix `0493344`: per-venue rate — spot keeps 1000ms, `binanceusdm` pins 500ms (slowest valid
  futures speed, XA6 load intent preserved); spec pins the futures instance must never inherit
  spot's 1000. Redeployed 13:03:46Z; verified live: ALL 16 perp books sub-second fresh, zero loop
  errors. **WATCH-V3-2 (amended):** expected-positive = loop-error rate ~0 on BOTH venues over
  the next hour+, forced-reconnect counters flat, journal every bar; the original defect-outcome
  clause stands for any residual waves.
- **Soak progress (2026-07-21 ~14:10Z, check #3): WATCH-V3-2 expected-positive CONFIRMED** — 75
  min on the depth-rate build with ZERO loop errors on both venues, zero recreations (no
  wsRecreations series at all), zero sweep alarms, journal 40/bar every bar, reconcile clean-only
  (126/125), every book channel sub-second, RSS 698 MiB (WATCH-V3-1 well inside bounds). Zero
  consults so far is BY DESIGN, not a defect: `AGENTIC_FALLBACK_CONSULT_BARS=8` (2h) with
  in-memory bar counters reset by the 13:03Z redeploy ⇒ first fallback consult due at the 15:00Z
  bar close; wake-on-move (0.8%) has not tripped in the prevailing chop. Next check verifies the
  first cross-venue consult fired and spent within budget. 48h soak clock runs from the last
  defect-fix redeploy (13:03:46Z).
- **Soak defect #3 FOUND+FIXED (2026-07-21, check #4 — first-consult verification).** The 15:00Z
  fallback consult wave FIRED (gate mechanics correct: forced_fallback outcomes, menu-8 batch),
  but 15 of the first 16 decide attempts journaled `error`/RETRYABLE with NO llm_usage rows and
  bare-classification rationale (no HTTP status ⇒ the transport catch: wall-clock abort). The
  decide-latency histogram pinned it: batched attempts measure 20-35s (avg 24.1s) against
  `AGENTIC_TIMEOUT_MS=30000` — a v2-era calibration for SINGLE-symbol decides that both v2 lanes
  carried; v3's menu-8 batched `submit_portfolio` call is ~2x v2-perp's menu-4 batch and sits at
  the cliff, so the abort killed ~94% of attempts. The one surviving call proved the path
  end-to-end (billed with cache reads, produced menu holds + one KAITO element schema-degrade —
  the tool-contract guardrail working, zero capability violations). Fix: `AGENTIC_TIMEOUT_MS`
  30000→90000 in `.env.app` (~3x the measured shape, ≤10% of a 15m bar — fail-fast intent
  survives at batched scale); app recreated 17:28Z (bootId `1b8ef6c9`), knob verified in-container.
  Bar counters reset ⇒ next fallback wave ~19:30Z; the following check verifies a fully-billed
  cross-venue consult. FLAGGED (post-soak, report-only): transport-level decide errors drop the
  underlying message from every ledger (journal writes the bare kind by privacy design, metrics
  keep only the outcome, nothing logs) — a one-line redacted-reason log in the metrics wrapper
  would have cut this diagnosis from five probes to one.
- **Soak progress (2026-07-21 ~16:31Z, check #5, mid-window):** all green on the 90s-timeout boot
  (`1b8ef6c9`, recreated 15:28:36Z — the defect-#3 record's "17:28Z" was a local-time slip; the
  soak clock runs from 15:28:36Z): zero alarms, zero loop errors (WATCH-V3-2 holding), journal
  40/bar every bar, reconcile clean-only both venues, kill switch RUNNING, RSS ~679 MiB flat
  (WATCH-V3-1 fine). 200 skips = 5 bars × 40 symbols, exactly on schedule; the first post-fix
  fallback consult wave is due at the 17:15Z bar close — next check verifies it bills, stays
  under the 90s ceiling, and any entries flow through Risk with reconcile staying clean.
- **Soak check #6 (2026-07-21 ~17:40Z): CONSULT PATH VERIFIED END-TO-END — the defect-#3 fix
  holds.** The 17:15Z wave fired (8 forced_fallback) and the model's own schedule took over
  (7 organic `consulted` outcomes): 15 decides, ZERO error_retryable, every attempt ≤30s under
  the 90s ceiling, all holds (flat book in chop — plausible). Billing verified across all three
  ledgers ONCE the v3 design was read correctly: decide tokens persist on `agent_decisions`
  token columns (5 batch-usage rows), `llm_usage` is reflection-only BY DESIGN, and
  `PromotionStatsRepository.tokenTotals` folds BOTH into per-model cost — Prometheus tokens,
  the in-memory budget ($2.72 remaining, ~$0.17 spent — inside the §5.2 projection), and the
  durable ledgers agree. Standing greens: zero alarms, zero loop errors (WATCH-V3-2), journal
  40/bar, reconcile clean-only both venues, kill switch RUNNING, RSS ~677 MiB flat (WATCH-V3-1),
  capability violations 0. Soak settles into the hourly checklist rhythm; 48h clock from
  15:28:36Z.
- **Soak handed to the daily loop (owner, 2026-07-21 ~20:15Z).** After checks #7-#8 extended the
  clean streak (zero alarms/loop errors, journal 40/bar, reconcile clean 551/550, RSS ~680 MiB
  flat, burn ~$0.10/h, 22 decides zero-retryable with organic cadence — consulted 8,
  forced_move 5), the owner judged the stack healthy, stopped the in-session soak wakeups, and
  re-enabled the `daily-profitability-loop` scheduled task (3×/day) with its prompt rewritten
  for v4 one-book ops (perp-profile/postgres-perp remnants and consumed pre-auths removed). The
  loop's §1-§3 now own soak monitoring; the 48h bar (from 15:28:36Z) and the lift-readiness
  record remain the loop's exit artifact. **Zero round trips is PARTLY masked contract failure,
  NOT purely model-holding-in-chop — CORRECTED 2026-07-22** (see § trade-model head-to-head +
  WATCH-V3-3): the investigation found that of the 100 LLM-consulted holds since cutover, only
  33 are genuine regime-appropriate holds (confidence NULL, real thesis); **67 are masked
  schema-rejection degrades** (confidence 0, empty rationale — the `inferStubDecision`
  fingerprint) where the model attempted to act and the tool response failed
  `tradeDecisionSchema`. At least one was a fully-formed BTC open_long the model serialized as a
  quoted JSON string. So the earlier "regime-appropriate holds, not a defect" read was 2/3
  wrong — it WAS a defect (contract non-compliance, now fixed) on top of genuine caution. Risk
  vetoed nothing because Risk never saw the degraded proposes (they died at the client parse
  boundary). Entry-averseness cannot be judged until the contract fix is deployed and the masked
  degrades resurface as real proposes; the CANDIDATE-playbook lever is deferred behind that.
- **Soak check #9 = loop Pass 36 (2026-07-21 ~20:10-20:45Z, first scheduled v4 pass; full entry
  LOG.md).** Sweep 0 alarms; kill switch RUNNING; reconcile clean-only both venues (1067/1062,
  latest CLEAN); zero stream loop errors over the full 4.75h boot window (WATCH-V3-2 holding);
  spend $0.47 of $3 (~$0.10/h, §5.2-consistent); consulted 9 (+1 organic since check #8), zero
  error_retryable. RSS 723.5 MiB — above the ~677-698 band of checks #3-#8 but far under the
  900 MiB defect line; WATCH-V3-1 slope watch continues. Pass work (measurement/docs only, no
  money path): (1) the Y3 collector was found STALE — the pre-cutover v2-era process (pid 83510,
  daemonized 07-20 15:27Z) survived the cutover and produced `deltas:null` two-lane digests for
  9 straight cycles; its `alarms:[]` was a §C.9 negative-read void, not quiet health. Restarted
  on v3 code (pid 26760, sentinel verified, first digest v3-single-app-shaped with real deltas on
  matching bootId). Re-daemonize after any host reboot stays a standing note. (2) state.md
  corruption repaired: the `61f277a` and `3e6900d` insertions each ate the first line of the
  bullet below them (§ Stage ladder header; the Kimi-K3 opener) — both lines restored from git.
  **WATCH-V3-3 (schema-degrade rate) — DEFECT OUTCOME FIRED + RESOLVED 2026-07-22.** The trigger
  was "≥2 more whole-payload events or a sustained >5% element rate ⇒ a root-cause pass on the
  tool-contract prompt/schema (and meter the degrade path)." Both conditions hit: the offline
  head-to-head measured a sustained ~31–38% propose-attempt schema-failure rate (both models),
  and the live sweep found 5 whole-payload + 41 element + 11 missing-symbol degrades since
  cutover. Root cause (both the root-cause pass AND the metering, as the trigger prescribed):
  the JSON tool schema advertised only `action` as required while zod's `requireTradeDirectives`
  demanded six open_* fields, four never stated required in model-facing text; thesis >300 chars
  rejected; `decisions` string-encoding accepted-then-dropped. FIX SHIPPED (gate green, 2712
  tests): prompt/tool hardening + the degrade path is now METERED
  (`agentic_schema_rejections_total{kind}` counter + `schema_rejected:` journal rationale — the
  "no metric/rationale marker" gap this WATCH named is closed). Historical prior: this was the
  same defect class as WATCH-X2-era degrade guidance. Deploy of the fix + a hardened-contract
  re-baseline is the remaining loop step (I commit + deploy — loop-domain per the 2026-07-22
  gate-override grant; the live-money flip is the only human gate).
- **RECOVERY RE-DISARMED AND RE-ARMED (Pass 40, 2026-07-27) — the clean stamp is the single point
  of failure for kill-switch auto-resume, and it has now been starved twice by two unrelated
  causes.** `b9837bd` (07-27 morning) freed it from `sweep_failure`; two hours later a
  multi-fill backfill stranded an order non-terminal and `adopt_non_adoptable` starved it again
  (defect + fix `968088f`, full narrative in LOG.md). Standing consequence for every future pass:
  **treat `reconciliation_last_success_timestamp_seconds` as a first-class liveness signal, not a
  dashboard curio** — any actionable mismatch class that can recur on every pass disarms recovery
  for the whole book, silently, while health stays green. `loop:sweep` now alarms on it
  (`reconcile_clean_stamp_stale`, 30-min bound); before this pass it could not see the condition at
  all. NOTE the measurement trap that cost a review round: the `reconciliations.result` column is
  written off the RAW mismatch total, so a `CLEAN`-row age is NOT the stamp and would fire forever
  on benign shared-wallet noise — read the gauge, never the rows.
  **WATCH-V4-1 (clean-stamp liveness).** Expected-positive: the gauge's age stays under ~2 min at
  every pass, `reconciliation_mismatch_total{class="adopt_non_adoptable"}` stays 0, and no order sits
  non-terminal while its `fills` sum equals its `qty`. Named defect outcome: the age exceeds 30 min
  again (the sweep now says so out loud) ⇒ a THIRD starvation cause exists — root-cause it before any
  other work, checking `sum(fills.qty)` against `orders.cum_qty` for non-terminal orders first, since
  that is the shape twice running. Deadline: next pass confirms the first ≥12h window with the stamp
  never stale.
  **WATCH-V4-2 (FILL_OVERFLOW is one-shot by construction).** Expected-positive:
  `reconciliation_mismatch_total{class="fill_overflow"}` stays 0. Named defect outcome: any non-zero
  reading is a book HALT that will NOT re-fire and is NOT repaired by restart — capture the
  `FILL_OVERFLOW:{symbol}` reason from `audit_log` immediately (the container log is the only other
  copy, and the sweep truncates its messages to 48 chars). Its likeliest cause — the unqualified
  trade index — was fixed the same pass (`9d69d91`), so a fire now means a genuinely new shape.
- **TRADE-ATTRIBUTION FAMILY CLOSED (Pass 40, 2026-07-27) — four defects the adversarial review
  surfaced, all fixed in-pass after the owner's do-not-defer ruling.** (1) `9d69d91`: the axis-2
  trade index was keyed on `venueOrderId` ALONE while built book-wide, but that id is unique only per
  venue — a perp trade could fold onto a spot order. `OrderRecord` now carries `symbol` (persisted),
  and a record whose venue cannot be established is not indexed at all. (2) `9d69d91`: the same index
  was snapshotted once per pass, so an order ACKed mid-pass reached the durable tier as
  "non-terminal, lost in memory" and HALTED the book — a false corruption verdict on an order that
  was merely young; the index is now re-read once on a miss. (3) `132fb3d`: fills arriving after an
  order folded terminal within one batch were journaled but never applied to position/cash (the
  in-flight map is cleared on the terminal fold) — invisible on spot, where balanceAxis is off and
  the position axis is perp-only; the ingestor now falls back to the durable intent. (4) `f2d74b6`:
  the daily cost breaker was in-memory only, so every redeploy handed the lane a fresh full $3 — it
  is now seeded at boot from the durable token ledgers (live-verified: "$1.2294 of $3 already spent
  today" where the previous boot would have read $0.00).
  **WATCH-V4-4 (attribution correctness).** Expected-positive: `fills` rows always carry the
  clientOrderId of an order on the SAME venue as the fill, no `FILL_FOR_UNKNOWN_ORDER` halt fires on
  an order younger than the pass that halted it, and `sum(fills.qty)` per order equals
  `orders.cum_qty` for every terminal order. Named defect outcome: any of those three breaking means
  the index or the fold has a shape none of the four fixes covers — do not patch the symptom;
  re-derive which tier resolved the trade first.
- **REDEPLOY IS NO LONGER A COIN FLIP WHILE HOLDING PERP EXPOSURE (Pass 40, 2026-07-27, fix
  `287ef6c`).** The boot-time perp pin halted the book (`START_TRADING_FAILED`, flatten=true) on a
  FLAT symbol carrying a resting algo-rail stop: the venue refuses `setMarginMode` with -4067 while
  `fetchPositions` drops zero-size rows, so the -4067 tolerance could not verify a symbol the venue
  already had on isolated margin. Probe-verified fallback to `fapiPrivateV2GetPositionRisk` (the
  only source that returns flat symbols — `fetchPositionsRisk` and the v3 endpoint do not).
  **Durable fact for future venue work: on binanceusdm, "no position row" never means "not
  isolated", and a resting algo-rail order is invisible to `fetchOpenOrders` but visible to the
  venue's own open-order check.**
  **WATCH-V4-3 (redeploy safety).** Expected-positive: every future redeploy that happens while a
  perp symbol carries a resting stop boots to `kill_switch_state{state="RUNNING"}` with no
  `perp pin:` line in the boot log. Named defect outcome: another `START_TRADING_FAILED` at boot ⇒
  the pin has a THIRD unverifiable shape — probe the venue for that symbol before editing the guard,
  and do not widen the tolerance without positive proof of `isolated`, which is the whole point of
  the gate. Standing operational note surfaced by this incident: a `flatten=true` halt CANCELS
  resting protective orders first, so a wedged FLATTENING state leaves open positions with no
  venue-side protection — an unsafe resting state, not a safe one.
- **A GUARD THAT WAS BUILT, BELIEVED, AND NEVER LOADED (Pass 43, 2026-07-28) — plus the loop learning
  to read the alerts it owns.** Two failures of the same shape, one causing the other's invisibility.
  (1) **The lane died silently for 3h.** The Anthropic account's credit ran out at 2026-07-27T21:16:25Z;
  the 400 is FATAL, so `AnthropicAgentClient` latched — and the latch held until a container recreate.
  Every surface stayed green because a latched client still journals a decision row per symbol: 30 rows
  with `action='hold'` and an EMPTY rationale, indistinguishable from genuine model holds, while
  `agent_tokens_total` sat frozen at 203,835. Fixes `ee4ddf3`/`7fa5ba8`: the latch expires after
  `FATAL_LATCH_COOLDOWN_MS` (30 min) so a cause fixed OUTSIDE the process self-heals with no redeploy,
  and the short-circuit journals `action='error'` with a `client_latched:` rationale metered as
  `agent_decide_total{outcome="client_latched"}`. **Verified, not assumed: those degraded rows carry
  `playbook_version IS NULL`, so `countVersionEntryStats` (the abstention-lapse evidence base) cannot
  see them — no statistic is corrupted, before or after.**
  (2) **`loop:sweep` never read Prometheus.** This stack has no Alertmanager by design, which makes the
  pass the alert consumer — and the sweep only re-derived conditions it had been taught one at a time.
  It now reads `/api/v1/rules` and promotes firing rules to `prometheus_alert_firing`. **CRITICAL ONLY:**
  ≥1 rule was firing 58.4% of the last 7 days (ReconciliationMismatch 1135/1440 min; sticky
  AgenticReflectionNeverMinted 4084 min/7d), and playbook §3 makes any alarm block improvement work, so
  promoting warnings would wedge the loop on ~6 passes in 10; `EffectiveModeLive` is severity `info` and
  fires permanently once live is armed. Warning/info annotate instead.
  **DURABLE FACT, the most reusable thing this pass found: Prometheus reads `alerts.rules.yml` ONCE at
  process start.** It is a read-only bind mount, the container has no `--web.enable-lifecycle`, and
  `docker compose up -d prometheus` is a NO-OP because compose sees no change — only
  `--force-recreate` (or a restart) reloads it. Consequence discovered live: the running Prometheus was
  serving a pre-2026-07-22 file, **16 alerting rules against 20 committed**, so the four alerts written
  on 07-27 to catch a silent lane had never evaluated once. Any pass editing that file MUST recreate the
  container (now required in playbook §5 step 3 and `docs/runbook.md` § Deploy), and the sweep's
  `promAlerts` probe now fails and NAMES any committed alert the running Prometheus has not loaded.
  Name-set comparison only — Prometheus re-renders PromQL, so diffing query text false-positives on
  every multi-line rule. Correcting an overstatement rather than leaving it flattering:
  `AgenticLaneSilent` would NOT have caught this outage (`agent_decide_total` kept incrementing); the
  staleness is real, that rule was not the miss.
  **WATCH-V4-5 (the latch is observable and self-healing).** Expected-positive, in three parts:
  `agent_client_latched` reads 0 whenever the lane is making calls and 1 within one scrape of a
  suppressed call, with `AgentClientFatalLatch` following it in both directions; ZERO
  `action='hold'`-with-empty-rationale rows ever appear again; and once a provider is funded the lane
  resumes within 30 min with NO redeploy. Named defect outcome: a latch that outlives its cooldown
  without a fresh `error_fatal` means the expiry path is not being reached — read `latchRationale`'s warn
  line (`latch expired … resuming calls`) before touching the state machine; and an
  `AgentClientFatalLatch` that will not clear after recovery means the gauge is being set from a stale
  outcome, which is a `recordDecide` bug, not an alert-tuning problem. **Status at hand-off: the
  NEGATIVE direction is live-verified (gauge 0, alert inactive, `health=ok`, 20/20 rules loaded on boot
  `464c608b`); the POSITIVE direction is UNPROVEN on this build** — the accounts are unfunded but bar
  counters reset on the 07:30Z redeploy, so the first consult attempt was up to 2h out. Deadline: the
  next pass confirms it from a sweep, and must not infer it from the unit tests.
- **Kimi-K3 experiment COMPLETE — offline replay verdict HOLD (2026-07-21/22, task #15 run
  phase):** kimi-k3 replayed over the newest 100 recorded consult payloads (1,363 payload rows
  loaded; v2 corpus served from a read-only clone of the retired `crypto-bot_postgres_data`
  volume; window 2026-07-20T21:45Z → 2026-07-21T10:45Z) via Moonshot's Anthropic-compat
  endpoint (`https://api.moonshot.ai/anthropic` — thinking-disabled accepted, forced
  tool_choice honored on first try). Verdict vs the sonnet-5 champion: schema-valid 0.85 <
  1.00, hold-agreement 0.17 << 0.85 (champion held all 100; K3 proposed longs on ~83% — far
  more aggressive), plan-sanity 1.0 (its one pass), cost/decide $0.0157 vs $0.0232 (−32%,
  fails the ≤50% bar). **Go bar NOT met ⇒ no live A/B; decide+reflection stay on
  claude-sonnet-5; loop stays on Claude.** Registry: v3 `experiments` row 1
  (`decide-model-eval`, source study — v2-era rows 1–130 archived in the v2 volume/backups);
  scorecard `candidates/kimi-k3-model-eval-2026-07-21.json`; narrative LOG.md 2026-07-22.
  Secret name is `MOONSHOT_API_KEY` in `.env` (the pruned memo's `KIMI_API_KEY` was stale);
  the harness now carries standing eval-lane routing knobs (`AGENTIC_EVAL_BASE_URL`/
  `_API_KEY`, 429 retry, thinking sentinel) for any future compat-endpoint eval. Research
  memo is git-history-only (`git show d533667:reports/loop/kimi-k3-research-2026-07-21.md`).
- **Trade-model head-to-head (v3 rich contract, shorts-capable) — COMPLETE; verdict NO FLIP;
  contract-compliance defect FOUND + FIXED (2026-07-22):** owner directive
  "make the backtest harness first-class and shorts-capable, then run sonnet-5 and kimi-k3".
  The legacy-contract run 2 (propose-dense window) died at 5/200 rows when its background
  process was lost at a session compaction (~$0.08 spent; partial row log
  `candidates/kimi-k3-rows-2026-07-22.jsonl`; no scorecard, no registry row) — NOT relaunched
  (loop-domain call): superseded by the head-to-head, which replays the IDENTICAL window under
  the v3 `submit_trade` contract instead of the deleted legacy plan contract. New harness
  `pnpm eval:trade-models` (`test/eval/agentic/trade-model-eval.spec.ts` +
  `trade-eval-fixtures.ts`): re-asks recorded market contexts under the CURRENT production
  prompt/tool (sound because `input_payload` is pure market JSON — no contract text); synthetic
  `capabilities` block (shorts:true, byte-matching the deployed $1k perp book) injected into
  v2-era payloads so `open_short` is reachable; `shortEntries`/`shortExits` buckets added to
  `counterfactual-scoring.ts` (production src, additive + relabel, unit-tested); per-model
  routing `AGENTIC_EVAL_MODEL_ROUTES_JSON` (key names only, never key values); corpus now
  file-served (`test/eval/agentic/data/corpus-v2-clone.jsonl`, gitignored, reproducible via
  `scripts/dump-eval-corpus.mjs` — the 5434 scratch DB is dispensable, teardown unblocked).
  **hh-v1 criteria, pre-registered BEFORE any paid call** — kimi-k3 vs a sonnet-5-replay
  baseline over the same fingerprinted 200-row slice (window 1783714500000–1783876500000;
  champion mix 25 long / 16 flat / 163 hold): (1) schema-valid ≥ baseline; (2) trade-sanity ≥
  baseline (fee-floor TP + taker-offset-0, the only prompt/tool-stated rules zod can't encode);
  (3) directional forward proxy (long entries raw + short entries negated, per-symbol grouped)
  ≥ baseline − 2bps; (4) propose-rate ratio ∈ [0.5, 1.5]; (5) cost/decide ≤ baseline (parity).
  Persisted champion actions are an informational REFERENCE only — cross-contract agreement is
  not a fair bar. CAVEAT: spot-recorded history re-asked as shorts-capable perp — these numbers
  are never a native perp eval. Re-test trigger: when the live v3 corpus holds ≥200 payload
  rows with ≥20 `open_*` proposes in a contiguous window, re-run natively (v3 corpus at
  2026-07-22: 3,280 rows, 83 payloads, ZERO proposes — cannot power this eval yet). Registry:
  new family `trade-model-eval`, source study, via `scripts/log-eval-experiment.mjs`
  (`REGISTRY_DATABASE_URL`, fail-closed gate; rows 2–5).
  **RESULT — OPERATIVE (hardened contract, both legs 200 rows in ONE invocation, max_tokens
  4096, thinking disabled; registry rows 6 sonnet-5 / 7 kimi-k3; scorecard
  `candidates/trade-model-eval-headtohead-hardened-2026-07-22.json`):** hh-v1 verdict **NO
  FLIP** — but now a REAL comparison (all five criteria evaluated, zero nulls, because both
  models actually propose on the fixed contract). kimi-k3 vs sonnet-5 baseline: (1) schema-valid
  0.71 < 0.805 FAIL; (2) trade-sanity 1.0 = 1.0 PASS; (3) directional proxy **+5.42bps vs
  −4.68bps** ≥ baseline−2 PASS (kimi's picks were directionally positive, sonnet's slightly
  adverse); (4) propose-rate ratio 5.43 ∉ [0.5,1.5] FAIL; (5) cost/decide $0.0124 ≤ $0.0272
  PASS (−54%). Two fails ⇒ NO FLIP; loop stays on Claude (owner directive; unchanged). PROFILE:
  kimi-k3 is more willing to trade (76 proposes: 64 long + **12 short**, rate 0.38 vs sonnet's
  14: 13 long + 1 short, rate 0.07), directionally better on its picks, and half the cost — but
  less schema-reliable (58 errors vs 39; kimi's dominant error is thesis >300 chars, sonnet's is
  missing sizeFraction). CAVEAT on criterion 4: it compares to the sonnet baseline, which is
  itself unusually passive (0.07 vs the champion's 0.125), so any active model blows past 1.5×;
  the ratio bar is degenerate against a passive baseline (doesn't change the verdict — schema-valid
  also fails). SUPERSEDES the pre-fix run (registry rows 2 sonnet / 3 kimi, scorecards
  `-sonnet5-`/`-kimi-k3-2026-07-22.json`): those legs ran the PRE-hardening contract where the
  sonnet baseline completed ZERO valid proposes (criteria 2/3/4 null) — not a real head-to-head,
  retained only as evidence of the contract-compliance defect. The max_tokens-1024 leg (row 4,
  `-maxtok1024`) is a further output-budget finding. The owner's "bad test" critique is fully
  resolved: the harness produces longs AND shorts and measures decision quality on a contract
  both models can comply with.
  **DOMINANT FINDING — v3 contract non-compliance (both models) FOUND + FIXED:** both models fail
  `tradeDecisionSchema` on a large fraction of propose attempts under thinking-disabled/forced-tool
  (sonnet 0.69, kimi 0.62). Root cause: the JSON tool schema advertises only `action` required
  while zod's `requireTradeDirectives` demands six fields on open_*, four of which were never
  stated as required in ANY model-facing text; thesis >300 chars also silently rejected.
  Production SILENTLY degrades every schema-rejected propose to a plain `hold` row
  (`inferStubDecision`) with no marker, no metric — so **67 of the 100 live LLM-consulted holds
  since the 07-21 cutover are MASKED contract failures, not caution** (33 genuine holds; the
  "zero proposes" soak reading was 2/3 wrong — see § soak correction). FIX SHIPPED (12 files,
  gate green 2712 tests): model-facing hardening (required-set enumeration in
  TRADE_ACTION_DESCRIPTION, strict thesis-cap wording, decisions-must-be-array-not-string) +
  unmask (`schema_rejected:` journal rationale so degrades are queryable, `recordSchemaFailure`
  seam + `agentic_schema_rejections_total{kind}` Prometheus counter). Post-fix evidence (identical
  newest-40 rows, registry row 5): sonnet-5 schema-valid **0.675 → 0.775** and completed proposes
  **0 → 4**. Re-test trigger: re-run the head-to-head on the HARDENED contract once deployed (a
  cleaner comparison — the current legs ran the pre-fix contract, so the baseline's proposal
  collapse confounds criteria 2/3/4).
- **Stage ladder + exit criteria (condensed from the active spec):**
  1. **Cost floor** — CLOSED 2026-07-08: true spend ~$0.77/day under the $5 breaker, skip rate
     70–83% (original criterion: ≤$1/day ×3 days + ≥2 RT/day + no EXPIRED regressions).
  2. **Learning-loop edge** — ACTIVE. Exit: ≥2 playbook promotions with version-attributed PnL
     AND rolling-7d net-of-cost ≥0. **Current status (Pass 26, 2026-07-15) — reflection loop ALIVE
     & HEALTHY on BOTH lanes, `c0d53bd` seed-race fix LIVE-VERIFIED:** SPOT playbook active v1, v2
     unresolved in A/B. **v2 is now PARTICIPATING and WINNING EARLY — 3/10 attributed trips (Pass 27;
     2/10 at Pass 26; 0/abstaining at Pass 24), net-of-cost +$1.09 vs champion v1 −$1.90 — so the
     abstention deadlock resolved NATURALLY.** The Pass-24 prediction ("the abstain-lapse
     `AGENTIC_ABSTAIN_LAPSE_DECIDES=15` mints v3 immediately") is **OBE**: the abstain-lapse condition
     is `decides≥15 && entries===0` (`reflection.service.ts:818`) and v2 now has `long` entries, so
     `entries===0` is false — the lapse is armed but doesn't fire. The BINDING guard is the **age-lapse**
     (`candidateLapseMs`, configured **168h**; boot log: `candidate v2 … still unresolved in A/B
     (age 99h < lapse 168h) — skipping mint, trigger preserved` ⇒ outcome `skipped_unresolved_candidate`,
     a healthy guard, NOT a defect). v2 minted 07-11 04:45Z ⇒ **mint-over at ~07-18 04:45Z unless it
     resolves via 10 attributed trips first.** `c0d53bd` verified: first close after boot `29e22ada`
     logged `trigger state seeded from DB … 17 closed trips lane-wide, 4 for this strategy` and fired
     the evaluation (no prime-but-fail). **PERP lane minted its OWN v2 (Pass 26, first live perp mint)**
     through the Phase-4 mint-backtest path (`attempt_started=1, minted=1`; separate DB/epoch;
     `minRr=2`/`minEdgeMultiple=2` changelog) — awaits its own 10-trip verdict.
     Reflection fires per strategy after 2 closed trips (`AGENTIC_REFLECTION_EVERY_N_TRADES=2`,
     `3e5773f`); NB the trigger check races the async DB seed on first-close-after-boot (primes
     but cannot fire — documented quirk, § Durable findings). PROMOTION pass eligibility:
     candidate needs ≥10 of its OWN attributed trips (symmetric — champion needs ≥10 in-window
     too); CANDIDATE passes stay blocked (§3(a)) while a candidate sits unresolved in A/B.
     **Update 2026-07-17 (owner session + Pass 32):** v2's runway re-protected — age-lapse 336h
     (mint-over ~07-25 04:45Z) + A/B 40% (`1a70a51`); the 07:45Z reflection attempt that bypassed
     the guard was the abstention-lapse WINDOW bug (v2's 4 longs beyond the recent-400 horizon
     post-5→8), fixed `cfb2ed3` with lifetime evidence — v2 now resolves on its 10-trip verdict
     or the 336h clock, nothing else mints over it.
  3. **Earned-live** — pass the coded promotion gate (`PromotionReadinessService`: ≥30 closed demo
     round trips, net-of-cost > 0, ≥14d window), then the unchanged human four-gate arming
     ceremony. Nothing automates live.
- **Settled owner decisions (not re-openable by a pass; argue in "Flagged for human review"
  instead):** no return to 1m/5m DECIDE cadence. Formerly settled, since REOPENED by owner:
  - **Shorts (2026-07-13, Push II plan approval): reopened for the DEMO stack only** — existing
    `BINANCE_DEMO_*` keys are futures-demo-capable (venue-path probe PASSED 2026-07-13: pinned
    ccxt 4.5.58 `binanceusdm.enableDemoTrading(true)` → `demo-fapi.binance.com`, auth + balance
    ($5,000 USDT) + orders + positions all OK; chosen path = real futures-demo venue, no
    PaperPerpAdapter, no ccxt bump). `PERP_LEVERAGE_CAP=1` unchanged. Live money, margin >1×, and
    the four live gates + arming ceremony untouched.
  - **Symbol set (2026-07-10): widened** BTC/ETH → **BTC, ETH, SOL, XRP, LINK at 15m**. Fallback:
    drop LINK on sustained >$3/day spend or attribution starvation. Further widening: see the 5→8
    pre-auth below.
  - **Models/cost (2026-07-08, "improve aggressively" mandate):** "Sonnet-5-only" and "≤$1/day"
    framings lifted. Reflection runs Opus-4.8; decide model changes ONLY via the $0 offline
    harness (never a blind flip); ceiling = `AGENTIC_DAILY_COST_STOP_USD=$5/day` breaker
    (expected true spend ~$2.2–2.5/day at 5 symbols).
- **Budgets:** `AGENTIC_DAILY_COST_STOP_USD=$5/day` runtime breaker; **≤$20/gate** for offline
  candidate evals (~2 API calls/replayed row — cap row count to stay under budget).
- **Pre-authorizations (owner; per the 2026-07-12 delegation a pass applies these itself once the
  trigger condition holds, recording the decision):**
  - (2026-07-07) IF net-of-cost > 0 AND round trips ≥ 30 before the 14-day window fills,
    `MIN_WINDOW_DAYS` 14→10 (`promotion-readiness.service.ts`). ≥30-trips and positive-net are
    NOT relaxable. UNFIRED.
  - (2026-07-08→13) **Sizing 0.05 APPLIED 2026-07-13** (`22af50d`, owner plan approval superseded
    the 15-trip trigger; full re-derivation memo in LOG.md 2026-07-13 owner session / git history
    of this file). Operative residuals: the expectancy ladder is the auto-brake (trailing 15-trip
    mean ≤ −$0.10 ⇒ strength ×0.4 ≈ $100, self-releasing; 8-trip data floor);
    `RISK_MAX_POSITION_PER_SYMBOL=1000` (base qty) is the **binding cap** — a sub-$0.50 symbol
    would be VETOED at entry, so universe expansion must avoid sub-$0.50 symbols or raise the cap
    with its own memo.
  - **Evidence epoch:** `PROMOTION_EVIDENCE_EPOCH=2026-07-12T08:30:00Z` (Pass 18 addendum, under
    the delegation; third epoch — 07-08 original, 07-10 wipe instant). Since `cc72a10` (#36) the
    epoch bounds ALL four consumers (gate, A/B attribution, promotion evaluator, reflection
    evidence/seeds). Declaring a new epoch = loop-domain; declare only at a verified flat instant.
  - **5→8 universe expansion (Push II close-out, owner-approved plan):** after a clean ≥2-day
    portfolio-consult soak (Phase-5 WATCH green), the loop may add **ZEC/AAVE/NEAR** per
    `reports/loop/universe-study-2026-07-13.md` — add the three DEFAULT_FILTERS rows from the
    report, re-derive gross exposure (8 × 0.05 ⇒ consider 0.04, record why), APPEND to
    TRADING_SYMBOLS, never reorder. **FIRED + APPLIED 2026-07-17 (owner session, `1a70a51`,
    spot boot `482d5ab1`):** Phase-5 consult WATCH resolved positive Pass 24; consult clean since
    the 07-13 enable (the 07-16 outage was market-data, not consult). Live demo-venue probe PASSED
    all three (TRADING; filters exactly match the study; ZEC $528.53 / AAVE $90.47 / NEAR $1.94 —
    all clear the $0.50 floor). Sizing 0.05→0.04 (8×0.04 ⇒ ~0.32 gross);
    `AGENTIC_MAX_CALLS_PER_DAY` 700→1100 (768 opportunities/day; breaker unchanged at $5).
    **WATCH:** first decides on ZEC/AAVE/NEAR post-warmup; daily spend ~$3.5–4 expected, breaker
    $5; no cap/notional entry vetoes on the new symbols; a sustained >$4.5/day = drop candidates
    per the study's fallback order. **Day-1 (Pass 32): decides GREEN all three** (ZEC 3 long
    proposes + open position with resting venue TP; AAVE/NEAR deciding), **zero risk vetoes**;
    spend ~$3.5–4.8/day (boot-cache-heavy window — not yet "sustained", re-measure); side effect:
    32 ws subscriptions crossed the venue 1008 burst cliff (Bug D, fixed `f9b7d56` — LOG.md).
    **Day-2 (Pass 33): spend re-measured ~$2.0–2.7/day — the day-1 band was boot-cache noise,
    fallback NOT armed; ZEC closed its first trip +$1.35 via the first-ever spot venue-TP fill.**

### Push 3 program (owner session 2026-07-13/14, plan `humming-sprouting-crab` v3) — COMPLETE, 2 lanes live

Owner-approved four fronts ("make it all first-class"): perp lane live + shorts ladder; full
stop-side architecture (watcher + venue-native trigger stops); factorial info×thinking
measurement; every free info channel built flag-off. All committed local, per-phase gates green,
TWO adversarial review rounds on the stop architecture (8 findings, all fixed + test-pinned).
Commit manifest: `3c8b1a1` (P0 studies), `39a43cd` (P1 A/B PRF), `8609722` (P2 stop watcher
flag-off), `c1be07f` (P3 perp compose profile), `3da8e4d` (P4 reduceOnly forwarding), `c0d53bd`
(P5 reflection seed race), `17b37b4` (P0c factorial cell script), `d7783de` (P6 five info
channels flag-off), `2046b31` (P7a/P7b venue trigger-order path), `7de96ba` (P7c resting-order
role identity), `4ce1fe0` (P8a-prep arm journaling), `830f556` (P7d venue-stop lifecycle
flag-off), `749c88b` (P7e review fix: perp small-position protection gap), `c50d4ac` (P7f review
fix: OMS algo-rail containment, 7 sub-fixes), `a6f0573` (P8a factorial ENABLE, spot), `359e4a7`
(P8d binanceusdm capability fix), `aca7fb1` (P8d perp L0 ENABLE). Decision records:

- **P0a stop-slippage study (`reports/loop/stop-slippage-2026-07-13.md`): watcher enable NOT
  JUSTIFIED at N=3** (mean total stop leak +3.2bps/exit vs the pre-registered −10bps bar; zero
  re-fires; worst +47bps; one exit favorable). `PLAN_STOP_WATCH_ENABLED` stays 'false'.
  **PRE-AUTH (loop-domain):** re-run the study once stop-exit N≥10; enable iff the criterion
  (mean worse than −10bps/exit OR any single event ≤ −100bps) is then met. CORRECTION to the
  Push II Phase-2 line "executor bar-close stop remains the only stop": the S3 1s protective
  backstop has been ARMED all along in compose (`PROTECT_STOP_LOSS_PCT=0.02`,
  `PROTECT_TRAILING_PCT=0.015` — the 2026-07-12 SOL trail event WAS S3 firing); the plan stop is
  bar-close, the 2%/1.5% backstop is intra-bar. This coheres with the small measured leak.
- **P0b entry fill-quality study (`reports/loop/entry-fill-quality-2026-07-13.md`):** maker-entry
  population is N=1 post-LIMIT_MAKER-deploy (filled maker in 0.13 bars). No guidance change
  supportable. **PRE-AUTH (loop-domain):** re-run once LIMIT_MAKER entry N≥15. Confirmed the #40
  stamp gap live: `first_fill_at` NULL on a FILLED order — the fills-table join is ground truth.
  **RE-RUN EXECUTED 2026-07-18 Pass 34 at N=25 (`reports/loop/entry-fill-quality-2026-07-18.md`,
  registry row 130): post-only maker entry VALIDATED** — fill rate 76%, median 0.13 bars; 6 misses
  priced at −353.5bps signed foregone (5/6 dodged losers; 5 were venue would-cross rejects) ⇒ no
  bounds change. Next re-run at N≈50 or on an entry-mechanic change; watch the would-cross reject
  share (20%). Pre-auth CONSUMED — future re-runs are ordinary data-gated maintenance.
- **P0d venue stop-capability probe (live on demo, orders placed far-from-market and cancelled;
  account left clean):** (1) spot `STOP_LOSS_LIMIT` is FULLY OMS-compatible — regular order rail,
  surfaces in fetchOpenOrders (unified type echoes 'limit' + stopPrice/triggerPrice; raw
  info.type STOP_LOSS_LIMIT), regular cancel, clientOrderId honored. (2) perp `STOP_MARKET` is
  created on the **ALGO/conditional rail** — response carries algoId/clientAlgoId/algoStatus;
  INVISIBLE to fetchOpenOrders/fetchOrder/cancelOrder (-2013/-2011); round-trip needs
  `fapiPrivateGetOpenAlgoOrders` / `fapiPrivateDeleteAlgoOrder({algoId})` (both exposed by pinned
  ccxt 4.5.58). reduceOnly STOP_MARKET is ACCEPTED with no position and is EXEMPT from the $50
  trigger-notional floor (-4164 binds only non-reduceOnly). OMS dedupe key on the algo rail =
  clientAlgoId. (3) `watchLiquidations`/`watchLiquidationsForSymbols` supported in pinned ccxt
  pro. P7 builds to these facts; the perp stop lifecycle must reconcile via the algo endpoints.
- **Factorial 2×2 pre-registration (info-context × thinking; owner approved superseding
  "one measured channel at a time" FOR THESE TWO ARMS, 2026-07-13):** arms assigned by
  independent keyed PRFs (`ab-assignment.ts`, salts 'info-ctx-v1'/'th-v1'; the old affine
  offsets shared one minute counter — the (info-control × thinking-on) cell was provably empty
  at 30/30). Cells recovered per-row (see prerequisite below). **Primary metric:** net-of-cost
  bps per closed trip per cell = (realizedPnl − fees − attributed LLM cost)/notional. **Evidence
  floor:** ≥15 closed trips per cell (60 total) or 30 calendar days, whichever first. **Adoption
  rule:** adopt a factor iff its main effect ≥ +10bps/trip net AND sign-consistent across both
  levels of the other factor. **Harm stop:** single interim peek at 8 trips/cell — any cell
  < −50bps/trip ⇒ that factor's pct → 0 immediately. **Interaction rule:** |interaction| >
  max(|main effects|) ⇒ extend to 25/cell before deciding. **Cost rule:** two daily-spend
  breaches of $4.50 ⇒ `AGENTIC_THINKING_AB_PCT` 50→30 (spot lane breaker stays $5). Exit-mechanic
  deploys mid-experiment shift all cells equally — record dates, do NOT reset the window.
  Verdict = loop judgment over `test/backtest/ab-cells/run.mjs` output; winners become always-on
  flags and both pcts → 0, restoring one-channel-at-a-time for future channels.
  **PREREQUISITE — SHIPPED (`4ce1fe0` P8a-prep):** migration 0012 adds nullable
  info_arm/thinking_arm; the client stamps treatment truth on every proposal path
  (info_arm = NOT infoContextControlArm, thinking_arm = thinkingArm) and the strategy journal
  persists them (NULL on quiet/prescreen rows). The cell script v2 prefers explicit arms (hash
  forensics fallback for pre-migration rows) and its trip-attribution join was FIXED — the v1 join
  keyed decide `event_time` (candle-OPEN) against intent `source_event_time` (candle-CLOSE) and
  attributed 0/12; the v2 ASOF join (mirrored from the promotion evaluator) attributes 11/12 live
  (the 12th has no preceding LLM decide). Early live signal: the info-treatment arm drives nearly
  all proposes (8.4% vs 1.9% propose rate).
- **P5 funnel fix shipped (`c0d53bd`):** the first close after every redeploy now evaluates the
  reflection trigger on the DB-seeded count (was: fire-and-forget seed ⇒ unseeded zero counters;
  a real starvation source given recreate frequency). Fail-open on seed errors preserved.
- **Post-factorial enable queue (one measured slot at a time resumes after the factorial
  verdict):** tr1 (decide-side track record) → d2 (spot-perp basis + OI delta + funding trend;
  single d1→d2 tag bump, FORBIDDEN mid-factorial) → lq1/bs1 (liquidations, book structure) →
  s1 (sentiment — CORRECTION: the s1 tag already existed, correctly gated on
  sentimentFeedEnabled; the plan's "attribution hole" premise was stale, so P6 added only the
  missing client-level tag tests, no second tag). All built flag-off in Push 3 P6. NOTE: the
  book-structure block deliberately does NOT ride the info-context A/B control arm (pure
  transform of data every payload already carries — nothing external to withhold; documented at
  its tag definition).
- **OCO REJECTED (decided, do not re-litigate):** spot orderList/OCO would make reconciliation/
  fills treat orderLists as alien objects. P7c's resting-order role identity (`7de96ba`) achieves
  the same TP/stop discrimination OMS-natively WITHOUT touching the frozen clientOrderId format:
  role = f(intent.source.dedupeKey) — `venue_tp_`/`venue_stop_` — resolved by clientOrderId via
  `ExecutionStorePort.loadIntentByClientOrderId` (the id encodes the intentId; the abandoned
  vtp:/vsl: id-prefix design would have broken the money-path CLIENT_ORDER_ID_RE that
  reconciliation/fill-ingestor depend on). Spot still cannot rest TP+stop TOGETHER (base
  double-lock — the P7f boot refusal enforces this); backlog #44 (spot OCO) is the only path to
  spot venue-side stop+TP, and it stays a seed.

- **PERP SHORTS LADDER pre-auths — SUPERSEDED BY v3 (2026-07-21, loop-domain annotation; text below
  kept verbatim as record):** the L0→L1 trigger's mechanism (`AGENTIC_SHORTS_ENABLED` on app-perp)
  was deleted at the v3 consolidation — shorts are now a per-symbol capability derived from venue
  (spec §3.4: `capabilities.shorts=true` on every perp symbol by construction, spot degrades
  `open_short` to hold + `capability_violation`). The ladder's INTENT (shorts earn exposure
  gradually) is carried by the unified book's sizing clamps + the capability wiring, not by a
  toggle; there is no knob left to flip and no `app-perp` target to flip it on. Do not fire.
  - **L0→L1 (shorts on the PERP lane):** after an L0 soak — ≥3 days clean AND ≥5 closed perp trips
    AND zero reconciliation mismatches AND the algo-rail stop lifecycle verified live (WATCH 1-3
    above green) — the loop may set `AGENTIC_SHORTS_ENABLED='true'` on app-perp (plan-mode shorts,
    pf2 tool). Portfolio consult stays OFF on the perp lane (single symbol; and the shorts+consult
    path wants its own soak). Leverage stays 1, isolated.
  - **Perp symbol expansion (L1→L2):** add a second perp symbol only after L1 shows ≥5 short trips
    clean; re-derive gross exposure first.
- **Watcher enable pre-auth (spot, unchanged from P0a):** re-run `test/backtest/stop-slippage`
  once spot stop-exit N≥10; enable `PLAN_STOP_WATCH_ENABLED` iff mean leak worse than −10bps/exit
  OR any event ≤ −100bps. The perp lane's venue stop already supersedes the watcher there.
- **Next-program seeds (backlog, not scheduled):** trailing-stop plan field (#45, wait for
  venue-TP+stop capture data), Thompson multi-candidate routing (#46), adaptive consult cadence
  (#47), weekly vol-ranked symbol rotation (#48), liquidation feed ENABLE (lq1 built flag-off, in
  the post-factorial queue), spot OCO (#44), SSE reflection streaming (#32), orders-timestamp
  stamps (#40).
- **Thompson routing (#46), adaptive cadence (#47), trailing-stop plan field (#45): deliberately
  EXCLUDED from Push 3** — the first two replace measurement machinery mid-experiment; any
  plan-schema/template change cannot ENABLE mid-factorial (build-only is fine). Not deferrals —
  scheduling decisions tied to the factorial window.

## Current stage

**Current order & status (last updated Pass 43, 2026-07-28T08:12Z).** Live build `13d94c9`, boot
`464c608b` (app deployed 08:05:55Z; prometheus force-recreated at 07:30Z on the same rules file), 4
containers healthy, kill switch RUNNING, both venues reconciling CLEAN, 20/20 alert rules loaded,
none unhealthy, sweep `Alarms (0)` with its positive control passing. RSS 757 MiB (WATCH-V3-1 fine). Book: 28 closed round
trips, net-of-cost **−$39.64**, `agentic_promotion_ready=0`, equity ~$4,978, 5 positions (4 spot dust +
SOL/USDT:USDT 0.64) under 4 resting protective orders. **The lane is NOT trading and cannot: both
provider accounts are unfunded (§ Flagged), so the client latches by design and journals named
`client_latched` degrades.** Open WATCH lines: V4-1 through V4-4 all holding; **V4-5 half-verified —
its negative direction is live, its positive direction is unproven on this build and is the next pass's
first job.** Nothing is queued for deploy. Everything else waits on funding, and funding should be read
against Pass 41's ENTRIES verdict before it happens.

**Two loop-tooling defects Pass 43's own review and post-deploy sweep found in its OWN fixes, both
shipped** — worth knowing because each was the fix re-creating, one layer up, the failure it removed:
(1) `354187e` — `agent_client_latched` was cleared by `off_menu` / `budget_blocked`, which are
`BatchingAgentClient` short-circuits that never reach the Anthropic client, so an off-menu symbol or a
budget-exhausted day would have silenced the critical alert while the lane was still latched. Now an
explicit two-set classification, and an unclassified future outcome leaves the level untouched.
(2) `13d94c9` — `agentic_budget_remaining_usd` is only set once the lane evaluates its budget, so a
fresh boot's default 0 made the sweep read `spend $3 >= 80% of $3` on a container that had spent
nothing. Now annotated inside a 5-min init grace (mirroring `AgenticBudgetExhausted`'s own `for: 5m`),
still alarming on a real 0 past it. **Standing lesson for any future sweep alarm: a false alarm is not
free — §3 makes it block the next pass, and an alarm that cries wolf trains the reader to skip it, which
is the habit that let the 07-27 outage stay invisible for three hours.**

**Stage 2 — learning-loop edge** (deployed 2026-07-08; Stage 1 cost floor CLOSED — see ladder
above). The reframing forensics (2026-07-08, still the operative diagnosis):

- **Learning loop was silently DEAD 4 days**: the ONE reflection candidate ever minted was killed
  by the polarity-blind banned-word validator; playbook stuck at v1 seed.
- **Entry decisions had NO measurable edge**: `long` decides averaged ≈0 to −3bps next-bar forward
  return at EVERY confidence bucket vs a 20bps fee hurdle (calibration over 928 decisions).
- **R:R inverted**: avg win +$0.06 vs avg loss −$0.21 — the plan gate floored only the take-profit
  side, never the stop.

**Stage-2 shape = a four-stage learning funnel:** reflection (Opus-4.8, calibration/attribution/
regime diagnostics + mint-time entry-rate floor + expectancy backtest) → offline replay scoring at
$0 (`pnpm eval:agentic`; NOT in the gated `test` suite — the §2.6 every-pass probe guards it) →
live A/B attribution (25%) → attributed auto-promotion (symmetric 10-trip floors + Mann–Whitney
PoS ≥ 0.70). Exit criterion: ≥2 promotions with version-attributed PnL AND rolling-7d net-of-cost
≥0.

**Durable findings (do not re-derive; full context in LOG.md by date):**

- **The whole funnel is trade-gated** — reflection and the promotion evaluator fire SOLELY via
  `onClosedTrade`; there is no wall-clock trigger (rejected on the merits — it would re-chew
  stale evidence). No trades ⇒ no Stage-2 signal, by design. (Pass 10, 2026-07-08.)
- **First-close-after-boot seed race:** the trigger check runs synchronously before the async DB
  seed lands, so the first close per strategy after a recreate primes but cannot fire; the second
  fires. Every redeploy resets in-memory primes. (Pass 21, 2026-07-13.)
- **Row-count journal windows are volume-fragile:** `recent(N)` shrinks in wall-clock terms as
  the universe/journal volume grows — three live defects from one class (#39 abstain window;
  Bug C `cfb2ed3` abstention-lapse 400-row window; Bug E `309bbfc` attribution 2000-row window).
  Any consumer measuring PER-VERSION or lifetime evidence must read lifetime stats
  (`versionEntryStats`) or epoch-bounded versioned rows (`recentVersioned`), never a shared
  recent(N); recency windows remain correct only where recency IS the semantics (reflection's
  evidence corpus). (Pass 33, 2026-07-18.)
- **Epoch-straddle bound:** promotion-walk cycles straddling an epoch can freeze a symbol group
  under entry-size drift (not count-preserving). Fixed by threading the epoch through all four
  consumers (`cc72a10`) + the 07-12 epoch move; declare new epochs only at flat instants.
  (Passes 14/17/18.)
- **Holds are model-driven:** 0 proposes + 0 rejections ⇒ the gate is not implicated; prescreen
  loosening surfaces more −EV bars and cannot reach the Stage-2 exit. (Passes 10/11; #29.)
- **Reflection repair chain, fully live-verified:** 30s-timeout abort (`ef325f6`) → validator
  false-positives (`f0c5e14`) → cadence 5→2 per-strategy (`3e5773f`) → transient-error trigger
  rollback + retry-with-feedback (`21c9b2d`) → **first live mint Pass 16 (v2)** → abstention
  deadlock diagnosed (Pass 21, #39) → entry-rate floor + abstain lapse (`b9dddc2`).

## A0 deep resource analysis (2026-07-20) — decision record

**COMPLETE ~08:30Z** (6 analysts + xhigh synthesis, ~1.5M tokens; report
`reports/loop/a0-analysis-2026-07-20.md`, evidence `reports/loop/a0-evidence-2026-07-20/`;
amended specs live in the plan file). Headline verdict: **the bot is starved, not broken.**
Binding constraints, in order: (1) consult cadence ~1-3 wakes/day vs the 10-20 design
intent — at historical entry fractions (3.8-9%) the 30-trip gate needs 24-56 consults/day;
(2) an entry mandate that structurally never fires (AND-veto filter stack, fee anchoring,
one-way reflection selectivity ratchet, functionally long-only perp — 0 entries in 19 v2
consults); (3) uncapped Opus reflection sessions ($2.25-2.93 each, 78-133 calls) blowing
1.8-3.9 daily budgets and blacking out consults; (4) plan_json EMPTY on every v2 row
(nextConsultBars/thesis unauditable — X6-X8 would have been built on nothing); (5) the
promotion gate is a cumulative ratchet (no trailing window) so idle burn permanently
raises the bar — re-stamp is costless only while trips=0.

**Adopted (loop-domain):** NEW pre-X2 activation bundle **XA1-XA7** (tasks #54-#60):
scheduler verify+tune → budget reservation + reflection carve-out → entry-mandate revision
(modulate-don't-veto, perp shorts, A/B→0 with its own decision record at execution) →
durable decision capture → exit invariants + repeated-noop breaker → spot channel tiering
→ one-time per-lane epoch re-stamp at final pre-campaign config. **X order resequenced:**
X6/X7/X8 (instrumentation, re-scoped: X6 build→verify+harden, X8 narrowed to the digest
table with epoch-bounded reads) → X2 (staged 8/menu-4→16/menu-6, sharding, funding
acceptance position-conditioned) → X3/X4/X5 (verify-before-build vs live tf1/pos1 blocks)
→ X9 (WATCH set per the report). Breakers stay FIXED at $1.50/$0.75 (raise considered and
rejected). **Owner flags:** CryptoPanic key wanted NOW (only external dependency);
optional R1 pull-forward if entries stay ~0 for 5+ days post-XA1 (R sequencing stays
owner-owned). First-campaign attribution is confounded by design (bundle + revision +
re-stamps + X2 land within days) — accepted, recorded, do not read the first delta as
pure playbook alpha.

## XA activation bundle (A0 → 2026-07-20) — decision record

The A0 verdict was "starved, not broken." The XA bundle makes the bot trade-capable BEFORE the
X-series enriches it. Shipped, gated (build+lint+typecheck+test+livegate all green), and
deployed to both local lanes, one commit each:

- **XA1** (menu-scoped consult gate + coalescing fix + cadence floor): verification found THREE
  defects behind the 2026-07-20 01:00Z fallback wave — (1) off-menu idle symbols recorded
  forced_* outcomes and had their consult clock + wake baseline reset by the batching client's
  inert menu-hold (fixed: strategy-side menu gate, fail-open, fill/rearm bypass); (2) the menu-12
  wave FRAGMENTED into six API calls because the early-flush threshold was the full symbol count
  (24, unreachable) — now min(symbols, menu), window 3s→15s; (3) knobs: fallback 16→8, wake
  0.015→0.008, nextConsultBars cap 64→32. WATCH-XA1: ≥8 batched consults/day for 3 awake days at
  ≤$1.50.
- **XA2** (attempt-level budget reservation + reflection carve-out): tryReserveAttempt($0.75)
  pre-flight → journaled `budget_deferred`, trigger preserved (permission gate fails CLOSED on
  attempt START; mid-attempt fail-OPEN); AttemptScopedBudget hard session caps (≤15 calls /
  ≤$0.75) bound the W6 runaway shape; shared daily meter stays the truth.
- **XA3** (entry-mandate revision): **CRITICAL find — the P2 expert seeds NEVER went live.** Both
  seed const versions said 2, but a pre-existing v2 REFLECTION row shadowed them via ensureSeed,
  so both lanes ran an old reflection lineage the ENTIRE v2 era. Bumped to v4 (above every DB
  row); v4 active live-verified both lanes. Mandate edits: info blocks are size MODULATORS not
  veto gates, RSI 55-75 continuation entries valid, fee floor quantified (skip only sub-60bps),
  weekend/Asia reduce-size, evidence-pace expectation explicit, perp short accountability. Spot
  `AGENTIC_DERIVATIVES_AB_PCT` 50→0 (change-discipline: the control arm stripped half the consults
  of the info bundle that drove the 8.4% vs 1.9% propose split).
- **XA4** (durable decision capture): plan_json was written ONLY on directive rows, so every v2
  hold dropped its model-chosen nextConsultBars → A0's "empty plan_json" finding. buildPlanJson
  now persists `{nextConsultBars}` on bare holds; readPlanJson coerces the schedule-only shape to
  plan=null on read (directive rows verbatim, I1b intact). max_tokens truncation now named with
  output_tokens instead of a generic no-tool-block warn. VERIFIED not a gap: consult usage is on
  agent_decisions and the in-process $/day breaker meters both decide + reflection — A0's
  "llm_usage only reflection rows" was a query mis-read on my part, not a code defect.
- **XA5** (repeated-noop breaker): a positioned symbol emitting the same action with no
  position-state change ×6 is suppressed at the gate until the position changes (the Bug-B
  flat-loop signature — ~55 consults/15h); fill/re-arm override. cancel-before-close verified
  already present. CARRIED (honest deferral): the terminal-NEW order sweep and the two
  exec-latency alarms from the XA5 spec are OMS/adapter work folded into Y2's sweep tool.

**Remaining activation steps (NOT done — deliberately not rushed):** XA6 (spot stream-load
tiering — a careful change to the ccxt ws layer that OOM-crashed twice; must not be rushed under
context pressure) and XA7 (evidence-epoch re-stamp, specced to land AFTER XA6 so the promotion
clock starts on the final build). Then the X-series (X6/X7/X8 → X2 → X3/X4/X5 → X9), R1-R3, and
X1-FINAL (GCP) per the plan file. Owner action still open: CryptoPanic key (X4).
[SUPERSEDED same-day by the record below — XA6/XA7-spot/X6/X7/X8 shipped 2026-07-20 ~09:00-09:40Z.]

## XA6 + X6/X7/X8 + XA7-spot (2026-07-20 ~09:00-09:40Z) — decision record

All gated (build+lint+typecheck+full suite+livegate green at every commit), deployed, live-verified.

- **XA6 — spot stream-load reduction (c0a03bc, b41a00a, 12ec4d6).** Three cuts, all fail-OPEN to
  full subscription: (1) ws `trades` augmented only when the paper sim exists — on demo lanes the
  channel fed nothing (StrategyHost drops TRADE events; trade-flow/liquidation feeds poll their
  own sources): ~24 subscriptions gone. (2) Per-symbol channel tiering: `book`+`trades` loops PARK
  for lite (non-menu, unpinned) symbols — no watch call, deregistered from the watchdog stall map
  and feed-health ages (a parked channel must never force a connection-wide close() or read as a
  stale feed) — and resume ≤30s after promotion through the paced gate; on demotion, a paced
  fail-open venue-side unWatch drops the subscription (verified in pinned ccxt 4.5.58).
  `candles`+`ticker` stay for all 24 (VERIFY-BEFORE-BUILD: the scanner ranks off streamed candles,
  not ticker/REST — A0's REST-fallback suggestion was written against a wrong assumption; nothing
  to build). (3) The decisive cut: `options.watchOrderBookRate=1000` on the market-data exchange —
  the active menu's high-volume diff-depth streams at ccxt's 100ms default were the dominant load;
  book consumers here are a top-of-book mid + 5s/30s staleness health, so 1s depth is ample.
  **Acceptance: CPU 118% → 24-28% steady (target <60%, 3 samples 09:30Z); perp ~1%; 10-12 books
  parked per ranking; 0 unwatch failures; 0 watchdog force-closes; rankings populate.** RSS
  1.34GiB stable vs the <1GiB target — NEAR-MISS accepted: level not growth (the R8-6 precursor
  is growth), watched below. 24h criteria (zero 1008 mass-closes, reconnect ≤ R8-2 baseline) fold
  into WATCH-XA6.
- **X6 — reflection verification+hardening (c1f2c16).** Verified pre-existing: Opus tier knob,
  decideModel pin on floor replay/candidate backtest (A0's "Opus pricing" concern was already
  fixed), outcome counter `agentic_reflection_outcomes_total`. Added: the tier-assertion spec
  (draft bills reflection model, floor replays bill decide model — pinned off request bodies);
  ANTI-RATCHET objective in the reflection prompt (missed winners weigh equal to realized losses;
  ≤1 gate tightened per revision, named in changelog; leaders-only rules must justify ~2
  trips/day; flat week = failing week); 07-16→17 execution-bug window excluded from journal rows
  AND realized round trips (`outsideExecutionBugWindows` — carried from XA5's tagging
  requirement). Budget framing verified at XA2's capped shape (≤15 calls / ≤$0.75/attempt/lane,
  one fire/UTC-week ⇒ worst-case ~$1.50/week both lanes, inside breakers).
- **X7 — thesis + hold post-mortems (21ba218).** decision-postmortem.ts (pure,
  counterfactual-scoring pattern): thesis grades vs realized outcome with LIVE exit semantics
  (stop at bar close per plan-executor; TP as close-crossing proxy — journal rows carry no
  intrabar H/L, documented under-count); hold post-mortems replay 24 forward bars per flat-book
  hold, missed-entry = >1% max favorable excursion. POPULATION SPLIT enforced: only hold
  DECISIONS graded — unfilled/rejected maker ORDERS never regret (P0b N=25: 5/6 were dodged
  losers). UTC-hour + weekday/weekend expectancy buckets; fail-open advisory relaxation line at
  entry rate <1/day (routed through reflection as a recorded revision, never a silent change).
- **X8 — per-version net-PnL reflection table (62a0657).** version-pnl-digest.ts reuses
  promotion-evaluator's `attributeVersion` join verbatim; unattributed bucket for
  pre-stamp/legacy/missing-join trips (fails toward unknown, never misattribution); window
  semantics per the thrice-burned recent(N) class — trips ride the epoch-bounded
  REFLECTION_EVIDENCE read, decisions ride recentVersioned's cap-not-recency convention.
  Reflection prompt told to weigh the table when revising.
- **XA7-spot — evidence-epoch re-stamp (one-time).** `PROMOTION_EVIDENCE_EPOCH`
  2026-07-19T18:57:09Z → **2026-07-20T09:36:00Z** at final pre-campaign spot config (XA bundle +
  X6/X7/X8 all deployed on the same boot). Flatness at stamp: 0 open orders, DUST-FLAT — 7
  sub-minNotional residuals (largest ~$0.25), the same standard the original W5 stamp used.
  Honest note: the first flatness query filtered `mode='demo'` (wrong string; lane mode is
  `testnet`) and returned a false-clean empty — the Y1 §C.9 negative-read-void class, caught by
  re-reading without the filter. Prior epoch carried only idle-consult burn and 0 trips — reset
  is costless now, expensive once trading resumes. NOT a repeatable ratchet-escape; perp's single
  stamp lands immediately after X2 deploys.

**WATCH-XA6** (24h from 09:30Z): zero 1008 mass-close events; forced-reconnect rate ≤ R8-2
baseline; spot RSS TREND flat (level 1.34GiB accepted; >20% growth between sweeps without a
deploy = R8-6 precursor, investigate before anything else); no STALE_DATA veto storm on
active-menu symbols (1000ms depth vs the 5s veto leaves 5x margin — a storm = revert
watchOrderBookRate to 100 and record). **WATCH-XA7-spot**: the promotion scoreboard walks only
post-09:36Z evidence; any pre-stamp trip/spend appearing in the walk is a defect.
**WATCH-X7/X8**: the first reflection attempt on this build renders postMortems + versionPnl
blocks in its payload (verify at the next weekly fire or trade-pair trigger); versionPnl shows
all-unattributed until post-stamp trips close (expected, not a defect).

## X2 stage-1 + XA7-perp + Y2/Y3 loop tooling (2026-07-20 ~10:30-13:30Z) — decision record

All gated (full suite 2534→2553 + livegate green per commit), deployed, live-verified.

- **X2 stage 1 (30817a7)** — perp universe 1→8: BTC ETH SOL ZEC AAVE NEAR HYPE KAITO (universe
  study: mean|daily ret| × log(30d mean quote volume) on production fapi, $0.50 floor;
  crypto-native only — equity-tokenized perps like KORU/MSTR scored high but trading-hour gaps
  fight bar scheduling/staleness; stage-2 reserve TRUMP UNI BCH). Every symbol + filter
  keyed-probe-verified on demo-fapi (#54 pattern); BTC perp step corrected 0.001→0.0001 (demo is
  finer; 0.001 was a ~$110 sizing quantum on the $1k book). Menu-4, fraction 0.35, cost stop
  1.50, portfolio consults ON at the XA1 15s window. Seed v5 (menu-breadth: concentrate, don't
  spray) active — perp DB version ceiling checked (4) before deploy, the XA3 collision class.
  NEW fh1 funding-rate-history payload block (usable while flat). Prompt HONESTY fix: the perp
  prompt promised margin/liq-distance fields the payload never carried — now teaches
  first-principles 2x-cap liquidation reasoning; the real fields are a follow-up before stage 2.
  **Live acceptance: batched consult c819a810 covered exactly the menu-4; all 8 symbols journal
  every bar; perp CPU ~1.8% / RSS 385MiB (ceilings crushed); 4 books tier-parked.**
  **PRE-AUTH (UNFIRED): stage-2 flip (16 symbols / menu-6) may be applied after one clean 24h
  soak inside ceilings (CPU <250% combined, RSS <2GiB/lane, zero 1008 mass-closes, recreations
  under half the rolling cap).** Sharding re-acceptance memo: post-XA6 stage-1 is ~21 subs (vs
  the ~64 the deferral memo feared) — full-drop recovery ceil(21/4)×1s ≈ 6s; sharding stays
  deferred. Known stage-1 residuals: trade-flow REST poll fails for HYPE/KAITO (no spot klines —
  fail-open, 2 of 8 symbols without tf block); funding acceptance is position-conditioned
  within the first post-deploy week (WATCH below).
- **XA7-perp (9f1c8c6)** — epoch 2026-07-18T15:36:14Z → **2026-07-20T10:42:00Z** immediately
  after the X2 stage-1 deploy. Venue-flat KEYED-PROBE-verified (fetchOpenOrders empty,
  fetchPositions empty); the 07-17 OMS row cbt019f6e8... (BTC SELL LIMIT state=NEW) is
  venue-ABSENT (OrderNotFound) — **named debt: the XA5(b) terminal-NEW class confirmed live; the
  app-side sweep/heal did NOT clear it in 3 days.** Both lanes now stamped once each; XA7 CLOSED.
- **Y2 (0dad180) + Y3 (2e0c191)** — pnpm loop:sweep / loop:collect / loop:digests. Live
  acceptance: three sweeps — real per-lane deltas on matching bootIds, boot-change resets clean,
  cost breakers read per-lane ($1.50/$1.50 post-X2). The tool caught its own precision defect on
  run 2: zero_decides fired on a 3-minute gap → fixed with a 30-min liveness elapsed floor
  (short_interval annotation below it; unknown elapsed still alarms). Collector smoke: sentinel
  self-verify, 26 heartbeats at 2s cadence, clean SIGTERM. Note: sandboxed smoke runs overwrote
  the shared watermark with probe-failed lanes — harmless (watermark is a cache, not truth) but
  explains one no-baseline sweep at 13:23Z.
- **Feeds verify-before-build (read-only, pre-X3/X4/X5):** X3 narrows to Fear&Greed (new) +
  futures taker-volume folded into the EXISTING positioning poller (pos1→pos2; long/short ratio
  already live); X4 core CLOSE-OBE (CryptoPanic adapter exists, fail-open, key-redacted) with
  three real residuals (currency filter hardcoded BTC,ETH vs 24-basket; no keyless boot log; no
  dedupe-by-id); X5 narrows to divergence flag + per-bar CVD series on tf1→tf2. No feed block
  acts as a veto on the active prompt path (XA3 semantics hold).

**WATCH-X2** (stage-1, from 10:42Z): ≥1 closed perp trip/day once entries begin; funding
acceptance = within the first week a position held across a 00/08/16Z boundary lands a
funding_payments row inside one poll interval; the 3× spot batch-element schema-validation
soft-holds (submit_portfolio element failed — NEAR/USDT 12:20Z) stay rare (<5% of batch
elements; a growing rate = consult spend without decisions, defect-class). **WATCH-Y2/Y3**: the
first scheduled pass rehydrates from loop:digests and runs loop:sweep as its evidence sweep
(Y4 wires this); collector survives the next host sleep with an annotated gap. **(Pass 35,
2026-07-20: first half RESOLVED POSITIVE — rehydration + sweep ran per v3, collector daemonized
via nohup pid 83510, first live-lane heartbeat 15:27:26Z verified. Host-sleep half stays OPEN;
note nohup survives sleep but not reboot — re-daemonize after any restart.)**

## X9 — round-7 extension gate + records (2026-07-20 ~15:30Z)

Gate GREEN at f4be8fe: build+lint+typecheck+format:check, 151 files / 2594 tests, livegate
41/41; both lanes redeployed healthy, 0 error-level lines post-boot.

- **X3/X5 feeds + X4 residuals (face895; enable f4be8fe two-step).** Scoped by the
  verify-before-build gap analysis (recorded above). Fear&Greed feed live both lanes (fg1
  block; keyless; container→alternative.me verified, index 29 "Fear" at deploy); futures taker
  buy/sell volume folded into the EXISTING positioning poller (`fapiDataGetTakerlongshortRatio`
  verified in pinned ccxt; pos1→pos2); trade-flow divergence flag + per-bar CVD deltas
  (tf1→tf2); sentiment residuals (basket-derived currencies incl. perp form, keyless boot log
  line, dedupe-by-id) — the sentiment feed itself stays OFF pending the owner's CryptoPanic key
  AND a SENTIMENT_FEED_ENABLED flip (both required).
- **R1 replay harness (ddd03a1).** `pnpm replay:agentic` — v2 contract over historical candles,
  candidate-backtest fill model reused verbatim, decide-model pinned (R8-8 class), per-run USD
  cap aborts via pre-call reservation. Exclusions spec-proven: promotion stats / round trips /
  version digest / exec-quality BY CONSTRUCTION (no fills, playbookVersion:null); the
  llmTokenTotals and lane-wide journal reads BY FILTER (notLike 'replay-%'). Reflection synthetic source opt-in
  (default OFF) and always labeled. Dry-run smoke: 8 decisions at a $0.50 cap, clean abort.
  Replay runs remain owner/loop-triggered (~$30-80 at real scale).
- **Lane metric parity (owner directive 2026-07-20) — premise CORRECTED.** Audit verdict:
  emission was ALREADY fully mirrored (all families registered unconditionally in
  ObservabilityModule; perp emitted agentic_version_* all along — 15k samples/30d). The named
  gap was the DASHBOARD: version panels bound to prometheus-spot only. Fixed: perp twins (ids
  119/120) + a venue protective-order lifecycle pair BOTH lanes (121/122 — emitted by both,
  panelized by neither); owner committed the dashboard (5ef8c52). Genuinely one-lane by design:
  funding_payments_ingested_total (perp venue guard, correct). Transients (perp flat ⇒ no
  position gauges) self-heal.
- **Shared-org rate-limit hazard (operational, recorded for GCP-era too):** the 11:00Z hour
  produced 21 RETRYABLE error decisions (16 spot / 5 perp) — heavy orchestration sessions and
  the trading app share ONE Anthropic org budget; my session's agent fleet exhausted it and the
  app's consults 429'd for the hour, recovering on reset. Mitigation options (not applied):
  separate key/org for the app, or orchestration restraint during trading hours. R1 replay runs
  inherit this hazard — their budget caps bound spend, not org-limit pressure.
- **Backlog hygiene (A0 items):** #47/#48 CLOSED-OBE by the v2 contract; #53 folded into X6's
  outcome counter (shipped); #18 folded into X7's expectancy buckets (shipped); #45 (venue-stop
  drift re-verify) re-checked against v2 exit directives — covered by the venue-stop-lifecycle
  suite + the new venue TP/stop panels; the 07-17 stale-NEW OMS row remains the open
  terminal-NEW debt item (named at the XA7-perp record).
- **Confounded attribution note (deliberate):** the first campaign's results cannot be
  attributed to any single change — the XA bundle, seed v4/v5, epoch re-stamps, X2 widening,
  and the feed additions all landed within days. This is accepted by design: there was nothing
  to attribute before (0 trips); attribution discipline starts NOW via X8's per-version table
  and the fresh epochs.

**WATCH-X9** (the A0-mandated observables, first checkpoint at the next pass, then daily):
(1) batched consults/day per lane vs the 8-20 band + entries/day vs the ~2.14 trips/day
promotion pace, with the derived earliest-promotion date (alarm when it slips >2 days/pass);
(2) per-trip net-of-cost vs the ~$0.70-1.00 bar once trips exist; (3) cost/day decomposed
(batches × size × per-consult cost), overshoot ≤10%; (4) XA5 regression guards (exit-reject
streaks ≥3, fill→terminal latency > reconcile interval); (5) P0b maker re-run re-arms at N≥15
v2-era maker entries (20% would-cross tripwire); (6) funding drag on perp shorts post-X2;
(7) CPU/RSS vs the XA6/X2 ceilings (spot ~25%/1.34GiB, perp ~2%/385MiB baselines);
(8) reflection exactly-one-fire/UTC-week at the capped shape, now rendering postMortems +
versionPnl + (when enabled) synthetic blocks; (9) replay-attempt cost at the decide tier with
epoch-cost exclusion holding (llmTokenTotals unchanged by any replay run); (10) fg1 block
renders in the first post-enable consult payload (fail-open: absence after 24h = feed defect,
not market signal).

## Y4 — daily-loop schedule RE-ENABLED (2026-07-20 ~16:00Z) — decision record

Two-step complete: playbook v3 (8fb908a — digest rehydration, loop:sweep evidence,
incident-first gate, autonomy per the 2026-07-17 delegation, current program context) +
SKILL.md rewritten to route through v3, then the scheduled task re-enabled. **Cadence decision:
KEEP 3×/day (02/10/18 local, unchanged)** — rationale: the hourly collector (Y3) now provides
the between-pass continuous watching that the discrete-pass model lacked (the R8-6/R8-7 miss
class), so passes become synthesis/action points, not the sole observation mechanism;
digest-driven triggering would need alerting infra that does not exist and the dashboard-only
alert posture is an owner decision. State hygiene: state.md 1434→788 lines, eight resolved
pre-2026-07-20 records moved verbatim to `archive/state-2026-07.md` (pointer section at the
foot); WATCH-V2-*/WATCH-R8-* moved with their records as superseded by the 2026-07-20
re-baseline; LOG.md gains the >30d rotation rule (no entries old enough to rotate yet). The v3
playbook's three-ledger check already paid for itself pre-enable: it caught the sweep tool's
stale perp breaker constant (0.75 vs the X2 1.50 — fixed, 76be4a8).

**WATCH-Y4**: the first post-enable pass (~18:07 local 2026-07-20) rehydrates from
`loop:digests`, runs `loop:sweep` as its evidence sweep, honors the incident-first gate, and
writes an honest LOG entry at bounded token cost — a pass that instead falls back to raw log
windows or hand-run sweeps = playbook-adoption defect, fix the doc not the pass. NOTE: the
collector (`pnpm loop:collect`) is NOT auto-started — the first pass will find a digest gap
since ~13:30Z and should start/daemonize it per the SKILL.md fallback note (deliberate: how to
daemonize on the sleeping MacBook is an operator choice; on GCP it becomes a compose service).
**(Pass 35, 2026-07-20 ~15:24–16:05Z — fired ahead of the 18:07-local slot — ALL first-fire
criteria MET: digest rehydration, loop:sweep evidence, incident gate honored (clean →
MAINTENANCE), honest LOG entry; collector daemonized as anticipated. One adoption gap
surfaced for v3.1: no concurrent-session guard — an interactive owner session was editing the
repo mid-pass, and the pass improvised a report-only/no-commit posture + a 3-min quiescence
wait before touching LOG/state; codify. Full entry: LOG.md Pass 35.)**

## R2 + R3 — program close at the pre-GCP stop line (2026-07-20 ~16:30Z) — decision record

R3 gate GREEN at bb21208: build+lint+typecheck+format:check, 152 files / 2619 tests, livegate
41/41; both lanes redeployed healthy.

- **R2 — episodic memory (bb21208).** Regime tags (trend / vol bucket / funding sign / UTC
  session) stamped into `plan_json.regimeTags` on EVERY journal write from this deploy — the
  tagged corpus builds now, on both lanes, replay rows included. Retrieval (mem1 block, ≤5
  tag-matched setups with read-time forward outcomes, synthetic-labeled) is gated by
  `AGENTIC_EPISODIC_MEMORY_ENABLED`, default OFF (byte-identical absent). **PRE-AUTH
  (UNFIRED): the loop may enable retrieval once ≥200 tagged rows exist per lane** (two-step:
  the knob goes into the lane files + zod schema at enable time — it currently reads the
  factory env map only, the selectAgentClient convention; noted debt). Forward outcomes are
  read-time joins — nothing is ever written back onto journal rows (rule 6).
- **Replay usage note (R1, standing):** replay runs are owner/loop-triggered with a REQUIRED
  per-run USD cap; tokens are provably excluded from epoch cost and all evidence walks. The
  shared-org rate-limit hazard (X9 record) applies doubly to replay — schedule runs OFF
  trading-critical hours until the app has its own key/org.
- **Program state at close:** every pre-cutover step of the plan is DONE — v2 contract, W/A0
  rounds, XA1-XA7, X2 stage-1 (+ stage-2 pre-auth UNFIRED), X3-X9, Y1-Y4, R1-R3, lane metric
  parity. **X1-FINAL (GCP terraform + lift) NOT STARTED — the owner-directed stop line.**
  Genuine owner-only items open (capability limits, not policy gates): CryptoPanic key (then
  SENTIMENT_FEED_ENABLED flip); GCP go-signal when ready — GCP is DEFERRED ENTIRELY to an
  owner-initiated session (2026-07-22 owner pick), the loop does not prep or initiate it.
  The pre-existing dirty-tree set (strategy-registry, ccxt-exchange.adapter, ccxt-normalize,
  3 specs — predates this program) is loop-domain to commit (2026-07-22 gate-override grant;
  husky pnpm shim resolved 2026-07-16) — no longer an owner action.
- The campaign measurement now runs itself: fresh epochs on the final build, the daily loop
  live on v3 (Pass 35 verified), the collector daemonized, and the WATCH set (XA1 / X2 / XA6 /
  XA7 / X7-X8 / X9 / Y2-Y3 / Y4) armed with dated checkpoints.

## Backlog (ranked; re-rank each pass)

Conventions: IDs are stable and never renumbered (LOG.md references them). **Re-verify a backlog
item against current code before implementing it** (Pass 2 precedent — inherited items go stale).
**Improvements ONLY — never bugs** (owner decision 2026-07-16, playbook §3 bug-routing
discipline): a defect is fixed in the pass that finds it, or — when it exceeds the §4 rails —
lives in § Flagged as an open defect until authorized. Open items first; the closed ledger keeps
one line per retired ID. The 2026-07-22 owner-directed sweep ("fix ALL that does not require me")
shipped **#46** (Thompson A/B routing, build-only), **#52** (ops-event logging), **#53**
(reflection-trigger counter) and closed **#43** as ALREADY-DONE (liquidation feed is live) — all
retired to the closed ledger. Every REMAINING open row is genuinely gated on live soak data or an
open design, NOT on owner action: **#18/#45/#47** DATA-GATED (0 closed trips / thin baseline
post-cutover), **#44** PROBE-GATED (demo orderList/oco capability probe), **#48** DESIGN-GATED
(rotation-vs-promotion-walk attribution; its 5→8 sequencing gate is OBE), **#42-ENABLE** fires
when the info-context A/B resolves.

### Open

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 18 | Per-hour/session expectancy gating (last residual of the W4.4 seeds — fee-tier/BNB dropped: demo fees flat 10bps, § Standing verdicts; trade-flow widening shipped Phase 3) | 2+ | M | DATA-GATED (2026-07-22 sweep): 0 closed trips post-cutover (worse than the 07-13 "10 trips" skip) — per-hour buckets statistically empty |
| 44 | Spot OCO exits (fuse executor stop + venue TP into one venue-side pair) — needs demo `orderList/oco` support proof; ccxt 4.5.58 has no unified spot OCO | 2 | M | PROBE-GATED (2026-07-22 sweep): needs a keyed demo-venue orderList/oco capability probe + the still-unmet venue-TP capture data (fills=0 post-cutover) |
| 45 | Trailing-stop plan field — wait for venue-TP capture data (Phase-2 WATCH counters) before designing | 2 | M | DATA-GATED (2026-07-22 sweep): venue-TP/stop capture data still unmet (fills=0 post-cutover) |
| 47 | Adaptive consult cadence (vary the 15m consult rhythm by regime) | 2 | M | DATA-GATED (2026-07-22 sweep): Phase-5 consult baseline still ~1 day old / trade-gated |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED (2026-07-22 sweep): the 5→8 sequencing gate is OBE (universe now 40 symbols + vol×ATR scanner + menu-8); residual = the open rotation-vs-promotion-walk attribution design |

## Flagged for human review (open)

> **This section is for defects that CANNOT be fixed without crossing the §4 MUST-NOT rails — owner
> capability limits only. It is not a defect queue.** Owner ruling 2026-07-27, verbatim: "do not
> defer defects … those must get fixed immediately if possible"; the daily loop is a profitability
> engine, not a bug tracker. Pass 40 initially parked four defects here citing the
> one-money-path-item-per-pass limit, was corrected, and fixed all four in the same pass. That limit
> governs chosen IMPROVEMENTS only and never licenses a deferral — now stated outright in playbook §4
> (§ DEFECTS ARE NEVER DEFERRED).

- **BOTH PROVIDER ACCOUNTS ARE UNFUNDED — the single blocker on the entire program (Passes 42/43,
  2026-07-28).** Anthropic returns `400 invalid_request_error: "Your credit balance is too low"`
  (exhausted mid-run at 21:16Z on 07-27); Moonshot returns `429 suspended — insufficient balance`.
  Consequences: the champion cannot trade at all (the lane latches, correctly, and journals named
  `client_latched` degrades), AND the frozen playbook-space replay — the one study that could answer
  whether ANY playbook text clears the +13.0 bps bar — cannot run. Purchasing credit is a financial
  action, outside what an automated pass may do; this is a capability limit, not a policy gate.
  **On resumption nothing needs redeploying or re-deciding:** the lane self-heals within 30 min of
  credit landing (`FATAL_LATCH_COOLDOWN_MS`, and that is a tested property — see WATCH-V4-5), and the
  study's corpus, 12 arms, metric and bar are all committed and frozen.
  **Read alongside Pass 41's diagnosis before funding, because they interact:** entries are
  significantly negative and worse than a random-bar placebo, so resuming spends ~$2.6/day
  accumulating evidence for a gate the current entry signal provably cannot pass. Whether that is
  worth doing is a decision about what this project is FOR — surfaced by Pass 41, restated by 42, and
  now unavoidable rather than deferrable. The loop does not decide it and has not assumed either answer.
- **TWO SCHEDULED PASSES RAN CONCURRENTLY IN ONE WORKING TREE (2026-07-28, Pass 42 + Pass 43).** Both
  sessions edited the same files; one committed the other's in-flight work twice (`ee4ddf3`, `7fa5ba8`)
  and caught the test count moving 3009 → 3011 mid-verification because writes were still landing. No
  work was lost, but nothing structural prevented it — a concurrent pass can land a half-finished tree
  inside another's gate run, and the resulting failure would be attributed to the wrong cause. Owner
  visibility wanted because the scheduler config is owner-owned; the loop-side mitigation (a lock file
  the playbook checks at §1) is loop-domain and is the next pass's first candidate.
- **SHARED-ORG RATE-LIMIT — RECURRING; owner action requested (Pass 35, 2026-07-20; first
  recorded X9 same day).** The trading app and interactive/orchestration sessions share ONE
  Anthropic org budget; heavy fleet windows 429 the app's consults. Recurrences beyond the
  recorded 11:00Z incident: perp 12:30:27Z ×4 + 14:15:39Z ×1, spot 15:15:30Z ×8 — every burst
  inside an owner-session orchestration window (RETRYABLE error decisions in agent_decisions;
  app self-heals next bar). Harmless at 0 entries; once trading resumes each burst is a missed
  decision on live bars. Structural fix is owner-side: **a dedicated Anthropic key/org for the
  trading app** (secrets = §4 MUST-NOT for the loop). Interim: scheduled passes run fleet-free
  during trading hours (Pass 35 did); heavy orchestration ideally avoids active-menu bar
  boundaries. Also still open at the owner: the CryptoPanic key (X4 sentiment enable).
- **OPEN DEFECT — PERP ALGO-STOP FILL INVISIBLE TO THE OMS ⇒ PHANTOM POSITION (Pass 30,
  2026-07-17; ACTIVE divergence since 2026-07-16 17:16Z; owner-gated money-path fix).** The #54
  stop architecture worked venue-side: the resting STOP_MARKET (trigger 64,348.6) FIRED ~17:16Z
  and closed the BTC 0.001 long at the venue. But the triggered algo order's spawned market order
  carries a venue-generated clientOrderId that `decodeClientOrderId` cannot map to an intent
  (fill-ingestor.service.ts:116-119) ⇒ the fill is never ingested (`fill poll: skippedUnknown=1`
  every ~10s since 17:16:07Z), the local book still holds the position, the stop intent stays
  ACKED forever, and the strategy submits a phantom SELL exit EVERY BAR (29+ SUBMIT_SENT→REJECT
  pairs since 17:30Z, raw_ack NULL, reason discarded). NO HALT fires because (a) P7f(3) correctly
  excludes algo intents from order-set reconciliation, and (b) NOTHING reconciles POSITIONS on the
  perp venue — the divergence class is structurally invisible. Evidence lane is corrupt from
  17:16Z (a real closed trip never closed locally; reflection/A/B starved). **Proposed remedy (3
  parts, all execution/OMS — outside §4 rails):** (1) `manageVenueStopPerp`'s reconcile: when a
  CONFIRMED-resting stop disappears from `fetchOpenAlgoOrders`, discriminate CANCELED vs TRIGGERED
  via `fapiPrivateGetAlgoHistoricalOrders({algoId})` and on TRIGGERED ingest the spawned order's
  fill through FillApplication (match by the algo response's orderId, not clientOrderId), journal
  `venue_stop_filled`, terminalize the intent; (2) fill-poll: an unmatched fill on a symbol with a
  live algo intent triggers the same algo-history lookup instead of skip-and-forget (today's
  skippedUnknown is a silent forever-loop); (3) systemic backstop: perp position reconciliation
  (`fetchPositions` vs local book) in the reconcile cycle — divergence is a HALTING mismatch class
  per rule 6. Also fold in: REJECT order_events journal a bare `{"type":"REJECT"}` — persist the
  venue error code/reason on the event payload (append-only-compatible: new rows only). Interim
  posture (deliberate): lane left running — venue account is flat, every phantom exit REJECTS so
  no money can move, and the $2/day breaker bounds the decide spend; do NOT let it open new
  positions before the fix (a real BUY would stack a live venue position under a phantom book) —
  if that risk is unacceptable, stop app-perp until the fix session. **P8d WATCH 2 = RED; L0→L1
  shorts pre-auth re-BLOCKED.** (Pass 31 posture check: containment HOLDING — one phantom exit
  REJECT per bar, no new entries — the phantom book itself blocks them, venue flat, cash
  unchanged; spend bounded by the $2/day breaker.)
  **FIX SHIPPED 2026-07-17 (`1ff1fc7`), BUT LIVE HEAL NOT YET CONFIRMED — the standing phantom
  persists; needs a keyed demo-venue probe next pass.** The 3-part remedy is coded, reviewed
  (4-lens adversarial, 2 must-fix + 1 should-fix all fixed), gates green (2190 tests + livegate +
  paper + eval), and DEPLOYED to app-perp (boot `c2b1043b`, healthy, no errors/HALT). ccxt
  correction applied: the flagged `fapiPrivateGetAlgoHistoricalOrders` does NOT exist in pinned
  4.5.58 — the adapter uses `fapiPrivateGetAllAlgoOrders` + `fapiPrivateGetAlgoOrder`. Extra
  review must-fixes folded in: the position axis is PERP-ONLY by config (`reconConfigFrom`, not
  method presence — spot would else spuriously HALT) and DEBOUNCED to 2 consecutive divergent
  passes (an ordinary stop fire flattens the venue ~10s before recovery heals the book; a
  single-pass HALT would fire on every stop); the spawnedOrderId-absent fallback matcher was
  REMOVED (exclusion-based ownership could fold a foreign fill). **SOAK RESULT (S6, honest):** the
  boot sweep left NO recovery warn and did NOT heal (local still `BTC/USDT:USDT 0.001@64577.6`),
  AND the armed position axis did NOT HALT. Both silences point to a LIVE demo-venue behavior the
  mocked unit tests can't reach and I couldn't pre-probe without keys (the #54 pattern):
  `fetchAlgoOrderStatus` returns undefined when no row matches the intent's clientAlgoId (row
  aged out / id mismatch ⇒ silent 'unknown', no heal), and `fetchPositions` most likely THROWS on
  the demo `fetchPositions` shape (⇒ silent `sweep_failure`, no HALT). Adapter code is structurally
  correct (delegations wired, both response shapes parsed) — the gap is real venue behavior.
  **NEXT PASS (needs live metrics/DB/keyed probe — all denied this session):** confirm via
  `reconciliation_mismatch_total{class=sweep_failure}` + the reconciliations row detail; P0d-style
  probe the demo-fapi `fapiPrivateGetAllAlgoOrders`/`fapiPrivateGetAlgoOrder`/`fetchPositions`
  actual shapes; fix the parse + regression-test; also verify the rehydrated in-flight intent is
  algo-classified (`hasLiveAlgoIntent`). Lane SAFE meanwhile (warmup ~3.5d, venue flat, no orders,
  $2/day breaker). **P8d WATCH 2 stays RED; L0→L1 stays BLOCKED until the heal is live-verified.**
  **SAME-DAY ADDENDUM (owner session ~12:30–13:00Z, keyed probe executed after all): BOTH
  hypotheses above were WRONG — and the "did not HALT" soak note too.** Probe + metrics truth:
  (1) **The axis DID HALT** — `kill_switch_state{HALTED_DEGRADED}=1`,
  `reconciliation_mismatch_total{class="position_drift"}` climbing every pass since ~1min after
  the `1ff1fc7` deploy; the engage line sat outside the soak grep windows and drift bumps are
  metric-only. The fail-closed backstop WORKS as designed. (2) `fetchPositions` round-trips CLEAN
  on demo (flat ⇒ `[]`, no throw). (3) The real no-heal cause: the fired stop's history row
  (`algoStatus=FINISHED`) carries the spawned order id as **`actualOrderId`** ('22141017991' —
  exactly the fill's own order id), not `orderId`; CANCELED rows carry `''`. Normalizer FIXED,
  live-shape regression-pinned, reviewer APPROVE 0 must-fix, gates green, deployed (boot
  `5403a8e0`). (4) That boot exposed the SECOND gap: recovery anchors only on LIVE in-flight algo
  intents, and the stop intent is now TERMINAL in the DB (0 intents rehydrated; a prior HALT's
  cancel path consumed it) ⇒ `recoverSymbol` returns 'none' without querying the venue ⇒ lane
  re-HALTed (correct, fail-closed). **Fix in flight (same session): DB-anchored recovery
  fallback** — persisted algo intents (incl. terminal) + late-fill application through the
  portfolio fill path, append-only event rows only. Heal target fill (probe-pinned): venueTradeId
  518032435 / order 22141017991 / SELL 0.001 @ 64181.4 / venueTs 1784222166363. Lane posture:
  HALTED = SAFE (kill switch refuses orders, venue flat, breaker bounds spend).
  **RESOLVED 2026-07-17 ~13:25Z (owner session) — PHANTOM HEALED, FULL CHAIN LIVE-VERIFIED (boot
  `051939bd`).** Three follow-up commits closed it: `333db28` (spawned order id lives in
  `actualOrderId` on demo — probe-proven, live-shape-pinned; reviewer APPROVE), `555cd48`
  (DB-anchored recovery — P7f(3) skips algo intents at boot so the in-flight anchor was
  structurally dead post-restart; anchor now = non-terminal order records + the P7c
  `loadIntentByClientOrderId` write-ahead row, discriminator `type==='STOP_MARKET'` because
  `order_intents` doesn't persist triggerPrice; reviewer APPROVE 0 must-fix, all 4 should-fixes
  landed incl. the halt-coordinator in-flight-leak guard and the once-per-poll anchor scan),
  `bd1cab2` (demo delivers algo timestamps as JSON STRINGS — the EpochMs mint threw, fail-open
  caught it exactly as declared, coercion + string-shape pin). **Live verification:**
  `fills_total` 0→1 (venueTradeId 518032435 ingested with exact strings 64181.4/0.001 + fee,
  under the stop's own coid); order row RECONCILE_REQUIRED→FILLED; `positions=[]` (book flat,
  equity=cash $4,998.77); FIRST reconcile pass `result="clean"`; `kill_switch_state{RUNNING}`.
  Interim-note correction: the drift axis HAD been HALTing the lane (HALTED_DEGRADED) between the
  first fix deploy and this resolution — the fail-closed backstop worked the whole time.
  **P8d WATCH 2 → GREEN** (the venue-stop fill is journaled and folded — retroactive but real).
  **L0→L1 shorts pre-auth: technical blockers ALL cleared — the ≥3-day / ≥5-closed-trips clean
  soak restarts from this boot; loop-domain to fire when met.** Evidence lane restored (3 closed
  perp trips on the book). **Pass 32 soak check: POSITIVE — 351 consecutive CLEAN reconcile
  passes 13:23:53→16:18Z, positions table empty (book flat), kill switch RUNNING, 0 mismatches.**
  Perp image note: RESOLVED Pass 33 (2026-07-18) — the Bug E redeploy (`309bbfc`, perp boot
  `b1995dce`) folded `f9b7d56` into the perp lane.
- **PERP VENUE-STOP (FLAG 1, #54) — RESOLVED 2026-07-16 (both layers shipped; Pass 29 closed it).**
  Layer (a) `25563bc` (throw containment + `reconcile_error`); layer (b) `34bdddd` (owner-directed
  `/goal` session): adapter parses the bare-array response AND matches the venue market id
  ("BTCUSDT") the rows actually carry — the second probe finding; the Pass-28 flagged diff alone
  would have left resting stops invisible to their own reconciler (duplicate-placement hazard).
  **Full stop architecture live-verified** (boot `803e9d0b`, 16:45–17:00Z): STOP_MARKET placed
  through the full OMS path, RESTING on the algo rail (probe-confirmed), reconcile-confirmed next
  bar (`skipped_existing`, registry `venueStopResting=true` ⇒ executor/S3 stand-down inside the
  force band); venue TP drift-cancel/re-place clean; `unknown-resolver`'s algo rail healed with the
  same fix. **Residual watch:** `reconcile_error` should now stay 0 (non-zero = NEW failure mode);
  `venue_stop_filled`/`venue_tp_filled` journal rows on the next closed perp trip = P8d WATCH 2.
  **L0→L1 shorts pre-auth:** technical blocker CLEARED; the soak criteria still bind (≥3 days clean,
  ≥5 closed perp trips, zero reconciliation mismatches, WATCH 2 green).
- **OPEN DEFECT — #49 signal-sink cross-signal pair atomicity (reclassified from the backlog
  2026-07-16 under the bug-routing policy; observed Pass 26, SPOT):** a resting venue-TP GTC locks
  the base qty a concurrent same-price marketable sell needs — 3 self-healing LINK IOC-exit
  TERMINAL_REJECTs (one/bar, `raw_ack`=null local refusal, ~0.0096 free vs 12.03 needed). Benign as
  observed (profit-take exits ≥ entry, position held), but LATENT: an S3/protective-stop fire on a
  TP-locked base is defeated unless the TP is cancelled FIRST — a cancel-before-fire ordering the
  signal sink does not guarantee today. Exceeds the signal-sink scope exception (CANCEL_OPEN routing
  only) ⇒ owner-gated money-path design: protective exits must atomically cancel the resting
  same-side venue order before (or with) the exit submission. Note: spot-only exposure — on perp the
  margin model has no base-lock, and the venue stop now rests server-side (#54 fixed); on spot the
  P7f double-lock forbids venue TP+stop together, so the executor/S3 stop is exactly the path the
  TP base-lock can defeat. **RESOLVED 2026-07-17 (owner session, `1b8d872`, spot boot
  `482d5ab1`).** Shipped design: compound signal — optional `cancelBeforeSubmit` on
  protective/managed exits; the signal sink cancels the resting same-side venue order (awaited to
  CANCEL_ACK) then submits the exit inside ONE per-key chain entry so nothing interleaves; cancel
  failure still submits the exit (fail OPEN for the protective action — venue rejects, next tick
  retries; reduce-only sizing bounds the race). 2-lens adversarial review, 1 should-fix found +
  fixed (the cancel-step journal row uses a `:cbe`-suffixed dedupeKey — same-PK collision was
  silently dropping the APPROVED+intentId row). **WATCH:** the next S3/protective or stop/max_hold
  exit against a resting TP journals `CANCEL_BEFORE_EXIT:<n>` then the gateway verdict on distinct
  rows, and the exit FILLS (no TERMINAL_REJECT insufficient-base loop); a `signals insert failed`
  ERROR on this path = the PK fix regressed.
- **AVAILABILITY (Pass 17, 2026-07-12; updated Pass 23; REGRESSED Pass 25):** the stack runs on the
  owner's MacBook; host sleep throttles everything (worst measured: 8%/24h duty cycle; the SOL trail
  fired 10h late → gap loss). Pass 23 read **100%/24h for two consecutive days**, but **Pass 25
  observed a fresh ~6h host-sleep gap mid-pass (~01:00–07:20Z 07-15)** — the app cycled several short
  boots and the loop pass itself stalled ~6h between commit and deploy. The 100%/24h improvement did
  NOT hold. Standing ask unchanged and now re-evidenced: keep the Mac awake on AC + auto-login (or
  move the stack to an always-on host; compose is portable, §5 backups cover the DB). Residual
  dependency: Docker Desktop "start at sign-in" (restart policy `e4542fb` only acts once the daemon
  is up).
- **6.9-LINK wallet scar (~$55):** historical unapplied recovered-order fill (pre-`b00c886`),
  journaled+deduped so no walk sees it post-epoch; venue-side manual sell is optional wallet
  hygiene only.
- **`ReconciliationMismatch` severity — RESOLVED-STALE 2026-07-16:** the Pass-8 flag said "restore
  critical when #24's class split lands"; #24 landed (`e909664`) with a deliberate severity design
  the flag predates — benign classes excluded from the alert entirely, HALTING classes paging
  critical via `ReconciliationHalt`/`KillSwitchEngaged`, and the residual actionable-but-non-halting
  classes (sweep/query failures, non-adoptable statuses) at warning (rationale in
  `observability/alerts.rules.yml`'s own comment). Restoring critical here would over-page
  non-halting mismatches; the implemented design supersedes the interim note. No change.
- **CI gap:** RESOLVED 2026-07-13 build-out (`dafe9aa`, #30 shipped) — the remote CI effect is
  verifiable only on the next push to the remote (no-push rule); keep the §2.6 every-pass probe.

### Standing verdicts (binding evidence — passes must NOT re-derive these)

- **BUILT DARK — the promotion gate's passive benchmark (Pass 41, 2026-07-27; specified `4d930e0`,
  built `6cb9c6d`).** Supersedes this entry's former "SPECIFIED, NOT BUILT" text, which was stale the
  moment the code landed. **What exists now:** `PassiveBenchmarkPort` + `PASSIVE_BENCHMARK` token
  (`src/ports/trading/promotion.ts:227`), an `@Optional()` trailing constructor arg on
  `PromotionReadinessService`, `passivePnlQuote` in the evidence payload, and reason
  `BELOW_PASSIVE_BENCHMARK` at `promotion-readiness.service.ts:133`. **What does NOT exist: any
  provider binding the token.** No composition-root binding ⇒ `benchmark` is `undefined` ⇒
  `passivePnlQuote` is `null` ⇒ the clause never fires and the verdict is byte-identical to the
  pre-2026-07-27 gate. That is the intended two-step enable, not an oversight; step two is binding a
  provider, and it is deliberately NOT taken while the program has no strategy worth arming.
  - **Correction to a claim made during Pass-42 planning:** "the bar is now beat-the-basket instead of
    net > 0" is FALSE. `:130` `NON_POSITIVE_NET_PNL` and `:133` `BELOW_PASSIVE_BENCHMARK` are
    independent `reasons.push` clauses — both block, and once the port is bound a strategy must clear
    BOTH zero and the basket. The change is strictly stricter, which is the safe direction for a
    live-arming input.
  - **Known weakness of the bar itself, recorded before it is ever enabled:** the required improvement
    spans ~0 to ~190 bps/trip purely as a function of what the basket does over the window. A criterion
    whose outcome is dominated by an exogenous variable is a beta bet. Whoever enables step two should
    exposure-match the benchmark to the strategy's realised gross exposure (~50% here), or prefer an
    A/B arm difference (regime-controlled by construction) as the kill criterion with beat-the-basket
    kept as a separate deployment gate.
- **NOT A FINDING — the inversion test is a tautological restatement (Pass 42, 2026-07-28; harness
  `test/backtest/inversion-test.mjs`).** It reproduces the ENTRIES verdict exactly (−16.9 bps at h=1)
  and reports the sign-flipped mirror: **+16.9 / +31.9 / +47.3 / +66.5 bps at h=1/4/8/24.** Those
  numbers are **arithmetic, not evidence.** Negating every observation negates the mean and mirrors
  the CI, the t-statistic, both chronological halves and the placebo p by construction — a run that
  did NOT reproduce them would mean the harness was broken. **Do NOT cite +66.5 bps, or any inverted
  figure, as an edge.** The only genuinely new content is magnitude versus the fee, and there:
  - **h=1 FAILS the fee**: +16.9 gross against a 20 bps round trip is **−3.1 net**, and the bootstrap
    lower bound (+10.9) sits under even the optimistic +13.0 bps demo-fee requirement.
  - h=8/24 would clear on point estimate, but rest on n=61 entries, a single ~4-day regime, and a
    **mixture over ~9 playbook versions** — the same three weaknesses that make the original finding
    an indictment of the churning mixture rather than of any one evaluated playbook.
  - **Adverse selection may not invert.** Entries were maker-side at 76% fill; being reliably on the
    wrong side of a print does not imply the other side of that print was available to take.
  Status: a **hypothesis for offline replay**, admitted as one arm of the Pass-42 playbook-space
  study, and nothing more. Fading a model is a classic overfitting trap and this is exactly its shape.
- **HORIZON WAS NOT THE CONSTRAINT EITHER, AND ACTIVE LOST TO PASSIVE ACROSS 7 YEARS (Pass 41,
  2026-07-27; preregistered `research/studies/horizon-and-baseline-2026-07-27.md`, harness
  `test/backtest/horizon-study.mjs`).** Tests the named frontier the settled price-TA verdict left
  open (multi-day cross-sectional momentum — the killed search covered 15m–1d only; no cell here is
  inside 1d). 4 signals × 3 horizons (7/30/90d) × 2 fee tiers over 2,600 daily bars, 16 assets,
  2019-08-04 → 2026-07-27. **24 of 24 cells FAIL.** Every cell has NEGATIVE excess over the passive
  basket; `xs_rev7`@h7 is significantly worse at **p=0.0000 over 364 periods**. Maker fees (4 bps)
  move results ~+0.16%/period and change no verdict — **the fee tier was never the binding
  constraint at these horizons.**
  - **The under-powered result reversed under power, which is the methodological headline.** At 400
    bars, three momentum signals showed +6.3 to +7.2% excess per 30-day period, both halves
    positive, compounding to +25–38% vs +14.5% buy-and-hold. At 2,600 bars the same cells read
    −5.36%, −6.37%, −5.46%, both halves negative. n went 11 → 84. Acting on the first run would have
    shipped a value-destroyer with a plausible story. **Never act on a sub-n≥12 cell.**
  - **Why every active strategy lost: the return was BETA and long-short discards it.** The basket
    earned +6.64% per 30-day period; a market-neutral construction strips that out and keeps only
    cross-sectional dispersion, which was negative after costs at every horizon. The strategies did
    not fail to find the return — they were built to throw it away.
  - **The gate asks the wrong question.** `PromotionReadinessService` requires net-of-cost > 0. A
    strategy earning +3%/yr while the basket earns +12% passes it and destroys value. Nothing in
    this program had ever been benchmarked against doing nothing, which is why it took until now to
    notice the bot lost ~4% of its book over a window where the same 16 assets returned **+0.39%**
    equal-weight. **Any future strategy must clear the passive basket net of all costs, not zero.**
  - **Survivorship caveat, load-bearing:** the 16 assets survived to 2026 and were scanner-liquid,
    so the +697% buy-and-hold figure is inflated and is NOT an achievable ex-ante return — nobody in
    2019 could have known to hold these names. The bias inflates basket and strategies alike, so the
    *excess* is the robust quantity, and it is negative everywhere. The robust claim is RELATIVE
    (active lost to passive), never the absolute passive number.
- **NON-PRICE CHANNELS — Wikipedia attention and Deribit DVOL/VRP TESTED AND FAILED; GDELT UNTESTED
  (Pass 41, 2026-07-27; preregistered `research/studies/nonprice-channels-2026-07-27.md`, harness
  `test/backtest/nonprice-study.mjs`).** This tests the program's own long-standing claim that "the
  only possible edge is information the price series does not contain" — which had never been
  checked. **15 of 15 runnable cells FAIL.** Every 95% CI spans zero; the best p across all cells is
  0.072, short of even an uncorrected 0.05 against a pre-registered Bonferroni bar of 1.85e-3. No
  cell reached the holdout. Wikipedia (n≈2,350, 10 assets over ~9 months, ≥100 views/day floor) is a
  genuinely powered null; DVOL (n≈440–480, BTC/ETH only) is a weak test, so a modest DVOL effect
  could still hide inside its intervals. **Do NOT quote the point estimates**: `views_z`@h7 reads
  +345 bps and `vrp`@h7 +268.6 bps, with CIs [−20, 689] and [−211, 620] — at this n a 7-day horizon
  cannot resolve them from zero, and quoting either as a finding is exactly the error that killed the
  funding-contrarian frontier. **GDELT is UNTESTED, and is now established as UNTESTABLE VIA DOC 2.0
  FROM THIS HOST** (12 cells; closed 2026-07-28, Pass 42). The 7-day-chunk backfill ran to completion
  as a background job — **366 requests, 0 successes, 122 failed chunks on every one of the three
  queries.** A follow-up single-request probe after minutes of idling still returns:
  - `HTTP 429 — "Please limit requests to one every 5 seconds… All high-traffic users should switch
    to our ngrams dataset"`, on `https` and `http`, on `timelinetone` and `timelinevol`, at
    `timespan=1d` (the smallest possible ask). DNS resolves fine (104.197.47.124), so this is a
    throttle, not an outage.
  - **The 6 s spacing was not enough and the throttle is STICKY**: it latches after a burst and does
    not release for at least tens of minutes. The pre-registration predicted the stickiness; what is
    now settled is that no pacing this harness can apply makes a full-window backfill possible.
  - **Do NOT re-run `fetch-nonprice.mjs gdelt`.** It cannot succeed from this host, and each attempt
    re-latches the throttle.
  - **The one real alternative, named and NOT built:** GDELT's own 429 body points high-volume users
    at the **Web NGrams dataset** (bulk files, not a per-query API). That is a genuine path to the
    same signal class, and it is deliberately not built — it is a new bulk-ingestion component, and
    the non-price hypothesis has already failed 15 of 15 runnable cells on two independent channels
    inside a program whose central finding is that this architecture's entries are anti-predictive.
    Recorded as a costed frontier, not a backlog item.
  - The Bonferroni denominator was fixed at 27 up front, so the correction stands unchanged and no
    late-arriving channel can move the bar. **The non-price study is CLOSED at 15/15 FAIL + 12
    permanently untested.**
- **THE ENTRY SIGNAL IS SIGNIFICANTLY NEGATIVE, AND WORSE THAN RANDOM (Pass 41, 2026-07-27;
  31-agent adversarial diagnosis, 2,300+ cuts, 24 actionable claims attacked, 6 survived).** This is
  the program's central finding and it supersedes any assumption that the lane merely lacks edge.
  - **Forward returns are negative at every horizon** (n=61 entries): +1 bar **−16.9 bps t=−4.58**
    CI [−25.2, −8.6], hit 25% against a ~50% base; +4 −31.9 t=−2.78; +8 **−47.3 t=−3.95**; +24
    −66.5 t=−3.14 (n=57). All 12 primary cells negative (P = 2.4e-4 under coin flips). Survives
    **Bonferroni over 195 cuts** (α=2.56e-4) at four cells. Trimming the best and worst observations
    makes it MORE negative (−17.3 t=−4.95; 3+3 → −18.0 t=−5.80). Both time-halves negative at all
    horizons. Long leg n=43 carries it (−19.9/−29.2/−56.3/−93.5); the short leg n=18 is not
    significant on its own. Market-neutral residuals are ~half the size and still significant at
    h=1/8/24 (−9.8 t=−2.84 / −28.0 t=−2.66 / −35.8 t=−2.09) but NOT at h=4 — so the causal
    "picks bad bars" reading holds net-of-beta at three of four horizons, not all four.
  - **Worse than random: a random-bar placebo on the same symbols and long/short mix gives
    p = 0.0013–0.0037.** Entry TIMING is measurably worse than choosing a bar by coin flip.
  - **A random entry at the model's own declared 2%/4%/48-bar geometry earns gross −1.07 bps — a
    martingale — and net −21.07 bps, i.e. exactly the fee** (34 symbol×side cells, 32,368 overlapping
    windows, intrabar resolution, cluster-robust t = −12.83). A six-bracket geometry sweep
    (1/2, 1.5/3, 2/4, 3/6, 2/2, 4/2) lands every bracket in [−24.32, −18.93] bps. **Under any
    bracket a random entry earns ≈0 gross, so net ≈ −fees always. Only entry alpha exceeding fees
    can produce profit.** CORRECTION to the exit study's arithmetic: the correct break-even is the
    CONDITIONAL (stop-or-TP) hit rate **36.67%**, not 34% — max-hold exits dominate the population.
    Observed conditional hit rate 18.85%, cluster CI [13.42, 22.92], P(≥34%) = 0.
  - **No conditional subgroup rescues it: 1,807 cuts examined, 0 of 188 counterfactual cuts positive
    at n≥8.** Smallest p among ALL positive-mean cuts is 0.302; BH at q=0.05 yields zero discoveries;
    family-wise permutation over 120 realised cuts gives p = 0.378. **There is no attribute-based
    entry filter to deploy** — the search is exhausted over everything the system records.
  - **The one attractive-looking cut is an artifact.** `stopLossPct > 2.5%` realised +203.8 bps is
    **4 of 4 KAITO**, and KAITO is rank 1 of 17 on unconditional 48-bar drift in this window
    (+2238 bps total). All four winners won by DISCRETIONARY early close, not geometry: replayed
    mechanically the same cut goes **+203.8 → −158.1**. Counterfactual stop-width buckets show the
    widest is worst (−197.5). **Do not widen stops. Do not concentrate on KAITO** (its own realised
    aggregate is n=8, −2.2 bps).
  - **Cost cutting cannot close the gap.** Gross realised −$20.10 on $1,982.66 of notional =
    **−101.9 bps/trip** (95% CI [−185, −8], P(gross > 0) = 0.018); marking the 4 open cycles — all
    four losing — gives n=27 at **−106.0 bps/trip**. Required gross edge for net-of-cost break-even
    under the BEST achievable cost structure is **+13.0 bps/trip** (demo fees) or **+24.2** (live
    20 bps). The gap is **115–130 bps/trip**, and LLM spend is $15.48 of the $37.56 net loss — **free
    inference still leaves −$22.08.** Do not propose cost work as a profitability lever.
- **NO EXIT RULE RESCUES THESE ENTRIES — verdict ENTRIES (Pass 41, 2026-07-27; pre-registered
  study `research/studies/edge-verdict-2026-08-10.md`, harness `test/backtest/exit-attribution.spec.ts`
  over `test/backtest/exit-simulator.ts`).** Three arms over the 23 recorded round trips, intrabar
  stop/TP resolution, zero LLM calls: Arm 1 actual (discretionary closes) −108.1 bps at 17.4% hit;
  Arm 2 the model's own declared plan run mechanically −78.4 bps at 22.7%; Arm 3 best of 14 geometry
  cells (stop ×1.5, TP ×0.5) −45.0 bps at 40.0%. **All 16 cells negative.** Break-even is ~34% at the
  model's own declared R:R 2.02 after 20 bps fees. Wider stops buy hit rate monotonically
  (17.4% → 40%) without turning expectancy positive and a shorter take-profit wins at every stop
  multiple — the signature of entries with no directional edge. **Do NOT re-run exit-rule sweeps.**
  Two corollaries: letting the declared plan run beats the model's own hand by 29.7 bps (real, but
  under the pre-registered 30 bps bar and nowhere near profitability), and the live exit mix is 16 of
  22 closes by the model's own `close` action against 3 venue stops and 2 venue TPs, with
  `PROTECT_STOP_LOSS_PCT=0.06` never having fired — `pnl-v1`'s "stopped out 2-3× more often than they
  take profit" was a single-symbol BTC-perp 4h BACKTEST and does not describe this book.
- **Consult cadence is ON TARGET; batching fragmentation is not a profitability lever (Pass 41,
  2026-07-27).** The true unit of work is 627 symbol-decisions over 6 days = 104/day ≈ 13
  menu-waves/day against the 16/day design point at `.env.app:100`; the model picks
  `nextConsultBars` 8/12/16, not 1. Any "N consults/day vs 16" comparison must count menu waves, not
  API calls — the two differ ~5× because batching fragments (133 of 272 calls carry one symbol, only
  6 the full menu, since each of the 40 strategy instances holds its own `barsSinceConsult` while
  `agent-prompt.ts:458` tells the model the value is portfolio-level). Fixing that fragmentation is
  worth ~11% of tokens ≈ **$0.20/day** — input per symbol only improves 3,060 → 2,571 from batch-1 to
  batch-8 because the shared prefix is small and already cached. Worth doing for HTTP volume and
  shared-org 429 pressure; not for money. **The remaining cost lever is payload SIZE**
  (~2,600–3,000 input tokens per symbol-decision; decide $10.53 / reflection $5.01 ≈ $2.6/day;
  $0.0167 per symbol-decision), which is what the C4 per-block ablation measures.
- **Gate-override audit + classification (2026-07-22; owner gate-override grant, verbatim: "You
  are welcome to change any owner gate/decision (not live flip; that's only me)"; change-discipline
  binds every change — pre-register, record what/why, never rewrite history).** A four-pass
  read-only audit (code gates, live-flip boundary, memory gates, policy gates) enumerated every
  owner/operator/hard gate in the program; the owner then overrode ALL of them except one.
  **KEPT — the ONLY human gate, unchanged:** the 16 live-flip code gates + the bootId arming
  ceremony + PromotionReadinessService (≥30 closed demo round trips AND positive net-of-cost PnL
  over ≥14d); plus the §4 MUST-NOT structural invariants (risk/execution/OMS semantics, append-only
  tables, secrets/redaction) — rails on what a change may DO, not gates on who approves it.
  **OVERRIDDEN — now loop-domain:** the three operator-recovery gates (kill-switch HALT resume,
  daily-loss halt resume, operator-drained-strategy recovery → precondition-gated AUTO-resume);
  commit + deploy (husky pnpm shim resolved 2026-07-16 — the loop commits AND deploys its own work);
  and bug/tech-debt fixes (fixed + shipped immediately on discovery, the backlog holds ONLY
  profitability improvements). **Genuine capability limits that still need the owner (a lack of
  credentials/hardware, NOT a policy gate):** a dedicated Anthropic org key, the CryptoPanic key,
  an always-on host, GCP credentials, and live trading capital — and GCP itself is DEFERRED ENTIRELY
  to a future owner-initiated session (the loop does not prep or initiate it). This extends the
  Strategic-frame owner decisions above (2026-07-10/12/17/22) — grant 7 is the widest.
- **Price-TA edge search is settled EMPTY** (2026-07-12 ultracode session: 4,562 backtests, 8
  families, long+short, 15m–1d, fees 0→20bps — ZERO honest survivors at any fee level incl.
  0bps; `reports/loop/multi-strategy-search-2026-07-12.md`). The LLM lane cannot profit by
  reading price better; its only possible edge is information the price series does not contain.
  **Do NOT re-run price-TA edge searches.** (Frontier if ever wanted, forward-test-only:
  long-short daily cross-sectional momentum on perps.)
- **Funding-carry NO-GO** (0/126 cells, `reports/loop/carry-study-2026-07-10.md`; re-test harness
  `test/backtest/carry/`, ~14-day cadence — next due ~2026-07-24 under the winsorized benchmark,
  write a NEW dated report). **Funding-contrarian frontier KILLED on second holdout**
  (`reports/loop/nonprice-sweep-2026-07-12.md`; 134/150 frontier cells died, top cells flipped
  negative — regime beta, not signal; do not redo). Both cheap non-price series are dead as
  directional signals; remaining edge channels = the live info-context A/B and event/news-class
  information with no fetchable history.
- **Demo fees are REAL and exactly 10bps flat per leg, maker=taker** (verified 2026-07-12) ⇒ fee
  levers cannot move demo PnL; fee-tier/BNB work is live-parity prep only.
- **Decide model: claude-sonnet-5 stays champion — E2 re-test trigger CONSUMED 2026-07-17
  (Pass 31).** First run (07-12, n=50): haiku-4.5 fails hold-agreement + propose bars. Re-test at
  corpus ≥600 (728; n=100 newest rows, registry row 129, scorecard
  `candidates/e2-model-eval-2026-07-17.json`): HOLD decisively — schema-valid 0.83, hold-agree
  0.78 < 0.85, forward proxy −27.9bps vs champion +17.8bps; the "cheaper-and-more-proposing"
  profile did NOT persist (propose ratio 1.8→0.8, propose-agreement 0.2). No further scheduled
  re-test — revisit only on a material payload/regime change (e.g. post-factorial always-on info
  blocks). Opus-4.8 decisively rejected (07-13). **Thinking-on: NO FLIP** by pre-registered
  criteria but strongest lever surfaced → absorbed into the P8a factorial (#42 CLOSED-OBE). E2
  re-run recipe (env hygiene — the SAFE recipe): LOG.md 2026-07-10 ~22:00Z incident-pass entry.
- **Kimi-K3 offline replay: HOLD decisively (2026-07-21/22, n=100 newest payload rows; v3
  registry row 1; scorecard `candidates/kimi-k3-model-eval-2026-07-21.json`).** Schema-valid
  0.85 < 1.00, hold-agreement 0.17 (champion held 100/100, K3 proposed ~83%), cost −32% where
  the bar demands −50%; plan-sanity 1.0 was its only pass. No live A/B, no scheduled re-test —
  revisit only on a material payload/regime change or a K3 serving-stack revision, via the
  standing eval-lane routing knobs (`AGENTIC_EVAL_BASE_URL`/`_API_KEY`, LOG.md 2026-07-22).
- **Trade-model head-to-head (v3 rich contract, HARDENED): NO FLIP, loop stays on Claude
  (2026-07-22, n=200/leg, max_tokens 4096, thinking disabled; registry rows 6 sonnet-5 / 7
  kimi-k3; scorecard `candidates/trade-model-eval-headtohead-hardened-2026-07-22.json`).** A
  REAL comparison (all five criteria evaluated): kimi-k3 fails criterion 1 (schema-valid 0.71 <
  0.805) and criterion 4 (propose-ratio 5.43 ∉ [0.5,1.5]); passes 2 (sanity 1.0=1.0), 3
  (directional proxy +5.42 vs −4.68bps), 5 (cost −54%). kimi's profile: more willing to trade
  (76 proposes incl. 12 shorts, rate 0.38 vs sonnet 0.07), directionally better on its picks,
  half the cost, but less schema-reliable (58 vs 39 errors — kimi's mode is thesis >300 chars).
  Criterion-4 caveat: the sonnet baseline is itself unusually passive (0.07 vs champion 0.125),
  so the ratio bar is degenerate against it (verdict unaffected — schema-valid also fails). The
  PRE-FIX legs (rows 2/3) are superseded — they ran the broken contract where sonnet completed 0
  valid proposes (criteria 2/3/4 null); retained only as contract-defect evidence. Re-test
  trigger: native v3 corpus once it holds ≥200 payloads with ≥20 `open_*` proposes.
- **v3 submit_trade contract non-compliance is a real defect, now FIXED (2026-07-22).** Both
  sonnet-5 and kimi-k3 fail `tradeDecisionSchema` on a large fraction of propose attempts under
  thinking-disabled/forced-tool; production silently degraded every rejection to a masked hold
  (67 of 100 live consulted holds since the 07-21 cutover). Root cause = model-facing required-set
  gap + thesis-cap + array-not-string; fix = prompt hardening + metered degrade path
  (`agentic_schema_rejections_total`, `schema_rejected:` rationale). Post-fix on the hardened
  head-to-head: sonnet schema-valid 0.69→0.805 and 0→14 completed proposes; kimi 0.62→0.71.
  Closes WATCH-V3-3. Deploy pending — loop-domain (I commit + deploy per the 2026-07-22
  gate-override grant).
- **Directional seed-rule edge clears fees nowhere ≤1d** (edge diagnostic 2026-07-10, 52
  selection-corrected buckets; `reports/loop/edge-diagnostic-2026-07-10.md`).

## Archived records (moved verbatim to archive/state-2026-07.md, 2026-07-20)

Full text preserved in git history (`reports/loop/archive/state-2026-07.md` was itself pruned
from the tree 2026-07-21 — git history is now the only copy). Each block below is UNCHANGED in
the archived file — moved because it is resolved or superseded, not because it was pruned:

- Push II program (owner session 2026-07-13) — 7/8 phases shipped; superseded by the v2 contract.
- Push 3 completion records (2026-07-14) — P7c/P7d/P7e/P7f/P8a/P8d; superseded by v2 + the
  phantom-position resolution (§ Flagged) and X2.
- v2 contract cutover (2026-07-18) — WATCH-V2-* rolled into the 2026-07-20 XA/X2/X9 watch sets.
- Round-8 pre-cutover cleanup + W4 adversarial audit (2026-07-18/19) — incl. the W6 soak verdict
  and WATCH-R8-* (fixes shipped + deployed; superseded by the 2026-07-20 records).
- Daily-loop Y-series creation record (2026-07-19) — Y1-Y4 shipped; no open item carried.
- Last pass narrative (Passes 23-34) — per-pass detail also in `reports/loop/LOG.md`.
- Backlog closed ledger (retired IDs #1-#57) and the Resolved provenance index — detail in
  `reports/loop/LOG.md` by date.

**Owner-directed md prune (2026-07-21, post-Pass-36): the following files are GIT-HISTORY-ONLY
now** — 19 markdown files removed from the working tree (evidence/study reports whose binding
verdicts are condensed above, plus `docs/archive/*` and the superseded W4 audit):
`docs/archive/{agentic-improvement-backlog,design-plan,nightly-improvement,
profitability-analysis-2026-07-04}.md`, `reports/audit-2026-07-cleanup.md`, and
`reports/loop/{a0-analysis-2026-07-20,autonomy-profitability-research-2026-07-12,
bounds-calibration-2026-07-13,candidates/2026-07-10/candidate-a,candidates/2026-07-10/
candidate-b,carry-study-2026-07-10,edge-diagnostic-2026-07-10,entry-fill-quality-2026-07-13,
entry-fill-quality-2026-07-18,loop-mechanism-learnings-2026-07,multi-strategy-search-2026-07-12,
nonprice-sweep-2026-07-12,stop-slippage-2026-07-13,universe-study-2026-07-13}.md`. Consequences
a future pass must know: (1) § Standing verdicts stays the binding record — the cited report
paths resolve via `git show`, not the tree; a missing-file read there is NOT a negative-read
incident. (2) "Y1 §C/§D" citations (playbook, sweep-tool headers, specs) refer to
`loop-mechanism-learnings-2026-07.md` in git history; the operational content lives in playbook
§2-§3. (3) The carry re-test (~07-24) REGENERATES its report from `test/backtest/carry/`
(the spec writes `carry-study-2026-07-10.md` fresh when data is present). (4) Code comments
citing pruned reports are provenance pointers into git history — do not "fix" them file-by-file.
**Second wave (same session; owner: "what is not 100% necessary gets removed"):** also pruned
`reports/loop/a0-evidence-2026-07-20/` (15 CSV/txt evidence files),
`reports/loop/archive/state-2026-07.md` (git history is now the ONLY copy of the archived
records), `reports/loop/digests/w6-digests.txt`, `reports/loop/kimi-k3-research-2026-07-21.md`
(the Kimi follow-up re-derives from git history + LOG.md when the owner key lands),
`docs/specs/2026-07-06-profitability-design.md`, and `plans/2026-07-v3-consolidation-spec.md` —
playbook "spec §N" citations resolve via `git show` (noted in playbook §0). The untracked
runtime files under `reports/loop/digests/` (jsonl history, watermark, collector.log) are not
repo content and stay — the collector regenerates them, and the loop's §1 rehydration reads
them. Surviving md set (9): CLAUDE.md (v2 lane-file drift corrected same commit:
`.env.app-perp`/`--profile perp` references removed to match the v3 tree), README, the
playbook, the runbook, LOG.md, this file, and the three `src/` boundary READMEs (current,
v3-aligned).

- **CORRECTION — v8 is the champion, v9 is a CANDIDATE (2026-07-28, Pass 42).** Two artefacts of this
  pass called v9 "the live champion": commit `b9b52a6` and the playbook-space arm label
  `champion_v9`. Both are wrong. `agentic_playbook_info` reports the app running **version 8**;
  **v9 is an unresolved `source='reflection'` candidate** sitting above it, taking
  `AGENTIC_PLAYBOOK_AB_PCT=40`% of decides through the A/B. The study arms are renamed to the roles
  the live system actually assigns (`champion_v8`, `candidate_v9`) before any result existed. The
  truncation defect `b9b52a6` fixed is real and unchanged — v9's entry-rules section ends mid-sentence
  at *"If ONE input disagrees (lagging"* and that text still reaches 40% of live decides — it is the
  candidate's text, not the champion's.
- **THE CANDIDATE-LAPSE DEADLOCK IS LIVE, NOT HYPOTHETICAL (2026-07-28, Pass 42).** The Phase-B
  blocker list predicted it; it is currently in force. `scripts/playbook-candidate.mjs:168-180` refuses
  to mint past ANY unresolved candidate above the active version, and its `blocking` filter carries
  **no age predicate**. v9 has been unresolved for ~16 h. Its three escape routes:
  - **promotion** — needs attributed A/B evidence the promotion evaluator will accept;
  - **age lapse** — `AGENTIC_CANDIDATE_LAPSE_HOURS=336` (14 days), so not before ~2026-08-10;
  - **abstention lapse** — needs ≥15 attributed real decides with zero entries.

  Both lapse routes live in `reflection.service.ts`, so both require the LLM lane to be calling. With
  both provider accounts unfunded the lane makes zero real decides, so **no evidence accrues on any
  route and `pnpm playbook:candidate` stays blocked until either funding returns or the 14-day age
  lapse fires.** The mint path being dead was previously masked by a second defect — the script's
  validator path pointed at a directory that never existed (fixed `0911c37`), so it exited 1 before
  ever reaching this check. Fixing that path is what made the deadlock observable.
