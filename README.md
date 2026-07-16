# crypto-bot

A Binance spot trading bot with paper-first defaults, a four-gate live interlock, strict money-safety,
a risk engine, a kill-switch, and full observability. Written in NestJS 11 / TypeScript strict. The
active strategy lane is agentic — an LLM (`ACTIVE_STRATEGY=agentic`) proposes Signals on a configurable
candle interval; the older deterministic EMA-cross/donchian lane was retired (owner decision
2026-07-03; see `docs/archive/nightly-improvement.md`, historical). The agentic lane is gated: it stays
paper/demo until `PromotionReadinessService` certifies it (>=30 closed demo round trips and positive
net-of-cost PnL over >=14 days), on top of the unchanged four-gate live interlock below. Paper mode
requires no credentials and no network access to the exchange.

Three modes: **paper** (default — fully in-memory simulator driven by real market data, no credentials
required), **testnet** (real `CcxtExchangeAdapter` against a Binance sandbox — either Binance Demo
Trading or Binance Spot Testnet), and **live** (real funds, behind a four-gate interlock that cannot
be satisfied in any CI environment).

---

## Features / safety highlights

- **Paper is the default.** Any missing or invalid `TRADING_MODE` input safely resolves to paper.
  No credential is ever required to run or test the bot.
- **Four-gate live interlock.** Live mode requires all of: explicit env flag (`TRADING_MODE=live`) +
  a bootId-bound in-memory arming handshake + withdrawals-disabled validated keys + complete risk
  limits. CI strips live secrets unconditionally; the live adapter is absent from the object graph in
  test/ci environments.
- **Money is never a native float.** All prices, quantities, notionals, fees, and balances use
  `decimal.js` Decimals wrapped in branded types. `parseFloat`/`Number()` on money paths is banned
  by lint. DB columns are `NUMERIC(38,18)`. Venue-facing rounding is explicit and directional.
- **Append-only audit.** `audit_log` and `order_events` tables are append-only; no UPDATE/DELETE is
  permitted and DB triggers enforce this.
- **Reconciliation HALT — no auto-flatten.** A balance drift, unknown open order, or fill for an
  unknown order halts the bot. It never auto-flattens on mismatch because local state may be wrong.
- **Order path is enforced.** Strategy → Risk (sizing + veto) → Execution → ExchangeAdapter.
  ESLint boundary zones prevent strategies from importing execution or adapter code.
- **OMS deduplication.** Intent is persisted before any network call. Unknown outcomes are
  `OUTCOME_AMBIGUOUS`, never retried blind.

---

## Prerequisites

| Requirement          | Version                                                     |
| -------------------- | ----------------------------------------------------------- |
| Node.js              | >=22 (Node 24 recommended)                                  |
| pnpm                 | 10.32.1                                                     |
| Docker + Compose     | optional — for full-stack (Postgres + Prometheus + Grafana) |
| Binance Demo account | optional — for testnet/demo mode                            |

---

## Quick start — local (paper mode)

No credentials required. The bot runs fully in-memory against live Binance market data for pricing.

```bash
pnpm install
cp .env.example .env        # secrets only — fill API keys
# Deploy knobs (mode, strategy, risk) are in committed .env.app — edit there if needed.
pnpm build
pnpm start
```

The server starts on `http://localhost:3100` (configurable via `PORT`). Confirm it is healthy:

```bash
curl http://localhost:3100/health/ready
```

To force paper mode regardless of `.env` contents:

```bash
TRADING_MODE=paper pnpm start
```

---

## Quick start — docker-compose (full stack)

Brings up Postgres 16, Prometheus, Grafana, and (once the `app` service is wired) the bot itself.

```bash
docker compose up --build
```

With no credentials in `.env`, the app still boots but cannot place sandbox orders until keys are set.
Deploy knobs (including `TRADING_MODE`) come from committed `.env.app`; secrets from gitignored `.env`.

| Service    | URL                   | Default credentials                          |
| ---------- | --------------------- | -------------------------------------------- |
| App        | http://localhost:3100 | —                                            |
| Grafana    | http://localhost:3101 | admin / admin (or `$GRAFANA_ADMIN_PASSWORD`) |
| Prometheus | http://localhost:9090 | —                                            |

Grafana dashboards and Prometheus scrape config are provisioned automatically from `observability/`.

---

## Running against Binance Demo

Binance Demo Trading (`demo-api.binance.com`) is the recommended pre-live environment: it uses
live-mirroring data and your real Binance account keys (with demo enabled on the account).

