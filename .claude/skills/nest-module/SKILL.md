---
name: nest-module
description: Scaffold a complete NestJS feature module following project conventions
user-invocable: true
argument-hint: <bucket>/<module-name>
context: fork
---

# NestJS Module Scaffolding

Scaffold a complete feature module for "$ARGUMENTS" (form: `<bucket>/<module-name>`, bucket one of `common`, `venue`, `trading`, `strategy`).

## Process

1. **Discover conventions**: Read `.claude/CLAUDE.md` and `.claude/project-discovery.json`, then read an existing feature module in the same bucket (for example `src/features/trading/mode-control/`) to extract:

   - Port tokens and interfaces the module binds (`src/ports/<bucket>/`)
   - Decorator usage (Swagger `@ApiResponse` + `api-examples/`, class-level versioning, guards)
   - Service initialization pattern (constructor injection, `@Inject(TOKEN)`, `TypedConfigService`)
   - Test mock patterns and setup in `test/features/<bucket>/`

2. **Generate structure** (Nest leaves live under `src/features/` only; specs live in the mirrored `test/` tree):

   ```text
   src/features/<bucket>/<module-name>/
   ├── <module-name>.module.ts
   ├── <module-name>.controller.ts        (only if the feature exposes HTTP)
   ├── <module-name>.service.ts
   ├── dtos/request/*.request.dto.ts
   ├── dtos/response/*.response.dto.ts
   └── api-examples/<module-name>.api-examples.ts
   test/features/<bucket>/<module-name>/
   ├── <module-name>.controller.spec.ts
   └── <module-name>.service.spec.ts
   ```

3. **Wire module**: Add to the parent module's `imports` array (feature module or the composition root under `src/features/trading/composition/`). Respect the eslint-plugin-boundaries walls — a feature imports only domain, ports, config, shared, and its own folder.

4. **Verify**: Run the full suite — `<scripts.format>`, `<scripts.lint>`, `<scripts.typecheck>`, `<scripts.test>` — all resolved from `project-discovery.json.scripts`. Chain into the `verification` gate before claiming done.

## Checklist

- Module registered in parent
- Controller has `@ApiResponse` + `api-examples` on every endpoint
- Service resolves ports via `@Inject(TOKEN)` with `private readonly`
- DTOs carry `class-validator` decorators (the swagger CLI plugin infers `@ApiProperty`)
- Money and quantity fields are exact decimal strings
- Spec files compile and pass under Vitest (`globals: false`, explicit imports)
