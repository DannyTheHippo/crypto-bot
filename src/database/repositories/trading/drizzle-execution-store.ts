import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Decimal from 'decimal.js';
import { price, qty } from '../../../domain/common/types/money';
import type { TradingMode } from '../../../domain/trading/types/mode';
import type {
  StrategyId,
  VenueId,
  SymbolId,
  ClientOrderId,
  EpochMs,
} from '../../../domain/common/types/ids';
import { decodeClientOrderId, isOurClientOrderId } from '../../../domain/common/types/ids';
import type { Position } from '../../../domain/trading/types/portfolio';
import type { OrderIntent } from '../../../domain/trading/types/order-intent';
import type { ApprovalProof } from '../../../domain/trading/types/risk-decision';
import type { FillRecord } from '../../../domain/trading/types/exec-report';
import type { OrderRecord } from '../../../domain/trading/oms/reducer';
import { isOrderState, TERMINAL_ORDER_STATES } from '../../../domain/trading/oms/reducer';
import type {
  ExecutionStorePort,
  PersistedOrderEvent,
  EquitySample,
  ReconciliationRow,
  RecoveredOpenOrder,
  ExecRunContext,
} from '../../../ports/trading/execution';
import * as schema from '../../schemas/trading';
import { IntentRepository } from './intent.repository';
import { OrderRepository } from './order.repository';
import { FillRepository } from './fill.repository';
import { EquityRepository } from './equity.repository';
import { ReconciliationRepository } from './reconciliation.repository';
import { PositionRepository } from './position.repository';

// Serialize an OrderEvent to a JSON-safe payload. FILL carries a Decimal cumQty that must
// be stored as a string for exact round-trip. All other event types carry no numeric money.
function serializeEvent(event: PersistedOrderEvent['event']): Record<string, unknown> {
  if (event.type === 'FILL') {
    return { type: event.type, cumQty: event.cumQty.toFixed() };
  }
  if (event.type === 'ACK') {
    return { type: event.type, venueOrderId: event.venueOrderId };
  }
  if (event.type === 'REJECT') {
    // Defect A commit-1 (REJECT venue-reason persistence, 2026-07-16): code/message are additive
    // to the base REJECT payload — a NEW field on NEW rows, never a migration/UPDATE (Hard Rule 6).
    // Omitted when absent so a bare REJECT (unknown-resolver's query-rejected fold) serializes
    // byte-identically to before this feature.
    return {
      type: event.type,
      ...(event.code !== undefined ? { code: event.code } : {}),
      ...(event.message !== undefined ? { message: event.message } : {}),
    };
  }
  if (event.type === 'RECONCILE_ADOPT_TERMINAL') {
    // 2026-07-27 defect fix: the audited row must show WHICH terminal the re-query pass adopted —
    // the default `{ type }`-only fallback below would otherwise drop the one fact that matters.
    return { type: event.type, terminal: event.terminal };
  }
  return { type: event.type };
}

// Push 3 P7a deferred STOP_LOSS_LIMIT/STOP_MARKET persistence (narrowed defensively, throwing on a
// trigger intent) because Risk did not yet emit them. Push 3 P7b widens IntentInsert/OrderInsert/
// trading.schema's `type` columns to the full OrderIntent union (TS-level only — the underlying
// order_intents.type/orders.type columns are plain unconstrained `text`, so no migration is
// needed), so this is now a straight pass-through. Kept as a named seam (rather than inlining
// `intent.type` at both call sites) so a future persisted-type narrowing has one place to change.
// OMS rule 5: a trigger intent is persisted here BEFORE the venue call, exactly like every other
// order — on the perp ALGO rail the dedupe key is clientAlgoId (= the same clientOrderId string).
function persistedOrderType(type: OrderIntent['type']): OrderIntent['type'] {
  return type;
}

