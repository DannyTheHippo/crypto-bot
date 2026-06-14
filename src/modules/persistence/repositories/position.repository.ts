import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { TradingMode } from '../../../domain/types/mode';
import * as schema from '../schema';
import { requireDb } from './persistence-guard';

export interface PositionInsert {
  strategyId: string;
  venue: string;
  symbol: string;
  signedQty: string;
  avgEntry: string;
  realizedPnl: string;
  mode: TradingMode;
  runId: string;
  bootId: string;
}

export type PositionRow = typeof schema.positions.$inferSelect;

export class PositionRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema> | null) {}

  // Full replace for the mode bucket: DELETE existing rows then INSERT new ones, atomically.
  // Pass tx to execute within an existing transaction; omit to self-manage one.
  async replaceAll(
    mode: TradingMode,
    rows: PositionInsert[],
    tx?: NodePgDatabase<typeof schema>,
  ): Promise<void> {
    if (tx !== undefined) {
      await tx.delete(schema.positions).where(eq(schema.positions.mode, mode));
      if (rows.length) {
        await tx.insert(schema.positions).values(rows);
      }
      return;
    }
    await requireDb(this.db).transaction(async (innerTx) => {
      await innerTx.delete(schema.positions).where(eq(schema.positions.mode, mode));
      if (rows.length) {
        await innerTx.insert(schema.positions).values(rows);
      }
    });
  }

  async findByMode(mode: TradingMode): Promise<PositionRow[]> {
    return requireDb(this.db)
      .select()
      .from(schema.positions)
      .where(eq(schema.positions.mode, mode));
  }
}
