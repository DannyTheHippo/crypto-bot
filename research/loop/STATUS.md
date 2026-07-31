<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 53,
2026-07-31**. Hard cap 200 lines — anything longer belongs in the file that owns it, with a pointer here.

## ⚠ `loop:sweep` REPORTS Alarms (2). ONE IS EXPECTED, ONE IS A REAL DEFECT WITH A NAMED BLOCKER

> **`venue_reject_rate_high [binance]` — 16/20 = 80.0%. EXPECTED. Do not investigate, do not tune.**
> Every one of those 20 submits predates the `f5abf8a` fix (window 2026-07-30T18:15Z → 07-31T01:45Z);
> all 16 rejects are one `reduce_only SELL ZEC/USDT` retrying every 30 min. It clears by itself once
> 20 clean spot submits accumulate, or degrades to `venue_reject_rate_undetermined` when the 7-day
> bound ages the window below the floor. **Do not lower the threshold** — derived from binanceusdm's
> 4/186 baseline (Wilson 99.9% upper bound 8.45%) and pinned by a spec. Same unverified fix
> `WATCH-V4-13` tracks; both resolve on the first real spot entry.
>
> **`venue_reject_rate_high [binanceusdm]` — 12/20 = 60.0%. REAL, root-caused Pass 53, REPAIR NOT
> SHIPPED.** 12 reduce-only KAITO exits terminal-rejected `-4024` in five minutes, and the position
> then carried **no stop for 45 minutes**. Cause is a frame mismatch: `FEED_ENV=live` prices orders
> the `SANDBOX_ENV=demo` venue executes, and `-4024` is the demo venue's `PERCENT_PRICE` floor
> (its own mark × 0.95) — which sat ABOVE our ref on all 12 attempts. **The obvious fix was REFUTED**
> (retaining the plan-stop registry row re-arms nothing and breaks `orphan_readopt`); the correct
> seams need the margin/base-lock rationale at `agentic.strategy.ts:1434-1438` resolved first.
> Forensics, exact diffs and the refutation: `incidents/2026-07-31-perp-exit-band-rejects.md`.

## ⚠ TWO LIVE BEHAVIOUR CHANGES SHIPPED 2026-07-30, AND NEITHER MAY BE CREDITED ALONE

> **1. `inverted` is the live playbook (v10)** since the 16:57:19Z boot — a **RESEARCH-BAR FAIL
> shipped on DEPLOYMENT-BAR grounds**, h=24 CI lower bound **−12.2**. **Never quote +47.6 as an edge.**
> Four horizon figures and the maker-fill caveat: `verdicts.md`; `watches.md` § WATCH-PLAYBOOK-V10-1.
>
> **2. `AGENTIC_PLAN_AUTHORITATIVE_EXITS=true`** (`.env.app:261`, same boot) — positions exit only via
> declared stop / TP / maxHold. **BASELINE FOR THE NEXT MEASUREMENT: −108.1 bps/trip at 17.4% hit;**
> revert if positions storm to `max_hold` worse than that. Fails toward EXITING.
> `watches.md` § WATCH-PLAN-AUTHORITY-1.
>
> **3. THE ATTRIBUTION LIMIT — read before writing any result.** Both are live simultaneously with no
> control arm. Their EVIDENCE is separable; **their realised-PnL contributions are NOT. No pass may
> claim either one moved the book on its own.**

## The LLM lane — FUNDED AND TRADING; do not investigate a latch

> The 60-hour outage ended 2026-07-30T09:01Z; the lane self-healed with no redeploy. **Only Anthropic
> was funded** — Moonshot untested since, presumed suspended. **759 real model decides lifetime**
> (Pass 53). Owner directive 2026-07-30, verbatim: *"lack of trading is because of the anthropic api
> account being unfunded. this should not have to turn into investigations on each pass."* So: **if a
> sweep shows a latched client, read the CAUSE, do not investigate.**
> `agent_client_latch_cause{cause="insufficient_credit"} == 1` means the balance is out — an owner
> capability limit. Cause-specific and fails CLOSED: any other cause is `other`, keeps
> `AgentClientFatalLatch` at `critical`, and IS a full incident.
> **Funding does not make resumed trading unambiguously good** — entries measure significantly
> negative and worse than a random-bar placebo. Owner call, § Flagged.

## Current order & status

- **Live build `35042cc`** (`build_info{git_sha}` confirmed), boot **2026-07-31T16:52:51.674Z**,
  bootId `4753ef53`, `RestartCount` 0, healthy. **23** Prometheus rules loaded (was 22), 0 unhealthy,
  0 firing — Prometheus WAS force-recreated this pass because `alerts.rules.yml` changed. HEAD
  (`7d2e1d2`) is one records-only commit ahead: **zero runtime delta, no deploy due.** The redeploy
  re-seeds the `agentic_venue_stop_total` counters WATCH-V4-11 and V4-13 read — note that provenance.