// DrizzleExecutionStore: satisfies ExecutionStorePort by delegating to the existing
// per-table repositories. The `orders` row is keyed by intentId (PK); `order_events`
// references it as `orderId`. We resolve clientOrderId → intentId via the unique
// `orders.clientOrderId` index (findByClientOrderId) — no in-process map survives restarts.
//
// Scope note: this is the write-ahead DURABILITY half of I1 — intents/orders/events/fills are
// journaled before their side effects. Restart RECOVERY routes through reconciliation (design §4.2:
// "restart ⇒ re-risk everything; recovery routes through reconciliation"), not in-process replay of
// order_events; a DB-backed journal-replay reader is a deferred follow-up. The network call only
// follows the journaled SUBMIT event, so a crash between the two writes here yields no venue exposure.
export class DrizzleExecutionStore implements ExecutionStorePort {
  private readonly intents: IntentRepository;
  private readonly orders: OrderRepository;
  private readonly fills: FillRepository;
  private readonly equity: EquityRepository;
  private readonly reconciliations: ReconciliationRepository;
  private readonly positions: PositionRepository;

  constructor(
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly ctx: ExecRunContext,
  ) {
    this.intents = new IntentRepository(db);
    this.orders = new OrderRepository(db);
    this.fills = new FillRepository(db);
    this.equity = new EquityRepository(db);
    this.reconciliations = new ReconciliationRepository(db);
    this.positions = new PositionRepository(db);
  }

  async saveIntent(intent: OrderIntent, proof: ApprovalProof): Promise<void> {
    await this.intents.insert({
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      strategyId: intent.strategyId,
      venue: intent.venue,
      symbol: intent.symbol,
      side: intent.side,
      type: persistedOrderType(intent.type),
      qty: intent.qty.toFixed(),
      limitPrice: intent.limitPrice?.toFixed(),
      // v3 (consolidation spec §2): trigger_price promoted to a real column.
      triggerPrice: intent.triggerPrice?.toFixed(),
      timeInForce: intent.timeInForce,
      reduceOnly: intent.reduceOnly,
      refPrice: intent.refPrice.toFixed(),
      refSeq: intent.refSeq,
      createdAt: intent.createdAt,
      expiresAt: intent.expiresAt,
      sourceDedupeKey: intent.source.dedupeKey,
      sourceEventTime: intent.source.eventTime,
      sourceBasedOnSeq: intent.source.basedOnSeq,
      sourceStrength: intent.source.strength.toFixed(),
      riskIntentHash: proof.intentHash,
      riskHmac: proof.hmac,
      riskNonce: proof.nonce,
      riskApprovedAtMs: proof.approvedAtMs,
      riskLimitsVersion: proof.limitsVersion,
      riskSnapshotSeq: proof.snapshotSeq,
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    });
  }

  async saveNewOrder(record: OrderRecord, intent: OrderIntent): Promise<void> {
    await this.orders.insert({
      intentId: intent.intentId,
      clientOrderId: record.clientOrderId,
      strategyId: intent.strategyId,
      venue: intent.venue,
      symbol: intent.symbol,
      side: intent.side,
      type: persistedOrderType(intent.type),
      qty: record.qty.toFixed(),
      limitPrice: intent.limitPrice?.toFixed(),
      timeInForce: intent.timeInForce,
      state: record.state,
      cumQty: record.cumQty.toFixed(),
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    });
  }

