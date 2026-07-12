# Autonomy & profitability research — 2026-07-12 (owner-directed session)

Deliverable of the owner's `/goal`: the best path to a fully self-learning, fully automatic agentic
lane — live-money arming as the only human step — that is genuinely profitable. Evidence base: a
12-agent research fan-out (6 repo deep-reads with file:line citations, 6 web research sweeps),
live promtool/DB probes against the running stack, and the Anthropic pricing reference. Every
claim below carries its evidence; nothing is a guess. Constraints were explicitly opened by the
owner for this session ("any existing constraint, owner decision, or gate is open to change").

## Executive summary

The learning machinery now works mechanically (mint → A/B → attributed verdict), but it cannot
produce profitability as built, for three compounding reasons. (1) **The strategy class has
measured zero edge**: the 52-bucket diagnostic found no seams, every 15m bucket loses 12–13bps/RT
out-of-sample, live decides average 0 to −3bps against a fee wall that is exactly 20bps on demo
(measured from the fills table this session: flat 10bps per leg, maker and taker identical, no
discount — fee levers cannot move demo PnL at all). (2) **The learning loop is statistically
hollow and throughput-crippled**: promotion is a bare mean comparison (candidate n≥10 vs champion
n≥1, no variance treatment), one candidate at a time, ~25% A/B share, with two real defects found
this session (A/B-routed contamination of reflection/evaluator reads; silent candidate orphaning).
At 2–4 trips/day on an 8–36% duty-cycle host, one candidate verdict takes weeks and is noise when
it arrives. (3) **The information diet is price-only**, and the literature is consistent that LLM
alpha on OHLCV-only diets is not credible (memorization-confounded backtests; documented value
concentrates in news/text processing).

The path: fix the loop's integrity defects and measurement starvation now (days); move candidate
evaluation offline-first onto the real settlement harness with honest-N statistics, using only
post-training-cutoff data (weeks); re-point the strategy toward where the evidence says edge can
exist — higher timeframes (the only positive bucket is BTC-4h) and an event/context diet from free
feeds — and let the existing A/B attribution decide; run the stack on an always-on host (the
single cheapest multiplier: everything accrues 3–10× faster); and close the six concrete gaps
between today and a genuinely one-touch live arming. If, after that, the gate still reads net<0,
the system is correctly refusing to go live — the gate's integrity is the product.

## What was measured this session (live stack, 2026-07-12 ~16:00Z)

- Gate since the 08:30Z epoch: RT=3 (all v1), net −$1.29, LLM $0.91, ready=0; v2 unresolved in
  A/B with zero attributed trips; reflection primed 1/2 on agentic-1/-2/-5.
- Duty cycle 36%/24h (`count_over_time(up[24h])/5760`); the Pass-17 low was 8%.
- Post-plan-fix behavior shift: 5 decides since the 14:42Z boot, 3 proposed (the 100%-hold era is
  over; throughput is now real but small).
- Cache: `cache_read=0`, `cache_creation=15928` this boot — the 1h-TTL cache is structurally
  mismatched with plan-mode call gaps (plan-managed symbols only consult the LLM every 16 bars =
  4h) and the A/B prefix split; most calls miss.
- Fills table: 42 fills, all with real venue fees; measured fee rate exactly 10.000bps on both
  maker (25 fills) and taker (17 fills) legs. Roughly half of fee spend is the taker exit legs
  (all exits are crossed IOC by construction).

## Diagnosis — five load-bearing findings

### 1. No edge in the current strategy class, and prose mutation cannot create one

In-repo: the edge diagnostic (52 selection-corrected buckets) found zero seams; all 15m buckets
(including all five deployed alts) lose 12–13bps/RT net out-of-sample; the best adequately-sampled
cell is BTC-4h at +10.2bps/RT (61 holdout RT, deflated Sharpe 0.152 vs the 0.95 bar). Live decide
calibration: ≈0 to −3bps next-bar at every confidence bucket. Carry is NO-GO 0/126 (but see the
methodological caveat in Phase 2 below).

Literature (12-agent sweep, primary sources in the session evidence files): no credible LLM alpha
from price/technical-only diets; Profit Mirage (2025) shows 51–72% backtest performance decay
post-training-cutoff — LLM trading backtests are systematically inflated by price-history
memorization; the documented LLM edge concentrates in news/text processing (Lopez-Lira & Tang;
StockBench; FS-Reasoning); no independently verified real-money live LLM track record exists
anywhere in the surveyed literature; retail 15m directional trading of majors clearing fees has no
credible quantified support. Reflection/memory-loop gains (FinMem-style) are backtest-only and
memorization-confounded.

