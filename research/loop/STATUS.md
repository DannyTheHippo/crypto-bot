<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 48,
2026-07-30**. Keep this under 200 lines: anything that grows past a few lines belongs in one of the
files below, with a one-line pointer here.

## ⛔ Owner-blocked — read this before investigating anything

> ## ⛔ THE ANTHROPIC ACCOUNT IS NOT FUNDED — THIS IS WHY THERE ARE NO TRADES
>
> **DO NOT INVESTIGATE IT. STOP HERE IF YOUR SWEEP SHOWS A LATCHED AGENT CLIENT, ZERO DECIDES, OR ZERO TRADES. This is the
> cause. It is settled. It is not a defect. No pass can fix it.** Owner directive, 2026-07-30,
> verbatim: _"lack of trading is because of the anthropic api account being unfunded. this should not
> have to turn into investigations on each pass. make it clear in state or log so that later loop
> passes do not investigate it; they should be able to tell immediately."_
>
> Re-confirmed live at 2026-07-30T07:45Z (Pass 48; previously Pass 46 at 09:00Z on 07-29), verbatim
> from the API: `400 invalid_request_error: "Your credit balance is too low to access the Anthropic
> API."` — 28 latches and 27 cooldown expiries on boot `1d68a57c` alone, 100% that one status, newest
> line 07:45:18Z, nothing redacted.
> **Nothing is broken in the code.** The lane calls, gets a FATAL 400, latches for 30 min, retries,
> gets the same 400, and re-latches — correct behaviour against an unfunded account. The Moonshot
> fallback account is unfunded too (`429 suspended — insufficient balance`), so there is no second
> provider to reach for. Consequence: **zero LLM decides, therefore zero trades, therefore zero
> progress toward the promotion gate, since 2026-07-27T21:16Z.**
> **Adding credit is a financial action no automated pass may take — this is the single owner action
> the entire program is waiting on.** On resumption nothing needs redeploying: the latch self-heals
> within 30 min of credit landing (proven live, WATCH-V4-5). Read § Flagged's funding entry and Pass
> 41's ENTRIES verdict together before funding — entries currently measure worse than a random-bar
> placebo, so resuming spends ~$2.6/day gathering evidence for a gate the present signal cannot pass.
>
> **How a pass tells, in one read, without any investigation (shipped Pass 48, 2026-07-30):**
> `loop:sweep` prints a banner naming this condition ABOVE its alarms section, and the alert split
> makes it non-blocking — `AgentClientLatchedUnfundedAccount` is severity `warning` deliberately, so
> it annotates rather than wedging playbook §3. The machine-readable fact is
> `agent_client_latch_cause{cause="insufficient_credit"} == 1`. **The demotion is cause-specific and
> fails CLOSED:** any other latch cause classifies as `other`, keeps `AgentClientFatalLatch` at
> `critical`, and IS a full incident. Passes 42–47 each re-derived this blocker from scratch — that is
> the waste this banner and the alert split exist to end.

## Current order & status

- **HEAD:** `a03b35d`. **Live build:** `446e1da`, boot `1d68a57c` (deployed 2026-07-29T11:03:17Z,
  `RestartCount` 0). **Pass 48's commits are NOT deployed — pending deploy this pass.**
- **Pass 48 (2026-07-30) shipped two commits.** `8002888` — the agent-client latch-cause split, so
  the unfunded-account condition annotates instead of forcing an investigation every pass
  (`agent_client_latch_cause{cause="insufficient_credit"}`, and `AgentClientLatchedUnfundedAccount`
  at severity `warning` on purpose); `a03b35d` — seeded `reconciliation_runs_total` and narrowed
  `ReconcilerStalled`, the two critical alerts guarding hard rule 6 that could not fire. A third
  commit seeding ~7 more void-read instruments is in flight from a concurrent session.
- **Deploy note:** Pass 48 edited `observability/alerts.rules.yml`, so the deploy MUST also run
  `docker compose up -d --force-recreate prometheus` (playbook §5 step 3) — that file is read once at
  Prometheus process start and a plain `up -d prometheus` is a no-op. 22 rules were loaded at the
  07-29 deploy.
- **Soaking a deploy: the first ~2h after a redeploy is a blind window for the LLM lane.**
  `AGENTIC_FALLBACK_CONSULT_BARS=8` at 15m bars means the first consult attempt — the only thing
  that can re-latch the client — is ~2h out, so the playbook's 15-30 min soak sits entirely inside
  it. Judge lane liveness from `agent_last_success_timestamp_seconds` (seeded at boot from
  `agent_decisions` since `446e1da`, so it reads the TRUE age on a fresh boot), never from
  `agent_client_latched` reading 0 on a boot too young to have tried. WATCH-V4-8, `watches.md`.
- **Alerts:** `AgenticNoSuccessfulDecideSustained` (severity `warning`, non-blocking) firing since
  2026-07-29T11:04:25Z — Pass 47's restart-surviving lane-liveness signal doing its job, not a
  regression.
- **The book** (Pass 47, independently re-derived from metrics): **28** closed round trips,
  net-of-cost **−$39.6370**, win rate **0.1786**, LLM cost **$16.1979**, trade-anchored window
  **4.30 of the 14 days** required, `agentic_promotion_ready` **0**, 0 fills, `equity_usdt`
  **4978.17**, RSS **711.5 MiB**. Four positions, all spot dust (ZEC/AAVE/BTC/SOL);
  `open_orders{venue}` 0 on both venues; no resting protective orders. **None of it can move while
  the account is unfunded** — the last real model decide was 2026-07-27T20:15:31Z.
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

- **BOTH PROVIDER ACCOUNTS ARE UNFUNDED** — the single blocker on the entire program. Purchasing
  credit is a financial action no automated pass may take. See the banner above.
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
