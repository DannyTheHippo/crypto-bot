---
type: domain-glossary
description: Canonical definitions of project jargon.
keywords: [glossary, signal, risk, oms, paper, livegate]
alwaysApply: false
sources: [local-claude-root, local-claude-agent]
last_synced: "2026-07-25"
---

# Domain glossary

_Synthesized from local `CLAUDE.md` and `.claude/CLAUDE.md` — no external fetch._

## A

### Agentic lane

The sole active strategy implementation under `src/features/strategy/agentic/`. Async, LLM-driven;
proposes **Signals** only — risk still sizes and vetoes; live boot requires promotion readiness plus
the four live gates.

## B

### Bucket (domain group)

One of `common`, `venue`, `trading`, `strategy` — shared names across `domain/`, `ports/`,
`features/`, and `database/repositories/`.

## F

### Four-gate live interlock

Env flag + bootId-bound arming handshake + withdrawals-disabled validated keys + complete risk
limits. All must pass before live trading; CI strips live secrets.

## O

### OMS (order management)

Intent persistence before network; unknown outcomes ⇒ query by `clientOrderId`; unknown >60s ⇒ kill
switch; unmapped errors are `OUTCOME_AMBIGUOUS`, never blind-retried.

## P

### Paper mode

Default trading mode when `TRADING_MODE` is missing or invalid. In-memory fill simulation driven by
real market data.

### Promotion readiness

`PromotionReadinessService` verdict required before agentic live boot: ≥30 closed demo round trips
and positive net-of-cost PnL (realized − fees − LLM spend) over ≥14 days.

## R

### RiskApprovedIntent

Branded order intent with HMAC proof — the only shape execution accepts from risk.

## S

### Signal

Strategy output proposing direction/symbol/context; not an order until risk approves and sizes it.
