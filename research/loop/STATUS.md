<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 49,
2026-07-30**. Keep this under 200 lines: anything that grows past a few lines belongs in one of the
files below, with a one-line pointer here.

## ⚠ TWO LIVE BEHAVIOUR CHANGES SHIPPED 2026-07-30, AND NEITHER MAY BE CREDITED ALONE

> **1. `inverted` is the live playbook (v10)** — `agentic_playbook_info` reads `version="10"` since the
> 16:57:19Z boot. **It is a RESEARCH-BAR FAIL, shipped on DEPLOYMENT-BAR grounds.** It beats
> `champion_v8` at all four horizons (**+11.9 / +37.1 / +52.0 / +117.7 bps** at h=1/4/8/24) and fails
> the research bar on interval width (h=24 CI lo **−12.2**). **Never quote +47.6 as an edge.**
> In-sample, one 6.35-day regime, and **adverse selection may not invert** — entries were maker-side at
> 76% fill, which offline replay structurally cannot measure. **A divergence between replay-predicted
> and live-realised entry return is a FINDING to report, whichever way it points.**
> `verdicts.md`; `watches.md` § WATCH-PLAYBOOK-V10-1.
>
> **2. `AGENTIC_PLAN_AUTHORITATIVE_EXITS=true`** (`.env.app:261`, same boot). The model's `close` is
> suppressed while a declared plan is live; positions exit only via declared stop / TP / maxHold.
> Measured basis **−78.4 vs −108.1 bps/trip** (29.7 bps). **BASELINE FOR THE NEXT MEASUREMENT:
> −108.1 bps/trip at 17.4% hit.** The failure mode to watch is **a plan lost to a restart**; the gate
> fails toward EXITING (absent `directives` ⇒ the close executes unchanged). WATCH-PLAN-AUTHORITY-1 is
> **FIRED**, not pending.
>
> **3. THE ATTRIBUTION LIMIT — read before writing any result.** Both are live simultaneously with no
> control arm. Their EVIDENCE is separable (one measured on entry forward return, the other on exit
> behaviour given entries); **their realised-PnL contributions are NOT. No future pass may claim
> either one moved the book on its own.**

## The LLM lane — FUNDED AND TRADING since 2026-07-30T09:01Z; do not investigate a latch

> **The 60-hour outage ended 2026-07-30T09:01Z**; the lane self-healed with **no redeploy**, closing
> the one WATCH-V4-5 clause credit was needed to test. **Only Anthropic was funded** — Moonshot is
> untested since and presumed still suspended.
>
> **The standing rule survives the good news: the condition recurs the moment the balance runs out.**
> Owner directive, 2026-07-30, verbatim: *"lack of trading is because of the anthropic api account
> being unfunded. this should not have to turn into investigations on each pass. make it clear in
> state or log so that later loop passes do not investigate it; they should be able to tell
> immediately."* So: **if a sweep shows a latched client, read the CAUSE, do not investigate.**
> `agent_client_latch_cause{cause="insufficient_credit"} == 1` means the balance is out — an owner
> capability limit no pass can fix; `loop:sweep` banners it above the alarms and
> `AgentClientLatchedUnfundedAccount` is `warning` on purpose so it annotates instead of wedging
> playbook §3. **Cause-specific and fails CLOSED:** any other cause classifies as `other`, keeps
> `AgentClientFatalLatch` at `critical`, and IS a full incident.
>
> **Funding does not make resumed trading unambiguously good.** `verdicts.md`: entries measure
> significantly negative and worse than a random-bar placebo, so a live lane spends ~$2.6/day
> accumulating evidence for a gate the present signal provably cannot pass. That is an owner call.

## Current order & status

- **HEAD = live build `4218d78`**, boot `b894ce22` (deployed 2026-07-30T16:57:19.888Z,
  `RestartCount` 0, healthy). Prometheus force-recreated: **21 rules across 5 groups, every rule
  `health: ok` and `state: inactive`, 0 firing** (read off `/api/v1/rules`). Sweep at 17:08:20Z:
  **0 alarms**. `count(ALERTS)` empty.
