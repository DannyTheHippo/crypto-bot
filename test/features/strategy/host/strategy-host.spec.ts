import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  StrategyHost,
  type AgenticHostOptions,
} from '../../../../src/features/strategy/agentic/strategy-host';
import { StrategyRegistry } from '../../../../src/features/strategy/agentic/strategy-registry';
import type { MarketStreamPort, FeedHealthPort } from '../../../../src/ports/venue/market-data';
import type { SignalSinkPort } from '../../../../src/ports/strategy/strategy';
import type {
  AsyncStrategy,
  AgentDecisionInput,
  StrategyInitContext,
  SymbolConstraints,
} from '../../../../src/ports/strategy/agentic-strategy';
import type {
  MarketEvent,
  CandleEvent,
  CandleInterval,
} from '../../../../src/domain/venue/types/market-events';
import type { ExecReport } from '../../../../src/domain/trading/types/exec-report';
import type { Signal } from '../../../../src/domain/strategy/types/signal';
import type { SubscriptionSpec } from '../../../../src/domain/venue/types/subscription';
import type {
  Position,
  StrategyPortfolioView,
} from '../../../../src/domain/trading/types/portfolio';
import { price, qty } from '../../../../src/domain/common/types/money';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
  type StrategyId,
} from '../../../../src/domain/common/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');

function candle(t: number, closed = true, symbol = S): CandleEvent {
  return {
    kind: 'CANDLE',
    venue: V,
    symbol,
    channel: 'candle:1m',
    seq: BigInt(t),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '1m',
    openTime: epochMs(t),
    closeTime: epochMs(t + 1),
    open: price('100'),
    high: price('100'),
    low: price('100'),
    close: price('100'),
    volume: qty('1'),
    closed,
  };
}

function ticker(t: number): MarketEvent {
  return {
    kind: 'TICKER',
    venue: V,
    symbol: S,
    channel: 'ticker',
    seq: BigInt(t),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    bid: price('99'),
    ask: price('101'),
    last: price('100'),
  };
}

function book(t: number): MarketEvent {
  return {
    kind: 'ORDER_BOOK_SNAPSHOT',
    venue: V,
    symbol: S,
    channel: 'book',
    seq: BigInt(t),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    bids: [{ price: price('99'), qty: qty('1') }],
    asks: [{ price: price('101'), qty: qty('1') }],
  };
}

function execReport(t: number): ExecReport {
  return {
    reportId: `r${t}`,
    clientOrderId: clientOrderId('cbp0000000000000007000800000000000000'),
    venue: V,
    symbol: S,
    eventTime: epochMs(t),
    ingestTime: epochMs(t),
    kind: 'ACK',
    venueOrderId: 'v',
  };
}

function sig(id: StrategyId, kind: Signal['kind'], t: number): Signal {
  return {
    strategyId: id,
    venue: V,
    symbol: S,
    kind,
    strength: 1,
    refPrice: price('100'),
    basedOnSeq: 1n,
    eventTime: epochMs(t),
    ttlMs: 1000,
    dedupeKey: `${id}:${kind}:${t}`,
    reason: 'test',
  };
}

// Minimal fake AsyncStrategy: `decide` is fully caller-controlled (resolve/reject/never-resolve),
// so every host branch (conflate, timeout, drain) is reproducible without depending on the
// concrete AgenticStrategy/agent-client wiring (owned by a concurrent change elsewhere).
class ProgrammableStrategy implements AsyncStrategy {
  readonly kind = 'agentic' as const;
  readonly subscriptions: SubscriptionSpec;
  calls = 0;
  readonly inputs: AgentDecisionInput[] = [];
  stopped = false;
  initCtx?: StrategyInitContext;

  constructor(
    readonly id: StrategyId,
    readonly warmup: { readonly interval: CandleInterval; readonly bars: number },
    private readonly impl: (input: AgentDecisionInput) => Promise<Signal[]>,
    symbol = S,
  ) {
    this.subscriptions = { venue: V, symbols: [symbol], channels: { candles: ['1m'] } };
  }

  onInit(ctx: StrategyInitContext): void {
    this.initCtx = ctx;
  }

  decide(input: AgentDecisionInput): Promise<Signal[]> {
    this.calls += 1;
    this.inputs.push(input);
    return this.impl(input);
  }

  onStop(): void {
    this.stopped = true;
  }
}

