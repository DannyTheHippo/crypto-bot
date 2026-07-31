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

### WATCH-V4-10 — an orphaned perp algo stop resting against a flat book (2026-07-30, Pass 49)

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

## Flagged for human review (open)

> **This section is for defects that CANNOT be fixed without crossing the §4 MUST-NOT rails — owner
> capability limits only. It is not a defect queue.** Owner ruling 2026-07-27, verbatim: "do not
> defer defects … those must get fixed immediately if possible"; the daily loop is a profitability
> engine, not a bug tracker. Pass 40 initially parked four defects here citing the
> one-money-path-item-per-pass limit, was corrected, and fixed all four in the same pass. That limit
> governs chosen IMPROVEMENTS only and never licenses a deferral — now stated outright in playbook §4
> (§ DEFECTS ARE NEVER DEFERRED).

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
