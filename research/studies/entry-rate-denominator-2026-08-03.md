# Entry rate — one denominator, registered (2026-08-03)

_Four different "entry rate" figures circulate in this program and none of them carries its own
denominator. This study registers one definition, measures it per playbook version and venue,
reconciles every circulating figure against it, and closes two open adjudications: the `n=64`
staleness question and the `13.29%` provenance question. **The `13.29%` figure is VERIFIED, and its
source is a data file, not a sentence.**_

**As-of:** `created_at < 2026-08-03T22:00:00Z` (a fixed cutoff, so every number below is
reproducible). Live `cryptobot` database, read-only via `docker exec crypto-bot-postgres-1 psql`.
HEAD `4eeefd5`.

## Bottom line

| Question | Answer |
| --- | --- |
| What is the registered lifetime entry rate? | **92 / 996 = 9.2369%** (loose form) or **91 / 996 = 9.1365%** (proportion-safe — see § 2, one entry was not from FLAT). |
| Is the census's 92 / 981 = 9.38% right? | **Yes, exactly**, at its own 18:25:30Z cutoff. Reproduced independently to the row (§ 1). |
| Is the record's `n=64` wrong? | **No — it is STALE, not wrong.** The `recorded-entries-v3.jsonl` fixture reproduces exactly (64 entries) over its own frozen window `[2026-07-22T17:30Z, 2026-07-27T20:00Z]`. 28 further entries have occurred since (§ 4). |
| Is the supplied **13.29%** verifiable? | **VERIFIED.** It is 78 FLAT entries / 587 FLAT rows = **13.2879%** over the window of `test/eval/agentic/data/corpus-v4-flat.jsonl`. Reproduced from the live journal to the row (§ 5). |
| Does the current lane still enter at 13.29%? | **No. 3.87%** under playbook v10 (21 / 543). The rate has more than halved since the corpus was cut (§ 3). |
| Does spot "never trade"? | **False as a lifetime claim.** Spot has **14** lifetime `open_long` entries and **zero** `open_short`, ever. The zero-entry claim is TRUE and window-scoped to v10 (§ 6). |
| Is the v10 lane inside the OOS arm's own VOID band `[4%, 40%]`? | **No — 3.87% is BELOW the 4% floor** (§ 7). |

## Registered definition

```text
entry_rate := count(action IN ('open_long','open_short'))
              / count(rows whose input_payload carries the FLAT position marker)

both restricted to:  trigger_kind = 'candle'
                     strategy_id NOT LIKE 'replay-%'
FLAT marker:         position('"position":{"side":"FLAT"' in input_payload) > 0
```

**The marker string is not re-typed here as a new constant.** It is the literal already used by the
production sweep tooling at `scripts/loop-forward-return.mjs:36-37`
(`FLAT_MARKER_SQL = '\'"position":{"side":"FLAT"\''`), reused verbatim so the definition cannot drift
from the tool that reports on it. The two filters come from the same file: `strategy_id NOT LIKE
'replay-%'` at `:39-41` (synthetic replay rows are journalled into the same live table) and
`trigger_kind = 'candle'` at `:42-43` (an `exec`-triggered row stamps a fill time, not a bar open).

**Why FLAT and not all rows.** Entries occur only from a flat position for this book, so an
all-rows denominator mixes two opportunity sets — bars where an entry was possible and bars where
the model was already in the trade and could only hold, adjust or close. The 756 payload-bearing
non-FLAT rows (§ 1) are decisions about an existing position; counting them dilutes the rate by a
factor that varies with how long positions are held, which is a different behaviour entirely.

**Failure direction of this definition: it is a MEASUREMENT and it fails OPEN.** A row whose payload
is absent is excluded from both numerator and denominator rather than assumed non-FLAT; the rate is
therefore reported over a smaller, honest population rather than a larger, guessed one.

## 1. The population, reproduced independently

Every count below is a fresh query, not a transcription of `census-2026-08-03.md`.

