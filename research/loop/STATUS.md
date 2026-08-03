<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything
else is looked up on demand; § Index says which file answers which question. Last updated **Pass 56,
2026-08-01**. Hard cap 200 lines — anything longer belongs in the file that owns it, with a pointer here.

## ⚠ `loop:sweep` REPORTS Alarms (2). ONE IS EXPECTED, ONE IS A REAL DEFECT WITH A NAMED BLOCKER

> **`venue_reject_rate_high [binance]` — 16/20 = 80.0%. EXPECTED. Do not investigate, do not tune.**
> All 20 submits predate `f5abf8a`; all 16 rejects are one `reduce_only SELL ZEC/USDT` retrying every
> 30 min. **Do not lower the threshold** (derived from binanceusdm's 4/186, Wilson 99.9% UB 8.45%,
> spec-pinned). Clears on the first real spot entry, with `WATCH-V4-13`.
>
> **`venue_reject_rate_high [binanceusdm]` — STOPPED FIRING 2026-08-03 (0/20). The REPAIR IS STILL NOT
> SHIPPED — the window simply rolled past the 12 rejects.** A cleared alarm is not a fixed defect: the
> `-4024` `PERCENT_PRICE` frame mismatch is unrepaired and will recur on the next perp exit priced
> against the live feed. The obvious fix was REFUTED (retaining the plan-stop registry row re-arms
> nothing and breaks `orphan_readopt`); the correct seams need `agentic.strategy.ts:1434-1438` first.
> Root cause, forensics, exact diffs: `incidents/2026-07-31-perp-exit-band-rejects.md`.

## ⚠ THE LANE IS WORSE THAN DOING NOTHING — measured 2026-08-01, first opportunity-cost read

> `BELOW_PASSIVE_BENCHMARK` fires on **evidence, not the fail-closed sentinel** (checked before
> recording). Equal-weight 28-asset basket over the evidence window: **−2.175%** ⇒ benchmark PnL ≈ −$11
> at ~50% exposure, −$22 at full notional, −$44 at 2× the book — against `netPnl` **−$48.54**. The lane
> **underperforms passive at every plausible exposure**: −4.9% of the book where holding the same basket
> at matched exposure lost 2.2%, so **≈$37 of the loss is the strategy, not market beta.** Every prior
> measurement compared against ZERO; this is the first against OPPORTUNITY COST.

## ⚠ THE RECONCILER HALTED THE BOOK OVER AN ORDER IT HAD CANCELLED ITSELF — fixed `62f9738`

> Halted on an order terminal at the venue **27.3 s earlier**; nothing was lost, no position went
> naked, auto-resume cleared it in 65 s. It surfaced ONLY as a resolved-alert annotation — the alarm
> list was clean of it. **Four more findings root-caused and NOT shipped, each with its blocker; full
> body: `incidents/2026-08-01-spurious-unknown-ours-halt.md`.** Through-line, and it recurred twice
> more today (`config_snapshots`, `fee_ledger`): _a surface reporting health it never established._

## ⚠ `entryVwap` IS BUY-SIDE ONLY — the anchor is WRONG for every short trip, and a verdict is due 08-10

> `round-trips.ts` builds `entryVwap` BUY-side unconditionally and `exit-attribution.spec.ts` feeds it
> to `simulateExit` as the entry price, so on a SHORT trip it is the **cover** price. Verified on
> TRUMP: 16 SELL @1.561 entering, one BUY @1.593 covering, `entryVwap` = **1.593**. Biases Arm2/Arm3
> anchoring for every short in `edge-verdict-2026-08-10.md`, and may explain the TRUMP episode's
> non-reproduction (−11.0 vs −207 recorded). **Not fixed on purpose:** needs a dated review and a
> pre-registration amendment, never a silent edit to a frozen study.
> `research/studies/frame-audit-2026-08-03.md`.

## ⚠ Three standing cautions — bodies moved out Pass 56; these are the facts, follow the pointer

