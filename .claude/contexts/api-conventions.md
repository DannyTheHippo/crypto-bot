# API Conventions (crypto-bot)

Observed from `src/features/trading/mode-control/` — read that feature before adding an endpoint.

## Controller pattern

```ts
@Controller({ path: 'mode', version: '1' }) // class-level versioning → /api/v1/mode/...
export class ArmingController {
  constructor(@Inject(MODE_CONTROL) private readonly service: ModeControlPort) {}

  @Post('arm/request')
  @UseGuards(ArmingTransportGuard)
  @ApiResponse(armRequestApiExamples.success)
  @ApiResponse(armRequestApiExamples.refused)
  request(@Body() b: ArmRequestRequestDto): ArmResult {
    return this.service.armLive({ step: 'REQUEST', bootId: b.bootId });
  }
}
```

- Controllers are thin, branch-free delegates to a port token (`@Inject(TOKEN)`), never to a concrete service class.
- Swagger examples live in `api-examples/<feature>.api-examples.ts`; `/health/live` and `/metrics` stay unversioned.
- Guards are feature-local (`*.guard.ts`); emergency paths (disarm) stay unguarded by design.

## DTO pattern

```ts
export class ArmRequestRequestDto {
  @IsString()
  @MinLength(1)
  bootId!: string;
}
```

- `dtos/request/*.request.dto.ts` and `dtos/response/*.response.dto.ts`; the swagger CLI plugin in `nest-cli.json` infers `@ApiProperty` from these suffixes and comments.
- Money values are exact decimal strings on the wire.
- Port result unions (`ArmResult`) are returned as-is when one response class cannot model both shapes.

## Module pattern

- Feature modules bind port tokens to implementations in `providers`; cross-cutting singletons (`RISK_SIGNING_KEY`, `KILL_SWITCH`) come from the composition root `src/features/trading/composition/`; `DRIZZLE_DB` comes from `DatabaseModule`.
- Feature specs live in `test/features/<bucket>/<feature>/` (Vitest, explicit imports, exact-string money assertions).
