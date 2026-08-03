<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 58,
2026-08-03**. Hard cap 200 lines — anything longer belongs in the file that owns it, with a pointer here.

## ⚠ `loop:sweep` REPORTS 1 alarm (was 2). It is EXPECTED — but its recorded clearing path is UNREACHABLE

> **`venue_reject_rate_high [binance]` — 16/20 = 80.0%. Do not investigate, do not tune.** All 20
> submits predate `f5abf8a`; all 16 rejects are one `reduce_only SELL ZEC/USDT`. **Do not lower the
> threshold** (binanceusdm 4/186, Wilson 99.9% UB 8.45%, spec-pinned). **CORRECTED Pass 58: it will NOT
> "clear on the first real spot entry"** — zero binance submits for 3d 7h, 7 spot entries lifetime vs
> 189 reduce-only legs. It **ages out ~2026-08-07T01:45Z** into `venue_reject_rate_undetermined` —
> silence, not health.
>
> **`config_snapshot_missing` — RESOLVED Pass 58 (`118132c`), verified in production.** No writer since
> 2026-06-14; first row ever at 09:37:08Z, and no drift/shape alarm replaced it.
>
> **`venue_reject_rate_high [binanceusdm]` — STOPPED FIRING (0/20), REPAIR STILL NOT SHIPPED.** A
> cleared alarm is not a fixed defect: the `-4024` `PERCENT_PRICE` frame mismatch recurs on the next
> perp exit priced against the live feed. The obvious fix was REFUTED; the correct seams need
> `agentic.strategy.ts:1434-1438` first. `incidents/2026-07-31-perp-exit-band-rejects.md`.

## ⚠ THE LANE IS WORSE THAN DOING NOTHING — measured 2026-08-01, first opportunity-cost read

> `BELOW_PASSIVE_BENCHMARK` fires on **evidence, not the fail-closed sentinel**. Equal-weight 28-asset
> basket over the evidence window **−2.175%** ⇒ benchmark ≈ −$11 at ~50% exposure, −$22 at full
> notional, against `netPnl` −$48.54 then ⇒ **≈$37 of the loss is strategy, not market beta**. Every
> prior measurement compared to ZERO.
>
> **THE RECONCILER ONCE HALTED THE BOOK OVER AN ORDER IT HAD CANCELLED ITSELF** — fixed `62f9738`,
> nothing lost, and it surfaced ONLY as a resolved-alert annotation. **Four more findings root-caused
> and NOT shipped:** `incidents/2026-08-01-spurious-unknown-ours-halt.md`. **The through-line has held
> three passes running** (`config_snapshots`, `fee_ledger`, and this pass's alarm text / harness
> monitor / playbook inventory): _a surface reporting health it never established._

## ⚠ Four standing cautions — bodies live elsewhere; these are the facts, follow the pointer

> **`entryVwap` IS BUY-SIDE ONLY ⇒ the anchor is the COVER price on every SHORT trip** (TRUMP: 16 SELL
> @1.561 in, one BUY @1.593 out ⇒ 1.593). Biases Arm2/Arm3 in `edge-verdict-2026-08-10.md`; **not fixed
> on purpose** — needs a pre-registration amendment. `studies/frame-audit-2026-08-03.md`.
>
> **THE HORIZON GRID FLATTERS EVERY RESULT** — h ∈ {1,4,8,24} never matched holding behaviour (median
> 15.6 bars); the gap to the +13.0 bar is **~70–125 bps, not ~30**. **Re-read any prior finding before
> quoting it.** `verdicts.md`; `learning-capacity-2026-07-31.md`.
>
> **TWO LIVE BEHAVIOUR CHANGES SHIPPED 2026-07-30, NEITHER CREDITABLE ALONE** — v10 `inverted` (a
> RESEARCH-BAR FAIL: **never quote +47.6 as an edge**) and `AGENTIC_PLAN_AUTHORITATIVE_EXITS=true`,
> same boot, no control arm. `watches.md` § V10-1, § PLAN-AUTHORITY-1.
>
> **THE LLM LANE IS FUNDED — do not investigate a latch**; read `agent_client_latch_cause` (all-zero at
> Pass 58; any cause other than `insufficient_credit` IS an incident — `charter.md`).

## Current order & status

- **Live build `9082f89`**, boot 09:37:08Z, healthy, `RestartCount` 0, health 200/200, 23 rules / 0
  firing, clean stamp ~1 min. Redeploys re-seed the `agentic_venue_stop_total` counters
  WATCH-V4-11/V4-13 read. **Promtool trap** (in-container check after a host edit is VOID): playbook §5.3.
