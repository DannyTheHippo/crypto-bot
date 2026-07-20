import { describe, it, expect } from 'vitest';
import {
  DECISION_TOOL,
  DECISION_V2_BOUNDS,
  PLAN_BOUNDS,
  PLAN_TOOL,
  PLAYBOOK_BLOCK_START,
  PLAYBOOK_BLOCK_END,
  PROMPT_TEMPLATE_VERSION,
  SHORTS_DECISION_TOOL,
  TRADE_TEMPLATE_VERSION,
  TRADE_SHORTS_TEMPLATE_VERSION,
  TRADE_PORTFOLIO_TEMPLATE_VERSION,
  TRADE_PORTFOLIO_SHORTS_TEMPLATE_VERSION,
  buildMarketPayload,
  buildSystemPrompt,
  buildTradeTool,
  buildTradeShortsTool,
  buildTradePortfolioTool,
  buildTradePortfolioShortsTool,
  buildUserMessage,
  computePromptHash,
} from '../../../src/features/trading/agentic/agent-prompt';
import { normalizeRawEvent } from '../../../src/features/trading/market-data/normalize';
import type { RawVenueEvent } from '../../../src/ports/exchange-stream';
import type {
  AgentDecisionInput,
  AgentContext,
  AgentMarketSnapshot,
  AgentTradingProfile,
} from '../../../src/ports/agentic-strategy';
import type { DerivativesSnapshot } from '../../../src/ports/derivatives-feed';
import type { SentimentSnapshot } from '../../../src/ports/sentiment-feed';
import type { FearGreedSnapshot } from '../../../src/ports/fear-greed-feed';
import type { TradeFlowSnapshot } from '../../../src/ports/trade-flow-feed';
import type { PositioningSnapshot } from '../../../src/ports/positioning-feed';
import type { LiquidationSnapshot } from '../../../src/ports/liquidation-feed';
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

function derivativesSnapshot(over: Partial<DerivativesSnapshot> = {}): DerivativesSnapshot {
  return {
    asOf: epochMs(T),
    fundingRate: 0.0001,
    fundingAnnualizedPct: 10.95,
    openInterest: 5000,
    basisBps: 50,
    // d2 fields — null by default (no buffer history); d2-specific tests override via `over`.
    spotPerpBasisBps: null,
    oiChangePct: null,
    fundingTrendDelta: null,
    fundingTrendDirection: null,
    ...over,
  };
}

function sentimentSnapshot(over: Partial<SentimentSnapshot> = {}): SentimentSnapshot {
  return {
    asOf: epochMs(T),
    items: [
      {
        title: 'BTC breaks resistance',
        source: 'example.com',
        publishedAt: '2026-07-10T00:00:00Z',
      },
    ],
    ...over,
  };
}

function tradeFlowSnapshot(over: Partial<TradeFlowSnapshot> = {}): TradeFlowSnapshot {
  return {
    asOf: epochMs(T),
    barImbalance: 0.4,
    cvd: 123.5,
    lookbackBars: 20,
    cvdDeltas: [15, -5, 20],
    divergence: null,
    ...over,
  };
}

function positioningSnapshot(over: Partial<PositioningSnapshot> = {}): PositioningSnapshot {
  return {
    asOf: epochMs(T),
    longShortRatio: 0.8376,
    longAccountPct: 45.58,
    shortAccountPct: 54.42,
    takerBuySellRatio: 1.12,
    takerBuyVol: 530.2,
    takerSellVol: 473.4,
    ...over,
  };
}

function fearGreedSnapshot(over: Partial<FearGreedSnapshot> = {}): FearGreedSnapshot {
  return {
    asOf: epochMs(T),
    value: 65,
    classification: 'Greed',
    trend: 'rising',
    ...over,
  };
}

