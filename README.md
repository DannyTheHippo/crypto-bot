# crypto-bot

A Binance **spot + USDⓈ-M perp** trading bot (one process, both venues) with paper-first defaults,
a four-gate live interlock, strict money-safety, a risk engine, a kill-switch, and full
observability. Written in NestJS 11 / TypeScript strict.

The active strategy lane is agentic — an LLM (`ACTIVE_STRATEGY=agentic`) proposes Signals on a
configurable candle interval. The older deterministic EMA-cross/donchian lane was retired (owner
decision 2026-07-03; historical write-up is git-history-only). The agentic lane stays paper/demo
until `PromotionReadinessService` certifies it (>=30 closed demo round trips and positive
net-of-cost PnL over >=14 days), on top of the unchanged four-gate live interlock. Paper mode
requires no credentials.

Three modes: **paper** (default — in-memory simulator driven by real market data), **testnet**
(real `CcxtExchangeAdapter` against a Binance sandbox — Demo Trading or Spot Testnet), and **live**
(real funds, four-gate interlock that cannot be satisfied in CI).

**Economics.** Sizing is capped at `equity = min(actualEquity, SIZER_EQUITY_CAP)` (~$1k production
cap). Spot trades a configured symbol basket with a deterministic scanner selecting the daily
active menu. Perps use isolated-margin leverage up to `PERP_LEVERAGE_CAP` with funding payments
ingested into net-of-cost PnL — same process, knobs in `.env.app` (no separate compose profile).

---

## Features / safety highlights

- **Paper is the default.** Any missing or invalid `TRADING_MODE` input safely resolves to paper.
- **Four-gate live interlock.** Env flag + bootId-bound arming handshake + withdrawals-disabled
  validated keys + complete risk limits. CI strips live secrets; live adapter absent in test/ci.
- **Money is never a native float.** `decimal.js` branded types; lint bans `parseFloat`/`Number()`
  on money paths; DB `NUMERIC(38,18)`; venue rounding is explicit and directional.
- **Append-only audit.** `audit_log` / `order_events` — no UPDATE/DELETE; DB triggers enforce.
- **Reconciliation HALT — no auto-flatten.**
- **Order path enforced.** Strategy → Risk → Execution → ExchangeAdapter (eslint boundaries).
- **OMS deduplication.** Persist intent before network; unknown ⇒ `OUTCOME_AMBIGUOUS`, never blind retry.

---

## Prerequisites

| Requirement          | Version                                                     |
| -------------------- | ----------------------------------------------------------- |
| Node.js              | >=22 (Node 24 recommended)                                  |
| pnpm                 | 10.32.1                                                     |
| Docker + Compose     | optional — Postgres + Prometheus + Grafana                  |
| Binance Demo account | optional — for testnet/demo mode                            |

---

## Quick start — local (paper mode)

```bash
pnpm install
cp .env.example .env        # secrets only
pnpm build
pnpm start
```

Health: `curl http://localhost:3100/health/ready`

Force paper: `TRADING_MODE=paper pnpm start`

---

## Quick start — docker-compose

```bash
docker compose up --build
```

| Service    | URL                   | Default credentials                          |
| ---------- | --------------------- | -------------------------------------------- |
| App        | http://localhost:3100 | —                                            |
| Grafana    | http://localhost:3101 | admin / admin (or `$GRAFANA_ADMIN_PASSWORD`) |
| Prometheus | http://localhost:9090 | —                                            |

---

## Configuration

**Secrets:** gitignored `.env` (from `.env.example`).

**Deploy knobs:** committed `.env.app` (one process / both venues). Compose loads
`env_file: [.env.app, .env]` (later wins). Host `pnpm start` loads `.env` then `.env.app`
via `AppConfigModule` (first path wins — same effective precedence).

| Variable | File | Meaning |
| -------- | ---- | ------- |
| `TRADING_MODE` | `.env.app` | `paper` \| `testnet` \| `live` |
| `SANDBOX_ENV` | `.env.app` | `demo` \| `testnet` when testnet mode |
| `AGENTIC_SHORTS_ENABLED` | `.env.app` | plan-mode shorts (perp-capable venue) |
| `PERP_LEVERAGE_CAP` | `.env.app` | isolated-margin leverage cap |
| `SIZER_EQUITY_CAP` | `.env.app` | hard cap on sizing equity |
| `BINANCE_*_API_KEY` / `_SECRET` | `.env` | demo / testnet / live keys |
| `ARMING_SECRET` | `.env` | live arming HMAC key |

Full knob list: [`.env.app`](.env.app).

---

## Testing

```bash
pnpm test              # features + domain + ports unit + livegate (required before completion claims)
pnpm test:livegate     # sacred — never skip
pnpm test:paper        # paper loop integration
pnpm test:cov          # coverage on the production gate suites
pnpm test:db           # Postgres integration
pnpm test:testnet      # sandbox order lifecycle (env-gated; nightly)
pnpm backtest          # research harness — OFF the production gate
pnpm checks            # format:check + lint:md + lint + typecheck + test
```

---

## Research

Non-runtime artifacts live under `research/`:

| Path | Role |
| ---- | ---- |
| `research/loop/{state,LOG}.md` | Tracked ops loop memory |
| `research/loop/digests/` | Ignored sweep runtime (digest JSON + watermark) |
| `research/scorecards/` | Tracked promoted eval/tournament scorecards |
| `research/candidates/` | Ignored ephemeral dumps / jsonl |
| `research/studies/` | Tracked study writeups |

Scripts: `pnpm loop:*`, `pnpm eval:*`, `pnpm backtest`, `pnpm fetch:edge-tournament`, `pnpm run:edge-tournament`.

---

## Observability

- `GET /metrics`, `GET /health/live`, `GET /health/ready`
- Grafana/Prometheus provisioned from `observability/`

---

## Architecture

Hexagonal rings with **domain buckets** repeated across layers (`common` · `venue` · `trading` ·
`strategy`):

- `src/domain/` — pure (no Nest/ccxt/`Date.now`/`process.env`)
- `src/ports/` — interfaces + DI tokens only
- `src/features/` — Nest implementations (leaves under group folders)
- `src/database/` — Drizzle schemas + bucketed repositories
- `src/config/`, `src/shared/` — config + cross-cutting infra

Order path: **Strategy** (`features/strategy/agentic`) → **Risk** → **Execution** →
**ExchangeAdapter**. Composition wiring lives in `features/trading/composition/` (app zone).

Detailed agent layout: [`.claude/CLAUDE.md`](.claude/CLAUDE.md) (generated/refreshed via `/init`).

---

## Project layout

```text
src/
  domain/{common,venue,trading,strategy}/   pure domain
  ports/{common,venue,trading,strategy}/    interfaces + tokens
  features/
    common/observability/
    venue/{exchange,market-data}/
    trading/{composition,risk,execution,mode-control}/
    strategy/agentic/
  database/{schemas/trading,repositories/{common,venue,trading,strategy}}/
  config/  shared/  app.module.ts
test/
  features/{common,venue,trading,strategy}/  # mirrors features
  domain/  ports/                            # pure + port contract specs
  paper/ livegate/ backtest/ eval/ db/ testnet/
research/{loop,scorecards,candidates,studies}/
docs/{runbook.md,planning/}
drizzle/  observability/  scripts/
```

---

## Safety & operations

See [docs/runbook.md](docs/runbook.md). Daily profitability loop:
[docs/planning/daily-profitability-loop.md](docs/planning/daily-profitability-loop.md).

---

## Links

- [Architecture](#architecture) (this README)
- [Operations runbook](docs/runbook.md)
- [Agent hard rules](CLAUDE.md)
