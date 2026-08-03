# Book truth — the population ledger (2026-08-04)

_The atomic book tuple, recomputed from raw rows under the production definitions, plus THE
population ledger every later write-up must cite instead of re-counting. Companion to
`research/studies/census-2026-08-03.md` (which counted rows) — this one closes round trips._

**Harness:** `test/backtest/book-truth.spec.ts`, gated `BOOK_TRUTH=1` + `DATABASE_URL`, read-only,
self-skipping, off the production gate.
**Anchor as-of:** `BOOK_TRUTH_AS_OF_MS=1785773220000` = **2026-08-03T16:07:00Z**, the instant
`STATUS.md:87-93` records its tuple at. A second uncapped run is reported alongside it.
**Epoch:** `PROMOTION_EVIDENCE_EPOCH` = 1784632860000 = 2026-07-21T11:21:00Z (round-tripped through
`to_timestamp()` before use, per the census's standing check).

> **Reproducibility warning, stated first because it bit this study.** An UNCAPPED run is not
> reproducible: the lane is live and `agent_decisions` grows continuously, so two uncapped runs four
> minutes apart returned `llmCostUsd` 28.7683109 and 28.8562685. **Every figure below is anchored to
> the 16:07:00Z cap unless it says otherwise.** Any future citation of a book figure that does not
> carry an as-of instant is unreproducible by construction.

## 1. The tuple reproduces — exactly, once funding ingest lag is accounted for

`STATUS.md:87-93` records, as one `evaluate()` sample: `roundTrips=48, windowDays=10.85,
netPnlUsd=−60.34, llmCostUsd=28.15, winRate=0.25`, and `gross −$32.19 lifetime`.

Recomputed from raw rows at the same instant:

| quantity | recomputed | recorded | agrees? |
| --- | --- | --- | --- |
| `roundTrips` | **48** | 48 | yes |
| `windowDays` | **10.847196840277778** | 10.85 | yes |
| `realizedPnl` (gross of fees) | **−27.9337071** | not recorded separately | — |
| `fees` | **3.5092247844** | not recorded separately | — |
| `llmCostUsd` | **28.1473391** | 28.15 | yes |
| `fundingNet` by `funding_time` (today) | **−0.77918708** (53 rows) | — | — |
| `fundingNet` as-ingested at 16:07Z | **−0.74678358** (50 rows) | — | — |
| `netPnl` using today's funding | −60.3694580644 | −60.34 | **no, off by $0.0295** |
| `netPnl` as-ingested | **−60.3370545644** | −60.34 | **yes** |
| `gross` (= net + LLM) as-ingested | **−32.1897154644** | −32.19 | **yes** |
| `winRate` | **0.25** (12 of 48) | 0.25 | yes |

**The $0.03 discrepancy is a real defect, not a rounding artifact, and it is named here because it
makes recorded book figures non-reproducible.** `PromotionStatsRepository.fundingNetForMode`
(`promotion-stats.repository.ts:198-213`) filters funding on `funding_time` — the market instant —
and has no `created_at` predicate. Three `funding_time = 2026-08-03T16:00:00Z` rows (ETH −0.03898766,
NEAR +0.00558693, HYPE +0.00099723, net **−0.03240350**) were not written until **16:37:10–16:37:28Z**,
a **~37-minute ingest lag**. The 16:07Z sample therefore could not see them; the same query today
returns them. Re-running the promotion gate against history reproduces a DIFFERENT `netPnl` than the
gate itself returned, for any sample taken inside the funding poller's lag window.

Direction: the effect makes a live sample read **less negative** than the settled truth, i.e. it
flatters the book — the wrong direction for a permission gate. It is small here ($0.032 on a $60
loss) and is recorded as a measurement-reproducibility defect, not as a promotion-gate safety defect;
no verdict in this pass turns on it.

Every other operand reproduces to full precision, including `llmCostUsd`, which was rebuilt
independently from `agent_decisions` (replay excluded) + `llm_usage` (`kind='reflection'`) at the
deployed rate card, with the unknown-model fail-closed fallback (`claude-opus-4-8` carries 58
reflection rows and appears in no price map, so it prices at the component-wise max, 5/25/0.5/10).

## 2. THE POPULATION LEDGER

Every closed-round-trip count circulating in the record is here, with its definition, its as-of, and
what produces it. **They are all correct for their own window.** None of them is wrong; they were
being compared as if they shared a denominator, and they do not.

| n | definition | as-of | source |
| --- | --- | --- | --- |
| **23** | closed round trips, `walkRoundTrips`, epoch-bounded | 2026-07-27T15:49:13Z | this spec, cap sweep |
| **27** | 23 closed **+ 4 open cycles marked to market** — _not_ a closed-trip count | 2026-07-27 freeze | `verdicts.md:432-433` |
| **32** | closed round trips | 2026-07-31T00:00:00Z | this spec, cap sweep |
| **38** _(a)_ | closed round trips | 2026-07-31T17:30:34Z | this spec; matches `learning-capacity-2026-07-31.md:113` |
| **38** _(b)_ | **measurable** trips of 46, after excluding 8 for an OHLCV grid gap | 2026-08-03 | `frame-audit-2026-08-03.md:94` |
| **46** | closed round trips (`fills=284`) | 2026-08-02T16:00:36Z | this spec; matches `frame-audit-2026-08-03.md:19` |
| **48** | closed round trips | 2026-08-03T14:20:24Z | this spec; the `STATUS.md` tuple |
| **49** | closed round trips | 2026-08-03T17:15:34Z (latest fill) | this spec, uncapped |
| **50** | the **pure-SQL probe's** count — 49 real + 1 phantom | 2026-08-03T16:07Z | § 3 |

**The two 38s are a collision, and it is the ledger's most dangerous entry.** `38(a)` is a closed-trip
count on 2026-07-31; `38(b)` is a measurable-subset count on 2026-08-03 whose own population is 46.
They are numerically equal and semantically unrelated. Any sentence citing "38 round trips" without an
as-of is ambiguous between them.

Companion counts, for the same reason:

| n | definition | as-of | source |
| --- | --- | --- | --- |
| **295** | `fills`, all-time — **and** all of them are `mode='testnet'` and post-epoch | 2026-08-03T17:15:34Z | `fills` |
| **294** | `fills` at the 16:07Z anchor | 2026-08-03T16:07:00Z | this spec |
| **159** | fills since a **mis-transcribed epoch of 2026-07-25T11:21:00Z** — four days late | — | census § header trap |
| **92 / 94** | lifetime journalled entry actions (`open_long`+`open_short`) | 92 at 2026-08-03T18:25Z; **94** at 2026-08-04 | `agent_decisions` |
| **64** | the ENTRIES-signal population (`n=64, mean −13.7503 bps`) | frozen, pre-2026-08-03 | `verdicts.md:166,170` |
| **15 / 12** | distinct symbols / distinct base assets traded since epoch | 2026-08-03 | `fills` |

**`64` and `92` are not the same quantity measured twice.** `92` counts journalled entry ACTIONS in
`agent_decisions`; `64` is the population of entries carrying a measurable forward return in the
signal study's frozen corpus. They differ by window AND by definition, and the census's framing of
`64` as merely "stale" understates it: even re-run today the two definitions would not converge,
because a journalled entry at the end of a symbol's series has no forward return and is dropped from
the signal population by construction (`playbook-space-replay.ts` `fwdBps` returns null there). This
study does not adjudicate the −13.75 figure; it only refuses the identification of its `n` with the
census's.

**Reconciliation of `295` vs `159`:** verified directly — `count(*) where mode='testnet' and
venue_timestamp >= 2026-07-25T11:21:00Z` returns exactly **159**, confirming the census's
self-reported mis-transcription was a four-day-late epoch and nothing else. There is no second fill
population.

## 3. Two walks, one disagreement, and it is the right one

Both walks ran over the same 294 rows at the anchor.

1. **Production** — `walkRoundTrips` imported from `src/domain/trading/risk/round-trips.ts`, the same
   fold the promotion gate runs. Boundaries are never re-derived; the partition into cycle members
   uses `partitionFillsIntoCycles`, which probes the production function itself rather than
   re-implementing the closure rule.
2. **Pure-SQL probe** — a window-function running signed qty per `(strategy_id, symbol)`, closing
   wherever residual notional (`|running qty| × that fill's own price`) drops below the $5 dust
   floor.

**Writing a second implementation was deliberate, and it is exactly what the corpus-fingerprint
lesson forbids for an IDENTITY function** (`corpus-fingerprint-drift-correction-2026-08-03.md`: _"a
reimplemented hash is a second source of truth — import it or do not compute it"_). The distinction
that makes it correct here: an identity function has one right answer and a second implementation can
only manufacture a fake disagreement. An **audit** wants the disagreement — it is the measurement.
The production walk is the truth throughout; the SQL is a probe, and where they differ the SQL is
wrong by construction, because it carries neither the stateful `peakNotional` guard nor the
position-reset at close.

**Result, fill by fill:**

| direction | count | detail |
| --- | --- | --- |
| both walks close | **49** | every production boundary, exactly |
| SQL closes, production does NOT | **1** | `fill_id=138` |
| production closes, SQL does NOT | **0** | — |

The single divergence is `fill_id=138`, `agentic-35`, `BCH/USDT:USDT`, **2026-07-27T12:15:46Z**,
BUY 0.022 @ 218.49 = **$4.8068** residual against the $5 dust floor. It is the first of **eight**
same-millisecond BUY fills of one order (138–145, total $79.85). The SQL probe closes a cycle there —
cost and no proceeds, a **−10,000 bps phantom trip** — and then matches the remaining 0.343 bought
against 0.365 sold. The production walk refuses, because `peakNotional` never reached dust.

**This is a live confirmation that the `peakNotional` guard is load-bearing, on the exact incident its
own comment cites** (`round-trips.ts:68-75`, added after 2026-07-27). It is not a hypothetical
defence: it is the only thing standing between the promotion gate's round-trip count and a 50th trip
that never happened. Note the direction — the guard makes the gate **under-count**, which is the
fail-closed direction for a live-arming input.

**The probe agreed everywhere else despite lacking the reset**, which is worth stating rather than
assuming: after a production close the carried residual is by definition below dust, so the SQL's
running sum re-enters the next cycle offset by a dust quantity that never moves a subsequent
crossing. The reset difference is real but inert on this book. It would not stay inert on a book with
many dust-tailed cycles in one `(strategy_id, symbol)` group.

`partitionMismatches = 0`: every cycle's realized PnL recomputed from its own partitioned members
equals the fold's own `realizedPnl` exactly. The frame-audit's own partition bug shape did not recur
here.

## 4. `winRate`, recomputed under the service's own definition

`PromotionReadinessService` defines a win as **per-trip `realizedPnl − feesQuote > 0`**
(`promotion-readiness.service.ts:136-139`). Recomputed: **12 wins of 48 = 0.25** at the anchor,
12 of 49 = 0.2449 uncapped.

**The definition carries no LLM term, and that is the whole point of R1.** LLM spend enters the
verdict only at book level, in `netPnl`. A trip that earns +$0.30 net of fees is a "win" while the
lane's amortized inference cost for that trip is **$0.5864** — measured, § 5. The win rate is
therefore not a measure of whether trips pay for themselves; it is a measure of whether they beat the
venue. Under an all-in per-trip definition the win count would be far lower, but this study does not
restate it as such: changing the definition of a gate input is R1's pre-registered territory, not a
recomputation.

## 5. One-way notional per trip — the `$72` figure does not reproduce

One-way notional is `turnover / 2`, turnover being the sum of `qty × price` over every member fill of
a cycle (both legs).

| statistic | value (USD, anchor, n=48) |
| --- | --- |
| mean | **83.2531** |
| median | **80.1664** |
| min | 23.4083 |
| p10 | 49.1658 |
| p90 | 118.7975 |
| max | 136.1501 |
| `binance` (spot), n=7 | mean 64.8174, median 77.9161 |
| `binanceusdm` (perp), n=41 | mean 86.4007, median 80.8055 |

**The `~$72/trip` figure in circulation does not reproduce as any statistic of this distribution** —
not the mean, not the median, not either venue's mean or median. The measured central value is
**$80–83**. Consequence for R1: an LLM-cost-per-trip expressed in bps against $72 is **~15% too
large**. The correction moves the LLM term _down_, and R1 reports it moved.

## 6. Epoch-straddle bound: exactly zero

The concern is real in general — `fillsForMode` filters fills by `venue_timestamp >= epoch` BEFORE
the walk, so a cycle that OPENED before the epoch loses its cost basis, and
`promotion-readiness.service.ts:54-71` documents that the service has no signal to detect it.

**Measured here: `count(*) from fills where mode='testnet' and venue_timestamp < 1784632860000` = 0.**
The first demo fill of any kind is **2026-07-23T15:45:22Z**, two days after the epoch.

**So the uncertainty band on this tuple from epoch straddle is exactly zero, not "small".** No cycle
can straddle an epoch that predates every fill. This also independently confirms the operational
precondition the service's comment says it cannot verify — the epoch was declared at a flat instant —
for the trivial reason that there was nothing to be flat about.

The band is zero for THIS tuple and this epoch only. It is not a general property, and re-stamping
the epoch forward would reintroduce it immediately.

## 7. Gross, net, and the composition, at the anchor

```text
realizedPnl (gross of fees)   −27.9337071
  − fees                       −3.5092247844
  + fundingNet (as-ingested)   −0.74678358
  ---------------------------------------------
  = "gross" per STATUS.md      −32.1897154644     (everything except inference)
  − llmCostUsd                −28.1473391
  ---------------------------------------------
  = netPnl                     −60.3370545644
```

Reading, unchanged from the record and now measured: **inference is 46.6% of the total loss, and
zeroing it entirely still leaves −$32.19.** The lane does not become profitable by becoming free.
What is new is § 5's denominator: −$32.19 over 3996.15 of one-way notional is **−80.6 bps per round
trip net of fees and funding**, which R1 sets against a derived bar rather than an asserted one.

## What this study cannot answer

- **It does not measure edge, forward return, or the passive benchmark.** It closes cycles and counts
  dollars. Whether the entries had signal is settled elsewhere and is untouched here.
- **It cannot reproduce a live `evaluate()` sample to the cent from the DB alone.** § 1's funding
  ingest lag means a sample's value depends on poller wall-clock, not only on market time. The
  as-ingested reconstruction here is a repair for one known lag; a different ingest path with a
  different lag would need its own.
- **It does not adjudicate `n=64`.** § 2 refuses the identification of that population with the
  census's 92/94 and stops there.
- **The `27` figure is carried, not verified.** Marking four open cycles requires marks this study
  never fetched; it is reproduced from `verdicts.md:432-433` as a definition, not as a measurement.
- **`winRate` is reported under the production definition only.** § 4 names the all-in alternative and
  deliberately does not compute it.
- **Nothing here is out-of-sample.** One book, one 10.85-day window, one regime, 12 base assets. Every
  count in § 2 is a census of that window, and no count in it is evidence about any other window.
