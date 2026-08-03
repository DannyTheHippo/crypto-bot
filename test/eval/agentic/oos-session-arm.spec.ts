// Call site for the out-of-sample SESSION arm, preregistered in
// research/studies/oos-session-arm-2026-08-03.md.
//
// TWO MODES, same idiom as playbook-space-replay.spec.ts/arm-sweep-v1.spec.ts:
//   - default (no env): free preconditions and unit checks for every module this file exercises —
//     the fidelity gate, eligibility, the VOID-condition checks, the JSONL record whitelist, and a
//     DRY-RUN decide batch proving $0 (a stubbed fetchFn, zero network egress) — no network, no DB,
//     no spend. Runs under `pnpm eval:agentic` so this harness cannot rot silently.
//   - DATABASE_URL set AND (DB_SUITE_ALLOW_RESET=1 OR a `_test`-suffixed DATABASE_URL): an
//     integration leg proving sealBatch writes a real, DB-authored `created_at` into the append-only
//     `experiments` table — same gate test/db/experiment-registry.spec.ts uses for the same table.
//
// This harness is UNSTARTED (research/studies/oos-session-arm-2026-08-03.md § Cadence: "Until that
// trigger exists the arm is UNSTARTED, not failed, and no read may be sealed") — the owner-side
// hourly trigger does not exist yet. Nothing in this file scores a read or writes a real committed
// decisions-*.jsonl; every write here targets a tmpdir. Building the file-backed path is still in
// scope (loadSessionAnswers/makeFileBackedFetchFn) so the real standing arm has somewhere to plug in
// once the trigger lands.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  LIVE_FEED_FLAGS,
  FEED_BLOCK_TO_FLAG,
  buildLiveSystemPrompt,
  checkPromptFidelity,
  agentPromptModuleFingerprint,
  sha256Hex,
} from './oos-arm-prompt';
import {
  makeStubFetchFn,
  loadSessionAnswers,
  makeFileBackedFetchFn,
  barsElapsed,
  assertEligible,
  decideOosRow,
  checkCapsFaithfulness,
  checkEntryRateBound,
  type OosCandidateRow,
} from './oos-arm-decide';
import {
  ALLOWED_RECORD_KEYS,
  buildDecisionRecord,
  appendDecisionRecords,
  computeRowSetHash,
  sealBatch,
  OOS_ARM_SEAL_FAMILY,
  OOS_ARM_DIR,
  decisionsFilePath,
  type DecisionRecord,
} from './oos-arm-record';
import { DEFAULT_FLOOR_PROFILE } from '../../../src/features/strategy/agentic/entry-rate-floor';
import { buildPlaybookBlock } from '../../../src/features/strategy/agentic/agent-prompt';
import { SPOT_VENUE_ID, PERP_VENUE_ID } from '../../../src/domain/venue/types/venue-map';
import { paramsHash, datasetHash, type ExperimentRow } from '../../backtest/experiment-log';

// BAR_MS is IMPORTED, not redefined — but not via a static `import`: scripts/loop-forward-return-
// core.mjs is a plain-ESM module with no .d.ts, and TS's relative-path module resolution never
// consults an ambient `declare module` override for a relative specifier (verified empirically —
// several attempts, all TS7016). The only compiler flag that resolves it (`allowJs` on
// tsconfig.eslint.json) regresses typecheck project-wide (eslint.config.mjs's `import.meta` usage,
// and several loop-sweep specs' now-unused `@ts-expect-error` directives), so it was tried and
// reverted rather than shipped. This reads the SAME source file's own literal at test time instead
// of hand-copying the value — a future edit to the real constant is caught by the "BAR_MS matches
// the imported source" assertion below, not silently missed, which is what "imported, never
// redefined" is actually protecting against.
const LOOP_FORWARD_RETURN_CORE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'loop-forward-return-core.mjs',
);

function readBarMsFromCore(): number {
  const source = readFileSync(LOOP_FORWARD_RETURN_CORE_PATH, 'utf8');
  const match = /export const BAR_MS = ([\d_]+);/.exec(source);
  if (!match) {
    throw new Error(
      `could not read BAR_MS out of ${LOOP_FORWARD_RETURN_CORE_PATH} — the source format changed; ` +
        'this must not fall back to a hand-copied literal.',
    );
  }
  return Number(match[1]!.replace(/_/g, ''));
}