- **`config_snapshots` HAS A WRITER NOW** (`118132c`) — it never had one since 2026-06-14. Row 1:
  `dust 5`, `epoch 2026-07-21T11:21:00Z`, no `db`/`bootId`/`gitSha`; the payload is a pure function of
  the hash. Writer FAILS OPEN, reader FAILS CLOSED. **WATCH-V4-16.**
- **THE PIN-SET LEAK IS REAL — the "UNREAD" check is READ, and it is a BLOCKED DEFECT, not backlog.
  First item for the next pass.** Four spot dust positions (`AAVE` $0.06 stuck **9.3 d**, `SOL`, `ZEC`,
  `BTC`) hold consult slots permanently — the fill path closes round trips at `dustNotional` while the
  pin tests EXACT ZERO, and the residue is below any `minNotional`. **≈$0.33/day = 11% of the breaker;
  148 consults → 148 `hold`s.** Repair written, reviewed, **WITHDRAWN**: both canonical dust sites
  carry a "was once real" guard no signal at the `PortfolioViewPort` seam can reconstruct, so dropping
  it unpins **a position being built**. Persisted high-water = money-table schema (report-only);
  in-memory resets on restart. **Sound route = a durable cycle reader.** `LOG.md` § Pass 58.
- **THE SPOT LANE IS SEVERELY SUPPRESSED, AND THE OBVIOUS EXPLANATION IS HALF WRONG.** `sideEligibility`
  is **prompt payload, not a code gate** — Risk never sees it and the model HAS entered against it.
  Real: 191 spot consults → **0** entries where the perp rate predicts ~7.7, P(0) ≈ 3.8e-4 —
  **confounded with v10 `inverted`**. `verdicts.md` BINDS: _"Do not propose cost work as a profitability
  lever."_ Backlog 58, expectancy-framed. `LOG.md` § Pass 58.
- **`llm_usage` IS NOT A DEFECT — vestigial by design** (writer deleted in `9a63edf`). **`llmCostUsd`
  is CORRECT** — `tokenTotals` UNIONs `agent_decisions` with the 69 reflection rows. **Do not drop
  those rows**: they sit inside the epoch, and removing them loosens a permission gate.
- **The playbook documented 8 of 22 alarm kinds; now all 22** (`7e1306c`). **`loop-sweep-specs` IS on
  the production gate** though the monitor claimed otherwise (`6149861`). All three off-gate harnesses
  were **STALE 68.4h**, now `harness_ok` — run `loop:harness` (~15s) on `harness_stale`.
- **`loop:authoring` CLAIMED ITS FIRST SLOT EVER (Pass 56)** — `experiments` id=16, registry gate
  VERIFIED. **An API-shape failure burns the whole day** (the env check precedes the day gate, the
  drafting call does not). `WATCH-DEPLOY-HALVES-1` sample zero.
- **THE BAR THIS PROGRAM GATES ON WAS NEVER DERIVED** — +13.0/+24.2 enter the repo fully formed in
  `7b3e977` with no operands; every later citation is circular. Measured demo cost 9.29 bps/round trip.
  `studies/fee-floor-derivation-2026-07-31.md`.
- **THE `−16.9 bps` ENTRIES FIGURE IS WRONG — it is `−13.75` (n=64, not 61)**; 3 rows fell past the
  `279713e` truncation. **Five `verdicts.md` citations stale**; mirror UNVERIFIED beyond h=1.
- **Cost shape:** LLM runs AT the $3/day breaker on ~5% of wakes. **The timing knobs, not the model,
  set the bill.** `charter.md` says $5/day while `.env.app:97` deploys `3` — unreconciled drift.
- **FAMILY B IS NOT BLOCKED — the 2026-07-31 drift finding was WRONG.** The separator is a genuine NUL
  byte, not the space that study's reimplementation typed; `assertDesignMatchesCorpus` does not throw
  and its whole § 2.6 reordering table is the same artifact. **Lesson: a reimplemented hash is a second
  source of truth — import it or do not compute it.** `studies/corpus-fingerprint-drift-correction-2026-08-03.md`.
- **The book at 2026-08-03T09:45Z, as ONE atomic tuple** (single `evaluate()` sample): `roundTrips=46,
  windowDays=9.92, netPnlUsd=−59.93, llmCostUsd=26.96, winRate=0.239, ready=false,
  reasons=[NON_POSITIVE_NET_PNL, INSUFFICIENT_WINDOW, BELOW_PASSIVE_BENCHMARK]`; `equity_usdt` 4969,
  RUNNING. **Never quote these from separate reads.** **−$5.6/day since Pass 56 (40 / −$48.60).**
