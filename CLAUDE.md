# crypto-bot

NestJS 11.1.x · TS strict · Node 24 (engines >=22) · pnpm · Postgres 16 · Drizzle ·
ccxt 4.5.58 (PINNED — bumping it requires re-running the sandbox-URL regression test
and the error-classifier snapshot test) · decimal.js · Vitest

Detailed layout, naming, and discovered conventions: [`.claude/CLAUDE.md`](.claude/CLAUDE.md).

## Commands

pnpm build | lint | typecheck | format:check | test | test:livegate | test:paper |
test:cov | test:testnet (env-gated, nightly)
build+lint+typecheck+test MUST be green before any completion claim.

Research (off production gate): pnpm backtest | eval:\* | loop:\* | fetch:edge-tournament

## Configuration

Deploy knobs live in committed lane files; secrets live in gitignored `.env` only.

| File | Role |
| ------ | ------ |
| `.env.app` | App deploy knobs, one process/both venues (+ comments) |
| `.env` / `.env.example` | Secrets only (API keys, arming tokens, Grafana password) |
| `docker-compose.yml` | `env_file` wiring + infra env only — no app knob `environment:` blocks |

**Compose:** `env_file: [.env.app, .env]` — later file wins (secrets override). One `app` service,
no profiles (the perp lane files/profile were deleted at the 2026-07-21 v3 cutover).

**Host `pnpm start`:** `AppConfigModule` loads `envFilePath: ['.env', '.env.app']` — first path wins (same effective precedence). Test/CI: `ignoreEnvFile: true` (unchanged).

**Standing sync rule:** deploy knob changes go to `.env.app`, zod schema in `environment.config.ts`, and docs — not inline compose `environment:`. Secrets template stays in `.env.example` only.

**env_file quirk:** `VAR=` means UNSET; never put an inline comment after an empty assignment (compose delivers the comment as the value).

## Project layout (buckets)

Same group names across rings: `common` · `venue` · `trading` · `strategy`.

```text
src/domain/{common,venue,trading,strategy}/
src/ports/{common,venue,trading,strategy}/
src/features/{common,venue,trading,strategy}/   # Nest leaves only under groups
src/database/repositories/{common,venue,trading,strategy}/
test/features/{common,venue,trading,strategy}/
research/{loop,scorecards,candidates,studies}/
```

Strategy lane: `src/features/strategy/agentic/`. Money path: `src/features/trading/{risk,execution}/`.
Venue I/O: `src/features/venue/{exchange,market-data}/`. Composition (app zone):
`src/features/trading/composition/`.

## Hard rules

1. MONEY IS NEVER A NATIVE FLOAT. decimal.js + branded types minted only in
   domain/common/types/money.ts; DB NUMERIC(38,18); ccxt constructed with number: String;
   order books are reference-grade (floats) — fills/orders/balances are exact strings;
   no parseFloat/Number() on money paths (lint); money tests assert exact strings
   (toBeCloseTo banned); venue-facing rounding is explicit and directional.
2. STRATEGY NEVER BYPASSES RISK. Order path: Strategy → Risk (sizing + veto) →
   Execution → ExchangeAdapter. Execution accepts only RiskApprovedIntent (brand +
   HMAC proof); never widen its signature; strategies cannot import execution/adapter
   (eslint-plugin-boundaries zones are the wall — never disable them).
3. PAPER IS DEFAULT; LIVE IS GATED. Any missing/invalid mode input resolves to paper.
   Never weaken the four gates (env flag + bootId-bound interlock + validated keys
   with withdrawals-disabled + complete risk limits), the NODE_ENV=test/ci override,
   or the config stripping of live secrets. test:livegate is sacred — never skip or
   delete it to make a suite pass.
4. src/domain imports nothing impure (no @nestjs/\*, ccxt, Date.now, process.env). The strategy
   lane is SOLELY the agentic / LLM-driven lane in src/features/strategy/agentic/ (NOT src/domain):
   async and non-deterministic (calls an out-of-process LLM at runtime), so it remains
   step-D-uncertifiable — live access is EARNED, not assumed. assertAgenticLaneNotLive refuses
   any live boot unless PromotionReadinessService (src/features/trading/mode-control/) returns a
   permitted verdict: >=30 closed demo round trips AND positive net-of-cost PnL (realized − fees −
   LLM spend) over >=14 days. A permitted boot still faces the unchanged four live gates and
   bootId-bound arming ceremony on top — the promotion gate narrows who may attempt arming, it
   does not replace it. Rules 1, 2, 3, 5, 6 bind on the lane exactly as elsewhere — it only
   proposes a Signal, Risk still sizes/vetoes it, and the four live gates still bind. The
   deterministic pure lane (ema-cross/donchian) and its replay-determinism gate were RETIRED by
   owner decision 2026-07-03 (git-history-only — pruned 2026-07-21);
   the test/backtest research harness was REBUILT 2026-07-10 by owner decision (edge program —
   research/loop/state.md § Flagged) and stays OFF the production test gate (`pnpm backtest`).
5. OMS: never blind-resubmit — unknown outcome ⇒ query by clientOrderId first
   (same-id dedupe is NOT a safety net on Binance: open-orders-only). Persist intent
   before any network call. Unknown >60s ⇒ kill switch. Unmapped errors are
   OUTCOME_AMBIGUOUS, never retried blind.
6. audit_log and order_events are append-only — never UPDATE/DELETE, never relax
   their triggers. Reconciliation mismatch HALTs and never auto-flattens.
7. No secrets in code/logs/fixtures/committed env files (`.env.app`); pino redact list mandatory for new loggers;
   key fingerprints only.
