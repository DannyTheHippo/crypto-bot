---
paths:
  - "**/schemas/**/*.ts"
  - "**/schema/**/*.ts"
  - "**/migrations/**"
  - "drizzle/**"
  - "drizzle.config.ts"
---

# Drizzle & Postgres Conventions

- **MUST** define tables in a dedicated `schema/` module using `pgTable()`; one file per table or a cohesive domain grouping — match the project's existing split.
- **MUST** check for existing shared column helpers (e.g. `timestamps()`, `id()`) before adding new column definitions.
- **MUST** generate migrations via `drizzle-kit generate` — **FORBIDDEN** to hand-write SQL migration files unless the project's existing migrations are hand-written.
- **MUST** check existing migration files under the configured migrations dir for the naming/numbering convention before generating a new one.
- **MUST** apply migrations via the project's configured runner (`drizzle-kit migrate` or an npm/pnpm script) — **FORBIDDEN** to apply schema changes directly against a live database.
- **MUST** wrap multi-statement writes in `db.transaction()`; pass the transaction handle to every query inside it.
- **MUST** use the project's shared `pg` `Pool`/connection instance — **FORBIDDEN** to open a new pool per module.
- **MUST** run tests against a dockerized Postgres instance (the project's `docker-compose` test service) — **FORBIDDEN** to run tests against a shared or production database.
- **MUST** use configuration via `@nestjs/config` + `.env` for connection strings. **FORBIDDEN** to hardcode secrets.
- **FORBIDDEN** to weaken a column's `notNull()`/type constraint to fix a failing test — fix the test data instead.
