# Success and stop criteria — what would justify live money, and what would justify stopping (2026-07-31)

**THIS RECORD IS A RECOMMENDATION TO THE OWNER. IT ENACTS NOTHING.** It changes no clause, no
threshold, no configuration and no code. `charter.md:170-174` enumerates the set the 2026-07-22
gate-override grant did **not** touch, verbatim: *"KEPT — the ONLY human gate, unchanged: the 16
live-flip code gates + the bootId arming ceremony + PromotionReadinessService (≥30 closed demo round
trips AND positive net-of-cost PnL over ≥14d)"*. `PromotionReadinessService` is named in that KEPT
set. The promotion gate therefore sits **inside** the live-flip exception and **outside** autonomy
grant 6 — the loop may not raise it, lower it, re-word it, or route around it. Everything below is
offered as a proposal for the owner to accept, amend or reject. If the owner does nothing, the
program's behaviour is unchanged and the gate keeps refusing, which is the correct default.

Two further boundaries, stated so this document cannot be mis-cited later:

- **Nothing here re-opens a settled verdict.** `verdicts.md` binds unchanged. The entry signal
  measures −16.9 bps at h=1 and loses to a random-bar placebo at p = 0.0013–0.0037
  (`verdicts.md:325-326`). This record takes that as given and asks only what evidence would have to
  appear for a live flip to be defensible.
- **This is not the argument the amendment excluded.** `entry-rate-rederivation-2026-07-30.md:351-353`
  bars "the promotion gate is unreachable" from being used as grounds to restore a pro-entry
  objective. This record does not restore any objective; it proposes exit criteria in both directions
  and recommends *less* trading, not more.

## 1. The gate as it actually is — verified today, not quoted

All line references are `src/features/trading/mode-control/promotion-readiness.service.ts` unless
stated otherwise.

| element | line | what is there |
| --- | --- | --- |
| `evaluate()` entry | `:45` | returns `NO_STATS_SOURCE` and refuses if the stats port is absent (`:46-48`) |
| thresholds | `:17-18` | `MIN_ROUND_TRIPS = 30`, `MIN_WINDOW_DAYS = 14` |
| net-of-cost definition | `:92` | `realizedPnl − fees − llmCostUsd + fundingNet` — LLM spend is subtracted, funding is signed and added |
| window | `:107-112` | `windowStart = max(firstClosedAt, epochMs)`; `windowDays = (lastClosedAt − windowStart) / DAY_MS` |
| the seven reasons | `:126-133` | `UNRESOLVED_FILL`, `UNCONVERTIBLE_FEE_ASSET`, `INSUFFICIENT_ROUND_TRIPS`, `NON_POSITIVE_NET_PNL`, `INSUFFICIENT_WINDOW`, `FUNDING_DATA_MISSING`, `BELOW_PASSIVE_BENCHMARK` |
| verdict | `:156` | `reasons.length === 0` — every clause must be clear at one and the same evaluation |

**`BELOW_PASSIVE_BENCHMARK` (`:123-124`, `:133`) is DARK, and this record confirms it independently.**
`grep -rn "PASSIVE_BENCHMARK" src/` returns exactly three files — the port symbol
(`src/ports/trading/promotion.ts:239`) and the two lines in this service that import and inject it.
**No composition-root module binds it.** The injection is `@Optional()` (`:40-42`) with the land-dark
posture documented at `:35-39`, so `this.benchmark` is `undefined`, `passivePnlQuote` is `null` and
`belowPassiveBenchmark` is `false`. The clause cannot fire in production today. Binding it would make
the gate strictly harder, never easier.

### The live book — read at 2026-07-31T11:29:09Z, not copied from STATUS

PromQL: `{__name__=~"agentic_promotion_.*|equity_usdt"}` via
`docker compose exec -T prometheus promtool query instant http://localhost:9090`.

