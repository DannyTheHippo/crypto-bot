<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 48,
2026-07-30**. Keep this under 200 lines: anything that grows past a few lines belongs in one of the
files below, with a one-line pointer here.

## The LLM lane — FUNDED AND TRADING AGAIN as of 2026-07-30T09:01Z; do not investigate a latch

> ## ✅ THE ACCOUNT WAS FUNDED MID-PASS ON 2026-07-30 — THE LANE IS ALIVE
>
> **The 60-hour outage is OVER.** Credit landed between 07:45Z (Pass 48 confirmed the `400` live at
> 07:45:18Z) and 09:01Z, and **the lane self-healed with no redeploy** — first real decide
> 2026-07-30T09:01:01Z (45.6s, full thesis), first proposes 09:15:31Z (`open_long` ZEC spot + perp).
> Measured at 11:04Z: **597 lifetime real decides** (575 before), 6 fills in 24h, `open_orders` 3 per
> venue, `agentic_budget_remaining_usd` $2.40 of $3. **This closes the one clause of WATCH-V4-5 that
> could not be tested without credit** — the funded-resumption path is now proven live, not inferred.
>
> **The standing rule survives the good news, because the condition can recur the moment the balance
> runs out again.** Owner directive, 2026-07-30, verbatim: _"lack of trading is because of the
> anthropic api account being unfunded. this should not have to turn into investigations on each pass.
> make it clear in state or log so that later loop passes do not investigate it; they should be able to
> tell immediately."_
>
> **So: if a future sweep shows a latched client, read the CAUSE, do not open an investigation.**
> `agent_client_latch_cause{cause="insufficient_credit"} == 1` means the balance is out again — an
> owner capability limit, not a defect, and no pass can fix it. `loop:sweep` prints a banner naming it
> ABOVE the alarms section, and `AgentClientLatchedUnfundedAccount` is severity `warning` on purpose so
> it annotates instead of wedging playbook §3. **The demotion is cause-specific and fails CLOSED:** any
> other cause classifies as `other`, keeps `AgentClientFatalLatch` at `critical`, and IS a full
> incident. Passes 42–47 each re-derived the blocker from scratch — that is the waste this exists to end.
>
> **Before treating resumed trading as unambiguously good, read `verdicts.md`.** Entries measure
> significantly negative and worse than a random-bar placebo, so a live lane spends ~$2.6/day
> accumulating evidence for a gate the present signal provably cannot pass. Pass 48's research
> recommends funding the frozen 12-arm playbook-space replay study (~$110, pre-registered, decisive in
> both directions) rather than the trading lane. That is an owner call, not a loop call.

## Current order & status

- **HEAD = live build `e091ba5`**, boot `4a43ac63` (deployed 2026-07-30T11:02:19Z, `RestartCount` 0,
  healthy). Prometheus force-recreated the same deploy: **23 rules loaded, 0 firing**. Post-deploy
  sweep at 11:04Z: **0 alarms**.
- **Pass 48 (2026-07-30) shipped four commits.** `8002888` — agent-client latch-cause split, so an
  unfunded account annotates instead of forcing an investigation every pass;
  `a03b35d` — seeded `reconciliation_runs_total` and narrowed `ReconcilerStalled`, **the two critical
  alerts guarding hard rule 6, neither of which could fire**; `e1ce4e1` — the loop hot/cold state
  split that created this file (rehydration 1,932 → 152 lines); `e091ba5` — seven more instruments
  whose zero was a void read, plus two loop-sweep honesty fixes.
- **Verified live post-deploy:** `build_info{git_sha="e091ba5"}`, `kill_switch_state{state="RUNNING"}`,
  and every seeded child publishing a true zero — including
  `reconciliation_runs_total{result="halt"}` on BOTH venues, which is the whole point of `a03b35d`.
- **Soaking a deploy: the first ~2h after a redeploy is a blind window for the LLM lane.**
  `AGENTIC_FALLBACK_CONSULT_BARS=8` at 15m bars means the first consult attempt is ~2h out, so the
  playbook's 15-30 min soak sits entirely inside it. Judge lane liveness from
  `agent_last_success_timestamp_seconds` (seeded at boot from `agent_decisions` since `446e1da`, so it
  reads the TRUE age on a fresh boot), never from `agent_client_latched` reading 0 on a boot too young
  to have tried. WATCH-V4-8, `watches.md`.