Consequence: iterating playbook PROSE on a 15m price-only lane optimizes inside a class with
measured zero edge. The lane's demo gate (live round trips, net-of-cost) is the correct honest
instrument — the literature validates exactly this design — but the strategy being measured needs
to change for the gate to ever go green.

### 2. The learning loop is statistically hollow and loses candidates silently

- **Promotion verdict** (`promotion-evaluator.ts:156-189`): bare Decimal mean comparison of net
  per attributed trip; candidate needs ≥10 trips, champion needs only >0 (one historical trip can
  seat the baseline); no variance, CI, or significance treatment anywhere in src/. At n=10 the
  minimum detectable effect is far larger than any plausible edge — this promotes noise.
- **Contamination defect (found this session)**: reflection's "current playbook" read + mint
  `parentVersion`, AND the evaluator's champion identity, source from the A/B-ROUTED provider
  (`app.module.ts:1095-1109`, `reflection.service.ts:603`, `promotion-evaluator.ts:149-151`). At
  AB_PCT=25, ~25% of reads see the CANDIDATE as champion: reflection revises against the wrong
  parent (corrupted lineage) and the evaluator self-excludes and silently no-ops that round. An
  unrouted `active()` read already exists (`app.module.ts:893-899`) — the fix is an S-effort swap.
- **Orphaning defect**: `runReflection` has no unresolved-candidate guard (unlike
  `scripts/playbook-candidate.mjs:160-172`, which refuses) — a new mint permanently strands the
  prior candidate below its 10-trip floor with zero telemetry. Single-candidate routing
  (`app.module.ts:838-854`, always the newest) plus the lane-wide one-promotion-per-UTC-day index
  serialize everything downstream.
- **No numeric-knob learning**: prescreen thresholds, RR/edge floors, TP/SL bounds are static env
  config; the loop mutates prose only. The zero-LLM plan-param sweep
  (`test/eval/agentic/plan-param-sweep.spec.ts`) runs the REAL `evaluatePlan()` and could tune
  TP/SL/maxHold against the accrued corpus today at $0 — it has never been pointed at real rows.
- **Offline evidence is disconnected**: scorecards (`counterfactual-scoring.ts`) feed reflection's
  prompt but never the promotion verdict; the deflated-Sharpe/honest-N apparatus
  (`test/backtest/stats.ts`, `trial-registry.ts`) registers zero agentic-lane trials.

### 3. Measurement is starved exactly where the learning needs it

- `input_payload` persists only on real LLM calls; plan-managed quiet bars journal NULL unless
  `AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS > 0`. Verified in-container this session: it IS deployed at 4
  (a research subagent claimed it was unset — wrong), so the corpus accrues (172/200 at Pass 20).
  The real remaining starvation is the next bullet.
- Plans (entry/TP/SL/maxHold) are never persisted on `agent_decisions`, so no recorded decision
  can ever be replayed through the real settlement harness (`test/backtest/harness.ts` — a
  genuinely production-grade path: real `applyFillToPosition`/`walkRoundTrips`, next-bar-open
  fills, funding). `RecordedAgenticStrategy` can only replay flattened long/flat/hold.
  `LiveAgenticStrategy` (the class that would wire the real plan-executor into the harness) is an
  explicit skeleton.
- The fee model the LLM reasons with is hardcoded in three independent places (prompt
  `roundTripBps` 20, plan-viability `feeFraction`, `REFLECTION_ROUND_TRIP_FEE_BPS=20`) and never
  reads the venue truth. On demo they happen to be exactly right (20bps RT measured); on live with
  BNB discount or maker fills they would all be stale.

### 4. Duty cycle is the cheapest multiplier in the whole program

Host duty cycle was 8%/24h at Pass 17 and 36%/24h now. Trips, reflection cadence, A/B verdicts,
corpus accrual, and the loop's own scheduled passes all scale linearly with uptime. An always-on
host (small VPS or Mac mini; compose is portable, §5 backups cover the DB, restart policy already
ships) is a 3–10× evidence-velocity multiplier for ~$10/month — no in-repo change competes with
that per unit effort.