| gauge | value read 11:29:09Z | `STATUS.md:62-65` at 09:52Z | clause |
| --- | --- | --- | --- |
| `agentic_promotion_round_trips` | **35** | 35 | `INSUFFICIENT_ROUND_TRIPS` clear, and monotone — it cannot fire again |
| `agentic_promotion_window_days` | **7.6486** of 14 | 7.329 | `INSUFFICIENT_WINDOW` **FIRING** |
| `agentic_promotion_net_pnl_usd` | **−42.5678** | −42.3358 | `NON_POSITIVE_NET_PNL` **FIRING** |
| `agentic_promotion_llm_cost_usd` | **19.7272** | 19.41 | (input to the above) |
| `agentic_promotion_win_rate` | **0.22857** (8 of 35) | — | not a clause |
| `agentic_promotion_ready` | **0** | 0 | `:156` |
| `equity_usdt` | **4975.38** | 4978.33 | not a clause |

**Two clauses fire. The 14-day floor cannot be met before 2026-08-06T18:00:26Z** — `windowStart` pins
to the first closed trip at 2026-07-23T18:00:26Z (`STATUS.md:79-81`), and `Math.max` of a fixed first
close against a fixed epoch (`:107-110`) means no trading pattern moves that date.

**A discrepancy worth recording rather than smoothing over.** Between the 09:52Z snapshot and this
11:29Z read, `window_days` advanced 0.320 days while `round_trips` stayed at 35. `windowDays` advances
only when `lastClosedAt` advances, and `lastClosedAt` is a maximum over cycle close times, so a window
that moves without the count moving means a *previously counted* cycle's `closedAt` moved forward — a
late fill appended to an already-closed cycle re-derived by `walkRoundTrips` (`:83`). It is not a
defect on its face, and it is not confirmed either. It is flagged because **there is no instrument
that would have surfaced it** (§ 9).

## 2. What today's correction established — and the trap inside it

`entry-rate-rederivation-2026-07-30.md` § 9 (`:339-471`) corrected a mechanism error in its own §5.
The corrected facts, which this record builds on and does not re-derive:

- Both counters are **cumulative since the evidence epoch** and **monotone non-decreasing**
  (`:381-384`). There is no rolling window. The 30 and the 14 are never composed into a rate
  (`:393-395`) — which also voids the deleted anti-ratchet objective's "2.14 trips/day" justification
  (`:433-439`).
- Trips are 35 against a floor of 30, so **the window binds, not the count** (`:404`).
- **`NON_POSITIVE_NET_PNL` is the clause that binds on the merits** (`:415`). For `permitted` at the
  earliest arithmetically possible instant, net-of-cost must cross zero by 2026-08-06 — **+$55 to +$62
  over ~6.3 days, +5.5% to +6.2% on the $1,000 effective book** (`:416-417`).
- Gross trading is negative, so **cutting LLM spend to zero cannot make net-of-cost positive**
  (`:418-420`).

**The trap, which § 9.5 names explicitly (`:446-465`) and this record must not fall into.** Because
`windowDays` advances only on closes (`round-trips.ts:200`), the corrected mechanism *stated alone*
reads as an argument to keep trading — a fully abstaining lane freezes the window and
`INSUFFICIENT_WINDOW` fires forever. § 9.5 refutes that three ways. **This record adds a fourth,
observed live today and not previously recorded:**

> **Abstention is not free — it is strictly worse than it looks.** `netPnl` (`:92`) subtracts
> `llmCostUsd`, and LLM spend accrues on **wall-clock** (the lane wakes and consults regardless of
> whether it trades), whereas `windowDays` advances only on **closes**. Measured between the two reads
> above: with the trip count unchanged at 35, `llm_cost_usd` rose $0.3172 and `net_pnl_usd` fell
> $0.2320 in 1.62 hours. So a lane that stops trading **freezes the window while continuing to burn
> net-of-cost**. Both firing clauses get worse together.

That is the real shape of the problem, and it is why a dated decision window (§ 8) is the operative
recommendation rather than drift: **there is no configuration of trading and abstention that makes the
gate easier by waiting.** Trading pushes `netPnl` down at −106.0 bps/trip (`verdicts.md:347`);
abstaining pushes it down at the LLM run-rate while freezing the window. Waiting is a choice with a
price in both directions, and the price is quantified in § 6.

## 3. Is the research bar reachable? The cluster arithmetic

This is the most important section in the record, and it corrects the framing this study was
commissioned under.

### The mechanism

