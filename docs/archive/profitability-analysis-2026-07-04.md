# Agentic lane — profitability analysis (2026-07-04)

> **ARCHIVED (2026-07-18):** point-in-time incident analysis. The root-cause signal-TTL bug it
> documents was fixed the same week (referenced as historical precedent in
> `docs/planning/daily-profitability-loop.md` § Decide); the "spot cannot hold a short" scope-out in
> §6 of the companion design spec was later reversed by the v2 perp-shorts program. Retained as
> historical record only.

Data-grounded review of the live demo (boot `6f50ba98`, `mode=testnet`, `BTC/USDT` 5m) combining
prometheus, docker logs, and code. Objective: **net return, cost-aware** — maximize net paper
return while accounting for LLM inference cost. Scope: everything (structural + in-envelope).

Live queries this session were limited to prometheus (`promtool`) + `docker logs` + code;
`psql` was environment-blocked, so per-row `signals`/`equity_curve`/`agent_decisions` detail is
inferred from prometheus counters + code (flagged where it matters).

---

## 1. What the running bot is actually doing

| Signal                              | Value                                             | Source                                                     |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Lane client                         | **LIVE** (`anthropic`), not stub                  | `agent_client_info{kind="anthropic"}=1`                    |
| Lifecycle / kill-switch             | ACTIVE / RUNNING, mode testnet                    | `strategy_lifecycle`, `kill_switch_state`                  |
| Decisions since boot (~2.49h)       | **30** (18 `proposed`, 11 `hold`)                 | `agent_decide_total`, `agent_decide_latency_seconds_count` |
| Decide latency                      | p50 **7.6s**, p95 **17.5s**                       | `agent_decide_latency_seconds`                             |
| Signals expired at gateway          | **11** (`EXPIRED`, `GATEWAY_REJECTED`)            | `signals_rejected_total`                                   |
| Orders submitted / rejected         | **0 / 0** (metric series absent)                  | `orders_*` all empty                                       |
| Fills / round trips                 | **0 / 0**                                         | `fills_total=0`, `round_trips_total` empty                 |
| Equity / starting cash              | **5000 / 5000** (flat)                            | `equity_usdt`, `starting_cash_usdt`                        |
| Realized + unrealized PnL, drawdown | **0 / 0 / 0**                                     | `*_pnl_usdt`, `drawdown_ratio`                             |
| Playbook version                    | **seed v1** (never promoted)                      | `agentic_playbook_info{version="1"}=1`                     |
| Tokens since boot                   | 145,559 in / 8,622 out (avg **~4,900 in/decide**) | `agent_tokens_total`                                       |

**Headline: the agent is live and deciding, but it has executed zero trades and made zero PnL.
Its only observable order-path effect is 11 expired signals. Meanwhile it is spending real money
on Opus.** Every trading-edge improvement is worth nothing until orders actually execute.

---

## 2. Root cause of zero trades (correctness bug — CRITICAL)

The signal TTL is checked in a **different clock domain** than the timestamp it is measured from.

- A closed candle is normalized with **`eventTime = candle openTime`** (`market-data/normalize.ts:182`;
  the same event also carries a correct `closeTime` at `:186`, currently unused for this).
- `decide()` stamps the signal with `input.snapshot.eventTime` (that open time) and
  `ttlMs = signalTtlMs` (`agentic.strategy.ts:150`, `anthropic-agent-client.ts:240-242`).
- The gateway is bound to **wall-clock `SystemClock`** (`app.module.ts:549`) and rejects when
  `SystemClock.now() > signal.eventTime + ttlMs` (`signal-gateway.service.ts:36-39`).
- `SIGNAL_TTL_MS` default = **120 s**; `STRATEGY_INTERVAL` = **300 s (5m)**.

A 5m candle _closes_ (and triggers the decide) at `openTime + 300s`; after the ~8–17s Opus call
the ENTER_LONG signal reaches the gateway at wall-clock ≈ `openTime + 310s`, but its
`expiresAt = openTime + 120s`. **It is ~190 s past expiry the instant it is created — deterministically,
every candle.** This is why ≥11 signals expired and no order ever reached the venue.

