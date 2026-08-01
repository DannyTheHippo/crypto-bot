<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 53,
2026-07-31**. Hard cap 200 lines — anything longer belongs in the file that owns it, with a pointer here.

## ⚠ `loop:sweep` REPORTS Alarms (2). ONE IS EXPECTED, ONE IS A REAL DEFECT WITH A NAMED BLOCKER

> **`venue_reject_rate_high [binance]` — 16/20 = 80.0%. EXPECTED. Do not investigate, do not tune.**
> All 20 submits predate the `f5abf8a` fix; all 16 rejects are one `reduce_only SELL ZEC/USDT` retrying
> every 30 min. It clears once 20 clean spot submits accumulate. **Do not lower the threshold** —
> derived from binanceusdm's 4/186 baseline (Wilson 99.9% upper bound 8.45%) and pinned by a spec.
> Resolves on the first real spot entry, with `WATCH-V4-13`.
>
> **`venue_reject_rate_high [binanceusdm]` — REAL, root-caused Pass 53, REPAIR NOT SHIPPED.** 12
> reduce-only KAITO exits terminal-rejected `-4024` in five minutes; the position then carried **no stop
> for 45 minutes**. Frame mismatch: `FEED_ENV=live` prices orders the `SANDBOX_ENV=demo` venue executes,
> and `-4024` is that venue's `PERCENT_PRICE` floor (its own mark × 0.95), which sat ABOVE our ref on
> all 12 attempts. **The obvious fix was REFUTED** (retaining the plan-stop registry row re-arms nothing
> and breaks `orphan_readopt`); the correct seams need `agentic.strategy.ts:1434-1438` resolved first.
> Forensics + exact diffs: `incidents/2026-07-31-perp-exit-band-rejects.md`.

## ⚠ THE HORIZON GRID FLATTERS EVERY RESULT — re-read any prior finding before quoting it

> h ∈ {1,4,8,24} was never matched to holding behaviour (**median hold 15.6 bars, mean 54.5**).
> Re-scored: **v1 −16.9 → h=16 −57.6, h=54 −111.3; v2 −15.9 → h=16 −94.5, h=54 −174.8.** This
> **reconciles** forward return with realized gross (−69.1 bps/trip; h=1 brackets nothing). **The gap
> to the +13.0 bar is ~70–125 bps, not ~30.** No ordering flips. `verdicts.md`;
> `research/studies/learning-capacity-2026-07-31.md`.

## ⚠ TWO LIVE BEHAVIOUR CHANGES SHIPPED 2026-07-30, AND NEITHER MAY BE CREDITED ALONE

> **v10 `inverted`** is live — a RESEARCH-BAR FAIL shipped on deployment-bar grounds, h=24 CI lower bound
> −12.2; **never quote +47.6 as an edge.** **`AGENTIC_PLAN_AUTHORITATIVE_EXITS=true`** (`.env.app:261`,
> same boot) — baseline **−108.1 bps/trip at 17.4% hit**. **ATTRIBUTION LIMIT:** both live simultaneously,
> no control arm — evidence is separable, **realised-PnL contributions are NOT.** `watches.md` § V10-1.

## The LLM lane — FUNDED AND TRADING; do not investigate a latch

> Anthropic funded 2026-07-30, Moonshot presumed suspended. Owner directive, verbatim: *"lack of
> trading is because of the anthropic api account being unfunded. this should not have to turn into
> investigations on each pass."* **If a sweep shows a latched client, read the CAUSE, do not
> investigate.** `agent_client_latch_cause{cause="insufficient_credit"} == 1` means the balance is out
> (owner capability limit); fails CLOSED — any other cause is `other`, keeps `AgentClientFatalLatch` at
> `critical`, and IS a full incident. **Funding does not make resumed trading unambiguously good.**

## Current order & status