The bootstrap in `test/eval/agentic/playbook-space-replay.ts:553-581` **resamples SYMBOLS, not rows**.
Its own docstring says why: *"Multiple entries on one symbol within hours are not independent, and a
row-level bootstrap would overstate confidence"* (`:554-556`). `clusterBootstrap` buckets observations
by `o.symbol` (`:559-565`) and resamples whole buckets (`:570-572`). Therefore **standard error scales
in CLUSTERS, not rows**: `SE(K) = SE(20) · sqrt(20/K)`. Adding rows to a symbol already in the sample
buys almost nothing; only adding *symbols* buys precision — and symbols are capped by the tradable
universe.

**The universe, counted from `.env.app:66` (`TRADING_SYMBOLS`): 40 distinct symbol strings** — 24 spot
plus 16 perp — **but only 28 distinct underlying assets** (BTC/USDT and BTC/USDT:USDT are two cluster
keys and one asset). The bootstrap keys on the string, so **K ≤ 40 is the mechanical ceiling and K ≤ 28
is the economic one**, and even 28 overstates independence in a market with one dominant beta.

### Required means, and the correction to the brief

`playbook-space-followon-2026-07-31.md:599-604` gives, from `inverted`'s own intervals (n=117, 20
clusters): SE = 3.52 / 5.97 / 9.29 / 30.51 bps at h = 1 / 4 / 8 / 24. Required mean = `floor + z·SE`.
**The binding clause is the p-clause at z = 2.2414** (α = 0.0125), not the CI clause — the CI clause
runs at a fixed z = 1.96 and yields the *lower* figures +19.9 / +24.7 / +31.2 / +72.8. The headline
+20.9 / +26.4 / +33.8 / +81.4 are p-clause values (`:601-604`). The brief had this inverted; z = 2.2414
is used throughout below.

**Clusters needed to bring each horizon's requirement down to the best value ever actually observed**
— best-ever taken across all 20 scored cells of `playbook-space-replay-2026-07-28.md:751-766`, which is
`inverted` at every horizon: −0.8 / +0.8 / +19.3 / +47.6.

| h | SE(20) | best-ever observed | clusters needed, demo floor +13.0 | clusters needed, live floor +24.2 |
| --- | --- | --- | --- | --- |
| 1 | 3.52 | −0.8 | **impossible at any K** | **impossible at any K** |
| 4 | 5.97 | +0.8 | **impossible at any K** | **impossible at any K** |
| 8 | 9.29 | +19.3 | **219** (universe is 40) | **impossible at any K** |
| 24 | 30.51 | +47.6 | **79** (universe is 40) | **171** (universe is 40) |

**Say the two answers plainly, because they are different answers and the brief expected only one.**

1. **At h = 1 and h = 4 the answer is not "more symbols than exist". It is "no number of symbols
   whatsoever."** The best mean ever observed at those horizons (−0.8 and +0.8 bps) is **below the fee
   floor itself**. The clause `mean > floor` is α-free and n-free: driving SE to exactly zero with
   infinite clusters still fails it. No amount of data rescues a mean on the wrong side of costs.
2. **At h = 8 and h = 24 the answer is "more symbols than exist."** Under the demo floor, 219 and 79
   clusters against a 40-string / 28-asset universe. Under the live floor the brief correctly demands,
   h = 8 joins category 1 (best-ever +19.3 is below live break-even +24.2) and h = 24 needs **171
   clusters — 4.3× the symbol strings that exist and 6.1× the distinct assets.**

**Under the live +24.2 floor, no horizon's best-ever observation can be rescued by any cluster count
the universe can supply.** That is the single most important fact in this record.

### The floor is an assertion — and the conclusion survives that

A concurrent audit, `fee-floor-derivation-2026-07-31.md`, finds that **+13.0 and +24.2 are asserted,
not derived**: both appear fully formed in one sentence in commit `7b3e977` and nothing in the repo
decomposes either into fee, slippage, funding and inference components (`:14`, `:75-76`). It measures
the demo round-trip cost at **9.29 bps**, making +13.0 conservative by ~3 bps (`:229`), and notes
+24.2 cannot be measured at all because there is no live book and no authoritative live fee schedule
in the repo (`:232-233`).

**This record's G1 therefore quotes a number the program cannot currently derive, and that dependency
is stated rather than hidden.** It does not change the conclusion. Re-running the same arithmetic at
the *measured* 9.29 bps demo floor — the most generous floor the repo can actually defend:

| h | best-ever | clusters needed at the measured 9.29 floor |
| --- | --- | --- |
| 1 | −0.8 | **impossible at any K** |
| 4 | +0.8 | **impossible at any K** |
| 8 | +19.3 | **87** (universe is 40) |
| 24 | +47.6 | **64** (universe is 40) |

**Every conclusion in this section is robust to the floor being wrong by 15 bps in the program's own
favour.** h = 1 and h = 4 remain impossible at any cluster count; h = 8 and h = 24 still need more
symbols than exist. If the owner revises the floor, G1's threshold number moves and this section's
findings do not.

### Why the go-live clause should still be restricted to h ∈ {1, 4} — corrected rationale

The brief's stated reason ("h = 8/24 are cluster-limited beyond the universe") is **wrong for h = 8**
once the live floor it also mandates is applied: h = 8 is not cluster-limited there, it is
**floor-limited**. An h = 8 signal as good as anything ever measured still loses money at live fees.
That is a stronger reason to exclude it, not a weaker one.

The defensible cut is the **decomposition of the requirement into a fee floor (real economics, fixed
forever) and an interval term (a sample-size artifact that clusters could in principle shrink)**, at
the live floor:

| h | req at K=20 | req at K=28 | req at K=40 | interval share of the requirement at K=20 |
| --- | --- | --- | --- | --- |
| 1 | +32.1 | +30.9 | +29.8 | **24.6%** |
| 4 | +37.6 | +35.5 | +33.7 | **35.6%** |
| 8 | +45.0 | +41.8 | +38.9 | 46.2% |
| 24 | +92.6 | +82.0 | +72.6 | **73.9%** |

At h = 1 and h = 4, **three quarters and two thirds of the requirement is the fee floor** — the clause
is asking a real economic question ("does this signal beat live costs?") and the statistical penalty is
5.6–9.5 bps once the universe is fully used. At h = 24, **74% of the requirement is interval width** —
the clause is mostly asking "is your sample big enough?", and the answer is structurally no: bringing
h = 24's interval term down to h = 1's present width would take **1,503 clusters**. Writing a criterion
at h = 24 is writing an unreachable clause and calling it rigour.

**Restricting to h ∈ {1, 4} is therefore honest, but the honesty cuts against a live flip, not for
it**: those are precisely the horizons where the best arm ever measured came in at −0.8 and +0.8 bps
against a requirement of +32.1 and +37.6. The gap is ~33 and ~37 bps. This is carried into § 10 rather
than buried.

## 4. Family B cannot carry a success exit

`playbook-space-followon-2026-07-31.md:494-572` registers Family B as an out-of-sample falsification
test for the `inverted` deployment. Verified:

- Scored arms = 1 (`inverted`), horizons = 4, cells = 4, **α = 0.0125** (`:556-563`).
- **It inherits the same required means.** `:609-610`: *"Both families use these figures: their α is
  the same 0.0125 and the SEs are read off the same best-powered arm."* So Family B must clear
  **+20.9 / +26.4 / +33.8 / +81.4** at the demo floor.
- `inverted`'s in-sample values are **−0.8 / +0.8 / +19.3 / +47.6**
  (`playbook-space-replay-2026-07-28.md:755-758`), i.e. short of the requirement by **21.7 / 25.6 /
  14.5 / 33.8 bps** at every horizon.
- It trips on row accrual, not date: ≥354 qualifying FLAT rows at ~60.8/day, earliest ≈ 2026-08-05
  (`:523-535`).

**Stated precisely, because overclaiming here would repeat the error this program keeps correcting:**
Family B is *structurally* capable of a pass — it is an independent draw and nothing in the design
forbids a higher out-of-sample mean. But out-of-sample means are systematically *worse* than the
in-sample means that selected the arm, and the arm needs to improve by 14–34 bps at every horizon
simultaneously. **In practice it is a one-sided instrument: it has ample power to kill `inverted` and
effectively none to promote it.** A success exit must not hang on it. Its correct role is the STOP
side (§ 7), plus the zero-cost live-vs-replay divergence check its own § requires (`:565-572`).

## 5. Proportionality — what continuing costs, and what it buys

