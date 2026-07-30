<!-- Created 2026-07-30 (Pass 48). research/loop/state.md § Standing verdicts, moved VERBATIM.
     One bullet — the 2026-07-22 gate-override audit — went to charter.md instead; see below. -->

# Verdicts — the binding evidence base

**Read this before proposing work in any area it covers.** These are settled findings with their
evidence attached: a pass does NOT re-derive them, and does not act against one without new evidence
of the same weight. Areas covered: the entry signal, exit rules, cost levers, the decide-model
choice, price TA, non-price channels, the promotion benchmark, and the live playbook lineage.

Moved verbatim from `state.md` at the 2026-07-30 compaction. The 2026-07-22 **gate-override audit +
classification** bullet, which stood last in this section, is now `charter.md` § Gate-override audit
— it is an owner decision rather than evidence, and a pass looks for it under policy.

## Standing verdicts (binding evidence — passes must NOT re-derive these)

- **THE DECIDE MODEL IS NOT THE LEVER — playbook-space replay, NO_SURVIVOR (2026-07-30;
  `research/studies/playbook-space-replay-2026-07-28.md`, Amendments 4-5).** 20 of 20 pre-registered
  cells scored across two models, 4 playbook arms, 4 horizons, 354 recorded FLAT rows, α = 2.5e-3.
  **0 passes.** Joint verdict computed by `aggregateVerdict`, artifact at
  `research/candidates/playbook-space-joint-verdict-2026-07-28.json`. Cost $39.3 of the $115 funded.
  - **`champion_v8` on identical rows: sonnet −12.7 / −36.3 / −32.7 / −70.1 bps at h=1/4/8/24 (n=70);
    kimi-k3 −10.7 / −29.6 / −44.1 / −66.1 (n=100).** Two vendors, schema compliance 92.9% vs 48.7%,
    entry rate 21.8% vs 62.0% — **entry quality indistinguishable, every cell failing on the mean.**
    Do not re-run a model swap expecting a different sign.
  - **Net-terms corollary:** at equal gross expectancy the higher-frequency lane is strictly worse.
    kimi took ~3x the round trips for the same edge, so ~3x the fee drag. "Which lane is best" resolves
    to **sonnet, and only because it trades less** — the very lever the live objective suppresses.
  - **Prose is not the lever either.** `minimal` (no guidance) −13.3 bps at h=1, within a bar of the
    champion; `momentum_pure` −12.7 → −85.3. All arms changed 9-55% of decisions vs the champion, so the
    prose moved behaviour without moving the sign. Zero inert arms.
  - **The −16.9 bps ENTRIES verdict REPRODUCES under the repaired harness** (−12.7 sonnet, −10.7 kimi),
    so the capabilities defect below did not manufacture it.
  - **SCOPE LIMIT, binding on any write-up:** four arms on sonnet and one on kimi is not the twelve-arm
    span the original decision rule assumed. **0 passes ⇒ the learning hypothesis is UNSUPPORTED on the
    funded arms, NOT proven dead.** Seven arms were never edge-tested; `meanrev_pure`, `leaders_only`
    and `one_symbol_btc` yield zero entries on this corpus and are untestable here at any budget.
  - **One live thread, and it is a FAIL:** `inverted` at h=8/24 posts means of **+19.3 / +47.6 bps**
    above the +13.0 bar with an h=24 placebo p of **0.0020 (below α)** — its entry timing carries
    information beyond side-and-symbol drift. It fails on interval width (CI lo +1.1, −12.2) at n=117 /
    20 clusters. In-sample, one 6.35-day regime, and largely a sign-flip of a known negative. **Never
    quote +47.6 as an edge**; it is at most an out-of-sample hypothesis.

