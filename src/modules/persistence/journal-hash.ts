import * as crypto from 'crypto';

export const AUDIT_INITIAL_PREV_HASH = '0'.repeat(64);

/**
 * Canonical form of a journal payload for hashing.
 *
 * Recursively sorts object keys so that {a:1,b:2} and {b:2,a:1} produce identical
 * text. Arrays preserve insertion order (a sort here would be semantically wrong).
 * Numbers and other scalars pass through unchanged.
 *
 * IMPORTANT: money values in payloads MUST be carried as strings, not JS numbers,
 * so that the serialization is lossless and round-trippable from the stored TEXT column.
 */
export function canonicalPayload(payload: unknown): string {
  return JSON.stringify(sortedKeys(payload));
}

function sortedKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = sortedKeys(obj[k]);
  }
  return sorted;
}

/**
 * Computes the SHA-256 hash for one audit_log row:
 *   hash = sha256( canonicalPayload(payload) || prevHash )
 */
export function computeAuditHash(payload: unknown, prevHash: string): string {
  return crypto
    .createHash('sha256')
    .update(canonicalPayload(payload) + prevHash)
    .digest('hex');
}
