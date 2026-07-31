<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 52,
2026-07-31**. Keep this under 200 lines: anything that grows past a few lines belongs in one of the
files below, with a one-line pointer here.

## ⚠ `loop:sweep` REPORTS Alarms (1) AND THAT IS THE EXPECTED STATE — DO NOT INVESTIGATE, DO NOT TUNE

> `venue_reject_rate_high [binance]` — 16/20 = 80.0% of the most recent spot submits were rejected.
> **This is a TRUE finding, not a regression and not a false positive.** Every one of those 20
> submits predates the `f5abf8a` fix (window 2026-07-30T18:15Z → 07-31T01:45Z); all 16 rejects are
> one `reduce_only SELL ZEC/USDT` retrying every 30 min. The alarm is correctly refusing to call an
> unrefuted 80% clean.
>
> **It clears by itself** once 20 clean spot submits accumulate, or degrades to the
> `venue_reject_rate_undetermined` annotation when the 7-day recency bound ages the window below the
> floor. **Do not lower the threshold to silence it** — it was derived from binanceusdm's measured
> 4/186 baseline (Wilson 99.9% upper bound 8.45%) and is pinned by a spec. This is the same
> unverified fix `WATCH-V4-13` tracks; both resolve on the first real spot entry.

## ⚠ TWO LIVE BEHAVIOUR CHANGES SHIPPED 2026-07-30, AND NEITHER MAY BE CREDITED ALONE

> **1. `inverted` is the live playbook (v10)**, `agentic_playbook_info{version="10"}` since the
> 16:57:19Z boot. It is a **RESEARCH-BAR FAIL shipped on DEPLOYMENT-BAR grounds**: it beats
> `champion_v8` at all four horizons but its h=24 CI lower bound is **−12.2**. **Never quote +47.6 as
> an edge.** In-sample, one 6.35-day regime, and adverse selection may not invert — entries were
> maker-side at 76% fill, which offline replay structurally cannot measure. Full text and the four
> horizon figures: `verdicts.md`; `watches.md` § WATCH-PLAYBOOK-V10-1.
>
> **2. `AGENTIC_PLAN_AUTHORITATIVE_EXITS=true`** (`.env.app:261`, same boot) — the model's `close` is
> suppressed while a declared plan is live; positions exit only via declared stop / TP / maxHold.
> **BASELINE FOR THE NEXT MEASUREMENT: −108.1 bps/trip at 17.4% hit.** Revert if positions storm to
> `max_hold` worse than that. The gate fails toward EXITING. `watches.md` § WATCH-PLAN-AUTHORITY-1.
>
> **3. THE ATTRIBUTION LIMIT — read before writing any result.** Both are live simultaneously with no
> control arm. Their EVIDENCE is separable; **their realised-PnL contributions are NOT. No pass may
> claim either one moved the book on its own.**

## The LLM lane — FUNDED AND TRADING; do not investigate a latch

> The 60-hour outage ended 2026-07-30T09:01Z; the lane self-healed with no redeploy. **Only Anthropic
> was funded** — Moonshot untested since, presumed suspended. 728 real model decides lifetime.
>
> **The standing rule survives the good news: the condition recurs the moment the balance runs out.**
> Owner directive 2026-07-30, verbatim: _"lack of trading is because of the anthropic api account
> being unfunded. this should not have to turn into investigations on each pass."_ So: **if a sweep
> shows a latched client, read the CAUSE, do not investigate.**
> `agent_client_latch_cause{cause="insufficient_credit"} == 1` means the balance is out — an owner
> capability limit. Cause-specific and fails CLOSED: any other cause is `other`, keeps
> `AgentClientFatalLatch` at `critical`, and IS a full incident.
> **Funding does not make resumed trading unambiguously good** — entries measure significantly
> negative and worse than a random-bar placebo. Owner call, § Flagged.

## Current order & status

