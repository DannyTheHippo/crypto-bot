# Long-directional battery — step-D study — 2026-06-15

Pre-registered long-only candidates run through the Phase-0 validation gate (deflated Sharpe, t-stat, MinBTL, walk-forward) at Binance spot VIP0 fees (10 bps/side; 7.5 bps with the BNB discount) + a zero-fee cross-check. Per-trade-return convention. Real Binance BTC/USDT.

## Pre-registered battery (declared before results)

- **Donchian breakout** — close breaks prior-N-bar high; exit on prior-M-bar low. {20/10, 20/20, 55/10, 55/20}.
- **Dual-timeframe momentum** — slow-SMA trend filter + N-bar momentum trigger. {mom10/20 × trend50/100}, threshold 0.
- **Vol-regime trend** — EMA-cross gated to a low coefficient-of-variation regime (gate, not inverse-vol sizing — harness is fixed-notional). {9/21,20/50 × vol≤2%,4%}.
- **ADX-regime trend** — EMA-cross gated to a trending regime (Wilder ADX ≥ adxMin). {9/21,20/50 × adx20,25}.

## Cumulative trial accounting (the DSR deflation penalty)

- **N = 272** = prior 208 (EMA 160 + mean-rev 48) + battery 64 (16 combos × 4 intervals). The honesty tax: every variant ever tried widens the selection the DSR must beat.
- **V = 6.286e-2**, **E[max Sharpe of N] = +0.718** (E[maxZ]=+2.865).
- Battery trials profitable: **0/64** @ 10 bps · 0/64 @ 7.5 bps · **13/64 @ 0 bps** (zero-fee: profitability is the strategy, not costs).

## donchian: best candidate 55/20 @ 1h

- per-trade SR -0.045 · trades 118 · full-sample ret -3.02% · skew +1.46 · kurt +5.35
- t-stat -0.49 (>3.0? ❌) · DSR +0.0000 (>0.95? ❌)
- MinBTL +∞ vs 118 trades (≥? ❌) · WF 1/4 positive [+4.2, -0.7, -1.2, -4.5]% (❌)
- **VERDICT: 🔴 FAIL**

## dualmom: best candidate mom20/trend50 @ 1h

- per-trade SR -0.111 · trades 775 · full-sample ret -24.90% · skew +3.48 · kurt +23.30
- t-stat -3.09 (>3.0? ❌) · DSR +0.0000 (>0.95? ❌)
- MinBTL +∞ vs 775 trades (≥? ❌) · WF 1/4 positive [+0.1, -9.8, -7.9, -6.1]% (❌)
- **VERDICT: 🔴 FAIL**

## volregime: best candidate 20/50/vol2 @ 1h

- per-trade SR -0.030 · trades 191 · full-sample ret -2.79% · skew +3.57 · kurt +26.26
- t-stat -0.41 (>3.0? ❌) · DSR +0.0000 (>0.95? ❌)
- MinBTL +∞ vs 191 trades (≥? ❌) · WF 1/4 positive [+9.2, -5.5, -5.3, -0.8]% (❌)
- **VERDICT: 🔴 FAIL**

## adxregime: best candidate 9/21/adx20 @ 1h

- per-trade SR -0.070 · trades 328 · full-sample ret -10.27% · skew +2.10 · kurt +10.05
- t-stat -1.26 (>3.0? ❌) · DSR +0.0000 (>0.95? ❌)
- MinBTL +∞ vs 328 trades (≥? ❌) · WF 1/4 positive [+5.0, -3.9, -5.4, -4.8]% (❌)
- **VERDICT: 🔴 FAIL**

## Verdict

No pre-registered long candidate clears the step-D gate. Channel breakout, dual-timeframe momentum, vol-regime-gated trend, and ADX-regime-gated trend all FAIL at VIP0 fees — and the zero-fee count above shows it is the strategies, not transaction costs. This extends the EMA + mean-rev closures: trend and reversion, plain or regime-conditioned, show no fee-surviving long edge on BTC/USDT. The least-bad candidate is recorded for the Phase-4 best-of-breed experiment (deployed labeled UNVALIDATED, never to live).