function pushStream() {
  const queue: MarketEvent[] = [];
  let resolve: ((r: IteratorResult<MarketEvent>) => void) | null = null;
  let closed = false;
  const iterable: AsyncIterable<MarketEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<MarketEvent>> => {
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
        if (closed)
          return Promise.resolve({ value: undefined as unknown as MarketEvent, done: true });
        return new Promise((r) => (resolve = r));
      },
    }),
  };
  return {
    iterable,
    push(v: MarketEvent) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: v, done: false });
      } else queue.push(v);
    },
    close() {
      closed = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function defaultFeedHealth(warmup: readonly CandleEvent[] = []): FeedHealthPort {
  return {
    health: () => 'LIVE',
    getRefPrice: () => undefined,
    updateRefPrice: () => undefined,
    fetchCandles: () => Promise.resolve(warmup),
  };
}

function makeHost(opts: {
  strategy: AsyncStrategy;
  sink: SignalSinkPort;
  feedHealth?: FeedHealthPort;
  hostOpts?: AgenticHostOptions;
}): {
  host: StrategyHost;
  registry: StrategyRegistry;
  stream: ReturnType<typeof pushStream>;
  id: StrategyId;
} {
  const registry = new StrategyRegistry();
  const id = opts.strategy.id;
  registry.register('fake', () => opts.strategy);
  registry.enable(id, 'fake', {});
  const stream = pushStream();
  const marketStream: MarketStreamPort = { subscribe: () => stream.iterable };
  const host = new StrategyHost(
    marketStream,
    opts.feedHealth ?? defaultFeedHealth(),
    opts.sink,
    registry,
    opts.hostOpts,
  );
  return { host, registry, stream, id };
}

describe('StrategyHost (agentic-only)', () => {
  it('warmup populates candle history via feedHealth.fetchCandles without calling the client, then reaches ACTIVE', async () => {
    const id = strategyId('warm');
    const w1 = candle(0);
    const w2 = candle(1);
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const fetchCandlesCalls: unknown[] = [];
    const fh: FeedHealthPort = {
      health: () => 'LIVE',
      getRefPrice: () => undefined,
      updateRefPrice: () => undefined,
      fetchCandles: (venue, symbol, interval, n) => {
        fetchCandlesCalls.push([venue, symbol, interval, n]);
        return Promise.resolve([w1, w2]);
      },
    };
    const { host, registry, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      feedHealth: fh,
    });

    await host.start();

    expect(strat.calls).toBe(0); // warmup never calls the client
    expect(registry.getLifecycle(id)).toBe('ACTIVE');
    expect(fetchCandlesCalls).toEqual([[V, S, '1m', 2]]);

    stream.push(candle(2)); // candle-triggered decide sees the warmed-up history
    await tick();
    stream.close();

    expect(strat.calls).toBe(1);
    const hist = strat.inputs[0]?.snapshot.candles.get(S);
    expect(hist?.map((c) => c.eventTime)).toEqual([epochMs(0), epochMs(1), epochMs(2)]);
  });

  it('delivers a decided signal via the buffered path (consumer arrives after emission)', async () => {
    const id = strategyId('buf');
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([sig(id, 'ENTER_LONG', 5)]),
    );
    const { host, stream } = makeHost({ strategy: strat, sink });

    await host.start();
    stream.push(candle(5));
    await tick(); // decide resolves and the signal lands in the buffered queue (no consumer parked yet)
    stream.close();

    const got: Signal[] = [];
    for await (const s of host.signals()) got.push(s);
    expect(got.map((s) => s.kind)).toEqual(['ENTER_LONG']);
    expect(recorded.map((s) => s.kind)).toEqual(['ENTER_LONG']);
  });

  it('delivers a decided signal via the awaiting-resolver path (consumer parked first)', async () => {
    const id = strategyId('await');
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([sig(id, 'ENTER_LONG', 5)]),
    );
    const { host, stream } = makeHost({ strategy: strat, sink });

    await host.start();
    const iterator = host.signals()[Symbol.asyncIterator]();
    const pending = iterator.next(); // parked BEFORE the trigger
    stream.push(candle(5));
    const first = await pending;

    if (first.done) throw new Error('expected a signal');
    expect(first.value.kind).toBe('ENTER_LONG');
    expect(recorded.map((s) => s.kind)).toEqual(['ENTER_LONG']);
    stream.close();
  });

  it('drops an unclosed candle entirely: no decide, and it never enters history', async () => {
    const id = strategyId('unclosed');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const { host, stream } = makeHost({ strategy: strat, sink: { recordSignal: () => undefined } });

    await host.start();
    stream.push(candle(1, false)); // unclosed
    await tick();
    expect(strat.calls).toBe(0);

    stream.push(candle(2)); // closed → triggers; history must contain ONLY this one
    await tick();
    stream.close();

    expect(strat.calls).toBe(1);
    const hist = strat.inputs[0]?.snapshot.candles.get(S);
    expect(hist?.map((c) => c.eventTime)).toEqual([epochMs(2)]);
  });

  it('folds ticker/book state without triggering, then surfaces it on the next candle-triggered snapshot', async () => {
    const id = strategyId('tickbook');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const { host, stream } = makeHost({ strategy: strat, sink: { recordSignal: () => undefined } });

    await host.start();
    stream.push(ticker(1));
    await tick();
    expect(strat.calls).toBe(0);
    stream.push(book(2));
    await tick();
    expect(strat.calls).toBe(0);

    stream.push(candle(3));
    await tick();
    stream.close();

    expect(strat.calls).toBe(1);
    const snap = strat.inputs[0]!.snapshot;
    expect(snap.tickers.get(S)?.eventTime).toBe(epochMs(1));
    expect(snap.books.get(S)?.eventTime).toBe(epochMs(2));
  });

  it('suppresses a second candle-triggered decide within minDecisionIntervalMs, then resumes past the window', async () => {
    const id = strategyId('cadence');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const { host, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: { minDecisionIntervalMs: 1000 },
    });

    // Base timestamps offset well clear of 0: the host's cadence clock initializes to epochMs(0),
    // so a first candle AT eventTime 0 would itself be gated against that sentinel.
    await host.start();
    stream.push(candle(10_000));
    await tick();
    expect(strat.calls).toBe(1);

    stream.push(candle(10_400)); // within the 1000ms window → suppressed
    await tick();
    expect(strat.calls).toBe(1);

    stream.push(candle(11_000)); // gate is strict-less-than: exactly at the boundary → fires
    await tick();
    stream.close();

    expect(strat.calls).toBe(2);
  });

  it('does not advance the cadence clock on a busy-conflated candle', async () => {
    const id = strategyId('cadence-busy');
    const resolvers: Array<(s: Signal[]) => void> = [];
    const strat = new ProgrammableStrategy(
      id,
      { interval: '1m', bars: 2 },
      () => new Promise<Signal[]>((r) => resolvers.push(r)),
    );
    const { host, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: { minDecisionIntervalMs: 1000 },
    });

    // Base timestamps offset well clear of 0: the host's cadence clock initializes to epochMs(0),
    // so a first candle AT eventTime 0 would itself be gated against that sentinel.
    await host.start();
    stream.push(candle(10_000)); // decide 1 starts; busy=true; cadence clock=10_000
    await tick();
    expect(strat.calls).toBe(1);

    stream.push(candle(10_800)); // busy-conflated: folds history only, must NOT move the cadence clock
    await tick();
    expect(strat.calls).toBe(1);

    resolvers[0]?.([]); // free the lane
    await tick();

    // 11_050 - 10_000 = 1050 ≥ 1000 → fires. If the conflated candle had wrongly moved the clock to
    // 10_800, 11_050 - 10_800 = 250 < 1000 would have suppressed it instead.
    stream.push(candle(11_050));
    await tick();
    stream.close();

    expect(strat.calls).toBe(2);
  });

  it('folds an exec report forward, delivers it once to the triggering decide, and never re-delivers it', async () => {
    const id = strategyId('exec');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const { host, stream } = makeHost({ strategy: strat, sink: { recordSignal: () => undefined } });

    await host.start();
    host.enqueueExecReport(id, execReport(5)); // queued; drained on the next stream event
    stream.push(candle(6)); // exec (priority 3) drains ahead of the candle (priority 2) in the same pass
    await tick();

    expect(strat.calls).toBe(1);
    expect(strat.inputs[0]?.trigger.kind).toBe('exec');
    expect(strat.inputs[0]?.snapshot.execReports).toHaveLength(1);
    expect(strat.inputs[0]?.snapshot.execReports[0]?.reportId).toBe('r5');

    stream.push(candle(7)); // a fresh decide — the exec report is not re-folded
    await tick();
    stream.close();

    expect(strat.calls).toBe(2);
    expect(strat.inputs[1]?.snapshot.execReports).toEqual([]);
  });

  it('AUTO-drains after 3 consecutive decide() timeouts, filters to risk-reducing signals while DRAINING, and a successful recovery probe restores ACTIVE', async () => {
    vi.useFakeTimers();
    try {
      const id = strategyId('drain-timeout');
      let calls = 0;
      const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () => {
        calls += 1;
        if (calls <= 3) return new Promise<Signal[]>(() => undefined); // never resolves
        return Promise.resolve([sig(id, 'ENTER_LONG', 100), sig(id, 'FLATTEN', 100)]);
      });
      const recorded: Signal[] = [];
      const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
      const { host, registry, stream } = makeHost({
        strategy: strat,
        sink,
        // drainCooldownBaseMs: 0 isolates this test to the DRAINING signal filter + recovery, without
        // also asserting cooldown timing (covered by the dedicated AUTO-recovery tests below).
        hostOpts: { agentTimeoutMs: 50, drainCooldownBaseMs: 0 },
      });

      await host.start();
      for (let i = 0; i < 3; i++) {
        stream.push(candle(i));
        await vi.advanceTimersByTimeAsync(50); // each timeout frees the lane for the next trigger
      }
      expect(registry.getLifecycle(id)).toBe('DRAINING');
      expect(registry.getDrainReason(id)).toBe('AUTO');
      expect(strat.calls).toBe(3);

      stream.push(candle(100)); // the recovery probe fires (cooldown is 0) and resolves successfully
      await vi.advanceTimersByTimeAsync(0);
      stream.close();

      expect(recorded.map((s) => s.kind)).toEqual(['FLATTEN']); // ENTER_LONG filtered, FLATTEN kept
      expect(registry.getLifecycle(id)).toBe('ACTIVE'); // the successful probe restores ACTIVE
      expect(registry.getDrainReason(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('DRAINs after 3 consecutive decide() rejections, stamping drainReason AUTO', async () => {
    const id = strategyId('drain-reject');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.reject(new Error('agent down')),
    );
    const { host, registry, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
    });

    await host.start();
    for (let i = 0; i < 3; i++) {
      stream.push(candle(i));
      await tick();
    }
    stream.close();

    expect(strat.calls).toBe(3);
    expect(registry.getLifecycle(id)).toBe('DRAINING');
    expect(registry.getDrainReason(id)).toBe('AUTO');
  });

  it('an AUTO drain skips decides during the cooldown (state still folds), then the post-cooldown probe fires exactly once', async () => {
    const id = strategyId('auto-recover');
    let clock = 0;
    const nowFn = () => clock;
    let shouldFail = true;
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      shouldFail ? Promise.reject(new Error('agent down')) : Promise.resolve([]),
    );
    const { host, registry, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: { nowFn, drainCooldownBaseMs: 1000 },
    });

    await host.start();
    for (let i = 0; i < 3; i++) {
      stream.push(candle(i));
      await tick();
    }
    expect(registry.getLifecycle(id)).toBe('DRAINING');
    expect(registry.getDrainReason(id)).toBe('AUTO');
    expect(strat.calls).toBe(3);

    // Still within the cooldown: the decide/client is never invoked, but the candle still folds.
    stream.push(candle(10));
    await tick();
    expect(strat.calls).toBe(3);

    // Cooldown elapsed: exactly one probe decide fires, and it succeeds → restores ACTIVE.
    clock = 1000;
    shouldFail = false;
    stream.push(candle(20));
    await tick();
    stream.close();

    expect(strat.calls).toBe(4);
    expect(registry.getLifecycle(id)).toBe('ACTIVE');
    expect(registry.getDrainReason(id)).toBeUndefined();
    // The candle folded during the cooldown (never decided) is still present in the probe's history
    // (bars=2 bounds history at 3; the two oldest closed candles have rolled off by now).
    const hist = strat.inputs[3]?.snapshot.candles.get(S);
    expect(hist?.map((c) => c.eventTime)).toEqual([epochMs(2), epochMs(10), epochMs(20)]);
  });

  it('a failed AUTO-drain recovery probe doubles the cooldown, capped at drainCooldownMaxMs', async () => {
    const id = strategyId('auto-backoff');
    let clock = 0;
    const nowFn = () => clock;
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.reject(new Error('agent down')),
    );
    const { host, registry, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: { nowFn, drainCooldownBaseMs: 1000, drainCooldownMaxMs: 3000 },
    });

    await host.start();
    for (let i = 0; i < 3; i++) {
      stream.push(candle(i));
      await tick();
    }
    expect(registry.getLifecycle(id)).toBe('DRAINING'); // cooldownUntilMs = 0 + 1000 = 1000

    clock = 1000; // cooldown elapsed: probe #1 fires and fails
    stream.push(candle(10));
    await tick();
    expect(strat.calls).toBe(4);
    expect(registry.getLifecycle(id)).toBe('DRAINING'); // stays draining

    // Probe #1 failure doubles: cooldownUntilMs = 1000 + min(1000·2¹, 3000) = 3000
    clock = 2999;
    stream.push(candle(11));
    await tick();
    expect(strat.calls).toBe(4); // still inside cooldown, no probe

    clock = 3000;
    stream.push(candle(12));
    await tick();
    expect(strat.calls).toBe(5); // probe #2 fires and fails too

    // Probe #2 failure: cooldownUntilMs = 3000 + min(1000·2², 3000) = 6000 (would be 4000 uncapped)
    clock = 5999;
    stream.push(candle(13));
    await tick();
    expect(strat.calls).toBe(5);

    clock = 6000;
    stream.push(candle(14));
    await tick();
    stream.close();
    expect(strat.calls).toBe(6); // probe #3 fires — the cap held rather than growing unbounded
  });

  it('an OPERATOR drain keeps deciding at cadence and filters to risk-reducing signals, but never auto-recovers even after a successful decide or an elapsed AUTO-style cooldown window', async () => {
    const id = strategyId('operator-drain');
    let clock = 0;
    const nowFn = () => clock;
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([sig(id, 'ENTER_LONG', 100), sig(id, 'FLATTEN', 100)]),
    );
    const { host, registry, stream } = makeHost({
      strategy: strat,
      sink,
      hostOpts: { nowFn, drainCooldownBaseMs: 1000 },
    });

    await host.start();
    registry.disable(id); // operator-initiated drain
    expect(registry.getLifecycle(id)).toBe('DRAINING');
    expect(registry.getDrainReason(id)).toBe('OPERATOR');

    clock = 10_000; // far past any AUTO cooldown window — irrelevant to an OPERATOR drain
    stream.push(candle(1));
    await tick();
    stream.close();

    expect(strat.calls).toBe(1); // decided immediately at cadence — no cooldown gate applies
    expect(registry.getLifecycle(id)).toBe('DRAINING'); // a successful decide must NOT restore ACTIVE
    expect(registry.getDrainReason(id)).toBe('OPERATOR'); // reason untouched
    expect(recorded.map((s) => s.kind)).toEqual(['FLATTEN']); // risk-reducing filter still applies
  });

  it('owner-authorized recovery program: with operatorDrainAutoResumeEnabled, an OPERATOR drain is PACED (cooldown + single probe, mirroring AUTO) — not cleared on the very next decide', async () => {
    const id = strategyId('operator-drain-autoresume');
    let clock = 0;
    const nowFn = () => clock;
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([sig(id, 'ENTER_LONG', 100), sig(id, 'FLATTEN', 100)]),
    );
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { host, registry, stream } = makeHost({
        strategy: strat,
        sink,
        hostOpts: { operatorDrainAutoResumeEnabled: true, nowFn, drainCooldownBaseMs: 1000 },
      });

      await host.start();
      registry.disable(id); // operator-initiated drain
      expect(registry.getLifecycle(id)).toBe('DRAINING');
      expect(registry.getDrainReason(id)).toBe('OPERATOR');

      // Security-review S2 (pacing parity): within the cooldown, no decide fires at all — a
      // deliberately-disabled strategy is not resurrected within one decide cycle.
      stream.push(candle(1));
      await tick();
      expect(strat.calls).toBe(0);
      expect(registry.getLifecycle(id)).toBe('DRAINING');
      expect(registry.getDrainReason(id)).toBe('OPERATOR');

      // Cooldown elapsed: exactly one probe decide fires and succeeds → restores ACTIVE.
      clock = 1000;
      stream.push(candle(2));
      await tick();
      stream.close();

      expect(strat.calls).toBe(1);
      expect(registry.getLifecycle(id)).toBe('ACTIVE');
      expect(registry.getDrainReason(id)).toBeUndefined();
      expect(recorded.map((s) => s.kind)).toEqual(['FLATTEN']); // risk-reducing filter still applied to the probe
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OPERATOR drain auto-cleared'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('owner-authorized recovery program: a FAILED OPERATOR-drain probe doubles the cooldown, capped at drainCooldownMaxMs — mirrors AUTO backoff exactly', async () => {
    const id = strategyId('operator-drain-backoff');
    let clock = 0;
    const nowFn = () => clock;
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.reject(new Error('agent down')),
    );
    const { host, registry, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: {
        operatorDrainAutoResumeEnabled: true,
        nowFn,
        drainCooldownBaseMs: 1000,
        drainCooldownMaxMs: 3000,
      },
    });

    await host.start();
    registry.disable(id); // operator-initiated drain, cooldownUntilMs armed to 0+1000=1000 on this tick
    stream.push(candle(1));
    await tick();
    expect(strat.calls).toBe(0); // still inside the cooldown

    clock = 1000; // cooldown elapsed: probe #1 fires and fails
    stream.push(candle(2));
    await tick();
    expect(strat.calls).toBe(1);
    expect(registry.getLifecycle(id)).toBe('DRAINING'); // stays draining, provenance untouched
    expect(registry.getDrainReason(id)).toBe('OPERATOR');

    // Probe #1 failure doubles: cooldownUntilMs = 1000 + min(1000·2¹, 3000) = 3000
    clock = 2999;
    stream.push(candle(3));
    await tick();
    expect(strat.calls).toBe(1); // still inside the doubled cooldown

    clock = 3000;
    stream.push(candle(4));
    await tick();
    stream.close();
    expect(strat.calls).toBe(2); // probe #2 fires
  });

  it('tradingHalted() suppresses ALL decides regardless of lifecycle, while state still folds', async () => {
    const id = strategyId('halted');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    let halted = true;
    const { host, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: { tradingHalted: () => halted },
    });

    await host.start();
    stream.push(candle(1));
    await tick();
    expect(strat.calls).toBe(0); // decide suppressed by the kill-switch

    halted = false; // kill-switch lifted
    stream.push(candle(2));
    await tick();
    stream.close();

    expect(strat.calls).toBe(1);
    // The halted candle still folded into history even though it never triggered a decide.
    const hist = strat.inputs[0]?.snapshot.candles.get(S);
    expect(hist?.map((c) => c.eventTime)).toEqual([epochMs(1), epochMs(2)]);
  });

  // 2026-07-19: the suppression above was completely silent — a day of HALTED decides went
  // unnoticed. Warned ONCE per engagement, not once per suppressed market event (which would spam
  // one line per tick), and re-warns on the NEXT engagement once RUNNING clears the flag.
  it('tradingHalted() suppression logs exactly ONE warn per engagement, not once per suppressed event, and re-warns on the next engagement', async () => {
    const id = strategyId('halted-log');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let halted = true;
    const { host, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: { tradingHalted: () => halted },
    });

    await host.start();
    stream.push(candle(1)); // three suppressed events while halted — must warn only once
    await tick();
    stream.push(candle(2));
    await tick();
    stream.push(candle(3));
    await tick();
    expect(strat.calls).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    halted = false; // kill-switch lifted — no new warn while RUNNING
    stream.push(candle(4));
    await tick();
    expect(strat.calls).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    halted = true; // re-engaged — the NEXT suppression warns again
    stream.push(candle(5));
    await tick();
    stream.close();
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('constraintsFor populates onInit ctx.symbolConstraints for each resolved subscribed symbol', async () => {
    const id = strategyId('constraints');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const constraints: SymbolConstraints = {
      tickSize: price('0.01'),
      lotStep: qty('0.001'),
      minNotional: price('10'),
    };
    const { host } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: { constraintsFor: (symbol) => (symbol === S ? constraints : undefined) },
    });

    await host.start();

    expect(strat.initCtx?.symbolConstraints.get(S)).toEqual(constraints);
  });

  it('constraintsFor returning undefined for a symbol leaves it out of onInit ctx.symbolConstraints', async () => {
    const id = strategyId('constraints-none');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const { host } = makeHost({ strategy: strat, sink: { recordSignal: () => undefined } });

    await host.start();

    expect(strat.initCtx?.symbolConstraints.size).toBe(0);
  });

  it('ignores TRADE events entirely (no decide)', async () => {
    const id = strategyId('trade');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const { host, stream } = makeHost({ strategy: strat, sink: { recordSignal: () => undefined } });

    await host.start();
    stream.push({
      kind: 'TRADE',
      venue: V,
      symbol: S,
      channel: 'trade',
      seq: 1n,
      eventTime: epochMs(1),
      ingestTime: epochMs(2),
      price: price('100'),
      qty: qty('1'),
      side: 'BUY',
      tradeId: 't1',
    });
    await tick();
    stream.close();

    expect(strat.calls).toBe(0);
  });

  it('conflates multiple ticker updates for the same symbol before a single drain', async () => {
    const id = strategyId('conflate');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const { host, stream } = makeHost({ strategy: strat, sink: { recordSignal: () => undefined } });
    await host.start(); // parks consumeEvents on the empty stream

    const internals = host as unknown as {
      routeEvent(e: MarketEvent): void;
      drainMailboxes(): void;
    };
    internals.routeEvent(ticker(1));
    internals.routeEvent(ticker(2)); // same symbol → conflates onto the queued ticker
    internals.drainMailboxes(); // folds the (conflated) ticker; never a trigger, so no decide yet
    expect(strat.calls).toBe(0);

    // A candle in the SAME drain as the tickers would be processed first (mailbox is priority-sorted,
    // candle > ticker), snapshotting before the ticker folds in — so it is driven in its own drain.
    internals.routeEvent(candle(3));
    internals.drainMailboxes();
    stream.close();

    expect(strat.calls).toBe(1);
    expect(strat.inputs[0]?.snapshot.tickers.size).toBe(1);
    expect(strat.inputs[0]?.snapshot.tickers.get(S)?.eventTime).toBe(epochMs(2));
  });

  it('uses portfolioFor to populate snapshot.portfolio, keyed by the real strategy id', async () => {
    const id = strategyId('pf');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const position: Position = {
      strategyId: id,
      venue: V,
      symbol: S,
      signedQty: new Decimal(1),
      avgEntry: price('100'),
      realizedPnl: new Decimal(0),
    };
    const view: StrategyPortfolioView = {
      strategyId: id,
      positions: new Map([[String(S), position]]),
      openOrders: [],
    };
    const { host, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
      hostOpts: { portfolioFor: () => view },
    });

    await host.start();
    stream.push(candle(1));
    await tick();
    stream.close();

    expect(strat.inputs[0]?.snapshot.portfolio.strategyId).toBe(id);
    expect(strat.inputs[0]?.snapshot.portfolio.positions.get(String(S))).toEqual(position);
  });

  it('stop() calls onStop, halts lifecycle, and completes the signals() iterator', async () => {
    const id = strategyId('stop');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const { host, registry, stream } = makeHost({
      strategy: strat,
      sink: { recordSignal: () => undefined },
    });

    await host.start();
    const iterator = host.signals()[Symbol.asyncIterator]();
    const pending = iterator.next(); // parked BEFORE stop() so stop() wakes the waiting resolver
    await host.stop();

    expect(strat.stopped).toBe(true);
    expect(registry.getLifecycle(id)).toBe('HALTED');
    const r = await pending;
    expect(r.done).toBe(true);
    stream.close();
  });

  it('works with the opts argument omitted (constructor defaults apply)', async () => {
    const id = strategyId('defaults');
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () =>
      Promise.resolve([]),
    );
    const registry = new StrategyRegistry();
    registry.register('fake', () => strat);
    registry.enable(id, 'fake', {});
    const stream = pushStream();
    const marketStream: MarketStreamPort = { subscribe: () => stream.iterable };
    const host = new StrategyHost(
      marketStream,
      defaultFeedHealth(),
      { recordSignal: () => undefined },
      registry,
    );

    await host.start();
    stream.push(candle(1));
    await tick();
    stream.close();

    expect(strat.calls).toBe(1);
  });
});