function liquidationSnapshot(over: Partial<LiquidationSnapshot> = {}): LiquidationSnapshot {
  return {
    asOf: epochMs(T),
    windowMin: 60,
    liqNotionalUsd: 12_500,
    longShareOfLiqs: 0.62,
    count: 5,
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
    derivatives?: DerivativesSnapshot;
    sentiment?: SentimentSnapshot;
    fearGreed?: FearGreedSnapshot;
    tradeFlow?: TradeFlowSnapshot;
    positioning?: PositioningSnapshot;
    liquidation?: LiquidationSnapshot;
  } = {},
): AgentDecisionInput {
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(T),
    candles: opts.candles ? new Map([[SYM, opts.candles]]) : new Map(),
    tickers: opts.ticker ? new Map([[SYM, opts.ticker]]) : new Map(),
    books: opts.book ? new Map([[SYM, opts.book]]) : new Map(),
    execReports: opts.execReports ?? [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
    ...(opts.derivatives ? { derivatives: opts.derivatives } : {}),
    ...(opts.sentiment ? { sentiment: opts.sentiment } : {}),
    ...(opts.fearGreed ? { fearGreed: opts.fearGreed } : {}),
    ...(opts.tradeFlow ? { tradeFlow: opts.tradeFlow } : {}),
    ...(opts.positioning ? { positioning: opts.positioning } : {}),
    ...(opts.liquidation ? { liquidation: opts.liquidation } : {}),
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

  it('renders the real fees and sizing rule from the given profile, and points at the payload constraints field', () => {
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
    expect(prompt).toContain('constraints field of the user message payload');
  });

  it('is byte-identical across symbols (v5): per-symbol constraints never enter the cached system prefix', () => {
    // The concrete constraint values live in the payload (buildMarketPayload extras.constraints);
    // the system prompt only references the field generically — this is what makes the tools+system
    // cache prefix shared across every symbol the client serves (cache_read was 0 in production
    // because five per-symbol system prompts each recurred less often than the 1h cache TTL).
    const a = buildSystemPrompt(
      fixtureProfile({
        constraints: { tickSize: price('0.01'), lotStep: qty('0.0001'), minNotional: price('10') },
      }),
    );
    const b = buildSystemPrompt(
      fixtureProfile({
        constraints: { tickSize: price('0.5'), lotStep: qty('0.001'), minNotional: price('5') },
      }),
    );
    expect(a).toBe(b);
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

  describe('derivatives block sentence (C1, DERIVATIVES_FEED_ENABLED gate)', () => {
    it('DERIVATIVES_FEED_ENABLED off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-C1 output (no mention of funding/derivatives)', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt).not.toContain('derivatives');
      expect(prompt.toLowerCase()).not.toContain('funding');
      expect(prompt.toLowerCase()).not.toContain('open interest');
    });

    it('derivativesFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        derivativesFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the derivatives block (funding rate, open interest, basis) only when derivativesFeedEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { derivativesFeedEnabled: true });

      expect(prompt.toLowerCase()).toContain('funding');
      expect(prompt.toLowerCase()).toContain('open interest');
      expect(prompt.toLowerCase()).toContain('basis');
    });
  });

  // ADD-A (X2, perp basket widening): a DEDICATED flag, never a reuse of derivativesFeedEnabled —
  // proves derivativesFeedEnabled=true alone stays byte-identical to pre-ADD-A output.
  describe('fundingHistory sentence (ADD-A, dedicated fundingHistoryFeedEnabled gate)', () => {
    it('derivativesFeedEnabled: true ALONE (fundingHistoryFeedEnabled omitted/false) never mentions fundingHistory — proves the flags are independent, not reused', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { derivativesFeedEnabled: true });

      expect(prompt).not.toContain('fundingHistory');
    });

    it('fundingHistoryFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        fundingHistoryFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the fundingHistory block only when fundingHistoryFeedEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { fundingHistoryFeedEnabled: true });

      expect(prompt).toContain('fundingHistory');
      expect(prompt.toLowerCase()).toContain('settled funding rate');
    });
  });

  describe('d2 derivatives-v2 sentence (Push 3 P6 Unit 1, AGENTIC_DERIVATIVES_V2_ENABLED gate)', () => {
    it('derivativesV2Enabled true ALONE (derivativesFeedEnabled omitted/false) is inert — byte-identical to the flag-off prompt', () => {
      const withoutV2 = buildSystemPrompt(fixtureProfile());
      const withV2Alone = buildSystemPrompt(fixtureProfile(), { derivativesV2Enabled: true });

      expect(withV2Alone).toBe(withoutV2);
    });

    it('derivativesV2Enabled: false is byte-identical to the d1 sentence (identity baseline is d1-on, not all-off)', () => {
      const d1 = buildSystemPrompt(fixtureProfile(), { derivativesFeedEnabled: true });
      const explicitlyOff = buildSystemPrompt(fixtureProfile(), {
        derivativesFeedEnabled: true,
        derivativesV2Enabled: false,
      });

      expect(explicitlyOff).toBe(d1);
    });

    it('derivativesFeedEnabled + derivativesV2Enabled both true SWAPS the sentence to document the three extra fields, never stacking alongside the d1 wording', () => {
      const d1 = buildSystemPrompt(fixtureProfile(), { derivativesFeedEnabled: true });
      const d2 = buildSystemPrompt(fixtureProfile(), {
        derivativesFeedEnabled: true,
        derivativesV2Enabled: true,
      });

      expect(d2).not.toBe(d1);
      expect(d2.toLowerCase()).toContain('spot-vs-perp basis');
      expect(d2.toLowerCase()).toContain('open-interest percent change');
      expect(d2.toLowerCase()).toContain('funding-rate trend');
      // Exactly one derivatives sentence — d2 replaces d1's, it does not append alongside it.
      const derivativesSentenceCount = d2.split('may include a derivatives block').length - 1;
      expect(derivativesSentenceCount).toBe(1);
    });
  });

  describe('sentiment block sentence (C4, SENTIMENT_FEED_ENABLED gate)', () => {
    it('SENTIMENT_FEED_ENABLED off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-C4 output (no mention of sentiment/headlines)', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt.toLowerCase()).not.toContain('sentiment');
      expect(prompt.toLowerCase()).not.toContain('headline');
    });

    it('sentimentFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        sentimentFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the sentiment block (recent headlines) only when sentimentFeedEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { sentimentFeedEnabled: true });

      expect(prompt.toLowerCase()).toContain('sentiment');
      expect(prompt.toLowerCase()).toContain('headline');
    });

    it('both derivativesFeedEnabled and sentimentFeedEnabled true documents both blocks', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), {
        derivativesFeedEnabled: true,
        sentimentFeedEnabled: true,
      });

      expect(prompt.toLowerCase()).toContain('funding');
      expect(prompt.toLowerCase()).toContain('sentiment');
    });
  });

  describe('fearGreed block sentence (X3a, FEAR_GREED_FEED_ENABLED gate)', () => {
    it('FEAR_GREED_FEED_ENABLED off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-X3a output (no mention of fearGreed)', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt).not.toContain('fearGreed');
    });

    it('fearGreedFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        fearGreedFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the fearGreed block only when fearGreedFeedEnabled is true, and frames it as a modulator, never a veto', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { fearGreedFeedEnabled: true });

      expect(prompt).toContain('fearGreed block');
      expect(prompt.toLowerCase()).toContain('modulator');
    });
  });

  describe('tradeFlow block sentence (AGENTIC_TRADEFLOW_ENABLED gate)', () => {
    it('tradeFlowFeedEnabled off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-feature output (no mention of tradeFlow/CVD)', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt).not.toContain('tradeFlow');
      expect(prompt.toLowerCase()).not.toContain('cvd');
    });

    it('tradeFlowFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        tradeFlowFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the tradeFlow block (barImbalance, cvd) only when tradeFlowFeedEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { tradeFlowFeedEnabled: true });

      expect(prompt).toContain('tradeFlow block');
      expect(prompt).toContain('barImbalance');
      expect(prompt.toLowerCase()).toContain('cvd');
    });
  });

  describe('positioning block sentence (AGENTIC_POSITIONING_ENABLED gate)', () => {
    it('positioningFeedEnabled off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-feature output (no mention of positioning/long-short)', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt).not.toContain('positioning block');
      expect(prompt.toLowerCase()).not.toContain('long/short');
    });

    it('positioningFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        positioningFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the positioning block (long/short account ratio) only when positioningFeedEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { positioningFeedEnabled: true });

      expect(prompt).toContain('positioning block');
      expect(prompt).toContain('longShortRatio');
    });
  });

  describe('liquidation block sentence (Push 3 P6 Unit 2, AGENTIC_LIQUIDATIONS_ENABLED gate)', () => {
    it('liquidationsFeedEnabled off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-feature output (no mention of liquidation)', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt.toLowerCase()).not.toContain('liquidation');
    });

    it('liquidationsFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        liquidationsFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the liquidation block (rolling notional + long/short share) only when liquidationsFeedEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { liquidationsFeedEnabled: true });

      expect(prompt.toLowerCase()).toContain('liquidation block');
      expect(prompt).toContain('longShareOfLiqs');
    });
  });

  describe('bookStructure block sentence (Push 3 P6 Unit 3, AGENTIC_BOOK_STRUCTURE_ENABLED gate)', () => {
    it('bookStructureFeedEnabled off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-feature output (no mention of bookStructure)', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt).not.toContain('bookStructure');
    });

    it('bookStructureFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        bookStructureFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the bookStructure block (microprice/depth-weighted imbalance/depth notional) only when bookStructureFeedEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { bookStructureFeedEnabled: true });

      expect(prompt).toContain('bookStructure');
      expect(prompt).toContain('micropriceBps');
      expect(prompt).toContain('depthWeightedImbalance10');
    });
  });

  describe('trackRecord block sentence (Push 3 P6 Unit 4, AGENTIC_TRACK_RECORD_ENABLED gate)', () => {
    it('trackRecordFeedEnabled off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-feature output (no mention of trackRecord)', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt).not.toContain('trackRecord');
    });

    it('trackRecordFeedEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), {
        trackRecordFeedEnabled: false,
      });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('documents the trackRecord block (tripCount/winRate/meanNetBpsPerTrip/trailingWindowTrips) only when trackRecordFeedEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { trackRecordFeedEnabled: true });

      expect(prompt).toContain('trackRecord');
      expect(prompt).toContain('winRate');
      expect(prompt).toContain('meanNetBpsPerTrip');
    });
  });

  describe('shorts capability (B3, shortsEnabled gate)', () => {
    it('shortsEnabled off (opts omitted) ⇒ the prompt is BYTE-IDENTICAL to pre-B3 output', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt).toContain(
        'You may only go LONG or stay FLAT — never short, never use leverage or margin.',
      );
      expect(prompt.toLowerCase()).not.toContain('short position');
    });

    it('shortsEnabled: false is explicitly byte-identical to opts omitted entirely', () => {
      const withOmitted = buildSystemPrompt(fixtureProfile());
      const withExplicitFalse = buildSystemPrompt(fixtureProfile(), { shortsEnabled: false });

      expect(withExplicitFalse).toBe(withOmitted);
    });

    it('swaps the LONG/FLAT-only constraint sentence and adds one short-semantics sentence when shortsEnabled is true', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), { shortsEnabled: true });

      expect(prompt).not.toContain('never short, never use leverage or margin');
      expect(prompt).toContain('You may go LONG, SHORT, or stay FLAT');
      expect(prompt.toLowerCase()).toContain('short position');
      expect(prompt).toContain("close ANY open position, long or short, via the 'flat' action");
    });
  });

  describe('plan mode (W3 payoff-floor sentence)', () => {
    it('states the stop-floor/RR constraint up front, with the configured minRr, when planMode is on', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), {
        planMode: true,
        minEdgeMultiple: '1.5',
        minRr: '2',
      });

      expect(prompt).toContain(
        'Plans are auto-rejected unless stopLossPct is at least the round-trip fee fraction and takeProfitPct is at least AGENTIC_MIN_RR (2) times stopLossPct — propose plans with genuine asymmetry, not thin targets with loose stops.',
      );
    });

    it('defaults minRr to 1.5 in the sentence when opts.minRr is omitted', () => {
      const prompt = buildSystemPrompt(fixtureProfile(), {
        planMode: true,
        minEdgeMultiple: '1.5',
      });

      expect(prompt).toContain('AGENTIC_MIN_RR (1.5)');
    });

    it('omits the payoff-floor sentence entirely outside plan mode', () => {
      const prompt = buildSystemPrompt(fixtureProfile());

      expect(prompt).not.toContain('AGENTIC_MIN_RR');
    });

    it('explains the managedPlan re-arm path (hold+plan on an unmanaged position) when planMode is on, never otherwise', () => {
      const planPrompt = buildSystemPrompt(fixtureProfile(), {
        planMode: true,
        minEdgeMultiple: '1.5',
        minRr: '1.5',
      });
      const legacyPrompt = buildSystemPrompt(fixtureProfile());

      expect(planPrompt).toContain('managedPlan: false');
      expect(planPrompt).toContain("including a plan object with your 'hold'");
      expect(legacyPrompt).not.toContain('managedPlan');
    });
  });
});

