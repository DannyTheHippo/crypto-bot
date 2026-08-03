# Corpus fingerprint drift — correction (2026-08-03)

**This corrects `research/studies/corpus-fingerprint-drift-2026-07-31.md`. That file is not edited —
house practice on this program appends dated corrections and never rewrites a prior record (no other
study under `research/studies/` carries a retroactive pointer either; `deployment-bar-halves-clause-2026-07-31.md`
§ 7.3 is resolved by the very study this file corrects, and it was not touched to add one). The
correction lives here.**

## 1. What the original study concluded

`corpus-fingerprint-drift-2026-07-31.md` found that the on-disk FLAT corpus hashes to
`030367bad28fb4198ce27f6e6b0dc8c39e33b26cd6b489a3ead3238d28d417ff` while every one of ten frozen
`research/candidates/` artifacts records `f1dd13c695f8009ed64f0e0f0b1f0ed82327e0cabfd716a6674859092125d229`.
It attributed the mismatch to **row order**: 81 `event_time` tie groups cover 305 of 386 rows, so
~10^117 orderings are all consistent with `ORDER BY event_time` alone, and it concluded the byte
order that produced the artifacts' hash is unrecoverable. That conclusion drove a real code change
(a follow-on pass added an `(eventTime ASC, id ASC numeric)` tie-break to `loadCorpus`) and a
two-tier `corpus-pin.ts` (a "canonical, reproducible" pin at `030367ba…` and a "citable, not
reproducible" legacy pin at `f1dd13c6…`).

## 2. What is actually true

**There is no drift, and there never was.** `corpusManifest`'s separator literal
(`test/eval/agentic/playbook-space-replay.ts`, `corpusManifest`) is a genuine **NUL byte** (`'\0'`),
not the ASCII space it renders as in an editor or a `cat -n`-style file viewer — the two characters
are visually indistinguishable in most terminal fonts. `corpus-fingerprint-drift-2026-07-31.md`'s own
reimplementation of the manifest hash (§ 2.1, "Reimplementing `corpusManifest`... against the actual
file") typed a literal space instead of copying the real byte, and that one-byte divergence is the
entire cause of the apparent mismatch. Hashing the real, unmodified 386-row corpus through the REAL,
imported `corpusManifest` reproduces `f1dd13c6…` exactly — the value every artifact already recorded.

Confirmed two ways, independently:

- By the implementer, via a byte scan of the working tree AND of `git show HEAD:test/eval/agentic/playbook-space-replay.ts`
  (the pre-this-pass version), both showing the identical two NUL bytes at the `corpusManifest`
  separator positions. `git show 83578d8` — the single commit `corpus-fingerprint-drift-2026-07-31.md`
  itself cites as `corpusManifest`'s sole edit (2026-07-27) — already contains the NUL byte, so this
  predates every pass on this file, including the original drift study.
- By the coordinator, independently, computing all four hashes below directly from the raw 386-row
  JSONL without going through any of the implementer's code.

## 3. The four measured hashes

| computation | sha256 |
| --- | --- |
| file order, NUL separator (the real `corpusManifest`) | `f1dd13c695f8009ed64f0e0f0b1f0ed82327e0cabfd716a6674859092125d229` |
| file order, SPACE separator (the drift study's reimplementation) | `030367bad28fb4198ce27f6e6b0dc8c39e33b26cd6b489a3ead3238d28d417ff` |
| sorted `(eventTime ASC, id ASC numeric)`, NUL separator | `f1dd13c695f8009ed64f0e0f0b1f0ed82327e0cabfd716a6674859092125d229` |
| recorded design pin (`research/candidates/playbook-space-design.json`) | `f1dd13c695f8009ed64f0e0f0b1f0ed82327e0cabfd716a6674859092125d229` |

Row 1 and row 4 match exactly: the corpus, in its own on-disk order, hashed with its own real
separator, already equals what every artifact recorded. Row 3 equals row 1: the
`(eventTime ASC, id ASC numeric)` tie-break sort is confirmed a genuine **no-op** on the current
file's row order — the corpus already happens to be in that order — independent of which separator is
used, since this is an array-identity fact, not a hash-dependent one.

## 4. The rest of the original study's reordering table is the same artifact

`corpus-fingerprint-drift-2026-07-31.md` § 2.6 tried eleven further reorderings and six alternative
hash recipes, reporting that none reproduced `f1dd13c6…`. Every one of those eleven reorderings was
also hashed with the space-separator reimplementation, so their reported values —
including `(event_time, id) lexical id` → `6b3c3af5…` and `id lexical asc` → `3d3768b8…` — are
likewise space-separator artifacts, not orderings of the real hash. None of them should be read as a
measurement of what any real ordering produces; they measure what the reimplementation produces,
which is a different function.

## 5. The transferable lesson

**A reimplementation of a hash function is a second source of truth; import it or do not compute it.**
The entire finding was one byte: a study that needed to check "does the corpus reproduce the recorded
hash" retyped the hashing logic instead of calling the exported `corpusManifest` over the exported
`loadCorpus`, and the retyped version silently diverged from the original on a character that looks
identical on screen. The fix applied in `test/eval/agentic/corpus-pin.spec.ts` is exactly this:
every assertion in that file compares two calls to the SAME imported functions against each other or
against a value read off an import, except one deliberately-marked exception (a two-row fixture
pinning that the separator is specifically a NUL byte), which exists precisely to make that byte
falsifiable rather than incidental.

## 6. What did and did not change in code as a result

- **`corpusManifest`'s NUL-byte separator is UNCHANGED, on purpose.** NUL is the correct choice
  specifically because it cannot occur inside the JSON payload text a corpus row carries, so it is an
  unambiguous field boundary where a space is not. Changing it to a printable character would
  invalidate all ten frozen artifacts to replace a correct design with a worse one.
- **`corpus-pin.ts` now carries a single entry**, `CANONICAL_CORPUS_PIN.sha256 = f1dd13c6…`, not the
  two-tier canonical/legacy split this program briefly carried. There is no legacy hash to distinguish
  from a canonical one.
- **`assertDesignMatchesCorpus` no longer has a legacy arm.** A mismatch always throws the one
  generic "does not transfer" message; there was never a second, known-cause hash to route to.
- **`loadCorpus`'s `(eventTime ASC, id ASC numeric)` tie-break is KEPT**, reframed honestly as a
  forward guard against a FUTURE re-dump landing in a different row order — a real risk given 81 tie
  groups covering 305 of 386 rows — not as a fix for a drift that occurred. It fails CLOSED on a
  non-numeric id for the same reason: an undefined sort order would reintroduce the very
  reproducibility risk the guard exists to close.
