# Non-price information channels — preregistration (2026-07-27)

Frozen before any channel series is joined to any return. Channels, transforms, horizons, the
in-sample/holdout split, the multiple-comparisons correction and the pass rule below cannot change
after a result is seen. Any later variation is a new registered trial. Negative evidence is a result.

## Why this study exists, and why it is the last one of its kind

`research/loop/state.md` § Standing verdicts now records, on adversarially-verified evidence, that
the agentic lane's entry signal is not merely edgeless but **significantly negative and worse than
random** (n=61, −16.9 bps at 15m, t=−4.58, random-bar placebo p = 0.0013–0.0037), that **no
conditional subgroup rescues it** (1,807 cuts, 0 of 188 counterfactual cuts positive at n≥8), that
**no exit rule rescues it** (16 cells, all negative), and that **a random entry earns ≈0 gross under
any bracket** so net ≈ −fees always. The arithmetic consequence is that only entry alpha exceeding
fees can produce profit, and the required edge is +13.0 bps/trip on demo fees or +24.2 on live
against a measured −106.0.

The same file has recorded since 2026-07-12 that single-venue price-technical analysis is settled
empty (4,562 trials, zero survivors at any fee level including 0 bps), that funding carry is NO-GO
(0/126 cells), and that the funding-contrarian frontier died on its second holdout. The standing
conclusion drawn from those is: *"the LLM lane cannot profit by reading price better; its only
possible edge is information the price series does not contain."*

**That claim has never been tested.** This study tests it. If every channel here fails, the honest
reading is that the hypothesis space this architecture can reach is exhausted, and the
recommendation becomes to stop rather than iterate.

## Honest prior

Low. Four independent searches have returned nothing, the one deployed public-data policy
(`residual20-volbeta`) failed its own pre-registered gate, and the entry signal is measurably worse
than chance. The expected outcome of this study is a fourth negative. It is worth running only
because the channel class is genuinely untested and cheap to test offline, and because a clean
negative here converts an open question into a closed one.

## Channels (frozen)

Selected for one property above all: **fetchable history**. A channel that can only be forward-tested
costs months of live evidence before a verdict and is excluded regardless of plausibility — which is
why crypto news RSS and Binance's open-interest / long-short history (30-day retention only) are NOT
in this study.

1. **GDELT DOC 2.0** — keyless global news tone and volume, `mode=timelinetone` / `timelinevol`.
   Probe-verified 2026-07-27: `timeline[0].data[] = {date: "20260726T171500Z", value}`, resolution
   adapts to span (15m at 1 day). Throttles at roughly one request per 5 s and the throttle is
   **sticky after a burst** — the backfill must pace and back off, and that pacing is part of the
   recorded method, not a workaround.
2. **Wikipedia Pageviews** — keyless daily per-article attention. Probe-verified: 176 daily points
   over 2026-02-01→07-26 for `Bitcoin`, shape `{timestamp: "2026020100", views}`. **Daily only** —
   there is no hourly per-article endpoint. Per-asset traffic must be reported before any altcoin
   result is believed.
3. **Deribit DVOL** — keyless BTC/ETH implied-volatility index,
   `public/get_volatility_index_data`. Probe-verified: 1000 points of `[ts, open, high, low, close]`
   per call plus a `continuation` token for pagination. A genuinely different signal class from
   anything already killed here (a derivatives risk-premium measure, not price-momentum or funding).

## Transforms (frozen — 9 signals)

All computed from a **trailing** window only; the signal at day *t* may use no data after *t*'s close.

| # | Channel | Signal | Definition |
| --- | --- | --- | --- |
| 1 | GDELT | `tone_z` | z-score of daily mean tone over a trailing 90-day window |
| 2 | GDELT | `tone_d` | 1-day change in daily mean tone |
| 3 | GDELT | `vol_z` | z-score of daily volume intensity, trailing 90 days |
| 4 | GDELT | `vol_d` | 1-day change in daily volume intensity |
| 5 | Wikipedia | `views_z` | z-score of log(daily views), trailing 90 days |
| 6 | Wikipedia | `views_d` | 1-day change in log(daily views) |
| 7 | DVOL | `dvol_z` | z-score of the daily-close index, trailing 90 days |
| 8 | DVOL | `dvol_d` | 1-day change in the index |
| 9 | DVOL | `vrp` | index minus trailing 30-day realized volatility (variance risk premium) |

## Universe, horizons, and returns

- **Universe.** Wikipedia: the 16 daily-bar symbols. DVOL: BTC and ETH only, by construction.
  GDELT: BTC and ETH plus one crypto-wide query.