- **Pass 53 was a DEFECT INVESTIGATION forced by §3** (two alarms). It shipped the visibility fixes,
  NOT the `-4024` repair — see the banner above for the blocker. Three commits: the
  `VenueTerminalRejectBurst` alert (WATCH-V4-14), the reconcile skip-log demotion (214 warns/3.6h that
  the counter beside it already carried), and the sweep's pass-coverage audit un-blanked. Detail:
  `LOG.md` § Pass 53.
- **`loop:authoring` HAS NEVER MINTED — 0 `playbook-authoring-attempt` rows lifetime** — because the
  registry gate `633f901` (Pass 52) made it impossible. **That fix is therefore UNVERIFIED**, today's
  authoring slot is **UNSPENT**, and `WATCH-DEPLOY-HALVES-1` sits at SAMPLE ZERO for the same reason.
  **Running it is the highest-value single action available to the next pass.**
- **A promtool trap:** checking `/etc/prometheus/alerts.rules.yml` inside the container after a
  host-side edit is VOID (dangling inode; reads like corruption, is not). Recipe now in playbook §5.3.
- **THE BAR THIS PROGRAM GATES ON WAS NEVER DERIVED.** +13.0/+24.2 enter the repo fully formed in
  `7b3e977` with no operands, and every later citation is circular. **Measured demo cost is 9.29
  bps/round trip.** No verdict moves (the gap is 111–126, not 115–130) but the h=1 inversion bullet's
  arithmetic changed — amended in `verdicts.md`. `research/studies/fee-floor-derivation-2026-07-31.md`.
- **FAMILY B IS BLOCKED, and not for scheduling reasons.** `assertDesignMatchesCorpus` fails CLOSED;
  the on-disk corpus hashes `030367ba…` against the `f1dd13c6…` every artifact records, and payload
  bytes match the live DB 386/386 ⇒ **unpinned row order among `event_time` ties**. NOT re-pinned:
  someone must choose between a deterministically re-ordered corpus and accepting the 20 cells as
  recorded-but-unreproducible. `research/studies/corpus-fingerprint-drift-2026-07-31.md`.
- **The book at 17:05Z:** **37** closed round trips (was 35), net-of-cost **−$40.7534** (was
  −$42.3358), LLM cost $20.598, trade-anchored window 7.891 of 14 days, win rate 27.03%,
  `agentic_promotion_ready` 0, `equity_usdt` 4981.69, kill switch RUNNING. Two trips closed since Pass
  52 and net-of-cost improved $1.58. **RSS 752 MiB at 3.6h into the previous boot — DOWN from Pass
  52's 763 MiB**, so WATCH-V3-1 holds and the "highest recorded, watch it" note is retired.
- **78% of spot orders were rejected for a week and nothing noticed** (binance 156/122 vs binanceusdm
  135/3; both protective legs sized 100% with `reduceOnly` dropped on spot). Fixed `f5abf8a`, **still
  unverified** — top banner and WATCH-V4-13.
- **THE PROMOTION GATE IS NOT REACHABLE ON THIS EDGE — arithmetic, not opinion.** Trips **37** vs a
  floor of 30, so **the WINDOW binds, not the count**: `windowStart` pins to 2026-07-23T18:00:26Z, so
  14 days cannot be met before **2026-08-06T18:00Z** whatever happens, and net-of-cost must cross zero
  by then (**+5.5% to +6.2% on the $1000 book** against a trailing −$0.72/trip). Gross trading is
  negative, so **zero LLM spend still cannot make it positive**, and NEITHER DIRECTION REACHES IT —
  `netPnl` burns cost on wall-clock while `windowDays` advances only on closes, so abstaining freezes
  the window AND bleeds. `LOG.md` § Pass 51; `research/studies/success-exit-2026-07-31.md`.
- **Cost shape:** LLM runs AT the $3/day breaker (±2%, not a boot artifact). Only **5.4% of wakes
  consult**, and of 205 consults in 24h just 21 are the organic schedule — 116 `forced_move`, 48
  `forced_fallback`. **The timing knobs, not the model, set the bill.** (WATCH-V4-10 CLOSED Pass 52 —
  breach real, recorded root cause wrong; see the WATCH table and `watches.md`.)
- **`test:cov` is GREEN (`400c08e`; Pass 52: 94.22/88.05/92.82/95.61 vs 90/85/90/90) but the
  STRUCTURAL cause is untouched — `pnpm test` and `pnpm checks` still omit `--coverage`**, so the
  mandated 100% globs stay advisory and the same six-day regression can recur (backlog 56). Four
  branches are `/* v8 ignore next */`-annotated rather than tested, two not pre-authorized —
  spot-check their reachability arguments. Detail: `LOG.md` § Pass 51.
