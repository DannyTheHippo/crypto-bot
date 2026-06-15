# Edge-search program — summary & deploy — 2026-06-15

The mission: a reliably profitable, statistically-validated strategy on the bot. This program built a
rigorous validation harness, searched for a fee-surviving edge across long/short/maker forms, and
deployed the best-of-breed candidate to the demo bot as a labeled experiment. **Honest outcome: no
strategy clears step-D validation; the durable deliverables are the harness + three documented
rejections + a labeled experimental strategy on testnet.**

## Phase 0 — validation tooling (the certifier)

`test/backtest/stats.ts` implements the step-D standard per Bailey & López de Prado: standard-normal
Φ/Φ⁻¹ (Abramowitz-Stegun erf + Acklam inverse), per-trade Sharpe, **t-stat**, **deflated Sharpe (DSR)**
via the False Strategy Theorem, **MinBTL**. `walk-forward.ts` (anchored+rolling, lead-in excluded) and
`cv.ts` (purged+embargoed K-fold). The **4-part gate**: `tStat>3.0 AND DSR>0.95 AND trades≥MinBTL AND
walk-forward OOS positive in every segment`. Validated against known inputs; a clean synthetic edge
passes, and the two prior closures (EMA, mean-rev) still **FAIL** — the certifier is calibrated.
Adversarial review (opus): all eight estimators correct; one fail-OPEN `psr` clamp fixed to fail-closed.
See `validation-study.md`.

## Phase 1 — long directional battery → REJECTED

Pre-registered Donchian breakout, dual-timeframe momentum, vol-regime trend, ADX-regime trend (16
combos × 4 intervals = 64 trials). **All four classes FAIL** the gate (cumulative N=272, V=0.063).
Profitable: 0/64 @ 10 bps, 0/64 @ 7.5 bps (BNB), 13/64 @ 0 bps — it is the strategies, not fees. Every
best candidate has _negative_ full-sample Sharpe. See `long-battery-study.md`.

## Phase 2 — maker / market-making → REJECTED

`fill-models.ts` MAKER_RESTING model (optimistic about fills, so a loss is robust). Across every
offset {0,0.5,1,2,5} bps and interval, the maker book is **net-negative**; spread capture (≤5 bps)
cannot cover the ~20 bps round-trip with **no maker rebate at Binance spot VIP0**. Fill rate falls with
offset (adverse selection). Market-making this pair at this tier is structurally loss-making. See
`maker-study.md`.

## Phase 3 — shorts (plumbing + research) → REJECTED; live execution DEFERRED

Production plumbing (Strategy→Risk→Execution wall intact, no signature widening): `ENTER_SHORT`/
`EXIT_SHORT` signal kinds, exhaustive sizer `orderForKind`, **directional E3 net-exposure headroom**
(a net-short book can no longer breach −maxNet), `EXIT_SHORT` added to the DRAINING risk-reducing set.
The halt coordinator now covers a short instead of abandoning it. All gated green at 100% coverage.
Research: short mean-reversion + long/short EMA (52 trials, cumulative N=324) **both FAIL**. **Shorts are
not live-deployable** (spot venue can't short) — a futures/margin venue is DEFERRED (no edge justifies
the build).

## Phase 4 — best-of-breed selected, promoted, wired, deployed

No candidate passed step-D. The honest best-of-breed by the metrics is in fact the **EMA-cross
incumbent** (the only positive long Sharpe, +0.009); every new candidate underperformed it, and among
the new candidates the metric-least-bad was the **vol-regime trend** (SR −0.030 / −2.79%) — still a
loser. The promoted experiment is the **Donchian breakout** (`src/domain/strategy/donchian-breakout.strategy.ts`,
SR −0.045 / −3.02%), selected **not** as the least-bad but as the cleanest, most **distinct** standalone
hypothesis (a pure price-channel edge, not an EMA-plus-filter), to exercise the strategy-selection
capability with a genuinely different strategy. It is wired behind a new **`ACTIVE_STRATEGY`** env switch
in `app.module.ts` (**default `ema-cross`**, env-selectable). EMA-cross remains the documented validated
default; the live gate (`PROMOTION.md`) is untouched and no unvalidated strategy can reach live.

**Deployed** to the demo/testnet bot on **:3100** with `ACTIVE_STRATEGY=donchian-breakout`,
**pinned to the characterized best-of-breed Donchian config: `STRATEGY_INTERVAL=1h`,
`DONCHIAN_ENTRY=55`, `DONCHIAN_EXIT=20`** (the `55/20 @ 1h` grid trial whose backtest is SR −0.045 /
−3.02%). Labeled UNVALIDATED in the boot log + this report + `state.json`. Risk engine fully binding.

