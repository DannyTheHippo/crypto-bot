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

- **TWO BARS, AND THEY ARE NEVER THE SAME BAR — a research-bar FAIL IS NOT a deployment veto (owner
  ruling 2026-07-30: _"if a less-bad playbook is found than the running one, deploy it. less-bad is
  always better than dropping it since it is CLOSER to profitability"_).** Read this before answering
  "should I deploy X?" — it stands first because the verdicts below it are research-bar verdicts and
  every one of them is silent on deployment.
  - **The RESEARCH bar** — mean **> +13.0 bps** AND the bootstrap 95% CI **lower bound > +13.0 bps**,
    under the pre-registered Bonferroni α, plus the random-bar placebo (playbook-space study: bar
    clauses at `research/studies/playbook-space-replay-2026-07-28.md:149-168`, α = 2.5e-3 on a family
    of 20 at `:724-736`). It answers **"does an edge exist?"** It governs every claim of edge and every
    step toward live money. Nothing else may be called an edge.
  - **The DEPLOYMENT bar** — beats the **currently running** playbook on the SAME corpus, the SAME
    metric and the SAME horizon, all three declared before the comparison is looked at. It answers
    **"which of several losing options should run?"** It governs playbook selection and nothing else.
  - **The load-bearing consequence: `NO_SURVIVOR` is a RESEARCH-bar verdict and says NOTHING WHATEVER
    against the deployment bar.** 20 of 20 declared cells scored, 0 passes
    (`playbook-space-replay-2026-07-28.md:801-810`) means no funded arm cleared +13.0 bps. It does not
    mean the arms are indistinguishable, and it does not mean the status quo wins by default — the
    study measured every arm's mean and the champion is not the best of them. **Do NOT re-derive
    "research-bar FAIL ⇒ do not deploy". It is FALSE, and applying it throws away everything the study
    measured while leaving the worst-measured option running.**
  - **The worked example, which is also the live decision.** On the identical 354-row corpus and the
    identical forward-return metric, `inverted` beats `champion_v8` at **every** horizon
    (`playbook-space-replay-2026-07-28.md:749-756`): h=1 **−0.8 vs −12.7**; h=4 **+0.8 vs −36.3**;
    h=8 **+19.3 vs −32.7**; h=24 **+47.6 vs −70.1** bps. `inverted` n=117 over 20 clusters at every
    horizon; `champion_v8` n=70 at h=1/4/8 and n=69 at h=24. Net of the 20 bps round trip (the ENTRY
    SIGNAL verdict below: _"+24.2 (live 20 bps)"_), h=24 reads **+27.6 for `inverted` against −90.1** —
    arithmetic on the two means, not a new measurement. Under the deployment bar that is not a close
    call; under the research bar both are failures, and both statements are true at once.
  - **Guardrail 1 — `inverted` FAILS the research bar and deploying it is NOT a claim of edge.** h=24
    CI lower bound **−12.2**, h=8 **+1.1**, both under +13.0; `p vs bar` 0.1947 / 0.2215. The existing
    hedge in the NO_SURVIVOR verdict below — **never quote +47.6 as an edge** — stays true and stays
    binding, and this verdict does not soften it by one basis point. Deployment is a choice among
    losers; it licenses no write-up, no promotion evidence, and no move toward live capital.
  - **Guardrail 2 — in-sample, one regime.** The arms are scored on the corpus that generated the
    finding, 6.35 calendar days, 2026-07-21 → 27 (`playbook-space-replay-2026-07-28.md:69-73, 218-223`).
    A deployment decision may rest on this; an edge claim may not.
  - **Guardrail 3 — adverse selection may not invert, and offline replay structurally cannot measure
    it.** The recorded entries were maker-side at **76% fill**; being reliably on the wrong side of a
    print does not imply the other side of that print was available at the same terms
    (`playbook-space-replay-2026-07-28.md:224-226`; § NOT A FINDING below). The study's "the bias is
    identical across arms" argument covers the entry PRICE level, not whether the faded side fills at
    all. **A divergence between replay-predicted and live-realised entry return is therefore a FINDING
    to report, not noise to explain away.**
  - **Guardrail 4 — this is NOT the arithmetic inversion test, and the two must never be collapsed.**
    `test/backtest/inversion-test.mjs` negates recorded observations, so its +16.9 / +31.9 / +47.3 /
    +66.5 bps mirror is a tautology (§ NOT A FINDING below). The `inverted` ARM is different in kind:
    playbook PROSE run through the model, producing its **own 117 entries** against the champion's 70
    on the same rows — the arm text and the header comment stating precisely this distinction are at
    `test/eval/agentic/playbook-space-arms.ts:100-133`. Citing the sign-flip mirror as support for the
    arm, or dismissing the arm as "just the sign-flip", are the same error in opposite directions.
  - **Guardrail 5 — reverting a failed deployment falls back to the NEXT-LEAST-BAD arm, never to
    `champion_v8` by default.** At h=24 the funded sonnet ranking is `inverted` +47.6 > `minimal` −40.7
    (n=89) > `champion_v8` −70.1 > `momentum_pure` −85.3 (`playbook-space-replay-2026-07-28.md:749-764`),
    so the fallback from `inverted` is `minimal`, and reverting to the champion would revert to a
    **worse-measured** option. The ranking is horizon-specific — at h=1 it reads `inverted` −0.8 >
    `champion_v8` −12.7 = `momentum_pure` −12.7 > `minimal` −13.3 — which is why the horizon is
    declared before the comparison, not chosen after it.
  - **ACTED ON 2026-07-30 (Pass 49) — `inverted` IS THE LIVE PLAYBOOK, v10. A RESEARCH-BAR FAIL,
    SHIPPED ON DEPLOYMENT-BAR GROUNDS.** Recorded in those words on purpose: the worked example above
    stopped being a worked example and became the deployment. `agentic_playbook_info` reads
    `version="10"` since the 2026-07-30T16:57:19Z boot; `agent_playbook_versions` carries version
    **10, `source='loop-candidate'`, `parent_version=8`** (minted 16:56:43.469Z, the `inverted` arm's
    prose verbatim, 1,933 chars) and version **11, `source='promotion'`, `parent_version=10`**
    (16:56:57.909Z). It is the FIRST `source='loop-candidate'` row in the program's history.
    - **Every guardrail 1-5 above binds on the deployment and none is softened by it.** In particular
      guardrail 1: `inverted` FAILS the research bar on interval width (h=24 CI lo **−12.2**, h=8
      **+1.1**, both under +13.0; `p vs bar` 0.1947 / 0.2215), so **never quote +47.6 as an edge**.
      Guardrail 2: in-sample, one 6.35-day regime. Guardrail 5: a revert falls back to `minimal`, not
      to `champion_v8`.
    - **Guardrail 3 is now a live measurement, not a caveat.** Adverse selection may not invert, and
      offline replay structurally cannot measure whether it does — the recorded entries were
      maker-side at **76% fill**. **A divergence between replay-predicted and live-realised entry
      return is a FINDING to report, whichever way it points**: live worse than replay is the
      adverse-selection hypothesis confirming; live better is a finding about the replay. Operational
      form: `watches.md` § WATCH-PLAYBOOK-V10-1.
    - **ATTRIBUTION LIMIT — binding on every future pass.** `AGENTIC_PLAN_AUTHORITATIVE_EXITS` went
      live on the SAME boot, six minutes after this promotion. **No pass may claim either change moved
      the realised book on its own.** There is no control arm. Their EVIDENCE is separable — this one
      is measured on entry forward return, which does not depend on how a position is exited; the
      other on exit behaviour given entries, which does not depend on which bar was chosen — and each
      therefore keeps an independent replay-measured basis. Their realised-PnL contributions do not
      decompose at any trip rate.
    - **The candidate-lapse deadlock recorded at the end of this file is RESOLVED as a consequence**,
      by `--supersede` and not by a lapse: `experiments` id 8, family `playbook-supersede`, label
      `v9 (reflection) superseded by v10 via --supersede`, `supersededAgeHours` 79 against a 336h
      window. **No row was deleted** — all ten versions including v9 remain.

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

- **ARCHITECTURE IS NOT THE LEVER EITHER — the haiku 3-vote swarm does NOT ship, and the screen that
  predicted it is now VALIDATED (2026-07-30, Pass 49; Family A of
  `research/studies/playbook-space-followon-2026-07-31.md`, scorecard
  `research/scorecards/playbook-space-followon-2026-07-31.json`).** Read this before proposing any
  ensemble, multi-call, self-consistency or majority-vote variant of the decide path.
  - **Deployment bar: it LOSES the declared primary horizon, so the incumbent stays.** Against
    `champion_v8` on the identical 354-row corpus and metric — h=1 −12.15 vs −12.69 (beats), h=4
    −22.58 vs −36.34 (beats), h=8 −35.38 vs −32.70 (loses), **h=24 primary −71.83 vs −70.10 (LOSES)**.
    2 of 4, and not horizon-dependently. **"No arm beats the incumbent, so the incumbent stays" is a
    result, not a default.**
  - **Research bar: `NO_SURVIVOR`.** 4 of 4 declared cells scored at α=0.0125, **0 passes**, every one
    POWERED (n=78–82 over 15 clusters against `MIN_ENTRIES=12`), every one failing the FIRST clause:
    means **−12.15 / −22.58 / −35.38 / −71.83** against a required **+20.9 / +26.4 / +33.8 / +81.4**.
  - **The pre-registered screen scored CORRECT, on the mechanism and not just the direction.**
    `architecture-options-2026-07-28.md` called it NEUTRAL-TO-WORSE before funding, on the argument
    that ensembling reduces variance rather than bias while the measured failure is a bias. The swarm
    is worse than its own single-call control at **3 of 4** horizons, at **3.00× the calls**
    (`$0.010506` vs `$0.003502` per decide) for near-identical entry rates (**24.58% vs 24.86%**), and
    placebo p is **0.9902 / 0.9946 / 0.9980 / 1.0000** — a displaced centre, exactly what a
    variance-reduction instrument cannot move. **The screen is now a validated instrument for the next
    screening decision, which is worth more than the arm was.** Its three registered mechanisms may be
    cited as pre-registered rather than post-hoc; mechanism 2 has measurement — of 354 rows, **282
    unanimous, 71 split-collapsed-to-mode, 53 where the swarm's action differed from the control's.**
  - **Attribution was PROMPT-CONTROLLED and that is verified, not asserted.**
    `src/features/strategy/agentic/agent-prompt.ts` is blob
    `c471c33055abad7c7ec0cb9978f81c61bc3c487d` at HEAD, on disk and at the pin — re-verified at all
    eight commits the run spanned, including two peer commits that landed mid-run and touched neither.
    So the `$4.86` in-run sonnet control was genuinely unnecessary. **Not removed by this:** provider
    -side model drift and re-run variance, which the funded design explicitly declined to buy out.
  - **A LEAD, EXPLICITLY NOT ACTED ON — do not read this as a finding.** A **single** haiku call beat
    the sonnet incumbent at h=1/4/8 (**−7.12 / −10.77 / −30.30** vs −12.69 / −36.34 / −32.70) and
    **LOST the declared primary h=24: −80.30 vs −70.10.** Three independent reasons it does not ship,
    any one sufficient: the pre-registered robustness clause requires h=24 **AND** ≥3 of 4 — both, not
    either; acting on "wins 3 of 4" cherry-picks against a primary declared before the numbers were
    seen; and it is a **model** change on the axis § THE DECIDE MODEL IS NOT THE LEVER already settled
    `NO_SURVIVOR`. **Never cite it as evidence for a decide-model swap.**
  - **The incumbent it was measured against is no longer the incumbent, and that STRENGTHENS the
    NO-GO.** The study correctly read the champion as `champion_v8` at comparison time; `inverted`
    shipped 16 minutes later. Against the live v10 the swarm's h=24 −71.83 sits against `inverted`'s
    replayed **+47.6** — ~119 bps worse, losing at every horizon rather than two. That comparison
    crosses models (haiku arm vs sonnet arm) so it is weaker than the like-for-like one the study ran,
    but it points the same way. **Do not re-open the swarm on "it nearly beat the champion".**
  - **Spend `$6.1728` of `$7.93` authorised** (calibration `$1.2142` + paid run `$4.9586`), 6.6% under
    projection, hard cap `$21` not approached, `rowsCovered = 354/354`, `aborted = false`.
  - **COST INPUT ROUTED ONWARD, not absorbed:** the sonnet re-check measured **`$0.0191125`/call,
    1.39× the predecessor's `$0.013717`** on the same prompt surface and model alias. Likely
    **cache amortisation over a single 40-row chunk** against a predecessor that spread its writes
    over 354 rows and four arms — a caution, **not** evidence of provider repricing. Family A is
    unaffected (priced off the haiku probe); **Family B is not** — its two sonnet legs were budgeted
    `$4.86` each on the older figure and would land nearer **`$6.77`** each. Re-size from the
    re-checked rate or say why not.
  - **Two arithmetic footnotes, so neither is re-derived as a defect.** (1) The haiku **0.273×** ratio
    is against the PREDECESSOR's sonnet price: `$0.0037475` / `$0.013717` = 0.273, inside the
    pre-registered 0.21–0.33 band. Against the re-checked `$0.0191125` the same numerator is
    **0.196×**, below that band — both true, and the band was declared against the older figure.
    (2) The re-check entered on 3 of 34 parsed rows (8.8%) against the predecessor's 19.8% for the
    same arm; at n=34 the 95% interval on 8.8% reaches ~23%, which contains 19.8%, so it is **within
    sampling error and evidence of nothing in either direction.**

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
- **ACTED ON THE FIRST COROLLARY ABOVE — the declared plan now outranks a mid-trade `close`
  (2026-07-30, deployment-bar action; code shipped FLAG-OFF, not yet enabled).** This is **NOT a new
  exit rule** and it does **NOT reopen the settled sweep** directly above. That sweep tested 16
  alternative _geometries_ and killed all of them; this changes **no geometry and no default** — it
  removes the model's discretion to deviate from the geometry it had already declared itself.
  Restating the two bars deliberately, because a future pass will otherwise misread this as a
  re-run: at **+29.7 bps/trip** it is a **RESEARCH-bar FAIL** (`verdicts.md:272` — "real, but under
  the pre-registered 30 bps bar and nowhere near profitability") and a **DEPLOYMENT-bar win** over
  what runs today, exactly the split the standing two-bar ruling at the top of this file governs.
  - **Measured basis, unchanged from the study above** (same 23 recorded round trips, same harness,
    paired by construction): Arm 1, what the lane actually did with discretionary closes included,
    **−108.1 bps/trip at 17.4% hit**; Arm 2, the model's own declared stop/take-profit/maxHold run
    mechanically, **−78.4 bps at 22.7%**. −108.1 is the number any future measurement of this change
    must be compared against.
  - **What Arm 2 simulated, read off the harness rather than the prose:**
    `test/backtest/exit-attribution.spec.ts:265` calls `simulateExit` with the entry decision's own
    `stopLossPct`/`takeProfitPct`/`maxHoldBars`, and `test/backtest/exit-simulator.ts:103-123` exits
    on **stop, take-profit or max_hold and nothing else** — it has no `close` input at all. Arm 2
    therefore honoured **no** model `close`, in any direction. The shipped gate drops it outright for
    that reason: this reproduces a measurement, it does not improve on one.
  - **Shipped:** `AGENTIC_PLAN_AUTHORITATIVE_EXITS` (default `false`, `.env.app` + zod schema),
    consumed in `anthropic-agent-client.ts`'s `buildProposalFromTradeDecision` close branch. When a
    positioned symbol carries enforced `directives`, the `close` emits no exit signal and is
    journalled as a `hold` tagged `plan_authoritative_close:` (queryable; deliberately NOT a
    `DEGRADED_DECIDE_RATIONALE_TAGS` member — the consult was healthy, the system overrode it).
    Journalling it as `hold` rather than `close` is load-bearing: a directive-less `close` is what
    makes `agentic.strategy.ts` clear the active plan, and a cleared plan is the unmanaged position
    the gate exists to prevent.
  - **Failure direction: fails toward EXITING.** The gate suppresses an exit, and an exit that fails
    to fire leaves a position open against its own declared invalidation, so it fires only on
    positive evidence that a deterministic executor is already enforcing that invalidation. No
    context, absent `directives` (the restart case — the in-memory plan was lost), or FLAT ⇒ the
    close executes unchanged. The evidence is strong: `agentic.strategy.ts:884` runs `evaluatePlan`
    **before** the consult gate on every bar and lets its stop/take_profit/max_hold verdict own the
    bar outright, so a suppressed close can only land on a bar the declared plan itself called hold —
    with `AGENTIC_VENUE_STOP`/`_TP` resting at the venue meanwhile.
  - **Scope limits, stated so nothing is read into this that was not measured.** Only the `close`
    _action_ is dropped: the 29.7 bps sits in that channel (16 of 22 closes were the model's own
    `close`; a partial close never closes a round trip in `walkRoundTrips`). An `adjust` — the
    sanctioned channel for revising a declared plan — still applies in full, so this reproduces
    Arm 2's exit-SOURCE semantics but not its implicit geometry freeze (Arm 2 replayed the geometry
    declared at ENTRY and never saw later revisions). Also unshipped: a Prometheus counter for the
    suppression, because its wiring passes through `trading-runtime.module.ts`, concurrently owned by
    another pass; the journal rationale tag is the queryable surface until then.
  - **WATCH-PLAN-AUTHORITY-1 (UNFIRED — the flag is off).** The enable is a separate config-only
    step. First post-enable observation must show `plan_authoritative_close:` holds appearing at
    roughly the historical close rate (~16 per 22 exits) AND the exit mix shifting toward venue
    stop/TP/max_hold. A storm of positions running to `max_hold` with realised bps _worse_ than
    −108.1 = revert (flip the flag) and record. Resolve explicitly at the next observation.
  - **STEP TWO TAKEN 2026-07-30 (Pass 49, `4218d78`) — `AGENTIC_PLAN_AUTHORITATIVE_EXITS=true`.**
    `.env.app:261`, live since the 16:57:19Z boot on build `4218d78`. Step one booted clean at
    16:51:44Z on `9a63edf` (`RestartCount` 0, kill switch RUNNING, 21 rules healthy and none firing,
    `loop:sweep` 0 alarms); that was the precondition, and this is the enable. **The bullet above is
    left standing verbatim as the pre-enable record — WATCH-PLAN-AUTHORITY-1 is now FIRED, not
    unfired**, and its live form is `watches.md` § WATCH-PLAN-AUTHORITY-1.
    - **Measured basis, unchanged and not re-derived:** the declared plan run mechanically is
      **−78.4 bps/trip at 22.7% hit** against **−108.1 bps at 17.4%** for the model's actual
      discretionary hand, over the same 23 recorded round trips — 29.7 bps, with 16 of 22 live closes
      being the model's own `close`. **BASELINE FOR THE NEXT MEASUREMENT: −108.1 bps/trip at 17.4%
      hit.** Research-bar FAIL (under the pre-registered 30 bps bar), deployment-bar win.
    - **The failure mode this creates is a plan lost to a restart**, since a position whose in-memory
      plan is gone has no declared stop left to exit on. The gate **fails toward EXITING** — no
      context, absent `directives`, or FLAT ⇒ the close executes unchanged — and `AGENTIC_VENUE_STOP`
      / `AGENTIC_VENUE_TP` are both `true`. Confirmed live rather than trusted from the spec: 6
      `ACKED` protective orders resting across both venues at 17:13Z, each with a `venue_order_id`,
      and the first round trip under the flag (`KAITO/USDT:USDT`) exited at 17:11:55Z **by its
      declared `STOP_MARKET`, not by a `close`**.
    - **ATTRIBUTION LIMIT — binding on every future pass.** The `inverted` playbook promotion went
      live on the SAME boot. **No pass may claim either change moved the realised book on its own.**
      Evidence separable, realised PnL not — full statement under the two-bar ruling at the top of
      this file.
    - **Correction to the trip-rate figure that framed the limit:** the ~3.8 trips/day quoted when the
      change was written is **not reproducible from the live gauges**. 32 closed trips over a
      6.9663-day trade-anchored window is 4.6/day; the funded stretch runs far faster (29 → 32 between
      2026-07-30T11:04Z and 17:15Z ≈ 11.7/day). The attribution limit does not depend on the rate and
      is unaffected. What the higher rate changes is the timeline: a first re-measure against −108.1
      may be days away rather than weeks.
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

  **AMENDED 2026-07-30 (Pass 48) — ONE PRECONDITION MET, THE DEFECT UNCHANGED. This is NOT resolved.**
  The Anthropic account was funded at 2026-07-30T09:01Z and the lane resumed real decides with no
  redeploy (`STATUS.md` § The LLM lane), so the "until either funding returns…" clause above has had
  its funding half satisfied. **That is the only thing that changed.**
  `scripts/playbook-candidate.mjs:168-180` still refuses to mint past ANY unresolved candidate above
  the active version, its `blocking` filter still carries **no age predicate**, and
  `pnpm playbook:candidate` is therefore still blocked; v9 is still unresolved and still takes
  `AGENTIC_PLAYBOOK_AB_PCT=40`% of live decides. What funding bought is narrow: the two lapse routes,
  which require the LLM lane to be calling, can now accrue evidence at all. It did not bring either
  materially nearer — the age lapse still cannot fire before ~2026-08-10, and the abstention lapse
  needs ≥15 attributed real decides with **zero** entries while the lane resumed proposing the same
  morning (`open_long` ZEC spot + perp, 09:15:31Z). Repairing the script itself is a separate change
  and is not claimed here.

  **RESOLVED 2026-07-30 (Pass 49) — by repairing the script, and via `--supersede`, not via a lapse.**
  `2c4e339` ported the runtime's age and abstention lapses into `scripts/playbook-candidate.mjs`, added
  a no-change sha256 check and a `--supersede` flag that records the supersession and deletes no row.
  v9 was superseded by v10 at 2026-07-30T16:56:43.469Z: `experiments` id 8, family
  `playbook-supersede`, label `v9 (reflection) superseded by v10 via --supersede`, metrics
  `{"lapseHours":336,"newVersion":10,"activeVersion":8,"supersededSource":"reflection",`
  `"supersededVersion":9,"supersededAgeHours":79}`. **Neither lapse route fired and neither is claimed
  to have** — at 79h against a 336h window the age route was nowhere near, and the abstention route
  correctly did not fire because v9 had 61 decides and **6 entries**, so it traded.
  - **The gate's declared failure direction survived the repair, which is the part worth keeping.** It
    fails CLOSED but **TIME-BOUNDED**: minting orphans a live candidate and writes an uncorrectable
    `parent_version`, so it refuses — but a permanently-closed gate is itself the failure, so the
    refusal expires at `candidateLapseMs`, lifts on proven abstention, and yields to `--supersede`,
    with the abstention sub-read failing toward NOT lapsing. `--supersede` itself fails CLOSED: no
    `experiments` table ⇒ refuse the override entirely, and the record is written in the same
    transaction as the mint it authorises.
  - **A worse defect was found underneath and is the real story.** `playbook-shared.mjs` resolved the
    active version via the FIRST seed row by version, while `PlaybookStoreAdapter.ensureSeed` looks up
    `seed.version` specifically and the composition root binds `SEED_PLAYBOOK_V3` at **8**. On a clean
    v3 database those agree; **the live table is not clean** — four seed rows survive at versions
    **1, 2, 6 and 8**, no promotion row, empty pin — so the helper returned **1** while the running
    process resolved **8**. Every candidate this CLI had ever been asked to mint would have written
    `parent_version=1` into an **append-only table that cannot be corrected afterwards**. It had never
    been asked: `source` read `reflection` 4, `seed` 4, `loop-candidate` **0**. The fix takes the
    newest seed row, justified by the documented bump-above-all-prior-rows rule at
    `agentic-strategy.module.ts:426-438`. **Verified in the first row it ever produced: v10 carries
    `parent_version=8`, not 1.** The defect and its first production use were the same event.
  - Also corrected: the CLI validated with no opts (spot-strict) while the runtime passes
    `{shortsAllowed, leverageAllowed}`, so it rejected perp-legal prose the live lane accepts (fails
    OPEN, never to spot-strict, bounded because `ValidatingPlaybookProvider` re-validates the same
    bytes on the read path); and `AGENTIC_CANDIDATE_LAPSE_HOURS` was read from a bare environment that
    nothing loaded `.env.app` into, so it fell back to a 720h code default against a deployed 336h
    policy — fixed by loading the deploy file, not by hardcoding a deploy value into a code default.
  - **`pnpm playbook:candidate` is now the ONLY minting path**, because in-process reflection was
    deleted the same pass (`9a63edf`). `'reflection'` stays in `CANDIDATE_SOURCES` — removing it would
    instantly stop routing v9's live decides — and is documented in-code as historical-only with its
    removal condition.
  - **One live knob now describes a state that no longer exists.** `AGENTIC_PLAYBOOK_AB_PCT=40` routes
    to the newest INACTIVE candidate above the active version; with v9 superseded and sitting below
    v10 there is none, so the A/B routes nothing. Since the deploy all four real decides read
    `playbook_version=10` (v9 took 40 of the previous 24h's 88). Not a defect — but a pass should
    either mint a genuine candidate to compare against `inverted` or set the knob to 0 and say so.
