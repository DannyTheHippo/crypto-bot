# crypto-bot — Agent Guide

Detailed layout, naming, and conventions for agents. **Hard safety rules** live in root
[`CLAUDE.md`](../CLAUDE.md) — they bind here without restatement.

## Stack

NestJS 11.1.x · TypeScript strict · Node ≥22 (24 recommended) · pnpm 10.32.1 · Postgres 16 ·
Drizzle · ccxt 4.5.58 (PINNED — bump requires sandbox-URL + error-classifier regression tests) ·
decimal.js · Vitest 4 · eslint-plugin-boundaries

## Project layout (domain buckets)

Same group names across rings: **`common`** · **`venue`** · **`trading`** · **`strategy`**.

```text
src/domain/{common,venue,trading,strategy}/   pure — no I/O, no Nest, no ccxt
src/ports/{common,venue,trading,strategy}/    interfaces + DI Symbol tokens only
src/features/
  common/observability/
  venue/{exchange,market-data}/
  trading/{composition,risk,execution,mode-control}/
  strategy/agentic/
src/database/
  schemas/trading/
  repositories/{common,venue,trading,strategy}/
src/config/  src/shared/  app.module.ts  main.ts
test/features/{common,venue,trading,strategy}/   mirrors features
test/domain/{common,venue,trading,strategy}/     pure domain specs
test/ports/                                      port contract specs
test/{livegate,paper,backtest,eval,db,testnet}/
research/{loop,scorecards,candidates,studies}/
docs/  drizzle/  observability/  scripts/
```

### Bucket contents (by ring)

| Bucket | `domain/` | `ports/` | `features/` | `repositories/` |
| ------ | --------- | -------- | ----------- | --------------- |
| `common/` | types/money, types/ids, rng | app-config, clock, observability | observability (metrics, health, pino) | llm-usage, pg-advisory lock |
| `venue/` | symbol, venue-map, subscription, market-events | exchange, streams, market-data, feeds, funding | exchange adapters, ccxt streams, feeds | funding-payments |
| `trading/` | order-intent, exec-report, portfolio, risk, oms, paper, mode | execution, risk, mode-control, promotion | risk, execution, mode-control, composition | orders, fills, intents, equity, … |
| `strategy/` | signal, indicators | strategy, agentic-strategy, sentiment feeds | agentic (LLM lane) | agent-decision, playbook, experiment |

**Hexagonal walls (eslint-plugin-boundaries):**

- `domain` → domain only
- `ports` → domain, ports
- `features/*/*` → domain, ports, config, shared, **same feature folder only**
- `database` → domain, ports, config, shared, database
- `app` (`app.module.ts`, `main.ts`, `features/trading/composition/**`) → composition root

**Do not** add `*.module.ts` under `domain/` or `ports/`. Nest leaves live under `features/` only.

**Order path:** Strategy (`features/strategy/agentic`) → Risk → Execution → ExchangeAdapter.
Composition wiring: `features/trading/composition/` (app zone).

**Layout note:** agentic strategy lives only under `features/strategy/agentic/`. Domain concerns
live under `domain/{common,venue,trading,strategy}/` (not flat). Nest leaves (`*.module.ts`)
never belong under `domain/` or `ports/`.

## File naming

All files: `kebab-case` with type suffix.

| Type | Pattern | Example location |
| ---- | ------- | ---------------- |
| Service | `*.service.ts` | `features/trading/risk/risk-engine.service.ts` |
| Module | `*.module.ts` | `features/trading/risk/risk.module.ts` |
| Controller | `*.controller.ts` | `features/trading/mode-control/arming.controller.ts` |
| Port | `{name}.ts` | `ports/trading/risk.ts` |
| Domain type | `{name}.ts` | `domain/trading/types/order-intent.ts` |
| Repository | `*.repository.ts` | `database/repositories/trading/order.repository.ts` |
| DTO | `*.{request,response}.dto.ts` | `features/trading/mode-control/dtos/` |
| Unit test | `*.spec.ts` | colocated under matching `test/` tree |

## Coding rules

Precedence: root [`CLAUDE.md`](../CLAUDE.md) hard rules > this file.

- **Money:** branded strings via `domain/common/types/money.ts`; never `parseFloat`/`Number()` on
  money paths (lint-enforced); exact-string assertions in tests (`toBeCloseTo` banned).
- **Ports:** export `Symbol('TOKEN')` constants + TypeScript interfaces; no `@Injectable`, no
  `@Module`. Features bind implementations; composition root provides cross-cutting singletons
  (e.g. `RISK_SIGNING_KEY`, `KILL_SWITCH`).
- **Domain purity:** no `@nestjs/*`, ccxt, `Date.now`, `process.env`, pg, drizzle-orm.
- **Config:** deploy knobs in `.env.app` + zod in `environment.config.ts`; secrets in gitignored
  `.env` only. Never inline app knobs in `docker-compose.yml` `environment:` blocks.
- **DI:** constructor injection with `private readonly`; resolve port tokens via `@Inject(TOKEN)`.
- **Imports:** deep relative paths from features to domain/ports (no path aliases for rings).
- Match existing comment density — explain non-obvious business logic only.

## Testing

Production gate — `pnpm test`:

```bash
vitest run test/features test/domain test/ports test/livegate
```

| Script | Scope |
| ------ | ----- |
| `pnpm test:livegate` | Sacred — never skip or delete to green a suite |
| `pnpm test:paper` | Paper loop integration |
| `pnpm test:cov` | Coverage on production gate suites |
| `pnpm test:db` | Postgres integration |
| `pnpm test:testnet` | Sandbox lifecycle (env-gated) |
| `pnpm backtest` / `pnpm eval:*` / `pnpm loop:*` | Research — OFF production gate |

Vitest: `globals: false`; import `{ describe, it, expect }` explicitly. SWC via `unplugin-swc`.
Coverage thresholds: 90/85/90/90 global; 100% on risk/oms/mode/execution paths (see
`vitest.config.ts` per-glob overrides).

Test layout mirrors source rings. Extend existing specs rather than duplicating coverage.
Domain/risk tests use exact money strings and branded id mint helpers.

## Discovered conventions

- **Framework:** NestJS 11 modular monolith; one process, spot + USDⓈ-M perp venues.
- **Persistence:** Drizzle ORM; repositories bucketed under `database/repositories/`; schemas in
  `database/schemas/`. `audit_log` / `order_events` append-only (DB triggers).
- **Lint:** `eslint.config.mjs` — typed lint via `typescript-eslint` recommendedTypeChecked;
  boundaries wall on `src/**`; domain purity + money-path restrictions on `src/domain/**`.
- **Format:** Prettier defaults; markdown via `markdownlint-cli2`.
- **Strategy lane:** agentic only (`ACTIVE_STRATEGY=agentic`); LLM calls in
  `features/strategy/agentic/`; promotion gate via `PromotionReadinessService`.
- **Observability:** Prometheus metrics, pino logging with redact list, Grafana in `observability/`.
- **Research:** `research/loop/STATUS.md` is the loop's entry point (charter/verdicts/watches
  alongside it); scorecards/studies committed;
  candidates ephemeral.

## Validation

Run before any completion claim:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```

Also required per root hard rules: `pnpm build` must be green. Shortcut:

```bash
pnpm checks   # format:check + lint:md + lint + typecheck + test
```

Research scripts (`pnpm backtest`, `pnpm eval:*`, `pnpm loop:*`) are off the production gate.
