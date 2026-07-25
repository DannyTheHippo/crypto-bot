import { describe, it, expect } from 'vitest';
import { SystemClock } from '../../../src/ports/common/clock';

describe('SystemClock', () => {
  it('returns the current epoch milliseconds as a positive integer', () => {
    const now = new SystemClock().now();
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThan(0);
  });
});
