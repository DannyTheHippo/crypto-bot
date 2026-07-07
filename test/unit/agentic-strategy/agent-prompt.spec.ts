import { describe, it, expect } from 'vitest';
import {
  DECISION_TOOL,
  PLAYBOOK_BLOCK_START,
  PLAYBOOK_BLOCK_END,
  PROMPT_TEMPLATE_VERSION,
  buildMarketPayload,
  buildSystemPrompt,
  buildUserMessage,
  computePromptHash,
} from '../../../src/features/trading/agentic/agent-prompt';
import type {
  AgentDecisionInput,
  AgentContext,
  AgentMarketSnapshot,
  AgentTradingProfile,
} from '../../../src/ports/agentic-strategy';
import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
} from '../../../src/domain/types/market-events';
import type { ExecReport } from '../../../src/domain/types/exec-report';
import { price, qty } from '../../../src/domain/types/money';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
} from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

function candle(index: number): CandleEvent {
  const t = T + index * 60_000;
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: SYM,
    channel: 'candle:1m',
    seq: BigInt(index + 1),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '1m',
    openTime: epochMs(t),
    closeTime: epochMs(t + 60_000),
    open: price(String(1000 + index)),
    high: price(String(1001 + index)),
    low: price(String(999 + index)),
    close: price(String(1000.5 + index)),
    volume: qty('1'),
    closed: true,
  };
}

function ticker(): TickerEvent {
  return {
    kind: 'TICKER',
    venue: V,
    symbol: SYM,
    channel: 'ticker',
    seq: 1n,
    eventTime: epochMs(T),
    ingestTime: epochMs(T + 1),
    bid: price('99.5'),
    ask: price('100.5'),
    last: price('100'),
  };
}

function book(
  over: { bids?: [string, string][]; asks?: [string, string][] } = {},
): OrderBookSnapshotEvent {
  const bids = over.bids ?? [
    ['100', '1'],
    ['99.5', '2'],
  ];
  const asks = over.asks ?? [
    ['100.5', '1'],
    ['101', '2'],
  ];
  return {
    kind: 'ORDER_BOOK_SNAPSHOT',
    venue: V,
    symbol: SYM,
    channel: 'book',
    seq: 1n,
    eventTime: epochMs(T),
    ingestTime: epochMs(T + 1),
    bids: bids.map(([p, q]) => ({ price: price(p), qty: qty(q) })),
    asks: asks.map(([p, q]) => ({ price: price(p), qty: qty(q) })),
  };
}

function execReport(): ExecReport {
  return {
    reportId: 'r1',
    clientOrderId: clientOrderId('cbp0000000000000007000800000000000000'),
    venue: V,
    symbol: SYM,
    eventTime: epochMs(T),
    ingestTime: epochMs(T),
    kind: 'ACK',
    venueOrderId: 'v1',
  };
}

function fixtureProfile(over: Partial<AgentTradingProfile> = {}): AgentTradingProfile {
  return {
    makerBps: '8',
    takerBps: '12',
    baseNotional: '75',
    maxOrderNotional: '300',
    constraints: {
      tickSize: price('0.01'),
      lotStep: qty('0.0001'),
      minNotional: price('10'),
    },
    ...over,
  };
}

function buildInput(
  opts: {
    candles?: CandleEvent[];
    ticker?: TickerEvent;
    book?: OrderBookSnapshotEvent;
    context?: AgentContext;
    execReports?: ExecReport[];
  } = {},
): AgentDecisionInput {
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(T),
    candles: opts.candles ? new Map([[SYM, opts.candles]]) : new Map(),
    tickers: opts.ticker ? new Map([[SYM, opts.ticker]]) : new Map(),
    books: opts.book ? new Map([[SYM, opts.book]]) : new Map(),
    execReports: opts.execReports ?? [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
  };
  return {
    strategyId: SID,
    trigger: { kind: 'candle', event: candle(0) },
    snapshot,
    context: opts.context,
  };
}