1. Create a Demo Trading API key at [demo.binance.com](https://demo.binance.com). Disable
   withdrawals on the key.
2. Set `TRADING_MODE=testnet` and `SANDBOX_ENV=demo` in `.env.app` (already the compose defaults).
3. Set demo keys in `.env`:

```dotenv
BINANCE_DEMO_API_KEY=your-demo-key-here
BINANCE_DEMO_API_SECRET=your-demo-secret-here
```

4. Run:

```bash
pnpm build
pnpm start
```

For sandbox internals (Demo vs Spot Testnet URL selection, venue capabilities, multi-symbol operation),
see the "Running against a sandbox" section of [docs/runbook.md](docs/runbook.md).

> **Note:** Binance Spot Testnet (`SANDBOX_ENV=testnet`) uses `BINANCE_TESTNET_*` keys and connects
> to `testnet.binance.vision`. The two key pairs are non-interchangeable. Testnet books are thin and
> synthetic; demo is the realistic sandbox.

---

## Configuration

**Secrets** (API keys, arming tokens): gitignored `.env` — copy from `.env.example`.

**Deploy knobs** (mode, strategy, risk limits, agentic tuning): committed `.env.app` (spot lane) and
`.env.app-perp` (perp profile). Docker compose loads `env_file: [lane file, .env]`; host `pnpm start`
loads `.env` then `.env.app` via `AppConfigModule`.

| Variable                              | File        | Meaning                                                                        |
| ------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `TRADING_MODE`                        | `.env.app`  | `paper` \| `testnet` \| `live`                                                 |
| `SANDBOX_ENV`                         | `.env.app`  | `demo` \| `testnet` — picks the Binance sandbox when `TRADING_MODE=testnet`    |
| `FEED_ENV`                            | `.env.app`  | Market-data feed environment (`live` = public Binance streams, no credentials) |
| `BINANCE_DEMO_API_KEY` / `_SECRET`    | `.env`      | Binance Demo Trading credentials (used when `SANDBOX_ENV=demo`)                |
| `BINANCE_TESTNET_API_KEY` / `_SECRET` | `.env`      | Binance Spot Testnet credentials (used when `SANDBOX_ENV=testnet`)             |
| `BINANCE_LIVE_API_KEY` / `_SECRET`    | `.env`      | Live credentials — read only when `TRADING_MODE=live`                          |
| `ARMING_SECRET`                       | `.env`      | HMAC key for the live arming handshake                                         |
| `TRADING_SYMBOLS`                     | `.env.app`  | Symbols the agentic lane trades (must each have a filter entry in risk module) |
| `STRATEGY_INTERVAL`                   | `.env.app`  | Candle interval: `1m` \| `5m` \| `15m` \| `1h` \| `4h` \| `1d`                 |
| `ACTIVE_STRATEGY`                     | `.env.app`  | Strategy lane — closed enum, `agentic` is the only registered lane             |
| `BASE_NOTIONAL`                       | `.env.app`  | Quote (USDT) per order                                                         |
| `STARTING_CASH`                       | `.env.app`  | In-memory quote balance the bot tracks (set near the account's USDT balance)   |
| `DATABASE_URL`                        | `.env.app`  | Postgres connection string — optional; paper/demo run fine without it          |
| `GRAFANA_ADMIN_PASSWORD`              | `.env`      | Grafana admin password (docker-compose)                                        |
| `PORT`                                | `.env.app`  | HTTP server port                                                               |
| `LOG_LEVEL`                           | `.env.app`  | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`                   |

Full knob list with comments: [`.env.app`](.env.app). Perp lane: [`.env.app-perp`](.env.app-perp).

---

## Testing

```bash
pnpm test              # unit tests + live-gate suite (required before any completion claim)
pnpm test:livegate     # live-gate suite only — proves paper is default; sacred, never skip
pnpm test:paper        # paper loop integration (no network)
pnpm test:cov          # unit + live-gate with coverage
pnpm test:db           # DB integration tests — requires Postgres at DATABASE_URL (must end in _test,
                       # or set DB_SUITE_ALLOW_RESET=1)
pnpm test:testnet      # order-lifecycle scenarios against the configured Binance sandbox —
                       # requires BINANCE_DEMO_* or BINANCE_TESTNET_* credentials; all-skipped
                       # green without them; intended for nightly runs
```

Run `pnpm build && pnpm lint && pnpm typecheck && pnpm test` before any pull request.

---

## Observability

The app exposes:

- `GET /metrics` — Prometheus metrics (mode, kill-switch state, order counts, fill latency, etc.)
- `GET /health/live` — liveness probe
- `GET /health/ready` — readiness probe (reports DB and market-data status)

In a docker-compose stack, Grafana at `http://localhost:3101` comes up with dashboards pre-provisioned
from `observability/grafana/provisioning/`. Prometheus scrapes the app on the configured interval.

`bootId` and `run_id` are threaded through every metric label and structured log line to correlate
events across a boot session.

---

## Architecture

The codebase is hexagonal (ports & adapters) in three rings. `src/domain/` is pure: no I/O, no
NestJS, no ccxt, no `Date.now`, no `process.env` — only typed domain logic (indicators, risk rules,
OMS state-machine reducer, paper fill model, mode/arming resolution). `src/ports/` holds interfaces
and DI tokens. `src/features/` contains the impure NestJS shells: `trading/agentic` (the LLM strategy
lane — StrategyHost, agent client, plan executor, promotion evaluator), `trading/market-data`,
`trading/risk`, `trading/execution`, `trading/exchange` (ccxt adapters + paper/perp adapters),
`trading/mode-control` (arming interlock, key probe, promotion readiness), and `common/observability`.
`src/database/` holds Drizzle repositories and schemas. `src/config/environment/` validates `AppConfig`
(Zod). `app.module.ts` is the composition root — the only file that knows concretions. The agentic lane
sits outside `src/domain`: it is async and calls an out-of-process LLM, so it is intentionally not
pure/deterministic (see CLAUDE.md rule 4).

Order path: **Strategy** (the agentic lane) emits Signals (conviction, no quantities) → **Risk** sizes
and vetoes → **Execution** stamps a `RiskApprovedIntent` (brand + HMAC proof) → **ExchangeAdapter**
places the order. Execution never widens its signature; strategies cannot import execution or adapter
code (`eslint-plugin-boundaries` enforces the wall).

This section and [Project layout](#project-layout) below are the current source of truth.
[docs/archive/design-plan.md](docs/archive/design-plan.md) is retained as a historical reference for
the original phased build order; it predates the agentic-lane rebuild and no longer describes the
current module layout.

---

## Safety & operations

Paper is the default and live is gated. In paper mode no credentials are needed and no orders reach
any venue. The live interlock requires four independent gates to hold simultaneously:

1. `TRADING_MODE=live` in the environment
2. A bootId-bound two-step arming handshake (`POST /mode/arm/request` → `POST /mode/arm/confirm`
   with an HMAC-SHA256 response) — armed session TTL is 8 hours
3. Exchange keys validated with withdrawals disabled (the probe's self-reported verdict is never
   trusted; ModeControl recomputes from the restriction snapshot)
4. Complete risk limits present in config

`NODE_ENV=test` or `CI` strips live secrets from the validated `AppConfig` and removes the live
adapter from the object graph entirely — CI cannot reach live.

Operational procedures (halt response, reconciliation mismatch recovery, re-arm after restart,
paper-honesty checks) are in [docs/runbook.md](docs/runbook.md).

---

## Project layout

```text
src/
  domain/                    pure domain logic — no I/O, NestJS, ccxt, Date.now, or process.env
    types/                   branded Decimal types (Price, Qty, Notional, …), Signal, OrderIntent, money
    indicators/              candle aggregation, technical indicators
    mode/                    arming + mode resolution (pure)
    oms/                     state-machine reducer, reconcile, recovery, position/fill math
    paper/                   paper fill model
    risk/                    pure rule functions, sizing, kill-switch, round-trips
    rng/                     seeded PRNG
  ports/                     interfaces + DI tokens only; imports domain types only
  config/environment/        AppConfig validation (Zod)
  database/                  Drizzle repositories, schemas, migration runner
  features/
    trading/
      agentic/                the LLM strategy lane — StrategyHost, agent client, prompt, plan
                               executor, promotion evaluator, reflection, playbook validator
      market-data/            ccxt stream adapter, normalization, feed health, derivatives/sentiment feeds
      risk/                   RiskEngine, sizer, kill-switch, signal gateway
      execution/               ExecutionService, OMS, fill ingestor, reconciliation, boot recovery
      exchange/                CcxtExchangeAdapter, live/paper/paper-perp adapters, error classifier
      mode-control/            ModeControl, arming interlock, key probe, promotion readiness
    common/observability/     Prometheus metrics, health endpoints, logger config
  shared/                     correlation middleware, exception filters, venue-safety guards
  app.module.ts               composition root
drizzle/                      schema definitions and migrations
observability/                Prometheus config, Grafana provisioning (dashboards + datasources)
docs/                         runbook.md, archive/ (historical), planning/, specs/
```

---

## Links

- [Architecture & design](#architecture) (current — this README)
- [Architecture & design (historical)](docs/archive/design-plan.md)
- [Operations runbook](docs/runbook.md)