### 5. "Fully automatic up to the flip" has six concrete unfinished gaps

- `ARM_PRECONDITIONS` — the documented arm-time check (kill switch RUNNING, reconciliation clean,
  no unresolved orders) — is a hardcoded always-`{ok:true}` stub (`mode-control.module.ts:31,82`);
  `hasUnresolvedOrders()` has zero production callers.
- ~57 `SUBMIT_UNKNOWN` zombie rows (backlog #25) will trip the (fixed) precondition someday.
- The 2026-07-10 wipe left a live-mode ACKED fixture order; boot-recovery would re-register it as
  a phantom open order on the first live boot → immediate reconciliation mismatch/HALT. Needs a
  legitimate terminal order_event stamp (W7 backfill precedent), never an UPDATE/DELETE.
- Risk limits are sized for a 100–1000× larger account (MAX_DAILY_LOSS=5000 vs $1k–5k capital) —
  the breakers would never bind at target capital.
- No arm-ceremony CLI exists (today: two manual HTTP calls plus a hand-computed HMAC inside a 60s
  TTL). One script makes arming genuinely one human action.
- The arming endpoints have zero auth beyond the CONFIRM HMAC and are published on 0.0.0.0:3100
  (runbook claims "localhost-bound + token-authed" — it is not).

## The path (recommended execution order)

### Phase 0 — always-on host (owner-side, day 1)

Move the compose stack to an always-on machine, or keep the MacBook awake on AC + auto-login.
Everything below accrues evidence 3–10× faster. This was already flagged (Pass 17); this session's
finding is that it now gates the entire learning-loop redesign, not just convenience.

### Phase 1 — learning-loop integrity (SHIPPED this session — see "Applied this session")

1. Route reflection + promotion-evaluator playbook reads through unrouted `active()` (S).
2. Add the unresolved-candidate guard to `runReflection`, mirroring the CLI's check (S); define
   candidate lapse (e.g. N days below floor ⇒ lapsed, next mint allowed) so it cannot stall.
3. Statistical floor on promotion (M): symmetric evidence floors (champion ≥ same n as candidate
   over the same window) plus a variance-aware rule — bootstrap probability-of-superiority with an
   explicit threshold beats a hard t-test at these n; document the minimum detectable effect.
4. Corpus accrual: quiet-bar payload sampling is already deployed at 4 (verified in-container);
   the remaining gap is persisting the submitted plan fields on `agent_decisions` (M, additive
   nullable analytics columns — scoped migration exception applies) so recorded decisions can be
   replayed through real settlement.
5. Fee truth: consolidate the three hardcoded 20bps sites onto one source fed from measured fills
   (S/M). On demo this is a no-op by value (20bps is correct); it is a prerequisite for live parity.

### Phase 2 — offline-first evaluation engine (week 1–2)

1. Point the zero-LLM plan-param sweep at the real corpus (S, $0) — first numeric-knob tuning.
2. Register agentic-lane trials in `trial-registry.ts`/experiments so every scorecard passes
   honest-N deflation (M). Also: winsorize per-cell Sharpe in the deflation variance — the carry
   study's NO-GO was partly an artifact of a structurally degenerate DSR gate (SR0\*=140.41 from
   thin-sample outliers); the fix matters for every future study's credibility in both directions.
