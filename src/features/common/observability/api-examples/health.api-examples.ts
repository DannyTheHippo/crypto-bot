import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

// satisfies (not `: Record<...>`) keeps the narrower literal-key type so `.ok` below stays
// ApiResponseOptions rather than ApiResponseOptions | undefined under noUncheckedIndexedAccess.
export const healthLiveApiExamples = {
  ok: {
    status: HttpStatus.OK,
    description: 'Process is alive.',
    examples: {
      example: {
        summary: 'Liveness check passing',
        value: { status: 'ok', info: {}, error: {}, details: {} },
      },
    },
  },
} satisfies Record<string, ApiResponseOptions>;

export const healthReadyApiExamples = {
  ok: {
    status: HttpStatus.OK,
    description:
      'Process is ready to serve traffic (event loop, config, and, when configured, DB).',
    examples: {
      example: {
        summary: 'Readiness check passing (paper mode, DB-less)',
        value: {
          status: 'ok',
          info: {
            event_loop_delay: { status: 'up' },
            config: { status: 'up', effectiveMode: 'paper', killSwitchState: 'RUNNING' },
          },
          error: {},
          details: {
            event_loop_delay: { status: 'up' },
            config: { status: 'up', effectiveMode: 'paper', killSwitchState: 'RUNNING' },
          },
        },
      },
    },
  },
} satisfies Record<string, ApiResponseOptions>;
