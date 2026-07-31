# Corpus fingerprint drift — cause narrowed, not closed (2026-07-31)

**This is an investigation report, not a pre-registration.** It resolves what
`deployment-bar-halves-clause-2026-07-31.md` § 7.3 left open, narrows the cause from two candidates
to one mechanism, and states plainly what remains unrecoverable. It exists because the attempt
counter shipped in the same pass had to choose a key, and choosing one without establishing why the
obvious key is broken would have been guessing.

## 1. The finding in one paragraph

The corpus on disk is a faithful, still-reproducible dump of the live database. Its **row set and
every payload byte are identical** to what Postgres holds today. The recipe that hashes it has never
been edited. Therefore the only remaining degree of freedom that can produce a different
`payloadSha256` is **row order** — and the data has enough ties in `event_time` to make row order
almost entirely unconstrained. § 7.3's candidate (b), "a hashing input differed", is effectively
closed. Candidate (a) survives only in a narrowed form: _a differently-ordered serialisation of the
same 386-row snapshot_.

## 2. What was measured

### 2.1 The manifest, recomputed

Reimplementing `corpusManifest` (`test/eval/agentic/playbook-space-replay.ts:470-486`) and
`loadCorpus` (`:454-467`) against the actual file:

| property | value |
| --- | --- |
| rows | 386 |
| symbols | 26 |
| firstEventTime | 1784646000000 |
| lastEventTime | 1785180600000 |
| payloadSha256 | `030367bad28fb4198ce27f6e6b0dc8c39e33b26cd6b489a3ead3238d28d417ff` |

Ten frozen artifacts under `research/candidates/` record `f1dd13c695f8009ed64f0e0f0b1f0ed82327e0cabfd716a6674859092125d229`
with **every identity field matching**. The file is untouched since creation
(`birth == mtime == ctime == 2026-07-27T20:12:42Z`) and is the only copy on the machine.

### 2.2 The hash is order-sensitive; the identity fields are not

`corpusManifest` folds each row in array order — `h.update(r.id).update(' ').update(r.inputPayload).update(' ')`
(`:478`). Row count, symbol count and both endpoints are order-**insensitive**, because exactly one
row sits at the minimum `event_time` and exactly one at the maximum.

**So a reordering changes the hash and leaves every identity field untouched. That is precisely the
observed signature**, and it required no re-dump, no schema change and no data change.

### 2.3 The recipe never changed

`git log -L` over both `corpusManifest` and `loadCorpus` returns exactly one commit each — `83578d8`,
2026-07-27. There is no later edit. This closes "the recipe drifted" independently of § 7.3's own
byte-diff argument.

### 2.4 The data never changed

Comparing `id, md5(input_payload)` for all 386 qualifying rows between the file and the live table:

| check | result |
| --- | --- |
| rows on disk / in DB | 386 / 386 |
| ids only on disk | 0 |
| ids only in DB | 0 |
| payload md5 mismatches | 0 |

`agent_decisions` carries no rewriting triggers. Unchanged recipe plus unchanged inputs plus changed
output leaves exactly one possibility: **a different sequence**.

### 2.5 The tie structure makes that possibility enormous

| quantity | value |
| --- | --- |
| distinct `event_time` values on disk | 162 |
| tie groups | 81 |
| rows inside a tie group | 305 of 386 |
| largest tie group | 10 |
| orderings consistent with `ORDER BY event_time` alone | ~10^117.6 |

Every one of those orderings yields the same four identity fields and a different payload hash.

### 2.6 Reorderings tried, and the one that matches

Recomputed over the on-disk rows, plus five server-side against the live table:

| ordering | payloadSha256 |
| --- | --- |
| as on disk | `030367ba…` |
| `ORDER BY event_time, id` (the documented recipe) | `030367ba…` |
| `ORDER BY id` numeric | `030367ba…` |
| `ORDER BY event_time` alone | `d75020d0…` |
| `ORDER BY created_at, id` | `dc4fad56…` |
| `(event_time, id)` lexical id | `6b3c3af5…` |
| id lexical asc | `3d3768b8…` |
| `(event_time, symbol)` | `2070b5d0…` |
| `(event_time, based_on_seq)` | `4853557b…` |
| `(symbol, event_time)` | `697fa987…` |
| reversed / id desc | `85ef5c6f…` |
| `event_time` desc | `39ed5b1e…` |

Plus six alternative hash recipes (payload-only, no separators, no trailing space, id+time+payload,
id+symbol+payload, time+payload). **None reproduces `f1dd13c6…`.**

The on-disk file matches the documented producer exactly. The SQL published at
`playbook-space-replay-2026-07-28.md:60-67` carries a deterministic tiebreak — `ORDER BY event_time, id`
— and reproduces `030367ba…`. So it is the **artifacts** that came from a differently-ordered
serialisation, not the file.

### 2.7 A premise correction worth recording

