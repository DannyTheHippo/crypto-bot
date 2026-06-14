import { describe, it, expect } from 'vitest';
import { reduceKillSwitch, INITIAL_KILL_SWITCH, type KillSwitch } from '../../../src/domain/risk/kill-switch';

const ks = (state: KillSwitch['state'], flattenRequested = false): KillSwitch => ({ state, flattenRequested });

describe('reduceKillSwitch state machine', () => {
  it('RUNNING + ENGAGE(flatten) → HALTING carrying the flatten flag', () => {
    expect(reduceKillSwitch(INITIAL_KILL_SWITCH, { type: 'ENGAGE', flatten: true })).toEqual({ state: 'HALTING', flattenRequested: true });
    expect(reduceKillSwitch(INITIAL_KILL_SWITCH, { type: 'ENGAGE', flatten: false })).toEqual({ state: 'HALTING', flattenRequested: false });
  });
  it('RUNNING ignores non-ENGAGE events', () => {
    expect(reduceKillSwitch(INITIAL_KILL_SWITCH, { type: 'ALL_FLAT' })).toBe(INITIAL_KILL_SWITCH);
  });
  it('HALTING + CANCELS_CONFIRMED → FLATTENING (when flatten requested) or HALTED', () => {
    expect(reduceKillSwitch(ks('HALTING', true), { type: 'CANCELS_CONFIRMED' })).toEqual({ state: 'FLATTENING', flattenRequested: true });
    expect(reduceKillSwitch(ks('HALTING', false), { type: 'CANCELS_CONFIRMED' })).toEqual({ state: 'HALTED', flattenRequested: false });
  });
  it('HALTING + CANCEL_TIMEOUT → HALTED_DEGRADED', () => {
    expect(reduceKillSwitch(ks('HALTING', true), { type: 'CANCEL_TIMEOUT' })).toEqual({ state: 'HALTED_DEGRADED', flattenRequested: true });
  });
  it('HALTING ignores unrelated events', () => {
    expect(reduceKillSwitch(ks('HALTING'), { type: 'ALL_FLAT' })).toEqual(ks('HALTING'));
  });
  it('FLATTENING + ALL_FLAT → HALTED; ignores others', () => {
    expect(reduceKillSwitch(ks('FLATTENING', true), { type: 'ALL_FLAT' })).toEqual({ state: 'HALTED', flattenRequested: false });
    expect(reduceKillSwitch(ks('FLATTENING', true), { type: 'CANCEL_TIMEOUT' })).toEqual(ks('FLATTENING', true));
  });
  it('HALTED/HALTED_DEGRADED + RESUME → RUNNING; ignores others', () => {
    expect(reduceKillSwitch(ks('HALTED'), { type: 'RESUME' })).toEqual(INITIAL_KILL_SWITCH);
    expect(reduceKillSwitch(ks('HALTED_DEGRADED'), { type: 'RESUME' })).toEqual(INITIAL_KILL_SWITCH);
    expect(reduceKillSwitch(ks('HALTED'), { type: 'ENGAGE', flatten: true })).toEqual(ks('HALTED'));
    expect(reduceKillSwitch(ks('HALTED_DEGRADED'), { type: 'ALL_FLAT' })).toEqual(ks('HALTED_DEGRADED'));
  });
});
