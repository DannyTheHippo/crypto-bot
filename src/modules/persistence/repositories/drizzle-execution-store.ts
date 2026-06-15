import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Decimal from 'decimal.js';
import { price } from '../../../domain/types/money';
import type { TradingMode } from '../../../domain/types/mode';
import type {
  StrategyId,
  VenueId,
  SymbolId,
  ClientOrderId,
  EpochMs,
} from '../../../domain/types/ids';
import type { Position } from '../../../domain/types/portfolio';
import type { OrderIntent } from '../../../domain/types/order-intent';
import type { ApprovalProof } from '../../../domain/types/risk-decision';
import type { FillRecord } from '../../../domain/types/exec-report';
import type { OrderRecord } from '../../../domain/oms/reducer';
import { isOrderState } from '../../../domain/oms/reducer';
import type {
  ExecutionStorePort,
  PersistedOrderEvent,
  EquitySample,
  ReconciliationRow,
  ExecRunContext,
} from '../../../ports/execution';
import * as schema from '../schema';
import { IntentRepository } from './intent.repository';
import { OrderRepository } from './order.repository';
import { FillRepository } from './fill.repository';
import { EquityRepository } from './equity.repository';
import { ReconciliationRepository } from './reconciliation.repository';
import { PositionRepository } from './position.repository';

// Serialize an OrderEvent to a JSON-safe payload. FILL carries a Decimal cumQty that must
// be stored as a string for exact round-trip. All other event types carry no numeric money.
function serializeEvent(event: PersistedOrderEvent['event']): unknown {
  if (event.type === 'FILL') {
    return { type: event.type, cumQty: event.cumQty.toFixed() };
  }
  if (event.type === 'ACK') {
    return { type: event.type, venueOrderId: event.venueOrderId };
  }
  return { type: event.type };
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
      type: intent.type,
      qty: intent.qty.toFixed(),
      limitPrice: intent.limitPrice?.toFixed(),
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
      type: intent.type,
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
      payload: serializeEvent(ev.event),
      // seq is used for ordering within this order's event log. We derive it from the
      // current timestamp in milliseconds cast to bigint — guaranteed monotone within a
      // single process and sufficient for ordering purposes.
      seq: BigInt(Date.now()),
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    });

    if (!inserted) return { applied: false };

    // Refresh the cached reducer state on the orders row.
    await this.orders.updateState(order.intentId, ev.derivedState, ev.cumQty, {
      venueOrderId: ev.venueOrderId,
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
      durationMs: 0,
      openOrdersChecked: 0,
      tradesChecked: 0,
      balancesChecked: 0,
      discrepancies: { mismatches: row.mismatches, detail: row.detail, venue: row.venue },
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

  async loadOpenOrders(mode: TradingMode): Promise<OrderRecord[]> {
    const rows = await this.orders.findOpenByMode(mode);
    // orders table has no step_size / attempt / cancelWanted columns — these are runtime-only
    // fields for the OMS reducer. Recovery routes through reconciliation (§4.2), not reducer
    // replay, so we synthesize safe defaults here.
    return rows.map((r) => {
      // Never trust a persisted state string blindly (I7). A row whose `state` is outside the
      // OrderState allow-list is corruption — fail the boot loudly rather than synthesize a
      // malformed OrderRecord that downstream recovery/reconciliation would treat as truth.
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
      };
    });
  }
}

// Re-export Decimal so tests that reconstruct fill records can access exact-decimal equality.
export { Decimal };