| quantity | at census cutoff (18:25:30Z) | at this study's cutoff (22:00:00Z) |
| --- | --- | --- |
| all `trigger_kind='candle'` non-replay rows | 43,312 | 43,872 |
| rows carrying `input_payload` | 1,731 | 1,752 |
| FLAT-marker rows (the denominator) | **981** | **996** |
| entries (`open_long` + `open_short`) | **92** | **92** |
| entries that are also FLAT | 91 | **91** |
| registered rate | **9.3782%** | **9.2369%** |

**The census reproduces exactly at its own cutoff** — 43,312 / 1,731 / 981 / 92, all four. No
disagreement was found anywhere in the census's § 3.

Composition of the 43,872 rows, because the denominator's meaning depends on it:

| slice | n | share |
| --- | --- | --- |
| `prescreen` holds, NULL payload | 39,989 | 91.1% |
| `plan-executor` holds, NULL payload | 1,458 | 3.3% |
| `claude-sonnet-5` `error`, NULL payload | 626 | 1.4% |
| `claude-sonnet-5` `hold`, NULL payload | 47 | 0.1% |
| payload-bearing, FLAT | **996** | **2.3%** |
| payload-bearing, not FLAT | 756 | 1.7% |

**Stated as a limitation, not a footnote: FLAT is detectable on 4.0% of candle rows.** Quiet and
prescreen holds carry a NULL `input_payload`, so the position side is unrecoverable for 42,120 rows.
A prescreen-held bar may well have been FLAT. The registered rate therefore measures **the model's
propensity to enter given that it was consulted and flat** — not the system's propensity to enter
given a flat book. Those two quantities differ by the prescreen's 39,989 rows and no query in this
study can bridge them.

## 2. One entry did not come from FLAT, so the loose form is not a proportion

| id | venue | symbol | action | pv | `event_time` | recorded position |
| --- | --- | --- | --- | --- | --- | --- |
| 11268 | `binanceusdm` | HYPE/USDT:USDT | `open_long` | 3 | 2026-07-24T09:45:00Z | `"side":"LONG","qty":"0.27","avgEntry":"58.508"` |

91 of 92 lifetime entries carry the FLAT marker. One is an `open_long` issued on an already-long
position. Consequences:

- The literal registered form `92 / 996 = 9.2369%` has a numerator that is **not a subset** of its
  denominator, so it is a ratio and not a proportion. Any binomial interval or one-sample proportion
  test must use the proportion-safe form **`91 / 996 = 9.1365%`**.
- The difference is 0.10 pp and changes no conclusion in this study. It is recorded because a later
  step that runs a proportion test on this rate needs to know which form it inherited.
- The same single row is already visible in the frozen fixture as `was_flat: false` (§ 4), which is
  independent confirmation that this is a real recorded event and not a marker-matching artifact.

## 3. The rate by playbook version and venue

Denominator is FLAT rows; numerator is all entries in the cell.

| pv | venue | FLAT rows | entries | rate | window (FLAT rows) |
| --- | --- | --- | --- | --- | --- |
| 1 | `binance` | 71 | 8 | 11.27% | 2026-07-21 → 07-23 |
| 1 | `binanceusdm` | 139 | 20 | 14.39% | 2026-07-21 → 07-23 |
| 2 | `binance` | 27 | 4 | 14.81% | 2026-07-23 → 07-24 |
| 2 | `binanceusdm` | 33 | 14 | 42.42% | 2026-07-23 → 07-24 |
| 3 | `binanceusdm` | 0 | 1 | undefined | — |
| 6 | `binance` | 20 | 0 | 0.00% | 2026-07-24 → 07-25 |
| 6 | `binanceusdm` | 28 | 5 | 17.86% | 2026-07-24 → 07-25 |
| 7 | `binance` | 11 | 0 | 0.00% | 2026-07-24 → 07-25 |
| 7 | `binanceusdm` | 23 | 5 | 21.74% | 2026-07-24 → 07-25 |
| 8 | `binance` | 20 | 1 | 5.00% | 2026-07-27 → 07-30 |
| 8 | `binanceusdm` | 41 | 7 | 17.07% | 2026-07-27 → 07-30 |
| 9 | `binance` | 11 | 1 | 9.09% | 2026-07-27 → 07-30 |
| 9 | `binanceusdm` | 29 | 5 | 17.24% | 2026-07-27 → 07-30 |
| **10** | **`binance`** | **232** | **0** | **0.00%** | **2026-07-30 → 08-03** |
| **10** | **`binanceusdm`** | **311** | **21** | **6.75%** | **2026-07-30 → 08-03** |

