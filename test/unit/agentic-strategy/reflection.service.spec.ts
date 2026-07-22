import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ReflectionService,
  createReflectionService,
  reconstructClosedTrades,
  summarizeHolds,
  type ReflectionServiceConfig,
  type ReflectionServiceDeps,
  type ReflectionPlaybookStore,
  type ReflectionMetricsRecorder,
} from '../../../src/features/trading/agentic/reflection.service';
import {
  DailyLlmBudget,
  type DailyLlmBudgetCaps,
} from '../../../src/features/trading/agentic/agent-budget';
import type {
  AgentDecisionJournalPort,
  AgentDecisionRow,
  LlmUsageEntry,
  LlmUsageSink,
} from '../../../src/ports/agentic-strategy';
import type { KillSwitchPort } from '../../../src/ports/risk';
import type { KillSwitchState } from '../../../src/domain/risk/kill-switch';
import type { StrategyRegistryPort, StrategyLifecycle } from '../../../src/ports/strategy';
import { strategyId, symbolId, venueId, epochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// A macrotask flush: runReflection chains several awaits (store.current, journal.recent, fetch,
// res.json) over already-resolved fakes — a single microtask tick isn't enough to drain them all.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function validPlaybookContent(tag: string): string {
  return [
    '## regime notes',
    `notes ${tag}`,
    '## entry rules',
    `entry ${tag}`,
    '## exit rules',
    `exit ${tag}`,
    '## mistakes to avoid',
    `mistakes ${tag}`,
  ].join('\n');
}

function row(overrides: Partial<AgentDecisionRow> = {}): AgentDecisionRow {
  return {
    strategyId: SID,
    symbol: symbolId('BTC/USDT'),
    venue: venueId('binance'),
    triggerKind: 'candle',
    basedOnSeq: 1n,
    eventTime: epochMs(T),
    model: 'test',
    action: 'hold',
    confidence: 0.5,
    rationale: '',
    refPrice: null,
    close: '100',
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    playbookVersion: 1,
    promptHash: 'hash',
    inputPayload: null,
    id: '1',
    createdAt: epochMs(T),
    ...overrides,
  };
}

function killSwitchWithState(state: KillSwitchState): KillSwitchPort {
  return {
    state: () => state,
    reason: () => '',
    engage: () => undefined,
    confirmCancels: () => undefined,
    cancelTimeout: () => undefined,
    allFlat: () => undefined,
    resume: () => undefined,
  };
}

function registryWithLifecycle(lifecycle: StrategyLifecycle): StrategyRegistryPort {
  return {
    register: () => undefined,
    enable: () => undefined,
    disable: () => undefined,
    states: () => [{ id: SID, lifecycle }],
  };
}

function fakeJournal(rows: readonly AgentDecisionRow[] = []): AgentDecisionJournalPort {
  return {
    record: () => undefined,
    // Mirrors the runtime adapters: newest-`limit` tail of the oldest→newest row list (every
    // current fixture fits under the smallest lookback limit, so existing tests see identical
    // windows — this is parity with runtime, not a behavior change).
    recent: (limit) => Promise.resolve(rows.slice(Math.max(0, rows.length - limit))),
    versionEntryStats: (version) => {
      let decides = 0;
      let entries = 0;
      for (const r of rows) {
        if (r.playbookVersion !== version) continue;
        if (!r.model.startsWith('claude')) continue;
        decides += 1;
        if (r.action === 'open_long' || r.action === 'open_short') entries += 1;
      }
      return Promise.resolve({ decides, entries });
    },
  };
}

function fakePlaybookStore(
  content: string,
  version = 1,
): {
  store: ReflectionPlaybookStore;
  appended: Array<{ content: string; source: 'reflection' | 'promotion'; parentVersion: number }>;
} {
  // current() is fixed (never advances on append), mirroring InMemoryPlaybookStore's own
  // resolution: a 'reflection' append never activates — only a later 'promotion' row would.
  const appended: Array<{
    content: string;
    source: 'reflection' | 'promotion';
    parentVersion: number;
  }> = [];
  const store: ReflectionPlaybookStore = {
    current: () => Promise.resolve({ version, content }),
    append: (c, source, parentVersion) => {
      appended.push({ content: c, source, parentVersion });
      return Promise.resolve({ version: version + appended.length });
    },
  };
  return { store, appended };
}

function fakeRecorder(): {
  recorder: ReflectionMetricsRecorder;
  rejections: boolean[];
  tokens: Array<[number, number, number | undefined, number | undefined, string | undefined]>;
  outcomes: string[];
  triggers: string[];
} {
  const rejections: boolean[] = [];
  const tokens: Array<
    [number, number, number | undefined, number | undefined, string | undefined]
  > = [];
  const outcomes: string[] = [];
  const triggers: string[] = [];
  return {
    recorder: {
      recordValidatorRejection: (b) => void rejections.push(b),
      recordTokens: (i, o, cr, cc, m) => void tokens.push([i, o, cr, cc, m]),
      recordReflectionOutcome: (outcome) => void outcomes.push(outcome),
      recordReflectionTrigger: (outcome) => void triggers.push(outcome),
    },
    rejections,
    tokens,
    outcomes,
    triggers,
  };
}

function fakeUsageSink(): { sink: LlmUsageSink; recorded: LlmUsageEntry[] } {
  const recorded: LlmUsageEntry[] = [];
  return { sink: { record: (entry) => void recorded.push(entry) }, recorded };
}

function warnLogger(): { warn: (msg: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (msg: string) => void messages.push(msg), messages };
}

function apiResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function revisionToolBody(input: unknown, stopReason = 'tool_use'): unknown {
  return {
    stop_reason: stopReason,
    // Mirrors the real Anthropic Messages API under adaptive thinking: responses carry a SIGNED
    // thinking block ahead of the tool_use, and the validator-reject retry (backlog #31) must echo
    // BOTH verbatim in the follow-up's assistant turn (omitting the thinking block is a guaranteed
    // 400 on the continuation) and reference the tool_use id from its tool_result.
    content: [
      { type: 'thinking', thinking: 'test-thinking-trace', signature: 'sig_test_1' },
      { type: 'tool_use', id: 'toolu_test_1', name: 'submit_playbook_revision', input },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function baseCfg(over: Partial<ReflectionServiceConfig> = {}): ReflectionServiceConfig {
  return {
    everyNTrades: 3,
    timeoutMs: 5000,
    model: 'claude-test-model',
    apiKey: 'sk-ant-test-key',
    ...over,
  };
}

// ── Backlog #39: mint-time entry-rate floor fixtures ────────────────────────

// A real (model starts 'claude'), FLAT-position consult row — exactly what the floor's journal
// scan qualifies. eventTime spreads rows so journal.recent()'s oldest→newest ordering is meaningful.
function flatConsultRow(i: number): AgentDecisionRow {
  return row({
    id: `flat-${i}`,
    model: 'claude-sonnet-5',
    inputPayload: JSON.stringify({ position: { side: 'FLAT' } }),
    eventTime: epochMs(T + i),
  });
}

// A submit_trade (v2 rich decision contract) tool-use response, mirroring the live decide path's
// envelope in miniature (no thinking block: the floor's replay disables thinking, same as decide's
// own attemptOnce). P3: migrated off the legacy submit_plan/'long' shape — an 'open_long'/'open_short'
// action carries the full directive set the v2 schema's requireTradeDirectives superRefine requires,
// or the replay's safeParse fails and the row silently doesn't count as an entry.
const FLOOR_DIRECTIVES = {
  sizeFraction: 0.1,
  entry: { style: 'maker' as const, offsetBps: 10 },
  entryValidityBars: 2,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  maxHoldBars: 3,
};

function floorPlanBody(action: 'open_long' | 'open_short' | 'hold'): unknown {
  const isOpen = action === 'open_long' || action === 'open_short';
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_floor',
        name: 'submit_trade',
        input: { action, ...(isOpen ? FLOOR_DIRECTIVES : {}) },
      },
    ],
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

// Dispatches a shared fetch mock between the reflection draft calls (tool submit_playbook_revision)
// and the floor's replay calls (tool submit_trade) by inspecting the request body's tool name —
// exactly the distinguishing signal a fake fetch has, per this suite's own design brief. Typed via a
// narrow structural param (rather than ReturnType<typeof vi.fn>) so the implementation's real
// `typeof fetch` signature — a Promise-returning function — is what TS/eslint actually check against.
function mockDualFetch(
  fetchFn: { mockImplementation(impl: typeof fetch): unknown },
  reflectionBodies: readonly unknown[],
  floorAction: 'open_long' | 'open_short' | 'hold',
): void {
  let reflectionCallIndex = 0;
  const impl: typeof fetch = (_url, init) => {
    const parsedBody = JSON.parse(init?.body as string) as { tools: Array<{ name: string }> };
    if (parsedBody.tools[0]!.name === 'submit_playbook_revision') {
      const body = reflectionBodies[reflectionCallIndex]!;
      reflectionCallIndex += 1;
      return Promise.resolve(apiResponse(body));
    }
    return Promise.resolve(apiResponse(floorPlanBody(floorAction)));
  };
  fetchFn.mockImplementation(impl);
}

interface Harness {
  deps: ReflectionServiceDeps;
  fetchFn: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof warnLogger>;
  storeApi: ReturnType<typeof fakePlaybookStore>;
  recorderApi: ReturnType<typeof fakeRecorder>;
  usageSinkApi: ReturnType<typeof fakeUsageSink>;
  budget: DailyLlmBudget;
  clock: { now: number };
}

function buildHarness(
  opts: {
    killSwitchState?: KillSwitchState;
    lifecycle?: StrategyLifecycle;
    budgetCaps?: DailyLlmBudgetCaps;
    rows?: readonly AgentDecisionRow[];
    seedContent?: string;
    withUsageSink?: boolean;
  } = {},
): Harness {
  const clock = { now: T };
  const nowFn = () => clock.now;
  const fetchFn = vi.fn();
  const logger = warnLogger();
  const storeApi = fakePlaybookStore(opts.seedContent ?? validPlaybookContent('seed'));
  const recorderApi = fakeRecorder();
  const usageSinkApi = fakeUsageSink();
  const budget = new DailyLlmBudget(
    opts.budgetCaps ?? { maxCallsPerDay: 10, maxTokensPerDay: 1_000_000 },
    nowFn,
  );
  const deps: ReflectionServiceDeps = {
    budget,
    playbookStore: storeApi.store,
    journal: fakeJournal(opts.rows ?? []),
    recorder: recorderApi.recorder,
    usageSink: (opts.withUsageSink ?? true) ? usageSinkApi.sink : undefined,
    killSwitch: killSwitchWithState(opts.killSwitchState ?? 'RUNNING'),
    registry: registryWithLifecycle(opts.lifecycle ?? 'ACTIVE'),
    fetchFn,
    nowFn,
    logger,
  };
  return { deps, fetchFn, logger, storeApi, recorderApi, usageSinkApi, budget, clock };
}

describe('reconstructClosedTrades', () => {
  it('pairs a LONG entry with the next FLAT exit into a closed-trade summary', () => {
    const rows = [
      row({ action: 'open_long', refPrice: '100', eventTime: epochMs(T) }),
      row({ action: 'close', refPrice: '110', eventTime: epochMs(T + 1000) }),
    ];
    expect(reconstructClosedTrades(rows, 10)).toEqual([
      {
        entryTime: T,
        exitTime: T + 1000,
        entryPrice: 100,
        exitPrice: 110,
        pnlPct: 10,
        side: 'LONG',
      },
    ]);
  });

  it('ignores a repeated long row while a trade is already open (hold re-affirmation, not a new entry)', () => {
    const rows = [
      row({ action: 'open_long', refPrice: '100', eventTime: epochMs(T) }),
      row({ action: 'open_long', refPrice: '105', eventTime: epochMs(T + 500) }),
      row({ action: 'close', refPrice: '110', eventTime: epochMs(T + 1000) }),
    ];
    expect(reconstructClosedTrades(rows, 10)).toEqual([
      {
        entryTime: T,
        exitTime: T + 1000,
        entryPrice: 100,
        exitPrice: 110,
        pnlPct: 10,
        side: 'LONG',
      },
    ]);
  });

  it('P3: pairs an open_short entry with close into a SHORT round trip, PnL sign mirrored (profit on a decline)', () => {
    const rows = [
      row({ action: 'open_short', refPrice: '100', eventTime: epochMs(T) }),
      row({ action: 'close', refPrice: '90', eventTime: epochMs(T + 1000) }),
    ];
    expect(reconstructClosedTrades(rows, 10)).toEqual([
      {
        entryTime: T,
        exitTime: T + 1000,
        entryPrice: 100,
        exitPrice: 90,
        pnlPct: 10,
        side: 'SHORT',
      },
    ]);
  });

  it('P3: open_long + close pairs into a LONG round trip (v2 literals, legacy pnlPct formula)', () => {
    const rows = [
      row({ action: 'open_long', refPrice: '100', eventTime: epochMs(T) }),
      row({ action: 'close', refPrice: '110', eventTime: epochMs(T + 1000) }),
    ];
    expect(reconstructClosedTrades(rows, 10)).toEqual([
      {
        entryTime: T,
        exitTime: T + 1000,
        entryPrice: 100,
        exitPrice: 110,
        pnlPct: 10,
        side: 'LONG',
      },
    ]);
  });

  it("P3: 'adjust' rows annotate the open position in place — never open or close a trade", () => {
    const rows = [
      row({ action: 'open_long', refPrice: '100', eventTime: epochMs(T) }),
      row({ action: 'adjust', refPrice: '103', eventTime: epochMs(T + 500) }),
      row({ action: 'close', refPrice: '110', eventTime: epochMs(T + 1000) }),
    ];
    expect(reconstructClosedTrades(rows, 10)).toEqual([
      {
        entryTime: T,
        exitTime: T + 1000,
        entryPrice: 100,
        exitPrice: 110,
        pnlPct: 10,
        side: 'LONG',
      },
    ]);
  });

  it('keeps only the most recent maxTrades', () => {
    const rows: AgentDecisionRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(row({ action: 'open_long', refPrice: '100', eventTime: epochMs(T + i * 10_000) }));
      rows.push(
        row({ action: 'close', refPrice: '110', eventTime: epochMs(T + i * 10_000 + 5000) }),
      );
    }
    expect(reconstructClosedTrades(rows, 2)).toHaveLength(2);
  });
});

describe('summarizeHolds', () => {
  it('returns a zeroed summary when there are no hold rows', () => {
    expect(summarizeHolds([row({ action: 'open_long' })])).toEqual({
      count: 0,
      spanMs: 0,
      meanConfidence: null,
    });
  });

  it('computes count/span/meanConfidence over hold rows only', () => {
    const rows = [
      row({ action: 'hold', confidence: 0.2, eventTime: epochMs(T) }),
      row({ action: 'open_long', confidence: 0.9, eventTime: epochMs(T + 100) }),
      row({ action: 'hold', confidence: 0.6, eventTime: epochMs(T + 200) }),
    ];
    expect(summarizeHolds(rows)).toEqual({ count: 2, spanMs: 200, meanConfidence: 0.4 });
  });
});

describe('ReflectionService', () => {
  describe('permanently inert construction', () => {
    it('never checks any precondition when everyNTrades is 0', async () => {
      const h = buildHarness();
      const stateSpy = vi.spyOn(h.deps.killSwitch!, 'state');
      const service = new ReflectionService(baseCfg({ everyNTrades: 0 }), h.deps);

      for (let i = 1; i <= 20; i++) service.onClosedTrade(SID, i);
      await flush();

      expect(h.fetchFn).not.toHaveBeenCalled();
      expect(stateSpy).not.toHaveBeenCalled();
    });

    it('never checks any precondition when no apiKey is configured', async () => {
      const h = buildHarness();
      const stateSpy = vi.spyOn(h.deps.killSwitch!, 'state');
      const service = new ReflectionService(
        baseCfg({ apiKey: undefined, everyNTrades: 1 }),
        h.deps,
      );

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.fetchFn).not.toHaveBeenCalled();
      expect(stateSpy).not.toHaveBeenCalled();
    });
  });

  describe('preconditions re-checked at execution time (never at trigger time)', () => {
    const NON_RUNNING_STATES: readonly KillSwitchState[] = [
      'HALTING',
      'HALTED',
      'FLATTENING',
      'HALTED_DEGRADED',
    ];

    it.each(NON_RUNNING_STATES)(
      'blocks when the kill switch is %s (not RUNNING)',
      async (state) => {
        const h = buildHarness({ killSwitchState: state });
        const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

        service.onClosedTrade(SID, 1);
        await flush();

        expect(h.fetchFn).not.toHaveBeenCalled();
        expect(h.storeApi.appended).toHaveLength(0);
      },
    );

    it('blocks when the strategy lifecycle is not ACTIVE (DRAINING)', async () => {
      const h = buildHarness({ lifecycle: 'DRAINING' });
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.fetchFn).not.toHaveBeenCalled();
    });

    it('blocks when the daily LLM budget is exhausted, without ever calling the client', async () => {
      const h = buildHarness({ budgetCaps: { maxCallsPerDay: 0, maxTokensPerDay: 1_000_000 } });
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.fetchFn).not.toHaveBeenCalled();
    });

    it('never calls tryReserveCall when the kill-switch precondition already failed', async () => {
      const h = buildHarness({ killSwitchState: 'HALTED' });
      const spy = vi.spyOn(h.budget, 'tryReserveCall');
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(spy).not.toHaveBeenCalled();
    });

    it('never calls tryReserveCall when the lifecycle precondition already failed', async () => {
      const h = buildHarness({ lifecycle: 'DRAINING' });
      const spy = vi.spyOn(h.budget, 'tryReserveCall');
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('auto-promotion (G4b)', () => {
    const revision = (): Response =>
      apiResponse(
        revisionToolBody({ playbook: validPlaybookContent('revised'), changelog: 'tweak' }),
      );

    it('auto-promotes the minted candidate once closedTradeCount reaches autoPromoteMinTrades', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(revision());
      const service = new ReflectionService(
        baseCfg({ everyNTrades: 1, autoPromoteMinTrades: 30 }),
        h.deps,
      );

      // The 2nd onClosedTrade arg is the strategy's cumulative closed-trade count (the promotion gate).
      service.onClosedTrade(SID, 30);
      await flush();

      // A 'reflection' candidate is minted, then a 'promotion' row targeting it is appended.
      expect(h.storeApi.appended.map((a) => a.source)).toEqual(['reflection', 'promotion']);
      const mintedVersion = 2; // fakePlaybookStore: current version 1, first append → 2
      const promotion = h.storeApi.appended[1]!;
      expect(promotion.parentVersion).toBe(mintedVersion);
      expect(promotion.content).toContain(`auto-promoted version ${mintedVersion}`);
      expect(h.logger.messages.some((m) => m.includes('auto-promoted playbook version'))).toBe(
        true,
      );
    });

    it('does NOT auto-promote below the trade floor — the candidate stays INACTIVE', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(revision());
      const service = new ReflectionService(
        baseCfg({ everyNTrades: 1, autoPromoteMinTrades: 30 }),
        h.deps,
      );

      service.onClosedTrade(SID, 29); // one short of the floor
      await flush();

      expect(h.storeApi.appended.map((a) => a.source)).toEqual(['reflection']);
    });

    it('does NOT auto-promote when disabled (autoPromoteMinTrades defaults to 0)', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(revision());
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1000);
      await flush();

      expect(h.storeApi.appended.map((a) => a.source)).toEqual(['reflection']);
    });

    it('leaves the candidate INACTIVE (never throws) when the promotion append fails (once-per-day cap)', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(revision());
      const appended: Array<{ source: string }> = [];
      const failingStore: ReflectionPlaybookStore = {
        current: () => Promise.resolve({ version: 1, content: validPlaybookContent('seed') }),
        append: (_c, source) => {
          appended.push({ source });
          return source === 'promotion'
            ? Promise.reject(new Error('promotion already landed today'))
            : Promise.resolve({ version: 2 });
        },
      };
      const service = new ReflectionService(
        baseCfg({ everyNTrades: 1, autoPromoteMinTrades: 30 }),
        {
          ...h.deps,
          playbookStore: failingStore,
        },
      );

      service.onClosedTrade(SID, 30);
      await flush();

      expect(appended.map((a) => a.source)).toEqual(['reflection', 'promotion']); // both attempted
      expect(
        h.logger.messages.some((m) => m.includes('auto-promotion') && m.includes('did not land')),
      ).toBe(true);
    });
  });

  describe('trigger + in-flight guard', () => {
    it('fires once tradesSinceLastAttempt reaches N (the 7-day floor is trivially satisfied at boot), then holds off until the floor elapses', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 3 }), h.deps);

      service.onClosedTrade(SID, 1);
      service.onClosedTrade(SID, 2);
      await flush();
      expect(h.fetchFn).not.toHaveBeenCalled(); // below N
      expect(h.recorderApi.triggers).toEqual(['below_threshold', 'below_threshold']);

      service.onClosedTrade(SID, 3);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // N reached, lastAttemptAt=0 floor trivially satisfied
      expect(h.recorderApi.triggers.at(-1)).toBe('fired');

      service.onClosedTrade(SID, 4);
      service.onClosedTrade(SID, 5);
      service.onClosedTrade(SID, 6);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // N reached again, but floor not yet elapsed
      // counter reset on fire (trade 3): trades 4,5 stay below N again, trade 6 reaches N but the
      // floor blocks it.
      expect(h.recorderApi.triggers.slice(-3)).toEqual([
        'below_threshold',
        'below_threshold',
        'cooldown',
      ]);

      h.clock.now += SEVEN_DAYS_MS;
      service.onClosedTrade(SID, 7);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(2); // floor elapsed — fires again
      expect(h.recorderApi.triggers.at(-1)).toBe('fired');
    });

    it('re-fires after a tuned cooldownMs shorter than the 7-day default (F7)', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(
        baseCfg({ everyNTrades: 1, cooldownMs: 60_000 }),
        h.deps,
      );

      service.onClosedTrade(SID, 1);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // first attempt (cooldown trivially satisfied at boot)
      expect(h.recorderApi.triggers.at(-1)).toBe('fired');

      h.clock.now += 30_000; // below the 60s cooldown
      service.onClosedTrade(SID, 2);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // cooldown not yet elapsed
      expect(h.recorderApi.triggers.at(-1)).toBe('cooldown');

      h.clock.now += 30_001; // total 60_001ms — past the tuned cooldown, far below 7 days
      service.onClosedTrade(SID, 3);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(2); // tuned cooldown elapsed — fires again
      expect(h.recorderApi.triggers.at(-1)).toBe('fired');
    });

    it('does not reset the counter on a blocked (precondition-failed) attempt — the very next closed trade retries', async () => {
      const h = buildHarness({ killSwitchState: 'HALTED' });
      const stateSpy = vi.spyOn(h.deps.killSwitch!, 'state');
      const service = new ReflectionService(baseCfg({ everyNTrades: 2 }), h.deps);

      service.onClosedTrade(SID, 1);
      service.onClosedTrade(SID, 2); // reaches N, launches, kill switch check fails inside runReflection
      await flush();
      expect(stateSpy).toHaveBeenCalledTimes(1);

      service.onClosedTrade(SID, 3); // counter was never reset — still >= N, retries immediately
      await flush();
      expect(stateSpy).toHaveBeenCalledTimes(2); // a second genuine attempt was made
    });

    it('skips launching a second attempt while one is already in flight, without queuing it', async () => {
      const h = buildHarness();
      h.fetchFn.mockReturnValue(new Promise<Response>(() => undefined)); // never resolves
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1); // launches; fetch pending forever
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1);
      expect(h.recorderApi.triggers.at(-1)).toBe('fired');

      h.clock.now += SEVEN_DAYS_MS + 60_000; // past the floor too, so ONLY in-flight blocks this
      service.onClosedTrade(SID, 2);
      await flush();

      expect(h.fetchFn).toHaveBeenCalledTimes(1); // still just 1 — never queued
      expect(h.logger.messages.some((m) => m.includes('already in flight'))).toBe(true);
      expect(h.recorderApi.triggers.at(-1)).toBe('inflight');
    });
  });

  describe('detachment', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('onClosedTrade returns synchronously (undefined, not a Promise) even when the reflection fetch never resolves for 60s', async () => {
      vi.useFakeTimers();
      const h = buildHarness();
      h.fetchFn.mockReturnValue(new Promise<Response>(() => undefined)); // never resolves
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      const result = service.onClosedTrade(SID, 1); // must never await runReflection internally
      expect(result).toBeUndefined();

      await vi.advanceTimersByTimeAsync(60_000); // still pending; nothing throws or hangs
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // the detached call genuinely launched
    });

    it('keeps the abort deadline armed through a stalled res.json() body read: the run aborts after timeoutMs and the in-flight guard releases', async () => {
      vi.useFakeTimers();
      const h = buildHarness();
      // The signal isn't known until fetchFn is actually called; read it back off the mock's
      // recorded call args (populated by the time json()'s executor below runs).
      const capturedSignal = (): AbortSignal | null | undefined =>
        (h.fetchFn.mock.calls[0]?.[1] as unknown as RequestInit | undefined)?.signal;
      h.fetchFn.mockResolvedValue({
        ok: true,
        status: 200,
        // Mirrors the real Fetch contract: aborting the signal mid-read rejects a pending body read.
        json: () =>
          new Promise((_resolve, reject) => {
            capturedSignal()?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      });
      const service = new ReflectionService(baseCfg({ everyNTrades: 1, timeoutMs: 5000 }), h.deps);

      service.onClosedTrade(SID, 1);
      await vi.advanceTimersByTimeAsync(0); // fetch resolves headers; res.json() is now the pending await
      expect(capturedSignal()?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(5000); // timeoutMs elapses while json() is still stuck
      expect(capturedSignal()?.aborted).toBe(true);
      // #32 behavior change: a body-read abort is now caught INSIDE callReflectionOnce and
      // classified transport_error (with #31 rollback), instead of escaping to the last-resort
      // 'run failed' catch as before.
      expect(h.logger.messages.some((m) => m.includes('transport error'))).toBe(true);
      expect(h.recorderApi.outcomes).toContain('transport_error');

      // in-flight guard released (finally): a later genuine attempt can still fire.
      h.clock.now += SEVEN_DAYS_MS;
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      service.onClosedTrade(SID, 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('output handling', () => {
    it('discards an invalid revised playbook and records the validator-rejection tripwire, minting nothing', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: 'not a valid playbook', changelog: 'oops' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.storeApi.appended).toHaveLength(0);
      expect(h.recorderApi.rejections).toEqual([false]);
      // The exit-point telemetry (W2): this is exactly the silent-discard path that killed the
      // live loop — it must now be visible as a labeled outcome, not just a warn line.
      expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'validator_reject']);
    });

    it('mints nothing when the revised playbook hashes identical to the current one (NO_CHANGE)', async () => {
      const seed = validPlaybookContent('same');
      const h = buildHarness({ seedContent: seed });
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: seed, changelog: 'no real change' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.storeApi.appended).toHaveLength(0);
      expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'no_change']);
    });

    it('mints a new INACTIVE candidate when the revised playbook differs from the current one', async () => {
      const h = buildHarness({ seedContent: validPlaybookContent('seed') });
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.storeApi.appended).toEqual([
        { content: validPlaybookContent('v2'), source: 'reflection', parentVersion: 1 },
      ]);
      expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    });

    it('labels a refusal and a budget-exhausted attempt with their own outcomes', async () => {
      const refused = buildHarness();
      refused.fetchFn.mockResolvedValue(
        apiResponse({ stop_reason: 'refusal', content: [], usage: undefined }),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), refused.deps);
      service.onClosedTrade(SID, 1);
      await flush();
      expect(refused.recorderApi.outcomes).toEqual(['attempt_started', 'refusal']);

      const broke = buildHarness({ budgetCaps: { maxCallsPerDay: 0, maxTokensPerDay: 1_000_000 } });
      const service2 = new ReflectionService(baseCfg({ everyNTrades: 1 }), broke.deps);
      service2.onClosedTrade(SID, 1);
      await flush();
      expect(broke.recorderApi.outcomes).toEqual(['budget_deferred']);
    });

    it('includes a decisionOutcomes forward-outcome digest in the reflection request body (F1)', async () => {
      const rows: AgentDecisionRow[] = [
        row({ action: 'open_long', close: '100', eventTime: epochMs(T) }), // FLAT→LONG entry
        row({ action: 'close', close: '110', eventTime: epochMs(T + 1000) }), // closes; no t+1 fwd
      ];
      const h = buildHarness({ rows });
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.fetchFn).toHaveBeenCalledTimes(1);
      const init = h.fetchFn.mock.calls[0]![1] as RequestInit;
      const requestBody = JSON.parse(init.body as string) as {
        messages: { content: string }[];
      };
      const userContent = requestBody.messages[0]!.content;
      // The user message is the playbook block, then "\n\n", then JSON.stringify(payload); the
      // payload is the only place carrying the "closedTrades" key, so slice from there to the end.
      const payload = JSON.parse(userContent.slice(userContent.indexOf('{"closedTrades"'))) as {
        decisionOutcomes?: {
          entries: { count: number; meanForwardReturnPct: number | null };
          confidence: { highLong: { count: number } };
        };
      };
      expect(payload.decisionOutcomes).toBeDefined();
      // Only the entry has a t+1 forward return ((110-100)/100 = +10%); the exit is the last row.
      expect(payload.decisionOutcomes!.entries).toEqual({
        count: 1,
        meanForwardReturnPct: ((110 - 100) / 100) * 100,
      });
      // The entry's default confidence 0.5 lands in the high-confidence long bucket.
      expect(payload.decisionOutcomes!.confidence.highLong.count).toBe(1);
    });

    it('folds calibration/regimeSplit/costContext into the payload and teaches the model to read calibration (W14)', async () => {
      const rows: AgentDecisionRow[] = [
        row({ action: 'open_long', close: '100', eventTime: epochMs(T) }),
        row({ action: 'close', close: '110', eventTime: epochMs(T + 1000) }),
      ];
      const h = buildHarness({ rows });
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      const body = requestBodyOf(h.fetchFn);
      expect(body.system).toContain(
        'if entries show no positive edge at any confidence, the entry rules',
      );
      const userContent = body.messages[0]!.content;
      const payload = JSON.parse(userContent.slice(userContent.indexOf('{"closedTrades"'))) as {
        calibration?: unknown[];
        regimeSplit?: { quiet: unknown[]; active: unknown[] };
        costContext?: { roundTripFeeBps: number; note: string };
      };
      // Only 2 rows -> the single decision-point bucket has n=1, below CALIBRATION_MIN_SAMPLE (3),
      // so calibration is present but empty; regimeSplit needs a 10-row trailing window, also empty.
      expect(payload.calibration).toEqual([]);
      expect(payload.regimeSplit).toEqual({ quiet: [], active: [] });
      expect(payload.costContext).toEqual({
        roundTripFeeBps: 20,
        note: 'net-of-cost PnL = realized − fees − LLM cost; wins must clear ~20bps round-trip fees',
      });
    });

    it('folds the postMortems digest (X7) into the reflection request body', async () => {
      const rows: AgentDecisionRow[] = [
        row({ action: 'open_long', close: '100', eventTime: epochMs(T) }),
        row({ action: 'close', close: '110', eventTime: epochMs(T + 1000) }),
      ];
      const h = buildHarness({ rows });
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      const body = requestBodyOf(h.fetchFn);
      const userContent = body.messages[0]!.content;
      const payload = JSON.parse(userContent.slice(userContent.indexOf('{"closedTrades"'))) as {
        postMortems?: {
          thesisPostMortems: unknown[];
          holdPostMortem: { gradedHolds: number; missedEntryRate: number | null };
          hourBuckets: unknown[];
          dayTypeBuckets: unknown[];
        };
      };
      // Only 2 rows -> no thesis-bearing round trip and no declined-entry hold with a full 24-bar
      // forward window, so the digest is present but structurally empty/null — this pins that the
      // key reaches the payload at all, not that this thin fixture grades anything.
      expect(payload.postMortems).toEqual({
        thesisPostMortems: [],
        holdPostMortem: {
          gradedHolds: 0,
          missedEntries: 0,
          correctHolds: 0,
          missedEntryRate: null,
          correctHoldRate: null,
        },
        hourBuckets: [],
        dayTypeBuckets: [],
      });
    });

    it('teaches the model to read postMortems.holdPostMortem.missedEntryRate as the anti-ratchet counterweight evidence', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      const body = requestBodyOf(h.fetchFn);
      expect(body.system).toContain(
        "postMortems.holdPostMortem's missedEntryRate is the fraction of declined-entry",
      );
      expect(body.system).toContain('anti-ratchet counterweight evidence');
    });

    it('records token usage on the budget when the API call succeeds', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.budget.snapshot().inputTokens).toBe(10);
      expect(h.budget.snapshot().outputTokens).toBe(20);
      // D: reflection-path tokens also feed the metrics recorder (agent_tokens_total) for the cost
      // view, tagged with the reflection model (#28: split Opus reflection from Sonnet decide $/day).
      // Cache args are undefined (not 0) when the response carried neither field — the
      // absent-vs-confirmed-zero distinction the cost analysis depends on.
      expect(h.recorderApi.tokens).toEqual([[10, 20, undefined, undefined, 'claude-test-model']]);
    });

    it('records reflection-path usage into the optional LLM usage sink when present', async () => {
      const h = buildHarness();
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(
        baseCfg({ everyNTrades: 1, model: 'claude-test-model' }),
        h.deps,
      );

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.usageSinkApi.recorded).toEqual([
        {
          kind: 'reflection',
          model: 'claude-test-model',
          strategyId: SID,
          inputTokens: 10,
          outputTokens: 20,
        },
      ]);
    });

    it('is a no-op when no LLM usage sink is wired (absent ⇒ usage simply goes unpersisted)', async () => {
      const h = buildHarness({ withUsageSink: false });
      h.fetchFn.mockResolvedValue(
        apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      expect(() => service.onClosedTrade(SID, 1)).not.toThrow();
      await flush();

      // The budget/recorder still see usage — only the sink is absent.
      expect(h.budget.snapshot().inputTokens).toBe(10);
      expect(h.usageSinkApi.recorded).toEqual([]);
    });

    it('logs an API error, mints nothing, never throws to the caller, and releases the in-flight guard', async () => {
      const h = buildHarness();
      h.fetchFn.mockRejectedValue(new Error('network down'));
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      expect(() => service.onClosedTrade(SID, 1)).not.toThrow();
      await flush();

      expect(h.storeApi.appended).toHaveLength(0);
      expect(h.logger.messages.some((m) => m.includes('transport error'))).toBe(true);

      // in-flight guard released (finally): a later genuine attempt can still fire.
      h.clock.now += SEVEN_DAYS_MS;
      h.fetchFn.mockRejectedValue(new Error('still down'));
      service.onClosedTrade(SID, 2);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('backlog #31: validator-reject retry-with-feedback + additive trigger rollback', () => {
    const invalidDraft = revisionToolBody({
      playbook: 'not a valid playbook',
      changelog: 'first attempt',
    });
    const validDraft = (tag: string): unknown =>
      revisionToolBody({ playbook: validPlaybookContent(tag), changelog: `fixed: ${tag}` });

    it('retries once with feedback after a first-draft validator rejection, then mints on the accepted retry (2 fetch calls, 2 budget reservations)', async () => {
      const h = buildHarness();
      h.fetchFn
        .mockResolvedValueOnce(apiResponse(invalidDraft))
        .mockResolvedValueOnce(apiResponse(validDraft('retried')));
      const reserveSpy = vi.spyOn(h.budget, 'tryReserveCall');
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.fetchFn).toHaveBeenCalledTimes(2);
      expect(reserveSpy).toHaveBeenCalledTimes(2); // precondition reservation + the retry's own
      expect(h.storeApi.appended).toEqual([
        { content: validPlaybookContent('retried'), source: 'reflection', parentVersion: 1 },
      ]);
      expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
      expect(h.recorderApi.rejections).toEqual([]); // no validator_reject on the accepted retry

      // The retry's assistant turn echoes the first response's FULL ordered content — the signed
      // thinking block verbatim FIRST (mandatory in a tool_result continuation), then the tool_use
      // — and its user turn is a tool_result error referencing the same id with the reason.
      const retryBody = requestBodyOf(h.fetchFn, 1) as unknown as {
        messages: Array<{
          role: string;
          content: string | Array<Record<string, unknown>>;
        }>;
      };
      expect(retryBody.messages).toHaveLength(3);
      const assistantTurn = retryBody.messages[1]!;
      expect(assistantTurn.role).toBe('assistant');
      const assistantBlocks = assistantTurn.content as Array<Record<string, unknown>>;
      expect(assistantBlocks).toHaveLength(2);
      expect(assistantBlocks[0]).toEqual({
        type: 'thinking',
        thinking: 'test-thinking-trace',
        signature: 'sig_test_1',
      });
      expect(assistantBlocks[1]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_test_1',
      });
      const toolResultTurn = retryBody.messages[2]!;
      expect(toolResultTurn.role).toBe('user');
      const toolResultBlock = (toolResultTurn.content as Array<Record<string, unknown>>)[0]!;
      expect(toolResultBlock['type']).toBe('tool_result');
      expect(toolResultBlock['tool_use_id']).toBe('toolu_test_1');
      expect(toolResultBlock['is_error']).toBe(true);
      expect(toolResultBlock['content']).toContain('failed validation');
    });

    it('records a single validator_reject (not two) when the retry is also rejected, and rolls back the trigger', async () => {
      const h = buildHarness();
      h.fetchFn
        .mockResolvedValueOnce(apiResponse(invalidDraft))
        .mockResolvedValueOnce(apiResponse(invalidDraft));
      const service = new ReflectionService(baseCfg({ everyNTrades: 2 }), h.deps);

      service.onClosedTrade(SID, 1);
      service.onClosedTrade(SID, 2); // reaches N=2, launches
      await flush();

      expect(h.fetchFn).toHaveBeenCalledTimes(2);
      expect(h.storeApi.appended).toHaveLength(0);
      expect(h.recorderApi.rejections).toEqual([false]); // recorded once, for the FINAL rejected draft
      expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'validator_reject']);
      expect(
        h.logger.messages.some((m) => m.includes('failed validation') && m.includes('changelog:')),
      ).toBe(true);

      // Rollback: the trigger was additively restored to >= N — the very next closed trade re-fires
      // immediately rather than requiring a fresh N (contrast with the no-rollback suite below).
      service.onClosedTrade(SID, 3);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(3);
    });

    it('skips the retry (and goes straight to a final validator_reject) when the retry budget reservation is exhausted', async () => {
      const h = buildHarness({ budgetCaps: { maxCallsPerDay: 1, maxTokensPerDay: 1_000_000 } });
      h.fetchFn.mockResolvedValueOnce(apiResponse(invalidDraft));
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.fetchFn).toHaveBeenCalledTimes(1); // the reserved-but-exhausted retry never calls out
      expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'validator_reject']);
    });

    it('skips the retry when the tool_use block carries no id (a tool_result cannot reference it — the continuation would 400)', async () => {
      const h = buildHarness();
      const idlessDraft = {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'test-thinking-trace', signature: 'sig_test_1' },
          {
            type: 'tool_use',
            name: 'submit_playbook_revision',
            input: { playbook: 'not a valid playbook', changelog: 'oops' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      };
      h.fetchFn.mockResolvedValueOnce(apiResponse(idlessDraft));
      const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

      service.onClosedTrade(SID, 1);
      await flush();

      expect(h.fetchFn).toHaveBeenCalledTimes(1); // no doomed continuation attempted
      expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'validator_reject']);
      // Trigger still rolled back — the next closed trade re-fires immediately.
      service.onClosedTrade(SID, 2);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(2);
    });

    // Each setup registers exactly one mockResolvedValueOnce/mockRejectedValueOnce call on the
    // given fetchFn — a `setup` callback (rather than a returned Promise/Response) sidesteps
    // @typescript-eslint/no-misused-promises on the untyped vi.fn() mock parameter.
    it.each([
      [
        'transport_error',
        (fetchFn: ReturnType<typeof vi.fn>) =>
          fetchFn.mockRejectedValueOnce(new Error('network down')),
      ],
      [
        'http_error',
        (fetchFn: ReturnType<typeof vi.fn>) =>
          fetchFn.mockResolvedValueOnce(apiResponse({}, { ok: false, status: 500 })),
      ],
      // content must be an array per reflectionResponseSchema — a string fails schema parsing.
      [
        'malformed_envelope',
        (fetchFn: ReturnType<typeof vi.fn>) =>
          fetchFn.mockResolvedValueOnce(apiResponse({ content: 'not-an-array' })),
      ],
      [
        'no_tool_block',
        (fetchFn: ReturnType<typeof vi.fn>) =>
          fetchFn.mockResolvedValueOnce(
            apiResponse({ stop_reason: 'tool_use', content: [], usage: undefined }),
          ),
      ],
      [
        'schema_fail',
        (fetchFn: ReturnType<typeof vi.fn>) =>
          fetchFn.mockResolvedValueOnce(
            apiResponse({
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: 't1', name: 'submit_playbook_revision', input: {} },
              ],
              usage: undefined,
            }),
          ),
      ],
    ] as const)(
      'additively rolls back the trigger on a %s first-call failure — the very next closed trade re-fires immediately',
      async (_label, setup) => {
        const h = buildHarness();
        setup(h.fetchFn);
        const service = new ReflectionService(baseCfg({ everyNTrades: 2 }), h.deps);

        service.onClosedTrade(SID, 1);
        service.onClosedTrade(SID, 2); // reaches N=2, launches
        await flush();
        expect(h.fetchFn).toHaveBeenCalledTimes(1);
        expect(h.storeApi.appended).toHaveLength(0);

        // Rolled back to >= N: the very next closed trade re-fires without needing a fresh N.
        h.fetchFn.mockResolvedValueOnce(apiResponse(validDraft('after-rollback')));
        service.onClosedTrade(SID, 3);
        await flush();
        expect(h.fetchFn).toHaveBeenCalledTimes(2);
      },
    );

    it.each([
      ['minted', () => apiResponse(validDraft('m'))],
      [
        'no_change',
        () =>
          apiResponse(
            revisionToolBody({ playbook: validPlaybookContent('seed'), changelog: 'nc' }),
          ),
      ],
      ['refusal', () => apiResponse({ stop_reason: 'refusal', content: [], usage: undefined })],
    ] as const)(
      'does NOT roll back the trigger on %s — the trigger is legitimately consumed, so a fresh N is required to re-fire',
      async (_label, response) => {
        const h = buildHarness({ seedContent: validPlaybookContent('seed') });
        h.fetchFn.mockResolvedValueOnce(response());
        const service = new ReflectionService(baseCfg({ everyNTrades: 2 }), h.deps);

        service.onClosedTrade(SID, 1);
        service.onClosedTrade(SID, 2); // reaches N=2, launches, consumes the trigger
        await flush();
        expect(h.fetchFn).toHaveBeenCalledTimes(1);

        // No rollback: one more closed trade is below the fresh N=2 floor — does not re-fire.
        // lastAttemptAt was legitimately stamped (not rolled back), so the 7-day cooldown floor
        // must also elapse before the fresh N=2 can fire again.
        h.clock.now += SEVEN_DAYS_MS;
        h.fetchFn.mockResolvedValueOnce(apiResponse(validDraft('later')));
        service.onClosedTrade(SID, 3);
        await flush();
        expect(h.fetchFn).toHaveBeenCalledTimes(1);

        // A second closed trade completes the fresh N=2 — now it re-fires.
        service.onClosedTrade(SID, 4);
        await flush();
        expect(h.fetchFn).toHaveBeenCalledTimes(2);
      },
    );

    it('preserves trades closed during an in-flight attempt: a refusal (no rollback) still carries forward the in-flight count rather than losing it', async () => {
      const h = buildHarness();
      let resolveFetch: (res: Response) => void;
      h.fetchFn.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );
      const service = new ReflectionService(baseCfg({ everyNTrades: 5 }), h.deps);

      service.onClosedTrade(SID, 1);
      service.onClosedTrade(SID, 2);
      service.onClosedTrade(SID, 3);
      service.onClosedTrade(SID, 4);
      service.onClosedTrade(SID, 5); // reaches N=5, launches, resets to 0, in flight
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1);

      // 3 more trades close WHILE the attempt is in flight — blocked from launching a 2nd attempt,
      // but still counted (onClosedTrade increments before checking `inFlight`).
      service.onClosedTrade(SID, 6);
      service.onClosedTrade(SID, 7);
      service.onClosedTrade(SID, 8);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // still just the one in-flight call

      resolveFetch!(apiResponse({ stop_reason: 'refusal', content: [], usage: undefined }));
      await flush();
      expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'refusal']);

      // If the 3 in-flight trades had been lost, 5 fresh closes would be needed to re-fire; since
      // they were preserved, only 2 more (5 - 3) are needed. lastAttemptAt was legitimately stamped
      // (refusal does not roll it back either), so the 7-day cooldown floor must also elapse.
      h.clock.now += SEVEN_DAYS_MS;
      h.fetchFn.mockResolvedValueOnce(apiResponse(validDraft('after-refusal')));
      service.onClosedTrade(SID, 9);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // 1 more (total 8 accrued) — still below 10 needed
      service.onClosedTrade(SID, 10);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(2); // the 2nd of the 2 needed closes fires it
    });
  });
});