(The 18-proposed vs 11-expired gap needs the `signals` table to fully attribute; it does not change
the conclusion — 0 orders / 0 fills is dispositive.)

**Fix options (small):**

1. **Config-only, immediate:** set `AGENTIC`-lane `SIGNAL_TTL_MS` > interval + max latency
   (e.g. 600000 for 5m). Zero code, zero risk.
2. **Code, correct:** measure TTL from the candle `closeTime` (already normalized) or stamp the
   signal `eventTime` at emission wall-clock, so the clock domains match. Add a regression test
   asserting a just-closed-candle signal is not born expired for interval ≥ TTL.
3. Guard against silent recurrence: the design comment in `signal-gateway.service.ts:18-20` assumes
   a replay-stable _event-time_ clock, but production binds _wall_ `SystemClock` — reconcile the
   comment/intent, and add an observability alert on `signals_rejected_total{reason="EXPIRED"}`.

---

## 3. LLM cost vs. return (cost-aware objective)

At ~290 decides/day: **~1.41M input + 0.083M output tokens/day**, for **$0 realized return** —
net-of-cost profitability is currently a pure loss.

- **Model drift is the dominant cost bug.** `.env` sets `AGENTIC_MODEL=claude-sonnet-5` (the
  intended model), but `docker-compose.yml`'s `environment:` block hard-set `claude-opus-4-8`, and
  compose `environment:` overrides `env_file`, so the **running container was actually on Opus** (the
  boot log's `5m` — also a compose override of `.env`'s `1m` — confirms the override block is active).
  At the dashboard's placeholder Opus pricing ($15/$75 per-Mtok) that is **~$27/day (~$820/mo)**;
  honoring the intended Sonnet-5 (~5× cheaper) drops it to **~$5/day**. _(Verify actual
  `claude-opus-4-8` / `claude-sonnet-5` pricing.)_
- **Prompt caching is a no-op here** (backlog F6's conclusion holds, though for a different reason
  than stated). Total input is ~4,900 tok/decide, but that is dominated by the _variable_ payload
  (the sliding 50-candle window + recentDecisions). The _stable_ cacheable prefix (system prompt +
  tool schema + playbook) is only ~800–1000 tokens — at/below even Sonnet's 1024-token cache
  minimum — and the candle window shifts every call, so no meaningful prefix caches. Not pursued.
- **Remaining cost levers (deferred, with tradeoffs):** trimming the candle count/precision (F5)
  cuts the _dominant_ variable input but needs an eval to confirm decision quality is unaffected;
  a cheap deterministic pre-screen / non-zero `AGENTIC_MIN_DECISION_INTERVAL_MS` cuts call volume
  but changes decision behavior (the model stops seeing every bar). Both are behavioral/quality
  risks, not free wins — left for a measured pass once F1 produces live trade data.

---

## 4. Structural caps on edge (relevant once §2 is fixed)

- **Long/flat only, single symbol, fixed notional.** Agent emits only ENTER_LONG/EXIT_LONG
  (`anthropic-agent-client.ts:247-260`); the sizer + risk engine already support shorts and
  multi-symbol. Long-only forfeits ~half of actionable regimes; fixed `BASE_NOTIONAL` never
  compounds as equity grows.
- **Learning loop is effectively dead.** Playbook is stuck at **seed v1**; reflection mints an
  _inactive_ candidate needing human promotion + restart (`reflection.service.ts:457`), and it will
  never even fire here — it requires 10 closed trades AND a 7-day cooldown, and there are **0 trades**.
- **Feedback is myopic / biased.** Only t+1 forward return reaches the loop; toy scoring excludes
  unrealized/open PnL and counts FLAT as a "hit" when price falls
  (`counterfactual-scoring.ts:115-117,200-236`) — it rewards inaction.
- **Prompt omits collected microstructure.** Order-book depth is fetched but never injected; only
  ticker bid/ask is (`agent-prompt.ts:146-148`).

---

## 5. Ranked findings (cost-aware)

