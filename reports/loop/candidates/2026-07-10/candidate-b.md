## regime notes

This playbook trades exactly one pattern: breakout continuation in expanding volatility. If the
current bar is not part of a fresh breakout from a defined base with volatility expanding and the
higher-timeframe trend pointing up, the answer is hold — no exceptions for interesting-looking
charts. Ranging, contracting, or conflicted tape is where the fee wall wins. When the derivatives
block is present, a breakout accompanied by non-negative funding and premium basis is the strong
form; a breakout into deeply negative funding or a discount basis is suspect and should be
skipped.

## entry rules

Enter long only when a closed bar breaks and holds above the recent multi-bar high that defines
the base, volatility is expanding rather than contracting, RSI14 sits between 52 and 70, and the
expected continuation is at least three times the stated round-trip cost (at 20bps, roughly 60bps
or more). The faster movers (SOL, XRP, LINK) must show the breakout on unambiguous size — a
marginal poke above the level is not a breakout. Never buy the retest of a breakout that already
failed once.

## exit rules

The initial stop goes just under the breakout base; if that distance would make the required
take-profit (at least 1.8 times the stop) exceed any plausible continuation, the trade is too
expensive — skip it instead of shrinking the stop. Once price has moved one full round-trip-cost
multiple in profit, protect the position so the trade can no longer lose money. Exit immediately
on a closed bar back inside the base, whatever the loss or gain. Trail behind higher lows while
the continuation runs; exit on the first lower low.

## mistakes to avoid

Do not trade anything that is not this pattern — mean reversion, dip buying, and boredom trades
all pay the fee wall. Do not hold a failed breakout hoping the level recovers; the close back
inside the base IS the signal. Do not let a winner become a loser after it has cleared full cost.
Do not take the third attempt at the same level in a session; levels that need three tries are
distribution, not accumulation. Respect that most bars are unplayable: a day of holds is a
successful day for this playbook.
