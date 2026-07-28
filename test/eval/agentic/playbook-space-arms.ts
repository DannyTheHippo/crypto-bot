// The twelve frozen arms of the playbook-space replay, preregistered in
// research/studies/playbook-space-replay-2026-07-28.md § Arms. Not a test file — see fixtures.ts's
// own header for why Vitest never picks these up directly.
//
// Each arm is a playbook TEXT. The system prompt is identical across arms, so the playbook is the
// only thing that varies — which is what makes "is there a text in playbook space whose entries clear
// the fee" a question this study can actually answer.
//
// EVERY arm must pass the live validatePlaybook gate (asserted in the runner, not merely hoped for).
// An arm the live validator would reject is NOT a reachable point in playbook space, so scoring it
// would answer a question about a system that cannot exist. That check is load-bearing, not hygiene.
//
// Arms 1-3 are loaded from the DB at run time (the real seeds/champion, verbatim, truncation
// included). Arms 4-12 are authored here and frozen by this file's own content hash in the manifest.

export interface PlaybookArm {
  readonly name: string;
  // 'db' arms resolve their content from agent_playbook_versions at the pinned version; 'literal'
  // arms carry it here.
  readonly source: { readonly kind: 'db'; readonly version: number } | { readonly kind: 'literal' };
  readonly content?: string;
  // One line, recorded in the results table so a reader can tell what each arm was FOR without
  // re-reading 4,000 characters of prose.
  readonly tests: string;
}

// ── Arms 1-3: the real lineage, pulled verbatim from the DB ──────────────────────────────────────
// NAMING CORRECTED 2026-07-28, before any results existed. v9 was originally labelled `champion_v9`.
// It is NOT the champion: `agentic_playbook_info` reports the app running **version 8**, and v9 is an
// unresolved `source='reflection'` CANDIDATE sitting above it, receiving AGENTIC_PLAYBOOK_AB_PCT=40%
// of decides through the A/B. Publishing a results table that called v9 "champion" would have
// misrepresented which text is actually in charge — so the arms now carry the roles the live system
// actually assigns.
const DB_ARMS: readonly PlaybookArm[] = [
  {
    name: 'champion_v8',
    source: { kind: 'db', version: 8 },
    tests: 'the ACTIVE champion (agentic_playbook_info version=8) — the true status quo',
  },
  {
    name: 'candidate_v9',
    source: { kind: 'db', version: 9 },
    tests:
      'the unresolved A/B candidate on 40% of decides, verbatim including its truncated entry-rules section',
  },
  {
    name: 'seed_v1',
    source: { kind: 'db', version: 1 },
    tests: 'the original 2026-07-21 seed — a different lineage',
  },
];

// ── Arm 4: neutral stub ──────────────────────────────────────────────────────────────────────────
// Deliberately says almost nothing. Not "no playbook" — the block delimiters and the DATA-framing
// sentence are structural and present in every live call, so removing them would change the prompt
// shape as well as the advice, confounding the arm. This isolates the advice.
const MINIMAL = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.

## entry rules
Use your own judgement on the market context provided. No additional heuristics are supplied.

## exit rules
Set a stop beyond invalidating structure and a take-profit consistent with your own thesis.

## mistakes to avoid
None specified. Rely on the decision contract and the market context.`;

// ── Arm 5: trade almost never ────────────────────────────────────────────────────────────────────
// STRUCTURALLY FORBIDDEN BY THE LIVE SYSTEM. reflection.service.ts:526-537 states a flat week is a
// FAILING week and instructs the reflector to LOOSEN when entries fall; a mint-time entry-rate floor
// and a live-abstention lapse enforce it. Against a measured -106 bps/trip, trading less is the only
// lever with positive expected effect, so the span here must contain what the live span cannot.
const TRADE_ALMOST_NEVER = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.
The base rate matters more than any single chart: across this book's realised history, the average
entry lost roughly one percent of notional after costs. Assume the same base rate applies to the
setup in front of you unless the evidence is overwhelming that it does not.
Doing nothing is a position. It costs no fees, no spread and no slippage, and it is the correct
choice in the large majority of market states.

## entry rules
Enter only when the setup is so clean that you would be surprised to be wrong: a decisive break of a
level that has held repeatedly, with the higher-timeframe trend in the same direction, volume
confirming, and a named invalidation within one to two percent. All four, not three.
If you are weighing whether it qualifies, it does not qualify. Hold.
Expect to enter on well under one in twenty flat consults. A week with no entries is a SUCCESS if no
setup met the bar — it means the filter worked. Never enter to satisfy an activity target.

## exit rules
Stops sit beyond invalidating structure, roughly 1.5-2x recent ATR, and are honored. Never widen.
If the thesis breaks, close immediately rather than waiting for the stop.
Let a working trade run to its take-profit; the rare qualifying setup is where the expectancy is.

## mistakes to avoid
Do not enter because nothing has happened for a while. Do not enter a marginal setup on the theory
that a small position is low risk — fees and spread are paid in full on every trip regardless of
size. Do not talk yourself past a missing confirmation. Do not treat a flat book as a failure.`;

