import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import * as prescreenModule from '../../../src/features/trading/agentic/prescreen';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
} from '../../../src/features/trading/agentic/agentic.strategy';
import type { PrescreenThresholds } from '../../../src/features/trading/agentic/prescreen';
import type {
  AgentClientPort,
  AgentDecisionEntry,
  AgentDecisionInput,
  AgentDecisionJournalPort,
  AgentDecisionRow,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../src/ports/agentic-strategy';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type { Position, StrategyPortfolioView } from '../../../src/domain/types/portfolio';
import { price, qty } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

const THRESHOLDS: PrescreenThresholds = {
  volShortBars: 5,
  volLongBars: 20,
  volRatio: 2,
  breakoutLookbackBars: 10,
  breakoutPct: 0.005,
};

function candle(closeStr: string, index = 0): CandleEvent {
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
    open: price(closeStr),
    high: price(closeStr),
    low: price(closeStr),
    close: price(closeStr),
    volume: qty('1'),
    closed: true,
  };
}

// 25-bar window built to clear every consult trigger under THRESHOLDS. A steady 3-bar-repeating
// oscillation (100/103/97) runs the whole 20-bar long window AND the whole 10-bar breakout-lookback
// window, so shortStdev/longStdev sit near 1 (no vol_expansion, ratio threshold 2) and the final
// close (100) sits near the midpoint of the last-10-bar high (103) / low (97) — 2.9%/3.1% clear of
// each edge, well past breakoutPct (0.5%).
function quietCandles(): CandleEvent[] {
  const pattern = ['100', '103', '97'];
  return Array.from({ length: 25 }, (_, i) => candle(pattern[i % pattern.length]!, i));
}

// A short-window spike over an otherwise-flat long window: trips vol_expansion (shortStdev/longStdev
// > volRatio) without needing an open position.
function volExpansionCandles(): CandleEvent[] {
  const flat = Array.from({ length: 20 }, (_, i) => candle('100', i));
  const spike = ['100', '105', '95', '108', '92'].map((c, i) => candle(c, 20 + i));
  return [...flat, ...spike];
}

function emptyPortfolio(): StrategyPortfolioView {
  return { strategyId: SID, positions: new Map(), openOrders: [] };
}

function longPortfolio(): StrategyPortfolioView {
  const position: Position = {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    signedQty: new Decimal('2.5'),
    avgEntry: price('100'),
    realizedPnl: new Decimal('0'),
  };
  return { strategyId: SID, positions: new Map([['p1', position]]), openOrders: [] };
}

function buildInput(
  opts: { candles?: CandleEvent[]; portfolio?: StrategyPortfolioView; eventTime?: number } = {},
): AgentDecisionInput {
  const et = opts.eventTime ?? T;
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(et),
    candles: opts.candles ? new Map([[SYM, opts.candles]]) : new Map(),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: opts.portfolio ?? emptyPortfolio(),
  };
  return {
    strategyId: SID,
    trigger: { kind: 'candle', event: candle('100') },
    snapshot,
  };
}

class CapturingAgentClient implements AgentClientPort {
  readonly inputs: AgentDecisionInput[] = [];
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    this.inputs.push(input);
    return Promise.resolve({ signals: [] });
  }
}

class RecordingJournal implements AgentDecisionJournalPort {
  readonly entries: AgentDecisionEntry[] = [];
  record(entry: AgentDecisionEntry): void {
    this.entries.push(entry);
  }
  recent(limit: number): Promise<readonly AgentDecisionRow[]> {
    void limit;
    return Promise.resolve([]);
  }
}

function makeStrategy(
  client: AgentClientPort,
  opts: {
    deps?: AgenticStrategyDeps;
    prescreenEnabled?: boolean;
    prescreenThresholds?: PrescreenThresholds;
  } = {},
): AgenticStrategy {
  const params: AgenticStrategyParams = {
    symbol: SYM,
    venue: V,
    interval: '1m',
    warmupBars: 2,
    model: 'test-model',
    prescreenEnabled: opts.prescreenEnabled,
    prescreenThresholds: opts.prescreenThresholds ?? THRESHOLDS,
  };
  return new AgenticStrategy(SID, params, client, opts.deps);
}