describe('createReflectionService', () => {
  it('scrubs the API key under NODE_ENV=test even when ANTHROPIC_API_KEY is present (never call a real LLM from a test run)', async () => {
    const h = buildHarness();
    const service = createReflectionService(
      { ANTHROPIC_API_KEY: 'k', NODE_ENV: 'test', AGENTIC_REFLECTION_EVERY_N_TRADES: '1' },
      h.deps,
    );

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('scrubs the API key under CI even when ANTHROPIC_API_KEY is present', async () => {
    const h = buildHarness();
    const service = createReflectionService(
      { ANTHROPIC_API_KEY: 'k', CI: 'true', AGENTIC_REFLECTION_EVERY_N_TRADES: '1' },
      h.deps,
    );

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('constructs without throwing when env knobs are absent, defaulting everyNTrades/timeoutMs/model', () => {
    const h = buildHarness();
    expect(() => createReflectionService({}, h.deps)).not.toThrow();
  });

  it('threads AGENTIC_REFLECTION_COOLDOWN_MS through to the cooldown gate (F7)', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = createReflectionService(
      {
        ANTHROPIC_API_KEY: 'k',
        AGENTIC_REFLECTION_EVERY_N_TRADES: '1',
        AGENTIC_REFLECTION_COOLDOWN_MS: '1000',
      },
      h.deps,
    );

    service.onClosedTrade(SID, 1);
    await flush();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);

    h.clock.now += 1001; // past the 1s tuned cooldown, far below the 7-day default
    service.onClosedTrade(SID, 2);
    await flush();
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
  });

  // Model precedence: AGENTIC_REFLECTION_MODEL > AGENTIC_MODEL > the shared Sonnet-5 default.
  // Asserted off the actual request body — the only place the choice becomes observable.
  it.each([
    [
      { AGENTIC_REFLECTION_MODEL: 'claude-opus-4-8', AGENTIC_MODEL: 'claude-sonnet-5' },
      'claude-opus-4-8',
    ],
    [{ AGENTIC_MODEL: 'claude-haiku-4-5' }, 'claude-haiku-4-5'],
    [{}, 'claude-sonnet-5'],
  ] as const)('reflection model precedence: %o → %s', async (envOver, expected) => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = createReflectionService(
      { ANTHROPIC_API_KEY: 'k', AGENTIC_REFLECTION_EVERY_N_TRADES: '1', ...envOver },
      h.deps,
    );
    service.onClosedTrade(SID, 1);
    await flush();
    const body = JSON.parse((h.fetchFn.mock.calls[0]![1] as { body: string }).body) as {
      model: string;
    };
    expect(body.model).toBe(expected);
  });

  // X6 (carried from XA5): journal rows inside the 2026-07-16→17 execution-bug window (venue-
  // rejected exits — the outcomes measure the execution defect, not the strategy) never reach any
  // reflection digest. Asserted off the request body: the in-window round trip's prices must be
  // absent while a control round trip outside the window renders normally.
  it('excludes rows inside the 2026-07-16→17 execution-bug window from reflection evidence', async () => {
    const inWindow = Date.UTC(2026, 6, 16, 12);
    const outWindow = Date.UTC(2026, 6, 19, 12);
    const mk = (action: AgentDecisionRow['action'], close: string, at: number, id: string) =>
      row({ action, close, eventTime: epochMs(at), createdAt: epochMs(at), id });
    const h = buildHarness({
      rows: [
        mk('open_long', '111.11', inWindow, 'w1'),
        mk('close', '122.22', inWindow + 60_000, 'w2'),
        mk('open_long', '333.33', outWindow, 'c1'),
        mk('close', '344.44', outWindow + 60_000, 'c2'),
      ],
    });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    const rawBody = (h.fetchFn.mock.calls[0]![1] as { body: string }).body;
    expect(rawBody).toContain('333.33'); // control round trip renders
    expect(rawBody).not.toContain('111.11'); // execution-bug round trip excluded
    expect(rawBody).not.toContain('122.22');
  });

  // The reflection call's abort deadline reads its OWN knob, not the decide timeout — see
  // AGENTIC_REFLECTION_TIMEOUT_MS's schema comment. Asserted off the AbortSignal because the timer is
  // the only place the choice becomes observable (the stalled-body pattern from the detachment suite).
  const stalledSignal = (
    fetchFn: ReturnType<typeof vi.fn>,
  ): (() => AbortSignal | null | undefined) => {
    const capture = (): AbortSignal | null | undefined =>
      (fetchFn.mock.calls[0]?.[1] as unknown as RequestInit | undefined)?.signal;
    fetchFn.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          capture()?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    return capture;
  };

  it('threads AGENTIC_REFLECTION_TIMEOUT_MS through to the reflection abort deadline', async () => {
    vi.useFakeTimers();
    try {
      const h = buildHarness();
      const signal = stalledSignal(h.fetchFn);
      const service = createReflectionService(
        {
          ANTHROPIC_API_KEY: 'k',
          AGENTIC_REFLECTION_EVERY_N_TRADES: '1',
          AGENTIC_REFLECTION_TIMEOUT_MS: '120000',
        },
        h.deps,
      );
      service.onClosedTrade(SID, 1);
      await vi.advanceTimersByTimeAsync(0); // headers resolved; res.json() now the pending await
      expect(signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000); // the old 30s decide timeout — must NOT abort here
      expect(signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(90_000); // reaches the configured 120s
      expect(signal()?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression (2026-07-09): reflection ran Opus + adaptive thinking under the SHARED 30s decide
  // timeout (AGENTIC_TIMEOUT_MS) and aborted every live attempt ("transport error: This operation was
  // aborted"), stranding the learning loop at the v1 seed. The reflection timeout must NOT inherit the
  // decide knob — with only AGENTIC_TIMEOUT_MS set, the call uses the generous reflection default.
  it('does NOT inherit AGENTIC_TIMEOUT_MS: the reflection call is not aborted at the 30s decide timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = buildHarness();
      const signal = stalledSignal(h.fetchFn);
      const service = createReflectionService(
        {
          ANTHROPIC_API_KEY: 'k',
          AGENTIC_REFLECTION_EVERY_N_TRADES: '1',
          AGENTIC_TIMEOUT_MS: '30000', // decide timeout present; NO reflection knob
        },
        h.deps,
      );
      service.onClosedTrade(SID, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000); // well past 30s — the bug would have aborted by now
      expect(signal()?.aborted).toBe(false);
      // Still armed: aborts at the generous reflection default (240s), proving the timer is live.
      await vi.advanceTimersByTimeAsync(180_000);
      expect(signal()?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Realized round-trip evidence + durable trigger seed ─────────────────────

import type {
  ReflectionTriggerSeed,
  RoundTripEvidence,
  RoundTripEvidencePort,
} from '../../../src/ports/promotion';

function evidenceRow(over: Partial<RoundTripEvidence> = {}): RoundTripEvidence {
  return {
    strategyId: 'agentic-1',
    symbol: 'BTC/USDT',
    openedAt: T - 60_000,
    closedAt: T,
    holdingMs: 60_000,
    entryVwap: '100',
    exitVwap: '101',
    boughtQty: '1',
    realizedPnl: '1',
    feesQuote: '0.2',
    netPnl: '0.8',
    meanSlippageBps: '12.50',
    ...over,
  };
}

function fakeEvidence(
  over: Partial<{
    trips: readonly RoundTripEvidence[];
    seed: ReflectionTriggerSeed;
    tripsError: Error;
    seedError: Error;
  }> = {},
): { port: RoundTripEvidencePort; seedCalls: () => number } {
  let seedCalls = 0;
  const port: RoundTripEvidencePort = {
    recentRoundTrips: () =>
      over.tripsError ? Promise.reject(over.tripsError) : Promise.resolve(over.trips ?? []),
    reflectionSeed: () => {
      seedCalls += 1;
      return over.seedError
        ? Promise.reject(over.seedError)
        : Promise.resolve(
            over.seed ?? {
              closedTradesTotal: 0,
              closedSinceLastReflection: 0,
              lastReflectionAt: null,
            },
          );
    },
  };
  return { port, seedCalls: () => seedCalls };
}

function requestBodyOf(
  fetchFn: ReturnType<typeof vi.fn>,
  call = 0,
): {
  system: string;
  messages: Array<{ content: string }>;
} {
  return JSON.parse((fetchFn.mock.calls[call]![1] as { body: string }).body) as {
    system: string;
    messages: Array<{ content: string }>;
  };
}

describe('ReflectionService realized evidence + trigger seeding', () => {
  it('the DB seed revives a redeploy-starved trigger (fires earlier than in-memory counting would)', async () => {
    const h = buildHarness();
    const ev = fakeEvidence({
      seed: { closedTradesTotal: 20, closedSinceLastReflection: 2, lastReflectionAt: null },
    });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 3 }), {
      ...h.deps,
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1); // in-memory 1 of 3; kicks the seed
    await flush(); // seed lands: max(1, 2) = 2
    expect(h.fetchFn).not.toHaveBeenCalled();
    service.onClosedTrade(SID, 2); // 3 of 3 → fires
    await flush();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  // Push 3 P5: first-close seed race fix. The seed used to be fire-and-forget (`void
  // this.seedTriggerState(key).catch(...)`), so THIS triggering close's own threshold check ran
  // against the still-zero/unseeded in-memory counter and could never fire on its own — only a LATER
  // close (after the seed had landed) could. The fix defers the threshold evaluation behind the seed
  // read for exactly this close, so a DB seed that already crosses the threshold fires immediately.
  it('the FIRST post-boot close seeds synchronously and fires the reflection attempt in the SAME invocation', async () => {
    const h = buildHarness();
    // DB truth already shows 2 closed round trips since last reflection by the time this close's
    // seed read resolves (the round-trip evidence row lands before onClosedTrade fires) — under the
    // OLD detached seed, this exact close would evaluate on the unseeded in-memory count (1) and
    // never fire; only a SECOND close would ever observe the landed seed.
    const ev = fakeEvidence({
      seed: { closedTradesTotal: 2, closedSinceLastReflection: 2, lastReflectionAt: null },
    });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 2 }), {
      ...h.deps,
      evidence: ev.port,
    });

    service.onClosedTrade(SID, 1); // in-memory 1 of 2; seeds BEFORE the threshold check runs
    await flush(); // seed lands first: max(1, 2) = 2 >= 2 → fires in this SAME invocation

    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a failed seed logs, falls back to in-memory counters, and retries on the next trade', async () => {
    const h = buildHarness();
    const ev = fakeEvidence({ seedError: new Error('db down') });
    const service = new ReflectionService(baseCfg({ everyNTrades: 10 }), {
      ...h.deps,
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1);
    await flush();
    expect(h.logger.messages.some((m) => m.includes('trigger seed failed'))).toBe(true);
    service.onClosedTrade(SID, 2);
    await flush();
    expect(ev.seedCalls()).toBe(2); // unseeded again after the failure → retried
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  // Push 3 P5 companion: the seed failure must never block the trigger — a broken seed degrades to
  // the unseeded in-memory counter and the threshold is still evaluated (fail-open) on BOTH the
  // seeding close and the retried close, exactly like the pre-seed-feature behavior.
  it('a rejected seed logs + retries on the next close, but the trigger evaluation still runs fail-open on both closes', async () => {
    const h = buildHarness();
    const ev = fakeEvidence({ seedError: new Error('db down') });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      evidence: ev.port,
    });

    // First close: the seed rejects — logged, and the seedState entry is cleared so the NEXT close
    // retries — but the trigger evaluation still runs fail-open on the unseeded in-memory counter
    // (1 >= everyNTrades=1) rather than blocking on the seed failure.
    service.onClosedTrade(SID, 1);
    await flush();
    expect(h.logger.messages.filter((m) => m.includes('trigger seed failed'))).toHaveLength(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);

    // Second close: seedState was cleared, so it retries the seed (rejects again) and STILL evaluates
    // fail-open — a genuine second attempt fires despite the seed never once landing.
    h.clock.now += SEVEN_DAYS_MS; // past the cooldown so the second genuine attempt can fire
    h.fetchFn.mockResolvedValueOnce(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v3'), changelog: 'c2' })),
    );
    service.onClosedTrade(SID, 2);
    await flush();

    expect(h.logger.messages.filter((m) => m.includes('trigger seed failed'))).toHaveLength(2);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a seeded lastReflectionAt arms the cooldown across restarts', async () => {
    const h = buildHarness();
    const ev = fakeEvidence({
      seed: { closedTradesTotal: 5, closedSinceLastReflection: 0, lastReflectionAt: T - 500 },
    });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 2, cooldownMs: 1_000 }), {
      ...h.deps,
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1); // 1 of 2; kicks seed
    await flush();
    service.onClosedTrade(SID, 2); // 2 of 2, but T − (T−500) = 500 < 1000 → cooldown blocks
    await flush();
    expect(h.fetchFn).not.toHaveBeenCalled();
    h.clock.now = T + 600; // now 1100 past the seeded attempt
    service.onClosedTrade(SID, 3);
    await flush();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('folds realizedRoundTrips into the payload and teaches the model to prefer it over proxies', async () => {
    const h = buildHarness();
    const trip = evidenceRow();
    const ev = fakeEvidence({ trips: [trip] });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1);
    await flush();
    const body = requestBodyOf(h.fetchFn);
    expect(body.system).toContain('realizedRoundTrips is DIFFERENT in kind');
    const payload = JSON.parse(body.messages[0]!.content.split('\n\n').at(-1)!) as {
      realizedRoundTrips: RoundTripEvidence[];
    };
    expect(payload.realizedRoundTrips).toEqual([trip]);
  });

  it('evidence failure mid-run degrades to proxies-only and still completes the attempt', async () => {
    const h = buildHarness();
    const ev = fakeEvidence({ tripsError: new Error('db gone'), seedError: new Error('db gone') });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1);
    await flush();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(
      requestBodyOf(h.fetchFn).messages[0]!.content.split('\n\n').at(-1)!,
    ) as { realizedRoundTrips: RoundTripEvidence[] };
    expect(payload.realizedRoundTrips).toEqual([]);
    expect(h.logger.messages.some((m) => m.includes('evidence unavailable'))).toBe(true);
  });

  it('trigger counters are per-strategy (P7): one instance triggering never drains another', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 2, cooldownMs: 0 }), h.deps);
    const otherId = strategyId('agentic-2');
    service.onClosedTrade(SID, 1); // agentic-1: 1 of 2
    service.onClosedTrade(otherId, 1); // agentic-2: 1 of 2 — lane-wide that is 2, but per-strategy neither fires
    await flush();
    expect(h.fetchFn).not.toHaveBeenCalled();
    service.onClosedTrade(SID, 2); // agentic-1 reaches 2 of 2 → fires for agentic-1 only
    await flush();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('scopes the journal read to the triggering strategy (P7)', async () => {
    const h = buildHarness();
    const recentCalls: Array<[number, string | undefined]> = [];
    const journal: AgentDecisionJournalPort = {
      record: () => undefined,
      recent: (limit, sid) => {
        recentCalls.push([limit, sid]);
        return Promise.resolve([]);
      },
    };
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), { ...h.deps, journal });
    service.onClosedTrade(SID, 1);
    await flush();
    expect(recentCalls).toEqual([
      [200, String(SID)], // per-strategy digest read (unchanged)
      // Backlog #39: the mint-time entry-rate floor's own corpus read is deliberately LANE-WIDE
      // (unscoped strategyId) — it wants the newest FLAT-consult rows across every symbol, not one
      // instrument's own recent window (see reflection.service.ts's runMintFloor).
      [400, undefined],
    ]);
  });

  it('the DB closed-trip total floors the auto-promotion count across redeploys', async () => {
    const h = buildHarness();
    const ev = fakeEvidence({
      seed: { closedTradesTotal: 35, closedSinceLastReflection: 1, lastReflectionAt: null },
    });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1, autoPromoteMinTrades: 30 }), {
      ...h.deps,
      evidence: ev.port,
    });
    // In-memory count is 1 (fresh boot) but the DB knows 35 closed trades → promotion proceeds.
    service.onClosedTrade(SID, 1);
    await flush();
    const promotion = h.storeApi.appended.find((a) => a.source === 'promotion');
    expect(promotion).toBeDefined();
    expect(promotion!.content).toContain('after 35 closed trades');
  });
});

