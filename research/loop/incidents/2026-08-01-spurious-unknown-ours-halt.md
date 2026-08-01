# 2026-08-01 — the reconciler halted the book over an order it had cancelled itself

Written by Pass 56. Five fronts were investigated in parallel and each was put through three
adversarial verifiers (correctness / consequence / remedy) with a refute-by-default instruction.
All five survived. One is shipped (`62f9738`); four are root-caused and NOT shipped — each names its
own blocker below.

**Nothing was lost and nothing was unprotected.** No money moved wrongly, no position went naked, the
kill switch behaved correctly in both directions, and the venue's own state matched the local book
byte-for-byte throughout. What failed is the *reconciler's ability to tell a race from a divergence*,
and the record's ability to reconstruct either.

## How this was found at all

The `loop:sweep` alarm list was clean of it. The incident surfaced only as two
`prometheus_alert_resolved_critical` **annotations** — `KillSwitchEngaged` and `ReconciliationHalt`,
both fired and resolved inside the 12h lookback. That annotation kind exists because of Pass 45's
49-minute demo-fapi outage, which had fully resolved before the pass ran and was named nowhere. It
earned its keep here: a 65-second halt that stopped trading and drained open orders would otherwise
have left no trace any pass would read. Pass 54 ran at 20:40Z the same evening — three hours after
the halt — and did not report it, because it was an owner-directed research session and §3 never ran.

## The shipped fix — spurious `UNKNOWN_OURS_OPEN` halt (`62f9738`)

**Timeline, boot `4753ef53`, all times UTC.**

| time | event |
| --- | --- |
| ~17:30:15 | binanceusdm open-orders sweep begins. `BTC/USDT:USDT` is the FIRST symbol fetched; `cbt019fb74b74127d468e1bd84cd515dc50` (BTC LIMIT SELL 0.0018) is resting and is captured into `venueOpen` |
| 17:30:29.504 | strategy issues `CANCEL_REQUESTED` on that order, reason `CANCEL_OPEN_SIGNAL` |
| 17:30:32.611 | `CANCEL_ACK` → `portfolio.closeOrder` drops it from the in-memory open-order map |
| 17:30:32.637 | `TradingRuntime` logs `openOrders=1` (was 2) — the map no longer holds the coid |
| 17:30:59.911 | sweep loop finally ends, reads the map ONCE, finds the coid absent ⇒ `UNKNOWN_OURS` ⇒ **kill switch engaged**, 27.3s after that order was already terminal at the venue |
| 17:31:00.246→.775 | halt drain cancels the one remaining order (KAITO), reason `HALT` |
| 17:32:01.329 | next binanceusdm pass CLEAN — for the dullest reason: `open_orders_checked=0`, the venue list is now empty |
| 17:32:04.541 | `RecoveryCoordinatorService` auto-resumes to RUNNING |

**Root cause.** `reconcileOpenOrders` accumulates VENUE truth incrementally inside a per-symbol
`await` loop, but reads its LOCAL comparand exactly once, *after* that loop. Any order resting at the
venue when its symbol was fetched, that goes terminal locally before the loop ends, reads as "our
prefix, present at venue, absent locally" and halts unconditionally. The window was **44,940 ms** on
this pass against **15,769–16,365 ms** on every neighbouring pass, because the strategy was
concurrently cancelling and re-submitting on the shared rate-limited ccxt client. binanceusdm sweeps
`BTC/USDT:USDT` first, so the widest possible window applied to the order that was cancelled.

**The KAITO cancel is a consequence, not the cause** — its `order_events` payload carries reason
`HALT` and its timestamp (17:31:00.246) is strictly after the engage (17:30:59.911). It is also
structurally incapable of being the cause: the drain iterates `portfolio.snapshot().openOrders`, i.e.
exactly the set the offending order was defined by being absent from.

**Second, compounding defect.** `UNKNOWN_OURS_OPEN` was the only halting class in the file pushing no
discriminator into `acc.halts`. Its siblings all carry one (`POSITION_DRIFT:${symbol}`,
`BALANCE_DRIFT:${asset}`, `FILL_OVERFLOW:${symbol}`). Since that joined string is all that reaches the
`reconciliations.detail` column, the persisted payload was `{"detail": "UNKNOWN_OURS_OPEN",
"mismatches": 1}` — no order id anywhere. A grep of the whole boot's log for `UNKNOWN_OURS` returns
five lines, all kill-switch/ops-event lines, none naming the coid (positive control: the same file has
1302 `reconcile.pass` matches). The incident was unreconstructible from the record it wrote.

**What shipped.** A second resolution tier before halting, mirroring the fill axis's existing
precedent for this exact hazard: resolve the coid against `OrderBookService`, then against a
venue-scoped durable read. Durably terminal ⇒ new `stale_venue_open` class, no halt. Durably
NON-terminal ⇒ still halts (that is the genuine-corruption shape `FILL_FOR_UNKNOWN_ORDER` guards). A
miss, a wrong-venue row and a throw all resolve identically to the halt — *could not confirm* is never
treated as confirmed.

`stale_venue_open` is deliberately NOT in `NON_ACTIONABLE_CLASSES`, so it still withholds the clean
stamp and cannot let auto-resume fire on an unobserved condition. It escalates per-coid: a streak
keyed `venue|coid` bumps each pass, **resets when the coid leaves that venue's open list**, and halts
past `driftPasses`. That distinction is the whole point — a sampling race cannot survive a second
independent venue read, but an order genuinely still resting at the venue always will, and that one
must still stop the book.

**The review caught three real defects in the first implementation**, all fixed before commit: the
class had no escalation at all (turning a permanent orphan into a permanently silent one); the
declared FAIL CLOSED did not match the code (`venueForSymbol` sat outside the `try`, so one
unparseable symbol would have killed the whole pass with the kill switch never engaged — fail OPEN);
and `test:cov` was red on the durable tier's own branch, the one reason that tier exists.