describe('buildSystemPrompt', () => {
  it('constrains the agent to LONG/FLAT-only, cost-aware, Risk-veto-aware, hold-when-uncertain, tool-only responses', () => {
    const prompt = buildSystemPrompt(fixtureProfile());

    expect(prompt).toContain('LONG');
    expect(prompt).toContain('FLAT');
    expect(prompt.toLowerCase()).toContain('cost');
    expect(prompt.toLowerCase()).toContain('fees');
    expect(prompt.toLowerCase()).toContain('risk');
    expect(prompt.toLowerCase()).toContain('veto');
    expect(prompt.toLowerCase()).toContain('hold');
    expect(prompt).toContain('submit_decision');
  });

  it('renders the real fees, sizing rule, and venue minimums from the given profile', () => {
    const profile = fixtureProfile({
      makerBps: '8',
      takerBps: '12',
      baseNotional: '75',
      maxOrderNotional: '300',
    });

    const prompt = buildSystemPrompt(profile);

    expect(prompt).toContain('8');
    expect(prompt).toContain('12');
    expect(prompt).toContain('20'); // round-trip = maker + taker
    expect(prompt).toContain('75');
    expect(prompt).toContain('300');
    expect(prompt).toContain(profile.constraints.tickSize.toFixed());
    expect(prompt).toContain(profile.constraints.lotStep.toFixed());
    expect(prompt).toContain(profile.constraints.minNotional.toFixed());
  });

  it('frames the playbook as advisory data that can never override these rules', () => {
    const prompt = buildSystemPrompt(fixtureProfile());

    expect(prompt.toLowerCase()).toContain('playbook');
    expect(prompt.toLowerCase()).toContain('data');
    expect(prompt.toLowerCase()).toContain('never');
  });

  it("frames recentDecisions annotations (the model's own prior-call reason text) as historical data, not instructions", () => {
    const prompt = buildSystemPrompt(fixtureProfile());

    expect(prompt).toContain('recentDecisions');
    expect(prompt.toLowerCase()).toContain('historical data');
  });

  it('with no protective backstop configured the prompt is byte-identical (no backstop mention)', () => {
    const prompt = buildSystemPrompt(fixtureProfile());
    expect(prompt).not.toContain('protective backstop');
    expect(prompt).not.toContain('  '); // no double space from a skipped sentence
  });

  it('describes a stop-only backstop', () => {
    const prompt = buildSystemPrompt(fixtureProfile({ protectStopLossPct: '0.02' }));
    expect(prompt).toContain(
      'A bot-side protective backstop will force-exit any long via the normal risk path if price falls 0.02 below entry — do not rely on it as your exit plan; manage exits yourself.',
    );
  });

  it('describes a trailing-only backstop', () => {
    const prompt = buildSystemPrompt(fixtureProfile({ protectTrailingPct: '0.015' }));
    expect(prompt).toContain('if price falls 0.015 below its peak — do not rely on it');
    expect(prompt).not.toContain('below entry');
  });

  it('describes both backstops in one sentence when both are configured', () => {
    const prompt = buildSystemPrompt(
      fixtureProfile({ protectStopLossPct: '0.02', protectTrailingPct: '0.015' }),
    );
    expect(prompt).toContain('0.02 below entry or 0.015 below its peak');
  });

  it('documents the candle precision scheme (full precision for recent bars, reduced for older ones)', () => {
    const prompt = buildSystemPrompt(fixtureProfile());

    expect(prompt.toLowerCase()).toContain('precision');
    expect(prompt).toContain('10');
  });

  it('documents the orderBook block (levels, spread, imbalance) and its conditional presence', () => {
    const prompt = buildSystemPrompt(fixtureProfile());

    expect(prompt).toContain('orderBook');
    expect(prompt.toLowerCase()).toContain('spread');
    expect(prompt.toLowerCase()).toContain('imbalance');
  });
});