- **Pass 49 shipped eleven commits, `8c6d098` … `4218d78`, plus one live DB action in no commit**
  (the v10 mint + promotion): the completed playbook-space study (`2f1c917`, NO_SURVIVOR 20/20); the
  two-bar rule + four backlog items retired OBSOLETE (`c521f39`); the ANTI-RATCHET retirement, prompt
  preserved at `playbook-authoring.md` (`9aa8400`); the unrecorded-pass detector (`0fc3bd1`); the
  playbook-candidate CLI repair (`2c4e339`); reflection off then deleted (`193107e`, `9a63edf`);
  stranded orders fixed (`83eae1f`); declared exits enabled (`4218d78`).
- **ARCHITECTURE IS NOT THE LEVER EITHER — the funded haiku 3-vote swarm does NOT ship** (Family A,
  `playbook-space-followon-2026-07-31.md`). It **loses the declared primary** (h=24 −71.83 vs
  `champion_v8` −70.10) and posts research-bar `NO_SURVIVOR`: 4/4 powered cells, 0 passes at α=0.0125.
  **The pre-registered screen scored CORRECT** — worse than its own single-call control at 3 of 4
  horizons, placebo p 0.99–1.00 (a displaced centre, which variance reduction cannot move). Spend
  `$6.1728` of `$7.93`. **A single haiku beat the incumbent at h=1/4/8 but LOST h=24 — a LEAD, not a
  finding, and NOT a licence to swap the decide model.** Against the now-live v10 the swarm loses at
  every horizon. **Do not re-run ensemble/multi-call architecture arms.** Cost routed onward: sonnet
  re-checked at `$0.0191125`/call, 1.39× the older `$0.013717` (likely cache amortisation) — Family
  B's sonnet legs re-size from the new figure. Full record: `verdicts.md`.
- **The book, re-derived from the gauges at 17:15:42Z:** **32** closed round trips (was 29),
  net-of-cost **−$41.8850** (was −$41.1723), win rate **0.1875**, LLM cost **$17.8605**,
  trade-anchored window **6.9663 of the 14 days** required, `agentic_promotion_ready` **0**,
  `equity_usdt` **4978.39**, budget **$1.3221** of $3, `open_orders` binance 3 / binanceusdm 2,
  RSS **711.4 MiB** (WATCH-V3-1 fine), kill switch RUNNING.
- **Do not read today's book as evidence about today's changes.** At 17:07Z it read 31 trips at
  −$39.0415, an improvement of 2.13 USD; at 17:15Z, 32 at −$41.8850, a loss of 2.84 USD on one trip.
  n=2 and n=1, and the first two trips closed BEFORE the 16:51/16:57Z deploys. **Exactly one closed
  round trip has run under either change** — KAITO/USDT:USDT, entered 16:30:38Z, closed **17:11:55Z
  by its declared venue STOP_MARKET**, which is the behaviour the enable predicts.
- **Champion is now v10 (`inverted`, `source='loop-candidate'`, `parent_version=8`) — the FIRST
  loop-authored row in the program's history.** v9 was **superseded** by `--supersede` (`experiments`
  id 8; **no row deleted**, all ten versions survive), resolving the candidate-lapse deadlock.
  Consequence: `AGENTIC_PLAYBOOK_AB_PCT=40` now routes **nothing** — no unresolved candidate sits
  above the active version. Historical: v8 +$6.77 over 5 trips, v2 −$24.76 over 14, both n far under
  the "never act on a sub-n≥12 cell" bar.
- **Reflection is DELETED** (`9a63edf`: −6,596 lines, −149 tests / −3 test files; two reflection
  alerts deleted, 23 rules → 21). **`AGENTIC_REFLECTION_MODEL` and the `claude-opus-5` price entry
  are KEPT — boot REFUSES without them.** `agent_tokens_total{model="claude-opus-5"}` is now ABSENT
  rather than a permanently-zero seeded child. **Do not book the `$5.01` as a forward saving:** it
  read 0 on the pre-deploy boot and is historical — `llm_usage`'s newest reflection row is
  2026-07-27T09:47:23Z, three days before deletion. `pnpm playbook:candidate` is the ONLY mint path.
- **Soaking a deploy: the first ~2h after a redeploy is a blind window for the LLM lane.**
  `AGENTIC_FALLBACK_CONSULT_BARS=8` at 15m bars puts the first consult ~2h out, so the 15-30 min soak
  sits inside it. Judge liveness from `agent_last_success_timestamp_seconds` (seeded at boot from
  `agent_decisions` since `446e1da`), never from `agent_client_latched` reading 0 on a young boot.