`scripts/dump-eval-corpus.mjs` **did not produce this corpus**. Its `mapRow` emits camelCase keys
plus token/latency/created-at columns; the on-disk rows are snake_case with none of those, which is
what `RawCorpusRow` (`:446-452`) expects. Its query is also unbounded, and an unbounded dump today
returns 1099 rows (545 under the study's filters), not 386. Whatever produced either hash, it was not
that script running now.

The 386-row snapshot existed in a **30-minute window** on 2026-07-27: the last included row was
created at 19:45:30Z, the next qualifying rows landed at 20:15:28Z, and the file was born at
20:12:42Z — inside it. Any dump after 20:15:28Z yields at least 392 rows and a later
`lastEventTime`, yet every artifact records 386 / 1785180600000. **This refutes the "re-dump from a
later DB state" reading of § 7.3 candidate (a):** whatever produced `f1dd13c6…` was a
re-serialisation of _the same snapshot_, not a later one.

## 3. A correction to two other studies

`deployment-bar-halves-clause-2026-07-31.md:384` is **right** that `lastEventTime` is identical at
`1785180600000`. Two prose passages disagree with it and are **wrong**:

- `playbook-space-replay-2026-07-28.md:69`
- `playbook-space-followon-2026-07-31.md:236`

Both write the range as ending `1785181500000`. **No qualifying row exists at that instant.** Capping
the study's own query there returns the identical 386 rows with `max(event_time) = 1785180600000`; of
the 40 rows at 1785181500000, 36 are `prescreen` with no payload, 3 are `plan-executor` with no
payload, and 1 has a payload that is not FLAT.

The number is real but is a different quantity: `1785181500000 = 1785180600000 + 900000`, one 15-minute
bar, and `playbook-space-followon-2026-07-31.md:515` uses it correctly as the **exclusive cut
boundary** for Family B. It leaked from there into two range statements as if it were the last row's
timestamp. Cosmetic in effect, corrected here rather than silently carried.

These files are frozen pre-registrations and are **not edited** by this record. The correction lives
here.

## 4. What this means for the attempt counter

`metrics->>'corpusFingerprint'` cannot be the counter's key. A fresh run fingerprints the on-disk
corpus as `030367ba…`; the registry holds `f1dd13c6…`. Measured after this pass's backfill:

| key | rows matched |
| --- | --- |
| identity tuple (rowsLoaded, rowSince, rowUntil) | 6 |
| `corpusFingerprint = f1dd13c6…` (what the artifacts recorded) | 6 |
| `corpusFingerprint = 030367ba…` (what a fresh run would compute) | **0** |

The key shipped is `(rowsLoaded, rowSince, rowUntil)` out of `metrics.window`. The reasoning, and the
three fields rejected, are in `corpusAttemptKey` (`scripts/loop-authoring-core.mjs`). The decisive
measurement is one this record should state, because it is not about playbook-space at all:

**Registry row id=5 records a different `corpusFingerprint` (`99a3c1a3…`) from its five siblings
(`bc9390e4…`) on the same 204-row corpus, and a `firstEventTime` of its replayed subsample rather
than of the corpus.** Its `rowsLoaded`, `rowSince` and `rowUntil` match its siblings exactly. So the
fingerprint's failure to identify one corpus has now fired **twice, on two unrelated corpora**, and
`firstEventTime` is not corpus-stable across writers either. That is why the key is the query bounds.

## 5. What could NOT be established

Stated flatly, because a narrowed cause is not a closed one.

1. **The byte order that produced `f1dd13c6…` is unrecoverable.** The file that hashed to it is gone.
   `test/eval/agentic/data/*.jsonl` is gitignored (`.gitignore:44`) and `research/candidates/**` is
   too, so neither the corpus nor an artifact carrying its rows is in git history. No worktree
   survives (`git worktree list` shows only the main checkout).
2. **Which mechanism reordered it** — a re-dump inside a short-lived worktree, a hand-run psql export
   without the `, id` tiebreak, or an intermediate ordering — is undetermined. The tie structure makes
   all three equally capable of producing the observed signature, and no evidence distinguishes them.
   `DATA` is `process.cwd()`-relative (`playbook-space-replay.ts:41`), so a worktree run would not
   have inherited the gitignored file and would have regenerated it locally; that is a plausible
   story, not a demonstrated one.
3. **Whether the 20 published cells were scored on the same row SEQUENCE as the file on disk.** They
   were scored on the same rows and the same bytes — § 2.4 proves that much, and it is the part that
   matters for every mean, CI and verdict, since none of those statistics depends on row order.
   `strideSample` does depend on order, so the 354-row _subsample_ the artifacts scored may not be
   the 354 rows a rerun would select. No published statistic is invalidated by this; a byte-exact
   replay of the leg is not currently possible.
4. **The count is still not the whole truth.** After the backfill it reads 6, which is the six
   pre-gate arms it was asked to count. It does **not** include the kimi-k3 leg's `champion_v8`
   (`research/candidates/playbook-space-replay-kimi-k3-2026-07-28.json`, 4 further cells against this
   same corpus), which was also never registered. Deliberately left out: the backfill was authorised
   for six arms, and an INSERT into an append-only table cannot be taken back, so the recoverable
   error (under-count by one, fixable by a later INSERT) was preferred to the unrecoverable one. The
   honest total against this corpus is arguably **7**, and closing that gap needs its own decision.

## 6. What would close item 1, and why none of it is done here

Each is a separate change with its own trade, and none is authorised by this record:

- Commit the manifest triple as a checked-in pin, so a drift is caught at the next run rather than
  three studies later.
- Make the producer's ordering explicit and asserted — the documented SQL already carries
  `ORDER BY event_time, id`; nothing verifies that the file on disk was produced by it.
- Commit the dump itself, against the reason `.gitignore:41-44` gives for excluding it.

The counter ships with this defect **documented rather than hidden**, and the deployment-bar chain's
claim that "an arm is only ever compared to an incumbent measured on the corpus it was itself scored
on" (`playbook-space-followon-2026-07-31.md:88-89`) remains **verifiable at the level of rows and
bytes and unverifiable at the level of the recorded fingerprint**. No reader should treat the corpus
pin as proven while that stands.