describe('AgenticStrategy prescreen gate', () => {
  it('bypasses the gate entirely when disabled: client is called, callback never fires', async () => {
    const client = new CapturingAgentClient();
    const onPrescreen = vi.fn();
    const strategy = makeStrategy(client, {
      prescreenEnabled: false,
      deps: { onPrescreen },
    });

    await strategy.decide(buildInput({ candles: quietCandles(), portfolio: emptyPortfolio() }));

    expect(client.inputs).toHaveLength(1);
    expect(onPrescreen).not.toHaveBeenCalled();
  });

  it('skips the LLM call in a quiet, flat market: journals a deterministic hold, calls back skipped_quiet', async () => {
    const client = new CapturingAgentClient();
    const journal = new RecordingJournal();
    const onPrescreen = vi.fn();
    const strategy = makeStrategy(client, {
      prescreenEnabled: true,
      deps: { journal, onPrescreen },
    });

    const signals = await strategy.decide(
      buildInput({ candles: quietCandles(), portfolio: emptyPortfolio() }),
    );

    expect(client.inputs).toHaveLength(0);
    expect(signals).toEqual([]);
    expect(onPrescreen).toHaveBeenCalledExactlyOnceWith('skipped_quiet');
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]!.action).toBe('hold');
    expect(journal.entries[0]!.model).toBe('prescreen');
    expect(journal.entries[0]!.rationale).toContain('quiet');
  });

  it('consults the LLM on volatility expansion even with no position open, calling back called', async () => {
    const client = new CapturingAgentClient();
    const onPrescreen = vi.fn();
    const strategy = makeStrategy(client, {
      prescreenEnabled: true,
      deps: { onPrescreen },
    });

    const signals = await strategy.decide(
      buildInput({ candles: volExpansionCandles(), portfolio: emptyPortfolio() }),
    );

    expect(client.inputs).toHaveLength(1);
    expect(signals).toEqual([]);
    expect(onPrescreen).toHaveBeenCalledExactlyOnceWith('called');
  });

  it('always consults the LLM when a position is open, regardless of how quiet the market is', async () => {
    const client = new CapturingAgentClient();
    const onPrescreen = vi.fn();
    const strategy = makeStrategy(client, {
      prescreenEnabled: true,
      deps: { onPrescreen },
    });

    await strategy.decide(buildInput({ candles: quietCandles(), portfolio: longPortfolio() }));

    expect(client.inputs).toHaveLength(1);
    expect(onPrescreen).toHaveBeenCalledExactlyOnceWith('called');
  });

  it('still fires onClosedTrade for a round trip that closes on a quiet candle, even though the gate then skips the LLM (trackClosedTrade runs before evaluatePrescreenGate)', async () => {
    const client = new CapturingAgentClient();
    const journal = new RecordingJournal();
    const onClosedTrade = vi.fn();
    const onPrescreen = vi.fn();
    const strategy = makeStrategy(client, {
      prescreenEnabled: true,
      deps: { journal, onClosedTrade, onPrescreen },
    });

    // Call 1: position open — the gate always consults with a position open (see the test above),
    // so this establishes lastPositionSide = 'LONG' via a real (non-quiet-skipped) decide().
    await strategy.decide(buildInput({ candles: quietCandles(), portfolio: longPortfolio() }));
    expect(client.inputs).toHaveLength(1);

    // Call 2: the position has since closed (portfolio now flat) on an otherwise quiet candle —
    // decide() must still detect the LONG→FLAT transition and fire onClosedTrade, THEN evaluate the
    // prescreen gate (which now sees a flat, quiet market and skips the LLM call).
    const signals = await strategy.decide(
      buildInput({ candles: quietCandles(), portfolio: emptyPortfolio() }),
    );

    expect(onClosedTrade).toHaveBeenCalledExactlyOnceWith(1);
    expect(client.inputs).toHaveLength(1); // unchanged: the second call never reached the LLM
    expect(signals).toEqual([]);
    expect(onPrescreen).toHaveBeenNthCalledWith(2, 'skipped_quiet');
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[1]!.model).toBe('prescreen');
  });

  it('fails open to the LLM when the prescreen evaluation throws, calling back failopen_error', async () => {
    const client = new CapturingAgentClient();
    const onPrescreen = vi.fn();
    const warn = vi.fn();
    // Stubs the pure evaluatePrescreen function itself to throw, isolating the strategy's own
    // try/catch/fail-open wiring from prescreen.ts's internal decision logic (already covered by
    // prescreen.spec.ts) — evaluatePrescreen never throws for any well-typed input in practice, so
    // this is the only deterministic way to exercise the strategy's catch branch.
    const spy = vi.spyOn(prescreenModule, 'evaluatePrescreen').mockImplementation(() => {
      throw new Error('boom');
    });
    const strategy = makeStrategy(client, {
      prescreenEnabled: true,
      deps: { onPrescreen, logger: { warn } },
    });

    const signals = await strategy.decide(
      buildInput({ candles: quietCandles(), portfolio: emptyPortfolio() }),
    );

    expect(client.inputs).toHaveLength(1);
    expect(signals).toEqual([]);
    expect(onPrescreen).toHaveBeenCalledExactlyOnceWith('failopen_error');
    expect(warn).toHaveBeenCalledOnce();

    spy.mockRestore();
  });
});