describe('X8: per-version net-PnL digest in the reflection payload', () => {
  // fakeJournal (top-level) has no recentVersioned — this local fixture adds it so the version join
  // (promotion-evaluator.ts's own attributeVersion, imported by version-pnl-digest.ts) has decisions
  // to read. Mirrors fakeEvidence's own "extend the default fake with one more field" shape.
  function fakeJournalWithVersions(
    versionedRows: readonly AgentDecisionRow[],
  ): AgentDecisionJournalPort {
    return { ...fakeJournal([]), recentVersioned: () => Promise.resolve(versionedRows) };
  }

  it('attributes fixture trips under two playbook versions into the exact expected table (pinned)', async () => {
    const h = buildHarness();
    const decisions = [
      row({ id: 'd1', playbookVersion: 1, eventTime: epochMs(T - 10_000) }),
      row({ id: 'd2', playbookVersion: 2, eventTime: epochMs(T + 50_000) }),
    ];
    const trips = [
      evidenceRow({ openedAt: T, closedAt: T + 100, netPnl: '5' }), // before the v2 decision → v1
      evidenceRow({ openedAt: T + 1_000, closedAt: T + 2_000, netPnl: '-2' }), // still before → v1
      evidenceRow({ openedAt: T + 60_000, closedAt: T + 61_000, netPnl: '10.5' }), // after → v2
    ];
    const ev = fakeEvidence({ trips });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      journal: fakeJournalWithVersions(decisions),
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1);
    await flush();

    const payload = JSON.parse(
      requestBodyOf(h.fetchFn).messages[0]!.content.split('\n\n').at(-1)!,
    ) as { versionPnl: unknown };
    expect(payload.versionPnl).toEqual({
      rows: [
        { version: 1, trips: 2, netPnlFeesOnly: '3' },
        { version: 2, trips: 1, netPnlFeesOnly: '10.5' },
      ],
      unattributed: { trips: 0, netPnlFeesOnly: '0' },
    });
  });

  it('pre-stamp/legacy trips (journal predates version stamping) land entirely in unattributed', async () => {
    const h = buildHarness();
    const trips = [
      evidenceRow({ openedAt: T, closedAt: T + 100, netPnl: '4' }),
      evidenceRow({ openedAt: T + 1_000, closedAt: T + 2_000, netPnl: '-1' }),
    ];
    const ev = fakeEvidence({ trips });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      journal: fakeJournalWithVersions([]), // no versioned rows at all — every trip predates stamping
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1);
    await flush();

    const payload = JSON.parse(
      requestBodyOf(h.fetchFn).messages[0]!.content.split('\n\n').at(-1)!,
    ) as { versionPnl: unknown };
    expect(payload.versionPnl).toEqual({
      rows: [],
      unattributed: { trips: 2, netPnlFeesOnly: '3' },
    });
  });

  it('a trip whose version join is missing (no versioned decision reaches its symbol/entry) lands in unattributed — fail-to-unknown, never misattributed', async () => {
    const h = buildHarness();
    const decisions = [
      // Only BTC/USDT is stamped; the ETH/USDT trip below has no covering decision at all.
      row({
        id: 'd1',
        playbookVersion: 1,
        symbol: symbolId('BTC/USDT'),
        eventTime: epochMs(T - 10_000),
      }),
    ];
    const attributed = evidenceRow({
      symbol: 'BTC/USDT',
      openedAt: T,
      closedAt: T + 100,
      netPnl: '6',
    });
    const orphan = evidenceRow({
      symbol: 'ETH/USDT',
      openedAt: T,
      closedAt: T + 100,
      netPnl: '-3',
    });
    const ev = fakeEvidence({ trips: [attributed, orphan] });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      journal: fakeJournalWithVersions(decisions),
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1);
    await flush();

    const payload = JSON.parse(
      requestBodyOf(h.fetchFn).messages[0]!.content.split('\n\n').at(-1)!,
    ) as { versionPnl: unknown };
    expect(payload.versionPnl).toEqual({
      rows: [{ version: 1, trips: 1, netPnlFeesOnly: '6' }],
      unattributed: { trips: 1, netPnlFeesOnly: '-3' },
    });
  });

  it('carries the versionPnl table in the request body and the system prompt teaches the model to weigh it', async () => {
    const h = buildHarness();
    const ev = fakeEvidence({ trips: [] });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      journal: fakeJournalWithVersions([]),
      evidence: ev.port,
    });
    service.onClosedTrade(SID, 1);
    await flush();

    const body = requestBodyOf(h.fetchFn);
    expect(body.system).toContain(
      'The versionPnl digest (X8) judges past REVISIONS by realized results',
    );
    const payload = JSON.parse(body.messages[0]!.content.split('\n\n').at(-1)!) as {
      versionPnl: unknown;
    };
    expect(payload.versionPnl).toEqual({
      rows: [],
      unattributed: { trips: 0, netPnlFeesOnly: '0' },
    });
  });
});