- **Wikipedia traffic floor — mean ≥ 100 views/day, fixed 2026-07-27 after seeing traffic and
  BEFORE joining any series to any return.** Backfill resolved all 16 articles at 421 daily points
  each, but traffic spans three orders of magnitude: BTC 4,309/day, ETH 1,099, DOGE 612, SOL 527,
  ZEC 241, LTC 230, ADA 173, BCH 164, UNI 143, LINK 105 — then AAVE 62, TRX 53, DOT 23, **XRP 14,
  NEAR 4, AVAX 1**. The bottom group are disambiguation stubs or wrong pages (XRP's real traffic
  plainly lives elsewhere), where day-to-day counts are Poisson noise rather than attention. The
  floor is a **data-quality** criterion, independent of any outcome, which is why fixing it on
  inspection of traffic alone is legitimate — but it is stamped here, before any return is joined,
  so it cannot later be tuned to a result. **Qualifying: BTC, ETH, SOL, DOGE, ZEC, LTC, ADA, BCH,
  UNI, LINK (10 assets).** The six excluded are reported as excluded, never silently dropped.
- **Horizons.** +1, +3 and +7 **daily** bars, close to close. Daily because the binding channel
  (Wikipedia) is daily-only; testing a daily signal at 15m would manufacture comparisons.
- **Returns.** Binance spot daily closes, already cached (16 symbols × 400 bars). Long-short spreads
  are computed as top-tercile minus bottom-tercile mean forward return, which is the tradable form.

## Statistics (frozen)

- **Cells: 9 signals × 3 horizons = 27.** Bonferroni α = 0.05 / 27 = **1.85e-3**. Every cell is
  reported, winners and losers, with n.
- **Standard errors** are cluster-robust by symbol AND by 7-day time block; the more conservative of
  the two is the one reported. Overlapping forward windows make naive t-statistics meaningless.
- **Split.** Chronological, fixed now and never re-cut: **in-sample = the first 60%** of each series,
  **holdout = the final 40%**, untouched until a cell has already passed in-sample.
- **Hurdle.** 20 bps round trip. A statistically significant spread smaller than the fee is a
  negative result, and will be reported as one.

## Pass rule (frozen)

A channel passes only if some cell satisfies **all three**:

1. in-sample long-short spread **|spread| > 20 bps** per trade at that horizon;
2. in-sample **p < 1.85e-3** (Bonferroni-corrected, cluster-robust);
3. the **same cell, same sign**, clears |spread| > 20 bps on the untouched holdout.

Anything less is a fail. In particular a cell that is significant in-sample and reverses or
attenuates below the fee on the holdout is recorded as a **failure**, not as "promising" — that is
precisely how the funding-contrarian frontier died, and repeating that mistake is the one outcome
this rule exists to prevent.

## RESULT — Wikipedia and DVOL: 15 of 15 cells FAIL (2026-07-27)

Harness `test/backtest/nonprice-study.mjs`, run against the cached series. Deterministic bootstrap
seed, so a rerun reproduces these numbers exactly.

| Channel | Signal | h | n | blocks | IS spread | 95% CI | p | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Wikipedia | `views_z` | 1 | 2350 | 35 | +49.6 bps | [−27, 109] | 0.204 | FAIL |
| Wikipedia | `views_z` | 3 | 2340 | 35 | +149.9 | [−43, 299] | 0.152 | FAIL |
| Wikipedia | `views_z` | 7 | 2320 | 34 | **+345.0** | [−20, 689] | 0.072 | FAIL |
| Wikipedia | `views_d` | 1 | 2400 | 35 | +31.1 | [−29, 107] | 0.312 | FAIL |
| Wikipedia | `views_d` | 3 | 2390 | 35 | −17.0 | [−127, 92] | 0.921 | FAIL |
| Wikipedia | `views_d` | 7 | 2360 | 35 | −4.9 | [−147, 142] | 0.927 | FAIL |
| DVOL | `dvol_z` | 1 | 472 | 35 | −34.2 | [−99, 58] | 0.606 | FAIL |
| DVOL | `dvol_z` | 3 | 470 | 35 | −37.6 | [−256, 150] | 0.721 | FAIL |
| DVOL | `dvol_z` | 7 | 464 | 34 | −151.3 | [−602, 334] | 0.615 | FAIL |
| DVOL | `dvol_d` | 1 | 480 | 35 | +11.2 | [−76, 98] | 0.791 | FAIL |
| DVOL | `dvol_d` | 3 | 478 | 35 | +92.4 | [−30, 209] | 0.153 | FAIL |
| DVOL | `dvol_d` | 7 | 472 | 35 | −12.4 | [−298, 171] | 0.877 | FAIL |
| DVOL | `vrp` | 1 | 442 | 32 | +43.6 | [−67, 113] | 0.565 | FAIL |
| DVOL | `vrp` | 3 | 440 | 32 | +153.8 | [−105, 351] | 0.262 | FAIL |
| DVOL | `vrp` | 7 | 436 | 32 | **+268.6** | [−211, 620] | 0.348 | FAIL |

**Every confidence interval spans zero.** The best p-value across all 15 cells is 0.072 — it would
not clear an uncorrected 0.05, let alone the pre-registered Bonferroni threshold of 1.85e-3. No cell
reached the holdout, because the pass rule requires clearing fee AND Bonferroni in-sample first.

