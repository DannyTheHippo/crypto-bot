import { describe, it, expect } from 'vitest';
import { PlanStopRegistryService } from '../../../../src/features/trading/risk/plan-stop-registry.service';
import type { PlanStop } from '../../../../src/ports/trading/risk';
import { positionKey } from '../../../../src/domain/trading/risk/evaluate';
import { strategyId, venueId, symbolId } from '../../../../src/domain/common/types/ids';

const SID = strategyId('agentic-btc');
const V = venueId('binance');
const V_PERP = venueId('binanceusdm');
const SYM = symbolId('BTC/USDT');
const SYM_PERP = symbolId('BTC/USDT:USDT');

// The registry's key convention is positionKey(strategyId, venue, symbol) — the SAME key
// ProtectiveExitService's hwm/lwm/cooldown maps and HaltCoordinator's snapshot.positions lookup
// use, so a key built any other way would silently miss on the reader side.
const KEY = positionKey(SID, V, SYM);
const KEY_PERP = positionKey(SID, V_PERP, SYM_PERP);

function planStop(over: Partial<PlanStop> = {}): PlanStop {
  return { side: 'LONG', stopPrice: '94.5', venueStopResting: false, ...over };
}

describe('PlanStopRegistryService', () => {
  it('set() then get() round-trips the entry with its stopPrice string byte-identical', () => {
    const reg = new PlanStopRegistryService();
    reg.set(KEY, planStop({ stopPrice: '94.500000000000000001' }));
    // The watcher compares this against a live mid — a float round-trip here would move the stop.
    expect(reg.get(KEY)).toEqual({
      side: 'LONG',
      stopPrice: '94.500000000000000001',
      venueStopResting: false,
    });
  });

  it('get() returns undefined for a position with no plan stop (watcher falls through to the global-% backstop)', () => {
    const reg = new PlanStopRegistryService();
    reg.set(KEY, planStop());
    expect(reg.get(KEY_PERP)).toBeUndefined();
  });

  it('a second set() REPLACES the whole entry — the confirm-before-flag venueStopResting update path', () => {
    // Mirrors AgenticStrategy.setVenueStopResting: read current, re-set the whole entry once a
    // placed stop is CONFIRMED resting. A merge-instead-of-replace registry would leave the old
    // algoId behind when the flag flips back to false.
    const reg = new PlanStopRegistryService();
    reg.set(KEY_PERP, planStop({ side: 'SHORT', stopPrice: '105.25' }));
    const current = reg.get(KEY_PERP);
    expect(current?.venueStopResting).toBe(false);

    reg.set(KEY_PERP, { ...current!, venueStopResting: true, algoId: 'algo-77' });
    expect(reg.get(KEY_PERP)).toEqual({
      side: 'SHORT',
      stopPrice: '105.25',
      venueStopResting: true,
      algoId: 'algo-77',
    });

    // …and back down (reconcile bar found the venue stop missing): algoId must not survive.
    reg.set(KEY_PERP, { ...reg.get(KEY_PERP)!, venueStopResting: false, algoId: undefined });
    expect(reg.get(KEY_PERP)?.venueStopResting).toBe(false);
    expect(reg.get(KEY_PERP)?.algoId).toBeUndefined();
  });

  it('clear() removes the entry from both get() and entries() (plan closed ⇒ nothing to watch)', () => {
    const reg = new PlanStopRegistryService();
    reg.set(KEY, planStop());
    reg.clear(KEY);
    expect(reg.get(KEY)).toBeUndefined();
    expect(reg.entries().size).toBe(0);
  });

  it('clear() on a key with no entry is a no-op that leaves every other entry intact', () => {
    // AgenticStrategy clears unconditionally on plan-clear, including for a position that never
    // registered a stop — that must never disturb another position's live entry.
    const reg = new PlanStopRegistryService();
    reg.set(KEY, planStop({ stopPrice: '94.5' }));
    reg.clear(KEY_PERP);
    expect(reg.get(KEY)?.stopPrice).toBe('94.5');
    expect(reg.entries().size).toBe(1);
  });

  it("entries() exposes every live entry keyed by positionKey for the halt drain's algo-cancel sweep", () => {
    // HaltCoordinator.cancelRestingAlgoStops iterates entries() and keys back into the portfolio
    // snapshot by the SAME key, cancelling only the rows carrying an algoId.
    const reg = new PlanStopRegistryService();
    reg.set(KEY, planStop({ stopPrice: '94.5' }));
    reg.set(KEY_PERP, planStop({ side: 'SHORT', stopPrice: '105.25', algoId: 'algo-77' }));

    const seen = [...reg.entries()].map(([key, stop]) => [key, stop.stopPrice, stop.algoId]);
    expect(seen).toEqual([
      [`${SID}:${V}:${SYM}`, '94.5', undefined],
      [`${SID}:${V_PERP}:${SYM_PERP}`, '105.25', 'algo-77'],
    ]);
  });

  it('a fresh registry is empty (a restart watches nothing until a plan re-registers)', () => {
    // The registry lives in-process and is wiped by a restart — reconcileOrphanedAlgoStop's whole
    // reason for existing. Pin the empty start so that assumption cannot silently change.
    expect(new PlanStopRegistryService().entries().size).toBe(0);
  });

  it('entries are position-scoped: the spot and perp legs of one strategy never collide', () => {
    const reg = new PlanStopRegistryService();
    reg.set(KEY, planStop({ side: 'LONG', stopPrice: '94.5' }));
    reg.set(KEY_PERP, planStop({ side: 'SHORT', stopPrice: '105.25' }));
    reg.clear(KEY);
    expect(reg.get(KEY)).toBeUndefined();
    expect(reg.get(KEY_PERP)).toEqual({
      side: 'SHORT',
      stopPrice: '105.25',
      venueStopResting: false,
    });
  });
});
