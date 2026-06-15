import { describe, it, expect } from 'vitest';
import { validateLimits, type PartialRiskLimits } from '../../../src/domain/risk/limits';

const VALID: PartialRiskLimits = {
  maxBandBps: 100,
  maxOrderNotional: '1000000',
  maxDriftBps: 100,
  maxPositionPerSymbol: '1000',
  maxGrossExposure: '1000000',
  maxNetExposure: '1000000',
  maxDailyLoss: '5000',
  maxDrawdownPct: '0.5',
  staleMaxAgeMs: 5000,
};

describe('validateLimits (§5 G2)', () => {
  it('returns the config when every field is present and positive', () => {
    expect(validateLimits(VALID)).toEqual(VALID);
  });
  it('rejects null / undefined', () => {
    expect(validateLimits(null)).toBeNull();
    expect(validateLimits(undefined)).toBeNull();
  });
  it('rejects a missing numeric field', () => {
    expect(validateLimits({ ...VALID, maxBandBps: null })).toBeNull();
  });
  it('rejects a non-positive numeric field', () => {
    expect(validateLimits({ ...VALID, maxDriftBps: 0 })).toBeNull();
  });
  it('rejects a non-finite numeric field', () => {
    expect(validateLimits({ ...VALID, staleMaxAgeMs: Infinity })).toBeNull();
  });
  it('rejects a missing or empty decimal field', () => {
    expect(validateLimits({ ...VALID, maxDailyLoss: null })).toBeNull();
    expect(validateLimits({ ...VALID, maxDailyLoss: '' })).toBeNull();
  });
  it('rejects an unparseable decimal field', () => {
    expect(validateLimits({ ...VALID, maxOrderNotional: 'not-a-number' })).toBeNull();
  });
  it('rejects a non-positive decimal field', () => {
    expect(validateLimits({ ...VALID, maxGrossExposure: '0' })).toBeNull();
  });
  it('rejects a non-finite decimal field', () => {
    expect(validateLimits({ ...VALID, maxNetExposure: 'Infinity' })).toBeNull();
  });
});
