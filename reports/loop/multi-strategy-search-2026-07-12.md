# Multi-strategy edge search — 2026-07-12 (Fable session)

The broadest systematic-strategy search the program has ever run, built to answer one question the
original edge diagnostic left dangerously narrow: **does the "no directional edge" verdict hold up
when you test far more than the single retired seed rule?** It does — decisively — and the *way* it
fails reshapes the whole profitability strategy.

## What was tested

Self-contained backtest harness (`test/backtest/multi-strategy/`, pure ESM, embedded winsorized
deflated-Sharpe so it neither collides with the concurrent `stats.ts` edit nor needs the vitest
transform). No-lookahead fill model: signal on bar *t*'s close, executed at bar *t+1*'s open, marked
to *t+2*'s open, turnover charged per leg. All metrics are **out-of-sample** (last 30% holdout);
every cell is deflated against the winsorized Sharpe variance of its trial set (Bailey & López de
Prado 2014) and must be walk-forward sign-consistent across 3 holdout sub-segments to survive.

- **7 strategy families**, each parameter-swept: time-series momentum, Donchian breakout, EMA
  crossover, MACD, RSI mean-reversion, Bollinger mean-reversion, ATR volatility breakout.
- **Long-only AND long-short** variants of every family (the owner's "revisit shorts" — measured, not
  assumed).
- **5 symbols** (BTC, ETH, SOL, XRP, LINK) across the timeframes on disk (BTC/ETH 15m→1d; alts
  15m/1h/4h/1d after this session's fetches), ~4 years each.
- **6 fee levels** — 0 bps (FDUSD maker-only), 3.6 (perp maker+BNB), 7.5, 10, 15, 20 (spot taker) —
  grounded in the 2026-07-12 fee research, so a strategy that only works at futures-maker cost is
  visibly distinguished from one that clears spot-taker.
- **Single-cell sweep: 4,092 backtests.** **Portfolio sweep: 150 backtests** (equal-weight 5-symbol
  Donchian basket, a small pre-registered grid — the diversification hypothesis the single-cell
  sweep can't express).

## Result: zero survivors, at any fee level, in either sweep

| Sweep | Cells | Survivors (net>0, RT≥floor, DSR≥0.95, walk-forward consistent) |
| --- | --- | --- |
| Single-cell (7 families × params × 5 sym × TFs × long/short × 6 fees) | 4,092 | **0** |
| Portfolio (Donchian basket, 5 sym × n-grid × 3 TFs × long/short × 5 fees) | 150 | **0** |

The frontier — the best cells, none of which survive:

- **Single-cell best is long-short Donchian trend**, e.g. Donchian(20) long-short on ETH 1h:
  +41 bps/round-trip net *even at full 20 bps spot-taker fees*, annualized Sharpe 1.2–1.5,
  walk-forward sign-consistent. It fails **only** the 682-trial deflation (SR0\*≈4) — the
  multiple-testing penalty for having searched so broadly. Read honestly: this is one cherry-picked
  cell out of 682, not a robust edge.
- **The diversified portfolio is worse, not better.** The complete 5-symbol equal-weight Donchian
  basket tops out at annualized Sharpe **0.44** (4h, n=10, 0 bps), most cells near zero or negative,
  **none walk-forward consistent**, DSR ≤ 0.29 at every fee level including zero. Diversification
  lowered variance but there was too little mean edge to concentrate — crypto's symbols are one
  correlated beta, so the basket regressed to the thin average trend-Sharpe instead of the lucky
  single-symbol tail. This is the clean result (the earlier 2-symbol reading was a data-alignment
  artifact, since fixed).

## Two positive nuggets inside the negative

1. **Shorts add real value.** Every best-per-fee cell in the single sweep is long-*short*, never
   long-only. The retired seed rule's "52 short trials failed" was a property of *that rule*, not of
   shorting — trend-following is symmetric and its short leg carries half the (thin) edge. Any future
   trend attempt should be long-short, which means the **perp venue**, whose 3.6 bps maker fee also
   makes it the cheapest place to run it.
2. **Long-short 1h/4h trend is the frontier** — the closest anything came. If any price-based edge
   exists here, it is diversified long-short higher-timeframe trend on perps, and the honest way to
   confirm-or-kill it is a small **pre-registered forward/paper test** (not another in-sample sweep,
   which only re-inflates the deflation penalty).

## The load-bearing conclusion (this is the one that matters)

**No simple price-based systematic strategy clears an honest out-of-sample deflated-Sharpe bar on
this universe — none, across 4,242 backtests spanning 7 families, both directions, single-symbol and
portfolio, and every fee level from free to 20 bps.** The program's original pessimism was right, but
it now rests on a search ~80× broader than the single rule it was based on.

The implication for the LLM lane is sharp and was not obvious before this search:

> The agentic lane decides on OHLCV + indicators — **exactly the information space just proven
> empty.** No amount of reflection-loop sophistication, prompt tuning, or model upgrade can extract a
> fee-clearing edge from price history that systematically isn't there. The lane's *only* possible
> source of edge is information the price series does not contain: news, events, on-chain flows,
> derivatives positioning.

That is precisely what this session's **derivatives-block A/B mechanism** now makes measurable, and
what the **event/context diet** recommendation targets. It also sets an honest expectation: the
literature (Lopez-Lira; StockBench; FS-Reasoning) puts even the information edge at marginal in
crypto, so the realistic program posture is — keep the demo lane learning at near-zero cost,
instrument each information feed to measure whether *any* of them add attributed net-of-cost edge in
A/B, and **do not risk live capital until the gate genuinely goes green on that evidence.** This
search is strong reason to believe price-pattern trading never will.

## Artifacts

- `test/backtest/multi-strategy/{engine,strategies,sweep,portfolio}.mjs` — the harness (rerun any
  time: `node test/backtest/multi-strategy/sweep.mjs --out <f>`, `… portfolio.mjs --out <f>`).
- `candidates/multi-strategy-sweep-2026-07-12.json` — all 4,092 single-cell results + per-fee
  frontier.
- `candidates/portfolio-trend-2026-07-12.json` — the 150 portfolio cells (with the selection-bias
  caveat recorded in the file).

## Honesty notes

- Research metric: bar-open fills, no intrabar path, no slippage beyond the modeled fee. It screens
  and seeds; it never certifies. The honest-N deflation is what prevents a lucky cell being mistaken
  for edge — and it did its job (it killed the one cherry-picked frontier cell).
- The deflation's 682-trial penalty is genuinely harsh, but the conclusion does not depend on it: the
  raw (undeflated) portfolio Sharpes are ≤0.44 and not walk-forward consistent, i.e. untradeable
  before any multiple-testing correction is even applied.
- Selection-bias caveat on the portfolio test (Donchian was chosen *because* the broad sweep surfaced
  it) is recorded in the JSON; the clean confirmation of the trend lead is forward/paper, not another
  offline slice.
