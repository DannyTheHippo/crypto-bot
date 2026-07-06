# Profitability design — agentic lane, staged hybrid

Date: 2026-07-06 · Status: owner-approved design (brainstorming gate) · Implementation: via
agent-pipeline (Stage 0 + Stage 1 first) and the daily loop
(`docs/planning/daily-profitability-loop.md`).

## 1. Problem and goal

The agentic lane is live on the testnet demo and losing money net of cost: latest cumulative
readiness snapshot (2026-07-06, epic close) was **23 round trips, net −$14.52, of which $11.33 was
LLM cost** (~78% of the loss is inference spend; trading PnL ≈ −$3). The owner's goal, decided
2026-07-06:

> **Real live profitability at $1k–$5k capital** — not merely earned-live gate passage, and not
> burn-minimized research.

The demo runs 5000 USDT paper ≈ the target live capital, so demo evidence transfers directly: the
earned-live gate (≥30 closed demo round trips AND net-of-cost PnL > 0 AND ≥14-day window, computed
by `PromotionReadinessService`) **is** the live business case, not just a safety gate.

### Survival math the design must beat (at ~$2.5k midpoint capital)

- **Fee hurdle:** ~0.15–0.2% per round trip (Binance spot, both sides). Fees alone killed all 324
  deterministic strategy trials at the retired step-D gate.
- **Inference drag:** ~$6/day at 2 symbols × 5m cadence on Sonnet-5 ⇒ 0.24%/day ≈ ~90%/yr hurdle
  before the first trade. Target: **≤$1/day** ⇒ 0.04%/day.
- **Known live defect:** `docker-compose.yml` claims 2×288 = 576 decides/day stays under
  `AGENTIC_MAX_CALLS_PER_DAY=500` — it does not; the lane hits the daily call cap and drains every
  day (~hour 21). The 15m move (192/day) fixes the overrun; the comment must be corrected in the
  same edit.

### Approach (owner-selected)

Staged hybrid: **cut inference cost to <$1/day first** (cheap, reversible), then **spend the runway
on learning-loop edge work** (where the uncertainty lives), measured per playbook version. Stage-1
cost mechanism: **15m cadence + deterministic pre-screen** (rejected alternatives: 1h config-only;
5m + pre-screen only).

## 2. Stage 0 — measurement hygiene (hours; blocks everything else)

Trustworthy numbers are a precondition for every later claim.

1. Verify the `agentic_promotion_*` gauges recover post-restart (they read 0 minutes after the
   2026-07-06 restart — likely pre-first-sample of the 5-minute sampler, but unverified) and that
   the readiness walk still counts pre-multi-symbol round trips: the strategyId changed
   (`agentic` → `agentic-1`/`agentic-2`) and old fills carry the old id. Confirm via the gauges once
   sampled, or the read-only SQL in `reports/nightly/PROMOTION.md` § Evidence (owner runs it via
   `! psql`; the sandbox denies psql).
2. Correct the `AGENTIC_MAX_CALLS_PER_DAY` overrun/comment in `docker-compose.yml` (subsumed by the
   Stage-1 15m edit; the false comment is fixed in the same change).
3. Confirm the Grafana "Agentic lane (LLM)" panels (`observability/grafana/dashboards/crypto-bot.json`)
   render **$/day LLM spend** and **net-of-cost PnL** post-restart — the two numbers every stage is
   judged by. Add/repair panels if not.

## 3. Stage 1 — cost floor: 15m cadence + deterministic pre-screen (target <$1/day)

1. **Config (zero code):** `STRATEGY_INTERVAL: '15m'` in `docker-compose.yml` (`15m` is valid —
   `CANDLE_INTERVALS`, `src/config/environment/environment.config.ts:18`). 2×96 = 192 calls/day
   ≈ $2.2/day. Sync `.env.example` (standing rule).
2. **Pre-screen gate (small module + tests):** a deterministic, pure check ahead of the LLM call in
   the decide path (`src/features/trading/agentic/agentic.strategy.ts` `decide()`, :132). Call the
   LLM only when at least one holds:

   - a position is open for the instance (exit management must never be starved);
   - volatility expansion (short-window vs long-window realized-vol ratio above threshold;
     starting default: 10-bar/50-bar stdev ratio > 1.3);
   - breakout proximity (close within a configured fraction of the N-bar high/low; starting
     default: within 0.5% of the 20-bar high or low).

   Starting defaults are knobs, tuned later against the skip-rate counter — the implementation
   plan may adjust them with rationale. Otherwise skip the call and journal a deterministic HOLD.
   Expected 50–70% skip rate ⇒ **~$0.7–1.0/day total**.

   - Observability: `agentic_prescreen_total{outcome="called"|"skipped_quiet"}` counter + panel.
   - Fail-open: any gate error ⇒ call the LLM (never silently starve decisions); log + counter.
   - Boundary discipline: the gate lives strategy-side and only decides _whether to consult the
     LLM_; it emits no signals itself — Strategy → Risk → Execution path untouched (hard rule 2).
   - Config knobs (zod, `environment.config.ts`): enable flag + thresholds, conservative defaults,
     `AGENTIC_PRESCREEN_*` family; documented in `.env.example`.