Basis, stated because two differ by 5×: **the $1,000 effective book (`SIZER_EQUITY_CAP=1000`,
`.env.app:189`) is the capital actually at risk and is the basis quoted below.** `equity_usdt` reads
$4,975.38 — the demo venue's wallet balance, not the sizing basis. Percentages against equity are
given in parentheses and are the less meaningful number.

**Epoch**: `PROMOTION_EVIDENCE_EPOCH=2026-07-21T11:21:00Z` (`.env.app:178`). Elapsed to the 11:29:09Z
read: **10.006 days**.

**LLM spend is not where you would first look for it.** `llm_usage` holds *only* reflection rows (69
rows, all opus, none after 2026-07-27); decide-path tokens live in `agent_decisions`, which
`promotion-stats.repository.ts:113-134` folds in with replay rows excluded. Priced at the configured
rates (`.env.app:165-171`) across both sources, SQL total = **$19.7428** against the gauge's $19.7272,
reconciling to 0.08%. Of **30,821** decide/reflection rows since the epoch, only **448 carry tokens**.

| quantity | value | derivation |
| --- | --- | --- |
| LLM spend since epoch | **$19.73** | gauge, reconciled by SQL above |
| LLM $/day, observed average | **$1.97** | $19.73 / 10.006 days |
| LLM $/day, healthy-day range | **$2.19 – $5.08** | per-day SQL fold; the 60-hour unfunded outage 07-28→07-30 drags the average down |
| net-of-cost drift | **−$4.254/day** | −$42.5678 / 10.006 days |
| net-of-cost per trip | **−$1.2162** | −$42.5678 / 35 |
| gross per trip | **−$0.7103** | −$24.86 (`STATUS.md:83`) / 35 |
| trips/day | **3.50** | 35 / 10.006 |

**What 30 more days costs:**

- LLM alone: **$59.15** at the observed average, **$90.00** at the $3/day breaker — **5.9% to 9.0% of
  the $1,000 book** (1.2%–1.8% of equity).
- Total net-of-cost drift at the observed rate: **−$127.63**, i.e. **−12.8% of the book** (−2.6% of
  equity), taking cumulative net-of-cost to about **−$170** — **−17.0% of the book.**

**What 30 more days buys:** ~105 further trips, taking n from 35 to ~140. On the realised per-trip
figure of **−106.0 bps with 95% CI [−185, −8]** at n = 27 (`verdicts.md:346-347`), the interval
half-width scales as `1/sqrt(n)`: **±88.5 bps → ±38.9 bps**, i.e. roughly **[−145, −67]**.

**Verdict on proportionality.** Thirty more days spends ~9% of the book to move a confidence interval
that already excludes zero on the wrong side into a tighter interval that still excludes zero on the
wrong side. **It buys precision on a sign that is not in doubt.** For the mean to reach the live
break-even of +24.2 bps from −106.0 requires a **~130 bps regime change**, and sample size cannot
supply one. The spend is justified only for as long as it is buying a *decision*, not a *measurement* —
which is exactly why § 8 recommends a dated window rather than an open-ended soak. On the numbers
above, the defensible remaining budget is **weeks, not months**: past roughly the 2026-08-31 window
close proposed in § 8, continued spend is buying a fourth significant figure on a known negative.

## 6. GO LIVE — conjunctive, all clauses at one evaluation

**Recommended to the owner. Not enacted.** Every clause must hold simultaneously; any one failing is a
refusal. These sit *on top of* the existing gate, never instead of it — the 16 live-flip code gates,
the bootId arming ceremony and the seven `reasons` clauses all still bind unchanged.

- **G1 — Research bar, restricted to h ∈ {1, 4}, at the LIVE fee floor.** A pre-registered
  out-of-sample arm posts **mean > +24.2 bps AND bootstrap cluster-CI lower bound > +24.2 bps** at
  **both** h = 1 and h = 4, under its family's declared Bonferroni α, and clears the random-bar
  placebo. **+24.2, not +13.0** (`verdicts.md:347-349`): +13.0 is demo break-even, and the destination
  is live fees at 20 bps. Certifying a strategy on demo costs for a live deployment is certifying it
  against the wrong economics. h = 8 and h = 24 are **excluded** per § 3 — at the live floor h = 8 is
  floor-limited and h = 24 needs 171 clusters against a 40-string universe; permitting them writes an
  unreachable clause and calls it rigour.
