import { Controller, Post, Body, Inject, UseGuards } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { MODE_CONTROL, type ModeControlPort, type ArmResult } from '../../../ports/mode-control';
import { ArmRequestRequestDto } from './dtos/request/arm-request.request.dto';
import { ArmConfirmRequestDto } from './dtos/request/arm-confirm.request.dto';
import {
  armConfirmApiExamples,
  armRequestApiExamples,
  disarmApiExamples,
} from './api-examples/arming.api-examples';
import { ArmingTransportGuard } from './arming-transport.guard';

// Thin HTTP delegation only. Localhost-bind middleware and the CLI wrapper are deferred to Phase 8d
// runtime glue; this layer stays branch-free for 100% coverage. The transport-layer x-arming-token
// second factor (§10b) is enforced by ArmingTransportGuard on arm/request + arm/confirm ONLY — disarm
// stays UNGUARDED (emergency disarm must never be blocked by a missing/misconfigured token). The
// return type stays the port's ArmResult union (see dtos/response/arm-result.response.dto.ts for the
// typed wire-contract label) rather than a class-transformer response DTO — the union's two shapes
// (success carries an optional challengeId, failure carries reason) cannot be modeled as one fixed
// class without losing or inventing fields.
// version: '1' moves this controller under the versioned+prefixed surface (/api/v1/mode/...) —
// see config/app.config.ts's header comment for why health/metrics stay unversioned instead.
// (Class-level versioning uses the @Controller options form; Nest types @Version as method-only.)
@Controller({ path: 'mode', version: '1' })
export class ArmingController {
  constructor(@Inject(MODE_CONTROL) private readonly service: ModeControlPort) {}

  @Post('arm/request')
  @UseGuards(ArmingTransportGuard)
  @ApiResponse(armRequestApiExamples.success)
  @ApiResponse(armRequestApiExamples.refused)
  request(@Body() b: ArmRequestRequestDto): ArmResult {
    return this.service.armLive({ step: 'REQUEST', bootId: b.bootId });
  }

  @Post('arm/confirm')
  @UseGuards(ArmingTransportGuard)
  @ApiResponse(armConfirmApiExamples.success)
  @ApiResponse(armConfirmApiExamples.refused)
  async confirm(@Body() b: ArmConfirmRequestDto): Promise<ArmResult> {
    // v3 §7.2 gate (c): "at CONFIRM (fresh probe)" — re-probe both venues immediately before
    // resolving CONFIRM so a caller's next resolveMode() read reflects current key state, not a
    // stale periodic-refresh (60s) snapshot. Optional-chained: refreshKeyProbe is absent only on
    // non-real ModeControlPort fakes, which never route through this controller.
    await this.service.refreshKeyProbe?.();
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