> **THE HORIZON GRID FLATTERS EVERY RESULT.** h ∈ {1,4,8,24} was never matched to holding behaviour
> (median hold 15.6 bars); the gap to the +13.0 bar is **~70–125 bps, not ~30**, and h=1 brackets no
> realized figure. **Re-read any prior finding before quoting it** — and note the one verdict that
> CANNOT be re-read is the opus rejection (`verdicts.md`; `learning-capacity-2026-07-31.md`).
>
> **TWO LIVE BEHAVIOUR CHANGES SHIPPED 2026-07-30, NEITHER CREDITABLE ALONE.** v10 `inverted` (a
> RESEARCH-BAR FAIL shipped on deployment-bar grounds — **never quote +47.6 as an edge**) and
> `AGENTIC_PLAN_AUTHORITATIVE_EXITS=true`, same boot, no control arm: evidence is separable,
> **realised-PnL contributions are NOT.** `watches.md` § V10-1, § PLAN-AUTHORITY-1.
>
> **THE LLM LANE IS FUNDED — do not investigate a latch**; read `agent_client_latch_cause` first
> (`insufficient_credit` = owner limit, not an incident; fails CLOSED, any other cause IS an
> incident — `charter.md`). Re-verified 2026-08-03 by a 1-token probe: 200 OK. **Funding does not
> make resumed trading good** — it is measurably worse than not trading (top banner).

## Current order & status

- **Live build `62f9738`**, boot `3f93c971` (07:54:53Z), healthy, 23 rules, 0 firing. Redeploys re-seed
  the `agentic_venue_stop_total` counters WATCH-V4-11/V4-13 read. **Promtool trap** (in-container check
  after a host-side edit is VOID — dangling inode, reads like corruption): playbook §5.3.
- **`loop:authoring` CLAIMED ITS FIRST SLOT EVER (Pass 56) — `experiments` id=16, registry gate
  VERIFIED** after two fixes (`13407c4`, `b54aae7`). **An API-shape failure burns the whole day**: the
  env check precedes the day gate but the drafting call does not. `WATCH-DEPLOY-HALVES-1` sample zero.
- **THE BAR THIS PROGRAM GATES ON WAS NEVER DERIVED.** +13.0/+24.2 enter the repo fully formed in
  `7b3e977` with no operands; every later citation is circular. Measured demo cost 9.29 bps/round trip.
  `research/studies/fee-floor-derivation-2026-07-31.md`.
- **THE `−16.9 bps` ENTRIES FIGURE IS WRONG — it is `−13.75` (n=64, not 61)**; 3 rows fell past the
  `279713e` truncation. **Five `verdicts.md` citations stale**; mirror UNVERIFIED beyond h=1. **A frozen
  constant reading a mutable cache fails only when the defect is FIXED.**
- **FAMILY B IS NOT BLOCKED — the 2026-07-31 drift finding was WRONG.** `corpusManifest`'s separator
  is a genuine **NUL byte**, not the space that study's reimplementation typed; the real function has
  always reproduced the recorded `f1dd13c6…` pin from the real corpus. Measured four ways: NUL+file
  order = `f1dd13c6…` (= the design pin), space+file order = `030367ba…` (= the study's "on-disk"
  value), and the tie-break sort is a **no-op**. Its whole § 2.6 reordering table (`6b3c3af5…`,
  `3d3768b8…`, +9) is the same artifact. Verified free, no network: `assertDesignMatchesCorpus` does
  **not** throw. A 1-token probe confirms the account can spend. **The ~$22 paid edge run was NOT
  executed — it is an owner go/no-go**, since that test's paid block is atomic and cannot be separated
  from the spend. `research/studies/corpus-fingerprint-drift-correction-2026-08-03.md`.
  **Transferable lesson: a reimplementation of a hash function is a second source of truth.**