- **G2 — The existing gate returns `permitted: true` on its own merits.** All seven `reasons`
  (`:126-133`) clear at one evaluation (`:156`), with net-of-cost positive **after** LLM spend, on the
  live epoch — not on a re-declared epoch chosen to flatter the number. Moving
  `PROMOTION_EVIDENCE_EPOCH` to clear this clause is explicitly *not* a way to satisfy it.
- **G3 — Realised confirmation, not replay confirmation.** The G1 arm must be the arm actually running,
  and its **live-realised** entry forward return over **≥ 30 closed round trips after the arm went
  live** must be positive net of live-equivalent fees, and must not diverge adversely from its
  replay-predicted value. Replay cannot see maker-side fill economics — entries were maker-side at 76%
  fill (`watches.md:232`) — so a replay pass alone is not evidence about live.
- **G4 — Passive benchmark, bound and clearing.** `PASSIVE_BENCHMARK` is wired at the composition root
  and `BELOW_PASSIVE_BENCHMARK` (`:133`) does **not** fire: the lane beats a buy-and-hold basket over
  the same window, not merely zero. Today the clause is dark (§ 1), so this requires an enable **before**
  it can be evidence. A lane earning +3% while the basket earns +12% is destroying value, and the gate
  as it stands would certify it.
- **G5 — The instrument exists.** `agentic_promotion_blocked{reason}` (§ 9) is shipped and has been
  reading correctly for the full evidence window. Flipping to live money on a gate whose binding clause
  is inferred by hand is not acceptable; § 9 is the evidence that hand-inference fails silently.

**G1 is the clause to argue about, and § 10 argues about it.**

## 7. STOP — and it must be able to FAIL, or it is not a criterion

A stop criterion that cannot be triggered by any observation is decoration. Each clause below names an
observation that would fire it.

- **S1 — Frontier exhaustion, against a FROZEN ledger.** Stop when every axis on the ledger is either
  tested-and-failed or unfunded. The ledger freezes on the day the owner accepts this record. **An axis
  may only be added to the ledger with BOTH (a) a pre-registered cost and (b) a written prior stating
  what result is expected and why.** *An axis named without a written prior does not reset the clock* —
  this is the entire point of the clause, because "there is always one more idea" is how a program
  fails to stop. Ledger as it stands, from the repo:

  | axis | status | pre-registered cost | written prior |
  | --- | --- | --- | --- |
  | `haiku_swarm` + `haiku_single` control | funded, Family A | **$6.80** (`playbook-space-followon-2026-07-31.md:13`) | registered |
  | Family B out-of-sample `inverted` | registered, trigger ≈ 2026-08-05 | to be set at freeze by the calibrate→size→run discipline | registered |
  | `tool_use_trader` | **deferred, not cancelled** | unset | unset — **does not reset the clock** |
  | four prose arms | deferred | unset | unset — **does not reset the clock** |
  | Wikipedia attention | **TESTED AND FAILED**, 15 of 15 cells (`verdicts.md:287-296`) | spent | closed |
  | Deribit DVOL / VRP | **TESTED AND FAILED**, weak test acknowledged (`verdicts.md:293-295`) | spent | closed |
  | GDELT via DOC 2.0 | **UNTESTABLE FROM THIS HOST** (`verdicts.md:298-310`) | closed | closed |
  | GDELT Web NGrams bulk | named and **deliberately NOT built** (`verdicts.md:311-316`) | new bulk-ingestion component | recorded as a costed frontier, not a backlog item |
  | weekly vol-ranked symbol rotation | DESIGN-GATED (`STATUS.md:138`) | unset | unset — **does not reset the clock** |
  | CryptoPanic sentiment (X4) | owner key-gated capability limit (`STATUS.md:169`) | unset | unset |

  **Fires when:** the funded arms return and no ledger row remains with both a cost and a prior. On
  today's ledger that is a live possibility within weeks, not a hypothetical.

- **S2 — Live divergence, keyed to `WATCH-PLAYBOOK-V10-1`.** The WATCH is deliberately symmetric: *"a
  divergence in EITHER direction between replay-predicted and live-realised entry return is a FINDING
  to report"* (`watches.md:229-231`), closing at ≥12 entries attributable to `playbook_version=10`
  (`watches.md:244`). **Fires when:** at closure, live-realised entry return under v10 comes back
  **above** the research bar — because that would mean the offline harness that produced every negative
  verdict in this program is not measuring the live lane, and the entire evidence base is about
  something other than the thing that trades. That is a stop-and-rebuild trigger, not a go-live
  trigger. **This clause can fail in the direction that embarrasses the record**, which is what makes
  it a criterion rather than a formality.

