import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import {
  ArmingTransportGuard,
  ARMING_TOKEN_HEADER,
} from '../../../src/features/trading/mode-control/arming-transport.guard';
import type { TypedConfigService } from '../../../src/config/environment/typed-config.service';
import type { TradingMode } from '../../../src/domain/types/mode';

const ENV_KEY = 'ARMING_TRANSPORT_TOKEN';

function fakeConfig(configMode: TradingMode): TypedConfigService {
  return { mode: { configMode } } as unknown as TypedConfigService;
}

// Minimal ExecutionContext stub: the guard only ever calls switchToHttp().getRequest().
function fakeContext(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('ArmingTransportGuard', () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('passes through in paper when the token env is absent', () => {
    delete process.env[ENV_KEY];
    const guard = new ArmingTransportGuard(fakeConfig('paper'));
    expect(guard.canActivate(fakeContext({}))).toBe(true);
  });

  it('passes through in testnet when the token env is absent', () => {
    delete process.env[ENV_KEY];
    const guard = new ArmingTransportGuard(fakeConfig('testnet'));
    expect(guard.canActivate(fakeContext({}))).toBe(true);
  });

  it('fail-closed: refuses in live when the token env is absent', () => {
    delete process.env[ENV_KEY];
    const guard = new ArmingTransportGuard(fakeConfig('live'));
    expect(guard.canActivate(fakeContext({}))).toBe(false);
  });

  it('rejects a request with no header when a token is configured', () => {
    process.env[ENV_KEY] = 'shared-secret';
    const guard = new ArmingTransportGuard(fakeConfig('paper'));
    expect(guard.canActivate(fakeContext({}))).toBe(false);
  });

  it('rejects a mismatched header value', () => {
    process.env[ENV_KEY] = 'shared-secret';
    const guard = new ArmingTransportGuard(fakeConfig('paper'));
    expect(guard.canActivate(fakeContext({ [ARMING_TOKEN_HEADER]: 'wrong' }))).toBe(false);
  });

  it('accepts a matching header value, even in live', () => {
    process.env[ENV_KEY] = 'shared-secret';
    const guard = new ArmingTransportGuard(fakeConfig('live'));
    expect(guard.canActivate(fakeContext({ [ARMING_TOKEN_HEADER]: 'shared-secret' }))).toBe(true);
  });

  it('takes the first value of a duplicated header', () => {
    process.env[ENV_KEY] = 'shared-secret';
    const guard = new ArmingTransportGuard(fakeConfig('paper'));
    expect(
      guard.canActivate(fakeContext({ [ARMING_TOKEN_HEADER]: ['shared-secret', 'other'] })),
    ).toBe(true);
  });

  // TypedConfigService is a TYPE dependency here — the instance arrives through Nest DI and the class
  // binding itself is only ever read by the emitted design:paramtypes metadata, which falls back to
  // Object when the binding is unavailable at module-evaluation time (a partially-initialized cycle).
  // Loading the guard with that binding absent must therefore change nothing about its verdicts: any
  // future `instanceof TypedConfigService` / static call added to canActivate would break here first,
  // and it would break the live-arming path in production the same way.
  it('verdicts are unchanged when the TypedConfigService binding is unavailable at module load', async () => {
    vi.resetModules();
    // Key present, value undefined — the shape a not-yet-initialized module namespace presents.
    vi.doMock('../../../src/config/environment/typed-config.service', () => ({
      TypedConfigService: undefined,
    }));
    const fresh = await import('../../../src/features/trading/mode-control/arming-transport.guard');
    vi.doUnmock('../../../src/config/environment/typed-config.service');

    delete process.env[ENV_KEY];
    expect(new fresh.ArmingTransportGuard(fakeConfig('live')).canActivate(fakeContext({}))).toBe(
      false,
    ); // still fail-closed in live
    expect(new fresh.ArmingTransportGuard(fakeConfig('paper')).canActivate(fakeContext({}))).toBe(
      true,
    ); // still a no-op in paper

    process.env[ENV_KEY] = 'shared-secret';
    const guard = new fresh.ArmingTransportGuard(fakeConfig('live'));
    expect(guard.canActivate(fakeContext({ [ARMING_TOKEN_HEADER]: 'shared-secret' }))).toBe(true);
    expect(guard.canActivate(fakeContext({ [ARMING_TOKEN_HEADER]: 'wrong' }))).toBe(false);
  });
});