- **Live build `35042cc`** (`build_info{git_sha}` confirmed), boot **2026-07-31T16:52:51.674Z**,
  bootId `4753ef53`, `RestartCount` 0, healthy. **23** Prometheus rules loaded (was 22), 0 unhealthy,
  0 firing — Prometheus WAS force-recreated this pass because `alerts.rules.yml` changed. HEAD
  (`7d2e1d2`) is one records-only commit ahead: **zero runtime delta, no deploy due.** The redeploy
  re-seeds the `agentic_venue_stop_total` counters WATCH-V4-11 and V4-13 read — note that provenance.
- **Pass 53 shipped the visibility fixes, NOT the `-4024` repair** (banner above has the blocker):
  `VenueTerminalRejectBurst` (WATCH-V4-14), the reconcile skip-log demotion, and the sweep's
  pass-coverage audit un-blanked. `LOG.md` § Pass 53.
- **`loop:authoring` HAS NEVER MINTED — 0 rows lifetime** — the registry gate `633f901` made it
  impossible, so that fix is **UNVERIFIED** and `WATCH-DEPLOY-HALVES-1` sits at SAMPLE ZERO. **The
  concurrent pass's uncommitted `.env` fix (see COLLISION #5) is plausibly the rest of the reason.**
- **A promtool trap:** checking `/etc/prometheus/alerts.rules.yml` inside the container after a host-side
  edit is VOID (dangling inode; reads like corruption, is not). Recipe in playbook §5.3.
- **THE BAR THIS PROGRAM GATES ON WAS NEVER DERIVED.** +13.0/+24.2 enter the repo fully formed in
  `7b3e977` with no operands; every later citation is circular. Measured demo cost 9.29 bps/round trip.
  `research/studies/fee-floor-derivation-2026-07-31.md`.
- **THE `−16.9 bps` ENTRIES FIGURE IS WRONG — it is `−13.75` (n=64, not 61).** 3 of 64 frozen rows fell
  past the `279713e` OHLCV truncation, so every reading silently scored 61; both implementations agree
  at −13.7503. **Five `verdicts.md` citations are stale**, the mirror is UNVERIFIED beyond h=1, Pass-41's
  original NOT re-derived. **A frozen constant reading a mutable cache fails only when the defect is FIXED.**
- **FAMILY B IS BLOCKED, not for scheduling reasons.** `assertDesignMatchesCorpus` fails CLOSED on
  `030367ba…` vs the recorded `f1dd13c6…`; payload bytes match 386/386 ⇒ **unpinned row order among
  `event_time` ties**. Someone must choose: re-order the corpus deterministically, or accept the 20
  cells as recorded-but-unreproducible. `research/studies/corpus-fingerprint-drift-2026-07-31.md`.
- **The book at 2026-08-01T06:10Z:** **40** closed round trips, net-of-cost **−$48.54**, LLM $22.04,
  window 8.47/14 days, `promotion_ready` 0, kill switch RUNNING. RSS holds inside WATCH-V3-1.
- **78% of spot orders were rejected for a week and nothing noticed** (binance 156/122 vs binanceusdm
  135/3). Fixed `f5abf8a`, **still unverified** — top banner and WATCH-V4-13.
- **THE PROMOTION GATE IS NOT REACHABLE ON THIS EDGE — arithmetic, not opinion.** 40 trips vs a floor of
  30, so **the WINDOW binds**: `windowStart` pins to 2026-07-23T18:00:26Z ⇒ 14 days cannot be met before
  **2026-08-06T18:00Z**, with net-of-cost crossing zero by then. Gross is negative, so **zero LLM spend
  cannot make it positive**; abstaining freezes the window AND bleeds. `success-exit-2026-07-31.md`.
- **Cost shape:** LLM runs AT the $3/day breaker. Only **5.4% of wakes consult**; of 205 consults in
  24h just 21 are the organic schedule — 116 `forced_move`, 48 `forced_fallback`. **The timing knobs,
  not the model, set the bill.** (WATCH-V4-10 CLOSED Pass 52 — see `watches.md`.)
- **`test:cov` is GREEN but `pnpm test`/`pnpm checks` still omit `--coverage`**, so the mandated 100%
  globs stay advisory (backlog 56); four branches are `v8 ignore`-annotated, two not pre-authorized.