## NOT shipped — four root-caused findings, each with its blocker

### 1. The clean stamp credits zero observation as "clean" (fail-open)

The auto-resume gate itself is **correct** — nine conditions, no elapsed-time term, and the 17:32:04
resume was genuinely earned by a real post-halt pass that swept both venues. The defect is one layer
down, in what `ReconciliationService` counts as clean: `sweep_failure` sits in
`NON_ACTIONABLE_CLASSES`, so a pass in which *every* symbol's `fetchOpenOrders` throws observes
nothing, records `actionableMismatches=0`, and **stamps CLEAN**. The file's own accumulator comment
already names the hazard: *"absences of observation, not observations of absence."* This is a
demonstrated shape, not hypothetical — 93,738 binance `sweep_failure` increments over 39h on
2026-07-27. A narrower sibling: a venue missing from `venuePorts` is logged and `continue`d, and the
pass still stamps clean.

Proposed: add `observed: boolean` to `PassResult`, false when a venue's open-orders axis produced zero
successful symbol sweeps or when its port was missing; gate the stamp on it.

**Blocker: sequencing risk against a known 39-hour wedge.** The pre-Task-C3 rule demanded a
process-wide literal zero and left the bot halted for 39h with `lastCleanAt` never set. Any tightening
keyed on "benign noise present" reproduces that exactly. This needs its own pass with a soak, not a
tail-end change.

### 2. A frozen order leaves every escalation surface, permanently

KAITO `cbt019fb947b2137ccf855aee8e47abbf55` has been in `RECONCILE_REQUIRED` since 19:15:38Z. Two
premises in the original brief were wrong and the investigation corrected them: `order_events` has
**five** rows, not two (`CANCEL_REQUESTED` 19:15:15 → `CANCEL_REJECT_UNKNOWN` 19:15:31 →
`QUERY_INCONCLUSIVE` 19:15:38), so the order was `CANCEL_UNKNOWN` for only **6.26 s** and the 60 s
watchdog was never *eligible* — it did not fail. And the order is the **take-profit**, not the
protective stop; the stop is the algo-rail `STOP_MARKET`, which is present. So hard rule 5 was not
violated and the position was never unprotected.

The genuine defect: once `freeze()` fires, nothing watches the order again — there is no frozen-age
watchdog, and `reconcileTerminalFor` has no `'open'` arm, so an order in this state cannot leave it.

**Blocker: the obvious fix is unsafe alone.** `RECONCILE_REQUIRED` is in the unresolved set, and
`recovery-coordinator.service.ts:240` refuses auto-resume while `hasUnresolvedOrders()` is true. Add
the escalation without the state-model fix and an order that *cannot* leave the state permanently
wedges auto-resume. The two must ship together, in that order.

### 3. The algo/conditional rail has no reconciliation consumer at all

The reconciler *does* walk both directions on the order axis — the DB→venue leg exists at
`reconciliation.service.ts:754-759`. It does not fire on the six `STOP_MARKET` rows because its source
is `portfolio.snapshot().openOrders`, an **in-memory** set that algo-rail orders are deliberately never
registered into. Local-open (3 LIMIT) equals venue-open (3) in both directions, so the pass is honestly
CLEAN; the six stop rows are in neither set and are invisible to both legs. That is playbook defect
class 4 — a divergence axis with no consumer.

Related, and reassuring: **there is no stop stacking.** A keyed read-only probe against the demo algo
rail returns exactly **two** open algo orders account-wide, both `reduceOnly: true`; the other four are
`TRIGGERING` in algo-history with `actualOrderId: ""`. Venue positions (UNI +13, KAITO +35.2, BCH
−0.287) are byte-identical to the local book. The "39 units of stop against a 13-unit position" the DB
appeared to show was a stale-row artifact, not exposure. `TRIGGERING` is unmapped in `ccxt-normalize.ts`
and collapses to `UNKNOWN` — the #54 venue-shape-divergence pattern again.

**Blocker: the safe part is cosmetic and the useful part is dangerous.** Mapping `TRIGGERING` is
near-zero risk but retires nothing (`actualOrderId` is empty, so the verdict stays `unknown`). The
part that would actually clear the rows — a staleness rule that folds a long-`TRIGGERING` order
terminal — discards any fill it might still produce, which books a phantom position. That needs a
measured bound and a soak.

### 4. `balances_checked = -1` means the axis never ran

`-1` is `AXIS_NOT_RUN`, not a count. The balance axis is deliberately disabled for the shared demo
wallet (a false `BALANCE_DRIFT` would halt on holdings the bot never touched), which is the right
call — but it means `reconciliation_mismatch_total{class="balance_drift"}` and `{class="balance_leak"}`
are **meaningless zeros**: a negative read with no positive control, seeded to 0 by the 2026-07-29
void-read fix and unreachable ever since. Same for `position_drift` where the position axis is off.

**Blocker: none, but it is measurement-only.** Fix is to make the metric seed axis-aware, mirroring the
`axisErrorCounter` block that already implements exactly this rule. Deferred only because it must not
be derived from a different availability predicate than `reconcileOnce` actually uses — a mismatch
would un-seed a class that CAN fire, re-opening the void-read problem.

## What this says about the instruments

Three of the five findings are the same shape: **a surface that reports health it never established.**
A clean stamp written off an unobserved axis, a zeroed counter for an axis that never ran, a whole
order rail with no consumer. The 2026-07-29 void-read fix taught the sweep to distrust an empty read;
the reconciler has not yet learned the same lesson about its own axes. That is the through-line worth
carrying into the next pass, and it is a bigger lever than any one of the four repairs.
