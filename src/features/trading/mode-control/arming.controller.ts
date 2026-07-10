import { Controller, Post, Body, Inject } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { MODE_CONTROL, type ModeControlPort, type ArmResult } from '../../../ports/mode-control';
import { ArmRequestRequestDto } from './dtos/request/arm-request.request.dto';
import { ArmConfirmRequestDto } from './dtos/request/arm-confirm.request.dto';
import {
  armConfirmApiExamples,
  armRequestApiExamples,
  disarmApiExamples,
} from './api-examples/arming.api-examples';

// Thin HTTP delegation only. Localhost-bind + token-auth middleware and the CLI wrapper
// are deferred to Phase 8d runtime glue; this layer stays branch-free for 100% coverage. The return
// type stays the port's ArmResult union (see dtos/response/arm-result.response.dto.ts for the typed
// wire-contract label) rather than a class-transformer response DTO — the union's two shapes
// (success carries an optional challengeId, failure carries reason) cannot be modeled as one fixed
// class without losing or inventing fields.
// version: '1' moves this controller under the versioned+prefixed surface (/api/v1/mode/...) —
// see config/app.config.ts's header comment for why health/metrics stay unversioned instead.
// (Class-level versioning uses the @Controller options form; Nest types @Version as method-only.)
@Controller({ path: 'mode', version: '1' })
export class ArmingController {
  constructor(@Inject(MODE_CONTROL) private readonly service: ModeControlPort) {}

  @Post('arm/request')
  @ApiResponse(armRequestApiExamples.success)
  @ApiResponse(armRequestApiExamples.refused)
  request(@Body() b: ArmRequestRequestDto): ArmResult {
    return this.service.armLive({ step: 'REQUEST', bootId: b.bootId });
  }

  @Post('arm/confirm')
  @ApiResponse(armConfirmApiExamples.success)
  @ApiResponse(armConfirmApiExamples.refused)
  confirm(@Body() b: ArmConfirmRequestDto): ArmResult {
    return this.service.armLive({
      step: 'CONFIRM',
      challengeId: b.challengeId,
      hmacHex: b.hmacHex,
      bootId: b.bootId,
    });
  }

  @Post('disarm')
  @ApiResponse(disarmApiExamples.success)
  disarm(): void {
    this.service.disarm('MANUAL');
  }
}
