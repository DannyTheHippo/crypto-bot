# Edge tournament results (2026-07-24)

Preregistration: `reports/loop/edge-tournament-preregistration-2026-07-24.md`
Discovery N (conservative): **5239**
Flat baseline: `0` · Agentic baseline: `-23.25`
Real LLM spend this run: **$0** (deterministic calculators; hard cap `2`)

Re-run after integrity repair (GDELT `publishedMs` parse + funding 8h bucket align). Same frozen calculators/gates.

## Data probes

- ohlcv_universe_ge_8: ok
- btc_eth_present: ok
- news_rows_ge_30: ok
- news_timestamps_valid: ok
- funding_venues_ge_2: ok
- macro_events_ge_10: ok
- manifest_ok: ok

## Trial scoreboard

| Trial | Net PnL USD | Cycles | Max DD | Median seg bps | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| `xsec20-ew` | 455.234432198696721184238133244828867372 | 168 | 0.210757652374913605701191831709299423145 | 2844.6170 | fail |
| `xsec20-volbeta` | 415.327161914466390553768267519750475843 | 168 | 0.2391602483616387416967535742346271578223 | 2091.8778 | fail |
| `residual20-volbeta` | 493.177360648517068635860369163182682795 | 168 | 0.2339966912325519223754991091097160511545 | 1427.4121 | fail |
| `news1d-asymmetric` | 17.9716980252571094483603244815013887 | 5 | 0.004809040604017498455916892084190404309205 | 0.0000 | fail |
| `funding-dispersion-3d` | 0 | 0 | 0 | 0.0000 | fail |
| `xsec20-volbeta-macro` | 362.923952370572556772137804084796417753 | 168 | 0.2544356830700802786275828358918091018816 | 2122.9531 | fail |

## Winner

**No trial passed.** Production agentic behavior stays unchanged. Negative evidence is the result.

Fail reasons:

- `xsec20-ew`: max drawdown 0.210757652374913605701191831709299423145 exceeds 0.10
- `xsec20-volbeta`: max drawdown 0.2391602483616387416967535742346271578223 exceeds 0.10
- `residual20-volbeta`: max drawdown 0.2339966912325519223754991091097160511545 exceeds 0.10; symbol ZEC/USDT:USDT contributes >40% of profit
- `news1d-asymmetric`: only 1 positive segments (need 2); cycles 5 < 30; symbol ETH/USDT:USDT contributes >40% of profit
- `funding-dispersion-3d`: aggregate net PnL not positive; only 0 positive segments (need 2); cycles 0 < 30; does not beat flat baseline
- `xsec20-volbeta-macro`: max drawdown 0.2544356830700802786275828358918091018816 exceeds 0.10; symbol SOL/USDT:USDT contributes >40% of profit

## Integrity verification (why results looked flaky)

### Xsec family (+$360–$493) — honest fail, not a silent winner

PnL is reproducible on cached 1d OHLCV (168 cycles). Gate fails on **max drawdown ≈21–25%** vs frozen **10% of the $1k book** (~$100 peak DD allowed; observed peak DD ≈$210–$285). Residual/macro also fail concentration (`ZEC` / `SOL` >40% of profit). **Positive net is real; it does not pass the pre-registered demo-build gate.**

### `news1d-asymmetric` — prior $0 was a data bug (now repaired)

First run scored **0 cycles / $0** while `news_rows_ge_30` still passed. Root cause: GDELT DOC dates are `YYYYMMDDTHHMMSSZ`; `Date.parse` yields `NaN`, cache stored `publishedMs: null`, and the probe counted raw rows without requiring valid timestamps. All bars then saw an empty news window → no trades.

Fixes: compact date parse in `scripts/fetch-edge-tournament-data.mjs`; cache re-fetched (`timelinetone`, 86 rows, valid ms); runner probe `news_timestamps_valid` fails closed if any raw nulls remain.

After repair: **+$17.97, 5 cycles, DD ~0.5%** — still fails (need ≥30 cycles and ≥2 positive segments). Limited by 90d GDELT window vs multi-year OHLCV (only ~58 decision bars have enough lookback).

### `funding-dispersion-3d` — honest cost null (not a join flake after align)

8h bucket alignment joins venues despite Binance/Bybit sub-second stamp drift (~254 stable multi-venue hits). Projected 3d carry never clears `2×` four-leg episode cost on the $400 notional (max projected carry ≈$0.34 vs threshold ≈$4.80). **Zero cycles is expected under frozen costs, not a silent bug.**

### Verdict

Still **no mechanical tournament winner**. Owner directed **demo deploy** of `residual20-volbeta` EdgePolicy anyway (2026-07-24) despite DD/concentration fail — see `.env.app` `AGENTIC_EDGE_POLICY_*`. Not a gate pass; not live arming.
