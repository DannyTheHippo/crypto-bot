import { describe, it, expect, vi } from 'vitest';
import { ProtectiveExitService } from '../../../src/features/trading/risk/protective-exit.service';
import type { ProtectiveExitConfig, KillSwitchPort } from '../../../src/ports/risk';
import type { PortfolioViewPort } from '../../../src/ports/execution';
import type { FeedHealthPort } from '../../../src/ports/market-data';
import type { SignalSinkPort } from '../../../src/ports/strategy';
import type { ClockPort } from '../../../src/ports/clock';
import type {
  Position,
  PortfolioSnapshot,
  OpenOrderSummary,
} from '../../../src/domain/types/portfolio';
import type { SymbolFilters } from '../../../src/domain/risk/evaluate';
import type { Signal } from '../../../src/domain/types/signal';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import { price, qty } from '../../../src/domain/types/money';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
} from '../../../src/domain/types/ids';
import Decimal from 'decimal.js';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const KEY = `${SID}:${V}:${SYM}`;

const FILTERS: ReadonlyMap<string, SymbolFilters> = new Map([
  [String(SYM), { tickSize: '0.01', stepSize: '0.0001', minQty: '0.0001', minNotional: '5' }],
]);

function pos(over: Partial<Position> = {}): Position {
  return {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    signedQty: new Decimal('1'),
    avgEntry: price('100'),
    realizedPnl: new Decimal('0'),
    ...over,
  };
}

function snapshot(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    positions: new Map(),
    balances: new Map(),
    openOrders: [],
    inFlightIntents: [],
    equity: new Decimal('100000'),
    unrealized: new Decimal('0'),
    startingCash: new Decimal('100000'),
    peakEquity: new Decimal('100000'),
    sodEquityUtc: new Decimal('100000'),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
    ...over,
  };
}

function config(over: Partial<ProtectiveExitConfig> = {}): ProtectiveExitConfig {
  return {
    stopLossPct: '0.02',
    trailingPct: '0.015',
    cooldownMs: 30_000,
    filters: FILTERS,
    ...over,
  };
}

function killSwitch(state: KillSwitchPort['state'] extends () => infer R ? R : never = 'RUNNING') {
  return {
    state: () => state,
    engage: vi.fn(),
    confirmCancels: vi.fn(),
    cancelTimeout: vi.fn(),
    allFlat: vi.fn(),
  } satisfies KillSwitchPort;
}

function feed(mid: string | undefined): FeedHealthPort {
  return {
    getRefPrice: () => (mid === undefined ? undefined : { mid: price(mid), at: epochMs(T) }),
    health: () => 'LIVE',
    fetchCandles: () => Promise.resolve([]),
  };
}

function portfolioView(snap: PortfolioSnapshot): PortfolioViewPort {
  return {
    snapshot: () => snap,
    forStrategy: () => ({
      strategyId: SID,
      positions: snap.positions,
      openOrders: snap.openOrders,
    }),
  };
}

const clock: ClockPort = { now: () => epochMs(T) };

function openOrder(symbol = SYM): OpenOrderSummary {
  return {
    clientOrderId: clientOrderId('cbp' + '0'.repeat(32)),
    symbol,
    side: 'SELL',
    qty: qty('1'),
  };
}

function inFlightIntent(symbol = SYM): OrderIntent {
  return {
    intentId: '0190abcd-1234-7abc-89ab-0123456789ab' as OrderIntent['intentId'],
    clientOrderId: clientOrderId('cbp' + '1'.repeat(32)),
    strategyId: SID,
    venue: V,
    symbol,
    side: 'SELL',
    type: 'LIMIT',
    qty: qty('1'),
    limitPrice: price('100'),
    timeInForce: 'IOC',
    reduceOnly: true,
    mode: 'paper',
    refPrice: price('100'),
    refSeq: 1n,
    createdAt: epochMs(T),
    expiresAt: epochMs(T + 10_000),
    source: { dedupeKey: 'x', eventTime: epochMs(T), basedOnSeq: 1n, strength: 1 },
  };
}

