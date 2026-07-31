<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 50,
2026-07-31**. Keep this under 200 lines: anything that grows past a few lines belongs in one of the
files below, with a one-line pointer here.

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
> was funded** — Moonshot is untested since and presumed still suspended. Live as of Pass 50: real
> model decides **722** lifetime.
>
> **The standing rule survives the good news: the condition recurs the moment the balance runs out.**
> Owner directive 2026-07-30, verbatim: _"lack of trading is because of the anthropic api account
> being unfunded. this should not have to turn into investigations on each pass."_ So: **if a sweep
> shows a latched client, read the CAUSE, do not investigate.**
> `agent_client_latch_cause{cause="insufficient_credit"} == 1` means the balance is out — an owner
> capability limit. Cause-specific and fails CLOSED: any other cause classifies as `other`, keeps
> `AgentClientFatalLatch` at `critical`, and IS a full incident.
>
> **Funding does not make resumed trading unambiguously good** — `verdicts.md`: entries measure
> significantly negative and worse than a random-bar placebo. That is an owner call, § Flagged.

## Current order & status

- **HEAD = live build `3f215aa`** (`build_info{git_sha}` confirmed on the running process), boot
  started **2026-07-31T07:47:51.820Z**, `RestartCount` 0, healthy. Prometheus force-recreated:
  **22 rules across 5 groups, 0 firing**; `AgenticOrphanStopCancelFailing` loaded `health: ok`.
- **Pass 50 shipped six commits, `daf8dbe` … `3f215aa` — six defects, one commit each, no
  improvement.** Algo-rail cancels instrumented + journaled (`59df4c9`); the HALT path's own
  un-journaled cancel (`a2d7d33`); truncation vs schema-rejection tagging (`daf8dbe`); replay-harness
  parity + a stale leverage cap that had been red since 2026-07-27 (`f9ed0ea`); the rail's first
  alert rule + a dashboard regex that coloured nothing (`d2ab9fa`); a test run that silently rewrote
  a committed study (`3f215aa`). Detail: `LOG.md` § Pass 50.
- **The book at 07:50Z:** **34** closed round trips (was 32), net-of-cost **−$44.2337** (was
  −$41.8850), win rate **0.2059**, LLM cost **$19.3709**, trade-anchored window **7.329 of 14 days**,
  `agentic_promotion_ready` **0**, `equity_usdt` **4976.77**, kill switch RUNNING.
  **Two trips closed overnight, one a winner; realised PnL moved −$0.82 while LLM spend moved
  +$0.99** — the loss this window is mostly the cost of asking.
- **WATCH-V4-10 is ROOT-CAUSED but NOT closed, and Pass 49's suspect is REFUTED.** The
  undefined-`entry`-after-`clearPlan()` hypothesis is dead. The real shape: the orphan reconciler
  reached its venue read every bar but emitted nothing on any of its four outcomes, so "never
  matched" and "cancel threw into a bare `catch {}`" were the same zero; separately, an algo-rail
  cancel that DID reach the venue was never journaled. **Money-path, not untidy:** a stale
  non-terminal algo intent marks its symbol BUSY for `driveFlattening`, so a HALT cannot complete for
  it until the next boot. The fix is prevention + measurement — **the four already-stranded rows will
  NOT terminalize.** `watches.md` § WATCH-V4-10 / V4-11.
- **THE INSTRUMENT ALREADY ANSWERED IT, on the first bar after the deploy** (08:01:13Z, boot
  `ae5df10b`): `orphan_scan=16 orphan_readopt=4 orphan_cancel=0 orphan_cancel_failed=0
  reconcile_error=0` on `binanceusdm` (`binance` 0 throughout — the path is perp-only). The scan runs
  once per perp symbol, does **not** throw, and matches nothing to cancel — while re-adopting 4
  resting stops on positioned symbols in the same bar, which proves `fetchOpenAlgoOrders` is
  returning live algo orders and they resolve to our ids. **Most probable: the HYPE stop is gone at
  the venue and stranded only in our book** — the benign half of the pair `watches.md` called
  unanswerable. Not fully excluded: an id-resolution mismatch on that one older order.
- **Next pass's cheapest high-value action:** a keyed
  `fetchAlgoOrderStatus(cbt019fb31cb7c97ea0a8dfa5462d3d3764, HYPE/USDT:USDT)` — the primitive exists
  on the adapter with no scheduled caller. CANCELED/EXPIRED ⇒ what remains of V4-10 is folding four
  stale local rows, not a venue problem.
- **A test run rewrote a committed study, and the data behind it has collapsed.** `vitest run
  test/backtest/` overwrote `carry-study-2026-07-10.md` (the evidence under a settled NO-GO) with
  funding rows **3250 → 31**. Write is now gated behind `CARRY_STUDY_WRITE=1`. **Still open:**
  `fetchExtended()` in `test/backtest/fetch-data.mjs` defaults `targetBars` to 200 with no
  `existsSync` guard, so it keeps truncating full-history caches — any carry-adjacent measurement
  today runs on ~1% of its intended data.
- **`AGENTIC_PLAYBOOK_AB_PCT=40` still routes nothing** — v9 superseded, no unresolved candidate above
  v10. Inherited from Pass 49 and still undecided: mint a v11 candidate against `inverted`
  (`pnpm loop:authoring` exists to draft one) or set the knob to 0 and say so.