- **The book, re-derived from metrics at 11:04Z — and it MOVED for the first time since 07-27:**
  **29** closed round trips (was 28), net-of-cost **−$41.1723** (was −$39.6370, so **$1.54 worse**),
  win rate **0.1724**, LLM cost **$16.7940**, trade-anchored window **6.71 of the 14 days** required
  (was 4.30), `agentic_promotion_ready` **0**, 6 fills in 24h, `open_orders` **3 per venue** (was 0 —
  the lane is placing protective stops again), `equity_usdt` **4976.88**, RSS **717 MiB**
  (WATCH-V3-1 fine). Champion playbook **v8** active.
- **Read the direction, not just the motion:** the window advanced 2.4 days and the book got $1.54
  worse over one closed trip. That is exactly what `verdicts.md` predicts — the gate needs ≥30 trips
  AND positive net-of-cost, and every additional trip on the present entry signal moves the first
  number toward the bar while moving the second away from it.
- **Playbook lineage:** champion **v8** (+$6.77 over 5 trips — the only meaningfully positive
  lineage; v2 alone is −$24.76 over 14 and accounts for most of the book's loss; n=5 is far under
  this loop's own "never act on a sub-n≥12 cell" bar, so it stays an observation). **v9 is an
  unresolved CANDIDATE**, not the champion, taking `AGENTIC_PLAYBOOK_AB_PCT=40`% of decides; the
  candidate-lapse deadlock is live and `pnpm playbook:candidate` stays blocked (`verdicts.md`).
- **Queued by the owner 2026-07-29, research, not started:** could the daily loop — or a similar
  subscription-based path — call app endpoints to execute trades as the bot would, routing around
  the funding blocker entirely? Two constraints to design against before anything is built: hard
  rule 2 forbids bypassing Risk, so the entry point must be the **Signal** boundary and not the
  order boundary; and the promotion gate measures a specific decider, so "whose evidence is this?"
  needs an answer before loop-originated trades may count toward it.
- **Last pass:** Pass 47, 2026-07-29 (`LOG.md`). Cadence 3×/day; take the pass lease before any edit
  (playbook §1 step 3) and release it last (§6 step 4).

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 47/48 |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | holds — 711.5 MiB |
| WATCH-V4-1 | `reconciliation_last_success_timestamp_seconds` age under ~2 min, `adopt_non_adoptable` 0, and no order sitting non-terminal while its `fills` sum equals its `qty` | holds — stamp 105s, re-verified against `audit_log` |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction, a fire is a book HALT that will NOT re-fire | holds — no `FILL_OVERFLOW` in `audit_log` |
| WATCH-V4-3 | a redeploy while a perp symbol carries a resting stop boots to `kill_switch_state{state="RUNNING"}` with no `perp pin:` line in the boot log | holds — `RestartCount` 0, RUNNING |
| WATCH-V4-4 | `fills` rows carry the clientOrderId of an order on the SAME venue, and `sum(fills.qty)` equals `orders.cum_qty` for every terminal order | holds — 197 perp→perp, 12 spot→spot, zero cross-venue folding |
| WATCH-V4-6 | the count of orders non-terminal with no in-flight intent stays at 4 and does not grow | holds — still exactly the 4 from 07-24, `cum_qty` 0 |
| WATCH-V4-7 | every digest carries an "alerts fired+resolved in the last 12h" line and a warn-scan span at or above the alert lookback | holds |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-8) are kept in full in `watches.md` § Resolved — they are
closed, not deleted; do not re-open one without new evidence.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