`pv=3` is the HYPE row of § 2 and is the reason a cell can carry an entry with a zero denominator.
`pv=4`/`pv=5` never produced a payload-bearing row.

**There is no single number.** The cell range is 0.00% to 42.42%, and the current playbook's cells
(0.00% spot, 6.75% perp, 3.87% combined) sit at the bottom of that range. Three lifetime aggregates,
each with its denominator:

| population | FLAT rows | entries | rate |
| --- | --- | --- | --- |
| whole book, lifetime | 996 | 92 | **9.2369%** |
| `binanceusdm` only, lifetime | 604 | 78 | **12.9139%** |
| `binance` only, lifetime | 392 | 14 | **3.5714%** |
| whole book, v10 only | 543 | 21 | **3.8674%** |

The daily rate (entries / FLAT rows that day) falls across the week without being monotone: 24.21%
(07-23), 28.38% (07-24), 4.88% (07-25), 17.50% (07-27), 10.84% (07-30), 6.40% (07-31), 3.03%
(08-01), 1.35% (08-02), 4.31% (08-03). 2026-07-28 and 07-29 carry candle rows but zero
payload-bearing ones; 2026-07-26 carries no non-replay candle row at all.

## 4. `n=64` versus 92 — STALENESS, and it reproduces exactly

**Adjudicated by reproducing the fixture from the live journal, not by argument.**

`test/eval/agentic/data/recorded-entries-v3.jsonl` holds 64 rows spanning `event_time`
`[2026-07-22T17:30:00Z, 2026-07-27T20:00:00Z]`, with fields `id, symbol, event_time, action,
was_flat`. Querying the live journal over exactly that window:

```sql
SELECT count(*) FILTER (WHERE action IN ('open_long','open_short')) AS entries,
       count(*) FILTER (WHERE strpos(coalesce(input_payload,''),
                                     '"position":{"side":"FLAT"') > 0) AS flat_rows
FROM agent_decisions
WHERE trigger_kind='candle' AND strategy_id NOT LIKE 'replay-%'
  AND event_time >= extract(epoch FROM timestamptz '2026-07-22 17:30:00+00')*1000
  AND event_time <= extract(epoch FROM timestamptz '2026-07-27 20:00:00+00')*1000;
```

| check | fixture | live journal |
| --- | --- | --- |
| entries | 64 | **64** |
| `was_flat` true / false | 63 / 1 | **63 / 1** |
| spot `open_long` | 12 | **12** |
| perp `open_long` + `open_short` | 33 + 19 | **33 + 19** |

**Verdict: the same quantity, measured over a frozen window.** `n=64` was correct at authorship and
is correct now for its window; 92 is the same measure run to 2026-08-03. 28 entries have accrued
since the fixture was cut. The `−13.75 (n=64, not 61)` correction at `verdicts.md:159-170` and
`STATUS.md:80` is about a _third_ thing — how many of those 64 rows were **scoreable** against the
OHLCV cache (61 before the refresh, 64 after) — and is untouched by anything here. All three numbers
are right; they answer three different questions.

**The entry rate in that window is 23.27%** (64 entries / 275 FLAT rows; spot 12/115 = 10.43%, perp
52/160 = 32.50%) — 2.5× the current lifetime rate, which is why a window-scoped figure quoted as a
lane property misleads.

## 5. 13.29% — VERIFIED, and the earlier search missed it for a good reason

