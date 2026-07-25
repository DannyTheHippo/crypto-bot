import { NodePgDatabase } from 'drizzle-orm/node-postgres';

export class PersistenceNotConfiguredError extends Error {
  constructor() {
    super('Database not configured: DATABASE_URL is absent. Cannot use persistence layer.');
    this.name = 'PersistenceNotConfiguredError';
  }
}

// Asserts db is non-null and returns it, throwing PersistenceNotConfiguredError otherwise.
export function requireDb<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema> | null,
): NodePgDatabase<TSchema> {
  if (db === null) throw new PersistenceNotConfiguredError();
  return db;
}