describe('unrouted active() read + unresolved-candidate guard (2026-07-12)', () => {
  const okRevision = () =>
    apiResponse(
      revisionToolBody({ playbook: validPlaybookContent('revised'), changelog: 'tweak' }),
    );

  it('bases the revision and parentVersion on the unrouted active() read, never the routed current()', async () => {
    const h = buildHarness();
    h.deps = {
      ...h.deps,
      playbookStore: {
        ...h.storeApi.store,
        // The routed read lies (serves the A/B candidate); the unrouted read tells the truth.
        current: () => Promise.resolve({ version: 9, content: validPlaybookContent('candidate') }),
        active: () => Promise.resolve({ version: 1, content: validPlaybookContent('champion') }),
      },
    };
    h.fetchFn.mockResolvedValue(okRevision());
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toHaveLength(1);
    expect(h.storeApi.appended[0]!.parentVersion).toBe(1);
    const [, init] = h.fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('champion');
    expect(init.body as string).not.toContain('candidate');
  });

  it('skips the mint entirely (no LLM call, trigger preserved) while an unresolved candidate sits in A/B', async () => {
    const h = buildHarness();
    h.deps = {
      ...h.deps,
      playbookStore: {
        ...h.storeApi.store,
        listVersions: () =>
          Promise.resolve([{ version: 2, source: 'reflection', createdAt: T - 1_000 }]),
      },
    };
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.storeApi.appended).toHaveLength(0);
    expect(h.recorderApi.outcomes).toEqual(['skipped_unresolved_candidate']);
  });

  it('mints over a candidate that has LAPSED past candidateLapseMs (deliberate, logged orphaning)', async () => {
    const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
    const h = buildHarness();
    h.deps = {
      ...h.deps,
      playbookStore: {
        ...h.storeApi.store,
        listVersions: () =>
          Promise.resolve([
            { version: 2, source: 'loop-candidate', createdAt: T - THIRTY_ONE_DAYS_MS },
          ]),
      },
    };
    h.fetchFn.mockResolvedValue(okRevision());
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toHaveLength(1);
    expect(h.logger.messages.some((m) => m.includes('lapsed'))).toBe(true);
  });

  it('lapses a provably-abstaining candidate EARLY (≥ abstainLapseDecides attributed decides, zero entries) and mints over it before the age lapse', async () => {
    // 15 candidate-attributed real decides, all holds — the v2 freeze signature (#39 companion).
    const abstainRows = Array.from({ length: 15 }, (_, i) =>
      row({
        id: `v2-hold-${i}`,
        model: 'claude-sonnet-5',
        playbookVersion: 2,
        action: 'hold',
        eventTime: epochMs(T + i),
      }),
    );
    const h = buildHarness({ rows: abstainRows });
    h.deps = {
      ...h.deps,
      playbookStore: {
        ...h.storeApi.store,
        // Candidate is only 1s old — the AGE lapse alone would skip this mint for another week.
        listVersions: () =>
          Promise.resolve([{ version: 2, source: 'reflection', createdAt: T - 1_000 }]),
      },
    };
    h.fetchFn.mockResolvedValue(okRevision());
    // Floor disabled to isolate the lapse path (the abstain rows would otherwise feed the floor's
    // replay too — covered by the #39 floor suite below).
    const service = new ReflectionService(baseCfg({ everyNTrades: 1, mintFloorRows: 0 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toHaveLength(1);
    expect(h.logger.messages.some((m) => m.includes('provably abstains live'))).toBe(true);
    expect(h.recorderApi.outcomes).toContain('minted');
  });

  it('does NOT abstention-lapse a candidate that has entered at least once — the age lapse still governs', async () => {
    const mixedRows = [
      ...Array.from({ length: 14 }, (_, i) =>
        row({
          id: `v2-hold-${i}`,
          model: 'claude-sonnet-5',
          playbookVersion: 2,
          action: 'hold',
          eventTime: epochMs(T + i),
        }),
      ),
      row({
        id: 'v2-entry',
        model: 'claude-sonnet-5',
        playbookVersion: 2,
        action: 'open_long',
        eventTime: epochMs(T + 14),
      }),
    ];
    const h = buildHarness({ rows: mixedRows });
    h.deps = {
      ...h.deps,
      playbookStore: {
        ...h.storeApi.store,
        listVersions: () =>
          Promise.resolve([{ version: 2, source: 'reflection', createdAt: T - 1_000 }]),
      },
    };
    const service = new ReflectionService(baseCfg({ everyNTrades: 1, mintFloorRows: 0 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.storeApi.appended).toHaveLength(0);
    expect(h.recorderApi.outcomes).toEqual(['skipped_unresolved_candidate']);
  });

  it('does NOT abstention-lapse a candidate whose only entries scrolled past the recent() window — lifetime evidence governs (2026-07-17 v2 false-abstention)', async () => {
    // 1 real entry older than the 400-row horizon, then 405 other-version rows + 15 candidate
    // holds — a recent(400) evidence base sees 15 candidate decides and ZERO entries and would
    // lapse a TRADING candidate; the lifetime read must not.
    const rows = [
      row({
        id: 'v2-old-entry',
        model: 'claude-sonnet-5',
        playbookVersion: 2,
        action: 'open_long',
        eventTime: epochMs(T - 10_000),
      }),
      ...Array.from({ length: 405 }, (_, i) =>
        row({
          id: `v1-noise-${i}`,
          model: 'claude-sonnet-5',
          playbookVersion: 1,
          action: 'hold',
          eventTime: epochMs(T + i),
        }),
      ),
      ...Array.from({ length: 15 }, (_, i) =>
        row({
          id: `v2-hold-${i}`,
          model: 'claude-sonnet-5',
          playbookVersion: 2,
          action: 'hold',
          eventTime: epochMs(T + 500 + i),
        }),
      ),
    ];
    const h = buildHarness({ rows });
    h.deps = {
      ...h.deps,
      playbookStore: {
        ...h.storeApi.store,
        listVersions: () =>
          Promise.resolve([{ version: 2, source: 'reflection', createdAt: T - 20_000 }]),
      },
    };
    const service = new ReflectionService(baseCfg({ everyNTrades: 1, mintFloorRows: 0 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.storeApi.appended).toHaveLength(0);
    expect(h.recorderApi.outcomes).toEqual(['skipped_unresolved_candidate']);
  });

  it('treats an abstention-evidence read failure as NOT abstaining — the guard still skips (fail toward preserving the candidate)', async () => {
    const h = buildHarness();
    h.deps = {
      ...h.deps,
      journal: {
        record: () => undefined,
        recent: () => Promise.resolve([]),
        versionEntryStats: () => Promise.reject(new Error('journal down')),
      },
      playbookStore: {
        ...h.storeApi.store,
        listVersions: () =>
          Promise.resolve([{ version: 2, source: 'reflection', createdAt: T - 1_000 }]),
      },
    };
    const service = new ReflectionService(baseCfg({ everyNTrades: 1, mintFloorRows: 0 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.storeApi.appended).toHaveLength(0);
    expect(h.recorderApi.outcomes).toEqual(['skipped_unresolved_candidate']);
    expect(h.logger.messages.some((m) => m.includes('abstention-lapse evidence read failed'))).toBe(
      true,
    );
  });

  it('never abstention-lapses through a journal that lacks versionEntryStats — absence is not evidence', async () => {
    // 15 candidate holds visible via recent() — the pre-fix evidence base — but no lifetime read:
    // the lapse must not fire off the window alone.
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({
        id: `v2-hold-${i}`,
        model: 'claude-sonnet-5',
        playbookVersion: 2,
        action: 'hold',
        eventTime: epochMs(T + i),
      }),
    );
    const h = buildHarness();
    h.deps = {
      ...h.deps,
      journal: { record: () => undefined, recent: () => Promise.resolve(rows) },
      playbookStore: {
        ...h.storeApi.store,
        listVersions: () =>
          Promise.resolve([{ version: 2, source: 'reflection', createdAt: T - 1_000 }]),
      },
    };
    const service = new ReflectionService(baseCfg({ everyNTrades: 1, mintFloorRows: 0 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.storeApi.appended).toHaveLength(0);
    expect(h.recorderApi.outcomes).toEqual(['skipped_unresolved_candidate']);
  });

  it('ignores non-candidate rows and versions at/below active — promotion history never blocks a mint', async () => {
    const h = buildHarness();
    h.deps = {
      ...h.deps,
      playbookStore: {
        ...h.storeApi.store,
        listVersions: () =>
          Promise.resolve([
            { version: 1, source: 'seed', createdAt: T - 5_000 },
            { version: 2, source: 'promotion', createdAt: T - 1_000 },
          ]),
      },
    };
    h.fetchFn.mockResolvedValue(okRevision());
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(h.storeApi.appended).toHaveLength(1);
  });
});

describe('backlog #39: mint-time entry-rate floor', () => {
  const FLOOR_ROWS = 2;

  function floorCfg(over: Partial<ReflectionServiceConfig> = {}): ReflectionServiceConfig {
    return baseCfg({
      everyNTrades: 1,
      mintFloorRows: FLOOR_ROWS,
      mintFloorMinRows: FLOOR_ROWS,
      mintFloorMinEntries: 1,
      ...over,
    });
  }

  it('rejects an abstaining draft through the floor, retries with the floor feedback, abstains again, and records abstain_reject with a rolled-back trigger', async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 20, maxTokensPerDay: 1_000_000 },
      rows: [flatConsultRow(0), flatConsultRow(1)],
    });
    mockDualFetch(
      h.fetchFn,
      [
        revisionToolBody({
          playbook: validPlaybookContent('abstain-1'),
          changelog: 'raise the bar',
        }),
        revisionToolBody({
          playbook: validPlaybookContent('abstain-2'),
          changelog: 'raise it more',
        }),
      ],
      'hold', // the candidate playbook never enters — the floor sees 0 entries on every replay
    );
    const service = new ReflectionService(floorCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toHaveLength(0);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'abstain_reject']);
    expect(
      h.logger.messages.some((m) => m.includes('abstains under the mint-time entry-rate floor')),
    ).toBe(true);

    // Call order: 0 = first reflection draft, 1..FLOOR_ROWS = its floor replay, FLOOR_ROWS+1 = the
    // retry reflection draft — its tool_result must carry the floor's own feedback text.
    const retryBody = requestBodyOf(h.fetchFn, FLOOR_ROWS + 1) as unknown as {
      messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
    };
    const toolResultTurn = retryBody.messages[2]!;
    expect(toolResultTurn.role).toBe('user');
    const toolResultBlock = (toolResultTurn.content as Array<Record<string, unknown>>)[0]!;
    expect(toolResultBlock['content']).toContain('cannot be evaluated or promoted');

    // Rollback: the trigger was additively restored to >= everyNTrades — the very next closed trade
    // re-fires immediately rather than requiring a fresh N (same convention as backlog #31's own
    // rollback tests above).
    h.fetchFn.mockResolvedValue(
      apiResponse({ stop_reason: 'refusal', content: [], usage: undefined }),
    );
    service.onClosedTrade(SID, 2);
    await flush();
    expect(h.recorderApi.outcomes).toEqual([
      'attempt_started',
      'abstain_reject',
      'attempt_started',
      'refusal',
    ]);
  });

  // X6 (A0 re-scope, tier assertion): the reflection DRAFT bills at the REFLECTION model while
  // every floor replay bills at the DECIDE model — a tier mismatch here simulates the Sonnet decide
  // path at Opus pricing (R8-8 demonstrated that cost blast radius at 1/50th of a replay run's
  // scale). Asserted off the actual request bodies, the only place the split becomes observable.
  it('reflection draft carries the reflection model while floor replays carry the decide model', async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 20, maxTokensPerDay: 1_000_000 },
      rows: [flatConsultRow(0), flatConsultRow(1)],
    });
    mockDualFetch(
      h.fetchFn,
      [revisionToolBody({ playbook: validPlaybookContent('enters'), changelog: 'loosen bar' })],
      'open_long',
    );
    const service = new ReflectionService(
      floorCfg({ model: 'claude-opus-4-8', decideModel: 'claude-sonnet-5' }),
      h.deps,
    );

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).toHaveBeenCalledTimes(1 + FLOOR_ROWS);
    const modelOf = (i: number): string =>
      (requestBodyOf(h.fetchFn, i) as unknown as { model: string }).model;
    expect(modelOf(0)).toBe('claude-opus-4-8');
    for (let i = 1; i <= FLOOR_ROWS; i++) {
      expect(modelOf(i)).toBe('claude-sonnet-5');
    }
  });

  it('mints when the replayed floor produces at least one entry', async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 20, maxTokensPerDay: 1_000_000 },
      rows: [flatConsultRow(0), flatConsultRow(1)],
    });
    mockDualFetch(
      h.fetchFn,
      [revisionToolBody({ playbook: validPlaybookContent('enters'), changelog: 'loosen bar' })],
      'open_long',
    );
    const service = new ReflectionService(floorCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: validPlaybookContent('enters'), source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    // 1 reflection draft + FLOOR_ROWS floor replay calls, no retry needed.
    expect(h.fetchFn).toHaveBeenCalledTimes(1 + FLOOR_ROWS);
  });

  it('skips the floor (fail-open) when fewer than mintFloorMinRows FLAT-consult rows qualify, and mints normally', async () => {
    const h = buildHarness({ rows: [flatConsultRow(0)] }); // 1 qualifying row, below FLOOR_ROWS=2
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = new ReflectionService(floorCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: validPlaybookContent('v2'), source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.fetchFn).toHaveBeenCalledTimes(1); // no floor replay calls at all
    expect(h.logger.messages.some((m) => m.includes('corpus too young'))).toBe(true);
  });

  it('fails open (mint proceeds) when every floor replay call fails transport — measurement failure is not abstention', async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 20, maxTokensPerDay: 1_000_000 },
      rows: [flatConsultRow(0), flatConsultRow(1)],
    });
    // Reflection draft succeeds; every floor replay rejects at transport level. measureEntryRate
    // skips failed rows, so consults=0 — the veto must read that as an unmeasurable floor (fail
    // open), never as "0 entries = abstention" (reviewer should-fix, 2026-07-13: a bad decide-model
    // id or an API outage must not mislabel every candidate abstaining and halt learning).
    const impl: typeof fetch = (_url, init) => {
      const parsedBody = JSON.parse(init?.body as string) as { tools: Array<{ name: string }> };
      if (parsedBody.tools[0]!.name === 'submit_playbook_revision') {
        return Promise.resolve(
          apiResponse(
            revisionToolBody({
              playbook: validPlaybookContent('unmeasurable'),
              changelog: 'tweak',
            }),
          ),
        );
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    };
    // Same narrow structural cast as mockDualFetch's param — vi.fn()'s own mockImplementation
    // signature trips no-misused-promises on a `typeof fetch` impl.
    (h.fetchFn as { mockImplementation(i: typeof fetch): unknown }).mockImplementation(impl);
    const service = new ReflectionService(floorCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: validPlaybookContent('unmeasurable'), source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(
      h.logger.messages.some((m) => m.includes('transport/model failure, not abstention')),
    ).toBe(true);
  });

  it('fails open (mint proceeds) when the daily budget is exhausted mid-floor-replay', async () => {
    const h = buildHarness({
      // attempt_started's own reservation already spends the only allowed call — the floor's first
      // per-row reservation then fails immediately.
      budgetCaps: { maxCallsPerDay: 1, maxTokensPerDay: 1_000_000 },
      rows: [flatConsultRow(0), flatConsultRow(1)],
    });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = new ReflectionService(floorCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: validPlaybookContent('v2'), source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.fetchFn).toHaveBeenCalledTimes(1); // the floor never made a single replay call
    expect(h.logger.messages.some((m) => m.includes('entry-floor skipped: budget'))).toBe(true);
  });

  it('is a byte-identical no-op when the floor is disabled (mintFloorRows=0) — legacy mint behavior preserved', async () => {
    const h = buildHarness({ rows: [flatConsultRow(0), flatConsultRow(1)] });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1, mintFloorRows: 0 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: validPlaybookContent('v2'), source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.fetchFn).toHaveBeenCalledTimes(1); // no floor calls whatsoever
  });

  it('createReflectionService defaults the mint floor to rows=12/minRows=6/minEntries=1 (5 rows < default min 6 → floor skipped)', async () => {
    const h = buildHarness({ rows: Array.from({ length: 5 }, (_, i) => flatConsultRow(i)) });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = createReflectionService(
      { ANTHROPIC_API_KEY: 'k', AGENTIC_REFLECTION_EVERY_N_TRADES: '1' },
      h.deps,
    );

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.fetchFn).toHaveBeenCalledTimes(1); // floor skipped (5 qualifying rows < default min 6)
  });
});

