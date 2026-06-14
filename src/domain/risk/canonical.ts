import Decimal from 'decimal.js';
import type { OrderIntent } from '../types/order-intent';

// Canonical JSON for hashing a risk-approval payload. The mint side and the verify
// side (Execution) MUST produce byte-identical strings for identical intents, so:
//   - Decimals serialize via toFixed() — full precision, never exponent notation
//     (the §4.2 canonicalization pitfall: "1e-7" vs "0.0000001" would diverge).
//   - bigints serialize as base-10 strings (JSON has no bigint).
//   - object keys are sorted; arrays preserve order.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Decimal) return v.toFixed();
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(canonicalize);
  if (typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return v; // string | number | boolean
}

// The exact payload hashed for an approval. Includes every field that defines the
// order's risk-relevant identity, so any post-approval mutation fails verification.
export function intentCanonical(intent: OrderIntent): string {
  return canonicalJson(intent);
}