- **THE PROMOTION GATE IS NOT REACHABLE ON THIS EDGE — arithmetic, not opinion.** 46 trips vs a floor
  of 30, so **the WINDOW binds**: 14 days not met before **08-06 18:00Z**. Gross is negative ⇒ **even
  zero LLM spend cannot make it positive**; abstaining freezes the window AND bleeds.
  `success-exit-2026-07-31.md`.
- **`test:cov` RED is FIXED** (`69461f3`) — the dead `if (toMs > cursor)` branch in `gross-exposure.ts`
  is gone, plus two specs. **93.87/87.49/92.89/95.61 vs 90/85/90/90.** Backlog 56 stays open and is the
  real fix — the mandated 100% globs never run on the green path.
- **Corpus v4 (587 rows) + OHLCV RESTORED Pass 54** — h=16 scoreable 59.3% → 97.4%; gitignored. **`arm-sweep-v1` closed the arm space Pass 55: both arms 0 entries in 30 rows — sizing-gate refusal.**
- **NOTHING HERE CAN CURRENTLY BE SHOWN TO LEARN — the mechanism is DIVISION, not suppression.** Only
  v1 (n=28,k=13) and v2 (n=18,k=11) of eight versions ever reached n≥12 AND k≥5, and both are the
  oldest. **OWNER DECISION OWED: daily minting and powered evidence are mutually exclusive**
  (`candidate-routing-override-2026-07-31.md`).
- **A decide-model A/B gate shipped FLAG-OFF (`3958c8c`) and is NOT a working A/B** — the arm is drawn once per BOOT and attribution journals every arm-B decide **as arm A**. **`AGENTIC_MODEL_AB_PCT` stays 0.**
- **THE SUCCESS/STOP CRITERIA ARE ADOPTED (owner, 2026-08-01: `1C, 2A, 3A, 4A`).** § 6/§ 7 ENACT;
  window closes **2026-08-31**; S3's −$200 / $150 triggers are LIVE. **G1 re-cut to h = 16**, but its
  FEASIBILITY figure is a **bound [+45.0, +92.6] @K=20, not a point**. **Q4 = A did NOT rebut § 10.**
  **S3 WILL LIKELY DECIDE THIS FIRST** — the −$200 trigger lands **~2026-08-27**, and does NOT extend it.
- **G4 AND G5 BOTH SHIPPED — no clause is decorative.** G5 `agentic_promotion_blocked{reason}`,
  zero-seeded over a closed 8-member union, fails OPEN. G4 equal-weight over **28 distinct assets, not
  40 strings**, exposure-matched, **FAILS CLOSED in the adapter**.
- **COLLISION #6 — an owner-directed INTERACTIVE session ran 06:43Z–08:05Z inside Pass 58's lease and
  took the number `57`**, declaring _"No lease taken"_. The lease binds only callers. **Zero file
  overlap, no work lost**; tip re-verified before staging. **The dirty tree at 06:41Z was ITS in-flight
  work — `git add -A` would have committed it.** Also **Pass 56 never released its lease** (46.6h stale
  when Pass 58 broke it); the break fails open, so it is the only signal.
