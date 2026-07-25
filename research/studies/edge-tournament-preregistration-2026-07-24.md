# Profitability edge tournament — preregistration (2026-07-24)

This document freezes the public-data profitability tournament before the full outcome datasets are
downloaded. Parameters, exclusions, cost assumptions, and the winner rule below cannot be changed
after seeing results. Any follow-up parameter choice is a new registered trial.

## Objective and honest prior

The production agentic strategy is net negative after trading fees and LLM spend. The tournament asks
whether one fixed public-data policy has positive net-of-all-costs evidence strong enough to justify a
demo-only forward test. It cannot certify future profitability or authorize live trading.

Prior unique search count:

- 52 seed-rule trials;
- 4,562 price/portfolio/cross-sectional trials;
- 492 funding/Fear-and-Greed directional trials;
- 126 single-venue delta-neutral carry trials;
- one pre-registration exploratory cross-venue funding probe described below.

The six trials in this report bring the disclosed global discovery count to **N = 5,239**. DSR is
reported with that conservative N. Because prior raw Sharpe vectors are not all recoverable, the
variance input is estimated from the six frozen trials and the limitation is stated in the result;
DSR is diagnostic, not the demo-build authority.

## Prior exploratory probe (disclosed)

Before this document was written, a read-only 90-day CCXT probe examined BTC, ETH, and SOL funding on
Binance USDM, Bybit, and OKX. Mean maximum-minus-minimum funding dispersion was approximately
0.46–0.62 bps per aligned settlement. The optimal venue pair changed every 1.25–1.40 settlements on
average. This informed the cost-derived stability rule for trial 5 and is counted above as one
hypothesis-shaping trial. No other tournament outcome data has been fetched.

## Frozen universe and time axis

Directional trials use the 16 currently configured Binance USDM symbols, with no post-result
deletions:

`BTC, ETH, SOL, ZEC, AAVE, NEAR, HYPE, KAITO, TRUMP, UNI, BCH, XRP, LINK, AVAX, SUI, LTC`.

At each timestamp a symbol is eligible only after 90 closed daily observations and while the public
venue reports a market/candle. Missing history creates an ineligible symbol, never a synthetic zero.
The three chronological reporting segments are:

1. 2023-07-25 through 2024-07-24 UTC;
2. 2024-07-25 through 2025-07-24 UTC;
3. 2025-07-25 through the last fully closed daily bar at or before 2026-07-24 UTC.

Funding dispersion uses symbols common to Binance USDM, Bybit, and OKX under the same 90-observation
eligibility rule. GDELT news timestamps are joined strictly backward to the most recent published
observation; a later article never affects an earlier trade.

## Six fixed trials

1. **`xsec20-ew`** — rank 20-day total return, long top 2, short bottom 2, equal-dollar, rebalance
   every 6 days.
2. **`xsec20-volbeta`** — trial 1 ranking with inverse 20-day realized-volatility weights and a
   60-day rolling BTC-beta rescale that targets zero net BTC beta. No fitted target-vol parameter.
3. **`residual20-volbeta`** — rank each symbol's 20-day return residual after subtracting its rolling
   60-day BTC beta times BTC's 20-day return; top/bottom 2, trial 2 weighting, 6-day rebalance.
4. **`news1d-asymmetric`** — public GDELT crypto-news series; rolling 90-day z-score. At `z <= -2`,
   short BTC for one day; at `z >= 2`, long ETH for one day; otherwise flat.
5. **`funding-dispersion-3d`** — for a common perp, long the lowest-rate venue and short the
   highest-rate venue only when that exact ordered pair has remained optimal for 3 consecutive
   settlements and projected 3-day funding exceeds twice four-leg taker fees plus modeled slippage.
   Exit after 3 days or immediately when the ordered pair changes.
6. **`xsec20-volbeta-macro`** — trial 2, with no new cohort from 6 hours before through 2 hours after
   an FOMC/CPI release and 50% target exposure for the following 48 hours.

No grid or threshold sweep is permitted.

## Execution and cost model

- Closed-bar decision; execution at the next available bar/open. No same-bar fill.
- Directional perp fills pay 10 bps venue fee plus 5 bps adverse slippage per leg.
- Actual historical funding is applied to the signed perp notional at each settlement.
- Cross-venue funding uses public VIP-0 taker fees for each venue plus 5 bps slippage per fill and
  requires four fills per completed episode.
- Turnover is charged on every changed target, including partial rebalances.
- Production-equivalent LLM cost is `max($0.03, observed average portfolio-batch cost)` per rebalance
  or event consult, allocated against the $1,000 effective book. The 2×-cost stress doubles fees,
  slippage, and LLM cost.
- No leverage benefit is credited. Gross target exposure may not exceed 40% of the effective book.

## Frozen demo-build gate

A trial passes only when all conditions hold:

1. aggregate net PnL after fees, slippage, funding, and allocated LLM cost is strictly positive;
2. at least 2 of 3 chronological segments are positive;
3. no losing segment loses more than the aggregate gain;
4. at least 30 closed cycles/rebalances;
5. the 2×-cost stress is non-negative;
6. maximum drawdown is at most 10% of the $1,000 effective book;
7. no symbol contributes more than 40% of total profit;
8. it beats both flat and the measured incumbent agentic baseline;
9. every required data probe succeeds.

Among passers, the winner is highest median segment net bps, then lower drawdown, then lower turnover.
If none pass, no edge policy is enabled. Negative evidence is the result.

## Production boundary

Research calculators may be deterministic under `test/backtest`; production remains agentic. A
passing policy can supply context, eligibility, cohort, and maximum size to the LLM, but the LLM must
still propose each Signal and every Signal must pass the existing Risk and Execution path. The live
flip, four live gates, and promotion requirement (at least 30 demo round trips, positive net-of-cost
PnL, and at least 14 days) remain unchanged.