// ── Arm 6: inverted ──────────────────────────────────────────────────────────────────────────────
// The inversion hypothesis, expressed as advice a real playbook could carry. See state.md's standing
// NOT-A-FINDING entry: the +66.5 bps figure is a sign-flip of a negative mean and is NOT evidence.
// This arm is the actual test — an arm told to fade must produce its own entries and clear the bar on
// its own observations, which is a materially stronger claim than negating someone else's mean.
const INVERTED = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.
Recorded evidence from this book: the setups that read as attractive long entries were followed by
falling prices, and the setups that read as attractive short entries were followed by rising prices.
Entry timing measured worse than picking a bar at random. Treat the obvious read of a chart here as a
contrary indicator rather than a signal.
The likely mechanism is that by the time a breakout, a reclaim or a clean pullback is visible on 15m
bars it is already crowded, and the move that follows is the unwind of that crowding.

## entry rules
When the market context would ordinarily argue for a long — breakout, reclaim, pullback holding
support, strong relative rank, rising EMA — open a SHORT instead.
When it would ordinarily argue for a short — breakdown, failed reclaim, weak relative rank, falling
EMA — open a LONG instead.
The strength of the ordinary read is the strength of this signal: the more textbook the setup looks
in its original direction, the more confident the opposite position.
State in your thesis what the conventional read was, so the inversion is explicit and auditable.
Hold only when there is no clear conventional read to invert.

## exit rules
Stops sit beyond the level that would confirm the CONVENTIONAL read was right after all — that is the
invalidation for this approach. Roughly 1.5-2x recent ATR. Honored, never widened.
Take profit into the unwind rather than waiting for a full reversal; these moves are exhaustion, not
new trends. maxHoldBars is a real deadline.

## mistakes to avoid
Do not drift back to the conventional read mid-trade. Do not invert a setup you cannot state clearly
in its original direction — vagueness inverted is still vagueness. Do not size so small that fees
dominate. Do not stack this on top of a conventional filter; the inversion IS the strategy.`;

// ── Arm 7: high conviction only ──────────────────────────────────────────────────────────────────
const HIGH_CONVICTION_ONLY = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.
Selectivity is the whole strategy. The scanner surfaces many symbols; almost all of them are noise at
any given moment. The job is to find the rare state where several independent inputs agree.

## entry rules
Require confluence of at least four independent inputs before entering, all pointing the same way:
(1) higher-timeframe trend (1h and 4h agree), (2) structure — a break-and-hold, retest or reclaim of a
level with prior significance, (3) relative strength rank in the top or bottom fifth of the menu,
(4) an indicator confirmation that is not merely restating price (RSI regime, EMA slope, volume).
A named invalidation level within one to two percent is mandatory; without one, hold.
Three of four is a hold, not a smaller position. Confluence does not partially count.

## exit rules
Stops beyond invalidating structure, roughly 1.5-2x recent ATR, honored and never widened.
Because entries are rare and well-confirmed, give them room in TIME rather than price: trail the stop
as new structure forms and let the trade reach take-profit rather than scratching it early.
Close immediately if the confluence that justified the entry breaks.

## mistakes to avoid
Do not lower the bar because the book has been flat. Do not count two restatements of price as two
independent inputs. Do not enter on a strong chart with no named invalidation. Do not average into a
losing position. Do not spread across many symbols — concentration is the point of selectivity.`;

// ── Arm 8: leaders only ──────────────────────────────────────────────────────────────────────────
const LEADERS_ONLY = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.
Trade only BTC, ETH and SOL. These carry the deepest books, the tightest spreads and the least
idiosyncratic noise; the long tail of the scanner menu is where slippage and thin liquidity eat any
edge that might exist. If the symbol in front of you is not one of those three, hold.
BTC leads: when BTC trends down, ETH and SOL longs are lower quality regardless of their own charts.