// ── Mint-time candidate-vs-champion offline expectancy backtest ────────────────────────────────

interface BacktestDirectivesInput {
  readonly sizeFraction: number;
  readonly entry: { readonly style: 'maker' | 'taker'; readonly offsetBps: number };
  readonly entryValidityBars: number;
  readonly stopLossPct: number;
  readonly takeProfitPct: number;
  readonly maxHoldBars: number;
}

type BacktestAction = 'open_long' | 'open_short' | 'hold';

// A real (model starts 'claude') row carrying a marker + close — regardless-of-action rows (unlike
// flatConsultRow above, the backtest wants the full decision mix, not just FLAT consults).
function backtestRow(id: string, close: string): AgentDecisionRow {
  return row({
    id,
    model: 'claude-sonnet-5',
    close,
    inputPayload: JSON.stringify({ marker: id, position: { side: 'FLAT' } }),
    eventTime: epochMs(T + Number(id.replace(/\D/g, ''))),
  });
}

// P3: v2 submit_trade tool-use response — directives ride at the TOP LEVEL of `input` (not nested
// under a `plan` key, unlike the legacy submit_plan shape this replaces).
function backtestPlanBody(action: BacktestAction, directives?: BacktestDirectivesInput): unknown {
  const isOpen = action === 'open_long' || action === 'open_short';
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_backtest',
        name: 'submit_trade',
        input: { action, ...(isOpen ? directives : {}) },
      },
    ],
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