- **DEFECT, FIXED — the replay described a different account than live did (2026-07-30).**
  `replayPlanRow` built capabilities from CONSTANTS while each recorded row carried the real ones: it
  advertised (and zod-bounded) a `sizeFraction` ceiling of 0.25 against a recorded 0.35 perp / 0.15 spot,
  offered shorts on the 139 SPOT rows recorded `shorts:false`, and stated leverage 2 on rows recorded at
  1 or 5. **Measured effect: entry rate 2.5% vs a live-recorded 16.1% on the same corpus; the fix moved
  it to 19.1%.** The mechanism was the bound contradiction — a model that believed its payload and
  proposed 0.30 was scored as a schema failure. **This reached production:** the same builder serves the
  mint-time entry-rate floor (`measureEntryRate`) and the candidate expectancy backtest, so both judged
  candidates against limits the live rows never had. Fixed via `recordedCapabilities` (per-row, bound
  taken from the capabilities so it cannot contradict the advertised limit), `capsSource` reported per
  call, callers fail closed. 12 regression tests. See WATCH-V4-9.
  - **A first diagnosis blamed `venueFreeCash: '0'` and was WRONG** — `buildTradeTool` never renders free
    cash. A test asserts its absence so the claim cannot be re-derived.

- **Moonshot's Anthropic-compatible surface returns HTTP 200 with an EMPTY BODY on ~30-45% of requests
  (2026-07-30).** Measured 172 of 546 attempts (31.5%) on the kimi edge leg, 13-22 of ~55 in each
  calibration. Non-deterministic — the same row returned empty once and 2,365 bytes the next call — so it
  is provider-side, not payload-dependent, and retryable. It presents as success: `ok: 40/40`, zero 429s,
  zero 5xx. Two kimi calibrations were correctly VOIDED at 55% and 72.5% transport before the cause was
  found. **Lowering concurrency makes it worse** (concurrency 2 / 300s timeout scored 55% against
  concurrency 4's 72.5%). Fixed by counting `emptyBody` separately and retrying after a short fixed
  delay; transport went to 99.2-100%. **Consequence for any kimi budget: the USD meter cannot price these
  attempts, so kimi's effective cost is ~1.55x its metered cost — $0.0263/call effective vs sonnet's
  $0.0137, i.e. kimi is ~1.9x MORE expensive, not the 0.61x a token-rate comparison suggests.**

- **BUILT DARK — the promotion gate's passive benchmark (Pass 41, 2026-07-27; specified `4d930e0`,
  built `6cb9c6d`).** Supersedes this entry's former "SPECIFIED, NOT BUILT" text, which was stale the
  moment the code landed. **What exists now:** `PassiveBenchmarkPort` + `PASSIVE_BENCHMARK` token
  (`src/ports/trading/promotion.ts:227`), an `@Optional()` trailing constructor arg on
  `PromotionReadinessService`, `passivePnlQuote` in the evidence payload, and reason
  `BELOW_PASSIVE_BENCHMARK` at `promotion-readiness.service.ts:133`. **What does NOT exist: any
  provider binding the token.** No composition-root binding ⇒ `benchmark` is `undefined` ⇒
  `passivePnlQuote` is `null` ⇒ the clause never fires and the verdict is byte-identical to the
  pre-2026-07-27 gate. That is the intended two-step enable, not an oversight; step two is binding a
  provider, and it is deliberately NOT taken while the program has no strategy worth arming.
  - **Correction to a claim made during Pass-42 planning:** "the bar is now beat-the-basket instead of
    net > 0" is FALSE. `:130` `NON_POSITIVE_NET_PNL` and `:133` `BELOW_PASSIVE_BENCHMARK` are
    independent `reasons.push` clauses — both block, and once the port is bound a strategy must clear
    BOTH zero and the basket. The change is strictly stricter, which is the safe direction for a
    live-arming input.
  - **Known weakness of the bar itself, recorded before it is ever enabled:** the required improvement
    spans ~0 to ~190 bps/trip purely as a function of what the basket does over the window. A criterion
    whose outcome is dominated by an exogenous variable is a beta bet. Whoever enables step two should
    exposure-match the benchmark to the strategy's realised gross exposure (~50% here), or prefer an
    A/B arm difference (regime-controlled by construction) as the kill criterion with beat-the-basket
    kept as a separate deployment gate.