## entry rules
On BTC, ETH or SOL only: enter on a break-and-hold, a retest that holds, or a reclaim of a level with
prior significance, with a named invalidation you can price.
Long on continuation above a rising EMA or a reclaim of a lost level; short the mirror on perp.
Prefer the strongest of the three at any moment rather than the one with the prettiest chart.
On any other symbol, hold — with the reason stated as universe restriction, not as a market view.

## exit rules
Stops beyond invalidating structure, roughly 1.5-2x recent ATR, honored and never widened.
Deep books mean stops fill near their level; use that and size properly rather than tightening.
Trail as structure forms; maxHoldBars is a real deadline. Funding accrues every 8h on perp.

## mistakes to avoid
Do not trade outside the three names for any reason. Do not treat a strong altcoin chart as evidence
that the restriction is wrong. Do not ignore BTC direction when trading ETH or SOL. Do not size so
small that fees dominate.`;

// ── Arm 9: one symbol (BTC) ──────────────────────────────────────────────────────────────────────
const ONE_SYMBOL_BTC = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.
Trade BTC only. Every other symbol is a hold, always, with the reason stated as universe restriction
rather than as a market view. The premise is that a single deep, well-understood market traded
patiently beats a broad menu traded thinly — attention is the scarce resource, not opportunity.

## entry rules
On BTC only: enter on a decisive break-and-hold of a level with prior significance, a retest that
holds, or a reclaim of a lost level, with a named invalidation you can price.
Long above a rising EMA on continuation; short the mirror on perp when structure breaks down.
Higher-timeframe context (1h, 4h) must not contradict the entry direction.
On every non-BTC symbol, hold.

## exit rules
Stops beyond invalidating structure, roughly 1.5-2x recent ATR, honored and never widened.
Trail the stop as new structure forms and let winners reach take-profit. maxHoldBars is a real
deadline. On perp, funding accrues every 8h — a headwind shortens the hold.

## mistakes to avoid
Do not trade any symbol other than BTC. Do not treat the restriction as a reason to force BTC trades
when BTC is rangebound. Do not widen a stop. Do not size so small that fees dominate.`;

// ── Arm 10: momentum pure ────────────────────────────────────────────────────────────────────────
const MOMENTUM_PURE = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.
Trend continuation is the only pattern traded here. Strength begets strength: a symbol making new
highs on the session with the higher timeframes aligned is more likely to continue than to reverse.
Relative strength rank is the primary input — prefer the strongest names on the menu for longs and the
weakest for shorts.

## entry rules
Long only when: price is above a rising EMA on 15m AND the 1h trend agrees AND the symbol ranks in the
strongest third of the menu AND price is extending rather than retracing.
Short (perp) the exact mirror: below a falling EMA, 1h agreeing, weakest third, extending down.
Enter on continuation — a break to new session highs or lows, or a shallow pullback that resumes.
Name the invalidation as the level whose loss would end the trend.
Never enter against the prevailing direction for any reason.

## exit rules
Stops beyond the level that would end the trend, roughly 1.5-2x recent ATR, honored and never widened.
Trends persist longer than they feel like they should: trail the stop up (long) or down (short) as new
structure forms rather than taking profit into strength. maxHoldBars is a real deadline.
Close immediately when the trend structure breaks, not when the price merely pauses.

## mistakes to avoid
Do not buy a dip, fade an extension, or trade a reversal — those are a different strategy and are out
of scope here. Do not enter a symbol ranked mid-menu. Do not enter when 15m and 1h disagree. Do not
take profit early on a working trend.`;

// ── Arm 11: mean reversion pure ──────────────────────────────────────────────────────────────────
const MEANREV_PURE = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.
Extension reverts. This book trades only stretched conditions: a symbol far from its moving average
after a fast move, with the move decelerating. Trends are out of scope here — a symbol grinding in its
direction with no extension is a hold, however strong it looks.

## entry rules
Long only when: price is stretched BELOW its 15m EMA after a fast decline AND the decline is
decelerating AND the symbol is at or near a level that has previously held.
Short (perp) the exact mirror: stretched above the EMA after a fast advance, decelerating, at a level
that has previously capped.
The named invalidation is a continuation of the original move beyond the extreme — if it goes, the
reversion thesis is dead and the trade is closed.
Never enter in the direction of the extension.

## exit rules
Stops just beyond the extreme of the move, roughly 1.5-2x recent ATR, honored and never widened.
Target the moving average, not a full trend reversal — reversion trades pay at the mean and give the
profit back beyond it. Take profit there rather than holding for more.
maxHoldBars is a real deadline; a reversion that has not happened quickly is not happening.

## mistakes to avoid
Do not chase continuation or trade breakouts — those are a different strategy and out of scope here.
Do not enter while the move is still accelerating; wait for deceleration. Do not hold past the mean
hoping for a trend. Do not average down into a move that keeps extending.`;

