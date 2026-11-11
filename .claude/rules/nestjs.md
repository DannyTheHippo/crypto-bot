---
paths:
  - "**/*.module.ts"
  - "**/*.controller.ts"
  - "**/*.service.ts"
  - "**/*.guard.ts"
  - "**/*.middleware.ts"
  - "**/*.interceptor.ts"
  - "**/*.pipe.ts"
  - "**/*.filter.ts"
  - "**/*.dto.ts"
  - "**/*.exception.ts"
  - "**/*.validator.ts"
  - "**/*.api-examples.ts"
---

Applies to NestJS sources under `src/features/**`, `src/database/**`, `src/config/**`, and `src/app.module.ts`. Adapted from the `nest` stack template to this repo's observed conventions (Vitest, Drizzle, hexagonal ports); the template's Mongoose-specific rules do not apply here.

Before coding a module/controller/service, read 2–3 existing files in the same feature bucket to extract: DI token resolution, logger usage, error style, DTO validation, decorator argument shape. Match these exactly. Root `CLAUDE.md` hard rules and `.claude/CLAUDE.md` take precedence over anything here.

# NestJS Backend Patterns

## Placement

- Nest leaves (`*.module.ts`, `*.controller.ts`, `*.service.ts`, guards, DTOs) live under `src/features/{common,venue,trading,strategy}/<feature>/` only — never under `src/domain/` or `src/ports/` (eslint-plugin-boundaries enforces the walls).
- Cross-feature wiring belongs in the composition root: `src/features/trading/composition/*.module.ts` or `src/app.module.ts`.

## Services and DI

- **MUST** use constructor injection with `private readonly` parameters.
- **MUST** resolve ports through their `Symbol` tokens — `@Inject(MODE_CONTROL) private readonly service: ModeControlPort`. Tokens and interfaces are exported from `src/ports/**`; feature modules bind implementations in `providers`.
- Repositories inject the database handle as `@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase<typeof schema> | null` (from `DatabaseModule`) and wrap every access in `requireDb(this.db)`.
- Configuration comes from `TypedConfigService` (`src/config/environment/`), validated by zod in `environment.config.ts`. **FORBIDDEN** to read `process.env` in features or to hardcode secrets.
- Logging: match the existing logger pattern in the feature bucket; the pino redact list is mandatory for new loggers (root `CLAUDE.md` rule 7).

## Controllers

- Thin HTTP delegation only: a handler calls one port method and returns its result. Keep controllers branch-free — `mode-control/**` carries a 100% coverage gate.
- Versioning is class-level: `@Controller({ path: 'mode', version: '1' })` surfaces under `/api/v1/...`; health and metrics stay unversioned (see `src/config/app.config.ts`).
- **MUST** attach `@ApiResponse(...)` per handler using the feature's `api-examples/<feature>.api-examples.ts` (`Record<string, ApiResponseOptions>` exports).
- Guards are feature-local `*.guard.ts` classes applied with `@UseGuards(...)` per handler; emergency paths (disarm) stay unguarded by design.

## DTOs

- File suffixes are `*.request.dto.ts` under `dtos/request/` and `*.response.dto.ts` under `dtos/response/`; the `@nestjs/swagger` CLI plugin in `nest-cli.json` keys on these suffixes and infers `@ApiProperty` from types and comments — add it explicitly only for `example`/`description` overrides.
- `class-validator` decorators on every field; `!:` definite assignment for required fields.
- Money and quantity fields cross the wire as exact decimal strings, never numbers (root `CLAUDE.md` rule 1).

## Error Handling

- Prefer returning discriminated-union results from ports (as `ArmResult` does: success carries `challengeId`, failure carries `reason`) over throwing. Where an `HttpException` is needed (guards, validation), match the feature's existing pattern.
- Venue and DB errors go through the existing classifiers; unmapped errors are `OUTCOME_AMBIGUOUS` and never retried blind (root `CLAUDE.md` rule 5).

## Tests

- Specs live in the mirrored `test/` tree (`test/features/<bucket>/<feature>/*.spec.ts`), never colocated. Vitest with `globals: false` — import `{ describe, it, expect, vi }` explicitly. Details: `.claude/CLAUDE.md` § Testing.
