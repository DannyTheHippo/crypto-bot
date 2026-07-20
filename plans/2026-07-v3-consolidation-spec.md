# v3 Consolidation Architecture Spec

Status: DESIGN — implements the approved v3 program (owner plan `how-can-we-save-snuggly-grove`, Decision Ledger rounds 1–11, not re-openable). This spec is the full-depth expansion of that plan's "v3 Design" section. Every call below is made; there are no TBDs. Where a value depends on a live venue read, the spec names the deterministic procedure and the mandatory probe gate (the standing #54 keyed-probe pattern) — the procedure is the decision.

Grounding evidence read for this spec: `src/app.module.ts` (2,427-line root, provider inventory below), `src/config/environment/environment.config.ts` (full env schema), `src/database/schemas/trading/trading.schema.ts`, `src/features/common/observability/metrics.service.ts`, `src/features/trading/agentic/agent-prompt.ts` (`DECISION_V2_BOUNDS`, `buildTrade*Tool`), `src/features/trading/agentic/universe-scanner.service.ts`, `src/features/trading/risk/position-sizer.service.ts`, `src/features/trading/mode-control/{mode-control.module.ts,mode-control.service.ts}`, `src/features/trading/execution/execution.module.ts:109-142`, `reports/loop/a0-analysis-2026-07-20.md`, `reports/loop/universe-study-2026-07-13.md`, `reports/loop/state.md` (X2 stage-1 record), `.env.app`, `.env.app-perp`, `docker-compose.yml`, the six existing `src/features/trading/composition/*.module.ts` files.

Non-negotiable constraints carried verbatim: hard rules 1–7 (decimal money; Strategy→Risk→Execution; paper default / live gated; OMS no-blind-resubmit; append-only `audit_log`/`order_events`; no secrets; pino redaction). `test:livegate` grows, never weakens. Boundaries zones (eslint-plugin-boundaries) stay enforced; the `app` zone already covers `src/features/trading/composition/**` (W3 Part 4 precedent, `app.module.ts:41-44`).

Core invariant of the whole design: **the engines are already venue-keyed** (`venue` on intents, orders, fills, positions, signals, risk_decisions); **the singletons stay single** (`PORTFOLIO_VIEW`, `KILL_SWITCH`, risk engine, OMS, promotion verdict, LLM budget); **only the composition/config/schema/metrics layers assumed one venue**. v3 rebuilds exactly those four layers.

---

## 1. VenueRuntime composition graph

### 1.1 Current inventory (what is being replaced)

`app.module.ts` today contains six inline `@Global()` modules plus the root's own provider block and the `AppModule` lifecycle class (the plan's "7 inline @Globals" counts the root block):

| Inline module | Providers (v2) |
| --- | --- |
| `DrizzlePersistenceGlobalModule` (line 297) | `EXEC_OUTBOX_OVERRIDE`, `EXECUTION_STORE_OVERRIDE`, `INSTANCE_LOCK_OVERRIDE`, `MODE_AUDIT_OVERRIDE`, `RISK_JOURNAL_OVERRIDE`, `SIGNAL_JOURNAL`, `FUNDING_PAYMENTS` |
| `KeyProbeModule` (line 403) | `KEY_PROBE` (single venue via `primaryVenue()`) |
| `ArmPreconditionsModule` (line 475) | `ARM_PRECONDITIONS` |
| `PaperExchangeModule` (line 567) | `PAPER_CONFIG`, `EXCHANGE_PORT` (single venue) |
| `MarketFeedModule` (line 866) | `CLOCK`, `WATCH_SOURCE`, `MD_EXCHANGE`, `REAL_FEED_HEALTH`, `EXCHANGE_STREAM`, `MARKET_STREAM_TELEMETRY`, `MARKET_STREAM`, `FEED_HEALTH`, `DERIVATIVES_FEED`, `SENTIMENT_FEED`, `FEAR_GREED_FEED`, `TRADE_FLOW_FEED`, `POSITIONING_FEED`, `LIQUIDATION_FEED`, `FUNDING_INGEST` |
| `AgenticCompositionBridgeModule` (line 1480) | `AGENT_DECISION_JOURNAL`, `LLM_USAGE_SINK`, `PLAYBOOK_PROVIDER_OVERRIDE`, `AGENT_TRADING_PROFILE_OVERRIDE`, `ACTIVE_MENU_GATE_OVERRIDE`, `ExecQualityService`, `PriceHistoryStore`, `EXEC_QUALITY_SINK_OVERRIDE`, `PAYLOAD_EXTRAS_PROVIDER_OVERRIDE`, `REFLECTION_METRICS_RECORDER_OVERRIDE`, `PROMOTION_STATS`, `REFLECTION_EVIDENCE` |
| Root provider block (line 1793) | `APP_FILTER`, `SignalSinkService`, `SIGNAL_REJECTIONS_COUNTER`, `HaltCoordinatorService`, `PROTECTIVE_EXIT_CONFIG`, `PLAN_STOP_REGISTRY`, `ProtectiveExitService`, `PROTECTIVE_EXITS_COUNTER`, `SIGNAL_SINK`, `STRATEGY_HOST` |
| `AppModule` class body | driver timers, `startTrading`, per-symbol strategy registration, `MetricsWrappingAgentClient` wrap, key-probe refresh, fill poll, portfolio log, XA6 channel-tier wiring |

Venue-singleton assumptions to retire: `primaryVenue()` (`app.module.ts:540-542`), `feedVenueConfig()` (`:852-857`), `agenticParams`' `venues[0]` (`:2370`), `reconConfigFrom`'s `venues[0]` (`execution.module.ts:139`), `readinessConfigProvider`'s `venues[0]` (`mode-control.module.ts:68`), `PERP_VENUE_ID` local copies (`app.module.ts:504`, `position-sizer.service.ts:26`, `execution.module.ts:132`).

### 1.2 The VenueRuntime concept

A **VenueRuntime** is the per-venue bundle: venue config + credentialed order client + exchange adapter + market stream adapter + feed-health instance + the venue's symbol subset + capital share. Two instances exist (spot `binance`, perp `binanceusdm`). They are **data, not DI scopes**: NestJS gets one flat module graph; per-venue instances live inside a registry map, and every existing singleton token (`EXCHANGE_PORT`, `EXCHANGE_STREAM`, `FEED_HEALTH`) is re-bound to a **routing facade** over the map. This preserves all 10–21 reference sites per singleton unchanged — the engines keep injecting one port; the facade dispatches on the `venue` field already present on every intent/order/symbol.

Symbol→venue resolution is a pure function, minted once in `src/domain/types/venue-map.ts` (new, pure — imports only `symbol.ts`):

```ts
export const SPOT_VENUE = 'binance';
export const PERP_VENUE = 'binanceusdm';
export function venueForSymbol(symbol: SymbolId): VenueId {
  return splitSymbol(symbol).settle !== undefined ? venueId(PERP_VENUE) : venueId(SPOT_VENUE);
}
```

This retires every local `PERP_VENUE_ID` copy (three sites) — all three files import this single source.

### 1.3 v3 module set under `src/features/trading/composition/`

Kept as-is (W3 seam, byte-identical): `db-health-bridge.module.ts`, `portfolio-view-bridge.module.ts`, `strategy-registry-bridge.module.ts`, `signing-key.module.ts`, `kill-switch.module.ts`, `limits-complete.module.ts`.

New/moved modules (all `@Global()` unless noted, role-suffixed filenames per house style):

**`venue-registry.module.ts` — `VenueRegistryModule`.** Provides/exports `VENUE_REGISTRY: ReadonlyMap<VenueId, VenueRuntimeDescriptor>` where

```ts
interface VenueRuntimeDescriptor {
  readonly venue: VenueId;
  readonly config: VenueConfig; // id + environment from VENUES
  readonly symbols: readonly SymbolId[]; // TRADING_SYMBOLS partitioned by venueForSymbol
  readonly capitalShare: string; // VENUE_CAPITAL_SPLIT[venue], decimal string
  readonly perpCapable: boolean; // venue === PERP_VENUE
}
```

Built purely from `TypedConfigService`; no network. Every other composition module injects this instead of reading `config.venues[0]`.

