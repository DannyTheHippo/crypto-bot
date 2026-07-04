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
} from '../../../src/modules/agentic-strategy/reflection.service';
import {
  DailyLlmBudget,
  type DailyLlmBudgetCaps,
} from '../../../src/modules/agentic-strategy/agent-budget';
import type {
  AgentDecisionJournalPort,
  AgentDecisionRow,
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
    id: '1',
    createdAt: epochMs(T),
    ...overrides,
  };
}

function killSwitchWithState(state: KillSwitchState): KillSwitchPort {
  return {
    state: () => state,
    engage: () => undefined,
    confirmCancels: () => undefined,
    cancelTimeout: () => undefined,
    allFlat: () => undefined,
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
  return { record: () => undefined, recent: () => Promise.resolve(rows) };
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

function fakeRecorder(): { recorder: ReflectionMetricsRecorder; rejections: boolean[] } {
  const rejections: boolean[] = [];
  return { recorder: { recordValidatorRejection: (b) => void rejections.push(b) }, rejections };
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
    content: [{ type: 'tool_use', name: 'submit_playbook_revision', input }],
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

interface Harness {
  deps: ReflectionServiceDeps;
  fetchFn: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof warnLogger>;
  storeApi: ReturnType<typeof fakePlaybookStore>;
  recorderApi: ReturnType<typeof fakeRecorder>;
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
  } = {},
): Harness {
  const clock = { now: T };
  const nowFn = () => clock.now;
  const fetchFn = vi.fn();
  const logger = warnLogger();
  const storeApi = fakePlaybookStore(opts.seedContent ?? validPlaybookContent('seed'));
  const recorderApi = fakeRecorder();
  const budget = new DailyLlmBudget(
    opts.budgetCaps ?? { maxCallsPerDay: 10, maxTokensPerDay: 1_000_000 },
    nowFn,
  );
  const deps: ReflectionServiceDeps = {
    budget,
    playbookStore: storeApi.store,
    journal: fakeJournal(opts.rows ?? []),
    recorder: recorderApi.recorder,
    killSwitch: killSwitchWithState(opts.killSwitchState ?? 'RUNNING'),
    registry: registryWithLifecycle(opts.lifecycle ?? 'ACTIVE'),
    fetchFn,
    nowFn,
    logger,
  };
  return { deps, fetchFn, logger, storeApi, recorderApi, budget, clock };
}

describe('reconstructClosedTrades', () => {
  it('pairs a LONG entry with the next FLAT exit into a closed-trade summary', () => {
    const rows = [
      row({ action: 'long', refPrice: '100', eventTime: epochMs(T) }),
      row({ action: 'flat', refPrice: '110', eventTime: epochMs(T + 1000) }),
    ];
    expect(reconstructClosedTrades(rows, 10)).toEqual([
      { entryTime: T, exitTime: T + 1000, entryPrice: 100, exitPrice: 110, pnlPct: 10 },
    ]);
  });

  it('ignores a repeated long row while a trade is already open (hold re-affirmation, not a new entry)', () => {
    const rows = [
      row({ action: 'long', refPrice: '100', eventTime: epochMs(T) }),
      row({ action: 'long', refPrice: '105', eventTime: epochMs(T + 500) }),
      row({ action: 'flat', refPrice: '110', eventTime: epochMs(T + 1000) }),
    ];
    expect(reconstructClosedTrades(rows, 10)).toEqual([
      { entryTime: T, exitTime: T + 1000, entryPrice: 100, exitPrice: 110, pnlPct: 10 },
    ]);
  });

  it('keeps only the most recent maxTrades', () => {
    const rows: AgentDecisionRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(row({ action: 'long', refPrice: '100', eventTime: epochMs(T + i * 10_000) }));
      rows.push(
        row({ action: 'flat', refPrice: '110', eventTime: epochMs(T + i * 10_000 + 5000) }),
      );
    }
    expect(reconstructClosedTrades(rows, 2)).toHaveLength(2);
  });
});

describe('summarizeHolds', () => {
  it('returns a zeroed summary when there are no hold rows', () => {
    expect(summarizeHolds([row({ action: 'long' })])).toEqual({
      count: 0,
      spanMs: 0,
      meanConfidence: null,
    });
  });

  it('computes count/span/meanConfidence over hold rows only', () => {
    const rows = [
      row({ action: 'hold', confidence: 0.2, eventTime: epochMs(T) }),
      row({ action: 'long', confidence: 0.9, eventTime: epochMs(T + 100) }),
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

      service.onClosedTrade(SID, 3);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // N reached, lastAttemptAt=0 floor trivially satisfied

      service.onClosedTrade(SID, 4);
      service.onClosedTrade(SID, 5);
      service.onClosedTrade(SID, 6);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(1); // N reached again, but floor not yet elapsed

      h.clock.now += SEVEN_DAYS_MS;
      service.onClosedTrade(SID, 7);
      await flush();
      expect(h.fetchFn).toHaveBeenCalledTimes(2); // floor elapsed — fires again
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

      h.clock.now += SEVEN_DAYS_MS + 60_000; // past the floor too, so ONLY in-flight blocks this
      service.onClosedTrade(SID, 2);
      await flush();

      expect(h.fetchFn).toHaveBeenCalledTimes(1); // still just 1 — never queued
      expect(h.logger.messages.some((m) => m.includes('already in flight'))).toBe(true);
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
      expect(h.logger.messages.some((m) => m.includes('run failed'))).toBe(true);

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
});
