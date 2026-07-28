# Architecture options against the fee floor — research memo (2026-07-28)

Owner question: *could this become profitable with a Haiku agent swarm, or by giving the trader model
tool use? Plus two other similar solutions.*

Answered against the evidence already on record. **No new measurement was made** — both provider
accounts are unfunded — so nothing here is a finding. It is a screen: which of these can even
*mechanically* produce the missing quantity, and which is cheapest to falsify.

## The one number every option has to clear

Everything reduces to a single arithmetic constraint the program has already measured:

| quantity | value | source |
| --- | --- | --- |
| required gross edge / round trip | **+13.0 bps** demo, **+24.2 bps** live | state.md § Standing verdicts |
| observed gross | **−106.0 bps** / trip (n=27) | Pass 41 |
| gross of a RANDOM entry at the model's own geometry | **≈ 0** (−1.07 bps, a martingale) | 34 cells, 32,368 windows |
| LLM spend as a share of the loss | $15.48 of $37.56 → **free inference still leaves −$22.08** | Pass 41 |

Two consequences that kill most ideas before they start:

1. **A random entry earns ≈0 gross, so net ≈ −fees always.** Only *entry alpha exceeding fees* can
   produce profit. Not better exits (16/16 cells negative), not better sizing, not cheaper inference.
2. **Sizing and cost cannot change a sign.** Expectancy is multiplied by size; −106 bps/trip scaled
   any which way stays negative. An architecture that only improves sizing or cost is arithmetically
   incapable of fixing this, however good it is.

So the screen for every option below is exactly one question: **by what mechanism does this produce
≥13 bps of entry alpha?**

## (a) Haiku agent swarm — predicted NEUTRAL-TO-WORSE

**Mechanism it offers:** ensembling. Many cheap agents vote; noise cancels.

**Why it does not apply.** Ensembling reduces **variance**, not **bias**. The finding here is a bias:
entries are −16.9 bps at h=1 (t=−4.58) and **measurably worse than a random-bar placebo**
(p = 0.0013–0.0037). Averaging more draws from a biased predictor converges *on the bias*, not on
zero. A swarm that agrees more confidently on a negative-expectancy signal produces the same expected
return with less dispersion — which is strictly worse, because dispersion was the only thing
occasionally rescuing a trip.

The cost argument does not save it either: cheaper inference is worth at most the $15.48 LLM line, and
free inference still leaves −$22.08.

**Cheapest falsification — genuinely cheap, and worth doing when funded.** It needs no new
infrastructure: add swarm arms to the existing playbook-space harness (N haiku replays per row,
majority-vote the action, score on the identical metric against the identical +13.0 bps bar). If a
12-arm span of deliberately wide *single*-model policies cannot clear the bar, a vote over the same
payload almost certainly cannot — but it is a ~$5 question, so it can simply be answered.

## (b) Tool use for the trader model — WEAK, and usually a category error

**Mechanism it offers:** the model chooses what to look at instead of receiving a fixed payload.

**The distinction that decides it:** tools add **access**, not **information**. Where a tool queries
data the payload already contains, it cannot help — the 1,807-cut adversarial search covered
*everything the system records* and found **0 of 188 counterfactual cuts positive at n≥8**, with a
family-wise permutation p of 0.378. A model choosing its own cuts is searching the same exhausted
space, more expensively.

Tool use is only promising to the exact extent it reaches information **not in the payload** — order
book depth beyond the recorded top-of-book, trade flow, cross-venue prices, funding term structure.
That is a real category. But then the hypothesis is *"channel X predicts returns"*, and **the tool is
an implementation detail of testing it.**

That reframing is decisive, because it makes the idea cheap to screen instead of expensive to build:
name the channel, fetch its history, test it directly. That is precisely what the non-price study did
for the three fetchable channels — **15 of 15 runnable cells failed**, every CI spanning zero.

