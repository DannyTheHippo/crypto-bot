<!-- Created 2026-07-30 (Pass 48). Full text of every open WATCH line and every open flagged item,
     moved or copied VERBATIM from research/loop/state.md. Nothing was edited. -->

# WATCH lines and flagged items — full text

**Read a line here when `STATUS.md`'s one-line index is not enough** — when you need the exact
expected-positive signature, the named defect outcome, or the deadline. Every WATCH carries all
three by change-discipline (playbook §4).

Provenance, stated because it decides where to look for the rest of a story:

- WATCH paragraphs that sit INSIDE a larger decision record were **copied** here verbatim. The
  record itself is intact in `archive/state-2026-07-30.md`, so no narrative was cut in half; the
  source record is named under each heading.
- The § Flagged entries were **moved**: the open ones and the section's policy header are here, the
  resolved and superseded ones are in `archive/state-2026-07-30.md` § Flagged … resolved.
- The pre-v3 WATCH sets (WATCH-XA1 / X2 / XA6 / XA7-spot / X7-X8 / X9 / Y2-Y3 / Y4) describe the
  BUILD that led here and are historical record, not standing checks against the current build
  (playbook § WATCH lines a pass must check). Their full text stayed with their decision records in
  `archive/state-2026-07-30.md`.

## Open WATCH lines

### WATCH-V3-1 — spot heap slope (2026-07-21; source: § Strategic frame, "v3 BUILD COMPLETE" record)

WATCH-V3-1: spot heap slope on the demo soak (paper plateau 673 MiB is the
  reference; a demo-mode sustained climb past ~900 MiB before the soak ends is a defect signal).

### WATCH-V4-1 — clean-stamp liveness (Pass 40, 2026-07-27; source: the "RECOVERY RE-DISARMED AND RE-ARMED" record)

  **WATCH-V4-1 (clean-stamp liveness).** Expected-positive: the gauge's age stays under ~2 min at
  every pass, `reconciliation_mismatch_total{class="adopt_non_adoptable"}` stays 0, and no order sits
  non-terminal while its `fills` sum equals its `qty`. Named defect outcome: the age exceeds 30 min
  again (the sweep now says so out loud) ⇒ a THIRD starvation cause exists — root-cause it before any
  other work, checking `sum(fills.qty)` against `orders.cum_qty` for non-terminal orders first, since
  that is the shape twice running. Deadline: next pass confirms the first ≥12h window with the stamp
  never stale.

  **AMENDED 2026-07-30 (Pass 49) — THE VERIFICATION SURFACE WAS WRONG, AND THE CLAUSE IS BREACHED
  ONCE.** Passes 47 and 48 each recorded this WATCH as holding with the citation "no
  `adopt_non_adoptable` in `audit_log`". That reading is true and worthless: **`audit_log` has never
  carried a single row of this class, over its whole history** — the class is written to
  `reconciliations.discrepancies` and to the boot-scoped
  `reconciliation_mismatch_total{class="adopt_non_adoptable"}` counter, and nowhere else. Two
  successive passes confirmed an expected-positive against a table structurally incapable of
  contradicting it, which is the same void-read disease those same passes were fixing elsewhere.
  **Check `reconciliations` from now on** — `select venue, ts, discrepancies from reconciliations
  where discrepancies::text like '%adopt_non_adoptable%'`. The metric alone is not enough either: it
  is boot-scoped and this loop redeploys on most passes.
  Read on the right surface the clause IS breached: **101 rows carry it.** 100 are the
  already-diagnosed 2026-07-27 `binanceusdm` BCH fold defect (`reconciliation.service.ts:969-977`),
  fixed. **One is new and was never recorded: 2026-07-30T09:30:15.860Z, `binance`, boot `1d68a57c`,
  a single pass, `{"detail":"adopt_non_adoptable:1","mismatches":1}`.** It self-cleared — 825 `CLEAN`
  binance passes in the same 14h window, clean stamp 86s old at Pass 49's close — so the **named
  defect outcome did NOT fire** and the stamp was never starved. The single event is **not
  root-caused** and stays an open check. A second occurrence is a root-cause pass: start from which
  order the venue reported `open`/other while absent from open orders, which is what the class means
  (`reconciliation.service.ts:59`).

  **AMENDED AGAIN 2026-07-30T21:52Z — THE SECOND OCCURRENCE ARRIVED, THE ROOT-CAUSE PASS RAN, AND
  "STAYS 0" WAS NEVER THE RIGHT EXPECTATION.** The trigger the amendment above set fired, so this is
  the root-cause pass it demanded.

  **Two counts in the amendment above are wrong and are corrected here rather than quietly restated.**
  The class now carries **102** rows, not 101. And of the 100 rows dated 2026-07-27, **99 are
  `binanceusdm` and 1 is `binance`** (`adopt_non_adoptable:2`, 15:45:22.821Z) — the amendment called
  all 100 `binanceusdm`. Query, run against the durable surface it named:
  `select venue, ts, result, open_orders_checked, discrepancies->>'detail' from reconciliations where
  discrepancies->>'detail' like '%adopt_non_adoptable%' order by ts`.

  **The second occurrence: 2026-07-30T19:00:30.599Z, `binance`, boot `f30074f2`, row id 28052,
  `{"detail":"adopt_non_adoptable:1","mismatches":1}`, `open_orders_checked` 2.**

  **All three `binance` occurrences share one signature, and it is a race between two non-atomic
  venue reads:**

  | occurrence | detail | `open_orders_checked` | order(s) that reached `ACKED` just before | lag |
  | --- | --- | --- | --- | --- |
  | 2026-07-27T15:45:22.821Z | `:2` | 0 | `BTC/USDT` LIMIT 15:45:02Z, `BTC/USDT` STOP_LOSS_LIMIT 15:45:03Z | 19–20s |
  | 2026-07-30T09:30:15.860Z | `:1` | 0 | `ZEC/USDT` LIMIT 09:30:03Z | 12s |
  | 2026-07-30T19:00:30.599Z | `:1` | 2 | `BTC/USDT` STOP_LOSS_LIMIT 19:00:02Z, `ZEC/USDT` STOP_LOSS_LIMIT 19:00:11Z | 19s |

  Each self-cleared on the **very next pass for that venue**, with `open_orders_checked` rising by
  exactly the number that had been missing: 0 → 1 at 09:31:45Z, 2 → 3 at 19:01:29Z.

  **Mechanism, read off the code rather than inferred from the pattern.** `reconcileOpenOrders`
  snapshots `fetchOpenOrders`, then for every local open order absent from that snapshot calls
  `fetchOrder` (`reconciliation.service.ts:743-748`). The two venue reads are **not atomic**. An order
  ACKed seconds earlier is legitimately absent from a list snapshot taken before it landed AND
  legitimately `open` on its own fetch — which is verbatim the condition line 776 bumps as
  `adopt_non_adoptable`. **The class cannot distinguish this race from a real defect**, so on a lane
  that places orders on 15m-bar boundaries against a 60s pass cadence, "stays 0" is unachievable by
  construction and its breach carries no information.

  **THE CLAUSE IS RE-DERIVED, AND THIS IS A TIGHTENING, NOT A WEAKENING.** "Stays 0" demanded nothing
  of an occurrence except that it not happen; the replacement demands a positive explanation for every
  one:

  > **Expected-positive (replaces "stays 0"):** every `adopt_non_adoptable` occurrence is BOTH
  > **transient** — absent from the next pass for that venue — AND **explained** — an order on that
  > venue reached `ACKED` within the preceding pass interval. Both clauses, per occurrence, checked on
  > `reconciliations` (durable) and not on the boot-scoped counter.
  >
  > **Named defect outcome:** an occurrence failing EITHER clause. **≥2 consecutive passes on one
  > venue** is the 2026-07-27 `binanceusdm` shape (99 rows over 1h39m, the fold defect at
  > `reconciliation.service.ts:969-977`) and is what actually starves the stamp, because the class is
  > deliberately **actionable** (`reconciliation.service.ts:152-153`) and so blocks `lastCleanAt`
  > every pass it fires. **An occurrence with no ACK in the preceding interval** is an unexplained
  > divergence — root-cause from the specific coid.

  **The "re-specify it against the classes that DO halt" option is REJECTED, on the watch's own
  subject.** WATCH-V4-1 is *clean-stamp liveness*. What starves the stamp is any ACTIONABLE mismatch,
  halting or not — and `adopt_non_adoptable` is on this watch precisely because it is actionable and
  **non-halting**, the one combination that can starve a stamp for hours without paging anything.
  Moving the clause to `UNKNOWN_OURS_OPEN` would hand the watch a subject that hard rule 6 and the
  halt path already cover, and would leave the real starvation mechanism unwatched. **The class was
  never expected to HALT and was never meant to** — it pushes nothing to `acc.halts`
  (`reconciliation.service.ts:776`), and every one of the 1,727 recorded HALTs came from
  `POSITION_DRIFT`, `UNKNOWN_OURS_OPEN` or `FILL_FOR_UNKNOWN_ORDER`, the last at 2026-07-27T16:46:02Z.

  > **CORRECTED Pass 59 (2026-08-03) — the set-membership sentence above is true but badly
  > misleading, and a pass reasoning from it will over-estimate what has actually fired.** Over
  > `audit_log`'s full retained range (2026-07-21 → 2026-08-03, 32,579 rows) **all 18
  > `RECONCILE_MISMATCH` kill-switch transitions carry reason `UNKNOWN_OURS_OPEN`. Zero
  > `POSITION_DRIFT`, zero `FILL_FOR_UNKNOWN_ORDER`.** The 2026-07-27T16:46:02Z record the sentence
  > cites is itself `UNKNOWN_OURS_OPEN`. Positive control: the same predicate on the same column
  > returns those 18 rows, so the two zeros are genuine absences, not a void read. **The realized set
  > is `{UNKNOWN_OURS_OPEN}` alone — `POSITION_DRIFT` has never halted this system in retained
  > history**, and it could not have done so casually anyway: a `streak >= 2` debounce shipped in
  > `1ff1fc7` (2026-07-17), ten days before that anchor, so a halt needs two CONSECUTIVE divergent
  > passes on one `venue|symbol`. `audit_log` begins 2026-07-21, four days after the positions axis
  > landed, so the 1,727 figure cannot be decomposed by class before that date — it is not refuted,
  > it is unverifiable. **`FILL_FOR_UNKNOWN_ORDER`'s zero has a second, worse explanation**: on
  > `binanceusdm` the reconciler's trades axis has observed **0 trades across 777 passes in 13h**
  > (binance: 6,356 across 778 — positive control), so that detector cannot fire there at all. See
  > this pass's LOG entry § the dead perp trades axis.
  The stamp-age clause and the `sum(fills.qty)` clause are unchanged.

  **State at re-derivation (2026-07-30T21:46:46Z):** 24h reads **2,840 `CLEAN` / 10 `MISMATCH` / 0
  `HALT`** with `kill_switch_state{state="RUNNING"} == 1`. The boot-scoped
  `reconciliation_mismatch_total{class="adopt_non_adoptable"}` reads **1** — the Pass 47 zero-seed
  working as designed, so that is a real reading rather than a void one, but it still only covers boot
  `f30074f2`.

### WATCH-V4-2 — FILL_OVERFLOW is one-shot by construction (Pass 40, 2026-07-27; same record)

  **WATCH-V4-2 (FILL_OVERFLOW is one-shot by construction).** Expected-positive:
  `reconciliation_mismatch_total{class="fill_overflow"}` stays 0. Named defect outcome: any non-zero
  reading is a book HALT that will NOT re-fire and is NOT repaired by restart — capture the
  `FILL_OVERFLOW:{symbol}` reason from `audit_log` immediately (the container log is the only other
  copy, and the sweep truncates its messages to 48 chars). Its likeliest cause — the unqualified
  trade index — was fixed the same pass (`9d69d91`), so a fire now means a genuinely new shape.

### WATCH-V4-3 — redeploy safety (Pass 40, 2026-07-27; source: the "REDEPLOY IS NO LONGER A COIN FLIP" record)

  **WATCH-V4-3 (redeploy safety).** Expected-positive: every future redeploy that happens while a
  perp symbol carries a resting stop boots to `kill_switch_state{state="RUNNING"}` with no
  `perp pin:` line in the boot log. Named defect outcome: another `START_TRADING_FAILED` at boot ⇒
  the pin has a THIRD unverifiable shape — probe the venue for that symbol before editing the guard,
  and do not widen the tolerance without positive proof of `isolated`, which is the whole point of
  the gate. Standing operational note surfaced by this incident: a `flatten=true` halt CANCELS
  resting protective orders first, so a wedged FLATTENING state leaves open positions with no
  venue-side protection — an unsafe resting state, not a safe one.

### WATCH-V4-4 — attribution correctness (Pass 40, 2026-07-27; source: the "TRADE-ATTRIBUTION FAMILY CLOSED" record)

  **WATCH-V4-4 (attribution correctness).** Expected-positive: `fills` rows always carry the
  clientOrderId of an order on the SAME venue as the fill, no `FILL_FOR_UNKNOWN_ORDER` halt fires on
  an order younger than the pass that halted it, and `sum(fills.qty)` per order equals
  `orders.cum_qty` for every terminal order. Named defect outcome: any of those three breaking means
  the index or the fold has a shape none of the four fixes covers — do not patch the symptom;
  re-derive which tier resolved the trade first.

### WATCH-V4-7 — the sweep can see across passes (Pass 45, 2026-07-29; source: the "AN OUTAGE THAT WAS OVER BEFORE ANYONE LOOKED" record)

  **WATCH-V4-7 (the sweep can see across passes).** Expected-positive: every pass's digest carries an
  `alerts fired+resolved in the last 12h` line and a warn-scan span at/above the alert lookback, and any
  Prometheus rule that fires between passes appears in exactly one of the two alert lists. Named defect
  outcome: an incident is later found in the container log or the DB that appeared in NEITHER list ⇒ the
  ALERTS series is not the complete record this assumes — check `alert_window_partial` for that pass
  first, since a scrape hole explains it without any code being wrong. **Open sub-item RESOLVED BY
  DELETION 2026-07-29** — there is no collector daemon left to hold stale code (see the record below).