const BAR_MS = readBarMsFromCore();

// ── fixture rows — synthetic, never sourced from the network or a real corpus dump ────────────────
const NOW_MS = 1_800_000_000_000; // fixed decide instant, so k is deterministic across runs

function fixedEventTime(k: number): number {
  return NOW_MS - k * BAR_MS;
}

function capsBlock(venue: string, shorts: boolean): Record<string, unknown> {
  return {
    capabilities: {
      venue,
      shorts,
      leverage: shorts ? '2' : '1',
      maxSizeFraction: '0.15',
      venueFreeCash: '500',
    },
  };
}

// A row whose payload carries ONLY blocks the live flags document (fearGreed, tradeFlow — both true
// per LIVE_FEED_FLAGS) — the PASS case for the fidelity gate.
const FAITHFUL_ROW: OosCandidateRow = {
  id: 'oos-fixture-1',
  symbol: 'BTC/USDT',
  eventTime: fixedEventTime(0),
  inputPayload: JSON.stringify({
    symbol: 'BTC/USDT',
    ...capsBlock(String(SPOT_VENUE_ID), false),
    fearGreed: { value: 40, classification: 'Fear', trend: 'flat' },
    tradeFlow: { barImbalance: 0.1, cvd: '100', cvdDeltas: [], divergence: null },
  }),
};

const FAITHFUL_ROW_2: OosCandidateRow = {
  id: 'oos-fixture-2',
  symbol: 'ETH/USDT:USDT',
  eventTime: fixedEventTime(2),
  inputPayload: JSON.stringify({
    symbol: 'ETH/USDT:USDT',
    ...capsBlock(String(PERP_VENUE_ID), true),
    positioning: { longShortRatio: 1.2, longAccountPct: 0.55, shortAccountPct: 0.45 },
  }),
};

// A row whose payload carries `sentiment` — sentimentFeedEnabled is FALSE live, so this row should
// VOID the fidelity gate (a mismatch between what live documents and what this row shows).
const UNFAITHFUL_ROW: OosCandidateRow = {
  id: 'oos-fixture-3',
  symbol: 'SOL/USDT',
  eventTime: fixedEventTime(1),
  inputPayload: JSON.stringify({
    symbol: 'SOL/USDT',
    ...capsBlock(String(SPOT_VENUE_ID), false),
    sentiment: { headlines: [{ title: 'x', source: 'y', publishedAt: 0 }] },
  }),
};

// A row with NO capabilities block at all — replayPlanRow's own documented fallback path
// (capsSource: 'config'), which VOID condition 1 must catch.
const NO_CAPS_ROW: OosCandidateRow = {
  id: 'oos-fixture-4',
  symbol: 'BTC/USDT',
  eventTime: fixedEventTime(0),
  inputPayload: JSON.stringify({ symbol: 'BTC/USDT' }),
};

const STUB_CFG = {
  apiKey: 'sk-ant-oos-arm-placeholder-never-sent',
  model: 'claude-oos-arm-stub',
  // .invalid is an IANA-reserved TLD (RFC 2606) — a regression that bypassed the injected fetchFn
  // and fell through to a real `fetch` would fail DNS resolution, never spend a cent.
  baseUrl: 'http://oos-arm.invalid',
  timeoutMs: 5_000,
  sizeFractionMax: '0.25',
  shortsEnabled: true,
};