// Dispatches a shared fetch mock across THREE call kinds: the reflection draft
// (submit_playbook_revision, sequential like mockDualFetch), and the backtest's per-row replay
// (submit_trade) — routed by (a) which playbook block rode in the request (candidate draft vs
// champion `current.content`, distinguished via a tag substring unique to each) and (b) which row's
// `marker` is embedded in the row payload text. `rowResponses` maps rowId -> per-arm action/directives;
// any row absent from the map gets a 'hold' response on both arms.
function mockBacktestFetch(
  fetchFn: { mockImplementation(impl: typeof fetch): unknown },
  reflectionBodies: readonly unknown[],
  candidateTag: string,
  championTag: string,
  rowResponses: Record<
    string,
    {
      candidate: { action: BacktestAction; directives?: BacktestDirectivesInput };
      champion: { action: BacktestAction; directives?: BacktestDirectivesInput };
    }
  >,
): void {
  let reflectionCallIndex = 0;
  const impl: typeof fetch = (_url, init) => {
    const parsedBody = JSON.parse(init?.body as string) as {
      tools: Array<{ name: string }>;
      messages: Array<{ content: string | Array<{ text?: string }> }>;
    };
    if (parsedBody.tools[0]!.name === 'submit_playbook_revision') {
      const body = reflectionBodies[reflectionCallIndex]!;
      reflectionCallIndex += 1;
      return Promise.resolve(apiResponse(body));
    }
    const content = parsedBody.messages[0]!.content as Array<{ text?: string }>;
    const playbookText = content[0]!.text ?? '';
    const rowText = content[1]!.text ?? '';
    const isCandidate = playbookText.includes(candidateTag);
    const isChampion = playbookText.includes(championTag);
    const rowMatch = /"marker":"([^"]+)"/.exec(rowText);
    const rowId = rowMatch?.[1];
    const resp = rowId ? rowResponses[rowId] : undefined;
    if (!resp) return Promise.resolve(apiResponse(backtestPlanBody('hold')));
    const arm = isCandidate ? resp.candidate : isChampion ? resp.champion : undefined;
    return Promise.resolve(apiResponse(backtestPlanBody(arm?.action ?? 'hold', arm?.directives)));
  };
  fetchFn.mockImplementation(impl);
}

describe('mint-time candidate-vs-champion offline expectancy backtest', () => {
  const BT_ROWS = [
    backtestRow('row-0', '100'),
    backtestRow('row-1', '104'),
    backtestRow('row-2', '90'),
  ];

  // Candidate directives: never hits TP by bar1 (tp far away) and stops out on bar2 at 90 → big loss.
  const LOSING_PLAN: BacktestDirectivesInput = {
    sizeFraction: 0.1,
    entry: { style: 'maker', offsetBps: 10 },
    entryValidityBars: 2,
    stopLossPct: 0.02,
    takeProfitPct: 0.1,
    maxHoldBars: 4,
  };
  // Champion directives: TP hits immediately on bar1 (close=104) → clean win.
  const WINNING_PLAN: BacktestDirectivesInput = {
    sizeFraction: 0.1,
    entry: { style: 'maker', offsetBps: 10 },
    entryValidityBars: 2,
    stopLossPct: 0.02,
    takeProfitPct: 0.04,
    maxHoldBars: 4,
  };

  function backtestCfg(over: Partial<ReflectionServiceConfig> = {}): ReflectionServiceConfig {
    return baseCfg({
      everyNTrades: 1,
      mintFloorRows: 0, // isolate the backtest from the (separately-tested) entry-rate floor
      mintBacktestRows: 3,
      mintBacktestMinTrips: 1,
      mintBacktestMarginBps: 10,
      ...over,
    });
  }

  it("rejects a candidate that backtests worse than the champion by more than the margin, retries with both arms' numbers, rejects again, and records expectancy_reject with a rolled-back trigger", async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 20, maxTokensPerDay: 1_000_000 },
      rows: BT_ROWS,
      seedContent: validPlaybookContent('seed-champion-tag'),
    });
    mockBacktestFetch(
      h.fetchFn,
      [
        revisionToolBody({
          playbook: validPlaybookContent('draft-candidate-tag-1'),
          changelog: 'first draft',
        }),
        revisionToolBody({
          playbook: validPlaybookContent('draft-candidate-tag-2'),
          changelog: 'second draft, still worse',
        }),
      ],
      'draft-candidate-tag',
      'seed-champion-tag',
      {
        'row-0': {
          candidate: { action: 'open_long', directives: LOSING_PLAN },
          champion: { action: 'open_long', directives: WINNING_PLAN },
        },
      },
    );
    const service = new ReflectionService(backtestCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toHaveLength(0);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'expectancy_reject']);
    expect(h.logger.messages.some((m) => m.includes('backtested worse than the champion'))).toBe(
      true,
    );
    expect(h.logger.messages.some((m) => m.includes('bps/trip'))).toBe(true);

    // Rollback: the very next closed trade re-fires immediately (same convention as the floor's own
    // rollback test above).
    h.fetchFn.mockResolvedValue(
      apiResponse({ stop_reason: 'refusal', content: [], usage: undefined }),
    );
    service.onClosedTrade(SID, 2);
    await flush();
    expect(h.recorderApi.outcomes).toEqual([
      'attempt_started',
      'expectancy_reject',
      'attempt_started',
      'refusal',
    ]);
  });

  it('mints when the candidate does not trail the champion by more than the margin', async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 20, maxTokensPerDay: 1_000_000 },
      rows: BT_ROWS,
      seedContent: validPlaybookContent('seed-champion-tag'),
    });
    mockBacktestFetch(
      h.fetchFn,
      [
        revisionToolBody({
          playbook: validPlaybookContent('draft-candidate-tag'),
          changelog: 'better',
        }),
      ],
      'draft-candidate-tag',
      'seed-champion-tag',
      {
        'row-0': {
          candidate: { action: 'open_long', directives: WINNING_PLAN },
          champion: { action: 'open_long', directives: LOSING_PLAN },
        },
      },
    );
    const service = new ReflectionService(backtestCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      {
        content: validPlaybookContent('draft-candidate-tag'),
        source: 'reflection',
        parentVersion: 1,
      },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
  });

  it('skips the backtest (fail-open) when no rows qualify (no real-model rows with a recorded close+payload), and mints normally', async () => {
    // model 'stub' (not 'claude'-prefixed) — fails the same real-decide qualifying filter the floor
    // itself applies, just regardless of action.
    const h = buildHarness({ rows: [row({ model: 'stub', close: '100', inputPayload: null })] });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = new ReflectionService(backtestCfg({ mintBacktestRows: 3 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: validPlaybookContent('v2'), source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.fetchFn).toHaveBeenCalledTimes(1); // no backtest replay calls
    expect(h.logger.messages.some((m) => m.includes('no qualifying recorded rows'))).toBe(true);
  });

  it('fails open (mint proceeds) when the daily budget is exhausted mid-backtest reservation', async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 1, maxTokensPerDay: 1_000_000 },
      rows: BT_ROWS,
    });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = new ReflectionService(backtestCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: validPlaybookContent('v2'), source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.fetchFn).toHaveBeenCalledTimes(1); // the backtest never made a single replay call
    expect(h.logger.messages.some((m) => m.includes('mint-backtest skipped: budget'))).toBe(true);
  });

  it('fails open (mint proceeds unbacktested) when simulated round trips fall below mintBacktestMinTrips', async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 20, maxTokensPerDay: 1_000_000 },
      rows: BT_ROWS,
      seedContent: validPlaybookContent('seed-champion-tag'),
    });
    // Both arms hold on every row (rowResponses empty ⇒ every replay defaults to 'hold') — zero
    // simulated round trips on either arm, below mintBacktestMinTrips=1.
    mockBacktestFetch(
      h.fetchFn,
      [
        revisionToolBody({
          playbook: validPlaybookContent('draft-candidate-tag'),
          changelog: 'tweak',
        }),
      ],
      'draft-candidate-tag',
      'seed-champion-tag',
      {},
    );
    const service = new ReflectionService(backtestCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      {
        content: validPlaybookContent('draft-candidate-tag'),
        source: 'reflection',
        parentVersion: 1,
      },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.logger.messages.some((m) => m.includes('too few simulated round trips'))).toBe(true);
  });

  it('is a byte-identical no-op when the backtest is disabled (mintBacktestRows=0) — legacy mint behavior preserved', async () => {
    const h = buildHarness({ rows: BT_ROWS });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = new ReflectionService(backtestCfg({ mintBacktestRows: 0 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: validPlaybookContent('v2'), source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.fetchFn).toHaveBeenCalledTimes(1); // no backtest calls whatsoever
  });

  it('createReflectionService defaults the backtest to rows=0 (disabled) — an unconfigured deployment never doubles LLM spend', async () => {
    const h = buildHarness({ rows: BT_ROWS });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = createReflectionService(
      { ANTHROPIC_API_KEY: 'k', AGENTIC_REFLECTION_EVERY_N_TRADES: '1' },
      h.deps,
    );

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
    expect(h.fetchFn).toHaveBeenCalledTimes(1); // backtest disabled by default
  });

  it('replays the champion arm ONCE per reflection run — the retry reuses the cached champion replays (reviewer finding)', async () => {
    const h = buildHarness({
      budgetCaps: { maxCallsPerDay: 20, maxTokensPerDay: 1_000_000 },
      rows: BT_ROWS,
      seedContent: validPlaybookContent('seed-champion-tag'),
    });
    mockBacktestFetch(
      h.fetchFn,
      [
        revisionToolBody({
          playbook: validPlaybookContent('draft-candidate-tag-1'),
          changelog: 'first draft',
        }),
        revisionToolBody({
          playbook: validPlaybookContent('draft-candidate-tag-2'),
          changelog: 'second draft, still worse',
        }),
      ],
      'draft-candidate-tag',
      'seed-champion-tag',
      {
        'row-0': {
          candidate: { action: 'open_long', directives: LOSING_PLAN },
          champion: { action: 'open_long', directives: WINNING_PLAN },
        },
      },
    );
    const service = new ReflectionService(backtestCfg(), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'expectancy_reject']);

    // Replay calls force submit_trade and carry exactly one arm's playbook block: the champion arm
    // ran once (3 rows) across BOTH gate evaluations, while the candidate arm ran twice (3 + 3).
    const replayBodies = h.fetchFn.mock.calls
      .map((c) => {
        const body = (c[1] as { body?: unknown } | undefined)?.body;
        return typeof body === 'string' ? body : '';
      })
      .filter((b) => b.includes('submit_trade'));
    const championReplays = replayBodies.filter((b) => b.includes('seed-champion-tag'));
    const candidateReplays = replayBodies.filter((b) => b.includes('draft-candidate-tag'));
    expect(championReplays).toHaveLength(BT_ROWS.length);
    expect(candidateReplays).toHaveLength(BT_ROWS.length * 2);
  });

  // NOTE (reviewer finding, throw fail-open): runMintBacktest wraps runCandidateBacktest in a
  // fail-open try/catch. A journal-level malformed close CANNOT reach that wrap in this harness —
  // earlier evidence machinery (summarize/reconstruct paths) converts every recent row's close
  // first and runReflection's own outer catch absorbs it ('run failed'), a pre-existing conversion
  // order outside this change's scope. The wrap's raw hazard (runCandidateBacktest throwing on a
  // malformed forward close) is pinned where it IS reachable: candidate-backtest.spec.ts.
});

// ── P3: weekly reflection trigger + regretDigest + shorts-aware mint gate ────────────────────────

