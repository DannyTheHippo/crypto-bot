# 2026-07-31 — a position that could not be exited, and 45 minutes with no stop behind it

Written by Pass 53. Investigated by four parallel agents plus three adversarial verifiers per finding;
the diagnosis below survived a correctness lens and an alternative-cause lens unrefuted, and the
**remediation** was partly refuted — that refutation is recorded in § What NOT to ship.

## One paragraph

Between 13:00:36Z and 13:06:10Z the app made 13 attempts to exit a 70.3 KAITO/USDT:USDT long on
binanceusdm. Twelve were terminal-rejected by the venue with `BadRequest -4024 "Limit price can't be
lower than X"`; the thirteenth stranded. The cause is not aggression and not a pricing bug in the
ordinary sense: **the app prices every order off the LIVE venue's tape while orders execute against
the DEMO venue**, and during this window the demo perp book was frozen 5.7% above the live tape. The
venue's floor is its own mark price × 0.95, which sat ABOVE our reference price, so every price we
could have computed was illegal. The costly part is not the rejects — it is that the first attempt
cancelled the resting protective stop *before* submitting its replacement, so the position sat with
no venue-side stop and no plan stop for **45 minutes**, and every counter on every dashboard read
healthy throughout.

## Timeline (UTC, 2026-07-31, boot `93e21a99`, build `c78d193`)

| time | event |
| --- | --- |
| 04:30:33 | entry fills 70.3 @ 1.136600; live-feed ref at that moment 1.136300 (**3 bps apart — the venues had NOT diverged at entry**) |
| 10:00:34.741 | protective `STOP_MARKET` ACKed, trigger 1.0797, dedupe `agentic:venue_stop_place:1785491100000` |
| 13:00:36 | agentic plan-executor fires `plan exit: stop` → `cancelFirstEligible` |
| 13:00:38.029 | the resting `STOP_MARKET` is `VENUE_CANCELED` — **two seconds after the exit signal, and before the replacement exit is known to be accepted** |
| 13:00:38 → 13:05:40 | 12 reduce-only SELL LIMIT/IOC submits, one every ~30s, **all terminal-rejected `-4024`** |
| 13:06:10 | 13th submit → `SUBMIT_AMBIGUOUS` → `QUERY_NOT_FOUND` |
| 13:06:40 → 13:11:14 | no further fires: the stranded order holds `inFlightSymbols`, which **suppresses the 1s protective backstop entirely** |
| 13:11:14.025 | `CANCEL_REQUESTED {reason: STRANDED_NEW_NEVER_LANDED}` |
| ~13:16 | price recovers above the 1.068404 stop threshold (`agent_decisions` close 1.076600) — firing stops for a second, unrelated reason |
| 13:45:34 | a new `STOP_MARKET` is finally placed — **the protection gap closes after 45 minutes** |

Nothing exited. The position was still open at 16:25Z; a partial reduce (35.1 @ 1.126200) filled at
16:30:31.

## Root cause

`src/features/trading/composition/market-streams.module.ts:77-79` builds the market-data feed against
`FEED_ENV` (default and configured value `live`), while orders execute against `SANDBOX_ENV=demo`.
`.env.app:29-30` documents the split deliberately: *"'live' gives realistic depth for fills; order
placement still goes to the SANDBOX_ENV venue above."*

Binance USDⓈ-M `-4024` is the `PERCENT_PRICE` filter's SELL lower bound, evaluated against **the
venue's own mark price**. Probed live from `testnet.binancefuture.com` (KAITOUSDT: `multiplierDown`
0.9500, tickSize 0.000100, MIN_NOTIONAL 5), the floor reconstructs to six decimals off the venue's
own `markPriceKlines`:

```text
demo mark 1.124900 x 0.95 = 1.068655   (the exact X returned at 13:01:09, 13:01:39, 13:04:40)
demo mark 1.124743 x 0.95 = 1.068506
demo mark 1.123722 x 0.95 = 1.067536
```

Over the same minutes production `KAITOUSDT` traded 1.0642–1.0720 — matching our `ref_price` column
to the tick — on 5m volume of 223k–644k, against the demo book's **281–300**. The demo venue was not
pricing; it was stalled.

**Our reference price was itself below the venue floor on all 12 attempts.** Per-attempt ref-to-floor
shortfall: 10.6, 26.1, 10.8, 23.0, 11.6, 14.5, 27.9, 28.1, 36.8, 38.5, 39.1, 39.4 bps.
`EXIT_CROSS_BUFFER_BPS=25` (`.env.app:198`) therefore accounted for 40–70% of each shortfall — not the
negligible slice a first reading suggested — but removing it entirely would have prevented **zero**
rejects. The buffer is not the bug.

