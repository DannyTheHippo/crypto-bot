import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CORRELATION_HEADER,
  currentCorrelationId,
  runWithCorrelation,
} from '../../../src/shared/correlation/correlation';
import { CorrelationMiddleware } from '../../../src/shared/correlation/correlation.middleware';

describe('correlation ALS', () => {
  it('is undefined outside any scope', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('carries a supplied id within the scope and drops it after', () => {
    const seen = runWithCorrelation('abc-123', () => currentCorrelationId());
    expect(seen).toBe('abc-123');
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('mints a UUID when the caller supplies none or a blank', () => {
    const minted = runWithCorrelation(undefined, () => currentCorrelationId());
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    const blank = runWithCorrelation('   ', () => currentCorrelationId());
    expect(blank).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('survives async continuations inside the scope', async () => {
    const seen = await runWithCorrelation('async-1', async () => {
      await new Promise((r) => setTimeout(r, 0));
      return currentCorrelationId();
    });
    expect(seen).toBe('async-1');
  });
});

describe('CorrelationMiddleware', () => {
  function run(headers: Record<string, string | string[]>) {
    const setHeaders: Record<string, string> = {};
    const req = { headers } as unknown as IncomingMessage;
    const res = {
      setHeader: (k: string, v: string) => {
        setHeaders[k] = v;
      },
    } as unknown as ServerResponse;
    let insideId: string | undefined;
    new CorrelationMiddleware().use(req, res, () => {
      insideId = currentCorrelationId();
    });
    return { setHeaders, insideId };
  }

  it('propagates an inbound id: handler scope and response header both carry it', () => {
    const { setHeaders, insideId } = run({ [CORRELATION_HEADER]: 'client-7' });
    expect(insideId).toBe('client-7');
    expect(setHeaders[CORRELATION_HEADER]).toBe('client-7');
  });

  it('mints when absent and takes the first value of a repeated header', () => {
    const minted = run({});
    expect(minted.insideId).toMatch(/^[0-9a-f-]{36}$/);
    expect(minted.setHeaders[CORRELATION_HEADER]).toBe(minted.insideId);

    const repeated = run({ [CORRELATION_HEADER]: ['first', 'second'] });
    expect(repeated.insideId).toBe('first');
  });
});