- **NOT A FINDING — the inversion test is a tautological restatement (Pass 42, 2026-07-28; harness
  `test/backtest/inversion-test.mjs`).** It reproduces the ENTRIES verdict exactly (−16.9 bps at h=1)
  and reports the sign-flipped mirror: **+16.9 / +31.9 / +47.3 / +66.5 bps at h=1/4/8/24.** Those
  numbers are **arithmetic, not evidence.** Negating every observation negates the mean and mirrors
  the CI, the t-statistic, both chronological halves and the placebo p by construction — a run that
  did NOT reproduce them would mean the harness was broken. **Do NOT cite +66.5 bps, or any inverted
  figure, as an edge.** The only genuinely new content is magnitude versus the fee, and there:
  - **h=1 FAILS the fee**: +16.9 gross against a 20 bps round trip is **−3.1 net**, and the bootstrap
    lower bound (+10.9) sits under even the optimistic +13.0 bps demo-fee requirement.
  - h=8/24 would clear on point estimate, but rest on n=61 entries, a single ~4-day regime, and a
    **mixture over ~9 playbook versions** — the same three weaknesses that make the original finding
    an indictment of the churning mixture rather than of any one evaluated playbook.
  - **Adverse selection may not invert.** Entries were maker-side at 76% fill; being reliably on the
    wrong side of a print does not imply the other side of that print was available to take.
  Status: a **hypothesis for offline replay**, admitted as one arm of the Pass-42 playbook-space
  study, and nothing more. Fading a model is a classic overfitting trap and this is exactly its shape.
- **HORIZON WAS NOT THE CONSTRAINT EITHER, AND ACTIVE LOST TO PASSIVE ACROSS 7 YEARS (Pass 41,
  2026-07-27; preregistered `research/studies/horizon-and-baseline-2026-07-27.md`, harness
  `test/backtest/horizon-study.mjs`).** Tests the named frontier the settled price-TA verdict left
  open (multi-day cross-sectional momentum — the killed search covered 15m–1d only; no cell here is
  inside 1d). 4 signals × 3 horizons (7/30/90d) × 2 fee tiers over 2,600 daily bars, 16 assets,
  2019-08-04 → 2026-07-27. **24 of 24 cells FAIL.** Every cell has NEGATIVE excess over the passive
  basket; `xs_rev7`@h7 is significantly worse at **p=0.0000 over 364 periods**. Maker fees (4 bps)
  move results ~+0.16%/period and change no verdict — **the fee tier was never the binding
  constraint at these horizons.**
  - **The under-powered result reversed under power, which is the methodological headline.** At 400
    bars, three momentum signals showed +6.3 to +7.2% excess per 30-day period, both halves
    positive, compounding to +25–38% vs +14.5% buy-and-hold. At 2,600 bars the same cells read
    −5.36%, −6.37%, −5.46%, both halves negative. n went 11 → 84. Acting on the first run would have
    shipped a value-destroyer with a plausible story. **Never act on a sub-n≥12 cell.**
  - **Why every active strategy lost: the return was BETA and long-short discards it.** The basket
    earned +6.64% per 30-day period; a market-neutral construction strips that out and keeps only
    cross-sectional dispersion, which was negative after costs at every horizon. The strategies did
    not fail to find the return — they were built to throw it away.
  - **The gate asks the wrong question.** `PromotionReadinessService` requires net-of-cost > 0. A
    strategy earning +3%/yr while the basket earns +12% passes it and destroys value. Nothing in
    this program had ever been benchmarked against doing nothing, which is why it took until now to
    notice the bot lost ~4% of its book over a window where the same 16 assets returned **+0.39%**
    equal-weight. **Any future strategy must clear the passive basket net of all costs, not zero.**
  - **Survivorship caveat, load-bearing:** the 16 assets survived to 2026 and were scanner-liquid,
    so the +697% buy-and-hold figure is inflated and is NOT an achievable ex-ante return — nobody in
    2019 could have known to hold these names. The bias inflates basket and strategies alike, so the
    _excess_ is the robust quantity, and it is negative everywhere. The robust claim is RELATIVE
    (active lost to passive), never the absolute passive number.
