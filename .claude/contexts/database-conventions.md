# Database Conventions (crypto-bot)

Drizzle ORM on Postgres 16. There is no Mongoose layer in this project.

## Schema

- One Drizzle schema module: `src/database/schemas/trading/trading.schema.ts`, re-exported by the `index.ts` barrel (drizzle-load-bearing: `drizzle(pool, { schema })` needs the namespace object).
- Money columns use the `numericMoney` custom type (`custom-types.ts`) → `numeric(38, 18)`, mapped to `string` on both sides — never a JS number.
- `audit_log` and `order_events` are append-only (DB triggers, `drizzle/0001_v3_append_only_hardening.sql`); never UPDATE/DELETE them or relax the triggers.

## Repositories

```ts
@Injectable()
export class OrderRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase<typeof schema> | null) {}

  async insert(order: OrderInsert): Promise<void> {
    await requireDb(this.db).insert(schema.orders).values(order);
  }
}
```

- Bucketed under `src/database/repositories/{common,venue,trading,strategy}/`; suffix `*.repository.ts`; port adapters as `*.adapter.ts`; in-memory fakes as `in-memory-*.ts`.
- `db` is nullable (persistence may be unconfigured); every access goes through `requireDb()`, which throws `PersistenceNotConfiguredError`.
- Insert shapes are explicit `XxxInsert` interfaces with string money/qty fields plus `mode: 'paper' | 'testnet' | 'live'`, `runId`, and `bootId` provenance.
- Multi-statement writes use `db.transaction()`; persist intent before any network call (root `CLAUDE.md` rule 5).

## Migrations

- `drizzle.config.ts`: dialect `postgresql`, `out: ./drizzle`, `DATABASE_URL` env with a local-compose default.
- Generate with `drizzle-kit generate`; apply with `pnpm migrate` (`drizzle-kit migrate`). CI runs `pnpm exec drizzle-kit check` before build — run it after any schema change.
- `drizzle/` mixes generated names (`0003_famous_newton_destine.sql`) with hand-named hardening migrations (`0001_v3_append_only_hardening.sql`) that carry trigger and constraint SQL drizzle-kit does not generate.

## Tests

- `pnpm test:db` runs `test/db` against a `_test`-suffixed database only (`assertDestructiveTargetIsTestDb` guard). Schemas and repositories are excluded from unit coverage and covered there.
