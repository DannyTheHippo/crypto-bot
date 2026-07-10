import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { ArmResultResponseDto } from '../dtos/response/arm-result.response.dto';

// satisfies (not `: Record<...>`) keeps the narrower literal-key type so property access below
// stays ApiResponseOptions rather than ApiResponseOptions | undefined under noUncheckedIndexedAccess.
export const armRequestApiExamples = {
  success: {
    status: HttpStatus.CREATED,
    description: 'Arming challenge issued.',
    type: ArmResultResponseDto,
    examples: {
      example: {
        summary: 'Challenge issued',
        value: { ok: true, challengeId: '3f9d2e1a-6b4c-4e2a-9c1a-0f2e1d3c4b5a' },
      },
    },
  },
  refused: {
    status: HttpStatus.CREATED,
    description: 'Arm request refused (precondition not met).',
    type: ArmResultResponseDto,
    examples: {
      example: {
        summary: 'Preconditions not met',
        value: { ok: false, reason: 'PRECONDITION' },
      },
    },
  },
} satisfies Record<string, ApiResponseOptions>;

export const armConfirmApiExamples = {
  success: {
    status: HttpStatus.CREATED,
    description: 'Arming confirmed; mode transitions to ARMED.',
    type: ArmResultResponseDto,
    examples: {
      example: {
        summary: 'Armed',
        value: { ok: true },
      },
    },
  },
  refused: {
    status: HttpStatus.CREATED,
    description: 'Arm confirmation refused.',
    type: ArmResultResponseDto,
    examples: {
      example: {
        summary: 'HMAC mismatch',
        value: { ok: false, reason: 'HMAC_MISMATCH' },
      },
    },
  },
} satisfies Record<string, ApiResponseOptions>;

export const disarmApiExamples = {
  success: {
    status: HttpStatus.CREATED,
    description: 'Disarm recorded; mode reverts to the resolved effective mode.',
  },
} satisfies Record<string, ApiResponseOptions>;