- **Corpus v4 (587 rows) and OHLCV RESTORED Pass 54** — 26 symbols now run to 2026-07-31T20:45Z; rows
  scoreable **h=16 59.3% → 97.4%, h=54 → 90.6%**. Gitignored ⇒ a fresh clone re-fetches.
  `leaders_only`/`one_symbol_btc` are **structurally unscoreable** (3 and 1 clusters vs a floor of 5).
  **`arm-sweep-v1` closed the arm space Pass 55: `shorts_only` and `meanrev_pure` both 0 entries in
  30 rows — sizing-gate refusal, $0.92 of $18, no cell scored. 0/30 bounds the rate under ~10%, it is
  not a proven zero.**
- **NOTHING HERE CAN CURRENTLY BE SHOWN TO LEARN — the mechanism is DIVISION, not suppression.** Only
  v1 (n=28,k=13) and v2 (n=18,k=11) of eight live versions ever reached n≥12 AND k≥5, and they are the
  two oldest; 78 entries / 8 = 9.75 vs a bar of 12. **2026-07-24 was both the highest-volume day (24
  entries) and the heaviest minting day (four versions)** — ~6 per arm on the best day there has been.
  **OWNER DECISION OWED: daily minting and powered evidence are mutually exclusive**
  (`candidate-routing-override-2026-07-31.md` is a dated owner call — do not reopen it silently).
- **A decide-model A/B config gate shipped FLAG-OFF (`3958c8c`) and is NOT a working A/B.** `abArm` had
  **zero production call sites** before it; the arm is drawn **once per BOOT** (singleton client pins
  one model) so it stays sequential; and attribution journals every arm-B decide **as arm A**.
  **`AGENTIC_MODEL_AB_PCT` stays 0** until the latter two are closed.
- **UNREAD, and an unread check is not a passing one:** whether any of the 14 `agentic_active_menu`
  symbols is **pinned with no open position and no resting order** (a pin-set leak). Owed work.
- **THE SUCCESS/STOP CRITERIA ARE ADOPTED (owner, 2026-08-01: `1C, 2A, 3A, 4A`).** `success-exit`
  § 6/§ 7 now ENACT; window closes **2026-08-31**; S3's −$200 / $150 triggers are LIVE. **G1 re-cut to
  h = 16** — evaluable today (the clause's number is the floor `> +24.2`, which does not move with the
  horizon), but its FEASIBILITY figure is a **bound [+45.0, +92.6] @K=20, not a point**. Even that
  bound's floor is worse than h = 4's, so **h = 16 is never as defensible as h ∈ {1,4}**. **Q4 = A did
  NOT rebut § 10.** Amendment 1 at the top of the study.
- **S3 WILL LIKELY DECIDE THIS BEFORE THE WINDOW DOES.** −$48.54 over 8.47 window-days = −$5.73/day ⇒
  the −$200 trigger lands **~2026-08-27**, four days before the 08-31 close (LLM is ~49 days out). A
  pass seeing it fire records a triggered criterion and does NOT extend the window.
- **G5 SHIPPED** — `agentic_promotion_blocked{reason}`, zero-seeded over a closed **8**-member union
  (prose says seven; `NO_STATS_SOURCE` is an early-return branch it missed). Fails OPEN. **G4 IS A
  LIVE-FLIP BLOCKER:** `PassiveBenchmarkPort` has NO implementation anywhere, so it needs a basket
  choice — 40 symbols, 28 assets, or **exposure-matched to the realised ~50% (recommended)**. OWNER.
- **COLLISION #5.** A concurrent pass ran ~00:07Z, committed nothing, left `package.json` +
  `scripts/loop-authoring.mjs` + its spec modified. **NOT committed, NOT discarded** — its work looks
  right (`loop:authoring` gains `--env-file-if-exists=.env`, plausibly why it has NEVER minted;
  `temperature` dropped because this model family 400s on it). **A later pass should claim them.**