- **NON-PRICE CHANNELS — Wikipedia attention and Deribit DVOL/VRP TESTED AND FAILED; GDELT UNTESTED
  (Pass 41, 2026-07-27; preregistered `research/studies/nonprice-channels-2026-07-27.md`, harness
  `test/backtest/nonprice-study.mjs`).** This tests the program's own long-standing claim that "the
  only possible edge is information the price series does not contain" — which had never been
  checked. **15 of 15 runnable cells FAIL.** Every 95% CI spans zero; the best p across all cells is
  0.072, short of even an uncorrected 0.05 against a pre-registered Bonferroni bar of 1.85e-3. No
  cell reached the holdout. Wikipedia (n≈2,350, 10 assets over ~9 months, ≥100 views/day floor) is a
  genuinely powered null; DVOL (n≈440–480, BTC/ETH only) is a weak test, so a modest DVOL effect
  could still hide inside its intervals. **Do NOT quote the point estimates**: `views_z`@h7 reads
  +345 bps and `vrp`@h7 +268.6 bps, with CIs [−20, 689] and [−211, 620] — at this n a 7-day horizon
  cannot resolve them from zero, and quoting either as a finding is exactly the error that killed the
  funding-contrarian frontier. **GDELT is UNTESTED, and is now established as UNTESTABLE VIA DOC 2.0
  FROM THIS HOST** (12 cells; closed 2026-07-28, Pass 42). The 7-day-chunk backfill ran to completion
  as a background job — **366 requests, 0 successes, 122 failed chunks on every one of the three
  queries.** A follow-up single-request probe after minutes of idling still returns:
  - `HTTP 429 — "Please limit requests to one every 5 seconds… All high-traffic users should switch
    to our ngrams dataset"`, on `https` and `http`, on `timelinetone` and `timelinevol`, at
    `timespan=1d` (the smallest possible ask). DNS resolves fine (104.197.47.124), so this is a
    throttle, not an outage.
  - **The 6 s spacing was not enough and the throttle is STICKY**: it latches after a burst and does
    not release for at least tens of minutes. The pre-registration predicted the stickiness; what is
    now settled is that no pacing this harness can apply makes a full-window backfill possible.
  - **Do NOT re-run `fetch-nonprice.mjs gdelt`.** It cannot succeed from this host, and each attempt
    re-latches the throttle.
  - **The one real alternative, named and NOT built:** GDELT's own 429 body points high-volume users
    at the **Web NGrams dataset** (bulk files, not a per-query API). That is a genuine path to the
    same signal class, and it is deliberately not built — it is a new bulk-ingestion component, and
    the non-price hypothesis has already failed 15 of 15 runnable cells on two independent channels
    inside a program whose central finding is that this architecture's entries are anti-predictive.
    Recorded as a costed frontier, not a backlog item.
  - The Bonferroni denominator was fixed at 27 up front, so the correction stands unchanged and no
    late-arriving channel can move the bar. **The non-price study is CLOSED at 15/15 FAIL + 12
    permanently untested.**