- **Truncated OHLCV caches are NOT restored** (cause corrected in `279713e`: the unconditional write
  plus a tf-less funding filename, not the `targetBars=200` default two passes blamed). Both globs are
  gitignored ⇒ restore by re-fetch: `<SYM>/USDT:USDT 1h 26000 --funding` for BTC/ETH/SOL/XRP, 70080
  bars for the three spot 15m series.
- **UNREAD, and an unread check is not a passing one:** whether any of the 14 `agentic_active_menu`
  symbols is **pinned with no open position and no resting order** (a pin-set leak, which would be a
  defect). Pass 53's fourth investigator died on its output contract before answering. Owed work.
- **Last pass:** Pass 53, 2026-07-31 (`LOG.md`). Cadence 3×/day; take the pass lease before any edit
  (playbook §1 step 3) and release it last (§6 step 5). The lease is 2h and time-based: a pass that
  spans a host sleep will find its own lease expired and may break it.

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
| WATCH-V4-10 | no perp algo stop stays `ACKED` more than one 15m bar after its position goes flat | **CLOSED Pass 52 — breach real, RECORDED ROOT CAUSE WRONG.** Venue truth: `REJECTED` / "Reduce only reject", fired 4m08s after flat, no spawned order, no fill. Cause was `REJECTED` normalizing to `UNKNOWN` (the one status `recoverIntent` never folds), NOT the boot-recovery exclusion — reconciliation axis 1 is regular-rail by construction. Full text + two residual strands: `watches.md` |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | answered once on the `ae5df10b` boot (`orphan_scan=16 readopt=4 cancel=0 cancel_failed=0`); re-seeded to 0 by the `f5abf8a` redeploy, so it needs one more flat perp bar to re-read |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:`; baseline 10 of 37 over 14 days | **FIRST READING Pass 53 — EXPECTED-POSITIVE CONFIRMED, defect outcome absent.** 7 rows this boot, min = max = 4096; `schema_rejected:` rows top out at 358. Disclosed: 4 of 11 rows over 14d carry NULL `output_tokens` (unreadable, not contradicted). **Do NOT raise `AGENTIC_MAX_TOKENS` in response — refuted** (the $3/day USD breaker binds, and a 12288 ceiling projects past the 75s batch HTTP budget, where an abort THROWS and 3 strikes auto-DRAIN the lane). In-contract lever is `output_config: {effort}`, absent from the client today |
| WATCH-V4-14 | a terminal-reject burst of ≥3 in 15m surfaces as a `prometheus_alert_firing_nonblocking` annotation naming `VenueTerminalRejectBurst` in the FIRST sweep after it, and agrees with the sweep's own rate alarm | **NEW Pass 53, UNFIRED.** Named defect outcomes: it fires on the 2/hour spot bleed (threshold mis-derived); or a burst occurs and it stays silent (`for: 5m` outliving a ~5m burst is the specific risk); or it lands as an ALARM, meaning severity drifted to `critical` and §3 is now wedgeable. **An unfired alert is not a passing one** — if nothing rejects by 2026-08-07, record it as UNTESTED |
| WATCH-V4-13 | on the FIRST spot entry after `f5abf8a`, `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments, `{venue="binance",event="placed"}` stays 0, and NO `InsufficientFunds` on a spot `reduce_only` SELL | **OPEN — re-read Pass 52, STILL VOID.** Zero `binance` rows in `order_intents` since the 09:27Z boot; all three intents are perp. Counters are healthy (every child present, zero-seeded), so the zeros are real — there is simply no spot activity. The pre-deploy stoppage is explained (the ZEC position dusted out), which credits nothing |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **OPEN, and now INSTRUMENTED (Pass 52).** `pnpm loop:forward-return`, surfaced every sweep. First reading v10 n=4/clusters=4 ⇒ UNDERPOWERED (bar: n≥12 AND clusters≥5). No divergence evaluated; point estimates are not quoted at rollup by design. A divergence EITHER way is a FINDING |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8) are kept in full in `watches.md` § Resolved — closed, not deleted; do not re-open one without new evidence.

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

**Maintenance rule (playbook §6 — a one-off compaction just re-grows).** Each pass appends to `LOG.md` and
updates THIS file; past five entries the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`.
**Nothing is ever deleted from any loop file — only moved, with a pointer left behind.** Outgrown a few
lines? Move the body out. (Pass 53 moved backlog 54/55 → `charter.md`, the promtool trap → playbook §5.)