- **Live build `f5abf8a`** (`build_info{git_sha}` confirmed on the running process), boot started
  **2026-07-31T09:27:23.922Z**, bootId `58e3ee87`, `RestartCount` 0, healthy. 22 Prometheus rules, 0
  firing. No alert-rules change this pass, so no `--force-recreate prometheus` was needed.
- **HEAD `fd4e389` is seven commits ahead of live `f5abf8a` — A DEPLOY IS DUE.** Unlike Pass 51's
  zero-runtime-delta gap, Pass 52 changed runtime code (`ccxt-normalize`, `algo-stop-recovery`,
  `counterfactual-scoring`, `ports/venue/exchange`). Redeploy re-seeds the `agentic_venue_stop_total`
  counters WATCH-V4-11 and V4-13 read — factor that into their provenance afterwards.
- **Pass 52 shipped seven commits, and unlike the previous three passes it is NOT only defect
  repair.** Three instruments the loop never had (`f60c79a`): `loop:forward-return` (closes
  WATCH-PLAYBOOK-V10-1's instrument gap), a per-venue reject alarm (backlog 55), an off-gate harness
  monitor (backlog 54). Plus the halves clause + once-per-UTC-day authoring ceiling (`0ee5947`), the
  registry gate that made `loop:authoring` unable to EVER mint (`633f901`), a REJECTED algo stop
  normalizing to UNKNOWN (`c3a7253`), forward return walking array indices across the outage
  (`df58436`), the 2026-07-10 incident config still in CI (`b28e54b`), six records (`bc8269b`).
  Detail: `LOG.md` § Pass 52.
- **THE BAR THIS PROGRAM GATES ON WAS NEVER DERIVED.** +13.0/+24.2 enter the repo fully formed in
  `7b3e977` with no operands, and every later citation is circular. **Measured demo cost is 9.29
  bps/round trip.** No verdict moves (the gap is 111–126, not 115–130) but the h=1 inversion bullet's
  arithmetic changed — amended in `verdicts.md`. `research/studies/fee-floor-derivation-2026-07-31.md`.
- **FAMILY B IS BLOCKED, and not for scheduling reasons.** `assertDesignMatchesCorpus` fails CLOSED
  and the on-disk corpus hashes `030367ba…` against the `f1dd13c6…` every artifact records. Payload
  bytes match the live DB 386/386 ⇒ the cause is **unpinned row order among `event_time` ties**. NOT
  re-pinned: someone must choose between a deterministically re-ordered corpus and accepting the 20
  cells as recorded-but-unreproducible. `research/studies/corpus-fingerprint-drift-2026-07-31.md`.
- **The book at 09:52Z:** **35** closed round trips (was 34), net-of-cost **−$42.3358** (was
  −$44.2755), LLM cost $19.41, trade-anchored window 7.329 of 14 days, `agentic_promotion_ready` 0,
  `equity_usdt` 4978.33, kill switch RUNNING. One trip closed during the soak, a winner (+$1.94
  realised). RSS 763 MiB — inside WATCH-V3-1 but the highest recorded; watch it.
- **78% of spot orders were rejected for a week and nothing noticed** (binance 156/122 vs binanceusdm
  135/3; both protective legs sized to 100% with `reduceOnly` dropped on spot). Fixed `f5abf8a`,
  **still unverified** — see the top banner and WATCH-V4-13.
- **THE PROMOTION GATE IS NOT REACHABLE ON THIS EDGE — arithmetic, not opinion.** Trips 35 vs a floor
  of 30, so **the WINDOW binds, not the count**: `windowStart` pins to the first closed trip
  2026-07-23T18:00:26Z, so 14 days cannot be met before **2026-08-06T18:00Z** whatever happens, and
  net-of-cost must cross zero by then — **+5.5% to +6.2% on the $1000 book** against a trailing
  −$0.72/trip. Gross trading is negative (−$24.86), so **zero LLM spend still cannot make it
  positive.** NEITHER DIRECTION REACHES IT: `netPnl` burns LLM cost on wall-clock while `windowDays`
  advances only on closes, so abstaining freezes the window AND bleeds. Method: `LOG.md` § Pass 51;
  reachability and the three exits: `research/studies/success-exit-2026-07-31.md`.
- **Cost shape:** LLM runs AT the $3/day breaker (±2%, not a boot artifact). Only **5.4% of wakes
  consult**, and of 205 consults in 24h just 21 are the organic schedule — 116 `forced_move`, 48
  `forced_fallback`. **The timing knobs, not the model, set the bill.**
- **WATCH-V4-10 CLOSED Pass 52** — the venue-truth read happened and the recorded root cause was
  wrong. WATCH table below; full text in `watches.md`.
- **`test:cov` is GREEN (`400c08e`; re-measured Pass 52 at 94.22/88.05/92.82/95.61 vs 90/85/90/90),
  but the STRUCTURAL cause is untouched: `pnpm test` and `pnpm checks` still omit `--coverage`**, so
  the mandated 100% globs stay advisory on the green path and the same six-day regression can land
  again. Putting `test:cov` on `pnpm checks` is the standing candidate. Four branches are
  `/* v8 ignore next */`-annotated rather than tested, two of them not pre-authorized — spot-check
  their reachability arguments rather than trusting them. Detail: `LOG.md` § Pass 51.
- **Truncated OHLCV caches are NOT restored** (cause corrected in `279713e`: the unconditional write
  plus a tf-less funding filename, not the `targetBars=200` default two passes blamed). Both globs
  are gitignored ⇒ restoration is a re-fetch: `<SYM>/USDT:USDT 1h 26000 --funding` for
  BTC/ETH/SOL/XRP, 70080 bars for the three spot 15m series.
- **Last pass:** Pass 52, 2026-07-31 (`LOG.md`). Cadence 3×/day; take the pass lease before any edit
  (playbook §1 step 3) and release it last (§6 step 5). The lease is 2h and time-based: a pass that
  spans a host sleep will find its own lease expired and may break it.

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 51 |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | holds |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — the 19:00:30Z occurrence is transient and explained (two binance `STOP_LOSS_LIMIT` ACKs 19-28s prior); the alert's 5 firing samples are a `for: 0m` rule staying hot ~5 min after ONE event, not a sustained fault |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction | holds — zero ever |
| WATCH-V4-3 | a redeploy with a resting perp stop boots to RUNNING with no `perp pin:` line | holds |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds |
| WATCH-V4-7 | every digest carries an alerts-fired-and-resolved line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows | holds — standing check on the mint-time gates |
| WATCH-V4-10 | no perp algo stop stays `ACKED` more than one 15m bar after its position goes flat | **CLOSED Pass 52 — breach real, RECORDED ROOT CAUSE WRONG.** Venue truth: `REJECTED` / "Reduce only reject", fired 4m08s after flat, no spawned order, no fill. Cause was `REJECTED` normalizing to `UNKNOWN` (the one status `recoverIntent` never folds), NOT the boot-recovery exclusion — reconciliation axis 1 is regular-rail by construction. Full text + two residual strands: `watches.md` |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | answered once on the `ae5df10b` boot (`orphan_scan=16 readopt=4 cancel=0 cancel_failed=0`); re-seeded to 0 by the `f5abf8a` redeploy, so it needs one more flat perp bar to re-read |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:`; baseline 10 of 37 over 14 days | **still unread** — two redeploys since it shipped; no reading taken yet |
| WATCH-V4-13 | on the FIRST spot entry after `f5abf8a`, `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments, `{venue="binance",event="placed"}` stays 0, and NO `InsufficientFunds` on a spot `reduce_only` SELL | **OPEN — re-read Pass 52, STILL VOID.** Zero `binance` rows in `order_intents` since the 09:27Z boot; all three intents are perp. Counters are healthy (every child present, zero-seeded), so the zeros are real — there is simply no spot activity. The pre-deploy stoppage is explained (the ZEC position dusted out), which credits nothing |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **OPEN, and now INSTRUMENTED (Pass 52).** `pnpm loop:forward-return`, surfaced every sweep. First reading v10 n=4/clusters=4 ⇒ UNDERPOWERED (bar: n≥12 AND clusters≥5). No divergence evaluated; point estimates are not quoted at rollup by design. A divergence EITHER way is a FINDING |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8) are kept in full in `watches.md` § Resolved —
closed, not deleted; do not re-open one without new evidence.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 54 | Put the off-gate harnesses on a run whose failure `loop:sweep` surfaces | 2 | S | **DONE Pass 52** (`f60c79a`) — `pnpm loop:harness` writes an artifact, the sweep reads it. Fails OPEN, but `harness_stale` / `harness_never_run` / `harness_result_unreadable` are each named, so silence-equals-clean is unavailable |
| 55 | Alarm on venue order-reject rate by venue in `loop:sweep` | 2 | S | **DONE Pass 52** (`f60c79a`) — 20% threshold derived from binanceusdm's 4/186 baseline (Wilson 99.9% upper bound 8.45%), floor n≥6, last-20-submits window bounded to 7 days. Fails CLOSED. **Fires at HEAD on a true finding — see the banner at the top; do not tune it** |
| 56 | Put `test:cov` on `pnpm checks` | 2 | S | NEW (Pass 51). `400c08e` fixed the symptom; the cause is that the mandated 100% globs never run on the green path, which is how five commits landed branches without tests. One line, once the four `v8 ignore` annotations are spot-checked |