- **Last pass:** Pass 55, 2026-08-01 (`LOG.md`). Cadence 3×/day; take the lease before any edit and
  release it last. It is 2h and time-based: a pass spanning a host sleep finds its own lease expired.

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 53 |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | holds |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — the 19:00:30Z occurrence is transient and explained (two binance `STOP_LOSS_LIMIT` ACKs 19-28s prior); the alert's 5 firing samples are a `for: 0m` rule staying hot ~5 min after ONE event, not a sustained fault |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction | holds — zero ever |
| WATCH-V4-3 | a redeploy with a resting perp stop boots to RUNNING with no `perp pin:` line | holds |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds |
| WATCH-V4-7 | every digest carries an alerts-fired-and-resolved line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows | holds — standing check on the mint-time gates |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | answered once on the `ae5df10b` boot (`orphan_scan=16 readopt=4 cancel=0 cancel_failed=0`); re-seeded to 0 by the `f5abf8a` redeploy, so it needs one more flat perp bar to re-read |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:`; baseline 10 of 37 over 14 days | **FIRST READING Pass 53 — EXPECTED-POSITIVE CONFIRMED, defect outcome absent.** 7 rows this boot, min = max = 4096; `schema_rejected:` rows top out at 358. Disclosed: 4 of 11 rows over 14d carry NULL `output_tokens` (unreadable, not contradicted). **Do NOT raise `AGENTIC_MAX_TOKENS` in response — refuted** (the $3/day USD breaker binds, and a 12288 ceiling projects past the 75s batch HTTP budget, where an abort THROWS and 3 strikes auto-DRAIN the lane). In-contract lever is `output_config: {effort}`, absent from the client today |
| WATCH-V4-14 | a terminal-reject burst of ≥3 in 15m surfaces as a `prometheus_alert_firing_nonblocking` annotation naming `VenueTerminalRejectBurst` in the FIRST sweep after it, and agrees with the sweep's own rate alarm | **NEW Pass 53, UNFIRED.** Named defect outcomes: it fires on the 2/hour spot bleed (threshold mis-derived); or a burst occurs and it stays silent (`for: 5m` outliving a ~5m burst is the specific risk); or it lands as an ALARM, meaning severity drifted to `critical` and §3 is now wedgeable. **An unfired alert is not a passing one** — if nothing rejects by 2026-08-07, record it as UNTESTED |
| WATCH-V4-13 | on the FIRST spot entry after `f5abf8a`, `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments, `{venue="binance",event="placed"}` stays 0, and NO `InsufficientFunds` on a spot `reduce_only` SELL | **OPEN — re-read Pass 52, STILL VOID.** Zero `binance` rows in `order_intents` since the 09:27Z boot; all three intents are perp. Counters are healthy (every child present, zero-seeded), so the zeros are real — there is simply no spot activity. The pre-deploy stoppage is explained (the ZEC position dusted out), which credits nothing |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **OPEN, and now INSTRUMENTED (Pass 52).** `pnpm loop:forward-return`, surfaced every sweep. First reading v10 n=4/clusters=4 ⇒ UNDERPOWERED (bar: n≥12 AND clusters≥5). No divergence evaluated; point estimates are not quoted at rollup by design. A divergence EITHER way is a FINDING |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8, **V4-10 moved out Pass 54**) are kept in full in `watches.md` § Resolved — closed, not deleted; do not re-open one without new evidence.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 56 | Put `test:cov` on `pnpm checks` | 2 | S | NEW (Pass 51). `400c08e` fixed the symptom; the cause is that the mandated 100% globs never run on the green path, which is how five commits landed branches without tests. One line, once the four `v8 ignore` annotations are spot-checked |
| 57 | Measure how much recorded PnL is attributable to demo/live price decoupling | 1 | M | **NEW (Pass 53).** The divergence is episodic, not a standing offset (3 bps at one trip's entry, 21 bps at its partial exit, **572 bps** during the 13:0xZ stall), so "demo PnL is fictional" is NOT supported — but it is unmeasured across the 37 closed trips, and it conditions the whole promotion scoreboard. Worth more than any single fix in the incident note |

Rows **54** and **55** were completed in Pass 52 and moved in full to `charter.md` § Backlog closed
ledger (nothing deleted). Four rows (18, 44, 45, 47) were retired OBSOLETE on 2026-07-30 — answered by
evidence, not awaiting data. **Do not re-open one because its gate has cleared**; the gate is moot,
the question is answered. Full ledger and reasons: `charter.md` § Backlog and the Pass 48 entry.

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- **THE OWNER DECISION THIS PROGRAM TURNS ON — a live lane is accumulating evidence for a gate that
  CANNOT be passed, and that is arithmetic, not opinion.** An arm must post **+20.9/+26.4/+33.8/+81.4
  bps** at h=1/4/8/24; the bar is **CLUSTER-limited**, at h=1/4 **unreachable at ANY cluster count**,
  and h=8/24 need 64–219 clusters against a 40-symbol universe. **Three exits, and the "STOP with extra
  steps" objection is unrebutted: `research/studies/success-exit-2026-07-31.md`. It asks four questions.**
- **ONE `.env.app` edit remains hook-blocked** (a global PreToolUse hook blocks all `.env*` edits):
  `:153` still says spot rests a `STOP_LOSS_LIMIT` — FALSE since `f5abf8a`; text in `LOG.md` § Pass 51.
  **`:159` `AGENTIC_PLAYBOOK_AB_PCT=40` NEEDS NO EDIT and must NOT be zeroed** — the owner overrode
  Pass 51 in favour of daily minting, so a pass that tidies the dead-looking knob silently cancels the
  decision (`research/studies/candidate-routing-override-2026-07-31.md`). Next mint is v12.
- **Both provider accounts** — Anthropic funded 2026-07-30, Moonshot presumed suspended. Recurs
  whenever the balance runs out; read `agent_client_latch_cause`, do not investigate.
- **Two scheduled passes have run concurrently in one tree** — four occurrences, one with production
  blast radius. `pnpm loop:lock` binds only passes that call it; the co-firing scheduler is
  owner-owned.
- **Shared-org rate limit** — app and interactive sessions share ONE Anthropic org budget; a
  dedicated key/org is owner-side. The CryptoPanic key (X4 sentiment enable) is also still open.
- **Availability** — the stack runs on the owner's MacBook; host sleep throttles everything (worst
  measured 8%/24h duty cycle). Pass 50 itself spanned a ~7.5h sleep.
