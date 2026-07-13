# $0 stop-slippage study — 2026-07-13

**Read this line first: N=3 realized stop exits. This is an honest small-N finding, not a
validated distribution — one more adverse event would materially change the mean, and the
per-symbol rows below are each N=1.** $0 study: reads the live stack's own `fills` ×
`order_intents` × `signals` × `agent_decisions` rows, no LLM calls, no network.

## 1. Method

`test/backtest/stop-slippage/run.mjs` walks every (strategy, symbol)'s fills in venue-timestamp
order, maintaining a running VWAP cost basis, so every stop-exit fill (`signals.reason = 'plan
exit: stop'`) resolves to its trip's entry VWAP and the count of stop-exit attempts before flat
(re-fires). IOC slippage bps is fill price vs. `order_intents.ref_price`, signed identically to the
`order_slippage_decision_bps` histogram (positive = adverse). The intended stop price is
`entryVwap × (1 − stopLossPct)`, with `stopLossPct` read from the most recent `agent_decisions.plan_json`
row on record for that trip (the entry's own `long` row does not carry `plan_json` in this
corpus — only later hold-consult rows do, see §3 caveat); leak bps is `(intendedStop − fillPrice) /
intendedStop × 10000`, again positive = adverse (realized exit landed below the level the plan meant
to defend).

## 2. Aggregate

| Metric | N | mean | median | worst |
| --- | --- | --- | --- | --- |
| Leak bps (fill vs intended stop) | 3 | +3.2 | +15.5 | +47.0 |
| IOC slippage bps (fill vs ref_price) | 3 | +0.87 | +0.89 | — |

Maker/taker split: 0 maker / 3 taker. Re-fires: 0 extra stop-exit attempts across 0 trips with more
than one stop-exit fill (every stop exit in this corpus closed its trip on the first attempt).

### Per-symbol stop exits

| Symbol | N | leak mean bps | leak median bps | leak worst bps | IOC mean bps | maker | taker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC/USDT | 1 | +15.5 | +15.5 | +15.5 | +0.48 | 0 | 1 |
| ETH/USDT | 1 | +47.0 | +47.0 | +47.0 | +0.89 | 0 | 1 |
| LINK/USDT | 1 | -52.8 | -52.8 | -52.8 | +1.25 | 0 | 1 |

LINK's negative leak means that trip's realized exit landed *above* (better than) the intended stop
line — the close-detected exit fired on a bar whose close had already recovered past the modeled
stop level by the time the order filled; not every close-detection lag is adverse.

### max_hold reference (time-based exits, no "intended price" to leak against)

| Symbol | N | IOC mean bps | maker | taker |
| --- | --- | --- | --- | --- |
| BTC/USDT | 1 | +0.00 | 0 | 1 |
| ETH/USDT | 1 | +0.00 | 0 | 1 |
| XRP/USDT | 1 | +0.90 | 0 | 1 |
| LINK/USDT | 1 | +0.00 | 0 | 1 |

Aggregate max_hold: N=4, mean IOC slippage +0.23bps, 0 maker / 4 taker. A 5th `plan exit: max_hold`
signal exists for agentic-3/SOL but its `intent_id` is null on the signal row itself (no order was
ever placed for it) — excluded from the max_hold table above as a non-fill, not folded in as a zero.

## 3. Data-quality caveats

- **N=3 stop exits total** across the whole corpus (3 strategies/symbols realized one each: BTC,
  ETH, LINK; agentic-3/SOL and agentic-4/XRP had none). This is descriptive, not distributional —
  treat every number above as a single-trip anecdote, not an estimate with a standard error.
- **`plan_json` is not on the entry's own `long` row.** Verified directly against the live rows: every
  `long`-action `agent_decisions` row in this corpus has `plan_json IS NULL`; the field is populated on
  later `hold`-action consult rows while the plan is active, and its `stopLossPct` value can drift
  bar-to-bar (the model re-affirms/updates its stated stop view mid-trade in these samples). The
  script therefore reads "the owning plan" as the most recent `plan_json` row on record inside the
  trip's window (entry fill through the exit signal), not the entry decision itself — flagged here
  rather than assumed silent.
- **All 3 stop exits and all 4 realized max_hold exits are taker fills** — no maker-side stop/max_hold
  exit exists yet in this corpus, so the maker/taker split carries no signal either way.
- **Lint scope note:** this script is a bare `.mjs` outside any `tsconfig` project, matching
  `test/backtest/bounds-calibration/run.mjs`'s class — that script's directory has its own
  `eslint.config.mjs` ignore entry; this study's directory does not yet have one (out of this
  dispatch's file scope: `test/backtest/stop-slippage/` and this report only). `pnpm lint` may need
  a matching ignore-list entry added as a follow-up.

## 4. Verdict

Pre-registered criterion: **watcher/venue-stop enable justified iff mean total stop leak worse than
−10bps/exit OR any single event ≤ −100bps** (loss-sign convention; equivalently, using this study's
positive-is-adverse bps convention, mean leak > +10bps or any single event ≥ +100bps).

Measured: mean leak = +3.2bps (below the +10bps mean threshold), worst single event = +47.0bps
(below the +100bps single-event threshold).

**NOT JUSTIFIED (N=3).** Neither threshold is met on the data as it stands, but N=3 is too thin to
treat this as a settled negative — one more ETH/LINK-sized adverse stop event would roughly triple
the mean, and the worst event already observed (+47bps) sits at under half the single-event bar.
Revisit once the corpus has grown past single digits per symbol before treating this as closed.
