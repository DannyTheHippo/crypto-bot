/**
 * DB integration suite — requires a live PostgreSQL 16 at DATABASE_URL.
 * Skips entirely without it so `pnpm test:db` without DATABASE_URL exits 0.
 *
 * WARNING: this suite DROPS SCHEMA public CASCADE before running migrations.
 * It must only run against a disposable test database.
 *
 * Safety guard (M7): the suite is skipped unless EITHER:
 *   - DB_SUITE_ALLOW_RESET=1 is set, OR
 *   - the database name in DATABASE_URL ends with `_test`
 *
 * Run unsandboxed:
 *   DB_SUITE_ALLOW_RESET=1 DATABASE_URL=postgres://cryptobot:cryptobot@127.0.0.1:5432/cryptobot_test pnpm test:db
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as path from 'path';
import * as schema from '../../src/database/schemas/trading';
import { computeAuditHash, AUDIT_INITIAL_PREV_HASH } from '../../src/database/journal-hash';
import { JournalRepository } from '../../src/database/repositories/trading/journal.repository';
import { OutboxRepository } from '../../src/database/repositories/trading/outbox.repository';
import { FillRepository } from '../../src/database/repositories/trading/fill.repository';
import { DrizzleExecutionStore } from '../../src/database/repositories/trading/drizzle-execution-store';
import type { PersistedOrderEvent, ReconciliationRow } from '../../src/ports/trading/execution';
import { OrderRepository } from '../../src/database/repositories/trading/order.repository';
import { IntentRepository } from '../../src/database/repositories/trading/intent.repository';
import { RiskDecisionRepository } from '../../src/database/repositories/trading/risk-decision.repository';
import { SignalRepository } from '../../src/database/repositories/trading/signal.repository';
import { AgentDecisionRepository } from '../../src/database/repositories/strategy/agent-decision.repository';
import { AgentDecisionJournalAdapter } from '../../src/database/repositories/strategy/agent-decision-journal.adapter';
import { PlaybookStoreAdapter } from '../../src/database/repositories/strategy/playbook-store.adapter';
import { LlmUsageRepository } from '../../src/database/repositories/common/llm-usage.repository';
import { LlmUsageSinkAdapter } from '../../src/database/repositories/common/llm-usage-sink.adapter';
import { PromotionStatsRepository } from '../../src/database/repositories/trading/promotion-stats.repository';
import type { AgentDecisionEntry } from '../../src/ports/strategy/agentic-strategy';
import Decimal from 'decimal.js';
import { price, qty } from '../../src/domain/common/types/money';
import {
  venueId,
  symbolId,
  clientOrderId,
  strategyId,
  epochMs,
} from '../../src/domain/common/types/ids';
import type { FillRecord } from '../../src/domain/trading/types/exec-report';
import type { Position } from '../../src/domain/trading/types/portfolio';

const DB_URL = process.env['DATABASE_URL'];

function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

const resetAllowed =
  process.env['DB_SUITE_ALLOW_RESET'] === '1' || (!!DB_URL && dbNameEndsWithTest(DB_URL));

const SKIP = !DB_URL || !resetAllowed;

// HARD SAFETY WALL, independent of every env flag above: this suite DROPs the public schema, so
// it must be structurally impossible to aim it at a non-_test database. DB_SUITE_ALLOW_RESET
// exists so READ-ONLY suites (test/eval) can acknowledge a production DATABASE_URL — it must
// never double as a license to reset one. Incident 2026-07-10: an accidental full-suite vitest
// invocation with ALLOW_RESET=1 + the production URL dropped the live `cryptobot` schema; this
// throw (not a skip — a skip would hide the misconfiguration) is the guarantee it cannot recur.
function assertDestructiveTargetIsTestDb(url: string): void {
  if (!dbNameEndsWithTest(url)) {
    throw new Error(
      `persistence.spec.ts refuses to DROP SCHEMA on database "${new URL(url).pathname.replace(/^\//, '')}": ` +
        'destructive DB suites only ever run against a database whose name ends in _test, ' +
        'regardless of DB_SUITE_ALLOW_RESET.',
    );
  }
}

// drizzle ≥0.44 wraps query failures in DrizzleQueryError with the pg error (code 23505,
// "duplicate key value violates unique constraint") on the `cause` chain, so unique-violation
// assertions must walk the chain rather than match the top-level message.
function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e !== null && e !== undefined; e = (e as { cause?: unknown }).cause) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (code === '23505') return true;
    if (typeof message === 'string' && /unique|duplicate/i.test(message)) return true;
  }
  return false;
}

// pg returns NUMERIC(38,18) padded to 18 decimal places.
function pad18(s: string): string {
  const dot = s.indexOf('.');
  if (dot === -1) return s + '.' + '0'.repeat(18);
  const frac = s.slice(dot + 1);
  return frac.length >= 18 ? s.slice(0, dot + 19) : s + '0'.repeat(18 - frac.length);
}

const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

describe.skipIf(SKIP)('DB integration — persistence layer', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    assertDestructiveTargetIsTestDb(DB_URL!);
    pool = new Pool({ connectionString: DB_URL! });

    // The generated DDL schema-qualifies references (public.*), so the migrations
    // must run verbatim against public. The target DB is dedicated to this suite:
    // reset public + drizzle bookkeeping so every run applies migrations from scratch.
    await pool.query(`DROP SCHEMA IF EXISTS public CASCADE`);
    await pool.query(`CREATE SCHEMA public`);
    await pool.query(`DROP SCHEMA IF EXISTS drizzle CASCADE`);

    db = drizzle(pool, { schema });

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  }, 10_000);

  // Seed a minimal order_intents parent row so a subsequent orders insert satisfies the
  // orders.intent_id → order_intents FK (the write-ahead path always persists the intent first).
  async function seedIntent(
    intentId: string,
    clientOrderId: string,
    mode: string,
    runId: string,
    bootId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO public.order_intents
        (intent_id, client_order_id, strategy_id, venue, symbol, side, type, qty, time_in_force, reduce_only,
         ref_price, ref_seq, created_at, expires_at, source_dedupe_key, source_event_time, source_based_on_seq,
         source_strength, mode, run_id, boot_id)
       VALUES ($1,$2,'s','binance','BTC/USDT','BUY','LIMIT','1.000000000000000000','GTC',false,
         '50000.000000000000000000',0,0,9999999,$3,0,0,'0.5',$4,$5,$6)`,
      [intentId, clientOrderId, `dk-${intentId}`, mode, runId, bootId],
    );
  }

  // ── (a) Migrations apply ──────────────────────────────────────────────────
  it('(a) all expected tables exist after migration', async () => {
    const result = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      ['public'],
    );
    const tables = result.rows.map((r) => r.tablename);
    const expected = [
      'agent_decisions',
      'agent_playbook_versions',
      'audit_log',
      'balances',
      'config_snapshots',
      'equity_curve',
      'exec_outbox',
      'experiments',
      'fee_ledger',
      'fills',
      'funding_events',
      'funding_payments',
      'llm_usage',
      'mode_transitions',
      'order_events',
      'order_intents',
      'orders',
      'outbox_consumer_acks',
      'positions',
      'reconciliations',
      'risk_decisions',
      'signals',
    ];
    for (const t of expected) {
      expect(tables, `table ${t} missing`).toContain(t);
    }
  });

  // ── (a2) information_schema shape assertions ──────────────────────────────
  it('(a2) audit_log.payload column type is text (not jsonb)', async () => {
    const result = await pool.query<{ data_type: string }>(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'audit_log' AND column_name = 'payload'`,
    );
    expect(result.rows[0]?.data_type).toBe('text');
  });

  it('(a2) positions primary key has mode as first column and 4 total columns', async () => {
    const result = await pool.query<{ column_name: string; ordinal_position: number }>(
      `SELECT kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'public'
         AND tc.table_name = 'positions'
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
    );
    const cols = result.rows.map((r) => r.column_name);
    expect(cols[0], 'mode must be first PK column').toBe('mode');
    expect(cols).toContain('strategy_id');
    expect(cols).toContain('venue');
    expect(cols).toContain('symbol');
    expect(cols.length).toBe(4);
  });

  it('(a2) order_events.id is primary key with GENERATED ALWAYS AS IDENTITY', async () => {
    const pkResult = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'public'
         AND tc.table_name = 'order_events'
         AND tc.constraint_type = 'PRIMARY KEY'`,
    );
    expect(pkResult.rows.map((r) => r.column_name)).toContain('id');

    const identResult = await pool.query<{ is_identity: string; identity_generation: string }>(
      `SELECT is_identity, identity_generation
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'order_events' AND column_name = 'id'`,
    );
    expect(identResult.rows[0]?.is_identity).toBe('YES');
    expect(identResult.rows[0]?.identity_generation).toBe('ALWAYS');
  });

  it('(a2) order_events has UNIQUE index on (order_id, dedupe_key)', async () => {
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'order_events'
         AND indexname = 'order_events_order_dedupe_uidx'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.indexdef).toMatch(/UNIQUE/i);
  });

  // ── (b) Exact-decimal round-trip ─────────────────────────────────────────
  it('(b) NUMERIC(38,18) round-trip: adversarial values preserve exact strings', async () => {
    const cases: Array<{ input: string; expected: string }> = [
      { input: '0.000000000000000001', expected: pad18('0.000000000000000001') },
      {
        input: '99999999999999999999.999999999999999999',
        expected: '99999999999999999999.999999999999999999',
      },
      { input: '0.1', expected: pad18('0.1') },
      { input: '123.456', expected: pad18('123.456') },
    ];

    for (const { input, expected } of cases) {
      await pool.query(
        `INSERT INTO public.balances
           (venue, asset, free, locked, mode, run_id, boot_id)
         VALUES ('test', $1, $2, '0.000000000000000000', 'paper', 'run1', 'boot1')`,
        [input, input],
      );
      const row = await pool.query<{ free: string; locked: string }>(
        `SELECT free, locked FROM public.balances WHERE venue='test' AND asset=$1 LIMIT 1`,
        [input],
      );
      expect(row.rows[0]!.free, `free for input ${input}`).toBe(expected);
      expect(typeof row.rows[0]!.free).toBe('string');
    }
  });

  // ── (c) Audit immutability ────────────────────────────────────────────────
  it('(c) UPDATE on audit_log raises exception', async () => {
    await pool.query(
      `INSERT INTO public.audit_log (actor, category, payload, prev_hash, hash)
       VALUES ('test', 'test', '{}', $1, $2)`,
      ['0'.repeat(64), computeAuditHash({}, AUDIT_INITIAL_PREV_HASH)],
    );
    await expect(
      pool.query(`UPDATE public.audit_log SET actor='hacker' WHERE actor='test'`),
    ).rejects.toThrow(/append-only|prohibited/i);
  });

  it('(c) DELETE on audit_log raises exception', async () => {
    await expect(pool.query(`DELETE FROM public.audit_log WHERE actor='test'`)).rejects.toThrow(
      /append-only|prohibited/i,
    );
  });

  it('(c) TRUNCATE on audit_log raises exception', async () => {
    await expect(pool.query(`TRUNCATE public.audit_log`)).rejects.toThrow(
      /append-only|prohibited/i,
    );
  });

  it('(c) UPDATE on order_events raises exception', async () => {
    // Insert prerequisite: order_intent + order first (FK chain).
    await pool.query(
      `INSERT INTO public.order_intents
         (intent_id, client_order_id, strategy_id, venue, symbol, side, type,
          qty, time_in_force, reduce_only, ref_price, ref_seq,
          created_at, expires_at, source_dedupe_key, source_event_time,
          source_based_on_seq, source_strength, mode, run_id, boot_id)
       VALUES ('intent-oe-1','cbpdeadbeef00000000000000000000001','s1','binance','BTC/USDT',
               'BUY','LIMIT','1.000000000000000000','GTC',false,
               '50000.000000000000000000',0,0,9999999999,'dk1',0,0,'0.5','paper','r1','b1')
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO public.orders
         (intent_id, client_order_id, strategy_id, venue, symbol, side, type,
          qty, time_in_force, state, cum_qty, mode, run_id, boot_id)
       VALUES ('intent-oe-1','cbpdeadbeef00000000000000000000001','s1','binance','BTC/USDT',
               'BUY','LIMIT','1.000000000000000000','GTC','NEW',
               '0.000000000000000000','paper','r1','b1')
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO public.order_events
         (order_id, dedupe_key, event_type, payload, seq, mode, run_id, boot_id)
       VALUES ('intent-oe-1','dk-immutable','SUBMITTED','{}',1,'paper','r1','b1')`,
    );
    await expect(
      pool.query(
        `UPDATE public.order_events SET event_type='TAMPERED' WHERE dedupe_key='dk-immutable'`,
      ),
    ).rejects.toThrow(/append-only|prohibited/i);
  });

  it('(c) DELETE on order_events raises exception', async () => {
    await expect(
      pool.query(`DELETE FROM public.order_events WHERE dedupe_key='dk-immutable'`),
    ).rejects.toThrow(/append-only|prohibited/i);
  });

  it('(c) TRUNCATE on order_events raises exception', async () => {
    await expect(pool.query(`TRUNCATE public.order_events`)).rejects.toThrow(
      /append-only|prohibited/i,
    );
  });

  // ── (c2) v3: 0001_v3_append_only_hardening.sql also covers funding_events/funding_payments/
  // experiments (folded into ONE hardening migration alongside audit_log/order_events — see that
  // migration's header comment) ──────────────────────────────────────────────────────────────────
  it('(c2) UPDATE/DELETE/TRUNCATE on funding_events raise exceptions', async () => {
    await pool.query(
      `INSERT INTO public.funding_events
        (strategy_id, venue, symbol, funding_rate, mark_price, signed_qty, payment_quote,
         funding_time, mode)
       VALUES ('s', 'binanceusdm', 'BTC/USDT:USDT', '0.0001', '50000', '1', '-5',
         now(), 'paper')`,
    );
    await expect(
      pool.query(`UPDATE public.funding_events SET mode = 'live' WHERE strategy_id = 's'`),
    ).rejects.toThrow(/append-only|prohibited/i);
    await expect(
      pool.query(`DELETE FROM public.funding_events WHERE strategy_id = 's'`),
    ).rejects.toThrow(/append-only|prohibited/i);
    await expect(pool.query(`TRUNCATE public.funding_events`)).rejects.toThrow(
      /append-only|prohibited/i,
    );
  });

  it('(c2) UPDATE/DELETE/TRUNCATE on funding_payments raise exceptions', async () => {
    await pool.query(
      `INSERT INTO public.funding_payments
        (venue, symbol, venue_payment_id, amount_quote, funding_time, mode)
       VALUES ('binanceusdm', 'BTC/USDT:USDT', 'fp-immutable-1', '3.5', 1700000000000, 'paper')`,
    );
    await expect(
      pool.query(
        `UPDATE public.funding_payments SET mode = 'live' WHERE venue_payment_id = 'fp-immutable-1'`,
      ),
    ).rejects.toThrow(/append-only|prohibited/i);
    await expect(
      pool.query(`DELETE FROM public.funding_payments WHERE venue_payment_id = 'fp-immutable-1'`),
    ).rejects.toThrow(/append-only|prohibited/i);
    await expect(pool.query(`TRUNCATE public.funding_payments`)).rejects.toThrow(
      /append-only|prohibited/i,
    );
  });

  // ── (d) Hash chain — via real JournalRepository ───────────────────────────
  it('(d) hash chain: JournalRepository.append stores entries with correct chained hashes', async () => {
    const journal = new JournalRepository(db);
    const entries = [
      { actor: 'system', category: 'boot', payload: { event: 'start', n: 1 } },
      { actor: 'system', category: 'mode', payload: { event: 'paper', n: 2 } },
      { actor: 'operator', category: 'arm', payload: { event: 'arm_request', n: 3 } },
    ];

    const seqs: number[] = [];
    for (const e of entries) {
      const seq = await journal.append(e);
      seqs.push(seq);
    }
    expect(seqs.length).toBe(3);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
    expect(seqs[2]!).toBeGreaterThan(seqs[1]!);

    // Fetch back and re-derive chain to confirm stored hashes are consistent.
    // The payload column stores canonical sorted-key JSON text; we parse it to
    // recompute the hash rather than relying on the original in-memory object.
    const result = await pool.query<{
      seq: number;
      prev_hash: string;
      hash: string;
      payload: string;
    }>(
      `SELECT seq, prev_hash, hash, payload FROM public.audit_log
       WHERE seq >= $1 ORDER BY seq`,
      [seqs[0]],
    );
    const rows = result.rows;
    expect(rows.length).toBe(3);

    let rePrev = rows[0]!.prev_hash;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const storedPayload = JSON.parse(row.payload) as unknown;
      const reHash = computeAuditHash(storedPayload, rePrev);
      expect(row.hash, `hash mismatch at entry ${i}`).toBe(reHash);
      expect(row.prev_hash, `prev_hash mismatch at entry ${i}`).toBe(rePrev);
      rePrev = reHash;
    }
  });

  it('(d) hash chain breaks if payload is tampered (computed, not stored)', () => {
    const p1 = { event: 'boot' };
    const p2 = { event: 'trade' };
    const h1 = computeAuditHash(p1, AUDIT_INITIAL_PREV_HASH);
    const h2 = computeAuditHash(p2, h1);

    const tamperedH1 = computeAuditHash({ event: 'TAMPERED' }, AUDIT_INITIAL_PREV_HASH);
    const brokenH2 = computeAuditHash(p2, tamperedH1);
    expect(brokenH2).not.toBe(h2);
  });

  // ── (e) Outbox semantics — via real OutboxRepository ─────────────────────
  it('(e) outbox: append 3 reports via OutboxRepository, consume returns them in cursor order', async () => {
    const outbox = new OutboxRepository(db);
    const reports = [
      {
        reportId: 'rep-1',
        payload: { kind: 'ACK', n: 1 },
        mode: 'paper' as const,
        runId: 'run-ob',
        bootId: 'boot-ob',
      },
      {
        reportId: 'rep-2',
        payload: { kind: 'FILL', n: 2 },
        mode: 'paper' as const,
        runId: 'run-ob',
        bootId: 'boot-ob',
      },
      {
        reportId: 'rep-3',
        payload: { kind: 'CANCEL_ACK', n: 3 },
        mode: 'paper' as const,
        runId: 'run-ob',
        bootId: 'boot-ob',
      },
    ];
    const cursors: number[] = [];
    for (const r of reports) {
      const cursor = await outbox.append(r);
      cursors.push(cursor);
    }
    expect(cursors.length).toBe(3);
    expect(cursors[1]!).toBeGreaterThan(cursors[0]!);
    expect(cursors[2]!).toBeGreaterThan(cursors[1]!);

    const rows = await outbox.consume('consumer-repo-test', 0);
    const ours = rows.filter((r) => reports.some((p) => p.reportId === r.reportId));
    expect(ours.length).toBe(3);
    expect(ours[0]!.reportId).toBe('rep-1');
    expect(ours[1]!.reportId).toBe('rep-2');
    expect(ours[2]!.reportId).toBe('rep-3');
  });

  it('(e) outbox: ack via OutboxRepository.ack; re-consume returns only rows above ack cursor', async () => {
    const outbox = new OutboxRepository(db);

    const ackResult = await pool.query<{ cursor: number }>(
      `SELECT cursor FROM public.exec_outbox WHERE report_id = 'rep-2'`,
    );
    const ackCursor = ackResult.rows[0]!.cursor;

    await outbox.ack('consumer-repo-ack', ackCursor);

    const remaining = await outbox.consume('consumer-repo-ack', 0);
    const ours = remaining.filter((r) => ['rep-1', 'rep-2', 'rep-3'].includes(r.reportId));
    expect(ours.every((r) => r.cursor > ackCursor)).toBe(true);
  });

  it('(e) outbox: duplicate reportId via OutboxRepository.append returns same cursor (idempotent)', async () => {
    const outbox = new OutboxRepository(db);
    const report = {
      reportId: 'rep-dedup-repo',
      payload: { kind: 'ACK' },
      mode: 'paper' as const,
      runId: 'run-ob',
      bootId: 'boot-ob',
    };
    const cursor1 = await outbox.append(report);
    const cursor2 = await outbox.append(report);
    expect(cursor1).toBe(cursor2);
  });

  // ── (f) Fill dedupe — via real FillRepository ─────────────────────────────
  it('(f) fill dedupe: same (venue,symbol,venue_trade_id) via FillRepository.insertIdempotent → one row', async () => {
    const fillRepo = new FillRepository(db);
    const fill = {
      venue: 'binance',
      symbol: 'BTC/USDT',
      venueTradeId: 'trade-repo-001',
      clientOrderId: 'cbpdeadbeef00000000000000000000001',
      price: '50000.000000000000000000',
      qty: '0.001000000000000000',
      feeResolved: false,
      liquidity: 'taker' as const,
      venueTimestamp: 1700000000000,
      source: 'ws' as const,
      mode: 'paper' as const,
      runId: 'r1',
      bootId: 'b1',
    };

    const r1 = await fillRepo.insertIdempotent(fill);
    expect(r1.inserted).toBe(true);

    const r2 = await fillRepo.insertIdempotent(fill);
    expect(r2.inserted).toBe(false);

    const fetched = await fillRepo.fetchByTradeId('binance', 'BTC/USDT', 'trade-repo-001');
    expect(fetched).not.toBeNull();
    expect(fetched!.venueTradeId).toBe('trade-repo-001');
  });

  // ── (f2) DrizzleExecutionStore.saveFill — Decimal dedupe, no false conflict ──
  it('(f2) saveFill re-ingesting an identical fill returns {inserted:false, conflict:false}', async () => {
    // Regression: pg renders NUMERIC(38,18) padded ('100.500000000000000000'); a STRING compare
    // against fill.price.toFixed() ('100.5') would false-positive a FILL_PAYLOAD_CONFLICT and HALT
    // the bot on every benign duplicate fill. saveFill must compare by exact Decimal value.
    const store = new DrizzleExecutionStore(db, { mode: 'paper', runId: 'r1', bootId: 'b1' });
    const fill: FillRecord = {
      venue: venueId('binance'),
      symbol: symbolId('BTC/USDT'),
      venueTradeId: 'dup-decimal-1',
      clientOrderId: clientOrderId('cbpdeadbeef00000000000000000000099'),
      price: price('100.5'),
      qty: qty('0.001'),
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(1_700_000_000_000),
      source: 'paper',
    };
    const first = await store.saveFill(fill, '');
    expect(first.inserted).toBe(true);
    const second = await store.saveFill(fill, '');
    expect(second.inserted).toBe(false);
    expect(second.conflict).toBe(false);
  });

  // ── (h) DB-backed recovery surface (savePortfolioSample / loadRecoverySnapshot / loadOpenOrders) ──
  // Each test uses a distinct `mode` so the mode-keyed (current-state) positions/orders tables
  // do not couple tests. Money is asserted by EXACT padded string (pg renders NUMERIC(38,18)).
  it('(h) savePortfolioSample + loadRecoverySnapshot round-trips equity and positions exactly', async () => {
    const store = new DrizzleExecutionStore(db, {
      mode: 'testnet',
      runId: 'run-rec',
      bootId: 'boot-rec',
    });
    const pos: Position = {
      strategyId: strategyId('s-rec'),
      venue: venueId('binance'),
      symbol: symbolId('BTC/USDT'),
      signedQty: new Decimal('1.5'),
      avgEntry: price('20000'),
      realizedPnl: new Decimal('12.25'),
    };
    await store.savePortfolioSample(
      {
        ts: epochMs(1_700_000_100_000),
        equity: '49850.5',
        cash: '19850.5',
        unrealized: '0',
        peak: '50000',
        sessionDateUtc: '2026-06-14',
      },
      [pos],
    );

    const snap = await store.loadRecoverySnapshot('testnet');
    expect(snap.latest).not.toBeNull();
    expect(snap.latest!.cash).toBe(pad18('19850.5'));
    expect(snap.latest!.equity).toBe(pad18('49850.5'));
    expect(snap.latest!.peak).toBe(pad18('50000'));
    // sodEquity = first sample of the latest row's session date = this sample.
    expect(snap.sodEquity).toBe(pad18('49850.5'));
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.signedQty.toFixed()).toBe('1.5');
    expect(snap.positions[0]!.avgEntry.toFixed()).toBe('20000');
    expect(snap.positions[0]!.realizedPnl.toFixed()).toBe('12.25');

    // Full restore invariant: restored equity must equal cash + Σ(signedQty × avgEntry-as-mark) exactly.
    const recomputed = new Decimal(snap.latest!.cash).plus(
      snap.positions.reduce((acc, p) => acc.plus(p.signedQty.mul(p.avgEntry)), new Decimal(0)),
    );
    // cash 19850.5 + 1.5×20000 = 49850.5
    expect(recomputed.toFixed()).toBe('49850.5');
  });

  it('(h) savePortfolioSample with an empty position set clears the persisted positions (flat)', async () => {
    const store = new DrizzleExecutionStore(db, {
      mode: 'live',
      runId: 'run-flat',
      bootId: 'boot-flat',
    });
    await store.savePortfolioSample(
      {
        ts: epochMs(1_700_000_200_000),
        equity: '100',
        cash: '100',
        unrealized: '0',
        peak: '100',
        sessionDateUtc: '2026-06-15',
      },
      [
        {
          strategyId: strategyId('s-flat'),
          venue: venueId('binance'),
          symbol: symbolId('ETH/USDT'),
          signedQty: new Decimal('2'),
          avgEntry: price('3000'),
          realizedPnl: new Decimal('0'),
        },
      ],
    );
    // A later flat sample must DELETE the prior position row (replaceAll = DELETE-by-mode + insert []).
    await store.savePortfolioSample(
      {
        ts: epochMs(1_700_000_300_000),
        equity: '100',
        cash: '100',
        unrealized: '0',
        peak: '100',
        sessionDateUtc: '2026-06-15',
      },
      [],
    );
    const snap = await store.loadRecoverySnapshot('live');
    expect(snap.positions).toHaveLength(0);
    expect(snap.latest!.cash).toBe(pad18('100'));
  });

  it('(h) loadOpenOrders returns only non-terminal orders for the mode', async () => {
    const store = new DrizzleExecutionStore(db, {
      mode: 'live',
      runId: 'run-oo',
      bootId: 'boot-oo',
    });
    // orders.intent_id has a (legitimate) FK to order_intents (write-ahead: saveIntent precedes
    // saveNewOrder), so seed the parent intents first.
    await seedIntent('oo-open-1', 'cbp-oo-open-000000000000000000001', 'live', 'run-oo', 'boot-oo');
    await seedIntent('oo-term-1', 'cbp-oo-term-000000000000000000001', 'live', 'run-oo', 'boot-oo');
    const ins = `INSERT INTO public.orders
      (intent_id, client_order_id, strategy_id, venue, symbol, side, type, qty, time_in_force, state, cum_qty, terminal_at, mode, run_id, boot_id)
      VALUES `;
    // open (terminal_at NULL) + terminal (terminal_at set) under mode 'live'
    await pool.query(
      ins +
        `('oo-open-1','cbp-oo-open-000000000000000000001','s','binance','BTC/USDT','BUY','LIMIT','1.000000000000000000','GTC','ACKED','0.000000000000000000',NULL,'live','run-oo','boot-oo')`,
    );
    await pool.query(
      ins +
        `('oo-term-1','cbp-oo-term-000000000000000000001','s','binance','BTC/USDT','BUY','LIMIT','1.000000000000000000','GTC','FILLED','1.000000000000000000',1700000000000,'live','run-oo','boot-oo')`,
    );

    const open = await store.loadOpenOrders('live');
    expect(open).toHaveLength(1);
    expect(open[0]!.record.clientOrderId).toBe('cbp-oo-open-000000000000000000001');
    expect(open[0]!.record.state).toBe('ACKED');
    // The portfolio-seeding half (2026-07-07): strategy attribution + open-order summary come
    // from the same row, exact strings preserved through the Qty/Price mints.
    expect(open[0]!.strategyId).toBe('s');
    expect(open[0]!.summary.symbol).toBe('BTC/USDT');
    expect(open[0]!.summary.side).toBe('BUY');
    expect(open[0]!.summary.qty.toFixed()).toBe('1');
    expect(open[0]!.summary.limitPrice).toBeUndefined();
  });

  it('(h) loadOpenOrders fails fast on an unrecognized persisted state (I7 — never trusted)', async () => {
    const store = new DrizzleExecutionStore(db, {
      mode: 'paper',
      runId: 'run-bad',
      bootId: 'boot-bad',
    });
    await seedIntent(
      'oo-bad-1',
      'cbp-oo-bad-0000000000000000000001',
      'paper',
      'run-bad',
      'boot-bad',
    );
    const ins = `INSERT INTO public.orders
      (intent_id, client_order_id, strategy_id, venue, symbol, side, type, qty, time_in_force, state, cum_qty, terminal_at, mode, run_id, boot_id)
      VALUES ('oo-bad-1','cbp-oo-bad-0000000000000000000001','s','binance','BTC/USDT','BUY','LIMIT','1.000000000000000000','GTC','BOGUS_STATE','0.000000000000000000',NULL,'paper','run-bad','boot-bad')`;
    await pool.query(ins);
    await expect(store.loadOpenOrders('paper')).rejects.toThrow(
      /unrecognized persisted order state/i,
    );
  });

  // ── (h2) W7: terminal_at is stamped at the appendOrderEvent chokepoint, and loadOpenOrders/
  // findOpenByMode excludes the row once it is set ────────────────────────────────────────────
  it('(h2) appendOrderEvent stamps terminal_at for a terminal derivedState and leaves it null for a non-terminal one', async () => {
    const store = new DrizzleExecutionStore(db, {
      mode: 'live',
      runId: 'run-tat',
      bootId: 'boot-tat',
    });
    const orderRepo = new OrderRepository(db);
    await seedIntent(
      'oo-tat-term',
      'cbp-oo-tat-term0000000000000001',
      'live',
      'run-tat',
      'boot-tat',
    );
    await seedIntent(
      'oo-tat-open',
      'cbp-oo-tat-open0000000000000001',
      'live',
      'run-tat',
      'boot-tat',
    );
    const ins = `INSERT INTO public.orders
      (intent_id, client_order_id, strategy_id, venue, symbol, side, type, qty, time_in_force, state, cum_qty, terminal_at, mode, run_id, boot_id)
      VALUES `;
    await pool.query(
      ins +
        `('oo-tat-term','cbp-oo-tat-term0000000000000001','s','binance','BTC/USDT','BUY','LIMIT','1.000000000000000000','GTC','ACKED','0.000000000000000000',NULL,'live','run-tat','boot-tat')`,
    );
    await pool.query(
      ins +
        `('oo-tat-open','cbp-oo-tat-open0000000000000001','s','binance','BTC/USDT','BUY','LIMIT','1.000000000000000000','GTC','ACKED','0.000000000000000000',NULL,'live','run-tat','boot-tat')`,
    );

    const before = Date.now();
    const terminalApply = await store.appendOrderEvent({
      clientOrderId: clientOrderId('cbp-oo-tat-term0000000000000001'),
      dedupeKey: 'venue-canceled',
      event: { type: 'VENUE_CANCELED' },
      derivedState: 'CANCELED',
      cumQty: '0',
    });
    const nonTerminalApply = await store.appendOrderEvent({
      clientOrderId: clientOrderId('cbp-oo-tat-open0000000000000001'),
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: 'v-tat' },
      derivedState: 'ACKED',
      cumQty: '0',
      venueOrderId: 'v-tat',
    });
    const after = Date.now();
    expect(terminalApply).toEqual({ applied: true });
    expect(nonTerminalApply).toEqual({ applied: true });

    const term = await orderRepo.findByClientOrderId('cbp-oo-tat-term0000000000000001');
    const open = await orderRepo.findByClientOrderId('cbp-oo-tat-open0000000000000001');
    expect(term!.terminalAt).not.toBeNull();
    expect(term!.terminalAt as number).toBeGreaterThanOrEqual(before);
    expect(term!.terminalAt as number).toBeLessThanOrEqual(after);
    expect(open!.terminalAt).toBeNull();

    // The chokepoint fix means findOpenByMode/loadOpenOrders now excludes the terminal row —
    // this is the BootRecovery re-seed bug the backfill + stamping fix (W7) closes. `mode: 'live'`
    // is shared with an earlier test's fixture rows, so assert membership rather than the full set.
    const openCoids = (await store.loadOpenOrders('live')).map((o) => o.record.clientOrderId);
    expect(openCoids).toContain('cbp-oo-tat-open0000000000000001');
    expect(openCoids).not.toContain('cbp-oo-tat-term0000000000000001');
  });

  // ── (h3) #40: submitted_at/acked_at/first_fill_at are first-write-wins at the SQL layer —
  // the COALESCE in OrderRepository.updateState must keep the EARLIEST stamp when a requeued
  // submit, re-ack, or later partial fill re-sends one (review must-fix: only a real-Postgres
  // test exercises the COALESCE; the unit spec pins the chokepoint mapping only) ───────────────
  it('(h3) lifecycle stamps are first-write-wins: a second ACK and a second FILL never move acked_at/first_fill_at', async () => {
    const store = new DrizzleExecutionStore(db, {
      mode: 'paper',
      runId: 'run-fww',
      bootId: 'boot-fww',
    });
    const orderRepo = new OrderRepository(db);
    await seedIntent(
      'oo-fww-1',
      'cbp-oo-fww-0000000000000000000001',
      'paper',
      'run-fww',
      'boot-fww',
    );
    await pool.query(
      `INSERT INTO public.orders
      (intent_id, client_order_id, strategy_id, venue, symbol, side, type, qty, time_in_force, state, cum_qty, terminal_at, mode, run_id, boot_id)
      VALUES ('oo-fww-1','cbp-oo-fww-0000000000000000000001','s','binance','BTC/USDT','BUY','LIMIT','1.000000000000000000','GTC','SUBMITTING','0.000000000000000000',NULL,'paper','run-fww','boot-fww')`,
    );
    const coid = clientOrderId('cbp-oo-fww-0000000000000000000001');
    const ev = (
      dedupeKey: string,
      event: PersistedOrderEvent['event'],
      derivedState: PersistedOrderEvent['derivedState'],
      cumQty = '0',
    ): PersistedOrderEvent => ({ clientOrderId: coid, dedupeKey, event, derivedState, cumQty });

    await store.appendOrderEvent(ev('submit', { type: 'SUBMIT_SENT' }, 'SUBMITTING'));
    await store.appendOrderEvent(ev('ack', { type: 'ACK', venueOrderId: 'v-fww' }, 'ACKED'));
    const afterFirstAck = await orderRepo.findByClientOrderId(String(coid));
    expect(afterFirstAck!.submittedAt).not.toBeNull();
    expect(afterFirstAck!.ackedAt).not.toBeNull();

    // Ensure a distinct wall-clock ms, then re-send an ACK and the fills.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.appendOrderEvent(ev('ack-2', { type: 'ACK', venueOrderId: 'v-fww' }, 'ACKED'));
    await store.appendOrderEvent(
      ev('fill-1', { type: 'FILL', cumQty: new Decimal('0.5') }, 'PARTIALLY_FILLED', '0.5'),
    );
    const afterPartial = await orderRepo.findByClientOrderId(String(coid));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.appendOrderEvent(
      ev('fill-2', { type: 'FILL', cumQty: new Decimal('1') }, 'FILLED', '1'),
    );

    const final = await orderRepo.findByClientOrderId(String(coid));
    expect(final!.submittedAt).toBe(afterFirstAck!.submittedAt); // never moved by later events
    expect(final!.ackedAt).toBe(afterFirstAck!.ackedAt); // second ACK could not move it
    expect(final!.firstFillAt).toBe(afterPartial!.firstFillAt); // full fill could not move it
    expect(final!.terminalAt).not.toBeNull();
  });

  // ── (i) Decision-trail persistence (§8): risk_decisions + signals rows land ──
  it('(i) risk_decisions row round-trips with exact reasons and mode scoping', async () => {
    const repo = new RiskDecisionRepository(db);
    await repo.insert({
      intentId: 'dt-intent-1',
      verdict: 'REJECTED',
      reasons: ['DAILY_LOSS', 'MAX_DRAWDOWN'],
      limitsVersion: '',
      snapshotSeq: 42n,
      inputsHash: '',
      mode: 'testnet',
      runId: 'run-dt',
      bootId: 'boot-dt',
    });
    const { rows } = await pool.query<{
      intent_id: string;
      verdict: string;
      reasons: string[];
      mode: string;
    }>(
      `SELECT intent_id, verdict, reasons, mode FROM public.risk_decisions WHERE intent_id = 'dt-intent-1'`,
    );
    expect(rows[0]?.verdict).toBe('REJECTED');
    expect(rows[0]?.reasons).toEqual(['DAILY_LOSS', 'MAX_DRAWDOWN']);
    expect(rows[0]?.mode).toBe('testnet');
  });

  it('(i) signals row round-trips with exact money strings and outcome', async () => {
    const repo = new SignalRepository(db);
    await repo.insert({
      signalId: 'dt-sig-1',
      strategyId: 's',
      venue: 'binance',
      symbol: 'BTC/USDT',
      kind: 'ENTER_LONG',
      strength: '0.5',
      refPrice: '50000.25',
      basedOnSeq: 7n,
      eventTime: 1_700_000_000_000,
      ttlMs: 10_000,
      dedupeKey: 'dk-dt-1',
      reason: 'ema-cross',
      outcome: 'APPROVED',
      intentId: 'dt-intent-2',
      mode: 'paper',
      runId: 'run-dt',
      bootId: 'boot-dt',
    });
    const { rows } = await pool.query<{ ref_price: string; outcome: string; intent_id: string }>(
      `SELECT ref_price, outcome, intent_id FROM public.signals WHERE signal_id = 'dt-sig-1'`,
    );
    expect(rows[0]?.ref_price).toBe(pad18('50000.25'));
    expect(rows[0]?.outcome).toBe('APPROVED');
    expect(rows[0]?.intent_id).toBe('dt-intent-2');
  });

  // ── (i2) v3: reconciliations.venue — venue-scoped operational fact, one row per venue pass ──
  it('(i2) saveReconciliation stamps venue as a first-class column (not folded into discrepancies)', async () => {
    const store = new DrizzleExecutionStore(db, {
      mode: 'testnet',
      runId: 'run-recon-v3',
      bootId: 'boot-recon-v3',
    });
    const spotRow: ReconciliationRow = {
      ts: epochMs(1_800_080_000_000),
      venue: 'binance',
      mismatches: 0,
      halted: false,
      detail: 'clean',
    };
    const perpRow: ReconciliationRow = {
      ts: epochMs(1_800_080_100_000),
      venue: 'binanceusdm',
      mismatches: 2,
      halted: false,
      detail: 'balance drift',
    };
    await store.saveReconciliation(spotRow);
    await store.saveReconciliation(perpRow);

    const { rows } = await pool.query<{
      venue: string;
      result: string;
      discrepancies: { mismatches: number; detail: string; venue?: string };
      run_id: string;
    }>(
      `SELECT venue, result, discrepancies, run_id FROM public.reconciliations
       WHERE run_id = 'run-recon-v3' ORDER BY venue`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.venue).toBe('binance');
    expect(rows[0]!.result).toBe('CLEAN');
    // venue now rides on its own column — no longer duplicated inside discrepancies.
    expect(rows[0]!.discrepancies).toEqual({ mismatches: 0, detail: 'clean' });
    expect(rows[1]!.venue).toBe('binanceusdm');
    expect(rows[1]!.result).toBe('MISMATCH');
    expect(rows[1]!.discrepancies).toEqual({ mismatches: 2, detail: 'balance drift' });
  });

  it('(i2) reconciliations.venue is NOT NULL', async () => {
    await expect(
      pool.query(
        `INSERT INTO public.reconciliations
          (ts, duration_ms, open_orders_checked, trades_checked, balances_checked, discrepancies,
           result, mode, run_id, boot_id)
         VALUES (now(), 0, 0, 0, 0, '{}', 'CLEAN', 'paper', 'run-recon-null', 'boot-recon-null')`,
      ),
    ).rejects.toThrow(/null value|not-null/i);
  });

  // ── (g) Constraint smoke tests ────────────────────────────────────────────
  it('(g) duplicate client_order_id on order_intents is rejected', async () => {
    const row = `INSERT INTO public.order_intents
      (intent_id, client_order_id, strategy_id, venue, symbol, side, type,
       qty, time_in_force, reduce_only, ref_price, ref_seq,
       created_at, expires_at, source_dedupe_key, source_event_time,
       source_based_on_seq, source_strength, mode, run_id, boot_id)
     VALUES`;
    await pool.query(
      row +
        ` ('intent-dup-1','cbp-dup-test-00000000000000000001','s1','binance','BTC/USDT',
          'BUY','LIMIT','1.000000000000000000','GTC',false,
          '50000.000000000000000000',0,0,9999999,'dk-d1',0,0,'0.5','paper','r1','b1')`,
    );
    await expect(
      pool.query(
        row +
          ` ('intent-dup-2','cbp-dup-test-00000000000000000001','s2','binance','BTC/USDT',
            'BUY','LIMIT','1.000000000000000000','GTC',false,
            '50000.000000000000000000',0,0,9999999,'dk-d2',0,0,'0.5','paper','r1','b1')`,
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('(g) v3: order_intents.trigger_price round-trips an exact decimal string, and is null when absent', async () => {
    const repo = new IntentRepository(db);
    const base = {
      strategyId: 's',
      venue: 'binanceusdm',
      symbol: 'BTC/USDT:USDT',
      side: 'SELL' as const,
      type: 'STOP_MARKET' as const,
      qty: '1.000000000000000000',
      timeInForce: 'GTC' as const,
      reduceOnly: true,
      refPrice: '50000.000000000000000000',
      refSeq: 0n,
      createdAt: 0,
      expiresAt: 9_999_999,
      sourceDedupeKey: 'dk-trig',
      sourceEventTime: 0,
      sourceBasedOnSeq: 0n,
      sourceStrength: '0.5',
      mode: 'paper' as const,
      runId: 'run-trig',
      bootId: 'boot-trig',
    };
    await repo.insert({
      ...base,
      intentId: 'intent-trig-1',
      clientOrderId: 'cbp-trig-000000000000000000001',
      triggerPrice: '48500.123456789012345678',
    });
    await repo.insert({
      ...base,
      intentId: 'intent-trig-2',
      clientOrderId: 'cbp-trig-000000000000000000002',
      side: 'BUY',
      type: 'LIMIT',
    });

    const withTrigger = await repo.findById('intent-trig-1');
    const withoutTrigger = await repo.findById('intent-trig-2');
    expect(withTrigger!.triggerPrice).toBe(pad18('48500.123456789012345678'));
    expect(withoutTrigger!.triggerPrice).toBeNull();
  });

  it('(g) duplicate (order_id, dedupe_key) on order_events is rejected', async () => {
    // Reuse intent-oe-1 + its order row created in test (c).
    const insert = `INSERT INTO public.order_events
      (order_id, dedupe_key, event_type, payload, seq, mode, run_id, boot_id)
      VALUES ('intent-oe-1','dk-smoke','SUBMITTED','{}',2,'paper','r1','b1')`;
    await pool.query(insert);
    await expect(pool.query(insert)).rejects.toThrow(/unique|duplicate/i);
  });

  // ── (j) Agentic persistence — decision journal + playbook store ──────────
  // NOTE: these run in THIS file (not a separate test/db/*.spec.ts) deliberately — Vitest's
  // fileParallelism defaults to true, and a second file with its own DROP SCHEMA CASCADE +
  // migrate() in beforeAll would race this suite's identical reset. Reusing the already-migrated
  // `db`/`pool` here avoids that hazard entirely.
  it('(j) agent_decisions round-trips exact decimal strings; AgentDecisionJournalAdapter.recent() maps branded types oldest→newest', async () => {
    const repo = new AgentDecisionRepository(db);
    const plan = {
      entryOffsetBps: 10,
      stopLossPct: '0.02',
      takeProfitPct: '0.03',
      entryValidityBars: 2,
      maxHoldBars: 8,
    };
    const base = {
      strategyId: 'agentic-dt-1',
      symbol: 'BTC/USDT',
      venue: 'binance',
      triggerKind: 'candle' as const,
      basedOnSeq: 42n,
      model: 'claude-opus-5',
      action: 'open_long' as const,
      confidence: 0.82,
      rationale: 'trend + momentum confluence',
      refPrice: '50000.123456789012345678',
      close: '50000.123456789012345678',
      inputTokens: 512,
      outputTokens: 64,
      latencyMs: 850,
      playbookVersion: 1,
      inputPayload: '{"candles":[]}',
    };
    await repo.insert({
      ...base,
      eventTime: 1_700_000_500_000,
      promptHash: 'hash-dt-1',
      planJson: plan,
      consultId: 'consult-dt-1',
    });
    await repo.insert({ ...base, eventTime: 1_700_000_600_000, promptHash: 'hash-dt-2' });
    // Two rows sharing the same eventTime: the desc(id) tiebreak (id is the insertion-ordered PK)
    // must resolve them in insertion order, matching InMemoryAgentDecisionJournal's plain
    // append-order — not whatever order Postgres happens to return same-eventTime rows in.
    await repo.insert({ ...base, eventTime: 1_700_000_700_000, promptHash: 'hash-dt-3a' });
    await repo.insert({ ...base, eventTime: 1_700_000_700_000, promptHash: 'hash-dt-3b' });

    const adapter = new AgentDecisionJournalAdapter(db);
    const rows = await adapter.recent(500);
    const ours = rows.filter((r) => r.promptHash === 'hash-dt-1' || r.promptHash === 'hash-dt-2');
    expect(ours).toHaveLength(2);
    // oldest→newest
    expect(ours[0]!.promptHash).toBe('hash-dt-1');
    expect(ours[1]!.promptHash).toBe('hash-dt-2');
    expect(ours[0]!.refPrice).toBe(pad18('50000.123456789012345678'));
    expect(ours[0]!.strategyId).toBe('agentic-dt-1');
    expect(typeof ours[0]!.id).toBe('string');
    // plan_json (W1.3 follow-on): round-trips verbatim when carried, null when absent.
    expect(ours[0]!.plan).toEqual(plan);
    expect(ours[1]!.plan).toBeNull();
    // consult_id (Push II Phase 5 follow-on): round-trips verbatim when carried, null when absent.
    expect(ours[0]!.consultId).toBe('consult-dt-1');
    expect(ours[1]!.consultId).toBeNull();

    const tied = rows.filter((r) => r.promptHash === 'hash-dt-3a' || r.promptHash === 'hash-dt-3b');
    expect(tied.map((r) => r.promptHash)).toEqual(['hash-dt-3a', 'hash-dt-3b']);
  });

  // ── (j) A3: journal-side v2 widening (action union + plan_json AgentDirectives shape) ────────
  it('(j) A3: an open_short row round-trips a full AgentDirectives plan_json (incl. thesis) field-for-field', async () => {
    const repo = new AgentDecisionRepository(db);
    const directives = {
      sizeFraction: '0.12',
      stopLossPct: '0.02',
      takeProfitPct: '0.05',
      partialCloseFraction: '0.5',
      entryOffsetBps: -25,
      entryValidityBars: 4,
      maxHoldBars: 288,
      entryStyle: 'taker' as const,
      direction: 'short' as const,
      thesis: 'BTC funding flip + basis compression; targeting mean reversion on the 4h.',
    };
    await repo.insert({
      strategyId: 'agentic-a3-1',
      symbol: 'BTC/USDT',
      venue: 'binanceusdm',
      triggerKind: 'candle',
      basedOnSeq: 1n,
      eventTime: 1_800_050_000_000,
      model: 'claude-sonnet-5',
      action: 'open_short',
      confidence: null,
      rationale: 'funding rich, basis compressing',
      refPrice: '65000.5',
      close: '65000.5',
      inputTokens: 400,
      outputTokens: 80,
      latencyMs: 900,
      playbookVersion: 3,
      promptHash: 'a3-open-short-1',
      inputPayload: '{"candles":[]}',
      planJson: directives,
    });

    const adapter = new AgentDecisionJournalAdapter(db);
    const rows = await adapter.recent(500);
    const row = rows.find((r) => r.promptHash === 'a3-open-short-1');
    expect(row).toBeDefined();
    expect(row!.action).toBe('open_short');
    expect(row!.plan).toEqual(directives);
  });

  it('(j) A3: AgentDecisionJournalAdapter.record fails OPEN on an out-of-union action — dropped and logged, never thrown', async () => {
    const adapter = new AgentDecisionJournalAdapter(db);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const badPromptHash = 'a3-guard-out-of-union';
    expect(() =>
      adapter.record({
        strategyId: strategyId('agentic-a3-guard'),
        symbol: symbolId('BTC/USDT'),
        venue: venueId('binance'),
        triggerKind: 'candle',
        basedOnSeq: 1n,
        eventTime: epochMs(1_800_060_000_000),
        model: 'claude-sonnet-5',
        // Simulates the anthropic-agent-client.ts breadcrumb's concern: a real runtime value the TS
        // union does not declare, smuggled past a narrower cast upstream (e.g. legacy 'short').
        action: 'short' as unknown as AgentDecisionEntry['action'],
        confidence: null,
        rationale: 'r',
        refPrice: null,
        close: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        playbookVersion: null,
        promptHash: badPromptHash,
        inputPayload: null,
      }),
    ).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('agentic-a3-guard'));
    const { rows } = await pool.query(
      `SELECT 1 FROM public.agent_decisions WHERE prompt_hash = $1`,
      [badPromptHash],
    );
    expect(rows).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('(j) v3: AgentDecisionJournalAdapter.record drops the legacy "long"/"flat" literals — a fresh v3 DB never carries a legacy-contract row', async () => {
    const adapter = new AgentDecisionJournalAdapter(db);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const base = {
      strategyId: strategyId('agentic-v3-legacy-guard'),
      symbol: symbolId('BTC/USDT'),
      venue: venueId('binance'),
      triggerKind: 'candle' as const,
      basedOnSeq: 1n,
      model: 'claude-sonnet-5',
      confidence: null,
      rationale: 'r',
      refPrice: null,
      close: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      playbookVersion: null,
      inputPayload: null,
    };
    // The port union no longer admits legacy 'long'/'flat' statically (v3 narrowing landed), but a
    // stale caller or replayed v2 recording could still hand them in at runtime — the journal guard
    // must drop both. The unsafe casts below are the point of the test: out-of-union input.
    adapter.record({
      ...base,
      eventTime: epochMs(1_800_070_000_000),
      action: 'long' as unknown as AgentDecisionEntry['action'],
      promptHash: 'v3-legacy-long',
    });
    adapter.record({
      ...base,
      eventTime: epochMs(1_800_070_100_000),
      action: 'flat' as unknown as AgentDecisionEntry['action'],
      promptHash: 'v3-legacy-flat',
    });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('agentic-v3-legacy-guard'));
    const { rows } = await pool.query(
      `SELECT prompt_hash FROM public.agent_decisions WHERE prompt_hash IN ($1, $2)`,
      ['v3-legacy-long', 'v3-legacy-flat'],
    );
    expect(rows).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('(j) countVersionEntryStats counts lifetime real-LLM decides/entries for ONE version (abstention-lapse evidence base)', async () => {
    const repo = new AgentDecisionRepository(db);
    const base = {
      strategyId: 'agentic-ves-1',
      symbol: 'BTC/USDT',
      venue: 'binance',
      triggerKind: 'candle' as const,
      basedOnSeq: 1n,
      confidence: 0.5,
      rationale: 'r',
      refPrice: null,
      close: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      inputPayload: null,
    };
    // Version 91: the single entry is deliberately the OLDEST row — a recent()-window read can
    // miss it (the 2026-07-17 v2 false-abstention); the lifetime count must not. A non-claude
    // replay row on the same version is excluded from the decide count entirely.
    await repo.insert({
      ...base,
      model: 'claude-sonnet-5',
      action: 'open_long',
      playbookVersion: 91,
      eventTime: 10,
      promptHash: 'ves-a',
    });
    await repo.insert({
      ...base,
      model: 'claude-sonnet-5',
      action: 'hold',
      playbookVersion: 91,
      eventTime: 11,
      promptHash: 'ves-b',
    });
    await repo.insert({
      ...base,
      model: 'replay-sim',
      action: 'open_long',
      playbookVersion: 91,
      eventTime: 12,
      promptHash: 'ves-c',
    });
    await repo.insert({
      ...base,
      model: 'claude-sonnet-5',
      action: 'hold',
      playbookVersion: 92,
      eventTime: 13,
      promptHash: 'ves-d',
    });
    // NULL playbook_version rows (prescreen/plan-executor bookkeeping) never count for any version.
    await repo.insert({
      ...base,
      model: 'claude-sonnet-5',
      action: 'open_long',
      playbookVersion: null,
      eventTime: 14,
      promptHash: 'ves-e',
    });

    expect(await repo.countVersionEntryStats(91)).toEqual({ decides: 2, entries: 1 });
    expect(await repo.countVersionEntryStats(92)).toEqual({ decides: 1, entries: 0 });
    expect(await repo.countVersionEntryStats(93)).toEqual({ decides: 0, entries: 0 });

    const adapter = new AgentDecisionJournalAdapter(db);
    expect(await adapter.versionEntryStats(92)).toEqual({ decides: 1, entries: 0 });
  });

  it('(j) P4: countVersionEntryStats counts v2 open_long/open_short as entries (false-abstention-lapse guard)', async () => {
    const repo = new AgentDecisionRepository(db);
    const base = {
      strategyId: 'agentic-ves-v2',
      symbol: 'BTC/USDT',
      venue: 'binanceusdm',
      triggerKind: 'candle' as const,
      basedOnSeq: 1n,
      confidence: null,
      rationale: 'r',
      refPrice: null,
      close: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      inputPayload: null,
      playbookVersion: 94,
      model: 'claude-sonnet-5',
    };
    await repo.insert({ ...base, action: 'open_long', eventTime: 20, promptHash: 'v2-a' });
    await repo.insert({ ...base, action: 'open_short', eventTime: 21, promptHash: 'v2-b' });
    await repo.insert({ ...base, action: 'close', eventTime: 22, promptHash: 'v2-c' });
    await repo.insert({ ...base, action: 'adjust', eventTime: 23, promptHash: 'v2-d' });
    await repo.insert({ ...base, action: 'hold', eventTime: 24, promptHash: 'v2-e' });

    expect(await repo.countVersionEntryStats(94)).toEqual({ decides: 5, entries: 2 });
  });

  it('(j) P4: latestThesis returns the newest non-null plan_json.thesis for a strategyId, skipping null-thesis rows', async () => {
    const repo = new AgentDecisionRepository(db);
    const base = {
      symbol: 'BTC/USDT',
      venue: 'binanceusdm',
      triggerKind: 'candle' as const,
      basedOnSeq: 1n,
      model: 'claude-sonnet-5',
      confidence: null,
      rationale: 'r',
      refPrice: null,
      close: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      playbookVersion: 5,
      inputPayload: null,
    };
    const directives = (thesis: string) => ({
      sizeFraction: '0.1',
      stopLossPct: '0.02',
      takeProfitPct: '0.05',
      entryOffsetBps: 0,
      entryValidityBars: 4,
      maxHoldBars: 288,
      entryStyle: 'taker' as const,
      thesis,
    });
    // No thesis at all before any row — null.
    expect(await repo.latestThesis('agentic-thesis-1')).toBeNull();

    await repo.insert({
      ...base,
      strategyId: 'agentic-thesis-1',
      action: 'open_long',
      eventTime: 1,
      promptHash: 'thesis-a',
      planJson: directives('first thesis'),
    });
    // A later row with NO thesis (plain hold, no plan) must not blank out the latest reading.
    await repo.insert({
      ...base,
      strategyId: 'agentic-thesis-1',
      action: 'hold',
      eventTime: 2,
      promptHash: 'thesis-b',
      planJson: null,
    });
    await repo.insert({
      ...base,
      strategyId: 'agentic-thesis-1',
      action: 'adjust',
      eventTime: 3,
      promptHash: 'thesis-c',
      planJson: directives('second, newer thesis'),
    });
    // A different strategy's thesis must never leak into this strategy's reading.
    await repo.insert({
      ...base,
      strategyId: 'agentic-thesis-2',
      action: 'open_long',
      eventTime: 4,
      promptHash: 'thesis-other',
      planJson: directives('unrelated strategy thesis'),
    });

    expect(await repo.latestThesis('agentic-thesis-1')).toBe('second, newer thesis');
    expect(await repo.latestThesis('agentic-thesis-2')).toBe('unrelated strategy thesis');
    expect(await repo.latestThesis('agentic-thesis-nonexistent')).toBeNull();
  });

  it('(j) recent(limit, strategyId) scopes the window to one instance (P7)', async () => {
    const repo = new AgentDecisionRepository(db);
    const base = {
      symbol: 'BTC/USDT',
      venue: 'binance',
      triggerKind: 'candle' as const,
      basedOnSeq: 1n,
      model: 'm',
      action: 'hold' as const,
      confidence: 0.5,
      rationale: 'r',
      refPrice: null,
      close: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      playbookVersion: null,
      inputPayload: null,
    };
    await repo.insert({ ...base, strategyId: 'agentic-p7-1', eventTime: 1, promptHash: 'p7-a' });
    await repo.insert({ ...base, strategyId: 'agentic-p7-2', eventTime: 2, promptHash: 'p7-b' });
    await repo.insert({ ...base, strategyId: 'agentic-p7-1', eventTime: 3, promptHash: 'p7-c' });

    const adapter = new AgentDecisionJournalAdapter(db);
    const scoped = await adapter.recent(500, 'agentic-p7-1');
    expect(scoped.every((r) => r.strategyId === 'agentic-p7-1')).toBe(true);
    expect(scoped.map((r) => r.promptHash)).toEqual(['p7-a', 'p7-c']);
    // The limit applies within the scope — the other strategy's rows never consume it.
    const limited = await adapter.recent(1, 'agentic-p7-1');
    expect(limited.map((r) => r.promptHash)).toEqual(['p7-c']);
  });

  it('(j) selectRecentVersioned: versioned rows only, sinceMs-bounded, cap keeps the newest (attribution read)', async () => {
    const repo = new AgentDecisionRepository(db);
    const base = {
      strategyId: 'agentic-rv-1',
      symbol: 'BTC/USDT',
      venue: 'binance',
      triggerKind: 'candle' as const,
      basedOnSeq: 1n,
      model: 'm',
      action: 'hold' as const,
      confidence: 0.5,
      rationale: 'r',
      refPrice: null,
      close: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      inputPayload: null,
    };
    // eventTimes above every other row this suite inserts (the A3 fixtures reach
    // 1_800_050_000_000 — stay above that), so the cap assertions below are deterministic
    // against the shared table.
    await repo.insert({
      ...base,
      eventTime: 1_800_100_000_100,
      playbookVersion: 7,
      promptHash: 'rv-a',
    });
    await repo.insert({
      ...base,
      eventTime: 1_800_100_000_200,
      playbookVersion: null,
      promptHash: 'rv-b',
    });
    await repo.insert({
      ...base,
      eventTime: 1_800_100_000_300,
      playbookVersion: 8,
      promptHash: 'rv-c',
    });
    await repo.insert({
      ...base,
      eventTime: 1_800_100_000_400,
      playbookVersion: 9,
      promptHash: 'rv-d',
    });
    // Two versioned rows sharing an eventTime: the desc(id) tiebreak must resolve them in
    // insertion order, matching selectRecent (attributeVersion's backwards scan depends on it).
    await repo.insert({
      ...base,
      eventTime: 1_800_100_000_500,
      playbookVersion: 10,
      promptHash: 'rv-e',
    });
    await repo.insert({
      ...base,
      eventTime: 1_800_100_000_500,
      playbookVersion: 11,
      promptHash: 'rv-f',
    });

    const adapter = new AgentDecisionJournalAdapter(db);
    // NULL-version rows are excluded outright — they must not consume the attribution window.
    const ours = (await adapter.recentVersioned(500)).filter(
      (r) => r.strategyId === 'agentic-rv-1',
    );
    expect(ours.map((r) => r.promptHash)).toEqual(['rv-a', 'rv-c', 'rv-d', 'rv-e', 'rv-f']);
    // Over-cap keeps the NEWEST versioned rows table-wide, returned oldest→newest — including the
    // same-eventTime pair in insertion order.
    const capped = await adapter.recentVersioned(2);
    expect(capped.map((r) => r.promptHash)).toEqual(['rv-e', 'rv-f']);
    // sinceMs bounds at-or-after the instant.
    const since = await adapter.recentVersioned(500, 1_800_100_000_300);
    expect(since.map((r) => r.promptHash)).toEqual(['rv-c', 'rv-d', 'rv-e', 'rv-f']);
  });

  it('(j) playbook store: current() lazily seeds the row on first call when absent', async () => {
    const seed = { version: 1001, content: 'seed-1001' };
    const store = new PlaybookStoreAdapter(db, seed);
    await expect(store.current()).resolves.toEqual({ ...seed, source: 'seed' });

    // A second adapter instance against the same seed version resolves the persisted row
    // rather than re-attempting (and racing) the insert.
    const store2 = new PlaybookStoreAdapter(db, seed);
    await expect(store2.current()).resolves.toEqual({ ...seed, source: 'seed' });
  });

  it('(j) playbook store: append() assigns monotonically increasing versions', async () => {
    const seed = { version: 2001, content: 'seed-2001' };
    const store = new PlaybookStoreAdapter(db, seed);
    await store.current(); // materializes the seed row first
    const a = await store.append('draft a', 'reflection', seed.version);
    const b = await store.append('draft b', 'reflection', seed.version);
    expect(b.version).toBe(a.version + 1);
  });

  it('(j) playbook store: promotion activates its parentVersion target, pin overrides it, and the partial unique index allows only one promotion per UTC day', async () => {
    const seed = { version: 3001, content: 'seed-3001' };
    const seedStore = new PlaybookStoreAdapter(db, seed);
    await seedStore.current(); // materializes the seed row
    const draft = await seedStore.append('reflection draft 3001', 'reflection', seed.version);
    await seedStore.append('promotion note', 'promotion', draft.version);

    // Promotion resolution: a FRESH adapter instance (boot-resolution is per-instance) activates
    // the promoted draft's content, not the promotion row's own content.
    const freshStore = new PlaybookStoreAdapter(db, seed);
    await expect(freshStore.current()).resolves.toEqual({
      version: draft.version,
      content: 'reflection draft 3001',
      source: 'promotion',
    });

    // Pin overrides promotion resolution when the pinned row exists.
    const pinnedStore = new PlaybookStoreAdapter(db, seed, seed.version);
    await expect(pinnedStore.current()).resolves.toEqual({ ...seed, source: 'pin' });

    // A second promotion the same UTC day is rejected by the partial unique index.
    await expect(seedStore.append('second promotion', 'promotion', seed.version)).rejects.toSatisfy(
      isUniqueViolation,
    );
  });

  it('(j) playbook store: a promotion dated the next UTC day is allowed even though a same-day second promotion is blocked', async () => {
    const seed = { version: 4001, content: 'seed-4001' };
    const store = new PlaybookStoreAdapter(db, seed);
    await store.current(); // materializes the seed row

    // The promotion-per-UTC-day partial unique index is table-wide, not scoped per seed/version
    // (see agent_playbook_versions_promotion_per_day_uidx in trading.schema.ts), and the preceding
    // test in this file already committed a same-day promotion row. Clear it so this test's own
    // day-1 insert below starts from zero same-day promotion rows (source='promotion' is an
    // insert-only-by-convention row, not append-only-hardened like audit_log/order_events, so a
    // test-scoped DELETE here is legal).
    await pool.query(`DELETE FROM public.agent_playbook_versions WHERE source = 'promotion'`);

    const day1 = await store.append('promotion note day 1', 'promotion', seed.version);

    // Same UTC day: rejected (already covered generally above; re-asserted here for locality
    // against this test's own seed range).
    await expect(
      store.append('promotion note day 1b', 'promotion', seed.version),
    ).rejects.toSatisfy(isUniqueViolation);

    // append() always stamps created_at via now(); simulating "the next day" requires an explicit
    // created_at, so this row is inserted directly rather than through the store.
    const result = await pool.query(
      `INSERT INTO public.agent_playbook_versions (version, content, source, parent_version, created_at)
       VALUES ($1, $2, 'promotion', $3, now() + interval '1 day')`,
      [day1.version + 1, 'promotion note day 2', seed.version],
    );
    expect(result.rowCount).toBe(1);
  });

  it('(j) llm_usage row insert round-trips exact ints, kind/mode/strategy_id, and created_at is populated', async () => {
    const repo = new LlmUsageRepository(db);
    await repo.insert({
      kind: 'reflection',
      model: 'claude-opus-5',
      mode: 'paper',
      strategyId: 'agentic-dt-1',
      inputTokens: 512,
      outputTokens: 64,
    });

    const rows = await pool.query<{
      kind: string;
      model: string;
      mode: string;
      strategy_id: string | null;
      input_tokens: number;
      output_tokens: number;
      created_at: Date;
    }>(
      `SELECT kind, model, mode, strategy_id, input_tokens, output_tokens, created_at
       FROM public.llm_usage WHERE model = $1`,
      ['claude-opus-5'],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.kind).toBe('reflection');
    expect(row.mode).toBe('paper');
    expect(row.strategy_id).toBe('agentic-dt-1');
    expect(row.input_tokens).toBe(512);
    expect(row.output_tokens).toBe(64);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it('(j) llm_usage: strategy_id is nullable', async () => {
    const repo = new LlmUsageRepository(db);
    await repo.insert({
      kind: 'reflection',
      model: 'claude-opus-5-nullable-sid',
      mode: 'testnet',
      strategyId: null,
      inputTokens: 1,
      outputTokens: 2,
    });

    const rows = await pool.query<{ strategy_id: string | null }>(
      `SELECT strategy_id FROM public.llm_usage WHERE model = $1`,
      ['claude-opus-5-nullable-sid'],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.strategy_id).toBeNull();
  });

  it('(j) LlmUsageSinkAdapter.record() stamps the constructor-bound mode and swallows insert errors (fire-and-forget)', async () => {
    const adapter = new LlmUsageSinkAdapter(db, 'live');
    adapter.record({
      kind: 'reflection',
      model: 'claude-opus-5-adapter',
      strategyId: strategyId('agentic-dt-2'),
      inputTokens: 7,
      outputTokens: 3,
    });
    // record() is sync fire-and-forget; give the detached insert a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await pool.query<{ mode: string; strategy_id: string | null }>(
      `SELECT mode, strategy_id FROM public.llm_usage WHERE model = $1`,
      ['claude-opus-5-adapter'],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.mode).toBe('live');
    expect(rows.rows[0]!.strategy_id).toBe('agentic-dt-2');
  });

  // ── (k) PromotionStatsRepository — earned-live evidence queries ───────────
  // Side/strategy live on order_intents, not fills — the section's own intent seeder takes a side
  // (the shared seedIntent above hardcodes BUY).
  async function seedIntentWithSide(
    intentId: string,
    clientOrderId: string,
    side: 'BUY' | 'SELL',
    mode: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO public.order_intents
        (intent_id, client_order_id, strategy_id, venue, symbol, side, type, qty, time_in_force, reduce_only,
         ref_price, ref_seq, created_at, expires_at, source_dedupe_key, source_event_time, source_based_on_seq,
         source_strength, mode, run_id, boot_id)
       VALUES ($1,$2,'agentic-k','binance','BTC/USDT',$3,'LIMIT','1.000000000000000000','GTC',false,
         '50000.000000000000000000',0,0,9999999,$4,0,0,'0.5',$5,'run-k','boot-k')`,
      [intentId, clientOrderId, side, `dk-${intentId}`, mode],
    );
  }

  async function seedFill(
    venueTradeId: string,
    intentId: string | null,
    ts: number,
    mode: string,
    fee: { amount: string; ccy: string } | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO public.fills
        (venue, symbol, venue_trade_id, intent_id, client_order_id, price, qty, fee_ccy, fee_amount,
         liquidity, venue_timestamp, source, mode, run_id, boot_id)
       VALUES ('binance','BTC/USDT',$1,$2,'cb-k','50000.000000000000000000','0.001000000000000000',
         $3,$4,'taker',$5,'rest_reconcile',$6,'run-k','boot-k')`,
      [venueTradeId, intentId, fee?.ccy ?? null, fee?.amount ?? null, ts, mode],
    );
  }

  it('(k) fillsForMode: mode filter, executedAt→fillId ordering, LEFT-JOIN nulls for unresolved intents', async () => {
    const repo = new PromotionStatsRepository(db);
    await seedIntentWithSide('int-k-buy', 'cb-k-buy', 'BUY', 'testnet');
    await seedIntentWithSide('int-k-sell', 'cb-k-sell', 'SELL', 'testnet');
    await seedIntentWithSide('int-k-paper', 'cb-k-paper', 'BUY', 'paper');
    await seedFill('vt-k-2', 'int-k-buy', 2_000, 'testnet', {
      amount: '0.010000000000000000',
      ccy: 'USDT',
    });
    await seedFill('vt-k-1', 'int-k-sell', 1_000, 'testnet', null);
    await seedFill('vt-k-3', null, 3_000, 'testnet', null);
    await seedFill('vt-k-0', 'int-k-paper', 500, 'paper', null);

    const rows = await repo.fillsForMode('testnet');
    const ours = rows.filter(
      (r) => r.symbol === 'BTC/USDT' && [1_000, 2_000, 3_000].includes(r.executedAt),
    );
    expect(ours.map((r) => r.executedAt)).toEqual([1_000, 2_000, 3_000]);
    expect(ours[0]!.side).toBe('SELL');
    expect(ours[0]!.strategyId).toBe('agentic-k');
    expect(ours[1]!.side).toBe('BUY');
    expect(ours[1]!.fee).toBe(pad18('0.01'));
    expect(ours[1]!.feeAsset).toBe('USDT');
    expect(ours[1]!.qty).toBe(pad18('0.001'));
    expect(ours[2]!.strategyId).toBeNull();
    expect(ours[2]!.side).toBeNull();
    // paper-mode fill excluded by the WHERE mode filter
    expect(rows.some((r) => r.executedAt === 500)).toBe(false);
  });

  it('(k) llmTokenTotals: decide from agent_decisions (nulls as 0), reflection-only rows from llm_usage', async () => {
    const repo = new PromotionStatsRepository(db);
    // Earlier (j) sections already landed agent_decisions/llm_usage rows in this suite run, so the
    // assertions are DELTAS around this test's own inserts, not absolute totals.
    const before = await repo.llmTokenTotals();
    await pool.query(
      `INSERT INTO public.agent_decisions
        (strategy_id, symbol, venue, trigger_kind, based_on_seq, event_time, model, action, rationale,
         input_tokens, output_tokens, prompt_hash)
       VALUES
        ('agentic-k','BTC/USDT','binance','candle',0,1,'m','hold','r',100,10,'hash-k-1'),
        ('agentic-k','BTC/USDT','binance','candle',0,2,'m','hold','r',200,20,'hash-k-2'),
        ('agentic-k','BTC/USDT','binance','candle',0,3,'m','error','r',NULL,NULL,'hash-k-3')`,
    );
    await pool.query(
      `INSERT INTO public.llm_usage (kind, model, mode, strategy_id, input_tokens, output_tokens)
       VALUES ('reflection','m','testnet','agentic-k',50,5),
              ('decide','m','testnet','agentic-k',999,999)`,
    );

    const totals = await repo.llmTokenTotals();
    // Per-model totals (W4+W13): both call sites here use model='m', so they merge into one entry.
    // decide side ignores the llm_usage 'decide' row (would double-count agent_decisions) and
    // treats NULL token columns as 0. Deltas: input 300 (decide) + 50 (reflection) = 350;
    // output 30 + 5 = 35.
    const sumIn = (t: typeof totals) => t.perModel.reduce((s, m) => s + m.inputTokens, 0);
    const sumOut = (t: typeof totals) => t.perModel.reduce((s, m) => s + m.outputTokens, 0);
    expect(sumIn(totals) - sumIn(before)).toBe(350);
    expect(sumOut(totals) - sumOut(before)).toBe(35);
  });

  // R1 exclusion (SQL-level): a synthetic replay-<runId> decide row must never reach llmTokenTotals
  // (epoch cost) or the lane-wide recent() (mint-floor corpus), and must reach recentSynthetic only.
  it('(k) R1: replay-<runId> agent_decisions rows are excluded from llmTokenTotals + lane-wide recent(), surfaced only by recentSynthetic', async () => {
    const promo = new PromotionStatsRepository(db);
    const repo = new AgentDecisionRepository(db);
    const adapter = new AgentDecisionJournalAdapter(db);

    const beforeTotals = await promo.llmTokenTotals();
    const sumIn = (t: typeof beforeTotals) => t.perModel.reduce((s, m) => s + m.inputTokens, 0);

    // One real lane row and one synthetic replay row, both with big token counts so a leak is loud.
    await pool.query(
      `INSERT INTO public.agent_decisions
        (strategy_id, symbol, venue, trigger_kind, based_on_seq, event_time, model, action, rationale,
         input_tokens, output_tokens, prompt_hash)
       VALUES
        ('agentic-r1','BTC/USDT','binance','candle',0,900001,'claude-x','hold','real',1000,100,'hash-r1-real'),
        ('replay-run9','BTC/USDT','binance','candle',0,900002,'claude-x','open_long','syn',7000,700,'hash-r1-syn')`,
    );

    // llmTokenTotals delta counts ONLY the real row (1000), never the replay row (7000).
    const afterTotals = await promo.llmTokenTotals();
    expect(sumIn(afterTotals) - sumIn(beforeTotals)).toBe(1000);

    // Lane-wide recent() (mint-floor corpus) never returns the replay row.
    const laneWide = await repo.selectRecent(500);
    expect(laneWide.some((r) => r.promptHash === 'hash-r1-real')).toBe(true);
    expect(laneWide.some((r) => r.promptHash === 'hash-r1-syn')).toBe(false);

    // recentSynthetic returns the replay row and only replay rows.
    const synthetic = await adapter.recentSynthetic(500);
    expect(synthetic.some((r) => r.promptHash === 'hash-r1-syn')).toBe(true);
    expect(synthetic.every((r) => r.strategyId.startsWith('replay-'))).toBe(true);
  });

  it('(k) fillsForMode carries the intent refPrice (null on an unresolved join) for slippage evidence', async () => {
    const repo = new PromotionStatsRepository(db);
    await seedIntentWithSide('int-k-ref', 'cb-k-ref', 'BUY', 'testnet');
    await seedFill('vt-k-ref', 'int-k-ref', 4_000, 'testnet', null);
    await seedFill('vt-k-noref', null, 5_000, 'testnet', null);

    const rows = await repo.fillsForMode('testnet');
    const joined = rows.find((r) => r.executedAt === 4_000);
    const orphan = rows.find((r) => r.executedAt === 5_000);
    expect(joined!.refPrice).toBe(pad18('50000')); // order_intents.ref_price via the LEFT JOIN
    expect(orphan!.refPrice).toBeNull();
  });

  it('(k) latestReflectionAt: null before any reflection row, newest created_at after', async () => {
    const repo = new PromotionStatsRepository(db);
    // The (k) llmTokenTotals test above may already have inserted a reflection row in this suite
    // run — take a before-reading and only assert monotonic movement plus the null→value contract
    // against a fresh, strictly newer row.
    const before = await repo.latestReflectionAt();
    await pool.query(
      `INSERT INTO public.llm_usage (kind, model, mode, strategy_id, input_tokens, output_tokens, created_at)
       VALUES ('reflection','m','testnet','agentic-k',1,1, now() + interval '1 hour')`,
    );
    const after = await repo.latestReflectionAt();
    expect(after).not.toBeNull();
    if (before !== null) expect(after!).toBeGreaterThan(before);
    // decide-kind rows never move the marker
    await pool.query(
      `INSERT INTO public.llm_usage (kind, model, mode, strategy_id, input_tokens, output_tokens, created_at)
       VALUES ('decide','m','testnet','agentic-k',1,1, now() + interval '2 hour')`,
    );
    expect(await repo.latestReflectionAt()).toBe(after);
  });
});