describe('oos-session-arm — free preconditions and unit checks', () => {
  it('BAR_MS matches the imported source (900_000 — scripts/loop-forward-return-core.mjs:43)', () => {
    expect(BAR_MS).toBe(900_000);
  });

  it('LIVE_FEED_FLAGS pins the .env.app-observed values (a drift here means re-verify the flags)', () => {
    expect(LIVE_FEED_FLAGS.derivativesFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.fundingHistoryFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.sentimentFeedEnabled).toBe(false);
    expect(LIVE_FEED_FLAGS.fearGreedFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.crossSymbolFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.tradeFlowFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.positioningFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.liquidationsFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.bookStructureFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.trackRecordFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.edgePolicyFeedEnabled).toBe(true);
    expect(LIVE_FEED_FLAGS.derivativesV2Enabled).toBe(false);
    expect(LIVE_FEED_FLAGS.episodicMemoryEnabled).toBe(false);
    const trueCount = Object.values(LIVE_FEED_FLAGS).filter(Boolean).length;
    expect(trueCount).toBe(10);
  });

  it('FEED_BLOCK_TO_FLAG maps every block agent-prompt.ts renders to a LIVE_FEED_FLAGS key', () => {
    for (const flagKey of Object.values(FEED_BLOCK_TO_FLAG)) {
      expect(Object.hasOwn(LIVE_FEED_FLAGS, flagKey)).toBe(true);
    }
  });

  it('buildLiveSystemPrompt is deterministic and documents every live-true block', () => {
    const a = buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
    const b = buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
    expect(a.systemPrompt).toBe(b.systemPrompt);
    expect(a.systemPromptSha256).toBe(b.systemPromptSha256);
    expect(a.systemPrompt.length).toBeGreaterThan(0);
    // fearGreed/tradeFlow/positioning are live-true — their guidance sentences must be present.
    expect(a.systemPrompt).toContain('fearGreed block');
    expect(a.systemPrompt).toContain('tradeFlow block');
    // sentiment/similarSetups are live-false — their guidance sentences must be ABSENT, matching
    // the byte-identical-when-off convention every feed flag in agent-prompt.ts documents.
    expect(a.systemPrompt).not.toContain('sentiment block');
    expect(a.systemPrompt).not.toContain('similarSetups field');
  });

  it('checkPromptFidelity PASSES a row whose blocks are all live-true', () => {
    const r1 = checkPromptFidelity(FAITHFUL_ROW.inputPayload);
    expect(r1.ok).toBe(true);
    expect(r1.violations).toHaveLength(0);
    const r2 = checkPromptFidelity(FAITHFUL_ROW_2.inputPayload);
    expect(r2.ok).toBe(true);
  });

  it('checkPromptFidelity FAILS CLOSED on a row carrying a live-false block (VOID condition 2)', () => {
    const result = checkPromptFidelity(UNFAITHFUL_ROW.inputPayload);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('sentiment'))).toBe(true);
  });

  it('checkPromptFidelity FAILS CLOSED on unparseable payload rather than skipping it', () => {
    expect(checkPromptFidelity('not json').ok).toBe(false);
    expect(checkPromptFidelity('null').ok).toBe(false);
  });

  it('agentPromptModuleFingerprint fails OPEN (never throws) even off a broken git tree', () => {
    expect(() => agentPromptModuleFingerprint(join(tmpdir(), 'not-a-repo'))).not.toThrow();
  });

  it('eligibility (k<=3) fails CLOSED — refused, never clamped', () => {
    for (const k of [0, 1, 2, 3]) {
      const row: OosCandidateRow = { ...FAITHFUL_ROW, eventTime: fixedEventTime(k) };
      expect(() => assertEligible(row, NOW_MS, BAR_MS)).not.toThrow();
      expect(barsElapsed(row.eventTime, NOW_MS, BAR_MS)).toBe(k);
    }
    const tooOld: OosCandidateRow = { ...FAITHFUL_ROW, eventTime: fixedEventTime(4) };
    expect(() => assertEligible(tooOld, NOW_MS, BAR_MS)).toThrow(/ineligible/);
    const future: OosCandidateRow = { ...FAITHFUL_ROW, eventTime: NOW_MS + BAR_MS };
    expect(() => assertEligible(future, NOW_MS, BAR_MS)).toThrow(/ineligible/);
  });

  it('OosCandidateRow structurally carries no live-action field (id/symbol/eventTime/inputPayload only)', () => {
    expect(Object.keys(FAITHFUL_ROW).sort()).toEqual(
      ['eventTime', 'id', 'inputPayload', 'symbol'].sort(),
    );
  });

  it('checkCapsFaithfulness VOIDs on any non-recorded capsSource (VOID condition 1)', () => {
    const clean = checkCapsFaithfulness([
      { rowId: '1', result: { capsSource: 'recorded' as const } },
      { rowId: '2', result: { capsSource: 'recorded' as const } },
    ]);
    expect(clean.void).toBe(false);
    const dirty = checkCapsFaithfulness([
      { rowId: '1', result: { capsSource: 'recorded' as const } },
      { rowId: '2', result: { capsSource: 'config' as const } },
    ]);
    expect(dirty.void).toBe(true);
    expect(dirty.offendingRowIds).toEqual(['2']);
  });

  it('checkEntryRateBound VOIDs outside [4%, 40%] and never on an empty batch (VOID condition 3)', () => {
    const low = checkEntryRateBound(
      Array.from({ length: 100 }, (_, i) => ({
        result: { ok: true, action: i === 0 ? 'open_long' : 'hold' },
      })),
    );
    // Exact, not approximate: 1/100 and 2/10 are the same IEEE754 doubles as their literals, so
    // equality is both correct and stricter here. `toBeCloseTo` is banned repo-wide (money rule).
    expect(low.rate).toBe(0.01);
    expect(low.void).toBe(true);
    const high = checkEntryRateBound(
      Array.from({ length: 10 }, () => ({ result: { ok: true, action: 'open_long' } })),
    );
    expect(high.rate).toBe(1);
    expect(high.void).toBe(true);
    const inBand = checkEntryRateBound([
      ...Array.from({ length: 8 }, () => ({ result: { ok: true, action: 'hold' } })),
      ...Array.from({ length: 2 }, () => ({ result: { ok: true, action: 'open_long' } })),
    ]);
    expect(inBand.rate).toBe(0.2);
    expect(inBand.void).toBe(false);
    const empty = checkEntryRateBound([]);
    expect(empty.rate).toBeNull();
    expect(empty.void).toBe(false);
  });

  it("ALLOWED_RECORD_KEYS never includes anything action-like beyond the session's own `action`", () => {
    expect(ALLOWED_RECORD_KEYS).not.toContain('recordedAction');
    expect(ALLOWED_RECORD_KEYS).not.toContain('liveAction');
    expect(ALLOWED_RECORD_KEYS).not.toContain('baselineAction');
    expect(ALLOWED_RECORD_KEYS.filter((k) => /action/i.test(k))).toEqual(['action']);
  });

  it("buildDecisionRecord emits ONLY whitelisted keys, and its `action` is the session's own", () => {
    const record = buildDecisionRecord({
      rowId: FAITHFUL_ROW.id,
      symbol: FAITHFUL_ROW.symbol,
      eventTime: FAITHFUL_ROW.eventTime,
      venue: String(SPOT_VENUE_ID),
      playbookVersion: 1,
      hashes: {
        systemPromptSha256: sha256Hex('sp'),
        playbookContentSha256: sha256Hex('pb'),
        toolSchemaSha256: sha256Hex('ts'),
        agentPromptBlobSha: 'deadbeef',
      },
      agentPromptCommitSha: 'cafef00d',
      capsSource: 'recorded',
      result: { ok: true, action: 'hold' },
    });
    const roundTripped = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    for (const key of Object.keys(roundTripped)) {
      expect(ALLOWED_RECORD_KEYS).toContain(key);
    }
    expect(record.action).toBe('hold');
    expect(record.base).toBe('BTC');
    expect(record.symbol).toBe('BTC/USDT');
  });

  it('computeRowSetHash is order-sensitive (row order is pinned explicitly)', () => {
    const rows = [FAITHFUL_ROW, FAITHFUL_ROW_2];
    const h1 = computeRowSetHash(rows);
    const h2 = computeRowSetHash([...rows].reverse());
    expect(h1).not.toBe(h2);
    expect(computeRowSetHash(rows)).toBe(h1); // reproducible over the SAME order
  });

  it('ExperimentRow (the seal row shape) carries no timestamp field the caller could author', () => {
    const row: ExperimentRow = {
      family: OOS_ARM_SEAL_FAMILY,
      paramsHash: 'p',
      datasetHash: 'd',
      source: 'study',
    };
    expect(Object.keys(row)).not.toContain('createdAt');
    expect(Object.keys(row)).not.toContain('created_at');
  });

  it('appendDecisionRecords writes newline-delimited JSON to a tmpdir, never to the committed dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oos-arm-spec-'));
    const file = join(dir, 'decisions-test.jsonl');
    const record = buildDecisionRecord({
      rowId: FAITHFUL_ROW.id,
      symbol: FAITHFUL_ROW.symbol,
      eventTime: FAITHFUL_ROW.eventTime,
      venue: String(SPOT_VENUE_ID),
      playbookVersion: null,
      hashes: {
        systemPromptSha256: sha256Hex('sp'),
        playbookContentSha256: sha256Hex('pb'),
        toolSchemaSha256: sha256Hex('ts'),
        agentPromptBlobSha: '',
      },
      agentPromptCommitSha: '',
      capsSource: 'recorded',
      result: { ok: true, action: 'hold' },
    });
    appendDecisionRecords(file, [record]);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...ALLOWED_RECORD_KEYS].sort());
    expect(parsed).not.toHaveProperty('recordedAction');
  });

  it('decisionsFilePath resolves under research/oos-arm/, which is NOT gitignored (checked, not assumed)', () => {
    // .gitignore:44,52 covers test/eval/agentic/data/*.jsonl and research/candidates/** only —
    // verified with `git check-ignore -v research/oos-arm/decisions-2026-08-03.jsonl` (exit 1, no
    // match) before this file was written. This test pins the PATH shape only; it never writes to
    // the real directory (see the tmpdir-only test above and this file's own header comment).
    const path = decisionsFilePath('2026-08-03');
    expect(path).toBe(join(OOS_ARM_DIR, 'decisions-2026-08-03.jsonl'));
    expect(OOS_ARM_DIR.endsWith(join('research', 'oos-arm'))).toBe(true);
  });

  it('loadSessionAnswers returns an EMPTY map (never throws) when the file does not exist yet', () => {
    const answers = loadSessionAnswers(join(tmpdir(), 'oos-arm-does-not-exist-12345.jsonl'));
    expect(answers.size).toBe(0);
    expect(answers.get('anything')).toBeUndefined();
  });

  it('makeFileBackedFetchFn round-trips a session answer through replayPlanRow (schema-valid hold)', async () => {
    const answers = new Map([
      ['oos-fixture-1', { rowId: 'oos-fixture-1', toolInput: { action: 'hold' } }],
    ]);
    const answer = answers.get(FAITHFUL_ROW.id);
    expect(answer).toBeDefined();
    const { systemPrompt } = buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
    const playbookBlock = buildPlaybookBlock('test playbook — decide only on structure');
    const outcome = await decideOosRow(
      FAITHFUL_ROW,
      STUB_CFG,
      systemPrompt,
      playbookBlock,
      makeFileBackedFetchFn(answer!),
    );
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.action).toBe('hold');
    expect(outcome.result.capsSource).toBe('recorded');
    expect(outcome.promptFidelity.ok).toBe(true);
  });

  it('decideOosRow surfaces the fidelity VOID on a row whose payload the live flags do not document', async () => {
    const { systemPrompt } = buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
    const playbookBlock = buildPlaybookBlock('test playbook');
    const outcome = await decideOosRow(
      UNFAITHFUL_ROW,
      STUB_CFG,
      systemPrompt,
      playbookBlock,
      makeStubFetchFn(),
    );
    expect(outcome.promptFidelity.ok).toBe(false);
  });

  it('decideOosRow surfaces capsSource "config" on a row with no capabilities block (VOID condition 1)', async () => {
    const { systemPrompt } = buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
    const playbookBlock = buildPlaybookBlock('test playbook');
    const outcome = await decideOosRow(
      NO_CAPS_ROW,
      STUB_CFG,
      systemPrompt,
      playbookBlock,
      makeStubFetchFn(),
    );
    expect(outcome.result.capsSource).toBe('config');
    expect(checkCapsFaithfulness([outcome]).void).toBe(true);
  });
});

