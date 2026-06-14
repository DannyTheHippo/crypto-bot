# Crypto Trading Bot — Design Plan

## Context

Greenfield repository (`crypto-bot`, currently empty). Objective: design a crypto trading bot where **paper trading is the default mode** and live trading is a switchable, multiply-gated mode. This document is the complete design for later build sessions: stack decision, architecture, module contracts, exchange connectivity, risk, order lifecycle, persistence, observability, testing, mode gating, a proposed CLAUDE.md, open questions, and a phased build order. Plan only — no code exists yet.

Volatile external facts (URLs, versions, deprecations) were verified against primary sources on 2026-06-11/12: the ccxt v4.5.58 GitHub source, npm registry, Binance spot-api-docs (incl. testnet changelog), NestJS/Drizzle/decimal.js release pages. Facts marked **[volatile]** must be re-verified at implementation time.

---

## Stack Decision

**Decision: NestJS + TypeScript. It fits. No alternative stack is proposed.**

Pinned: **NestJS 11.1.x · Node.js 24 LTS (engines ≥22) · TypeScript strict · pnpm · ccxt 4.5.58 (pinned exact) · decimal.js 10.6.x · PostgreSQL 16 · Drizzle ORM · Vitest** [volatile — re-verify minors at `pnpm install` time]. NestJS v12 (ESM-only) is expected ~Q3 2026: build ESM-migration-friendly (no `require.main`/`__dirname` idioms), but do not wait for it.

Justification against the stated workload facts:

| Workload fact                                        | Fit assessment                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single Node event loop                               | The workload is I/O-bound: WS ingestion, REST calls, DB writes, timers — Node's native shape. The only CPU risk is strategy math, addressed below.                                                                                                                   |
| WS market-data ingestion, reconnection, backpressure | ccxt's JS/TS build is the _reference implementation_ (Python/PHP are transpiled from it); ccxt pro `watch*` methods are bundled in the main package (`ccxt.pro.binance`). Pull-based async iterables + per-channel bounded queues give explicit backpressure (§3.3). |
| Scheduled jobs                                       | `@nestjs/schedule` 6.1.x (cron v4; `waitForCompletion: true` prevents overlapping runs — directly relevant to reconciliation/equity-sampling loops; `SchedulerRegistry` for dynamic per-strategy jobs).                                                              |
| REST order placement                                 | ccxt unified REST, native async/await; NestJS DI swaps the adapter per mode (paper/testnet/live).                                                                                                                                                                    |
| Persistence                                          | node-postgres returns `NUMERIC` as strings by default — exact precision at the driver boundary (§7).                                                                                                                                                                 |

Structural fit: NestJS modules + DI tokens give _enforceable_ boundaries (backed by lint zones, §1.2), lifecycle hooks for ordered teardown, `@nestjs/terminus` 11.1.x health endpoints, guards on the admin API. Known v11 facts honored: termination hooks run in **reverse module-initialization order**, but providers _within one module_ destroy concurrently — therefore shutdown ordering (stop strategies → cancel orders per policy → close ccxt pro streams → flush) is expressed as **module dependency structure**, not provider order. `app.enableShutdownHooks()` is mandatory.

**Event-loop blocking risk — addressed explicitly:**

- Indicator math at candle/tick cadence (EMA, RSI, ATR over bounded windows) is microseconds per event; it stays on the event loop under a **hard CPU budget: 10 ms soft / 50 ms hard per strategy event handler**, measured by the host via `process.hrtime.bigint()`; 3 consecutive hard breaches auto-transition the strategy to DRAINING + alert.
- Heavier strategies (ML inference, large matrix ops) move behind a `StrategyRunner` boundary inside StrategyHost: `InProcessRunner` vs `WorkerRunner` (worker_threads pool via **piscina 5.1.x**) implement the same interface; the worker receives the identical ordered event stream (Decimals as canonical strings), is single-flight, and its mailbox conflates exactly like a slow in-process strategy — determinism preserved. Worker crash ⇒ strategy HALTED, never silent restart (state is lost). Backtesting/optimization runs as a **separate process**. Piscina is deferred until profiling justifies it; event-loop monitoring (`perf_hooks.monitorEventLoopDelay`, `eventLoopUtilization`) is wired from day one so the decision is data-driven.

**JS floating-point hazard — mandated away:**

- **Money is never a native `number`.** Prices, quantities, notionals, fees, balances, PnL are `decimal.js` `Decimal` wrapped in branded types (`Price`, `Qty`, `Notional`, `FeeAmount`) minted only by smart constructors that throw on NaN/∞/≤0/precision overflow.
- Bootstrap policy: `Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -19, toExpPos: 39 })` (exp bounds prevent exponential-notation strings reaching the DB). The ledger never rounds implicitly; venue-facing values are rounded **explicitly and directionally** (ROUND_DOWN/ROUND_UP per side) against the symbol's `tickSize`/`stepSize`.
- ccxt is constructed with `number: String` so unified REST and pro parse pipelines return strings (§3.2). **Known exception [volatile]:** ccxt pro _order-book caches_ store native floats unconditionally — order books are treated as reference-grade market data; where exactness matters, raw strings are read from `.info`. Fills, orders, balances are always exact strings → Decimal.
- DB columns `NUMERIC(38,18)`; JSON wire format uses strings. Enforced by ESLint (`no-restricted-syntax` banning `parseFloat`/`Number()`/arithmetic operators on money-typed values outside `domain/types/money.ts`; `toBeCloseTo` banned in money tests) plus a CI schema lint rejecting float/double money columns.

**Stated latency boundary:** decision cadence ≥ ~100 ms (candles, tickers). Not an HFT design; sub-10 ms market-making would be a different system (colocated, native venue protocols) — out of scope, flagged so nobody discovers it the hard way.

---

## Connectivity Assumption — Accepted, With Flags

ccxt / ccxt pro behind an adapter interface is accepted. Flags:

1. **ccxt does not unify paper-fill semantics** (as stated) — and exchange testnets are _also_ unrepresentative (thin, synthetic books; Binance positions its Demo environment, not the testnet, as realistic). Consequence: the internal `PaperExchangeAdapter` driven by **production market data** is the primary strategy-evaluation substrate; exchange testnets validate _connectivity and order plumbing_, not strategy performance.
2. ccxt's unified layer adds per-call overhead and occasionally lags venue API changes. Acceptable at our cadence; the ports (§3.1) let a venue-native client replace ccxt per venue without touching domain code.
3. ccxt parses to JS floats by default — mitigated via `number: String` + the order-book caveat above.
4. **[volatile]** ccxt maintainers have stated `setSandboxMode` for Binance may be repointed at the demo environment "in the near future" (ccxt issue #27266). Mitigation: a pinned ccxt version plus a **regression test asserting which base URLs sandbox/demo modes resolve to** — URL drift fails CI loudly instead of trading against the wrong environment.

## 1. Architecture Overview

Hexagonal (ports & adapters), three rings:

```
src/
  domain/            ← PURE. No I/O, no @nestjs/*, no ccxt, no Date.now, no process.env.
    types/           # branded Decimals, ids, MarketEvent/Signal/OrderIntent/ExecReport...
    strategy/        # Strategy implementations + indicator math
    risk/rules/      # pure rule functions (intent, snapshot, limits) → RuleVerdict
    sizing/          # pure sizing math
    oms/reducer.ts   # pure state-machine reducer: (OrderRecord, OrderEvent) → OrderRecord | TransitionError
    paper/fill.ts    # pure fill model: (restingOrder, MarketEvent, prngState) → SimFill[]
  ports/             ← interfaces + DI tokens only; imports domain types only
  modules/           ← NestJS modules (impure shells): market-data/ strategy/ risk/ execution/
                       exchange-adapter/ persistence/ observability/ config/ mode-control/
  app.module.ts      ← composition root — the only file that knows concretions
```

**Primary data flow (every hop journals to Persistence):**

```
 Exchange WS ──► MarketData (normalize, string→Decimal, seq-stamp, book maintenance,
                 conflation/bounded queues, gap & staleness flags)
                    │  MarketEvent (Ticker/Trade/Candle/OrderBookSnapshot)
                    ▼
                 StrategyHost ──► Strategy (pure, sync) ──► Signal[]  (conviction, no quantities)
                    ▼
                 Risk: SignalGateway (TTL, dedupe, kill-switch fast-fail)
                       → PositionSizer (Signal → OrderIntent, vs snapshot incl. in-flight)
                       → RiskEngine.evaluate (veto/clamp; sole minter of RiskApprovedIntent)
                    │  RiskApprovedIntent  (branded + HMAC proof — unforgeable, §4.2)
                    ▼
                 Execution/OMS (proof verify, write-ahead persist, idempotent clientOrderId,
                                state machine, retries-with-query)
                    ▼
                 ExchangePort (ccxt adapter: testnet/demo/live ─ or ─ PaperExchangeAdapter) ──► venue
                    ▲                                                  │
                    └────── ExecReports (user-data WS / sim) ◄─────────┘
                          ▼
                 Outbox (DB write-ahead, cursor, dedupe) ──► OMS reducer ──► Portfolio/PnL ──► Metrics
```

**Separate reconciliation path** (never shares code with the happy path):

```
 Triggers: 30 s timer (5 s while any *_UNKNOWN exists) · post-reconnect · post-unknown ·
           startup · always before live arming
   ──► ReconciliationService ──► ExchangePort: fetchOpenOrders / fetchBalances / fetchMyTrades(since checkpoint − overlap)
   ──► compare vs local truth (by clientOrderId / venue tradeId / balance epsilon)
   ──► benign: ingest + WARN   |   material: KillSwitch.engage(HALT) + page  (taxonomy §6.4)
```

**Mode axis:** `TradingMode = 'paper' | 'testnet' | 'live'`, default paper (§10). `ModeControl` resolves it at boot; the composition root binds `ExchangePort` accordingly — in paper mode the live adapter is **not constructed and not present in the object graph**. Market data always flows from real venues (production public endpoints in paper mode). When mode = testnet, `VenueConfig.environment ∈ {'testnet','demo'}` selects the sandbox flavor (§3.5).

**Eventing:** pull-based typed `AsyncIterable` streams on the trading path (explicit consumer pace); Nest's event bus only for low-rate control-plane fan-out (mode transitions, config changes, observability). **Three clocks, never conflated:** `eventTime` (exchange — the only clock strategies see), `ingestTime` (local receipt — latency/staleness math), wall time via injected `ClockPort` (infra only: TTLs, schedules; fake in tests/replay). Clock skew (`ingestTime − eventTime`) is monitored; sustained skew trips DEGRADED rather than mass-rejecting signals.

**Concurrency:** one process, one event loop (+ optional worker pool). Single-writer discipline: only OMS mutates order/position state; only MarketData mutates book state; signals are processed serially per symbol (race-free crossing registry, §5). A Postgres advisory lock per (venue, apiKey) at startup prevents a second bot instance trading the same key.

## 2. Module Boundaries

Nine NestJS modules. Format: responsibility / public interface (the _only_ injectable surface, as `Symbol` tokens bound to port interfaces) / MUST-NOT.

Boundary enforcement is three-layered: (1) token-only exports — concrete classes never appear in `exports:`; (2) **lint-enforced import zones** (`eslint-plugin-boundaries`): `domain` imports only `domain`; `ports` imports only `domain`; `modules/X` imports `domain`, `ports`, own subtree — never `modules/Y`; only `app.module.ts` sees concretions. CI fails on violation — this is the actual wall; (3) curated per-module `imports:` lists — `EXCHANGE_PORT`/`EXECUTION_GATE` are unresolvable from the Strategy module's container scope, so a strategy cannot even be _wired_ to the exchange.

### 2.1 MarketDataModule

- **Responsibility:** consume `ExchangeStreamPort`; normalize to `MarketEvent` (string→Decimal at the seam); maintain local order books (snapshot+delta, checksum, gap detection); assign local `seq` per (venue, symbol, channel); stamp `gapBefore`/`stale`/`conflatedCount` flags; candle aggregation + REST backfill for warmup; per-stream staleness watchdogs; own all market-side queues (§3.3).
- **Public:** `MARKET_STREAM: subscribe(spec: SubscriptionSpec): AsyncIterable<MarketEvent>` · `FEED_HEALTH: health(venue, symbol, channel): ChannelHealth` (`LIVE | DEGRADED | GAP`) · `getRefPrice(symbol): { mid: Price; at: EpochMs } | undefined` · `fetchCandles(...)` (historical).
- **MUST NOT:** place/cancel orders; hold trade-permission credentials; emit floats or raw ccxt structures; drop a _closed_ candle silently (that is an incident, not a conflation); fabricate `eventTime` (use `ingestTime` + `eventTimeSynthetic: true`); resume post-reconnect delivery before book checksum passes and a fresh ticker arrives.

### 2.2 StrategyModule

- **Responsibility:** host pure strategies: registry, lifecycle (LOADING → WARMUP → ACTIVE → DRAINING → HALTED → UNLOADED), warmup replay with signals **discarded host-side**, per-strategy mailboxes (merge priority: execReports > closed candles > trades > conflated book/ticker), CPU budget enforcement, `StrategyRunner` worker escape hatch.
- **Public:** `STRATEGY_REGISTRY: register/enable(id, cfg)/disable(id, drain: DrainPolicy)/states()` · `STRATEGY_HOST: start/stop/signals(): AsyncIterable<Signal>` — consumed exclusively by Risk's SignalGateway.
- **MUST NOT:** import/inject anything from execution, exchange-adapter, or persistence (lint zone + container scope); let a strategy perform I/O, see wall time, balances, equity, or other strategies' state (strategies get the reduced `StrategyPortfolioView`: own attributed position + own open orders only — a strategy that can see equity _will_ eventually size itself, and that path must not exist); emit quantities (Signals carry conviction; sizing is Risk's).

