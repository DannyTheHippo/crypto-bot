// Tracked pin for the FLAT-corpus manifest hash, checked in because both
// test/eval/agentic/data/*.jsonl and research/candidates/** are gitignored (.gitignore:44,52) — the
// corpus itself cannot survive a clean clone, but the fact of what it should hash to must.
//
// See research/studies/corpus-fingerprint-drift-correction-2026-08-03.md for why this is a SINGLE
// entry, not the two-tier canonical/legacy split an earlier pass of this file briefly carried.
// research/studies/corpus-fingerprint-drift-2026-07-31.md concluded the on-disk corpus had drifted
// from every published artifact via row order. That conclusion was wrong: `corpusManifest`'s
// separator (playbook-space-replay.ts) is a genuine NUL byte, not the ASCII space it renders as in an
// editor, and the drift study's own reimplementation typed a literal space instead of copying the
// real byte — producing a value (`030367ba…`) the real code never emits. Hashing the real,
// unmodified corpus through the REAL `corpusManifest` reproduces THIS file's pin exactly, and always
// has: the ten frozen research/candidates/ artifacts (e.g. playbook-space-design.json) match it
// directly. There was no drift, and there never was.

export interface CorpusPinEntry {
  readonly sha256: string;
  readonly reproducible: boolean;
  readonly status: string;
  readonly note: string;
}

/**
 * The FLAT corpus's manifest hash, produced by the imported `corpusManifest` over the imported
 * `loadCorpus`'s output — never by a local reimplementation (see the correction record's
 * transferable lesson). Reproducible today, and matches every one of the ten frozen
 * research/candidates/ artifacts, because there was never a mismatch to fix: 386 rows, 26 symbols,
 * firstEventTime=1784646000000, lastEventTime=1785180600000.
 *
 * `loadCorpus`'s (eventTime ASC, id ASC numeric) tie-break is a FORWARD guard, not a fix applied
 * here: the corpus has 81 event_time tie groups covering 305 of 386 rows, so a future re-dump in a
 * different row order remains a real combinatorial risk (~10^117 orderings consistent with
 * `ORDER BY event_time` alone) even though today's on-disk order already happens to match it.
 */
export const CANONICAL_CORPUS_PIN: CorpusPinEntry = {
  sha256: 'f1dd13c695f8009ed64f0e0f0b1f0ed82327e0cabfd716a6674859092125d229',
  reproducible: true,
  status: 'CANONICAL',
  note:
    '386 rows, 26 symbols, firstEventTime=1784646000000, lastEventTime=1785180600000. Matches every ' +
    'recorded corpusSha256 under research/candidates/ directly — there is no legacy/canonical split.',
};
