import { Controller, Post, Body, Inject } from '@nestjs/common';
import { MODE_CONTROL, type ModeControlPort } from '../../ports/mode-control';

// Thin HTTP delegation only. Localhost-bind + token-auth middleware and the CLI wrapper
// are deferred to Phase 8d runtime glue; this layer stays branch-free for 100% coverage.
@Controller('mode')
export class ArmingController {
  constructor(@Inject(MODE_CONTROL) private readonly service: ModeControlPort) {}

  @Post('arm/request')
  request(@Body() b: { bootId: string }) {
    return this.service.armLive({ step: 'REQUEST', bootId: b.bootId });
  }

  @Post('arm/confirm')
  confirm(@Body() b: { challengeId: string; hmacHex: string; bootId: string }) {
    return this.service.armLive({ step: 'CONFIRM', challengeId: b.challengeId, hmacHex: b.hmacHex, bootId: b.bootId });
  }

  @Post('disarm')
  disarm() {
    this.service.disarm('MANUAL');
  }
}