### 2.3 RiskModule

- **Responsibility:** **owns sizing and veto** — quantity is a risk decision: `SignalGateway` (TTL, dedupe, serial-per-symbol) → `PositionSizer` (Signal → OrderIntent vs one shared snapshot incl. `inFlightIntents`; lot/tick/minNotional rounding; below-minimum ⇒ SizingRejection, never a dust order) → `RiskEngine.evaluate` (synchronous on purpose — no awaits between snapshot read and verdict). Sole minter of `RiskApprovedIntent`. Owns the kill switch, the order-rate buckets, the symbol-level open-interest registry (crossing detection), and worst-case exposure reservations for `*_UNKNOWN` orders.
- **Public:** `POSITION_SIZER` · `RISK_ENGINE: evaluate(intent, snapshot): RiskDecision` · `KILL_SWITCH: engage(reason)/state()` · `RiskLimitsConfig` type.
- **MUST NOT:** call any exchange (flatten is expressed as reduce-only intents through Execution); mutate the portfolio; approve anything while the kill switch is engaged (reduce-only carve-out excepted, §5); release a decision that has not been journaled; approve when any limit is `undefined` (limits-completeness rule — defense in depth behind ModeControl gate (d)).

### 2.4 ExecutionModule (OMS)

- **Responsibility:** verify approval proofs (hash + HMAC + nonce + TTL); write-ahead intent persistence; deterministic clientOrderId; the order state machine (§6, pure reducer in domain); retry policy with query-before-resubmit; partial fills, fee ledger, TTL auto-cancel, cancel races; the **exec-report outbox** (DB write-ahead, cursor, `reportId` dedupe — never-drop); canonical portfolio state with per-strategy virtual sub-accounts; equity sampling input.
- **Public:** `EXECUTION_GATE: submit(approved: RiskApprovedIntent): Promise<SubmitAck>` · `cancel(clientOrderId, reason)` · `cancelAllFor(strategyId)` (drain) · `flattenAll(reason)` (kill-switch path) · `PORTFOLIO_VIEW: snapshot(): PortfolioSnapshot` / `forStrategy(id): StrategyPortfolioView` · `EXEC_REPORT_STREAM: consume(consumerId, fromCursor)` (durable, resumable).
- **MUST NOT:** accept a bare `OrderIntent` (no such overload exists; runtime proof check on top); resize/reprice an approved intent; submit without re-checking `ModeControl.assertCanTrade()` and `intent.mode === effectiveMode` _at submission time_; reuse a clientOrderId across modes; blind-resubmit on unknown outcome; drop, conflate, or reorder exec reports; synthesize fills without a venue tradeId.

### 2.5 ExchangeAdapterModule

- **Responsibility:** `ExchangePort` + `ExchangeStreamPort` implementations: `CcxtExchangeAdapter` (per-venue env selection, string-mode numerics, error → `AdapterErrorClass` mapping, rate limiting), `PaperExchangeAdapter` (§6.5 — same ports, ccxt-shaped errors, same event bus; the OMS cannot tell it from a real venue); capability detection; credential validation incl. permission probes.
- **Public:** per-venue tokens `EXCHANGE_PORT(venue)`, `EXCHANGE_STREAM(venue)` · `VenueCapabilities`.
- **MUST NOT:** business logic; auto-retry `placeOrder` on ambiguous failure (surface `OUTCOME_AMBIGUOUS`; OMS resolves); pass ccxt floats upward; log secrets (ccxt errors can embed request headers — deep redaction paths); construct a live-keyed client unless ModeControl authorizes (§10).

### 2.6 PersistenceModule

- **Responsibility:** Drizzle repositories for the §7 schema; the append-only `audit_log` and `order_events` journal; outbox tables; migrations (plain SQL via drizzle-kit — required for REVOKE/trigger DDL); transaction control for write-ahead patterns (intent persisted in tx1; exchange called _outside_ any tx; result + audit in tx2).
- **Public:** typed repo tokens (`ORDER_REPO`, `FILL_REPO`, `JOURNAL: append(entry): Promise<cursor>`, `OUTBOX`, …).
- **MUST NOT:** domain decisions; exchange calls; float money columns (CI schema lint); be bypassed by modules writing SQL directly; mix paper/live rows without the `mode` discriminator in every trading table.

### 2.7 ObservabilityModule

- **Responsibility:** nestjs-pino structured logging (correlation chain `md.seq → signalId → intentId → clientOrderId → exchangeOrderId → fillId`, plus `bootId`, `mode`, `run_id` on every record; pino `redact` paths for secrets); prom-client 15 metrics via @willsoto/nestjs-prometheus (`/metrics`); terminus `/health/live` + `/health/ready`; event-loop monitors.
- **Public:** `METRICS` (typed instruments per §8) · `AUDIT: record(e)` (fire-and-forget bounded queue; overflow = counter + alert, never backpressure).
- **MUST NOT:** be load-bearing (no control flow reads logs/metrics); block the hot path; log key material or full signed payloads.

### 2.8 ConfigModule

- **Responsibility:** boot-time env + file config, zod-validated through `ConfigModule.forRoot({ validate })` into one frozen `AppConfig`; typed namespaces via `registerAs`/`ConfigType`; fail-fast on invalid; config hash + `config_snapshots` row at boot and on every accepted change; hot-reload only for an allowlisted subset (strategy params/enablement); exposes `bootId` (random per process start).
- **MUST NOT:** expose raw `process.env`; hot-reload `TRADING_MODE`, credentials, or risk limits (restart + re-arm required); parse money (validated strings handed to domain smart constructors); log secret values.

### 2.9 ModeControlModule

- **Responsibility:** sole owner of mode resolution and the arming interlock (§10); continuous precondition re-evaluation (armed TTL on every call; key probe every 60 s); the guard Execution calls per order; anomaly intake (`raise(AnomalyClass, …)`) that can freeze symbols or engage the kill switch.
- **Public:** `MODE_CONTROL: resolveMode(): ModeResolution` (re-evaluated per call — consumers must not cache) · `armLive(req): ArmResult` · `disarm(reason)` (sync, idempotent) · `assertCanTrade(intentMode): void` (throws `ModeViolationError`).
- **MUST NOT:** place orders; trust the env flag alone; persist armed state; auto-rearm after any halt; be bypassable (Execution and the live-adapter factory consult it independently).

## 3. Exchange Connectivity

### 3.1 Ports (contracts)

```ts
interface ExchangeStreamPort {
  marketRaw(spec: SubscriptionSpec): AsyncIterable<RawVenueEvent>; // consumed only by MarketData
  userEvents(): AsyncIterable<RawUserEvent>; // consumed only by Execution
}

interface ExchangePort {
  readonly venue: VenueId;
  readonly capabilities: VenueCapabilities; // clientOrderId, fetchOrderByClientId, wsUserStream, stp, sandbox…
  placeOrder(req: PlaceOrderRequest): Promise<ExchangeAck>; // money as canonical strings at this seam
  cancelOrder(clientOrderId: ClientOrderId, symbol: SymbolId): Promise<ExchangeAck>;
  fetchOrder(clientOrderId: ClientOrderId, symbol: SymbolId): Promise<ExchangeOrderState>; // MUST support client-id lookup
  fetchOpenOrders(symbol?: SymbolId): Promise<readonly ExchangeOrderState[]>;
  fetchBalances(): Promise<ReadonlyMap<AssetId, { free: string; locked: string }>>;
  fetchMyTrades(symbol: SymbolId, since: EpochMs): Promise<readonly Fill[]>;
  validateCredentials(): Promise<CredentialCheck>; // auth probe + permission flags (§10c)
}
```

### 3.2 ccxt adapter specifics (verified against ccxt 4.5.58 source — [volatile])

