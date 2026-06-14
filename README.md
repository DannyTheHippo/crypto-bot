# crypto-bot

A Binance spot trading bot with paper-first defaults, a four-gate live interlock, strict money-safety,
a risk engine, a kill-switch, and full observability. Written in NestJS 11 / TypeScript strict. Runs
an EMA-cross strategy on configurable timeframes; paper mode requires no credentials and no network
access to the exchange.

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
cp .env.example .env        # review; defaults to TRADING_MODE=testnet — change to paper if desired
pnpm build
pnpm start
```

The server starts on `http://localhost:3000` (configurable via `PORT`). Confirm it is healthy:

```bash
curl http://localhost:3000/health/ready
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

With no credentials in the environment, the app resolves to paper mode automatically. Service URLs:

| Service    | URL                   | Default credentials                          |
| ---------- | --------------------- | -------------------------------------------- |
| App        | http://localhost:3000 | —                                            |
| Grafana    | http://localhost:3001 | admin / admin (or `$GRAFANA_ADMIN_PASSWORD`) |
| Prometheus | http://localhost:9090 | —                                            |

Grafana dashboards and Prometheus scrape config are provisioned automatically from `observability/`.

---

## Running against Binance Demo

Binance Demo Trading (`demo-api.binance.com`) is the recommended pre-live environment: it uses
live-mirroring data and your real Binance account keys (with demo enabled on the account).

1. Create a Demo Trading API key at [demo.binance.com](https://demo.binance.com). Disable
   withdrawals on the key.
2. Set in `.env`:

```dotenv
TRADING_MODE=testnet
SANDBOX_ENV=demo
BINANCE_DEMO_API_KEY=your-demo-key-here
BINANCE_DEMO_API_SECRET=your-demo-secret-here
```

3. Run:

```bash
pnpm build
pnpm start
```

A complete annotated round-trip run (EMA-cross BUY → SELL on BTC/USDT, fills matched against the
demo account ledger) is documented in [docs/demo-trading-run.md](docs/demo-trading-run.md).

> **Note:** Binance Spot Testnet (`SANDBOX_ENV=testnet`) uses `BINANCE_TESTNET_*` keys and connects
> to `testnet.binance.vision`. The two key pairs are non-interchangeable. Testnet books are thin and
> synthetic; demo is the realistic sandbox.

---

## Configuration

Key environment variables (full list with comments in `.env.example`):

| Variable                              | Meaning                                                                        | Default in `.env.example` |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------- |
| `TRADING_MODE`                        | `paper` \| `testnet` \| `live`                                                 | `testnet`                 |
| `SANDBOX_ENV`                         | `demo` \| `testnet` — picks the Binance sandbox when `TRADING_MODE=testnet`    | `demo`                    |
| `FEED_ENV`                            | Market-data feed environment (`live` = public Binance streams, no credentials) | `live`                    |
| `BINANCE_DEMO_API_KEY` / `_SECRET`    | Binance Demo Trading credentials (used when `SANDBOX_ENV=demo`)                | —                         |
| `BINANCE_TESTNET_API_KEY` / `_SECRET` | Binance Spot Testnet credentials (used when `SANDBOX_ENV=testnet`)             | —                         |
| `BINANCE_LIVE_API_KEY` / `_SECRET`    | Live credentials — read only when `TRADING_MODE=live`                          | —                         |
| `ARMING_SECRET`                       | HMAC key for the live arming handshake                                         | —                         |
| `TRADING_SYMBOL`                      | Symbol to trade (must have a filter entry in risk module)                      | `BTC/USDT`                |
| `STRATEGY_INTERVAL`                   | Candle interval: `1m` \| `5m` \| `15m` \| `1h` \| `4h` \| `1d`                 | `1m`                      |
| `EMA_FAST` / `EMA_SLOW`               | EMA periods for the cross strategy                                             | `3` / `5`                 |
| `BASE_NOTIONAL`                       | Quote (USDT) per order                                                         | `100`                     |
| `STARTING_CASH`                       | In-memory quote balance the bot tracks (set near the account's USDT balance)   | `5000`                    |
| `DATABASE_URL`                        | Postgres connection string — optional; paper/demo run fine without it          | _(unset)_                 |
| `GRAFANA_ADMIN_PASSWORD`              | Grafana admin password (docker-compose)                                        | `grafana`                 |
| `PORT`                                | HTTP server port                                                               | `3000`                    |
| `LOG_LEVEL`                           | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`                   | `debug`                   |

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

In a docker-compose stack, Grafana at `http://localhost:3001` comes up with dashboards pre-provisioned
from `observability/grafana/provisioning/`. Prometheus scrapes the app on the configured interval.

`bootId` and `run_id` are threaded through every metric label and structured log line to correlate
events across a boot session.

---

## Architecture

The codebase is hexagonal (ports & adapters) in three rings. `src/domain/` is pure: no I/O, no
NestJS, no ccxt, no `Date.now`, no `process.env` — only typed domain logic (strategy, risk rules,
sizing, OMS state-machine reducer, paper fill model). `src/ports/` holds interfaces and DI tokens.
`src/modules/` contains the impure NestJS shells (market-data, strategy, risk, execution,
exchange-adapter, persistence, observability, config, mode-control, trading). `app.module.ts` is the
composition root — the only file that knows concretions.

Order path: **Strategy** emits Signals (conviction, no quantities) → **Risk** sizes and vetoes →
**Execution** stamps a `RiskApprovedIntent` (brand + HMAC proof) → **ExchangeAdapter** places the
order. Execution never widens its signature; strategies cannot import execution or adapter code.

See [docs/design-plan.md](docs/design-plan.md) for the full architecture, module contracts, OMS
design, risk rules, persistence schema, and phased build order.

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

```
src/
  domain/          pure domain logic — strategy, risk rules, sizing, OMS reducer, paper fill model
    types/         branded Decimal types (Price, Qty, Notional, …), MarketEvent, Signal, OrderIntent
    strategy/      EMA-cross and other strategy implementations
    risk/          pure rule functions
    sizing/        pure sizing math
    oms/           state-machine reducer
    paper/         paper fill model
  ports/           interfaces + DI tokens only; imports domain types only
  modules/         NestJS modules (impure shells)
    config/        AppConfig validation (Zod)
    market-data/   WS ingestion, normalization, feed health
    strategy/      StrategyHost, signal dispatch
    risk/          RiskEngine, sizer, filters
    execution/     ExecutionService, OMS, fill ingestor
    exchange-adapter/  CcxtExchangeAdapter (testnet/demo/live) + PaperExchangeAdapter
    persistence/   Drizzle repositories, migration runner
    mode-control/  ModeControl, arming interlock, key probe
    observability/ Prometheus metrics, health endpoints
    trading/       TeeingMarketStream, DemoFillPollerService, boot driver
  app.module.ts    composition root
drizzle/           schema definitions and migrations
observability/     Prometheus config, Grafana provisioning (dashboards + datasources)
docs/              design-plan.md, runbook.md, demo-trading-run.md
```

---

## Links

- [Architecture & design](docs/design-plan.md)
- [Operations runbook](docs/runbook.md)
- [Demo trading run walkthrough](docs/demo-trading-run.md)