- **Last pass:** Pass 58, 2026-08-03 (`LOG.md`). Cadence 3×/day; take the lease before any edit, release
  it last. It is 2h and time-based: a pass spanning a host sleep finds its own lease expired.

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 58 |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | holds |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — the 19:00:30Z occurrence is transient and explained (two binance `STOP_LOSS_LIMIT` ACKs 19-28s prior); the alert's 5 firing samples are a `for: 0m` rule staying hot ~5 min after ONE event, not a sustained fault |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction | holds — zero ever |
| WATCH-V4-3 | a redeploy with a resting perp stop boots to RUNNING with no `perp pin:` line | holds |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds — **and is no longer hand-checked**: the I2 sweep invariant (2026-08-03) compares `cum_qty` to summed fills in exact SQL `NUMERIC` on every terminal order, every pass, failing CLOSED. 439 terminal orders, 0 mismatches |
| WATCH-V4-7 | every digest carries an alerts-fired-and-resolved line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows | holds — standing check on the mint-time gates |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | **RE-READ Pass 58 — expected-positive CONFIRMED again**: `orphan_scan=2843 readopt=1 cancel=0 cancel_failed=0` on binanceusdm before the redeploy. Re-seeded to 0 by each redeploy, so it re-reads on the next flat perp bar |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:`; baseline 10 of 37 over 14 days | **FIRST READING Pass 53 — EXPECTED-POSITIVE CONFIRMED, defect outcome absent.** 7 rows this boot, min = max = 4096; `schema_rejected:` rows top out at 358. Disclosed: 4 of 11 rows over 14d carry NULL `output_tokens` (unreadable, not contradicted). **Do NOT raise `AGENTIC_MAX_TOKENS` in response — refuted** (the $3/day USD breaker binds, and a 12288 ceiling projects past the 75s batch HTTP budget, where an abort THROWS and 3 strikes auto-DRAIN the lane). In-contract lever is `output_config: {effort}`, absent from the client today |
| WATCH-V4-14 | a terminal-reject burst of ≥3 in 15m surfaces as a `prometheus_alert_firing_nonblocking` annotation naming `VenueTerminalRejectBurst` in the FIRST sweep after it, and agrees with the sweep's own rate alarm | **NEW Pass 53, UNFIRED.** Named defect outcomes: it fires on the 2/hour spot bleed (threshold mis-derived); or a burst occurs and it stays silent (`for: 5m` outliving a ~5m burst is the specific risk); or it lands as an ALARM, meaning severity drifted to `critical` and §3 is now wedgeable. **An unfired alert is not a passing one** — if nothing rejects by 2026-08-07, record it as UNTESTED |
| WATCH-V4-13 | on the FIRST spot entry after `f5abf8a`, `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments, `{venue="binance",event="placed"}` stays 0, and NO `InsufficientFunds` on a spot `reduce_only` SELL | **STILL VOID at Pass 58 — and now known to be STRUCTURALLY STARVED, not merely quiet.** All binance stop counters 0; zero binance submits of any kind for 3d 7h; 191 spot consults → 0 entries. This watch cannot be answered until the spot-suppression question (backlog 58) is settled — record it as BLOCKED-ON-EVIDENCE, not as holding |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **OPEN, and now INSTRUMENTED (Pass 52).** `pnpm loop:forward-return`, surfaced every sweep. First reading v10 n=4/clusters=4 ⇒ UNDERPOWERED (bar: n≥12 AND clusters≥5). No divergence evaluated; point estimates are not quoted at rollup by design. A divergence EITHER way is a FINDING |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |
| WATCH-V4-16 | **NEW Pass 58.** Every boot leaves exactly ONE `config_snapshots` row per config hash; an unchanged redeploy BUMPS `activated_at` on the existing row rather than inserting a second; `config_snapshot_missing` stays cleared | **FIRST READING GREEN** — 1 row, `dust 5`, `epoch 2026-07-21T11:21:00Z`, no `db`/`bootId`/`gitSha`. Named defect outcomes: duplicate rows per hash ⇒ wrong upsert target; `activated_at` NOT moving on an unchanged redeploy ⇒ `onConflictDoUpdate` not firing; `config_snapshot_drift` ⇒ either real drift or the nested key walk mis-resolving; the alarm RETURNING ⇒ the fail-open writer is failing silently — read the app log for `config snapshot write failed`, do not rebuild the writer |
| WATCH-V4-17 | **NEW Pass 58.** No symbol carrying an in-flight entry intent is absent from `agentic_active_menu` at a recompute | **UNFIRED.** Named defect outcome: an `off_menu` hold journalled for a symbol that has an in-flight intent — i.e. the pre-existing gap `548376c` closed has reappeared. Note the exposure window is up to a full UTC day, because `isPinned` is only evaluated inside `recompute()` |
| WATCH-V4-15 | `stale_venue_open` appears on an ordinary in-sweep cancel and does NOT halt, while a coid still venue-open past `driftPasses` consecutive passes DOES halt with its id in `reconciliations.detail` | **NEW Pass 56, UNFIRED.** Named defect outcomes: it never fires at all (the second tier is resolving at the book tier every time, so the durable arm is dead code in production); or it fires and never clears, meaning the streak reset is not matching coids and a benign race is walking toward a halt; or a genuine orphan escalates and the halt string still lacks the id. **It is deliberately actionable**, so a stuck one starves the clean stamp and blocks auto-resume — that is the intended fail direction, not a defect |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8, **V4-10 moved out Pass 54**) are kept in full in `watches.md` § Resolved — closed, not deleted; do not re-open one without new evidence.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 56 | Put `test:cov` on `pnpm checks` | 2 | S | NEW (Pass 51). `400c08e` fixed the symptom; the cause is that the mandated 100% globs never run on the green path, which is how five commits landed branches without tests. One line, once the four `v8 ignore` annotations are spot-checked |
| 57 | Measure how much recorded PnL is attributable to demo/live price decoupling | — | — | **CLOSED 2026-08-03 with a measured answer.** artifact **+21.0 bps/trip**, median +0.53, cluster CI **[+1.4, +39.8]**, n=38 of 46 (8 excluded, disclosed grid gap), 12 clusters. **Excludes zero and FLATTERS the demo book** (demo −70.3 vs live −91.2) ⇒ decoupling **cannot** be what makes the book negative; correcting for it makes it worse. Concentrated in maker fills (+121.3, n=8) vs taker (−5.8, n=30). `research/studies/frame-audit-2026-08-03.md` |
| 58 | Retire or re-scope the spot half of the universe | 1 | M | **NEW (Pass 58).** 191 spot consults → **0** entries (P(0) ≈ 3.8e-4 against the perp rate); spot realized PnL **−$8.01 over 7 lifetime entries**; 5 spot symbols currently on the menu. **Justify on EXPECTANCY, never on cost** — `verdicts.md` § entry signal forbids the cost framing outright. **Confounded with v10 `inverted`** (live 07-30T16:57Z, no control arm), so it needs that controlled or a two-step enable. Three remedies with failure directions: `LOG.md` § Pass 58 |