> **Config-coherence correction.** The first deploy ran the strategy's _code default_ `20/10 @ 1m`
> (`STRATEGY_INTERVAL` unset ⇒ 1m), which is **not** the characterized config — a focused re-measure at
> VIP0 fees shows `20/10 @ 1m` is SR **−0.7758** / **−23.11%** (521 trades), far worse than the cited
> −0.045; `20/10 @ 1h` is SR −0.086 / −9.46%; only `55/20 @ 1h` is the −0.045 / −3.02% the report quotes.
> Citing −0.045 while running `20/10 @ 1m` mis-described the bot, so the deploy was pinned to `55/20 @ 1h`
> — the deployed config now matches the number on the page.

### Soak

- **First deploy (`20/10 @ 1m`, bootId `c691a01e`):** exercised the **full round-trip** end-to-end — the
  promoted Donchian fired `ENTER_LONG` → **BUY 0.0015 BTC @ 66648.43** (15:07) and then, on a 1m
  channel-breakdown ~24 min later, `EXIT_LONG` → **SELL 0.00149 BTC @ 66717.98** (15:31); both legs sized →
  risk-approved → submitted → **filled on the demo venue** (signals table: `ENTER_LONG`×1, `EXIT_LONG`×1;
  `donchian-1` `realized_pnl` **+0.0042 USDT** net — exit above entry; one trade, not the edge, the
  strategy's backtest expectation is negative). A 0.0000085 BTC stepSize remainder is left as dust.
  `/health/ready` 200, zero error/warn logs. This proved the promoted strategy autonomously drives **both
  legs** of the Strategy→Risk→Execution→Adapter path under the live risk engine.
- **Config-correction redeploy (`55/20 @ 1h`, bootId `71d3c433`, env-only recreate, image unchanged):**
  `Up (healthy)`, `/health/ready` 200 (effectiveMode=testnet, killSwitch RUNNING, db up, event-loop p99
  ~29 ms), `/health/live` 200; boot log confirms `BTC/USDT 1h entry=55 exit=20 baseNotional=100`; host
  consuming market data; **zero error/warn logs** (only the deliberate UNVALIDATED-experiment warn). At a
  55-bar `1h` channel a fresh breakout entry is not expected inside a short soak — the execution path was
  already demonstrated above; this redeploy confirms the **correct** config boots clean with risk binding.
- DB: 36 fills, 98 order_events (FILL 36 / ACK 31 / SUBMIT_SENT 31; the +1-each vs the entry-only snapshot
  is the donchian-1 exit leg), 31 orders all in a **terminal DB state** (28 FILLED + 3 PARTIALLY_FILLED — no
  order in a NEW/working state); the runtime tracks none as open (`openOrders=0 inFlight=0`). (The
  non-completing reconciler means venue-side remainders can't be independently confirmed — the claim is the
  DB record + the runtime view, not that the venue holds nothing.)
- CAVEAT (honest): deploying via recreate on the preserved DB carries prior positions forward. After the
  round-trip closed, `donchian-1` is **effectively flat** (0.0000085 BTC stepSize dust, `realized_pnl`
  +0.0042). The genuine orphan is **`ema-1`** (0.00150741 BTC @ 66554.84, `realized_pnl` −0.84) — left open
  by the earlier `ACTIVE_STRATEGY` switch from ema-cross to donchian; the donchian strategy manages only its
  own attribution and will not flatten the ema-1 lot. There are **no orphaned open orders** (an earlier
  draft's "29 open orders" figure was not supported by the DB — all orders FILLED/PARTIALLY_FILLED, none
  working). Not a defect — a consequence of switching `ACTIVE_STRATEGY` without flattening (the plan
  specified `up -d`, not `down -v`); a production strategy-switch would flatten first. The pre-existing
  periodic venue-reconciler still does not complete on the demo account (unchanged from prior deploys).

## Verdict

The deliverable is exactly the honest expectation set at approval: a rigorous validation harness, three
documented rejections (long battery, maker, shorts), short plumbing, and a clearly-labeled experimental
strategy on testnet. **No validated winner exists on BTC/USDT in any form tested** — long or short,
trend or reversion, plain or regime-conditioned, taker or maker. EMA-cross stays the env-default; live
promotion remains gated on a real step-D pass.