describe('P3: checkWeeklyReflectionTrigger', () => {
  it('a quiet week (no trade trigger) fires exactly one scheduled reflection', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('weekly'), changelog: 'q' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 100 }), h.deps); // trade trigger never fires

    service.checkWeeklyReflectionTrigger(SID);
    await flush();
    expect(h.storeApi.appended).toHaveLength(1);

    // Same UTC-week bucket — a second check in the same week must NOT fire again.
    service.checkWeeklyReflectionTrigger(SID);
    await flush();
    expect(h.storeApi.appended).toHaveLength(1);

    // A week later, the bucket advances — fires again.
    h.clock.now += 7 * 24 * 60 * 60 * 1000;
    service.checkWeeklyReflectionTrigger(SID);
    await flush();
    expect(h.storeApi.appended).toHaveLength(2);
  });

  it('a busy week (trade trigger already fired) fires none extra', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('busy'), changelog: 'q' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1); // trade-count trigger fires first
    await flush();
    expect(h.storeApi.appended).toHaveLength(1);

    // Same UTC-week bucket as the trade-triggered attempt — the weekly check must no-op.
    service.checkWeeklyReflectionTrigger(SID);
    await flush();
    expect(h.storeApi.appended).toHaveLength(1);
  });

  it('never checks any precondition when inert (everyNTrades 0 or no apiKey)', async () => {
    const h = buildHarness();
    const stateSpy = vi.spyOn(h.deps.killSwitch!, 'state');
    const service = new ReflectionService(baseCfg({ everyNTrades: 0 }), h.deps);

    service.checkWeeklyReflectionTrigger(SID);
    await flush();

    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(stateSpy).not.toHaveBeenCalled();
  });

  it('W6 regression (2026-07-20): a blocked weekly fire is consumed — no per-bar re-fire loop', async () => {
    // runReflection's non-consuming exits (here: budget_deferred, XA2's pre-flight) leave lastAttemptAt
    // un-advanced by design for the trade path; the weekly path must still burn its
    // week-bucket ON FIRE or every subsequent per-bar check re-enters runReflection
    // (live: 91 Opus calls / $2.3 in 46 min against an abstention-lapsed candidate).
    const h = buildHarness({ budgetCaps: { maxCallsPerDay: 0, maxTokensPerDay: 1_000_000 } });
    const service = new ReflectionService(baseCfg({ everyNTrades: 100 }), h.deps);

    service.checkWeeklyReflectionTrigger(SID);
    await flush();
    expect(h.recorderApi.outcomes).toEqual(['budget_deferred']);

    for (let bar = 0; bar < 50; bar += 1) {
      h.clock.now += 60_000;
      service.checkWeeklyReflectionTrigger(SID);
    }
    await flush();
    expect(h.recorderApi.outcomes).toEqual(['budget_deferred']);

    // Next UTC week: eligible again — blocked weekly attempts retry next week, not next bar.
    h.clock.now += 7 * 24 * 60 * 60 * 1000;
    service.checkWeeklyReflectionTrigger(SID);
    await flush();
    expect(h.recorderApi.outcomes).toEqual(['budget_deferred', 'budget_deferred']);
  });
});

describe('P3: regretDigest in the reflection payload', () => {
  it('includes the not-taken-option regret digest (P4 scoreNotTakenOptions) in the request body', async () => {
    const rows: AgentDecisionRow[] = [
      row({ action: 'hold', close: '100', eventTime: epochMs(T) }), // declined entry
      row({ action: 'hold', close: '110', eventTime: epochMs(T + 1000) }), // t+1 for the row above
    ];
    const h = buildHarness({ rows });
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'tweak' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    const body = requestBodyOf(h.fetchFn);
    expect(body.system).toContain('regretDigest scores the OPTION NOT TAKEN');
    const userContent = body.messages[0]!.content;
    const payload = JSON.parse(userContent.slice(userContent.indexOf('{"closedTrades"'))) as {
      regretDigest?: { declinedEntry: { count: number; meanRegretBps: number | null } };
    };
    expect(payload.regretDigest).toBeDefined();
    // A hold that stayed FLAT while price ran +10% reads as a declined entry with negative regret
    // (directionalEdge(FLAT, fwd) = -fwd) — see counterfactual-scoring.ts's scoreNotTakenOptions.
    expect(payload.regretDigest!.declinedEntry.count).toBe(1);
    expect(payload.regretDigest!.declinedEntry.meanRegretBps).toBeLessThan(0);
  });
});

describe('P3: shorts-aware mint gate (validatePlaybook shortsAllowed/leverageAllowed threading)', () => {
  const SHORTS_PLAYBOOK = validPlaybookContent('shorts-ok').replace(
    'entry shorts-ok',
    'entry shorts-ok — go short into exhaustion at resistance',
  );

  it('rejects shorts prose on the spot lane (shortsEnabled false, the default)', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: SHORTS_PLAYBOOK, changelog: 'shorts idea' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toHaveLength(0);
    expect(h.recorderApi.outcomes).toContain('validator_reject');
  });

  it('passes shorts prose on the perp lane (shortsEnabled true)', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: SHORTS_PLAYBOOK, changelog: 'shorts idea' })),
    );
    const service = new ReflectionService(
      baseCfg({ everyNTrades: 1, shortsEnabled: true }),
      h.deps,
    );

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toEqual([
      { content: SHORTS_PLAYBOOK, source: 'reflection', parentVersion: 1 },
    ]);
    expect(h.recorderApi.outcomes).toEqual(['attempt_started', 'minted']);
  });
});

// ── Backlog #32 (reflection SSE streaming) + #50 (run_failed outcome + rollback) ─────────────────

describe('backlog #32/#50: SSE streaming + run_failed rollback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function sseResponse(
    events: readonly unknown[],
    opts: { hang?: boolean; signal?: AbortSignal | null } = {},
  ): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const evt of events) {
          const type = (evt as { type?: string }).type ?? 'message';
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`));
        }
        if (opts.hang) {
          // Mirrors real fetch: aborting the request signal errors a pending body read.
          opts.signal?.addEventListener('abort', () =>
            controller.error(new Error('This operation was aborted')),
          );
        } else {
          controller.close();
        }
      },
    });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
      },
      body,
    } as unknown as Response;
  }

  // The full streamed shape of a signed-thinking + tool_use response: thinking text and signature
  // arrive as deltas, the tool input arrives split across TWO input_json_delta chunks, and the
  // final output_tokens arrives only in message_delta — the reassembly must stitch all of it.
  function sseEventsForDraft(input: unknown): unknown[] {
    const json = JSON.stringify(input);
    const mid = Math.floor(json.length / 2);
    return [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'sse-thinking-' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'trace' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_sse_1' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_sse_1', name: 'submit_playbook_revision' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: json.slice(0, mid) },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: json.slice(mid) },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } },
      { type: 'message_stop' },
    ];
  }

  it('mints from a streamed response: split input_json_delta reassembles the tool input, usage carries message_start input and message_delta output tokens', async () => {
    const h = buildHarness();
    const draft = { playbook: validPlaybookContent('sse-mint'), changelog: 'streamed tweak' };
    h.fetchFn.mockResolvedValue(sseResponse(sseEventsForDraft(draft)));
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toHaveLength(1);
    expect(h.storeApi.appended[0]!.content).toBe(draft.playbook);
    expect(h.recorderApi.outcomes).toContain('minted');
    expect(h.recorderApi.tokens[0]).toEqual([10, 25, undefined, undefined, 'claude-test-model']);
  });

  it('the #31 retry echoes the STREAMED thinking block (text + signature stitched from deltas) and the tool_use id verbatim in the assistant turn', async () => {
    const h = buildHarness();
    const invalid = { playbook: 'not a valid playbook', changelog: 'bad' };
    const valid = { playbook: validPlaybookContent('sse-retry'), changelog: 'fixed' };
    h.fetchFn
      .mockResolvedValueOnce(sseResponse(sseEventsForDraft(invalid)))
      .mockResolvedValueOnce(sseResponse(sseEventsForDraft(valid)));
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((h.fetchFn.mock.calls[1]![1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(retryBody.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'sse-thinking-trace', signature: 'sig_sse_1' },
        {
          type: 'tool_use',
          id: 'toolu_sse_1',
          name: 'submit_playbook_revision',
          input: invalid,
        },
      ],
    });
    expect(retryBody.messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_sse_1', is_error: true }],
    });
    expect(h.storeApi.appended).toHaveLength(1);
    expect(h.recorderApi.outcomes).toContain('minted');
  });

  it('a stream that stalls mid-body aborts on the IDLE timer, classifies transport_error, and rolls back the trigger (the very next closed trade re-fires)', async () => {
    vi.useFakeTimers();
    const h = buildHarness();
    // Same narrow structural cast as mockDualFetch's param — vi.fn()'s own mockImplementation
    // signature is void-typed, which trips no-misused-promises on a Promise-returning impl.
    const impl: typeof fetch = (_url, init) =>
      Promise.resolve(
        sseResponse(
          [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
          { hang: true, signal: init?.signal },
        ),
      );
    (h.fetchFn as { mockImplementation(i: typeof fetch): unknown }).mockImplementation(impl);
    const service = new ReflectionService(baseCfg({ everyNTrades: 2, timeoutMs: 5000 }), h.deps);

    service.onClosedTrade(SID, 1);
    service.onClosedTrade(SID, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000); // idle-gap budget elapses with no further chunk
    expect(h.recorderApi.outcomes).toContain('transport_error');

    // Rolled back: the very next closed trade re-fires without a fresh N.
    h.fetchFn.mockResolvedValue(
      sseResponse(
        sseEventsForDraft({ playbook: validPlaybookContent('recovered'), changelog: 'ok' }),
      ),
    );
    service.onClosedTrade(SID, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('#50: a throw AFTER the trigger consume (journal down) records run_failed and rolls back — the very next closed trade re-fires', async () => {
    const h = buildHarness();
    const service = new ReflectionService(baseCfg({ everyNTrades: 2 }), {
      ...h.deps,
      journal: { record: () => undefined, recent: () => Promise.reject(new Error('db down')) },
    });

    service.onClosedTrade(SID, 1);
    service.onClosedTrade(SID, 2); // reaches N=2, consumes the trigger, then journal.recent throws
    await flush();

    expect(h.recorderApi.outcomes).toContain('attempt_started');
    expect(h.recorderApi.outcomes).toContain('run_failed');
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.logger.messages.some((m) => m.includes('run failed after trigger consume'))).toBe(
      true,
    );

    // Rolled back: one more closed trade re-fires immediately (attempt_started twice).
    service.onClosedTrade(SID, 3);
    await flush();
    expect(h.recorderApi.outcomes.filter((outcome) => outcome === 'attempt_started')).toHaveLength(
      2,
    );
  });

  it('a JSON (non-stream) response still parses through the legacy path — test doubles and stream-stripping proxies keep working', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('json'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    expect(h.storeApi.appended).toHaveLength(1);
    expect(h.recorderApi.outcomes).toContain('minted');
  });

  it('every reflection request body carries stream: true', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('s'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), h.deps);

    service.onClosedTrade(SID, 1);
    await flush();

    const sent = JSON.parse((h.fetchFn.mock.calls[0]![1] as RequestInit).body as string) as {
      stream?: boolean;
    };
    expect(sent.stream).toBe(true);
  });
});

// R1 historical-replay harness: reflection consumes synthetic (replay-<runId>) experience ONLY under
// the explicit opt-in, and only ever as a clearly-labeled, separate digest source.
describe('ReflectionService R1 synthetic-experience opt-in', () => {
  const syntheticRow = row({
    id: 'replay-r1',
    strategyId: strategyId('replay-run1'),
    model: 'claude-sonnet-5',
    action: 'open_long',
    playbookVersion: null,
  });

  it('default (opt-in absent) never reads recentSynthetic and omits the synthetic digest — byte-identical prompt', async () => {
    const h = buildHarness();
    const recentSynthetic = vi.fn(() => Promise.resolve([syntheticRow]));
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    // Journal exposes recentSynthetic, but the opt-in is OFF ⇒ it must never be called.
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      journal: { ...h.deps.journal!, recentSynthetic },
    });
    service.onClosedTrade(SID, 1);
    await flush();

    expect(recentSynthetic).not.toHaveBeenCalled();
    const payload = JSON.parse(
      requestBodyOf(h.fetchFn).messages[0]!.content.split('\n\n').at(-1)!,
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('syntheticExperience');
  });

  it('opt-in ON folds a CLEARLY-LABELED synthetic digest, kept apart from the live-evidence digests', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      journal: { ...h.deps.journal!, recentSynthetic: () => Promise.resolve([syntheticRow]) },
      syntheticExperience: true,
    });
    service.onClosedTrade(SID, 1);
    await flush();

    const payload = JSON.parse(
      requestBodyOf(h.fetchFn).messages[0]!.content.split('\n\n').at(-1)!,
    ) as { syntheticExperience?: { source?: string; rows?: number } };
    expect(payload.syntheticExperience?.source).toBe('REPLAY_SIMULATION_NOT_LIVE_EVIDENCE');
    expect(payload.syntheticExperience?.rows).toBe(1);
  });

  it('opt-in ON with no synthetic rows omits the digest (nothing to label)', async () => {
    const h = buildHarness();
    h.fetchFn.mockResolvedValue(
      apiResponse(revisionToolBody({ playbook: validPlaybookContent('v2'), changelog: 'c' })),
    );
    const service = new ReflectionService(baseCfg({ everyNTrades: 1 }), {
      ...h.deps,
      journal: { ...h.deps.journal!, recentSynthetic: () => Promise.resolve([]) },
      syntheticExperience: true,
    });
    service.onClosedTrade(SID, 1);
    await flush();

    const payload = JSON.parse(
      requestBodyOf(h.fetchFn).messages[0]!.content.split('\n\n').at(-1)!,
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('syntheticExperience');
  });
});