  async appendOrderEvent(ev: PersistedOrderEvent): Promise<{ applied: boolean }> {
    const order = await this.orders.findByClientOrderId(ev.clientOrderId);
    if (order === null) return { applied: false };

    const { inserted } = await this.orders.appendEvent({
      orderId: order.intentId,
      dedupeKey: ev.dedupeKey,
      eventType: ev.event.type,
      // Defect A commit-1: reason (cancel audit context / venue REJECT text) merged into the SAME
      // JSONB payload column — additive to NEW rows only, never a migration or an UPDATE of an
      // existing row (order_events is append-only, Hard Rule 6). Omitted when absent, so an event
      // with no reason serializes byte-identically to before.
      payload: {
        ...serializeEvent(ev.event),
        ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
      },
      // seq is used for ordering within this order's event log. We derive it from the
      // current timestamp in milliseconds cast to bigint — guaranteed monotone within a
      // single process and sufficient for ordering purposes.
      seq: BigInt(Date.now()),
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    });

    if (!inserted) return { applied: false };

    // Refresh the cached reducer state on the orders row. Stamping terminal_at here is the
    // single OMS persistence chokepoint for it (findOpenByMode/BootRecovery rely on it being
    // non-null for every order that will never transition again). Backlog #40 adds the other
    // lifecycle stamps at the same seam — journal-time wall clock, the same convention as
    // terminalAt (no venue clock reaches here: ACK carries none and FILL's venue timestamp lives
    // on the fills row); updateState writes them first-write-wins so a requeued submit, re-ack,
    // or second partial fill never moves an earlier stamp.
    await this.orders.updateState(order.intentId, ev.derivedState, ev.cumQty, {
      venueOrderId: ev.venueOrderId,
      ...(ev.event.type === 'SUBMIT_SENT' ? { submittedAt: Date.now() } : {}),
      ...(ev.event.type === 'ACK' ? { ackedAt: Date.now() } : {}),
      ...(ev.event.type === 'FILL' ? { firstFillAt: Date.now() } : {}),
      ...(TERMINAL_ORDER_STATES.has(ev.derivedState) ? { terminalAt: Date.now() } : {}),
    });

    return { applied: true };
  }

  async saveFill(
    fill: FillRecord,
    intentId: string,
  ): Promise<{ inserted: boolean; conflict: boolean }> {
    const existing = await this.fills.fetchByTradeId(fill.venue, fill.symbol, fill.venueTradeId);
    if (existing !== null) {
      // Same tradeId, different price/qty is corruption (§6.6 I3). Compare by EXACT DECIMAL value,
      // never by string: pg renders NUMERIC(38,18) padded to full scale ('100.500000000000000000'),
      // so a string compare against fill.price.toFixed() ('100.5') would false-positive a
      // FILL_PAYLOAD_CONFLICT on every benign duplicate fill and HALT the bot (Hard Rule 1 + I3).
      const conflict =
        !new Decimal(existing.price).eq(fill.price) || !new Decimal(existing.qty).eq(fill.qty);
      return { inserted: false, conflict };
    }

    const { inserted } = await this.fills.insertIdempotent({
      venue: fill.venue,
      symbol: fill.symbol,
      venueTradeId: fill.venueTradeId,
      intentId: intentId || undefined,
      clientOrderId: fill.clientOrderId,
      price: fill.price.toFixed(),
      qty: fill.qty.toFixed(),
      feeCcy: fill.fee?.ccy,
      feeAmount: fill.fee?.amount.toFixed(),
      feeResolved: false,
      liquidity: fill.liquidity,
      venueTimestamp: fill.venueTimestamp,
      source: fill.source,
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    });

    return { inserted, conflict: false };
  }

  async savePortfolioSample(sample: EquitySample, positions: readonly Position[]): Promise<void> {
    const positionRows = positions.map((p) => ({
      strategyId: p.strategyId,
      venue: p.venue,
      symbol: p.symbol,
      signedQty: p.signedQty.toFixed(),
      avgEntry: p.avgEntry.toFixed(),
      realizedPnl: p.realizedPnl.toFixed(),
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    }));

    await this.db.transaction(async (tx) => {
      await tx.insert(schema.equityCurve).values({
        runId: this.ctx.runId,
        ts: new Date(sample.ts),
        equity: sample.equity,
        cash: sample.cash,
        unrealized: sample.unrealized,
        peak: sample.peak,
        sessionDateUtc: sample.sessionDateUtc,
        bootId: this.ctx.bootId,
        mode: this.ctx.mode,
      });
      await this.positions.replaceAll(this.ctx.mode, positionRows, tx);
    });
  }

  async saveReconciliation(row: ReconciliationRow): Promise<void> {
    await this.reconciliations.insert({
      // v3 (consolidation spec §2): venue is now a first-class column (was folded into the
      // discrepancies jsonb blob only) — kept out of discrepancies now that it has its own column.
      venue: row.venue,
      ts: new Date(row.ts),
      durationMs: row.durationMs,
      openOrdersChecked: row.openOrdersChecked,
      tradesChecked: row.tradesChecked,
      balancesChecked: row.balancesChecked,
      discrepancies: { mismatches: row.mismatches, detail: row.detail },
      result: row.halted ? 'HALT' : row.mismatches > 0 ? 'MISMATCH' : 'CLEAN',
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    });
  }

