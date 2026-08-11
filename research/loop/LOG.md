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

_Pass 62's entry rotated VERBATIM to `archive/LOG-through-pass-47.md` at Pass 67, and **Pass 63's at Pass 68** (five-entry retention). Nothing deleted._

## 2026-08-05 — Pass 64 (a fifth of every portfolio consult was paid for and thrown away, and the fix nearly blinded the loop's own liveness probe)

**Pass type: REPAIR.** CANDIDATE was mechanically ELIGIBLE — the newest `playbook-authoring-attempt` row
is `authoring-attempt-2026-08-04` (id 17), so the 08-05 UTC slot was unspent — and was **deliberately not
taken**: §4 ranks trading-path correctness above candidate work, the daily mint has produced zero
candidates in four consecutive days, and a live defect was discarding 21.4% of consults. The slot is
still unspent and available to a later pass today.

**Window:** 2026-08-05T00:07Z → 01:30Z. Lease 00:07:34Z (nonce `7d4749e9d652d12e`), single lease, no
collision, released at pass end. `loop:sweep` 00:07:43Z: **1 alarm** — the frozen
`venue_reject_rate_high [binance]` 16/20, recorded, ages out 2026-08-06T23:15Z, not investigated per §3's
generalised exemption — 14 annotations, 25 Prometheus rules loaded / 0 firing. Pre-pass build `37587f6`,
boot `e423875b`, `RestartCount` 0, working-tree tip `51069ed`.

**The four mandatory signals, read directly rather than off the sweep:** `kill_switch_state{RUNNING}`;
`reconciliation_last_success_timestamp_seconds` ~1.5 min old; `agentic_budget_remaining_usd` $2.8485606 of
the $3/day breaker; real decides flowing (lifetime 1318 → 1319, newest 00:15:21Z);
`agent_client_latch_cause` all three children 0.

**The book, ONE `evaluate()` sample, 2026-08-05T00:07:43Z:** `windowDays=12.010497858796297`,
`roundTrips=54`, `netPnlUsd=-69.9567868244`, `llmCostUsd=31.1806829`, `winRate=0.24074074074074073`,
`ready=false`, reasons `[NON_POSITIVE_NET_PNL, INSUFFICIENT_WINDOW, BELOW_PASSIVE_BENCHMARK]`. Against
Pass 63 (11.857d / 50 trips / −66.4741 / 30.0386, 16h earlier): **+4 round trips, net −$3.48 worse, LLM
+$1.14 ⇒ gross −$2.34 over those 4 trips.** **The window still binds: 12.01 of 14 days, ~2.0 days to
run.** `agentic_promotion_passive_benchmark_pnl_usd` reads **−1.2295550254578758** (Pass 63 read −1.6955),
state `COMPUTED` — it moves, so it is a live computation, and the strategy remains ~$68.7 worse than doing
nothing. **WATCH-V3-1 HOLDS:** measured the way the watch mandates, from a Prometheus range query starting
past the 45-min grace — 70 samples over 5.75h, 779.4 → 786.3 MiB, peak 789.1 MiB, **least-squares slope
+0.73 MiB/h** (endpoint +1.20), sitting on the +0.75 MiB/h control and far under the ~900 MiB signal.

### The incident gate cleared, and one resolved critical was verified rather than assumed

`prometheus_alert_resolved_critical` named `ReconcilerStalled`. Rather than trust the Pass-63 carve-out,
the firing window was read from Prometheus' own `ALERTS` series: **4 samples, 18:06:05Z → 18:06:50Z**,
against container `StartedAt` 18:06:01.719Z — i.e. **+3.3s to +48s after start.** That is the recorded
redeploy carve-out. **Pass 63's own figures are corrected: it recorded "two samples, 8 s after the
container started"; it was four samples, first at +3.3 s.**

**All 28 `anthropic_api_fatal_error_status_latching` events in 7 days fall between 2026-07-29T18:15Z and
07-30T12:15Z** — the known unfunded-account episode — with **zero since funding**. Positive control: the
series carries data throughout the window. Not an incident, and no pass needs to re-derive it again.

### THE HEADLINE — 48 whole batches discarded in 7 days, and the two causes were not the same defect

`app_log_events_total` is a Prometheus counter with 90d retention, so the history survives even though the
log tail reaches back only 6h. Over 7 days: **48 `submit_portfolio_payload_failed` events against 224
consults = 21.4% of portfolio consults discarded whole**, present in **20 of 28 six-hour buckets**, every
single day since 07-30, plus a sibling `..._element_for_symbol` at 25. `increase()` under-counts a label
child first seen inside the window, so 48 is a **floor**.

**A metrics-only triangulation refuted the obvious hypothesis before any code was read.** Bucketing
`agent_decide_total{outcome="truncated"}` against the payload-failure counter at 6h resolution shows
**eight of the twenty-one non-empty buckets carry payload failures with ZERO truncations** — so the two
are different failure modes, and `AGENTIC_OUTPUT_EFFORT` cannot fix the second. Per-row evidence then
confirmed it exactly:

- `4db9283d` 22:00:24Z — `output_tokens` **272**, `stop_reason != max_tokens`, tag `schema_rejected`, 1
  symbol (KAITO). The model emitted `decisions` as a JSON **string** whose quoting degraded mid-value. The
  tool schema is `strict:true` and its description has forbidden a string-encoded array since `651aa2a`
  (2026-07-25), ten days earlier — **there is no prompt fix left; the remedy had to be on ingest.**
- `39e43751` 00:01:22Z — `output_tokens` **4096** exactly, tag `truncated_max_tokens`, 2 symbols.

**3 symbol-decides lost, $0.099215 of inference paid for and discarded.** Extrapolating that per-event
mean across 48 events ≈ **$2.4/7d ≈ $0.34/day, ~11% of the breaker** — n=2 is a thin basis and the figure
is quoted as such. `agent_decide_total` counts **per symbol** (22 rows = 22 decides this boot, exact
match), so it does not under-count; the under-counts are `agentic_schema_rejections_total{kind="batch"}`
(per-batch: 2 for 3 lost decides) and case (1) being misfiled into `hold`.

**No retry exists.** `attemptWithRetry` only retries thrown `AgentProposeError`s, and a 200 carrying a
schema-invalid payload never throws. The lane holds every symbol and returns. Fails CLOSED — correct
direction, zero recovery.

### L1 IS FALSIFIED ON ITS PRIMARY SIGNATURE — the knob is live and truncation fired anyway

`AGENTIC_OUTPUT_EFFORT=medium` was traced **end to end across seven hops** and is not a dead hop: `.env.app`
→ zod → AppConfig → port → module env record → client config → the outbound `output_config: {effort}`.
Verified in the **compiled `dist` actually running**, in the container env, and in the boot's
`config_snapshots` row (hash `89848501`, `output_effort = medium`). It went live in the client at
**2026-08-04T08:00:23Z** — `prompt_hash` moved `46359ad3` → `aefafb3c` with `playbook_version` constant at
10, no code commits in the window, and `b2f7f53` touched only `.env.app` + `STATUS.md`, where
`AGENTIC_OUTPUT_EFFORT` is the sole key entering `feedTags`. **Truncation still fired 16h later at exactly
4096 output tokens.** WATCH-V4-12's declared expected-positive (`truncated_max_tokens` → 0) is therefore
**not met with the lever live** — a finding, in whichever direction it points. Open and UNVERIFIED: whether
`effort: medium` is honoured for this model, or whether the unconditional `thinking: {type:'adaptive'}`
consumes budget ahead of tool JSON regardless. **`stop_reason` is recorded nowhere** and is recoverable
only by inferring it from the rationale tag prefix — the cheapest way to make that answerable.

### Shipped — `de28b12`, `fbb3800`

**`de28b12`** adds a `claude-opus-4-8` entry to `AGENTIC_TOKEN_PRICES_JSON`. **The dollar error today is
exactly $0.00**, and that is the only reason the edit is safe: narrowing a cost is generically the UNSAFE
direction for a permission gate. Opus 4.8 and Opus 5 are both $5/$25 per MTok (verified against the current
pricing reference, not from memory), and opus-5 already dominated the map on all four components, so
max-of-configured already landed on the true rate. Confirmed by reconstructing the gauge from first
principles: **$26.1690759 + $0.5438130 + $4.4677940 = $31.1806829**, matching the live gauge to the last
digit. What it fixes is **latent**: the fallback is `max()` over an operator-editable map, so adding any
pricier model later would silently re-price those 58 frozen rows and inject ~$4.47 of phantom cost with no
new warn (the warn is latched once per process, so its count of 1 carries no information).
**Two record corrections:** `llm_usage` is **NOT vestigial** — `promotion-stats.repository.ts:149-172`
folds BOTH `agent_decisions` and `llm_usage` (`kind='reflection'`) into `llmCostUsd`, making it one of two
authoritative inputs; and `.env.app:82`'s claim that the gate re-prices "all 69 of them" through the map
was false (11 of 69) and this entry makes it true.

**`fbb3800`** ships the three discard fixes: salvage a string-encoded `decisions` (fails CLOSED — any
doubt falls through to the unchanged discard, and neither schema is widened); preserve the model's
`nextConsultBars` on a whole-batch discard; and split `empty_tool_input:` out of `schema_rejected:`.

### THE REVIEW CAUGHT THE FIX INTRODUCING THE EXACT DEFECT THIS PROGRAM EXISTS TO ABOLISH

The new tag went into `DEGRADED_DECIDE_RATIONALE_TAGS` and into **neither of its two declared
hand-mirrors** — `scripts/loop-sweep.mjs`'s `realDecides` probe and `docs/runbook.md`'s liveness SQL, both
carrying a comment stating they must be edited with it. Every `empty_tool_input:` row would have satisfied
the probe's predicate, so **a dead lane would have read ALIVE in the loop's own liveness probe** — while
the TS-side readers stayed correct off the shared constant, so nothing else in the suite would have
disagreed. Both mirrors fixed. **The sweep this pass rehydrated from is unaffected: zero such rows existed,
because the tag did not exist.**

**Nothing enforced those mirrors, which is why it was possible.** `degrade-tag-mirrors.spec.ts` (new) now
asserts every tag in the constant appears in both mirrors and that neither carries a stale extra — a
comment-enforced invariant converted to a machine-checked one. **Verified by mutation: removing the mirror
line fails 2 tests and exits 1; before the fix the same drift left the entire gate green.**

The review's other three MUST-FIX were **missing tests**, each proven by mutation against the full gate and
each **re-verified independently by the orchestrator** rather than taken on the lane's report: deleting the
`empty_tool_input` producer branch (now fails 1), removing the clamp (2), stripping
`nextConsultBarsOnlySchema`'s bounds (3). **All three previously left 3835/3835 green.** A drifted `.min()`
would have admitted `nextConsultBars: -1`, making `barsSinceConsult >= -1` true every bar — consulting on
every single bar against the $3/day breaker.

**A behaviour change the review forced, not just a comment fix.** Adopting the model's `nextConsultBars`
unclamped would have stretched the post-degrade blind window from 2h to **8h**, past the 4h cadence
`.env.app:108` already records as starving evidence pace — off a field read out of a payload the schema had
just rejected. It is now **clamped to `AGENTIC_FALLBACK_CONSULT_BARS`**: a recovered schedule may only ever
make the lane consult SOONER, never widen the blind window. The declared failure direction was rewritten to
say so.

### Not shipped, each with its reason — this pass answers Pass 63's standing recommendation

Pass 63 asked the next pass to pick one of two remedies for the serial-tail bottleneck. **This pass adopts
option 2: latent defects are recorded, not shipped, while live ones are fixed in-pass.** Three items:

1. **The `llmCostSinceMs` gauge — DROPPED, and a lane claim refuted.** A lane reported the code comment
   "both bounds of this read are now PUBLISHED" as false. Reading it, the comment explicitly scopes that to
   the **`evidence` object** ("is in `evidence` below"), where both bounds genuinely are. Only the metrics
   surface carries just the upper bound, and `llmCostSinceMs` is always `epochMs` — a static deploy
   constant reconstructible from config. Confirmed by two independent scrapes. **Adequate as-is.**
2. **The derivatives-feed spot-ticker error counter — recorded, not shipped.** `derivatives_feed_poll_errors_total`
   structurally cannot count spot-ticker sub-poll failures (reads 0 despite 2 real ones this boot), because
   `fetchSpotTicker` catches its own rejections and never touches `errorCount`. **Currently INERT:**
   `AGENTIC_DERIVATIVES_V2_ENABLED` is absent from the container and defaults false, so `spotPerpBasisBps`
   is not rendered into the prompt at all. **Trigger to ship it: any enable of derivatives v2.** Also
   established as correct-by-design: `api.binance.com` is deliberate (read-only context from production
   because demo books are synthetic; orders stay sandboxed), both failures were single-cycle and self-healed
   on the next 60s poll, and the HYPE/USDT exclusion is correct-and-informative.
3. **The frozen binance reject alarm** — untouched, per its recorded exemption.

### Gates, deploy, soak

`format:check` / `lint` / `lint:md` / `typecheck` clean; **`test` 198 files / 3863 passed** (baseline 197 /
3835 ⇒ +1 file, +28 tests); `build` clean; **`eval:agentic` 95 passed | 20 skipped, run BEFORE the
commits.** Deployed `fbb3800` at 01:11:05Z with the `GIT_SHA=` prefix — **`build_info{git_sha="fbb3800"}`
confirmed live**, new boot `90dbb484`, `RestartCount` 0.

**The redeploy carve-outs re-confirmed a fifth time, and now timed precisely:** `mode_info` read
`effective="paper"` at +39s and had resolved to `testnet` by +69s; `reconciliation_last_success_timestamp_seconds`
and `agentic_budget_remaining_usd` were both 0 at +69s and initialised by +99s ($2.8348842). A scrape inside
that window is a mid-boot artifact, **not** a downgrade and **not** a stall.
`agentic_schema_rejections_total{kind="batch_stringified_recovered"}` materialises at 0 on boot, confirming
the new counter child zero-seeds congruently.

### Flagged / next-pass candidates

- **WATCH-V4-12 needs restating, not re-deriving.** L1 is live and its primary signature is unmet. The next
  question is whether `effort` is honoured for this model at all; recording `stop_reason` on the journal row
  is the cheapest instrument for it.
- **The new WATCH (below) reads at the first `empty_tool_input:` or `batch_stringified_recovered`.** Both
  counters are zero-seeded, so a zero is a real absence rather than a missing series.
- **CANDIDATE's 08-05 slot is unspent** and the mint has produced zero candidates in four days.
- **Pass 63's serial-tail recommendation is now answered** (option 2 adopted, above); this pass still ran
  4 read lanes + 1 write lane + 1 review + 1 remediation lane, and the tail was again the binding cost.

## 2026-08-06 — Pass 65 (one host suspend exposed three latent defects, every instrument that should have caught them was blind, and the fixes for them introduced three more)

**Window:** 2026-08-05T00:05Z (Pass 64's sweep) → 2026-08-06T17:45Z. Sweep gap 40.0h — Pass 64 held its
lease 2398 min and never released it; `loop:lock` broke it as stale on acquire, and Pass 64's own
report sat complete-but-uncommitted in the tree (landed unmodified as `af22c6d`). Boot at sweep
`9add5939-fcbf-4fa3-8098-2e15b9ac630c` (StartedAt 2026-08-05T16:29:07Z, build `fbb3800`);
mid-pass restart boot `2262ab93` at 16:26:00Z; deploy boot at 17:39:41Z on `5deaac5`.
Lease re-armed mid-pass at 17:27:22Z (old nonce matched on release) — the sanctioned Pass-63 pattern.

**Book, ONE `evaluate()` sample (2026-08-06T16:33:53Z):** `windowDays=13.6763003472,
roundTrips=61, netPnlUsd=−72.7377983944, llmCostUsd=33.1938887, winRate=0.2622950820, ready=false`,
reasons `[NON_POSITIVE_NET_PNL, INSUFFICIENT_WINDOW, BELOW_PASSIVE_BENCHMARK]`. The window is 0.32 d
(~7.8 h) short of the 14-day floor, so INSUFFICIENT_WINDOW clears tonight and **the gate still does
not open** — `NON_POSITIVE_NET_PNL` is untouched by it. Passive benchmark `state="COMPUTED"`, bar
**−4.6574**, moved a third time (P63 −1.6955, P64 −1.2296, P65 −4.6574), which independently
re-confirms Pass 64's settlement that it is a live computation, not the `+Inf` refusal sentinel.
Strategy is ~**$68.08 worse than doing nothing**. **Nothing in this pass moves profitability.**

**WATCH-V3-1:** RSS 807,403,520 B = 770 MiB at ~9 min into the restart boot — above the ~673 MiB
paper reference, below the ~900 MiB defect signal, consistent with the 801.3 MiB ceiling of the
49.7 h control boot. HOLDS. Per the watch's own rule the post-boot ramp is NOT divided by the gap.

Pass type: **INCIDENT** (§3 gate — 82 alarms), with the CANDIDATE slot also spent in parallel and
reported in full below, including its failure.

### The sweep: 82 alarms, and the one that mattered was not among them

81 × `MarketChannelStale` (critical) + the frozen `venue_reject_rate_high [binance]` (16/20, ages
out 2026-08-06T23:15Z, no action). Every stale alert carried the identical firing stamp
`2026-08-06T12:44:25.935442849Z` — an ARTIFACT of Prometheus resuming after the last host-suspend
gap (which ends 12:43:46), not the instant anything died; `alert_window_partial` flagged only 78%
scrape coverage over the window, the same story. The real death instant is
**2026-08-06T09:51:53Z–09:52:17Z**, recovered from all 91 staleness children falling inside a
25-second spread and confirmed by range query (BTC ticker 0.811 @09:52:00 → 228.798 @09:56:00).

### Defect 1 — pinned ccxt caches a REJECTED markets-load promise, forever

`node_modules/ccxt/js/src/base/Exchange.js:891-903`: `loadMarkets()` memoises `marketsLoading`, and
its rejection handler resets only `reloadingMarkets`; `marketsLoading` is assigned `undefined`
exactly once, in the constructor (`:135`). Every ccxt-pro `watch*` begins `await this.loadMarkets()`
at **reload=false**, so one failed markets load makes every later `watch*` return the same
already-rejected promise: instant rejection, **zero network I/O**, permanently.

A host suspend at 09:52Z killed the sockets; the watchdog recreated the exchange three times, the
last two at 09:57:51Z _inside_ the outage. Both wedged for **6.25 h**, emitting 19,057 byte-identical
`NetworkError: <venue> GET .../exchangeInfo fetch failed` lines across 91 channels on both venues.

Nothing could recover it. `handleLoopError` recreates only on `isClosedByUser`; this error is
`NetworkError` → transient → DEGRADED + a FIXED 1000 ms backoff. The watchdog's only lever is
`exchange.close()`, and `Exchange.close()` iterates `clients` — a never-connected instance has none,
so `close()` is **a no-op that mints no `ExchangeClosedByUser`** and never re-enters the recreation
branch. **222 watchdog fires produced zero recreations.** The `RecreationPolicy` breaker was intact
but unreachable: it guards a branch this error never enters.

**The falsifier was RUN, not assumed.** The investigating lane named its own cheapest disconfirming
test and did not run it; the orchestrator did — `wget` to both `exchangeInfo` URLs from **inside
`crypto-bot-app-1`** returned REACHABLE while the adapter had been throwing `fetch failed` on those
exact URLs for 6.25 h. Corroborating controls, same process, all alive throughout:
`derivatives_feed_staleness_seconds` 5.134, `context_feed_staleness_seconds{trade_flow}` 7.047,
`liquidation_stream_healthy` 1, reconciliation writing CLEAN rows every ~60 s.
`nodejs_active_handles_total` fell 89 → 7 and never recovered. Not a hot loop despite 19k lines:
CPU ~9% of one core, and it consumed **no rate-limit budget at all** — which is why it could never heal.

**Also corrected:** `ccxt-stream.adapter.ts:159` claimed "the container healthcheck/restart-policy
is the final rung". `docker-compose.yml:40-48` probes only `/health/live`, which returns 200 while
the process breathes — `RestartCount` was 0 after 6.25 h of a totally dead feed. There is no rung.

Restored in production at 16:26Z by a plain `docker compose restart app` — the wedge is pure
in-process state — which is itself live confirmation: 120 channels back, staleness under 11 s,
reconnects 0, lane deciding by 16:30:25Z. Durable fix `7edd4a6`.

### Defect 2 — one missing try/catch cost 7h07m of halted trading

`demo-fill-poller.service.ts` called `fetchMyTrades` **unguarded inside the per-symbol loop**, so one
symbol's throw aborted the whole venue poll — including the `algoSuspects → recoverSymbol()` loop,
the **only periodic trigger** for `AlgoStopRecoveryService` (`trading-runtime.module.ts:769` says so
in code: "sweep is boot-only today"). binanceusdm's `demo-fapi.binance.com/fapi/v1/userTrades`
returned **502 Bad Gateway** on ~29% of calls for ~10.7 h; across 16 sequential symbols
P(abort) ≈ 99.6%, and **4072 of 4072 polls aborted**. `reconcileTrades` HAS that catch and survived
the identical outage.

Two venue-fired STOP_MARKETs went un-ingested for **5h30m** (HYPE, 17:35:02.555Z → 23:05:46.830Z)
and **1h39m** (ETH, 01:33:43.545Z → 03:12:18.278Z), leaving phantom local shorts against a flat venue.
Fix `0e7b375`.

### The halt was NOT a no-op — three orchestrator claims falsified by the lanes

Recorded because this loop's standing failure mode is an orchestrator relaying its own hypothesis as
fact. All three were the orchestrator's, and all three were wrong:

- _"the streak>=2 debounce never reaches 2"_ — FALSE. `position_drift` 429 vs halts 427 = exactly
  **2 first-strike passes**, one per episode. The debounce fired both times it should have.
- _"427 engage/resume flaps"_ — FALSE. `audit_log` holds exactly **4** transitions: RUNNING→HALTING
  17:36:47Z (HYPE) → HALTED→RUNNING 23:05:57Z; RUNNING→HALTING 01:34:49Z (ETH) → HALTED→RUNNING
  03:12:52Z. The other 425 rows are `HALTED→HALTED` — `reduceKillSwitch`'s HALTED case handles only
  RESUME, so a repeat ENGAGE returns unchanged while still logging and writing an audit row. That is
  what manufactured the "no-op" appearance.
- _"binanceusdm CLEAN rows continued through the halt span"_ — FALSE. Zero binanceusdm CLEAN rows
  17:00–22:59Z. The continuous CLEAN stream was **binance spot**, a different venue.

**Money impact: none.** Zero `SUBMIT_SENT` on binanceusdm inside either HALTED window (positive
control: 14 submits in the RUNNING gap between them); `order_events` in both windows holds only the
halt's own cancel-all (12 events each, complete within ~12 s of engage) plus the one backfilled
algo-stop FILL; `flatten=false` in every audit row. **Hard rule 6 was honoured.** The cost was 7h07m
of unavailable trading and a book that mis-reported its own position for 7h09m _while halted_.
Direction was checked and was the safe one — local phantom short vs venue flat, so the book
OVER-stated risk; auto-flattening `local=-0.043, venue=0` would have OPENED a real 0.043 long.

Live exposure at investigation: BTC short 0.0009 and SOL short 1.08, ~$137 gross, **both protected**
by server-side algo-rail stops, max loss if both fill ≈ **$2.75** on ~$4,963 equity. A plain
`fetchOpenOrders` returns 0 stops and reads as naked shorts — that read is VOID; stops live on
`fapiPrivateGetOpenAlgoOrders`. Post-restart re-adoption clean: `orphan_scan=16`,
**`orphan_readopt=2`**, `orphan_cancel_failed=0` (WATCH-V4-11 expected-positive again).

### Defect 3 — the lane was not refusing and not parked; it was never invoked

`StrategyHost.drainMailboxes()` has exactly one caller, inside the market-event `for await`. No
candles ⇒ no drain ⇒ `decide()` never called; the consult gate was never REACHED. Proven by two
`/metrics` scrapes 151 s apart: every `agentic_consult_gate_total` child frozen (skipped_scheduled
1593, consulted 18) and `agent_decide_total{hold}` frozen at 41, while staleness advanced +150.0.
`agent_decisions` holds **1640 rows == 1640 gate outcomes**, exactly 1:1 over 40 symbols × 41 bars,
stopping dead at 09:45:31.404869Z. Of 60k log lines the `StrategyHost` context emitted **2**, both
from the unrelated kill-switch suppression — the feed-starvation path emits nothing at all.

Throughout, the board was green: all 40 `strategy_lifecycle{state="ACTIVE"}` = 1 and
`kill_switch_state{RUNNING}` = 1. Positions were never at risk from this: `risk-engine.service.ts`
stamps `ageMs` on the mark and bounds it, so no intent could be built on a 6.4 h-old price.
Instrument `e94c11e`.

### The instrument failures — why none of this was ever seen

**The sweep could not see a halt storm.** `loop-sweep-core.mjs:375` alarmed only on
`latestResult === 'HALT'`, and the probe fetched only a lifetime `count(*)` plus that one row, so a
halt followed by any CLEAN row was invisible. Lifetime census, run this pass: **2155 HALT rows
across 8 boots**, of which **2138 (99.2%) are POSITION_DRIFT** — TRUMP 1711, HYPE 329, ETH 98 —
against 16 `UNKNOWN_OURS_OPEN` and 1 `FILL_FOR_UNKNOWN_ORDER`. **Zero `reconcile_halt` alarms were
ever raised for any of them.**

That falsifies STATUS.md's standing line _"POSITION_DRIFT HAS NEVER HALTED THIS SYSTEM — all 18
RECONCILE_MISMATCH halts are UNKNOWN_OURS_OPEN"_. The reason is not that position-drift bypasses
`audit_log`: the kill-switch audit port shipped in `759e54b` at 2026-07-27T08:56:55Z, **66 seconds
after the last TRUMP halt row**, so the 1725 halts of 07-26/27 predate the instrument entirely. The
claim was true when written and went stale silently; this boot recorded 427/427. Fix `069d40f`.

**Detection was never the gap.** `alerts.rules.yml` `KillSwitchEngaged` (`for: 0m`, critical) would
have fired continuously for all 7h07m. The sweep is the designated reader, and it was blind.

**No tick-liveness series existed.** All four lane health surfaces are outcome- or state-scoped, so
nothing distinguished "evaluated and stayed quiet" from "never asked". `AgenticLaneSilent` needs a
6 h window for exactly that reason and duly fired 6 h late — the rule is correct, the SERIES is
wrong. New `agentic_last_gate_timestamp_seconds` + `AgenticLaneNotTicking` at 2700 s (3 bar periods)
detects a dead tick in BAR time: **45 min instead of 6 h**, and it would also have caught the 5h45m
gap of 2026-08-05T17:15Z that produced no `AgenticLaneSilent` at all.

### Authoring (CANDIDATE) — the slot was spent and the run ABORTED. A failure, not a refusal

`--dry-run` first (free insurance, P62) passed end to end. The real run claimed the day's single slot
(`public.experiments` **id=21**, `classifySameDayGate` SLOT_OPEN, next 2026-08-07T00:00Z), drafted 2
variants at claude-sonnet-5, ran 630 s of replay — then hit its **$5 spend cap and aborted**:
`aborted=true`, `meter={"calls":348,"usd":"5.0015"}`, `rowsCovered=108/150`, `schemaRate=0.731`.
Every arm cell came back null; `renderTwoBars` called `.toFixed` on one and threw out of `main()`.
**Stage 6 never ran, so NOT ONE scorecard reached `public.experiments`.** Honest-N: 0 registry rows,
2 variants drafted, 0 scored cells, $5.0015 spent, slot consumed.

This is **not** `MINT GATE: REFUSED`. A refusal on a measured bar is the pass working; this destroyed
its own evidence. `aborted: true` is a state the code deliberately sets and its own renderer could
not print, so **every** budget-aborted run has been losing everything it paid for. `--dry-run` cannot
catch it — synthetic variants score non-null, so the abort path is never exercised. Fix `5deaac5`.

The gate was re-asked mechanically rather than reasoned about (playbook: "ask the gate"), and
answered `ONCE-PER-UTC-DAY: SLOT_SPENT … no override flag by design`, exiting before any paid call.

**Structural, and recorded rather than fixed:** the run was guaranteed to abort.
`costPerDecideUsd = 0.01437212643678161` ($5.0015 ÷ 348), and declared work is 150 rows × 3 arms =
450 decides = **$6.47 against a $5.00 cap**. $5 buys ~348 calls ≈ 116 rows, so requesting 150 aborts
at ~77% coverage on EVERY run, independent of the 27% schema-discard waste. Fixing it means raising
the cap (more money) or lowering `rowsRequested` (a narrower scored corpus); neither should be picked
as a side effect of an incident pass, and neither can be exercised until 2026-08-07T00:00Z.

### Two adversarial reviews, and both found MUST-FIX in work that had already passed every gate

This is the pass's most important process fact: **199 files and 3898 tests were green at the moment
the new alert rule would have paged critical on every boot.** Green gates were not evidence.

Review 1 (the four non-ccxt lanes + orchestrator edits): the new `AgenticLaneNotTicking` would have
false-fired CRITICAL 5 min after every boot, because prom-client initialises a LABEL-LESS gauge to 0
at registration and `time() - 0` ≈ 1.786e9. Since `loop:sweep` promotes firing criticals to alarms
and §3 turns any alarm into a mandatory investigation, **it would have wedged the next pass's agenda
on every redeploy** — an instrument manufacturing its own incident, the exact class this pass spent
the day removing. **That defect was the orchestrator's own**, introduced by its dispatch instruction
"do NOT boot-seed it, the `for:` covers the gap" — which is false, since the gate fires 40-at-once
once per 15m bar and `for: 5m` cannot cover a 15-minute gap. Fixed by seeding the gauge at boot;
**verified live on this deploy** (gauge = 17:39:41.920Z, age 35 s, alert would not fire).
It also caught a branch-coverage regression: the new catch's `String(err)` arm was uncovered at
97.05% against the declared 100% for execution paths, so `pnpm test:cov` FAILED while `pnpm test`
passed (backlog #56 exists for exactly this gap). `test:cov` now exits 0.

Review 2 (the ccxt fix, whose lane early-stopped and filed NO report): all three MUST-FIX sat in the
watchdog escalation — the component that never got its own self-review. `void recreateExchange(...)`
had no `.catch()`, so a post-swap logger throw (EPIPE on a closing stdout) would reach
`main.ts`'s `unhandledRejection` handler and **exit the trading process** — a recovery-only device
becoming what kills the lane. Escalation and `close()` were mutually exclusive, so a policy-declined
tick did **nothing**, strictly worse than HEAD, up to 600 s of inaction or a rolling hour past the
cap. And the counter latched on "any channel stalled" rather than the same channels, so one
permanently-silent key would pin the watchdog in escalation mode forever. Two of the three were
directly contradicted by the comments above them. It also killed a **vacuous test** — deleting the
single-flight guard left the suite green, because the fixture froze the clock so the cooldown alone
held the count.

### Diff, gates, soak

Commits: `af22c6d` (Pass 64's orphaned report, byte-for-byte), `7edd4a6` (ccxt wedge), `0e7b375`
(fill-poller isolation + watermark guard), `e94c11e` (tick-liveness gauge + alert), `069d40f` (sweep
boot-scoped halt count), `5deaac5` (aborted-authoring reporting), plus this report.

Gates at close: format/lint/lint:md/typecheck/build clean; **`test` 199 files / 3922 passed**
(baseline 198/3835 at Pass 63, 199/3898 mid-pass); **`eval:agentic` 95 passed | 20 skipped**;
**`test:cov` exit 0** (93.13/86.94/92.06/94.47 against the 90/85/90/90 bar) — run because a review
finding turned on it. Every behaviour change is mutation-proven; the orchestrator ran its own
mutation on `hasNoMarkets` (3 tests fail, reverted, diff byte-identical) rather than trust a lane
that filed no report.

Deploy `5deaac5` at 17:39:41Z, `build_info{git_sha="5deaac5"}` confirmed. Prometheus
`--force-recreate`d (alerts.rules.yml is a single-file bind mount read once at start; a plain
`up -d` is a no-op). Mid-boot carve-outs observed exactly as STATUS records them: `effective="paper"`,
zero clean-stamp, zero budget gauge — all resolve by ~+99 s.

Fan-out: **read-only roster COMPLETE — all 4 declared lanes returned** (halt-noop, stream-death,
position-drift, lane-silence). **Write roster COMPLETE — all 5 declared lanes returned** (feed-wedge,
fill-poller, lane-liveness, sweep-halt, authoring-render).

### Soak verdict — PASS, and it exercised two of the pass's own fixes in production

Post-deploy `loop:sweep` on boot `815e01b8`, running build `5deaac5`: **1 alarm, down from 82** — and
the one remaining is the frozen, documented `venue_reject_rate_high [binance]` that ages out at
2026-08-06T23:15Z. Health at +17 min: `mode_info{effective="testnet"}` (carve-out resolved), kill
switch RUNNING, clean stamp fresh at 17:56:12Z, budget gauge initialised at 2.090178, **91 staleness
children live**, and **zero firing Prometheus alerts**.

Two fixes verified in production rather than only in test:

- **`agentic_last_gate_timestamp_seconds` read the BOOT INSTANT at +35 s** (17:39:41.920Z, age 35 s,
  `AgenticLaneNotTicking` not firing) and then **advanced to 17:45:52Z** — a real consult-gate
  evaluation at the 17:45 bar. So the seed works AND the series tracks real ticks. Unseeded it would
  have read 0, and `time() - 0` ≈ 1.786e9 would have paged CRITICAL five minutes into this very
  deploy. That is the review's MUST-FIX 1 confirmed in exactly the situation that would have fired it.
- **Neither `reconcile_halt_in_boot_unreadable` nor `reconcile_halt_in_boot_boot_id_void` appeared** on
  a post-redeploy sweep — the precise regression the review flagged (two blocking alarms on every
  routine redeploy, wedging §3 on a step the playbook prescribes), verified absent against the live
  two-`boot_info`-series window. `reconcile_halt_in_boot` correctly stayed silent on a boot with no
  halt rows.

### Not defects — checked and closed rather than left open

- **`venue_free_cash_usdt{binanceusdm}=281.57` vs a venue-reported 4941.61 free.** Correct by design:
  `.env.app:44` `VENUE_CAPITAL_SPLIT={"binance":"500","binanceusdm":"500"}` against
  `SIZER_EQUITY_CAP=1000`. The gauge reads the ALLOCATED book, and the sizer reads the same source
  (`position-sizer.service.ts:556-564`), so it is consistent, not understated. Closed.
- **The orphan SUI `reduceOnly` stop:** `orphan_cancel=1` on the restart boot, consistent with an
  automatic cleanup. Stated as consistent-with, not proven.
- **The playbook's own freeze banner** claimed the v3 cutover was unrecorded and ordered every pass to
  MAINTENANCE-only, while its closing parenthetical said the record IS present. The cutover record is
  `archive/state-2026-07-30.md:59`, dated 2026-07-21; passes 51-64 ran CANDIDATE throughout, so the
  text was contradicted by the loop's own behaviour for six weeks. Repaired, with the alarm-kind count
  (22 → 24).

### Still open

- **4 phantom `ACKED` local stop rows** (UNI/USDT:USDT ×2, KAITO/USDT:USDT ×2, from 2026-07-31) with
  no venue algo-rail counterpart. No exposure, but nothing reconciles them: the open-orders axis is
  regular-rail-only and the position axis does not read orders. Clearing them means cancelling or
  terminalizing orders — not done this pass.
- **Per-symbol fill watermarks.** The new guard holds the whole venue's window when any symbol fails;
  two silent-truncation mechanisms sit at the end of that growth (Binance's 500-row `myTrades` page
  default, and perp's 7-day client-side `endTime` derivation that returns EMPTY without throwing, the
  #54 defect). Neither is reachable today. The structurally correct fix is per-symbol watermarks,
  keyed `${venue}|${symbol}` as `reconcileTrades` already does.
- **The authoring budget/rows mismatch** above.
- **#149's CLOCK half** (unchanged): `maxHoldBars: 96`/`barsElapsed: 0` hardcoded because no reachable
  port carries the position's open time.

### Recommendation — repair has now consumed three consecutive passes

The playbook says that when defect work crowds out the improvement on consecutive passes, the report
recommends what to change about the system rather than forcing one. Passes 63, 64 and 65 were all
repair. The through-line is unchanged and now has fifteen instances: _a surface reporting health it
never established._ This pass added five more — the sweep blind to 2155 halts, the lane reporting
ACTIVE while dead, `audit_log` blind to 99.2% of halts by construction until 07-27, a healthcheck
documented as "the final rung" that cannot fail, and an authoring runner that cannot print its own
abort state.

Two concrete changes, both cheap:

1. **Put `test:cov` on `pnpm checks`** (backlog #56, now proved a third time — this pass shipped a
   real threshold breach that `pnpm test` could not see, and only a review caught it). One line.
2. **Require every new alert rule to be evaluated against a freshly-booted process before it ships.**
   The boot-transient false-fire was invisible to every gate and to promtool, which validates syntax
   and not semantics; only a reviewer reading prom-client's initialisation caught it. A 60-second
   post-deploy check of `time() - <gauge>` would have caught it mechanically.

Neither is profitability work, and that is the point: the loop cannot get back to profitability while
each pass spends itself proving the previous pass's instruments were lying.

## 2026-08-10 — Pass 66 (the stop moved past the window, the evidence for minting evaporated, and the pass-64 fix turned out to salvage a shape that never occurs)

**Window:** 2026-08-10T08:51Z → 2026-08-10T12:00Z. Lease 08:51:24Z (nonce `9e9f1b3a99e54f68`), released
and re-armed 09:12:27Z (`810ce9cc3741aa7d`) — the sanctioned Pass-63 pattern. **The loop had been dark
~90h**: the `daily-profitability-loop` scheduled task was **disabled**, not crashed (last fired
2026-08-06T16:05:13Z, ~11 passes missed). Re-enabled at the top of this pass. A **host Docker update
stopped the entire stack mid-pass**; recreated 09:38:49Z on the SAME image (`5deaac5`, no rebuild —
lane work was uncommitted), healthy, RestartCount 0. **Every since-boot counter reset at that instant**;
the readings below are anchored to boot `815e01b8` and are not re-readable from the current boot.

### The checkpoint: the program's expected ending changed

Checkpoint #1 was due 08-11T12:00Z and was run **27h08m early, labelled early**. One `evaluate()`
sample at **2026-08-10T08:52:03Z**: `windowDays=17.50014773148148, roundTrips=80,
netPnlUsd=−81.2138271444, llmCostUsd=40.0934201, winRate=0.275`, reasons `[NON_POSITIVE_NET_PNL,
BELOW_PASSIVE_BENCHMARK]`. **`INSUFFICIENT_WINDOW` has cleared and the gate still does not open** —
exactly as § 2 predicted, because the window never touched `NON_POSITIVE_NET_PNL`.

Measured **−$81.21 against the pre-declared line's −$97.14 at this instant: better by $15.92.**
Scoreboard § 2.5 rule 2 makes "better" as reportable as "worse" and forces a re-derivation, so all four
rates were re-derived. **Every restated S3 date now lands AFTER the 2026-08-31 close** — 2026-09-30
(forward −$2.3037/day), 09-08 (wall-clock), 09-04 (conservative `windowDays`), 09-02 (the original
composed rate) — against a declared band of 08-27→09-01. **The window and the −$200 trigger are
untouched; a checkpoint re-derives a date, never a criterion.** What changed is which mechanism ends
the program: **expect the written verdict, not a triggered S3.** That flips § 2.2's own flagged
interaction, and the flip is recorded now rather than discovered at the close.

The book got better and the reasons are not creditable to anything this program did. Forward-window
gross is **−$0.0830/trip** against a **−$0.6483** book average, and the hit rate on those 19 trips is
**31.58%** against 24.49% at A1 — still short of the 41.65% gross break-even. Four caveats travel with
those numbers wherever they are quoted: **n=19 with clusters unread**; the bps form is an estimate on a
stale notional denominator; **ZERO configuration changed in that window** (container on `5deaac5`,
RestartCount 0 — the _loop_ was dark, the _app_ was not), so there is **no lever confound and a full
regime confound**; and the forward-return instrument agrees with the regime reading.

### The evidence that would have justified minting did not survive its own population growing

Fresh `pnpm loop:forward-return` at **08:53Z**, v10 `flat_only`: h=1 −7.6 [−19.5, +6.9] n=55; h=4 −9.3
[−32.1, +15.7] n=55; h=8 −20.8 [−45.1, +3.9] n=54; h=24 −15.5 [−44.6, +29.2] n=54. **Every interval
includes zero.** The 2026-08-04 amendment recorded the same two cells EXCLUDING zero (−45.3 [−122.0,
−0.3] and −52.8 [−134.9, −1.5]) on n=21. On 2.6× the population the point estimates moved to −9.3 and
−20.8 and both intervals opened. **The adverse-POWERED signature was a small-population reading.** The
honest statement is that v10's forward edge is **indistinguishable from zero** — not that it is good;
the point estimate is negative at all four horizons. WATCH-PLAYBOOK-V10-1 tier 2 is superseded and its
intervals must not be re-quoted. The n=21/k=8 vs n=26/k=9 discrepancy the record never reconciled is
**accrual, not filters**. The replay divergence is unchanged and still fires at h=8 and h=24.

This matters because the **event-driven mint gate shipped this pass** keys on exactly that reading.
On today's data it **REFUSES**, and that is the gate working, not a bug.

### Six days late, both levers adjudicated — on a window that had to be re-based first

L1 and L4 went live in **one instant, 2026-08-04T08:00:23Z** (the prompt-hash partition switches to
`aefafb3c…` at `:23.693878Z`, confirming it to the second), so **neither is separately creditable**.
Their registered "first two full UTC days" are 08-05 and 08-06 — **both corrupted by the Pass-65 feed
wedge** (2920 and 2560 `agent_decisions` rows against 3840 on an intact day). The window was **re-based
to the three clean days 08-07→08-09, declared before the numbers were read against it.**

**L4 — all three clauses MET, no rollback.** `forced_move` 28.9/day against a 94/day baseline (−69.3%);
decide spend −$0.6844/day, an **over-delivery** against the declared $0.15–$0.60 band, recorded as one
because § 3.4 printed its upper bound precisely so over-delivery would be as falsifiable as under-;
and Σ one-way notional **ROSE 1.45%** while spend fell 26.5%. Its most-likely named defect — "the lever
bought less trading, not cheaper trading" — **does not fire**, and neither does the fallback-absorption
defect (`forced_fallback` fell to 7.4/day from 29). **The LLM term moved 82.77 → 59.99 bps/round trip.
That is the first lever in this program to move the § 1.3 identity in the right direction for the right
reason: spend fell while turnover did not.**

**L1 — primary FALSIFIED, and its cost clause passes only through a confound.** Rows carrying
`truncated_max_tokens:` at exactly `output_tokens = 4096` number **4 and 3** on the two registered days
against a registered expectation of zero. On the clean window the 4096-pinned rate is 2.17% of priced
decides against 3.35% before — a ~35% relative fall on 17 vs 7 rows, not distinguishable from noise and
not the registered zero. Its spend clause passes only because the lane made **36.4% fewer priced calls**
— which is L4's mechanism — while **cost per decide ROSE 15.6%**. Latency and schema-rejection defects
do not fire (p95 30,556 ms vs 29,009; zero rows ≥75s; `schema_rejected` 7.67/day vs 18).

**L1 is NOT unset today, and not out of optimism.** Whether `effort` reaches the model at all is
unanswerable from these columns — a request-parameter effect and a payload-size effect produce an
identical row, and the payload grew independently when the liquidation and perp trade-flow channels
went live the same day. `stop_reason` ships this pass to separate them. **Registered read: the
`max_tokens` share on the `+eff-medium` partition over 7 days; unchanged-or-higher ⇒ UNSET
`AGENTIC_OUTPUT_EFFORT`; deadline 2026-08-17; the unset is the DEFAULT on a silent instrument.**

**A separate falsification, of the instrument rather than the lever:** WATCH-V4-12's own recorded line
that truncation rows are "all pinned at exactly 4096" **is false in both eras** — 33% of prefix rows
before the enable and 58% after are NOT at the ceiling. Two different events have been aggregated under
that watch since it opened, and every prior count under it inherits that.

### The Pass-64 consult-discard fix salvages a shape that does not occur

WATCH-V4-20, read one day past deadline: **`batch_stringified_recovered` = 0 while `{kind="batch"}`
fired 13 times in 3.64 days**, and **zero `empty_tool_input:` rows exist across six days** against 47
`schema_rejected:`. Both counters zero-seed at boot, so both are real absences. **Two of the four named
defects FIRE.** Per the clause's own instruction the recovery is no longer claimed. Whole-batch
discards continue at ~3.6/day; the rate did fall from the 21.4% baseline **but not by the mechanism
this fix shipped**, and the cause is unidentified. The third defect (`nextConsultBars` clamp) was not
read — **an unrun check is not a passing one**, so it stays open with no deadline claim.

### The NOFILL re-read is blocked on the cell nobody was counting

55 v10 entry decisions, 55 produced an intent, **45 filled, 10 intent-with-no-fill**. The total clears
n≥12 — but **the binding constraint is the UNFILLED cell at n=10**, so the filled-vs-unfilled split,
the only instrument that can show adverse selection, still cannot be scored. Saying "n=55, powered"
here would have been wrong. Re-read ~2026-08-12. `computeForwardReturn` carries no fill-status
partition; the seam is recorded, not built.

### What shipped

- **`stop_reason` journaling** (`fe84c61`) — nullable column, migration `0003` (a clean single
  `ALTER TABLE`, inspected for the churn `0002`'s header documents), threaded from an envelope field
  the schema had been parsing and discarding for its whole life. Batch stamps the first resolved
  proposal only, so `stop_reason IS NOT NULL` means exactly one row per HTTP call. **The migration must
  be applied BEFORE this code deploys** — an insert naming a column the database lacks kills journaling
  while every surface reads healthy, which is this program's signature failure.
- **Authoring budget preflight + event-driven mint gate** (`abcfc61`). Every authoring run had been
  arithmetically guaranteed to abort — ~$6.47 declared against a $5.00 cap — burning the UTC slot and
  producing nothing for ten days. `classifyDeclaredBudget` now refuses **before** `claimTodaysSlot`,
  fails CLOSED, and the default shape becomes 2 arms × 150 rows = $4.3116. **Arms are cut before rows**:
  at 90 rows `judgeHalves` starves its 12-entries-per-half floor and every mint refuses, so cutting rows
  would have swapped a budget abort for a quieter one. `classifyMintTrigger` permits a mint only on the
  incumbent's adverse-POWERED reading. **Eight live playbook versions shared 78 entries — 9.75/version
  against a floor of 12 — which is why only v1 and v2 ever reached powered evidence.** Event-driven
  minting **dissolves** that exclusivity instead of trading one horn for the other.
- **The OOS session arm's machinery** (`924f8b2`) — and the defect that mattered most was not the
  missing trigger. **`sealBatch` routed through `logTrials`, which silently no-ops in production**, so
  the arm could have decided for weeks while every sweep reported "no sealed window exists". Replaced
  with a direct INSERT and a fail-CLOSED read-back. Cadence amended to 3×/day (owner: no new daemons)
  while the arm is still UNSTARTED and the amendment is therefore admissible.
- **Per-symbol fill watermarks** (`e574bd3`) — the per-venue watermark let one persistently failing
  symbol pin `since` for every symbol on its venue, and that hold ends not in an error but in two
  silent truncations (Binance's 500-row page; the perp endpoint's 7-day window returning EMPTY).
- **The fee-truth enable (L6)**, registered `09fa553` **before** it shipped, with a **derived magnitude
  of ZERO** — and the registration refutes a hypothesis this pass's own plan carried.
- Orphaned `ACKED` algo-rail stop rows now terminalize through a reconciliation-sanctioned path, and
  #149's clock half is closed by a durable open-time source.

### The finding that cost the plan a premise

The plan justified the fee-truth enable partly on a suppression hypothesis: the model is told a round
trip costs 20 bps on a book that really costs 7.2, and that 2.8× overstatement plausibly suppresses
what it will trade. **Measured before shipping the fix, it does not survive.** Proposed
`takeProfitPct` on 112 non-replay perp entry decisions: min **0.012**, median **0.035**, max 0.070;
spot n=14: min 0.020, median 0.031. **Not one proposal on either venue ever came within a factor of six
of the 0.002 floor.** The median perp target is **17.5× the overstated cost and 48× the true one**.

A 2.8× overstatement cannot bind a target that already clears the true cost by 48×. **The hypothesis is
refuted on the exit-target axis and untested on the entry axis**, which is the one this read cannot
see. It also explains mechanically why the TP-floor gate has never fired — re-verified at 0 rejections
all-time — instead of leaving that as an unexplained zero. So L6 ships as a **correctness fix and a
confound removal**, never as an improvement, and any post-enable gain attributed to it is refuted in
advance. Its clauses grade **rendered bytes and floor values, never PnL**, and its harm-rollback cohort
(perp trips with TP < 0.002) is expected to be **empty** — recorded as unfired-for-want-of-population,
which is not a pass.

`TRADE_TEMPLATE_VERSION` goes **v4 → v6, skipping v5 deliberately**: `PROMPT_TEMPLATE_VERSION` in the
same file already holds `'v5'`, and reusing that string for a different template composition is exactly
the collision `computePromptHash`'s distinctness spec exists to catch. A lane caught that; the plan had
said v5.

### Process

**Three of this pass's own records were wrong or self-defeating, and every one was caught by something
other than the orchestrator.** The plan's E1 watch read "perp reject rate falls" with a rollback on
"reject rate unchanged at 48h" — against a baseline of **0 rejections all-time**, the expected-positive
was vacuous and the rollback would have fired automatically on `0 == 0`. The plan asserted "ten playbook
versions"; the measured figure is **eight live** (ten is the mint-ledger count, which never deletes a
row). And two committed records introduced **16 MD049 lint errors** on a validator that is part of
`pnpm checks`. **The recurring failure is unchanged: the orchestrator asserting what it has not
checked.**

**A production-gate spec was RED at HEAD when this pass opened** — `pass-record-audit.spec.ts`, because
Pass 65's entry wrote `Window:` unbolded, which is the exact defect Pass 63 corrected in its own entry.
It shipped because **the pass record is written AFTER the gate run, so no pass can catch its own
malformed record.** Fixed here.

**Five lanes early-stopped or were killed mid-flight** (a session restart took all of them), and in
every case the artifacts were further along than the report. Checking `git status` and the diff, not
the report, is what recovered them. One lane returned a **NEEDS_DECISION** rather than guessing at a
missing port — it had proved that no port, service, in-memory map or table carried a live position's
open time — and that halt was the correct outcome, not a failure.

**A fourth orchestrator miss, caught by the instrument that exists for it.** The first deploy of this
pass was run as a plain `docker compose up -d --build app`, omitting the `GIT_SHA=$(git rev-parse
--short HEAD)` prefix the playbook § deploy step spells out. The image built and the container came up
healthy — and `build_info{git_sha}` read **`"unknown"`**, because `${GIT_SHA:-unknown}` bakes the
literal. **The playbook documents this exact failure mode**, and the deploy "succeeding" while being
unverifiable by its own instrument is the pass's own through-line pointed back at itself. Redeployed
with the prefix. **Never verify a deploy by container health alone; the sha is the verification.**

**A scoping fact on #149's clock fix, recorded because it bounds where the fix is live.**
`RoundTripEvidenceReader` — the concrete `RoundTripEvidencePort` the new closure reuses — hardcodes
`DEMO_MODE = 'testnet'` (pre-existing, untouched, correct for the reflection-evidence job it was built
for). So `openPositionOpenedAt` returns `null` for any position whose fills are recorded under
`mode='paper'`, and the clock **fails open to `barsElapsed: 0` there — never worse than before, but
inert.** This deployment's `mode_info` settles to `effective="testnet"` after the documented ~69 s
boot transient and its fills carry `mode='testnet'`, so the fix **is** live here. If the lane is ever
run in paper mode, this fix is a no-op until the reader's mode is threaded rather than hardcoded.

## 2026-08-10 — Pass 67 (the out-of-sample arm stopped being UNSTARTED, and the one owed enable is refused by its own precondition)

**Window:** 2026-08-10T16:07Z → 16:46Z. Lease `04fb519b02bec364` taken 16:07:41Z, released 16:46Z. `date -u` anchored
BEFORE any timestamp forensics (16:07:16Z). Sweep `2026-08-10T16:07:51Z`: **ZERO alarms**, 17
annotations. Boot `a5279f26-8b35-4275-8a7b-d1a7ca6a4569`, StartedAt 2026-08-10T09:49:33Z,
RestartCount 0, running build **`917e542`** (`build_info` read directly, not inferred), working tree
tip `3a23dc1` — the three commits above `917e542` are docs-only, so the deployed build IS the newest
app-code commit. 26 Prometheus rules loaded, 0 firing.

**Fan-out:** 2 read-only lanes declared and joined. `loop:fanout join` line, verbatim:
`loop-fanout: COMPLETE — all 2 declared lane(s) returned (recon-adopt-nonadoptable, e1-e2-derivatives-readiness).`

### The four mandatory per-pass signals — read POSITIVELY, never inferred from the absence of an alarm

| signal | reading | verdict |
| --- | --- | --- |
| `kill_switch_state{state="RUNNING"}` | 1 | RUNNING |
| `reconciliation_last_success_timestamp_seconds` | 1786378326.167, age **83s** | fresh, non-zero |
| `agentic_budget_remaining_usd` | **1.8424065** of the one $3/day breaker | non-zero |
| `agent_decisions` on the current bootId | Δ1000 rows, **21 REAL** model decides, newest 15:45:23Z | flowing |

Also read: `agentic_last_gate_timestamp_seconds` age **774s** (WATCH-V4-22 holds — the 2700s
`AgenticLaneNotTicking` threshold is not close), `agentic_capability_violations_total{kind="open_short_on_spot"}` = **0**,
`mode_info{requested="testnet",effective="testnet"}`, live menu **10** symbols.
**Migration `0003` VERIFIED APPLIED** — `agent_decisions.stop_reason` is present in `\d`, 4 rows in
`drizzle.__drizzle_migrations` (newest 1786352088242 = 08:54:48Z). STATUS's "`pnpm migrate` MUST run
before the next deploy" is therefore **DISCHARGED**, not outstanding.

### §3 — the sweep is clean, and the two RESOLVED alerts were investigated anyway

The playbook's own rule ("a resolved critical is a defect investigation anyway") was applied, not waived.

- **`ReconcilerStalled` (critical) — 1 firing sample at 2026-08-10T09:49:55Z**, i.e. **22 seconds after
  StartedAt**. This is the redeploy carve-out, **seventh timed confirmation**. Not a defect. Read off
  Prometheus' own `ALERTS` series by range query, so the timing is measured, not assumed.
- **`ReconciliationMismatch` (warning) — two DISTINCT classes, and only one was already explained.**
  `class="algo_orphan_adopted"` 09:54:55Z→09:58:55Z (5 samples) is the known post-boot orphan
  re-adoption. **`class="adopt_non_adoptable"` fired 11:47:55Z→12:06:55Z (10 samples) — two hours into
  a healthy boot, not a boot transient**, and was investigated as a defect candidate.

#### `adopt_non_adoptable` — VERDICT BENIGN for this episode, with a discriminator that makes the next sighting cheap

Mechanism (`src/features/trading/execution/reconciliation.service.ts:77`, counter at `:268-272`,
candidate selection at `:892-897`): _we hold this order open locally, but this pass's `fetchOpenOrders`
did not list it._ Three bump sites inside `adoptTerminal`/`backfillClosedOrderTrades` (`:1097-1103`,
`:1105`, `:1147-1150`); only `canceled`/`expired` are legally adoptable (`terminalEventFor`, `:1174-1183`).
**Fails CLOSED — refuse, leave alone, re-check next pass**: every bump is followed by a bare `return`,
no `acc.halts.push`, no fold, no cancel. The one real cost is documented at `:1130-1137` — a persistent
occurrence blocks `lastCleanAt` and with it auto-resume.

Two rows in the window, both `binanceusdm`: id **57770** at 11:46:04.768Z (`adopt_non_adoptable:1,backfilled_fill:1`)
and id **57798** at 12:01:11.018Z (`adopt_non_adoptable:2`). Both `result=MISMATCH`, **never HALT**; the
kill switch was never engaged; equity flat at 4961.39–4961.55 USDT across 11:57Z–12:06Z and the position
vector unchanged. Two increments × `increase(...[5m])` × the :55 eval offset reproduces the 10 reported
samples exactly. Episode A healed in **62s** via `DemoFillPollerService` (`poll:` dedupe-key prefix minted
only at `demo-fill-poller.service.ts:170`); Episode B was a venue-endpoint disagreement (`fetchOrder`
said `open` while per-symbol `fetchOpenOrders` had not propagated a ~35s-old ACK) and cleared on the next
pass (57800 at 12:02:22Z, `open_orders_checked` 2→4, CLEAN). Both heals are **named mechanisms, not luck**.

**Recurrence: 8 distinct days, 121 increments lifetime** (58,268 `reconciliations` rows scanned). This
clears the N≥2 bar, so it is root-caused here rather than normalised — **and the histogram contains two
different phenomena that must never be pooled**: 2026-07-27's **100 rows over 3.5h of consecutive passes**
is the DEFECT shape already documented at `:1412-1420` (a stale-snapshot fold stranding a venue-FILLED
order, since fixed at `:1422`); 07-30 → 08-10 are 1–3 isolated rows clearing on the next pass.

> **DISCRIMINATOR, binding on every future sighting:** the same coid bumping this class on **≥2
> consecutive passes on the same venue = DEFECT** (something is stranded non-terminal); a **one-shot bump
> whose successor pass is CLEAN = the venue-read race**, benign. What would overturn BENIGN: (a) that
> ≥2-consecutive-pass repeat, (b) an order that took a bump never reaching a non-null `terminal_at`, or
> (c) a bump coinciding with a `position_drift`/`fill_overflow` halt on the same symbol. **None of the
> three holds for 2026-08-10.**

**Recorded, NOT shipped — with a named trigger.** All three bump sites are anonymous: no log line, no
`acc.notes` entry, and `detail` carries only `class:count`, so the lane had to identify the objects by
arithmetic and elimination and **still could not pin which two of three fresh LIMITs took the 12:01Z
bumps**. The minimal mirror of `recordPositionDrift`'s existing bounded `acc.notes` channel (`:798-819`)
is written out in full in this pass's lane report. **Trigger to ship it: the next deploy this loop makes
for any other reason** — it is diagnosability-only on a fail-closed path the lane verified is behaving
correctly, and a deploy whose sole purpose is diagnostics would add a boot transient to E1's in-flight
soak (below) for no measurement gain.

### §1a — THE OUT-OF-SAMPLE SESSION ARM IS NO LONGER UNSTARTED

**This is the pass's headline.** Firing #1 of the decide leg ran end to end against real data for the
first time since the machinery landed (`924f8b2`, Pass 66). Previous sweeps annotated
`_oos_arm_unstarted_` and `_oos_arm_decision_record_empty_`; both are now false.

1. **Gather** — `loop:oos-gather` wrote **4** candidate rows, `gatheredAtMsFromDb=1786378131000` (DB
   clock, per § vi, never the host's). One playbook version across the window (v10), so the
   version-span refusal did not fire.
2. **Blind decide** — dispatched subagent, VOID-4 convention (amendment 2026-08-10 § 4). Its entire input
   was the candidates file plus the composed prompt surface from `buildLiveSystemPrompt`/`buildPlaybookBlock`
   — **never hand-composed**: `systemPromptSha256 f719d5455c28f00f…`, `toolSchemaSha256 7cddfe56c51020f7…`.
   Decisions: `67526` PEPE/USDT **hold**, `67525` BTC/USDT:USDT **hold**, `67527` SOL/USDT:USDT
   **open_short**, `67573` KAITO/USDT:USDT **open_long**.
3. **Record** — `OOS_ARM_RUN=1 … exec vitest run test/eval/agentic/oos-arm-run.spec.ts`, 6 tests passed
   (5 always-on + the gated leg). **`research/oos-arm/decisions-2026-08-10.jsonl`, 4 lines**, every row
   `capsSource:"recorded"` (VOID condition 1 clean) and `schemaValid:true`. Both VOID checks
   (caps-faithfulness, entry-rate bound) ran BEFORE the append and passed — session entry rate this
   firing **2/4 = 50%**, under the absolute 65% ceiling of condition 3(b). `agentPromptCommitSha`
   `3a23dc1823e96d3f…`, `agentPromptBlobSha` `5ed73d67f21a0d8f…`.

**FIRING #2 (pass end, 16:37:49Z)** fired as the amendment's dual-leg cadence requires —
`gatheredAtMsFromDb=1786379870575`, **2 rows** after rowId-dedupe against firing #1 (`67602` KAITO/USDT:USDT
**open_long**, `67652` ZEC/USDT:USDT **hold**), same prompt surface (`f719d545…` / `7cddfe56…`, unchanged
because nothing was deployed between the firings), both `capsSource:"recorded"`, both VOID checks clean.
**NO GAP this pass: both legs fired.** Transcript artifact: agent `af2b50ff6292ce0af` — same durability
blocker as firing #1.

**NOTHING WAS SEALED, and that is correct** (amendment § 7): read 1's target is **202 rows** and this pass
brings the window to **6** (4 + 2). A seal IS a scored read against the family's 6-read budget, so sealing
early buys an UNDERPOWERED read for a spent slot. At the amendment's own 33.675 rows/day the target lands
≈2026-08-16 — though **this pass delivered 6 rows, not the 11.2 the amendment's per-firing rate projects**,
so that date is optimistic on today's evidence and the next passes should watch the realised rate.

**FLAGGED — the VOID-4 artifact is not durable, and this pass could not make it durable.** The
pre-registration requires the deciding subagent's transcript to be _checked before the seal is written_
and "never summarized, redacted, or regenerated". That transcript (222 KB, agent id
`a16c5a955547fa858`) lives in **session-scoped harness storage outside the repo**, and the seal is ~6 days
and ~50 firings away. An attempt to copy it into `research/oos-arm/transcripts/` was **DENIED by the
host permission gate** — this is a genuine BLOCKER, not a scheduling choice: the pass could not obtain
the capability. Stated plainly because the consequence is concrete: **if these transcripts are not
preserved, VOID condition 4 becomes unverifiable for read 1 and the read is void by construction.** The
retention design is also non-trivial (≈200 KB × 6 firings/day ≈ 1.2 MB/day, ~7 MB to first seal, ~40 MB
across the family), so it needs a decision, not a reflex. Next pass owes it.

### §4 — pass type MAINTENANCE, and CANDIDATE is ineligible on the gate's own reading

**CANDIDATE ineligible.** Minting is EVENT-DRIVEN since `abcfc61`: permitted only when the incumbent
reads adverse-POWERED (`powered ∧ ciHi < 0`, `flat_only`, h=4 or h=8) on a fresh recomputation.
**This sweep's own recomputation: v10 `flat_only` h=8 = −13.7 bps [−29.1, **+5.9**] n=58 clusters=11.**
The interval includes zero, so `classifyMintTrigger` (`scripts/loop-authoring-core.mjs:1426`, `:1486`)
does not permit a mint. Pass 66's independent read of h=4 (−9.3 [−32.1, **+15.7**]) agrees. **The trigger
not firing IS it working.**

`loop:authoring --dry-run` was run (exempt from the day slot, writes nothing) and is recorded for what it
does and does not prove: **`dryRun` is the ONLY exemption to `classifyMintTrigger`** (`:1479`, `:1491`),
so the dry run **bypassed** the event gate rather than clearing it — it does not establish eligibility.
What it did measure: incumbent `incumbent_v10`, entry rate **41/150 = 27.3%** on the same rows;
`dryrun_variant_1` won 3/4 horizons (h=1 +12.8, h=4 +16.6, h=8 +10.1) but **LOST the primary h=24 (−5.7)**
and was **HALF_LOST** on chronological halves — "a win located in half of a single-regime window", fails
CLOSED. RESEARCH bar 4/4 cells, 0 passes ⇒ NO_SURVIVOR. **`MINT GATE: REFUSED`.** No registry rows were
written (dry run), so **the UTC day's authoring slot is UNSPENT** and no honest-N row ids exist to record.

**PROMOTION ineligible** — `promotion_evidence` this sweep: `windowDays=17.909358402777777`,
`roundTrips=83`, `netPnlUsd=−80.6143034444`, `llmCostUsd=40.5201836`, `winRate=0.2891566265060241`,
`ready=false`, reasons `[NON_POSITIVE_NET_PNL, BELOW_PASSIVE_BENCHMARK]` — all seven fields from ONE
`evaluate()` call. Against Checkpoint #1's tuple 7h15m earlier (08:52:03Z: 17.500/80/−81.2138/40.0934/0.275):
**+3 round trips, net PnL +$0.5995 BETTER, LLM spend +$0.4268, win rate 0.275 → 0.2892.** Gross on those
3 trips ≈ **+$1.03**. **n=3 — quoted as a window delta, never as a trend.** Per-version scoreboard sums to
83 trips exactly, so the book and the version split agree.

### The owed action: E2 is REFUSED today, on its own stated precondition

STATUS owed item (1) is "add `AGENTIC_DERIVATIVES_V2_ENABLED=true` to `.env.app` … only after E1 soaks one
pass, and only after confirming **no active sweep compares d1-tagged rows first**." **Both clauses fail.**

- **The d1-tag precondition FAILS.** `feedTags` (`anthropic-agent-client.ts:1783-1790`) puts `d2` in the
  same slot as `d1`, and the joined tag is SHA-256'd into `agent_decisions.prompt_hash`
  (`agent-prompt.ts:523-536`) — an opaque digest, so a partition identified by its hash **silently loses
  every post-flip row**. The code says so in terms: _"ENABLING V2 MID-FACTORIAL IS FORBIDDEN"_
  (`agent-prompt.ts:44-49`, mirrored `environment.config.ts:389-397`). Since this boot there is exactly
  **one** partition, `7ee5a76d`, 24 rows / 20 perp / 4 perp entries (positive control: the same query
  without the boot filter returns 4,608 perp rows over 3 days). **Two open measurements would break:**
  (a) **E1/L6's own registered watch** — clause 1 is already MET (the hash moved off `aefafb3c…`), but
  clauses 2 and 3 grade the _first 20 perp trips_ and _first 50 v6 perp proposals_ against the d1-era
  baseline and are at 20 rows / 4 entries today; (b) **L1's `stop_reason` read, deadline 2026-08-17** —
  registered as the `max_tokens` share on the `+eff-medium` partition over **7 days of post-deploy rows**,
  ~6.5h elapsed, n=12, 1 `max_tokens`. Breaking it is both mechanical (new digest) **and substantive**: the
  watch exists to separate a request-parameter effect from a payload-size one, and d2 grows the payload
  mid-window — re-introducing the exact confound the instrument was built to remove.
- **E1 has not soaked one pass.** E1 = the L6 fee-truth enable `917e542`, live at boot 09:49:33Z —
  **~6.5h, and its effective measurement clock is ~4.5h** (earliest accepted decide under `7ee5a76d` is
  11:45:29Z). The loop's own precedent is deploy-in-N / soak-verdict-in-N+1; no soak verdict exists.
- **A rider the enable would fire and not satisfy.** `derivatives_feed_poll_errors_total` **structurally
  cannot count spot-ticker sub-poll failures** (`fetchSpotTicker` catches its own rejections and never
  touches `errorCount`) — re-confirmed live: the counter reads **0** while the LTC spot-ticker warn counter
  reads **1**. Its recorded trigger to ship is _"any enable of derivatives v2"_, and E2 as specified is
  env-only, so flipping the flag fires that trigger and leaves it unmet.

**Cost was NOT the reason to refuse and is recorded so no later pass re-derives it:** +136 bytes payload
(≈+2.0% of a 6,862-byte user message) and +159 chars of cached system prompt ≈ cents/day against $3.
**Earliest clean flip:** after L1's `stop_reason` read completes (08-17) **and** E1's soak verdict is filed
with its cohorts full. The exact one-line edit, in this file's own comment style, is carried in the lane
report — **not applied.**

The v2 fields are **FOUR, not the three STATUS names**: `spotPerpBasisBps`, `oiChangePct`,
`fundingTrendDelta`, **`fundingTrendDirection`**. Baseline re-measured: **0/326** payload-bearing perp rows
over 3 days carry any of them (positive control: **all 326 carry a `derivatives` block**, so the zeros are
real absences). On the frozen entry-decision filter the old "0/94" is now **0/130**.

### "E1" and "E2" were defined NOWHERE in this repository

The lane could not find a definition: STATUS.md's owed item uses both labels, and a repo-wide search of
`*.md` returns only that line plus `LOG.md`'s Pass 66 reference to "the plan's E1 watch". The
identification E1 = L6/`917e542` is an **inference** from that reference plus Pass 66's shipped set — and
`verdicts.md` uses "E2" for an unrelated thing (the haiku-4.5 decide-model re-test). **A dated owed action
whose subject is unnamed is a state-file defect**, and it is fixed in STATUS this pass by naming both
labels with their commits. Recorded rather than smoothed: this pass spent a lane's time recovering a
definition that should have been one line.

### Diff, gates, deploy

**No code shipped and NOTHING WAS DEPLOYED — deliberate, and this is the rationale.** The sweep was clean;
the one investigated alarm class is benign on a fail-closed path; the only owed enable is refused by its own
precondition; and CANDIDATE is ineligible on the mint gate's own reading. The single available code change
(the `adopt_non_adoptable` diagnostic) is diagnosability-only and carries a named trigger instead. A deploy
this pass would have bought nothing and added a boot transient to E1's in-flight soak.

Files: `research/oos-arm/decisions-2026-08-10.jsonl` (new, the arm's first real record),
`research/loop/LOG.md`, `research/loop/STATUS.md`, `research/loop/archive/LOG-through-pass-47.md`
(Pass 62 rotated verbatim). Gates: `pnpm lint:md` and `pnpm format:check` green; the husky pre-commit hook
validates the whole repo on commit. Full `build`/`lint`/`typecheck`/`test` not re-run — **no source file
was touched this pass**, and the sweep already carries this morning's harness reads
(`loop-sweep-specs` 379/379, `eval:agentic` 102 passed/21 skipped, `backtest` 80 passed/10 skipped, all
PASS 6.3h ago). Soak: **N/A, nothing deployed.** WATCH-V3-1: RSS delta is annotated
`_rss_delta_spans_warmup_` this sweep — the prior sample sits 1 min into the boot, inside the 45-min
warm-up grace, so the Δ327 MB **neither establishes nor refutes** a slope and is not read as one.

### Flagged / next-pass candidates

1. **The VOID-4 transcript durability BLOCKER above** — the arm accrues rows every pass from here, and each
   un-preserved transcript is a row-block that cannot be blindness-checked at seal time. Highest priority.
2. **Re-read Checkpoint #1 at the first pass after 2026-08-11T12:00Z**, then 08-18 and 08-25.
3. **L1's `stop_reason` read, due 2026-08-17** — n=12 today; do not flip any payload flag into that window.
4. **E2 stays owed but DATED-BLOCKED** — earliest clean flip after 08-17 with E1's soak verdict filed.
5. **The `adopt_non_adoptable` diagnostic diff**, to ride the next deploy made for another reason.

## 2026-08-11 — Pass 68 (the VOID-4 blocker is a capability limit, not a scheduling choice — so the pass shipped the CHECK instead of the copy)

**Pass type: EVIDENCE-INTEGRITY** (promotion-ready-evidence tier, §4 priority 2). Sweep clean, so §3
did not force a defect investigation; the pass took STATUS's own named highest-priority owed item —
the OOS arm's VOID-4 transcript durability blocker. **Nothing was deployed** (no app-code change, so
no boot transient onto E1's in-flight soak). Lease `e43c2cdd94d35f88`, re-armed mid-pass as
`b52a413a31452995`.

### The sweep — run TWICE, and the second one is the §3 gate

| sweep | alarms | annotations | bootId | build | rules |
| --- | --- | --- | --- | --- | --- |
| 2026-08-11T00:07:36Z | **0** | 12 | `a5279f26` | `917e542` | 26 loaded / 0 firing |
| 2026-08-11T07:14:04Z | **0** | 14 | `a5279f26` | `917e542` | 26 loaded / 0 firing |

The first sweep is **not** this pass's evidence base: ~7h elapsed between it and the pass's next
successful command (below), and a 7h-stale alarm list cannot gate §3. The second sweep is the
authoritative read. Same boot, `RestartCount: 0`, container healthy in both.

**The four mandatory signals, read POSITIVELY at both instants — never inferred from an absent alarm:**

| signal | 00:08Z | 07:13Z |
| --- | --- | --- |
| `kill_switch_state{RUNNING}` | 1 | 1 |
| reconcile clean-stamp age | 57s | ~88s |
| `agentic_budget_remaining_usd` | 2.8906 | 2.2226 |
| real decides this boot / newest | 27 / 00:00:21Z | 25Δ / 06:45:36Z |

Also `agentic_last_gate_timestamp_seconds` age 454s then 616s (**WATCH-V4-22 holds**, threshold
2700s); `agentic_capability_violations_total{open_short_on_spot}` **0**; all three
`agent_client_latch_cause` children **0** (lane funded, no latch). Live menu 11 symbols.
`mode_info{requested="testnet",effective="testnet"}`. Day spend at 07:13Z is $0.7774 over ~7.2h —
pace ~$2.6/day against the $3 breaker, no proximity alarm.

**Promotion scoreboard** (07:14:04Z sweep, all seven fields from ONE `evaluate()` call):
`windowDays=18.375136770833333`, `roundTrips=84`, `netPnlUsd=-82.2436003144`,
`llmCostUsd=41.8417661`, `winRate=0.2857142857142857`, `ready=false`, reasons
`[NON_POSITIVE_NET_PNL, BELOW_PASSIVE_BENCHMARK]`. Against Pass 67's 16:33Z tuple
(17.909/83/−81.2992/41.1734/0.2892): **+1 round trip, net PnL −$0.9444 WORSE, LLM spend +$0.6684,
win rate 0.2892 → 0.2857.** **n=1 — a window delta, never a trend.**

### A 7-HOUR GAP INSIDE THE PASS, AND IT WAS NOT THE STACK

`date -u` at pass start read **00:07:11Z**. The next `date -u`, after the attestation step, read
**07:12:16Z**. `loop:unlock` confirmed it independently: _"lease already expired (425 min old)"_ —
7.08h.

**My first reading of this was WRONG and is corrected here rather than quietly dropped.** I inferred
a host suspend (the documented duty-cycle class). The evidence refutes it: across that window the app
produced **+25 real model decides** and **+1120 `agent_decisions` rows**, `app_suspend_events_total`
reported **0 suspends in 12h**, bootId was unchanged, `RestartCount` stayed 0, and host uptime
advanced by the full 7:07. **The stack ran normally throughout; what stalled was this pass's own
execution.** Cause is outside the app and outside what this pass can see — recorded as an observation,
not diagnosed.

**Two things it would have silently corrupted, both caught only because §1 step 2's `date -u`
re-anchor is a rule:**

1. **The lease was dead for ~5h of the pass.** Released and re-armed with a fresh nonce
   (`b52a413a31452995`), the sanctioned mid-pass move (P65 precedent). The lease **fails OPEN and
   binds only callers**, so nothing would have stopped a concurrent pass in that window.
2. **The OOS candidates gathered at 00:08:26Z were ~28 bars stale by the time they could be decided.**
   The shipped runner computes eligibility against `gatheredAtMsFromDb`, **not** the decide instant, so
   it would have accepted them and recorded rows whose true `k` at decide time was ~28 against a
   registered `k ≤ 3`. **That file was DISCARDED, not decided** — nothing was spent, and the leg
   re-gathered fresh at 07:13:37Z. This is the amendment's own rule ("never papered over by widening a
   later firing's lookback window to catch up") applied to the mirror-image case.

### §1a firing 1 — 6 rows, and the arm's first entry-bearing batch since the blocker was named

`loop:oos-gather` wrote **6** rows, `gatheredAtMsFromDb=1786432417751` (DB clock). One playbook
version (v10), so the version-span refusal did not fire.

**The prompt surface is now EMITTED BY A TRACKED SPEC, not hand-rolled.** New
`test/eval/agentic/oos-arm-emit-prompt.spec.ts` (env-gated `OOS_ARM_EMIT_PROMPT=1`, clean-skips
otherwise, wired into `pnpm eval:oos-arm`) writes the four surface files from
`buildLiveSystemPrompt`/`buildPlaybookBlock`. Hashes: `systemPromptSha256 f719d5455c28f00f…`,
`toolSchemaSha256 7cddfe56c51020f7…`, `playbookContentSha256 87af2021cec09d0d…`,
`agentPromptBlobSha 5ed73d67f21a0d8f…`. **The first two are byte-identical to Pass 67's**, which is
the expected result of VOID condition 2 given nothing was deployed between the passes — the first
time this loop has been able to state that as a measurement rather than an assumption.

Blind decide (dispatched subagent, `general-purpose`, opus — same shape as P67, kept for
comparability). Recorded via the gated runner, 6 tests passed, appended to
**`research/oos-arm/decisions-2026-08-11.jsonl`**:

| rowId | symbol | venue | action |
| --- | --- | --- | --- |
| 69931 | PEPE/USDT | binance | hold |
| 69930 | AAVE/USDT:USDT | binanceusdm | **open_short** |
| 69923 | BTC/USDT:USDT | binanceusdm | hold |
| 69922 | SOL/USDT:USDT | binanceusdm | hold |
| 69926 | UNI/USDT:USDT | binanceusdm | **open_long** |
| 69925 | ZEC/USDT:USDT | binanceusdm | hold |

Every row `capsSource:"recorded"` (VOID condition 1 clean) and `schemaValid:true`; both VOID checks
(caps-faithfulness, entry-rate bound) ran BEFORE the append and passed. **Session entry rate this
firing 2/6 = 33.3%.**

### THE VOID-4 BLOCKER IS A CAPABILITY LIMIT — NAMED, REPRODUCED, AND WORKED AROUND WITHOUT WEAKENING IT

STATUS's owed item (1). Pass 67 reported that copying the deciding subagent's transcript into
`research/oos-arm/transcripts/` was denied by the host permission gate. **This pass reproduced that
independently, twice, in two different command shapes** (a compound script and a bare single-file
`cp`). The denial is on the **action** — reading harness session storage into the project tree — not
on the command form: reading the file in place, hashing it, and computing over it all succeed. **This
is a capability the loop does not have and cannot grant itself.** I did not attempt to launder it
through a different tool, which would have been working around the intent rather than the mechanism.

**So the pass shipped a VERIFIER instead of a COPIER**, which the blocked capability is not needed for:

- `scripts/loop-oos-transcript-core.mjs` — pure classifier (`extractToolCalls`, `classifyBlindness`,
  `buildAttestation`). **FAILS CLOSED**, deliberately opposite to this study's measurement cores: a
  `Read`/`Write`/`Edit` outside the declared surface, a `Bash` referencing any path outside the scratch
  prefix, a `Bash` with no path token at all, **any** other tool, or any unparseable transcript line all
  refuse the "clean" verdict. Zero tool calls is clean.
- `scripts/loop-oos-transcript.mjs` — I/O shell (`pnpm loop:oos-transcript`). Reads the transcript **in
  place**, sha256 over the **raw bytes**, appends one line to `research/oos-arm/attestations.jsonl`
  (tracked; ~1 KB/firing, so the whole six-read family costs kilobytes — against ~23 MB if the raw
  corpus were committed, which `.gitignore:41-43`'s standing convention forbids anyway).
- `test/features/common/scripts/loop-oos-transcript-core.spec.mjs` — 23 tests, **on the production
  gate** via `pnpm test`.

**What the attestation is NOT: the artifact.** The transcript remains the sole evidence and is
untouched. The attestation adds the CHECK — run at capture time, while the bytes are known to exist —
plus a cryptographic pin so a seal-time reader can prove identity. Under the pre-registration's own
§ Blindness is procedural, it is the check the seal depends on. Full ruling:
`studies/oos-session-arm-2026-08-03.md` § Amendment 2026-08-11.

### THE FIRST VERSION OF THIS CHECK CERTIFIED CLEAN WHAT WAS NOT — CAUGHT BY THE PASS'S OWN REVIEWER

**This is the pass's most important finding and it is a finding against the pass's own work.** The
first classifier I shipped collected only content blocks whose `type` was literally `tool_use`, and
**silently dropped every other shape**. I wrote, and had already recorded, that Pass 67's two firings
were CLEAN. **They are not.**

Real transcripts also carry `{type:'server_tool_use', name:'advisor'}` with a matching
`{type:'advisor_tool_result'}`. Measured across the live corpus: **29 `server_tool_use` blocks in 23 of
27 subagent transcripts.** The harness injects an `advisor` tool into dispatched subagents by default,
it was invoked inside the decide legs, its result was returned into the deciding context, **and the gate
could not see it.** Two layers had opposite failure directions: `classifyBlindness` failed closed on an
unknown tool NAME while the extractor failed open on an unknown block TYPE, so the unconditional-violation
rule never fired on the calls it was written to catch.

I verified this myself before acting on the review — deep block-type counts on all four OOS transcripts,
`plain tool_use` vs `any *tool_use` — rather than taking the finding on report (STATUS's standing rule:
a claim inherited from a lane is evidence of nothing until this pass checks it).

**Re-attested with the corrected classifier. The record was REGENERATED, not edited — it was uncommitted,
so nothing false ever entered the history:**

| pass · firing | agentId | bytes | sha256 (first 16) | calls | verdict |
| --- | --- | --- | --- | --- | --- |
| 67 · 1 | `a16c5a955547fa858` | 222,121 | `62f15ee624f98df9` | 9 | **VIOLATED** — `Bash`, `advisor` |
| 67 · 2 | `af2b50ff6292ce0af` | 150,920 | `90333383ed239dba` | 6 | **VIOLATED** — `advisor` |
| 68 · 1 | `a5d2836268725850c` | 270,996 | `954af2697c2650c9` | 8 | **VIOLATED** — `Bash`×2, `advisor` |
| 68 · 2 | `a130daaa41f278a8b` | 155,615 | `1d3cef6fbb76dda7` | 5 | **CLEAN** |

**What is NOT established: no transcript shows a read of `research/loop/`, of `agent_decisions`, or of
candle data beyond the payload.** The live lane's own `action` was never in reach. What DID happen is
that an external reasoner was consulted inside three deciding sessions — which changes the identity of
the decider in an arm whose whole object is what a _session_ extracts from these bytes.

**Ruling (loop-domain, §4 autonomy — decided and recorded, not flagged): the 12 rows from those three
firings are VOID-4-FLAGGED.** Read 1's seal must either EXCLUDE them or carry a dated argument that the
advisor channel is non-contaminating; it may not silently score them. **Recommendation: exclude.** That
costs rows and buys nothing, which is exactly why it is the right default — the same asymmetry the
pre-registration already relies on to remove any incentive to void a read one dislikes.

**The one CLEAN firing is the evidence the remedy works.** Firing 2's brief forbade `Bash` outright and
constrained the subagent to four `Read`s and one `Write`; that subagent **declined the advisor on its own
and said so unprompted**. Every future brief carries that constraint, so a `non_client_tool_call` from
here on is a real finding rather than a default.

### THE GATE WAS MADE STRICTER, NEVER LOOSENED

The review also produced **eight false-CLEAN `Bash` commands** against the original path-allowlisting
branch — including `cat <allowed>/../../etc/passwd` (prefix escape by string containment),
`psql -c "select * from agent_decisions" > <allowed>/out` (reads this study's own ground truth), and
`cat <allowed>/candidates.json README.md` (a bare filename carries no `/`, so it was invisible). The
original header's claim that an over-broad token set "cannot mask a real violation" **was false and is
retracted in the amendment.**

`Bash` is now an **unconditional violation**, the same tier as `Grep`/`Task` — which is what the study's
own dispatch brief already required. The tokenizer is **deleted rather than hardened**: a classifier
retaining any Bash-clean path is more permissive than the procedure it enforces. Also fixed:
`classifyBlindness` now THROWS on malformed preconditions (it previously returned `clean:true` when
`toolCalls` was omitted), and the attestation record no longer embeds absolute host paths or the
developer's username (`schemaVersion: 2`; verified `grep danielhendrich` returns nothing).

Separately, P68 firing 1 had ALSO tripped the old tokenizer on two `sed` expressions
(`1s/^.\{37000\}//p`) misread as paths. That false positive is now moot — `Bash` violates regardless —
but its cause was fixed anyway: `loop-oos-arm-gather.mjs` writes the candidates file pretty-printed, so
a subagent pages the same bytes with `Read` and never needs a shell. Content after `JSON.parse` is
byte-identical, so nothing the study measures changes.

### §1a firing 2 — 1 row, and the fix's expected-positive MET on its first reading

**NO GAP this pass: both legs fired.** Firing 2 gathered **0 rows twice** (07:28:22Z, 07:29:21Z) —
firing 1 had consumed the eligible window ~15 min earlier and rowId-dedupe correctly left nothing —
then **1 row** at 07:31:09Z (`gatheredAtMsFromDb=1786433469627`) once a further bar had closed.

Row **70052 UNI/USDT:USDT → hold**, `capsSource:"recorded"`, `schemaValid:true`, both VOID checks
clean. Session entry rate this firing 0/1.

**The gather fix and the tightened brief worked, measured not assumed.** Firing 2's transcript
(`a130daaa41f278a8b`, 155,615 bytes, sha256 `1d3cef6fbb76dda7…`) attested **CLEAN — 5 tool calls, ZERO
`Bash`.** The subagent paged the now-pretty-printed candidates file with `Read` and never reached for a
shell, which is exactly **WATCH-V4-25's expected-positive** and the direct counterpart to firing 1's
false-positive. One deviation it disclosed unprompted and correctly: it declined to call its own
`advisor` tool because that would have been a tool call outside the permitted set.

### NOTHING SEALED, and the row rate is measurably below projection

Read 1's target is **202 rows** (amendment § 5). The window stands at **13** (6 from P67, 6 + 1 here).
A seal IS a scored read against the family's 6-read budget, so sealing early buys an UNDERPOWERED read
for a spent slot.

**The realised rate is worse than the amendment's projection, for a structural reason worth naming.**
The amendment projects 33.675 rows/day from 6 firings × 5.6125 rows. P67 delivered 6; this pass
delivered **7**. The dual-leg design meets its own dedupe: **two firings close together in wall-clock do
not yield two firings' worth of rows** — firing 2 here returned 0, 0, then 1, gated entirely by how many
15-min bars had closed since firing 1, not by the leg firing twice. At ~6-7 rows/pass and 3 passes/day
the target lands far later than the amendment's ≈2026-08-16. **Do not quote 33.675/day or 08-16 without
this correction.** The lever that would actually help is spacing the two firings across the pass rather
than minutes apart.

### Diff, gates, the review, and what was NOT done

**Shipped `d32b094`** (10 files, +1193/−2): `scripts/loop-oos-transcript-core.mjs` (new, pure),
`scripts/loop-oos-transcript.mjs` (new, shell), `test/features/common/scripts/loop-oos-transcript-core.spec.mjs`
(new, 32 tests, production gate), `test/eval/agentic/oos-arm-emit-prompt.spec.ts` (new, env-gated emitter),
`scripts/loop-oos-arm-gather.mjs` (pretty-print), `package.json` + `eslint.config.mjs` (wiring),
`research/studies/oos-session-arm-2026-08-03.md` (§ Amendment 2026-08-11),
`research/oos-arm/attestations.jsonl` + `decisions-2026-08-11.jsonl` (records).

`pnpm checks` (format:check + lint:md + lint + typecheck + test:cov) **exit 0** — coverage
93.23 / 87.04 / 92.15 / 94.56, all above thresholds. `pnpm build` **green**. `pnpm eval:agentic`
**102 passed / 22 skipped**, the env-gated legs skipping cleanly as designed. Core spec went 23 → **32
tests** with the fix. Gates were re-run in full AFTER the classifier fix, not only before it. **No deploy,
no soak** — nothing in this pass touches app code, so the running build stays `917e542` and E1's soak
window is undisturbed.

**THE REVIEW IS THE REASON THIS PASS IS HONEST, AND IT RETURNED MUST-FIX ON WORK THAT HAD ALREADY PASSED
EVERY GATE — the fourth consecutive pass where that has happened.** All gates were green, 23 tests passed,
and the tooling was certifying the exact opposite of the truth. The reviewer's severity-1 finding was
empirical, not stylistic: it probed 25 real transcripts and produced the block-type counts. It also
produced eight concrete false-CLEAN `Bash` inputs and caught a `code-hygiene` violation (the developer's
username committed in a tracked record). **Every must-fix was applied in-pass**; the two should-fix items
not applied are named below. **Green gates are not evidence** — this is the standing STATUS line, earning
itself again.

**Process misses this pass, recorded not smoothed:**

1. **The orchestrator asserted what it had not checked** — I wrote "attested CLEAN" into LOG, STATUS and a
   frozen study amendment on the strength of a tool I had just written and not adversarially probed. The
   recurring failure mode named in STATUS, committed again.
2. **The first classifier shipped opposite failure directions in one pipeline** (extractor open, classifier
   closed) — the exact `code-hygiene` § failure-direction rule, violated by the module whose entire purpose
   is failing closed.
3. **A checkable comment asserted a verification that had not been done** ("verified against a live
   transcript") — falsified by the very file it was attesting.

**Fan-out discipline — a deviation, disclosed.** `pnpm loop:fanout declare` was **blocked by the host
permission classifier** in two invocations (both roster locations). Rather than run an undeclared
parallel fan-out, the pass dropped to **one write lane at a time**, for which §4.6 requires no roster.
Lanes: `attestation` (the three transcript files) and `emitter` (the one spec), dispatched serially,
each verified by the orchestrator against its artifacts, not its report. The two orchestrator-owned
edits (`package.json`, `eslint.config.mjs`) were made by the orchestrator, and the `eslint.config.mjs`
line was applied only after I read lines 53-61 and confirmed the lane's claim of seven precedented
entries myself.

### Flagged / next

1. **E2 stays DATED-BLOCKED to ≥2026-08-17** — untouched this pass, not re-litigated.
2. **L1's `stop_reason` read, due 2026-08-17** — untouched; **no payload or prompt flag flipped into
   that window this pass**, which the pass deliberately preserved.
3. **Checkpoint #1 re-read is NOT due** — the gate is the first pass after 2026-08-11T12:00Z and this
   pass ran 00:07–07:4xZ. Deliberately not pulled forward.
4. **WATCH-V4-25 opened** (`watches.md`) — six named defect outcomes, resolution deadline = read 1's
   first seal.
5. **⛔ EVERY FUTURE DECIDE-LEG BRIEF MUST FORBID `Bash` AND THE ADVISOR EXPLICITLY.** This is now the
   single highest-value process rule for the arm: the harness injects `advisor` by default, so the
   DEFAULT outcome is a VIOLATED firing. Firing 2's brief is the working template — four `Read`s, one
   `Write`, `Bash` forbidden by name, and a line telling the subagent its transcript is the audit
   artifact. Copy it verbatim.
6. **12 of the window's 13 rows are VOID-4-FLAGGED** and the seal must resolve them (exclude, or a dated
   non-contamination argument). **Do not seal read 1 without doing so**, and do not treat the flag as
   fatal to the arm — the remedy is proven and the rows accruing from here are clean.
7. **The row-rate correction above** is the next pass's most decision-relevant number: if ~6-7 rows/pass
   holds, read 1's seal is weeks out. A pass that wants more rows should space the two firings across the
   pass, not run them minutes apart.
8. **Two reviewer should-fixes NOT applied, named so they are not lost:** (a) `loop-oos-transcript.mjs`'s
   own exports (`projectSlug`, `parseArgs`, the path builders) carry **zero test coverage** — the slug
   transform was verified empirically against the live directory name but nothing will notice if it
   drifts; (b) `rowIds` binding is **operator-asserted, never verified** — a mistyped `--agent` yields a
   clean-looking attestation for the wrong transcript, and the cheap fix is to require that one allowed
   `Write` target equals the declared answers path. Also latent: a `path_not_allowed` violation's `detail`
   embeds the offending absolute path verbatim, which could reintroduce a username into the tracked record
   on a future real violation.