// ── Arm 12: shorts only ──────────────────────────────────────────────────────────────────────────
// Tests the ENTRIES verdict's leg decomposition: the long leg (n=43) carried the loss at every horizon
// (-19.9 / -29.2 / -56.3 / -93.5 bps) while the short leg (n=18) was not significant on its own.
const SHORTS_ONLY = `## regime notes
One book, two venues (spot + perp), one scanner menu. Swing horizon: hours to days on 15m bars.
Short side only. Recorded evidence from this book: long entries lost at every horizon measured, while
the short entries were not measurably losing. Whatever the cause, the long side is where the damage
was done, so it is out of scope here.
Perp is the venue for this — a spot symbol with no short capability is a hold, stated as a venue
restriction rather than a market view.

## entry rules
Enter shorts on perp only, when structure breaks down: a decisive loss of a level that had held, a
failed reclaim of a lost level, or continuation below a falling EMA with the 1h trend agreeing.
Prefer the weakest-ranked names on the menu; a strong-ranked symbol needs a clear breakdown, not just
a pullback.
Rich positive funding with stalling upside is a tailwind. Rising open interest with falling price
means fresh shorts — respect the crowding and size accordingly.
Name the invalidation as the level whose reclaim would prove the breakdown false.
Never open a long for any reason; a bullish read is a hold.

## exit rules
Stops above the level whose reclaim invalidates the breakdown, roughly 1.5-2x recent ATR, honored and
never widened. Liquidation distance must stay above 3x the stop distance — cut size, never tighten.
Cover into capitulation rather than waiting for a full trend reversal. Trail down as new structure
forms. maxHoldBars is a real deadline; funding accrues every 8h and a headwind shortens the hold.

## mistakes to avoid
Do not open a long under any circumstance. Do not short a symbol merely because it is up — require a
structural breakdown. Do not chase a liquidation wick down. Do not let liquidation distance fall
below 3x the stop. Do not size so small that fees dominate.`;

const LITERAL_ARMS: readonly PlaybookArm[] = [
  {
    name: 'minimal',
    source: { kind: 'literal' },
    content: MINIMAL,
    tests: "the model's own priors, unguided",
  },
  {
    name: 'trade_almost_never',
    source: { kind: 'literal' },
    content: TRADE_ALMOST_NEVER,
    tests: 'extreme abstention — FORBIDDEN by the live anti-ratchet objective',
  },
  {
    name: 'inverted',
    source: { kind: 'literal' },
    content: INVERTED,
    tests: "fade the system's own setups — the inversion hypothesis",
  },
  {
    name: 'high_conviction_only',
    source: { kind: 'literal' },
    content: HIGH_CONVICTION_ONLY,
    tests: 'four-way confluence required (~1 in 20)',
  },
  {
    name: 'leaders_only',
    source: { kind: 'literal' },
    content: LEADERS_ONLY,
    tests: 'BTC/ETH/SOL only — liquidity as the filter',
  },
  {
    name: 'one_symbol_btc',
    source: { kind: 'literal' },
    content: ONE_SYMBOL_BTC,
    tests: 'BTC only — attention as the scarce resource',
  },
  {
    name: 'momentum_pure',
    source: { kind: 'literal' },
    content: MOMENTUM_PURE,
    tests: 'continuation only; no dip-buying, no fading',
  },
  {
    name: 'meanrev_pure',
    source: { kind: 'literal' },
    content: MEANREV_PURE,
    tests: 'fade extension only; no continuation',
  },
  {
    name: 'shorts_only',
    source: { kind: 'literal' },
    content: SHORTS_ONLY,
    tests: 'short side only — the long leg carried the recorded loss',
  },
];

export const PLAYBOOK_ARMS: readonly PlaybookArm[] = [...DB_ARMS, ...LITERAL_ARMS];
