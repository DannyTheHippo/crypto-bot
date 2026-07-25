import { describe, it, expect } from 'vitest';
import {
  queryBackoffMs,
  QUERY_BACKOFF_MS,
  MAX_QUERY_ATTEMPTS,
  UNKNOWN_KILL_AFTER_MS,
} from '../../../src/domain/oms/query-backoff';

describe('queryBackoffMs (§6.3 query loop)', () => {
  it('exposes the documented schedule and constants', () => {
    expect([...QUERY_BACKOFF_MS]).toEqual([250, 500, 1000, 2000, 4000]);
    expect(MAX_QUERY_ATTEMPTS).toBe(5);
    expect(UNKNOWN_KILL_AFTER_MS).toBe(60_000);
  });

  it('returns the base delay at jitter01 = 0.5 (the midpoint)', () => {
    expect(queryBackoffMs(1, 0.5)).toBe(250);
    expect(queryBackoffMs(2, 0.5)).toBe(500);
    expect(queryBackoffMs(5, 0.5)).toBe(4000);
  });

  it('applies a ±20% jitter band', () => {
    expect(queryBackoffMs(1, 0)).toBe(200); // 250 × 0.8 (lower edge)
    expect(queryBackoffMs(1, 1)).toBe(300); // 250 × 1.2 (upper edge)
    expect(queryBackoffMs(4, 0)).toBe(1600); // 2000 × 0.8
  });

  it('clamps an attempt below 1 to the first bucket', () => {
    expect(queryBackoffMs(0, 0.5)).toBe(250);
    expect(queryBackoffMs(-3, 0.5)).toBe(250);
  });

  it('clamps an attempt past the schedule to the last bucket', () => {
    expect(queryBackoffMs(6, 0.5)).toBe(4000);
    expect(queryBackoffMs(99, 0.5)).toBe(4000);
  });

  it('truncates a fractional attempt index', () => {
    expect(queryBackoffMs(2.9, 0.5)).toBe(500); // floor → bucket 2
  });
});