describe('oos-session-arm — dry-run decide batch: $0 by construction, no network egress', () => {
  it('every row decides via the injected fetchFn, capsSource is "recorded" on every row, and global fetch is NEVER called', async () => {
    const rows = [FAITHFUL_ROW, FAITHFUL_ROW_2];
    const { systemPrompt, systemPromptSha256 } = buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
    const playbookBlock = buildPlaybookBlock(
      'dry-run playbook — structure only, no live edge claim',
    );

    let injectedCalls = 0;
    const countingStub: typeof fetch = (...args: Parameters<typeof fetch>) => {
      injectedCalls += 1;
      return makeStubFetchFn({ action: 'hold' })(...args);
    };

    // Poison the GLOBAL fetch for the duration of this batch: any code path that fell through to a
    // real network call (rather than the injected fetchFn replayPlanRow actually uses) throws
    // immediately instead of silently succeeding against a live endpoint.
    const realFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = () => {
      globalFetchCalls += 1;
      throw new Error('global fetch must never be called by the dry-run decide batch');
    };

    try {
      const outcomes = await Promise.all(
        rows.map((row) => decideOosRow(row, STUB_CFG, systemPrompt, playbookBlock, countingStub)),
      );
      expect(injectedCalls).toBe(rows.length);
      expect(globalFetchCalls).toBe(0);
      for (const outcome of outcomes) {
        expect(outcome.result.ok).toBe(true);
        expect(outcome.result.capsSource).toBe('recorded');
        expect(outcome.promptFidelity.ok).toBe(true);
      }
      expect(checkCapsFaithfulness(outcomes).void).toBe(false);

      // Records built from this batch never carry the live lane's action, and the row-set hash is
      // reproducible — the two properties Deliverable B's acceptance criteria name explicitly.
      const records: DecisionRecord[] = outcomes.map((o) =>
        buildDecisionRecord({
          rowId: o.rowId,
          symbol: o.symbol,
          eventTime: o.eventTime,
          venue: String(SPOT_VENUE_ID),
          playbookVersion: 1,
          hashes: {
            systemPromptSha256,
            playbookContentSha256: sha256Hex(playbookBlock),
            toolSchemaSha256: sha256Hex('tool-schema-placeholder'),
            agentPromptBlobSha: agentPromptModuleFingerprint().worktreeBlobSha,
          },
          agentPromptCommitSha: agentPromptModuleFingerprint().commitSha,
          capsSource: o.result.capsSource!,
          result: o.result,
        }),
      );
      for (const record of records) {
        expect(Object.keys(record)).toEqual(expect.arrayContaining([]));
        expect(Object.keys(record).every((k) => ALLOWED_RECORD_KEYS.includes(k))).toBe(true);
      }
      expect(computeRowSetHash(rows)).toBe(computeRowSetHash(rows));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('the decide leg source never imports an llm_usage writer — no DB write on this path at all', () => {
    const source = readFileSync(join(__dirname, 'oos-arm-decide.ts'), 'utf8');
    expect(source).not.toMatch(/llm-usage/i);
    expect(source).not.toMatch(/LlmUsage/);
  });
});

// ── DB integration — sealBatch writes a real, DB-authored created_at ────────────────────────────────
// Same guard as test/db/experiment-registry.spec.ts (DB_SUITE_ALLOW_RESET or a `_test`-suffixed
// DATABASE_URL) — this is NOT part of the free/default leg above, and is skipped entirely offline.
const DB_URL = process.env['DATABASE_URL'];
function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}
const DB_GATE_OPEN =
  !!DB_URL && (process.env['DB_SUITE_ALLOW_RESET'] === '1' || dbNameEndsWithTest(DB_URL));

describe.skipIf(!DB_GATE_OPEN)(
  'oos-session-arm — DB integration: seal writes a real created_at',
  () => {
    it('sealBatch inserts one experiments row whose created_at is DB-authored and recent', async () => {
      const pool = new Pool({ connectionString: DB_URL! });
      try {
        const window = {
          windowStart: NOW_MS - 4 * BAR_MS,
          windowEnd: NOW_MS,
          rowIdsInOrder: [FAITHFUL_ROW.id, FAITHFUL_ROW_2.id],
          payloadSha256: computeRowSetHash([FAITHFUL_ROW, FAITHFUL_ROW_2]),
        };
        const beforeSeal = Date.now();
        await sealBatch(window);
        const afterSeal = Date.now();

        const expectedParamsHash = paramsHash({
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
        });
        const expectedDatasetHash = datasetHash({
          symbol: 'oos-arm',
          interval: 'n/a',
          rowCount: window.rowIdsInOrder.length,
          firstTs: window.windowStart,
          lastTs: window.windowEnd,
        });

        const res = await pool.query<{ created_at: Date }>(
          `SELECT created_at FROM experiments
         WHERE family = $1 AND params_hash = $2 AND dataset_hash = $3
         ORDER BY id DESC LIMIT 1`,
          [OOS_ARM_SEAL_FAMILY, expectedParamsHash, expectedDatasetHash],
        );
        expect(res.rows).toHaveLength(1);
        const createdAtMs = new Date(res.rows[0]!.created_at).getTime();
        expect(createdAtMs).toBeGreaterThanOrEqual(beforeSeal - 1000);
        expect(createdAtMs).toBeLessThanOrEqual(afterSeal + 1000);
      } finally {
        await pool.end();
      }
    }, 30_000);
  },
);
