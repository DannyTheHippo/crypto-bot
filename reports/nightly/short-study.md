# Short / long-short battery — step-D study — 2026-06-15

Shorts plumbed through Risk (Phase 3) and the harness sizing. Candidates run through the Phase-0 gate at VIP0 fees (10 bps; 7.5 with BNB) + a zero-fee cross-check. **Not live-deployable: the paper/testnet venue is spot (can't short); a short winner needs a futures/margin venue — DEFERRED.** Per-trade-return convention. Real Binance BTC/USDT.

## Pre-registered short battery

- **Short mean-reversion** — SELL when z ≥ +entryZ (overbought), cover when z ≤ 0. {lookback 20/50/100 × entryZ 1.5/2.0/2.5}. The mirror of the closed long reversion.
- **Long/short EMA** — long above the cross, FLIP to short below it. {9/21, 20/50, 30/100, 50/200}. The closed trend follower with the downside captured.

## Cumulative trial accounting

- **N = 324** = prior 208 + long battery 64 + short battery 52.
- **V = 6.042e-2**, **E[max Sharpe of N] = +0.718** (E[maxZ]=+2.920).
- Short trials profitable: **2/52** @ 10 bps · 3/52 @ 7.5 bps · **37/52 @ 0 bps**.

## short-mr: best candidate 100/2.0 @ 15m

- per-trade SR +0.009 · trades 108 · full-sample ret +0.11% · skew -1.10 · kurt +3.99
- t-stat +0.09 (>3.0? ❌) · DSR +0.0000 (>0.95? ❌)
- MinBTL +110430.9 vs 108 trades (≥? ❌) · WF 3/4 positive [+1.4, +0.0, -1.6, +0.1]% (❌)
- **VERDICT: 🔴 FAIL**

## longshort-ema: best candidate 50/200 @ 1h

- per-trade SR -0.005 · trades 116 · full-sample ret +0.10% · skew +2.02 · kurt +8.49
- t-stat -0.06 (>3.0? ❌) · DSR +0.0000 (>0.95? ❌)
- MinBTL +∞ vs 116 trades (≥? ❌) · WF 1/4 positive [+4.0, -1.9, -2.0, -0.0]% (❌)
- **VERDICT: 🔴 FAIL**

## Verdict

No short or long-short candidate clears step-D. Shorting overbought reversion and capturing the EMA down-leg both FAIL at VIP0 fees (zero-fee count above confirms it is the strategies, not costs). Combined with the long closures, BTC/USDT shows no fee-surviving directional edge in any tested form — long or short, trend or reversion, plain or regime-conditioned. Live short execution stays DEFERRED (no edge to justify a futures-venue build).