function build(
  over: {
    config?: Partial<ProtectiveExitConfig>;
    killState?: 'RUNNING' | 'HALTING' | 'HALTED' | 'FLATTENING' | 'HALTED_DEGRADED';
    snap?: PortfolioSnapshot;
    mid?: string;
    noRef?: boolean;
    sink?: SignalSinkPort;
    counter?: { inc: (labels: Record<string, string>) => void };
  } = {},
) {
  const snap = over.snap ?? snapshot();
  const sink: SignalSinkPort = over.sink ?? { recordSignal: vi.fn() };
  const inc = vi.fn();
  const counterArg = over.counter ?? { inc };
  const svc = new ProtectiveExitService(
    clock,
    killSwitch(over.killState ?? 'RUNNING'),
    feed(over.noRef ? undefined : (over.mid ?? '100')),
    portfolioView(snap),
    sink,
    config(over.config),
    counterArg as unknown as import('prom-client').Counter<string>,
  );
  return { svc, sink, snap, inc };
}

describe('ProtectiveExitService', () => {
  it('is inert when both stopLossPct and trailingPct are 0', async () => {
    const { svc, sink } = build({
      config: { stopLossPct: '0', trailingPct: '0' },
      mid: '1', // would trip both if active
    });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('does nothing when the kill switch is not RUNNING', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos()]]) });
    const { svc, sink } = build({ killState: 'HALTING', snap, mid: '1' });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('does nothing when there are no positions', async () => {
    const { svc, sink } = build();
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('ignores flat positions', async () => {
    const flat = pos({ signedQty: new Decimal('0') });
    const snap = snapshot({ positions: new Map([[KEY, flat]]) });
    const { svc, sink } = build({ snap, mid: '1' });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('skips a position when no ref price is available (retries next tick)', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos()]]) });
    const { svc, sink } = build({ snap, mid: undefined });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('treats a below-minNotional position as dust and skips it (never fires)', async () => {
    const dust = pos({ signedQty: new Decimal('0.001') }); // 0.001 * 1 = 0.001 < minNotional 5
    const snap = snapshot({ positions: new Map([[KEY, dust]]) });
    const { svc, sink } = build({ snap, mid: '1' });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('protects anyway (never skips) when the symbol has no filter entry', async () => {
    const noFilterSym = symbolId('XRP/USDT');
    const key = `${SID}:${V}:${noFilterSym}`;
    const p = pos({ symbol: noFilterSym, signedQty: new Decimal('0.000001') }); // would be dust if filtered
    const snap = snapshot({ positions: new Map([[key, p]]) });
    const { svc, sink } = build({ snap, mid: '1' }); // ref 1 << avgEntry 100*(1-0.02) ⇒ stop fires
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('seeds HWM from avgEntry when avgEntry > ref on first sight', async () => {
    // avgEntry 100, ref 90: hwm seeds at max(100, 90) = 100. Trailing 1.5% below 100 = 98.5;
    // ref 90 <= 98.5 ⇒ trail fires (stop also fires: 90 <= 100*0.98=98 too — precedence checked elsewhere).
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const { svc, sink } = build({
      snap,
      mid: '90',
      config: { stopLossPct: '0', trailingPct: '0.015' },
    });
    await svc.tick(epochMs(T));
    const signal = (sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
    expect(signal.reason).toBe('TRAILING_STOP');
  });

  it('seeds HWM from ref when ref > avgEntry on first sight (no premature trail trigger)', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const { svc, sink } = build({
      snap,
      mid: '110',
      config: { stopLossPct: '0', trailingPct: '0.015' },
    });
    await svc.tick(epochMs(T));
    // hwm seeds at max(100, 110)=110; trail threshold 110*0.985=108.35; ref 110 > threshold ⇒ no fire.
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('ratchets the HWM up across ticks and never back down', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const sink: SignalSinkPort = { recordSignal: vi.fn() };
    let mid = '120';
    const feedRef: FeedHealthPort = {
      getRefPrice: () => ({ mid: price(mid), at: epochMs(T) }),
      health: () => 'LIVE',
      fetchCandles: () => Promise.resolve([]),
    };
    const svc = new ProtectiveExitService(
      clock,
      killSwitch('RUNNING'),
      feedRef,
      portfolioView(snap),
      sink,
      config({ stopLossPct: '0', trailingPct: '0.015' }),
    );
    await svc.tick(epochMs(T)); // hwm -> 120, ref 120, threshold 118.2, no fire
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    // Price drops to 110 — well below the ratcheted 120 peak's trail threshold (118.2). If the HWM
    // had reseeded to the lower current price instead of ratcheting, this would NOT fire.
    mid = '110';
    await svc.tick(epochMs(T + 1000));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const signal = (sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
    expect(signal.reason).toBe('TRAILING_STOP');
  });

  it('fires STOP_LOSS at exactly the boundary (ref == avgEntry * (1 - stopLossPct))', async () => {
    // avgEntry 100, stopLossPct 0.02 ⇒ boundary 98. ref exactly 98 must trigger (≤, not <).
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const { svc, sink } = build({
      snap,
      mid: '98',
      config: { stopLossPct: '0.02', trailingPct: '0' },
    });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const signal = (sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
    expect(signal.reason).toBe('STOP_LOSS');
    expect(signal.refPrice.toFixed()).toBe('98');
  });

  it('does not fire STOP_LOSS just above the boundary', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const { svc, sink } = build({
      snap,
      mid: '98.01',
      config: { stopLossPct: '0.02', trailingPct: '0' },
    });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('fires TRAILING_STOP from the ratcheted peak, not the entry price', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const sink: SignalSinkPort = { recordSignal: vi.fn() };
    const cfg = config({ stopLossPct: '0', trailingPct: '0.015' });
    let mid = '200';
    const feedRef: FeedHealthPort = {
      getRefPrice: () => ({ mid: price(mid), at: epochMs(T) }),
      health: () => 'LIVE',
      fetchCandles: () => Promise.resolve([]),
    };

    // Tick 1: price rallies to 200 — ratchets hwm to 200.
    const svc = new ProtectiveExitService(
      clock,
      killSwitch('RUNNING'),
      feedRef,
      portfolioView(snap),
      sink,
      cfg,
    );
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    // Tick 2: price drops to 197 — exactly the 200×0.985 trailing boundary, far above the 100 entry
    // (proves the ratcheted peak, not the entry price, gates the trigger).
    mid = '197';
    await svc.tick(epochMs(T + 1000));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const signal = (sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
    expect(signal.reason).toBe('TRAILING_STOP');
  });

  it('gives STOP_LOSS precedence when both stop and trail fire on the same tick', async () => {
    // avgEntry 100, stop 0.02 -> boundary 98; trailing 0.015 seeded at ref (first tick) -> also 98-ish.
    // Force both true: ref far below both boundaries.
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const { svc, sink } = build({
      snap,
      mid: '50',
      config: { stopLossPct: '0.02', trailingPct: '0.015' },
    });
    await svc.tick(epochMs(T));
    const signal = (sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
    expect(signal.reason).toBe('STOP_LOSS');
  });

  it('stacking guard: skips firing when the symbol has an open order', async () => {
    const snap = snapshot({
      positions: new Map([[KEY, pos({ avgEntry: price('100') })]]),
      openOrders: [openOrder()],
    });
    const { svc, sink } = build({ snap, mid: '50' });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('stacking guard: skips firing when the symbol has an in-flight intent', async () => {
    const snap = snapshot({
      positions: new Map([[KEY, pos({ avgEntry: price('100') })]]),
      inFlightIntents: [inFlightIntent()],
    });
    const { svc, sink } = build({ snap, mid: '50' });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('cooldown blocks an immediate re-fire, then allows one after the cooldown expires', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const sink: SignalSinkPort = { recordSignal: vi.fn() };
    const svc = new ProtectiveExitService(
      clock,
      killSwitch('RUNNING'),
      feed('50'),
      portfolioView(snap),
      sink,
      config({ stopLossPct: '0.02', trailingPct: '0', cooldownMs: 30_000 }),
    );
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    await svc.tick(epochMs(T + 1000)); // within cooldown ⇒ no re-fire
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    await svc.tick(epochMs(T + 30_000)); // cooldown has elapsed ⇒ fires again
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('swallows a sink throw without crashing, without setting lastFiredAt, and without incrementing the counter', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const inc = vi.fn();
    const sink: SignalSinkPort = {
      recordSignal: vi.fn().mockRejectedValue(new Error('sink down')),
    };
    const svc = new ProtectiveExitService(
      clock,
      killSwitch('RUNNING'),
      feed('50'),
      portfolioView(snap),
      sink,
      config({ stopLossPct: '0.02', trailingPct: '0', cooldownMs: 30_000 }),
      { inc } as unknown as import('prom-client').Counter<string>,
    );
    await expect(svc.tick(epochMs(T))).resolves.toBeUndefined();
    expect(inc).not.toHaveBeenCalled();

    // No cooldown recorded ⇒ the very next tick retries immediately (same instant is fine here).
    await svc.tick(epochMs(T + 1));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('increments the counter with the correct reason label on a successful fire', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const inc = vi.fn();
    const { svc } = build({
      snap,
      mid: '50',
      config: { stopLossPct: '0.02', trailingPct: '0' },
      counter: { inc },
    });
    await svc.tick(epochMs(T));
    expect(inc).toHaveBeenCalledWith({ reason: 'STOP_LOSS' });
  });

  it('cleans up HWM/cooldown state once a position closes, so re-entry reseeds a fresh peak', async () => {
    const withPos = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
    const sink: SignalSinkPort = { recordSignal: vi.fn() };
    const cfg = config({ stopLossPct: '0', trailingPct: '0.015' });
    let currentSnap = withPos;
    const view: PortfolioViewPort = {
      snapshot: () => currentSnap,
      forStrategy: () => ({ strategyId: SID, positions: currentSnap.positions, openOrders: [] }),
    };
    let mid = '200';
    const feedRef: FeedHealthPort = {
      getRefPrice: () => ({ mid: price(mid), at: epochMs(T) }),
      health: () => 'LIVE',
      fetchCandles: () => Promise.resolve([]),
    };
    const svc = new ProtectiveExitService(clock, killSwitch('RUNNING'), feedRef, view, sink, cfg);

    // Ratchet HWM to 200.
    await svc.tick(epochMs(T));
    const internal = svc as unknown as { hwm: Map<string, Decimal> };
    expect(internal.hwm.get(KEY)?.toFixed()).toBe('200');

    // Position closes (flat) — cleanup drops the HWM entry.
    currentSnap = snapshot({ positions: new Map() });
    await svc.tick(epochMs(T + 1000));
    expect(internal.hwm.has(KEY)).toBe(false);

    // Re-enter at a much lower price — must reseed fresh (from the new avgEntry/ref), not reuse 200.
    currentSnap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('50') })]]) });
    mid = '50';
    await svc.tick(epochMs(T + 2000));
    expect(internal.hwm.get(KEY)?.toFixed()).toBe('50');
  });

  it('skips a position with no ref price this tick (no HWM seeded, no fire) and retries later', async () => {
    const snap = snapshot({ positions: new Map([[KEY, pos()]]) });
    const { svc, sink } = build({ snap, noRef: true });
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    const internal = svc as unknown as { hwm: Map<string, Decimal> };
    expect(internal.hwm.has(KEY)).toBe(false); // nothing seeded off a missing price
  });

  it('treats a below-minQty sliver as dust (skipped) even when the stop would trigger', async () => {
    // qty 0.00005 < minQty 0.0001 — line-140 branch, distinct from the minNotional dust rule.
    const snap = snapshot({
      positions: new Map([[KEY, pos({ signedQty: new Decimal('0.00005') })]]),
    });
    const { svc, sink } = build({ snap, mid: '1' }); // 99% below entry — would fire if not dust
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('drops the cooldown entry when the position closes, so a re-entry can protect immediately', async () => {
    let currentSnap = snapshot({ positions: new Map([[KEY, pos()]]) });
    const view: PortfolioViewPort = {
      snapshot: () => currentSnap,
      forStrategy: () => ({
        strategyId: SID,
        positions: currentSnap.positions,
        openOrders: currentSnap.openOrders,
      }),
    };
    const sink: SignalSinkPort = { recordSignal: vi.fn() };
    // Stop-only config; ref 97 ≤ entry×0.98 = 98 ⇒ fires (and 1×97 notional stays above the dust
    // rule, unlike a deep crash that would sweep the position into the minNotional skip).
    const svc = new ProtectiveExitService(
      clock,
      killSwitch('RUNNING'),
      feed('97'),
      view,
      sink,
      config({ trailingPct: '0' }),
    );
    await svc.tick(epochMs(T));
    expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const internal = svc as unknown as { lastFiredAt: Map<string, number> };
    expect(internal.lastFiredAt.has(KEY)).toBe(true);

    // Position gone → the cooldown entry is cleaned up alongside the HWM.
    currentSnap = snapshot({ positions: new Map() });
    await svc.tick(epochMs(T + 1000));
    expect(internal.lastFiredAt.has(KEY)).toBe(false);
  });

  // ── Short support: LWM (low-water mark) trailing + inverted stop, kind EXIT_SHORT ──
  function shortPos(over: Partial<Position> = {}): Position {
    return pos({ signedQty: new Decimal('-1'), ...over });
  }

  describe('short positions', () => {
    it('fires an inverted STOP_LOSS at exactly the boundary (ref == avgEntry * (1 + stopLossPct))', async () => {
      // avgEntry 100, stopLossPct 0.02 ⇒ boundary 102. ref exactly 102 must trigger (≥, not >).
      const snap = snapshot({ positions: new Map([[KEY, shortPos({ avgEntry: price('100') })]]) });
      const { svc, sink } = build({
        snap,
        mid: '102',
        config: { stopLossPct: '0.02', trailingPct: '0' },
      });
      await svc.tick(epochMs(T));
      expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      const signal = (sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
      expect(signal.kind).toBe('EXIT_SHORT');
      expect(signal.reason).toBe('STOP_LOSS');
      expect(signal.refPrice.toFixed()).toBe('102');
    });

    it('does not fire the inverted STOP_LOSS just below the boundary', async () => {
      const snap = snapshot({ positions: new Map([[KEY, shortPos({ avgEntry: price('100') })]]) });
      const { svc, sink } = build({
        snap,
        mid: '101.99',
        config: { stopLossPct: '0.02', trailingPct: '0' },
      });
      await svc.tick(epochMs(T));
      expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('seeds the LWM from avgEntry when avgEntry < ref on first sight (no premature trail trigger)', async () => {
      const snap = snapshot({ positions: new Map([[KEY, shortPos({ avgEntry: price('100') })]]) });
      const { svc, sink } = build({
        snap,
        mid: '90',
        config: { stopLossPct: '0', trailingPct: '0.015' },
      });
      await svc.tick(epochMs(T));
      // lwm seeds at min(100, 90)=90; trail threshold 90*1.015=91.35; ref 90 <= threshold ⇒ no fire
      // (price fell further in the short's favor, not against it).
      expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('ratchets the LWM down across ticks and never back up, firing TRAILING_STOP from the trough', async () => {
      const snap = snapshot({ positions: new Map([[KEY, shortPos({ avgEntry: price('100') })]]) });
      const sink: SignalSinkPort = { recordSignal: vi.fn() };
      let mid = '80';
      const feedRef: FeedHealthPort = {
        getRefPrice: () => ({ mid: price(mid), at: epochMs(T) }),
        health: () => 'LIVE',
        fetchCandles: () => Promise.resolve([]),
      };
      const svc = new ProtectiveExitService(
        clock,
        killSwitch('RUNNING'),
        feedRef,
        portfolioView(snap),
        sink,
        config({ stopLossPct: '0', trailingPct: '0.015' }),
      );
      await svc.tick(epochMs(T)); // lwm -> 80, ref 80, threshold 80*1.015=81.2, no fire
      expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

      // Price rises to 90 — well above the ratcheted 80 trough's trail threshold (81.2). If the LWM
      // had reseeded to the higher current price instead of ratcheting down, this would NOT fire.
      mid = '90';
      await svc.tick(epochMs(T + 1000));
      expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      const signal = (sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
      expect(signal.kind).toBe('EXIT_SHORT');
      expect(signal.reason).toBe('TRAILING_STOP');
    });

    it('cleans up the LWM once a short position closes, so re-entry reseeds a fresh trough', async () => {
      const withPos = snapshot({
        positions: new Map([[KEY, shortPos({ avgEntry: price('100') })]]),
      });
      const sink: SignalSinkPort = { recordSignal: vi.fn() };
      const cfg = config({ stopLossPct: '0', trailingPct: '0.015' });
      let currentSnap = withPos;
      const view: PortfolioViewPort = {
        snapshot: () => currentSnap,
        forStrategy: () => ({ strategyId: SID, positions: currentSnap.positions, openOrders: [] }),
      };
      let mid = '50';
      const feedRef: FeedHealthPort = {
        getRefPrice: () => ({ mid: price(mid), at: epochMs(T) }),
        health: () => 'LIVE',
        fetchCandles: () => Promise.resolve([]),
      };
      const svc = new ProtectiveExitService(clock, killSwitch('RUNNING'), feedRef, view, sink, cfg);

      await svc.tick(epochMs(T));
      const internal = svc as unknown as { lwm: Map<string, Decimal> };
      expect(internal.lwm.get(KEY)?.toFixed()).toBe('50');

      currentSnap = snapshot({ positions: new Map() });
      await svc.tick(epochMs(T + 1000));
      expect(internal.lwm.has(KEY)).toBe(false);

      currentSnap = snapshot({ positions: new Map([[KEY, shortPos({ avgEntry: price('200') })]]) });
      mid = '200';
      await svc.tick(epochMs(T + 2000));
      expect(internal.lwm.get(KEY)?.toFixed()).toBe('200');
    });

    it('drops the stale opposite-direction watermark on a sign flip (long → short reusing the same key)', async () => {
      let currentSnap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
      const view: PortfolioViewPort = {
        snapshot: () => currentSnap,
        forStrategy: () => ({ strategyId: SID, positions: currentSnap.positions, openOrders: [] }),
      };
      const sink: SignalSinkPort = { recordSignal: vi.fn() };
      const cfg = config({ stopLossPct: '0', trailingPct: '0.015' });
      let mid = '150';
      const feedRef: FeedHealthPort = {
        getRefPrice: () => ({ mid: price(mid), at: epochMs(T) }),
        health: () => 'LIVE',
        fetchCandles: () => Promise.resolve([]),
      };
      const svc = new ProtectiveExitService(clock, killSwitch('RUNNING'), feedRef, view, sink, cfg);

      // Long leg ratchets hwm to 150.
      await svc.tick(epochMs(T));
      const internal = svc as unknown as { hwm: Map<string, Decimal>; lwm: Map<string, Decimal> };
      expect(internal.hwm.get(KEY)?.toFixed()).toBe('150');

      // Position flips to a short at the same key — the stale long hwm must not leak into the
      // short's inverted-direction math (a hwm read on the short branch would be a bug).
      currentSnap = snapshot({ positions: new Map([[KEY, shortPos({ avgEntry: price('150') })]]) });
      mid = '150';
      await svc.tick(epochMs(T + 1000));
      expect(internal.lwm.get(KEY)?.toFixed()).toBe('150');
      expect(internal.hwm.has(KEY)).toBe(false);
    });

    it("drops the cooldown stamp on a sign flip so the fresh short's first stop is not suppressed", async () => {
      let currentSnap = snapshot({ positions: new Map([[KEY, pos({ avgEntry: price('100') })]]) });
      const view: PortfolioViewPort = {
        snapshot: () => currentSnap,
        forStrategy: () => ({ strategyId: SID, positions: currentSnap.positions, openOrders: [] }),
      };
      const sink: SignalSinkPort = { recordSignal: vi.fn() };
      const cfg = config({ stopLossPct: '0.01', trailingPct: '0' });
      let mid = '98'; // long stop: 98 ≤ 100 × 0.99 ⇒ fires, stamping lastFiredAt
      const feedRef: FeedHealthPort = {
        getRefPrice: () => ({ mid: price(mid), at: epochMs(T) }),
        health: () => 'LIVE',
        fetchCandles: () => Promise.resolve([]),
      };
      const svc = new ProtectiveExitService(clock, killSwitch('RUNNING'), feedRef, view, sink, cfg);

      await svc.tick(epochMs(T));
      expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

      // Flip to a short at the same key, well inside the cooldown window. The flip drops the
      // long-era stamp, so the short's own stop (102 ≥ 100 × 1.01) must fire immediately.
      currentSnap = snapshot({ positions: new Map([[KEY, shortPos({ avgEntry: price('100') })]]) });
      mid = '102';
      await svc.tick(epochMs(T + 1000));
      expect((sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it('gives STOP_LOSS precedence over TRAILING_STOP on a short when both fire the same tick', async () => {
      const snap = snapshot({ positions: new Map([[KEY, shortPos({ avgEntry: price('100') })]]) });
      const { svc, sink } = build({
        snap,
        mid: '150', // far above both the 102 stop boundary and the seeded 100×1.015=101.5 trail boundary
        config: { stopLossPct: '0.02', trailingPct: '0.015' },
      });
      await svc.tick(epochMs(T));
      const signal = (sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Signal;
      expect(signal.reason).toBe('STOP_LOSS');
    });

    it('applies the stacking guard and dust check to shorts identically to longs', async () => {
      const busySnap = snapshot({
        positions: new Map([[KEY, shortPos({ avgEntry: price('100') })]]),
        openOrders: [openOrder()],
      });
      const busy = build({ snap: busySnap, mid: '150' });
      await busy.svc.tick(epochMs(T));
      expect((busy.sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

      const dustSnap = snapshot({
        positions: new Map([[KEY, shortPos({ signedQty: new Decimal('-0.001') })]]), // notional 0.15 < minNotional 5
      });
      const dust = build({ snap: dustSnap, mid: '150' });
      await dust.svc.tick(epochMs(T));
      expect((dust.sink.recordSignal as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