- **S3 — Budget.** **Fires when:** cumulative net-of-cost since the epoch reaches **−$200** (−20% of
  the $1,000 book), or cumulative LLM spend since the epoch reaches **$150**, whichever is first.
  Projected from the § 5 rates: at −$4.254/day, −$200 arrives **37.0 days** after the 11:29Z read,
  **≈ 2026-09-06**; $150 of LLM spend arrives **66.1 days** out at the observed $1.97/day
  (**≈ 2026-10-05**) or **43.4 days** at the $3/day breaker (**≈ 2026-09-12**). Both are stated because
  the binding one depends on whether the lane keeps trading, and both land close enough to the § 8
  window close to be real constraints rather than distant hypotheticals.

### What "stop" means operationally — and what it does not mean

**STOP means: cease paying for new evidence. It does not mean delete anything.**

- Set the lane to propose nothing (or stop the trading process); the four live gates keep refusing as
  they already do. **No code path is removed and no gate is loosened** — a stopped program must not
  leave a weakened gate behind it.
- **Nothing is deleted.** Every record, study, verdict, WATCH, scorecard, candidate and pre-registration
  stays in the repo. `charter.md`'s standing rule that nothing is ever deleted from a loop file, only
  moved with a pointer (`STATUS.md:190-194`), binds a stop exactly as it binds a pass.
- The DB, the fills, the `agent_decisions` corpus and the frozen manifests are retained — they are the
  asset the program actually produced, and they are what any future attempt would resume from.
- Write one closing verdict in `verdicts.md` recording which clause fired and on what evidence.
- **Stopping is reversible on new evidence of the same weight** required to overturn any verdict. It is
  a decision to stop spending, not a claim that the question is closed forever.

## 8. The operative recommendation — a dated decision window

**Neither GO LIVE nor STOP is available today**, and pretending otherwise would be false precision:
`INSUFFICIENT_WINDOW` cannot clear before 2026-08-06T18:00:26Z, and the funded Family A/B arms have not
returned. So the operative default is:

> **DECISION WINDOW: opens on owner acceptance of this record, closes 2026-08-31.**
>
> - At the close, a **written verdict is required** in `verdicts.md` — GO LIVE (§ 6, all clauses), STOP
>   (§ 7), or a **named extension**.
> - **An extension is valid only if it names a specific MEASUREMENT, its cost, and its completion
>   date.** "More soak", "let it run", "wait for conditions", or an unnamed new idea are **not**
>   measurements.
> - **An extension without a named measurement is itself a STOP trigger.** Not a warning, not a
>   re-review — the stop clause fires. This is the clause that prevents the window from becoming an
>   indefinite drift, and it is written to bind against the person who would most want to extend it.

Why 2026-08-31: it clears the 2026-08-06 window floor, the ≈2026-08-05 Family B trigger and the funded
Family A arms with margin, and it closes before the § 5 arithmetic turns from "buying a decision" into
"buying a fourth significant figure". Roughly 31 days at the observed drift is a further **≈ −$132**,
about **13% of the book** — a real price, knowingly paid, for a dated answer.

## 9. The missing instrument — and why it is not a footnote

**`agentic_promotion_blocked{reason}` does not exist.**
`src/features/common/observability/promotion-metrics.service.ts` declares exactly six gauges —
`agentic_promotion_round_trips` (`:15-18`), `_win_rate` (`:19-22`), `_net_pnl_usd` (`:23-26`),
`_llm_cost_usd` (`:27-30`), `_window_days` (`:31-34`), `_ready` (`:35-38`). `tick()` (`:83-97`) sets all
six from `evidence` and **never exports `evidence.reasons`**, though the service computes it at
`:126-133` and returns it at `:153`. There is no labelled per-reason series and no way to ask
Prometheus which clause is blocking.

