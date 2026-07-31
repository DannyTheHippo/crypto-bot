# Learning capacity: can any configuration here learn an edge?

Owner-directed session, 2026-07-31. The question asked was whether a vastly more intelligent but
cheaper decide model could push the book toward profitability — specifically GPT-5.6 after its price
cut, or kimi-k3 despite an earlier disqualification. The owner then reframed it to the better
question: **the least-bad config / model / architecture that can potentially LEARN an edge.**

Measuring against that reframe produced a finding that supersedes the model question, and a second one
that reconciles two ledgers this program has carried in contradiction for a week.

## 1. Headline — the declared horizon grid was measuring the wrong thing

Forward return is scored at h ∈ {1, 4, 8, 24} bars (15m). That grid was inherited and **was never
matched to how long this book holds a position.** Measured over the last 10 days, n=40 closes:

- **median hold 234.4 min ≈ 15.6 bars**
- **mean hold 817.3 min ≈ 54.5 bars**

So h=24 was the only declared horizon anywhere near the median, and the mean hold runs past the grid
entirely. Re-scored at hold-matched horizons (`pnpm loop:horizon-rescore`, $0, no new model calls):

| version | h=1 | h=4 | h=8 | h=24 | **h=16 (median)** | **h=54 (mean)** |
| --- | --- | --- | --- | --- | --- | --- |
| v1 | −16.9 [−28.5, −4.9] | −34.6 | −47.4 | −58.5 | **−57.6 [−85.1, −20.2]** | **−111.3 [−184.7, −41.6]** |
| v2 | −15.9 [−25.1, −5.5] | −29.0 | −70.8 | −155.6 | **−94.5 [−153.7, −30.0]** | **−174.8 [−325.0, −125.6]** |

v3/v6/v7/v8/v9/v10 are UNDERPOWERED at every horizon including the new ones. v6/v7 additionally read
h=54 UNDETERMINED on a 40% gap share, correctly honouring the >20% missing-bars rule rather than
reporting a false zero.

**Control:** the tool reproduces `pnpm loop:forward-return` exactly at h=1 (v1 −16.9 [−28.5, −4.9]
n=28 k=13; v2 −15.9 [−25.1, −5.5] n=18 k=11). A re-score that could not reproduce the old numbers
would be broken rather than informative; this one reproduces.

**Ordering flips: NONE.** v1 outperforms v2 at every horizon, old grid and new. Nothing already ranked
gets re-ranked — the correction changes magnitudes, not the order.

### 1.1 Why this matters more than "it is worse than we thought"

Two independent ledgers describing the same book have disagreed by several-fold and nobody reconciled
them. Realized gross per round trip, from fills:

- **−101.9 to −106.0 bps** as recorded in `verdicts.md` (earlier, n≈27, $1,982.66 notional)
- **−69.1 bps** measured this session: −$23.17 gross over **$3,353.99** round-trip notional, 38 trips

Against forward return at **h=1: −16.9 bps**.

**The hold-matched horizons BRACKET every realized measurement** — v1 reads −57.6 at h=16 and −111.3 at
h=54, spanning both −69.1 and −102/−106. The h=1 reading is **4–6× off every realized figure** and
brackets none of them. That is mutual validation of the two instruments at the hold-matched horizons
and it retires h=1 as an artifact of scoring a horizon this book never trades. It also resolves an
instance of the § C.7 three-ledger-divergence class that had been sitting in plain sight.

**Stated limit on this reconciliation, because it is not like-for-like:** the forward-return cells are
v1/v2 (2026-07-22 → 07-24) while the realized figures span the whole epoch across all eight arms, and
forward return measures signed ENTRY drift whereas realized PnL includes exit timing and fees. The
claim is therefore about ORDER OF MAGNITUDE agreement, not a point estimate — which is exactly the
level at which h=1 fails and the hold-matched horizons succeed.

**Consequence for the fee floor.** The research bar is +13.0 bps (demo) / +24.2 (live). Read at h=1
the gap looked like ~30 bps. Read at the horizon the book actually trades it is **~70–125 bps.** Every
arm ever scored on the declared grid was scored on its most flattering horizon.

## 2. No configuration here can currently be SHOWN to learn

