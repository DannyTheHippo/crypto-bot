# Horizon test + passive baseline — preregistration (2026-07-27)

Frozen before any signal is joined to any return. Universe, signals, horizons, fee levels, the
benchmark and the pass rule cannot change after a result is seen.

## The question

Every negative result in this program was measured at **15 minutes to 1 day**, where a 20 bps
round-trip fee dwarfs anything predictable. The random-entry test made that concrete: gross
**−1.07 bps** — a martingale — so net = −fees by construction, whatever the signal.

This asks whether the fee wall was the *whole* story. At a 30-day horizon 20 bps is 0.2% against
typical 10–30% moves: a 50–100× better signal-to-fee ratio. If nothing works even there, horizon was
not the binding constraint and the architecture is out of moves.

**This is NOT a re-run of the settled price-TA search.** That search (4,562 trials, zero survivors)
covered **15m–1d** and is explicitly marked do-not-repeat. Its own closing note names the exception:
*"Frontier if ever wanted, forward-test-only: long-short daily cross-sectional momentum on perps."*
This study tests that named frontier and the horizon question behind it, at 7/30/90 days — outside
the killed range. Any cell inside 1d would be a violation and none is included.

## The benchmark change this study introduces

The promotion gate asks for **net-of-cost PnL > 0**. That is the wrong bar: a strategy earning +3%/yr
while the basket earns +12% passes it and is still destroying value. Nothing in this program has ever
been measured against doing nothing — which is why it took until today to notice the bot lost ~4% of
its book over a window in which the same 16 assets returned **+0.39%** equal-weight.

So the bar here is **excess return over the passive equal-weight basket, net of all costs**, not
positivity. A signal that is positive but below the basket is recorded as a **FAIL**.

## Universe and data

16 assets with 400 daily bars already cached: BTC, ETH, SOL, XRP, LINK, AAVE, NEAR, ZEC, DOGE, ADA,
AVAX, LTC, UNI, BCH, DOT, TRX. Binance spot daily closes. No survivorship filtering is applied and
none is possible — the universe is fixed by what the bot actually traded, which is itself a
selection, and that limitation is stated rather than corrected away.

## Signals (frozen — 4)

Long-short, cross-sectional, rebalanced at the horizon. Each ranks the universe at each rebalance
using only trailing data, longs the top tercile and shorts the bottom, equal-weighted.

| # | Signal | Definition |
| --- | --- | --- |
| 1 | `xs_mom30` | rank by trailing 30-day total return |
| 2 | `xs_rev7` | rank by trailing 7-day return, **negated** (short-term reversal) |
| 3 | `xs_momvol` | trailing 30-day return divided by trailing 30-day realized vol |
| 4 | `ts_mom50` | time-series: long assets above their 50-day moving average, short those below |

## Horizons and fees