**`persistence-overrides.module.ts` — `PersistenceOverridesModule`** (replaces `DrizzlePersistenceGlobalModule`, code motion + one policy change). Same seven tokens. Policy change: the production no-DB branch dies — v3 config refuses to boot outside test/ci without `DATABASE_URL` (§3), so the `db === null` fallbacks are reachable only under test/ci (the hermetic suite keeps its in-memory backings).

**`exchange-adapters.module.ts` — `ExchangeAdaptersModule`** (replaces `PaperExchangeModule`). Providers:

- `VENUE_EXCHANGE_PORTS: ReadonlyMap<VenueId, ExchangePort>` — factory iterates `VENUE_REGISTRY`. Paper mode: `PaperExchangeAdapter` for spot + `PaperPerpAdapter` for perp, each seeded with its venue's `capitalShare` as starting balance (paper mirrors the split by construction). Testnet/demo: two `CcxtExchangeAdapter`s over `RealCcxtOrderClient`s built by the existing `buildOrderClient` (with `assertSwapPrivateUrlSafe` on the perp client, verbatim). Live: two `LiveExchangeAdapter`s each wrapping its venue adapter behind `LIVE_ADAPTER_CAP` — both constructors keep the unconditional test/ci throw.
- `EXCHANGE_PORT` — the **`VenueRoutingExchangeAdapter`** facade: implements `ExchangePort`; `placeOrder`/`cancelOrder`/`fetchOrder`/`fetchMyTrades`/`fetchBalances`/`fetchPositions`/`fetchFundingPayments`/`pinPerpVenueDefaults`/algo-rail methods dispatch on the argument's `venue` (or `venueForSymbol(symbol)` where only a symbol is present). Aggregating reads (`fetchBalances` with no venue) return per-venue-tagged results. Fail direction: an unroutable venue **throws** (fail CLOSED — a mis-routed order is a wrong-venue trade).
- `PAPER_CONFIG` — kept; `startingBalances` now derived from the split.

**`market-streams.module.ts` — `MarketStreamsModule`** (MarketFeedModule's stream half). Providers: `CLOCK`, `WATCH_SOURCE`, `VENUE_MD_EXCHANGES` (two public ccxt clients, replaces `MD_EXCHANGE`), `VENUE_FEED_HEALTH` (two `FeedHealthServiceWithBackfill` instances, one per venue, each over its own venue's symbols), `REAL_FEED_HEALTH`/`FEED_HEALTH` — a **symbol-routing FeedHealth facade** (`getRefPrice`/`fetchCandles`/`health` dispatch via `venueForSymbol`; `health()` with no symbol returns worst-of), `EXCHANGE_STREAM` — a **`MergedExchangeStream`** interleaving both `CcxtExchangeStreamAdapter`s' `marketRaw()`/`userEvents()` async iterables (the WATCH-R8-7 merged-iterator hardening applies here), `MARKET_STREAM_TELEMETRY` (concatenates both venues' channel ages; forced-reconnect counts summed per venue for the venue-labeled counter, §8), `MARKET_STREAM` — one `TeeingMarketStream` over the merged stream (paper feed sink resolves per event venue). XA6 channel tiering is wired per venue adapter (both get the shared scanner's `isActive` resolver). Sharding posture: carried from the X2 stage-1 re-acceptance memo — post-XA6 tiered subscription count at 24+16 symbols is ~35–45 subs across two connections (one per venue-class); sharding stays deferred with the same recovery-time math recorded.

**`context-feeds.module.ts` — `ContextFeedsModule`** (MarketFeedModule's poller half). `DERIVATIVES_FEED`, `SENTIMENT_FEED`, `FEAR_GREED_FEED`, `TRADE_FLOW_FEED`, `POSITIONING_FEED`, `LIQUIDATION_FEED`, `FUNDING_INGEST` — all constructed once over the combined basket. Trade-flow polls only symbols with a spot klines market (the stage-1 HYPE/KAITO fail-open residual becomes an explicit skip list derived at boot); derivatives/positioning/liquidation feeds take the perp symbol set; funding ingest takes the perp symbol set and stays DB-gated. `basketCurrenciesFor` and the source builders move here verbatim.

**`key-probe.module.ts` — `KeyProbeModule`** (moved out, redesigned per-venue — see §7). Provides `VENUE_KEY_PROBES: ReadonlyMap<VenueId, KeyProbePort>` and `KEY_PROBE` as the **AND-aggregate facade**: `probe()` runs both venue probes; `keysValid` only when every venue's recomputed validity holds; any venue failing ⇒ aggregate invalid (fail CLOSED). Paper binds the forced-invalid probe for both.

**`arm-preconditions.module.ts` — `ArmPreconditionsModule`** (moved out, logic unchanged): kill switch RUNNING + `CrashRecoveryService.hasUnresolvedOrders()` — both already book-level; the unresolved-orders read spans both venues' orders because the store is venue-keyed.

**`agentic-bridge.module.ts` — `AgenticBridgeModule`** (replaces `AgenticCompositionBridgeModule`). Same twelve tokens with these v3 deltas: `PLAYBOOK_PROVIDER_OVERRIDE` builds **one lineage** — seed = `SEED_PLAYBOOK_V3` (§9: `SEED_PLAYBOOK_PERP` const dies; the v3 seed folds the expert seed plus both lanes' final ACTIVE playbook text), validator capabilities fixed at `{ shortsAllowed: true, leverageAllowed: true }` (perp symbols exist in every v3 boot; per-symbol enforcement moved to the client zod layer, §4); `PlaybookAbRoutingProvider` + `ValidatingPlaybookProvider` carry over unchanged (candidate attribution feeds the promotion evaluator — kept). `ACTIVE_MENU_GATE_OVERRIDE` binds one `UniverseScannerService` over the combined 40-symbol basket (§5). `AGENT_TRADING_PROFILE_OVERRIDE` stays symbol-fallback-anchored. `PAYLOAD_EXTRAS_PROVIDER_OVERRIDE` gains per-venue free-cash lines (§6.4) and drops the single-symbol `fundingAccrualQuote` read in favor of a per-perp-symbol map.

**`trading-runtime.module.ts` — `TradingRuntimeModule`** (not `@Global`; imported by AppModule). Absorbs the root provider block verbatim (`SignalSinkService` … `STRATEGY_HOST`) plus a new `TradingRuntimeService` class extracted from the `AppModule` body: constructor injection list, `onModuleInit`/`onApplicationBootstrap`/`onModuleDestroy`, driver timers, `startTrading`, `agenticParams` (now `venue: venueForSymbol(symbol)`), the fill poller loop (iterates venues), the per-venue `pinPerpVenueDefaults` call (perp runtime only), per-venue reconciliation scheduling, and the XA6 tier wiring. `startTrading`'s `DEFAULT_FILTERS` boot assertion now covers all 40 symbols (perp filter rows added in the same pass, keyed-probe-verified steps — the BTC-perp 0.0001-step correction class).

**`app.module.ts` (v3)** shrinks to: imports (AppConfig, Persistence, Observability, the composition modules above, Risk, Execution, ModeControl, AgenticStrategy), `APP_FILTER`, `CorrelationMiddleware` wiring. Target ≤ 120 lines. No providers of its own.

### 1.4 Provider disposition (v2 → v3)

| v2 provider | v3 disposition |
| --- | --- |
| 7 persistence overrides | Survive → `PersistenceOverridesModule` (test/ci-only fallbacks) |
| `KEY_PROBE` | Survives, per-venue map + AND facade → `KeyProbeModule` |
| `ARM_PRECONDITIONS` | Survives verbatim → `ArmPreconditionsModule` |
| `PAPER_CONFIG`, `EXCHANGE_PORT` | Survive → `ExchangeAdaptersModule`; `EXCHANGE_PORT` becomes routing facade; + new `VENUE_EXCHANGE_PORTS` |
| `CLOCK`, `WATCH_SOURCE` | Survive → `MarketStreamsModule` |
| `MD_EXCHANGE` | **Deleted** (replaced by `VENUE_MD_EXCHANGES`) |
| `REAL_FEED_HEALTH`, `FEED_HEALTH`, `EXCHANGE_STREAM`, `MARKET_STREAM`, `MARKET_STREAM_TELEMETRY` | Survive as facades/merger → `MarketStreamsModule`; + new `VENUE_FEED_HEALTH` |
| 6 context feeds + `FUNDING_INGEST` | Survive → `ContextFeedsModule` (combined basket, venue-partitioned symbol sets) |
| 12 agentic-bridge tokens | Survive → `AgenticBridgeModule` (single-lineage playbook, per-venue extras) |
| Root block (10 providers) | Survive → `TradingRuntimeModule` |
| `AppModule` class body | → `TradingRuntimeService` |
| `primaryVenue`/`feedVenueConfig`/`venues[0]` reads (5 sites) | **Deleted**, replaced by `VENUE_REGISTRY` + `venueForSymbol` |
| `MetricsWrappingAgentClient`, `PlaybookAbRoutingProvider`, `ValidatingPlaybookProvider`, `createArmPreconditions` | Survive, move to their owning composition module files |

### 1.5 Execution-layer venue-awareness (composition workstream scope)

- `ReconciliationService`: `reconcile()` iterates `VENUE_REGISTRY`; one pass per venue per 30s tick; `ReconConfig` becomes per-venue: `balanceAxis: environment !== 'demo'` (both venues demo ⇒ off on both), `positionAxis: perpCapable`, `sweepSymbols: descriptor.symbols`. One `reconciliations` row per venue pass (schema gains `venue`, §2).
- `DemoFillPollerService.poll` takes `(venue, symbols)` and the runtime loop calls it per venue.
- `PortfolioStateService`: balances become venue-keyed (§6.4 snapshot change); equity = Σ over venues (one book, one equity, one peak, one drawdown).
- `KillSwitchService`: unchanged (one instance); its flatten/cancel paths go through the routing `EXCHANGE_PORT`, reaching both venues.

---

## 2. Schema v3 (Drizzle, fresh DB, single initial migration + one hardening migration)

Greenfield: `drizzle/0000_v3_initial.sql` + `0001_v3_append_only_hardening.sql` (the REVOKE + BEFORE UPDATE OR DELETE trigger bodies copied **verbatim** from v2's `0001/0008/0009/0013` for: `audit_log`, `order_events`, `funding_events`, `funding_payments`, `experiments`). No migration from v2 data. `numericMoney` = `NUMERIC(38,18)` custom type, carried.

Shared stamp (`tradingStamp`): `mode text NOT NULL ('paper'|'testnet'|'live')`, `run_id text NOT NULL`, `boot_id text NOT NULL` — carried on the same tables as v2. `mode` is deploy-environment segregation, never lane discrimination (there are no lanes).

Venue policy: `venue` stays on **venue-scoped operational facts**; **book-scoped measurement tables carry no venue** and no measurement query may filter on venue.

| Table | Columns (v3) | v3 delta vs v2 |
| --- | --- | --- |
| `order_intents` | `intent_id` PK, `client_order_id` UQ, `strategy_id`, `venue`, `symbol`, `side`, `type` (`LIMIT\|MARKET\|LIMIT_MAKER\|STOP_LOSS_LIMIT\|STOP_MARKET`), `qty` money, `limit_price` money, `trigger_price` money, `time_in_force`, `reduce_only` bool, `ref_price` money, `ref_seq` bigint, `created_at` bigint, `expires_at` bigint, `source_dedupe_key`, `source_event_time`, `source_based_on_seq`, `source_strength`, `signal_id`, `risk_intent_hash`, `risk_hmac`, `risk_nonce`, `risk_approved_at_ms`, `risk_limits_version`, `risk_snapshot_seq`, stamp, `created_at_wall` | + `trigger_price` promoted to a real column (v2 lacked it despite `OrderIntent.triggerPrice`) |
| `orders` | `intent_id` PK→FK, `client_order_id` UQ, `venue_order_id`, `strategy_id`, `venue`, `symbol`, `side`, `type`, `qty`, `limit_price`, `time_in_force`, `state`, `cum_qty`, `submitted_at`, `acked_at`, `first_fill_at`, `terminal_at`, `raw_ack` jsonb, stamp, `updated_at` | carried |
| `order_events` | `id` identity PK, `order_id` FK, `dedupe_key`, `event_type`, `payload` jsonb, `seq` bigint, `ts`, stamp; UQ(`order_id`,`dedupe_key`) | carried; **append-only trigger verbatim** |
| `fills` | `fill_id` identity PK, `venue`, `symbol`, `venue_trade_id`, `intent_id` FK, `client_order_id`, `price`, `qty`, `fee_ccy`, `fee_amount`, `fee_resolved`, `liquidity`, `venue_timestamp`, `source`, stamp, `ingested_at`; UQ(`venue`,`symbol`,`venue_trade_id`) | carried |
| `positions` | `strategy_id`, `venue`, `symbol`, `signed_qty`, `avg_entry`, `realized_pnl`, stamp, `updated_at`; PK(`mode`,`strategy_id`,`venue`,`symbol`) | carried |
| `balances` | `id` PK, `venue`, `asset`, `free`, `locked`, `ts`, stamp | carried (already venue-keyed) |
| `fee_ledger` | `id` PK, `venue`, `asset`, `amount`, `fill_id` FK, stamp, `ts` | carried |
| `signals` | `signal_id` PK, `strategy_id`, `venue`, `symbol`, `kind`, `strength`, `limit_price_hint`, `ref_price`, `based_on_seq`, `event_time`, `ttl_ms`, `dedupe_key`, `reason`, `outcome`, `intent_id` (soft), stamp, `ts` | carried |
| `risk_decisions` | `id` PK, `intent_id` (soft), `verdict`, `reasons` jsonb, `limits_version`, `snapshot_seq`, `inputs_hash`, stamp, `ts` | carried (book-level risk; the intent carries venue) |
| `exec_outbox` | `cursor` identity PK, `report_id` UQ, `payload` jsonb, stamp, `ts` | carried |
| `outbox_consumer_acks` | `consumer_id` PK, `cursor`, `acked_at` | carried |
| `equity_curve` | `id` PK, `run_id`, `ts`, `equity`, `cash`, `unrealized`, `peak`, `session_date_utc`, `gap_annotation`, `boot_id`, `mode`; UQ(`run_id`,`ts`) | **book-scoped, no venue — one curve** |
| `config_snapshots` | `hash` PK, `config` jsonb, `activated_at`, `mode` | carried |
| `reconciliations` | `id` PK, **`venue` NOT NULL (NEW)**, `ts`, `duration_ms`, `open_orders_checked`, `trades_checked`, `balances_checked`, `discrepancies` jsonb, `result`, stamp | + `venue` (one row per per-venue pass) |
| `mode_transitions` | `id` PK, `from_mode`, `to_mode`, `actor`, `evidence` jsonb, `boot_id`, `ts` | book-scoped (one arming) |
| `audit_log` | `seq` identity PK, `ts`, `actor`, `category`, `payload` text, `prev_hash`, `hash` | carried; **REVOKE + trigger verbatim**; hash-chain semantics unchanged |
| `agent_decisions` | `id` PK, `strategy_id`, `symbol`, `venue`, `trigger_kind`, `based_on_seq`, `event_time`, `model`, `action` (`open_long\|open_short\|close\|adjust\|hold\|error`), `confidence`, `rationale`, `ref_price`, `close`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `latency_ms`, `playbook_version`, `prompt_hash`, `input_payload` text, `plan_json` jsonb (v2 shape incl. `nextConsultBars`/`regimeTags`), `consult_id`, `created_at`; idx(`strategy_id`,`event_time`) | − `info_arm`, − `thinking_arm` (factorial retired); action union drops legacy `long\|flat` (legacy contract deleted, §9); venue kept for operational queries only — **measurement never filters on it** |
| `agent_playbook_versions` | `id` PK, `version` UQ, `content`, `source` (`seed\|reflection\|promotion\|loop-candidate`), `parent_version`, `created_at`; promotion-per-UTC-day partial UQ | **one lineage — no lane column, single version sequence** |
| `llm_usage` | `id` PK, `kind` (`decide\|reflection`), `model`, `mode`, `strategy_id`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `created_at` | + decide-path writer wired (XA4c carried into v3: the decide client records here; breakers meter true cost) |
| `funding_events` | `id` PK, `strategy_id`, `venue`, `symbol`, `funding_rate`, `mark_price`, `signed_qty`, `payment_quote`, `funding_time`, `mode`, `created_at` | carried; **append-only trigger verbatim** |
| `funding_payments` | `id` PK, `venue`, `symbol`, `venue_payment_id`, `amount_quote`, `funding_time`, `mode`, `created_at`; UQ(`venue`,`symbol`,`venue_payment_id`) | carried; **append-only trigger verbatim**; the payload accrual read becomes DB-backed (X2f carried) |
| `experiments` | `id` PK, `family`, `params_hash`, `dataset_hash`, `source`, `label`, `metrics` jsonb, `created_at`; idx | carried; **append-only trigger verbatim** |

Book-scoped measurement set (promotion/reflection/attribution read these with **no venue predicate**): `equity_curve`, `agent_playbook_versions`, `llm_usage`, `agent_decisions` (aggregation over all rows), `fills`-walk in `PromotionStatsRepository` (walks all venues' fills into one round-trip ledger; `funding_payments.amount_quote` adds into net — sign convention carried).

---

## 3. Config env inventory (single `.env.app`, lane files die)

### 3.1 New knobs

| Var | Shape / default | Semantics |
| --- | --- | --- |
| `VENUE_CAPITAL_SPLIT` | JSON `{"binance":"500","binanceusdm":"500"}` (decimal strings; default exactly that) | Fixed wallet split of the book. Zod: keys must exactly equal the configured `VENUES` ids; every share a positive decimal string; Σ shares ≤ `SIZER_EQUITY_CAP` — violation ⇒ **boot refusal (fail CLOSED)** |
| `AGENTIC_MAX_POSITION_FRACTION_SPOT` | fractionString, default `0.15` | Per-spot-symbol sizeFraction cap |
| `AGENTIC_MAX_POSITION_FRACTION_PERP` | fractionString, default `0.35` | Per-perp-symbol sizeFraction cap |
| `MARKET_BOOK_BAND_BPS` | int, default `50` | Book band-truncation (Group-1 workstream), fail OPEN |
| `MARKET_BOOK_MAX_LEVELS` | int, default `1000` | Book depth cap per side, fail OPEN |

### 3.2 Kept (new defaults where changed)

`PORT` (3100), `LOG_LEVEL`, `TRADING_MODE`, `NODE_ENV`/`CI`, `SANDBOX_ENV` (default `demo`), `FEED_ENV` (process.env, kept), `HOST`, `STARTING_CASH` (process.env, kept).

- `DATABASE_URL` — **required outside test/ci** (new cross-field refusal; the DB is mandatory for the one-book evidence chain).
- `VENUES` — kept, but outside test/ci must be non-empty and its id set must exactly cover the venues implied by `TRADING_SYMBOLS` via `venueForSymbol` (a `:USDT` settle symbol with no `binanceusdm` entry, or vice versa ⇒ refusal). Default deployed value: `[{"id":"binance","environment":"demo"},{"id":"binanceusdm","environment":"demo"}]`.
- `TRADING_SYMBOLS` — kept; deployed value = 24 spot (current `.env.app:61` list) + 16 perps (§5.4) = 40 entries; uniqueness + `DEFAULT_FILTERS` boot assertion carried.
- `STRATEGY_INTERVAL` (`15m` deployed), `ACTIVE_STRATEGY` (`agentic`).
- Agentic core: `AGENTIC_MODEL` (`claude-sonnet-5`), `AGENTIC_REFLECTION_MODEL`, `AGENTIC_TIMEOUT_MS`, `AGENTIC_REFLECTION_TIMEOUT_MS`, `AGENTIC_MAX_TOKENS` (schema default **4096**, was 1024 — the deployed v2-contract shape becomes the default), `AGENTIC_MIN_DECISION_INTERVAL_MS`, `AGENTIC_WARMUP_BARS`, `AGENTIC_ENTRY_TTL_BARS`, `AGENTIC_FALLBACK_CONSULT_BARS` (default **8** — XA1), `AGENTIC_WAKE_MOVE_PCT` (default **0.008** — XA1), `AGENTIC_PLAN_MODE` (default **true** — the only deployed shape), `AGENTIC_PLAN_EXIT_TTL_BARS`, `AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS`, `AGENTIC_VENUE_TP` (default **true**), `AGENTIC_VENUE_TP_REPLACE_DRIFT_BPS`, `AGENTIC_VENUE_STOP` (default **true**), `AGENTIC_VENUE_STOP_REPLACE_DRIFT_BPS`, `AGENTIC_MAX_ENTRIES_PER_DAY`, drain cooldowns, reflection knobs (`EVERY_N_TRADES`, `COOLDOWN_MS`), `AGENTIC_PLAYBOOK_PIN`, `AGENTIC_PLAYBOOK_AB_PCT` (kept — candidate attribution), `AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES`, mint-backtest knobs, token prices (`AGENTIC_TOKEN_PRICE_*`, `AGENTIC_TOKEN_PRICES_JSON`), `AGENTIC_PORTFOLIO_CONSULT` (default **true** — rollback lever), `AGENTIC_PORTFOLIO_WINDOW_MS`, feature-context flags (`AGENTIC_DERIVATIVES_V2_ENABLED`, `AGENTIC_CROSS_SYMBOL_*`, `AGENTIC_BOOK_STRUCTURE_ENABLED`, `AGENTIC_TRACK_RECORD_ENABLED`, `AGENTIC_TRADEFLOW_*`, `AGENTIC_POSITIONING_*`, `AGENTIC_LIQUIDATIONS_ENABLED`), feed flags (`DERIVATIVES_FEED_*`, `SENTIMENT_FEED_*`, `FEAR_GREED_*`, `FUNDING_INGEST_*`).
- Unified budget: `AGENTIC_DAILY_COST_STOP_USD` default **3** (one book budget); `AGENTIC_MAX_CALLS_PER_DAY` default **2000**; `AGENTIC_MAX_TOKENS_PER_DAY` default **4,000,000** (two lanes merged; the $-breaker remains the true governor).
- Promotion: `PROMOTION_EVIDENCE_EPOCH` (ONE knob, stamped once at the v3 demo cutover flat instant — strict ISO refinement carried), `PROMOTION_DUST_NOTIONAL`.
- Menu: `AGENTIC_ACTIVE_MENU_SIZE` default **8** (§5).
- Sizing/risk: `EXIT_CROSS_BUFFER_BPS`, `ENTRY_ORDER_TYPE`, `BASE_NOTIONAL`, `SIZER_EQUITY_FRACTION`, `SIZER_EQUITY_CAP` (**default `1000`, now defaulted rather than optional-uncapped** — the $1k book is the program constraint; explicit `0` disables), `PROTECT_STOP_LOSS_PCT`, `PROTECT_TRAILING_PCT`, `PLAN_STOP_WATCH_ENABLED`, `PLAN_STOP_FORCE_BPS`, `STOP_LIMIT_BUFFER_BPS`, `RISK_STALE_MAX_AGE_MS`.
- Risk limits, re-defaulted to book scale (v2's schema defaults were pre-$1k-book drift; deployed values become defaults): `RISK_MAX_ORDER_NOTIONAL` `'400'`, `RISK_MAX_POSITION_PER_SYMBOL` `'350'`, `RISK_MAX_GROSS_EXPOSURE` `'1200'`, `RISK_MAX_NET_EXPOSURE` `'1200'`, `RISK_MAX_DAILY_LOSS` `'50'`, `RISK_MAX_DRAWDOWN_PCT` `'0.2'`, `RISK_MAX_BAND_BPS` 100, `RISK_MAX_PASSIVE_EXIT_BAND_BPS` 1200, `RISK_MAX_STOP_TRIGGER_BAND_BPS` 2000.
- Perp mechanics (bind to perp-venue symbols only): `PERP_LEVERAGE_CAP` (default **2** — the deployed perp value), `PERP_MMR_FALLBACK` `0.005`, `PERP_LIQ_BUFFER_PCT` `0.20`.
- Secrets (`.env` only, never in schema/AppConfig): `BINANCE_DEMO_*`, `BINANCE_TESTNET_*`, `BINANCE_LIVE_*`, `ARMING_SECRET`, `ANTHROPIC_API_KEY`, `SENTIMENT_FEED_API_KEY`, `LIVE_BASE_URL_OVERRIDE`, Grafana password.

### 3.3 Renamed / merged (old → new)

| Old | New |
| --- | --- |
| `AGENTIC_MAX_POSITION_FRACTION` (0.15 spot lane / 0.35 perp lane) | `AGENTIC_MAX_POSITION_FRACTION_SPOT` + `AGENTIC_MAX_POSITION_FRACTION_PERP` |
| Two lane `AGENTIC_DAILY_COST_STOP_USD` (1.50 + 1.50) | One `AGENTIC_DAILY_COST_STOP_USD=3` |
| Two lane `AGENTIC_MAX_CALLS_PER_DAY` (1100 × 2) | One `AGENTIC_MAX_CALLS_PER_DAY=2000` |
| Two lane `PROMOTION_EVIDENCE_EPOCH` | One epoch knob (fresh stamp at cutover) |
| Two lane `AGENTIC_ACTIVE_MENU_SIZE` (12 / 4) | One `AGENTIC_ACTIVE_MENU_SIZE=8` |
| `SIZER_EQUITY_FRACTION` (0.04 / 0.05) | One value, deployed `0.04` (spot's — conservative side; sizeFraction is the active channel anyway) |

### 3.4 Deleted knobs (tombstones removed from schema, `.env.example`, docs)

`TRADING_SYMBOL` (legacy single-symbol fallback — `TRADING_SYMBOLS` becomes required), `PERP_VENUE_ENABLED` (venue presence in `VENUES` is the signal), `AGENTIC_SHORTS_ENABLED` (shorts are a per-symbol capability derived from venue, not a boot flag), `AGENTIC_DERIVATIVES_AB_PCT` (XA3: control arm retired at 0), `AGENTIC_AUTO_PROMOTE_MIN_TRADES` (legacy count-only path, superseded by the attributed knob).

### 3.5 Cross-field zod refusals (all fail CLOSED at construction)

Preserved: `PROTECT_STOP_LOSS_PCT > AGENTIC_MAX_STOP_LOSS_PCT` when enabled; `AGENTIC_ACTIVE_MENU_SIZE ≤ |TRADING_SYMBOLS|`; `EXIT_CROSS_BUFFER_BPS < RISK_MAX_BAND_BPS`; reflection-model pricing map completeness; `AGENTIC_TOKEN_PRICES_JSON` parse-fail-loud; `VAR=`-empty stripping + inline-comment stripping; test/ci live-credential strip.

Replaced: the v2 "venue TP + venue stop only if all venues perp" refusal (`environment.config.ts:843-865`) is structurally unenforceable on a mixed-venue boot and is replaced by a **per-symbol rule in the strategy**: perp symbols may rest TP and stop simultaneously (both reduce-only against margin); spot symbols rest the TP only — the spot stop stays executor bar-close + `PLAN_STOP_WATCH` (no OCO wiring, backlog #44 unchanged). `manageVenueStop` skips spot symbols whenever `AGENTIC_VENUE_TP` is also on; declared fail direction: the skip loses nothing that v2 had (v2 spot ran TP-only).

Replaced: `AGENTIC_SHORTS_ENABLED requires binanceusdm` — moot (flag deleted; `open_short` gating is per-symbol, §4).

New: `DATABASE_URL` required outside test/ci; `VENUES` non-empty + exact symbol-coverage outside test/ci; `VENUE_CAPITAL_SPLIT` key-set/positivity/Σ ≤ cap; `AGENTIC_PLAN_MODE=false` refused when any perp symbol is configured (shorts and venue rails require plan mode — carried from the v2 perp constraint, now cross-field).

---

## 4. Unified tool contract

One contract, two tools, built by two factories (the four lane-split factories collapse; legacy `DECISION_TOOL`/`SHORTS_DECISION_TOOL`/`PLAN_TOOL`/`PLAN_SHORTS_TOOL`/`PORTFOLIO_TOOL`/`PORTFOLIO_SHORTS_TOOL` and their client paths are deleted, §9 — v3 ships the rich decision contract only).

### 4.1 Bounds (single source: `DECISION_V2_BOUNDS`, carried verbatim)

| Field | Bounds | Notes |
| --- | --- | --- |
| `sizeFraction` | min 0.005; max **per symbol**: 0.15 spot / 0.35 perp | injected per-symbol, no longer per-process |
| `entry.offsetBps` | [−150, 150] int | |
| `entryValidityBars` | [1, 16] int | |
| `stopLossPct` | [0.002, `AGENTIC_MAX_STOP_LOSS_PCT`] | same bound the `PROTECT_STOP_LOSS_PCT` refusal uses (`domain/risk/agentic-bounds.ts`) |
| `takeProfitPct` | [0.001, 0.2] | |
| `maxHoldBars` | [1, 288] int | |
| `partialCloseFraction` | [0.05, 0.95] | adjust only |
| `thesis` | ≤ 300 chars | |
| `nextConsultBars` | [1, 32] int | portfolio-level only (XA1 cap carried) |

Bounds ride in descriptions only; enforcement is the client zod layer (strict tool use 400s on JSON-schema min/max — carried constraint).

### 4.2 Per-symbol capability flags (payload side)

Each symbol block in the batched user payload carries a `capabilities` object; the model reads it, the zod layer enforces it:

```jsonc
{
  "symbol": "SOL/USDT:USDT",
  "capabilities": {
    "venue": "binanceusdm", // 'binance' | 'binanceusdm'
    "shorts": true, // perp only; spot: false
    "leverage": "2", // PERP_LEVERAGE_CAP; spot: "1"
    "maxSizeFraction": "0.35", // per-venue cap, decimal string
    "venueFreeCash": "212.41" // that wallet's free quote/margin (display-grade string)
  }
  // ...existing market/context blocks unchanged
}
```

### 4.3 Tool schemas

`buildTradeTool(caps: SymbolCapabilities)` — single-symbol (non-batched fallback path): name `submit_trade`, strict; `action` enum `open_long|open_short|close|adjust|hold` with unified description text: `open_short` is VALID ONLY for symbols whose `capabilities.shorts` is true — an `open_short` on a spot symbol is rejected and journaled as a capability violation; same-side `open_*` is a scale-in (fresh directives, max-hold restarts); opposite-side `open_*` while positioned is a no-op hold. Shared field set: `sizeFraction` (number; fraction of the ONE account equity, capped at `SIZER_EQUITY_CAP`, in [0.005, symbol's `maxSizeFraction`]; venue wallet headroom additionally clamps), `entry {style: maker|taker, offsetBps int}`, `entryValidityBars`, `stopLossPct`, `takeProfitPct`, `maxHoldBars`, `partialCloseFraction`, `thesis`. Required: `action`; `additionalProperties: false`.

`buildTradePortfolioTool(capsBySymbol)` — the primary (batched) path; name stays `submit_portfolio` (batching seam targets it by name): `decisions` array of per-symbol objects (`symbol` + `action` + the shared field set, required `symbol`+`action`, no additional properties) plus top-level `nextConsultBars` (int, PORTFOLIO-LEVEL, one value for the whole cross-venue batch, [1,32]). Required: `decisions`, `nextConsultBars`.

The action enum always includes `open_short` (one schema, no lane variants). Enforcement: the client zod layer validates each decision against **its symbol's** capabilities — `open_short` on `capabilities.shorts=false` ⇒ that element degrades to `hold`, is journaled with action `error` + rationale `capability_violation:open_short_on_spot`, and increments `agentic_capability_violations_total{kind="open_short_on_spot"}`. Named degrade, never silent (XA4b discipline). `sizeFraction > maxSizeFraction` clamps at the sizer as today (the sizer's `maxAgentPositionFraction` becomes per-venue, §6).

### 4.4 Action mapping (unchanged semantics, venue-resolved)

| Action | Mapping |
| --- | --- |
| `open_long` | plan-managed entry → `ENTER_LONG` Signal (`sizeFraction`, entry style/offset, directives to plan-executor); venue = `venueForSymbol` |
| `open_short` | perp symbols only → `ENTER_SHORT` Signal (same directive set; `direction: 'short'`) |
| `close` | full reduce-only exit → `EXIT_LONG`/`EXIT_SHORT` by position sign; universal cancel-resting-before-close invariant (XA5a) applies |
| `adjust` | in-place directive revision; optional `partialCloseFraction` → reduce-only partial; max-hold clock never resets |
| `hold` | no signal; `nextConsultBars` + `regimeTags` journaled (XA4 shape carried) |

Prompt deltas (agentic workstream): whole-book framing ("one account, two wallets, fixed split — per-venue free cash shown per symbol"), per-venue free-cash lines in the portfolio block, the XA3 mandate edits carried into `SEED_PLAYBOOK_V3`, the perp first-principles liquidation paragraph carried, `promptHash` recomputed over the new template (new template version tag `v3`).

---

## 5. Scanner + menu

### 5.1 Combined basket and ranking

One `UniverseScannerService` over the 40-symbol basket (24 spot + 16 perp). Ranking formula carried: score = 24h-quote-volume rank × ATR% rank (product, lower better), candle-derived, quorum-guarded, alphabetical tie-break, `Infinity` for unwarmed symbols. Cross-venue note: ranks are computed on the combined pool — a venue's symbols compete on equal terms; volume/ATR are venue-comparable because both are derived from each symbol's own 15m candles.

### 5.2 Menu size = 8, with the A0-informed starvation check

Promotion pace requirement (`promotion-readiness.service.ts` via A0 finding 1): ≥30 closed round trips over ≥14 trade-anchored days ⇒ **≥2.14 closed trips/day**. Historical entry fractions per symbol-consult: 3.8% (perp) / ~9% (spot); planning blend **5%**.

Wake supply: fallback floor 8 bars × 15m = 2h ⇒ **12 guaranteed wakes/day**; wake-on-move 0.8%, fill wakes, and model self-scheduling (`nextConsultBars ≤ 32`) push the planning band to **12–24 wakes/day**.

Entry arithmetic at menu M: expected entries/day = wakes × M × 0.05.

- M=8: 12 wakes → 4.8 entries/day; 24 wakes → 9.6. Both ≥ 2.2× the 2.14 pace floor — headroom against the entry fraction being optimistic.
- M=6: 12 wakes → 3.6 (1.7× floor) — passes but thin coverage of a 40-symbol basket.
- M=4: 12 wakes → 2.4 (1.1× floor) — no headroom; rejected.

Cost arithmetic against the unified `AGENTIC_DAILY_COST_STOP_USD=3`: A0 measured ~$0.06–0.18 per 6-symbol batched wake with cache amortization; scaling ≈ linearly in payload symbols gives menu-8 ≈ **$0.08–0.24/wake, midpoint $0.15**.

- Menu 8 × 16 wakes ≈ **$2.40/day** ≤ $3 (steady-state target); 24 wakes × $0.15 = $3.60 — the breaker plus the XA1 pre-batch cost projection (degrade batch size before blowing the stop) bound the tail.
- Menu 12 (v2 spot's size) × 16 wakes ≈ $3.20 > $3 — starves the tail of every day; rejected.

**Decision: `AGENTIC_ACTIVE_MENU_SIZE=8`.**

### 5.3 Hysteresis, pinning, venue floor

- Hysteresis rank band: **12** (1.5 × menu, preserving v2's 12→18 ratio); stays a fixed constant, not a knob.
- Positioned/resting-order pinning carried verbatim (portfolio-snapshot pin via `ACTIVE_MENU_GATE_OVERRIDE`'s `isPinned`).
- **New venue floor:** after ranking, if fewer than 2 of either venue's symbols are in the fresh top-8, the under-represented venue's best-ranked members are promoted until it holds 2 (menu may transiently exceed 8 by ≤2, same class as pin overflow). Rationale: the combined verdict needs evidence from both venues; a one-venue hot streak must not zero the other's trip accrual. Fail direction: the floor only ever adds symbols (fail OPEN toward coverage).
- XA1 semantics carried: fallback consults are menu-scoped (active menu + positioned only), consult-gate outcomes all exported, pre-batch cost projection degrades batch size.

### 5.4 The 16-perp launch selection

Rule (extends the validated stage-1 recipe verbatim — `state.md` X2 stage-1 record + `universe-study-2026-07-13.md`): rank USDT-M perps by **mean |daily return| × log(30d mean quote volume)** on production fapi; **$0.50 price floor**; **crypto-native only** (equity-tokenized perps excluded — trading-hour gaps fight bar scheduling/staleness); every symbol + its filters **keyed-probe-verified on demo-fapi before wiring** (#54 pattern — 8/16 groundwork rows were wrong until probed).

The 16 = stage-1's 8 + the recorded stage-2 reserve + the next 5 by the same recipe:

1–8 (stage-1, live-verified): `BTC/USDT:USDT`, `ETH/USDT:USDT`, `SOL/USDT:USDT`, `ZEC/USDT:USDT`, `AAVE/USDT:USDT`, `NEAR/USDT:USDT`, `HYPE/USDT:USDT`, `KAITO/USDT:USDT`.
9–11 (stage-2 reserve, recorded in `state.md:475`): `TRUMP/USDT:USDT`, `UNI/USDT:USDT`, `BCH/USDT:USDT`.
12–16 (provisional next-5 by the recipe, spot-basket-overlapping liquid perps above the $0.50 floor): `XRP/USDT:USDT`, `LINK/USDT:USDT`, `AVAX/USDT:USDT`, `SUI/USDT:USDT`, `LTC/USDT:USDT`.

Binding procedure: at implementation, re-run the ranking script on production fapi and keyed-probe all 16 on demo-fapi; any candidate failing probe/floor/listing is replaced by the next-ranked crypto-native candidate, and the final list + probe evidence is recorded as a change-discipline decision record. The procedure, not the provisional names, is authoritative — this is the same substitution discipline stage-1 already exercised.

---

## 6. Capital-split sizing (exact, decimal-string arithmetic)

All arithmetic `Decimal`; every config value a decimal string; no native floats (hard rule 1). New `SizerDeps` fields: `venueCapitalShare: ReadonlyMap<VenueId, string>`, `maxAgentPositionFraction` becomes `maxAgentPositionFractionByVenue: ReadonlyMap<VenueId, string>`.

### 6.1 Definitions

```text
cappedBookEquity   = min(snapshot.equity, SIZER_EQUITY_CAP)                      // one book
venueCap(v)        = Decimal(VENUE_CAPITAL_SPLIT[v])                             // fixed share
maxFraction(v)     = spot ? MAX_POSITION_FRACTION_SPOT : MAX_POSITION_FRACTION_PERP
venueOpenNotional(v)     = Σ over positions p where p.venue = v : |p.signedQty| × refPriceOf(p.symbol)
venueReservedNotional(v) = Σ over inFlightIntents f where f.venue = v ∧ ¬f.reduceOnly :
                             f.qty × (f.limitPrice ?? f.refPrice)                // fails CLOSED: over-reserves partial fills
venueHeadroom(v)   = venueCap(v) − venueOpenNotional(v) − venueReservedNotional(v)
venueFree(v)       = spot: balances(v).get(quoteAsset).free                     // USDT free in the spot wallet
                     perp: balances(v).get(settleAsset).free                    // free margin in the perp wallet
```

### 6.2 Entry path (non-reduce-only, sizeFraction-directed — the v3 primary path)

```text
f          = min(Decimal(signal.sizeFraction), maxFraction(v))
target     = cappedBookEquity × f
symbolHeadroom = cappedBookEquity × maxFraction(v) − symbolPosNotional − symbolReservedNotional
                 // applied when same-side scale-in OR same-symbol reserved > 0 (carried clamp)
target     = min(target, symbolHeadroom)            // when applicable
target     = min(target, venueHeadroom(v))          // NEW: the split clamp — "venue share headroom"
target     = spot BUY: min(target, venueFree(v) × 0.95)                          // affordability, carried
             perp (both sides): min(target, marginNotionalCap(venueFree(v), leverageCap),
                                        liqSafeNotionalCap(leverageCap, mmrFallback, liqBufferPct))
             then applyFundingScaling(target, expectedFundingBpsPerHold)          // carried
qty        = roundToStep(target ÷ limitPrice, stepSize, 'down')
```

`min(venue share headroom, venue free balance)` from the decision ledger is realized as the two independent clamps (`venueHeadroom`, then the wallet-affordability clamp). A non-positive `target` after clamping routes to `BELOW_MINIMUM` (sizeFraction-directed) — carried semantics: an exhausted-headroom scale-in is a named rejection, never a dust order. Legacy `equityFraction`/`baseNotional` paths keep the same two new clamps (`venueHeadroom` inserted after the existing affordability clamp).

Sizing this way means the model reasons about one book (sizeFraction of book equity) while the split binds mechanically — a demo wallet can never be asked for an unfundable order (the greenfield-decision rationale: demo wallets cannot transfer).

### 6.3 Reduce-only paths (exits, covers, flatten, partial close)

**Exempt from every capital-split clamp.** `rawQty = |posQty| × Decimal(reduceFraction ?? '1')`, carried verbatim, including the perp min-notional exemption and the `RESTING`/`RESTING_STOP` price/trigger construction. Declared fail direction: reducing exposure is risk-reducing and must never be blocked by the split (fail OPEN with respect to the split; all venue-rounding and band gates still apply).

### 6.4 Snapshot and payload surface

`PortfolioSnapshot` gains `venueBalances: ReadonlyMap<VenueId, ReadonlyMap<Asset, Balance>>`; the existing combined `balances`/`equity`/`peakEquity` stay (one book — equity math unchanged as the sum over venues). `buildAgentPortfolioBlock` adds a `perVenue` array: one entry per venue with `venue`, `freeCash` (venueFree), `capitalShare`, `headroom` (venueHeadroom) — all display-grade decimal strings.

Spec coverage required (risk workstream): split-boundary cases (headroom exactly 0, negative after reservation), wallet-underfunded rejection, reduce-only bypass, cross-venue gross/net on combined equity, both-venue kill-switch flatten.

---

## 7. Arming matrix (one ceremony, per-venue keys)

### 7.1 Key policy change (explicit, livegate-pinned)

v2's spot probe required `marginOrFutures === false` (excess capability ⇒ invalid). v3's one account must trade USDT-M: the v3 authoritative recompute becomes, per venue surface:

- Spot surface: `!withdrawalsEnabled ∧ spotEnabled ∧ urlCrossCheckOk`
- Perp surface: `!withdrawalsEnabled ∧ futuresEnabled ∧ urlCrossCheckOk`
- Margin loans (cross-margin borrow) remain forbidden on both: `¬marginEnabled`.

`KeyProbePort` v3: `probeAll(): Promise<ReadonlyMap<VenueId, KeyProbeResult>>`; the aggregate `keysValid = ∀ venue: recomputedValid(venue)`. The recompute stays composition-side (never trusts the probe's own flag — S5 carried). Key fingerprints only, never raw keys.

### 7.2 Gate × venue evaluation order

| Order | Gate | Scope | Evaluated | Refusal condition (all fail CLOSED) |
| --- | --- | --- | --- | --- |
| 0 | Config authority (`TRADING_MODE=live`, test/ci force-paper, secret stripping) | process | boot | invalid/missing ⇒ paper |
| 1 | Promotion interlock (`assertAgenticLaneNotLive`) | book | boot (live only) | combined verdict not `permitted` (≥30 trips ∧ ≥14 days ∧ net-of-cost > 0 over the ONE book, epoch-bounded; evaluation error ⇒ undefined ⇒ refuse) |
| 2 | Arming REQUEST (bootId-bound challenge) | book | on request | armingSecret absent (test/ci) ⇒ never succeeds |
| 3 | Gate (c) key validation | **per venue, both** | at CONFIRM (fresh probe) | spot invalid ∨ perp invalid ∨ either probe unreachable |
| 4 | Gate (d) risk limits complete | book | at CONFIRM | incomplete limits |
| 5 | ARM_PRECONDITIONS | book | at CONFIRM | kill switch ≠ RUNNING ∨ unresolved orders (any venue) ∨ either check unreadable |
| 6 | CONFIRM (HMAC over challenge + bootId) | book | — | HMAC mismatch, TTL expiry, stale boot |

Arming flips **both venues together** — there is no per-venue armed state. Periodic probe refresh (60s) runs `probeAll`; **any** venue going invalid while ARMED ⇒ `disarm('KEY_PROBE_FAILURE')` (carried, now either-fails). Graduated live rollout is capital-side only (smaller `SIZER_EQUITY_CAP`), never per-venue arming — ledger decision 5.

### 7.3 `test:livegate` changes (matrix grows, never weakens)

Carried rows re-pinned unchanged: test/ci forces paper; live secrets stripped from AppConfig under test/ci; no `LiveExchangeAdapter` in the object graph on non-live boots; adapter constructor throws under test/ci; bootId-stale HMAC refused; TTL disarm; `KEY_PROBE_FAILURE` disarm.

New rows: (1) spot-valid + perp-invalid ⇒ CONFIRM refused; (2) perp-valid + spot-invalid ⇒ CONFIRM refused; (3) probe-unreachable on either venue ⇒ refused (fail CLOSED); (4) **two** live adapters constructed on a live boot, each behind `LIVE_ADAPTER_CAP`, both test/ci-throwing; (5) live boot with `VENUES` missing either venue ⇒ config refusal before any adapter constructs; (6) promotion verdict computed over book-scoped tables with no venue predicate (a venue-filtered evidence read in the gate is a livegate failure); (7) withdrawals-enabled on either surface ⇒ invalid; (8) the futures-enabled requirement on the perp surface does not weaken the spot surface's margin-loan prohibition.

---

## 8. Metrics inventory (name → labels)

Policy: `venue` label **only** on venue-scoped metrics; account/book gauges label-less (they now truly describe the one book). ONE Prometheus, ONE Grafana, v3-native dashboard.

| Metric | Labels | v3 status |
| --- | --- | --- |
| `equity_usdt`, `peak_equity_usdt`, `day_pnl_usdt`, `drawdown_ratio`, `unrealized_pnl_usdt`, `starting_cash_usdt`, `cash_usdt` (book Σ free USDT) | — | carried, label-less (one book) |
| `venue_free_cash_usdt` | `venue` | **NEW** — per-wallet free cash (the split's observable) |
| `venue_capital_headroom_usdt` | `venue` | **NEW** — `venueHeadroom(v)` (sizing observability) |
| `realized_pnl_usdt`, `position_qty`, `position_notional_usdt` | `venue`,`strategy`,`symbol` | + `venue` |
| `open_orders`, `in_flight_intents` | `venue` | + `venue` (venue-scoped facts) |
| `kill_switch_state` | `state` | carried (one switch) |
| `mode_info`, `boot_info` | carried | carried |
| `strategy_lifecycle` | `strategy`,`state` | carried |
| `event_loop_delay_p99_seconds`, `event_loop_utilization` | — | carried |
| `market_channel_staleness_seconds` | `venue`,`symbol`,`channel` | + `venue` |
| `market_stream_forced_reconnects_total` | `venue` | + `venue` (per stream adapter) |
| `reconciliation_runs_total` | `venue`,`result` | + `venue` (per-venue passes) |
| `agent_decide_total` | `outcome`,`model` | carried (one lane) |
| `agent_tokens_total` | `kind`,`model` | carried |
| `agent_decide_latency_seconds` | — | carried |
| `agentic_playbook_info` | `version` | carried — one lineage, one series |
| `playbook_validator_rejections_total` | `banned_token`,`token` | carried |
| `agent_client_info` | `kind` | carried |
| `agentic_consult_gate_total` | `outcome` | carried (all outcomes exported — XA1) |
| `agentic_reflection_outcomes_total` | `outcome` | carried |
| `agentic_venue_tp_total`, `agentic_venue_stop_total` | `venue`,`event` | + `venue` |
| `agentic_active_menu` | `symbol` | carried (combined menu) |
| `agentic_menu_churn_total` | `direction` | carried |
| `agentic_budget_remaining_usd` | — | carried — ONE unified budget |
| `agentic_capability_violations_total` | `kind` | **NEW** (§4.3) |
| `funding_payments_ingested_total` | `venue`,`symbol` | carried (already venue-labeled) |
| `derivatives_feed_staleness_seconds`, `derivatives_feed_poll_errors_total`, `sentiment_feed_*` | — | carried (global pollers) |
| `signal_rejections_total`, `protective_exits_total` | carried shapes | carried, book-level |
| `process_resident_memory_bytes` (prom-client default) | — | drives `AppMemoryHigh` |

**Which v2 metrics die:** no metric *names* are dropped except the retired factorial's journal-side arms (no metric existed); what dies is the **per-process duplication** — every series scraped twice under spot/perp Prometheus jobs collapses to one series from one scrape target, the second Prometheus dies, and the two per-lane `agentic_playbook_info` version sequences collapse to one. The W1 dashboard and its panels (per-lane variables, lane cost split) do not carry — the v3 dashboard is built native against this inventory.

Guardrails from day one (observability workstream): `NODE_OPTIONS=--max-old-space-size=1024` on the app service; compose `mem_limit`: app 1536m, postgres 512m, prometheus 512m, grafana 256m; alert `AppMemoryHigh`: app RSS > 1.2 GiB for 10m (thresholds tightened to measured peaks at the validation gate); footprint acceptance: stack ≤ ~2.5 GiB, app ≤ ~1.2 GiB (the e2-medium verdict), RSS-gap explained by heap snapshot.

---

## 9. Deletion list

Files/services:

- `.env.app-perp` (lane file dies; `.env.app` is the single knob file; `.env.example` re-synced).
- `docker-compose.yml` perp profile: `app-perp`, `postgres-perp`, `prometheus-perp` services + the `perp` profile mechanism → **4-container compose** (app, postgres, prometheus, grafana).
- Second Prometheus config + scrape jobs; v2 Grafana dashboard provisioning (W1 dashboard JSON).
- `src/features/trading/exchange/in-memory-funding-sink.ts` (funding payments are DB-mandatory).
- The production no-DB fallback branch in every persistence override (in-memory classes survive **only** as test/ci backings).

Code/consts:

- `app.module.ts`'s six inline `@Global` modules + the lifecycle body (decomposed per §1; net deletion of the 2,427-line file down to a thin root).
- `primaryVenue()`, `feedVenueConfig()`, all `venues[0]` reads, all local `PERP_VENUE_ID` copies (→ `domain/types/venue-map.ts`).
- Legacy tool contract: `DECISION_TOOL`, `SHORTS_DECISION_TOOL`, `PLAN_TOOL`, `PLAN_SHORTS_TOOL`, `PORTFOLIO_TOOL`, `PORTFOLIO_SHORTS_TOOL`, `buildTradeShortsTool`, `buildTradePortfolioShortsTool` + the client's legacy `submit_decision`/`submit_plan` parse paths and their specs (v3 is rich-contract-only; §4's two factories replace all eight shapes).
- `SEED_PLAYBOOK_PERP` (folded into `SEED_PLAYBOOK_V3` together with both lanes' ACTIVE playbook text); the `shortsEnabled`-as-lane-selector derivations in `agentic-strategy.module.ts` and `AgenticBridgeModule`.
- Derivatives-control A/B: `derivativesControlArm` client path, `AGENTIC_DERIVATIVES_AB_PCT`, `agent_decisions.info_arm`/`thinking_arm` columns (XA3 retired the factorial; the playbook champion/candidate A/B is NOT deleted — it feeds attributed auto-promotion).
- Env tombstones per §3.4 (`TRADING_SYMBOL`, `PERP_VENUE_ENABLED`, `AGENTIC_SHORTS_ENABLED`, `AGENTIC_DERIVATIVES_AB_PCT`, `AGENTIC_AUTO_PROMOTE_MIN_TRADES`) + their zod entries, AppConfig fields, and comments.
- The v2 "all-venues-perp" venue-TP/stop cross-field refusal (replaced per §3.5).
- Y2 sweep/digest tooling's dual-lane branches (`scripts/loop-sweep.mjs` et al. updated to the single stack — part of the validation-gate step, not a workstream below).

---

## 10. Workstream boundary map (tasks #5–#11)

File-scope ownership. A workstream may **not** edit files owned by another; cross-needs are expressed as exported contracts the owner lands. Worktree isolation is only needed where a row below names a shared file.

| # | Workstream | Owns (exclusive file scope) |
| --- | --- | --- |
| 5 | Composition + venue runtimes | `src/app.module.ts`, `src/features/trading/composition/**` (all new modules + moves), `src/domain/types/venue-map.ts` (new), `src/features/trading/execution/{reconciliation.service.ts,demo-fill-poller.service.ts,execution.module.ts}` (venue iteration only), `src/features/trading/market-data/ccxt-stream.adapter.ts` (merged-stream/tiering seams), `src/ports/{exchange-stream.ts,market-data.ts}` additions, boot specs |
| 6 | Schema + repositories | `src/database/**` (schemas, migrations, repositories, tokens), `test/db/**`, repo-touching specs |
| 7 | Config redesign | `src/config/**`, `src/ports/app-config.ts`, `.env.app` (rewrite), `.env.example`, deletion of `.env.app-perp`, config specs |
| 8 | Risk/sizing unification | `src/features/trading/risk/**`, `src/domain/risk/**`, `src/ports/risk.ts`, `src/features/trading/execution/portfolio-state.service.ts` + `src/ports/execution.ts` (the `venueBalances` snapshot change — assigned here because sizing is the consumer), sizing/risk specs |
| 9 | Mode-control/arming | `src/features/trading/mode-control/**`, `src/features/trading/exchange/key-probe.service.ts`, `src/ports/{mode-control.ts,promotion.ts}`, `src/features/trading/agentic/agentic-live-interlock.ts`, `test/livegate/**` |
| 10 | Agentic unification | `src/features/trading/agentic/**` (prompt, tools, clients, scanner, seeds, strategy, scheduler), `src/ports/agentic-strategy.ts`, agentic/eval specs |
| 11 | Observability v3 | `src/features/common/observability/**`, `docker-compose.yml`, `prometheus/**`, `grafana/**`, alert rules, compose/promtool checks |

Shared files and integration order (the only serialization in Group 2):

1. **`environment.config.ts` + `ports/app-config.ts` land FIRST** (workstream #7, alone). §3 fully specifies the schema, so #7 needs no input from the others; after it merges, the file is frozen — any late field goes through #7's owner as a follow-up commit, never a parallel edit.
2. **Schema (#6) lands SECOND** (repositories define the DB contracts #5/#9/#10 compile against). #6 and the module-file portions of #5 can build in parallel worktrees; only the merge is ordered.
3. **#8, #9, #10, #11 run fully parallel** after 1–2: their file scopes are disjoint (verified against the table above). #10 consumes #8's `venueBalances` type read-only; if #10 starts first it codes against the type declared in this spec (§6.4) and rebases.
4. **`app.module.ts` final assembly lands LAST** (workstream #5): it imports every other workstream's exported modules/providers. No other workstream touches `app.module.ts` at any point — composition needs are expressed as each feature module's own exports.
5. `agentic-strategy.module.ts` is owned by #10, but its `selectAgentClient` seam is consumed by #5's `AgenticBridgeModule`; the contract is the existing exported-token surface (`AGENT_CLIENT`, override tokens) — #10 must not rename tokens without a same-commit update handshake with #5 (the one declared overlap; worktree-isolate these two if concurrent).
6. `AgentMetricsRecorder` is owned by #11; #10 consumes it through the existing recorder interface only (boundaries wall carried).

Every workstream ends green on `pnpm build && pnpm lint && pnpm typecheck && pnpm format:check && pnpm test` (sandbox-disabled), including `test:livegate` for #9.
