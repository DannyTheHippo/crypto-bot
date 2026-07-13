# Universe expansion study — 2026-07-13

**Study only, no config flip.** Ranks Binance USDT spot markets by a return/volume score to
recommend 3 additions to the current 5-symbol universe (BTC/ETH/SOL/XRP/LINK). The 5→8 expansion
itself is a separately-gated decision that happens later, after portfolio-consult soaks. This
report is read-only input to that decision.

## 1. Method

- **Universe:** `GET /api/v3/ticker/24hr`, filtered to USDT-quoted spot symbols, excluding
  stablecoin-vs-USDT pairs (USDC/FDUSD/TUSD/DAI/USDP/PYUSD/BUSD/UST/USTC bases, plus fiat pairs
  EUR/GBP/TRY), leveraged-token suffixes (UP/DOWN/BULL/BEAR), and the 5 incumbents. Ranked by 24h
  `quoteVolume` descending, top 25 taken forward alongside the 5 incumbents (30 symbols total).
- **Per-symbol stats:** `GET /api/v3/klines?interval=1d&limit=30` for each of the 30 symbols.
  30-day annualized close-to-close volatility (log returns, `stdev * sqrt(365)`), mean daily
  `|log return|`, mean daily quote volume (mean of each kline's quote-asset-volume field), last
  close.
- **Score** = mean daily `|log return|` x `log(mean daily quote volume)` — the TP-clearing driver
  (a 15m-lane symbol must clear ~20bps round-trip fees) weighted by liquidity depth via a log
  dampener so a handful of illiquid/manipulable spikes can't dominate over genuinely tradable
  volatility.
- **Filters at finalist stage:** `GET /api/v3/exchangeInfo`, pulling `PRICE_FILTER.tickSize`,
  `LOT_SIZE.stepSize`/`minQty`, and `NOTIONAL.minNotional` for the 3 recommended symbols only (not
  fetched for all 30 — order-book-level probes are unnecessary for a ranking study).

## 2. Liquidity floor — two readings, reported transparently

The task brief's literal constraint is quote volume ≥ $100M/day. Applying it literally: only BTC
($1.05B), ETH ($445M), and SOL ($174M) clear it — **among the incumbents, XRP ($90.8M) and LINK
($12.8M) do not.** ZEC ($96.1M) is the only non-incumbent near-miss. A strict $100M floor would
therefore yield **zero non-incumbent candidates**, which contradicts the fact that the deployed
system already runs LINK profitably-scoped at ~$13M/day — so $100M is not the system's operative
liquidity floor in practice.

This report uses two readings side by side:

- **Literal $100M/day:** passes BTC/ETH/SOL only (of the 30-symbol universe). No recommendation
  possible under this reading alone.
- **Incumbent-anchored floor** (≥ lowest incumbent's 30d-mean volume, LINK's ~$12.8M, rounded to
  $12M): passes 12 of the 25 non-incumbent candidates. **This is the floor used to produce the 3
  recommendations below.** It is a relaxation, not a substitute for the literal constraint — flagged
  here so the human deciding the config flip can override back to strict-$100M if that was the
  intended bar.

Both readings use the **30-day mean** daily quote volume, not the 24h snapshot used only for the
initial top-25 selection — several symbols (OPN, MUB) show 24h volume far above their 30d mean,
i.e. recent one-day spikes, which is exactly why the mean and not the snapshot is the liquidity
gate.

## 3. Exclusions applied before ranking finalists

- **Stablecoins the base filter missed:** `USD1USDT` and `RLUSDUSDT` are USD-pegged stablecoins
  (score ~0.003, annualized vol ~0.4%) that the base/quote-name filter did not catch. Excluded by a
  vol floor (annualized vol < 5% ⇒ pegged asset), not by name.
- **Commodity-pegged:** `XAUTUSDT` (Tether Gold) is gold-backed, not a crypto-native asset;
  self-excludes on score (0.144, below BTC's 0.290) regardless.
- **Suspected tokenized-equity products, not organic crypto:** `MUBUSDT`, `SNDKBUSDT`, `SPCXBUSDT`
  have base-asset tickers matching known equity/ETF symbols (MUB = iShares muni-bond ETF, SNDK =
  SanDisk, SPCX = a SPAC/rocket-launch ticker), consistent with Binance's tokenized-stock listings
  rather than native crypto. `exchangeInfo` permission sets do not disambiguate asset class, so this
  could not be conclusively confirmed or ruled out from the API alone. Excluded rather than
  recommended, per the "can't confirm, don't recommend" rule for a crypto-momentum lane. MUB/SNDKB
  fail the liquidity floor regardless (~$7-8M); **SPCXB would otherwise have passed** (24.8M vol,
  score 0.566, would have displaced NEAR from the top-3) — called out explicitly since it's the one
  exclusion that changes the recommendation set.

## 4. Top-10 by score (full 30-symbol universe, before exclusions)

| Rank | Symbol | Score | Mean \|ret\| | Ann. vol | 30d mean quote vol | Price | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | DEXEUSDT | 1.352 | 8.51% | 223% | $7.8M | $39.87 | excluded — below liquidity floor |
| 2 | WLDUSDT | 0.872 | 4.81% | 119% | $74.4M | $0.41 | excluded — price < $0.50 |
| 3 | SNDKBUSDT | 0.845 | 5.35% | 133% | $7.3M | $1,688.03 | excluded — tokenized-equity suspect + floor |
| 4 | OPNUSDT | 0.769 | 4.79% | 119% | $9.4M | $0.06 | excluded — price and floor both fail |
| 5 | **ZECUSDT** | **0.707** | 3.85% | 89% | $96.1M | $506.84 | **recommended #1** |
| 6 | MUBUSDT | 0.677 | 4.27% | 111% | $7.8M | $927.01 | excluded — tokenized-equity suspect + floor |
| 7 | SXTUSDT | 0.635 | 4.27% | 144% | $2.8M | $0.008 | excluded — price and floor both fail |
| 8 | DODOUSDT | 0.628 | 4.55% | 155% | $1.0M | $0.023 | excluded — price and floor both fail |
| 9 | **AAVEUSDT** | **0.579** | 3.46% | 87% | $18.6M | $95.15 | **recommended #2** |
| 10 | SPCXBUSDT | 0.566 | 3.33% | 96% | $24.8M | $138.62 | excluded — tokenized-equity suspect |

`NEARUSDT` (score 0.526, rank 13 overall) is **recommended #3** — included here for completeness
since it falls just outside the top-10 window above.

## 5. Recommendations

All three clear price ≥ $0.50, the incumbent-anchored volume floor (~$12M), and beat BTC's
mean-|return| (1.40%) clearly — the TP-clearing bar this score is built around.

| Symbol | Score | Mean \|ret\| | 30d mean quote vol | Price | tickSize | stepSize | minQty | minNotional |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZECUSDT | 0.707 | 3.85% | $96.1M | $506.84 | 0.01000000 | 0.00100000 | 0.00100000 | 5.00000000 |
| AAVEUSDT | 0.579 | 3.46% | $18.6M | $95.15 | 0.01000000 | 0.00100000 | 0.00100000 | 5.00000000 |
| NEARUSDT | 0.526 | 3.03% | $35.6M | $1.938 | 0.00100000 | 0.10000000 | 0.10000000 | 5.00000000 |

- **ZEC** is the standout: near-$100M literal volume (the closest any non-incumbent gets), an
  established asset, and the highest score of the three by a wide margin. The one candidate that
  would clear even a stricter floor than the incumbent-anchored one used here.
- **AAVE and NEAR are floor-dependent** — at $18.6M and $35.6M respectively, both sit well below
  the literal $100M constraint and closer to LINK's existing $12.8M than to BTC/ETH/SOL. Their
  inclusion rests entirely on the incumbent-anchored floor reading in §2; a decision-maker who wants
  the literal $100M bar enforced should drop both and fall back to ZEC-only (or none, if even ZEC's
  96.1M is rounded down to "does not clear $100M").

## 6. Incumbents' reference scores

| Symbol | Score | Mean \|ret\| | Ann. vol | 30d mean quote vol | Price |
| --- | --- | --- | --- | --- | --- |
| SOLUSDT | 0.396 | 2.09% | 52% | $173.8M | $75.44 |
| ETHUSDT | 0.365 | 1.83% | 44% | $444.8M | $1,770.59 |
| XRPUSDT | 0.312 | 1.70% | 40% | $90.8M | $1.0686 |
| BTCUSDT | 0.290 | 1.40% | 31% | $1,053.4M | $62,290.85 |
| LINKUSDT | 0.274 | 1.68% | 39% | $12.8M | $7.906 |

All 3 recommendations beat BTC's score and mean-|return| (the weakest incumbent on both); ZEC and
AAVE also beat every incumbent's mean-|return| including SOL's.

## 7. Caveats

- **30-day window is regime-dependent.** Scores reflect the trailing month only; a symbol's
  volatility/volume ranking can shift materially across regimes (e.g. altcoin-season rotations).
  This is a snapshot, not a stable estimate — re-run before acting on it if meaningfully more than a
  few weeks pass.
- **Volume can be manipulated on mid-caps.** None of the 3 recommendations are thin enough to be
  obviously wash-traded, but mid-cap altcoin spot volume on Binance is not immune to wash trading or
  market-making incentive programs; the quoteVolume figures should be treated as directionally
  informative, not audited.
- **Demo-venue availability assumed = production listing.** This study queried Binance's production
  `api.binance.com` market-data endpoints (public, unauthenticated) for ticker/kline/exchangeInfo
  data — it did not verify these symbols are listed and tradable on whatever demo/testnet venue the
  system currently runs against. Confirm spot availability on the actual trading venue before wiring
  these into `default-filters.ts`.
- **24h-vs-30d-mean divergence is real, not a bug.** Several symbols (OPN: $107M 24h vs $9.4M 30d
  mean; MUB: $47M 24h vs $7.8M 30d mean) show one-day volume spikes far above their trailing-month
  average — confirmed by two independent ticker fetches roughly an hour apart returning consistent
  relative rankings. This is why the recommendation floor uses the 30d mean rather than the 24h
  snapshot.
- **Well-known large-caps show surprisingly thin USDT-spot volume.** BNB ($44-67M/day) and DOGE
  ($21-36M/day) sit well below their public reputation for liquidity — their retail volume mostly
  flows through other quote pairs (historically BUSD, now FDUSD) and derivatives/futures markets,
  not Binance USDT spot specifically. This is a real market-structure fact for this venue/quote-pair
  scope, not a data error.
- **Tokenized-equity exclusion is a judgment call, not a confirmed fact.** §3 excludes MUB/SNDKB/SPCXB
  on ticker-naming inference; `exchangeInfo` does not expose an asset-class field to confirm this
  directly. If any of the three are in fact organic crypto assets, SPCXB in particular would
  re-enter the candidate set at rank 10 (score 0.566) and could displace NEAR.
- **WLD near-miss on price only.** `WLDUSDT` (score 0.872, the highest of any liquidity-floor-passing
  candidate) misses only the $0.50 price floor ($0.41) — flagged since it is otherwise the strongest
  non-incumbent by volume-and-score combined; the $0.50 floor exists specifically to keep entries
  clear of the deployed `RISK_MAX_POSITION_PER_SYMBOL=1000` base-qty veto boundary (see
  `reports/loop/state.md` § Sizing re-derivation 2026-07-13), so this is not a data artifact to
  relax casually.

## 8. Deviations from task brief

- Sandboxed Bash blocked outbound DNS (`ENOTFOUND api.binance.com`); network calls were made with
  the sandbox disabled per the tool-hierarchy escape hatch for evidenced sandbox-caused failures,
  rather than via the suggested `docker compose exec app node -e` path — direct `node` invocation
  worked once unsandboxed, so the docker indirection was unnecessary.
- The literal $100M/day floor from the task brief yields zero non-incumbent candidates (§2); an
  incumbent-anchored floor is used instead to produce the 3 recommendations, clearly flagged as a
  relaxation rather than silently substituted.