describe('buildUserMessage', () => {
  it('produces a JSON-parseable string when no playbook is supplied', () => {
    const raw = buildUserMessage(buildInput());

    expect(() => {
      JSON.parse(raw);
    }).not.toThrow();
  });

  it('caps candles at the last 30 when more are supplied, keeping the newest window', () => {
    const candles = Array.from({ length: 60 }, (_, i) => candle(i));
    const payload = JSON.parse(buildUserMessage(buildInput({ candles }))) as {
      candles: [number, string, string, string, string, string][];
    };

    expect(payload.candles).toHaveLength(30);
    const first = payload.candles[0]!;
    const expectedFirst = candles[30]!; // 60 - 30 = 30: the 31st candle is the oldest kept
    expect(first[0]).toBe(expectedFirst.openTime);
  });

  it('encodes the newest 10 candles in the window at full decimal precision, never floats', () => {
    // Index 59 is the newest of 60 — within the last-10-full-precision slice of the 30-wide window.
    const closeStr = '1000.123456789';
    const c: CandleEvent = { ...candle(59), close: price(closeStr) };
    const candles = [...Array.from({ length: 59 }, (_, i) => candle(i)), c];
    const payload = JSON.parse(buildUserMessage(buildInput({ candles }))) as {
      candles: [number, string, string, string, string, string][];
    };
    const [, , , , close] = payload.candles[payload.candles.length - 1]!;

    expect(close).toBe(closeStr);
    expect(typeof close).toBe('string');
  });

  it('reduces candles older than the newest 10 (within the 30-wide window) to 6 significant digits', () => {
    // Index 30 lands at the oldest-kept position (60 - 30 = 30 dropped, so index 30 is the oldest of
    // the 30-wide window) and is well outside the last-10-full-precision slice.
    const closeStr = '1000.123456789';
    const candles = Array.from({ length: 60 }, (_, i) =>
      i === 30 ? { ...candle(i), close: price(closeStr) } : candle(i),
    );
    const payload = JSON.parse(buildUserMessage(buildInput({ candles }))) as {
      candles: [number, string, string, string, string, string][];
    };
    const [, , , , close] = payload.candles[0]!; // the oldest kept candle, index 30 pre-slice

    expect(close).toBe('1000.12'); // 6 significant digits, exact Decimal rounding — not the full string
    expect(close).not.toBe(closeStr);
  });

  it('serializes the ticker as exact decimal strings when present, or null when absent', () => {
    const withTicker = JSON.parse(buildUserMessage(buildInput({ ticker: ticker() }))) as {
      ticker: { bid: string; ask: string; last: string } | null;
    };
    expect(withTicker.ticker).toEqual({ bid: '99.5', ask: '100.5', last: '100' });

    const withoutTicker = JSON.parse(buildUserMessage(buildInput())) as { ticker: unknown };
    expect(withoutTicker.ticker).toBeNull();
  });

  it('passes indicators, htf, and position straight through from context', () => {
    const context: AgentContext = {
      indicators: {
        lastClose: 100,
        emaFast: 99,
        emaSlow: 98,
        rsi14: 55,
        atr14: 1,
        ret1: 0.1,
        ret5: 0.5,
        ret20: 1,
      },
      position: {
        side: 'LONG',
        qty: '2',
        avgEntry: '90',
        realizedPnl: '5',
        unrealizedPnlPct: 10,
        openOrders: 1,
      },
      recentDecisions: [{ eventTime: epochMs(T), action: 'long', close: 100, reason: 'r' }],
      htf: {
        h1: { emaFast: 101, emaSlow: 99, rsi14: 60 },
        h4: null,
      },
    };
    const payload = JSON.parse(buildUserMessage(buildInput({ context }))) as {
      indicators: unknown;
      htf: unknown;
      position: unknown;
    };

    expect(payload.indicators).toEqual(context.indicators);
    expect(payload.htf).toEqual(context.htf);
    expect(payload.position).toEqual(context.position);
  });

  it('defaults indicators/htf/position to null and recentDecisions to [] with no context', () => {
    const payload = JSON.parse(buildUserMessage(buildInput())) as {
      indicators: unknown;
      htf: unknown;
      position: unknown;
      recentDecisions: unknown[];
    };

    expect(payload.indicators).toBeNull();
    expect(payload.htf).toBeNull();
    expect(payload.position).toBeNull();
    expect(payload.recentDecisions).toEqual([]);
  });

  it('maps execReportsSinceLastDecide to only {kind, eventTime}, dropping other fields', () => {
    const report = execReport();
    const payload = JSON.parse(buildUserMessage(buildInput({ execReports: [report] }))) as {
      execReportsSinceLastDecide: Array<Record<string, unknown>>;
    };

    expect(payload.execReportsSinceLastDecide).toEqual([{ kind: 'ACK', eventTime: T }]);
    expect(payload.execReportsSinceLastDecide[0]).not.toHaveProperty('reportId');
    expect(payload.execReportsSinceLastDecide[0]).not.toHaveProperty('clientOrderId');
  });

  describe('recentDecisions rendering (merged decision + outcome, one block)', () => {
    it('renders each decision as a single human-readable line, with outcome appended once known', () => {
      const context: AgentContext = {
        indicators: null,
        position: {
          side: 'FLAT',
          qty: '0',
          avgEntry: null,
          realizedPnl: '0',
          unrealizedPnlPct: null,
          openOrders: 0,
        },
        recentDecisions: [
          {
            eventTime: epochMs(T - 120_000),
            action: 'long',
            close: 43125.1,
            reason: 'r1',
            outcome: { priceMovePct: 0.42, positionPnlDelta: '3.10', heldDuring: 'LONG' },
          },
          { eventTime: epochMs(T - 60_000), action: 'hold', close: 43200, reason: 'r2' }, // no outcome yet
        ],
      };
      const payload = JSON.parse(buildUserMessage(buildInput({ context }))) as {
        recentDecisions: string[];
      };

      expect(payload.recentDecisions).toHaveLength(2);
      const [annotated, unannotated] = payload.recentDecisions;

      expect(annotated).toContain('2 decisions ago');
      expect(annotated).toContain('long');
      expect(annotated).toContain('43125.1');
      expect(annotated).toContain('+0.42%');
      expect(annotated).toContain('+3.10');
      expect(annotated).toContain('USDT');
      expect(annotated).toContain('held long');

      expect(unannotated).toContain('1 decision ago');
      expect(unannotated).toContain('hold');
      expect(unannotated).not.toContain('→'); // no outcome arrow yet
    });

    it('renders "flat" for a decision annotated while the strategy held no position', () => {
      const context: AgentContext = {
        indicators: null,
        position: {
          side: 'FLAT',
          qty: '0',
          avgEntry: null,
          realizedPnl: '0',
          unrealizedPnlPct: null,
          openOrders: 0,
        },
        recentDecisions: [
          {
            eventTime: epochMs(T - 60_000),
            action: 'hold',
            close: 100,
            reason: 'r',
            outcome: { priceMovePct: 2, positionPnlDelta: '0', heldDuring: 'FLAT' },
          },
        ],
      };
      const payload = JSON.parse(buildUserMessage(buildInput({ context }))) as {
        recentDecisions: string[];
      };

      expect(payload.recentDecisions[0]).toContain('(flat)');
      expect(payload.recentDecisions[0]).not.toContain('held long');
    });

    it('signs a negative price move and PnL delta without a double sign', () => {
      const context: AgentContext = {
        indicators: null,
        position: {
          side: 'FLAT',
          qty: '0',
          avgEntry: null,
          realizedPnl: '0',
          unrealizedPnlPct: null,
          openOrders: 0,
        },
        recentDecisions: [
          {
            eventTime: epochMs(T - 60_000),
            action: 'long',
            close: 100,
            reason: 'r',
            outcome: { priceMovePct: -1.5, positionPnlDelta: '-2.5', heldDuring: 'FLAT' },
          },
        ],
      };
      const payload = JSON.parse(buildUserMessage(buildInput({ context }))) as {
        recentDecisions: string[];
      };

      expect(payload.recentDecisions[0]).toContain('-1.50%');
      expect(payload.recentDecisions[0]).toContain('-2.5');
      expect(payload.recentDecisions[0]).not.toContain('+-');
    });

    it('renders "n/a" (never the literal NaN) when priceMovePct is null', () => {
      const context: AgentContext = {
        indicators: null,
        position: {
          side: 'FLAT',
          qty: '0',
          avgEntry: null,
          realizedPnl: '0',
          unrealizedPnlPct: null,
          openOrders: 0,
        },
        recentDecisions: [
          {
            eventTime: epochMs(T - 60_000),
            action: 'hold',
            close: NaN,
            reason: 'no candle yet',
            outcome: { priceMovePct: null, positionPnlDelta: '0', heldDuring: 'FLAT' },
          },
        ],
      };
      const raw = buildUserMessage(buildInput({ context }));
      const payload = JSON.parse(raw) as { recentDecisions: string[] };

      expect(payload.recentDecisions[0]).toContain('n/a');
      expect(raw).not.toContain('NaN');
    });
  });

  describe('order book rendering', () => {
    it('renders top-5 bid/ask levels as exact strings, spread in bps, and a bid/ask imbalance ratio', () => {
      const b = book({
        bids: [
          ['100', '1'],
          ['99.5', '2'],
        ],
        asks: [
          ['100.5', '1'],
          ['101', '1'],
        ],
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ book: b }))) as {
        orderBook: {
          bids: [string, string][];
          asks: [string, string][];
          spreadBps: number;
          imbalance: number;
        } | null;
      };

      expect(payload.orderBook).not.toBeNull();
      const ob = payload.orderBook!;
      expect(ob.bids).toEqual([
        ['100', '1'],
        ['99.5', '2'],
      ]);
      expect(ob.asks).toEqual([
        ['100.5', '1'],
        ['101', '1'],
      ]);
      // Reference-grade floats (not money): asserted with exact equality against the SAME float
      // expression the builder evaluates — 0.5, 100.25, and 1.5 are all binary-exact doubles.
      // mid = 100.25, spread = 0.5 -> bps = 0.5/100.25*10000 ≈ 49.875
      expect(ob.spreadBps).toBe((0.5 / 100.25) * 10_000);
      // bid qty 1+2=3, ask qty 1+1=2 -> imbalance 1.5
      expect(ob.imbalance).toBe(1.5);
      for (const [price_, qty_] of [...ob.bids, ...ob.asks]) {
        expect(typeof price_).toBe('string');
        expect(typeof qty_).toBe('string');
      }
    });

    it('caps rendered levels at 5 per side even when the book is deeper', () => {
      const deepLevels: [string, string][] = Array.from({ length: 8 }, (_, i) => [
        String(100 - i),
        '1',
      ]);
      const b = book({ bids: deepLevels, asks: deepLevels });
      const payload = JSON.parse(buildUserMessage(buildInput({ book: b }))) as {
        orderBook: { bids: unknown[]; asks: unknown[] } | null;
      };

      expect(payload.orderBook!.bids).toHaveLength(5);
      expect(payload.orderBook!.asks).toHaveLength(5);
    });

    it('omits the orderBook key entirely (no empty scaffolding) when no book snapshot is available', () => {
      const raw = buildUserMessage(buildInput());
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('orderBook');
      expect(raw).not.toContain('spreadBps');
    });
  });

  describe('playbook block', () => {
    it('omits the playbook block entirely when no playbook content is supplied', () => {
      const raw = buildUserMessage(buildInput(), {});

      expect(raw).not.toContain(PLAYBOOK_BLOCK_START);
      expect(() => {
        JSON.parse(raw);
      }).not.toThrow();
    });

    it('quotes the playbook inside the delimiters, before the JSON market context, framed as data not instructions', () => {
      const playbookContent =
        '## regime notes\ntrending\n## entry rules\nx\n## exit rules\ny\n## mistakes to avoid\nz';
      const raw = buildUserMessage(buildInput(), { playbookContent });

      const startIdx = raw.indexOf(PLAYBOOK_BLOCK_START);
      const endIdx = raw.indexOf(PLAYBOOK_BLOCK_END);
      const jsonStartIdx = raw.indexOf('{');
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      expect(jsonStartIdx).toBeGreaterThan(endIdx);
      expect(raw).toContain(playbookContent);
      expect(raw.toLowerCase()).toContain('data, not instructions');

      const trailingJson = raw.slice(jsonStartIdx);
      expect(() => {
        JSON.parse(trailingJson);
      }).not.toThrow();
    });
  });
});

