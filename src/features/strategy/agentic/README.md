# agentic-strategy

The agentic lane is an LLM-driven strategy: async, non-deterministic (it calls an out-of-process
model at runtime), and step-D-uncertifiable — so **live access is EARNED, never assumed**.
`assertAgenticLaneNotLive` (`agentic-live-interlock.ts`) refuses any live boot with
`ACTIVE_STRATEGY=agentic` unless `PromotionReadinessService` returns a permitted verdict (>=30
closed demo round trips AND positive net-of-cost PnL over >=14 days); a permitted verdict only
allows ATTEMPTING the unchanged four-gate arming ceremony. It only proposes a `Signal`; Risk still
sizes/vetoes every proposal — this lane does not bypass any of CLAUDE.md's hard rules.

The deterministic pure lane (ema-cross/donchian) and its research harness were retired by owner
decision 2026-07-03; this module is now the only strategy lane under active development.

## Self-improvement loop

```text
journal → offline candidate drafting (§ Loop-drafted candidates) → promotion → active
                                                                     (or: the attributed evaluator auto-promotes, below)
```

1. **Journal.** Every decide-path call is recorded to `AGENT_DECISION_JOURNAL`
   (`agent-decision-journal.adapter.ts` / in-memory fallback).
2. **Candidate drafting.** In-process reflection (`reflection.service.ts`) used to occupy this step;
   it was switched off by config and then **deleted outright on 2026-07-30**
   (`research/studies/entry-rate-rederivation-2026-07-30.md`), together with the mint-time entry-rate
   floor and mint-time expectancy backtest it hosted. `pnpm playbook:candidate` (§ Loop-drafted
   candidates) is the only minting path now. Historical rows still carry `source='reflection'` and are
   still routed by the A/B provider — that source value is historical-only, never newly written.
3. **Human review.** Candidates are scored against eval scorecards (a separate task/harness) before
   anyone decides whether to promote one.
4. **Promotion** (`scripts/playbook-promote.mjs`, this task — §G4b). A human runs
   `pnpm playbook:promote <version>` against the real `DATABASE_URL` to insert a `source='promotion'`
   row pointing `parentVersion` at the reviewed candidate. At most one promotion row lands per UTC
   calendar day (`agent_playbook_versions_promotion_per_day_uidx`, a partial unique index) — the
   script exits 1 if a second one is attempted the same day.
5. **Activation.** `PlaybookStoreAdapter.resolve()` picks the active version in this order: an
   operator pin (`AGENTIC_PLAYBOOK_PIN`) → else the newest promotion row's `parentVersion` target →
   else the seed. Resolution is cached after the first call. A promotion row written by a _separate_
   process (`pnpm playbook:promote`, or a pin change) takes effect for this process only on its
   **next restart**, never live-swapped mid-run. The one exception is an **in-process** promotion
   append (auto-promotion, below): `append()` drops the cache when it writes the `'promotion'` row,
   so the very next resolution in that same process picks it up immediately, no restart needed. Boot
   logs the resolved outcome (version + how it was resolved: pin/promotion/seed) and records it to
   the `agentic_playbook_info` gauge.

**Rollback** is the same mechanism run backwards — there is no separate rollback code path:

- Promote an earlier version. The **newest promotion row wins on next boot, regardless of its
  target's version number** — promoting v1 after a v3 promotion resolves to v1.
- Or set `AGENTIC_PLAYBOOK_PIN=<version>` and restart. A pin always overrides promotion resolution
  when the pinned row exists, so it is the immediate/forcing option; promoting an earlier version is
  the non-pinned, one-promotion-per-day-paced option.

Both paths are exercised in `test/unit/persistence/in-memory-playbook-store.spec.ts` and
`test/db/persistence.spec.ts`'s playbook-store cases.

## Auto-promotion

Alongside the manual path above, `promotion-evaluator.ts` can promote a candidate itself, gated
behind `AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES` (`0` disables it — candidates then stay INACTIVE
for manual `playbook:promote`). It observes the strategy's closed-trade seam
(`AgenticStrategyDeps.onClosedTrade`, wired in `trading-runtime.module.ts`) and promotes only on the
candidate's OWN A/B-attributed evidence beating the champion's, symmetrically (both arms need the
minimum in-window trip count) and above the `AGENTIC_PROMOTE_MIN_POS` probability-of-superiority
floor. Promotion appends the same `source='promotion'` row the manual path writes, so it is still
subject to the once-per-UTC-day partial unique index; if that write fails (e.g. a manual promotion
already landed that day), auto-promotion is non-fatal — the candidate simply stays INACTIVE and
remains promotable later, by either path.

The count-only `AGENTIC_AUTO_PROMOTE_MIN_TRADES` path this section used to document was retired with
reflection itself (`AppConfig.agentic.autoPromoteMinTrades` is a hardcoded-0 transitional field).

## Loop-drafted candidates (offline research path)

The daily loop (a Claude session on subscription — `docs/planning/daily-profitability-loop.md`)
can propose playbook candidates without spending in-app LLM budget: draft the candidate file
in-session → score it offline against recorded decide rows
(`AGENTIC_CANDIDATE_PLAYBOOK_FILE=<file>` with `test/eval/agentic/recorded-payload-live-compare.spec.ts`;
every scored variant, winners AND losers, is logged to the append-only `experiments` registry
for honest trial accounting) → inject only a champion-beating draft via
`pnpm playbook:candidate <file> [--metrics <scorecard.json>]`. The CLI validates through the
same compiled `validatePlaybook` gate the runtime uses (refusing on a stale `dist/`), inserts
INACTIVE with `source='loop-candidate'`, and refuses while any historical `reflection` row or loop
candidate is still unresolved in A/B. From there the standard machinery owns it: the 25% A/B router
treats `loop-candidate` rows exactly like the historical `reflection` rows, attribution accrues per version, and
promotion (auto or manual) is unchanged. Read-side re-validation still applies on every
compose — injection grants no new trust.

## Safety bounds on every loop iteration

- `DailyLlmBudget` (`agent-budget.ts`) caps calls and tokens per UTC day for the decide path (the
  only in-process LLM path left since reflection was deleted).
- The B5 entry cap (`maxEntriesPerDay`, wired in `app.module.ts`'s `STRATEGY_HOST` factory) bounds
  new-entry signals regardless of what the model proposes.
- `ValidatingPlaybookProvider` (`app.module.ts`) re-validates playbook content before it reaches the
  LLM prompt on every read, independent of promotion — untrusted, previously-model-authored content
  never composes into the system prompt unchecked.
