// Specs for the corpus tie-break GUARD (test/eval/agentic/playbook-space-replay.ts, loadCorpus /
// corpusManifest / assertDesignMatchesCorpus) and the tracked pin it supports (corpus-pin.ts). Five
// things this gate proves — the fifth is the actual lesson of
// research/studies/corpus-fingerprint-drift-correction-2026-08-03.md:
//
//   1. ORDER INVARIANCE — a corpus with a real tie group hashes identically regardless of the input
//      line order. This is the test that would have caught a REAL reordering, had one occurred.
//   2. NUMERIC, NOT LEXICAL — the id comparator sorts 2 < 10 < 100, and a lexically-sorted copy of
//      the same rows hashes differently, so the distinction is pinned, not asserted.
//   3. NO LEGACY ARM — `assertDesignMatchesCorpus` has exactly one failure message for a mismatch;
//      there is no second, "known-legacy" hash to route to (there never was one).
//   4. CLEAN-CLONE SAFETY — the file-level pin check SKIPS, never fails, when the gitignored corpus is
//      absent, so a fresh clone stays green.
//   5. IMPORTED, NOT REIMPLEMENTED — the pin is asserted against the IMPORTED `corpusManifest` over
//      the IMPORTED `loadCorpus`, never a local reimplementation, and a small worked fixture makes the
//      NUL-byte separator itself falsifiable rather than incidental. A local reimplementation
//      diverging from the real separator by exactly one byte is what produced the false
//      "030367ba…" drift finding this file corrects — see the correction record.

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDesignMatchesCorpus,
  corpusManifest,
  loadCorpus,
  type StudyDesign,
} from './playbook-space-replay';
import { CANONICAL_CORPUS_PIN } from './corpus-pin';

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'corpus-pin-'));

interface RawRow {
  readonly id: number;
  readonly symbol: string;
  readonly event_time: number;
  readonly action: string;
  readonly input_payload: string;
}

const writeJsonl = (rows: readonly RawRow[]): string => {
  const file = join(tmpDir(), 'corpus.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
};

// Deterministic seeded shuffle (Fisher-Yates over a small LCG) — no dependency on the production
// PRNG in playbook-space-replay.ts, which is intentionally unexported.
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('corpus tie-break — order invariance', () => {
  it('a 10-member event_time tie group hashes identically after a seeded shuffle', () => {
    const tieGroup: RawRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      symbol: 'BTC/USDT',
      event_time: 5_000, // every row shares this instant — a tie group at realistic scale
      action: 'hold',
      input_payload: `payload-${i + 1}`,
    }));

    const inOrderFile = writeJsonl(tieGroup);
    const shuffledFile = writeJsonl(seededShuffle(tieGroup, 42));

    const inOrderManifest = corpusManifest(loadCorpus(inOrderFile));
    const shuffledManifest = corpusManifest(loadCorpus(shuffledFile));

    expect(shuffledManifest.payloadSha256).toBe(inOrderManifest.payloadSha256);
    // Sanity: the shuffle actually reordered the input, so this is not a trivially-true comparison.
    expect(seededShuffle(tieGroup, 42).map((r) => r.id)).not.toEqual(tieGroup.map((r) => r.id));
  });
});

describe('corpus tie-break — numeric, not lexical', () => {
  it('sorts ids 2, 10, 100 numerically, and the lexical order hashes differently', () => {
    // Deliberately out of both numeric and lexical order in the input file.
    const rows: RawRow[] = [
      { id: 100, symbol: 'ETH/USDT', event_time: 9_000, action: 'hold', input_payload: 'p-100' },
      { id: 2, symbol: 'ETH/USDT', event_time: 9_000, action: 'hold', input_payload: 'p-2' },
      { id: 10, symbol: 'ETH/USDT', event_time: 9_000, action: 'hold', input_payload: 'p-10' },
    ];
    const loaded = loadCorpus(writeJsonl(rows));

    // The tie-break comparator sorted these numerically, not as strings.
    expect(loaded.map((r) => r.id)).toEqual(['2', '10', '100']);

    const numericManifest = corpusManifest(loaded);

    // The lexical ordering ('10', '100', '2') is what a naive string sort would produce — assert it
    // hashes to something ELSE, so "numeric, not lexical" is a pinned fact and not just a comment.
    const lexicalOrder = loaded
      .filter((r) => r.id === '10')
      .concat(loaded.filter((r) => r.id === '100'))
      .concat(loaded.filter((r) => r.id === '2'));
    const lexicalManifest = corpusManifest(lexicalOrder);

    expect(lexicalManifest.payloadSha256).not.toBe(numericManifest.payloadSha256);
  });

  it('fails CLOSED on a non-numeric id rather than silently falling back to string order', () => {
    const rows: RawRow[] = [
      // event_time ties force the comparator to actually consult id.
      {
        id: 'abc' as unknown as number,
        symbol: 'ETH/USDT',
        event_time: 1,
        action: 'hold',
        input_payload: 'a',
      },
      { id: 1, symbol: 'ETH/USDT', event_time: 1, action: 'hold', input_payload: 'b' },
    ];
    expect(() => loadCorpus(writeJsonl(rows))).toThrow(/non-numeric row id/);
  });
});