### WATCH-V4-9 — the replay must describe the same account live described (2026-07-30; source: `research/studies/playbook-space-replay-2026-07-28.md` Amendment 5)

  **WATCH-V4-9 (replay capability fidelity).** `replayPlanRow` built its capabilities from CONSTANTS
  while the recorded row payload carried the real ones, so it advertised a `sizeFraction` ceiling of
  0.25 against a recorded 0.35 (and bounded the schema there, manufacturing schema rejections from
  models that believed their own payload), offered shorts on the 139 SPOT rows recorded `shorts:false`,
  and stated leverage 2 on rows recorded at 1 or 5. This is not confined to research: the same builder
  serves two MINT-TIME gates — `measureEntryRate`'s entry-rate floor and the candidate expectancy
  backtest — so both judged candidates against a ceiling and a short-side availability the live row
  never had. **Fixed 2026-07-30** by deriving capabilities per row from the payload
  (`recordedCapabilities`), with the zod bound taken from those capabilities so bound and advertised
  limit cannot disagree; `capsSource` is reported per call and the playbook-space study voids any run
  with a single non-`recorded` row (12 regression tests,
  `test/features/strategy/agentic/entry-rate-floor-capabilities.spec.ts`).

  Expected-positive: every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows,
  and a candidate that the entry-rate floor rejects is rejected for abstaining, not for proposing a size
  the recorded row actually permitted. Named defect outcome: **the 4x entry-rate gap does not close.**
  The replay entered 4.5% of 33 rows where the LIVE system entered 18.2% of the same rows with nominally
  the same playbook; if a post-fix re-measure still reads far below the recorded 16.1% corpus rate, the
  cause is NOT capabilities and the next suspect is the system prompt — the replay builds it from
  `DEFAULT_FLOOR_PROFILE`, which is not known to match the live prompt — followed by the live mixture
  over ~9 playbook versions versus a single replayed arm. **A first diagnosis blamed
  `venueFreeCash: '0'` and was WRONG** (the tool description never carries free cash; the regression
  test now asserts its absence so the claim cannot be re-derived) — so do not attribute the gap to
  anything without re-measuring it. Deadline: before any paid edge tier runs, since entry rate is the
  input the whole design is sized against and an unpowered cell cannot answer the study's question.

