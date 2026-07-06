import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Template convention (P4 residue): request-scoped correlation id carried on AsyncLocalStorage and
// folded into every pino line via the logger mixin (logger.config.ts) — NOT a request-scoped Nest
// provider, so the singleton services this bot is built from stay singletons. The HTTP surface is
// tiny (health + arming), but an armed-session investigation needs its request's log lines
// stitchable across the mode-control/audit call chain.

export const CORRELATION_HEADER = 'x-correlation-id';

export interface CorrelationContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

// Runs fn inside a correlation scope, minting an id when the caller supplied none (or a blank).
export function runWithCorrelation<T>(id: string | undefined, fn: () => T): T {
  const correlationId = id !== undefined && id.trim().length > 0 ? id : randomUUID();
  return storage.run({ correlationId }, fn);
}
