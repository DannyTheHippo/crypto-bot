---
type: product-context
description: What the product does and why it exists.
keywords: [product, trading, bot, paper, live, agentic]
alwaysApply: false
sources: [local-readme, local-claude-root]
last_synced: "2026-07-25"
---

# Product context

_Synthesized from local `README.md` and `CLAUDE.md` — no external fetch._

## What this project is

A Binance **spot + USDⓈ-M perp** trading bot (one NestJS process, both venues) with paper-first
defaults, a four-gate live interlock, strict money-safety, a risk engine, kill-switch, and full
observability.

## Why it exists

Automate discretionary-style crypto trading with safety rails: exact decimal money handling, enforced
order path (Strategy → Risk → Execution → ExchangeAdapter), append-only audit, and reconciliation
HALT without auto-flatten.

## Core modes

1. **Paper** (default) — in-memory simulator on real market data; no credentials required.
2. **Testnet** — real `CcxtExchangeAdapter` against Binance sandbox (Demo Trading or Spot Testnet).
3. **Live** — real funds; four-gate interlock + bootId-bound arming; never satisfiable in CI.

## Active strategy lane

Agentic only (`ACTIVE_STRATEGY=agentic`): an LLM proposes **Signals** on a configurable candle
interval. Live access requires `PromotionReadinessService` certification (≥30 closed demo round trips,
positive net-of-cost PnL over ≥14 days) on top of the four live gates. The retired deterministic
EMA-cross/donchian lane is git-history-only.

## Out-of-scope

- Blind order resubmit on unknown outcomes (OMS queries by `clientOrderId` first).
- Strategy bypass of risk or execution.
- Native floats on money paths.
- UPDATE/DELETE on `audit_log` / `order_events`.