Rows **54/55** moved in full to `charter.md` § Backlog closed ledger; rows **18/44/45/47** retired
OBSOLETE 2026-07-30. **Do not re-open one because its gate has cleared** — the question is answered.

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- **THE OWNER DECISION THIS PROGRAM TURNS ON** — the gate CANNOT be passed, by arithmetic: an arm must
  post +20.9/+26.4/+33.8/+81.4 bps, the bar is **CLUSTER-limited**, unreachable at h=1/4 at ANY cluster
  count, and the universe is **28 BASES, not 40 strings**. `success-exit-2026-07-31.md` — three exits,
  four questions, "STOP with extra steps" unrebutted.
- **GO/NO-GO OWED: the ~$22 Family B paid edge run** — blocker refuted 08-03, account can spend, but
  the paid block is atomic. **Not run unilaterally**; the deployment's own falsification test.
- **ONE `.env.app` edit hook-blocked** — `:153` spot/`STOP_LOSS_LIMIT` FALSE since `f5abf8a`. **`:159`
  `AGENTIC_PLAYBOOK_AB_PCT=40` must NOT be zeroed** — that cancels the owner's daily-minting override.
- **Both provider accounts** — Anthropic funded 07-30 (re-verified 08-03), Moonshot presumed suspended.
- **Concurrent passes in one tree — SIX occurrences.** #6 was an owner-directed INTERACTIVE session
  declaring _"No lease taken"_, so `loop:lock` never saw it: the lease binds only callers, and
  scheduler/session co-firing is owner-owned. **A pass can also end without releasing its lease** —
  Pass 56's was 46.6h stale when Pass 58 broke it, and the break is the only signal it happened.
- **Availability** — the stack runs on the owner's MacBook; host sleep throttles everything.
- **Shared-org rate limit**; the CryptoPanic key (X4 sentiment) is also still open. **6.9-LINK wallet
  scar (~$55)** — journaled and deduped post-epoch; a manual sell is optional hygiene only.

## Index — every loop file, and when to read it

| file | read it when |
| --- | --- |
| `STATUS.md` (this file) | always, first, at the start of every pass |
| `charter.md` | deciding whether a change is loop-domain or needs the owner; before firing a pre-authorization; before disputing a settled decision |
| `verdicts.md` | before proposing work in an area it covers — the entry signal, exit rules, cost levers, decide-model choice, price TA, non-price channels, the promotion benchmark, the live playbook lineage |
| `watches.md` | checking a WATCH's exact expected-positive or named defect outcome; reading an open flagged item in full |
| `LOG.md` | appending this pass's entry (newest last); reading the last five passes |
| `archive/state-2026-07-30.md` | a line here or in `watches.md` points there for the record behind it — v3 build/cutover, soak defects, per-pass decision records |
| `archive/LOG-through-pass-47.md` | a pass entry older than the five kept in `LOG.md`; Pass 58 rotated Pass 53 out |
| `state.md` | never for content — a stub kept because commit messages, `docs/runbook.md` and the scheduled task reference the path by name |
| `digests/` | `loop:sweep` writes its digest here; rehydration reads the newest |
| `incidents/` | a named incident note written by an earlier pass |

**Maintenance rule (playbook §6 — a one-off compaction just re-grows).** Each pass appends to `LOG.md` and updates THIS file; past five entries the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`. **Nothing is ever deleted from a loop file — only moved, with a pointer left behind.** Outgrown a few lines? Move the body out. (P53: backlog 54/55 → `charter.md`, promtool trap → playbook §5. P54: WATCH-V4-10 → `watches.md`. P58: the Family B correction body → its own study; the dust-pin and spot-suppression bodies → `LOG.md` § Pass 58.)
