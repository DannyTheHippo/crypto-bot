import { describe, it, expect } from 'vitest';
import {
  createArmPreconditions,
  type UnresolvedOrdersReader,
} from '../../../src/features/trading/composition/arm-preconditions.module';
import type { KillSwitchPort } from '../../../src/ports/risk';
import type { KillSwitchState } from '../../../src/domain/risk/kill-switch';

function fakeKillSwitch(state: KillSwitchState | (() => KillSwitchState)): KillSwitchPort {
  return {
    state: () => (typeof state === 'function' ? state() : state),
    reason: () => '',
    engage: () => undefined,
    confirmCancels: () => undefined,
    cancelTimeout: () => undefined,
    allFlat: () => undefined,
    resume: () => undefined,
  };
}

function fakeUnresolvedOrders(value: boolean | (() => boolean)): UnresolvedOrdersReader {
  return {
    hasUnresolvedOrders: () => (typeof value === 'function' ? value() : value),
  };
}

// §10b arm-hardening: real ARM_PRECONDITIONS provider, replacing the always-`{ok:true}` stub. Each
// case below is a precondition the operator's arm/confirm can now be refused on — see
// docs/runbook.md's Re-arm section for the operator-facing list.
describe('createArmPreconditions', () => {
  it('ok when the kill switch is RUNNING and no orders are unresolved', () => {
    const preconditions = createArmPreconditions(
      fakeKillSwitch('RUNNING'),
      fakeUnresolvedOrders(false),
    );
    expect(preconditions.check()).toEqual({ ok: true });
  });

  it('not-ok with a specific reason when the kill switch is not RUNNING', () => {
    const preconditions = createArmPreconditions(
      fakeKillSwitch('HALTING'),
      fakeUnresolvedOrders(false),
    );
    const result = preconditions.check();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('HALTING');
  });

  it('not-ok with a specific reason when orders are unresolved', () => {
    const preconditions = createArmPreconditions(
      fakeKillSwitch('RUNNING'),
      fakeUnresolvedOrders(true),
    );
    const result = preconditions.check();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unresolved orders');
  });

  it('fails closed (not-ok, unavailable) when the kill switch read throws', () => {
    const killSwitch = fakeKillSwitch(() => {
      throw new Error('boom');
    });
    const preconditions = createArmPreconditions(killSwitch, fakeUnresolvedOrders(false));
    const result = preconditions.check();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unavailable');
  });

  it('fails closed (not-ok, unavailable) when the unresolved-orders read throws', () => {
    const unresolvedOrders = fakeUnresolvedOrders(() => {
      throw new Error('boom');
    });
    const preconditions = createArmPreconditions(fakeKillSwitch('RUNNING'), unresolvedOrders);
    const result = preconditions.check();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unavailable');
  });

  it('checks the kill switch before the unresolved-orders read (fail-fast on the cheaper gate)', () => {
    let ordersRead = false;
    const unresolvedOrders: UnresolvedOrdersReader = {
      hasUnresolvedOrders: () => {
        ordersRead = true;
        return false;
      },
    };
    const preconditions = createArmPreconditions(fakeKillSwitch('HALTED'), unresolvedOrders);
    preconditions.check();
    expect(ordersRead).toBe(false);
  });
});
