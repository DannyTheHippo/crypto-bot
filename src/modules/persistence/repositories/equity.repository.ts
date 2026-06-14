import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc, asc } from 'drizzle-orm';
import type { TradingMode } from '../../../domain/types/mode';
import { DRIZZLE_DB } from '../persistence.tokens';
import * as schema from '../schema';
import { requireDb } from './persistence-guard';

export interface EquityInsert {
  runId: string;
  ts: Date;
  equity: string;
  cash: string;
  unrealized: string;
  peak: string;
  sessionDateUtc: string;
  gapAnnotation?: string;
  bootId: string;
  mode: 'paper' | 'testnet' | 'live';
}

export type EquityRow = typeof schema.equityCurve.$inferSelect;

@Injectable()
export class EquityRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  async insert(row: EquityInsert): Promise<void> {
    await requireDb(this.db).insert(schema.equityCurve).values(row);
  }

  async findLatestByMode(mode: TradingMode): Promise<EquityRow | null> {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.equityCurve)
      .where(eq(schema.equityCurve.mode, mode))
      // `id` (identity PK) is a deterministic tiebreaker so two samples sharing a millisecond `ts`
      // across runs resolve to a single, stable "latest" row (recovery loads by mode across boots).
      .orderBy(desc(schema.equityCurve.ts), desc(schema.equityCurve.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findSessionStartByMode(mode: TradingMode, sessionDateUtc: string): Promise<EquityRow | null> {
    const rows = await requireDb(this.db)
      .select()
      .from(schema.equityCurve)
      .where(and(eq(schema.equityCurve.mode, mode), eq(schema.equityCurve.sessionDateUtc, sessionDateUtc)))
      .orderBy(asc(schema.equityCurve.ts), asc(schema.equityCurve.id))
      .limit(1);
    return rows[0] ?? null;
  }
}
