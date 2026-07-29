import pino from 'pino';
import { currentCorrelationId } from '../../../shared/correlation/correlation';
import { recordLogEvent } from './log-event-metrics';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-mbx-apikey"]',
  // §10b arm-hardening: pino-http logs the full req.headers object on every request (see the
  // request-completed lines this mixin drives) — without this, the ArmingTransportGuard's
  // x-arming-token second factor would land in the request log in plaintext on every arm attempt.
  'req.headers["x-arming-token"]',
  '*.apiKey',
  '*.apiSecret',
  '*.secret',
  '*.password',
  '*.ARMING_SECRET',
  '*.armingSecret',
  '*.ARMING_TRANSPORT_TOKEN',
  '*.armingTransportToken',
  '*.SENTIMENT_FEED_API_KEY',
  '*.sentimentFeedApiKey',
] as const;

export interface PinoLoggerOptions {
  level: string;
  bootId: string;
  mode: string;
}

/**
 * The pino instance options, separated from the pino-http wrapper so they can be asserted and
 * exercised behaviourally in isolation (test/features/common/observability/logger-redact.spec.ts).
 */
export function buildPinoOptions(opts: PinoLoggerOptions): pino.LoggerOptions {
  return {
    level: opts.level,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
    base: {
      bootId: opts.bootId,
      mode: opts.mode,
    },
    // Correlation-ALS (P4): stamps the request-scoped correlation id (CorrelationMiddleware,
    // src/shared/correlation/) onto every line logged inside a request. Off-request lines (boot,
    // timers) return undefined, which pino's serializer simply omits.
    mixin: () => ({ correlationId: currentCorrelationId() }),
    hooks: {
      // Counts warn/error/fatal lines into app_log_events_total (log-event-metrics.ts) so the
      // between-pass error picture lives in the TSDB instead of a `docker logs` tail that a
      // container recreate erases. This is a pino hook, NOT pino-http's identically-named
      // `hooks.logMethod` — pino-http's only wraps its own request-completed line, which is why the
      // logger instance is constructed here and handed to pino-http rather than letting pino-http
      // build it from loose options.
      //
      // Failure direction: OPEN. recordLogEvent absorbs its own faults, and this hook always
      // forwards to `method` — a broken counter must never cost a log line.
      logMethod(args, method, level) {
        recordLogEvent(level, args);
        return method.apply(this, args);
      },
    },
  };
}

export function buildPinoHttpOptions(opts: PinoLoggerOptions) {
  return {
    pinoHttp: {
      logger: pino(buildPinoOptions(opts)),
    },
  };
}