**Consequence:** every pass infers the binding clause by hand from the five numeric gauges. That
inference is exactly what failed. `entry-rate-rederivation-2026-07-30.md` § 5 argued for days against
`INSUFFICIENT_ROUND_TRIPS` — a clause that had **already stopped binding** (`:409-410`) — and the error
survived until § 9 checked the code line by line today. **A one-line gauge would have made the wrong
claim impossible to write.** The same blind spot is why the § 1 window/count discrepancy is flagged as
unexplained rather than resolved.

This is offered as an observation, not an enactment: shipping the metric is ordinary loop-domain
tech-debt work under the 2026-07-22 grant, and **G5 makes it a precondition of any live flip** — but
this record does not ship it, and no clause here should be read as authorising a change to the gate's
behaviour. A metric that only *reports* which clause fires changes no verdict.

## 10. The strongest counter-argument, carried UNRESOLVED

**This section is not rebutted, by design.** A reader who disagrees with this record deserves the best
version of their case, and the honest position is that this objection is not fully answered.

> **The objection.** Restricted to h ∈ {1, 4} at the live floor, G1 demands **+32.1 bps** and
> **+37.6 bps** from a program whose best-ever measurements at those horizons are **−0.8** and **+0.8
> bps** — gaps of 33 and 37 bps, against a fee floor that is itself two thirds to three quarters of the
> requirement. No arm in a 20-cell study came close. No family size fixes it (§ 3). No cluster count
> fixes it. **So these criteria are not a live path; they are a STOP written in the vocabulary of a
> success criterion, and calling the document a "success exit" is a category error.** If the honest
> answer is stop, the record should say stop plainly rather than dress it as an achievable bar —
> because a criterion nobody can meet does not inform a decision, it merely makes the decision look
> like it was earned.
>
> **And the counter to the counter is worse.** Anyone who genuinely wants a live path must therefore
> argue for a criterion **below** the research bar. But below the research bar means going live on a
> signal this program has measured as **worse than a random-bar placebo** (p = 0.0013–0.0037,
> `verdicts.md:325-326`) — worse than choosing entry bars by coin flip. The two-bars verdict permits a
> research-bar FAIL to be *deployed* (`verdicts.md:17-29`), and `inverted` was shipped on exactly that
> reasoning — but that ruling governs *"which of several losing options should run"* (`:29`), and it
> says in terms that the research bar *"governs every claim of edge and every step toward live money"*
> (`:25-26`). **Live money is not a deployment-bar decision.** So the two available positions are: a
> bar that nothing has ever approached, or live capital on a measured anti-signal.

**What this record does not claim.** It does not claim the objection is wrong. It is not obvious that a
criterion nobody can meet is more useful than an explicit stop, and a reader who concludes this
document *is* a stop with extra steps has read it correctly on the numbers. The reason it is
nonetheless written as criteria rather than a recommendation to stop is narrow and worth stating
exactly: **the promotion gate is owner-kept (`charter.md:170-174`), so a recommendation to stop is not
the loop's to make either.** Both exits belong to the owner. This record's job is to put the arithmetic
in front of that decision, not to pre-empt it in either direction.

**The residual disagreement is real and is left open.** Whether the correct reading of § 3 is
"demanding but principled" or "unreachable, therefore stop" is a judgement about how much a program
should pay for a decision it can already anticipate — and that judgement is the owner's.

## 11. What is being asked of the owner

This record asks for a decision and assumes none. Four questions:

1. **Do you accept the GO LIVE clauses in § 6** — in particular G1's restriction to h ∈ {1, 4} and its
   use of the **live** +24.2 bps floor rather than the demo +13.0? If not, name the clause to change.
2. **Do you accept the STOP clauses in § 7**, including S1's rule that an axis without a written prior
   does not reset the clock, and S3's budget triggers at −$200 net-of-cost / $150 LLM spend?
3. **Do you accept the dated decision window in § 8** — close 2026-08-31, written verdict required, an
   extension without a named measurement is itself a stop trigger?
4. **Having read § 10, do you want criteria at all, or do you want to stop now?** The objection in
   § 10 is not rebutted, and the arithmetic in § 3 and § 5 is the same either way. A decision to stop
   today is fully supported by this record's own numbers and would cost nothing that has already been
   learned.

Until the owner answers, nothing changes: the gate keeps returning `permitted: false`, the four live
gates keep binding, and this record has enacted nothing.