- **The unrecorded-pass detector fired correctly on its first production sweep**, naming the three
  2026-07-29 sweeps (16:07:26Z, 19:33:03Z, 19:46:38Z). **RESOLVED — verified by re-running
  `loop:sweep`, not assumed; the annotation is gone.** Reconstructed in `LOG.md` § "Pass 47 addendum
  b": all three ran on git `14d197f` against boot `1d68a57c`, `realDecides` delta 0, zero fills, same
  critical `AgentClientFatalLatch`, and **no commit landed between `14d197f` and `8c6d098`** — what
  they observed is reconstructable, what they decided is not. Prose alone would NOT have cleared it:
  the detector matches a `**Window:**` span under a `## <date> — Pass <n>` heading, so an unrecorded
  window needs a covering entry. Do not re-investigate them.
- **ANSWERED in Pass 48, kept only so it is not re-opened:** loop-as-decider is **NO-GO** on
  evidentiary grounds (free inference removes 37% of the requirement, 0% of its cause).
- **Last pass:** Pass 49, 2026-07-30 (`LOG.md`). Cadence 3×/day; take the pass lease before any edit
  (playbook §1 step 3) and release it last (§6 step 4).

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 49 |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | holds — 711.4 MiB |
| WATCH-V4-1 | `reconciliation_last_success_timestamp_seconds` age under ~2 min, `adopt_non_adoptable` 0, and no order sitting non-terminal while its `fills` sum equals its `qty` | stamp clause holds (86s); **`adopt_non_adoptable` clause BREACHED once** — 2026-07-30T09:30:15Z, `binance`, single pass, self-cleared. Passes 47/48 verified it against `audit_log`, which **can never carry this class**; the surface is `reconciliation.discrepancies`. Named defect outcome did NOT fire; the event is not root-caused |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction, a fire is a book HALT that will NOT re-fire | holds — zero `fill_overflow` in `reconciliations` or `audit_log`, ever |
| WATCH-V4-3 | a redeploy while a perp symbol carries a resting stop boots to `kill_switch_state{state="RUNNING"}` with no `perp pin:` line in the boot log | holds — two redeploys, both `RestartCount` 0 / RUNNING |
| WATCH-V4-4 | `fills` rows carry the clientOrderId of an order on the SAME venue, and `sum(fills.qty)` equals `orders.cum_qty` for every terminal order | holds — 218 perp→perp, 14 spot→spot, zero cross-venue folding, 0 sum mismatches |
| WATCH-V4-7 | every digest carries an "alerts fired+resolved in the last 12h" line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows, and a candidate the entry-rate floor rejects is rejected for abstaining, not for proposing a size the recorded row actually permitted | defect FIXED + shipped `8c6d098` (2026-07-30) and the study it blocked ran to completion (20/20 cells, NO_SURVIVOR, `verdicts.md`); the named defect outcome did NOT fire — entry rate moved 2.5% → 19.1% against the recorded 16.1%. Still open as a standing check on the mint-time gates: any run reading a non-`recorded` row voids it, and if a later re-measure falls back below 16.1% the next suspect is the system prompt (`DEFAULT_FLOOR_PROFILE`), then the live ~9-version mixture |
| WATCH-V4-10 | no perp algo stop stays `ACKED` more than one 15m bar after its position goes flat | **OPEN, observed breached** — `HYPE/USDT:USDT` `BUY STOP_MARKET` resting 73+ min and two boots after its short closed. `reduceOnly`, so untidy not dangerous; mechanism NOT established |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds appear at ~the historical close rate (~16 per 22 exits) AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED** (flag on since 16:57Z). Baseline **−108.1 bps/trip at 17.4% hit**; revert if positions storm to `max_hold` at worse than −108.1. n=1 so far |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps, in the predicted direction | **OPEN, n<12.** A divergence EITHER way is a FINDING to report — worse = adverse selection confirming, better = a finding about the replay |

Resolved WATCH lines (V3-2, V3-3, V4-5, **V4-6 — closed Pass 49**, V4-8) are kept in full in
`watches.md` § Resolved — closed, not deleted; do not re-open one without new evidence.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

### Open

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED (2026-07-22 sweep): the 5→8 sequencing gate is OBE (universe now 40 symbols + vol×ATR scanner + menu-8); residual = the open rotation-vs-promotion-walk attribution design |

### Closed 2026-07-30 (Pass 48) — OBSOLETE, answered by evidence, not awaiting data

Four rows retired rather than deleted (closed-ledger convention, `charter.md` § Backlog). Each was
gated on data the 2026-07-27 verdicts have since made irrelevant — **do not re-open one because its
gate has cleared**; the gate is moot, the question behind it is answered.

