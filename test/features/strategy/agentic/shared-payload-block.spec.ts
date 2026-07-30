// Batch shared-payload block (2026-07-30). payloadExtrasProvider is called ONCE per batch, but its
// result used to be spread into EVERY symbol element, so an 8-symbol wave sent 8 copies of the same
// portfolio/budget/calendar/execQuality/fundingAccrualQuote blocks. They now ride in ONE shared
// block ahead of the symbol blocks.
//
// The two contracts this file exists to hold:
//  1. The partition is exact — `full === { ...shared, ...symbolOnly }` key-for-key, asserted against
//     the REAL renderer (recorded-payload-fixtures.ts cannot serve here: it is a hand-maintained
//     mirror of literal strings, already covering 11 of the 34 emitted keys, and it never calls
//     buildMarketPayload at all).
//  2. The JOURNAL stays whole — AgentProposal.inputPayload is the FULL render, so rows recorded after
//     this split carry every block rows recorded before it carry. The frozen corpus stays
//     self-comparable and the replay harnesses (entry-rate-floor.ts, candidate-backtest.ts) keep
//     seeing complete rows.
import { describe, it, expect, vi } from 'vitest';
import {
  buildMarketPayload,
  buildSharedPayload,
  type BuildMarketPayloadExtras,
} from '../../../../src/features/strategy/agentic/agent-prompt';
import {
  AnthropicAgentClient,
  type AnthropicAgentClientConfig,
  type AgentPayloadExtras,
} from '../../../../src/features/strategy/agentic/anthropic-agent-client';
import type {
  AgentContext,
  AgentDecisionInput,
  AgentMarketSnapshot,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { FearGreedSnapshot } from '../../../../src/ports/strategy/fear-greed-feed';
import type {
  CandleEvent,
  OrderBookSnapshotEvent,
  TickerEvent,
} from '../../../../src/domain/venue/types/market-events';
import { price, qty } from '../../../../src/domain/common/types/money';
import { epochMs, strategyId, symbolId, venueId } from '../../../../src/domain/common/types/ids';

const T = 1_700_000_000_000;
const V = venueId('binance');
// A realistic wave: the deployed batch is one element per TRADING_SYMBOLS entry.
const BATCH_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'AAVE/USDT', 'UNI/USDT'] as const;

function candles(symbolStr: string, n: number): CandleEvent[] {
  const symbol = symbolId(symbolStr);
  return Array.from({ length: n }, (_, i) => {
    const t = T + i * 900_000;
    return {
      kind: 'CANDLE',
      venue: V,
      symbol,
      channel: 'candle:15m',
      seq: BigInt(i + 1),
      eventTime: epochMs(t),
      ingestTime: epochMs(t + 1),
      interval: '15m',
      openTime: epochMs(t),
      closeTime: epochMs(t + 900_000),
      open: price(String(1000.12345 + i)),
      high: price(String(1004.5678 + i)),
      low: price(String(996.4321 + i)),
      close: price(String(1002.98765 + i)),
      volume: qty(String(812_093 + i)),
      closed: true,
    } satisfies CandleEvent;
  });
}

function ticker(symbolStr: string): TickerEvent {
  const symbol = symbolId(symbolStr);
  return {
    kind: 'TICKER',
    venue: V,
    symbol,
    channel: 'ticker',
    seq: 1n,
    eventTime: epochMs(T),
    ingestTime: epochMs(T + 1),
    bid: price('1002.4'),
    ask: price('1003.1'),
    last: price('1002.75'),
  };
}

