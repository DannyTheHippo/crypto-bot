import {
  pgTable,
  text,
  bigint,
  boolean,
  timestamp,
  jsonb,
  integer,
  doublePrecision,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { numericMoney } from './custom-types';

// ── Shared stamp columns ─────────────────────────────────────────────────────
// Every trading row carries mode + run_id + boot_id for segregation and replay. mode is deploy-
// environment segregation (paper/testnet/live), never lane discrimination — v3 has no lanes
// (consolidation spec §2).
const tradingStamp = {
  mode: text('mode').notNull().$type<'paper' | 'testnet' | 'live'>(),
  runId: text('run_id').notNull(),
  bootId: text('boot_id').notNull(),
};

// ── order_intents ─────────────────────────────────────────────────────────────

export const orderIntents = pgTable('order_intents', {
  intentId: text('intent_id').primaryKey(),
  clientOrderId: text('client_order_id').notNull().unique(),
  strategyId: text('strategy_id').notNull(),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull().$type<'BUY' | 'SELL'>(),
  // Widened to the full OrderIntent['type'] union (STOP_LOSS_LIMIT/STOP_MARKET venue trigger
  // orders) — TS-level only ($type<>()), matching the repo's convention; the underlying column is
  // plain unconstrained text, no DB CHECK.
  type: text('type')
    .notNull()
    .$type<'LIMIT' | 'MARKET' | 'LIMIT_MAKER' | 'STOP_LOSS_LIMIT' | 'STOP_MARKET'>(),
  qty: numericMoney('qty').notNull(),
  limitPrice: numericMoney('limit_price'),
  // v3 (consolidation spec §2): promoted to a real column — v2 lacked it despite
  // OrderIntent.triggerPrice existing on the domain type since Push 3 P7b; a trigger order's
  // trigger price previously round-tripped through recovery as always-undefined
  // (algo-stop-recovery.service.ts's own header comment). Nullable: only STOP_LOSS_LIMIT/
  // STOP_MARKET intents carry one.
  triggerPrice: numericMoney('trigger_price'),
  timeInForce: text('time_in_force').notNull().$type<'GTC' | 'IOC' | 'FOK'>(),
  reduceOnly: boolean('reduce_only').notNull(),
  refPrice: numericMoney('ref_price').notNull(),
  refSeq: bigint('ref_seq', { mode: 'bigint' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  // signal source snapshot (dedupe key, eventTime, basedOnSeq, strength)
  sourceDedupeKey: text('source_dedupe_key').notNull(),
  sourceEventTime: bigint('source_event_time', { mode: 'number' }).notNull(),
  sourceBasedOnSeq: bigint('source_based_on_seq', { mode: 'bigint' }).notNull(),
  sourceStrength: text('source_strength').notNull(),
  // risk approval reference
  signalId: text('signal_id'),
  riskIntentHash: text('risk_intent_hash'),
  riskHmac: text('risk_hmac'),
  riskNonce: text('risk_nonce'),
  riskApprovedAtMs: bigint('risk_approved_at_ms', { mode: 'number' }),
  riskLimitsVersion: text('risk_limits_version'),
  riskSnapshotSeq: bigint('risk_snapshot_seq', { mode: 'bigint' }),
  ...tradingStamp,
  createdAtWall: timestamp('created_at_wall', { withTimezone: true }).defaultNow().notNull(),
});

// ── orders ────────────────────────────────────────────────────────────────────

export const orders = pgTable('orders', {
  intentId: text('intent_id')
    .primaryKey()
    .references(() => orderIntents.intentId),
  clientOrderId: text('client_order_id').notNull().unique(),
  venueOrderId: text('venue_order_id'),
  strategyId: text('strategy_id').notNull(),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull().$type<'BUY' | 'SELL'>(),
  type: text('type')
    .notNull()
    .$type<'LIMIT' | 'MARKET' | 'LIMIT_MAKER' | 'STOP_LOSS_LIMIT' | 'STOP_MARKET'>(),
  qty: numericMoney('qty').notNull(),
  limitPrice: numericMoney('limit_price'),
  timeInForce: text('time_in_force').notNull().$type<'GTC' | 'IOC' | 'FOK'>(),
  // cached reducer state
  state: text('state').notNull(),
  cumQty: numericMoney('cum_qty').notNull(),
  // per-transition timestamps (epoch ms, nullable until reached)
  submittedAt: bigint('submitted_at', { mode: 'number' }),
  ackedAt: bigint('acked_at', { mode: 'number' }),
  firstFillAt: bigint('first_fill_at', { mode: 'number' }),
  terminalAt: bigint('terminal_at', { mode: 'number' }),
  // raw acks from venue
  rawAck: jsonb('raw_ack'),
  ...tradingStamp,
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── order_events ──────────────────────────────────────────────────────────────
// Append-only journal; state re-derivable from this table.
// PK: id (IDENTITY). UNIQUE(order_id, dedupe_key) for idempotent re-apply.
// Trigger enforces immutability (no UPDATE/DELETE) — see 0001_v3_append_only_hardening.sql.

export const orderEvents = pgTable(
  'order_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.intentId),
    dedupeKey: text('dedupe_key').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
    ...tradingStamp,
  },
  (t) => [uniqueIndex('order_events_order_dedupe_uidx').on(t.orderId, t.dedupeKey)],
);

// ── fills ─────────────────────────────────────────────────────────────────────
// UNIQUE(venue, symbol, venue_trade_id) per §6.6; ON CONFLICT DO NOTHING.

export const fills = pgTable(
  'fills',
  {
    fillId: bigint('fill_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    venueTradeId: text('venue_trade_id').notNull(),
    intentId: text('intent_id').references(() => orderIntents.intentId),
    clientOrderId: text('client_order_id').notNull(),
    price: numericMoney('price').notNull(),
    qty: numericMoney('qty').notNull(),
    feeCcy: text('fee_ccy'),
    feeAmount: numericMoney('fee_amount'),
    feeResolved: boolean('fee_resolved').notNull().default(false),
    liquidity: text('liquidity').notNull().$type<'maker' | 'taker'>(),
    venueTimestamp: bigint('venue_timestamp', { mode: 'number' }).notNull(),
    source: text('source').notNull().$type<'ws' | 'rest_reconcile' | 'paper'>(),
    ...tradingStamp,
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('fills_venue_symbol_trade_uidx').on(t.venue, t.symbol, t.venueTradeId)],
);

// ── positions ─────────────────────────────────────────────────────────────────
// PK: (mode, strategy_id, venue, symbol) — segregates paper/testnet/live sub-accounts.

export const positions = pgTable(
  'positions',
  {
    strategyId: text('strategy_id').notNull(),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    signedQty: numericMoney('signed_qty').notNull(),
    avgEntry: numericMoney('avg_entry').notNull(),
    realizedPnl: numericMoney('realized_pnl').notNull(),
    ...tradingStamp,
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.mode, t.strategyId, t.venue, t.symbol] })],
);

// ── balances ──────────────────────────────────────────────────────────────────

export const balances = pgTable('balances', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  venue: text('venue').notNull(),
  asset: text('asset').notNull(),
  free: numericMoney('free').notNull(),
  locked: numericMoney('locked').notNull(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  ...tradingStamp,
});

export const feeLedger = pgTable('fee_ledger', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  venue: text('venue').notNull(),
  asset: text('asset').notNull(),
  amount: numericMoney('amount').notNull(),
  fillId: bigint('fill_id', { mode: 'number' }).references(() => fills.fillId),
  ...tradingStamp,
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
});

// ── signals ───────────────────────────────────────────────────────────────────

export const signals = pgTable('signals', {
  signalId: text('signal_id').primaryKey(),
  strategyId: text('strategy_id').notNull(),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  kind: text('kind').notNull(),
  strength: text('strength').notNull(),
  limitPriceHint: numericMoney('limit_price_hint'),
  refPrice: numericMoney('ref_price').notNull(),
  basedOnSeq: bigint('based_on_seq', { mode: 'bigint' }).notNull(),
  eventTime: bigint('event_time', { mode: 'number' }).notNull(),
  ttlMs: integer('ttl_ms').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  reason: text('reason').notNull(),
  outcome: text('outcome').notNull(),
  // Soft reference only (NO FK): a signal is journaled by SignalSink BEFORE the gate writes the
  // order_intents row (and REJECTED signals produce no intent at all), so an FK here is unsatisfiable
  // by the §2 Strategy→Risk→Execution ordering. This is an analysis artifact, not a referential guard.
  intentId: text('intent_id'),
  ...tradingStamp,
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
});

// ── risk_decisions ────────────────────────────────────────────────────────────

export const riskDecisions = pgTable('risk_decisions', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  // Soft reference only (NO FK): RiskEngine journals EVERY verdict — including REJECTED, whose intent
  // never reaches the gate's saveIntent, and APPROVED/RESIZED, journaled before saveIntent commits.
  // An FK to order_intents is therefore unsatisfiable across the §2 boundary; intent_id stays a value.
  intentId: text('intent_id').notNull(),
  verdict: text('verdict').notNull().$type<'APPROVED' | 'RESIZED' | 'REJECTED'>(),
  reasons: jsonb('reasons').notNull().$type<string[]>(),
  limitsVersion: text('limits_version').notNull(),
  snapshotSeq: bigint('snapshot_seq', { mode: 'bigint' }).notNull(),
  inputsHash: text('inputs_hash').notNull(),
  ...tradingStamp,
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
});

// ── exec_outbox ───────────────────────────────────────────────────────────────
// Never-drop exec report stream. cursor is BIGINT GENERATED ALWAYS AS IDENTITY.

export const execOutbox = pgTable('exec_outbox', {
  cursor: bigint('cursor', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  reportId: text('report_id').notNull().unique(),
  payload: jsonb('payload').notNull(),
  ...tradingStamp,
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
});

export const outboxConsumerAcks = pgTable(
  'outbox_consumer_acks',
  {
    consumerId: text('consumer_id').notNull(),
    cursor: bigint('cursor', { mode: 'number' }).notNull(),
    ackedAt: timestamp('acked_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.consumerId] })],
);

// ── equity_curve ──────────────────────────────────────────────────────────────
// Book-scoped measurement table — one curve for the whole book, no venue column (v3 consolidation
// spec §2 venue policy: measurement tables carry no venue and no measurement query may filter on it).

export const equityCurve = pgTable(
  'equity_curve',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    runId: text('run_id').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    equity: numericMoney('equity').notNull(),
    cash: numericMoney('cash').notNull(),
    unrealized: numericMoney('unrealized').notNull(),
    peak: numericMoney('peak').notNull(),
    sessionDateUtc: text('session_date_utc').notNull(),
    gapAnnotation: text('gap_annotation'),
    bootId: text('boot_id').notNull(),
    mode: text('mode').notNull().$type<'paper' | 'testnet' | 'live'>(),
  },
  (t) => [uniqueIndex('equity_curve_run_ts_uidx').on(t.runId, t.ts)],
);

// ── config_snapshots ──────────────────────────────────────────────────────────

export const configSnapshots = pgTable('config_snapshots', {
  hash: text('hash').primaryKey(),
  config: jsonb('config').notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }).defaultNow().notNull(),
  mode: text('mode').notNull().$type<'paper' | 'testnet' | 'live'>(),
});

// ── reconciliations ───────────────────────────────────────────────────────────
// venue-scoped operational fact (v3 consolidation spec §2): ReconciliationService iterates
// VENUE_REGISTRY and runs one pass per venue per tick, so one row per venue pass — venue is NOT
// NULL (no lane-wide aggregate row exists).

export const reconciliations = pgTable('reconciliations', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  venue: text('venue').notNull(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  durationMs: integer('duration_ms').notNull(),
  openOrdersChecked: integer('open_orders_checked').notNull(),
  tradesChecked: integer('trades_checked').notNull(),
  balancesChecked: integer('balances_checked').notNull(),
  discrepancies: jsonb('discrepancies').notNull(),
  result: text('result').notNull().$type<'CLEAN' | 'MISMATCH' | 'HALT'>(),
  ...tradingStamp,
});

// ── mode_transitions ──────────────────────────────────────────────────────────

export const modeTransitions = pgTable('mode_transitions', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  fromMode: text('from_mode').notNull(),
  toMode: text('to_mode').notNull(),
  actor: text('actor').notNull(),
  evidence: jsonb('evidence').notNull(),
  bootId: text('boot_id').notNull(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
});

// ── audit_log ─────────────────────────────────────────────────────────────────
// Append-only. seq BIGINT GENERATED ALWAYS AS IDENTITY.
// SHA-256 hash chain: hash = sha256(canonicalPayload(payload) || prev_hash).
// payload is TEXT storing the canonical sorted-key JSON so the chain is re-derivable
// from stored bytes without re-serialization (JSONB does not preserve key order).
// Appends serialized via pg_advisory_xact_lock.
// REVOKE UPDATE, DELETE from app role + BEFORE UPDATE OR DELETE trigger (see 0001_v3_append_only_hardening.sql).

export const auditLog = pgTable('audit_log', {
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  actor: text('actor').notNull(),
  category: text('category').notNull(),
  payload: text('payload').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

// ── agent_decisions ───────────────────────────────────────────────────────────
// Journals every agentic-lane decision (mapped to a Signal or not) for offline analysis — mirrors
// signals'/risk_decisions' shape. PLAIN insert-only table: the append-only REVOKE/trigger hardening
// in 0001_v3_append_only_hardening.sql is scoped to audit_log/order_events/funding_events/
// funding_payments/experiments only (CLAUDE.md rule 6). action is TS-level only ($type<>()), no DB
// CHECK — matches signals.kind / risk_decisions.verdict.
// v3 (consolidation spec §2/§9): action narrows to the rich-tool-contract-only vocabulary — the
// legacy 'long'|'flat' literals (the retired DECISION_TOOL/SHORTS_DECISION_TOOL contract) are
// dropped; a fresh v3 DB never carries a legacy row, so no back-compat literal is needed. venue is
// kept for operational queries only — measurement (promotion/reflection/attribution) never filters
// on it (see PromotionStatsRepository). info_arm/thinking_arm (the retired derivatives-control A/B
// factorial) are dropped outright — the playbook champion/candidate A/B is NOT retired and needs no
// column here (it is attributed via consult_id + playbook_version, not an arm flag).

export const agentDecisions = pgTable(
  'agent_decisions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    strategyId: text('strategy_id').notNull(),
    symbol: text('symbol').notNull(),
    venue: text('venue').notNull(),
    triggerKind: text('trigger_kind').notNull().$type<'candle' | 'ticker' | 'book' | 'exec'>(),
    basedOnSeq: bigint('based_on_seq', { mode: 'bigint' }).notNull(),
    eventTime: bigint('event_time', { mode: 'number' }).notNull(),
    model: text('model').notNull(),
    action: text('action')
      .notNull()
      .$type<'open_long' | 'open_short' | 'close' | 'adjust' | 'hold' | 'error'>(),
    confidence: doublePrecision('confidence'),
    rationale: text('rationale').notNull(),
    refPrice: numericMoney('ref_price'),
    close: numericMoney('close'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    // Cache-token analytics (true-spend accounting) — mirrors AgentDecisionEntry's absent-vs-null-
    // vs-confirmed-zero semantics (ports/agentic-strategy.ts); null on rows that never called the
    // client (error/quiet-hold).
    cacheReadInputTokens: integer('cache_read_input_tokens'),
    cacheCreationInputTokens: integer('cache_creation_input_tokens'),
    latencyMs: integer('latency_ms'),
    playbookVersion: integer('playbook_version'),
    promptHash: text('prompt_hash').notNull(),
    // Rendered market-context JSON the model saw (playbook/system excluded — see agent-prompt.ts's
    // buildMarketPayload) for offline prompt-variant replay; null on error/quiet-hold rows.
    inputPayload: text('input_payload'),
    // Accepted trade plan, verbatim, for offline replay through the settlement backtest harness;
    // null whenever the decision carried no accepted plan (hold-without-plan/error). A LOCAL mirror
    // of ports/agentic-strategy.ts's AgentDirectives — this file deliberately never imports ports
    // types (schema stays a pure DB-shape description), so sizeFraction/entryStyle/
    // partialCloseFraction?/thesis? must be kept in sync by hand with that interface.
    // nextConsultBars: portfolio-level consult-schedule value, merged in by
    // agent-decision-journal.adapter.ts's record() when no directive plan rode alongside it — see
    // that call site's own comment for the merge rule.
    // regimeTags: a compact regime fingerprint (trend/vol/funding?/session) rides on EVERY arm —
    // stamped on every journaled row so a later consult can retrieve its own past setups by jsonb tag
    // equality (agent-decision.repository.ts's selectSimilarSetups). Kept in sync BY HAND with
    // ports/agentic-strategy.ts's RegimeTags (this file deliberately never imports ports types).
    planJson: jsonb('plan_json').$type<
      | {
          readonly sizeFraction?: string;
          readonly stopLossPct: string;
          readonly takeProfitPct: string;
          readonly partialCloseFraction?: string;
          readonly entryOffsetBps: number;
          readonly entryValidityBars: number;
          readonly maxHoldBars: number;
          readonly entryStyle?: 'maker' | 'taker';
          readonly direction?: 'long' | 'short';
          readonly thesis?: string;
          readonly nextConsultBars?: number;
          readonly regimeTags?: {
            readonly trend: 'up' | 'down' | 'flat';
            readonly vol: 'low' | 'mid' | 'high';
            readonly funding?: 'positive' | 'negative' | 'flat';
            readonly session: 'asia' | 'eu' | 'us';
          };
        }
      // A hold that carried only a portfolio schedule — no directive set — persists
      // `{ nextConsultBars }` alone; a tagged hold with neither directives nor a schedule persists
      // `{ regimeTags }` alone.
      | {
          readonly nextConsultBars?: number;
          readonly regimeTags?: {
            readonly trend: 'up' | 'down' | 'flat';
            readonly vol: 'low' | 'mid' | 'high';
            readonly funding?: 'positive' | 'negative' | 'flat';
            readonly session: 'asia' | 'eu' | 'us';
          };
        }
    >(),
    // Batch-attribution join key: BatchingAgentClient coalesces up to 5 per-symbol propose() calls
    // into ONE AnthropicAgentClient.proposeBatch call, and every resulting proposal (including
    // degraded-to-hold elements) carries the SAME consultId, so offline cost/attribution analytics
    // can join the N rows born from one batched call back together. Null on every non-batched
    // (single-symbol propose()) row.
    consultId: text('consult_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('agent_decisions_strategy_event_idx').on(t.strategyId, t.eventTime)],
);

// ── agent_playbook_versions ────────────────────────────────────────────────────
// Versioned agent system-prompt playbook content. version is monotonic (UNIQUE); source
// distinguishes the initial seed from later reflection drafts and promoted (activated) rows — a
// 'promotion' row POINTS AT the version it promotes via parentVersion rather than duplicating its
// content. At most one 'promotion' row may land per UTC calendar day (one promotion/day cadence),
// enforced by a partial unique index on created_at's UTC date, scoped to source = 'promotion'.
// v3 (consolidation spec §2): ONE lineage — no lane column, single version sequence (SEED_PLAYBOOK_V3
// folds the seed plus both v2 lanes' final ACTIVE playbook text — see agentic-strategy module).

export const agentPlaybookVersions = pgTable(
  'agent_playbook_versions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    // 'loop-candidate': a daily-loop-proposed draft awaiting promotion, distinct from 'reflection'
    // (ad hoc reflection-triggered draft).
    source: text('source')
      .notNull()
      .$type<'seed' | 'reflection' | 'promotion' | 'loop-candidate'>(),
    parentVersion: integer('parent_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('agent_playbook_versions_version_uidx').on(t.version),
    uniqueIndex('agent_playbook_versions_promotion_per_day_uidx')
      // Extra parens are load-bearing: Postgres index syntax requires each non-column expression
      // fully parenthesized — `(expr)::date` needs one MORE wrap or CREATE INDEX fails at `::`
      // (42601; v2's 0003 carried the double-wrap, drizzle-kit renders this template verbatim).
      .on(sql`((${t.createdAt} at time zone 'utc')::date)`)
      .where(sql`${t.source} = 'promotion'`),
  ],
);

// ── llm_usage ─────────────────────────────────────────────────────────────────
// Reflection-path LLM token usage, kept separate from agent_decisions.input_tokens/output_tokens
// (the decide-path's own per-call columns) so cost analysis can UNION the two without double
// counting: decide-path tokens live on agent_decisions; this table's writers are the reflection loop
// only (ReflectionService, via LlmUsageSink — ports/agentic-strategy.ts). kind is a 2-value union
// ('decide' | 'reflection') for future use, matching the repo's TS-level-only enum convention
// (agent_decisions.action, agent_playbook_versions.source) — no DB CHECK constraint. strategy_id is
// nullable: reflection runs are per-strategy, but a future 'decide' writer might not always resolve
// one at call time. v3: one unified budget across the whole book (AGENTIC_DAILY_COST_STOP_USD) reads
// this table with no venue predicate — book-scoped measurement.

export const llmUsage = pgTable('llm_usage', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  kind: text('kind').notNull().$type<'decide' | 'reflection'>(),
  model: text('model').notNull(),
  mode: text('mode').notNull().$type<'paper' | 'testnet' | 'live'>(),
  strategyId: text('strategy_id'),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  // Cache-token analytics (true-spend accounting) — same absent-vs-zero semantics as
  // LlmUsageEntry's cache fields (ports/agentic-strategy.ts).
  cacheReadInputTokens: integer('cache_read_input_tokens'),
  cacheCreationInputTokens: integer('cache_creation_input_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── funding_events ────────────────────────────────────────────────────────────
// Append-only journal of perp funding-payment settlements (PaperPerpAdapter.applyFunding): one row
// per (position, funding timestamp) accrual. payment_quote = −signed_qty × mark_price ×
// funding_rate (Binance convention: a long with positive funding_rate PAYS — payment_quote
// negative — a short RECEIVES). Same REVOKE + immutable-trigger treatment as audit_log/order_events
// (0001_v3_append_only_hardening.sql) — CLAUDE.md rule 6 scopes append-only hardening to rows that
// are a durable settlement/audit trail, which a funding payment is, unlike agent_decisions' plain-
// insert analytics table above.

export const fundingEvents = pgTable('funding_events', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  strategyId: text('strategy_id').notNull(),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  fundingRate: numericMoney('funding_rate').notNull(),
  markPrice: numericMoney('mark_price').notNull(),
  signedQty: numericMoney('signed_qty').notNull(),
  paymentQuote: numericMoney('payment_quote').notNull(),
  fundingTime: timestamp('funding_time', { withTimezone: true }).notNull(),
  mode: text('mode').notNull().$type<'paper' | 'testnet' | 'live'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── funding_payments ─────────────────────────────────────────────────────────
// Venue-reported perp funding-payment settlements (funding-ingest.service.ts, ccxt
// fetchFundingHistory), DISTINCT from funding_events above (funding_events is the paper-sim
// journal written by PaperPerpAdapter.applyFunding and carries fundingRate/markPrice/signedQty —
// none of which are available on ccxt's unified FundingHistory row; see VenueFundingPayment's own
// header comment in ports/exchange.ts). No tradingStamp (runId/bootId): the ingest poller reads
// venue history independent of any local run/boot, mode alone is what promotion nets on.
// UNIQUE(venue, symbol, venue_payment_id) mirrors fills' own dedupe key — ON CONFLICT DO NOTHING
// makes re-ingestion idempotent. Sign convention: amount_quote POSITIVE = received (a short
// collecting funding), NEGATIVE = paid (a long paying funding) — ccxt's unified income-endpoint
// convention, ADDED directly into promotion's net (never subtracted).
// Same REVOKE + immutable-trigger treatment as funding_events/audit_log/order_events
// (0001_v3_append_only_hardening.sql) — a funding settlement is a durable venue-truth record, never
// corrected in place. Measurement reads (PromotionStatsRepository.fundingNetForMode) filter on mode
// only — never venue (book-scoped net).

export const fundingPayments = pgTable(
  'funding_payments',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    venue: text('venue').notNull(),
    symbol: text('symbol').notNull(),
    venuePaymentId: text('venue_payment_id').notNull(),
    amountQuote: numericMoney('amount_quote').notNull(),
    fundingTime: bigint('funding_time', { mode: 'number' }).notNull(),
    mode: text('mode').notNull().$type<'paper' | 'testnet' | 'live'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('funding_payments_venue_symbol_payment_uidx').on(
      t.venue,
      t.symbol,
      t.venuePaymentId,
    ),
  ],
);

// ── experiments ───────────────────────────────────────────────────────────────
// Append-only registry of every backtest/study trial ever run (research-side writer:
// test/backtest/experiment-log.ts), so the deflated-Sharpe multiple-testing count (N) is honest
// across sessions rather than reset per-process. source is TS-level only ($type<>()), matching the
// repo's convention (signals.kind / agent_playbook_versions.source) — no DB CHECK constraint.
// Same REVOKE + immutable-trigger treatment as audit_log/order_events/funding_events
// (0001_v3_append_only_hardening.sql): a trial row is a durable research-audit trail, never
// corrected in place — a re-run logs a NEW row instead.

export const experiments = pgTable(
  'experiments',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    family: text('family').notNull(),
    paramsHash: text('params_hash').notNull(),
    datasetHash: text('dataset_hash').notNull(),
    source: text('source').notNull().$type<'loop' | 'reflection' | 'human' | 'study'>(),
    label: text('label'),
    metrics: jsonb('metrics'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('experiments_family_params_dataset_idx').on(t.family, t.paramsHash, t.datasetHash)],
);
