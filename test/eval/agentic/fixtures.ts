// Shared support code for the agentic eval harness (test/eval/agentic/*.spec.ts). Not itself a
// test file — Vitest's default include glob only picks up *.spec.ts/*.test.ts, so this module is
// only ever reached via import.
import { AnthropicAgentClient } from '../../../src/features/trading/agentic/anthropic-agent-client';
import { price, qty } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type {
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentTradingProfile,
} from '../../../src/ports/agentic-strategy';
import type { ScoringRow } from '../../../src/features/trading/agentic/counterfactual-scoring';

export const T = 1_700_000_000_000;
export const SID = strategyId('agentic-eval');
export const V = venueId('binance');
export const SYM = symbolId('BTC/USDT');

export const EVAL_PROFILE: AgentTradingProfile = {
  makerBps: '10',
  takerBps: '10',
  baseNotional: '100',
  maxOrderNotional: '400',
  constraints: { tickSize: price('0.01'), lotStep: qty('0.0001'), minNotional: price('10') },
};

export function evalCandle(index: number, closeStr: string): CandleEvent {
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

export function evalInput(candle: CandleEvent): AgentDecisionInput {
  const snapshot: AgentMarketSnapshot = {
    eventTime: candle.eventTime,
    candles: new Map([[SYM, [candle]]]),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
  };
  return { strategyId: SID, trigger: { kind: 'candle', event: candle }, snapshot };
}

export interface ScriptedDecision {
  readonly action: 'long' | 'flat' | 'hold';
  readonly confidence: number;
  readonly rationale?: string;
}

function toolUseResponseBody(decision: ScriptedDecision): unknown {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        name: 'submit_decision',
        input: {
          action: decision.action,
          confidence: decision.confidence,
          rationale: decision.rationale ?? 'eval fixture rationale',
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

function fakeResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

export interface AnthropicRequestBody {
  readonly model: string;
  readonly system: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}

// Returns the next scripted decision on each call, in order, as a canned 200 tool-use response —
// no network I/O. `requestLog` (if supplied) collects every parsed request body so a caller can
// assert the REAL system/user prompt was actually sent. Throws if called more times than the
// script provides, so a mis-wired test fails loudly instead of silently reusing the last response.
export function scriptedFetch(
  script: readonly ScriptedDecision[],
  requestLog: AnthropicRequestBody[] = [],
): typeof fetch {
  let callIndex = 0;
  return ((_url: string, init?: RequestInit) => {
    if (init?.body) requestLog.push(JSON.parse(init.body as string) as AnthropicRequestBody);
    if (callIndex >= script.length) {
      throw new Error(`scriptedFetch: no scripted decision left for call #${callIndex}`);
    }
    const decision = script[callIndex]!;
    callIndex++;
    return Promise.resolve(fakeResponse(toolUseResponseBody(decision)));
  }) as unknown as typeof fetch;
}

export interface ReplayResult {
  readonly rows: ScoringRow[];
  readonly requestLog: AnthropicRequestBody[];
}

// Drives the REAL buildSystemPrompt/buildUserMessage (via AnthropicAgentClient internally) through
// one candle per scripted decision, mapping each AgentProposal into a ScoringRow. This is a
// deliberately minimal test-harness mapping (refPrice/close both come straight from the fixture
// candle's own close) — not a reproduction of agentic.strategy.ts's production journal-writer,
// which this task does not touch.
export async function replay(
  playbookContent: string,
  model: string,
  closes: readonly string[],
  script: readonly ScriptedDecision[],
): Promise<ReplayResult> {
  const requestLog: AnthropicRequestBody[] = [];
  const client = new AnthropicAgentClient(
    {
      apiKey: 'sk-ant-eval-fixture',
      model,
      timeoutMs: 5000,
      maxTokens: 256,
      signalTtlMs: 60_000,
      profile: EVAL_PROFILE,
    },
    scriptedFetch(script, requestLog),
    undefined,
    { current: () => Promise.resolve({ version: 1, content: playbookContent }) },
  );

  const rows: ScoringRow[] = [];
  for (let i = 0; i < closes.length; i++) {
    const candle = evalCandle(i, closes[i]!);
    const input = evalInput(candle);
    const proposal = await client.propose(input);
    rows.push({
      eventTime: input.snapshot.eventTime,
      action: proposal.decision?.action ?? 'error',
      confidence: proposal.decision?.confidence ?? null,
      refPrice: candle.close.toFixed(),
      close: candle.close.toFixed(),
      playbookVersion: proposal.playbookVersion ?? null,
      promptHash: proposal.promptHash ?? 'unknown',
    });
  }
  return { rows, requestLog };
}