describe('buildSystemPrompt tradeContract option (S1, rich decision contract)', () => {
  it('tradeContract omitted/false ⇒ BYTE-IDENTICAL to the pre-S1 legacy prompt (no mandate/swing/submit_trade wording)', () => {
    const withOmitted = buildSystemPrompt(fixtureProfile());
    const withExplicitFalse = buildSystemPrompt(fixtureProfile(), { tradeContract: false });

    expect(withExplicitFalse).toBe(withOmitted);
    expect(withOmitted).not.toContain('submit_trade');
    expect(withOmitted).not.toContain('net-of-cost');
    expect(withOmitted).toContain('Respond ONLY by calling the submit_decision tool.');
  });

  it('tradeContract: true swaps in the v2 trader-with-judgment prompt: mandate, swing horizon, sizing/exit/scheduling authority, correlation budgeting, and the submit_trade closing rule', () => {
    const prompt = buildSystemPrompt(fixtureProfile(), { tradeContract: true });

    expect(prompt.toLowerCase()).toContain('net-of-cost');
    expect(prompt.toLowerCase()).toContain('swing');
    expect(prompt).toContain('sizeFraction is your conviction channel');
    expect(prompt.toLowerCase()).toContain('own your exits');
    expect(prompt).toContain('nextConsultBars is itself an economic decision');
    expect(prompt.toLowerCase()).toContain('correlation budgeting');
    expect(prompt).toContain('Respond ONLY by calling the submit_trade tool.');
    // Never the legacy closing instruction or the legacy LONG/FLAT-only framing.
    expect(prompt).not.toContain('Respond ONLY by calling the submit_decision tool.');
  });

  it('tradeContract: true without shortsEnabled documents the SPOT lane only (no shorts/leverage/funding sentences)', () => {
    const prompt = buildSystemPrompt(fixtureProfile(), { tradeContract: true });

    expect(prompt).toContain('trading a single SPOT symbol');
    expect(prompt.toLowerCase()).not.toContain('liquidation distance');
    expect(prompt.toLowerCase()).not.toContain('funding is part of your pnl');
  });

  it('tradeContract: true + shortsEnabled: true documents the PERP lane: shorts, 2x leverage cap, margin/liquidation, funding-as-carry', () => {
    const prompt = buildSystemPrompt(fixtureProfile(), {
      tradeContract: true,
      shortsEnabled: true,
    });

    expect(prompt.toLowerCase()).toContain('perpetual futures');
    expect(prompt).toContain('leverage is capped at 2x');
    // X2 honesty fix (2026-07-20): the summary carries no margin/liq-distance fields yet, so
    // the prompt teaches first-principles liquidation reasoning off the 2x cap instead of
    // promising fields that never render (follow-up build lands before stage-2 widening).
    expect(prompt.toLowerCase()).toContain(
      'manage liquidation risk actively from first principles',
    );
    expect(prompt.toLowerCase()).not.toContain('the position summary shows margin usage');
    expect(prompt.toLowerCase()).toContain('funding is part of your pnl');
    expect(prompt).not.toContain('trading a single SPOT symbol');
  });

  it('tradeContract: true still documents the feed blocks (derivatives/sentiment/etc.) when their flags are on, same as the legacy prompt', () => {
    const prompt = buildSystemPrompt(fixtureProfile(), {
      tradeContract: true,
      derivativesFeedEnabled: true,
      trackRecordFeedEnabled: true,
    });

    expect(prompt.toLowerCase()).toContain('funding');
    expect(prompt).toContain('trackRecord block');
  });

  it('tradeContract: true still frames the playbook as advisory DATA and recentDecisions as historical data, same framing as the legacy prompt', () => {
    const prompt = buildSystemPrompt(fixtureProfile(), { tradeContract: true });

    expect(prompt.toLowerCase()).toContain('playbook');
    expect(prompt.toLowerCase()).toContain('never');
    expect(prompt).toContain('recentDecisions');
    expect(prompt.toLowerCase()).toContain('historical data');
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

  // B3: managedPlan (a boolean) is replaced by AgentPositionSummary.directives (an object, absent
  // when unmanaged) — the re-arm signal is now conveyed by the KEY'S ABSENCE, not an explicit false.
  it('omits position.directives from the payload JSON when the plan is lost (re-arm signal via absence)', () => {
    const context: AgentContext = {
      indicators: null,
      position: {
        side: 'LONG',
        qty: '2',
        avgEntry: '90',
        realizedPnl: '5',
        unrealizedPnlPct: 10,
        openOrders: 0,
      },
      recentDecisions: [],
    };
    const raw = buildUserMessage(buildInput({ context }));
    const payload = JSON.parse(raw) as { position: { directives?: unknown } };

    expect(raw).not.toContain('"directives"');
    expect(payload.position.directives).toBeUndefined();
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

  // Push 3 P6 Unit 3: bookStructure reads the SAME already-streaming book snapshot as orderBook
  // above — the existing orderBook block stays untouched (asserted below); bookStructure is an
  // ADDITIONAL, separately flag-gated block (via buildMarketPayload's extras, not snapshot presence).
  describe('bookStructure block rendering (Push 3 P6 Unit 3)', () => {
    function symmetricBook(): OrderBookSnapshotEvent {
      return book({
        bids: [
          ['100', '10'],
          ['99.99', '5'],
        ],
        asks: [
          ['100.01', '10'],
          ['100.02', '5'],
        ],
      });
    }

    it('bookStructureEnabled omitted/false ⇒ the bookStructure key is never computed, existing orderBook stays byte-identical', () => {
      const input = buildInput({ book: symmetricBook() });
      const withoutFlag = buildMarketPayload(input);
      const explicitlyOff = buildMarketPayload(input, { bookStructureEnabled: false });

      expect(withoutFlag).toBe(explicitlyOff);
      const payload = JSON.parse(withoutFlag) as Record<string, unknown>;
      expect(payload).not.toHaveProperty('bookStructure');
      expect(payload).toHaveProperty('orderBook');
    });

    it('renders micropriceBps ≈ 0 and near-zero depthWeightedImbalance10 for a symmetric book, plus positive depth notional within the 25bps band', () => {
      const payload = JSON.parse(
        buildMarketPayload(buildInput({ book: symmetricBook() }), { bookStructureEnabled: true }),
      ) as {
        bookStructure: {
          micropriceBps: number;
          depthWeightedImbalance10: number;
          bidDepthNotional25bps: number;
          askDepthNotional25bps: number;
        };
      };

      // Symmetric qty at best bid/ask (10/10) -> microprice === mid -> 0bps offset.
      expect(payload.bookStructure.micropriceBps).toBe(0);
      // Symmetric depth at every level (10/10, 5/5) -> perfectly balanced -> 0.
      expect(payload.bookStructure.depthWeightedImbalance10).toBe(0);
      // mid = 100.005; both levels of both sides sit within 25bps (~0.25) of mid, so all is counted:
      // bid notional = 100*10 + 99.99*5, ask notional = 100.01*10 + 100.02*5. Same float expression
      // form as the builder itself evaluates (mirrors the order-book spreadBps test above), not
      // toBeCloseTo (banned project-wide — eslint.config.mjs's no-restricted-syntax selector).
      expect(payload.bookStructure.bidDepthNotional25bps).toBe(100 * 10 + 99.99 * 5);
      expect(payload.bookStructure.askDepthNotional25bps).toBe(100.01 * 10 + 100.02 * 5);
    });

    it('renders a signed depthWeightedImbalance10 favoring the heavier side, and stops the depth-notional walk once a level is outside the 25bps band', () => {
      const skewedBook = book({
        bids: [
          ['100', '20'], // heavy bid depth
        ],
        asks: [
          ['101', '1'], // mid ~100.5; 101 is ~50bps away -> outside the 25bps band entirely
        ],
      });
      const payload = JSON.parse(
        buildMarketPayload(buildInput({ book: skewedBook }), { bookStructureEnabled: true }),
      ) as { bookStructure: { depthWeightedImbalance10: number; askDepthNotional25bps: number } };

      expect(payload.bookStructure.depthWeightedImbalance10).toBeGreaterThan(0);
      expect(payload.bookStructure.askDepthNotional25bps).toBe(0);
    });

    it('omits the bookStructure key when no book snapshot is available, even with the flag on', () => {
      const payload = JSON.parse(
        buildMarketPayload(buildInput(), { bookStructureEnabled: true }),
      ) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('bookStructure');
    });
  });

  // Order-book memory bound (normalize.ts's normalizeBook): band-filters + hard-caps raw ccxt book
  // levels BEFORE Decimal construction. This fixture proves that truncation is inert for the agent
  // prompt — buildOrderBookBlock only ever reads the top 5 levels and buildBookStructureBlock only
  // ever reads the top 10 (weighted imbalance) plus a 25bps depth-notional walk that stops at the
  // first out-of-band level (both far inside a 50bps band 12 levels deep) — so band-filtering/
  // capping levels neither builder ever reaches must never change the rendered payload.
  describe('order-book memory bound: prompt-render fidelity across truncation', () => {
    const MID = 100;
    // All within the 50bps band (inclusive) and 12 deep — past both builders' own depth ceilings
    // (top-5 / top-10), so the shared near-mid prefix is identical whether or not the tail below is
    // truncated.
    const WITHIN_BAND_BPS = [1, 5, 10, 12, 15, 18, 20, 22, 25, 30, 35, 45];
    // Beyond the 50bps band — present only in the untruncated raw book; the band filter removes
    // these, and the corresponding maxLevels cap (see the test below) is set high enough that the
    // band filter alone drives every level dropped in this fixture.
    const BEYOND_BAND_BPS = [60, 80, 120, 160, 200, 250, 300];

    function rawLevel(bps: number, side: 'bid' | 'ask'): [number, number] {
      const levelPrice = side === 'bid' ? MID * (1 - bps / 10_000) : MID * (1 + bps / 10_000);
      return [levelPrice, 1];
    }

    function rawBookEvent(offsets: number[]): RawVenueEvent {
      return {
        type: 'book',
        venue: V,
        symbol: SYM,
        timestamp: epochMs(T),
        raw: {
          timestamp: T,
          bids: offsets.map((bps) => rawLevel(bps, 'bid')),
          asks: offsets.map((bps) => rawLevel(bps, 'ask')),
        },
      };
    }

    it('renders a byte-identical orderBook + bookStructure block whether the raw book is band-filtered/capped or left untruncated', () => {
      const fullOffsets = [...WITHIN_BAND_BPS, ...BEYOND_BAND_BPS];

      const truncated = normalizeRawEvent(rawBookEvent(fullOffsets), epochMs(T), undefined, {
        bandBps: 50,
        maxLevels: 1000,
      }) as OrderBookSnapshotEvent;
      const untruncated = normalizeRawEvent(
        rawBookEvent(fullOffsets),
        epochMs(T),
      ) as OrderBookSnapshotEvent;

      // Sanity: the fixture actually exercises truncation — otherwise the fidelity check below is
      // vacuous (comparing two identical inputs would trivially pass).
      expect(truncated.bids).toHaveLength(WITHIN_BAND_BPS.length);
      expect(untruncated.bids).toHaveLength(fullOffsets.length);
      expect(truncated.bids.length).toBeLessThan(untruncated.bids.length);

      const truncatedPayload = buildMarketPayload(buildInput({ book: truncated }), {
        bookStructureEnabled: true,
      });
      const untruncatedPayload = buildMarketPayload(buildInput({ book: untruncated }), {
        bookStructureEnabled: true,
      });

      expect(truncatedPayload).toBe(untruncatedPayload);
    });
  });

  // Push 3 P6 Unit 4 (#17 residual): trackRecord is a plain passthrough of AgentContext.trackRecord
  // (the strategy attaches it, gated by AGENTIC_TRACK_RECORD_ENABLED + evidence-port availability) —
  // mirrors crossSymbol's own wiring: no dedicated builder function, no extras flag.
  describe('trackRecord block rendering (Push 3 P6 Unit 4)', () => {
    const minimalContext: AgentContext = {
      indicators: null,
      position: {
        side: 'FLAT',
        qty: '0',
        avgEntry: null,
        realizedPnl: '0',
        unrealizedPnlPct: null,
        openOrders: 0,
      },
      recentDecisions: [],
    };

    it('renders tripCount/winRate/meanNetBpsPerTrip/trailingWindowTrips when the context carries a trackRecord', () => {
      const context: AgentContext = {
        ...minimalContext,
        trackRecord: {
          tripCount: 12,
          winRate: 0.58,
          meanNetBpsPerTrip: 4.2,
          trailingWindowTrips: 15,
        },
      };
      const payload = JSON.parse(buildUserMessage(buildInput({ context }))) as {
        trackRecord: {
          tripCount: number;
          winRate: number;
          meanNetBpsPerTrip: number;
          trailingWindowTrips: number;
        };
      };

      expect(payload.trackRecord).toEqual({
        tripCount: 12,
        winRate: 0.58,
        meanNetBpsPerTrip: 4.2,
        trailingWindowTrips: 15,
      });
    });

    it('omits the trackRecord key entirely (no empty scaffolding) when the context carries none — the flag-off / no-evidence-port / too-few-trips case', () => {
      const raw = buildUserMessage(buildInput({ context: minimalContext }));
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('trackRecord');
      expect(raw).not.toContain('meanNetBpsPerTrip');
    });
  });

  // C1: derivatives-market context (funding rate, open interest, mark/index basis) — a REST-polled
  // sibling to the order-book block above, gated the identical way (present/absent on the snapshot).
  describe('derivatives block rendering (C1)', () => {
    it('renders funding rate, annualized funding, open interest, and basis bps when a fresh snapshot is attached', () => {
      const derivatives = derivativesSnapshot({
        fundingRate: 0.00025,
        fundingAnnualizedPct: 27.375,
        openInterest: 8123.5,
        basisBps: 12.4,
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ derivatives }))) as {
        derivatives: {
          fundingRate: number;
          fundingAnnualizedPct: number;
          openInterest: number;
          basisBps: number;
        };
      };

      expect(payload.derivatives).toEqual({
        fundingRate: 0.00025,
        fundingAnnualizedPct: 27.375,
        openInterest: 8123.5,
        basisBps: 12.4,
      });
    });

    it('omits the derivatives key entirely (no empty scaffolding) when no derivatives snapshot is available — the flag-off / stale / absent-poll case', () => {
      const raw = buildUserMessage(buildInput());
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('derivatives');
      expect(raw).not.toContain('fundingRate');
      expect(raw).not.toContain('basisBps');
    });

    it('a stale/absent derivatives snapshot never throws — buildUserMessage still returns valid JSON', () => {
      expect(() => {
        JSON.parse(buildUserMessage(buildInput()));
      }).not.toThrow();
    });

    it('DERIVATIVES_FEED_ENABLED off ⇒ the rendered user message for a representative snapshot is BYTE-IDENTICAL to the no-derivatives render (flag-off byte-identity)', () => {
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
        htf: { h1: { emaFast: 101, emaSlow: 99, rsi14: 60 }, h4: null },
      };
      const candles = Array.from({ length: 20 }, (_, i) => candle(i));
      const withoutDerivativesFlag = buildUserMessage(
        buildInput({ candles, ticker: ticker(), book: book(), context }),
      );
      // DERIVATIVES_FEED_ENABLED off means the strategy layer never attaches a snapshot
      // (AgenticStrategy.withDerivatives), so the port-level render is identical to never having
      // wired the feed at all — asserted here at the render boundary itself.
      const explicitlyNoDerivatives = buildUserMessage(
        buildInput({ candles, ticker: ticker(), book: book(), context, derivatives: undefined }),
      );

      expect(withoutDerivativesFlag).toBe(explicitlyNoDerivatives);
      expect(withoutDerivativesFlag).not.toContain('derivatives');
    });
  });

  // ADD-A (X2, perp basket widening): funding-rate HISTORY block — usable while FLAT, distinct from
  // the derivatives block above (own key, own gate).
  describe('fundingHistory block rendering (ADD-A)', () => {
    it('renders recent (last settled rates, oldest-first) and predicted (current fundingRate) when recentFundingRates is present', () => {
      const derivatives = derivativesSnapshot({
        fundingRate: 0.0001,
        recentFundingRates: [0.0002, 0.00015, 0.0001],
      });
      const payload = JSON.parse(buildMarketPayload(buildInput({ derivatives }))) as {
        fundingHistory: { recent: number[]; predicted: number };
      };

      expect(payload.fundingHistory).toEqual({
        recent: [0.0002, 0.00015, 0.0001],
        predicted: 0.0001,
      });
    });

    it('omits the fundingHistory key entirely when recentFundingRates is absent — a derivatives snapshot alone does not imply history', () => {
      const derivatives = derivativesSnapshot();
      const raw = buildMarketPayload(buildInput({ derivatives }));
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('fundingHistory');
      expect(raw).not.toContain('fundingHistory');
    });

    it('omits the fundingHistory key entirely when recentFundingRates is an empty array', () => {
      const derivatives = derivativesSnapshot({ recentFundingRates: [] });
      const payload = JSON.parse(buildMarketPayload(buildInput({ derivatives }))) as Record<
        string,
        unknown
      >;

      expect(payload).not.toHaveProperty('fundingHistory');
    });

    it('omits the fundingHistory key entirely when no derivatives snapshot is available at all', () => {
      const raw = buildMarketPayload(buildInput());
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('fundingHistory');
    });
  });

  // d2 (Push 3 P6 Unit 1): the three extra fields are ALWAYS present on the underlying
  // DerivativesSnapshot (the feed accumulates regardless of the flag) — buildMarketPayload's
  // extras.derivativesV2Enabled is what gates whether buildDerivativesBlock spreads them in.
  describe('d2 derivatives-v2 payload fields (AGENTIC_DERIVATIVES_V2_ENABLED gate)', () => {
    const v2Derivatives = derivativesSnapshot({
      fundingRate: 0.0002,
      fundingAnnualizedPct: 21.9,
      openInterest: 9000,
      basisBps: 8,
      spotPerpBasisBps: 15.5,
      oiChangePct: -3.2,
      fundingTrendDelta: 0.00005,
      fundingTrendDirection: 'up',
    });

    it('v2Enabled omitted/false ⇒ the four pre-d2 fields only, byte-identical to the d1 render', () => {
      const input = buildInput({ derivatives: v2Derivatives });
      const d1Payload = buildMarketPayload(input);
      const explicitlyOffPayload = buildMarketPayload(input, { derivativesV2Enabled: false });

      expect(d1Payload).toBe(explicitlyOffPayload);
      const parsed = JSON.parse(d1Payload) as { derivatives: Record<string, unknown> };
      expect(parsed.derivatives).toEqual({
        fundingRate: 0.0002,
        fundingAnnualizedPct: 21.9,
        openInterest: 9000,
        basisBps: 8,
      });
      expect(d1Payload).not.toContain('spotPerpBasisBps');
      expect(d1Payload).not.toContain('oiChangePct');
      expect(d1Payload).not.toContain('fundingTrendDelta');
    });

    it('v2Enabled true spreads spotPerpBasisBps/oiChangePct/fundingTrendDelta/fundingTrendDirection into the same block', () => {
      const input = buildInput({ derivatives: v2Derivatives });
      const payload = buildMarketPayload(input, { derivativesV2Enabled: true });
      const parsed = JSON.parse(payload) as { derivatives: Record<string, unknown> };

      expect(parsed.derivatives).toEqual({
        fundingRate: 0.0002,
        fundingAnnualizedPct: 21.9,
        openInterest: 9000,
        basisBps: 8,
        spotPerpBasisBps: 15.5,
        oiChangePct: -3.2,
        fundingTrendDelta: 0.00005,
        fundingTrendDirection: 'up',
      });
    });

    it('v2Enabled true with no derivatives snapshot still omits the whole block (no empty scaffolding)', () => {
      const payload = buildMarketPayload(buildInput(), { derivativesV2Enabled: true });

      expect(JSON.parse(payload)).not.toHaveProperty('derivatives');
    });

    it('v2Enabled true renders null v2 fields as JSON null (insufficient buffer history), never dropping the keys', () => {
      const input = buildInput({
        derivatives: derivativesSnapshot({
          spotPerpBasisBps: null,
          oiChangePct: null,
          fundingTrendDelta: null,
          fundingTrendDirection: null,
        }),
      });
      const payload = buildMarketPayload(input, { derivativesV2Enabled: true });
      const parsed = JSON.parse(payload) as { derivatives: Record<string, unknown> };

      expect(parsed.derivatives).toHaveProperty('spotPerpBasisBps', null);
      expect(parsed.derivatives).toHaveProperty('oiChangePct', null);
      expect(parsed.derivatives).toHaveProperty('fundingTrendDelta', null);
      expect(parsed.derivatives).toHaveProperty('fundingTrendDirection', null);
    });
  });

  // Trade-flow/CVD context — a REST-polled sibling to the derivatives block above, gated the
  // identical way (present/absent on the snapshot).
  describe('tradeFlow block rendering', () => {
    it('renders barImbalance, cvd, and lookbackBars when a fresh snapshot is attached', () => {
      const tradeFlow = tradeFlowSnapshot({ barImbalance: -0.25, cvd: -42.5, lookbackBars: 20 });
      const payload = JSON.parse(buildUserMessage(buildInput({ tradeFlow }))) as {
        tradeFlow: {
          barImbalance: number;
          cvd: number;
          lookbackBars: number;
          cvdDeltas: number[];
          divergence: string | null;
        };
      };

      expect(payload.tradeFlow).toEqual({
        barImbalance: -0.25,
        cvd: -42.5,
        lookbackBars: 20,
        cvdDeltas: tradeFlow.cvdDeltas,
        divergence: tradeFlow.divergence,
      });
    });

    it('omits the tradeFlow key entirely (no empty scaffolding) when no snapshot is available — the flag-off / stale / absent-poll case', () => {
      const raw = buildUserMessage(buildInput());
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('tradeFlow');
      expect(raw).not.toContain('barImbalance');
    });

    it('renders cvdDeltas + divergence (X5)', () => {
      const tradeFlow = tradeFlowSnapshot({
        cvdDeltas: [5, -10, 15],
        divergence: 'bullish_divergence',
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ tradeFlow }))) as {
        tradeFlow: { cvdDeltas: number[]; divergence: string | null };
      };

      expect(payload.tradeFlow.cvdDeltas).toEqual([5, -10, 15]);
      expect(payload.tradeFlow.divergence).toBe('bullish_divergence');
    });
  });

  // Positioning context — a REST-polled sibling to the derivatives block above, gated the identical
  // way (present/absent on the snapshot).
  describe('positioning block rendering', () => {
    it('renders longShortRatio, longAccountPct, and shortAccountPct when a fresh snapshot is attached', () => {
      const positioning = positioningSnapshot({
        longShortRatio: 1.2,
        longAccountPct: 55,
        shortAccountPct: 45,
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ positioning }))) as {
        positioning: {
          longShortRatio: number;
          longAccountPct: number;
          shortAccountPct: number;
          takerBuySellRatio: number | null;
          takerBuyVol: number | null;
          takerSellVol: number | null;
        };
      };

      expect(payload.positioning).toEqual({
        longShortRatio: 1.2,
        longAccountPct: 55,
        shortAccountPct: 45,
        takerBuySellRatio: positioning.takerBuySellRatio,
        takerBuyVol: positioning.takerBuyVol,
        takerSellVol: positioning.takerSellVol,
      });
    });

    it('renders taker buy/sell volume fields, including null when the taker endpoint degraded (X3b)', () => {
      const positioning = positioningSnapshot({
        takerBuySellRatio: null,
        takerBuyVol: null,
        takerSellVol: null,
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ positioning }))) as {
        positioning: { takerBuySellRatio: number | null };
      };

      expect(payload.positioning.takerBuySellRatio).toBeNull();
    });

    it('omits the positioning key entirely (no empty scaffolding) when no snapshot is available — the flag-off / stale / absent-poll case', () => {
      const raw = buildUserMessage(buildInput());
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('positioning');
      expect(raw).not.toContain('longShortRatio');
    });
  });

  // #43 liquidation-order flow (Push 3 P6 Unit 2) — a WS-fed sibling to the REST-polled positioning
  // block above, gated the identical way (present/absent on the snapshot).
  describe('liquidation block rendering', () => {
    it('renders windowMin, liqNotionalUsd, longShareOfLiqs, and count when a fresh snapshot is attached', () => {
      const liquidation = liquidationSnapshot({
        windowMin: 60,
        liqNotionalUsd: 25_000,
        longShareOfLiqs: 0.3,
        count: 7,
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ liquidation }))) as {
        liquidation: {
          windowMin: number;
          liqNotionalUsd: number;
          longShareOfLiqs: number | null;
          count: number;
        };
      };

      expect(payload.liquidation).toEqual({
        windowMin: 60,
        liqNotionalUsd: 25_000,
        longShareOfLiqs: 0.3,
        count: 7,
      });
    });

    it('renders longShareOfLiqs as JSON null (a healthy, quiet window) rather than dropping the key', () => {
      const liquidation = liquidationSnapshot({
        liqNotionalUsd: 0,
        longShareOfLiqs: null,
        count: 0,
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ liquidation }))) as {
        liquidation: Record<string, unknown>;
      };

      expect(payload.liquidation).toHaveProperty('longShareOfLiqs', null);
      expect(payload.liquidation).toHaveProperty('count', 0);
    });

    it('omits the liquidation key entirely (no empty scaffolding) when no snapshot is available — the flag-off / unhealthy-stream case', () => {
      const raw = buildUserMessage(buildInput());
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('liquidation');
      expect(raw).not.toContain('longShareOfLiqs');
    });
  });

  // C4: free news/sentiment headlines — a REST-polled sibling to the derivatives block above, gated
  // the identical way (present/absent on the snapshot).
  describe('sentiment block rendering (C4)', () => {
    it('renders capped headlines (title/source/publishedAt) when a fresh snapshot is attached', () => {
      const sentiment = sentimentSnapshot({
        items: [
          {
            title: 'BTC breaks resistance',
            source: 'coindesk.com',
            publishedAt: '2026-07-10T00:00:00Z',
          },
        ],
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ sentiment }))) as {
        sentiment: { items: { title: string; source: string; publishedAt: string }[] };
      };

      expect(payload.sentiment).toEqual({
        items: [
          {
            title: 'BTC breaks resistance',
            source: 'coindesk.com',
            publishedAt: '2026-07-10T00:00:00Z',
          },
        ],
      });
    });

    it('caps rendered headlines at 5 even when the snapshot carries more', () => {
      const items = Array.from({ length: 8 }, (_, i) => ({
        title: `headline ${i}`,
        source: 'example.com',
        publishedAt: '2026-07-10T00:00:00Z',
      }));
      const payload = JSON.parse(
        buildUserMessage(buildInput({ sentiment: sentimentSnapshot({ items }) })),
      ) as { sentiment: { items: unknown[] } };

      expect(payload.sentiment.items).toHaveLength(5);
    });

    it('omits the sentiment key entirely (no empty scaffolding) when no sentiment snapshot is available — the flag-off / stale / absent-poll / no-key case', () => {
      const raw = buildUserMessage(buildInput());
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('sentiment');
      expect(raw).not.toContain('publishedAt');
    });

    it('omits the sentiment key when the snapshot carries no items (no empty scaffolding)', () => {
      const raw = buildUserMessage(buildInput({ sentiment: sentimentSnapshot({ items: [] }) }));
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('sentiment');
    });
  });

  describe('fearGreed block rendering (X3a)', () => {
    it('renders value/classification/trend when a fresh snapshot is attached', () => {
      const fearGreed = fearGreedSnapshot({
        value: 18,
        classification: 'Extreme Fear',
        trend: 'falling',
      });
      const payload = JSON.parse(buildUserMessage(buildInput({ fearGreed }))) as {
        fearGreed: { value: number; classification: string; trend: string | null };
      };

      expect(payload.fearGreed).toEqual({
        value: 18,
        classification: 'Extreme Fear',
        trend: 'falling',
      });
    });

    it('omits the fearGreed key entirely (no empty scaffolding) when no snapshot is available', () => {
      const raw = buildUserMessage(buildInput());
      const payload = JSON.parse(raw) as Record<string, unknown>;

      expect(payload).not.toHaveProperty('fearGreed');
      expect(raw).not.toContain('classification');
    });

    it('a stale/absent sentiment snapshot never throws — buildUserMessage still returns valid JSON', () => {
      expect(() => {
        JSON.parse(buildUserMessage(buildInput()));
      }).not.toThrow();
    });

    it('SENTIMENT_FEED_ENABLED off ⇒ the rendered user message for a representative snapshot is BYTE-IDENTICAL to the no-sentiment render (flag-off byte-identity)', () => {
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
        htf: { h1: { emaFast: 101, emaSlow: 99, rsi14: 60 }, h4: null },
      };
      const candles = Array.from({ length: 20 }, (_, i) => candle(i));
      const withoutSentimentFlag = buildUserMessage(
        buildInput({ candles, ticker: ticker(), book: book(), context }),
      );
      // SENTIMENT_FEED_ENABLED off means the strategy layer never attaches a snapshot
      // (AgenticStrategy.withSentiment), so the port-level render is identical to never having
      // wired the feed at all — asserted here at the render boundary itself.
      const explicitlyNoSentiment = buildUserMessage(
        buildInput({ candles, ticker: ticker(), book: book(), context, sentiment: undefined }),
      );

      expect(withoutSentimentFlag).toBe(explicitlyNoSentiment);
      expect(withoutSentimentFlag).not.toContain('sentiment');
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

  it("disambiguates 'flat' (close an open position) from the already-flat case (use 'hold')", () => {
    expect(DECISION_TOOL.input_schema.properties.action.description).toContain(
      "'flat' to close an open position (if already flat, use 'hold')",
    );
  });
});

describe('SHORTS_DECISION_TOOL (B3)', () => {
  it('is the same submit_decision tool name — strict, disallows additional properties, requires action/confidence/rationale', () => {
    expect(SHORTS_DECISION_TOOL.name).toBe('submit_decision');
    expect(SHORTS_DECISION_TOOL.strict).toBe(true);
    expect(SHORTS_DECISION_TOOL.input_schema.additionalProperties).toBe(false);
    expect(SHORTS_DECISION_TOOL.input_schema.required).toEqual([
      'action',
      'confidence',
      'rationale',
    ]);
  });

  it('constrains action to exactly long, short, flat, hold', () => {
    expect(SHORTS_DECISION_TOOL.input_schema.properties.action.enum).toEqual([
      'long',
      'short',
      'flat',
      'hold',
    ]);
  });

  it('DECISION_TOOL itself stays untouched (still only long/flat/hold)', () => {
    expect(DECISION_TOOL.input_schema.properties.action.enum).toEqual(['long', 'flat', 'hold']);
  });
});

describe('strict tool schemas stay within the API-accepted JSON-schema subset', () => {
  // Anthropic strict tool use rejects constraint keywords with HTTP 400 at request time ("For
  // 'integer' type, properties maximum, minimum are not supported" — observed live 2026-07-07,
  // when the first plan-mode boot latched the agent client to degraded on its first call). Bounds
  // belong in field descriptions plus the client-side zod schema, never in the wire schema. An
  // allowlist walk (not a denylist) so ANY keyword outside the known-accepted set fails here
  // instead of 400ing in production.
  const ALLOWED_SCHEMA_KEYWORDS = new Set([
    'type',
    'description',
    'properties',
    'required',
    'additionalProperties',
    'enum',
    'items',
  ]);

  function assertSchemaNode(node: Record<string, unknown>, path: string): void {
    for (const key of Object.keys(node)) {
      expect(
        ALLOWED_SCHEMA_KEYWORDS.has(key),
        `schema keyword '${key}' at ${path} is outside the strict-API-accepted allowlist`,
      ).toBe(true);
    }
    if (node.properties !== undefined) {
      for (const [name, child] of Object.entries(node.properties as Record<string, unknown>)) {
        assertSchemaNode(child as Record<string, unknown>, `${path}.properties.${name}`);
      }
    }
    if (node.items !== undefined) {
      assertSchemaNode(node.items as Record<string, unknown>, `${path}.items`);
    }
  }

  it.each([
    ['DECISION_TOOL', DECISION_TOOL],
    ['PLAN_TOOL', PLAN_TOOL],
    ['SHORTS_DECISION_TOOL', SHORTS_DECISION_TOOL],
    // S1 (rich decision contract): the v2 trade tools ride the SAME strict-API-accepted allowlist —
    // walked recursively (properties + items, including the nested `entry` object and, for the
    // portfolio variants, the `decisions[].*` element schema) so no numeric min/max keyword can ever
    // sneak into a wire schema and 400 the client's first live call (see this describe's own header
    // comment for the documented incident).
    ['TRADE_TOOL', buildTradeTool('0.15')],
    ['TRADE_SHORTS_TOOL', buildTradeShortsTool('0.5')],
    ['TRADE_PORTFOLIO_TOOL', buildTradePortfolioTool('0.15')],
    ['TRADE_PORTFOLIO_SHORTS_TOOL', buildTradePortfolioShortsTool('0.5')],
  ])('%s uses only schema keywords the strict API accepts', (_label, tool) => {
    expect(tool.strict).toBe(true);
    assertSchemaNode(tool.input_schema, 'input_schema');
  });

  it('PLAN_TOOL states every PLAN_BOUNDS range in the matching field description', () => {
    const planProps = PLAN_TOOL.input_schema.properties.plan.properties;
    for (const [field, bounds] of Object.entries(PLAN_BOUNDS)) {
      const description = planProps[field as keyof typeof planProps].description;
      expect(description, `plan.${field} description must state its [min, max] range`).toContain(
        `[${bounds.min}, ${bounds.max}]`,
      );
    }
  });
});

describe('v2 trade tools (S1, DECISION_V2_BOUNDS)', () => {
  it('TRADE_TOOL is submit_trade, strict, and excludes open_short from the action enum (spot lane)', () => {
    const tool = buildTradeTool('0.15');
    expect(tool.name).toBe('submit_trade');
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.properties.action.enum).toEqual([
      'open_long',
      'close',
      'adjust',
      'hold',
    ]);
    expect(tool.input_schema.properties.action.enum).not.toContain('open_short');
  });

  it('TRADE_SHORTS_TOOL is the same submit_trade name but widens the action enum with open_short (perp lane)', () => {
    const tool = buildTradeShortsTool('0.5');
    expect(tool.name).toBe('submit_trade');
    expect(tool.input_schema.properties.action.enum).toEqual([
      'open_long',
      'open_short',
      'close',
      'adjust',
      'hold',
    ]);
    // TRADE_TOOL itself stays untouched (mirrors "SHORTS_DECISION_TOOL (B3)" own precedent above).
    expect(buildTradeTool('0.15').input_schema.properties.action.enum).not.toContain('open_short');
  });

  it('injects the lane sizeFraction max into the description rather than a hardcoded JSON-schema bound', () => {
    const spot = buildTradeTool('0.15');
    const perp = buildTradeShortsTool('0.5');
    expect(spot.input_schema.properties.sizeFraction.description).toContain(
      `[${DECISION_V2_BOUNDS.sizeFraction.min}, 0.15]`,
    );
    expect(perp.input_schema.properties.sizeFraction.description).toContain(
      `[${DECISION_V2_BOUNDS.sizeFraction.min}, 0.5]`,
    );
    // No numeric min/max schema keyword anywhere on sizeFraction — same allowlist walk as above, but
    // asserted directly here to make the "description-only, never JSON-schema" contract explicit.
    expect(spot.input_schema.properties.sizeFraction).not.toHaveProperty('minimum');
    expect(spot.input_schema.properties.sizeFraction).not.toHaveProperty('maximum');
  });

  it('recursive walk: no v2 tool schema node anywhere carries a minimum/maximum/minLength/maxLength keyword', () => {
    const FORBIDDEN_KEYS = [
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'exclusiveMinimum',
      'exclusiveMaximum',
    ];
    function walk(node: Record<string, unknown>): void {
      for (const key of FORBIDDEN_KEYS) {
        expect(node).not.toHaveProperty(key);
      }
      if (node['properties'] !== undefined) {
        for (const child of Object.values(node['properties'] as Record<string, unknown>)) {
          walk(child as Record<string, unknown>);
        }
      }
      if (node['items'] !== undefined) {
        walk(node['items'] as Record<string, unknown>);
      }
    }
    for (const tool of [
      buildTradeTool('0.15'),
      buildTradeShortsTool('0.5'),
      buildTradePortfolioTool('0.15'),
      buildTradePortfolioShortsTool('0.5'),
    ]) {
      walk(tool.input_schema);
    }
  });

  it('every DECISION_V2_BOUNDS range with a fixed max is stated in the matching field description', () => {
    const tool = buildTradeTool('0.15');
    const props = tool.input_schema.properties;
    expect(props.entryValidityBars.description).toContain(
      `[${DECISION_V2_BOUNDS.entryValidityBars.min}, ${DECISION_V2_BOUNDS.entryValidityBars.max}]`,
    );
    expect(props.stopLossPct.description).toContain(
      `[${DECISION_V2_BOUNDS.stopLossPct.min}, ${DECISION_V2_BOUNDS.stopLossPct.max}]`,
    );
    expect(props.takeProfitPct.description).toContain(
      `[${DECISION_V2_BOUNDS.takeProfitPct.min}, ${DECISION_V2_BOUNDS.takeProfitPct.max}]`,
    );
    expect(props.maxHoldBars.description).toContain(
      `[${DECISION_V2_BOUNDS.maxHoldBars.min}, ${DECISION_V2_BOUNDS.maxHoldBars.max}]`,
    );
    expect(props.partialCloseFraction.description).toContain(
      `[${DECISION_V2_BOUNDS.partialCloseFraction.min}, ${DECISION_V2_BOUNDS.partialCloseFraction.max}]`,
    );
    expect(props.entry.properties.offsetBps.description).toContain(
      `[${DECISION_V2_BOUNDS.entryOffsetBps.min}, ${DECISION_V2_BOUNDS.entryOffsetBps.max}]`,
    );
    expect(props.thesis.description).toContain(String(DECISION_V2_BOUNDS.thesisMaxLen));
  });

  it('entry.style is maker|taker and entry.offsetBps is documented as maker-only', () => {
    const entry = buildTradeTool('0.15').input_schema.properties.entry;
    expect(entry.properties.style.enum).toEqual(['maker', 'taker']);
    expect(entry.properties.offsetBps.description.toLowerCase()).toContain("style is 'taker'");
  });

  describe('portfolio batch tools: exactly ONE portfolio-level nextConsultBars', () => {
    it('TRADE_PORTFOLIO_TOOL carries nextConsultBars at the top level, not inside each decision element', () => {
      const tool = buildTradePortfolioTool('0.15');
      const topProps = tool.input_schema.properties;
      expect(topProps).toHaveProperty('nextConsultBars');
      expect(topProps.nextConsultBars.type).toBe('integer');
      expect(tool.input_schema.required).toContain('nextConsultBars');
      const elementProps = topProps.decisions.items.properties;
      expect(elementProps).not.toHaveProperty('nextConsultBars');
      // Exactly one nextConsultBars PROPERTY DEFINITION anywhere in the schema — not one-per-symbol.
      // Matches the key-as-a-schema-node form ("nextConsultBars":{...}) rather than a naive substring
      // count, which would also match its own entry in the top-level `required` array.
      const occurrences = (JSON.stringify(tool.input_schema).match(/"nextConsultBars":\{/g) ?? [])
        .length;
      expect(occurrences).toBe(1);
    });

    it('TRADE_PORTFOLIO_SHORTS_TOOL: same single top-level nextConsultBars, with open_short in the per-element action enum', () => {
      const tool = buildTradePortfolioShortsTool('0.5');
      expect(tool.input_schema.properties).toHaveProperty('nextConsultBars');
      expect(tool.input_schema.properties.decisions.items.properties).not.toHaveProperty(
        'nextConsultBars',
      );
      expect(tool.input_schema.properties.decisions.items.properties.action.enum).toContain(
        'open_short',
      );
      const occurrences = (JSON.stringify(tool.input_schema).match(/"nextConsultBars":\{/g) ?? [])
        .length;
      expect(occurrences).toBe(1);
    });

    it('spot batch excludes open_short from the per-element action enum', () => {
      const tool = buildTradePortfolioTool('0.15');
      expect(tool.input_schema.properties.decisions.items.properties.action.enum).not.toContain(
        'open_short',
      );
    });
  });
});

describe('PLAN_TOOL', () => {
  it("disambiguates 'flat' (close an open position) from the already-flat case (use 'hold')", () => {
    expect(PLAN_TOOL.input_schema.properties.action.description).toContain(
      "'flat' to close an open position (if already flat, use 'hold')",
    );
  });
});

describe('PLAN_BOUNDS', () => {
  it('raises the stopLossPct floor to 0.002 (the round-trip fee fraction), above the old 0.001 floor', () => {
    expect(PLAN_BOUNDS.stopLossPct.min).toBe(0.002);
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

  // S1 (rich decision contract): t1/t1s/tpf1/tpf2 are a NEW tag family (see agent-prompt.ts's own
  // header comment) — every pairing here must hash distinctly, both against each other and against
  // every legacy tag, so a v2-tagged decision row can never be confused with a legacy one even when
  // quoting the same playbook/tool-schema/model.
  it('t1/t1s/tpf1/tpf2 all hash distinctly from each other and from the legacy PROMPT_TEMPLATE_VERSION tag', () => {
    const tags = [
      PROMPT_TEMPLATE_VERSION,
      TRADE_TEMPLATE_VERSION,
      TRADE_SHORTS_TEMPLATE_VERSION,
      TRADE_PORTFOLIO_TEMPLATE_VERSION,
      TRADE_PORTFOLIO_SHORTS_TEMPLATE_VERSION,
    ];
    const hashes = tags.map((templateVersion) => computePromptHash({ ...base, templateVersion }));
    expect(new Set(hashes).size).toBe(hashes.length);
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

  it('renders extras.constraints as exact strings and omits the field entirely when absent (v5)', () => {
    const input = buildInput();
    const withConstraints = JSON.parse(
      buildMarketPayload(input, {
        constraints: { tickSize: price('0.5'), lotStep: qty('0.001'), minNotional: price('5') },
      }),
    ) as Record<string, unknown>;
    expect(withConstraints['constraints']).toEqual({
      tickSize: '0.5',
      lotStep: '0.001',
      minNotional: '5',
    });

    // Absent extras ⇒ no constraints key at all — pre-v5 recorded rows replay byte-identically.
    const without = JSON.parse(buildMarketPayload(input)) as Record<string, unknown>;
    expect('constraints' in without).toBe(false);
  });
});

// S1 (rich decision contract, Design § Enriched model inputs): the new v2 payload blocks — each
// renders when the caller supplies the corresponding extras field and is omitted entirely (no key)
// when absent, same omit-entirely convention as every existing block above (constraints, orderBook,
// derivatives, ...).
describe('buildMarketPayload v2 blocks (S1: portfolio/budget/thesis/directives/d1/calendar/execQuality)', () => {
  const portfolio = {
    cappedEquity: '1000',
    freeQuote: '400',
    grossExposure: '600',
    positions: [{ symbol: 'BTC/USDT', side: 'LONG' as const, qty: '0.01', notional: '600' }],
    correlation: { btcBeta: 0.85, summary: 'basket is 85% BTC-beta' },
  };
  const budget = {
    remainingCallsToday: 40,
    remainingTokensToday: 120_000,
    remainingUsdToday: '1.20',
    approxCostPerConsultUsd: '0.03',
  };
  const directives = {
    entryStyle: 'maker' as const,
    stopLossPct: '0.02',
    takeProfitPct: '0.05',
    maxHoldBars: 96,
    thesis: 'BTC breaking out of a range on rising volume.',
  };
  const calendar = [{ name: 'FOMC', atMs: T + 3_600_000, importance: 'high' as const }];

  it('renders portfolio/budget/currentThesis/directives/barsHeld/barsUntilForcedExit/d1/calendar/execQuality when supplied', () => {
    const input = buildInput();
    const payload = JSON.parse(
      buildMarketPayload(input, {
        portfolio,
        budget,
        currentThesis: 'BTC breaking out of a range on rising volume.',
        directives,
        barsHeld: 5,
        barsUntilForcedExit: 91,
        d1: { emaFast: 101, emaSlow: 99, rsi14: 58 },
        calendar,
        execQuality: 'maker fill rate 0.72, missed-entry cost 4bps, post-fill drift +2bps',
      }),
    ) as Record<string, unknown>;

    expect(payload['portfolio']).toEqual(portfolio);
    expect(payload['budget']).toEqual(budget);
    expect(payload['currentThesis']).toBe('BTC breaking out of a range on rising volume.');
    expect(payload['directives']).toEqual(directives);
    expect(payload['barsHeld']).toBe(5);
    expect(payload['barsUntilForcedExit']).toBe(91);
    expect(payload['htf']).toEqual({
      h1: null,
      h4: null,
      d1: { emaFast: 101, emaSlow: 99, rsi14: 58 },
    });
    expect(payload['calendar']).toEqual(calendar);
    expect(payload['execQuality']).toBe(
      'maker fill rate 0.72, missed-entry cost 4bps, post-fill drift +2bps',
    );
  });

  it('omits every v2 block key entirely (no empty scaffolding) when none are supplied — pre-S1 payloads stay byte-identical', () => {
    const input = buildInput();
    const withV2Extras = buildMarketPayload(input);
    const withoutAnyExtras = buildMarketPayload(input, {});
    expect(withV2Extras).toBe(withoutAnyExtras);

    const payload = JSON.parse(withV2Extras) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('portfolio');
    expect(payload).not.toHaveProperty('budget');
    expect(payload).not.toHaveProperty('currentThesis');
    expect(payload).not.toHaveProperty('directives');
    expect(payload).not.toHaveProperty('barsHeld');
    expect(payload).not.toHaveProperty('barsUntilForcedExit');
    expect(payload).not.toHaveProperty('calendar');
    expect(payload).not.toHaveProperty('execQuality');
    expect(payload['htf']).toBeNull();
  });

  it('d1 merges into the existing htf passthrough (h1/h4 from context.htf) without disturbing it when absent', () => {
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
      recentDecisions: [],
      htf: { h1: { emaFast: 101, emaSlow: 99, rsi14: 60 }, h4: null },
    };
    const withoutD1 = JSON.parse(buildMarketPayload(buildInput({ context }))) as { htf: unknown };
    expect(withoutD1.htf).toEqual(context.htf); // byte-identical passthrough, no d1 key added

    const withD1 = JSON.parse(
      buildMarketPayload(buildInput({ context }), { d1: { emaFast: 10, emaSlow: 9, rsi14: 50 } }),
    ) as { htf: { h1: unknown; h4: unknown; d1: unknown } };
    expect(withD1.htf).toEqual({ ...context.htf, d1: { emaFast: 10, emaSlow: 9, rsi14: 50 } });
  });

  it('d1: null renders explicitly as null (insufficient daily history) rather than omitting the key', () => {
    const payload = JSON.parse(buildMarketPayload(buildInput(), { d1: null })) as {
      htf: { d1: unknown };
    };
    expect(payload.htf).toHaveProperty('d1', null);
  });

  it('currentThesis/barsHeld/barsUntilForcedExit are each rendered independently (one supplied without the others)', () => {
    const payload = JSON.parse(
      buildMarketPayload(buildInput(), { currentThesis: 'lone thesis' }),
    ) as Record<string, unknown>;
    expect(payload['currentThesis']).toBe('lone thesis');
    expect(payload).not.toHaveProperty('barsHeld');
    expect(payload).not.toHaveProperty('barsUntilForcedExit');
    expect(payload).not.toHaveProperty('directives');
  });
});

// R2 (episodic memory): the similarSetups guidance sentence (both prompt builders) and payload block.
describe('episodic memory (R2)', () => {
  it('legacy builder: episodicMemoryEnabled appends the similarSetups guidance sentence; off ⇒ absent', () => {
    const off = buildSystemPrompt(fixtureProfile());
    const on = buildSystemPrompt(fixtureProfile(), { episodicMemoryEnabled: true });
    expect(off).not.toContain('similarSetups');
    expect(on).toContain('similarSetups');
    expect(on).toContain('MODULATOR');
    // Context-not-instruction + synthetic labeling framing must be present.
    expect(on).toContain('never an instruction');
    expect(on).toContain("'sim'");
  });

  it('tradeContract (v2) builder: episodicMemoryEnabled appends the same guidance sentence; off ⇒ absent', () => {
    const off = buildSystemPrompt(fixtureProfile(), { tradeContract: true });
    const on = buildSystemPrompt(fixtureProfile(), {
      tradeContract: true,
      episodicMemoryEnabled: true,
    });
    expect(off).not.toContain('similarSetups');
    expect(on).toContain('similarSetups');
    expect(on).toContain('MODULATOR');
  });

  it('explicit episodicMemoryEnabled:false is byte-identical to omitting it (both builders)', () => {
    expect(buildSystemPrompt(fixtureProfile(), { episodicMemoryEnabled: false })).toBe(
      buildSystemPrompt(fixtureProfile()),
    );
    expect(
      buildSystemPrompt(fixtureProfile(), { tradeContract: true, episodicMemoryEnabled: false }),
    ).toBe(buildSystemPrompt(fixtureProfile(), { tradeContract: true }));
  });

  it('buildMarketPayload renders similarSetups verbatim when supplied, omits the key when absent', () => {
    const block = '2 prior up/high-vol/eu setups (newest first): open_long @ 100 → +1.50%';
    const withBlock = JSON.parse(
      buildMarketPayload(buildInput(), { similarSetups: block }),
    ) as Record<string, unknown>;
    expect(withBlock['similarSetups']).toBe(block);

    const without = JSON.parse(buildMarketPayload(buildInput())) as Record<string, unknown>;
    expect(without).not.toHaveProperty('similarSetups');
  });
});