- **Package:** ccxt pro is bundled — `new ccxt.pro.binance({...})`; no separate dependency. Pin the exact version; the error-class mapping and sandbox URL resolution get **snapshot tests** so a ccxt bump that remaps either fails CI.
- **String numerics:** construct with `number: String` — all unified `parseNumber`-based structures (REST and pro `watchTrades/watchTicker/watchOrders/watchBalance`) return strings. Exception: pro **order-book caches store floats unconditionally** (`OrderBookSide` + `safeFloat`) — books are reference-grade; exact values read from `.info` when needed.
- **Capability detection:** `exchange.has` for coarse method existence; `exchange.features[marketType]` (per-market-type tree: `createOrder.timeInForce.{IOC,FOK,PO}`, `triggerPrice`, `fetchMyTrades.daysBack`, …) for parameter-level capability. `features` is still being populated across venues — wrap access behind one adapter helper; missing _required_ capability ⇒ refuse to start the venue (fail-fast).
- **Rate limiting:** `enableRateLimit` defaults true; one cost-aware leaky-bucket throttler per exchange instance (per-endpoint weights via `calculateRateLimiterCost`). Policy: **one ccxt instance per venue per process** so the limiter sees all traffic. Order-path requests carry a deadline — queued past it ⇒ fail fast (stale intent). This is transport pacing; the _risk_ order-rate cap is separate (§5 R1).
- **Client order ids:** unified `params.clientOrderId` maps to Binance `newClientOrderId`. Constraint: `[A-Za-z0-9_-]{1,36}` (Binance derivatives regex `^[\.A-Z\:/a-z0-9_-]{1,36}$` is the de-facto spot validation). Fetch-by-client-id: Binance `fetchOrder(undefined, symbol, { clientOrderId })` → `origClientOrderId` (symbol required).
- **Error taxonomy** (current hierarchy — note `RateLimitExceeded` is now a _sibling_ of `DDoSProtection` under `NetworkError`, no longer its child): `ExchangeError` branch = non-transient (`AuthenticationError`, `BadRequest/BadSymbol`, `InvalidOrder` → `OrderNotFound`/`DuplicateOrderId`/`OrderImmediatelyFillable`, `InsufficientFunds`, `OperationRejected`, `NotSupported`); `OperationFailed` branch = transient (`NetworkError` → `DDoSProtection`, `RateLimitExceeded`, `ExchangeNotAvailable`/`OnMaintenance`, `InvalidNonce`/`ChecksumError`, `RequestTimeout`; `BadResponse`; `CancelPending`). Mapping to OMS retry classes in §6.3.
- **WS robustness:** ccxt pro reconnects/resubscribes transparently with backoff, and `watchOrderBook` (Binance) performs REST-snapshot + buffered-delta sync with sequence validation — but on a gap it **throws `ChecksumError`, deletes the local book and subscription, and rejects the pending promise**; resync happens only when the app's loop calls `watchOrderBook` again. Therefore: every `watch*` runs in a supervised `for(;;) try/catch` loop (catch transient errors, mark the stream/book invalid, continue — the next call re-subscribes and re-snapshots), plus an **application staleness watchdog** per stream (ccxt has none), plus **post-reconnect reconciliation** for private streams (missed private events are not replayed). `newUpdates` defaults true (incremental delivery).
- **Binance user-data streams [volatile, 2026 change]:** listenKey endpoints are **retired** (testnet 2026-02-04, production 2026-02-20). ccxt pro 4.5.58 already implements spot `watchOrders`/`watchBalance` via the WS-API `userDataStream.subscribe.signature` (HMAC/RSA/Ed25519 all supported), so plain HMAC keys work — but build nothing on listenKey, and plan **Ed25519 keys as the default** (Binance's stated direction; required for `session.logon`/FIX).

### 3.3 Queues and backpressure (owned by MarketData unless noted)

| Queue                                | Policy                                                                                                                                           | Rationale                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticker cell (per venue×symbol)       | conflate, latest-wins, `conflatedCount++`                                                                                                        | only the freshest quote matters at ≥100 ms cadence                                                                                          |
| Book cell (per venue×symbol)         | conflate maintained-book snapshot                                                                                                                | diffs already folded locally; consumers get top-N snapshots, never raw diffs                                                                |
| Trade ring (per venue×symbol)        | bounded 1024, drop-oldest; next delivery gets `gapBefore: true`                                                                                  | spikes must not OOM; strategies must _know_ they missed prints                                                                              |
| Candle queue                         | bounded 256; losing a **closed** candle = FeedHealth GAP + alert, never silent                                                                   | primary strategy input, trivially low-rate                                                                                                  |
| Strategy mailbox (StrategyHost)      | per-strategy merge; a slow strategy degrades only its own freshness                                                                              | isolation between strategies                                                                                                                |
| Signal queue (Risk gateway)          | bounded 64; overflow ⇒ reject-newest + alert                                                                                                     | a signal storm is a strategy bug; risk must not buffer stale desire                                                                         |
| **Exec-report outbox (Execution)**   | **never-drop**: `INSERT INTO outbox` (tx) before in-memory dispatch; durable cursor + ack; redelivery on restart; consumers dedupe on `reportId` | money state — at-least-once + idempotent apply; crash between insert and apply re-applies; crash before insert is covered by reconciliation |
| Audit/metrics queues (Observability) | bounded, drop + counter                                                                                                                          | never backpressure the trading path                                                                                                         |

### 3.4 Credentials & per-venue config

Distinct env vars per venue **and** environment (`BINANCE_TESTNET_*`, `BINANCE_DEMO_*`, `BINANCE_LIVE_*`) — never wired into one adapter instance; base-URL overrides in `VenueConfig` with defaults pinned to the verified ccxt version + the URL regression test; key fingerprints (prefix hash) persisted for audit, never the keys; testnet/demo/live keys are **non-interchangeable** (a demo key against testnet yields Binance `-2008 Invalid Api-Key ID`) — the adapter probes at startup and refuses on environment/key mismatch.

**Implemented selector:** when `TRADING_MODE=testnet`, the env var `SANDBOX_ENV ∈ {testnet, demo}` (default `demo` — the keys this deployment ships are `BINANCE_DEMO_*`) chooses the sandbox flavor; the composition root's `resolveSandbox()` maps it to `VenueConfig.environment` and the matching `BINANCE_TESTNET_*` / `BINANCE_DEMO_*` keys (read from `process.env`, never into `AppConfig`, so never hashed or logged). Both flavors are RUN-verified against the live venue (`pnpm test:testnet` order-lifecycle scenarios, 2026-06). `live` reads `BINANCE_LIVE_*` from the (test/ci-stripped) `AppConfig`; `paper` constructs no network client.

### 3.5 Venue sandbox matrix (verified 2026-06; [volatile])

| Venue                                                | Real sandbox?                                               | URLs                                                                                                                                                                                                      | ccxt 4.5.58 support                                                                                                                                                                                       | Notes                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Binance Spot Testnet**                             | Yes — alive, actively maintained, _not_ deprecated          | REST `https://testnet.binance.vision/api`; WS-API `wss://ws-api.testnet.binance.vision/ws-api/v3`; streams `wss://stream.testnet.binance.vision/ws/stream` (legacy bare-domain WS paths removed May 2025) | `setSandboxMode(true)` → these URLs. Spot-only in practice: any `sapi`/`eapi`/`papi` call throws `NotSupported`; `fetchCurrencies` silently returns `{}` (currency metadata must come from `loadMarkets`) | Keys via GitHub login at testnet.binance.vision (HMAC/RSA/Ed25519). **~Monthly data resets** (balances/orders wiped, keys survive) — integration suite + reconciliation must tolerate. Production-equivalent rate limits/filters. Synthetic, thin market data. |
| **Binance Demo Trading**                             | Yes (new 2025/26)                                           | REST `https://demo-api.binance.com/api`; WS-API `wss://demo-ws-api.binance.com/ws-api/v3`; streams `wss://demo-stream.binance.com`                                                                        | `enableDemoTrading(true)` — **mutually exclusive** with sandbox mode (throws if both)                                                                                                                     | Keys from a real binance.com account (no KYC). **Live-mirroring market data**, user-controlled balance resets, live-equal limits — the realistic sandbox.                                                                                                      |
| OKX                                                  | Demo via `x-simulated-trading: 1` header                    | mainnet URLs + header                                                                                                                                                                                     | sandbox mode supported                                                                                                                                                                                    | not in initial scope                                                                                                                                                                                                                                           |
| Kraken spot, Coinbase Advanced, KuCoin, Gate, Bitget | **No usable public spot sandbox** (or discontinued/limited) | —                                                                                                                                                                                                         | —                                                                                                                                                                                                         | **require the internal simulated-fill engine** (`PaperExchangeAdapter`) — which is the default substrate for paper mode everywhere anyway                                                                                                                      |

Policy: **paper mode (internal sim + production market data) is the strategy-evaluation environment**; **Binance Spot Testnet** is the integration-test environment (Phase 7); **Binance Demo** is the optional realistic dress rehearsal before live (open question #3). ccxt does not unify sandbox fill semantics across venues — our OMS never assumes venue-uniform fills.

## 4. Strategy Abstraction

### 4.1 Strategy interface (pure decision logic)

```ts
interface MarketView {
  // read-only, host-assembled; frozen in dev builds
  readonly eventTime: EpochMs; // the ONLY clock a strategy ever sees
  candles(symbol: SymbolId, interval: CandleInterval, n: number): readonly CandleEvent[];
  lastTicker(symbol: SymbolId): TickerEvent | undefined;
  book(symbol: SymbolId): OrderBookEvent | undefined; // top-N snapshot, never raw diffs
  feed(symbol: SymbolId, channel: string): ChannelHealth; // strategies MAY self-censor on GAP (advisory)
  readonly portfolio: StrategyPortfolioView; // OWN position/open orders only — no balances/equity
  random(): number; // seeded PRNG — deterministic replay
}

interface Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { interval: CandleInterval; bars: number };
  onInit(ctx: StrategyInitContext): void; // ctx: validated params, warmup candles, per-symbol tickSize/lotStep/minNotional
  onCandle(e: CandleEvent, view: MarketView): Signal[]; // sync — Promise return is a type error
  onTick(e: TickerEvent, view: MarketView): Signal[];
  onOrderBook(e: OrderBookEvent, view: MarketView): Signal[];
  onExecReport(r: ExecReport, view: MarketView): Signal[]; // own orders only (host filters)
  onStop(): void;
}
```

**Purity rules (enforced, not requested):** handlers synchronous (the return type forbids awaiting I/O); lint zone for `domain/strategy/**` bans `Date`, `Math.random`, timers, `fetch`, `process`, and all imports outside `domain`; time only from `view.eventTime`; randomness only from `view.random()`. CPU budget per §Stack. Because handlers are pure over an ordered event stream with no ambient clock, **full-session replay from the journal reproduces signals bit-for-bit** — the backtest/live symmetry guarantee, and what makes paper trustworthy. `Decimal → number` is permitted only inside an explicitly-marked indicator boundary (`toIndicatorNumber()`) for indicator math — never for money that flows out.

### 4.2 Signal, OrderIntent, RiskDecision

```ts
interface Signal {
  // conviction, NOT quantity — sizing is Risk's job
  readonly strategyId: StrategyId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly kind: 'ENTER_LONG' | 'EXIT_LONG' | 'FLATTEN' | 'CANCEL_OPEN'; // spot v1: short = sell held base only
  readonly strength: number; // [0,1] conviction (plain number OK — not money)
  readonly limitPriceHint?: Price; // sizer may override
  readonly refPrice: Price; // decision-time reference (slippage baseline §8)
  readonly basedOnSeq: bigint; // seq of the triggering MarketEvent
  readonly eventTime: EpochMs; // event time of trigger — NOT wall time
  readonly ttlMs: number; // Risk rejects expired signals
  readonly dedupeKey: string; // strategy-deterministic; replay ⇒ same key
  readonly reason: string; // human-readable, to audit
}

interface OrderIntent {
  // built by PositionSizer (Risk module), never by strategies
  readonly intentId: IntentId; // UUIDv7
  readonly clientOrderId: ClientOrderId; // deterministic: 'cb' + modeChar(p|t|l) + 32-hex(intentId) = 35 chars,
  // charset [a-z0-9] — valid on Binance; mode cross-leak detectable
  readonly strategyId: StrategyId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly type: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER';
  readonly qty: Qty; // post lot-step rounding (ROUND_DOWN)
  readonly limitPrice?: Price; // post tick rounding (directional)
  readonly timeInForce: 'GTC' | 'IOC' | 'FOK';
  readonly reduceOnly: boolean; // exit/flatten intents; spot: enforced by OMS qty clamp vs attributed position
  readonly mode: TradingMode; // stamped at sizing; Execution re-validates vs ModeControl per submission
  readonly refPrice: Price;
  readonly refSeq: bigint;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly source: Pick<Signal, 'dedupeKey' | 'eventTime' | 'basedOnSeq' | 'strength'>;
}

type RiskDecision =
  | { verdict: 'APPROVED'; approved: RiskApprovedIntent }
  | {
      verdict: 'RESIZED';
      approved: RiskApprovedIntent;
      originalQty: Qty;
      reasons: readonly RiskReason[];
    }
  | { verdict: 'REJECTED'; intent: OrderIntent; reasons: readonly RiskReason[] }; // machine-readable rule codes
```

**`RiskApprovedIntent` — unforgeable, two layers.** Layer 1, compile time: branded with a non-exported `unique symbol`; `ExecutionGate.submit()` has no `OrderIntent` overload. Branding stops honest mistakes, not `as unknown as` — hence Layer 2, runtime: at boot the composition root generates a random 32-byte `RISK_SIGNING_KEY` (process-lifetime, never persisted, never in env), provided to exactly two providers. The approval carries `{ intentHash: sha256(canonicalJson(intent)), hmac, nonce (single-use), approvedAtMs, ttlMs: 2000, limitsVersion, snapshotSeq }`; Execution independently recomputes the hash, verifies the HMAC, checks TTL, and consults the nonce ledger. Forged ⇒ HMAC fails; mutated ⇒ hash fails; replayed ⇒ nonce fails; stale ⇒ TTL fails (re-run risk). **Canonicalization pitfall handled:** Decimals serialize via `toFixed` at symbol precision (no exponent notation) before hashing, or the two sides can disagree on identical intents. Boot-random key means approvals never survive restart — intentional: restart ⇒ re-risk everything, and recovery routes through reconciliation.

**TOCTOU:** sizer and engine share one snapshot instance and run synchronously; the remaining gap (snapshot → venue ack) is covered by `inFlightIntents` (reserved at approval, released on terminal report) — without this, two signals 50 ms apart double-spend the balance — plus the approval TTL.

### 4.3 Registry, lifecycle, hot-swap

Strategy _types_ are code; _instances_ are config (`strategies: [{ id, type, symbols, params, enabled, drainPolicy }]`). Hot-swap via config watcher → `StrategyRegistry`: validate + snapshot config → old instance to DRAINING per `DrainPolicy = 'CANCEL_OPEN_AND_FLATTEN' | 'CANCEL_OPEN_KEEP_POSITION' | 'MANAGE_TO_CLOSE'(deadline → HALTED)` (default: `CANCEL_OPEN_KEEP_POSITION`) → `onStop` → new instance WARMUP (historical replay, signals discarded) → ACTIVE. **Position attribution survives unload** (virtual sub-accounts in the ledger) — re-enabling resumes the same book; otherwise orphaned inventory leaks into "unattributed" and per-strategy caps stop meaning anything. While DRAINING, the host filters emissions to risk-reducing kinds only. All transitions audited.

## 5. Risk Controls

`RiskEngine.evaluate(intent, snapshot)` is pure and synchronous; inputs: intent, `PortfolioSnapshot` (positions + balances + open orders + `inFlightIntents` + equity/peak/day-PnL + `reconcileStatus`), market marks with staleness, `RiskLimitsConfig`, kill-switch state, mode resolution.

**Evaluation order (first failing HARD check short-circuits; clamps compose then re-validate):**

| #     | Check                               | Predicate (pass condition)                                                                                                                                                                                                                    | Class                                                                                                                                                                                                  | On fail                        |
| ----- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| G0    | Kill switch                         | state = RUNNING, **or** intent is reduce-only FLATTEN and state = FLATTENING (carve-out)                                                                                                                                                      | HARD                                                                                                                                                                                                   | REJECT `KILL_SWITCH`           |
| G1    | Mode match                          | `intent.mode === resolveMode().effective` (catches downgrade between decision and submission)                                                                                                                                                 | HARD                                                                                                                                                                                                   | REJECT `MODE_MISMATCH`         |
| G2    | Limits complete                     | every limit non-null, schema-validated at boot                                                                                                                                                                                                | HARD                                                                                                                                                                                                   | REJECT `LIMITS_INCOMPLETE`     |
| P1    | Market-data staleness               | fresh book-derived mark (`age ≤ 5 000 ms` default) and FeedHealth = LIVE. Carve-out: reduce-only FLATTEN may use last-trade fallback with the P2 band widened ×2 — you must be able to flatten on stale data; you must never _add_ risk on it | HARD                                                                                                                                                                                                   | REJECT `STALE_DATA`            |
| P2    | Price band                          | abs(limitPrice − refMid) / refMid ≤ maxBandBps (default 100 bps). No naked MARKET orders exist in v1: FLATTEN emits **marketable limits priced at the band edge** — a crossed/broken feed cannot fill us at absurd prices                     | HARD for strategy intents (an out-of-band price is a buggy signal — never silently repriced); CLAMP for FLATTEN                                                                                        | REJECT `PRICE_BAND`            |
| P3    | Fat-finger notional                 | qty × (limitPrice ?? refMid) ≤ maxOrderNotional                                                                                                                                                                                               | HARD for strategy intents (clamping masks a bug); FLATTEN is CLAMP-by-slicing into ≤cap children                                                                                                       | REJECT `FAT_FINGER`            |
| P4    | Signal/intent expiry + drift collar | now ≤ expiresAt and abs(refPrice − currentMark) ≤ maxDriftBps — catches the fast-reconnect case where price gapped 3% in 800 ms that the age check misses                                                                                     | HARD                                                                                                                                                                                                   | REJECT `EXPIRED` / `REF_DRIFT` |
| R1    | Order rate                          | token buckets: global (default 10/s), per-symbol (2/s), per-strategy — plus a **reserved flatten bucket** so flatten can never be starved by a runaway strategy                                                                               | SOFT: reject this intent (intents are perishable at our cadence; strategy re-emits). Escalation: ≥25 rate-rejects in 5 s ⇒ `ORDER_RATE_RUNAWAY` → **engage kill switch** (that's a loop, not bad luck) | REJECT `RATE_LIMIT`            |
| X1    | Crossing                            | intent would execute against a sibling strategy's resting order (symbol-level open-interest registry incl. in-flight)                                                                                                                         | HARD (default `REJECT_CROSSING`; venue STP set as backstop where `capabilities.stp`)                                                                                                                   | REJECT `CROSSING_INTENT`       |
| E1    | Max position per symbol             | post-trade abs(attributed position + same-direction in-flight + intent) ≤ limit                                                                                                                                                               | SOFT-CLAMP to headroom; clamp below exchange minimum ⇒ REJECT                                                                                                                                          | CLAMP/REJECT `POSITION_LIMIT`  |
| E2/E3 | Max gross / net exposure            | post-trade Σ abs(notional) ≤ gross; Σ abs(signed notional) ≤ net (reduce-only always passes — strictly decreases)                                                                                                                             | SOFT-CLAMP                                                                                                                                                                                             | CLAMP/REJECT `EXPOSURE_LIMIT`  |
| C1    | Max daily loss                      | sodEquityUtc − equity < maxDailyLoss (equality trips)                                                                                                                                                                                         | HARD + **engage kill switch** (pre-trade re-check; the monitor below is primary — this closes the race between monitor ticks). Reduce-only passes                                                      | REJECT `DAILY_LOSS`            |
| C2    | Max drawdown                        | (peakEquity − equity) / peakEquity < maxDrawdownPct                                                                                                                                                                                           | HARD + engage kill switch → **flatten**. Reduce-only passes                                                                                                                                            | REJECT `MAX_DRAWDOWN`          |
| F1    | Post-clamp filter validation        | after all clamps: qty rounded **down** to stepSize, ≥ minQty, notional ≥ minNotional, price tick-aligned. **A clamp landing below exchange minimums becomes REJECT, never a doomed submit.** Applies to each FLATTEN slice                    | HARD                                                                                                                                                                                                   | REJECT `BELOW_EXCHANGE_MIN`    |
| F2    | Reduce-only semantics               | sign opposes position; qty ≤ abs(position) (clamped down, F1 re-checked); flips via reduce-only are violations                                                                                                                                | HARD                                                                                                                                                                                                   | REJECT `REDUCE_ONLY_VIOLATION` |

Hard = reject (and possibly halt); soft = clamp/pause with alert. Additionally: orders stuck in `*_UNKNOWN` reserve their **full quantity as worst-case exposure** in E1–E3 until resolved.

**Post-trade monitors (primary owners of C1/C2):** `EquitySampler` computes `equity = cash + Σ pos×mark` (Decimal) on every fill **and** every 5 s → `equity_curve` row + persisted `peakEquity`. `DailyLossMonitor` and `DrawdownMonitor` evaluate every sample; trips are idempotent (re-trip absorbed). Named edge cases, decided:

- **UTC rollover with open positions:** `sodEquityUtc` re-anchors atomically on the first sample of the new UTC date — equity-based accounting splits an open position's loss across days naturally; a sample captured at 23:59:59.9 evaluates against the old anchor even if processed after midnight; **a halt engaged before rollover does not auto-clear at midnight** (rollover resets the measurement, never the halt — daily-loss re-enable is manual, open question #6 resolved: manual).
- **Equity-curve gaps:** `peakEquity` is persisted and reloaded — a restart can never launder drawdown by resetting the peak. Gaps are never interpolated; the first post-gap sample is taken only after a clean reconciliation pass; gaps are annotated so Sharpe/drawdown jobs exclude them from periodization.

**Global kill switch (state machine):** `RUNNING → HALTING → HALTED → (FLATTENING →) HALTED`, plus `HALTED_DEGRADED`. Engage from: admin API, monitors, reconciliation, OMS anomalies (illegal transitions, cumQty regression, fill overflow, unknown-our-prefix orders), rate runaway, repeated 429/418 storms, process signals, ModeControl downgrades. HALTING rejects all non-flatten intents and issues cancel-all; cancels confirmed ⇒ HALTED; cancel timeout (10 s) ⇒ `HALTED_DEGRADED` + page (orders may still be live; reconciliation keeps polling). FLATTEN (per-reason config: default **true for DRAWDOWN, false for RECONCILE_MISMATCH** — local truth is suspect there, and blind flattening on wrong state can double the damage; human decides) emits reduce-only marketable limits at band edge, sliced per P3, through the **normal risk pipeline**. ALL*FLAT when every abs(position) < exchange minQty. **Disengage is manual only** (admin API, operator-identified, typed confirmation), gated on: reconciliation clean, market data fresh, mode preconditions re-evaluated; live arming state is \_not* restored — re-arm required. **Fills are facts, not requests:** the OMS ingests fill events in every state including HALTED — risk gates submissions, never fill ingestion.

All limits in `RiskLimitsConfig` (zod, all mandatory — absence blocks live mode, §10d). Every decision (verdict + ordered reason codes + snapshot seq + inputs hash) is journaled before the approval leaves the module.

## 6. Order Lifecycle (OMS)

**Core invariants:** I1 write-ahead (every transition persisted before the side effect it authorizes; crash recovery degrades in-flight states to `*_UNKNOWN`, never to optimistic states) · I2 pure id (`clientOrderId = f(intentId, mode)`, no attempt counters — one intent ⇒ at most one venue order, ever) · I3 fill idempotency (dedupe on `(venue, symbol, venueTradeId)` UNIQUE; fills never synthesized without a venue tradeId — paper mints its own) · I4 monotonicity (`cumQty` non-decreasing, ≤ qty + one step; violation = money anomaly → kill switch) · I5 unknown-is-a-state (never a swallowed exception) · I6 reconciliation adds facts through the same idempotent pipelines, never auto-trades to "fix" · I7 no silent coercion (illegal `(state, event)` ⇒ freeze to `RECONCILE_REQUIRED` + anomaly).

Order events are persisted to an append-only **`order_events`** journal (`(order_id, dedupe_key)` UNIQUE); state is derived by the pure reducer, cached as a column, re-derivable from the log.

### 6.1 State machine

States: `NEW → SUBMITTING → ACKED → PARTIALLY_FILLED → FILLED | CANCELED | REJECTED | EXPIRED` (terminals), plus `SUBMIT_UNKNOWN`, `CANCEL_PENDING`, `CANCEL_UNKNOWN`, and frozen `RECONCILE_REQUIRED`. Transition table (pairs not listed are **illegal** → I7):

| State                    | Event                                           | Next                             | Note                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEW                      | persisted, submit sent                          | SUBMITTING                       | persist BEFORE the HTTP write (I1)                                                                                                                                           |
| NEW                      | cancel requested                                | CANCELED                         | never sent; local-only                                                                                                                                                       |
| SUBMITTING               | venue ack                                       | ACKED                            | record venueOrderId; deferred-cancel flag honored now                                                                                                                        |
| SUBMITTING               | venue reject                                    | REJECTED                         | terminal, mapped code                                                                                                                                                        |
| SUBMITTING               | provably-not-sent failure                       | NEW                              | attempt++; >3 ⇒ REJECTED(local)                                                                                                                                              |
| SUBMITTING               | ambiguous failure                               | SUBMIT_UNKNOWN                   | start query loop                                                                                                                                                             |
| SUBMITTING               | fill / full fill                                | PARTIALLY_FILLED / FILLED        | **implicit ack — WS exec report beat the REST response; legal, common on Binance**                                                                                           |
| SUBMITTING               | venue canceled/expired                          | CANCELED / EXPIRED               | implicit ack + terminal (e.g. unfilled IOC)                                                                                                                                  |
| SUBMITTING               | cancel requested                                | SUBMITTING                       | set `cancelWanted` flag; cancel deferred until resolution                                                                                                                    |
| SUBMIT_UNKNOWN           | ack / fill / venue report                       | ACKED / PARTIALLY_FILLED / …     | WS resolves the ambiguity                                                                                                                                                    |
| SUBMIT_UNKNOWN           | query: open (cum 0 / >0)                        | ACKED / PARTIALLY_FILLED         | fills backfilled via fetchMyTrades before applying                                                                                                                           |
| SUBMIT_UNKNOWN           | query: terminal                                 | FILLED/CANCELED/REJECTED/EXPIRED | trade backfill first                                                                                                                                                         |
| SUBMIT_UNKNOWN           | query: definitively not found (within window)   | NEW                              | resubmit-eligible, **same clientOrderId**, only if intent TTL unexpired; else CANCELED(local)                                                                                |
| SUBMIT_UNKNOWN           | query inconclusive (bounded attempts exhausted) | RECONCILE_REQUIRED               | symbol frozen; worst-case exposure reserved                                                                                                                                  |
| ACKED / PARTIALLY_FILLED | fill / full fill                                | PARTIALLY_FILLED / FILLED        | cumQty from venue **cumulative** fields, never deltas                                                                                                                        |
| ACKED / PARTIALLY_FILLED | cancel requested (ttl/strategy/risk/shutdown)   | CANCEL_PENDING                   | persist, then send cancel by clientOrderId                                                                                                                                   |
| ACKED                    | venue canceled (reason: stp)                    | CANCELED                         | legal transition but a strategy defect — freeze symbol + surface                                                                                                             |
| CANCEL_PENDING           | cancel ack                                      | CANCELED                         | venue-reported cumQty > local ⇒ fills in flight: schedule fetchMyTrades backfill — **never synthesize fills from the delta** (no tradeIds; would collide with the real fill) |
| CANCEL_PENDING           | fill / full fill                                | CANCEL_PENDING / FILLED          | cancel race: fills win; keep waiting / terminal                                                                                                                              |
| CANCEL_PENDING           | "unknown order" reject (e.g. Binance −2011)     | CANCEL_UNKNOWN                   | ambiguous between _already filled_ and _already canceled_ — query decides, never assume                                                                                      |
| CANCEL_PENDING           | ambiguous failure                               | CANCEL_UNKNOWN                   |                                                                                                                                                                              |
| CANCEL_UNKNOWN           | fill / query resolves                           | FILLED / per venue truth         | re-issue cancel if still open; >3 reissues ⇒ RECONCILE_REQUIRED                                                                                                              |
| CANCEL_UNKNOWN           | query: not found                                | RECONCILE_REQUIRED               | an order we hold an ack for cannot vanish                                                                                                                                    |
| RECONCILE_REQUIRED       | reconcile resolves (with recorded evidence)     | per evidence                     | only exit; fills still ingested while frozen                                                                                                                                 |
| FILLED/CANCELED/EXPIRED  | late fill (new tradeId, cum ≤ qty)              | unchanged                        | **legal** (cross-channel reordering); CANCELED whose late fills reach full qty ⇒ RECONCILE_REQUIRED (contradiction)                                                          |
| any terminal             | contradicting event                             | RECONCILE_REQUIRED               | duplicates dropped; contradictions frozen                                                                                                                                    |

Residual-dust rule: `qty − cumQty < stepSize` is consistent with FILLED (venues round; exact-equality would false-alarm). **Crash recovery at startup:** `SUBMITTING → SUBMIT_UNKNOWN`, `CANCEL_PENDING → CANCEL_UNKNOWN`, then a full reconciliation pass; **live arming is refused while any order is `*_UNKNOWN` or `RECONCILE_REQUIRED`.** Order amend/replace is deliberately unsupported in v1 (cancel + new intent only — amend adds a second ambiguity axis).

### 6.2 Idempotency — corrected mechanism

- `clientOrderId = 'cb' + modeChar + hex32(intentId)` (35 chars, §4.2): deterministic, prefix-identifiable at reconciliation, mode-leak-detectable.
- **Write-ahead:** intent row + clientOrderId committed before any network call. Consequence: a venue order with our prefix missing from our DB is _proof_ of corruption (DB loss, key sharing, second instance), not a maybe — HALT.
- **Blind resubmit is forbidden, and same-id dedupe is NOT the safety mechanism — query-before-resubmit is.** Binance enforces clientOrderId uniqueness **only among currently open orders**: if the first submit filled instantly, a same-id resubmit is _accepted as a fresh order_ and doubles exposure past everything Risk approved. Same-id is defense in depth only. ccxt `DuplicateOrderId` on a resubmit is therefore good news (the original is open) — treat as implicit ack and query, never retry around.
- **`not_found` caveat:** venues answer not-found both for never-landed and for archived orders. Trust it only within the bounded post-submit query window (seconds — archiving impossible there), and corroborate once via `fetchOpenOrders`; outside the window, `not_found` routes to `RECONCILE_REQUIRED` + a `fetchMyTrades` sweep, not to resubmit.

### 6.3 Error classification & retry policy (adapter-owned)

`AdapterErrorClass = TRANSPORT_RETRYABLE | OUTCOME_AMBIGUOUS | TERMINAL_REJECT | AUTH_FATAL | MAINTENANCE`.

| ccxt class                                                                                               | Classification      | Action                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RateLimitExceeded`, `DDoSProtection` (429/418)                                                          | TRANSPORT_RETRYABLE | rejected at the edge (documented not-executed); backoff per Retry-After, max 3, then treat as ambiguous; 418/ban ⇒ circuit breaker → kill switch |
| `InvalidNonce` (timestamp/recvWindow)                                                                    | TRANSPORT_RETRYABLE | resync server time, widen recvWindow once, max 2; recurring ⇒ venue degraded                                                                     |
| `RequestTimeout`                                                                                         | OUTCOME_AMBIGUOUS   | may have landed after our deadline                                                                                                               |
| generic `NetworkError`, `ExchangeNotAvailable` (5xx)                                                     | OUTCOME_AMBIGUOUS   | ECONNREFUSED _looks_ pre-send, but ccxt does not expose write-completion — treat all as ambiguous                                                |
| `InsufficientFunds`, `InvalidOrder`, `BadSymbol`, `BadRequest`, `OrderImmediatelyFillable`/`NotFillable` | TERMINAL_REJECT     | no retry; counted in taxonomy; repeated `InsufficientFunds` ⇒ reconcile balances                                                                 |
| `DuplicateOrderId`                                                                                       | special             | implicit ack → query path (§6.2)                                                                                                                 |
| `AuthenticationError`, `PermissionDenied`, `AccountSuspended`                                            | AUTH_FATAL          | terminal + kill switch — broken credentials mid-run is an incident                                                                               |
| `OnMaintenance`                                                                                          | MAINTENANCE         | pause venue: no new intents, in-flight orders ride, cancels best-effort; clean reconcile gates resumption                                        |
| `OrderNotFound` on cancel                                                                                | special             | already closed — query final state                                                                                                               |
| **anything unmapped**                                                                                    | OUTCOME_AMBIGUOUS   | the safe default: never blind-retry, never terminal, on an unknown error                                                                         |

Query loop (`*_UNKNOWN`): `fetchOrder` by clientOrderId at 250 ms/500 ms/1 s/2 s/4 s ±20% jitter; inconclusive after 5 attempts ⇒ `RECONCILE_REQUIRED`, symbol frozen, full-qty exposure reserved; any unknown unresolved >60 s, or venue unreachable while unknowns are held ⇒ **global kill switch** — when the state of real money is unknown, nothing else may trade. The classifier is **snapshot-tested against the pinned ccxt error hierarchy** (ccxt has restructured it between versions; an unnoticed remap silently converts query-first into blind-retry).

### 6.4 Reconciliation loop

Cadence/triggers per §1. Serialized per venue. Compares:

1. **Open orders:** venue `fetchOpenOrders` vs local non-terminal, joined on clientOrderId.
2. **Trades:** `fetchMyTrades(since checkpoint − 5 min overlap)` vs recorded fills by venue tradeId — overlap is free under I3 dedupe and absorbs clock skew/late visibility. Checkpoint per (venue, symbol).
3. **Balances:** venue vs local ledger (positions + open-order locks + fee ledger) per asset, within `ε = max(εabs_dust, εrel·|balance|)`. Within-ε drift is recorded, **not adopted**; drift growing monotonically across 3 passes escalates to HALT even under ε (a slow leak is a systematic fee/rounding bug).

| Discrepancy                                                                                                 | Response                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venue trade absent locally (missed fill)                                                                    | ingest via FillIngestor + WARN — expected after stream gaps                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Local non-terminal order absent from venue                                                                  | query individually → adopt terminal truth; WARN                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Venue open order with our prefix, unknown locally                                                           | **HALT** — I1 makes this impossible except DB loss / key sharing / second instance; no auto-cancel (we'd cancel what we can't account for)                                                                                                                                                                                                                                                                                                                                            |
| Venue order, foreign id                                                                                     | WARN + ignore (manual trading on the key — flag loudly; runbook recommends dedicated keys)                                                                                                                                                                                                                                                                                                                                                                                            |
| Balance drift > ε / position ≠ venue implication                                                            | **HALT, no auto-flatten** — flattening is trading on a model just proven wrong: if the discrepancy itself is the error (fee-in-base bug, unfetched fill, parsing defect), auto-flatten _creates or doubles_ the position, during the same fault window that caused the mismatch, at the worst liquidity. While halted, exactly one order class is allowed: cancel of known open orders (risk-reducing, idempotent). Position changes require operator resolution recorded as evidence |
| Fill overflow / cumQty regression / same-tradeId-different-payload / fill for unknown order with our prefix | **HALT** (money-impacting anomaly; quarantine row persisted)                                                                                                                                                                                                                                                                                                                                                                                                                          |

Every pass persists a `reconciliations` row; mismatch count > 0 pages.

### 6.5 PaperExchangeAdapter (simulated fills)

Implements the same ports; throws ccxt-shaped errors; delivers events through the same outbox — the OMS cannot tell it from a venue. Fed by real (or recorded) market data; virtual Decimal ledger with placement-time locks (buy: `price·qty·(1+takerBuffer)` quote; sell: base) and ccxt-shaped `InsufficientFunds` rejects.

```ts
interface PaperConfig {
  seed: number; // ALL randomness derives from this
  marketFill:
    | { mode: 'book_walk' } // default when L2 subscribed
    | { mode: 'touch_slippage'; slippageBps: Decimal }; // fallback, default 5 bps
  limitFill:
    | { mode: 'trade_through' } // default, conservative
    | { mode: 'queue_sim' }; // research only, off by default
  latency: { submitMs: [number, number]; eventMs: [number, number] }; // seeded PRNG (mulberry32)
  fees: { makerBps: Decimal; takerBps: Decimal; feeCurrency: 'quote' | 'base' | { asset: string } };
  insufficientDepthPolicy: 'partial_then_reject_rest' | 'fill_at_worst_level';
  reorderDelivery?: boolean; // test mode: deliberately deliver fill-before-ack, late-fill-after-cancel —
  // the only place §6.1's reordering rows get exercised before production does it for real
}
```

- **Market orders — book walk:** consume L2 levels as of `submitTime + simulated latency` (not decision time — that gap _is_ slippage), VWAP across levels, one fill per level (exercises partial-fill paths), taker fee.
- **Limit orders — trade-through:** a resting buy at P fills only from printed trades strictly below P (sell: above), at **our** limit price, maker fee; touching P never fills (we'd be at the back of the queue). Marketable-on-arrival limits cross immediately, price-capped at P, taker fee. Prints are **allocated across our resting orders** (price then time priority) — naively giving each order the full print double-counts liquidity. `queue_sim` (queue-ahead decrement, zero-cancel assumption) stays off by default: trade-through's pessimistic-under-fill bias is _known_, which is the right bias for a go/no-go signal.
- **Determinism:** injected `ClockPort` (virtual time in tests, no sleeps), single totally-ordered event stream, seeded PRNG ⇒ same seed + fixture = byte-identical fill sequence, asserted in CI. Fee currency configurable to `base`/third-asset specifically to exercise §6.6 fee paths in paper.
- **Honesty box (runbook, not just code comments):** paper cannot capture queue position (trade-through is a bound, not an estimate), **self-impact** (the prints we consume happened without us — paper double-counts liquidity at our own size), venue-specific reject codes/filters (PERCENT_PRICE, STP variants), latency that correlates with volatility (venues are slowest exactly when it matters), hidden/iceberg liquidity, auth/maintenance events (injectable, never emergent). Paper PnL is an upper bound at small size and increasingly fictional as size grows relative to displayed depth.

### 6.6 Fills, fees, user-data streams

`FillRecord { venue, symbol, venueTradeId (UNIQUE), clientOrderId, price, qty, fee: {ccy, amount} | null, liquidity, venueTimestamp, source: 'ws'|'rest_reconcile'|'paper' }`. One `FillIngestor` pipeline for all three sources; `ON CONFLICT DO NOTHING`; same tradeId with _different_ payload = corruption → kill switch. `cumQty` is **recomputed from the fill table**, not incremented — replays converge. Position math: average-cost (increase: weighted avg; reduce: `realized += (px − avgCost)·qty·sign`, avgCost unchanged). Fees: **base-currency fee** (typical Binance BUY) ⇒ position uses _net_ base, cost basis uses gross — getting this wrong leaves unsellable dust and balance drift that looks like a bug; **quote fee** ⇒ adjust proceeds/cost; **third-asset fee (BNB)** ⇒ separate `fee_ledger` per asset, never touches position math, PnL reporting converts at fill-time mark (flagged estimate), and the asset participates in balance reconciliation. `fee: null` (ccxt sometimes omits on WS) ⇒ `FEE_UNRESOLVED`, patched by reconciliation's authoritative `fetchMyTrades`.

User-data: per venue, supervised `watchOrders` + `watchMyTrades` loops feeding the outbox. **No cross-channel ordering guarantee** — handled structurally: fill-before-REST-ack is legal (implicit ack); order updates carrying cumQty lower than current are stale → dropped; REST response after WS terminal is an idempotent no-op. Stream drop ⇒ missed fills ⇒ post-reconnect reconciliation _is_ the recovery path (no special-case fill logic). Duplicates dropped by dedupe keys before reaching the reducer.

## 7. Persistence

**Store: PostgreSQL 16.** `NUMERIC` arbitrary precision (the money rule at the storage layer; node-postgres returns it as strings — exact at the driver boundary); real transactions for write-ahead; JSONB for raw payloads; trigger-enforceable append-only tables. SQLite rejected even for dev: its numeric affinity is float-like — a money-rule violation.

**Query layer: Drizzle ORM + drizzle-kit + node-postgres** [volatile — v1.0 was at RC in 04/2026; pin stable 0.45.x or the RC line, re-verify at implementation]. Why over the alternatives: (1) pg `numeric` maps to **string by default** — no float coercion anywhere — and one `customType` (`toDriver`: Decimal→string via `toFixed`, `fromDriver`: string→Decimal) gives Decimal-in/Decimal-out entities with no bundled-class identity pitfalls (Prisma's `Prisma.Decimal` is a separate bundled decimal.js copy — `instanceof` traps); (2) migrations are plain reviewable SQL — exactly what the audit-log `REVOKE`/trigger/identity DDL needs; (3) `db.transaction()` + `sql` escape hatch (advisory locks) fits the write-ahead pattern; (4) plain-provider NestJS integration, none of Prisma 7's ESM/CJS friction with Nest's CJS toolchain. Runner-up: Prisma 7 (best Decimal ergonomics, but requires `moduleFormat = "cjs"` workarounds with Nest 11). TypeORM (1.0, revived 2026) and raw kysely considered and rejected for a new money-critical project.

**Schema** (all money/qty `NUMERIC(38,18)` — 20 integer digits + 18 fractional covers wei-grade precision and large notionals; BIGINT minor units rejected: 2^63−1 caps at 9.22 units at 18-decimal scale. Every trading row stamped `mode` + `run_id` + `boot_id`):

| Table              | Key columns / notes                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order_intents`    | `intent_id` PK, full OrderIntent payload, risk-approval reference, `signal_id` FK                                                                                                                                                                                                                                                                                                                                                                             |
| `orders`           | `intent_id` PK/FK, `client_order_id` UNIQUE, `venue_order_id`, `strategy_id`, venue/symbol/side/type/qty/limit_price/tif, **derived** `state` (cache of reducer output), per-transition timestamps, raw acks JSONB                                                                                                                                                                                                                                            |
| `order_events`     | append-only journal: `(order_id, dedupe_key)` UNIQUE, event payload JSONB, seq — state re-derivable                                                                                                                                                                                                                                                                                                                                                           |
| `fills`            | `(venue, symbol, venue_trade_id)` UNIQUE, `intent_id` FK, price/qty/fee/fee_ccy NUMERIC, liquidity, `fee_resolved` flag, source                                                                                                                                                                                                                                                                                                                               |
| `positions`        | `(strategy_id, venue, symbol)` PK — virtual sub-accounts; signed qty, avg_entry, realized_pnl; venue-level netting derived                                                                                                                                                                                                                                                                                                                                    |
| `balances`         | `(venue, asset, ts)` snapshots per reconcile + latest; `fee_ledger` per asset                                                                                                                                                                                                                                                                                                                                                                                 |
| `signals`          | `signal_id` PK, full Signal, outcome (sized / sizing-rejected / risk-rejected / submitted), links decision → order → fills                                                                                                                                                                                                                                                                                                                                    |
| `risk_decisions`   | `intent_id`, verdict, ordered reason codes, limits_version, snapshot_seq, inputs hash                                                                                                                                                                                                                                                                                                                                                                         |
| `exec_outbox`      | `cursor` BIGINT IDENTITY, report payload, consumer acks — the never-drop stream                                                                                                                                                                                                                                                                                                                                                                               |
| `equity_curve`     | `(run_id, ts)`, equity/cash/unrealized/peak, `session_date_utc`, gap annotations                                                                                                                                                                                                                                                                                                                                                                              |
| `config_snapshots` | hash PK, config JSONB, activated_at, mode                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `reconciliations`  | ts, duration, counts, discrepancies JSONB, result                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mode_transitions` | from/to, actor, interlock evidence JSONB (challenge hash — never secrets), boot_id                                                                                                                                                                                                                                                                                                                                                                            |
| `audit_log`        | **append-only**: `seq` BIGINT IDENTITY, ts, actor, category, payload JSONB, `prev_hash`, `hash` (SHA-256 chain over canonical payload ‖ prev) — appends serialized via `pg_advisory_xact_lock`; `REVOKE UPDATE, DELETE` from the app role + `BEFORE UPDATE OR DELETE` trigger raising exception (covers owner sessions); chain integrity from prev_hash, not gapless seq; superuser-grade tamper evidence would need external anchoring (out of scope, noted) |

**Paper vs live persistence:** identical schema, identical write paths — paper exercises the same code; rows segregated by `mode`/`run_id`; dashboards filter by mode. Live additionally records key fingerprints and arming evidence. Candles cached for warmup (both modes); raw tick capture behind a config flag with retention pruning (the only non-append-only-exempt high-volume table).

## 8. Observability & Metrics

- **Logging:** nestjs-pino JSON; the §2.7 correlation chain on every record — one grep traces decision → order → fills end-to-end; deep `redact` paths (ccxt errors can embed signed request headers). Log ≠ audit: `audit_log` is the durable record.
- **Health:** `/health/live` — process-only, zero dependencies (event loop responsive, heap under cap); must not flap on venue outages. `/health/ready` — DB ping, REST reachable, WS per-stream freshness, config loaded, reconciliation not failed; the body _includes_ `killSwitchState` and `effectiveMode` — **HALTED is ready** (healthy and intentionally not trading); only infrastructure failures are unready. Terminus 11 `HealthIndicatorService` custom indicators: WS staleness, reconcile age, event-loop delay.
- **Backend:** Prometheus (prom-client 15 via @willsoto/nestjs-prometheus) + Grafana + Alertmanager, docker-compose. Ledger truth is Decimal in Postgres; Prometheus floats are display-grade exports.

**Metric definitions (precise; reporting currency USDT, converted at fill time):**

| Metric                     | Definition                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Realized PnL               | **Average-cost method** per (strategy, symbol): on reducing fills, `(fillPx − avgEntry) × qtyClosed × dirSign − fees(quote-converted at fill-time mark)`; avgEntry updated only on increasing fills. Method config-pinned and stated on dashboards.                                                                                        |
| Unrealized PnL             | `signedQty × (mark − avgEntry)`; **mark = best-bid/ask mid** from latest book, fallback last trade with `mark_stale{symbol}` gauge = 1.                                                                                                                                                                                                    |
| Equity                     | `cash + Σ pos×mark`, sampled per fill + every 5 s → `equity_curve`.                                                                                                                                                                                                                                                                        |
| Max drawdown               | **peak-to-trough on sampled equity:** current `(peak − equity)/peak` gauge + historical max; computed over real samples only (gaps excluded); peak persisted across restarts.                                                                                                                                                              |
| Sharpe                     | **daily returns from UTC-midnight equity closes**, `r_t = E_t/E_{t−1} − 1`, **rf = 0** (stated: crypto has no agreed riskless leg), annualized ×√365 (24/7 market). **Absent from /metrics below 20 daily samples** (not NaN, not 0).                                                                                                      |
| Sortino                    | same periodization; downside deviation `sqrt(Σ min(r,0)²/n)` (MAR = 0); ×√365; same sample rule.                                                                                                                                                                                                                                           |
| Calmar                     | annualized return over the window (`(E_end/E_start)^(365/days) − 1`) / max drawdown over the same window; window = 90 d (run lifetime if shorter); absent if dd = 0 or underfilled.                                                                                                                                                        |
| Win rate                   | wins / closed round-trips; round-trip = position returns to flat (sign flips split); win ⇔ net-of-fees PnL > 0.                                                                                                                                                                                                                            |
| Profit factor              | Σ gross profits / Σ abs(gross losses) over closed round-trips; absent while losses = 0.                                                                                                                                                                                                                                                    |
| Slippage                   | histograms, **signed by side, positive = adverse**, in bps: **decision slippage** = (execVWAP vs `Signal.refPrice`); **arrival slippage** = (execVWAP vs mid at OMS submit). The difference isolates internal pipeline latency cost from market movement. Labels: venue/symbol/orderType.                                                  |
| Fill rate                  | Σ filledQty / Σ submittedQty over terminal orders (1 h window) + fully-filled-order ratio; labeled by type/TIF (limit fill rate is strategy-meaningful; market should be ~1).                                                                                                                                                              |
| Rejection/failure taxonomy | `orders_rejected_total{stage = risk, exchange, oms, code}` — risk codes from §5; exchange codes mapped (`LOT_SIZE`, `MIN_NOTIONAL`, `INSUFFICIENT_BALANCE`, `RATE_LIMIT`, …); OMS codes (`timeout`, `canceled_ttl`, `canceled_user`, `canceled_halt`, `partial_then_canceled`, `network_error`, `unknown_resolved`, `unknown_unresolved`). |
| System                     | event-loop lag + utilization, per-stream `ws_staleness_seconds`, queue depths/drop counters, reconnect counts, submit-latency histogram (intent→ack), `reconcile_mismatch_total{kind}` + last-success timestamp, `kill_switch_state` (enum gauge), `mode_info{requested,effective}`, `arm_events_total{event}`, rate-limit budget.         |

**Dashboards:** (1) PnL & Equity — curve, dayPnL vs −maxDailyLoss line, drawdown vs limit, ratios, win/PF; (2) Execution quality — slippage (both variants), fill rate, latency, rejection taxonomy stacked; (3) Risk & safety — limit headroom, kill-switch timeline, mode + arming annotations; (4) System — loop, streams, queues, reconcile.

**Alerts:** kill switch engaged (page) · `HALTED_DEGRADED` >1 min (page) · reconcile mismatch >0 (page) · reconcile last-success >300 s (crit) · `unknown_unresolved` >0 (page) · daily loss ≥80% of limit (warn) · WS staleness >10 s for 30 s (crit) · equity sampler silent >2 min while RUNNING (crit) · rejection storm >0.5/s (crit) · event-loop p99 >200 ms 5 m (warn) · slippage p95 >25 bps 15 m (warn) · armed >8 h (warn, TTL safety net).

## 9. Testing Strategy

**Runner: Vitest + unplugin-swc** (officially documented Nest recipe; SWC supplies `emitDecoratorMetadata` that esbuild cannot; aligned with Nest v12 direction) + separate `tsc --noEmit` (SWC does not type-check).

**Unit (domain core — pure, no Nest, no I/O):**

- Risk decision table: one parameterized fixture per §5 check × {pass, boundary-exactly-at-limit (inequality direction asserted: equality trips loss limits), breach, clamp-then-F1-reject}; assert verdict + **full ordered reason codes** + reservation effects, Decimal-string equality.
- OMS reducer: exhaustive (state × event) matrix against §6.1 — legal pairs produce specified state + side effects; illegal pairs throw `TransitionError`, never silently mutate; duplicate-event idempotency; out-of-order sequences.
- Strategy goldens: recorded candle fixtures → expected Signal sequences (pure ⇒ no mocks), serialized-Decimal deep-equal.
- PnL/fee fixtures: hand-computed sequences incl. fee-in-base (net-qty!), fee-in-BNB, partial-close avg-cost — asserted by **exact string equality** (`toBeCloseTo` lint-banned for money).
- ModeControl: resolution over all precondition vectors; challenge TTL/replay/HMAC-mismatch/bootId-mismatch; approval-proof canonicalization (two sides hash identical intents identically).
- Property-based (fast-check, CI `FC_NUM_RUNS=1000`, failing seeds committed): risk conservation (REJECT ⇒ no reservation; CLAMP ⇒ qty' ≤ qty ∧ post-state satisfies limits); reduce-only never increases |position| or flips sign; PnL conservation `equity ≡ initialCash + realized + unrealized − fees` over arbitrary fill sequences; OMS robustness over permuted/duplicated event streams (cumQty monotone, terminals absorbing); paper-fill sanity (buy fill ≤ limit, Σ partials ≤ qty); clientOrderId encoding bijective + constraint-safe.

**Deterministic paper-engine scenarios** (seeded, fake timers, scripted streams): gap-open through resting order; partial-fill ladder; fee in non-quote asset; daily-loss trip exactly at the boundary sample; **UTC rollover with open losing position** (anchor re-set, halt not auto-cleared); drawdown → HALTING → FLATTENING → flat with a fill arriving during HALTING; rate-runaway escalation; reorder-delivery mode exercising every out-of-order row in §6.1.

**Integration vs Binance Spot Testnet** (tagged, env-keyed, nightly — never default CI; tolerant of the ~monthly testnet reset):

1. auth + `apiRestrictions` probe (withdrawal-capable key refused); 2. far-from-touch limit place→cancel round-trip with exact Decimal parsing; 3. marketable-limit fill via WS-API user stream, fee handling, slippage metrics emitted; 4. partial fill at the touch → cancel remainder → cumQty consistent (auto-skip if book too thin); 5. deliberate LOT_SIZE/MIN_NOTIONAL/PRICE_FILTER violations → mapped codes → REJECTED; 6. **idempotent resubmit**: sever connection before ack → query-then-adopt, exactly one venue order; 7. WS kill mid-session → staleness rises, reconnect, reconciliation backfills a fill placed during the gap; 8. **external-order detection**: order placed with our prefix outside the OMS → reconcile HALTs; 9. seeded wrong local position → `QTY_DIVERGENCE` → HALT → manual-resume path; 10. controlled 429 burst → backoff honored, no silent drops. Plus the **sandbox-URL regression test** (assert resolved base URLs per mode against pinned ccxt).

**LIVE-GATE TEST MATRIX (mandatory in every CI pass):** all 2⁴ combinations of {env flag, armed, keysValid, limitsComplete} with live requested — only all-true yields live; every other row asserts effective = paper, `submit()` of a live-stamped intent throws `ModeViolationError`, **no `LiveExchangeAdapter` instance exists in the DI container**, refusal audited. Supplementary rows: all-true + `NODE_ENV=test` ⇒ paper with live key fields _stripped from the validated config object_; all-true + `CI=true` ⇒ paper + live adapter constructor throws if force-instantiated + live URLs absent from config — **CI has no code path or config value that reaches live** (and the CI secret store is never provisioned live credentials — the schema override is the in-code backstop, not the only line); simulated restart (new bootId) ⇒ disarmed, old HMAC token refused; arm-token TTL expiry/reuse refused + audited; armed-TTL expiry mid-session ⇒ downgrade + kill switch + audit; order created under live, mode downgraded before submit ⇒ `MODE_MISMATCH`.

**Coverage:** Risk, ModeControl, OMS reducer: **100% branch** (per-path Vitest thresholds — these modules fail the build below it). Repo overall ≥90% lines / ≥85% branches. Nightly: Stryker mutation testing on `risk/` ≥85% score (advisory).

**Commands (pnpm):**

```
pnpm build          # nest build
pnpm lint           # eslint (boundaries + money rules)
pnpm typecheck      # tsc --noEmit
pnpm format:check
pnpm test           # vitest run: unit + property (FC_NUM_RUNS=100 local)
pnpm test:livegate  # gate matrix — mandatory in every CI run
pnpm test:paper     # deterministic paper scenarios (fake timers)
pnpm test:cov       # coverage thresholds as gate
pnpm test:testnet   # integration suite — requires BINANCE_TESTNET_*; nightly
pnpm test:mutation  # stryker on risk/ (nightly, advisory)
```

CI order: lint → typecheck → unit+property → livegate → paper → coverage gate. Testnet + mutation nightly with testnet-only secrets.

## 10. Paper-vs-Live Switching & Safety Gates

`TradingMode = 'paper' | 'testnet' | 'live'`. **Paper is the landing zone for every missing, empty, or invalid input** — the zod schema defaults to paper and degradation is one-way toward paper, never toward danger. `effective = live` iff **all four** preconditions hold; `effective = testnet` iff requested ∧ sandbox keys valid; everything else is paper.

| Gate                       | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Env flag               | `TRADING_MODE=live` exactly; immutable post-boot (no hot-reload path exists).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| (b) Runtime interlock      | Two-step arming via admin API (localhost/private, token-authenticated; CLI wrapper `bot arm-live`): `POST /mode/arm/request` → crypto-random challenge bound to the current `bootId`, TTL 60 s → `POST /mode/arm/confirm` with `HMAC-SHA256(challengeId + ':' + bootId, ARMING_SECRET)` (a secret distinct from API keys, never logged; constant-time compare) _or_ a typed phrase mechanism — config picks one. Challenge single-use (replay refused + audited). Armed state is **in-memory only**: restart ⇒ new bootId ⇒ disarmed, and a captured token cannot arm the new process (bootId mismatch). Armed-session TTL 8 h ⇒ auto-disarm **+ kill-switch engage** (so the operator notices rather than silently paper-trading against a live position). Auto-disarm also on: kill-switch engage from any source, key-probe failure, reconcile mismatch, manual disarm. Arming preconditions: kill switch RUNNING, reconciliation clean, **no `*_UNKNOWN`/`RECONCILE_REQUIRED` orders**, other three gates already true — you arm _last_. |
| (c) Live keys valid        | present, `validateCredentials()` succeeds, and the key restriction probe (Binance `GET /sapi/v1/account/apiRestrictions`; re-probed every 60 s) shows: **withdrawals disabled — mandatory, refused outright, not warned**; transfers disabled; spot trading enabled; margin/futures absent; IP restriction warn-if-absent (config-escalatable). A failed probe mid-run flips keysValid ⇒ downgrade + kill switch. Environment/key cross-checks: a live key answering on a sandbox URL (or vice versa) ⇒ refuse + audit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| (d) Risk limits configured | `RiskLimitsConfig` schema-complete, all §5 limits non-null and positive; plus the in-engine limits-completeness rule as defense in depth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Any missing precondition ⇒ structured refusal (logged + audited + alert) and the process runs in paper.** No degraded "live-ish" state exists.

**Enforcement — four independent layers:**

1. **ModeControlService** — single source of `ModeResolution`; re-evaluated on every call (armed TTL checked per call; cached key verdict re-probed every 60 s).
2. **Execution per-order assert** — `assertCanTrade(intent.mode)` before every adapter call (catches disarm/downgrade mid-run; a stale paper intent cannot leak into live or vice versa).
3. **Live-adapter constructor guard** — the live adapter's DI factory requires a capability token mintable only by ModeControl at live boot; the constructor additionally throws unconditionally when `NODE_ENV ∈ {test, ci}` or `CI` is truthy. Live credentials are read only inside that factory: **in paper mode the live client is not gated — it is absent from the object graph.**
4. **Config-schema hard override** — evaluated before any module loads: `NODE_ENV ∈ {test, ci} ∨ CI` ⇒ `TRADING_MODE` coerced to paper **and** `BINANCE_LIVE_API_KEY`/`BINANCE_LIVE_API_SECRET`/`ARMING_SECRET` and live base URLs are _stripped from the validated config object_ — downstream code cannot even read them. Default and example configs ship `TRADING_MODE=paper`.

**Audit/log events** (→ `mode_transitions` + `audit_log` + structured log + metrics): `mode.boot_resolution{requested, effective, downgrades[], bootId}` · `mode.arm_requested/confirmed/failed{reason: TTL_EXPIRED|REPLAY|HMAC_MISMATCH|PRECONDITION}` · `mode.disarmed{trigger}` · `mode.downgrade{failedPrecondition}` · `mode.live_order_refused{intentId, code}` · `mode.key_check{restrictions snapshot — booleans only}` · `killswitch.engaged/resumed`.

---

## Proposed CLAUDE.md Outline (for this repo)

~45 lines, hard rules only (well under the ~150-instruction target):

```markdown
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
```

---

## Open Questions & Explicit Assumptions

Resolved during design (decision + rationale recorded, revisit only with cause): ORM = Drizzle (§7); test runner = Vitest (§9); accounting = average-cost, config-pinned (§8); daily-loss re-enable = manual (§5); sizing lives in Risk (§2.3); no order amend in v1 (§6.1); no internal cross-netting in v1 (§5 X1); reporting currency = USDT.

Open — options + recommendation, decided silently by no one:

| #   | Question                                | Options                                           | Recommendation                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Market scope at start                   | spot-only vs spot+perps                           | **Spot-only** (brief names Binance _Spot_ Testnet; perps add margin/liquidation/funding to Risk). `reduceOnly`/net-exposure hooks already in the types.                                                                                                                       |
| 2   | First venue set                         | Binance only vs multi-venue day one             | **Binance only.**                                                                                                                                                                                                 |
| 3   | Binance sandbox flavor for mode=testnet | Spot Testnet vs Demo Trading                      | **Testnet for the integration suite** (purpose-built, GitHub-login keys, production-equal filters); **Demo as the pre-live dress rehearsal** (live-mirroring data). Config supports both (`VenueConfig.environment`); revisit when ccxt repoints `setSandboxMode` [volatile]. |
| 4   | Strategy cadence at start               | candle-driven vs tick-driven                      | **Candle-driven** (deterministic, cheap, testable); tick/book handlers exist in the interface from day one.                                                                                                                                                                   |
| 5   | Admin API exposure                      | localhost-only + CLI vs authenticated remote HTTP | **Localhost + token + CLI wrapper**; no public surface.                                                                                                                                                                                                                       |
| 6   | RESIZED (clamp) verdict default         | clamp-don't-kill vs reject-only                   | **Clamp on exposure caps only (E1–E3), reject on fat-finger/band** — clamped orders can violate a strategy's intended R:R, so add a per-strategy `rejectOnClamp` opt-out.                                                                                                     |
| 7   | Backtesting                             | in scope now vs later                             | **Later** — pure strategies + journal replay + paper engine make a backtester a thin driver over existing code; not in the initial phases.                                                                                                                                    |
| 8   | Deployment                              | docker-compose vs k8s                             | **docker-compose** (bot + Postgres + Prometheus + Grafana) until operational needs say otherwise.                                                                                                                                                                             |
| 9   | Hot-swap drain default                  | cancel-open-keep-position vs cancel-and-flatten   | **CANCEL_OPEN_KEEP_POSITION** (attribution survives; flatten is a strategy decision, not a deploy artifact); per-strategy override.                                                                                                                                           |
| 10  | Equity sampling / monitor cadence       | 5 s vs 10 s                                       | **5 s + per-fill** (research design's tighter race window between monitor ticks).                                                                                                                                                                                             |

**Assumptions (stated; violations are flagged at runtime where detectable):** single account per venue; the bot is the only trader on its API keys (foreign orders are tolerated + flagged; our-prefix unknowns HALT; advisory lock blocks a second instance); UTC everywhere; one bot process per account (single-writer OMS — no horizontal scaling of order placement); strategies are long/flat on spot in v1 (no margin shorting).

---

## Phased Build Order

Each phase is independently reviewable and ends with a runnable verification step; later phases never require redesigning earlier ones. Every phase ends with the validation gate (`pnpm build && pnpm lint && pnpm typecheck && pnpm test:cov`).

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                   | Runnable verification                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0     | Scaffold: Nest 11 app, strict tsconfig, eslint (boundaries zones + money rules), ConfigModule (zod, paper-default, test/CI hard override), ObservabilityModule (pino + redaction, terminus, prom-client), docker-compose (Postgres/Prometheus/Grafana), CI, repo CLAUDE.md. **Re-verify [volatile] pins** (ccxt latest, Drizzle GA status, Nest minor). | app boots in paper; `/health/*` green; gate green                                                                    |
| 1     | `src/domain` types (branded money + smart constructors, events, Signal/OrderIntent/RiskDecision/ExecReport) + Persistence (Drizzle schema §7, SQL migrations incl. audit-log REVOKE/trigger/hash-chain, repos, outbox)                                                                                                                                  | migrations apply; exact-decimal round-trip tests; audit immutability test (UPDATE raises); gate green                |
| 2     | MarketData read-only: ccxt adapter (string mode, supervised watch loops, ChecksumError resync, staleness watchdogs), conflation cells + bounded queues, seq/gap/stale stamping, candle backfill; sandbox-URL regression test                                                                                                                            | runs against production public data; chaos test (kill socket) → auto-resync; stream metrics live; gate green         |
| 3     | StrategyModule: registry, lifecycle + warmup replay (signals discarded), mailboxes, CPU budget; one EMA-cross candle strategy emitting persisted Signals — no orders                                                                                                                                                                                    | live signals persisted; golden + replay-determinism tests; gate green                                                |
| 4     | RiskModule: SignalGateway, PositionSizer, RiskEngine (full §5 table), approval minting (HMAC proof), kill-switch state machine, rate buckets, crossing registry — evaluating logged intents, still no orders                                                                                                                                            | decision-table + property tests green (100% branch); simulated intent stream shows correct vetoes/clamps; gate green |
| 5     | ExecutionModule + PaperExchangeAdapter: reducer + order_events, write-ahead, clientOrderId codec, exec-report outbox, portfolio/virtual sub-accounts, fee ledger, equity sampler → **full paper loop end-to-end** with dashboards                                                                                                                       | deterministic paper suite green (incl. reorder-delivery rows); 24 h paper run produces sane dashboards; gate green   |
| 6     | OMS hardening + reconciliation: `*_UNKNOWN` states, error classifier + snapshot test, query loops, ReconciliationService (§6.4 taxonomy), crash-recovery, advisory lock, monitors (daily loss/drawdown incl. UTC-rollover + persisted-peak tests), HALTING/FLATTENING paths                                                                             | fault-injection suite green; forced mismatch HALTs without flatten; gate green                                       |
| 7     | Live order path vs **Binance Spot Testnet** (mode=testnet): real create/cancel/fetch, WS-API user-data streams (no listenKey), idempotent retries, monthly-reset tolerance                                                                                                                                                                              | `pnpm test:testnet` scenarios 1–10 green                                                                             |
| 8     | ModeControl: bootId-bound interlock, key-restriction probes (withdrawal refusal), live-adapter capability-token factory, config secret-stripping, full live-gate matrix                                                                                                                                                                                 | 2⁴ matrix + supplementary rows green in CI; CI-cannot-reach-live proven; gate green                                  |
| 10    | Ops polish: dashboards/alert rules finalized, runbook (halt/mismatch/re-arm/paper-honesty), event-loop budget test, 72 h paper soak                                                                                                                                                                                                                     | soak report: 0 unknown_unresolved, 0 reconcile mismatches, alert drills fire                                         |

---

## Todo Steps

- [ ] Phase 0: scaffold NestJS 11 app (pnpm), strict tsconfig, scripts `build/lint/typecheck/format:check/test/test:livegate/test:paper/test:cov/test:testnet`
- [ ] Phase 0: eslint — `eslint-plugin-boundaries` zones (domain/ports/modules/app) + money rules (`no-restricted-syntax`: parseFloat/Number/toBeCloseTo on money paths)
- [ ] Phase 0: ConfigModule (zod `validate`, registerAs namespaces; paper default; NODE_ENV=test/ci override stripping live secrets); ObservabilityModule (nestjs-pino + redact, terminus `/health/live|ready`, prom-client `/metrics`)
- [ ] Phase 0: docker-compose (Postgres 16, Prometheus, Grafana), CI pipeline (paper-forced, no live secrets provisioned), repo CLAUDE.md per outline; re-verify volatile pins (ccxt, Drizzle GA, Nest minor)
- [ ] Phase 1: `src/domain/types` — branded Decimal money + smart constructors (`Decimal.set` bootstrap policy), MarketEvent union, Signal, OrderIntent, RiskDecision, ExecReport, PortfolioSnapshot
- [ ] Phase 1: Drizzle schema + SQL migrations for §7 tables; audit_log append-only DDL (IDENTITY, hash chain, advisory-lock append, REVOKE + raise-trigger); customType NUMERIC(38,18)↔Decimal; exact round-trip + immutability tests
- [ ] Phase 2: CcxtMarketDataAdapter (`number: String`, supervised `for(;;)` watch loops, ChecksumError → invalidate + resubscribe, staleness watchdogs) + conflation cells/trade ring/candle queue + seq/gapBefore/stale stamping + REST candle backfill
- [ ] Phase 2: sandbox-URL regression test (assert resolved URLs for setSandboxMode/enableDemoTrading against pinned ccxt 4.5.58)
- [ ] Phase 3: StrategyRegistry + lifecycle (WARMUP replay, DRAINING filters, CPU budget) + MarketView + EMA-cross strategy; persist Signals; golden + bit-identical replay tests
- [ ] Phase 4: SignalGateway (serial per symbol, TTL, dedupe) + PositionSizer + RiskEngine §5 table + approval HMAC minting/verification + kill-switch state machine + rate buckets (incl. reserved flatten bucket) + crossing registry; 100%-branch decision-table + fast-check property suites
- [ ] Phase 5: OMS reducer + order_events journal + write-ahead submit + clientOrderId codec + exec-report outbox (cursor/ack/dedupe) + portfolio virtual sub-accounts + fee ledger (base/quote/third-asset) + equity sampler
- [ ] Phase 5: PaperExchangeAdapter (book-walk, trade-through with print allocation, seeded latency, balance locks, ccxt-shaped errors, reorder-delivery test mode); deterministic scenario suite; first 24 h paper run
- [ ] Phase 6: error classifier + ccxt-hierarchy snapshot test; `SUBMIT_UNKNOWN`/`CANCEL_UNKNOWN` query loops; ReconciliationService (open orders/trades-with-overlap/balances-epsilon + monotone-drift escalation); crash recovery; per-(venue,key) advisory lock; DailyLoss/Drawdown monitors (UTC rollover, persisted peak); HALTING→FLATTENING (band-edge marketable limits, slicing); fault-injection suite
- [ ] Phase 7: CcxtExchangeAdapter order path vs Binance Spot Testnet (WS-API user streams, Ed25519-ready); `pnpm test:testnet` scenarios 1–10; monthly-reset tolerance
- [ ] Phase 8: ModeControl (challenge/HMAC/bootId/TTL/single-use; 8 h armed TTL → disarm + kill switch; key-restriction probe with withdrawal refusal; arming blocked on unknowns) + live-adapter capability-token factory + live-gate matrix (16 rows + supplementary) in default CI
- [ ] Phase 10: dashboards + alert rules; runbook (halt/mismatch/re-arm procedures, paper honesty box); event-loop budget test; 72 h paper soak + report
- [ ] Validation gate (every phase and final): `pnpm build && pnpm lint && pnpm typecheck && pnpm test:cov` — all green, livegate included in `test`
