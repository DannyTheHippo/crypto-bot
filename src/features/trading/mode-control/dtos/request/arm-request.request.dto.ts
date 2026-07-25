import { IsString, MinLength } from 'class-validator';

// Wire contract mirrors ArmRequest's REQUEST step (ports/trading/mode-control.ts) — bootId is the operator's
// (advisory) assertion of which instance they target; the service binds against its OWN cfg.bootId
// regardless (see mode-control.service.ts's armLive header comment).
export class ArmRequestRequestDto {
  @IsString()
  @MinLength(1)
  bootId!: string;
}
