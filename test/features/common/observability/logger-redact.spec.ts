import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import pino from 'pino';
import {
  REDACT_PATHS,
  buildPinoHttpOptions,
  buildPinoOptions,
} from '../../../../src/features/common/observability/logger.config';

// Redaction moved onto the pino instance when the logger started being constructed here and handed
// to pino-http (needed so the app_log_events_total logMethod hook sees EVERY line, not just
// pino-http's own request-completed line). buildPinoOptions is that instance's options.
function redactionOf(opts: ReturnType<typeof buildPinoOptions>) {
  const redact = opts.redact;
  if (redact === undefined || typeof redact !== 'object' || Array.isArray(redact)) {
    throw new Error('expected a redact object on the pino options');
  }
  return redact;
}

describe('Logger pino config redact paths', () => {
  it('includes all required redact paths', () => {
    const opts = buildPinoOptions({ level: 'info', bootId: 'test-boot', mode: 'paper' });
    const redactPaths = redactionOf(opts).paths;

    for (const required of REDACT_PATHS) {
      expect(redactPaths).toContain(required);
    }
  });

  it('uses [REDACTED] censor value', () => {
    const opts = buildPinoOptions({ level: 'info', bootId: 'test-boot', mode: 'paper' });
    expect(redactionOf(opts).censor).toBe('[REDACTED]');
  });

  // The wrapper still has to hand pino-http a real logger, or nestjs-pino silently builds its own
  // (unredacted, unhooked) one.
  it('hands pino-http a constructed logger instance', () => {
    const config = buildPinoHttpOptions({ level: 'info', bootId: 'test-boot', mode: 'paper' });
    expect(typeof config.pinoHttp.logger.error).toBe('function');
    expect(config.pinoHttp.logger.level).toBe('info');
  });

  it('behaviorally redacts apiKey and headers from logged objects', () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });

    const logger = pino(
      {
        level: 'info',
        redact: {
          paths: [...REDACT_PATHS],
          censor: '[REDACTED]',
        },
      },
      dest,
    );

    logger.info({
      exchange: {
        apiKey: 'super-secret-key',
        apiSecret: 'super-secret-secret',
      },
    });

    const output = lines.join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('super-secret-key');
    expect(output).not.toContain('super-secret-secret');
  });

  // §10b arm-hardening regression: pino-http serializes the full req.headers object on every
  // request-completed line (CorrelationMiddleware's own request, exercised in
  // app-module.boot.spec.ts) — without this path the ArmingTransportGuard's x-arming-token header
  // would appear in plaintext in every arm/request + arm/confirm log line.
  it('behaviorally redacts the x-arming-token request header', () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });

    const logger = pino(
      {
        level: 'info',
        redact: {
          paths: [...REDACT_PATHS],
          censor: '[REDACTED]',
        },
      },
      dest,
    );

    logger.info({
      req: { headers: { 'x-arming-token': 'super-secret-transport-token' } },
    });

    const output = lines.join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('super-secret-transport-token');
  });
});
