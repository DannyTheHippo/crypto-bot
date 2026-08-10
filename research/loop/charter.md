<!-- Created 2026-07-30 (Pass 48). Every block below is VERBATIM from research/loop/state.md as it
     stood at Pass 47 (2026-07-29). Nothing was edited; only the surrounding narrative was moved. -->

# Loop charter — standing owner decisions, autonomy grants and rails

**Read this when you are about to decide whether something is your domain.** It is stable policy,
not status: the owner's standing decisions, the delegation grants that make demo money-path work
loop-domain, the budgets, the pre-authorizations a pass may fire on its own once the stated trigger
holds, and the backlog's admission rule. Status lives in `STATUS.md`; binding evidence lives in
`verdicts.md`; open WATCH lines live in `watches.md`.

Two rails bind everything here and are deliberately NOT restated in this file: the playbook's §4
MUST-NOT list (`docs/planning/daily-profitability-loop.md`) and hard rules 1-7 in the project
`CLAUDE.md`. The single human gate in the whole program is the live-money flip.

The narrative these decisions sat inside — the v3 build and cutover, the soak defects, the per-pass
decision records — moved verbatim to `archive/state-2026-07-30.md`.

## Strategic frame

The mutable strategy the playbook deliberately does not embed. Passes update stage status here;
when the owner approves a new spec, replace the pointer (and archive the old spec) — the playbook
never changes for strategy evolution.

- **Active spec:** `docs/specs/2026-07-06-profitability-design.md` (owner-approved 2026-07-06;
  git-history-only since the 2026-07-21 prune).
- **Goal:** real live profitability at **$1k–$5k capital** (owner, 2026-07-06). Objective
  function: net-of-cost PnL = `realizedPnl − fees − llmCostUsd`.
- **Active frame (owner decisions 2026-07-10):** the LLM agentic lane is the program centerpiece —
  it trades AND self-learns. The daily loop (a Claude session on subscription, ~zero marginal
  cost) is the heavyweight researcher driving that self-learning: **"LLM proposes, backtest
  disposes."** Playbook v2 codifies the pipeline: draft candidate playbooks IN-SESSION → score
  offline (`AGENTIC_CANDIDATE_PLAYBOOK_FILE` recorded-payload live-compare eval, ≤$20/gate) → log
  EVERY scored variant (winner and losers) to the append-only experiments registry (migration
  0009, `test/backtest/experiment-log.ts`) → inject champion-beaters via `pnpm playbook:candidate`
  → live A/B (`AGENTIC_PLAYBOOK_AB_PCT`) + attributed auto-promotion decide. Cadence
  **2–4 passes/day**. The funding-carry sub-plan is resolved NO-GO (§ Standing verdicts).
- **Standing owner decisions 2026-07-10 (policy, still operative):** (1) no owner gate on redeploy
  — validated-better versions are committed AND deployed autonomously (demo/paper stack; ship
  criterion unchanged: gates green + out-of-sample/net-of-cost evidence + §5 soak); (2) the daily
  loop (or equivalent automated process) drives the program; (3) the ONLY human touch is the
  live-money flip — four live gates, bootId arming ceremony, promotion gate unchanged;
  (4) `BINANCE_DEMO_*` keys cover futures-demo (demo-fapi) testing.
