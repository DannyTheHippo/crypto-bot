# crypto-bot

NestJS 11.1.x · TS strict · Node 24 (engines >=22) · pnpm · Postgres 16 · Drizzle ·
ccxt 4.5.58 (PINNED — bumping it requires re-running the sandbox-URL regression test
and the error-classifier snapshot test) · decimal.js · Vitest

## Commands

pnpm build | lint | typecheck | format:check | test | test:livegate | test:paper |
test:cov | test:testnet (env-gated, nightly)
build+lint+typecheck+test MUST be green before any completion claim.

## Hard rules

1. MONEY IS NEVER A NATIVE FLOAT. decimal.js + branded types minted only in
   domain/types/money.ts; DB NUMERIC(38,18); ccxt constructed with number: String;
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
4. src/domain imports nothing impure (no @nestjs/\*, ccxt, Date.now, process.env).
   Strategies: sync handlers, eventTime only, seeded RNG only.
5. OMS: never blind-resubmit — unknown outcome ⇒ query by clientOrderId first
   (same-id dedupe is NOT a safety net on Binance: open-orders-only). Persist intent
   before any network call. Unknown >60s ⇒ kill switch. Unmapped errors are
   OUTCOME_AMBIGUOUS, never retried blind.
6. audit_log and order_events are append-only — never UPDATE/DELETE, never relax
   their triggers. Reconciliation mismatch HALTs and never auto-flattens.
7. No secrets in code/logs/fixtures; pino redact list mandatory for new loggers;
   key fingerprints only.