3. Build the LLM-in-the-loop walk-forward backtest on `harness.ts` (L): async decide pre-pass,
   enforced $ budget, resting-order model; **post-training-cutoff market data only — Feb 2026
   onward** (Sonnet-5's verified training cutoff is Jan 2026) to dodge the memorization confound;
   label OHLCV-fidelity limits. Before the L-effort spend, run the ~$5-10 de-risking experiment:
   replay accrued payload rows with and without orderBook/ticker fields and measure decision
   agreement — low agreement refutes the OHLCV-only premise cheaply. Batch API halves eval cost;
   ~$25/candidate at 4h granularity fits the existing ≤$20-per-gate budget envelope.
4. Re-architect promotion: offline verdict (walk-forward, DSR-corrected, real settlement) becomes
   the PRIMARY gate; live A/B becomes a confirmatory non-inferiority check; allow K parallel
   candidates in A/B (M/L) and widen the one-promotion-per-day index scope to match. GEPA-style
   Pareto candidate search (20–100 rollouts per improvement, per the literature) becomes viable
   the moment the offline verifier exists — that is the actual self-learning engine.

### Phase 3 — strategy re-pointing (the profitability bet, week 2+)

1. Higher timeframes — offline only until proven (amended by adversarial review): extend the edge
   diagnostic per its own stated follow-ups ($0: wider ATR-k grid past 3, per-timeframe
   maxHoldBars sweep on BTC/ETH 4h/1d, honest-N registered), and evaluate 4h agentic candidates
   through the offline harness (~$25/candidate) rather than a live lane. A live 4h lane is gated
   on BOTH a gate-passing cell in that extension AND a 24/7 host (a 4h lane on a sleeping host
   holds overnight positions with unenforced stops), and costs M-L plumbing (per-strategy
   intervals are not wired: global `STRATEGY_INTERVAL`, first-spec channel merging, interval-blind
   candle routing and stamping).
2. Event/context diet (amended by adversarial review): build a minimal PROMPT-BLOCK A/B mechanism
   first (UTC-minute bucketing like the playbook router, promptHash-attributed, symmetric floors) —
   without it every feed block is unmeasurable, which is already true of the derivatives block
   (ON lane-globally since 2026-07-10 with no control arm). Then: measure the derivatives block
   first, F&G daily regime gate second; skip RSS headlines and unlocks until any block shows
   attributed lift. CryptoPanic's free tier is dead (April 2026); X has no free tier; Reddit is
   ToS-ambiguous — skip paid social entirely.
3. Fee levers — live-parity only, deprioritized on demo (measured: maker=taker=10bps flat, no
   discount ⇒ zero demo PnL effect): `ENTRY_ORDER_TYPE=LIMIT_MAKER` flip and a maker-exit path for
   take-profit exits become worthwhile at live arming, alongside BNB fee payment (25% spot
   discount) on the live account. Perp venue stays parked: carry is NO-GO, directional edge is
   absent, and B3/INT-B3 wiring is L-effort with reviewer+security-auditor gates — fee rate alone
   does not justify it.

### Phase 4 — one-touch live arming (parallel, anytime)

Wire `ARM_PRECONDITIONS` to the real checks (S); sweep the 57 zombies via a journaled one-time
resolution (M, OMS-owner scope); terminalize the ACKED fixture row via a legitimate terminal event
(S); right-size risk limits for $1k–5k (S); ship the arm-ceremony CLI (S); put auth/localhost
guarding on `/api/v1/mode/arm/*` (S). None are large; all are currently unresolved; together they
make "one human step" literally true and safe.

### Cost governance (continuous)

Current spend ($0.9–2.5/day) is fine against the $5 breaker but is 18–91bps/month of drag at
$1k–5k capital — LLM cost is a first-class term of the objective at target scale. Levers: the 4h
lane cuts decide volume ~4×; run reflection through the Batch API (50% discount, latency-tolerant);
re-examine the 1h-TTL cache after cadence changes (it misses most calls today); run the E2
decide-model eval when the corpus crosses 200 rows (Haiku 4.5 is 3× cheaper if parity holds); note
Sonnet-5 intro pricing ends 2026-08-31 (+50% after).

## Do-not-do list (evidence-closed)

- Perp/shorts wiring for fee reasons alone (carry NO-GO; no directional edge to port).
- Prescreen loosening for throughput (surfaces more −EV bars; Pass-11 finding stands).
- Wall-clock reflection triggers (re-chews stale evidence; Pass-10 finding stands).
- Passive market-making on majors (uncompetitive vs institutional HFT; literature unanimous).
- Paid social sentiment (X no free tier; Reddit ToS risk; LunarCrush/Santiment paywalled).
- Trusting any backtest Sharpe >~1.5 without deflation (walk-forward literature: honest
  out-of-sample collapses to ~0.3; in-repo DSR apparatus exists — use it).
- Weakening the live gate toward backtest-based promotion (the literature specifically validates
  the current live-demo-round-trip design as the correct mitigation for memorization-inflated
  backtests).

## Adversarial review (verdicts — amendments folded into the phases above)

Four contestable calls were independently red-teamed by a read-only reviewer with repo access:

- **1h/4h live lane: REFUTED as justified; backtest extension CONFIRMED.** The +10.2bps BTC-4h
  cell is evidence about the retired deterministic seed rule, not LLM decides — funding a live
  lane off it is a category error. Worse, on a 36%-duty-cycle host a 4h lane holds overnight
  positions with in-process-only stops unenforced most of the time. And per-strategy intervals are
  NOT plumbed (global `STRATEGY_INTERVAL`; `MarketDataService` stamps every candle with the first
  spec's interval; the host routes by symbol only) — real effort M-L across 4 seams. Do: the $0
  backtest extension (wider k, per-TF maxHold) and evaluate 4h via the offline harness instead.
- **Event/context diet: AMENDED (narrow).** No prompt-block A/B mechanism exists — the derivatives
  block has been ON lane-globally since 2026-07-10 and is therefore UNMEASURABLE; adding more
  unmeasured blocks repeats that mistake. Build a minimal prompt-block A/B first, measure the
  already-on derivatives block, then F&G as a daily regime gate; skip RSS/unlocks until any block
  shows attributed lift. Queue math: ≥30 matched RT/arm ≈ 30-60 days per block at current cadence —
  the lane can afford 1-2 block experiments, ever, until throughput rises.
- **Offline-first promotion: DIRECTION CONFIRMED, premises corrected.** Sonnet-5's training cutoff
  is Jan 2026 (verified) — the clean backtest window is **Feb 2026 onward** (~960 4h bars/symbol,
  growing weekly). Cost ~$25/candidate holds at 4h; at 15m x 5 symbols it is ~$1,000 — offline-first
  applies to coarse GO/NO-GO verification of few candidates (GEPA-style), not fine ranking.
  Cheapest de-risking first: replay accrued payload rows with and without orderBook/ticker fields
  (~$5-10) to test whether an OHLCV-degraded prompt even predicts live behavior.
- **Statistical floor: CONFIRMED with parameters** — PoS ≥ 0.70 (not a significance test: any
  alpha ≤ 0.05 at n=10 has single-digit power and stalls the loop for quarters; 0.70 cuts the
  null false-promote rate from ~50% to ~25-30%), symmetric champion floor, and the two structural
  fixes as prerequisites. End state: live A/B carries zero promotion authority (non-inferiority
  veto only) once the offline verifier exists.

## Applied this session (implemented, gates green, deployed)

The **self-learning engine v2** package — every Phase-1 item plus the cache root-cause fix —
implemented inline, full gates green (build, lint, typecheck, format, 1718 unit / 41 livegate /
11 paper / 15 eval):

1. **Unrouted `active()` reads** in reflection (revision basis + parentVersion) and the promotion
   evaluator (champion identity) — the ~25% A/B contamination class is closed.
2. **Unresolved-candidate guard** in `runReflection` (pre-budget, trigger-preserving) with a
   720h lapse (`AGENTIC_CANDIDATE_LAPSE_HOURS`) — silent candidate orphaning is closed. Live
   consequence: while v2 sits unresolved in A/B, reflection outcomes will read
   `skipped_unresolved_candidate` instead of minting v3 over it — that is the fix working (and it
   resolves Pass 17's shadowing watch in the safe direction).
3. **Statistically honest promotion**: symmetric attributed-trip floors (champion ≥10 in-window
   too) + Mann–Whitney probability-of-superiority ≥ `AGENTIC_PROMOTE_MIN_POS` (0.70) on top of the
   mean comparison. Live consequence: v2's verdict now also waits for champion v1 to accrue 10
   post-epoch trips — slower, honest.
4. **Playbook knobs channel** (novel capability): one optional validated
   `knobs: minConfidence=… minRr=… minEdgeMultiple=…` line per playbook; tighten-only semantics
   enforced deterministically in the client (new entries only — exits and re-arms are never
   gated); bounds validated at mint AND read; reflection's prompt documents the channel and points
   it at the calibration digest. The loop's first parametric degrees of freedom, attributed per
   version for free.
5. **Symbol-agnostic cached prefix** (cache_read=0 root cause): per-symbol venue minimums moved
   from the system prompt into the payload `constraints` field; template versions bumped v4→v5,
   p2→p3 (honest promptHash flip; both A/B arms share the template).
6. **Eval price-table fix**: Opus 4.8 $15/$75 → $5/$25 in `candidate-model-eval.spec.ts` (the
   deployed gate map was already correct; only offline scorecard projections were 3x overstated).

Also verified directly this session (correcting two research-agent claims before they misled):
quiet-bar payload sampling is already deployed at 4, and demo fees are real — measured exactly
10bps per leg, maker and taker alike, from the fills table.