3. **Unchanged on purpose:** 2 symbols stay (evidence accrual; cost bounded by the gate);
   `ProtectiveExitService` is cadence-independent (ticks on price, not decides), so slower decides
   do not widen unprotected risk; `AGENTIC_MAX_ENTRIES_PER_DAY=12` and drain cooldowns remain as
   outer guards.

**Stage-1 exit criterion:** ≥3 consecutive days with LLM spend ≤$1/day AND round trips still
accruing (≥2/day across both symbols) AND no `EXPIRED`/starved-exit regressions.

## 4. Stage 2 — edge: make the learning loop earn the spend (weeks, measured)

Runs on the Stage-1 cost floor; every change is judged by per-playbook-version net-of-cost PnL.

1. **Fix scoring biases** (`counterfactual-scoring.ts`, flagged in the 2026-07-04 analysis §4):
   FLAT is counted a "hit" when price falls (rewards inaction) and open/unrealized PnL is excluded.
   Reflection can only learn from honest scorecards.
2. **Inject collected-but-unused context** (`agent-prompt.ts:146-148`): order-book depth is fetched
   but never injected (only ticker bid/ask reaches the prompt). Token-budget it — verify
   tokens/decide stays ≤~4k (prompt-v3 trim discipline).
3. **Per-playbook-version attribution:** query/panel attributing realized net PnL to the playbook
   version active at decide time (`agent_decisions` carries the version; join to fills). Without
   this, auto-promotion (`AGENTIC_AUTO_PROMOTE_MIN_TRADES=30`, live activation already shipped) is
   flying blind.
4. **Let reflection iterate:** cooldown is already 24h with DB-seeded counters; watch
   `agentic_playbook_info{version}` advance past 1 and compare versions via (3).

**Stage-2 exit criterion:** ≥2 playbook promotions with version-attributed PnL, and net-of-cost PnL
trending ≥0 over a rolling 7 days.

## 5. Stage 3 — pass the earned-live gate, then human ceremony (unchanged)

- Accrue the ≥14-day window at Stage-1 economics: ≥30 closed round trips, net-of-cost PnL > 0.
- Nothing here automates live: the four gates + bootId-bound arming ceremony + human
  `paper` → `main` merge stay exactly as `reports/nightly/PROMOTION.md` describes. Start live at the
  small end ($1k–2k); compounding sizing (`SIZER_EQUITY_FRACTION`) scales positions with equity.

## 6. Explicitly out of scope (owner decisions / physics)

- Shorts/futures/margin (dropped 2026-07-04: spot cannot hold a short; margin/futures infra out of
  scope).
- Prompt caching (evaluated 2026-07-04 §3: no-op at the true cacheable-prefix size).
- More symbols beyond 2, model downgrades below Sonnet-5, and 1m/5m scalping cadences — all
  re-openable later with Stage-0 measurement in place, not now.

## 7. Critical files

- `docker-compose.yml` — interval, cap comment, prescreen knobs (+ `.env.example` sync).
- `src/config/environment/environment.config.ts` — `AGENTIC_PRESCREEN_*` schema.
- `src/features/trading/agentic/agentic.strategy.ts` (decide path, :132) + new sibling pre-screen
  module + tests (mirror existing agentic test patterns).
- `src/features/trading/agentic/agent-prompt.ts` (:146-148 book-depth injection).
- `src/features/trading/agentic/counterfactual-scoring.ts` (bias fixes, regression tests).
- `observability/grafana/dashboards/crypto-bot.json` (prescreen + version-attribution panels).

## 8. Verification

- Per-change gates: `pnpm build | lint | typecheck | test` all green; money-path rules 1–7
  untouched (`test:livegate` stays sacred).
- Live, after each deploy (promtool): `agentic_prescreen_total` splitting sanely,
  `sum by (kind)(agent_tokens_total)` implying ≤$1/day at the 3/15 per-Mtok rates,
  `signals_rejected_total{reason="EXPIRED"}` empty, round trips accruing, protective exits still
  firing (log check).
- Stage exits as defined per stage; weekly checkpoint against the readiness gauges + PROMOTION.md
  SQL.

## 9. Execution route

1. This spec (owner reviews before implementation).
2. `docs/planning/daily-profitability-loop.md` — the daily autonomous improvement pass that reads
   this spec as its strategic frame.
3. agent-pipeline produces the `## Todo Steps` implementation plan for Stage 0 + Stage 1; Stage 2
   items become their own pipeline pass — or daily-loop passes — once the Stage-1 exit criterion
   holds.
