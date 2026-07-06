# Short-horizon mean-reversion out-of-sample study — 2026-06-15

Real Binance BTC/USDT OHLCV (same cached datasets as the EMA study). Fee = 10 bps/side (taker, conservative; ~20 bps round-trip). Fills at NEXT-bar open (no lookahead). Sizing = baseNotional 1000 / price, exits full; PnL on a 5000 base. IS = first 70%, OOS = last 30% (chronological). Strategy = MeanReversionStrategy (z-score reversion: ENTER_LONG when z <= -entryZ, EXIT_LONG when z >= 0); PnL math is the production applyFillToPosition, driven through the SAME generalized harness that reproduces the EMA verdict byte-for-byte.

> **Hypothesis:** short-horizon liquidity-provision / overreaction reversal — buy transient weakness (close >=entryZ std-devs below a rolling mean), exit on reversion to the mean. This is the COMPLEMENT of the trend-following EMA-cross (proven edgeless), a genuinely different edge class. **Pre-registered grid:** lookback {20, 50, 100} x entryZ {1, 1.5, 2, 2.5} = 12 combos, exitZ fixed at 0 (canonical revert-to-mean, NOT tuned). **Trial accounting:** 48 variants this study; cumulative research-program N = 160 (EMA) + 48 = 208 (for the deflated-Sharpe / multiple-testing correction that any eventual deployment must clear).

## 1h — 17520 bars (IS 12264 / OOS 5256)

Buy&hold: IS +54.56% · OOS -35.78%

| lookback/entryZ | IS ret% | IS trades | IS win% | OOS ret% | OOS trades | OOS win% |
| --------------- | ------- | --------- | ------- | -------- | ---------- | -------- |
| 100/1.0         | +4.58   | 107       | 73      | -4.99    | 41         | 63       |
| 100/2.5         | +3.85   | 45        | 69      | -5.51    | 16         | 69       |
| 100/1.5         | -0.59   | 73        | 67      | -5.03    | 29         | 62       |
| 100/2.0         | -1.57   | 54        | 65      | -6.33    | 21         | 62       |
| 20/2.5          | -2.45   | 151       | 60      | -11.38   | 64         | 48       |
| 50/2.5          | -3.04   | 86        | 63      | -6.38    | 31         | 55       |
| 50/1.5          | -4.13   | 137       | 66      | -9.45    | 55         | 60       |
| 50/2.0          | -4.77   | 105       | 63      | -6.93    | 43         | 60       |
| 20/2.0          | -5.00   | 242       | 63      | -11.31   | 92         | 54       |
| 50/1.0          | -6.20   | 168       | 67      | -9.34    | 75         | 59       |
| 20/1.5          | -11.10  | 313       | 60      | -10.53   | 127        | 64       |
| 20/1.0          | -13.67  | 389       | 59      | -11.98   | 167        | 64       |

- **IS-best** 100/1.0: IS +4.58% → **OOS -4.99%** (FAILS OOS)
- Best OOS combo 100/1.0: OOS -4.99% (its IS +4.58%)
- Positive: IS 2/12 · OOS 0/12 · **BOTH 0/12** · **BOTH @ 0 bps (no fees): 0/12**

## 15m — 23000 bars (IS 16099 / OOS 6901)

Buy&hold: IS -37.36% · OOS -1.70%

| lookback/entryZ | IS ret% | IS trades | IS win% | OOS ret% | OOS trades | OOS win% |
| --------------- | ------- | --------- | ------- | -------- | ---------- | -------- |
| 50/2.5          | -8.13   | 119       | 59      | -0.97    | 43         | 63       |
| 100/1.5         | -9.58   | 106       | 66      | -2.73    | 42         | 69       |
| 100/2.0         | -9.68   | 78        | 63      | -1.23    | 35         | 69       |
| 100/2.5         | -9.70   | 60        | 57      | -2.39    | 24         | 58       |
| 20/2.5          | -10.14  | 206       | 53      | +0.13    | 82         | 59       |
| 50/2.0          | -11.14  | 155       | 59      | -2.15    | 57         | 60       |
| 100/1.0         | -12.02  | 131       | 63      | -3.00    | 60         | 73       |
| 50/1.5          | -12.27  | 208       | 62      | -1.70    | 83         | 66       |
| 20/2.0          | -14.84  | 325       | 54      | -2.60    | 143        | 55       |
| 50/1.0          | -15.43  | 258       | 60      | -2.55    | 107        | 67       |
| 20/1.5          | -20.62  | 422       | 51      | -5.69    | 190        | 50       |
| 20/1.0          | -27.48  | 545       | 49      | -7.16    | 240        | 48       |

- **IS-best** 50/2.5: IS -8.13% → **OOS -0.97%** (FAILS OOS)
- Best OOS combo 20/2.5: OOS +0.13% (its IS -10.14%)
- Positive: IS 0/12 · OOS 1/12 · **BOTH 0/12** · **BOTH @ 0 bps (no fees): 0/12**