- **THE ENTRY SIGNAL IS SIGNIFICANTLY NEGATIVE, AND WORSE THAN RANDOM (Pass 41, 2026-07-27;
  31-agent adversarial diagnosis, 2,300+ cuts, 24 actionable claims attacked, 6 survived).** This is
  the program's central finding and it supersedes any assumption that the lane merely lacks edge.
  - **Forward returns are negative at every horizon** (n=61 entries): +1 bar **−16.9 bps t=−4.58**
    CI [−25.2, −8.6], hit 25% against a ~50% base; +4 −31.9 t=−2.78; +8 **−47.3 t=−3.95**; +24
    −66.5 t=−3.14 (n=57). All 12 primary cells negative (P = 2.4e-4 under coin flips). Survives
    **Bonferroni over 195 cuts** (α=2.56e-4) at four cells. Trimming the best and worst observations
    makes it MORE negative (−17.3 t=−4.95; 3+3 → −18.0 t=−5.80). Both time-halves negative at all
    horizons. Long leg n=43 carries it (−19.9/−29.2/−56.3/−93.5); the short leg n=18 is not
    significant on its own. Market-neutral residuals are ~half the size and still significant at
    h=1/8/24 (−9.8 t=−2.84 / −28.0 t=−2.66 / −35.8 t=−2.09) but NOT at h=4 — so the causal
    "picks bad bars" reading holds net-of-beta at three of four horizons, not all four.
  - **Worse than random: a random-bar placebo on the same symbols and long/short mix gives
    p = 0.0013–0.0037.** Entry TIMING is measurably worse than choosing a bar by coin flip.
  - **A random entry at the model's own declared 2%/4%/48-bar geometry earns gross −1.07 bps — a
    martingale — and net −21.07 bps, i.e. exactly the fee** (34 symbol×side cells, 32,368 overlapping
    windows, intrabar resolution, cluster-robust t = −12.83). A six-bracket geometry sweep
    (1/2, 1.5/3, 2/4, 3/6, 2/2, 4/2) lands every bracket in [−24.32, −18.93] bps. **Under any
    bracket a random entry earns ≈0 gross, so net ≈ −fees always. Only entry alpha exceeding fees
    can produce profit.** CORRECTION to the exit study's arithmetic: the correct break-even is the
    CONDITIONAL (stop-or-TP) hit rate **36.67%**, not 34% — max-hold exits dominate the population.
    Observed conditional hit rate 18.85%, cluster CI [13.42, 22.92], P(≥34%) = 0.
  - **No conditional subgroup rescues it: 1,807 cuts examined, 0 of 188 counterfactual cuts positive
    at n≥8.** Smallest p among ALL positive-mean cuts is 0.302; BH at q=0.05 yields zero discoveries;
    family-wise permutation over 120 realised cuts gives p = 0.378. **There is no attribute-based
    entry filter to deploy** — the search is exhausted over everything the system records.
  - **The one attractive-looking cut is an artifact.** `stopLossPct > 2.5%` realised +203.8 bps is
    **4 of 4 KAITO**, and KAITO is rank 1 of 17 on unconditional 48-bar drift in this window
    (+2238 bps total). All four winners won by DISCRETIONARY early close, not geometry: replayed
    mechanically the same cut goes **+203.8 → −158.1**. Counterfactual stop-width buckets show the
    widest is worst (−197.5). **Do not widen stops. Do not concentrate on KAITO** (its own realised
    aggregate is n=8, −2.2 bps).
  - **Cost cutting cannot close the gap.** Gross realised −$20.10 on $1,982.66 of notional =
    **−101.9 bps/trip** (95% CI [−185, −8], P(gross > 0) = 0.018); marking the 4 open cycles — all
    four losing — gives n=27 at **−106.0 bps/trip**. Required gross edge for net-of-cost break-even
    under the BEST achievable cost structure is **+13.0 bps/trip** (demo fees) or **+24.2** (live
    20 bps). The gap is **115–130 bps/trip**, and LLM spend is $15.48 of the $37.56 net loss — **free
    inference still leaves −$22.08.** Do not propose cost work as a profitability lever.
- **NO EXIT RULE RESCUES THESE ENTRIES — verdict ENTRIES (Pass 41, 2026-07-27; pre-registered
  study `research/studies/edge-verdict-2026-08-10.md`, harness `test/backtest/exit-attribution.spec.ts`
  over `test/backtest/exit-simulator.ts`).** Three arms over the 23 recorded round trips, intrabar
  stop/TP resolution, zero LLM calls: Arm 1 actual (discretionary closes) −108.1 bps at 17.4% hit;
  Arm 2 the model's own declared plan run mechanically −78.4 bps at 22.7%; Arm 3 best of 14 geometry
  cells (stop ×1.5, TP ×0.5) −45.0 bps at 40.0%. **All 16 cells negative.** Break-even is ~34% at the
  model's own declared R:R 2.02 after 20 bps fees. Wider stops buy hit rate monotonically
  (17.4% → 40%) without turning expectancy positive and a shorter take-profit wins at every stop
  multiple — the signature of entries with no directional edge. **Do NOT re-run exit-rule sweeps.**
  Two corollaries: letting the declared plan run beats the model's own hand by 29.7 bps (real, but
  under the pre-registered 30 bps bar and nowhere near profitability), and the live exit mix is 16 of
  22 closes by the model's own `close` action against 3 venue stops and 2 venue TPs, with
  `PROTECT_STOP_LOSS_PCT=0.06` never having fired — `pnl-v1`'s "stopped out 2-3× more often than they
  take profit" was a single-symbol BTC-perp 4h BACKTEST and does not describe this book.