- **OWNER DECISION 2026-07-12 (verbatim: "No owner decisions; this is your domain and the aim of
  these passes is profitability. Just do what you have to."):** demo-stack measurement and
  configuration decisions previously routed as owner proposals — evidence-epoch declarations
  included, and the named pre-authorizations below once their stated trigger conditions are met —
  are **loop-domain**: a pass decides, applies, and records the decision + rationale in
  LOG.md/state.md instead of flagging and waiting. This extends the 2026-07-10 decisions above;
  decision (3) is UNCHANGED — the live-money flip remains the sole human checkpoint, and the
  playbook §4 MUST-NOT boundaries (risk/execution/OMS semantics, live gates, append-only tables,
  secrets) are structural rails, not preferences — delegation does not relax them.
- **OWNER DECISION 2026-07-16 — bug-routing discipline (encoded in playbook §3):** the backlog,
  the loop, and similar mechanisms are NOT bug collectors — a bug found by a pass is FIXED in that
  pass; the backlog holds only improvements that move net-of-cost PnL or measurement trust. Fixes
  exceeding the §4 rails go to "Flagged for human review" as OPEN DEFECTS (evidence + exact diff),
  never to the backlog. Applied retroactively: #49 reclassified from backlog seed to § Flagged.
- **OWNER DECISIONS 2026-07-17 (interactive session; plan `should-we-not-just-elegant-locket`):**
  (1) **Full money-path delegation, encoded in playbook §4 — the ONLY owner gate in the program
  is the live-money flip.** Demo-lane risk/execution/OMS/adapter work — defect fixes AND new
  capability — is loop-domain under the standing discipline: mandatory adversarial reviewer
  dispatch, full gates + livegate/paper, deploy soak, decision record + WATCH, two-step enables
  for behavior-changing capability, never two money-path items per pass. The §4 MUST-NOT list
  shrinks to the live-flip/audit invariants (live gates + arming, append-only tables +
  money-table schema, secrets/redaction) — invariants on what a change may do, not gates on who
  approves it. Supersedes the 2026-07-07 scoped exceptions and the 2026-07-10 perp-venue
  owner-scope note. (2) Both § Flagged defects (perp phantom position; #49 atomicity) AUTHORIZED
  — sequenced, phantom first. (3) app-perp stays RUNNING until the fix deploys (containment
  holding per Pass 31). (4) Evidence gates re-affirmed exactly as pre-registered (promotion
  floors, factorial floor, shorts soak, watcher study) — no loosening; v2's runway is protected
  via config instead (lapse 168→336h, playbook A/B 25→40). (5) The 5→8 universe pre-auth is
  FIRED this session (see § Pre-authorizations).
- **OWNER DECISIONS 2026-07-20 (interactive session; plan `how-can-we-save-snuggly-grove`) — the
  v3 consolidation program.** (1) The two lane processes MERGE into one process trading ONE
  unified book (one portfolio/risk/kill-switch/equity, one promotion verdict, one playbook
  lineage, one batched cross-venue consult) — greenfield deploy, fresh DB, evidence clock
  restarts; only the ACTIVE playbook text carries over (folded into v3 seeds). (2) **v2 is FROZEN
  at tag `v2-final` (commit `2e49dfa`, full gate green: 2619 tests)**; branch `v2-maintenance`
  carries critical fixes only — rebuild the running image from that branch, never from main.
  main is v3 from the next commit onward. (3) **X2 stage-2 is CANCELLED on v2** — the 16-perp
  universe becomes v3's launch basket. (4) Scheduled passes are v2-maintenance-only until the v3
  local demo cutover (playbook banner); the v3 program executes in the owner's interactive
  session, not the loop. (5) Fixed capital split across the two wallets (default 500/500 of
  `SIZER_EQUITY_CAP`); one arming ceremony flips both venues (either venue's key validation
  failing refuses arming — fail CLOSED). (6) Deploy target after local soak: GCP e2-medium
  (X1-FINAL executes on v3; owner commits first, unchanged). Full decision ledger + design:
  the plan file and `plans/2026-07-v3-consolidation-spec.md` (spec lands next).

## Settled owner decisions, budgets and pre-authorizations

- **Settled owner decisions (not re-openable by a pass; argue in "Flagged for human review"
  instead):** no return to 1m/5m DECIDE cadence. Formerly settled, since REOPENED by owner:
  - **Shorts (2026-07-13, Push II plan approval): reopened for the DEMO stack only** — existing
    `BINANCE_DEMO_*` keys are futures-demo-capable (venue-path probe PASSED 2026-07-13: pinned
    ccxt 4.5.58 `binanceusdm.enableDemoTrading(true)` → `demo-fapi.binance.com`, auth + balance
    ($5,000 USDT) + orders + positions all OK; chosen path = real futures-demo venue, no
    PaperPerpAdapter, no ccxt bump). `PERP_LEVERAGE_CAP=1` unchanged. Live money, margin >1×, and
    the four live gates + arming ceremony untouched.
  - **Symbol set (2026-07-10): widened** BTC/ETH → **BTC, ETH, SOL, XRP, LINK at 15m**. Fallback:
    drop LINK on sustained >$3/day spend or attribution starvation. Further widening: see the 5→8
    pre-auth below.
  - **Models/cost (2026-07-08, "improve aggressively" mandate):** "Sonnet-5-only" and "≤$1/day"
    framings lifted. Reflection runs Opus-4.8; decide model changes ONLY via the $0 offline
    harness (never a blind flip); ceiling = `AGENTIC_DAILY_COST_STOP_USD=$5/day` breaker
    (expected true spend ~$2.2–2.5/day at 5 symbols).
- **Budgets:** `AGENTIC_DAILY_COST_STOP_USD=$3/day` runtime breaker (**SUPERSEDED 2026-07-21 by the
  v3 one-book consolidation, recorded here Pass 59, 2026-08-03** — the `$5/day` above is the pre-v3
  two-lane figure and is historical. `.env.app:97` deploys `3`, `loop-sweep-core.mjs`'s
  `AGENTIC_DAILY_COST_BREAKER_USD` reads `3`, and the playbook §0 documents the unified `$3/day`;
  the charter was simply never updated, which is the drift Pass 58 flagged. Breaker exhaustion
  mid-day ⇒ economize via prompt/cadence, never raise the breaker); **≤$20/gate** for offline
  candidate evals (~2 API calls/replayed row — cap row count to stay under budget).

- **Pre-authorizations (owner; per the 2026-07-12 delegation a pass applies these itself once the
  trigger condition holds, recording the decision):**
  - (2026-07-07) IF net-of-cost > 0 AND round trips ≥ 30 before the 14-day window fills,
    `MIN_WINDOW_DAYS` 14→10 (`promotion-readiness.service.ts`). ≥30-trips and positive-net are
    NOT relaxable. UNFIRED.
  - (2026-07-08→13) **Sizing 0.05 APPLIED 2026-07-13** (`22af50d`, owner plan approval superseded
    the 15-trip trigger; full re-derivation memo in LOG.md 2026-07-13 owner session / git history
    of this file). Operative residuals: the expectancy ladder is the auto-brake (trailing 15-trip
    mean ≤ −$0.10 ⇒ strength ×0.4 ≈ $100, self-releasing; 8-trip data floor);
    `RISK_MAX_POSITION_PER_SYMBOL=1000` (base qty) is the **binding cap** — a sub-$0.50 symbol
    would be VETOED at entry, so universe expansion must avoid sub-$0.50 symbols or raise the cap
    with its own memo.
  - **Evidence epoch:** `PROMOTION_EVIDENCE_EPOCH=2026-07-12T08:30:00Z` (Pass 18 addendum, under
    the delegation; third epoch — 07-08 original, 07-10 wipe instant). Since `cc72a10` (#36) the
    epoch bounds ALL four consumers (gate, A/B attribution, promotion evaluator, reflection
    evidence/seeds). Declaring a new epoch = loop-domain; declare only at a verified flat instant.
  - **5→8 universe expansion (Push II close-out, owner-approved plan):** after a clean ≥2-day
    portfolio-consult soak (Phase-5 WATCH green), the loop may add **ZEC/AAVE/NEAR** per
    `reports/loop/universe-study-2026-07-13.md` — add the three DEFAULT_FILTERS rows from the
    report, re-derive gross exposure (8 × 0.05 ⇒ consider 0.04, record why), APPEND to
    TRADING_SYMBOLS, never reorder. **FIRED + APPLIED 2026-07-17 (owner session, `1a70a51`,
    spot boot `482d5ab1`):** Phase-5 consult WATCH resolved positive Pass 24; consult clean since
    the 07-13 enable (the 07-16 outage was market-data, not consult). Live demo-venue probe PASSED
    all three (TRADING; filters exactly match the study; ZEC $528.53 / AAVE $90.47 / NEAR $1.94 —
    all clear the $0.50 floor). Sizing 0.05→0.04 (8×0.04 ⇒ ~0.32 gross);
    `AGENTIC_MAX_CALLS_PER_DAY` 700→1100 (768 opportunities/day; breaker unchanged at $5).
    **WATCH:** first decides on ZEC/AAVE/NEAR post-warmup; daily spend ~$3.5–4 expected, breaker
    $5; no cap/notional entry vetoes on the new symbols; a sustained >$4.5/day = drop candidates
    per the study's fallback order. **Day-1 (Pass 32): decides GREEN all three** (ZEC 3 long
    proposes + open position with resting venue TP; AAVE/NEAR deciding), **zero risk vetoes**;
    spend ~$3.5–4.8/day (boot-cache-heavy window — not yet "sustained", re-measure); side effect:
    32 ws subscriptions crossed the venue 1008 burst cliff (Bug D, fixed `f9b7d56` — LOG.md).
    **Day-2 (Pass 33): spend re-measured ~$2.0–2.7/day — the day-1 band was boot-cache noise,
    fallback NOT armed; ZEC closed its first trip +$1.35 via the first-ever spot venue-TP fill.**

## Backlog (ranked; re-rank each pass)

Conventions: IDs are stable and never renumbered (LOG.md references them). **Re-verify a backlog
item against current code before implementing it** (Pass 2 precedent — inherited items go stale).
**Improvements ONLY — never bugs** (owner decision 2026-07-16, playbook §3 bug-routing
discipline): a defect is fixed in the pass that finds it, or — when it exceeds the §4 rails —
lives in § Flagged as an open defect until authorized. Open items first; the closed ledger keeps
one line per retired ID. The 2026-07-22 owner-directed sweep ("fix ALL that does not require me")
shipped **#46** (Thompson A/B routing, build-only), **#52** (ops-event logging), **#53**
(reflection-trigger counter) and closed **#43** as ALREADY-DONE (liquidation feed is live) — all
retired to the closed ledger. Every REMAINING open row is genuinely gated on live soak data or an
open design, NOT on owner action: **#18/#45/#47** DATA-GATED (0 closed trips / thin baseline
post-cutover), **#44** PROBE-GATED (demo orderList/oco capability probe), **#48** DESIGN-GATED
(rotation-vs-promotion-walk attribution; its 5→8 sequencing gate is OBE), **#42-ENABLE** fires
when the info-context A/B resolves.

Closed ledger — rows moved out of `STATUS.md` when done, kept in full here (nothing is deleted):

- **#54 — put the off-gate harnesses on a run whose failure `loop:sweep` surfaces.** DONE Pass 52
  (`f60c79a`): `pnpm loop:harness` writes an artifact and the sweep reads it. Fails OPEN, but
  `harness_stale` / `harness_never_run` / `harness_result_unreadable` are each named, so
  silence-equals-clean is unavailable.
- **#55 — alarm on venue order-reject rate by venue in `loop:sweep`.** DONE Pass 52 (`f60c79a`): 20%
  threshold derived from binanceusdm's 4/186 lifetime baseline (Wilson 99.9% upper bound 8.45%),
  floor n≥6, last-20-submits window bounded to 7 days. Fails CLOSED. **It earned itself on 2026-07-31
  — it is the only instrument that caught the `-4024` exit-reject incident** (Pass 53,
  `incidents/2026-07-31-perp-exit-band-rejects.md`). Do not tune it to silence a true finding.

## Gate-override audit + classification (2026-07-22)

> Moved here 2026-07-30 from state.md § Standing verdicts, where it stood as the one policy bullet
> among evidence bullets. It is the widest grant in the program, so it belongs with the decisions —
> `verdicts.md` carries a pointer at its former position.

- **Gate-override audit + classification (2026-07-22; owner gate-override grant, verbatim: "You
  are welcome to change any owner gate/decision (not live flip; that's only me)"; change-discipline
  binds every change — pre-register, record what/why, never rewrite history).** A four-pass
  read-only audit (code gates, live-flip boundary, memory gates, policy gates) enumerated every
  owner/operator/hard gate in the program; the owner then overrode ALL of them except one.
  **KEPT — the ONLY human gate, unchanged:** the 16 live-flip code gates + the bootId arming
  ceremony + PromotionReadinessService (≥30 closed demo round trips AND positive net-of-cost PnL
  over ≥14d); plus the §4 MUST-NOT structural invariants (risk/execution/OMS semantics, append-only
  tables, secrets/redaction) — rails on what a change may DO, not gates on who approves it.
  **OVERRIDDEN — now loop-domain:** the three operator-recovery gates (kill-switch HALT resume,
  daily-loss halt resume, operator-drained-strategy recovery → precondition-gated AUTO-resume);
  commit + deploy (husky pnpm shim resolved 2026-07-16 — the loop commits AND deploys its own work);
  and bug/tech-debt fixes (fixed + shipped immediately on discovery, the backlog holds ONLY
  profitability improvements). **Genuine capability limits that still need the owner (a lack of
  credentials/hardware, NOT a policy gate):** a dedicated Anthropic org key, the CryptoPanic key,
  an always-on host, GCP credentials, and live trading capital — and GCP itself is DEFERRED ENTIRELY
  to a future owner-initiated session (the loop does not prep or initiate it). This extends the
  Strategic-frame owner decisions above (2026-07-10/12/17/22) — grant 7 is the widest.

## Loop file index — moved here from `STATUS.md` (Pass 63, 2026-08-04, for its 200-line cap)

`STATUS.md` keeps the short form plus a pointer to this table; nothing was deleted, only moved.

| file | read it when |
| --- | --- |
| `STATUS.md` | always, first, at the start of every pass |
| `charter.md` (this file) | deciding whether a change is loop-domain or needs the owner; before firing a pre-authorization; before disputing a settled decision |
| `verdicts.md` | before proposing work in an area it covers — the entry signal, exit rules, cost levers, the derived break-even bar (§ Addendum 2026-08-04), decide-model choice, price TA, non-price channels, the promotion benchmark, the live playbook lineage |
| `watches.md` | checking a WATCH's exact expected-positive or named defect outcome; reading an open flagged item in full; the pre-fix bodies of open defects #147–#152 |
| `LOG.md` | appending this pass's entry (newest last); reading the last five passes |
| `archive/state-2026-07-30.md` | a line in `STATUS.md` or `watches.md` points there for the record behind it — v3 build/cutover, soak defects, per-pass decision records |
| `archive/LOG-through-pass-47.md` | a pass entry older than the five kept in `LOG.md`; Pass 63 rotated Pass 58 out |
| `state.md` | never for content — a stub kept because commit messages, `docs/runbook.md` and the scheduled task reference the path by name |
| `digests/` | `loop:sweep` writes its digest here; rehydration reads the newest |
| `incidents/` | a named incident note written by an earlier pass |

## Backlog (open) — moved here from STATUS.md at Pass 66 for the 200-line cap, nothing dropped

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 56 | Put `test:cov` on `pnpm checks` | 2 | S | **Proved again Pass 60**: `6029d72` shipped five uncovered branches and only an A/B revert found them. One line, once the `v8 ignore` annotations are spot-checked |
| 58 | Retire or re-scope the spot half of the universe | 1 | M | 191 spot consults → **0** entries under v10 (P(0) ≈ 3.8e-4); **14 lifetime spot `open_long`, zero `open_short` ever**; spot realized PnL **−$8.01 over 7 lifetime entries**, and Pass 62 measures **−190.1 bps/trip mean on n=7 — 4× worse than perp, but n=7 is not a basis for a venue decision.** **Justify on EXPECTANCY, never on cost.** Confounded with v10 `inverted`. Remedies: `LOG.md` § Pass 58 |

Row **57 CLOSED 2026-08-03 with a measured answer** (decoupling artifact +21.0 bps/trip, CI [+1.4, +39.8] — it FLATTERS the demo book, so it cannot be what makes it negative; `studies/frame-audit-2026-08-03.md`). Rows **54/55** moved in full to `charter.md` § Backlog closed ledger; **18/44/45/47** retired OBSOLETE 2026-07-30. **Do not re-open one because its gate has cleared.**
