# Business context — github-dannythehippo-crypto-bot

Fetched 2026-07-24 from DannyTheHippo/crypto-bot (private, default branch main).

## Product context

- Binance spot trading bot with a separate USDⓈ-M perpetual lane; NestJS 11 / TypeScript strict; paper-first defaults; four-gate live interlock; money-safety, risk engine, kill-switch, observability. (README.md:L1-L8)
- Active strategy: agentic lane — LLM (`ACTIVE_STRATEGY=agentic`) proposes Signals. EMA-cross/donchian retired (owner decision 2026-07-03). (README.md:L4-L8; CLAUDE.md:L49-L58)
- Modes: paper (default), testnet, live (four-gate interlock). (README.md:L11-L14)
- Sizing capped at min(actualEquity, SIZER_EQUITY_CAP) (~$1k production). Spot: 24-symbol basket via UniverseScannerService. Perp: USDⓈ-M shorts up to 2x isolated leverage; funding in net-of-cost PnL. (README.md:L17-L22)
- Agentic live gate: PromotionReadinessService requires ≥30 closed demo round trips and positive net-of-cost PnL (realized − fees − LLM spend) over ≥14 days, on top of four live gates. (README.md:L7-L8; CLAUDE.md:L49-L54)
- v3 topology (2026-07-21): one Nest process runs binance spot + binanceusdm against one Postgres and one Prometheus. (docs/runbook.md:L12-L16)
- Daily profitability loop: 2–4 passes/day toward promotion gate. (docs/planning/daily-profitability-loop.md:L14-L22)

## Domain glossary

| Term | Meaning |
|------|---------|
| Signal | Strategy output with conviction, no quantities; sized/vetoed by Risk |
| RiskApprovedIntent | Execution-only input: brand + HMAC proof after Risk approval |
| Order path | Strategy → Risk → Execution → ExchangeAdapter |
| Four-gate live interlock | TRADING_MODE=live + bootId-bound arming + withdrawals-disabled keys + complete risk limits |
| PromotionReadinessService | Certifies agentic lane for live attempt |
| OUTCOME_AMBIGUOUS | OMS unknown order outcome; never retried blind |
| Kill-switch | RUNNING → HALTING → HALTED (+ FLATTENING, HALTED_DEGRADED) |
| Reconciliation mismatch | HALTs; never auto-flattens |
| Net-of-cost PnL | realizedPnl − fees − llmCostUsd |
| domain ring | Pure logic — no I/O, NestJS, ccxt, Date.now, process.env |
| agentic lane | Async LLM strategy outside src/domain |
| edge program / backtest | Research harness; OFF production test gate |

## Stakeholders

- DannyTheHippo — repo owner, sole listed contributor (gh contributors / users API)
- @octopus-tech — company on owner GitHub profile
- Owner — decision authority for lane retirement, v3 cutover, promotion evidence

## Integrations

Binance Spot; Binance Demo Trading (demo-api.binance.com); Binance Spot Testnet (testnet.binance.vision); Binance USDⓈ-M (binanceusdm); ccxt 4.5.58 (pinned); out-of-process LLM; Postgres 16 + Drizzle; Prometheus; Grafana; Docker Compose (app, postgres, prometheus, grafana).

## Related work

- EMA-cross/donchian retired 2026-07-03
- v3 one-book consolidation cutover 2026-07-21
- Edge program / backtest rebuilt 2026-07-10 (off production gate)
- Daily profitability loop v4 playbook active
- docs/archive/design-plan.md superseded
- No GitHub Issues/PRs as of fetch

## Internal dependencies

Stack: NestJS 11.1.x, TypeScript strict, Node ≥22, pnpm, Postgres 16, Drizzle, ccxt 4.5.58, decimal.js, Vitest.

Hexagonal rings: src/domain (pure), src/ports, src/features (Nest shells), src/database, src/config/environment, app.module.ts composition root.

Config: deploy knobs in .env.app; secrets in gitignored .env.

Repo About gaps: no description, topics, license, releases, wiki, or discussions.