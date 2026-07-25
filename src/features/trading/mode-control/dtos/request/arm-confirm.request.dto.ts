import { IsString, MinLength } from 'class-validator';

// Wire contract mirrors ArmRequest's CONFIRM step (ports/trading/mode-control.ts). Fields are hydrated by
// the global ValidationPipe (never constructed in code) — hence the definite-assignment markers.
export class ArmConfirmRequestDto {
  @IsString()
  @MinLength(1)
  challengeId!: string;

  @IsString()
  @MinLength(1)
  hmacHex!: string;

  @IsString()
  @MinLength(1)
  bootId!: string;
}