  async loadRecoverySnapshot(
    mode: TradingMode,
  ): Promise<{ latest: EquitySample | null; sodEquity: string | null; positions: Position[] }> {
    const latestRow = await this.equity.findLatestByMode(mode);
    if (latestRow === null) {
      return { latest: null, sodEquity: null, positions: [] };
    }

    const latest: EquitySample = {
      ts: latestRow.ts.getTime() as EpochMs,
      equity: latestRow.equity,
      cash: latestRow.cash,
      unrealized: latestRow.unrealized,
      peak: latestRow.peak,
      sessionDateUtc: latestRow.sessionDateUtc,
    };

    const sodRow = await this.equity.findSessionStartByMode(mode, latestRow.sessionDateUtc);
    const sodEquity = sodRow?.equity ?? null;

    const positionRows = await this.positions.findByMode(mode);
    const domainPositions: Position[] = positionRows.map((r) => ({
      strategyId: r.strategyId as StrategyId,
      venue: r.venue as VenueId,
      symbol: r.symbol as SymbolId,
      signedQty: new Decimal(r.signedQty),
      avgEntry: price(r.avgEntry),
      realizedPnl: new Decimal(r.realizedPnl),
    }));

    return { latest, sodEquity, positions: domainPositions };
  }

  // orders table has no step_size / attempt / cancelWanted columns — these are runtime-only fields
  // for the OMS reducer, synthesized here with safe defaults. Shared by loadOpenOrders (recovery,
  // §4.2) and loadOrderByVenueOrderId (§6.4 cluster-A durable second tier) — one reconstruction, two
  // callers. Never trust a persisted state string blindly (I7): a row whose `state` is outside the
  // OrderState allow-list is corruption — throw loudly rather than synthesize a malformed
  // OrderRecord that downstream recovery/reconciliation would treat as truth.
  private rowToOrderRecord(r: {
    clientOrderId: string;
    state: string;
    qty: string;
    cumQty: string;
    venueOrderId: string | null;
    symbol: string;
  }): OrderRecord {
    if (!isOrderState(r.state)) {
      throw new Error(
        `recovery: unrecognized persisted order state '${r.state}' for clientOrderId ${r.clientOrderId}`,
      );
    }
    return {
      clientOrderId: r.clientOrderId as ClientOrderId,
      state: r.state,
      qty: new Decimal(r.qty),
      cumQty: new Decimal(r.cumQty),
      stepSize: '0.00000001',
      venueOrderId: r.venueOrderId ?? undefined,
      attempt: 0,
      cancelWanted: false,
      // Persisted, unlike the runtime-only fields above — a rehydrated record must still be able to
      // name its own venue (reconciliation's trade index refuses to match a record whose venue it
      // cannot establish).
      symbol: r.symbol as SymbolId,
    };
  }

  async loadOpenOrders(mode: TradingMode): Promise<RecoveredOpenOrder[]> {
    const rows = await this.orders.findOpenByMode(mode);
    const out: RecoveredOpenOrder[] = [];
    for (const r of rows) {
      out.push({
        record: this.rowToOrderRecord(r),
        strategyId: r.strategyId as StrategyId,
        summary: {
          clientOrderId: r.clientOrderId as ClientOrderId,
          symbol: r.symbol as SymbolId,
          side: r.side,
          qty: qty(r.qty),
          limitPrice: r.limitPrice === null ? undefined : price(r.limitPrice),
        },
        intent: await this.loadIntentForRecovery(r.intentId),
      });
    }
    return out;
  }

  async loadFilledQty(clientOrderId: ClientOrderId): Promise<string> {
    return this.fills.sumQtyByClientOrderId(clientOrderId);
  }

