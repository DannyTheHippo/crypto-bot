import { describe, it, expect } from 'vitest';
import { roleForDedupeKey } from '../../../src/domain/oms/resting-order-role';

// Push 3 P7c: pure classification off a Signal's own dedupeKey lineage — no I/O, no clientOrderId
// format change (the venue-facing clientOrderId encoding, ids.ts's encodeClientOrderId, is
// unchanged; role rides the ALREADY-persisted intent.source.dedupeKey instead).
describe('roleForDedupeKey()', () => {
  it("classifies AgenticStrategy.manageVenueTp's real placement dedupeKey shape as vtp", () => {
    // Exact shape manageVenueTp stamps (agentic.strategy.ts): `${strategyId}:${symbol}:agentic:venue_tp_place:${eventTime}`.
    expect(roleForDedupeKey('agentic-1:BTC/USDT:agentic:venue_tp_place:1700000000000')).toBe('vtp');
  });

  it("classifies AgenticStrategy.buildCancelOpenSignal's real cancel dedupeKey shape as vtp", () => {
    expect(roleForDedupeKey('agentic-1:BTC/USDT:agentic:venue_tp_cancel:1700000000000')).toBe(
      'vtp',
    );
  });

  it('classifies a legacy (pre-P7c) resting-TP dedupeKey as vtp — legacy compatibility is free, no fallback path needed', () => {
    // Every venue-TP dedupeKey ever emitted by this codebase already carries 'venue_tp_' — a resting
    // order placed before P7c shipped resolves correctly with ZERO special-casing.
    expect(roleForDedupeKey('venue_tp_place:2')).toBe('vtp');
  });

  it('classifies a venue_stop_* dedupeKey as vsl (P7d convention, forward-compatible)', () => {
    expect(roleForDedupeKey('agentic-1:BTC/USDT:agentic:venue_stop_place:1700000000000')).toBe(
      'vsl',
    );
  });

  it('classifies an unrelated dedupeKey (plan exit, entry, stale sweep) as unknown', () => {
    expect(roleForDedupeKey('agentic-1:BTC/USDT:agentic:plan_exit:1700000000000')).toBe('unknown');
    expect(roleForDedupeKey('entry-1')).toBe('unknown');
    expect(roleForDedupeKey('protect:STOP_LOSS:BTC/USDT:1700000000000')).toBe('unknown');
  });
});