describe('corpus tie-break — assertDesignMatchesCorpus has no legacy arm', () => {
  const baseDesign: Omit<StudyDesign, 'corpusSha256'> = {
    sharedEdgeArms: 1,
    leadModelOnlyEdgeArms: 1,
    edgeRows: 150,
    leverRows: 0,
    measured: {
      leadUsdPerCall: 0.01,
      followUsdPerCall: 0.01,
      leadEdgeBudgetUsd: 10,
      followBudgetUsd: 10,
      leverTierUsd: 0,
    },
  };

  it('does not throw when the design matches the corpus in front of it', () => {
    const matchingDesign: StudyDesign = {
      ...baseDesign,
      corpusSha256: CANONICAL_CORPUS_PIN.sha256,
    };
    expect(() =>
      assertDesignMatchesCorpus(matchingDesign, CANONICAL_CORPUS_PIN.sha256),
    ).not.toThrow();
  });

  it('throws the one generic mismatch message for ANY wrong hash — there is no second arm', () => {
    const wrongDesign: StudyDesign = { ...baseDesign, corpusSha256: 'some-other-corpus-hash' };
    expect(() => assertDesignMatchesCorpus(wrongDesign, CANONICAL_CORPUS_PIN.sha256)).toThrow(
      /does not transfer/,
    );
  });
});

describe('corpus tie-break — clean-clone safety', () => {
  // The gitignored corpus (test/eval/agentic/data/*.jsonl) is absent on a fresh clone. A check that
  // fails in that state is a broken gate, not a strict one — it must SKIP, not fail.
  const CORPUS_PRESENT = existsSync(
    join(process.cwd(), 'test/eval/agentic/data/corpus-v3-flat.jsonl'),
  );

  it.runIf(CORPUS_PRESENT)('the on-disk corpus reproduces the canonical pin', () => {
    // There is no drift, and there never was (corpus-fingerprint-drift-correction-2026-08-03.md): the
    // real corpus, hashed by the real corpusManifest, has always reproduced this value — it is what
    // every one of the ten frozen research/candidates/ artifacts already recorded.
    const manifest = corpusManifest(loadCorpus());
    expect(manifest.payloadSha256).toBe(CANONICAL_CORPUS_PIN.sha256);
  });

  it.skipIf(CORPUS_PRESENT)('skips instead of failing when the gitignored corpus is absent', () => {
    // Only reachable on a machine without the corpus dump — asserts the skip condition itself is
    // sound rather than an inverted no-op.
    expect(CORPUS_PRESENT).toBe(false);
  });
});

describe('corpus tie-break — the pin comes from imported code, not a reimplementation', () => {
  it('a two-row fixture pins the manifest hash AND falsifies the NUL-byte separator', () => {
    const rows: RawRow[] = [
      { id: 1, symbol: 'BTC/USDT', event_time: 1_000, action: 'hold', input_payload: 'alpha' },
      { id: 2, symbol: 'BTC/USDT', event_time: 2_000, action: 'hold', input_payload: 'beta' },
    ];
    const loaded = loadCorpus(writeJsonl(rows));

    // Golden value: sha256('1' + '\0' + 'alpha' + '\0' + '2' + '\0' + 'beta' + '\0'), computed once
    // from the imported `corpusManifest` and pinned here as a literal. This is the ONLY place in this
    // file a hash value is hand-computed rather than read off the import — every other spec compares
    // two calls to the same imported functions against each other, never against a reimplementation.
    // corpus-fingerprint-drift-2026-07-31.md's central mistake was exactly a reimplementation
    // diverging from the real separator by one byte, so a spec that trusted a reimplementation here
    // would be the same defect in miniature.
    const EXPECTED_NUL_SEP_SHA256 =
      'bc84300291242e1cb349a05c16db5f5243172dc417883ebc2a8a8fc0ac89141d';
    expect(corpusManifest(loaded).payloadSha256).toBe(EXPECTED_NUL_SEP_SHA256);

    // Falsifies the separator byte: a SPACE-separated hash of the identical rows must NOT match. If
    // it did, this spec would not be distinguishing anything about the separator at all.
    const spaceSepHash = createHash('sha256');
    for (const r of loaded)
      spaceSepHash.update(r.id).update(' ').update(r.inputPayload).update(' ');
    expect(spaceSepHash.digest('hex')).not.toBe(EXPECTED_NUL_SEP_SHA256);
  });
});