The two largest point estimates are worth naming precisely because they are the trap this study was
built to avoid: `views_z` at h=7 shows **+345 bps** and `vrp` at h=7 shows **+268.6 bps**, both of
which would look like a discovery in a report that quoted point estimates. Their intervals are
[−20, 689] and [−211, 620]. At this sample size a 7-day horizon simply cannot resolve an effect of
that size from zero, and quoting either as a finding would be the exact error that killed the
funding-contrarian frontier.

Honest note on power: the DVOL cells rest on n≈440–480 observations from **two** assets, so they are
a weak test rather than a strong refutation — a real but modest DVOL effect could hide inside those
intervals. The Wikipedia cells, at n≈2,350 across ten assets, are a genuinely powered null.

## GDELT — NOT TESTED (channel unavailable at its rate limit)

12 of the 27 cells could not be run. The DOC 2.0 API serves short spans fine but **fails outright on
any span ≥90 days at any backoff** (probe-verified: 429s and connection failures through 15/30/45/60/
75/90-second retries), so the backfill must walk the window in 7-day chunks at ~6 s spacing — 120
requests per query — and the throttle is sticky enough that this did not complete within the session.

This is recorded as **UNTESTED, not as a failure.** GDELT remains the one channel here with both
15-minute granularity and deep history, and it deserves a proper attempt: run
`node test/backtest/fetch-nonprice.mjs gdelt` as a long-running background job, confirm
`nonprice-gdelt-bitcoin.json` covers the window, then re-run `nonprice-study.mjs` — the 12 GDELT
cells will populate automatically against the same frozen criteria. Nothing about the pass rule or
the correction changes; the Bonferroni denominator was fixed at 27 up front precisely so a channel
arriving late cannot alter the bar for the others.

## What follows a pass, and what follows a fail

- **Pass.** Build the channel as a production feed adapter behind the existing port pattern
  (port in `src/ports/strategy/`, adapter under `src/features/venue/market-data/`, payload block in
  `agent-prompt.ts`), **flag-OFF and byte-identical when absent**, then a two-step enable with its
  own decision record and WATCH. A passing channel is a hypothesis to trade cautiously, never a
  certified edge, and it does not touch the live gates.
- **Fail.** Record "no non-price channel found" in § Standing verdicts alongside the existing four
  negatives, and recommend stopping this architecture rather than iterating. No production code is
  written for a failed channel.

## Production boundary

Read-only research under `test/`. No production code changes, no money path, no live gate touched.
The LLM lane keeps proposing every Signal and Risk keeps sizing and vetoing it. The live flip, the
four live gates and the promotion requirement (≥30 demo round trips, positive net-of-cost PnL,
≥14 days) are untouched by this study in every branch.

## Closure — GDELT is untestable via DOC 2.0 from this host (2026-07-28)

The "proper attempt" promised above was made and **failed at the transport layer, not the statistics
layer**. `node test/backtest/fetch-nonprice.mjs gdelt` ran to completion as a long background job:

```text
bitcoin:  chunks ok=0 fail=122 tonePoints=0 volPoints=0
ethereum: chunks ok=0 fail=122 tonePoints=0 volPoints=0
crypto:   chunks ok=0 fail=122 tonePoints=0 volPoints=0
```

**366 requests, 0 successes.** A single follow-up probe after minutes of idling — the smallest ask the
endpoint accepts (`timespan=1d`) — still returns:

```text
HTTP 429
"Please limit requests to one every 5 seconds or contact ... All high-traffic users
 should switch to our ngrams dataset"
```

Identical on `https` and `http`, on `timelinetone` and `timelinevol`. DNS resolves
(`104.197.47.124`), so this is a throttle, not an outage.

**What this settles and what it does not.** It settles that the 6 s spacing is insufficient and that
the throttle is **sticky** — it latches after a burst and does not release for at least tens of
minutes, so no pacing this harness can apply will complete a full-window backfill. It settles
nothing whatsoever about whether news tone predicts returns. **GDELT's 12 cells stay UNTESTED, never
FAILED**, and quoting them as evidence either way would be exactly the error this study was built to
avoid.

**Do not re-run the backfill.** It cannot succeed from this host and each attempt re-latches the
throttle.

**The named alternative, deliberately not built.** GDELT's own 429 body points high-volume users at
the **Web NGrams dataset** — bulk files rather than a per-query API, and a genuine route to the same
signal class. It is not built because it is a new bulk-ingestion component, and the non-price
hypothesis has already failed **15 of 15 runnable cells across two independent channels** inside a
program whose central finding is that this architecture's entries are anti-predictive. It is recorded
as a costed frontier, not a backlog item.

**Study status: CLOSED.** 15/15 runnable cells FAIL; 12 GDELT cells permanently untested by this
route. The Bonferroni denominator stays 27 as pre-registered, so the correction applied to the
runnable cells is unchanged — fixing it up front is precisely what makes this closure legitimate
rather than a post-hoc narrowing of the family.