- **Horizons: 7, 30, 90 days** — rebalance period equals holding period.
- **Two fee levels, both reported:** 20 bps round trip (today's demo/taker reality) and 4 bps
  (futures maker-only, ~2 bps per leg). Fees are charged on turnover at every rebalance.
- **12 cells** = 4 signals × 3 horizons, each reported at both fee levels.

## Benchmarks (reported alongside every cell)

1. Equal-weight buy-and-hold of the 16 assets over the identical window — **the bar to beat**.
2. BTC buy-and-hold.
3. Zero (the promotion gate's current, insufficient bar).

## Statistics

- Bonferroni across 12 cells: α = 0.05/12 = **4.17e-3**.
- Overlapping windows are avoided by construction (rebalance period = holding period), so periods are
  non-overlapping and a simple block bootstrap over rebalance periods is sufficient; 2000 draws,
  deterministic seed.
- **n is small by construction**: 400 daily bars gives ~57 non-overlapping 7-day periods, ~13
  30-day, ~4 90-day. The 90-day cells are therefore descriptive only and **cannot pass** — they are
  reported for shape, and this is stated now so a large 90-day number cannot be promoted after the
  fact.

## Pass rule (frozen)

A cell passes only if **all** hold:

1. mean excess return over the equal-weight basket is **positive at the 20 bps fee level**;
2. p < 4.17e-3 against the basket, block-bootstrapped;
3. the excess is still positive in **both** halves of a chronological split;
4. n ≥ 12 non-overlapping periods (which excludes every 90-day cell a priori).

Anything else fails. A cell that beats zero but not the basket fails. A cell that only works at 4 bps
is reported as **fee-tier-dependent** — informative, and not a pass, because the live lane does not
have that fee tier today.

## AMENDMENT 1 — window extended to power the test (recorded before re-running)

The first run used 400 daily bars and was **under-powered exactly where it mattered**: the 30-day
cells had n=11 against the pre-registered n≥12 floor, so they could not pass by construction. They
were also the only encouraging cells — three independent momentum signals (`xs_mom30` +6.37%,
`xs_momvol` +6.27%, `ts_mom50` +7.18% excess per period) all positive in both halves, compounding to
+25% to +38% against +14.5% buy-and-hold, while reversal was negative. That pattern is the direction
the literature predicts, which is a reason to power the test rather than to believe it.

Window extended to **2,600 daily bars** (~7 years for majors; 2,112–2,177 for later listings). The
30-day cells go from n=11 to n≈85. **Nothing else changes** — same 4 signals, same 3 horizons, same
two fee levels, same Bonferroni α=4.17e-3, same n≥12 floor, same 4-clause pass rule.

Stated plainly because it affects how a pass should be read: this is a re-run **with knowledge** of
an encouraging under-powered result, not a blind first look. A cell that passes here is therefore
*suggestive and forward-testable*, not established. It would need out-of-sample confirmation before
anything is built on it.

## AMENDMENT 2 — survivorship bias, which may be the dominant confound

The 16 assets are the ones the bot traded in 2026, i.e. assets that **survived to 2026** and were
liquid enough to enter a top-40 scanner. Running a 7-year momentum test on a 2026-chosen universe is
biased **upward**, potentially severely: every asset that went to zero, delisted, or faded out of
liquidity between 2019 and 2026 is absent, and momentum strategies are precisely the ones that would
have held those names on the way down.

This cannot be corrected with the data on hand — it needs a point-in-time universe (listing and
delisting dates), which is not cached and not free to reconstruct. So the honest reading of any
positive long-horizon result here is: **an upper bound, not an estimate.** If a cell fails even
under a bias that favours it, that failure is strong. If a cell passes, the bias is a sufficient
alternative explanation on its own and the result is not actionable without a point-in-time universe.

## RESULT — 24 of 24 cells FAIL, and the encouraging cell reversed under power

Harness `test/backtest/horizon-study.mjs`, window **2019-08-04 → 2026-07-27**, 2,600 daily bars,
16 assets, deterministic bootstrap seed.

**Benchmarks over the window: equal-weight buy-and-hold +697.2%; BTC buy-and-hold +494.5%; the
monthly-rebalanced basket +1,294.9%.**

| Signal | h | n | Excess/period (taker) | 95% CI | p | Compounded vs basket |
| --- | --- | --- | --- | --- | --- | --- |
| `xs_mom30` | 7 | 364 | −1.07% | [−2.31, 0.03] | 0.058 | +68.6% vs +1377% |
| `xs_mom30` | 30 | 84 | −5.36% | [−13.00, 1.93] | 0.138 | +55.1% vs +1295% |
| `xs_mom30` | 90 | 28 | −26.52% | [−57.74, −1.11] | 0.035 | −26.4% vs +1671% |
| `xs_rev7` | 7 | 364 | **−1.93%** | [−3.21, −0.98] | **0.0000** | −91.9% vs +1430% |
| `xs_rev7` | 30 | 84 | −7.72% | [−13.54, −1.04] | 0.028 | −78.9% vs +1263% |
| `xs_rev7` | 90 | 28 | −16.97% | [−38.94, 0.87] | 0.066 | +317.0% vs +1913% |
| `xs_momvol` | 7 | 364 | −1.07% | [−2.27, 0.05] | 0.063 | +70.4% vs +1377% |
| `xs_momvol` | 30 | 84 | −6.37% | [−13.98, 1.22] | 0.093 | −32.1% vs +1295% |
| `xs_momvol` | 90 | 28 | −30.17% | [−68.41, −1.10] | 0.043 | −70.2% vs +1671% |
| `ts_mom50` | 7 | 364 | −1.03% | [−2.31, 0.08] | 0.067 | +96.9% vs +1370% |
| `ts_mom50` | 30 | 84 | −5.46% | [−13.18, 2.04] | 0.134 | +73.4% vs +1295% |
| `ts_mom50` | 90 | 28 | −30.98% | [−70.43, −0.29] | 0.049 | −83.8% vs +1671% |

Maker-tier cells (4 bps) differ by ~+0.16%/period and change no verdict — **the fee tier was never
the binding constraint at these horizons.**

**The encouraging result reversed.** `ts_mom50`@h30 went from **+7.18% excess at n=11** to **−5.46%
at n=84**; `xs_mom30`@h30 from +6.37% to −5.36%; `xs_momvol`@h30 from +6.27% to −6.37%. All three
flipped sign, and both chronological halves are now negative in every one. This is the clearest
demonstration in this whole program of why the n≥12 floor and the pre-registered pass rule exist:
acting on the first run would have deployed a value-destroyer with a plausible story attached.

Several cells are now **significantly WORSE** than passive, not merely no better — `xs_rev7`@h7 at
p=0.0000 across 364 periods is a robust finding that short-term reversal actively destroys value in
this universe after costs.

**Why every active strategy lost: the return was beta, and long-short throws it away.** The basket
earned +6.64% per 30-day period over this window. A market-neutral long-short construction strips
exactly that out and keeps only the cross-sectional dispersion — which, net of fees, was negative at
every horizon tested. The strategies did not fail to *find* the return; they were structurally built
to discard it.

**Survivorship reading, per Amendment 2.** The bias inflates the basket and the strategies alike, so
the *excess* is the more robust quantity, and the excess is negative everywhere. The +697% passive
figure is itself inflated and must **not** be read as an achievable ex-ante return: nobody in 2019
could have known to hold these particular 16 names. The robust claim is **relative** — active timing
and selection lost to passive exposure across every horizon, both fee tiers, and 7 years — not the
absolute passive number.

## What follows

- **Pass** → the horizon/fee wall was the binding constraint. Rebuild around a multi-day rebalance
  with maker-only execution and the LLM out of the per-bar path, and re-benchmark against the basket.
- **Fail** → horizon was not the constraint either. Combined with the entry signal being worse than
  random, non-price channels null, exits ruled out and 1,807 conditional cuts dead, the honest
  conclusion is that this architecture has no reachable edge, and the recommendation is to stop
  rather than iterate.

In both branches the passive baseline becomes a permanent fixture of the promotion gate, because the
gate's current bar has been demonstrated to pass value-destroying strategies.