describe('DECISION_TOOL', () => {
  it('is strict, disallows additional properties, and requires action/confidence/rationale', () => {
    expect(DECISION_TOOL.name).toBe('submit_decision');
    expect(DECISION_TOOL.strict).toBe(true);
    expect(DECISION_TOOL.input_schema.additionalProperties).toBe(false);
    expect(DECISION_TOOL.input_schema.required).toEqual(['action', 'confidence', 'rationale']);
  });

  it('constrains action to exactly long, flat, hold', () => {
    expect(DECISION_TOOL.input_schema.properties.action.enum).toEqual(['long', 'flat', 'hold']);
  });
});

describe('computePromptHash', () => {
  const base = {
    templateVersion: PROMPT_TEMPLATE_VERSION,
    playbookContent: 'some playbook',
    toolSchemaJson: JSON.stringify(DECISION_TOOL),
    modelId: 'claude-test-model',
  };

  it('is stable for identical inputs', () => {
    expect(computePromptHash(base)).toBe(computePromptHash({ ...base }));
  });

  it('is a 64-char hex sha256 digest', () => {
    expect(computePromptHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['templateVersion', { templateVersion: 'v-other' }],
    ['playbookContent', { playbookContent: 'a different playbook' }],
    ['toolSchemaJson', { toolSchemaJson: '{"different":true}' }],
    ['modelId', { modelId: 'claude-other-model' }],
  ])('changes when %s changes', (_label, override) => {
    expect(computePromptHash({ ...base, ...override })).not.toBe(computePromptHash(base));
  });
});

describe('buildMarketPayload (W1.3 input-snapshot persistence)', () => {
  it('equals buildUserMessage when no playbook is supplied', () => {
    const input = buildInput();
    expect(buildMarketPayload(input)).toBe(buildUserMessage(input));
  });

  it('never contains playbook delimiters or content, even when the user message does', () => {
    const input = buildInput();
    const playbookContent = 'PLAYBOOK-SECRET-HEURISTIC never persist me';
    const message = buildUserMessage(input, { playbookContent });
    const payload = buildMarketPayload(input);

    expect(message).toContain(PLAYBOOK_BLOCK_START);
    expect(message).toContain(playbookContent);
    expect(payload).not.toContain(PLAYBOOK_BLOCK_START);
    expect(payload).not.toContain(PLAYBOOK_BLOCK_END);
    expect(payload).not.toContain(playbookContent);
    expect(() => {
      JSON.parse(payload);
    }).not.toThrow();
  });
});