function book(symbolStr: string): OrderBookSnapshotEvent {
  const symbol = symbolId(symbolStr);
  const level = (
    p: number,
    q: number,
  ): { price: ReturnType<typeof price>; qty: ReturnType<typeof qty> } => ({
    price: price(String(p)),
    qty: qty(String(q)),
  });
  return {
    kind: 'ORDER_BOOK_SNAPSHOT',
    venue: V,
    symbol,
    channel: 'book',
    seq: 1n,
    eventTime: epochMs(T),
    ingestTime: epochMs(T + 1),
    bids: [
      level(1002.4, 3.1),
      level(1002.3, 5.2),
      level(1002.2, 1.4),
      level(1002.1, 8.9),
      level(1002.0, 2.2),
    ],
    asks: [
      level(1003.1, 2.8),
      level(1003.2, 4.6),
      level(1003.3, 1.1),
      level(1003.4, 7.3),
      level(1003.5, 3.9),
    ],
  };
}

const FEAR_GREED: FearGreedSnapshot = {
  asOf: epochMs(T),
  value: 61,
  classification: 'Greed',
  trend: 'rising',
};

function context(symbolStr: string): AgentContext {
  return {
    indicators: {
      lastClose: 1002.98,
      emaFast: 1001.4,
      emaSlow: 998.2,
      rsi14: 57.3,
      atr14: 6.14,
      ret1: 0.0012,
      ret5: 0.0041,
      ret20: 0.0173,
    },
    position: {
      side: 'FLAT',
      qty: '0',
      avgEntry: null,
      realizedPnl: '0',
      unrealizedPnlPct: null,
      openOrders: 0,
    },
    recentDecisions: [],
    // Per-symbol by construction — the rank/ownReturnPct differ per element, so this must NEVER be
    // hoisted into the shared block.
    crossSymbol: {
      rank: 2,
      of: 5,
      ownReturnPct: '1.73',
      strongest: { symbol: 'SOL/USDT', returnPct: '3.10' },
      weakest: { symbol: 'UNI/USDT', returnPct: '-2.04' },
    },
    // Realized round trips are filtered by strategyId and there is one instance per symbol — the
    // differing tripCount below is what makes hoisting this unsound.
    trackRecord: {
      tripCount: symbolStr === 'BTC/USDT' ? 31 : 12,
      winRate: 0.42,
      meanNetBpsPerTrip: -3.1,
      trailingWindowTrips: 40,
    },
  };
}

function buildInput(symbolStr: string, i: number): AgentDecisionInput {
  const symbol = symbolId(symbolStr);
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(T),
    candles: new Map([[symbol, candles(symbolStr, 30)]]),
    tickers: new Map([[symbol, ticker(symbolStr)]]),
    books: new Map([[symbol, book(symbolStr)]]),
    execReports: [],
    portfolio: { strategyId: strategyId(`agentic-${i + 1}`), positions: new Map(), openOrders: [] },
    fearGreed: FEAR_GREED,
    // Per-symbol trailing window (LiquidationFeedPort.latest(symbol)) — differing counts here pin
    // that the shared block never absorbs it.
    liquidation: {
      asOf: epochMs(T),
      windowMin: 60,
      liqNotionalUsd: 12_500 + i * 900,
      longShareOfLiqs: 0.62,
      count: 5 + i,
    },
  };
  return {
    strategyId: strategyId(`agentic-${i + 1}`),
    trigger: { kind: 'candle', event: candles(symbolStr, 30)[29]! },
    snapshot,
    context: context(symbolStr),
  };
}

// Sized off the live journal (2026-07-30): portfolio ≈900B, budget ≈152B, calendar ≈14B,
// fundingAccrualQuote ≈27B per rendered element.
const PAYLOAD_EXTRAS: AgentPayloadExtras = {
  portfolio: {
    cappedEquity: '1000.00',
    freeQuote: '412.338291',
    grossExposure: '587.661709',
    positions: [
      { symbol: 'BTC/USDT', side: 'LONG', qty: '0.00184', notional: '203.114' },
      { symbol: 'ETH/USDT', side: 'LONG', qty: '0.0611', notional: '191.223' },
      { symbol: 'SOL/USDT', side: 'LONG', qty: '1.204', notional: '193.325' },
    ],
    correlation: { btcBeta: 0.87, summary: 'basket tracks BTC closely over the trailing window' },
    perVenue: [
      { venue: 'binance', freeCash: '262.11', capitalShare: '0.60', headroom: '58.44' },
      { venue: 'binanceusdm', freeCash: '150.22', capitalShare: '0.40', headroom: '31.09' },
    ],
  },
  budget: {
    remainingCallsToday: 231,
    remainingTokensToday: 1_418_902,
    remainingUsdToday: '4.1183',
    approxCostPerConsultUsd: '0.0192',
  },
  calendar: [{ name: 'FOMC minutes', atMs: T + 3_600_000, importance: 'high' }],
  execQuality: 'maker fill 61% (n=44) · missed-entry cost 4.1bps · post-fill drift +1.8bps',
  fundingAccrualQuote: '-0.418293014',
};

