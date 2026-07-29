import type {
  ClientOrderId,
  StrategyId,
  SymbolId,
  VenueId,
  EpochMs,
} from '../../domain/common/types/ids';
import type { TradingMode } from '../../domain/trading/types/mode';
import type { OrderIntent } from '../../domain/trading/types/order-intent';
import type { ApprovalProof, RiskApprovedIntent } from '../../domain/trading/types/risk-decision';
import type {
  PortfolioSnapshot,
  StrategyPortfolioView,
  Position,
  OpenOrderSummary,
} from '../../domain/trading/types/portfolio';
import type { ExecReport, FillRecord } from '../../domain/trading/types/exec-report';
import type { OrderRecord, OrderEvent, OrderState } from '../../domain/trading/oms/reducer';
import type { SymbolFilters } from '../../domain/trading/risk/evaluate';

// ── Tokens ────────────────────────────────────────────────────────────────────

export const EXECUTION_GATE = Symbol('EXECUTION_GATE');
export const PORTFOLIO_VIEW = Symbol('PORTFOLIO_VIEW');
export const EXEC_OUTBOX = Symbol('EXEC_OUTBOX');
export const EXECUTION_STORE = Symbol('EXECUTION_STORE');
export const EXEC_RUN_CONTEXT = Symbol('EXEC_RUN_CONTEXT');
export const PORTFOLIO_CONFIG = Symbol('PORTFOLIO_CONFIG');
// Per-symbol exchange filters the OMS needs (stepSize drives the reducer's residual-dust
// rule). Risk already rejected intents with missing filters, so a lookup miss here is rare;
// the gate falls back to a fine default step so a fill can still reach FILLED.
export const EXEC_FILTERS = Symbol('EXEC_FILTERS');
export type ExecFilters = ReadonlyMap<string, SymbolFilters>;

// Stamped on every persisted trading row (§7): which mode/run/boot produced it.
export interface ExecRunContext {
  readonly mode: 'paper' | 'testnet' | 'live';
  readonly runId: string;
  readonly bootId: string;
}

// v1 portfolio is single-quote (all symbols settle in quoteAsset); equity is denominated in it.
export interface PortfolioConfig {
  readonly quoteAsset: string;
  readonly startingCash: string;
  // Same knob as the promotion verdict's PROMOTION_DUST_NOTIONAL: when a REDUCING fill leaves
  // residual position notional (quote ccy) strictly below this, applyFill reports the round trip
  // closed for METRICS purposes even though the position itself stays nonzero (never deleted while
  // open — CLAUDE.md §6). Absent or '0' disables dust-close reporting: only an exact-zero fold
  // counts (pre-W2.2 behavior).
  readonly dustNotional?: string;
  // v3 §1.3/§6.4: per-venue starting-cash seed (decimal-string, quote-asset terms) for the paper
  // ledger's internal per-venue cash split (PortfolioStateService.venueBalances) — mirrors
  // AppConfig.venueCapitalSplit, keyed by venue id string (paper "mirrors the split by
  // construction"). Optional: absent (module-isolation fixtures, or before the composition root
  // wires it off AppConfig — the #5 integration item) ⇒ PortfolioStateService reports no
  // venueBalances at all, and every existing consumer of the combined balances/equity fields is
  // unaffected (byte-identical to pre-split behavior).
  readonly venueCapitalShare?: ReadonlyMap<string, string>;
}

// ── EXECUTION_GATE ──────────────────────────────────────────────────────────────

// submit refuses (no order, no network) on a failed proof — the verify-reject matrix is
// the order-authorization chokepoint. SUBMITTED ⇒ accepted by the venue; UNKNOWN ⇒ the
// outcome is ambiguous and a query loop owns it (§6.3); REJECTED ⇒ refused before or at
// the venue with a reason.
export type SubmitOutcome = 'SUBMITTED' | 'REJECTED' | 'UNKNOWN';

export interface SubmitAck {
  readonly clientOrderId: ClientOrderId;
  readonly outcome: SubmitOutcome;
  readonly state?: OrderState;
  readonly venueOrderId?: string;
  readonly reason?: string;
}

export interface ExecutionGatePort {
  // Accepts ONLY a RiskApprovedIntent (brand + verified HMAC proof) — never an OrderIntent.
  submit(approved: RiskApprovedIntent): Promise<SubmitAck>;
  cancel(clientOrderId: ClientOrderId, reason: string): Promise<void>;
  cancelAllFor(strategyId: StrategyId): Promise<void>;
  flattenAll(reason: string): Promise<void>;
}

// ── PORTFOLIO_VIEW ────────────────────────────────────────────────────────────

export interface PortfolioViewPort {
  snapshot(): PortfolioSnapshot;
  forStrategy(strategyId: StrategyId): StrategyPortfolioView;
}

// ── EXEC_OUTBOX (the never-drop exec-report stream, §3.3/§6.6) ─────────────────

// A report is durable in the outbox BEFORE its money effects are applied; consumers read
// by cursor, apply, then ack, and dedupe on reportId. The in-process notify is an
// optimisation over cursor/ack, never a replacement (crash before insert ⇒ reconciliation;
// crash between insert and apply ⇒ re-apply, idempotent).
export interface OutboxAppend {
  readonly reportId: string;
  readonly report: ExecReport;
}

export interface OutboxEntry {
  readonly cursor: number;
  readonly reportId: string;
  readonly report: ExecReport;
}

export interface ExecOutboxPort {
  append(entry: OutboxAppend): Promise<number>; // returns the assigned cursor (idempotent on reportId)
  consume(consumerId: string, fromCursor: number): Promise<readonly OutboxEntry[]>;
  ack(consumerId: string, cursor: number): Promise<void>;
}

// In-process notify: an optimisation over cursor/ack delivery (never a replacement). A source
// (e.g. the paper adapter) calls it after appending so the consumer drains promptly; awaiting
// it synchronously is how reorder-delivery exercises fill-before-ack. Default is a no-op.
export const EXEC_REPORT_NOTIFY = Symbol('EXEC_REPORT_NOTIFY');
export type ExecReportNotify = () => Promise<void>;

// ── EXECUTION_STORE (write-ahead durability; §6.1 I1) ─────────────────────────

// One persisted (state, event) transition: the append-only order_events row plus the
// reducer-derived state/cumQty cached on the orders row. Idempotent on (clientOrderId,
// dedupeKey) — re-applying a journaled event is a no-op (applied:false).
export interface PersistedOrderEvent {
  readonly clientOrderId: ClientOrderId;
  readonly dedupeKey: string;
  readonly event: OrderEvent;
  readonly derivedState: OrderState;
  readonly cumQty: string;
  readonly venueOrderId?: string;
  readonly reason?: string; // audit context for cancels (TTL/strategy/risk/shutdown)
}

export interface EquitySample {
  readonly ts: EpochMs;
  readonly equity: string;
  readonly cash: string;
  readonly unrealized: string;
  readonly peak: string;
  readonly sessionDateUtc: string;
}

// Observer hook fired with every equity sample (per-fill + 5s). The post-trade monitors subscribe
// here so they evaluate C1/C2 on the SAME stream the sampler produces; default is a no-op so the
// sampler stays decoupled from (and constructible without) the monitor.
export const EQUITY_OBSERVER = Symbol('EQUITY_OBSERVER');
export type EquityObserver = (sample: EquitySample) => void;

// The two post-trade limits the monitors read (§5 C1/C2), as canonical decimal strings. The
// composition root binds these from the same source as the risk limits.
export const EQUITY_LIMITS = Symbol('EQUITY_LIMITS');
export interface EquityLimits {
  readonly maxDailyLoss: string;
  readonly maxDrawdownPct: string;
}

export interface ExecutionStorePort {
  // tx1 write-ahead: the intent (+ risk approval reference) and the NEW order row, both
  // committed before any network call (a venue order with our prefix missing here is proof
  // of corruption, not a maybe — §6.2).
  saveIntent(intent: OrderIntent, proof: ApprovalProof): Promise<void>;
  saveNewOrder(record: OrderRecord, intent: OrderIntent): Promise<void>;
  // Append the journal row + refresh the derived state cache. Returns applied:false when the
  // dedupeKey was already journaled (idempotent replay).
  appendOrderEvent(ev: PersistedOrderEvent): Promise<{ applied: boolean }>;
  // §6.6 fill idempotency: ON CONFLICT (venue, symbol, venueTradeId) DO NOTHING. A re-seen tradeId
  // with the SAME payload is a benign duplicate (inserted:false, conflict:false); the same tradeId
  // with a DIFFERENT price/qty is corruption (conflict:true) — the ingestor halts on it (I3).
  saveFill(fill: FillRecord, intentId: string): Promise<{ inserted: boolean; conflict: boolean }>;
  savePortfolioSample(sample: EquitySample, positions: readonly Position[]): Promise<void>;
  // §6.4 — one durable row per reconciliation pass (mismatch count > 0 pages).
  saveReconciliation(row: ReconciliationRow): Promise<void>;
  // Recovery reads: load last equity sample + start-of-day equity + current positions.
  loadRecoverySnapshot(
    mode: TradingMode,
  ): Promise<{ latest: EquitySample | null; sodEquity: string | null; positions: Position[] }>;
  // Recovery read: load orders with no terminal_at (open/in-flight states).
  loadOpenOrders(mode: TradingMode): Promise<RecoveredOpenOrder[]>;
  // Recovery read: total base qty of the journaled fills for one order — the fill table is the
  // authoritative cumQty source ("cumQty is rebuilt from the fill table, never the venue's
  // running field"); boot recovery folds this back over a persisted record whose derived cum
  // lags it (2026-07-11: three partials in one poll folded from a stale snapshot, regressing
  // the cached cum and stranding a venue-FILLED order at RECONCILE_REQUIRED).
  loadFilledQty(clientOrderId: ClientOrderId): Promise<string>;
  // Push 3 P7c: resting-order role resolution (vtp/vsl) — recovers the persisted intent for an open
  // order's clientOrderId so the caller can classify it off intent.source.dedupeKey (see
  // domain/trading/oms/resting-order-role.ts). Optional because it is a NEW read path: the in-memory store
  // implements it directly (paper/test); a store that hasn't wired it yet is simply absent here, and
  // every call site treats that identically to a lookup miss — resolves 'unknown' and leaves the
  // order alone (warn-once, never a blind cancel/reconcile). Read-only; never on the order-submit path.
  loadIntentByClientOrderId?(clientOrderId: ClientOrderId): Promise<OrderIntent | null>;
  // §6.4 trade-axis venue-id resolution (cluster-A): on the real venue, VenueFill.clientOrderId
  // carries the numeric venue order id (ccxt myTrades has no clientOrderId field), so a trade the
  // in-memory OrderBookService cannot resolve via its own venueOrderId index is NOT automatically
  // foreign — it may be OUR OWN order whose in-memory projection was lost (crash, a second
  // instance, a recovery gap, or simply a TERMINAL order boot-recovery never rehydrates) while I1's
  // write-ahead still holds it durably. Returns a full (synthesized) OrderRecord — not just an id —
  // so the caller can both read `state` (terminal vs non-terminal drives the classification) and, if
  // terminal, fold a genuinely-missed fill directly onto it. Required (not @Optional) because a
  // silent degrade to "not found" on a store that has not wired it would quietly resurrect the
  // foreign/ours ambiguity this method exists to close.
  loadOrderByVenueOrderId(venue: VenueId, venueOrderId: string): Promise<OrderRecord | null>;
  // §6.4 spot-lane false-HALT fix (2026-07-19): a fill already recorded in the durable fills table
  // (e.g. a historical trade the checkpoint/overlap window keeps re-surfacing forever once the
  // symbol goes quiet — 2026-07-19 incident) is a pure no-op no matter how it classifies; checked
  // BEFORE any tier-1/tier-2 classification so a long-terminal order absent from the rehydrated
  // in-memory book stops re-triggering FILL_FOR_UNKNOWN_ORDER on every pass.
  hasFill(venue: VenueId, symbol: SymbolId, venueTradeId: string): Promise<boolean>;
}

// A non-terminal order restored at boot: the OMS record for the order-book projection plus the
// strategy attribution + summary the portfolio open-order set needs. Without the summary half,
// recovered orders were invisible to reconciliation's venue-truth adoption and the stale-entry
// sweep (2026-07-07: a stranded cancel + 57 unsweepable zombies). The persisted intent completes
// the pair: without it a recovered order's later fills were journaled but never applied to the
// portfolio (position/cash silently diverged from venue truth, 2026-07-11: a recovered 6.9-LINK
// entry filled into an unmanaged position), the unknown-resolver could not poll it, and Risk's
// E1 in-flight clamp never saw its reserved exposure. null tolerates a missing intent row
// (pre-write-ahead residue) — consumers degrade to the pre-rehydration behavior for that order.
export interface RecoveredOpenOrder {
  readonly record: OrderRecord;
  readonly strategyId: StrategyId;
  readonly summary: OpenOrderSummary;
  readonly intent: OrderIntent | null;
}

// An axis that did not RUN at all writes this instead of a count, because 0 already means "ran and
// examined nothing" and the two must not collide — the whole point of the 2026-07-29 repair. Negative
// by design: the columns are signed integers, so the sentinel is storable, sorts below every real
// count, and cannot be mistaken for one.
export const AXIS_NOT_RUN = -1;

// §6.4 reconciliation audit row.
// The four count fields below were columns on the table from the start but were written as a
// hardcoded 0 by the only persisting store, so all 23,973 rows since the v3 cutover recorded nothing
// (found 2026-07-29). They are part of the contract now so a store cannot invent them: an audit row
// that cannot say what the pass examined is not an audit row.
//
// SCOPE LIMIT on openOrdersChecked, stated because the value was already misread once: it counts
// REGULAR-rail open orders only (ExchangePort.fetchOpenOrders). Venue-side protective/algo stops live
// behind fetchOpenAlgoOrders and this axis never calls it, so NO value of this field — zero or not —
// is evidence about resting protective orders. state.md's 2026-07-28 "the venue reports
// open_orders_checked=0 on every reconcile" was wrong twice over: the number was a constant, and the
// question it was answering is not one this field can answer.
export interface ReconciliationRow {
  readonly ts: EpochMs;
  readonly venue: string;
  readonly mismatches: number;
  readonly halted: boolean;
  readonly detail: string;
  // Wall-clock across the whole axis chain, including a thrown pass. Measurement-only: it feeds no
  // decision anywhere, so it fails OPEN — a backwards wall-clock step (SystemClock is Date.now() on a
  // host that sleeps) reads as 0 rather than propagating a negative.
  readonly durationMs: number;
  // Venue-returned rows examined, or AXIS_NOT_RUN.
  readonly openOrdersChecked: number;
  readonly tradesChecked: number;
  // LOCAL assets compared against venue truth — not a count of venue balances. A venue asset with no
  // local entry is never compared, so this is deliberately the local denominator. AXIS_NOT_RUN
  // whenever balanceAxis is off, which is every demo venue, i.e. the entire current deployment.
  readonly balancesChecked: number;
}

// §6.4 reconciliation tunables. epsAbs/epsRel form the per-asset balance tolerance band; overlapMs
// is the fetchMyTrades look-back beyond the checkpoint (free under I3 dedupe, absorbs clock skew);
// driftPasses is how many consecutive strictly-growing within-ε drifts escalate to a HALT.
// balanceAxis disables the per-asset balance comparison where local balances cannot mirror venue
// truth (a shared multi-asset demo account vs the synthetic STARTING_CASH seed) — a false
// BALANCE_DRIFT there would HALT on holdings the bot never touched. Order/trade axes always run.
// sweepSymbols is the configured trading universe, unioned with symbols that have live local state,
// so the open-order/trade sweeps see venue truth even before the bot holds anything.
// positionAxis (Defect A) mirrors balanceAxis's opt-out shape but defaults ON when absent (unlike
// balanceAxis, always explicitly set by callers): optional so existing ReconConfig literals compile
// unchanged, and the axis is gated primarily by exchange.fetchPositions being defined at all
// (spot/paper adapters omit it, so the flag is moot there).
export const RECON_CONFIG = Symbol('RECON_CONFIG');
export interface ReconConfig {
  readonly epsAbs: string;
  readonly epsRel: string;
  readonly overlapMs: number;
  readonly driftPasses: number;
  readonly balanceAxis: boolean;
  readonly sweepSymbols: readonly string[];
  readonly positionAxis?: boolean;
}

// Recovery program (owner-authorized 2026-07-22, RecoveryCoordinatorService): gates whether a
// cleared-cause HALTED/HALTED_DEGRADED kill switch may auto-resume without a human. Composition root
// binds this from AppConfig.recovery.autoResumeEnabled (RECOVERY_AUTO_RESUME_ENABLED, schema default
// true); module-isolation fixtures with no config fall back to true too, matching the schema default
// — the flag is a deploy-time on/off switch, never the safety mechanism itself.
// RecoveryCoordinatorService's own per-cause + universal fail-closed preconditions and 2-pass
// debounce (see its header comment) are what actually make a resume safe.
export const RECOVERY_CONFIG = Symbol('RECOVERY_CONFIG');
export interface RecoveryConfig {
  readonly autoResumeEnabled: boolean;
}

// §1/§6 single-writer interlock: a per-(venue, apiKey) lock acquired at startup so a second bot
// instance cannot trade the same key. The live impl is a Postgres pg_advisory_lock (held for the
// process lifetime); the in-memory default guards only within one process. acquire throws if the
// lock is already held.
export const INSTANCE_LOCK = Symbol('INSTANCE_LOCK');
export interface InstanceLockPort {
  acquire(venue: string, keyFingerprint: string): Promise<void>;
  release(): Promise<void>;
}

// Optional override tokens: the composition root injects a Drizzle-backed adapter when DATABASE_URL
// is present and NODE_ENV ∉ {test,ci} and !CI. Each module's provider factory checks these tokens
// (@Optional) and falls back to the in-memory default when absent. Defined here (ports layer) so
// execution.module and mode-control.module can inject them without importing persistence concretions.
export const EXEC_OUTBOX_OVERRIDE = Symbol('EXEC_OUTBOX_OVERRIDE');
export const EXECUTION_STORE_OVERRIDE = Symbol('EXECUTION_STORE_OVERRIDE');
export const INSTANCE_LOCK_OVERRIDE = Symbol('INSTANCE_LOCK_OVERRIDE');

// ── EXEC_QUALITY_SINK (W3 Part 1: read-side exec-quality fan-out) ─────────────

// A rendering-agnostic mirror of agentic/exec-quality.service.ts's ExecQualityEntryAttempt (that
// type cannot be imported here — boundaries forbid ports → features). Fields/semantics are kept in
// lock-step by hand: exec-quality.service.ts's own header documents the money-path note (limitPrice/
// fillPrice are decimal STRINGS, never re-minted as Price/Qty) and the maker/taker + outcome
// conventions this DTO carries verbatim.
export type ExecQualitySide = 'long' | 'short';
export type ExecQualityOutcome = 'filled' | 'expired' | 'cancelled';

export interface ExecQualityAttempt {
  readonly symbol: SymbolId;
  readonly side: ExecQualitySide;
  readonly style: 'maker' | 'taker';
  readonly limitPrice: string;
  readonly outcome: ExecQualityOutcome;
  readonly fillPrice?: string;
  readonly terminalAt: EpochMs;
}

// Measurement-only observer the OMS terminal-state fold calls once per terminal ENTRY attempt
// (reduceOnly === false). Fails OPEN by contract: every call site catches and logs a sink error,
// never rethrows — this is a read-side digest feed, not a step in the money path, and must never
// block or alter the fold it observes (CLAUDE.md hard rule 5 territory stays untouched).
export interface ExecQualitySinkPort {
  recordEntryAttempt(attempt: ExecQualityAttempt): void;
}

// The concrete sink (ExecQualityService) lives in features/strategy/agentic, a different boundaries
// zone execution may not import directly — same cross-zone problem EXEC_OUTBOX_OVERRIDE et al. solve.
// EXECUTION_MODULE's own EXEC_QUALITY_SINK provider falls back to a no-op when this override is
// absent (module-isolation tests, or a boot where AgenticCompositionBridgeModule never wires it).
export const EXEC_QUALITY_SINK = Symbol('EXEC_QUALITY_SINK');
export const EXEC_QUALITY_SINK_OVERRIDE = Symbol('EXEC_QUALITY_SINK_OVERRIDE');

export type { OrderRecord, OrderState };