**No venue price-band awareness exists anywhere on the order path.** `SymbolFilters`
(`src/domain/trading/risk/evaluate.ts:16-21`) carries only `tickSize`/`stepSize`/`minQty`/
`minNotional`; `PERCENT_PRICE`/`multiplierDown` appear nowhere in `src/`; and the one price-band gate
that does exist (`evaluate.ts:174-194`) measures deviation against **our own** `refMid`, so a 25 bps
crossed exit passes by construction (25 vs `RISK_MAX_BAND_BPS=100`).

## The three ways this stayed invisible

1. **`protective_exits_total{reason="STOP_LOSS"}` counts fires, not fills.** It read a healthy `12`
   while nothing exited. The cooldown stamp (`protective-exit.service.ts:314-319`) is likewise set on
   FIRE, so a venue reject is invisible to the retry loop — hence 30s forever, no backoff, no cap.
2. **No alert referenced `orders_rejected_total`.** All 22 rules were green throughout.
3. **The venue stop was decorative anyway.** Its trigger (1.0797) was priced off the LIVE feed and
   could never have fired against a demo mark of 1.1249. The 45-minute gap cost less than it looks —
   because the protection it replaced was already notional on this venue split.

## What NOT to ship (a refuted fix, recorded so it is not re-proposed)

The obvious repair — "keep the plan-stop registry row until the exit is accepted" — **is wrong and was
refuted on evidence.** `manageVenueStop` (`agentic.strategy.ts:1532`) lives inside `runActivePlan` and
is gated on `this.activePlan` (`:1243`), **not** on the plan-stop registry, so retaining the row
re-arms nothing. Worse, a retained row (i) still reports `venueStopResting: true` after the venue order
was cancelled, which makes `tickPlanStop`'s stand-down (`protective-exit.service.ts:236-239`) and the
strategy force-band (`:1413-1420`) defer to a stop that does not exist; and (ii) permanently
short-circuits `reconcileOrphanedAlgoStop` at `:2077` ("already adopted this session"), disabling the
`orphan_readopt` path that is the live recovery mechanism on plan-less bars. It also inverts the
invariant `clearPlan`'s own header declares at `:822-824`.

The two seams that are actually correct:

- **defer the algo-stop cancel until the exit is ACKed** — which must first resolve the margin/base-lock
  rationale at `agentic.strategy.ts:1434-1438` and the deliberate fail-open at
  `protective-exit.service.ts:293-299`; or
- **a plan-independent re-arm** that does not depend on `activePlan` at all.

Two further corrections for whoever takes this: the upper-band counterpart of `-4024` is **`-4023`**
("Limit price can't be higher than"), not `-4025`. And a derived bound is preferable to parsing the
venue's error string — `features/venue/market-data/derivatives-feed.service.ts:32-34,:283` already
consumes `markPrice` via ccxt `fetchFundingRate`, so `markPrice × multiplierDown` from `exchangeInfo`
is contract-backed with no brittle regex and no TTL guesswork. Note also that
`error-classifier.ts:81-85` derives `code` from `err.constructor.name` and that value is a live
Prometheus label **and** a snapshot-tested surface — introducing a message-derived code changes both.

## The larger question this raises, which is not a defect

The divergence is **episodic, not a standing offset** — testnet drifts and stalls, then live moves back
to it. Measured at both ends of this trip: 3 bps apart at the 04:30 entry, 21 bps apart at the 16:30
partial exit, 572 bps apart during the stall. So the claim "demo fills and PnL are fictional" is **not**
supported by this incident and must not be asserted from it; it needs its own measurement.

But the program is accumulating promotion evidence — 35 closed round trips, net-of-cost PnL — on a venue
whose book episodically decouples from the tape the strategy reads and whose protective stops are priced
in the wrong frame. **How much of the recorded PnL is attributable to that decoupling is unmeasured, and
measuring it is worth more than any single fix above.** That measurement is proposed as the next pass's
work; the `FEED_ENV` choice itself (real prices for the venue we trade, at the cost of a near-dead book
that would wreck candles and indicators) is a pre-registered decision, not something to flip silently.

## Shipped this pass

Only the visibility gap, because it is the part that was fully understood: `VenueTerminalRejectBurst`
(`observability/alerts.rules.yml`) fires at `severity: warning` on
`sum by (code) (increase(orders_rejected_total{stage="exchange"}[15m])) >= 3` for 5m. Warning is
load-bearing — the sweep promotes only `critical` to a blocking alarm, and this stack already carries a
blocking per-venue reject-RATE alarm. Verified against both known reject axes: the 13:00Z hour spikes to
12 (fires); the binance spot `InsufficientFunds` bleed runs 2/hour (does not).