- **The book at 2026-08-03, as ONE atomic tuple** (single `evaluate()` sample — the pairing defect is
  now structurally impossible, task #87): `roundTrips=46, windowDays=9.92, netPnlUsd=−59.78,
  llmCostUsd=26.83, winRate=0.239, ready=false, reasons=[NON_POSITIVE_NET_PNL, INSUFFICIENT_WINDOW,
  BELOW_PASSIVE_BENCHMARK]`. **Never quote these fields from separate reads again** — `loop:sweep`
  emits the tuple whole or voids it whole.
- **THE PROMOTION GATE IS NOT REACHABLE ON THIS EDGE — arithmetic, not opinion.** 40 trips vs a floor of
  30, so **the WINDOW binds**: `windowStart` 2026-07-23T18:00:26Z ⇒ 14 days not met before **08-06
  18:00Z**. Gross is negative ⇒ **zero LLM spend cannot make it positive**; abstaining freezes the
  window AND bleeds. `success-exit-2026-07-31.md`.
- **Cost shape:** LLM runs AT the $3/day breaker; only **5.4% of wakes consult**, and of 205 consults in
  24h just 21 are the organic schedule. **The timing knobs, not the model, set the bill.**
- **`test:cov` RED is FIXED** — the dead `if (toMs > cursor)` branch in `gross-exposure.ts` is gone
  (`cursor` only ever takes `fromMs` or an `executedAt` the loop guard already proved `< toMs`), plus
  two specs. **93.87/87.49/92.89/95.61 vs 90/85/90/90.** Backlog 56 (put `test:cov` on `pnpm checks`)
  is still open and is the real fix — the mandated 100% globs never run on the green path.
- **Corpus v4 (587 rows) + OHLCV RESTORED Pass 54** — h=16 scoreable 59.3% → 97.4%; gitignored.
  `leaders_only`/`one_symbol_btc` structurally unscoreable. **`arm-sweep-v1` closed the arm space Pass
  55: both arms 0 entries in 30 rows — sizing-gate refusal, $0.92 of $18.**
- **NOTHING HERE CAN CURRENTLY BE SHOWN TO LEARN — the mechanism is DIVISION, not suppression.** Only
  v1 (n=28,k=13) and v2 (n=18,k=11) of eight versions ever reached n≥12 AND k≥5, and they are the two
  oldest; 78 entries / 8 = 9.75 vs a bar of 12. **OWNER DECISION OWED: daily minting and powered
  evidence are mutually exclusive** (`candidate-routing-override-2026-07-31.md` — do not reopen silently).
- **A decide-model A/B config gate shipped FLAG-OFF (`3958c8c`) and is NOT a working A/B.** The arm is
  drawn **once per BOOT** (singleton client pins one model) so it stays sequential, and attribution
  journals every arm-B decide **as arm A**. **`AGENTIC_MODEL_AB_PCT` stays 0** until both are closed.
- **UNREAD:** whether any of the 14 `agentic_active_menu` symbols is **pinned with no open position and
  no resting order** (a pin-set leak). An unread check is not a passing one. Owed work.
- **THE SUCCESS/STOP CRITERIA ARE ADOPTED (owner, 2026-08-01: `1C, 2A, 3A, 4A`).** § 6/§ 7 ENACT;
  window closes **2026-08-31**; S3's −$200 / $150 triggers are LIVE. **G1 re-cut to h = 16**, but its
  FEASIBILITY figure is a **bound [+45.0, +92.6] @K=20, not a point** ⇒ **h=16 is never as defensible
  as h ∈ {1,4}**. **Q4 = A did NOT rebut § 10.**
- **S3 WILL LIKELY DECIDE THIS BEFORE THE WINDOW DOES.** −$5.73/day ⇒ the −$200 trigger lands
  **~2026-08-27**, four days before the 08-31 close. It does NOT extend the window.
- **G4 AND G5 BOTH SHIPPED — no clause is decorative.** G5 `agentic_promotion_blocked{reason}`,
  zero-seeded over a closed **8**-member union, fails OPEN. G4 equal-weight over **28 distinct assets,
  not 40 strings**, exposure-matched, 28/28, **FAILS CLOSED in the adapter**; never manufactures a permit.
- **COLLISION #5 — RESOLVED, zero file overlap** (LOG.md § Pass 56). **Fifth occurrence; the lease
  cannot survive this host's sleep cycle** — scheduler co-firing is owner-owned. Lane-level collision
  is now mechanically refused by `loop:fanout declare` (playbook §4.6), which the lease never covered.
- **Last pass:** Pass 56, 2026-08-01 (`LOG.md`). Cadence 3×/day; take the lease before any edit, release
  it last. It is 2h and time-based: a pass spanning a host sleep finds its own lease expired.

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 55 |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | holds |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — the 19:00:30Z occurrence is transient and explained (two binance `STOP_LOSS_LIMIT` ACKs 19-28s prior); the alert's 5 firing samples are a `for: 0m` rule staying hot ~5 min after ONE event, not a sustained fault |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction | holds — zero ever |
| WATCH-V4-3 | a redeploy with a resting perp stop boots to RUNNING with no `perp pin:` line | holds |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds — **and is no longer hand-checked**: the I2 sweep invariant (2026-08-03) compares `cum_qty` to summed fills in exact SQL `NUMERIC` on every terminal order, every pass, failing CLOSED. 439 terminal orders, 0 mismatches |
| WATCH-V4-7 | every digest carries an alerts-fired-and-resolved line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows | holds — standing check on the mint-time gates |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | answered once on the `ae5df10b` boot (`orphan_scan=16 readopt=4 cancel=0 cancel_failed=0`); re-seeded to 0 by the `f5abf8a` redeploy, so it needs one more flat perp bar to re-read |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:`; baseline 10 of 37 over 14 days | **FIRST READING Pass 53 — EXPECTED-POSITIVE CONFIRMED, defect outcome absent.** 7 rows this boot, min = max = 4096; `schema_rejected:` rows top out at 358. Disclosed: 4 of 11 rows over 14d carry NULL `output_tokens` (unreadable, not contradicted). **Do NOT raise `AGENTIC_MAX_TOKENS` in response — refuted** (the $3/day USD breaker binds, and a 12288 ceiling projects past the 75s batch HTTP budget, where an abort THROWS and 3 strikes auto-DRAIN the lane). In-contract lever is `output_config: {effort}`, absent from the client today |
| WATCH-V4-14 | a terminal-reject burst of ≥3 in 15m surfaces as a `prometheus_alert_firing_nonblocking` annotation naming `VenueTerminalRejectBurst` in the FIRST sweep after it, and agrees with the sweep's own rate alarm | **NEW Pass 53, UNFIRED.** Named defect outcomes: it fires on the 2/hour spot bleed (threshold mis-derived); or a burst occurs and it stays silent (`for: 5m` outliving a ~5m burst is the specific risk); or it lands as an ALARM, meaning severity drifted to `critical` and §3 is now wedgeable. **An unfired alert is not a passing one** — if nothing rejects by 2026-08-07, record it as UNTESTED |
| WATCH-V4-13 | on the FIRST spot entry after `f5abf8a`, `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments, `{venue="binance",event="placed"}` stays 0, and NO `InsufficientFunds` on a spot `reduce_only` SELL | **OPEN — re-read Pass 52, STILL VOID.** Zero `binance` rows in `order_intents` since the 09:27Z boot; all three intents are perp. Counters are healthy (every child present, zero-seeded), so the zeros are real — there is simply no spot activity. The pre-deploy stoppage is explained (the ZEC position dusted out), which credits nothing |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **OPEN, and now INSTRUMENTED (Pass 52).** `pnpm loop:forward-return`, surfaced every sweep. First reading v10 n=4/clusters=4 ⇒ UNDERPOWERED (bar: n≥12 AND clusters≥5). No divergence evaluated; point estimates are not quoted at rollup by design. A divergence EITHER way is a FINDING |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |
| WATCH-V4-15 | `stale_venue_open` appears on an ordinary in-sweep cancel and does NOT halt, while a coid still venue-open past `driftPasses` consecutive passes DOES halt with its id in `reconciliations.detail` | **NEW Pass 56, UNFIRED.** Named defect outcomes: it never fires at all (the second tier is resolving at the book tier every time, so the durable arm is dead code in production); or it fires and never clears, meaning the streak reset is not matching coids and a benign race is walking toward a halt; or a genuine orphan escalates and the halt string still lacks the id. **It is deliberately actionable**, so a stuck one starves the clean stamp and blocks auto-resume — that is the intended fail direction, not a defect |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8, **V4-10 moved out Pass 54**) are kept in full in `watches.md` § Resolved — closed, not deleted; do not re-open one without new evidence.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 56 | Put `test:cov` on `pnpm checks` | 2 | S | NEW (Pass 51). `400c08e` fixed the symptom; the cause is that the mandated 100% globs never run on the green path, which is how five commits landed branches without tests. One line, once the four `v8 ignore` annotations are spot-checked |
| 57 | Measure how much recorded PnL is attributable to demo/live price decoupling | — | — | **CLOSED 2026-08-03 with a measured answer.** artifact **+21.0 bps/trip**, median +0.53, cluster CI **[+1.4, +39.8]**, n=38 of 46 (8 excluded, disclosed grid gap), 12 clusters. **Excludes zero and FLATTERS the demo book** (demo −70.3 vs live −91.2) ⇒ decoupling **cannot** be what makes the book negative; correcting for it makes it worse. Concentrated in maker fills (+121.3, n=8) vs taker (−5.8, n=30). `research/studies/frame-audit-2026-08-03.md` |

Rows **54/55** completed Pass 52 and moved in full to `charter.md` § Backlog closed ledger. Rows
**18/44/45/47** retired OBSOLETE 2026-07-30 — answered by evidence, not awaiting data. **Do not re-open
one because its gate has cleared**; the gate is moot, the question is answered.

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- **THE OWNER DECISION THIS PROGRAM TURNS ON** — the gate CANNOT be passed, by arithmetic: an arm must
  post +20.9/+26.4/+33.8/+81.4 bps, the bar is **CLUSTER-limited**, unreachable at h=1/4 at ANY cluster
  count, and the universe is **28 BASES, not 40 strings** (2026-08-03) ⇒ harder than recorded.
  `success-exit-2026-07-31.md` — three exits, four questions, "STOP with extra steps" unrebutted.
- **GO/NO-GO OWED: the ~$22 Family B paid edge run** — blocker refuted 08-03, account can spend, but
  the paid block is atomic so it cannot be probed without the spend. **Not run unilaterally.** The
  deployment's own falsification test; the highest-value unspent item in the program.
- **ONE `.env.app` edit hook-blocked** — `:153` spot/`STOP_LOSS_LIMIT` FALSE since `f5abf8a`. **`:159`
  `AGENTIC_PLAYBOOK_AB_PCT=40` must NOT be zeroed** — that cancels the owner's daily-minting override.
- **Both provider accounts** — Anthropic funded 07-30 (re-verified 08-03), Moonshot presumed suspended.
- **Two scheduled passes concurrent — FIVE occurrences**, one with production blast radius; the
  scheduler is owner-owned. Lane collisions are now refused by `loop:fanout declare`.
- **Shared-org rate limit**; the CryptoPanic key (X4 sentiment) is also still open.
- **Availability** — owner's MacBook; host sleep throttles everything (worst 8%/24h duty cycle).
- **6.9-LINK wallet scar (~$55)** — journaled and deduped post-epoch; a manual sell is optional hygiene.

## Index — every loop file, and when to read it

| file | read it when |
| --- | --- |
| `STATUS.md` (this file) | always, first, at the start of every pass |
| `charter.md` | deciding whether a change is loop-domain or needs the owner; before firing a pre-authorization; before disputing a settled decision |
| `verdicts.md` | before proposing work in an area it covers — the entry signal, exit rules, cost levers, decide-model choice, price TA, non-price channels, the promotion benchmark, the live playbook lineage |
| `watches.md` | checking a WATCH's exact expected-positive or named defect outcome; reading an open flagged item in full |
| `LOG.md` | appending this pass's entry (newest last); reading the last five passes |
| `archive/state-2026-07-30.md` | a line here or in `watches.md` points there for the record behind it — v3 build/cutover, soak defects, per-pass decision records |
| `archive/LOG-through-pass-47.md` | a pass entry older than the five kept in `LOG.md`; Pass 55 rotated Pass 50 out |
| `state.md` | never for content — a stub kept because commit messages, `docs/runbook.md` and the scheduled task reference the path by name |
| `digests/` | `loop:sweep` writes its digest here; rehydration reads the newest |
| `incidents/` | a named incident note written by an earlier pass |

**Maintenance rule (playbook §6 — a one-off compaction just re-grows).** Each pass appends to `LOG.md` and updates THIS file; past five entries the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`. **Nothing is ever deleted from a loop file — only moved, with a pointer left behind.** Outgrown a few lines? Move the body out. (P53: backlog 54/55 → `charter.md`, promtool trap → playbook §5. P54: WATCH-V4-10 → `watches.md`.)