- **Consult cadence is ON TARGET; batching fragmentation is not a profitability lever (Pass 41,
  2026-07-27).** The true unit of work is 627 symbol-decisions over 6 days = 104/day ≈ 13
  menu-waves/day against the 16/day design point at `.env.app:100`; the model picks
  `nextConsultBars` 8/12/16, not 1. Any "N consults/day vs 16" comparison must count menu waves, not
  API calls — the two differ ~5× because batching fragments (133 of 272 calls carry one symbol, only
  6 the full menu, since each of the 40 strategy instances holds its own `barsSinceConsult` while
  `agent-prompt.ts:458` tells the model the value is portfolio-level). Fixing that fragmentation is
  worth ~11% of tokens ≈ **$0.20/day** — input per symbol only improves 3,060 → 2,571 from batch-1 to
  batch-8 because the shared prefix is small and already cached. Worth doing for HTTP volume and
  shared-org 429 pressure; not for money. **The remaining cost lever is payload SIZE**
  (~2,600–3,000 input tokens per symbol-decision; decide $10.53 / reflection $5.01 ≈ $2.6/day;
  $0.0167 per symbol-decision), which is what the C4 per-block ablation measures.

- **Price-TA edge search is settled EMPTY** (2026-07-12 ultracode session: 4,562 backtests, 8
  families, long+short, 15m–1d, fees 0→20bps — ZERO honest survivors at any fee level incl.
  0bps; `reports/loop/multi-strategy-search-2026-07-12.md`). The LLM lane cannot profit by
  reading price better; its only possible edge is information the price series does not contain.
  **Do NOT re-run price-TA edge searches.** (Frontier if ever wanted, forward-test-only:
  long-short daily cross-sectional momentum on perps.)
- **Funding-carry NO-GO** (0/126 cells, `reports/loop/carry-study-2026-07-10.md`; re-test harness
  `test/backtest/carry/`, ~14-day cadence — next due ~2026-07-24 under the winsorized benchmark,
  write a NEW dated report). **Funding-contrarian frontier KILLED on second holdout**
  (`reports/loop/nonprice-sweep-2026-07-12.md`; 134/150 frontier cells died, top cells flipped
  negative — regime beta, not signal; do not redo). Both cheap non-price series are dead as
  directional signals; remaining edge channels = the live info-context A/B and event/news-class
  information with no fetchable history.
- **Demo fees are REAL and exactly 10bps flat per leg, maker=taker** (verified 2026-07-12) ⇒ fee
  levers cannot move demo PnL; fee-tier/BNB work is live-parity prep only.