### Open

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 18 | Per-hour/session expectancy gating (last residual of the W4.4 seeds — fee-tier/BNB dropped: demo fees flat 10bps, § Standing verdicts; trade-flow widening shipped Phase 3) | 2+ | M | DATA-GATED (2026-07-22 sweep): 0 closed trips post-cutover (worse than the 07-13 "10 trips" skip) — per-hour buckets statistically empty |
| 44 | Spot OCO exits (fuse executor stop + venue TP into one venue-side pair) — needs demo `orderList/oco` support proof; ccxt 4.5.58 has no unified spot OCO | 2 | M | PROBE-GATED (2026-07-22 sweep): needs a keyed demo-venue orderList/oco capability probe + the still-unmet venue-TP capture data (fills=0 post-cutover) |
| 45 | Trailing-stop plan field — wait for venue-TP capture data (Phase-2 WATCH counters) before designing | 2 | M | DATA-GATED (2026-07-22 sweep): venue-TP/stop capture data still unmet (fills=0 post-cutover) |
| 47 | Adaptive consult cadence (vary the 15m consult rhythm by regime) | 2 | M | DATA-GATED (2026-07-22 sweep): Phase-5 consult baseline still ~1 day old / trade-gated |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED (2026-07-22 sweep): the 5→8 sequencing gate is OBE (universe now 40 symbols + vol×ATR scanner + menu-8); residual = the open rotation-vs-promotion-walk attribution design |

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- ~~**BOTH PROVIDER ACCOUNTS ARE UNFUNDED**~~ — **RESOLVED 2026-07-30T09:01Z**, the Anthropic account
  was funded and the lane self-healed with no redeploy (banner above). The Moonshot fallback is
  untested since and presumed still suspended. The item stays listed, struck rather than deleted,
  because the condition recurs whenever the balance runs out and the response is then unchanged: read
  `agent_client_latch_cause`, do not investigate.
- **The open question funding does NOT answer** — `verdicts.md`: entries are worse than a random-bar
  placebo, so a live lane accumulates evidence for a gate the present signal cannot pass. Pass 48's
  research recommends the ~$110 frozen replay study over the trading lane. Owner call.
- **WATCH-V4-6 — an order reaching `NEW` via `QUERY_NOT_FOUND` can never become terminal.** Four
  zombie orders since 2026-07-24; live impact measured nil. The repair is new OMS orchestration
  (TTL re-examination + venue re-query before terminalizing), not a line change.
- **Two scheduled passes have run concurrently in one working tree** — four recorded occurrences,
  one with production blast radius. `pnpm loop:lock` binds only passes that call it; the scheduler
  config that lets passes co-fire is owner-owned.
- **Shared-org rate limit** — the trading app and interactive sessions share ONE Anthropic org
  budget. A dedicated key/org for the app is owner-side; the CryptoPanic key (X4 sentiment enable)
  is also still open.
- **Availability** — the stack runs on the owner's MacBook; host sleep throttles everything (worst
  measured 8%/24h duty cycle). Treat counter gaps across an `app_suspended` annotation as duty cycle.
- **6.9-LINK wallet scar (~$55)** — historical unapplied recovered-order fill, journaled and deduped
  so no walk sees it post-epoch; a venue-side manual sell is optional wallet hygiene only.

## Index — every loop file, and when to read it

| file | read it when |
| --- | --- |
| `STATUS.md` (this file) | always, first, at the start of every pass |
| `charter.md` | deciding whether a change is loop-domain or needs the owner; before firing a pre-authorization; before disputing a settled decision |
| `verdicts.md` | before proposing work in an area it covers — the entry signal, exit rules, cost levers, decide-model choice, price TA, non-price channels, the promotion benchmark, the live playbook lineage |
| `watches.md` | checking a WATCH's exact expected-positive or named defect outcome; reading an open flagged item in full |
| `LOG.md` | appending this pass's entry (newest last); reading the last five passes |
| `archive/state-2026-07-30.md` | a line here or in `watches.md` points there for the record behind it — v3 build/cutover, soak defects, per-pass decision records, A0/XA/X2/X9/Y4/R2, resolved flagged entries |
| `archive/LOG-through-pass-47.md` | a pass entry older than the five kept in `LOG.md` (Pass 0 → Pass 42) |
| `state.md` | never for content — a stub kept because commit messages, `docs/runbook.md` and the scheduled task reference the path by name |
| `digests/` | `loop:sweep` writes its digest here; rehydration reads the newest |
| `incidents/` | a named incident note written by an earlier pass |

**Maintenance rule (playbook §6, the actual fix — a one-off compaction just re-grows).** Each pass
appends its entry to `LOG.md` and updates THIS file. When `LOG.md` holds more than five pass entries,
the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`, appended at the end in
chronological order. Nothing is ever deleted from any loop file — only moved, with a pointer left
behind. If a STATUS section outgrows a few lines, move the body to the file that owns it and leave
the one-liner.