describe('StrategyHost B5 entry cap (agentic)', () => {
  it('drops the 13th ENTER_LONG of the UTC day under the default cap, admitting the first 12', async () => {
    const id = strategyId('entry-cap-default');
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, (input) =>
      Promise.resolve([sig(id, 'ENTER_LONG', input.snapshot.eventTime)]),
    );
    const { host, stream } = makeHost({ strategy: strat, sink });

    await host.start();
    for (let i = 0; i < 13; i++) {
      stream.push(candle(1000 + i));
      await tick();
    }
    stream.close();

    expect(strat.calls).toBe(13); // the strategy itself is never gated — only emission is
    expect(recorded).toHaveLength(12); // the 13th ENTER_LONG dropped
  });

  it('exit/flatten signals always pass, even once the entry cap is exhausted', async () => {
    const id = strategyId('entry-cap-exit');
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    let call = 0;
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, () => {
      call += 1;
      // First 12 saturate the default cap; calls 13+ are FLATTEN, which must never be capped.
      return Promise.resolve([sig(id, call <= 12 ? 'ENTER_LONG' : 'FLATTEN', call)]);
    });
    const { host, stream } = makeHost({ strategy: strat, sink });

    await host.start();
    for (let i = 0; i < 15; i++) {
      stream.push(candle(1000 + i));
      await tick();
    }
    stream.close();

    expect(recorded.filter((s) => s.kind === 'ENTER_LONG')).toHaveLength(12);
    expect(recorded.filter((s) => s.kind === 'FLATTEN')).toHaveLength(3);
  });

  it('resets the entry counter on a UTC-day rollover (nowFn seam)', async () => {
    const id = strategyId('entry-cap-rollover');
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, (input) =>
      Promise.resolve([sig(id, 'ENTER_LONG', input.snapshot.eventTime)]),
    );
    let clock = 0;
    const nowFn = () => clock;
    const { host, stream } = makeHost({
      strategy: strat,
      sink,
      hostOpts: { nowFn, maxEntriesPerDay: 2 },
    });

    await host.start();
    stream.push(candle(1));
    await tick();
    stream.push(candle(2));
    await tick();
    stream.push(candle(3)); // 3rd same-day entry: capped
    await tick();
    expect(recorded).toHaveLength(2);

    clock = 24 * 60 * 60 * 1000; // next UTC day
    stream.push(candle(4));
    await tick();
    stream.close();

    expect(recorded).toHaveLength(3); // fresh day, fresh cap
  });

  it('the entry counter persists across a tradingHalted toggle (cap independent of the kill-switch)', async () => {
    const id = strategyId('entry-cap-halt');
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, (input) =>
      Promise.resolve([sig(id, 'ENTER_LONG', input.snapshot.eventTime)]),
    );
    let halted = false;
    const { host, stream } = makeHost({
      strategy: strat,
      sink,
      hostOpts: { maxEntriesPerDay: 2, tradingHalted: () => halted },
    });

    await host.start();
    stream.push(candle(1));
    await tick();
    expect(recorded).toHaveLength(1); // 1/2 used

    halted = true;
    stream.push(candle(2)); // suppressed entirely by the kill-switch — no decide, no count change
    await tick();
    expect(strat.calls).toBe(1);
    expect(recorded).toHaveLength(1);

    halted = false;
    stream.push(candle(3)); // 1 slot still remaining from before the halt
    await tick();
    expect(recorded).toHaveLength(2);

    stream.push(candle(4)); // now exhausted — the halt window never reset or bypassed the cap
    await tick();
    stream.close();

    expect(recorded).toHaveLength(2);
  });

  it('the entry counter persists across a DRAINING excursion (cap independent of lifecycle transitions)', async () => {
    const id = strategyId('entry-cap-drain');
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const strat = new ProgrammableStrategy(id, { interval: '1m', bars: 2 }, (input) =>
      Promise.resolve([sig(id, 'ENTER_LONG', input.snapshot.eventTime)]),
    );
    const { host, registry, stream } = makeHost({
      strategy: strat,
      sink,
      hostOpts: { maxEntriesPerDay: 2 },
    });

    await host.start();
    stream.push(candle(1));
    await tick();
    expect(recorded).toHaveLength(1); // 1/2 used

    registry.disable(id); // OPERATOR drain — ENTER_LONG filtered by RISK_REDUCING before the cap check
    stream.push(candle(2));
    await tick();
    expect(recorded).toHaveLength(1); // still 1/2 — the drained decide never reached admitEntry

    registry.setLifecycle(id, 'ACTIVE'); // recovered
    stream.push(candle(3));
    await tick();
    stream.close();

    expect(recorded).toHaveLength(2); // consumes the last remaining slot — cap state carried through
  });

  it('multi-symbol (P7): subscribes the UNION of instance specs and routes each event only to its declaring instance', async () => {
    const ETH = symbolId('ETH/USDT');
    const idBtc = strategyId('agentic-1');
    const idEth = strategyId('agentic-2');
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const btc = new ProgrammableStrategy(idBtc, { interval: '1m', bars: 0 }, () =>
      Promise.resolve([]),
    );
    const eth = new ProgrammableStrategy(
      idEth,
      { interval: '1m', bars: 0 },
      () => Promise.resolve([]),
      ETH,
    );
    const registry = new StrategyRegistry();
    registry.register('fake-btc', () => btc);
    registry.register('fake-eth', () => eth);
    registry.enable(idBtc, 'fake-btc', {});
    registry.enable(idEth, 'fake-eth', {});
    const stream = pushStream();
    let subscribed: SubscriptionSpec | undefined;
    const marketStream: MarketStreamPort = {
      subscribe: (spec) => {
        subscribed = spec;
        return stream.iterable;
      },
    };
    const host = new StrategyHost(marketStream, defaultFeedHealth(), sink, registry);

    await host.start();
    stream.push(candle(5)); // BTC bar
    await tick();
    stream.push(candle(6, true, ETH)); // ETH bar
    await tick();
    stream.close();

    expect(subscribed?.symbols).toEqual([S, ETH]); // union, one stream
    expect(btc.calls).toBe(1); // the ETH bar never reached the BTC instance
    expect(btc.inputs[0]!.trigger.event.symbol).toBe(S);
    expect(eth.calls).toBe(1);
    expect(eth.inputs[0]!.trigger.event.symbol).toBe(ETH);
  });
});