Four rows (18, 44, 45, 47) were retired OBSOLETE on 2026-07-30 — answered by evidence, not awaiting
data. **Do not re-open one because its gate has cleared**; the gate is moot, the question is
answered. Full ledger and reasons: `charter.md` § Backlog and the Pass 48 entry.

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- **THE OWNER DECISION THIS PROGRAM NOW TURNS ON — a live lane is accumulating evidence for a gate
  that CANNOT be passed, and Pass 52 made that arithmetic rather than opinion.** An arm must post
  **+20.9 / +26.4 / +33.8 / +81.4 bps** at h=1/4/8/24. **CORRECTED: the bar is CLUSTER-limited, not
  n-limited** (the bootstrap resamples symbols) — and at **h=1/4 it is unreachable at ANY cluster
  count**, because the best mean ever observed sits below the fee floor and `mean > floor` is α-free
  and n-free. h=8/24 need **64–219 clusters against a 40-symbol universe**. Under the live +24.2
  floor, no horizon is rescuable. Thirty more days costs ~13% of the $1000 book to buy precision on a
  sign that is not in doubt. **Three exits, and the objection that this is "STOP with extra steps" is
  carried unrebutted: `research/studies/success-exit-2026-07-31.md`. It asks four questions.**
- **ONE `.env.app` edit remains hook-blocked** (a global PreToolUse hook blocks all `.env*` edits and
  passes run unattended): `:153` still says spot rests a `STOP_LOSS_LIMIT` — FALSE since `f5abf8a`;
  replacement text in `LOG.md` § Pass 51 § Flagged. **`:159` `AGENTIC_PLAYBOOK_AB_PCT=40` NEEDS NO
  EDIT and must NOT be zeroed** — the owner overrode Pass 51's "set it to 0, withhold v12" on
  2026-07-31 in favour of daily minting, so the 40 is now load-bearing and a pass that tidies the
  dead-looking knob silently cancels the decision (`research/studies/candidate-routing-override-2026-07-31.md`).
  `maxVersion()` is 11, so the next mint is v12.
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

**Maintenance rule (playbook §6, the actual fix — a one-off compaction just re-grows).** Each pass
appends to `LOG.md` and updates THIS file; past five entries the oldest rotates VERBATIM to
`archive/LOG-through-pass-47.md`, appended chronologically. Nothing is ever deleted from any loop
file — only moved, with a pointer left behind. If a STATUS section outgrows a few lines, move the
body to the file that owns it and leave the one-liner.
