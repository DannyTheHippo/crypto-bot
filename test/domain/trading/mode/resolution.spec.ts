import { describe, it, expect } from 'vitest';
import {
  resolveMode,
  type ModeResolutionVector,
} from '../../../../src/domain/trading/mode/resolution';

// Base vector with all four live gates satisfied.
const allLive: ModeResolutionVector = {
  requested: 'live',
  envFlagLive: true,
  armed: true,
  keysValid: true,
  limitsComplete: true,
  testnetKeysValid: false,
};

describe('resolveMode — live requested (2⁴ gate combinations)', () => {
  it('all gates true → effective live, no downgrades', () => {
    expect(resolveMode(allLive)).toEqual({
      effective: 'live',
      requested: 'live',
      downgrades: [],
    });
  });

  it('envFlagLive false → paper with ENV_FLAG', () => {
    const r = resolveMode({ ...allLive, envFlagLive: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['ENV_FLAG']);
  });

  it('armed false → paper with NOT_ARMED', () => {
    const r = resolveMode({ ...allLive, armed: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['NOT_ARMED']);
  });

  it('keysValid false → paper with KEYS_INVALID', () => {
    const r = resolveMode({ ...allLive, keysValid: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['KEYS_INVALID']);
  });

  it('limitsComplete false → paper with LIMITS_INCOMPLETE', () => {
    const r = resolveMode({ ...allLive, limitsComplete: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['LIMITS_INCOMPLETE']);
  });

  it('envFlagLive+armed false → paper with ENV_FLAG,NOT_ARMED (ordered)', () => {
    const r = resolveMode({ ...allLive, envFlagLive: false, armed: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['ENV_FLAG', 'NOT_ARMED']);
  });

  it('envFlagLive+keysValid false → paper with ENV_FLAG,KEYS_INVALID', () => {
    const r = resolveMode({ ...allLive, envFlagLive: false, keysValid: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['ENV_FLAG', 'KEYS_INVALID']);
  });

  it('envFlagLive+limitsComplete false → paper with ENV_FLAG,LIMITS_INCOMPLETE', () => {
    const r = resolveMode({ ...allLive, envFlagLive: false, limitsComplete: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['ENV_FLAG', 'LIMITS_INCOMPLETE']);
  });

  it('armed+keysValid false → paper with NOT_ARMED,KEYS_INVALID', () => {
    const r = resolveMode({ ...allLive, armed: false, keysValid: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['NOT_ARMED', 'KEYS_INVALID']);
  });

  it('armed+limitsComplete false → paper with NOT_ARMED,LIMITS_INCOMPLETE', () => {
    const r = resolveMode({ ...allLive, armed: false, limitsComplete: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['NOT_ARMED', 'LIMITS_INCOMPLETE']);
  });

  it('keysValid+limitsComplete false → paper with KEYS_INVALID,LIMITS_INCOMPLETE', () => {
    const r = resolveMode({ ...allLive, keysValid: false, limitsComplete: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['KEYS_INVALID', 'LIMITS_INCOMPLETE']);
  });

  it('envFlagLive+armed+keysValid false → paper with three reasons', () => {
    const r = resolveMode({ ...allLive, envFlagLive: false, armed: false, keysValid: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['ENV_FLAG', 'NOT_ARMED', 'KEYS_INVALID']);
  });

  it('envFlagLive+armed+limitsComplete false → paper with three reasons', () => {
    const r = resolveMode({ ...allLive, envFlagLive: false, armed: false, limitsComplete: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['ENV_FLAG', 'NOT_ARMED', 'LIMITS_INCOMPLETE']);
  });

  it('envFlagLive+keysValid+limitsComplete false → paper with three reasons', () => {
    const r = resolveMode({
      ...allLive,
      envFlagLive: false,
      keysValid: false,
      limitsComplete: false,
    });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['ENV_FLAG', 'KEYS_INVALID', 'LIMITS_INCOMPLETE']);
  });

  it('armed+keysValid+limitsComplete false → paper with three reasons', () => {
    const r = resolveMode({ ...allLive, armed: false, keysValid: false, limitsComplete: false });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['NOT_ARMED', 'KEYS_INVALID', 'LIMITS_INCOMPLETE']);
  });

  it('all gates false → paper with all four downgrade reasons', () => {
    const r = resolveMode({
      ...allLive,
      envFlagLive: false,
      armed: false,
      keysValid: false,
      limitsComplete: false,
    });
    expect(r.effective).toBe('paper');
    expect(r.downgrades).toEqual(['ENV_FLAG', 'NOT_ARMED', 'KEYS_INVALID', 'LIMITS_INCOMPLETE']);
  });
});

describe('resolveMode — testnet requested', () => {
  it('testnetKeysValid true → effective testnet, no downgrades', () => {
    const r = resolveMode({
      requested: 'testnet',
      envFlagLive: false,
      armed: false,
      keysValid: false,
      limitsComplete: false,
      testnetKeysValid: true,
    });
    expect(r).toEqual({ effective: 'testnet', requested: 'testnet', downgrades: [] });
  });

  it('testnetKeysValid false → effective paper, no downgrades', () => {
    const r = resolveMode({
      requested: 'testnet',
      envFlagLive: false,
      armed: false,
      keysValid: false,
      limitsComplete: false,
      testnetKeysValid: false,
    });
    expect(r).toEqual({ effective: 'paper', requested: 'testnet', downgrades: [] });
  });
});

describe('resolveMode — paper requested', () => {
  it('paper → always effective paper, empty downgrades', () => {
    const r = resolveMode({
      requested: 'paper',
      envFlagLive: false,
      armed: false,
      keysValid: false,
      limitsComplete: false,
      testnetKeysValid: false,
    });
    expect(r).toEqual({ effective: 'paper', requested: 'paper', downgrades: [] });
  });
});
