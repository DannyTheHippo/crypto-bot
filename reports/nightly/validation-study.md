# Step-D validation study — 2026-06-15

The validation harness that certifies a "winner": **deflated Sharpe (DSR)**, **t-statistic**, **MinBTL**, and **walk-forward**. Per-trade-return convention (no annualization across the four heterogeneous intervals). Real Binance BTC/USDT OHLCV, fee 10 bps/side (VIP0 taker). Formulas per Bailey & López de Prado (2012, 2014) — see test/backtest/stats.ts.

## The 4-part gate (ALL must hold for a validated winner)

1. **t-stat > 3.0** — mean per-trade return robustly non-zero.
2. **DSR > 0.95** — Sharpe significant AFTER multiple-testing deflation across the program.
3. **trades ≥ MinBTL** — sample long enough for the claimed Sharpe.
4. **Walk-forward OOS positive in EVERY segment** (4 anchored segments, lead-in excluded).

## Selection penalty (harvested from the closed studies)

- **N = 208 trials** (EMA 40×4 + mean-rev 12×4) — the full multiple-testing breadth of the research program so far.
- **V = 5.450e-2** — variance of the 208 trial per-trade Sharpe ratios.
- **E[max Sharpe of N] = +0.649** = √V · E[maxZ_208] (E[maxZ]=+2.778). Any single candidate must beat this benchmark just to not be the luckiest of 208 coin-flips.

> **Caveats (honest framing).** (a) V pools per-trade Sharpes across 4 candle intervals × 2 strategy classes whose trade counts differ by ~10× — the False Strategy Theorem assumes comparable draws, so this V is an approximation; the direction is CONSERVATIVE (more dispersion ⇒ higher benchmark ⇒ harder to pass), so it cannot manufacture the FAIL verdict. (b) With trades = n, condition 1 (t>3.0) strictly implies condition 3 (trades ≥ MinBTL) at N=208 (E[maxZ]=+2.78 < 3.0), so MinBTL adds no rejection power here — it is kept because the relation flips once N grows enough that E[maxZ] > 3.0.

## EMA-cross: best candidate 30/100 @ 1h

- per-trade SR +0.009 · trades 104 · skew +4.45 · kurt +32.97
- **t-stat +0.09** (>3.0? ❌)
- **DSR +0.0000** (>0.95? ❌)
- **MinBTL +100487.0 trades** vs 104 realized (≥? ❌)
- **Walk-forward** 1/4 segments positive [+11.0, -2.0, -1.2, -6.2]% (all positive? ❌)
- **VERDICT: 🔴 FAIL**

## Mean-reversion: best candidate 100/1.0 @ 1h

- per-trade SR -0.004 · trades 148 · skew -2.80 · kurt +13.83
- **t-stat -0.05** (>3.0? ❌)
- **DSR +0.0000** (>0.95? ❌)
- **MinBTL +∞ trades** vs 148 realized (≥? ❌)
- **Walk-forward** 1/4 segments positive [-0.6, +6.1, -3.6, -2.1]% (all positive? ❌)
- **VERDICT: 🔴 FAIL**

## Verdict

Both the best EMA-cross and the best mean-reversion candidate **FAIL** the step-D gate — in full agreement with the two prior closures (160-config EMA + 48-config mean-rev). The validation tooling is calibrated: it rejects the strategies already known to be edgeless, while a clean synthetic edge passes the unit-test gate. No candidate from the closed studies is a winner.
