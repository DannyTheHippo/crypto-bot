import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  AgenticStrategy,
  evaluateConsultSchedule,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
  type ConsultGateOutcome,
} from '../../../../src/features/strategy/agentic/agentic.strategy';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { CandleEvent } from '../../../../src/domain/venue/types/market-events';
import type { ExecReport } from '../../../../src/domain/trading/types/exec-report';
import type { Position } from '../../../../src/domain/trading/types/portfolio';
import { price, qty } from '../../../../src/domain/common/types/money';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
} from '../../../../src/domain/common/types/ids';

// B2 (Design § Deleted scaffolding): evaluateConsultSchedule replaces prescreen.ts — these specs
// exercise it end-to-end through AgenticStrategy.decide() (mirrors stale-entry-sweep.spec.ts's own
// harness pattern: a stub client counting calls, a synthetic bar-by-bar snapshot builder), since the
// gate's effect is only observable as "did decide() call the client this bar", not as a standalone
// unit under test.

const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const STEP_MS = 900_000; // 15m
const BASE_TIME = 14_400_000 * 100_000;
const COID = 'cbp0000000000000007000800000000000001';

function candle(index: number, close: number): CandleEvent {
  const t = BASE_TIME + index * STEP_MS;
  const p = price(String(close));
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: SYM,
    channel: 'candle:15m',
    seq: BigInt(index + 1),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '15m',
    openTime: epochMs(t),
    closeTime: epochMs(t + STEP_MS),
    open: p,
    high: p,
    low: p,
    close: p,
    volume: qty('1'),
    closed: true,
  };
}

function execEvent(index: number): ExecReport {
  return {
    kind: 'ACK',
    reportId: `r${index}`,
    clientOrderId: clientOrderId(COID),
    venue: V,
    symbol: SYM,
    eventTime: epochMs(BASE_TIME + index * STEP_MS),
    ingestTime: epochMs(BASE_TIME + index * STEP_MS + 1),
    venueOrderId: `vo${index}`,
  };
}

interface BuildInputOpts {
  readonly trigger?: 'candle' | 'exec';
  readonly close?: number;
  readonly openPosition?: boolean;
}

// One decide cycle at bar `index`. Every prior bar closes flat at 100 — only the CURRENT bar's close
// (opts.close, default 100) is ever meaningful to evaluateConsultSchedule (it reads only the last
// candle).
function buildInput(index: number, opts: BuildInputOpts = {}): AgentDecisionInput {
  const close = opts.close ?? 100;
  const candles = Array.from({ length: index + 1 }, (_, i) => candle(i, i === index ? close : 100));
  const positions = new Map<string, Position>();
  if (opts.openPosition) {
    positions.set(`${SID}:${V}:${SYM}`, {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      signedQty: new Decimal('1'),
      avgEntry: price('100'),
      realizedPnl: new Decimal('0'),
    });
  }
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(BASE_TIME + index * STEP_MS),
    candles: new Map([[SYM, candles]]),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions, openOrders: [] },
  };
  const trigger: AgentDecisionInput['trigger'] =
    opts.trigger === 'exec'
      ? { kind: 'exec', event: execEvent(index) }
      : { kind: 'candle', event: candle(index, close) };
  return { strategyId: SID, trigger, snapshot };
}

// Always accepts (never rejects on bounds/edge floors — out of scope here), returns a 'hold' decision
// and the configured portfolio-level nextConsultBars (undefined ⇒ no schedule, mirrors a client that
// never batches / a decision that never sets one).
class ScheduledClient implements AgentClientPort {
  readonly calls: AgentDecisionInput[] = [];
  constructor(private readonly nextConsultBars: number | undefined) {}
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    this.calls.push(input);
    return Promise.resolve({
      signals: [],
      decision: { action: 'hold', confidence: 0, rationale: 'test' },
      nextConsultBars: this.nextConsultBars,
    });
  }
}

function makeStrategy(
  client: AgentClientPort,
  onConsultGate: (outcome: ConsultGateOutcome) => void,
  extraDeps: Partial<AgenticStrategyDeps> = {},
) {
  const params: AgenticStrategyParams = {
    symbol: SYM,
    venue: V,
    interval: '15m',
    warmupBars: 5,
    model: 'test-model',
  };
  const deps: AgenticStrategyDeps = { onConsultGate, ...extraDeps };
  return new AgenticStrategy(SID, params, client, deps);
}