  // Resting-order role resolution (P7c) keys on the intent's dedupeKey lineage; the production
  // store must answer this or every live role degrades to 'unknown' and the venue-TP/stop
  // reconcilers go blind (the in-memory store answers from its map). The clientOrderId encodes
  // the intentId, so this is decode + the recovery loader — no new SQL shape. Foreign or
  // malformed ids resolve null (fail-open to 'unknown'), matching the resolver's contract.
  async loadIntentByClientOrderId(clientOrderId: ClientOrderId): Promise<OrderIntent | null> {
    if (!isOurClientOrderId(clientOrderId)) return null;
    return this.loadIntentForRecovery(decodeClientOrderId(clientOrderId).intentId);
  }

  // §6.4 cluster-A durable second-tier lookup (see the port's own header comment): the trade axis's
  // last resort before classifying a venue-order-id-unresolved trade as genuinely foreign.
  async loadOrderByVenueOrderId(venue: VenueId, venueOrderId: string): Promise<OrderRecord | null> {
    const row = await this.orders.findByVenueOrderId(venue, venueOrderId);
    return row === null ? null : this.rowToOrderRecord(row);
  }

  // §6.4 open-orders axis second tier (see the port's own header comment): the durable fallback for
  // a venue-open coid absent from OrderBookService — a just-restarted process, a recovery gap, or
  // true corruption. order.repository's own findByClientOrderId is unscoped (other callers, e.g. this
  // file's own event-fold lookup, intentionally look up by the globally-unique coid alone) — venue is
  // compared HERE against the row's own persisted `venue` column instead, so a row that exists but
  // belongs to a different venue resolves identically to "not found". Environment (demo/testnet vs
  // live) stays unscoped: VenueId alone does not distinguish them, but clientOrderId already encodes
  // mode in its own prefix character, so no two different-mode orders can ever collide on this lookup.
  async loadOrderByClientOrderId(
    venue: VenueId,
    clientOrderId: ClientOrderId,
  ): Promise<OrderRecord | null> {
    const row = await this.orders.findByClientOrderId(clientOrderId);
    return row === null || row.venue !== venue ? null : this.rowToOrderRecord(row);
  }

  // §6.4 spot-lane false-HALT fix: the trade axis's first filter, checked before any classification.
  async hasFill(venue: VenueId, symbol: SymbolId, venueTradeId: string): Promise<boolean> {
    return (await this.fills.fetchByTradeId(venue, symbol, venueTradeId)) !== null;
  }

  // Rehydrate the persisted write-ahead intent (tx1) for a recovered order so the runtime gets
  // the full (order, intent) pair back — fill application, the unknown-resolver's query loop,
  // and Risk's E1 in-flight clamp all key on the in-memory intent. A missing row degrades to
  // null (tolerated residue), never a throw: the order itself still recovers book-only.
  private async loadIntentForRecovery(intentId: string): Promise<OrderIntent | null> {
    const r = await this.intents.findById(intentId);
    if (r === null) return null;
    return {
      intentId: r.intentId as OrderIntent['intentId'],
      clientOrderId: r.clientOrderId as ClientOrderId,
      strategyId: r.strategyId as StrategyId,
      venue: r.venue as VenueId,
      symbol: r.symbol as SymbolId,
      side: r.side,
      type: r.type,
      qty: qty(r.qty),
      limitPrice: r.limitPrice === null ? undefined : price(r.limitPrice),
      // v3 (consolidation spec §2): trigger_price now round-trips through recovery — previously
      // always undefined here (algo-stop-recovery.service.ts's own header comment records the v2 gap).
      triggerPrice: r.triggerPrice === null ? undefined : price(r.triggerPrice),
      timeInForce: r.timeInForce,
      reduceOnly: r.reduceOnly,
      mode: r.mode,
      refPrice: price(r.refPrice),
      refSeq: r.refSeq,
      createdAt: r.createdAt as EpochMs,
      expiresAt: r.expiresAt as EpochMs,
      source: {
        dedupeKey: r.sourceDedupeKey,
        eventTime: r.sourceEventTime as EpochMs,
        basedOnSeq: r.sourceBasedOnSeq,
        // Signal.strength is a plain number (not money); Decimal round-trips the stored text
        // through the sanctioned .toNumber() export boundary.
        strength: new Decimal(r.sourceStrength).toNumber(),
      },
    };
  }
}

// Re-export Decimal so tests that reconstruct fill records can access exact-decimal equality.
export { Decimal };
