export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-mbx-apikey"]',
  '*.apiKey',
  '*.apiSecret',
  '*.secret',
  '*.password',
  '*.ARMING_SECRET',
  '*.armingSecret',
] as const;

export interface PinoLoggerOptions {
  level: string;
  bootId: string;
  mode: string;
}

export function buildPinoHttpOptions(opts: PinoLoggerOptions) {
  return {
    pinoHttp: {
      level: opts.level,
      redact: {
        paths: [...REDACT_PATHS],
        censor: '[REDACTED]',
      },
      base: {
        bootId: opts.bootId,
        mode: opts.mode,
      },
    },
  };
}