Eight playbook versions have run live. Against the program's own power bar (`MIN_ENTRIES = 12` **and**
`MIN_CLUSTERS = 5`, both required):

| version | entries | clusters | live | readable? |
| --- | --- | --- | --- | --- |
| v1 | 28 | 13 | 07-22 → 07-23 | **POWERED** |
| v2 | 18 | 11 | 07-23 → 07-24 | **POWERED** |
| v3 | 1 | 1 | 07-24 | no |
| v6 | 5 | 3 | 07-24 → 07-25 | no |
| v7 | 5 | 5 | 07-24 → 07-25 | no |
| v8 | 8 | 6 | 07-27 → 07-30 | no |
| v9 | 6 | 5 | 07-27 → 07-30 | no |
| v10 (live) | 7 | 5 | 07-30 → 07-31 | no |

78 entries over 8 versions is 9.75/version against a bar of 12. **The only two versions ever powered
enough to read are the two oldest.**

**The mechanism is DIVISION, not suppression — checked, because the obvious confound would have
inverted the story.** Trading did not slow. Entries per day, with versions live that day: 07-22 → 8
(v1); 07-23 → 23 (v1,v2); **07-24 → 24 (v2,v3,v6,v7)**; 07-25 → 2; 07-27 → 7 (v8,v9); 07-30 → 9
(v8,v9,v10); 07-31 → 5 (v10). **2026-07-24 was simultaneously the highest-volume day in the program's
history and its heaviest minting day** — four versions sharing 24 entries is ~6 per arm, half the bar,
on the best day there has ever been. The two POWERED versions are simply the two that had the book
largely to themselves. Three further days (07-26, 07-28, 07-29) produced zero decides — outage and
host sleep — which compounds the shortfall without causing it.

This is why `verdicts.md`'s scope limit reads _"0 passes ⇒ the learning hypothesis is UNSUPPORTED on
the funded arms, **NOT proven dead**"_. Live, it has never been tested. It has been overwritten.

## 3. The model question, answered on the reframed terms

No model supplies edge. Best cell ever recorded anywhere is **−7.12 bps** against a **+13.0 bps** bar;
`verdicts.md` § THE DECIDE MODEL IS NOT THE LEVER is 20/20 cells, two vendors, 0 passes. So in a
learning architecture the model's job is not to supply edge — it is to be a **cheap, reliable
substrate for running many experiments.** On that criterion price matters, just not as the original
framing had it: **cheaper buys SEARCH RATE, not PnL.**

- claude-sonnet-5 (incumbent): $3/$15 per Mtok; measured $0.0137–$0.0191/call
- claude-haiku-4-5: ~$0.0037/call — ~4–5× more arms per dollar
- GPT-5.6 Luna: $0.20/$1.20 per Mtok after the 2026-07-30 cut — ~15× on rate; **never evaluated here**
- GPT-5.6 Sol (flagship, uncut, $5/$30): _more expensive_ than the incumbent
- kimi-k3: **excluded.** Its disqualification was on quality (three benchmarks plus a real-PnL bake-off
  it lost −$93.59 vs −$30.28), and Moonshot's ~31.5% empty-200 rate makes it **$0.0263/call effective
  vs sonnet's $0.0137 — 1.9× MORE expensive.** The price cut addresses none of that.

**The cost thesis is dead on its own terms and this is arithmetic, not opinion.** Measured
2026-07-31T17:20Z: net-of-cost −$43.93, LLM cost $20.76 ⇒ **gross trading with inference FREE is
−$23.17 over 38 round trips (−$0.61/trip).** `verdicts.md`: _"Do not propose cost work as a
profitability lever."_ And _"the timing knobs, not the model, set the bill"_ — only 5.4% of wakes
consult, and 164 of 205 consults in 24h are forced rather than scheduled.

**The haiku question is NOT settled and cannot be settled offline for free.** The published replay
cells persist only per-(arm, horizon) aggregates — no per-row action or direction is written anywhere
(`playbook-space-replay.spec.ts` builds a per-row `entries` array at replay time but only ever writes
the aggregate `table`). Re-scoring haiku vs sonnet at h=16 therefore requires a **fresh paid replay
run**. Verified, not assumed. Until then the observation that a single haiku call beat sonnet at
h=1/4/8 and lost at h=24 remains exactly what `verdicts.md` says it is — a lead explicitly not acted
on, and now additionally suspect because its wins sit at horizons the book never trades.

