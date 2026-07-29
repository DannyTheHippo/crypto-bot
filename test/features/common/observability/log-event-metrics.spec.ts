import { describe, it, expect, beforeEach } from 'vitest';
import { register } from 'prom-client';
import pino from 'pino';
import { Writable } from 'stream';
import {
  createLogEventNormalizer,
  materializeLogEventSeries,
  recordLogEvent,
  resolveLogMessage,
} from '../../../../src/features/common/observability/log-event-metrics';
import { buildPinoOptions } from '../../../../src/features/common/observability/logger.config';

async function counterValue(level: string, event: string): Promise<number | undefined> {
  const metric = register.getSingleMetric('app_log_events_total');
  if (!metric) return undefined;
  // prom-client 15's Metric.get() is async — it resolves the per-child values without having to
  // scrape and re-parse the whole registry exposition.
  const collected = await (
    metric as unknown as {
      get: () => Promise<{ values: { labels: Record<string, string>; value: number }[] }>;
    }
  ).get();
  return collected.values.find((v) => v.labels['level'] === level && v.labels['event'] === event)
    ?.value;
}

describe('normalizeLogEvent', () => {
  it('collapses per-event identifiers so one failure class is one key', () => {
    const normalize = createLogEventNormalizer();
    const a = normalize('fill poll failed for order 88213 on binanceusdm');
    const b = normalize('fill poll failed for order 41007 on binanceusdm');
    expect(a).toBe(b);
    expect(a).toBe('fill_poll_failed_for_order_on_binanceusdm');
  });

  it('strips uuids as well as digit runs', () => {
    const normalize = createLogEventNormalizer();
    expect(normalize('boot 899d4a09-59bc-4f86-bf91-7f234a7df73c ready')).toBe('boot_ready');
  });

  it('folds every key past the cap into `other` instead of growing unbounded', () => {
    const normalize = createLogEventNormalizer(3);
    expect(normalize('alpha')).toBe('alpha');
    expect(normalize('beta')).toBe('beta');
    expect(normalize('gamma')).toBe('gamma');
    expect(normalize('delta')).toBe('other');
    // A key already admitted still resolves normally once the cap is reached.
    expect(normalize('beta')).toBe('beta');
  });

  it('truncates long messages to a bounded label', () => {
    const normalize = createLogEventNormalizer();
    const key = normalize('x'.repeat(200));
    expect(key.length).toBeLessThanOrEqual(48);
  });

  it('returns a sentinel for non-string and empty-after-normalization input', () => {
    const normalize = createLogEventNormalizer();
    expect(normalize(undefined)).toBe('unlabeled');
    expect(normalize({ not: 'a string' })).toBe('unlabeled');
    expect(normalize('12345')).toBe('unlabeled');
  });
});

describe('resolveLogMessage', () => {
  it('handles every pino call shape used in this codebase', () => {
    expect(resolveLogMessage(['plain message'])).toBe('plain message');
    expect(resolveLogMessage([{ venue: 'binance' }, 'with context'])).toBe('with context');
    expect(resolveLogMessage([{ msg: 'embedded' }])).toBe('embedded');
    expect(resolveLogMessage([new Error('from an error')])).toBe('from an error');
    expect(resolveLogMessage([{ venue: 'binance' }])).toBeUndefined();
  });
});

describe('recordLogEvent', () => {
  beforeEach(() => {
    register.removeSingleMetric('app_log_events_total');
  });

  it('counts warn/error/fatal and ignores anything below warn', async () => {
    recordLogEvent(50, ['venue request failed']);
    recordLogEvent(40, ['venue request failed']);
    recordLogEvent(30, ['routine info line']);
    recordLogEvent(20, ['debug line']);

    expect(await counterValue('error', 'venue_request_failed')).toBe(1);
    expect(await counterValue('warn', 'venue_request_failed')).toBe(1);
    expect(await counterValue('info', 'routine_info_line')).toBeUndefined();
    expect(await counterValue('debug', 'debug_line')).toBeUndefined();
  });

  it('materializes zero-valued children so a quiet app still exports series', async () => {
    materializeLogEventSeries();
    expect(await counterValue('warn', 'none')).toBe(0);
    expect(await counterValue('error', 'none')).toBe(0);
    expect(await counterValue('fatal', 'none')).toBe(0);
  });

  // Failure direction is OPEN: this sits on the hot logging path, so nothing it does may throw.
  it('never throws on hostile input', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => recordLogEvent(50, [circular])).not.toThrow();
    expect(() => recordLogEvent(Number.NaN, ['x'])).not.toThrow();
    expect(() => recordLogEvent(50, [])).not.toThrow();
  });
});

describe('pino logMethod hook', () => {
  beforeEach(() => {
    register.removeSingleMetric('app_log_events_total');
  });

  function loggerWritingTo(lines: string[]) {
    const dest = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    return pino(buildPinoOptions({ level: 'info', bootId: 'test-boot', mode: 'paper' }), dest);
  }

  it('counts through the real logger wiring and still writes the line', async () => {
    const lines: string[] = [];
    const logger = loggerWritingTo(lines);

    logger.error({ venue: 'binance' }, 'reconcile sweep failed');
    logger.info('a routine line');

    expect(await counterValue('error', 'reconcile_sweep_failed')).toBe(1);
    expect(lines.join('')).toContain('reconcile sweep failed');
    expect(lines.join('')).toContain('a routine line');
  });

  // The hook must not disturb the redaction the same options carry — both live on the instance now
  // that pino-http is handed a constructed logger rather than loose options.
  it('leaves redaction intact', async () => {
    const lines: string[] = [];
    const logger = loggerWritingTo(lines);

    logger.warn({ exchange: { apiKey: 'super-secret-key' } }, 'venue auth rejected');

    const output = lines.join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('super-secret-key');
    expect(await counterValue('warn', 'venue_auth_rejected')).toBe(1);
  });
});
