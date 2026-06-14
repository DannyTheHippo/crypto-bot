// mulberry32: a fast, deterministic 32-bit PRNG.
// Produces values in [0, 1) with identical output for identical seeds.
// Used by MarketView.random() so strategies are fully deterministic under replay.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    z = (z ^ (z >>> 14)) >>> 0;
    return z / 0x100000000;
  };
}