- **Decide model: claude-sonnet-5 stays champion — E2 re-test trigger CONSUMED 2026-07-17
  (Pass 31).** First run (07-12, n=50): haiku-4.5 fails hold-agreement + propose bars. Re-test at
  corpus ≥600 (728; n=100 newest rows, registry row 129, scorecard
  `candidates/e2-model-eval-2026-07-17.json`): HOLD decisively — schema-valid 0.83, hold-agree
  0.78 < 0.85, forward proxy −27.9bps vs champion +17.8bps; the "cheaper-and-more-proposing"
  profile did NOT persist (propose ratio 1.8→0.8, propose-agreement 0.2). No further scheduled
  re-test — revisit only on a material payload/regime change (e.g. post-factorial always-on info
  blocks). Opus-4.8 decisively rejected (07-13). **Thinking-on: NO FLIP** by pre-registered
  criteria but strongest lever surfaced → absorbed into the P8a factorial (#42 CLOSED-OBE). E2
  re-run recipe (env hygiene — the SAFE recipe): LOG.md 2026-07-10 ~22:00Z incident-pass entry.
- **Kimi-K3 offline replay: HOLD decisively (2026-07-21/22, n=100 newest payload rows; v3
  registry row 1; scorecard `candidates/kimi-k3-model-eval-2026-07-21.json`).** Schema-valid
  0.85 < 1.00, hold-agreement 0.17 (champion held 100/100, K3 proposed ~83%), cost −32% where
  the bar demands −50%; plan-sanity 1.0 was its only pass. No live A/B, no scheduled re-test —
  revisit only on a material payload/regime change or a K3 serving-stack revision, via the
  standing eval-lane routing knobs (`AGENTIC_EVAL_BASE_URL`/`_API_KEY`, LOG.md 2026-07-22).
- **Trade-model head-to-head (v3 rich contract, HARDENED): NO FLIP, loop stays on Claude
  (2026-07-22, n=200/leg, max_tokens 4096, thinking disabled; registry rows 6 sonnet-5 / 7
  kimi-k3; scorecard `candidates/trade-model-eval-headtohead-hardened-2026-07-22.json`).** A
  REAL comparison (all five criteria evaluated): kimi-k3 fails criterion 1 (schema-valid 0.71 <
  0.805) and criterion 4 (propose-ratio 5.43 ∉ [0.5,1.5]); passes 2 (sanity 1.0=1.0), 3
  (directional proxy +5.42 vs −4.68bps), 5 (cost −54%). kimi's profile: more willing to trade
  (76 proposes incl. 12 shorts, rate 0.38 vs sonnet 0.07), directionally better on its picks,
  half the cost, but less schema-reliable (58 vs 39 errors — kimi's mode is thesis >300 chars).
  Criterion-4 caveat: the sonnet baseline is itself unusually passive (0.07 vs champion 0.125),
  so the ratio bar is degenerate against it (verdict unaffected — schema-valid also fails). The
  PRE-FIX legs (rows 2/3) are superseded — they ran the broken contract where sonnet completed 0
  valid proposes (criteria 2/3/4 null); retained only as contract-defect evidence. Re-test
  trigger: native v3 corpus once it holds ≥200 payloads with ≥20 `open_*` proposes.
- **v3 submit_trade contract non-compliance is a real defect, now FIXED (2026-07-22).** Both
  sonnet-5 and kimi-k3 fail `tradeDecisionSchema` on a large fraction of propose attempts under
  thinking-disabled/forced-tool; production silently degraded every rejection to a masked hold
  (67 of 100 live consulted holds since the 07-21 cutover). Root cause = model-facing required-set
  gap + thesis-cap + array-not-string; fix = prompt hardening + metered degrade path
  (`agentic_schema_rejections_total`, `schema_rejected:` rationale). Post-fix on the hardened
  head-to-head: sonnet schema-valid 0.69→0.805 and 0→14 completed proposes; kimi 0.62→0.71.
  Closes WATCH-V3-3. Deploy pending — loop-domain (I commit + deploy per the 2026-07-22
  gate-override grant).
- **Directional seed-rule edge clears fees nowhere ≤1d** (edge diagnostic 2026-07-10, 52
  selection-corrected buckets; `reports/loop/edge-diagnostic-2026-07-10.md`).

## Later corrections (2026-07-28, appended below § Archived records in state.md)

- **CORRECTION — v8 is the champion, v9 is a CANDIDATE (2026-07-28, Pass 42).** Two artefacts of this
  pass called v9 "the live champion": commit `b9b52a6` and the playbook-space arm label
  `champion_v9`. Both are wrong. `agentic_playbook_info` reports the app running **version 8**;
  **v9 is an unresolved `source='reflection'` candidate** sitting above it, taking
  `AGENTIC_PLAYBOOK_AB_PCT=40`% of decides through the A/B. The study arms are renamed to the roles
  the live system actually assigns (`champion_v8`, `candidate_v9`) before any result existed. The
  truncation defect `b9b52a6` fixed is real and unchanged — v9's entry-rules section ends mid-sentence
  at _"If ONE input disagrees (lagging"_ and that text still reaches 40% of live decides — it is the
  candidate's text, not the champion's.
- **THE CANDIDATE-LAPSE DEADLOCK IS LIVE, NOT HYPOTHETICAL (2026-07-28, Pass 42).** The Phase-B
  blocker list predicted it; it is currently in force. `scripts/playbook-candidate.mjs:168-180` refuses
  to mint past ANY unresolved candidate above the active version, and its `blocking` filter carries
  **no age predicate**. v9 has been unresolved for ~16 h. Its three escape routes:
  - **promotion** — needs attributed A/B evidence the promotion evaluator will accept;
  - **age lapse** — `AGENTIC_CANDIDATE_LAPSE_HOURS=336` (14 days), so not before ~2026-08-10;
  - **abstention lapse** — needs ≥15 attributed real decides with zero entries.

  Both lapse routes live in `reflection.service.ts`, so both require the LLM lane to be calling. With
  both provider accounts unfunded the lane makes zero real decides, so **no evidence accrues on any
  route and `pnpm playbook:candidate` stays blocked until either funding returns or the 14-day age
  lapse fires.** The mint path being dead was previously masked by a second defect — the script's
  validator path pointed at a directory that never existed (fixed `0911c37`), so it exited 1 before
  ever reaching this check. Fixing that path is what made the deadlock observable.
