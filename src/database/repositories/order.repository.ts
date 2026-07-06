import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, isNull } from 'drizzle-orm';
import type { TradingMode } from '../../domain/types/mode';
import { DRIZZLE_DB } from '../database.tokens';
import * as schema from '../schemas/trading';
import { requireDb } from './persistence-guard';

export interface OrderInsert {
  intentId: string;
  clientOrderId: string;
  venueOrderId?: string;
  strategyId: string;
  venue: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER';
  qty: string;
  limitPrice?: string;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  state: string;
  cumQty: string;
  mode: 'paper' | 'testnet' | 'live';
  runId: string;
  bootId: string;
}

export interface OrderEventInsert {
  orderId: string;
  dedupeKey: string;
  eventType: string;
  payload: unknown;
  seq: bigint;
  mode: 'paper' | 'testnet' | 'live';
  runId: string;
  bootId: string;
}

@Injectable()
export class OrderRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(order: OrderInsert): Promise<void> {
    await requireDb(this.db).insert(schema.orders).values(order);
  }

  async updateState(
    intentId: string,
    state: string,
    cumQty: string,
    extra?: Partial<{
      venueOrderId: string;
      submittedAt: number;
      ackedAt: number;
      firstFillAt: number;
      terminalAt: number;
      rawAck: unknown;
    }>,
  ): Promise<void> {
    await requireDb(this.db)
      .update(schema.orders)
      .set({ state, cumQty, updatedAt: new Date(), ...extra })
      .where(eq(schema.orders.intentId, intentId));
  }

  // ON CONFLICT DO NOTHING — idempotent re-apply posture for the Phase 5 reducer.
  // Returns { inserted: true } on new row, { inserted: false } on duplicate dedupe_key.
  async appendEvent(event: OrderEventInsert): Promise<{ inserted: boolean }> {
    const rows = await requireDb(this.db)
      .insert(schema.orderEvents)
      .values(event)
      .onConflictDoNothing()
      .returning({ id: schema.orderEvents.id });
    return { inserted: rows.length > 0 };
  }

  async findByIntentId(intentId: string) {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.intentId, intentId));
    return rows[0] ?? null;
  }

  async findByClientOrderId(clientOrderId: string) {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.clientOrderId, clientOrderId));
    return rows[0] ?? null;
  }

  async findOpenByMode(mode: TradingMode) {
    return requireDb(this.db)
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.mode, mode), isNull(schema.orders.terminalAt)));
  }
}
