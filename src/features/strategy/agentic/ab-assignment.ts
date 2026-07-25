// Push 3 P1: keyed-PRF arm assignment. The prior scheme derived every A/B arm from the SAME
// `floor(Date.now() / 60_000)` minute counter with a per-arm additive offset (+37, +73, ...) before
// the modulo. That is a phase shift of one shared signal, not independent randomness — two arms
// built that way are mathematically dependent, so factorial cells (e.g. arm-A-control combined with
// arm-B-treatment) are not guaranteed to ever co-occur. abArm instead hashes `${salt}:${minute}`
// through an independent keyed PRF (FNV-1a) per arm: each salt yields an unrelated pseudo-random
// stream, so any combination of arms across the whole minute domain can populate. Changing an arm's
// salt re-randomizes THAT arm's assignment only, with no effect on any other arm and no effect on
// attribution — rows are tagged truthfully per-row via promptHash regardless of which minutes ended
// up on which side of an arm.
export function abArm(minute: number, salt: string, pct: number): boolean {
  if (pct <= 0) return false;
  const bytes = new TextEncoder().encode(`${salt}:${minute}`);
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < pct;
}