| Rank  | Finding                                                                       | Type             | Impact                  | Effort | Risk                          |
| ----- | ----------------------------------------------------------------------------- | ---------------- | ----------------------- | ------ | ----------------------------- |
| **1** | Signal expiry → zero trades (§2)                                              | correctness      | **Unlocks ALL trading** | S      | low                           |
| **2** | Opus cost for $0 output: enable prompt caching + throttle/pre-screen (§3)     | cost             | ~$27/day → large cut    | S–M    | low                           |
| 3     | Long-only → enable shorts (unlock down-regimes)                               | edge             | High                    | M      | med (Risk still sizes/vetoes) |
| 4     | Learning loop dead: fire + auto-promote reflection w/ guardrails              | decision quality | Med–High (compounds)    | M      | med                           |
| 5     | Equity-scaled / compounding sizing (Decimal)                                  | edge             | Med                     | S–M    | low                           |
| 6     | Richer, less-myopic feedback + inject order-book/regime context               | decision quality | Med                     | S–M    | low                           |
| 7     | Fix scoring biases (mark open positions; stop rewarding inaction)             | eval rigor       | Med (indirect)          | S      | low                           |
| 8     | Multi-symbol (tension w/ cost — multiplies calls)                             | edge             | Med–High                | L      | med                           |
| 9     | Stops / take-profit / trailing (intra-bar risk)                               | risk-adj         | Med–High                | L      | med-high                      |
| 10    | Net-of-cost PnL panel; audit `trade_pnl_usdt` buckets vs live `BASE_NOTIONAL` | observability    | enables measurement     | S      | low                           |

## 6. Implemented + verified this session

**All green** (build/lint/typecheck pass; **1130 tests pass** — the only 4 reds are pre-existing
health-spec failures in the uncommitted WIP, proven unrelated via a stash baseline: 4 fail/1124 pass
without these changes → 4 fail/1130 pass with them, +6 new tests).

- **F1 — signal expiry fix (VERIFIED LIVE).** `anthropic-agent-client.ts` anchors a candle-triggered
  signal's `eventTime` to the triggering bar's `closeTime` (deterministic `openTime + interval − 1`)
  instead of the open-time snapshot stamp, so the gateway's `eventTime + ttlMs` window starts at bar
  close. Regression test added. **After redeploy the live demo went from 0 trades / 100% expiry to
  actually trading:** first ~9 min — `signals_rejected_total` empty (was 11 EXPIRED),
  `orders_submitted_total`=1, `fills_total`=1, an open `position_qty`≈0.0007 BTC (~$100 notional).
  This is the unlock.
- **F2 — model drift → Sonnet-5 (deployed).** `docker-compose.yml` + `.env.example` use
  `claude-sonnet-5` (matching `.env`), fixing the `environment:`-overrides-`env_file` override that
  silently forced Opus (~5× cost). Prompt caching evaluated and NOT pursued (no-op at the true prefix
  size — §3).
- **F4 — gated auto-promotion + live activation (built + tested; dormant until ≥30 trades).**
  Reflection auto-promotes a freshly-minted, validated candidate to ACTIVE once the cumulative
  closed-trade count reaches `AGENTIC_AUTO_PROMOTE_MIN_TRADES` (compose sets 30; 0 disables). The
  promotion append drops the store's cached resolution (`playbook-store.adapter.ts` /
  `in-memory-playbook-store.ts`), so the next decide re-resolves **live, no restart** — the same
  singleton backs reads and writes. Safe by design: the read side (`ValidatingPlaybookProvider`)
  re-validates before the LLM sees any playbook, so the ≥30 gate is about statistical evidence, not
  content safety; a promotion-write failure (once-per-UTC-day cap) leaves the candidate INACTIVE,
  never fatal. 6 new tests. Inert until real trades reach 30.

**Not built — F3 shorts (dropped by decision).** Binance SPOT can't hold a short (a naked SELL is
venue-rejected for insufficient base balance); true shorting needs margin/futures infrastructure out
of scope. The lane stays long/flat.

## 7. Live status & what to watch

