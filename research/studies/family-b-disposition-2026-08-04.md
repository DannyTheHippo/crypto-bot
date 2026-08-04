# Family B disposition — the ~$22 falsification run is NOT run, and here is the whole case (2026-08-04)

_Decision record. Owner delegated the go/no-go on 2026-08-04 ("only spend money if you think it is
truly useful"). The decision is **NO RUN**, made on the evidence below, and it closes backlog #50
(re-scoped, not completed) and #64 (moot). Nothing here deletes the option: the corpus trigger is
met and § 5 records exactly how a future owner runs it._

## 1. What Family B was for

`playbook-space-followon-2026-07-31.md` registered Family B as the deployed champion's own
out-of-sample falsification test: replay v10 `inverted` (and control arms) against a fresh frozen
corpus, scored against the frozen **+13.0 bps** research bar, ~1,400 paid calls ≈ **$21.91**, paid
block atomic. It was blocked 2026-07-31 by a corpus-hash "drift" that
`corpus-fingerprint-drift-correction-2026-08-03.md` refuted (the study had reimplemented the hash
with a one-byte error), and unblocked on corpus grounds this pass: **584 qualifying rows vs ≥ 354
required** (`census-2026-08-03.md` § 5, re-verified at the corrected epoch).

So the run is _available_. The question is whether its result could still change any decision.

## 2. Why it no longer can

**(a) A stronger instrument already answered the question, with power.** Family B tests v10
out-of-sample _in replay space_. Since its registration, the live realised forward-return
instrument reached power on v10 itself: h=4 **−45.3 bps** CI95 [−122.0, −0.3], h=8 **−52.8** CI95
[−134.9, −1.5], n=21, k=8 clusters (sweep 2026-08-03T22:02Z, unchanged at 2026-08-04). That is
real fills on the real book — a strictly stronger evidence class than an offline replay — and it
already delivers the falsification signal Family B was built to look for.

**(b) Replay→live transfer is measured broken, this pass.** The same sweep shows live-realised vs
replay-predicted deltas of **−46.1 bps (h=4)** and **−72.1 bps (h=8)**, POWERED, with the
adverse-selection mechanism named (76% maker fills, which offline replay structurally cannot see).
Any Family B outcome inherits that transfer gap: a PASS would not validate live behaviour, and a
FAIL would confirm what live evidence already shows twice over.

**(c) The bar it scores against is superseded.** Family B is frozen to +13.0 — registered before
`verdicts.md` § Addendum 2026-08-04, so per forward-only supersession it would still be scored
against +13.0. The derived bars are **+8.36 gross / ≈ +78.8 all-in** (forward ≈ +108). A PASS at
+13.0 therefore licenses nothing: no deployment claim could clear the real bar. A FAIL triggers,
per the pre-registered contract shape, **no automatic demotion** — only the mint-vs-stand-down
question that the S3 arithmetic (`redesign-scoreboard-2026-08-04.md` § 2) has already posed.

**(d) The cost is not just $22.** B2's breaker accounting deliberately counts replay rows
(`llmSpendTotalsAllSources`), so the app's next same-UTC-day boot re-seed would latch the $3/day
breaker and starve the live lane for the rest of the day — and the lever-enable deploy happens
today. The run would cost ~$22 **plus** up to a day of live evidence accrual, 27 days before the
decision window closes.

**Decision rule applied: spend only where a result could change a decision.** No branch of Family
B's outcome — PASS, FAIL, or regime-control shift — changes any decision this program can still
take before 2026-08-31. The −$200 stop and the window verdict will be decided by live evidence
that already exists and keeps accruing for free.

## 3. What this does to the ledger

- **#50** ("Confirm `inverted` out-of-sample — the deployment's falsification test") closes as
  **SUPERSEDED BY A STRONGER INSTRUMENT**: the live forward-return watch, powered on v10, now IS
  the deployment's falsification test, and it has effectively fired (tier-2 of the restated
  WATCH-PLAYBOOK-V10-1 is adjudicable now). Not completed — the replay-space test was never run —
  and not silently dropped.
- **#64** (Family B exceeds its declared allocation by ~$1.70–$1.91) closes **MOOT**: there is no
  spend to re-budget. The discrepancy's resolution-by-computation stands recorded in the D8 spec
  for any future run.
- The charter's "LLM proposes, backtest disposes" discipline is **not** weakened: what changed is
  which instrument disposes. For this lane the live realised cell is the disposer of record, and
  the measured replay→live transfer gap (b) is the dated evidence for that re-scoping.

## 4. What this decision cannot claim

- It is not evidence that v10 would have failed (or passed) Family B. That measurement was not
  taken.
- It does not retire replay-space testing in general — the $0 offline harness remains the
  charter's instrument for model-identity changes, where it can measure what changes.
- If the live lane's regime shifts (e.g. the basket turns and v10's live cells lose power), the
  case in § 2(a) weakens and this disposition should be revisited rather than cited.

## 5. If a future owner wants it anyway

The corpus trigger is met (584 rows as of 2026-08-03T18:25Z, growing ~130/day). Preconditions in
order, per the D8 spec: dated re-budget line in `charter.md` § Budgets (compute the overage, raise
the cap to a stated number); interpretation contract dated before manifest freeze; candle backfill
(`fetch-edge-tournament-data.mjs`, network, no API spend); manifest freeze with the IMPORTED hash
function; 1-token preflight; then `pnpm eval:playbook-space` atomically. Run it on a day with no
planned app reboot, or accept the breaker latch.