- **6.9-LINK wallet scar (~$55)** — historical unapplied recovered-order fill, journaled and deduped so no walk sees it post-epoch; a venue-side manual sell is optional wallet hygiene only.

## Index — every loop file, and when to read it

| file | read it when |
| --- | --- |
| `STATUS.md` (this file) | always, first, at the start of every pass |
| `charter.md` | deciding whether a change is loop-domain or needs the owner; before firing a pre-authorization; before disputing a settled decision |
| `verdicts.md` | before proposing work in an area it covers — the entry signal, exit rules, cost levers, decide-model choice, price TA, non-price channels, the promotion benchmark, the live playbook lineage |
| `watches.md` | checking a WATCH's exact expected-positive or named defect outcome; reading an open flagged item in full |
| `LOG.md` | appending this pass's entry (newest last); reading the last five passes |
| `archive/state-2026-07-30.md` | a line here or in `watches.md` points there for the record behind it — v3 build/cutover, soak defects, per-pass decision records |
| `archive/LOG-through-pass-47.md` | a pass entry older than the five kept in `LOG.md` — now **Pass 0 → Pass 47** (Pass 50 rotated 46 and 47 out, appended at the end) |
| `state.md` | never for content — a stub kept because commit messages, `docs/runbook.md` and the scheduled task reference the path by name |
| `digests/` | `loop:sweep` writes its digest here; rehydration reads the newest |
| `incidents/` | a named incident note written by an earlier pass |

**Maintenance rule (playbook §6 — a one-off compaction just re-grows).** Each pass appends to `LOG.md` and updates THIS file; past five entries the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`.
**Nothing is ever deleted from a loop file — only moved, with a pointer left behind.** Outgrown a few lines?
Move the body out. (P53: backlog 54/55 → `charter.md`, promtool trap → playbook §5. P54: WATCH-V4-10 → `watches.md`.)