### WATCH-PLAN-AUTHORITY-1 — the declared plan now owns the exit (FIRED 2026-07-30, Pass 49)

  **WATCH-PLAN-AUTHORITY-1.** Opened in `verdicts.md` while the flag was off; **it is no longer
  UNFIRED — `AGENTIC_PLAN_AUTHORITATIVE_EXITS=true` at `.env.app:261` since the 16:57:19Z boot of
  2026-07-30.** While a positioned symbol carries enforced `directives`, the model's `close` emits no
  exit signal and is journalled as a `hold` tagged `plan_authoritative_close:`; positions exit ONLY
  via the declared stop, take-profit or maxHold.
  **Expected-positive, in two parts:** `plan_authoritative_close:` holds appear at roughly the
  historical close rate (~16 per 22 exits), AND the exit mix shifts toward venue stop / TP / max_hold.
  **BASELINE FOR THE NEXT MEASUREMENT: −108.1 bps/trip at 17.4% hit** (Arm 1 of the exit study, the
  lane's actual discretionary hand over 23 recorded round trips). The replay-measured target is
  Arm 2's **−78.4 bps at 22.7%**, i.e. 29.7 bps better — a research-bar FAIL under the pre-registered
  30 bps bar and a deployment-bar win.
  **Named defect outcome:** a storm of positions running to `max_hold` with realised bps **worse than
  −108.1** ⇒ flip the flag back and record it. **The failure mode to watch for specifically is a plan
  lost to a restart**, since a position whose in-memory plan is gone has no declared stop left to exit
  on. The gate fails toward EXITING by construction — no context, absent `directives`, or FLAT ⇒ the
  close executes unchanged — and `AGENTIC_VENUE_STOP`/`AGENTIC_VENUE_TP` are both `true`, so stop and
  take-profit rest at the venue meanwhile. **Confirm that live rather than trusting the spec**: at
  Pass 49's close, 6 `ACKED` protective orders rested across both venues, every one carrying a
  `venue_order_id`, and the first round trip under the flag (`KAITO/USDT:USDT`, entered 16:30:38Z)
  closed at **17:11:55Z by its declared `STOP_MARKET`**, not by a `close`.
  **Deadline: the next pass with ≥5 closed round trips under the flag resolves this explicitly.**
  Read § WATCH-PLAYBOOK-V10-1 before attributing anything it measures.

### WATCH-PLAYBOOK-V10-1 — `inverted` is live, and the divergence is the finding (2026-07-30, Pass 49)

> **AMENDMENT 2026-08-03 — clustering is now on BASE asset, and v10 is unaffected.** `clusterBootstrap`
> and `computeCell` keyed clusters on the raw symbol string, so 40 symbol strings counted as 40 units
> when they are only **28 distinct bases** (twelve bases trade on both venues, h=24 correlation
> 0.9993–0.9999) — `MIN_CLUSTERS=5` was satisfiable by **three** independent assets, the exact
> degeneracy its own comment claimed to prevent. Re-read after the fix: **no POWERED cell flips.** v10
> itself is **byte-identical** (clusters=6, same mean, same four CIs) — its 17 entries carry no
> same-base cross-venue pair. v1/v2 stay powered (13→10, 11→9 clusters); v9 drops 5→4 but was already
> underpowered on n=6. So this is a **forward guarantee, not a retroactive correction**, and nothing in
> this WATCH's recorded history moves. `research/studies/cluster-degeneracy-2026-08-03.md`.

  **WATCH-PLAYBOOK-V10-1 (replay-predicted vs live-realised entry return).** `agentic_playbook_info`
  reads `version="10"` since the 16:57:19Z boot: the `inverted` arm's prose, minted
  `source='loop-candidate'` `parent_version=8` and promoted the same minute. **It is a RESEARCH-BAR
  FAIL deployed on DEPLOYMENT-BAR grounds** — see `verdicts.md`; nothing here licenses an edge claim.
  **Expected-positive:** live-realised entry forward return under v10 lands materially above
  `champion_v8`'s replayed `−12.7 / −36.3 / −32.7 / −70.1 bps` at h=1/4/8/24, in the direction the
  replay predicted (`inverted` `−0.8 / +0.8 / +19.3 / +47.6`, deltas `+11.9 / +37.1 / +52.0 / +117.7`).
  **Named defect outcome — and it is deliberately symmetric:** a **divergence in EITHER direction
  between replay-predicted and live-realised entry return is a FINDING to report**, not noise to
  explain away. Live materially WORSE than the replay is the adverse-selection hypothesis confirming —
  the recorded entries were maker-side at **76% fill**, and offline replay structurally cannot measure
  whether the faded side of a print was available at the same terms. Live materially BETTER than the
  replay is equally a finding, about the replay rather than about the strategy. **Report it whichever
  way it points; do not quietly attribute either outcome to noise.**
  **Do NOT quote +47.6 as an edge** under any live result: the arm fails the research bar on interval
  width (h=24 CI lo **−12.2**, h=8 **+1.1**, both under +13.0), and it is in-sample on one 6.35-day
  regime, 2026-07-21 → 27.
  **Attribution rail, binding:** `AGENTIC_PLAN_AUTHORITATIVE_EXITS` went live on the same boot, six
  minutes after the promotion. Their EVIDENCE is separable — this WATCH measures entry forward return,
  which does not depend on how a position is exited; WATCH-PLAN-AUTHORITY-1 measures exit behaviour
  GIVEN entries, which does not depend on which bar was chosen. **Their realised-PnL contributions are
  NOT separable, and no pass may claim either change moved the book on its own.**
  Deadline: first pass with ≥12 entries attributable to `playbook_version=10` (this loop's own
  "never act on a sub-n≥12 cell" bar).

  > **FIRST POWERED READING — Pass 59, 2026-08-03 — and the expected-positive above is UNADJUDICABLE
  > AS WRITTEN. Do not re-derive this; the defect is in the comparator, not the sample.** The deadline
  > fired (n=21, clusters=8, `flat_only` identical — all 21 entries are from FLAT, gap=0 at every
  > horizon). But the clause sets a **live** cell against a **replay** cell, so its difference
  > confounds four axes at once, none of which decomposes: v10-vs-v8, live-vs-replay, two **disjoint**
  > windows (replay 07-21→27, 6.35 d, basket **−438.4 bps**; live 07-30→08-03, 3.66 d, basket
  > **−70.5 bps**), and venue mix (replay drew on 139 spot corpus rows; live is **21 of 21
  > binanceusdm perp, zero spot** — itself confounded with v10 via the spot-suppression finding). It
  > is not even v8-against-v8: the `−36.3` is the champion arm's **70 replayed** entries, a different
  > set from v8's **8 live** ones.
  >
  > **The framing is load-bearing — the verdict flips three ways on defensible baselines:** vs v8
  > *replay* (as written) v10 is worse at h=1/4/8, better at h=24; vs v8 *live* (same instrument, same
  > price source) v10 is **BETTER at h=4 (+52.0) and h=8 (+16.2)** — the two horizons the sweep flags
  > as its failures; market-neutralised, v10 is worse at all four. **Verdict: NOT-COMPARABLE at every
  > horizon.** More v10 data cannot fix it.
  >
  > **What IS established, and it is not nothing.** (a) Against **v10's own** replay prediction — the
  > one comparison free of the live-vs-replay axis — the interval excludes the prediction at h=4
  > (delta −46.1) and h=8 (−72.1): **`inverted` did not reproduce out of sample at 2 of 4 horizons**,
  > exactly the failure `verdicts.md` guardrail 2 pre-registered. It is **consistent at h=1 and at
  > h=24 — and h=24 was the parent study's DECLARED PRIMARY horizon**, so the headline is narrower
  > than "the arm failed". (b) Market-neutral (each entry's signed return minus `dir ×` the
  > equal-weight drift of all 40 series at the same bar/horizon): h=4 **−48.6** CI [−123.8, −1.7],
  > h=8 **−65.0** CI [−148.5, −10.1], n=21/k=8 — **powered, excludes zero.** v10's entries are worse
  > than the market it traded. Beta *helped* v10, so this is the honest adverse reading.
  >
  > **The adverse-selection sentence three lines above is FALSE for this metric.** `ENTRY_SQL` selects
  > `agent_decisions` rows (decisions, filled or not) and `forwardBps` anchors on the decision bar's
  > close, marking out on the same close-convention grid at both ends — **no fill price, no fee, no
  > fill/no-fill filter, construction identical to replay's `fwdBps`.** Replay's inability to see fills
  > cannot move a statistic that ignores fills on both sides; the sentence was written about
  > *realised PnL* and does not transfer. The real instrument is the filled-vs-unfilled split on these
  > same 21 rows (16 filled / 5 not, 76.2%): FILLED h=4 **−68.1**, NOFILL **+27.5**, a +95.6 bps gap in
  > exactly the adverse-selection direction — but **NOFILL is n=5/k=3 and may NOT be quoted as
  > evidence** under this program's own power bar. Suggestive, not established; it reaches n≥12 around
  > 2026-08-09.
  >
  > **ROLLBACK REFUSED, on mechanism as much as evidence.** `AGENTIC_PLAYBOOK_PIN=8` is not a
  > rollback: with `active=8`, `selectCandidate`'s `version > 8` filter **re-arms v9 AND v10 as A/B
  > candidates**; both clear `THOMPSON_MIN_TRIPS`, so it would **activate Thompson sampling for the
  > first time in this program's history** (priors so wide the draw is near a coin flip); and a freshly
  > minted v12 has 0 trips, so it would be ineligible and never routed — **silently cancelling the
  > owner's daily-minting override** by a second mechanism its own record forbids. `verdicts.md`
  > guardrail 5 also binds: revert to the next-least-bad arm, **never to `champion_v8` by default**.
  > The knob needs a restart (`current()` caches once per process) and took the bot down on
  > 2026-07-06. Evidence for preferring v8 rests on an **n=8/k=5** cell that fails the power bar, and
  > the window confound runs *against* v10 (v8 made money into a −240.3 bps headwind while 76%-short
  > v10 had a −70.5 bps tailwind). **Restate the expected-positive against the live-vs-live v8 cell the
  > tool already computes** (`REPLAY_REFERENCE.incumbent` is loaded and never rendered) before any
  > future pass tries to adjudicate this again.
  >
  > **AMENDMENT 2026-08-04 — THE CLAUSE, RESTATED. Nothing above is re-adjudicated; the FIRED-POWERED
  > reading stands as written.** This appends the replacement clause the block itself demanded, in two
  > tiers, and is honest that **only the second tier can ever be adjudicated**. Live cells re-read
  > `pnpm loop:forward-return` 2026-08-04 against the same Postgres instance; v10's four cells are
  > unchanged from the Pass-59 sweep, which is itself the check that this restatement is not resting on
  > a moved number.
  >
  > **The live v8 cell, printed for the first time.** `REPLAY_REFERENCE.incumbent` is a *replay* row and
  > is not what this restatement uses — the live v8 panel the tool already renders is:
  >
  > | version | population | n | clusters | h=1 | h=4 | h=8 | h=24 | power |
  > | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  > | 8 (`champion_v8`) | `all` = `flat_only` | 8 | 5 | −2.1 | −97.3 | −69.0 | +20.2 | **UNDERPOWERED (n=8<12), no interval** |
  > | 10 (`inverted`) | `all` = `flat_only` | 21 | 8 | −26.4 | −45.3 | −52.8 | −11.0 | **POWERED** |
  > | delta (v10 − v8) | — | — | — | −24.3 | **+52.0** | **+16.2** | −31.2 | inherits v8's UNDERPOWERED label |
  >
  > v10's intervals: h=1 [−82.4, +10.2], h=4 [−122.0, −0.3], h=8 [−134.9, −1.5], h=24 [−90.5, +50.5].
  > v8 has none and never will (below).
  >
  > **TIER 1 — DIRECTIONAL ONLY, AND CAPPED UNDERPOWERED FOREVER.** Restated clause: *live-realised
  > entry forward return under v10 lands above the same metric under v8, measured on the same
  > instrument, the same price source and the same close convention.* On today's read v10 is better at
  > h=4 (+52.0) and h=8 (+16.2) and worse at h=1 (−24.3) and h=24 (−31.2). **None of that is evidence
  > and none of it ever will be.** v10 is the deployed champion, so `selectCandidate` routes no new
  > entries to v8: its **n=8 is terminal, not merely current**, and no amount of waiting moves it past
  > `MIN_ENTRIES=12`. A clause whose comparator can never reach the power bar is a clause that can
  > never be adjudicated — recording that plainly is the point of this tier, not a defect in it. The
  > two cells also sit in **disjoint windows** (v8's 8 entries precede the 2026-07-30T16:57Z boot,
  > v10's 21 follow it), which the recorded −240.3 vs −70.5 bps basket figures already price.
  >
  > **What `research/studies/passive-benchmark-truth-2026-08-04.md` does and does not move here.** It does
  > **not** move −240.3 / −70.5: those are entry-window drift terms over the 40 live series, a
  > different object from that study's buy-and-hold basket over the promotion evidence window. It
  > **does** establish, on both windows it measured, that a **40-symbol-string** equal-weight basket
  > reads more negative than a **28-base-asset** one (by 0.42 pp and 0.29 pp), because the twelve
  > dual-listed majors fell while the spot-only alt tail rose. The market-neutral adjustment in the
  > block above is symbol-weighted over 40 series, while this loop's own `MIN_CLUSTERS` doctrine makes
  > the base asset the unit. **Direction of that unit error, argued not measured:** market-neutral bps
  > is `signed − dir × drift`, so for a 76%-short arm a more-negative drift reads *worse*. Re-cutting
  > the drift on bases could therefore only **soften** "v10 is worse at all four", never strengthen it.
  > **NOT MEASURED on the entry-window drift** — recorded as an open unit question, and the reason the
  > market-neutral cell below is quoted as recorded rather than re-derived.
  >
  > **TIER 2 — THE ADJUDICABLE PRIMARY, and it is already powered.** Three readings, in the order a
  > future pass should take them:
  >
  > 1. **Market-neutral v10 versus zero** — h=4 **−48.6** CI [−123.8, −1.7], h=8 **−65.0** CI
  >    [−148.5, −10.1], n=21/k=8, **POWERED, excludes zero**. Carried verbatim from the FIRED-POWERED
  >    record above, *not* re-derived — that block forbids re-derivation and this amendment obeys it.
  > 2. **Raw live v10 versus zero** — re-read 2026-08-04 and unchanged: h=4 **−45.3** CI [−122.0, −0.3]
  >    and h=8 **−52.8** CI [−134.9, −1.5] are POWERED and both exclude zero; **h=1 and h=24 do not**
  >    (their intervals straddle zero) and may not be quoted as adverse. This comparator has no
  >    live-vs-replay axis, no v8 axis and no window axis — it is v10 against nothing, which is the only
  >    comparison in this whole block that is free of a confound.
  > 3. **The filled-vs-unfilled split on the same 21 rows** (16 filled / 5 not, 76.2%) — FILLED h=4
  >    **−68.1**, NOFILL **+27.5**, a +95.6 bps gap in the adverse-selection direction. **NOFILL is
  >    n=5/k=3: `RECORDED, NOT EVIDENCE`, and its point estimate is not quotable.** It re-reads when
  >    NOFILL reaches n≥12, projected **~2026-08-09**. This is the real adverse-selection instrument;
  >    the sentence in the original expected-positive is FALSE for the headline metric and stays so.
  >
  > **Named defect outcomes for the restated clause, symmetric as before:** tier-2 reading 2 losing
  > power at h=4 or h=8 on a later read (entries can be revised out by a grid gap, so a shrinking n is
  > a finding about the grid, not about v10); tier-2 reading 3 arriving at n≥12 with the gap **closed**,
  > which would refute adverse selection rather than confirm it and must be reported that way; or tier-2
  > readings 1 and 2 disagreeing in sign, which would make the drift term — not the entries — the
  > finding. **Deadline: the pass after NOFILL reaches n≥12 (~2026-08-09) resolves tier 2 explicitly.**
  > Tier 1 carries **no deadline** by construction and must never be given one.

**Amendment 2026-08-10 (Pass 66) — tier 2 is SUPERSEDED by accrual, and the NOFILL re-read is
blocked on the UNFILLED cell rather than on the total.**

1. **Tier 2's "excludes zero at h=4/h=8" no longer reproduces.** Fresh `pnpm loop:forward-return` at
   **2026-08-10T08:53Z**, v10 `flat_only`: h=4 **POWERED −9.3 bps n=55 k=10 CI [−32.1, +15.7]**;
   h=8 **POWERED −20.8 bps n=54 k=10 CI [−45.1, +3.9]**; h=1 −7.6 [−19.5, +6.9]; h=24 −15.5
   [−44.6, +29.2]. **Every horizon's interval now includes zero.** On n=21 the same two cells read
   −45.3 [−122.0, −0.3] and −52.8 [−134.9, −1.5]. **The adverse reading did not survive 2.6× the
   population — do not re-quote the 2026-08-04 amendment's intervals.** The honest statement is that
   v10's forward edge is **indistinguishable from zero**, not that it is good: the point estimate is
   negative at all four horizons. Full table, and the resolution that the n=21/k=8 vs n=26/k=9
   discrepancy is **accrual, not filters**: `studies/redesign-scoreboard-2026-08-04.md`
   § Checkpoint #1.
2. **The replay divergence is UNCHANGED and still fires** — h=8 live −20.8 vs replay +19.3, h=24
   live −15.5 vs replay +47.6, both intervals excluding the prediction. Replay keeps predicting an
   edge the live lane does not realise.
3. **The NOFILL n≥12 re-read (due ~2026-08-09) was taken, and it is blocked on the unfilled cell.**
   Joining v10 entry decisions to `order_intents` on `symbol` + `source_based_on_seq`, and intents to
   `fills` on `intent_id`: **55 v10 entry decisions, 55 produced an intent, 45 filled, 10
   intent-with-no-fill.** The total clears n≥12; **the unfilled cell is n=10 and is UNDERPOWERED**, so
   the filled-vs-unfilled forward-return split — the only instrument that can show adverse selection
   — **cannot be scored yet**. At the observed accrual (~5 v10 entries/day, ~18% unfilled) the
   unfilled cell reaches n=12 around **2026-08-12**. Re-read then; the binding constraint is the
   unfilled count, and saying "n=55, powered" here would be wrong.
4. **Instrument gap, named rather than worked around.** `computeForwardReturn` carries no fill-status
   partition, so even at n≥12 the split needs the core extended to expose `filled`/`unfilled`
   alongside `all`/`flat_only`. Seam recorded; not built this pass.

### WATCH-V4-10 — an orphaned perp algo stop resting against a flat book (2026-07-30, Pass 49)

  **CLOSED 2026-07-31 — the breach was real, the recorded root cause was WRONG, and the fix is
  elsewhere. Read this block before the original text below it.**

  **Venue truth** (keyed `demo-fapi` read via `fapiPrivateGetAllAlgoOrders` by `clientAlgoId` — the
  same endpoint and args `CcxtExchangeAdapter.fetchAlgoOrderStatus` uses):
  `cbt019fb31cb7c97ea0a8dfa5462d3d3764` / algoId `1000000150396877`, `HYPE/USDT:USDT`,
  `BUY STOP_MARKET` 1.49 @ trigger 54.574, `reduceOnly`. **`algoStatus REJECTED`,
  `rejectReason "Reduce only reject"`, `triggerTime 2026-07-30T16:04:39.939Z`, `actualOrderId ""`**
  — no spawned order, no fill — and absent from `fetchOpenAlgoOrders`. So it was never resting,
  never filled and never cancelled: it **fired 4m08s after its position went flat, was refused, and
  died venue-side.** There is no live stray order and it cannot re-fire. The current −1.44 short is
  separately protected by `cbt019fb79e51…`, verified `algoStatus NEW`.

  **The breach is confirmed.** ACKed 2026-07-30T13:00:32.760Z for the −1.49 short; position FLAT at
  2026-07-30T16:00:31.969Z; the local row stayed `ACKED` with `terminal_at NULL` and only two events
  ever (`SUBMIT_SENT`, `ACK`) for ~21.5h across four boots, ~10.5h of it against a flat book. Every
  other HYPE stop got `CANCELED` cleanly.

  **NOT caused by the `boot-recovery.service.ts` `openOrders` exclusion** — that hypothesis was
  recorded here and is refuted. Reconciliation axis 1 is regular-rail **by construction**: its venue
  source is `fetchOpenOrders`, which never returns algo orders. And `fetchOrder` on an algo
  clientOrderId throws `BadRequest -1102`, so registering algo orders into that set would have sent
  `adoptTerminal` down a path that fails every 30s — permanent `adopt_query_failure` noise, forever,
  and still no terminal fold. The algo rail already has its own boot reconciliation
  (`AlgoStopRecoveryService`, wired at `trading-runtime.module.ts:642`).

  **Actual root cause:** `mapAlgoHistoryStatus` (`ccxt-normalize.ts`) had no `REJECTED` case, so it
  fell to `default: return 'UNKNOWN'` — and `UNKNOWN` is the one status `recoverIntent` deliberately
  never folds (fail-open, retry next sweep). A rejected-on-trigger stop was therefore **un-retirable
  by any pass on any boot**, which is exactly the recorded symptom reached by a different mechanism.

  **Fix:** `REJECTED` is now its own `AlgoOrderHistoryView` member and folds terminal via
  `VENUE_EXPIRED` — not `REJECT`, which the reducer accepts only from `SUBMITTING`/`SUBMIT_UNKNOWN`,
  so a `REJECT` fold from `ACKED` would throw `TransitionError` and re-strand the order. Appended
  `order_events` row under dedupe namespace `algo-hist:REJECTED:{algoId}`; hard rule 6 intact.
  **Failure direction, split deliberately because this is the money path:** no `spawnedOrderId` ⇒ the
  venue provably created no order, so no fill can be lost ⇒ fold terminal (fails CLOSED on the
  strand); `spawnedOrderId` present ⇒ quantity may have executed, so route to the TRIGGERED path
  which ingests only what `fetchMyTrades` positively proves and returns `'unknown'` otherwise. A
  possibly-lost fill is never traded for a tidier book. The live row self-heals on the next boot
  sweep — no DB surgery.

  **Two residual strands of the same class, recorded rather than fixed:** the algo-history query is
  bounded by `startTime = intent.createdAt` and venue retention, so a stop whose history row ages
  out reverts to `UNKNOWN`-forever; and `AlgoStopRecoveryService.sweep` is boot-only, so between
  boots the only route in is the bar-level `onAlgoStopGone` hook.

  ---

  **WATCH-V4-10 (orphaned perp algo stop).** Observed while verifying WATCH-PLAN-AUTHORITY-1, not
  looked for. `HYPE/USDT:USDT` `BUY STOP_MARKET`, submitted 2026-07-30T13:00:31Z as protection for a
  SHORT that closed at **16:00:31Z**, was still `ACKED` at 17:13Z — **73+ minutes and two boots after
  the position it protected went flat.**
  **Bounded, and say so before anyone panics:** the resting perp stop is `reduceOnly` by construction
  (`agentic.strategy.ts:2086`), so triggering it against a flat book reduces nothing rather than
  opening an unintended long. This is untidy, not dangerous.
  **The one code path that can produce it, stated as a candidate and NOT as a diagnosis:**
  `cancelPerpAlgoStopIfResting` (`agentic.strategy.ts:2096-2101`) returns silently when its `entry`
  snapshot is `undefined`. That snapshot is read from `planStopRegistry` BEFORE `clearPlan()`, so a
  plan already cleared leaves nothing to read and the cancel becomes a no-op **with no counter
  incremented**. `agentic_venue_stop_total{event="orphan_cancel"}` reads 0 on this boot, which is
  consistent with BOTH "never needed" and "silently skipped" — the same void-read shape Passes
  44/47/48 have now fixed at six other sites. **Mechanism NOT established.** This pass observed the
  state and the path; it did not prove the path is what happened.
  **Expected-positive:** no perp algo stop remains `ACKED` more than one 15m bar after its position
  goes flat. **Named defect outcome:** a second orphan appears ⇒ the silent-return branch is the
  suspect and the first thing to build is a counter that distinguishes "no cancel needed" from
  "cancel skipped because the registry row was gone" — do not patch the cancel before the read exists,
  because a fix on an unreadable path is unverifiable. Deadline: next pass re-checks
  `select symbol, type, state from orders where state = 'ACKED'` against the live position set.

  **RE-CHECKED 2026-07-30T21:51Z — the record is still stranded, and THE DEADLINE QUERY ABOVE IS A
  VOID READ.** Two questions were being run together and they separate cleanly.

  **1. The local record is unchanged, and it is worse than recorded.**
  `cbt019fb31cb7c97ea0a8dfa5462d3d3764` (venue order `1000000150396877`), `binanceusdm`
  `HYPE/USDT:USDT` `BUY` `STOP_MARKET`, qty 1.49, trigger 53.254, still `ACKED` with `terminal_at`
  NULL and `updated_at` frozen at 2026-07-30T13:00:32.760Z. The short it protected closed at
  **16:00:39.991Z** (`cbt019fb3c15b877621a1bf9b70162d067c`, `BUY LIMIT` FILLED), and `positions`
  carries **no HYPE row** — the perp book holds only `BTC/USDT:USDT` +0.0018. So: **8h51m after
  submission, 5h51m orphaned, and FOUR boots have started since its own** (`181b2965`, `923ed595`,
  `b894ce22`, `f30074f2`, per `reconciliations.boot_id` windows) — not the two recorded above.

  **2. Whether it is still RESTING AT THE VENUE is unanswerable from anything this system records,
  and `state = 'ACKED'` is not evidence either way.** `boot-recovery.service.ts:97-101` deliberately
  does **not** register algo-rail orders into `portfolio.openOrders`, and reconciliation's open-orders
  axis iterates exactly that set to decide what to adopt terminal
  (`reconciliation.service.ts:723,743-748`). **After any boot, no reconciliation pass can fold a perp
  algo stop terminal, whatever the venue says** — so `ACKED` is the expected local reading whether the
  order rests or not.

  **Corroborated in the pass counts.** `binanceusdm` `open_orders_checked` reads **1** on every pass
  while the local book holds **4** non-terminal `binanceusdm` orders — and exactly **1 of the 4 is
  regular-rail** (the 17:30:05Z `BTC/USDT:USDT SELL LIMIT`); the other three are `STOP_MARKET` on the
  algo rail, which `fetchOpenOrders` does not surface. On spot `binance` the two counts agree exactly
  (3 non-terminal, `open_orders_checked` 3). **"1 binanceusdm open order" therefore carries zero
  information about the HYPE stop**, and any reading of it as "the stop is still resting" is
  unsupported.

  **Directly demonstrated this boot.** `agentic_venue_stop_total{event="drift_cancel",
  venue="binanceusdm"}` reads **1** and `{event="placed"}` reads **1** on boot `f30074f2`, while **no
  `binanceusdm` `STOP_MARKET` record reached a terminal state on this boot at all**. A venue-side algo
  cancel and the local terminal fold are decoupled here, measured, not argued.

  **3. Counter-evidence against the tempting general claim, kept because it constrains the
  diagnosis.** Cross-boot perp stops are **not** universally stranded: at 16:52:15Z / 16:52:26Z /
  16:52:29Z, on boot `181b2965`, three previous-boot stops were `CANCELED` and folded terminal
  (`BTC/USDT:USDT` submitted 10:45:27Z, `UNI/USDT:USDT` 11:00:32Z, `UNI/USDT:USDT` 11:45:33Z). A
  cross-boot cancel-and-fold path exists and ran that minute; it reached neither the HYPE stop nor the
  `BTC/USDT:USDT` stop submitted 11:45:33Z, which is **also still `ACKED`**. **Mechanism still NOT
  established** — this pass narrowed where to look and proved what the old read cannot tell you; it
  did not prove a cause. `agentic_venue_stop_total{event="orphan_cancel"}` is still **0** on both
  venues, the same void read as before.

  **The named defect outcome has NOT fired on its own terms.** The second stranded record
  (`BTC/USDT:USDT`, 11:45:33Z) sits against an **open** position and was plausibly superseded by the
  19:00:09Z stop, so it is a superseded-duplicate shape rather than a second orphan against a flat
  book. Recorded as adjacent, not counted as the trigger.

  **Re-derived deadline check, because the old one cannot answer its own question.** Replace
  `select symbol, type, state from orders where state = 'ACKED'` with: **the count of non-terminal
  `STOP_MARKET` records whose symbol has no `positions` row, cross-checked against
  `fetchOpenAlgoOrders` for those symbols.** The second half does not exist as a scheduled read today
  — `manageVenueStopPerp` runs the algo-rail scan only for POSITIONED symbols, and a flat symbol is
  exactly the case in question. **So the first thing to build is still a READ, not a fix**, and the
  read now has two jobs rather than one: distinguish "no cancel needed" from "cancel skipped", and
  distinguish "resting at the venue" from "gone at the venue, stranded in our book".

  **ROOT-CAUSED 2026-07-31 (Pass 50, `59df4c9` + `a2d7d33`) — and the Pass 49 suspect is REFUTED.**
  The "undefined `entry` read after `clearPlan()`" hypothesis is dead: both live call sites snapshot
  `stopEntry` BEFORE `clearPlan()`. The actual finding is that `reconcileOrphanedAlgoStop` **did**
  reach its `fetchOpenAlgoOrders` call for HYPE on every bar — every guard between `decide()` and it
  is satisfied (`planMode` set, `activePlan` null, venue stop enabled, perp venue, no registry entry,
  position FLAT) — but its no-plan branch emitted NOTHING on any of its four outcomes, so "never
  matched" and "matched, and `cancelAlgoOrder` threw into a bare `catch {}`" were indistinguishable
  by construction. Branch (b)'s cancel has demonstrably never succeeded for this order: the boot
  sweep folded two sibling perp stops terminal at 16:52Z via `algo-hist:CANCELED:{algoId}` and never
  folded this one.

  Second mechanism, same rail: the `binanceusdm BTC/USDT:USDT` stop from 19:00:09Z **was** cancelled
  at the venue at 22:45Z by `drift_cancel`, and is still non-terminal locally because **no algo-rail
  cancel was ever journaled on any path**. So one rail carried both a cancel that never happens and a
  cancel that happens and is never recorded.

  **Escalated from untidy to money-path:** a stale non-terminal algo order keeps its intent in
  `inFlightIntents` (`boot-recovery.service.ts:122-128`) and `driveFlattening` marks that symbol BUSY
  off exactly that set (`halt-coordinator.service.ts:153`), so `allFlat` never becomes true for it —
  **a HALT cannot complete for that symbol until the next boot**. `cancelRestingAlgoStops` was itself
  the fifth un-journaled cancel, making the HALT path both producer and victim.

  **This WATCH stays OPEN.** The fix is prevention and measurement, not a heal: the four already
  stranded rows will NOT terminalize, because their cancels predate the seam. Closure requires the
  venue-truth read this entry has demanded since Pass 49.

### WATCH-V4-11 — the algo rail can now say which failure it is having (2026-07-31, Pass 50)

  Source: the Pass 50 record in `LOG.md`, commits `59df4c9` (strategy sites) and `a2d7d33` (HALT
  path). This is the instrument WATCH-V4-10 was missing; V4-10 stays open on the venue-truth read.

  **Expected-positive:** on a boot that has run at least one flat perp bar,
  `agentic_venue_stop_total{event="orphan_scan"}` reads **> 0** — proving the no-active-plan
  reconcile path executes at all — and every algo-rail cancel that resolves is followed by an
  `algo-hist:CANCELED:{algoId}` row in `order_events` for that order, so a cancelled stop reaches a
  terminal local state instead of resting `ACKED` across boots. All 15 `VenueStopEvent` labels remain
  zero-pre-seeded on both venues (30 children), so an absent child is a bug, not a zero.

  **The discrimination this exists to provide, stated so it is read correctly:**
  `orphan_scan` > 0 with `orphan_cancel` **and** `orphan_cancel_failed` both 0 means the scan runs
  and never matches the stranded order — the venue is not returning it, or the id does not resolve.
  `orphan_cancel_failed` > 0 means it matches and the cancel throws. Before this pass both readings
  were the same zero.

  **Named defect outcome:** `orphan_scan` still reading **0** on a boot older than a few bars with a
  flat perp symbol in the menu — that would mean a guard short-circuits before the scan and the Pass
  50 proof chain is wrong. Also a defect: an `orphan_cancel` increment with no corresponding
  `order_events` append for that order, which would mean the journal seam is being swallowed rather
  than firing.

  **Deadline:** the next pass reads these counters on the post-`3f215aa` boot and records which of
  the two V4-10 failures is live. That reading is the input to V4-10's closure.

  **Failure direction, declared:** every counter and the journal call are a measurement/cleanup seam
  and FAIL OPEN — all five call sites are `void`, never awaited, because the fold performs venue reads
  against no configured ccxt timeout and previously sat inline between a stop cancel and the exit
  signal built from it, and inside a reconcile path on a 2s non-LLM budget whose overrun drops the bar
  and trips auto-DRAIN. A test pins that a rejecting seam still emits the EXIT signal, so a
  reintroduced `await` fails loudly.

### WATCH-V4-12 — a truncated consult is no longer filed as a schema rejection (2026-07-31, Pass 50)

  Source: the Pass 50 record in `LOG.md`, commits `daf8dbe` (production) and `f9ed0ea` (replay
  harness parity).

  **Expected-positive:** `agent_decisions` rows whose degrade is an output-budget truncation carry
  `truncated_max_tokens:` rather than `schema_rejected:`, on BOTH the single and batch paths and on
  both the empty-tool-input and no-tool-block branches. The measurable signature is that a row
  tagged `truncated_max_tokens:` carries `output_tokens` equal to `AGENTIC_MAX_TOKENS` (4096); the
  baseline is **10 of 37** such rejections over the 14 days to 2026-07-31.

  **Why it is worth watching rather than just fixing:** each truncation degrades a whole batch to
  hold, so the rate is a direct read on how much decide capacity the 4096-token output budget is
  costing. If the rate is materially above the 10/37 baseline once it is separately countable, the
  lever is the output budget or the thinking configuration — not the schema.

  **Named defect outcome:** `truncated_max_tokens:` rows appearing with `output_tokens` well below
  4096 (the tag is being applied to something that is not a truncation), or the combined
  `schema_rejected:` + `truncated_max_tokens:` rate rising above its pre-change level (the re-tag was
  supposed to reclassify, not to add).

  **Known bucket move, declared rather than discovered later:** re-tagged rows move from
  `agent_decide_total{outcome="hold"}` to `{outcome="truncated"}` via `outcomeForProposal`. Both tags
  sit in `PROVES_CALL_COMPLETED_OUTCOMES` and neither in `LATCHED_DECIDE_OUTCOMES`, so the latch
  gauges are unmoved, and the boundary is pinned by the `schema_rejected: → 'hold'` case added to
  `agent-decide-outcome-tags.spec.ts`. **A reader comparing hold volume across the 2026-07-31 deploy
  boundary must expect a step, and it is this.**

  **Failure direction:** FAILS OPEN — an absent or unreadable `stop_reason` falls back to the old
  tag, and the degrade itself (soft hold, empty signals, metric) is byte-identical on every branch.

  **FIRST READING — 2026-07-31, Pass 53. Expected-positive CONFIRMED on every measurable row; the
  named defect outcome did NOT occur.** Measured on boot `93e21a99` (since 12:33:12Z) and over 14 days:

  | tag | rows (boot) | `output_tokens` (boot) | rows (14d) | at exactly 4096 (14d) |
  | --- | --- | --- | --- | --- |
  | `truncated_max_tokens:` | 7 | min = max = **4096** | 11 | 7 |
  | `schema_rejected:` | 8 | 168 – **358** | 137 | 12 |

  Every `truncated_max_tokens:` row carrying a usage number carries exactly 4096 — 7 of 7 on this
  boot, 7 of 7 measurable over 14 days. **Zero rows sit "well below 4096", so the named defect outcome
  is not present.** The tags discriminate cleanly: this boot's `schema_rejected:` rows top out at 358
  output tokens, an order of magnitude off the ceiling.

  **Disclosed rather than counted as a pass:** the remaining **4** of the 11 `truncated_max_tokens:`
  rows carry `output_tokens` NULL (usage is recorded on the first symbol of a batch only), so the
  signature is *unreadable* on them, not contradicted. The 12 `schema_rejected:` rows at 4096 across
  14 days are pre-change rows — the population the re-tag was built to reclassify — and are the reason
  the 14-day figures must not be read as a post-change rate.

  **What the reading COSTS, which is the part worth acting on.** Truncation is not free capacity: the
  5 truncating consults on this boot each ran 27.6–32.1s and spent the full 4096 output tokens, while
  an 8-symbol consult that succeeded spent 1150 tokens in 13.3s — so batch width does not explain it.
  Each truncation degrades a whole batch to hold. **Do NOT respond by raising `AGENTIC_MAX_TOKENS`**:
  that fix was refuted on review (see `LOG.md` § Pass 53) because the binding constraint is the $3/day
  USD breaker, not the token/day cap, and because the batch HTTP budget is 75s against a projected
  ~83–91s at a 12288 ceiling — an abort THROWS rather than soft-holding, and three strikes auto-DRAIN
  the lane. The in-contract lever is `output_config: {effort: …}`, which appears nowhere in
  `anthropic-agent-client.ts` today, so the lane runs at the API default and pays for thinking depth
  it may not need.

**Amendment 2026-08-10 (Pass 66) — the registered primary is FALSIFIED with exact counts, and this
watch's own "all pinned at exactly 4096" line is falsified alongside it.**

L1 (`AGENTIC_OUTPUT_EFFORT=medium`) went live **2026-08-04T08:00:23Z** — confirmed to the second from
the prompt-hash partition, which switches to `aefafb3c…` at `2026-08-04T08:00:23.693878Z` (567 rows
through 2026-08-10T08:45Z). Cross-tab over `agent_decisions`, non-replay, by UTC day, of the
`truncated_max_tokens:` prefix against `output_tokens = 4096`:

| UTC day | prefix ∧ 4096 | prefix, NOT 4096 | 4096, no prefix | priced decides |
| --- | --- | --- | --- | --- |
| 2026-07-31 | 8 | 4 | 2 | 194 |
| 2026-08-01 | 7 | 2 | 0 | 157 |
| 2026-08-02 | 2 | 1 | 0 | 157 |
| 2026-08-03 | 12 | 7 | 0 | 155 |
| 2026-08-04 *(straddles the enable)* | 5 | 8 | 0 | 124 |
| 2026-08-05 *(feed-wedge day)* | 4 | 13 | 0 | 79 |
| 2026-08-06 *(feed-wedge day)* | 3 | 2 | 0 | 67 |
| 2026-08-07 | 1 | 0 | 0 | 103 |
| 2026-08-08 | 2 | 0 | 0 | 114 |
| 2026-08-09 | 4 | 5 | 0 | 106 |

- **The registered expected-positive — "zero rows … over the first TWO FULL UTC days after the
  enable" (08-05, 08-06) — is FALSIFIED: 4 and 3.** This confirms with counts what Pass 65 recorded
  from a single observation.
- **The 4096-pinned rate did fall, and not by enough to mean anything.** 17/508 = **3.35%** of
  priced decides over 07-31→08-02, against 7/323 = **2.17%** over the three CLEAN post-enable days
  08-07→08-09 — a ~35% relative reduction on 17 vs 7 rows. **Not distinguishable from noise at this
  count, and not the registered zero.**
- **NEW, and it invalidates how this watch has been counted since it opened: "all pinned at exactly
  4096" is FALSE.** Prefix-carrying rows that are NOT at 4096 exist in both eras — **14 of 43 (33%)**
  over 07-31→08-03 and **31 of 53 (58%)** over 08-04→08-10. A truncation stamp below the token
  ceiling is a **different event** from the one this watch was written to count, and the two have
  been aggregated together throughout. Every prior count under this watch inherits that.
- **L1's named defect 2 (latency) does NOT fire.** p95 **30,556 ms** post-enable (n=567) against
  **29,009 ms** pre (n=841); max 67,251 ms; **zero rows ≥ 75 s and zero ≥ 90 s**.

**Why this cannot be adjudicated further today, and exactly what closes it.** Whether `effort` is
honoured for this model at all is unanswerable from these columns: a request-parameter effect and a
payload-size effect produce an identical row. `stop_reason` is journalled from this pass
(`agent_decisions.stop_reason`, migration `0003`). **Registered read: the `max_tokens` share of
`stop_reason` on the `+eff-medium` prompt-hash partition over 7 days of post-deploy rows.
Unchanged-or-higher ⇒ `effort` is not transmitting ⇒ unset `AGENTIC_OUTPUT_EFFORT`. Deadline
2026-08-17.** **The default outcome on a silent, empty or unreadable instrument is the unset, not the
status quo** — a lever that does not transmit is rolled back, never left set in the hope that it did
something.

### WATCH-V4-13 — spot rests one protective leg, and the zero that looks like proof is not (2026-07-31, Pass 51)

  Source: the Pass 51 record in `LOG.md`, commit `f5abf8a`.

  **What shipped.** On spot, both protective legs sized to 100% of the position and `reduceOnly` is
  dropped on spot, so a resting `'vtp'` and a resting `'vsl'` competed for the same free base and the
  loser terminal-rejected. Measured over the 7 days to 2026-07-31: binance spot **156 submits, 122
  `InsufficientFunds`** (78%), against binanceusdm **135 submits, 3 rejects**. All 122 were
  `reduce_only` SELLs on SOL/USDT, ZEC/USDT, AAVE/USDT. Spot now rests the TP only;
  `manageVenueStopSpot` stands down (`setVenueStopResting(key, false)`) instead of placing.

  **Expected-positive:** on the FIRST spot entry after `f5abf8a`,
  `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments,
  `{venue="binance",event="placed"}` stays **0**, and no `InsufficientFunds` appears in
  `order_events` for a spot `reduce_only` SELL.

  **Named defect outcome:** a `binance` `placed` increment (the stand-down is not on the live path),
  OR a spot `InsufficientFunds` on a `reduce_only` SELL (something else still places a second leg),
  OR a `'vsl'` resting on `binance` that stops being scanned — that last one would mean the
  manage-only path was bypassed and the WATCH-V4-10 stranding class has been re-created on spot.

  **READ THIS BEFORE QUOTING THE COUNTER: a zero is not evidence here.** `InsufficientFunds` since
  the 09:27:23Z deploy is 0 — and it was ALSO 0 for the six hours BEFORE the deploy, against 32 in
  the prior 24h. The last spot position closed at 01:54Z, so no spot leg of either role is being
  placed and the contention cannot recur either way. Under §C.9 the post-deploy zero is a **VOID
  NEGATIVE READ**. The positive control this WATCH requires is an actual spot entry; until one
  exists the change is verified by tests and review only, never by production.

  **Failure direction, declared:** FAILS OPEN — when nothing rests, stand down and place nothing,
  keeping the bar-close software stop armed. This is deliberately the opposite of the naive reading:
  the placement was guaranteed to be rejected, so a false belief that a venue stop rests is the
  hazard, not the absence of one. The compensating control is pinned by a test (spot plan-stop
  breach still fires `EXIT_LONG` with no resting order).

  **Reading taken 2026-07-31T11:23Z — STILL UNVERIFIABLE, and now quantified rather than argued.**
  The positive control has not occurred: **zero `binance` rows in `order_intents` since the
  09:27:23Z boot.** All three intents on this boot are `binanceusdm` (one reduce-only LIMIT BUY, two
  reduce-only STOP_MARKET); the newest `binance` intent is 2026-07-31T01:45:02Z, *before* the
  deploy. So no spot leg of either role has been attempted and the contention cannot recur either
  way — the post-deploy `InsufficientFunds` zero remains a VOID NEGATIVE READ, exactly as this
  WATCH predicted.
  The counters themselves are healthy, which is what makes the zero readable at all: every
  `agentic_venue_stop_total{venue="binance",...}` child is present and reads `0` — including
  `stood_down` **and** `placed` — because the recorder zero-seeds its closed label set at
  construction. These are REAL zeros, not absent series. `agentic_venue_tp_total{venue="binance"}`
  is likewise all-zero while `binanceusdm` shows `placed=1`, `skipped_existing=17`, confirming the
  metric path is live and only spot is quiet.
  **The WATCH stays OPEN.** It resolves on the first spot entry, not on a date. Note the counters
  reset on every redeploy, so a pass reading them after a restart must re-establish that a spot
  entry occurred *on that boot* before treating any value as evidence.

  **Why the retry loop stopped BEFORE the fix deployed — asked and answered, so it is not left as a
  mystery.** The new `venue_reject_rate_high` alarm (below) observed that binance spot's submits
  ended 2026-07-31T01:45Z, roughly 7.7h before the `f5abf8a` deploy at 09:27Z, and flagged that
  something other than the fix ended it. It did — and the cause is mundane. All 16 rejects in that
  window were `reduce_only SELL ZEC/USDT`, retrying every 30 minutes against a position that dusted
  out: `positions` now reads binance ZEC/USDT **0.000736** (~$0.35), AAVE **0.000649**, BTC
  **0.00000755**, SOL **0.000476** — every one below `minNotional`. With no position to protect, no
  protective leg is placed, so the loop ended for lack of a subject rather than for lack of the
  defect. **This does NOT credit the fix and does not weaken the void read above** — it removes an
  apparent anomaly, nothing more. The fix is still unverified and still needs a real spot entry.

  **The rationale that was REFUTED on review, recorded so it is not re-invented.** The choice was
  first argued on "a spot `STOP_LOSS_LIMIT` can trigger into a thin book and fail to fill". False:
  all four spot stops that ever reached their trigger filled at or inside it, zero partials, within
  1.3bps (ZEC, BTC, SOL, AAVE, 2026-07-25 → 07-31). The 78% was also misattributed to the stop leg
  alone — it is the COMBINED rate; per role it was vtp 86.6% (97/112) and vsl 58.5% (24/41), and both
  are artifacts of the contention itself, so neither predicts the post-fix rate.

  **Known residual, deliberately accepted.** The bar-close software stop lives inside `runActivePlan`
  and is gated on an in-memory `activePlan` that dies with the process, whereas the venue order it
  replaces survived restarts and LLM outages. A restart DURING an LLM latch therefore drops spot
  downside coverage to `PROTECT_STOP_LOSS_PCT`. That combination is real on this stack (a 60-hour
  latch ended 2026-07-30) and is the strongest argument for the inverted choice (rest the stop, let
  the TP be software). Revisit if a restart-during-latch is ever observed with an open spot position.

  **Deadline:** the next pass that sees a spot entry reads the three counters above and records the
  outcome. Until then this WATCH is OPEN and UNVERIFIED, not passing.

### WATCH-V4-14 — a terminal venue reject burst is now audible between passes (2026-07-31, Pass 53)

  Source: the Pass 53 record in `LOG.md`, commit for `VenueTerminalRejectBurst`; full forensics in
  `research/loop/incidents/2026-07-31-perp-exit-band-rejects.md`.

  **What happened.** 12 reduce-only KAITO/USDT:USDT exits were terminal-rejected `-4024` in five
  minutes and every continuously-running surface read healthy — `protective_exits_total` counts FIRES
  not FILLS (it read 12), and no rule in `alerts.rules.yml` referenced `orders_rejected_total`. Only
  the sweep's per-venue rate alarm caught it, ~3h later.

  **Expected-positive:** the next terminal-reject burst of ≥3 in 15m appears as a
  `prometheus_alert_firing_nonblocking` annotation naming `VenueTerminalRejectBurst` with its `code`
  label, in the FIRST sweep after the burst — and the sweep's own `venue_reject_rate_high` alarm and
  this rule agree about whether a burst happened.

  **Named defect outcome:** (a) the rule fires on the binance spot `InsufficientFunds` bleed (measured
  2/hour, so it must NOT — that would mean the threshold is mis-derived and the rule is noise); (b) a
  reject burst occurs and the rule stays silent (`stage="exchange"` is not the label the venue path
  actually writes, or `for: 5m` outlives the burst — a 12-reject burst spanning 5m sits right at that
  boundary and is the specific thing to check on the first real firing); (c) it lands as an ALARM
  rather than an annotation, which would mean the severity was changed to `critical` and the loop's
  own §3 gate is now wedgeable by a self-resolving condition.

  **Failure direction:** FAILS OPEN — measurement only. It cannot block an order, a fill, or an exit.

  **Deadline:** the first pass that observes any terminal venue reject reads all three surfaces (this
  rule, the sweep's rate alarm, `orders_rejected_total`) and records whether they agree. If no reject
  of any kind occurs by 2026-08-07, the rule is UNTESTED and must be recorded as such — an unfired
  alert is not a passing one.

### WATCH-V4-15 — a sampling race and a real orphan no longer look the same (2026-08-01, Pass 56)

**Source:** `research/loop/incidents/2026-08-01-spurious-unknown-ours-halt.md`; shipped `62f9738`.

**What changed.** The open-orders axis halted the whole book whenever a venue-open order carrying our
prefix was absent from the in-memory open-order map. That map is read ONCE, after a per-symbol `await`
loop, so an order the strategy cancelled mid-sweep read as a divergence. On 2026-07-31 that halted
trading over an order already terminal at the venue 27.3 s earlier. There is now a second tier — order
book, then a venue-scoped durable read — and a new `stale_venue_open` class that does not halt, but
DOES escalate per-coid: streak keyed `venue|coid`, reset when the coid leaves that venue's open list,
halt past `driftPasses`.

**Expected-positive.** `stale_venue_open` appears on an ordinary in-sweep cancel and does NOT halt,
while a coid still venue-open across more than `driftPasses` consecutive passes DOES halt, with its id
present in `reconciliations.detail` (the pre-fix halt recorded no id at all, which is why the incident
had to be reconstructed from `order_events` and container logs).

**Named defect outcomes — any one is a finding:**

1. **It never fires at all.** Every case resolves at the book tier, so the durable arm is dead code in
   production and the incident it was written for is not the shape that actually occurs. The durable
   tier is reachable in principle only after a restart, when the book no longer holds the record — if
   months pass with zero durable-tier resolutions, say so rather than assuming coverage.
2. **It fires and never clears.** The streak reset is not matching coids (key shape, venue prefix, or a
   coid that changes representation between the venue read and the map), so a benign race walks toward
   a halt. This is the failure that turns the fix into a slower version of the bug.
3. **A genuine orphan escalates but the halt string still lacks the id** — the discriminator was lost
   again somewhere between `acc.halts` and the `reconciliations.detail` column.

**It is deliberately ACTIONABLE**, i.e. absent from `NON_ACTIONABLE_CLASSES`. A stuck
`stale_venue_open` therefore starves the clean stamp and blocks kill-switch auto-resume. **That is the
intended fail direction, not a defect** — an unresolved venue/local disagreement must not be able to
hand back a permit. Do not "fix" it by making the class non-actionable; that reintroduces exactly the
silent-mask this WATCH exists to detect.

**Deadline.** If nothing has fired by **2026-08-15**, record it as UNTESTED rather than passing — an
unfired alert is not a passing one. The alert-side change (`ReconciliationMismatch` now excludes this
class) means a firing will be visible in the sweep's annotations, not as a page.

### WATCH-V4-18 — a re-armed plan carries the model's own geometry, not a synthetic pair (2026-08-04, Pass 63)

**Source:** open defect #149; shipped `44792d9`. `rearmExitGeometry` / `rearmStopTrigger` invert
`venueTpPrice`/`venueStopPrice` against `avgEntry` to recover the pcts the ALREADY-RESTING venue orders
encode, validated against `DECISION_V2_BOUNDS` (`agent-prompt.ts:274`) — the model's own tool-schema
range, deliberately not a second hand-picked pair of constants.

**Expected-positive.** On any restart re-arm over an open position that still has protective orders
resting, the re-arm warn line reports `stop=<pct> [resting-stop]` and/or `tp=<pct> [resting-tp]` — NOT
`[synthetic]` — and the re-armed `takeProfitPct` stops being exactly `0.02` on every such symbol.

**Named defect outcomes — any one is a finding:**

1. **Every re-arm still reports `[synthetic]`** despite orders resting ⇒ the lookup is not finding them.
   On PERP the trigger comes only from the `planStopRegistry` row, whose sole seeder with no active plan
   is `reconcileOrphanedAlgoStop`'s re-adopt — so this most likely means the re-adopt is not running, not
   that the derivation is wrong.
2. **A derived pct lands inside `DECISION_V2_BOUNDS` but outside the model's observed 0.012–0.04 band**
   ⇒ a stale or foreign resting order was adopted. This is the KNOWN, ACCEPTED residual: the failure mode
   is a premature exit, never an unbounded loss (a wrong-side order yields a negative pct and is
   rejected), and it still beats a synthetic 5%/2% the model never authored. If it recurs, tighten the TP
   bound from the schema range to the observed band.
3. **Drift-cancel churn does NOT fall after this deploy** ⇒ the "#149 manufactures #148" mechanism is
   wrong and the drift has another cause. Do not re-assert the causal claim without this signal.

**Deadline.** First restart carrying an open position. If none by **2026-08-08**, record UNTESTED — an
unexercised path is not a passing one.

### WATCH-V4-19 — a drift/qty cancel no longer leaves a position bare for a bar (2026-08-04, Pass 63)

**Source:** open defect #148 (live 2026-08-04T08:30:35–08:44Z: HYPE/BTC/UNI, $195.59 of a $434 perp book,
`PLAN_STOP_WATCH_ENABLED=false` so the 1s watcher backstop was off); shipped `44792d9`.

**Expected-positive.** No positioned symbol crosses a bar boundary with no protective stop resting.
`agentic_venue_tp_total{event="placed"}` and `agentic_venue_stop_total{event="placed"}` increment in the
SAME bar as each `drift_cancel` — the `'placed'` emission on the TP replace path was itself a must-fix
this pass, without which ~36% of TP placements were invisible on the only counter evidencing that rail.

**Named defect outcomes — any one is a finding:**

1. **`drift_cancel` without a same-bar placement.** On the TP leg this is EXPECTED whenever the
   `sideCollateral` guard fires (another order rests on the exit side, so the compound would clear a leg
   the position still needs and the deferred path deliberately stands). **Measure how often that guard
   fires** — if it is the common case rather than the exception, the fix does not cover the live scenario
   it was written for.
2. **Duplicate resting orders** ⇒ in-flight suppression (`venueTpPlacedAtBar` / `venueStopPlacedAtBar`)
   is insufficient for the compound path, which reaches placement one call earlier than before.
3. **`InsufficientFunds` on a spot leg** ⇒ the side-scoped, role-less `cancelBeforeSubmit` cleared a leg
   the other needed. That is exactly what the `sideCollateral` guard exists to prevent, so any occurrence
   means the guard's condition is wrong, not that the compound is unusable.

**Deadline. 2026-08-08.** Note this cannot be exercised on the binance spot lane, which has had zero
submits since 2026-07-31 — a spot-side zero is starvation, not health (the WATCH-V4-13 trap).

### WATCH-V4-16 — one `config_snapshots` row per config hash (2026-08-03, Pass 58)

**Body written Pass 63.** This WATCH and WATCH-V4-17 were created in Pass 58 as one-liners in
`STATUS.md`, whose header promises "full text in `watches.md`" — and neither body was ever written.
Pass 63 found both missing (zero occurrences of either id in this file) and wrote them from the
STATUS one-liners plus `LOG.md` § Pass 58. **The record asserted a property of itself it had never
established, which is the same class this loop keeps finding in the code.**

**What it guards.** `config_snapshots` HAS a writer, contrary to the Pass-58 alarm text that first
named it. The writer fails OPEN (a snapshot write failure must never block a boot); the sweep's W3
reader fails CLOSED. That asymmetry is deliberate and must survive any change here.

**Expected-positive.** Every boot leaves exactly ONE row per config hash; an unchanged redeploy BUMPS
`activated_at` on the existing row rather than inserting a second; the `config_snapshot_missing` alarm
stays cleared.

**First reading (Pass 58): GREEN** — 1 row, `dust 5`, `epoch 2026-07-21T11:21:00Z`, no `db` / `bootId`
/ `gitSha` fields.

**Named defect outcomes — any one is a finding:**

1. **Duplicate rows per hash** ⇒ the upsert is targeting the wrong conflict key.
2. **`activated_at` does NOT move on an unchanged redeploy** ⇒ `onConflictDoUpdate` is not firing.
3. **`config_snapshot_drift` fires** ⇒ either genuine drift, or the nested key walk mis-resolving
   (the sweep tries the flat env spelling, the flat camelCase spelling, and the nested canonical
   AppConfig location `agentic.promotionDustNotional` / `agentic.promotionEvidenceEpoch`).
4. **The `config_snapshot_missing` alarm RETURNS** ⇒ the fail-open writer is failing silently. Read
   the app log for `config snapshot write failed` — **do not rebuild the writer**; Pass 58 already
   established it exists.

### WATCH-V4-17 — an in-flight entry intent keeps its consult (2026-08-03, Pass 58)

**Body written Pass 63** — see WATCH-V4-16 above for why it was missing.

**What changed.** If the daily `recompute()` lands after an entry intent is submitted but before it
produces a position row or an open-order row, the symbol is unpinned; with
`AGENTIC_PORTFOLIO_CONSULT=true` every off-menu symbol then takes a hard `off_menu` hold. Pass 58
pinned that seam (`548376c` had closed the original gap). Protective exits were never at risk —
`ProtectiveExitService` runs on its own tick and `runActivePlan` precedes the consult gate — **the LLM
consult genuinely was.**

**Expected-positive.** No symbol carrying an in-flight entry intent is absent from
`agentic_active_menu` at a recompute.

**Named defect outcome.** An `off_menu` hold journalled for a symbol that has an in-flight intent —
i.e. the gap `548376c` closed has reappeared.

**Exposure window.** Up to a full UTC day, because `isPinned` is only evaluated inside `recompute()`.
That is why a single observation is weak evidence here: the failure is rare per bar and sticky per day.

**Status: UNFIRED** as of Pass 63.

### WATCH-V4-20 — a rejected portfolio batch stops costing every symbol in it (2026-08-05, Pass 64)

**Why.** Over the 7 days to 2026-08-05, **48 of 224 portfolio consults (21.4%) had their whole batch
discarded** on a top-level schema failure — every symbol held, the model's output paid for and thrown
away, ~$0.34/day. Shipped in `fbb3800`: salvage a string-encoded `decisions`, preserve a clamped
`nextConsultBars`, and split `empty_tool_input:` out of `schema_rejected:`.

**Expected-positive, four clauses.**

1. `agentic_schema_rejections_total{kind="batch_stringified_recovered"}` increments on the first
   cleanly-stringified payload, and those symbols journal real actions rather than a `schema_rejected` hold.
2. `empty_tool_input:` rows carry an empty payload AND a non-`max_tokens` stop; genuine truncations keep
   stamping `truncated_max_tokens:` with `output_tokens` 4096.
3. Every `nextConsultBars` stamped by a whole-batch discard is **≤ `AGENTIC_FALLBACK_CONSULT_BARS`** (8).
4. The sweep's `realDecides` count never counts a degraded row — guarded by `degrade-tag-mirrors.spec.ts`.

**Named defect outcomes.**

- `batch_stringified_recovered` stays 0 while `{kind="batch"}` keeps firing ⇒ the live shape is always
  malformed-inner JSON (as boot `e423875b`'s own case was, where `JSON.parse` correctly threw), and the
  salvage addresses a shape that does not actually occur — record it and stop claiming the recovery.
- `empty_tool_input:` never fires while `schema_rejected:` does ⇒ the empty-payload case was a one-off and
  the split bought diagnosability nobody needed.
- A stamped `nextConsultBars` above the fallback bars ⇒ the clamp is not wired at the live call site.
- `realDecides` jumping while decides are degraded ⇒ a mirror drifted again; the new spec should make this
  unreachable, so it firing means the guard itself is wrong.

**Baseline to read against** (boot `e423875b`, pre-fix): 1037 clean rows, 2 `truncated_max_tokens`, 1
`schema_rejected`, 0 `empty_tool_input` (the tag did not exist). Both new counter children zero-seed at
boot, so **a zero is a real absence, not a missing series**.

**Deadline: 2026-08-09.** At ~32 consults/day the 21.4% rate implies ~7 discards/day, so four days is
ample; a still-empty reading by then is itself the finding.

**Status: UNFIRED** — shipped and deployed `fbb3800` at 2026-08-05T01:11:05Z, boot `90dbb484`.

**Amendment 2026-08-10 (Pass 66) — read one day past deadline; TWO of the four named defects FIRE.**

Counters at **2026-08-10T09:02Z**, boot `815e01b8` (up since 2026-08-06T17:39:41Z — 3.64 days). Both
new children zero-seed at boot, so a zero here is a real absence, not a missing series:

```text
agentic_schema_rejections_total{kind="batch"}                       = 13
agentic_schema_rejections_total{kind="batch_stringified_recovered"} =  0
agentic_schema_rejections_total{kind="element"}                     = 23
agentic_schema_rejections_total{kind="single"}                      =  0
agentic_schema_rejections_total{kind="missing_symbol"}              =  2
```

- **Defect 1 FIRES, unambiguously.** `batch_stringified_recovered` is **0** while `{kind="batch"}`
  fired **13** times in 3.64 days. **The salvage addresses a shape that does not occur.** Per the
  clause's own instruction: recorded, and **the recovery is no longer claimed.**
- **Defect 2 FIRES.** **Zero** rows carry the `empty_tool_input:` prefix across the whole
  2026-08-04 → 2026-08-10 window (`agent_decisions`, non-replay, prefix split on `rationale`), while
  `schema_rejected:` fired **47** times over the same window. The split bought diagnosability nobody
  needed.
- **Defect 3 UNREAD** — no `nextConsultBars` read was taken this pass. It stays open with no
  deadline claim: **an unrun check is not a passing one.**
- **Defect 4 does not fire** — no `realDecides` drift observed; the guarding spec is green.

**And a reading the watch did not ask for.** Whole-batch discards continue at 13 / 3.64 d ≈
**3.6/day**, against the ~7/day the deadline paragraph projected from the 21.4% baseline. The rate
fell — **but not by the mechanism this fix shipped**, because the salvage recovered nothing. The
cause is unidentified and **is not creditable to `fbb3800`**. Untested candidate confounds: the
`strict:true` schema (predates the fix), the 2026-08-04 L1/L4 enables, and the liquidation + perp
trade-flow payload channels going live 2026-08-04. Note also that the 21.4% baseline used
`increase()` over a different window and a "consults" denominator; this read is a raw counter against
`consulted`=251 gate events, so the rate comparison is **indicative, not matched**. The defect that
fires does not depend on the denominator.

**Status: FIRED (defects 1 and 2). The fix is deployed, harmless, and did not do what it shipped to
do.**

## Flagged for human review (open)

> **This section is for defects that CANNOT be fixed without crossing the §4 MUST-NOT rails — owner
> capability limits only. It is not a defect queue.** Owner ruling 2026-07-27, verbatim: "do not
> defer defects … those must get fixed immediately if possible"; the daily loop is a profitability
> engine, not a bug tracker. Pass 40 initially parked four defects here citing the
> one-money-path-item-per-pass limit, was corrected, and fixed all four in the same pass. That limit
> governs chosen IMPROVEMENTS only and never licenses a deferral — now stated outright in playbook §4
> (§ DEFECTS ARE NEVER DEFERRED).

- **GO/NO-GO OWED: the ~$22 Family B paid edge run (2026-08-03).** The blocker recorded since
  2026-07-31 was **refuted** this pass. `corpusManifest`'s separator is a genuine **NUL byte**, not the
  space `corpus-fingerprint-drift-2026-07-31.md` typed into its own reimplementation; the real function
  over the real 386-row corpus reproduces the recorded `f1dd13c6…` design pin exactly. Measured four
  ways: NUL + file order = `f1dd13c6…` (= the pin), space + file order = `030367ba…` (= that study's
  claimed "on-disk" value), and the `(eventTime, id-numeric)` tie-break is a **no-op**. The study's
  whole § 2.6 reordering table is the same artifact. Verified free, no network: `loadDesign()` against
  the live corpus does **not** throw — `assertDesignMatchesCorpus` is not firing and never should have
  been. A 1-token preflight confirms the Anthropic account can spend.
  **What was NOT done, deliberately:** `pnpm eval:playbook-space`'s paid `it` block runs the corpus
  assertion, the preflight, and `runReplay` (~1,400 calls, up to ≈$21.91) as **one atomic function** —
  there is no way to probe "is the assertion still blocking" without committing the spend. Committing
  ~$22 as a side effect of a hash-bug fix is a consequential action, so it was surfaced rather than
  triggered, even though the budget was pre-authorised for this study.
  **What remains genuinely unverified:** transport rate, schema validity and faithfulness are only
  exercised by the real run. "Family B is unblocked" is therefore supported for its two most likely
  blockers (corpus mismatch, funding) and unproven for the rest.
  Record: `research/studies/corpus-fingerprint-drift-correction-2026-08-03.md`. **Transferable lesson:
  a reimplementation of a hash function is a second source of truth — import it, or do not compute it.**

- ~~**BOTH PROVIDER ACCOUNTS ARE UNFUNDED — the single blocker on the entire program (Passes 42/43,
  2026-07-28).**~~ **Struck 2026-07-30T09:01Z when funding returned — read the AMENDED block at the
  end of this item, which also carries the standing latch-cause guidance. Nothing below is deleted;
  the 2026-07-28 body stands as written.**
  Anthropic returns `400 invalid_request_error: "Your credit balance is too low"`
  (exhausted mid-run at 21:16Z on 07-27); Moonshot returns `429 suspended — insufficient balance`.
  Consequences: the champion cannot trade at all (the lane latches, correctly, and journals named
  `client_latched` degrades), AND the frozen playbook-space replay — the one study that could answer
  whether ANY playbook text clears the +13.0 bps bar — cannot run. Purchasing credit is a financial
  action, outside what an automated pass may do; this is a capability limit, not a policy gate.
  **On resumption nothing needs redeploying or re-deciding:** the lane self-heals within 30 min of
  credit landing (`FATAL_LATCH_COOLDOWN_MS`, and that is a tested property — see WATCH-V4-5), and the
  study's corpus, 12 arms, metric and bar are all committed and frozen.
  **Read alongside Pass 41's diagnosis before funding, because they interact:** entries are
  significantly negative and worse than a random-bar placebo, so resuming spends ~$2.6/day
  accumulating evidence for a gate the current entry signal provably cannot pass. Whether that is
  worth doing is a decision about what this project is FOR — surfaced by Pass 41, restated by 42, and
  now unavoidable rather than deferrable. The loop does not decide it and has not assumed either answer.
  **AMENDED 2026-07-30T09:01Z — FUNDING RETURNED AND THE PREDICTION HELD (Pass 48).** Credit landed
  between 07:45:18Z (Pass 48 confirmed the `400` still live at that timestamp) and 09:01Z, and **the
  lane self-healed with no redeploy**: first real decide 2026-07-30T09:01:01Z (45.6s, full thesis),
  first proposes 09:15:31Z (`open_long` ZEC spot + perp), 597 lifetime real decides at 11:04Z against
  575 before, 6 fills in 24h, `open_orders` 3 per venue. So the "on resumption nothing needs
  redeploying or re-deciding" clause above is now live-verified rather than inferred, and it closes the
  one WATCH-V4-5 clause that could not be tested without credit. **Only the Anthropic account was
  funded — the Moonshot fallback is untested since and is presumed still suspended.** Full record:
  `STATUS.md` § The LLM lane.
  **The item stays listed, struck rather than moved to the archive, because the condition recurs the
  moment the balance runs out again — and the response is then fixed: read the CAUSE, do not open an
  investigation.** `agent_client_latch_cause{cause="insufficient_credit"} == 1` means the balance is
  out again: an owner capability limit, not a defect, and no pass can fix it. `loop:sweep` prints a
  banner naming it ABOVE the alarms section, and `AgentClientLatchedUnfundedAccount` is severity
  `warning` on purpose so it annotates instead of wedging playbook §3. **The demotion is cause-specific
  and fails CLOSED:** any other cause classifies as `other`, keeps `AgentClientFatalLatch` at
  `critical`, and IS a full incident. Passes 42-47 each re-derived the blocker from scratch — that is
  the waste this exists to end (shipped Pass 48, `8002888`).
  **What funding does NOT settle:** the Pass 41 reading quoted directly above is unchanged — entries
  are significantly negative and worse than a random-bar placebo, so a live lane spends ~$2.6/day
  accumulating evidence for a gate the present entry signal provably cannot pass. That decision is
  still the owner's, and the loop still has not assumed either answer.

- ~~**OPEN DEFECT — WATCH-V4-6 (`QUERY_NOT_FOUND` terminalization, Pass 44, 2026-07-28)**~~ —
  **CLOSED 2026-07-30 (Pass 49), commit `83eae1f`.** It was flagged here as a *missing capability*
  rather than as a deferral, and the capability was built: `sweepStrandedNew`, zero reducer changes,
  four independent positive facts required before any terminalization. All four zombie orders reached
  `CANCELED` on the first tick after deploy with nothing run by hand. Full text and the live evidence
  moved with the WATCH to § Resolved WATCH lines below, so the WATCH and the defect still cannot drift
  apart. Struck rather than deleted, per this section's convention.

- **TWO SCHEDULED PASSES RAN CONCURRENTLY IN ONE WORKING TREE (2026-07-28, Pass 42 + Pass 43;
  RECURRED live during Pass 44).** Pass 44 observed it from inside: commits `8a15ad0` (08:18:21Z) and
  `b5eee27` (08:23:03Z) landed on `main` from another session mid-pass. No damage — neither touched
  Pass 44's files, and both changed `test/eval`, which the production gate glob excludes — but it is
  now three recorded occurrences. **Loop-side mitigation SHIPPED (`6369c0b`): `pnpm loop:lock` /
  `pnpm loop:unlock <nonce>`, playbook §1 step 3 and §6 step 4.** Honest limits, because the guard
  must not be trusted past its evidence: it is a 120-min time lease (not a liveness check — a pass is
  a session, not a watchable process), and **it only binds passes that CALL it**, which is exactly why
  it did not prevent the Pass 44 collision. A refusal is evidence of overlap; a clean acquire is not
  proof of its absence. **The scheduler config that lets two passes co-fire remains owner-owned and
  open.**
  Original occurrence (Pass 42/43): both sessions edited the same files; one committed the other's
  in-flight work twice (`ee4ddf3`, `7fa5ba8`) and caught the test count moving 3009 → 3011
  mid-verification because writes were still landing. No work was lost, but nothing structural
  prevented it — a concurrent pass can land a half-finished tree inside another's gate run, and the
  resulting failure would be attributed to the wrong cause.
  Standing procedure for any pass that sees this: assess damage before trusting a gate result — which
  files the foreign commits touched, whether they intersect this pass's own, and whether they fall
  inside the production gate glob. Pass 44 did exactly that and could then stand behind its 3054-test
  run; a pass that skips it cannot.

- **SHARED-ORG RATE-LIMIT — RECURRING; owner action requested (Pass 35, 2026-07-20; first
  recorded X9 same day).** The trading app and interactive/orchestration sessions share ONE
  Anthropic org budget; heavy fleet windows 429 the app's consults. Recurrences beyond the
  recorded 11:00Z incident: perp 12:30:27Z ×4 + 14:15:39Z ×1, spot 15:15:30Z ×8 — every burst
  inside an owner-session orchestration window (RETRYABLE error decisions in agent_decisions;
  app self-heals next bar). Harmless at 0 entries; once trading resumes each burst is a missed
  decision on live bars. Structural fix is owner-side: **a dedicated Anthropic key/org for the
  trading app** (secrets = §4 MUST-NOT for the loop). Interim: scheduled passes run fleet-free
  during trading hours (Pass 35 did); heavy orchestration ideally avoids active-menu bar
  boundaries. Also still open at the owner: the CryptoPanic key (X4 sentiment enable).

- **AVAILABILITY (Pass 17, 2026-07-12; updated Pass 23; REGRESSED Pass 25):** the stack runs on the
  owner's MacBook; host sleep throttles everything (worst measured: 8%/24h duty cycle; the SOL trail
  fired 10h late → gap loss). Pass 23 read **100%/24h for two consecutive days**, but **Pass 25
  observed a fresh ~6h host-sleep gap mid-pass (~01:00–07:20Z 07-15)** — the app cycled several short
  boots and the loop pass itself stalled ~6h between commit and deploy. The 100%/24h improvement did
  NOT hold. Standing ask unchanged and now re-evidenced: keep the Mac awake on AC + auto-login (or
  move the stack to an always-on host; compose is portable, §5 backups cover the DB). Residual
  dependency: Docker Desktop "start at sign-in" (restart policy `e4542fb` only acts once the daemon
  is up).

- **6.9-LINK wallet scar (~$55):** historical unapplied recovered-order fill (pre-`b00c886`),
  journaled+deduped so no walk sees it post-epoch; venue-side manual sell is optional wallet
  hygiene only.

## Resolved WATCH lines — closed, kept, not deleted

### WATCH-V4-6 — an order reaching `NEW` via `QUERY_NOT_FOUND` can never become terminal (RESOLVED Pass 49, 2026-07-30)

Moved here from § Open WATCH lines by Pass 49, byte-identical **except two emphasis delimiters**:
the `_"NEW is resubmit-eligible…"_` quote is now asterisk-delimited. MD049 runs at markdownlint's
default `consistent` mode (it is not configured in `.markdownlint-cli2.jsonc`), so the FIRST emphasis
in a file fixes that file's expected style — and moving this block down the file changed which one
that was. Wording unchanged; only the two markers.

This one is simultaneously an open WATCH and an open flagged defect; the full § Flagged entry is
here rather than duplicated below.

- **OPEN DEFECT — WATCH-V4-6: AN ORDER THAT REACHES `NEW` VIA `QUERY_NOT_FOUND` CAN NEVER BECOME
  TERMINAL (Pass 44, 2026-07-28).** Four orders have sat non-terminal since 2026-07-24, each with the
  identical event chain and nothing after it: `SUBMIT_SENT → SUBMIT_AMBIGUOUS → QUERY_NOT_FOUND`
  (`ZEC/USDT:USDT`, `SOL/USDT:USDT`, `KAITO/USDT:USDT`, `NEAR/USDT:USDT`).
  Root cause, read from code not inferred: `SUBMIT_UNKNOWN + QUERY_NOT_FOUND → NEW` is deliberate
  ("resubmit-eligible, same clientOrderId (TTL live)", `reducer.ts:194-195`) and its TTL-lapsed
  sibling `QUERY_NOT_FOUND_EXPIRED → CANCELED` exists — but the TTL is evaluated **only at query
  time** (`unknown-resolver.service.ts:310-315`), ~7s after submit, when it is obviously still live.
  The resolver then drops the order from `pending` with the comment *"NEW is resubmit-eligible;
  resubmit orchestration is a follow-up"*. That follow-up was never built, so nothing re-queries the
  order, nothing expires it, and nothing resubmits it.
  **Live impact today is nil, and that is measured:** `open_orders{venue}`=0 both venues,
  `in_flight_intents`=0, `venue_capital_headroom_usdt{binanceusdm}`=500 (full, so no phantom reserve),
  `reconciliation_mismatch_total` has no series across the whole 4 days these rows have existed, and
  the clean stamp is fresh. The portfolio view correctly excludes never-ACKed orders.
  **Why Pass 44 did not fix it:** the repair is the missing capability the code itself names — TTL
  re-examination plus a venue re-query before terminalizing (never blind; hard rule 5). That is new
  OMS money-path orchestration, not a line change. `NEW + CANCEL_REQUESTED → CANCELED` ("never sent,
  local-only", `reducer.ts:153`) is already the right terminal transition, so no reducer change is
  needed — the missing piece is the sweep that decides when to emit it.
  **Expected-positive:** the count of orders in a non-terminal state with no in-flight intent stays at
  these 4 and does not grow. **Named defect outcome:** it grows ⇒ the ambiguous-submit path is
  producing zombies at a rate that will eventually meet a book-wide non-terminal scan, which is
  exactly the shape that starved the clean stamp twice in Pass 40 (`adopt_non_adoptable`). Check
  `sum(fills.qty)` vs `orders.cum_qty` for non-terminal orders first, as WATCH-V4-1 already says.

  **RESOLVED — Pass 49, 2026-07-30, commit `83eae1f`.** The expected-positive held for six days
  (the count never grew past 4) and the missing capability was built rather than the symptom patched.
  `sweepStrandedNew` mirrors the shipped `reconcileFrozen` pass — same tick, same 60s per-order
  rate limit, same fold — with **ZERO reducer changes**: the terminal is the already-audited
  `NEW + CANCEL_REQUESTED → CANCELED` transition, written as an appended `order_events` row with
  reason `STRANDED_NEW_NEVER_LANDED`. Nothing cancels, adopts or flattens at the venue; no signature
  was widened; the reconciliation HALT path is untouched.
  **Fails CLOSED, and the four positive facts are the point.** An order wrongly terminalized in an
  append-only journal is unrecoverable and would silently orphan a position, while one left at `NEW`
  is untidy only — it is not `isUnresolved`, so it blocks neither live arming nor auto-resume.
  Terminalization therefore requires four independent facts, each able to veto alone: no
  `venueOrderId` ever recorded; the DURABLE fill journal sums to zero (not the in-memory cum); a
  durable intent whose TTL has lapsed AND a 5-minute age floor anchored on `intent.createdAt`
  (the TTL alone is a strategy-tunable knob); and a FRESH `fetchOrder` still throwing a definitive
  not-found, since the original `QUERY_NOT_FOUND` is days stale. A re-query resolving with ANY
  status — including open — refuses, because that contradiction belongs to `UNKNOWN_OURS_OPEN`.
  **Verified live against the DB, not the metric.** All four terminalized on the first tick after the
  16:51:44Z deploy with nothing run by hand: `ZEC/USDT:USDT` at 16:52:47Z, `SOL/USDT:USDT`,
  `KAITO/USDT:USDT` and `NEAR/USDT:USDT` at 16:52:49Z — every one `CANCELED`, `cum_qty` 0,
  `venue_order_id` NULL, **zero `fills` rows**. `order_events` carries exactly four
  `CANCEL_REQUESTED` rows with payload
  `{"type":"CANCEL_REQUESTED","reason":"STRANDED_NEW_NEVER_LANDED"}`, each appended as the 4th event
  after the unchanged `SUBMIT_SENT → SUBMIT_AMBIGUOUS → QUERY_NOT_FOUND` chain of 2026-07-24.
  Nothing was rewritten. Book-wide there are now **zero** non-terminal orders lacking a
  `venue_order_id`.
  **The join that cost a wrong query, written down so it costs nobody else one:**
  `order_events.order_id` is the **intent UUID**, NOT the `client_order_id`. The `orders` row
  keys on both; `order_events` keys only on the intent id.
  **Never-filled was established by evidence, not assumed.** The open-orders-only caveat in hard rule
  5 is real for `fetchOpenOrders` and for placement-time dedupe, but the resolver queries
  `fetchOrder`, which does return closed orders — and the fix deliberately does not rest on that
  venue-retention semantics. The decisive corroboration is indirect: reconciliation axis 1 classifies
  any venue open order carrying our prefix with no local open row as `UNKNOWN_OURS_OPEN` and HALTs,
  and post-restart these four were not in the local open set, so six days of passes would have halted
  had any been resting. They never landed.

### WATCH-V4-5 — the latch is observable and self-healing (RESOLVED Pass 45, 2026-07-29)

  **WATCH-V4-5 (the latch is observable and self-healing).** Expected-positive, in three parts:
  `agent_client_latched` reads 0 whenever the lane is making calls and 1 within one scrape of a
  suppressed call, with `AgentClientFatalLatch` following it in both directions; ZERO
  `action='hold'`-with-empty-rationale rows ever appear again; and once a provider is funded the lane
  resumes within 30 min with NO redeploy. Named defect outcome: a latch that outlives its cooldown
  without a fresh `error_fatal` means the expiry path is not being reached — read `latchRationale`'s warn
  line (`latch expired … resuming calls`) before touching the state machine; and an
  `AgentClientFatalLatch` that will not clear after recovery means the gauge is being set from a stale
  outcome, which is a `recordDecide` bug, not an alert-tuning problem. **Status at hand-off: the
  NEGATIVE direction is live-verified (gauge 0, alert inactive, `health=ok`, 20/20 rules loaded on boot
  `464c608b`); the POSITIVE direction is UNPROVEN on this build** — the accounts are unfunded but bar
  counters reset on the 07:30Z redeploy, so the first consult attempt was up to 2h out. Deadline: the
  next pass confirms it from a sweep, and must not infer it from the unit tests.
  **RESOLVED — POSITIVE DIRECTION PROVEN (Pass 45, 2026-07-29).** No new mechanism was needed: boot
  `899d4a09` ran unbroken for 22h with no redeploy to reset the bar counters, so the fallback clock
  finally elapsed and the unfunded account drove the fatal path repeatedly. All three clauses confirmed
  from LIVE state, explicitly not from the unit tests: (1) `agent_client_latched`=1 while calls are
  suppressed, `AgentClientFatalLatch` inactive on the 07:30Z boot and firing since 10:45:25Z — both
  directions observed; (2) **ZERO `action='hold'`-with-empty-rationale rows since the fix deployed** —
  135 such rows exist but the newest is 2026-07-28T01:15:18Z, ~6h before `ee4ddf3` booted, and the same
  condition now produces 197 named `client_latched:` degrades at `action='error'` instead; (3) the latch
  expires and resumes with NO redeploy — 8 expiries on one boot at `RestartCount` 0. Only the
  funded-resumption clause ("resumes within 30 min of credit landing") stays untested, and it cannot be
  tested without credit; the load-bearing half — self-heal rather than wedge-until-recreate — is done.
  The starvation analysis Pass 44 wrote remains correct and still applies to any pass that deploys: a
  redeploy pushes the first fallback consult 2h out. It was simply not binding on a boot left alone.

### WATCH-V4-8 — a redeploy must not be able to erase a standing outage (RESOLVED Pass 47, 2026-07-29)

**WATCH-V4-8 (a redeploy must not be able to erase a standing outage).** Expected-positive: after any
redeploy, the pass can still tell within its 15-30 min soak whether the lane is actually calling the
model — not merely that `agent_client_latched` reads 0 on a boot too young to have tried. Named defect
outcome: a pass reports a clean lane inside the ~2h post-deploy window and the next pass finds the
latch alert firing again with no intervening change ⇒ the soak signed off on a dead lane, and the
signal needs to survive process restarts. **The fix shape is already proven twice in this repo:** seed
the gauge from the durable ledger at boot, exactly as `f2d74b6` did for the cost breaker (which handed
every redeploy a fresh full $3 until it read the token ledgers) and as
`reconciliation_last_success_timestamp_seconds` does for reconcile liveness. Concretely, an
`agent_last_success_timestamp_seconds` seeded at boot from `agent_decisions` would have read ~34h stale
throughout this pass, on every boot, with no dependence on whether the lane had tried yet. **NOT shipped
this pass** and the reason is specific, not a priority call: its fix touches
`src/features/common/observability/metrics.service.ts` and `observability/alerts.rules.yml`, both
rewritten ~50 min earlier by a concurrent unleased session (`af67acf`) whose own deploy soak was still
running — a rules-file edit additionally requires a Prometheus `--force-recreate`. Deadline: next pass
with an uncontended tree.
**RESOLVED — Pass 47, 2026-07-29, commit `446e1da`.** The tree was uncontended and the fix shipped as
specified: `agent_last_success_timestamp_seconds` is seeded at boot from `agent_decisions`, so it reads
the TRUE age on the first scrape of every boot. Confirmed from LIVE state, not from unit tests — on the
minutes-old boot `1d68a57c` the gauge read `2026-07-27T20:15:31.331Z`, **38.80h stale, in the same
scrape where `agent_client_latched` read 0**, and `AgenticNoSuccessfulDecideSustained` fired at
11:04:25Z on an 8-minute-old boot. Three design points worth keeping, each of which review changed:
(a) the success predicate is **structural** — `prompt_hash <> '' AND latency_ms IS NOT NULL AND
strategy_id NOT LIKE 'replay-%'`, two columns written together and only by code that already parsed a
response body — so scheduled skips, latched suppressions and thrown errors are excluded by the shape of
the write path rather than by a list of rationale strings someone has to remember; review narrowed it
further to exclude post-200 degrades, which is why the lifetime count reads 575 and not 660.
(b) **severity `warning`, deliberately**: `loop:sweep` promotes only `critical` to the blocking alarm and
§3 blocks improvement work until alarms clear, so a critical would wedge every future pass on a
condition no pass can fix — it lands as `prometheus_alert_firing_nonblocking` and sweep alarms stayed 0.
(c) **`for: 5m`, not the soak length** — the sweep reads only rules already in state `firing`, so a `for:`
equal to the playbook's 15-min MINIMUM soak would still be `pending` when the soak-ending sweep runs,
invisible on the very pass that shipped it. A firing after a long host sleep is the expected recurring
case, not an edge; suppressing it by gating on `process_start_time` would reintroduce exactly the
boot-scoped blindness this rule removes.

### WATCH-V3-2 — market-stream loop errors after the v3 soak defects (expected-positive CONFIRMED 2026-07-21)

**WATCH-V3-2:** expected-positive = loop-error rate ~0 and
  `market_stream_forced_reconnects_total` flat over ≥1h with journal every bar on both venues;
  defect outcome = waves persist past the first hour ⇒ the candle threshold was not the (only)
  initiator — reopen with a raw demo-ws probe before touching anything else. Owner-session soak
  wakeups own the check; resolution before the lift-readiness call.

Amended the same day after soak defect #2:

**WATCH-V3-2 (amended):** expected-positive = loop-error rate ~0 on BOTH venues over
  the next hour+, forced-reconnect counters flat, journal every bar; the original defect-outcome
  clause stands for any residual waves.

### WATCH-V3-3 — schema-degrade rate (defect outcome FIRED, then RESOLVED 2026-07-22)

  **WATCH-V3-3 (schema-degrade rate) — DEFECT OUTCOME FIRED + RESOLVED 2026-07-22.** The trigger
  was "≥2 more whole-payload events or a sustained >5% element rate ⇒ a root-cause pass on the
  tool-contract prompt/schema (and meter the degrade path)." Both conditions hit: the offline
  head-to-head measured a sustained ~31–38% propose-attempt schema-failure rate (both models),
  and the live sweep found 5 whole-payload + 41 element + 11 missing-symbol degrades since
  cutover. Root cause (both the root-cause pass AND the metering, as the trigger prescribed):
  the JSON tool schema advertised only `action` as required while zod's `requireTradeDirectives`
  demanded six open_* fields, four never stated required in model-facing text; thesis >300 chars
  rejected; `decisions` string-encoding accepted-then-dropped. FIX SHIPPED (gate green, 2712
  tests): prompt/tool hardening + the degrade path is now METERED
  (`agentic_schema_rejections_total{kind}` counter + `schema_rejected:` journal rationale — the
  "no metric/rationale marker" gap this WATCH named is closed). Historical prior: this was the
  same defect class as WATCH-X2-era degrade guidance. Deploy of the fix + a hardened-contract
  re-baseline is the remaining loop step (I commit + deploy — loop-domain per the 2026-07-22
  gate-override grant; the live-money flip is the only human gate).

### WATCH-DEPLOY-HALVES-1 — the halves clause is wired, not decorative (2026-07-31)

  Source: `research/studies/deployment-bar-halves-clause-2026-07-31.md`; clause recorded in
  `verdicts.md` § Standing verdicts, TWO BARS → DEPLOYMENT bar.

  **Why a WATCH at all.** The clause reports `UNDETERMINED` whenever any of the four half-means is
  non-finite, and `UNDETERMINED` fails OPEN. A clause that is *always* undetermined therefore looks
  identical, in every shipped artifact, to a clause that is working and never triggering. Nothing
  else would surface that.

  **Expected-positive:** the first authoring run under the amended bar reports a `halvesVerdict` for
  the candidate at h=24, and `halvesSplitAtMs` is present, non-null, and **the same value for every
  arm in the run**.

  **Named defect outcomes, either of which means the guard is measuring nothing:**

  1. every candidate returns `UNDETERMINED` — the plumbing is decorative and the third conjunct
     never binds;
  2. `halvesSplitAtMs` differs per arm — the split is not shared, so the two arms' halves cover
     different calendar windows and the clause has silently reverted to the index-split semantics
     the record exists to prevent.

  **Known-and-accepted, not a defect:** the frozen recorded-incumbent path (the 2026-07-28 artifact)
  cannot carry time-split fields — that leg never computed them — so any comparison against it reads
  `UNDETERMINED` by construction. Do NOT "fix" that by substituting the artifact's index-split
  `firstHalf`/`secondHalf`; they arrive at runtime, the parsed type does not declare them, and the
  substitution would turn UNDETERMINED into a green pass. It is structurally blocked and pinned by a
  test.

  **Resolution:** the pass following the first non-dry `pnpm loop:authoring` run. Until such a run
  exists the sample is zero, and **no pass may report this WATCH as holding** — an unrun check is not
  a passing one.

## Open defects #147–#152 (found Pass 62, evidenced, NOT shipped)

STATUS.md carries the one-line facts and points here. Full evidence, queries and proposed fixes:
`LOG.md` § Pass 62. The reverted 576-line exit-path diff is quarantined at
`scratchpad/exit-path-quarantine/exit-path-incomplete.patch`.

**#147 LIVE — four orphaned reduce-only STOP_MARKETs from 2026-07-31, still `state='ACKED'`,
`terminal_at IS NULL`.** Two on `UNI/USDT:USDT` qty 13 at trigger **4.177** while UNI is LONG 15 @
avg_entry 3.888 with its own take-profit resting at 3.966 — a rally to 4.177 (**+7.4%, above its own
TP, i.e. a WINNING move**) fires 26 units of reduce-only market SELL against a 15-unit long. Two on
`KAITO/USDT:USDT` qty 35.2, and KAITO has **no position row at all**. Mechanism:
`reconcileOrphanedAlgoStop` early-returns when a plan is active (UNI has one) and `break`s after the
first `vsl` match, so a second orphan on the same symbol is structurally unreachable;
`AlgoStopRecoveryService.sweep` is boot-only. **NOT self-correcting** — the reconciler's open-orders
axis reads `fetchOpenOrders`, which never sees the perp algo/conditional rail (its own counter reports
`open_orders_checked=4`, exactly the four non-algo LIMIT orders).
Named fix: run the sweep every managed bar, collect ALL `vsl`-role orders, match on algoId, and
cancel only what is positively identified as not-the-current-plan's — on ambiguity LEAVE IT, because
cancelling a stop the position still needs is strictly worse than a stale one resting.

**#148 LIVE (bounded, recurring) — a take-profit drift-cancel strands the position with no venue stop
until the next bar.** `manageVenueTp`'s drift branch emits a bare cancel and defers re-placement.
Observed 2026-08-04T08:30:35–08:44Z: HYPE, BTC and UNI — **$195.59 of a $434 perp book, 45%** — held
no protective stop for ~15 minutes, with `PLAN_STOP_WATCH_ENABLED=false` so the 1s watcher backstop
is off. **It self-healed at the 08:45 bar** (verified 08:59Z: all six positions carry stop + TP), so
this is a recurring bounded window, not an outage — but it recurs on the first managed bar after every
restart, and there have been 37 boots since the epoch. Named fix: replace-before-cancel in the same
signal batch (the `cancelBeforeSubmit` primitive already exists on the exit path).

**#149 LIVE — every restart replaces the model's declared exit geometry with a synthetic 5% stop /
2% take-profit it never authored**, a 2.5:1 adverse risk/reward. `ActivePlanState` is in-memory; the
re-arm fallback hardcodes `barsElapsed: 0`, `maxHoldBars: 96`. ETH and SOL are on that geometry now —
their resting orders sit at exactly 1.05000 and 0.98000 of avg entry, and the model's own take-profit
distribution over 166 plans is 0.012–0.04, concentrated at 0.02/0.025/0.03/0.035. With 96 bars = 24h
against a ~9h restart cadence the declared time-stop can never mature: only **3 of 43** closed trips
ever exited via `max_hold`, and those cost −$2.62 — the LEAST damaging non-TP path, so "max_hold is
bleeding the book" is refuted; the defect is the inverse. This also MANUFACTURES #148: the resting TP
was priced off the model's 0.035, the re-armed plan wants 0.02, so the correctly-priced order is
cancelled as "drifted". Named fix (minimal): derive `barsElapsed` from the open position's actual
entry time, and re-derive the pcts from the resting venue orders' own prices — the same
"re-adopt off the venue's own price" rule `reconcileOrphanedAlgoStop` already applies.

**#150–#152 promotion-gate MEASUREMENT defects.** The gate's thresholds, `MIN_WINDOW_DAYS`, the four
live gates and the arming interlock are OUT OF SCOPE and untouched; how the gate MEASURES is in scope.
(150) `llmCostUsd` — the gate's largest cost term — still has **no `asOfMs`/watermark bound** after
`4ef4153`, which fixed re-derivability only for the **37× smaller** funding term; an uncapped read is
unreproducible by construction. (151) `netPnlUsd` sums LLM cost over a **different interval** than
`windowDays` measures, so **25.2% of the published cost falls outside the published window**.
(152) `BELOW_PASSIVE_BENCHMARK` is currently firing on a **REFUSAL (`CANNOT_COMPUTE`)**, not on a
comparison, and no published series distinguishes the two. The other six published gauges
**reproduce BYTE-EXACTLY** from raw fills/orders/agent_decisions/llm_usage/funding_payments — I3 was
performed by hand Pass 62, which is what makes these three legible as defects rather than noise.

## Quietly-holding WATCH lines — moved out of STATUS.md at Pass 65 for the 200-line cap

These four were carrying no information in the hot file: each had held for many passes with a
one-word status, so they cost a line every pass and told the next pass nothing. **They are still
OPEN and still binding** — moved, not resolved, and not deleted. A pass that needs their current
reading re-derives it from the named series; a pass that sees one BREAK promotes it back to
STATUS.md immediately, because a break is exactly the information the one-word status was hiding.

| id | expected-positive | status when moved |
| --- | --- | --- |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction | holds — zero ever |
| WATCH-V4-3 | a redeploy with a resting perp stop boots to RUNNING with no `perp pin:` line | holds |
| WATCH-V4-7 | every digest carries an alerts-fired-and-resolved line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows | holds — standing check on the mint-time gates |

### Moved out of STATUS.md at Pass 66 for the 200-line cap — quietly holding, nothing dropped

| id | expected-positive | status |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | **HOLDS** — 770 MiB at P65. The Pass-59 "ACCELERATED" reading is WITHDRAWN as an instrument artifact: `rssBytes` is a bare two-point subtraction and this host restarts ~25×/week, so a pair straddling the post-boot ramp manufactures a phantom slope (it did twice). **Control: the 49.7h boot of 2026-08-01 — +0.75 MiB/h, NEGATIVE trailing-24h slope, 801.3 MiB ceiling.** **Do not divide a straddling delta by the sweep gap** — use a range query past `RSS_WARMUP_GRACE_MS`. Body: `watches.md` |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — Pass 59's 14:00:57Z occurrence passes BOTH clauses (next binanceusdm pass 14:01:48Z CLEAN; two binanceusdm `LIMIT_MAKER` ACKs at 14:00:29Z/14:00:43Z inside the preceding interval). **Its halt-class sentence was CORRECTED Pass 59** — see the standing caution above |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds — **and is no longer hand-checked**: the I2 sweep invariant (2026-08-03) compares `cum_qty` to summed fills in exact SQL `NUMERIC` on every terminal order, every pass, failing CLOSED. 439 terminal orders, 0 mismatches |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | **RE-READ Pass 58 — expected-positive CONFIRMED again**: `orphan_scan=2843 readopt=1 cancel=0 cancel_failed=0` on binanceusdm before the redeploy. Re-seeded to 0 by each redeploy, so it re-reads on the next flat perp bar |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |
