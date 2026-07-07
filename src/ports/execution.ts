import type { ClientOrderId, StrategyId, EpochMs } from '../domain/types/ids';
import type { TradingMode } from '../domain/types/mode';
import type { OrderIntent } from '../domain/types/order-intent';
import type { ApprovalProof, RiskApprovedIntent } from '../domain/types/risk-decision';
import type {
  PortfolioSnapshot,
  StrategyPortfolioView,
  Position,
  OpenOrderSummary,
} from '../domain/types/portfolio';
import type { ExecReport, FillRecord } from '../domain/types/exec-report';
import type { OrderRecord, OrderEvent, OrderState } from '../domain/oms/reducer';
import type { SymbolFilters } from '../domain/risk/evaluate';

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
}

// A non-terminal order restored at boot: the OMS record for the order-book projection plus the
// strategy attribution + summary the portfolio open-order set needs. Without the summary half,
// recovered orders were invisible to reconciliation's venue-truth adoption and the stale-entry
// sweep (2026-07-07: a stranded cancel + 57 unsweepable zombies).
export interface RecoveredOpenOrder {
  readonly record: OrderRecord;
  readonly strategyId: StrategyId;
  readonly summary: OpenOrderSummary;
}

// §6.4 reconciliation audit row.
export interface ReconciliationRow {
  readonly ts: EpochMs;
  readonly venue: string;
  readonly mismatches: number;
  readonly halted: boolean;
  readonly detail: string;
}

// §6.4 reconciliation tunables. epsAbs/epsRel form the per-asset balance tolerance band; overlapMs
// is the fetchMyTrades look-back beyond the checkpoint (free under I3 dedupe, absorbs clock skew);
// driftPasses is how many consecutive strictly-growing within-ε drifts escalate to a HALT.
// balanceAxis disables the per-asset balance comparison where local balances cannot mirror venue
// truth (a shared multi-asset demo account vs the synthetic STARTING_CASH seed) — a false
// BALANCE_DRIFT there would HALT on holdings the bot never touched. Order/trade axes always run.
// sweepSymbols is the configured trading universe, unioned with symbols that have live local state,
// so the open-order/trade sweeps see venue truth even before the bot holds anything.
export const RECON_CONFIG = Symbol('RECON_CONFIG');
export interface ReconConfig {
  readonly epsAbs: string;
  readonly epsRel: string;
  readonly overlapMs: number;
  readonly driftPasses: number;
  readonly balanceAxis: boolean;
  readonly sweepSymbols: readonly string[];
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

export type { OrderRecord, OrderState };