describe('AgenticStrategy consult schedule (B2)', () => {
  it('(a) is quiet while barsSinceConsult < the portfolio schedule, then consults once it is reached', async () => {
    const gates: ConsultGateOutcome[] = [];
    const client = new ScheduledClient(4);
    const strategy = makeStrategy(client, (o) => gates.push(o));

    // Seed the schedule via a fill — deterministic, independent of the fallback bootstrap path —
    // so bars 1-3 are genuinely "quiet under an active schedule=4", the scenario under test.
    await strategy.decide(buildInput(0, { trigger: 'exec' }));
    expect(client.calls).toHaveLength(1);
    expect(gates.at(-1)).toBe('forced_fill');

    await strategy.decide(buildInput(1));
    await strategy.decide(buildInput(2));
    await strategy.decide(buildInput(3));
    expect(client.calls).toHaveLength(1); // bars 1-3: still just the seed call
    expect(gates.slice(-3)).toEqual([
      'skipped_scheduled',
      'skipped_scheduled',
      'skipped_scheduled',
    ]);

    await strategy.decide(buildInput(4));
    expect(client.calls).toHaveLength(2); // bar 4: schedule reached
    expect(gates.at(-1)).toBe('consulted');
  });

  it('(b) an exec trigger forces a consult regardless of the schedule state and resets the clock', async () => {
    const gates: ConsultGateOutcome[] = [];
    const client = new ScheduledClient(4);
    const strategy = makeStrategy(client, (o) => gates.push(o));

    await strategy.decide(buildInput(0)); // no schedule yet, fallback far away — quiet
    await strategy.decide(buildInput(1)); // quiet
    expect(client.calls).toHaveLength(0);

    await strategy.decide(buildInput(2, { trigger: 'exec' }));
    expect(client.calls).toHaveLength(1);
    expect(gates.at(-1)).toBe('forced_fill');

    // Reset proven: the very next bar is quiet under the freshly re-established schedule=4, not an
    // immediate re-consult.
    await strategy.decide(buildInput(3));
    expect(client.calls).toHaveLength(1);
    expect(gates.at(-1)).toBe('skipped_scheduled');
  });

  it('(c) a >=1.5% close move since the last consult forces a consult; a 1.4% move does not', async () => {
    const gatesUp: ConsultGateOutcome[] = [];
    const clientUp = new ScheduledClient(100); // schedule far away — isolates the wake-move check
    const strategyUp = makeStrategy(clientUp, (o) => gatesUp.push(o));
    await strategyUp.decide(buildInput(0, { trigger: 'exec', close: 100 })); // seeds lastConsultPrice
    expect(clientUp.calls).toHaveLength(1);

    await strategyUp.decide(buildInput(1, { close: 101.6 })); // +1.6%
    expect(clientUp.calls).toHaveLength(2);
    expect(gatesUp.at(-1)).toBe('forced_move');

    const gatesFlat: ConsultGateOutcome[] = [];
    const clientFlat = new ScheduledClient(100);
    const strategyFlat = makeStrategy(clientFlat, (o) => gatesFlat.push(o));
    await strategyFlat.decide(buildInput(0, { trigger: 'exec', close: 100 }));
    expect(clientFlat.calls).toHaveLength(1);

    await strategyFlat.decide(buildInput(1, { close: 101.4 })); // +1.4%
    expect(clientFlat.calls).toHaveLength(1); // unchanged — stayed quiet
    expect(gatesFlat.at(-1)).toBe('skipped_scheduled');
  });

  it('(d) an open position with no armed directives consults immediately (restart re-arm)', async () => {
    const gates: ConsultGateOutcome[] = [];
    const client = new ScheduledClient(undefined);
    const strategy = makeStrategy(client, (o) => gates.push(o));

    await strategy.decide(buildInput(0, { openPosition: true }));
    expect(client.calls).toHaveLength(1);
    expect(gates.at(-1)).toBe('forced_rearm');
  });

  it('(e) with no schedule ever set, the fallback cadence consults every fallbackConsultBars (16)', async () => {
    const gates: ConsultGateOutcome[] = [];
    const client = new ScheduledClient(undefined); // never returns a schedule — fallback governs
    const strategy = makeStrategy(client, (o) => gates.push(o));

    for (let bar = 0; bar < 15; bar += 1) {
      await strategy.decide(buildInput(bar));
    }
    expect(client.calls).toHaveLength(0);

    await strategy.decide(buildInput(15));
    expect(client.calls).toHaveLength(1);
    expect(gates.at(-1)).toBe('forced_fallback');

    // Cycle repeats: another 15 quiet bars, then the 32nd bar overall fires again.
    for (let bar = 16; bar < 31; bar += 1) {
      await strategy.decide(buildInput(bar));
    }
    expect(client.calls).toHaveLength(1);
    await strategy.decide(buildInput(31));
    expect(client.calls).toHaveLength(2);
    expect(gates.at(-1)).toBe('forced_fallback');
  });

  // XA1 (A0 activation bundle): off-menu idle symbols stay quiet at the GATE — previously they
  // recorded forced_* outcomes every fallback cycle and had their consult clock + wake baseline
  // reset by the batching client's inert menu-hold without ever consulting.
  it('(f) XA1: an off-menu flat symbol never consults and records only skipped_scheduled', async () => {
    const gates: ConsultGateOutcome[] = [];
    const client = new ScheduledClient(undefined);
    const strategy = makeStrategy(client, (o) => gates.push(o), {
      menuGate: { isActive: () => false },
    });

    for (let bar = 0; bar < 20; bar += 1) {
      await strategy.decide(buildInput(bar)); // well past the 16-bar fallback
    }
    expect(client.calls).toHaveLength(0);
    expect(new Set(gates)).toEqual(new Set(['skipped_scheduled']));
  });

  it('(g) XA1: menu re-entry fires the fallback consult immediately (clock kept climbing off-menu)', async () => {
    const gates: ConsultGateOutcome[] = [];
    let active = false;
    const client = new ScheduledClient(undefined);
    const strategy = makeStrategy(client, (o) => gates.push(o), {
      menuGate: { isActive: () => active },
    });

    for (let bar = 0; bar < 20; bar += 1) {
      await strategy.decide(buildInput(bar));
    }
    expect(client.calls).toHaveLength(0);

    active = true; // scanner promotes the symbol onto the menu
    await strategy.decide(buildInput(20));
    expect(client.calls).toHaveLength(1);
    expect(gates.at(-1)).toBe('forced_fallback');
  });

  it('(h) XA1: forced_fill and forced_rearm bypass the menu gate (defense in depth)', async () => {
    const gatesFill: ConsultGateOutcome[] = [];
    const clientFill = new ScheduledClient(undefined);
    const strategyFill = makeStrategy(clientFill, (o) => gatesFill.push(o), {
      menuGate: { isActive: () => false },
    });
    await strategyFill.decide(buildInput(0, { trigger: 'exec' }));
    expect(clientFill.calls).toHaveLength(1);
    expect(gatesFill.at(-1)).toBe('forced_fill');

    const gatesRearm: ConsultGateOutcome[] = [];
    const clientRearm = new ScheduledClient(undefined);
    const strategyRearm = makeStrategy(clientRearm, (o) => gatesRearm.push(o), {
      menuGate: { isActive: () => false },
    });
    await strategyRearm.decide(buildInput(0, { openPosition: true }));
    expect(clientRearm.calls).toHaveLength(1);
    expect(gatesRearm.at(-1)).toBe('forced_rearm');
  });
});

