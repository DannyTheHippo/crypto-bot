// UUIDv7 generator built from hex strings + Uint8Array bytes only — no Number()/parseInt
// (banned on money paths by lint). `unixMs` and `rand` (≥10 bytes) are injected so the
// sizer is deterministic under test; production supplies clock + crypto.randomBytes.
export function uuidv7(unixMs: number, rand: Uint8Array): string {
  if (rand.length < 10) throw new Error('uuidv7 requires at least 10 random bytes');
  const tsHex = unixMs.toString(16).padStart(12, '0').slice(-12); // 48-bit timestamp
  const r = Array.from(rand.subarray(0, 10), (b) => b.toString(16).padStart(2, '0')).join(''); // 20 hex
  const variant = '89ab'[rand[0]! % 4]; // variant nibble ∈ [89ab] without parsing
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7${r.slice(0, 3)}-${variant}${r.slice(3, 6)}-${r.slice(6, 18)}`;
}
