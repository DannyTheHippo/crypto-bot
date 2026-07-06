# Maker / market-making economics — 2026-06-15

Can a resting-LIMIT (maker) strategy capture enough spread to beat fees at Binance spot VIP0? VIP0 has **no maker rebate** (maker ≈ taker ≈ 10 bps, 7.5 with BNB), and BTC/USDT spread ≈ 1 bp — so round-trip fees (~20 bps) dwarf the spread. The MAKER_RESTING model is deliberately OPTIMISTIC (any bar touching the limit fills the whole order at the limit, no queue), so a loss here is robust. Candidate = mean-reversion 50/1.5 (liquidity provision). maxRestBars=10. Maker fee modelled at the taker tier (no rebate).

## 1h

- **Taker baseline** (next-open, crosses spread): ret -13.58% · trades 192 · fees +383.53 · B&H -0.66%

| offset bps | maker fills | fill rate | expired entries | unfilled exits | ret%   | fees    |
| ---------- | ----------- | --------- | --------------- | -------------- | ------ | ------- |
| 0          | 384         | 100%      | 0               | 0              | -13.58 | +383.53 |
| 0.5        | 382         | 99%       | 0               | 2              | -13.51 | +383.53 |
| 1          | 375         | 99%       | 1               | 3              | -13.06 | +377.55 |
| 2          | 367         | 98%       | 2               | 4              | -11.93 | +372.53 |
| 5          | 355         | 97%       | 6               | 4              | -10.76 | +360.59 |

## 5m

- **Taker baseline** (next-open, crosses spread): ret -10.99% · trades 318 · fees +635.87 · B&H -12.47%

| offset bps | maker fills | fill rate | expired entries | unfilled exits | ret%   | fees    |
| ---------- | ----------- | --------- | --------------- | -------------- | ------ | ------- |
| 0          | 635         | 100%      | 0               | 0              | -11.39 | +635.85 |
| 0.5        | 585         | 98%       | 8               | 5              | -10.91 | +595.84 |
| 1          | 571         | 97%       | 10              | 7              | -10.50 | +583.85 |
| 2          | 554         | 96%       | 12              | 12             | -8.97  | +571.91 |
| 5          | 489         | 90%       | 23              | 30             | -7.31  | +521.96 |

## Verdict

Across every interval and offset, the maker book never turns a profit, and the spread captured by the offset (at most 5 bps/side) cannot cover the ~20 bps round-trip fee — there is no maker rebate at VIP0 to bridge the gap. Deeper offsets improve the fill PRICE but collapse the FILL RATE (adverse selection: you only get filled when the market runs through you), and shallow offsets fill often but capture ~nothing. **Market-making this pair at this fee tier is structurally loss-making** — a documented rejection, not a winner. (A real maker edge needs either a rebate tier or a venue/pair with a materially wider spread.)