// XA1/XA5: pure evaluateConsultSchedule gate priority — the menu gate and repeated-noop breaker
// both quiet a symbol, but the unconditional fill/re-arm overrides must still win above them.
describe('evaluateConsultSchedule gate priority (XA1 menu + XA5 noop)', () => {
  const base = {
    state: { barsSinceConsult: 100, scheduledConsultBars: 1, lastConsultPrice: 100 },
    isExecTrigger: false,
    hasOpenPositionWithoutDirectives: false,
    lastClose: 100,
    wakeMovePct: 0.008,
    fallbackConsultBars: 8,
  };

  it('menuActive:false quiets an otherwise-due symbol', () => {
    expect(evaluateConsultSchedule({ ...base, menuActive: false })).toBe('skipped_scheduled');
  });

  it('noopSuppressed quiets an otherwise-due symbol', () => {
    expect(evaluateConsultSchedule({ ...base, noopSuppressed: true })).toBe('skipped_scheduled');
  });

  it('a fill overrides BOTH the menu gate and the noop breaker (forced_fill)', () => {
    expect(
      evaluateConsultSchedule({
        ...base,
        isExecTrigger: true,
        menuActive: false,
        noopSuppressed: true,
      }),
    ).toBe('forced_fill');
  });

  it('a positioned symbol without directives re-arms regardless of the noop breaker (forced_rearm)', () => {
    expect(
      evaluateConsultSchedule({
        ...base,
        hasOpenPositionWithoutDirectives: true,
        noopSuppressed: true,
      }),
    ).toBe('forced_rearm');
  });

  it('absent flags default to consulting (fail OPEN)', () => {
    expect(evaluateConsultSchedule(base)).toBe('consulted');
  });
});
