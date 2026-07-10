import { describe, it, expect } from 'vitest';
import { paramsHash, datasetHash, PRIOR_TRIAL_ROWS } from './experiment-log';
import { PRIOR_TRIALS } from './trial-registry';

describe('experiment-log — hash determinism', () => {
  it('paramsHash is deterministic for identical input', () => {
    const a = paramsHash({ maxHoldBars: 20, kMultiple: 1.5 });
    const b = paramsHash({ maxHoldBars: 20, kMultiple: 1.5 });
    expect(a).toBe(b);
  });

  it('paramsHash is independent of key order', () => {
    const a = paramsHash({ maxHoldBars: 20, kMultiple: 1.5 });
    const b = paramsHash({ kMultiple: 1.5, maxHoldBars: 20 });
    expect(a).toBe(b);
  });

  it('paramsHash differs for a differing value', () => {
    const a = paramsHash({ maxHoldBars: 20, kMultiple: 1.5 });
    const b = paramsHash({ maxHoldBars: 20, kMultiple: 2 });
    expect(a).not.toBe(b);
  });

  it('datasetHash is deterministic and key-order independent', () => {
    const key = { symbol: 'BTCUSDT', interval: '1h', rowCount: 100, firstTs: 1, lastTs: 200 };
    const a = datasetHash(key);
    const b = datasetHash({
      lastTs: 200,
      firstTs: 1,
      rowCount: 100,
      interval: '1h',
      symbol: 'BTCUSDT',
    });
    expect(a).toBe(b);
  });

  it('datasetHash differs when rowCount differs', () => {
    const a = datasetHash({
      symbol: 'BTCUSDT',
      interval: '1h',
      rowCount: 100,
      firstTs: 1,
      lastTs: 200,
    });
    const b = datasetHash({
      symbol: 'BTCUSDT',
      interval: '1h',
      rowCount: 101,
      firstTs: 1,
      lastTs: 200,
    });
    expect(a).not.toBe(b);
  });

  it('PRIOR_TRIAL_ROWS never throws and maps at most PRIOR_TRIALS.length rows (skips missing data files)', () => {
    const rows = PRIOR_TRIAL_ROWS();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(PRIOR_TRIALS.length);
    for (const r of rows) {
      expect(r.family).toBe('SeedEntryStrategy');
      expect(r.source).toBe('human');
      expect(r.paramsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