## 5m — 26000 bars (IS 18200 / OOS 7800)

Buy&hold: IS +2.35% · OOS -14.41%

| lookback/entryZ | IS ret% | IS trades | IS win% | OOS ret% | OOS trades | OOS win% |
| --------------- | ------- | --------- | ------- | -------- | ---------- | -------- |
| 100/2.5         | -2.33   | 62        | 55      | -1.03    | 37         | 68       |
| 100/2.0         | -3.14   | 90        | 57      | -1.65    | 46         | 65       |
| 50/2.5          | -3.74   | 120       | 53      | -0.41    | 58         | 60       |
| 100/1.5         | -4.30   | 113       | 54      | -2.32    | 56         | 61       |
| 50/2.0          | -4.58   | 173       | 53      | -2.39    | 80         | 59       |
| 100/1.0         | -5.72   | 159       | 49      | -2.80    | 75         | 59       |
| 50/1.5          | -6.99   | 220       | 45      | -4.00    | 98         | 49       |
| 20/2.5          | -8.07   | 192       | 30      | -2.62    | 96         | 42       |
| 50/1.0          | -9.94   | 295       | 42      | -4.95    | 124        | 44       |
| 20/2.0          | -13.32  | 344       | 28      | -6.41    | 143        | 36       |
| 20/1.5          | -18.74  | 463       | 23      | -8.91    | 192        | 30       |
| 20/1.0          | -23.75  | 592       | 20      | -11.28   | 254        | 29       |

- **IS-best** 100/2.5: IS -2.33% → **OOS -1.03%** (FAILS OOS)
- Best OOS combo 50/2.5: OOS -0.41% (its IS -3.74%)
- Positive: IS 0/12 · OOS 0/12 · **BOTH 0/12** · **BOTH @ 0 bps (no fees): 6/12**

## 1m — 30000 bars (IS 21000 / OOS 9000)

Buy&hold: IS -19.18% · OOS +5.11%

| lookback/entryZ | IS ret% | IS trades | IS win% | OOS ret% | OOS trades | OOS win% |
| --------------- | ------- | --------- | ------- | -------- | ---------- | -------- |
| 100/2.5         | -4.08   | 82        | 32      | -0.77    | 29         | 41       |
| 100/2.0         | -6.29   | 105       | 26      | -1.25    | 39         | 36       |
| 50/2.5          | -6.96   | 143       | 24      | -1.65    | 57         | 19       |
| 100/1.5         | -8.12   | 133       | 21      | -1.56    | 55         | 31       |
| 20/2.5          | -9.33   | 213       | 16      | -2.68    | 84         | 11       |
| 100/1.0         | -9.60   | 177       | 21      | -1.99    | 73         | 23       |
| 50/2.0          | -9.71   | 193       | 21      | -2.34    | 78         | 21       |
| 50/1.5          | -12.44  | 250       | 20      | -3.38    | 107        | 15       |
| 50/1.0          | -15.47  | 326       | 13      | -4.71    | 144        | 11       |
| 20/2.0          | -16.84  | 395       | 13      | -5.85    | 159        | 7        |
| 20/1.5          | -23.27  | 545       | 10      | -8.53    | 249        | 9        |
| 20/1.0          | -29.72  | 702       | 7       | -10.97   | 325        | 8        |

- **IS-best** 100/2.5: IS -4.08% → **OOS -0.77%** (FAILS OOS)
- Best OOS combo 100/2.5: OOS -0.77% (its IS -4.08%)
- Positive: IS 0/12 · OOS 0/12 · **BOTH 0/12** · **BOTH @ 0 bps (no fees): 0/12**

## Verdict

NO interval's in-sample-best parameter set is positive out-of-sample (IS-best survives OOS: false). Across all intervals, 0/48 variants are positive in BOTH IS and OOS at 10 bps, and **6/48 even at ZERO fees** — so a near-zero count is the STRATEGY, not transaction costs. Short-horizon z-score mean-reversion shows **no robust, fee-surviving edge** on BTC/USDT across the tested intervals/params, the same verdict class as the EMA-cross trend-follower. This CLOSES the plain z-score mean-reversion hypothesis; re-tuning the same form on this data would be overfitting (forbidden by step D).

### Console summary

- 1h: IS-best 100/1.0 IS +4.58% → OOS -4.99% [fails]; positive-both 0/12 (0bps 0/12); B&H OOS -35.78%
- 15m: IS-best 50/2.5 IS -8.13% → OOS -0.97% [fails]; positive-both 0/12 (0bps 0/12); B&H OOS -1.70%
- 5m: IS-best 100/2.5 IS -2.33% → OOS -1.03% [fails]; positive-both 0/12 (0bps 6/12); B&H OOS -14.41%
- 1m: IS-best 100/2.5 IS -4.08% → OOS -0.77% [fails]; positive-both 0/12 (0bps 0/12); B&H OOS +5.11%