`oos-session-arm-2026-08-03.md:143` records 13.29% as the arm's scored baseline and marks it
**UNVERIFIED**, having searched the repository for the literal string `13.29` and found only
unrelated hits (`:674`). That search was correct and its conclusion was still wrong: **the figure is
in the repository as data, in a 4 MB JSONL that never states its own rate.**

`test/eval/agentic/data/corpus-v4-flat.jsonl` holds **587 rows** spanning `event_time`
`[2026-07-21T15:00:00Z, 2026-07-31T20:30:00Z]`, recorded actions `hold` 506, `open_long` 52,
`open_short` 26, `close` 3.

```text
(52 + 26) / 587 = 78 / 587 = 0.1328790 = 13.2879%  →  13.29%
```

Reproduced from the live journal over the same window, independently of the file:

| population | FLAT rows | FLAT entries | all entries | rate |
| --- | --- | --- | --- | --- |
| `corpus-v4-flat` window | **587** | **78** | 79 | **13.2879%** |
| `corpus-v3-flat` window | **386** | **62** | 63 | **16.0622%** |

The v3 line is the confirming control: `verdicts.md:273` records the live-recorded entry rate on that
corpus as **16.1%**, and 62/386 = 16.06% is that number. The same construction on the v4 corpus is
13.29%. Both windows contain exactly one non-FLAT entry — the § 2 HYPE row — which is why
`all entries` exceeds `FLAT entries` by one in each.

**So 13.29% is the same quantity this study registers, measured over the frozen v4 replay corpus.**
It is not a different definition and it is not wrong. It is **stale by four days**, and in those four
days the lane's rate fell to 9.24% lifetime / 3.87% under the current playbook.

### A caution earned in the process of finding it

Before locating the corpus, a brute-force search over every hour-boundary window of the journal
(3 venue slices × 2 denominators × ~46k window pairs, denominators ≥ 100) found **20 distinct
windows** whose rate rounds to 13.29% at two decimals. One of them —
`binanceusdm` FLAT rows, 2026-07-21T18:00Z → 2026-08-03T19:00Z — is **also 78 / 587**, the same two
integers as the corpus, over a completely different population. **A two-decimal rate is
window-fittable; matching one proves nothing.** The corpus identification stands only because the
file exists, its window is declared, and the v3 control reproduces an independently recorded figure
(16.1%) by the identical construction.

## 6. The spot correction — the zero-entry claim is window-scoped, and it matters

`STATUS.md:70` and `:141` / `:158` record _"191 spot consults → 0 entries"_. Read as a lane property
it says spot never trades. That reading is false.

**Every spot entry in the book's history, in full:**

| `event_time` | symbol | pv |
| --- | --- | --- |
| 2026-07-22T17:30:00Z | SOL/USDT, AAVE/USDT, ETH/USDT, BTC/USDT | 1 |
| 2026-07-22T23:45:00Z | PEPE/USDT | 1 |
| 2026-07-23T03:15:00Z | ZEC/USDT | 1 |
| 2026-07-23T15:30:00Z | AAVE/USDT, ZEC/USDT | 1 |
| 2026-07-23T23:15:00Z | BTC/USDT, SOL/USDT | 2 |
| 2026-07-24T06:30:00Z | AAVE/USDT | 2 |
| 2026-07-24T07:00:00Z | PEPE/USDT | 2 |
| 2026-07-30T09:00:00Z | ZEC/USDT | 9 |
| 2026-07-30T10:15:00Z | BTC/USDT | 8 |

**14 lifetime spot entries, all `open_long`, zero `open_short` ever.** Last spot entry
**2026-07-30T10:15:00Z**. Playbook v10 went live at **2026-07-30T16:45:00Z** (first v10-tagged
journal row). So:

- **True in the v10 window:** 0 entries over **232** spot FLAT consults (the recorded 191 has since
  grown to 232 — the claim was right when written and its denominator moves).