The full image (F1+F2+F4) is deployed. F1 is already confirmed trading (above). Over ~30–60 min
watch (prometheus / Grafana): `fills_total` + `round_trips_total{result}` accruing,
`signals_rejected_total{reason="EXPIRED"}` staying empty, the token `$/hr` panel at the Sonnet tier,
and no `degraded` / new risk rejections in `docker logs`. F4 stays dormant until ~30 closed trades
accrue, then a reflection candidate auto-promotes live — watch for the `auto-promoted playbook
version` log and `agentic_playbook_info{version}` advancing past 1.

## Loop pass log

### 2026-07-05 — dust-trap fix (shipped + deployed)

**Data (~2.6 h window, boot 1ddca607):** 31 decides (23 proposed / 8 hold), **F1 holding** (no
`EXPIRED`), Sonnet cost ~$5/day, no risk/order rejections, clean logs. But two problems surfaced:
`signals_rejected_total{reason="BELOW_MINIMUM",stage="SIZING_REJECTED"} = 15`, and
**`round_trips_total` still empty / `trade_pnl_count=0` despite `fills_total=5`, `orders_fully_filled=2`**,
with `position_qty` whittled from 0.0006993 → **0.00002859 BTC (~$2.8, below the $5 minNotional)**.

**Root cause — dust trap.** Passive-limit exits partial-fill and leave a sub-`minNotional` sliver.
`buildContext` reported any `signedQty>0` as `LONG`, so the agent kept proposing `EXIT_LONG` on the
dust; the sizer rejected each as `BELOW_MINIMUM` (`position-sizer.service.ts:88-92`). And because the
position never reaches _exactly_ flat, **no round trip is ever recorded** — silently starving
win/loss + PnL histograms and F4's ≥30-closed-trade gate.

**Shipped (agentic-lane only, all gates green — 1133 tests pass; the 4 reds remain the pre-existing
health-spec failures):** `agentic.strategy.ts` now captures `minNotional` in `onInit` and
`buildContext` reclassifies a held position whose notional (`signedQty × avgEntry`, Decimal — no
float) is below `minNotional` as **FLAT**. The agent then holds or re-enters, and a fresh entry
absorbs the dust into a tradable position. Fail-safe: no `minNotional` ⇒ prior LONG behavior. 3 new
tests. Rebuilt + redeployed.

**Flagged for human review (money-path — NOT changed autonomously):**

1. **Marketable exits.** `EXIT_LONG` sends a passive `LIMIT GTC` SELL priced _above_ mid
   (`position-sizer.service.ts:70-74`, no marketable hint), so exits fill only on an uptick and
   partial-fill into dust. Pricing reduce-only exits marketably (cross to the bid) would fully close
   in one shot and prevent dust — but it's a position-sizer money-path change (crosses the spread,
   taker fee) that warrants review + careful tests.
2. **Dust-threshold round-trip accounting.** `portfolio-state.service.ts` records a round trip only
   at `signed_qty == 0`; a sub-`minNotional` remainder blocks it forever. Treating dust as flat in
   the accounting layer would unblock win/loss/PnL + F4's gate — but it touches realized-PnL
   accounting and append-only order_events, so it needs review.

## Appendix — raw metric readings (boot 6f50ba98, uptime ~2.49h)

```text
agent_client_info{kind="anthropic"} = 1
agent_decide_total{outcome="proposed"} = 18 ; {outcome="hold"} = 11
agent_decide_latency_seconds: count=30 sum=215.68  (p50 7.6s, p95 17.5s)
signals_rejected_total{reason="EXPIRED",stage="GATEWAY_REJECTED"} = 11
orders_total / orders_submitted_total / orders_rejected_total = (absent)
fills_total = 0 ; round_trips_total = (absent) ; trade_pnl_usdt_count = 0
equity_usdt = 5000 ; starting_cash_usdt = 5000 ; drawdown_ratio = 0
agent_tokens_total{kind="input"} = 145559 ; {kind="output"} = 8622
agentic_playbook_info{version="1"} = 1
kill_switch_state{state="RUNNING"} = 1 ; strategy_lifecycle{state="ACTIVE"} = 1
```