## 4. The search space is smaller than it looked

Of the arms never edge-tested, **two can never be tested at all** under the current power bar:
`leaders_only` (BTC/ETH/SOL) and `one_symbol_btc` (BTC) are hard-capped at 3 and 1 symbol-clusters by
their own playbook text, against a floor of 5. That is structural and corpus-size-independent. Only
`meanrev_pure` among the three zero-entry arms is genuinely open.

## 5. The corpus was expanded and is currently INERT

`corpus-v4-flat.jsonl`: 587 rows (from 386, +52%), 26 symbols, 2026-07-21T15:00Z → 07-31T20:30Z.
Fingerprints differ correctly from v3 and the fail-closed gates still throw on mismatch.

**But the OHLCV candle cache stops at ~2026-07-27**, so the 201 new rows (34% of the corpus) fall past
coverage and `fwdBps` returns null for every one at every horizon. **Row count grew 52%; scoreable
calendar span grew 0%.** This is the known truncation from `279713e` (an unconditional write plus a
tf-less funding filename). Refreshing the cache is a $0 re-fetch and is the unlock for everything
downstream — including any paid re-run at h=16.

## 6. What shipped, and what it does NOT do

A flag-off decide-model A/B config gate: `AGENTIC_MODEL_B` + `AGENTIC_MODEL_AB_PCT` (default 0), with
a construction-time boot refusal when `pct > 0` and the second model has no `AGENTIC_TOKEN_PRICES_JSON`
entry. Fails CLOSED. Byte-identical at `pct = 0`; 931 tests green.

**It is NOT a working paired A/B, and must not be read as one.** Three findings, all recorded against
the change's own interest:

1. **`abArm` had ZERO production call sites before today.** The claim that it was "wired to playbook
   routing" is false — `PlaybookAbRoutingProvider` uses its own inline
   `Math.floor(Date.now()/BUCKET_MS) % 100` and never calls `abArm`. Verified by grep over `src/`.
2. **The arm is drawn once per BOOT, not per minute.** `AnthropicAgentClient` pins one model per
   instance and `AGENT_CLIENT` is a Nest singleton. A per-boot coin flip is still sequential and still
   regime-confounded — **the benefit claimed for this change (turning a 4–8 month sequential
   comparison into a paired weeks-long one) is NOT delivered** and will not be until the client accepts
   a per-call model.
3. **Attribution would silently corrupt the promotion gate.** `agentic.strategy.ts:3046`/`:3100`
   journal `model: this.model`, set once at construction, never reading `proposal.model`; and
   `MetricsWrappingAgentClient` labels every token/decide metric with the static config model. Every
   arm-B decide would be recorded as arm A, poisoning the exact cost and PnL inputs
   `NON_POSITIVE_NET_PNL` reads.

**`AGENTIC_MODEL_AB_PCT` must stay 0 until (2) and (3) are closed.**

## 7. The decision this now turns on — owner call

**Daily playbook minting and powered evidence are mutually exclusive.** Holding an arm to `n ≥ 12 AND
k ≥ 5` takes 2–4 days at 4.2–7.7 entries/day; daily minting guarantees no arm is ever readable. Daily
minting is a dated owner decision (`candidate-routing-override-2026-07-31.md`) and change-discipline
forbids a pass reopening it silently.

Recommendation: **suspend daily minting for the live lane and move iteration offline**, where an arm
scores in hours for ~$5 instead of 2–4 days. The live lane's job becomes confirming survivors and
generating corpus. If daily minting is kept instead, then record explicitly that the live lane is a
**corpus generator, not an evidence source**, so no future pass quotes an underpowered live arm as a
result.

## 8. Next, in order

1. Refresh the OHLCV cache through 2026-07-31 ($0). Nothing downstream is scoreable without it.
2. Close the attribution gap (§ 6.3) and the per-call-model constraint (§ 6.2) before any A/B enable.
3. Only then: a paid re-run scoring haiku vs sonnet at the hold-matched horizon, pre-registered.
4. Re-read every prior study's conclusions against § 1 — they were all scored on the flattering grid.