- **True lifetime:** 14 entries over 392 spot FLAT consults = **3.5714%**, against perp's 12.9139%.
- **True in the pre-v10 era:** spot entered at 8.45% (12 of 142 FLAT rows through 2026-07-30T00:00Z),
  i.e. roughly 40% of the perp rate over the same period — suppressed, not absent.

**What a step that retires the spot menu must not assume.** Not that spot never trades: it traded 14
times, and its suppression is coincident with v10 and therefore confounded with it (`STATUS.md:158`
already flags the confound). An expectancy argument needs the spot round-trip population, and that
population is **7 closed cycles**, not 7 or 14 entries — the two are different objects and the record
conflates them. Driving the production `walkRoundTrips` over the live fills (see
`fee-floor-derivation-2026-07-31.md` § Amendment 2026-08-03 § A3 for the method) gives spot **7
closed round trips, gross realised −$8.9557, net of fees −$9.8632**. `STATUS.md:158`'s _"−$8.01 over
7 lifetime entries"_ reproduces at neither figure; the nearest neighbour is the cumulative net after
**six** cycles, −$8.1425 at 2026-07-31T01:10:54Z. **That figure is not adjudicated here** — it is
flagged as not-reproduced so the expectancy step re-derives it rather than inheriting it.

## 7. Reconciling all four circulating figures

| figure | same quantity, or different? | denominator | window | verdict |
| --- | --- | --- | --- | --- |
| **21.8%** (`champion_v8` sonnet replay) | **Different numerator, same form.** The numerator is a _re-decided_ action from a replayed model, not the live lane's own recorded action. | 354 scored rows of the v3 FLAT corpus | `[2026-07-21T15:00Z, 2026-07-27T19:30Z]` | Not comparable to a live rate without stating that the actions are synthetic (`verdicts.md:190`). |
| **62.0%** (`champion_v8` kimi-k3 replay) | Same as above, different model. | same 354 rows | same | The program already classes this as a different behaviour, not a different quality. |
| **13.29%** (the arm's scored baseline) | **Same quantity.** | 587 FLAT rows of the v4 corpus | `[2026-07-21T15:00Z, 2026-07-31T20:30Z]` | **VERIFIED** (§ 5). Stale by four days. |
| **VOID band `[4%, 40%]`** | **Different kind — a bound on a future read, not a measurement.** | the arm's own sealed rows | forward | The live lane's current rate, 3.87%, is **below the floor** (§ 3). |
| **16.1%** (live-recorded, study corpus) | Same quantity, v3 corpus. | 386 FLAT rows | `[2026-07-21T15:00Z, 2026-07-27T19:30Z]` | Reproduced: 62/386 = 16.06% (§ 5). |
| **9.38%** (census) | Same quantity, lifetime. | 981 FLAT rows | to 2026-08-03T18:25:30Z | Reproduced exactly (§ 1). |

**The single sentence this table exists to enable:** every figure above except the VOID band is the
same ratio, and they differ only in _which rows_ and _whose actions_. None of them is wrong; quoting
any of them without its window and its action-source is.

## What this study cannot answer

- **It cannot see the opportunity set.** 42,120 of 43,872 candle rows carry no payload, so whether
  the book was flat on those bars is unrecoverable. Everything here is conditioned on a consult
  having happened.
- **It does not explain why the rate fell.** The v10 coincidence is recorded and is confounded with
  the `inverted` playbook shipping at 2026-07-30T16:57Z with no control arm (`STATUS.md:158`). This
  study measures the fall; it does not attribute it.
- **It computes no forward return, expectancy or edge.** An entry rate is a behaviour, not a
  performance. Nothing here supports or refutes any claim about whether those entries were good.
- **It does not re-adjudicate `−13.75` or `n=61`.** Those concern scoreability against the OHLCV
  cache, not entry counting, and are cited as-is.
- **The `−$8.01` spot PnL figure is flagged, not resolved** (§ 6). Reproducing it requires knowing
  the as-of instant and the fee treatment the original used, and neither is recorded.
- **It measures no live venue.** There is no live book.
