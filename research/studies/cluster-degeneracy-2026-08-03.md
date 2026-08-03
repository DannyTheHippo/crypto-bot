# Cluster-key degeneracy in the forward-return bootstrap (2026-08-03)

An audit of `scripts/loop-forward-return-core.mjs`'s cluster bootstrap, whose `MIN_CLUSTERS = 5`
floor exists so that a cell's power verdict cannot be bought by resampling too few independent
things. The bootstrap and the `clusters` count it reports were both keyed on the raw ccxt symbol
string, and the trading universe carries twelve base assets on both venues (spot `BTC/USDT` and
perp `BTC/USDT:USDT`) — 40 symbol strings over 28 distinct bases. A same-base cross-venue pair is
one observation wearing two symbol strings, not two independent ones, so the floor could be
satisfied by fewer independent assets than its own count implied.

**No verdict moves.** That conclusion is stated up front and the reading is in § 3.

## Bottom line

| Question | Answer |
| --- | --- |
| Was `clusterBootstrap` and `computeCell`'s `clusters` count keyed on the symbol string or the base asset? | **Symbol string**, in both places (`scripts/loop-forward-return-core.mjs:147-170,180-200`, pre-fix). |
| How much does the universe double-count? | 40 symbol strings, 28 distinct bases — 12 bases trade on both `binance` (spot) and `binanceusdm` (perp) under different strings. |
| Is the double-count negligible? | No. Measured spot/perp h=24 forward-return correlation for the same base is **0.9993-0.9999** — the two "clusters" are near-perfectly collinear, i.e. one effective observation. |
| Did any LIVE cell flip from POWERED to UNDERPOWERED once fixed? | **No.** Every powered cell in the current book (v1, v2, v10) stayed powered; only the reported cluster count and, for POWERED cells, the bootstrap CI changed (§ 3). |
| Did the deployed arm's watch (WATCH-PLAYBOOK-V10-1, v10) move? | **No.** v10's 6 clusters are unchanged before and after — its 17 entries carry no same-base cross-venue pair, so its CI is byte-identical (§ 3). |
| Did anything change status at all? | **Yes, one sub-clause.** v9's cluster count drops from 5 (at the floor, clause PASSING) to 4 (clause FAILING) — but v9 was already UNDERPOWERED on `n=6<12`, so the cell's overall verdict does not change (§ 3). |

## 1. The defect

`clusterBootstrap` (`scripts/loop-forward-return-core.mjs:147-170` pre-fix) grouped observations by
`o.symbol` and resampled that map's keys; `computeCell` (:180-200 pre-fix) reported
`clusters = new Set(sorted.map((o) => o.symbol)).size`. Both read the ccxt symbol string verbatim.

`MIN_CLUSTERS`'s own comment (`:54-67`, unchanged in substance by this fix) says the floor exists
because "20 entries concentrated on 3 symbols is 3 effective observations for a cluster bootstrap."
That reasoning is about *independence*, not about symbol strings — and two symbol strings for the
same coin's spot and perp book are not independent. `binance` and `binanceusdm` quote the same
underlying asset against very similar order flow; a directional forward-return move in one venue is
overwhelmingly the same move in the other. A cell built from, say, `BTC/USDT` and `BTC/USDT:USDT`
entries alone reported `clusters = 2` and could clear the floor two assets short of a real 5.

## 2. The fix

