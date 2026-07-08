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
journal → reflection (hypothesis generation) → human review (eval scorecards) → promotion → active
                                                                                  (or: reflection auto-promotes directly, below)
```

1. **Journal.** Every decide-path call is recorded to `AGENT_DECISION_JOURNAL`
   (`agent-decision-journal.adapter.ts` / in-memory fallback).
2. **Reflection** (`reflection.service.ts`, trade-triggered, detached from the decide path). After
   every `everyNTrades` closed trades (default 10, config `AGENTIC_REFLECTION_EVERY_N_TRADES`), and
   never more than once per cooldown (default 7 days, tunable via `AGENTIC_REFLECTION_COOLDOWN_MS`,
   floored at 0), it reviews recent journal rows — closed round-trips, a hold summary, and a
   **forward-outcome digest** (per-decision t+1 outcomes bucketed by entry/exit/held-long/stayed-flat
   and by confidence, from `counterfactual-scoring.ts`) — and drafts a candidate playbook revision.
   `append(content, 'reflection', parentVersion)` mints an **INACTIVE** candidate row — reflection
   never activates anything itself.
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

Alongside the manual path above, `reflection.service.ts` can also promote a candidate itself
(`maybeAutoPromote`), gated behind `AGENTIC_AUTO_PROMOTE_MIN_TRADES` (default `0`, which disables
it — candidates then stay INACTIVE for manual `playbook:promote`). The deployed demo bot
(`docker-compose.yml`) sets it to `30`.

Auto-promotion only runs as the tail end of a reflection attempt that actually mints a new
candidate — it is not a standalone scheduler, so it inherits every precondition reflection already
has (§ Self-improvement loop step 2: `everyNTrades` cadence, the cooldown, the kill switch, the
strategy's `ACTIVE` lifecycle, and the LLM budget). When a reflection run mints a candidate, it is
promoted immediately if the strategy's **cumulative** closed-trade count is `>=
AGENTIC_AUTO_PROMOTE_MIN_TRADES` — this is a running total, not a per-window or matched-trade
sample, so raising the threshold is the only lever against noisy early promotions. Promotion appends
the same `source='promotion'` row the manual path writes, so it is still subject to the
once-per-UTC-day partial unique index; if that write fails (e.g. a manual promotion already landed
that day), auto-promotion is non-fatal — the candidate simply stays INACTIVE and remains promotable
later, by either path.

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
