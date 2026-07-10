import { ApiProperty } from '@nestjs/swagger';
import type { ArmFailureReason } from '../../../../../ports/mode-control';

// Swagger wire-shape label only — the port's ArmResult stays a discriminated union at the
// controller boundary (see arming.controller.ts's header comment). ok=true responses may carry
// challengeId (REQUEST step); ok=false responses always carry reason.
export class ArmResultResponseDto {
  @ApiProperty({ example: true, description: 'Whether the arm step succeeded.' })
  ok!: boolean;

  @ApiProperty({
    example: '3f9d2e1a-6b4c-4e2a-9c1a-0f2e1d3c4b5a',
    description: 'Challenge id issued on a successful REQUEST step.',
    required: false,
  })
  challengeId?: string;

  @ApiProperty({
    example: 'HMAC_MISMATCH',
    enum: ['TTL_EXPIRED', 'REPLAY', 'HMAC_MISMATCH', 'PRECONDITION'],
    description: 'Failure reason, present when ok is false.',
    required: false,
  })
  reason?: ArmFailureReason;
}