function elementExtras(symbolStr: string): BuildMarketPayloadExtras {
  return {
    ...PAYLOAD_EXTRAS,
    fearGreed: FEAR_GREED,
    constraints: { tickSize: price('0.01'), lotStep: qty('0.0001'), minNotional: price('10') },
    capabilities: {
      venue: venueId('binance'),
      shorts: false,
      leverage: '1',
      maxSizeFraction: '0.25',
      venueFreeCash: '412.338291',
    },
    currentThesis: symbolStr === 'BTC/USDT' ? 'trend continuation off the 4h base' : undefined,
  };
}

function apiResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (): string | null => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function baseCfg(over: Partial<AnthropicAgentClientConfig> = {}): AnthropicAgentClientConfig {
  return {
    apiKey: 'sk-ant-super-secret-test-key',
    model: 'claude-test-model',
    timeoutMs: 5000,
    maxTokens: 512,
    signalTtlMs: 30_000,
    baseUrl: 'https://mock.anthropic.test',
    payloadExtrasProvider: () => PAYLOAD_EXTRAS,
    ...over,
  };
}

// The four sections validatePlaybook requires — an invalid playbook is treated as absent, which
// would silently drop the very block this file asserts the shared block sits after.
const PLAYBOOK_CONTENT = [
  '## regime notes',
  'ranging',
  '## entry rules',
  'prefer maker entries',
  '## exit rules',
  'honour the declared stop',
  '## mistakes to avoid',
  'chasing extended moves',
].join('\n');

function holdBody(symbols: readonly string[]): unknown {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        name: 'submit_portfolio',
        input: {
          decisions: symbols.map((symbol) => ({ symbol, action: 'hold' })),
          nextConsultBars: 8,
        },
      },
    ],
  };
}

interface SentRequest {
  readonly system: unknown;
  readonly messages: readonly { readonly content: readonly { readonly text: string }[] }[];
}

function sentBody(fetchFn: ReturnType<typeof vi.fn>): SentRequest {
  const init = fetchFn.mock.calls[0]![1] as { body: string };
  return JSON.parse(init.body) as SentRequest;
}