| # | Item | Why it is OBSOLETE — the verdict that answers it (`verdicts.md`) |
| --- | --- | --- |
| 18 | Per-hour/session expectancy gating | It is a conditional-subgroup cut, and that search is exhausted: 1,807 cuts examined, **0 of 188 counterfactual cuts positive at n≥8**, smallest p among positive-mean cuts 0.302, BH at q=0.05 yields zero discoveries. "There is no attribute-based entry filter to deploy" (§ THE ENTRY SIGNAL IS SIGNIFICANTLY NEGATIVE). More closed trips would not change this — the cut class itself is dead |
| 44 | Spot OCO exits (venue-side stop+TP pair) | Exit geometry, and the exit study is **16 of 16 cells negative** across three arms and 14 geometry cells, with an explicit "**Do NOT re-run exit-rule sweeps**" (§ NO EXIT RULE RESCUES THESE ENTRIES). A demo `orderList/oco` probe would prove only that a negative-expectancy exit can be placed venue-side |
| 45 | Trailing-stop plan field | Same verdict: wider stops buy hit rate monotonically (17.4% → 40%) **without turning expectancy positive**, and a shorter TP wins at every stop multiple — the signature of entries with no directional edge. The venue-TP capture data it waited on cannot reverse that |
| 47 | Adaptive consult cadence | Priced and rejected: cadence/batching work is worth ~**$0.20/day** and "**Consult cadence is ON TARGET; batching fragmentation is not a profitability lever**" (§ Consult cadence). The remaining cost lever is payload SIZE, which the C4 per-block ablation covers as a separate plan step — not this item |

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- ~~**BOTH PROVIDER ACCOUNTS ARE UNFUNDED**~~ — **RESOLVED 2026-07-30T09:01Z**, the Anthropic account
  was funded and the lane self-healed with no redeploy (banner above). The Moonshot fallback is
  untested since and presumed still suspended. The item stays listed, struck rather than deleted,
  because the condition recurs whenever the balance runs out and the response is then unchanged: read
  `agent_client_latch_cause`, do not investigate.
- **The open question funding does NOT answer** — `verdicts.md`: entries are worse than a random-bar
  placebo, so a live lane accumulates evidence for a gate the present signal cannot pass. The power
  table in `research/studies/playbook-space-followon-2026-07-31.md:596-606` is the finding: an arm
  must post **+20.9 / +26.4 / +33.8 / +81.4 bps** at h=1/4/8/24 to clear the research bar, and **no
  family size fixes that** — the CI clause runs at fixed z=1.96 regardless of α. The bar is
  n-limited, not α-limited, so money reliably buys a deployment-bar ranking and only marginally a
  research-bar pass. Owner call.
- ~~**WATCH-V4-6 — `QUERY_NOT_FOUND` orders can never become terminal**~~ — **CLOSED Pass 49
  (`83eae1f`)**: flagged as a missing capability, capability built, all four zombie orders `CANCELED`
  on the first tick after deploy. `watches.md` § Resolved.
- **Two scheduled passes have run concurrently in one working tree** — four recorded occurrences, one
  with production blast radius. `pnpm loop:lock` binds only passes that call it; the scheduler config
  that lets passes co-fire is owner-owned.
- **Shared-org rate limit** — the trading app and interactive sessions share ONE Anthropic org budget.
  A dedicated key/org is owner-side; the CryptoPanic key (X4 sentiment enable) is also still open.
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
| `archive/LOG-through-pass-47.md` | a pass entry older than the five kept in `LOG.md` — now **Pass 0 → Pass 44** (Pass 49 rotated Pass 44 out); the filename names the era, not the last entry |
| `state.md` | never for content — a stub kept because commit messages, `docs/runbook.md` and the scheduled task reference the path by name |
| `digests/` | `loop:sweep` writes its digest here; rehydration reads the newest |
| `incidents/` | a named incident note written by an earlier pass |

**Maintenance rule (playbook §6, the actual fix — a one-off compaction just re-grows).** Each pass
appends its entry to `LOG.md` and updates THIS file. When `LOG.md` holds more than five pass entries,
the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`, appended at the end in chronological
order. Nothing is ever deleted from any loop file — only moved, with a pointer left behind. If a
STATUS section outgrows a few lines, move the body to the file that owns it and leave the one-liner.
