import { describe, it, expect, vi } from 'vitest';
import {
  LiquidationFeedService,
  type LiquidationWatchSource,
  type LiquidationEvent,
} from '../../../../src/features/venue/market-data/liquidation-feed.service';
import type { ClockPort } from '../../../../src/ports/common/clock';
import { symbolId, epochMs } from '../../../../src/domain/common/types/ids';

// Perp form — the one the composition root actually configures (perpSymbols(registry) in
// context-feeds.module.ts). A spot-form SYM here would mask defect-145's keying bug: the prior
// record() converted the ccxt event DOWN to spot before checking membership, so it only ever
// matched a spot-configured basket, never the perp-configured one production actually runs.
const SYM = symbolId('BTC/USDT:USDT');
const PEPE = symbolId('PEPE/USDT');

function mutableClock(start = 1_000_000): { clock: ClockPort; set: (t: number) => void } {
  let t = start;
  return { clock: { now: () => epochMs(t) }, set: (n) => (t = n) };
}

function expectCloseTo(actual: number, expected: number, precision: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(Math.pow(10, -precision) / 2);
}

// A fixture double that answers one queued response per call — either a batch of events (the "venue
// pushed a forceOrder message" case) or an Error (the "stream errored" case). Once the queue is
// exhausted, further calls return a promise that never resolves — mirroring a real WS watch call
// quietly waiting for the next (possibly long-delayed) liquidation event, never itself an error.
function queuedSource(
  responses: readonly (readonly LiquidationEvent[] | Error)[],
): LiquidationWatchSource & { calledSymbols: (readonly string[])[] } {
  let i = 0;
  const calledSymbols: (readonly string[])[] = [];
  return {
    calledSymbols,
    watchLiquidationsForSymbols: (symbols) => {
      calledSymbols.push(symbols);
      const idx = i++;
      if (idx >= responses.length) return new Promise<readonly LiquidationEvent[]>(() => undefined);
      const r = responses[idx]!;
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r);
    },
  };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('LiquidationFeedService', () => {
  it('subscribes using the ccxt unified perp form (BASE/QUOTE:QUOTE), not the spot symbol', async () => {
    const { clock } = mutableClock();
    const source = queuedSource([[]]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock });

    svc.start();
    await flushMicrotasks();

    expect(source.calledSymbols[0]).toEqual(['BTC/USDT:USDT']);
    svc.stop();
  });

  it('aggregates rolling notional and long/short share from fixture events (sell=long liq, buy=short liq)', async () => {
    // defect-145 regression: SYM is perp-form (the one production actually configures). The prior
    // record() converted the incoming perp event DOWN to spot before checking membership against a
    // perp-form options.symbols, so this exact scenario silently accumulated nothing.
    const { clock } = mutableClock();
    const source = queuedSource([
      [
        { symbol: 'BTC/USDT:USDT', side: 'sell', quoteValue: 10_000 }, // long liquidated
        { symbol: 'BTC/USDT:USDT', side: 'buy', quoteValue: 5_000 }, // short liquidated
      ],
    ]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock });

    svc.start();
    await flushMicrotasks();

    const snap = svc.latest(SYM);
    expect(snap).not.toBeNull();
    expect(snap!.count).toBe(2);
    expect(snap!.liqNotionalUsd).toBe(15_000);
    // longShareOfLiqs = longNotional / total = 10000 / 15000
    expectCloseTo(snap!.longShareOfLiqs!, 10_000 / 15_000, 10);
    expect(svc.recordedEventCount()).toBe(2);
    svc.stop();
  });

  it('latest() resolves the same window for the spot sibling of a perp-configured symbol', async () => {
    // The agentic strategy queries latest() with the SPOT symbol (agentic.strategy.ts's this.symbol)
    // while the composition root configures/subscribes this service in PERP form — both must
    // normalize to the same key via perpSymbolFor, or a real consult reads an empty window forever.
    const { clock } = mutableClock();
    const source = queuedSource([[{ symbol: 'BTC/USDT:USDT', side: 'sell', quoteValue: 10_000 }]]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock });

    svc.start();
    await flushMicrotasks();

    const spotSibling = symbolId('BTC/USDT');
    const snap = svc.latest(spotSibling);
    expect(snap).not.toBeNull();
    expect(snap!.count).toBe(1);
    expect(snap!.liqNotionalUsd).toBe(10_000);
    svc.stop();
  });

  it('latest() returns null for a spot symbol with no subscribed perp sibling (TRADING_SYMBOLS carries spot-only listings, e.g. DOGE/USDT)', async () => {
    // defect-145 recurrence: without a subscribed-membership check, latest() normalizes to a perp
    // key that was never subscribed and answers a fabricated {count: 0, liqNotionalUsd: 0} instead
    // of the null that "no measurement for this symbol" requires — indistinguishable from a healthy,
    // genuinely quiet DOGE perp market to a caller that never sees the stream's subscription list.
    const { clock } = mutableClock();
    const source = queuedSource([[]]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock }); // BTC only — no DOGE

    svc.start();
    await flushMicrotasks();

    expect(svc.latest(symbolId('DOGE/USDT'))).toBeNull();
    svc.stop();
  });

  it('latest() returns null for a symbol pruned by runLoop after the venue rejects it as an unlisted perp market', async () => {
    const { clock } = mutableClock();
    const source = queuedSource([
      new Error('binanceusdm does not have market symbol PEPE/USDT:USDT'),
      [],
    ]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM, PEPE], clock });

    svc.start();
    await flushMicrotasks();

    // Would answer a fabricated zero snapshot without deleting the pruned key from `subscribed`.
    expect(svc.latest(PEPE)).toBeNull();
    svc.stop();
  });

  it('falls back to contracts * price when quoteValue is absent', async () => {
    const { clock } = mutableClock();
    const source = queuedSource([
      [{ symbol: 'BTC/USDT:USDT', side: 'sell', contracts: 2, price: 100 }],
    ]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock });

    svc.start();
    await flushMicrotasks();

    expect(svc.latest(SYM)!.liqNotionalUsd).toBe(200);
    svc.stop();
  });

  it('a healthy stream with zero events in the window still answers a snapshot (count 0), never null', async () => {
    const { clock } = mutableClock();
    // Queue exhausted immediately -> the loop parks on a never-resolving watch call, exactly the
    // "stream healthy, quietly waiting" state.
    const source = queuedSource([]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock });

    svc.start();
    await flushMicrotasks();

    const snap = svc.latest(SYM);
    expect(snap).not.toBeNull();
    expect(snap!.count).toBe(0);
    expect(snap!.liqNotionalUsd).toBe(0);
    expect(snap!.longShareOfLiqs).toBeNull();
    expect(svc.streamHealthy()).toBe(true);
    svc.stop();
  });

  it('never started (start() not called) answers null — distinct from a healthy-but-quiet stream', () => {
    const { clock } = mutableClock();
    const svc = new LiquidationFeedService(queuedSource([]), { symbols: [SYM], clock });

    expect(svc.latest(SYM)).toBeNull();
    expect(svc.streamHealthy()).toBe(false);
  });

  it('a stream error marks the feed unhealthy (latest() null) and increments reconnectCount, then recovers on the next successful call', async () => {
    const { clock } = mutableClock();
    const source = queuedSource([
      new Error('ws disconnected'),
      [{ symbol: 'BTC/USDT:USDT', side: 'sell', quoteValue: 100 }],
    ]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock, backoffMs: 1 });

    svc.start();
    await flushMicrotasks();
    // The first call rejected — unhealthy, reconnecting, latest() must NOT report a quiet-but-healthy
    // snapshot during this window (fail-open at the caller boundary, never a misleading zero).
    expect(svc.streamHealthy()).toBe(false);
    expect(svc.latest(SYM)).toBeNull();
    expect(svc.reconnectCount()).toBe(1);

    // Wait past the 1ms backoff for the loop to retry and succeed.
    await new Promise((r) => setTimeout(r, 20));
    await flushMicrotasks();

    expect(svc.streamHealthy()).toBe(true);
    expect(svc.latest(SYM)!.count).toBe(1);
    svc.stop();
  });

  it('prunes samples older than the rolling window, so an old liquidation stops counting', async () => {
    const { clock, set } = mutableClock(0);
    const source = queuedSource([
      [{ symbol: 'BTC/USDT:USDT', side: 'sell', quoteValue: 100 }],
      [], // second call lands after the window has been advanced past
    ]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock, windowMin: 60 });

    svc.start();
    await flushMicrotasks();
    expect(svc.latest(SYM)!.count).toBe(1);

    set(61 * 60_000); // 61 minutes later — past the 60-minute window
    expect(svc.latest(SYM)!.count).toBe(0);
    expect(svc.latest(SYM)!.liqNotionalUsd).toBe(0);
    svc.stop();
  });

  it('prunes a perp symbol the venue does not list, retrying immediately with the trimmed set and without counting a reconnect', async () => {
    const { clock } = mutableClock();
    const warn = vi.fn();
    const source = queuedSource([
      new Error('binanceusdm does not have market symbol PEPE/USDT:USDT'),
      [],
    ]);
    const svc = new LiquidationFeedService(source, {
      symbols: [SYM, PEPE],
      clock,
      logger: { warn },
    });

    svc.start();
    await flushMicrotasks();

    expect(source.calledSymbols[0]).toEqual(['BTC/USDT:USDT', 'PEPE/USDT:USDT']);
    expect(source.calledSymbols[1]).toEqual(['BTC/USDT:USDT']); // retried without the excluded symbol
    expect(svc.reconnectCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('excluding PEPE/USDT:USDT'));
    svc.stop();
  });

  it('an unrelated stream error still increments reconnectCount and logs the reconnect warning (not treated as a symbol exclusion)', async () => {
    const { clock } = mutableClock();
    const warn = vi.fn();
    const source = queuedSource([
      new Error('ws disconnected'),
      [{ symbol: 'BTC/USDT:USDT', side: 'sell', quoteValue: 100 }],
    ]);
    const svc = new LiquidationFeedService(source, {
      symbols: [SYM],
      clock,
      backoffMs: 1,
      logger: { warn },
    });

    svc.start();
    await flushMicrotasks();

    expect(svc.reconnectCount()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('liquidation-feed stream error, reconnecting: ws disconnected'),
    );
    svc.stop();
  });

  it('pruning the last remaining perp symbol exits the loop, flips streamHealthy() false, and logs a final warn', async () => {
    const { clock } = mutableClock();
    const warn = vi.fn();
    const source = queuedSource([
      new Error('binanceusdm does not have market symbol BTC/USDT:USDT'),
    ]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock, logger: { warn } });

    svc.start();
    await flushMicrotasks();

    expect(source.calledSymbols).toHaveLength(1); // no symbols left to retry with -> loop exits
    expect(svc.streamHealthy()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no venue-supported perp symbols remain'),
    );
    svc.stop();
  });

  it('warns once when the stream stays healthy for 30+ minutes with zero recorded events', async () => {
    const { clock, set } = mutableClock(0);
    const warn = vi.fn();
    // Queue exhausted immediately -> the loop parks on a never-resolving watch call, so the ONLY
    // trigger for the check is latest() itself (a real consult), same as production.
    const source = queuedSource([]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock, logger: { warn } });

    svc.start();
    await flushMicrotasks();
    svc.latest(SYM); // still within the threshold
    expect(warn).not.toHaveBeenCalled();

    set(31 * 60_000); // past the 30-minute zero-event threshold
    svc.latest(SYM);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('zero recorded events'));

    warn.mockClear();
    svc.latest(SYM); // one-shot — must not fire again
    expect(warn).not.toHaveBeenCalled();
    svc.stop();
  });

  it('never warns of zero events once a real event has been recorded', async () => {
    const { clock, set } = mutableClock(0);
    const warn = vi.fn();
    const source = queuedSource([[{ symbol: 'BTC/USDT:USDT', side: 'sell', quoteValue: 100 }]]);
    const svc = new LiquidationFeedService(source, { symbols: [SYM], clock, logger: { warn } });

    svc.start();
    await flushMicrotasks();
    expect(svc.recordedEventCount()).toBe(1);

    set(31 * 60_000);
    svc.latest(SYM);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('zero recorded events'));
    svc.stop();
  });
});
