# agentic-strategy

The agentic lane is an LLM-driven strategy: async, non-deterministic (it calls an out-of-process
model at runtime), and permanently **EXPERIMENT-ONLY** — paper/testnet only, step-D-uncertifiable,
never promoted to live. `assertAgenticLaneNotLive` (`agentic-live-interlock.ts`) refuses any live
boot with `ACTIVE_STRATEGY=agentic`. It only proposes a `Signal`; Risk still sizes/vetoes every
proposal, and the four live gates still bind — this lane does not bypass any of CLAUDE.md's hard
rules.

The deterministic pure lane (ema-cross/donchian) and its research harness were retired by owner
decision 2026-07-03; this module is now the only strategy lane under active development.

## Self-improvement loop

```
journal → reflection (hypothesis generation) → human review (eval scorecards) → promotion → active on next boot
```

1. **Journal.** Every decide-path call is recorded to `AGENT_DECISION_JOURNAL`
   (`agent-decision-journal.adapter.ts` / in-memory fallback).
2. **Reflection** (`reflection.service.ts`, trade-triggered, detached from the decide path). After
   every `everyNTrades` closed trades (default 10, config `AGENTIC_REFLECTION_EVERY_N_TRADES`), and
   never more than once per 7-day cooldown floor, it reviews recent journal rows and drafts a
   candidate playbook revision. `append(content, 'reflection', parentVersion)` mints an **INACTIVE**
   candidate row — reflection never activates anything itself.
3. **Human review.** Candidates are scored against eval scorecards (a separate task/harness) before
   anyone decides whether to promote one.
4. **Promotion** (`scripts/playbook-promote.mjs`, this task — §G4b). A human runs
   `pnpm playbook:promote <version>` against the real `DATABASE_URL` to insert a `source='promotion'`
   row pointing `parentVersion` at the reviewed candidate. At most one promotion row lands per UTC
   calendar day (`agent_playbook_versions_promotion_per_day_uidx`, a partial unique index) — the
   script exits 1 if a second one is attempted the same day.
5. **Activation.** `PlaybookStoreAdapter.resolve()` picks the active version in this order: an
   operator pin (`AGENTIC_PLAYBOOK_PIN`) → else the newest promotion row's `parentVersion` target →
   else the seed. Resolution runs **once per process, at boot, and is cached** — a promotion (or a
   pin change) written while a process is already running takes effect only on that process's
   **next restart**, never live-swapped mid-run. Boot logs the resolved outcome (version + how it
   was resolved: pin/promotion/seed) and records it to the `agentic_playbook_info` gauge.

**Rollback** is the same mechanism run backwards — there is no separate rollback code path:

- Promote an earlier version. The **newest promotion row wins on next boot, regardless of its
  target's version number** — promoting v1 after a v3 promotion resolves to v1.
- Or set `AGENTIC_PLAYBOOK_PIN=<version>` and restart. A pin always overrides promotion resolution
  when the pinned row exists, so it is the immediate/forcing option; promoting an earlier version is
  the non-pinned, one-promotion-per-day-paced option.

Both paths are exercised in `test/unit/persistence/in-memory-playbook-store.spec.ts` and
`test/db/persistence.spec.ts`'s playbook-store cases.

## Auto-promotion is deferred

Promotion above is a deliberate, human-pinned action — there is no scheduled or automatic promotion
path, by design. Auto-promotion is gated behind a documented evidence threshold that has not been
reached: **≥30 matched closed trades per comparison window**. At this lane's current volume (0–3
trades/day), a smaller sample is statistically indistinguishable from noise, so an automated
promoter would be as likely to activate a regression as an improvement. Revisit only once the trade
volume and a comparison methodology (paired trades, matched market regime) both support it.

## Safety bounds on every loop iteration

- `DailyLlmBudget` (`agent-budget.ts`) caps calls and tokens per UTC day, shared across the decide
  and reflection paths.
- The B5 entry cap (`maxEntriesPerDay`, wired in `app.module.ts`'s `STRATEGY_HOST` factory) bounds
  new-entry signals regardless of what the model proposes.
- Reflection checks the kill switch and the strategy's registry lifecycle (must be `ACTIVE`) before
  running, and fails closed (aborts) if either dependency is unavailable rather than assuming a
  missing check would have passed.
- `ValidatingPlaybookProvider` (`app.module.ts`) re-validates playbook content before it reaches the
  LLM prompt on every read, independent of promotion — untrusted, previously-model-authored content
  never composes into the system prompt unchecked.