describe('shared batch payload block', () => {
  it('partitions the payload exactly: full === { ...shared, ...symbolOnly }, key-for-key', () => {
    const input = buildInput('BTC/USDT', 0);
    const extras = elementExtras('BTC/USDT');

    const full = JSON.parse(buildMarketPayload(input, extras)) as Record<string, unknown>;
    const shared = JSON.parse(buildSharedPayload(extras)!) as Record<string, unknown>;
    const symbolOnly = JSON.parse(
      buildMarketPayload(input, extras, { omitShared: true }),
    ) as Record<string, unknown>;

    expect({ ...shared, ...symbolOnly }).toEqual(full);
    // Disjoint AND exhaustive — neither block may duplicate a key, and nothing may be lost between
    // them (a plain deep-equal above would survive a key silently rendered into BOTH blocks).
    expect(Object.keys(shared).filter((k) => k in symbolOnly)).toEqual([]);
    expect([...Object.keys(shared), ...Object.keys(symbolOnly)].sort()).toEqual(
      Object.keys(full).sort(),
    );
  });

  it('hoists exactly the batch-invariant keys, and leaves every per-symbol key behind', () => {
    const extras = elementExtras('BTC/USDT');
    const shared = JSON.parse(buildSharedPayload(extras)!) as Record<string, unknown>;

    expect(Object.keys(shared).sort()).toEqual([
      'budget',
      'calendar',
      'execQuality',
      'fearGreed',
      'fundingAccrualQuote',
      'portfolio',
    ]);

    const symbolOnly = JSON.parse(
      buildMarketPayload(buildInput('BTC/USDT', 0), extras, { omitShared: true }),
    ) as Record<string, unknown>;
    // Verified per-symbol against 86 recorded + 16 live multi-symbol waves — see sharedFields' own
    // comment in agent-prompt.ts for why each of these is NOT batch-invariant.
    for (const key of ['liquidation', 'trackRecord', 'crossSymbol', 'capabilities', 'position']) {
      expect(symbolOnly).toHaveProperty(key);
    }
  });

  it('omitShared drops NOTHING when the caller supplied no shared extras (single-symbol path)', () => {
    const input = buildInput('BTC/USDT', 0);
    const extras: BuildMarketPayloadExtras = {
      constraints: { tickSize: price('0.01'), lotStep: qty('0.0001'), minNotional: price('10') },
    };

    expect(buildSharedPayload(extras)).toBeNull();
    expect(buildMarketPayload(input, extras, { omitShared: true })).toBe(
      buildMarketPayload(input, extras),
    );
  });

  it('falls back to the snapshot fear&greed when extras carries none — recorded-row replays stay byte-identical', () => {
    const input = buildInput('BTC/USDT', 0);
    const withoutExtra = JSON.parse(buildMarketPayload(input, {})) as Record<string, unknown>;

    expect(withoutExtra['fearGreed']).toEqual({
      value: 61,
      classification: 'Greed',
      trend: 'rising',
    });
  });

  it('CORPUS GUARD: the journalled payload key set is unchanged by the split', async () => {
    const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdBody(BATCH_SYMBOLS)));
    const client = new AnthropicAgentClient(baseCfg(), fetchFn);

    const { proposals } = await client.proposeBatch(BATCH_SYMBOLS.map(buildInput));

    // The exact key set a pre-split row carried for this fixture. Frozen literally: this is the
    // guard that keeps the frozen corpus self-comparable, so it must fail if a block ever silently
    // stops being journalled.
    const expected = [
      'symbol',
      'interval',
      'eventTime',
      'candles',
      'ticker',
      'constraints',
      'capabilities',
      'orderBook',
      'fearGreed',
      'liquidation',
      'crossSymbol',
      'trackRecord',
      'portfolio',
      'budget',
      'calendar',
      'execQuality',
      'fundingAccrualQuote',
      'indicators',
      'htf',
      'position',
      'recentDecisions',
      'execReportsSinceLastDecide',
    ].sort();

    expect(proposals.size).toBe(BATCH_SYMBOLS.length);
    for (const symbol of BATCH_SYMBOLS) {
      const journalled = proposals.get(symbol)!.inputPayload;
      expect(Object.keys(JSON.parse(journalled!) as object).sort()).toEqual(expected);
    }
  });

  it('sends the shared block ONCE, after the playbook block, and strips its keys from every symbol block', async () => {
    const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdBody(BATCH_SYMBOLS)));
    const client = new AnthropicAgentClient(baseCfg(), fetchFn, undefined, {
      current: () => Promise.resolve({ version: 7, content: PLAYBOOK_CONTENT }),
    });

    await client.proposeBatch(BATCH_SYMBOLS.map(buildInput));

    const blocks = sentBody(fetchFn).messages[0]!.content;
    // playbook, shared, 5 symbol blocks, completeness reminder.
    expect(blocks).toHaveLength(BATCH_SYMBOLS.length + 3);
    expect(blocks[0]!.text).toContain('prefer maker entries');
    expect(blocks[1]!.text).toContain('Batch-wide context');
    expect(blocks.filter((b) => b.text.includes('Batch-wide context'))).toHaveLength(1);

    for (let i = 0; i < BATCH_SYMBOLS.length; i += 1) {
      const wire = blocks[i + 2]!.text;
      expect(wire).toContain(`Symbol ${i + 1} of ${BATCH_SYMBOLS.length}`);
      for (const key of ['"portfolio"', '"budget"', '"calendar"', '"execQuality"', '"fearGreed"']) {
        expect(wire).not.toContain(key);
      }
      // Per-symbol blocks still carry their own per-symbol context.
      expect(wire).toContain('"liquidation"');
      expect(wire).toContain('"trackRecord"');
    }
  });

  it('MEASURED: a wave sheds N copies of the shared keys and pays for one shared block', async () => {
    const inputs = BATCH_SYMBOLS.map(buildInput);
    const sharedBytes = buildSharedPayload(elementExtras('BTC/USDT'))!.length;

    // Every element sheds the same amount: its `"key":value` text for each shared key, plus that
    // key's separating comma. Summed, that is the shared block's own JSON minus its outer braces and
    // internal commas plus one comma per key — i.e. exactly `sharedBytes - 1`, wherever in the full
    // payload the keys happened to sit.
    for (const [i, input] of inputs.entries()) {
      const extras = elementExtras(BATCH_SYMBOLS[i]!);
      const full = buildMarketPayload(input, extras).length;
      const wire = buildMarketPayload(input, extras, { omitShared: true }).length;
      expect(full - wire).toBe(sharedBytes - 1);
    }

    // The wave pays for ONE shared block instead of N inlined copies.
    const waveSaving = BATCH_SYMBOLS.length * (sharedBytes - 1) - sharedBytes;
    expect(waveSaving).toBeGreaterThan(0);
    // Sanity floor on this fixture's live-sized extras, so a future change that quietly stops
    // hoisting the biggest block (portfolio) fails here rather than reading as a smaller win.
    expect(waveSaving / BATCH_SYMBOLS.length).toBeGreaterThan(700);

    // And the real request the client actually sent is smaller than the same wave rebuilt under the
    // pre-split composition (full payload per symbol, no shared block, same framing).
    const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdBody(BATCH_SYMBOLS)));
    await new AnthropicAgentClient(baseCfg(), fetchFn).proposeBatch(inputs);
    const sent = sentBody(fetchFn).messages[0]!.content;
    const after = sent.map((b) => b.text.length).reduce((a, b) => a + b, 0);
    const preSplit =
      inputs
        .map(
          (input, i) =>
            `${i === 0 ? '' : '\n\n'}Symbol ${i + 1} of ${inputs.length} (${BATCH_SYMBOLS[i]!}):\n${buildMarketPayload(input, elementExtras(BATCH_SYMBOLS[i]!))}`
              .length,
        )
        .reduce((a, b) => a + b, 0) + sent[sent.length - 1]!.text.length;
    expect(after).toBeLessThan(preSplit);
  });

  it('FAILS OPEN: a lane-wide block the batch disagrees on stays per-symbol', async () => {
    const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdBody(BATCH_SYMBOLS)));
    const client = new AnthropicAgentClient(baseCfg(), fetchFn);
    const inputs = BATCH_SYMBOLS.map(buildInput);
    // One element polled a fresher reading mid-window.
    const dissenting: AgentDecisionInput = {
      ...inputs[2]!,
      snapshot: { ...inputs[2]!.snapshot, fearGreed: { ...FEAR_GREED, value: 58 } },
    };

    await client.proposeBatch([inputs[0]!, inputs[1]!, dissenting, inputs[3]!, inputs[4]!]);

    const blocks = sentBody(fetchFn).messages[0]!.content;
    const sharedText = blocks.find((b) => b.text.includes('Batch-wide context'))!.text;
    expect(sharedText).not.toContain('"fearGreed"');
    // No reading is lost: every element still renders its own.
    for (let i = 0; i < BATCH_SYMBOLS.length; i += 1) {
      expect(blocks[i + 1]!.text).toContain('"fearGreed"');
    }
  });
});