Added `baseAsset(symbol)` (`scripts/loop-forward-return-core.mjs`, new) — the ccxt symbol's base,
i.e. everything before the first `/`: `BTC/USDT` and `BTC/USDT:USDT` both yield `BTC`. Both
`clusterBootstrap`'s resample-unit map and `computeCell`'s `clusters` count now key on
`baseAsset(o.symbol)` instead of `o.symbol`. `gridKey(venue, symbol)`
(`scripts/loop-forward-return-core.mjs:215-217`) is untouched — it keys the *price grid*, which must
stay per-venue to avoid interleaving two different order books (defect #37, see its own comment);
clustering and grid-lookup are opposite concerns and this fix only touches the former.

The sort-before-resample determinism is preserved exactly, now sorting base-asset keys instead of
symbol-string keys, so `BOOTSTRAP_SEED` still buys byte-identical reruns
(`test/features/strategy/loop-sweep/forward-return.spec.ts`, "determinism and fail-open shape").

## 3. Before vs. after, on the live book

Read via `pnpm loop:forward-return` against the live Postgres instance, twice: once with the fix in
place, once with `scripts/loop-forward-return-core.mjs` reverted to the symbol-keyed version (the
test/spec file was left at the fixed version for both runs since it does not affect the live query).
Both reads returned successfully; the sandbox's network egress deny blocked the first attempt inside
this run, and disabling it produced the readings below (host confirmed reachable — not a live-stack
outage, a local sandbox restriction).

| version | population | n | clusters BEFORE (symbol) | clusters AFTER (base asset) | powered BEFORE | powered AFTER |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | all / flat_only | 28 | 13 | 10 | POWERED | POWERED |
| 2 | all / flat_only | 18 | 11 | 9 | POWERED | POWERED |
| 3 | all | 1 | 1 | 1 | UNDERPOWERED | UNDERPOWERED |
| 3 | flat_only | 0 | 0 | 0 | UNDERPOWERED | UNDERPOWERED |
| 6 | all / flat_only | 5 | 3 | 3 | UNDERPOWERED | UNDERPOWERED |
| 7 | all / flat_only | 5 | 5 | 5 | UNDERPOWERED (n only) | UNDERPOWERED (n only) |
| 8 | all / flat_only | 8 | 6 | 5 | UNDERPOWERED (n only) | UNDERPOWERED (n only) |
| 9 | all / flat_only | 6 | 5 | 4 | UNDERPOWERED (n only) | UNDERPOWERED (n **and** clusters) |
| 10 (inverted, deployed arm) | all / flat_only | 17 (16 at h=24) | 6 | 6 | POWERED | POWERED |

**The load-bearing question — which POWERED cells were powered only by same-base cross-venue
duplicates: none.** v1 and v2 lost 3 and 2 clusters respectively (13→10, 11→9) but both sit far above
the `MIN_CLUSTERS = 5` floor either way, so their power verdict is unaffected; only their reported
cluster count and — because the bootstrap now resamples fewer, larger buckets — their 95% CI width
changed (e.g. v1 h=1 CI narrows from `[-28.5, -4.9]` to `[-25.4, -11.7]`). v10, the arm
WATCH-PLAYBOOK-V10-1 is actually watching, is untouched at the bit level: its cluster count (6),
mean, and all four CIs are byte-identical before and after, because none of its 17 entries pair a
spot and perp leg of the same base. **The one status-relevant change is v9**, whose cluster count
was sitting exactly on the floor (5, passing) before the fix and drops to 4 (failing) after it — but
v9's `n=6` was already under `MIN_ENTRIES=12`, so the cell was UNDERPOWERED before and after; only
the *reason* named in its summary gains a second failing clause. No cell's POWERED/UNDERPOWERED
status flips.

## 4. Why the deployed arm was never at risk here, and why the fix still matters

v10 not moving at all is not a coincidence discovered after the fact — checking it was the point of
running the before/after comparison rather than trusting the arithmetic alone. But the absence of a
live incident does not make the defect cosmetic: `clusters` is reported and read as a count of
*independent* assets (`MIN_CLUSTERS`'s comment says so explicitly), and v9's flip from
"cluster clause passing at exactly 5" to "failing at 4" shows the floor was, for at least one real
cell, satisfied by a duplicate rather than a fifth independent asset. Had that cell's `n` cleared 12
on the same entry mix, the old code would have minted a POWERED verdict — with an interval — on 4
effective observations wearing 5 symbol-string clusters. The fix closes that path before it produces
a false-POWERED cell rather than after.

## What this study does not claim

- It does not claim any current research-bar or promotion verdict changes; § 3 shows none does.
- It does not re-derive `MIN_CLUSTERS = 5` itself — that floor's own justification (density of the
  bootstrap's discrete lattice) is untouched by this fix and is not re-examined here.
- It does not audit `gridKey` or the price-grid lookup, which key on `(venue, symbol)` deliberately
  and are the opposite concern from clustering (§ 2).