- **`test:cov` is RED at HEAD and was not caused by Pass 50** — `reconciliation.service.ts`,
  `unknown-resolver.service.ts`, `position-sizer.service.ts` are the sub-100% files under the two
  100% globs, none touched. `pnpm test` / `pnpm checks` do not run coverage.
- **Two unrecorded sessions in three days.** The 2026-07-30 18:25→22:19Z session shipped three
  commits and deployed with no LOG entry; reconstructed as `LOG.md` § Pass 49 addendum c. The
  detector cannot catch this class on its own — it keys on sweep digests, and a digest after the
  newest LOG entry sits in a deliberate grace bucket until a later entry lands.
- **Last pass:** Pass 50, 2026-07-31 (`LOG.md`). Cadence 3×/day; take the pass lease before any edit
  (playbook §1 step 3) and release it last (§6 step 5). The lease is 2h and time-based: a pass that
  spans a host sleep will find its own lease expired and may break it — Pass 50 did, and said so.

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 50 |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | holds |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — the 19:00:30Z occurrence is transient and explained (two binance `STOP_LOSS_LIMIT` ACKs 19-28s prior); the alert's 5 firing samples are a `for: 0m` rule staying hot ~5 min after ONE event, not a sustained fault |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction | holds — zero ever |
| WATCH-V4-3 | a redeploy with a resting perp stop boots to RUNNING with no `perp pin:` line | holds |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds |
| WATCH-V4-7 | every digest carries an alerts-fired-and-resolved line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows | holds — standing check on the mint-time gates |
| WATCH-V4-10 | no perp algo stop stays `ACKED` more than one 15m bar after its position goes flat | **OPEN, breached, now ROOT-CAUSED** — HYPE stop ~11h across 3+ boots. Closure needs the venue-truth read, not the instrument |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | **NEW, unread** — this is the instrument V4-10 was missing |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:`; baseline 10 of 37 over 14 days | **NEW, unread.** Expect a step in `agent_decide_total{outcome="hold"}` across the 07-31 deploy — that is this change, declared |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **OPEN, n<12.** A divergence EITHER way is a FINDING to report |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8) are kept in full in `watches.md` § Resolved —
closed, not deleted; do not re-open one without new evidence.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 54 | Put the off-gate harnesses (`test/backtest`, `test/eval`) on a scheduled run whose failure `loop:sweep` surfaces | 2 | S | NEW (Pass 50). Five of six defects that pass were invisible failures; a red spec sat unread since 2026-07-27. One commit, highest available leverage on measurement trust |

Four rows (18, 44, 45, 47) were retired OBSOLETE on 2026-07-30 — answered by evidence, not awaiting
data. **Do not re-open one because its gate has cleared**; the gate is moot, the question is
answered. Full ledger and reasons: `charter.md` § Backlog and the Pass 48 entry.

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- **The open question funding does NOT answer.** `verdicts.md`: entries are worse than a random-bar
  placebo, so a live lane accumulates evidence for a gate the present signal cannot pass. An arm must
  post **+20.9 / +26.4 / +33.8 / +81.4 bps** at h=1/4/8/24 to clear the research bar, and **no family
  size fixes that** — the bar is n-limited, not α-limited. Owner call: whether a lane that provably
  cannot pass its own gate should keep accruing ~$1/day of evidence.
- **Both provider accounts** — Anthropic funded 2026-07-30, Moonshot presumed still suspended. Recurs
  whenever the balance runs out; read `agent_client_latch_cause`, do not investigate.
- **Two scheduled passes have run concurrently in one working tree** — four recorded occurrences, one
  with production blast radius. `pnpm loop:lock` binds only passes that call it; the scheduler config
  that lets passes co-fire is owner-owned.
- **Shared-org rate limit** — the trading app and interactive sessions share ONE Anthropic org budget.
  A dedicated key/org is owner-side; the CryptoPanic key (X4 sentiment enable) is also still open.
- **Availability** — the stack runs on the owner's MacBook; host sleep throttles everything (worst
  measured 8%/24h duty cycle). Pass 50 itself spanned a ~7.5h sleep.
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
| `archive/state-2026-07-30.md` | a line here or in `watches.md` points there for the record behind it — v3 build/cutover, soak defects, per-pass decision records |
| `archive/LOG-through-pass-47.md` | a pass entry older than the five kept in `LOG.md` — now **Pass 0 → Pass 47** (Pass 50 rotated 46 and 47 out, appended at the end) |
| `state.md` | never for content — a stub kept because commit messages, `docs/runbook.md` and the scheduled task reference the path by name |
| `digests/` | `loop:sweep` writes its digest here; rehydration reads the newest |
| `incidents/` | a named incident note written by an earlier pass |

**Maintenance rule (playbook §6, the actual fix — a one-off compaction just re-grows).** Each pass
appends its entry to `LOG.md` and updates THIS file. When `LOG.md` holds more than five pass entries,
the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`, appended at the end in chronological
order. Nothing is ever deleted from any loop file — only moved, with a pointer left behind. If a
STATUS section outgrows a few lines, move the body to the file that owns it and leave the one-liner.