**Recommendation:** never build tool use to *discover* whether a channel works. Test the channel; build
the tool only for one that survived. Note also that the microstructure channels most likely to carry
short-horizon information are **not recorded by this system at all** (no order-book, trade-flow or
quote tables exist), so they cannot be tested offline today — testing them requires a recording
period first, which is a months-long commitment, not a code change.

## (c) Non-directional: market making / spread capture — DEAD ON COST, not on skill

**Mechanism it offers:** stop predicting direction entirely; earn the bid-ask spread. This is the one
class **no existing verdict contradicts** — all eleven standing verdicts are about *directional
prediction*, and a market maker does not predict direction.

**Why it still fails here, and it is not close.** Demo fees are **10 bps flat per leg, maker = taker**
(verified 2026-07-12), and live is ~20 bps round trip at this account's tier. A market maker must
capture more than the round-trip fee per cycle. Top-of-book spread on the liquid names it trades is on
the order of **~1 bp**. Capturing 1 bp against a 20 bps cost is not a strategy that needs tuning; it is
off by more than an order of magnitude.

Market making becomes arithmetically possible only with a **maker rebate or a fee tier**, which is a
function of volume and capital — and this book is capped at **~$1k**. So this option is not blocked by
the model, the prompt, or the architecture. It is blocked by the fee schedule, and no amount of
engineering moves it.

## (d) Delta-neutral funding carry — ALREADY TESTED, NO-GO

Worth stating explicitly because it is the obvious fourth idea and it is **not open**:
`research/studies/carry-study-2026-07-10.md` ran a delta-neutral long-spot/short-perp carry state
machine over **126 cells** (7 symbols × 3 lookbacks × 3 thresholds × 2 exit rules, ~2 years of funding
history) at 24 bps round-trip cost. **Verdict NO-GO, no cell retried or reparametrized.** The
funding-*contrarian* frontier was separately killed on its second holdout (134/150 cells died; the
survivors flipped negative — regime beta, not signal).

The same fee arithmetic explains it: funding at 5–12% annualised has to accrue for a long time to
clear 24 bps of round-trip cost, and the entry/exit timing that would shorten that is the same
directional prediction problem in a different coordinate system.

## What the evidence actually points at

Stated plainly because the alternative is proposing work that cannot succeed.

**The binding constraint is the fee floor, not the intelligence of the trader.** At ~$1k of capital and
10–20 bps per round trip, the reachable strategy space splits in two:

- strategies needing **directional alpha** — settled empty across 4,562 price-TA backtests (zero
  survivors at *any* fee level including 0 bps), 1,807 conditional cuts, 15/15 non-price cells, 24/24
  horizon cells, 16/16 exit cells, 8/8 long-only overlays;
- strategies needing a **fee tier or capital scale** this book does not have — market making, HFT,
  anything whose per-cycle gross is smaller than the cost.

The one return the program has *measured and confirmed* is beta: the equal-weight basket earned
**+6.64% per 30-day period** while every active overlay lost to it, and the bot itself lost ~4% over a
window where the same 16 assets returned **+0.39%**. **Important caveat, load-bearing:** those assets
were selected for surviving to 2026, so the absolute passive figure is survivorship-inflated and is
**not** an achievable ex-ante return. The robust claim is strictly *relative* — **active lost to
passive** — and it should never be quoted as "buy-and-hold makes X%".

## Recommendation

1. **Finish the playbook-space replay first.** It is built, frozen, and one funded key away. It is the
   strongest existing test of the whole "better prompt/policy/architecture" family — twelve
   deliberately wide arms including the two the live objective forbids. If nothing there clears
   +13.0 bps, options (a) and (b) are answered by implication and cheaply.
2. **Add swarm arms to that same harness** (~$5) rather than building a swarm. It reuses the frozen
   corpus, metric and bar, so the result is directly comparable.
3. **Do not build tool use to discover a channel.** Name the channel, test it, build only for a
   survivor.
4. **Treat market making as a capital/fee-tier question**, not an engineering one. Revisit only if the
   fee schedule changes.
5. Do not re-run carry, price-TA, exits, horizons, or the non-price channels. All settled.
