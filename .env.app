# Spot lane deploy knobs (docker compose `app` service).
# Secrets live in gitignored .env only — compose loads env_file: [.env.app, .env].


# ── Server ──
PORT=3100
LOG_LEVEL=debug # fatal|error|warn|info|debug|trace
NODE_ENV=production # MUST NOT be test/ci (those force paper + skip the runtime)
# Bind all interfaces so Prometheus (and the published host port) can reach /metrics + /health.
# main.ts defaults to 127.0.0.1 for host runs; the container network is the isolation boundary.
HOST=0.0.0.0

# ── Mode ──
# paper   = internal simulator, no credentials, no network orders
# testnet = orders placed on a Binance sandbox (SANDBOX_ENV picks which)
# live    = real funds — gated (env flag + bootId-bound arming + key probe + limits); do not use
TRADING_MODE=testnet
# Sandbox flavour when TRADING_MODE=testnet:
#   demo    = Binance Demo Trading (demo-api.binance.com, enableDemoTrading)  -> BINANCE_DEMO_*
#   testnet = Binance Spot Testnet (testnet.binance.vision, setSandboxMode)   -> BINANCE_TESTNET_*
SANDBOX_ENV=demo

# Market-data feed venue/environment. 'live' gives realistic depth for fills; order placement still goes to the SANDBOX_ENV venue above.
FEED_ENV=live
# VENUES='[{"id":"binance","environment":"demo"}]'   # optional; default venue is binance
# Push II Phase 8 (futures-demo venue, deploy decision separate from this commit): pointing
# VENUES at binanceusdm/demo (SAME BINANCE_DEMO_* keys above, probe-verified to authenticate
# against demo-fapi.binance.com) turns THIS deployment into the futures-demo lane instead of
# spot — a separate service/stack, never both at once in one process. TRADING_SYMBOLS would
# also need to name the futures market id (e.g. BTC/USDT:USDT), and AGENTIC_SHORTS_ENABLED
# below would need AGENTIC_PLAN_MODE on too (shorts require plan mode + a perp-capable venue).
# VENUES='[{"id":"binanceusdm","environment":"demo"}]'

# Demo Trading keys (used when SANDBOX_ENV=demo). Withdrawals must be disabled.

# Spot Testnet keys (used when SANDBOX_ENV=testnet)

# Live keys — read ONLY when TRADING_MODE=live (stripped under NODE_ENV=test/ci). Leave blank for paper/demo.
# Promoting to live is a deliberate human action behind the four-gate interlock.

# ── Strategy (agentic LLM lane — the only lane; live access is EARNED, not assumed) ──
# Non-deterministic/step-D-uncertifiable: boot interlock refuses TRADING_MODE=live unless
# PromotionReadinessService returns permitted (see PROMOTION.md). No ANTHROPIC_API_KEY = inert stub.
ACTIVE_STRATEGY=agentic
TRADING_SYMBOL=BTC/USDT # DEPRECATED single-symbol fallback (used only when TRADING_SYMBOLS is unset)
# Multi-symbol (P7): CSV, one agentic strategy instance per entry (agentic-1, agentic-2, … in CSV
# order — APPEND new symbols, never reorder: positions/journals key off the instance id). Every
# entry must have a DEFAULT_FILTERS row (domain/risk/default-filters.ts) — asserted loud at boot.
# One shared lane-wide LLM budget; entry caps apply per instance. Each symbol ≈ +96 decides/day
# at 15m — eight symbols ≈ 768/day opportunities, under AGENTIC_MAX_CALLS_PER_DAY=1100 (raised
# 500→700 with the 5-symbol widening so a prescreen fail-open cannot brush the cap and starve
# reflection's budget calls; the $/day breaker stays the true governor). Symbol widening to
# SOL/XRP/LINK: owner decision 2026-07-10 (reports/loop/state.md § Strategic frame); projected
# ~$2.2-2.5/day at current skip rates; fallback = drop LINK on sustained >$3/day. Widened 5→8 (ZEC/AAVE/NEAR) 2026-07-17 per the fired pre-auth (universe-study-2026-07-13, probe-verified on the live demo venue); projected ~$3.5-4/day under the $5 breaker.
# I2 (2026-07-18): 8→24 expansion per the v2 program (Design § Universe). All 16 new pairs
# (BNB DOGE ADA AVAX DOT LTC SUI PEPE WIF TRX SHIB UNI APT ARB OP FIL) live-probe-verified
# 2026-07-18 against api.binance.com exchangeInfo (status TRADING; DEFAULT_FILTERS rows in
# domain/risk/default-filters.ts corrected to the live tick/step/minNotional values in the same
# change — 8 of 16 groundwork estimates were wrong, see that file's header). APPEND-ONLY order
# preserved (agentic-1..8 keep their instance ids; new instances agentic-9..24).
TRADING_SYMBOLS=BTC/USDT,ETH/USDT,SOL/USDT,XRP/USDT,LINK/USDT,ZEC/USDT,AAVE/USDT,NEAR/USDT,BNB/USDT,DOGE/USDT,ADA/USDT,AVAX/USDT,DOT/USDT,LTC/USDT,SUI/USDT,PEPE/USDT,WIF/USDT,TRX/USDT,SHIB/USDT,UNI/USDT,APT/USDT,ARB/USDT,OP/USDT,FIL/USDT
# Universe (U1/I2): top-N active-menu size the deterministic scanner selects daily from the
# 24-symbol basket above (volume × ATR% ranking, rank-18 hysteresis, positioned symbols pinned).
# Idle instances stream candles but cost no LLM calls and hold no positions.
AGENTIC_ACTIVE_MENU_SIZE=12
STRATEGY_INTERVAL=15m # candle interval the agent decides on (schema default 5m; compose pins 15m: 8 symbols × 96/day = 768 opportunities under AGENTIC_MAX_CALLS_PER_DAY=1100; prescreen keeps true calls far lower)
# Anthropic Messages API key for the agent client (secret — never commit a real key). Setting it
# activates the LIVE agentic lane (it starts proposing decisions on each closed candle); leaving it
# blank binds the inert stub, so the demo boots healthy but never trades until a key is supplied.
AGENTIC_MODEL=claude-sonnet-5 # Anthropic model id (schema default; matches the AGENTIC_TOKEN_PRICE_* defaults below)
# Reflection-path model override; unset = reflection uses AGENTIC_MODEL (one model, one price). If
# you pin a pricier model, raise BOTH AGENTIC_TOKEN_PRICE_* knobs to its rates — the flat pricing
# then over-counts the cheaper decide path, which is the fail-closed direction for earned-live.
# Pinned to claude-sonnet-5 (not opus) so the flat AGENTIC_TOKEN_PRICE_* pricing stays honest per
# PROMOTION.md's fail-closed rule; per-model pricing revisit deferred to Stage 2.
# Reflection on the Opus tier (owner decision 2026-07-08: strengthen Tier-2 learning; 1-4
# calls/day ≈ $0.10-0.15 each at 5/25 rates). Per-model pricing below keeps the gate honest.
AGENTIC_REFLECTION_MODEL=claude-opus-4-8
AGENTIC_TIMEOUT_MS=30000 # per-call DECIDE request timeout (Sonnet, fast — fail fast)
# Reflection-path timeout, separate from the decide timeout above. Opus + adaptive thinking over
# the large calibration/attribution prompt cannot answer in 30s — the shared 30s decide timeout
# aborted every live reflection attempt (2026-07-09 "transport error: This operation was aborted"),
# stranding the learning loop at the v1 seed. Reflection is off the trading hot path (detached), so
# 240s is free headroom against Opus worst-case rather than a tight estimate.
AGENTIC_REFLECTION_TIMEOUT_MS=240000
AGENTIC_MAX_TOKENS=4096 # max output tokens per LLM call (1024→4096, v2 decision contract 2026-07-18: richer per-consult output — directives, thesis, portfolio scheduling — needs headroom)
AGENTIC_MIN_DECISION_INTERVAL_MS=0 # floor between agent decisions; 0 = every closed candle
AGENTIC_WARMUP_BARS=340 # closed candles retained; ≥336 keeps h4 (and h1) HTF indicators non-null at 15m — below that the prompt's 1h/4h confluence data is silently null (prompt still slices 50)
AGENTIC_MAX_CALLS_PER_DAY=1100 # DailyLlmBudget cap on LLM calls per UTC day (500→700 at the 5-symbol widening; 700→1100 at the 8-symbol expansion 2026-07-17: 768 bar-opportunities/day must not brush the cap under prescreen fail-open; the $/day breaker stays the true governor)
AGENTIC_MAX_TOKENS_PER_DAY=2000000 # DailyLlmBudget cap on input+output tokens per UTC day
AGENTIC_DAILY_COST_STOP_USD=1.50 # USD cost circuit breaker per UTC day (tokens × per-model AGENTIC_TOKEN_PRICE* rates, cache included post-W13); 5→1.50 (v2 decision contract 2026-07-18, Design § Live-scale economics): book-scale ($1k effective book) cost breaker — LLM spend is part of the loss the model is mandated to minimize; 0 disables
AGENTIC_MAX_ENTRIES_PER_DAY=40 # runaway sanity cap on ENTER decisions per UTC day (12→40, v2 decision contract 2026-07-18: entry cadence is model-owned via sizing/scale-in/scheduling now, this is a safety ceiling, not a target)
AGENTIC_ENTRY_TTL_BARS=2 # stale-entry sweep: resting entries older than N observed decide cycles get a CANCEL_OPEN (risk-reducing); 0 disables
# v2 decision contract (D1/B2, Design § Sizing flow / § New tool contract): per-lane conviction-channel
# cap on sizeFraction, injected into both the trade-tool description and the client's zod schema.
AGENTIC_MAX_POSITION_FRACTION=0.15
# v2 consult scheduler (B2, replaces the deleted prescreen gate): floor re-consult cadence even if
# the model's own nextConsultBars requested a longer gap or the schedule stalls.
AGENTIC_FALLBACK_CONSULT_BARS=16
# v2 consult scheduler (B2): wake-on-move — a bar close whose move vs lastConsultPrice clears this
# fraction forces an immediate re-consult regardless of schedule.
AGENTIC_WAKE_MOVE_PCT=0.015
AGENTIC_PLAN_EXIT_TTL_BARS=2 # TTL (bars) on plan-executor exit signals; 1-bar TTL races its own age (a max_hold exit expired live 2026-07-07 at 902.2s vs 900s)
AGENTIC_DRAIN_COOLDOWN_BASE_MS=30000 # first AUTO-drain cooldown backoff
AGENTIC_DRAIN_COOLDOWN_MAX_MS=900000 # ceiling on AUTO-drain cooldown backoff
AGENTIC_REFLECTION_EVERY_N_TRADES=2 # closed trades between reflection runs, counted PER STRATEGY (reflection.service.ts keys the trigger by strategyId — P7 single-instrument digests). 10→5 owner 2026-07-08: iteration speed is the learning bottleneck; 5→2 loop 2026-07-10: the 5-symbol widening spread trips across agentic-1..5, so per-strategy N=5 slowed the lane-level cadence ~5× — N=2 restores ~the owner's calibrated lane trips-to-trigger; the 6h cooldown + $/day breaker still bound spend; 0 disables
AGENTIC_REFLECTION_COOLDOWN_MS=21600000 # min wall-clock between reflection runs (schema default 7d; demo pins 6h — was 12h; owner 2026-07-08)
AGENTIC_AUTO_PROMOTE_MIN_TRADES=0 # LEGACY count-only auto-promotion DISABLED (owner 2026-07-08): 32 lane-wide trades already satisfied the old ≥30 floor, so the first mint would have gone ACTIVE at 100% of decides with zero candidate evidence — replaced by the attributed evaluator below
AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES=10 # attributed auto-promotion: candidate promotes only after ≥N of ITS OWN A/B-attributed closed trips AND mean net/trip > champion's; since 2026-07-12 the floor is SYMMETRIC (champion needs ≥N in-window trips too); 0 disables
AGENTIC_PROMOTE_MIN_POS=0.70 # probability-of-superiority floor (Mann–Whitney over candidate-vs-champion trip pairs, ties half): promotion also needs PoS ≥ this — a bare mean comparison promoted on noise at n=10 (~50% false-promote under the null; ~25-30% at 0.70)
AGENTIC_CANDIDATE_LAPSE_HOURS=336 # unresolved-candidate lapse (reflection mint guard): a candidate stuck below its attributed-trip floor stops blocking new mints after this many hours (deliberate, logged orphaning). 720→168 (loop-domain, 2026-07-12): at 2-4 possible mints/day a candidate that can't reach 10 trips in a WEEK at 50% traffic is untestable — a 30d block would stall the learning loop on one stuck candidate. 168→336 (owner session 2026-07-17): the lapse exists to clear DEAD candidates — v2 is PARTICIPATING (3/10 attributed, net-positive) and the 168h clock would have discarded it mid-measurement ~07-18 04:45Z; doubled so a live candidate resolves on evidence, not age
AGENTIC_MINT_FLOOR_ROWS=12 # backlog #39 mint-time entry-rate floor: replay a fresh reflection draft against this many of the newest real FLAT-consult payloads (lane-wide) before it may occupy the A/B slot — a candidate that structurally never enters (v2: 0/17 FLAT consults since mint) can never accrue the attributed trips its own promotion verdict needs; 0 disables the floor entirely
AGENTIC_MINT_FLOOR_MIN_ROWS=6 # below this many qualifying FLAT-consult rows the corpus is too young to judge — the floor SKIPS (fail-open, mint proceeds unchecked) rather than blocking an early lane
AGENTIC_MINT_FLOOR_MIN_ENTRIES=1 # floor passes once the replay produces at least this many entries; a failing draft feeds the EXISTING bounded retry-with-feedback (backlog #31), then 'abstain_reject' (rollback, no mint) if the retry also abstains
AGENTIC_ABSTAIN_LAPSE_DECIDES=15 # #39 companion, retro-applies to PRE-floor candidates (v2): an unresolved candidate with ≥ this many attributed real decides and ZERO entries lapses immediately (provably untestable — its verdict clock can never start), unblocking the next mint ahead of the age lapse; 0 disables
AGENTIC_MINT_BACKTEST_ROWS=60 # mint-time candidate-vs-champion offline expectancy backtest: replays this many of the newest recorded rows (any action) against BOTH the draft candidate and the current champion, simulating each 'long' plan over the row's own sparse forward-close path — a verdict prior in hours instead of a weeks-long live A/B; schema default is 0 (off) for any unconfigured deployment, this stack opts in; 0 disables
AGENTIC_MINT_BACKTEST_MARGIN_BPS=10 # noise HANDICAP, not a hurdle: the candidate mints unless its mean net bps/trip trails the champion's by MORE than this (candidate >= champion − margin passes); trailing by more feeds the SAME bounded retry-with-feedback as the floor, then 'expectancy_reject' (rollback, no mint) if the retry also trails
AGENTIC_MINT_BACKTEST_MIN_TRIPS=3 # minimum simulated round trips BOTH arms need before the backtest verdict is trusted; below this the backtest fails open (mint proceeds unbacktested)
AGENTIC_PLAN_MODE=true # W3.1 plan-based trading (submit_plan + deterministic executor); ENABLED by owner 2026-07-07 (offline-A/B pre-check waived by owner; the recorded-input harness remains the post-hoc validator)
# AGENTIC_SHORTS_ENABLED: 'false' # Push II Phase 8 (plan-mode shorts) — schema default is already 'false'; commented out deliberately (deploy decision is a separate step, per owner). Requires a perp-capable venue (VENUES pointed at binanceusdm/demo, see above) — flipping this on a spot-only deployment throws at boot (AnthropicAgentClient's constructor guard).
# AGENTIC_MIN_EDGE_MULTIPLE / AGENTIC_MIN_RR retired 2026-07-18 (v2 cutover): only the fee floor (TP >= round-trip fees) survives.
# AGENTIC_PLAN_MAX_QUIET_BARS retired 2026-07-18 (v2 cutover): superseded by consult schedule + fallback + wake-on-move.
AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS=4 # snapshot the decide payload every Nth plan-managed bar so the offline replay harness accrues rows (plan mode otherwise journals inputPayload null); 0 disables
AGENTIC_VENUE_TP=true # venue-resting take-profit for plan-mode longs (ENABLED 2026-07-13, Push II Phase 2): TP rests at the venue as post-band maker LIMIT GTC — intra-bar touches fill at the exact TP price instead of bar-close detection + IOC taker crossing (bounds study measured +23bps/trade at wide-TP cells). Executor bar-close stop stays the only stop; schema default false
AGENTIC_VENUE_TP_REPLACE_DRIFT_BPS=10 # re-place threshold: a resting TP SELL priced >N bps from the plan's current TP price is cancelled for next-bar re-placement
# AGENTIC_VENUE_STOP: 'true' # Push 3 P7d: venue-resting protective stop lifecycle (spot STOP_LOSS_LIMIT), same rationale as AGENTIC_VENUE_TP above but for the stop leg — commented out, NOT enabled here; schema default false
# AGENTIC_VENUE_STOP_REPLACE_DRIFT_BPS: 10 # re-place threshold, mirrors AGENTIC_VENUE_TP_REPLACE_DRIFT_BPS above
AGENTIC_PLAYBOOK_AB_PCT=40 # W4.1 champion/candidate A/B LIVE (owner 2026-07-08): % of decides routed to the newest INACTIVE reflection candidate for per-version attribution. 50→25 (loop-domain, 2026-07-13 Pass 21): the 50% premise is falsified — v2 entered on 0 of 17 FLAT-state consults since mint (v1: 16/57; P≈0.4% under v1's rate), so serving share cannot create candidate evidence for an abstaining candidate; it only halves the champion entry stream that feeds the symmetric floor, reflection cadence, and the info-context A/B; 0 disables. 25→40 (owner session 2026-07-17): the abstention premise resolved — v2 IS entering (3/10 attributed, net-positive vs the champion), so serving share now buys candidate evidence directly; 40 accelerates the 10-trip verdict while the champion keeps the majority stream
# AGENTIC_EXPECTANCY_LADDER retired 2026-07-18 (v2 cutover): ladder deleted; TRACK_RECORD_* internals remain (no env knob).
# AGENTIC_PRESCREEN_* retired 2026-07-18 (v2 cutover): replaced by consult schedule + AGENTIC_FALLBACK_CONSULT_BARS + AGENTIC_WAKE_MOVE_PCT.
# Optional playbook_version id to pin; leave unset for latest ACTIVE. (No inline comment after an
# empty assignment — compose env_file would deliver the comment text as the value.)
AGENTIC_PLAYBOOK_PIN=
AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK=3 # default-model (claude-sonnet-5) list price: USD per 1M input tokens
AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK=15 # default-model (claude-sonnet-5) list price: USD per 1M output tokens
AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK=0.3 # sonnet-5 cache reads (~0.1x input); was priced $0 — undercounted true spend inside the promotion gate
AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK=6 # sonnet-5 1h-TTL cache writes (~2x input)
# Per-model override map so the Opus reflection path bills at Opus rates (fail-closed: unknown
# models in cost rows price at the most expensive configured rates). Keep in sync with the
# models actually configured above.
AGENTIC_TOKEN_PRICES_JSON={"claude-sonnet-5":{"inputPerMtok":"3","outputPerMtok":"15","cacheReadPerMtok":"0.3","cacheWritePerMtok":"6"},"claude-opus-4-8":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}
# Owner-declared evidence epoch: the promotion gate evaluates round trips / LLM cost / window
# from this instant instead of all-time (owner decision 2026-07-08 — post-fix evidence judges
# the post-fix configuration; the -$18.99 experimentation hole stays visible in Grafana but no
# longer gates promotion). Set to the 2026-07-08 deploy instant, chosen at a FLAT-position
# moment (both agentic strategies were dust-flat) so no round trip straddles the boundary.
# Empty = all-time.
# Moved 2026-07-08T09:52:35Z -> the 2026-07-10 DB-wipe instant (owner-directed, "fix the
# documented items" session): the local ledger restarted empty at the wipe, so the epoch
# formalizes the restart instead of overstating the window with zero-trade days.
# Moved again 2026-07-12 (loop Pass 18 addendum; owner delegated the declaration to the loop
# this session): the wipe left exit-only straddle fills that froze the walk on up to 3 of 5
# symbols (backlog #35/#36) — 08:30:00Z sits inside the verified flat window (lane flat
# 07:45:08Z onward, 0 open orders), erasing every stray. Forfeits 7 RT / -$4.34 over 1.4d.
# Stamped 2026-07-19 at a log-verified FLAT instant (dust-only book, 0 open orders) per the epoch-straddle bound; travels to the GCP lift with NO re-reset.
# step, per Design § Conflict resolutions (both lanes reset together at a verified flat moment).
PROMOTION_EVIDENCE_EPOCH=2026-07-19T18:57:09Z
PROMOTION_DUST_NOTIONAL=5 # residual-position notional (quote ccy) below which a round-trip cycle counts as CLOSED
SIGNAL_TTL_MS=120000 # signal validity window
BASE_NOTIONAL=100 # quote (USDT) per order; keep below the account balance, above minNotional
SIZER_EQUITY_FRACTION=0.04 # 4% of equity per entry (compounding sizing; overrides BASE_NOTIONAL on entries when > 0; schema default 0 disables). 0.02→0.05 applied 2026-07-13 (owner-approved Profitability Push II Phase 1; re-derivation in reports/loop/state.md § Sizing re-derivation 2026-07-13): worst case 5 × ~$250 ≈ $1,248 ≈ 25% of $5k equity; binding cap is RISK_MAX_POSITION_PER_SYMBOL base qty on XRP at 4.3×; expectancy ladder (below) is the reduction-only auto-brake. 0.05→0.04 at the 8-symbol expansion (pre-auth fired 2026-07-17): 8 × 0.04 ⇒ worst case ~0.32 gross vs 0.40 at 0.05 — breadth widened, gross exposure held near the Push II band.
# $1k effective book (v2 decision contract, Design § Live-scale economics, 2026-07-18): sizing
# equity = min(actualEquity, SIZER_EQUITY_CAP) on every sizing path — production capital max ~$1k,
# so demo earns its promotion evidence at exactly live proportions regardless of the $5k demo
# account balance above.
SIZER_EQUITY_CAP=1000
PROTECT_STOP_LOSS_PCT=0.06 # bot-side backstop: force-exits a long via the normal risk path if price falls 6% below entry (0.02→0.06, v2 decision contract 2026-07-18, Design § Conflict resolutions: must sit strictly above the model's own stop-loss upper bound 0.05, or the backstop could fire before the model's own worst-case stop); schema default 0 disables
PROTECT_TRAILING_PCT=0 # bot-side trailing backstop DISABLED (0.015→0, v2 decision contract 2026-07-18, Design § Conflict resolutions: the model owns trailing via revisable stop directives now); schema default 0 disables
PLAN_STOP_WATCH_ENABLED=false # plan-aware 1s stop watcher (Push 3 P2, built 2026-07-13): fires the ACTIVE PLAN's own stop intra-bar via the protective-exit clock instead of waiting for 15m bar close. OFF per the pre-registered stop-slippage study verdict (NOT JUSTIFIED at N=3, mean leak +3.2bps — reports/loop/stop-slippage-2026-07-13.md); loop pre-auth: re-run study at N>=10 stop exits, enable iff criterion met
PLAN_STOP_FORCE_BPS=30 # watcher deep-breach failsafe (bps beyond the plan stop) — force-fires even while a venue-native stop rests unfilled; inert while the watcher flag is off
EXIT_CROSS_BUFFER_BPS=25 # reduce-only IOC exit crossing buffer (bps); must stay below RISK_MAX_BAND_BPS
ENTRY_ORDER_TYPE=LIMIT_MAKER # post-only entries (guaranteed maker or venue-rejected); sizer falls back to plain LIMIT per-intent if the plan-derived price would cross the book. LIMIT was the pre-2026-07-13 default; flipped with Profitability Push II Phase 1 (entries already rest passively in plan mode — this pins the maker fee instead of merely hoping for it)
STARTING_CASH=5000 # in-memory quote balance the bot tracks (set near the demo account's USDT)

# C1: read-only public derivatives-data feed (funding rate, open interest, mark/index basis)
# polled from the USDT-margined perp market, surfaced to the agentic prompt when fresh.
# ENABLED 2026-07-10 (owner program): promptHash gains +d1 from this boot — the enable
# timestamp is the attribution epoch recorded in reports/loop/state.md.
DERIVATIVES_FEED_ENABLED=true
DERIVATIVES_FEED_POLL_MS=60000 # REST poll interval (ms); schema default 60000

# P5b: perp funding-payment settlement ingestion (funding-ingest.service.ts), hourly REST poll
# against binanceusdm fetchFundingHistory, persisted to funding_payments — feeds promotion's
# fundingNet (realized - fees - llmCost + fundingNet) and the agent payload's accrual line.
FUNDING_INGEST_ENABLED=true
FUNDING_INGEST_POLL_MS=3600000 # hourly; funding settles at most 3x/day on Binance USDM
# Derivatives-block A/B (owner-authorized measurement start 2026-07-12): the block has been ON
# lane-globally since the 2026-07-10 enable above with no control arm, so its effect has never
# been measurable. 30% of decides route to a CONTROL arm that withholds the block entirely
# (system sentence, promptHash's +d1 tag, and the payload's derivatives key together) — a ~70/30
# treatment/control split; the offline scorer's existing (playbookVersion, promptHash, symbol)
# grouping picks the two arms apart with zero new scoring code. 0 disables (byte-identical).
# FACTORIAL ENABLE 2026-07-14 (Push 3 P8a): 30→50. Paired with the thinking arm below, this is
# the pre-registered info×thinking 2×2 (reports/loop/state.md § Factorial 2×2). The arms are
# now INDEPENDENT keyed PRFs (Push 3 P1 ab-assignment.ts — they were affine offsets of one
# minute counter, one cell provably empty at 30/30) and each decide row stamps its explicit
# info_arm/thinking_arm (migration 0012, Push 3 P8a-prep), so test/backtest/ab-cells reads
# cells directly. Adoption/harm/cost rules pre-registered; verdict is loop-domain.
AGENTIC_DERIVATIVES_AB_PCT=50
# AGENTIC_THINKING_AB_PCT retired 2026-07-18 (v2 cutover): thinking always on (adaptive) for decide.
# Cross-symbol relative-strength context (2026-07-12): each instance sees where its symbol
# ranks by trailing 20-bar return within the 5-symbol basket — the strongest systematic signal
# in the 2026-07-12 multi-strategy search (cross-sectional momentum). Rides the SAME control
# arm as the derivatives block above (one information-context A/B, +xs1 promptHash tag), so
# the two live arms stay a clean price-only vs price+information contrast.
AGENTIC_CROSS_SYMBOL_ENABLED=true
AGENTIC_CROSS_SYMBOL_LOOKBACK_BARS=20

# Portfolio-consult batching (Push II Phase 5, DESIGN Task 2): coalesces the 5 concurrent
# single-symbol propose() calls (one per agentic-N instance, same bar close) into ONE Anthropic
# call via submit_portfolio (pf1 promptHash tag; consult_id groups the batch's journal rows).
# ENABLED 2026-07-13 after the attribution plumbing (migration 0011) + enable-gate opus review
# (must-fix applied: post-200 schema failures soft-hold the batch, never a correlated strike).
# Shorts+consult is supported since backlog #41 via PORTFOLIO_SHORTS_TOOL (plan.direction per
# element, pf2 tag) — PLAN MODE required; boot still refuses legacy non-plan shorts with
# consult. Rollback = flip to 'false' (byte-identical legacy chain by construction).
AGENTIC_PORTFOLIO_CONSULT=true
AGENTIC_PORTFOLIO_WINDOW_MS=3000

# C4: read-only free news/sentiment feed (headlines only, no numeric scores) polled from
# CryptoPanic, surfaced to the agentic prompt when fresh. Off by default; requires
# SENTIMENT_FEED_API_KEY — a missing key keeps the feed inert even when enabled.
# I2 (2026-07-18): stays OFF — no live CryptoPanic auth_token is held (SENTIMENT_FEED_API_KEY in
# .env.example is an unfilled placeholder, not a real credential); a new external-service signup
# is out of scope for this pass. Follow-up flagged for F2/state.md.
SENTIMENT_FEED_ENABLED=false
SENTIMENT_FEED_POLL_MS=300000 # REST poll interval (ms); schema default 300000
# CryptoPanic auth_token (secret — never commit a real key; free tier).

# Trade-flow/CVD context (2026-07-13): taker aggressor imbalance + rolling CVD, read off a raw
# (unparsed) klines REST poll — ccxt's unified fetchOHLCV/parseOHLCV drops the venue's
# taker-buy-base-volume field unconditionally, so this bypasses it (see trade-flow-feed.ts's
# header comment). Rides the SAME information-context A/B control arm as the derivatives
# block above (AGENTIC_DERIVATIVES_AB_PCT). ENABLED 2026-07-13 (Push II Phase 3) — the
# treatment-arm bundle composition changed on this date (tags +tf1+pos1); attribute the info
# A/B verdict to the bundle-from-now, not the pre-Phase-3 bundle.
AGENTIC_TRADEFLOW_ENABLED=true
AGENTIC_TRADEFLOW_POLL_MS=60000 # REST poll interval (ms); schema default 60000

# Positioning context (2026-07-13): market-wide futures long/short account ratio. Rides the
# same information-context A/B control arm as above; ENABLED 2026-07-13 with tradeFlow (one
# bundle-composition change, one date). Liquidation-order flow is NOT shipped — ccxt 4.5.58
# exposes no public REST source for it (only a private per-account forceOrders endpoint, or a
# WS-only public liquidation stream) — see positioning-feed.ts's header comment.
AGENTIC_POSITIONING_ENABLED=true
AGENTIC_POSITIONING_POLL_MS=300000 # REST poll interval (ms); schema default 300000

# #43 (Push 3 P6 Unit 2): public liquidation-order flow (rolling notional + long/short side-skew)
# via ccxt PRO's watchLiquidationsForSymbols WS stream on binanceusdm — WS-sourced regardless of
# this lane's own trading venue (spot), same rationale as the derivatives/positioning REST feeds
# above. ENABLED 2026-07-18 (v2 decision contract, Design § Enriched model inputs: "Feeds on —
# liquidations + bookStructure + trackRecord").
AGENTIC_LIQUIDATIONS_ENABLED=true
# Book-structure block (Push 3 P6 Unit 3): microprice offset, depth-weighted imbalance, ±25bps
# depth notional — computed from the already-streaming order book, no new feed/cost. ENABLED
# 2026-07-18 (v2 decision contract, Design § Enriched model inputs).
AGENTIC_BOOK_STRUCTURE_ENABLED=true
# Track-record block (Push 3 P6 Unit 4): this strategy's own realized tripCount/winRate/
# meanNetBpsPerTrip/trailingWindowTrips, now also net-vs-BTC-hold and net-vs-basket alpha (P4).
# ENABLED 2026-07-18 (v2 decision contract, Design § Enriched model inputs).
AGENTIC_TRACK_RECORD_ENABLED=true

# ── Risk limits (optional; defaults = the values RiskModule shipped with — override deliberately) ──
RISK_MAX_ORDER_NOTIONAL=500 # quote-notional cap per order (100000→500, v2 decision contract 2026-07-18, Design § Live-scale economics: book-scale envelope for the ~$1k effective book)
RISK_MAX_POSITION_PER_SYMBOL=1000 # base-qty cap per symbol position
RISK_MAX_GROSS_EXPOSURE=1200 # portfolio gross exposure cap (quote) (1000000→1200, v2 decision contract 2026-07-18, Design § Live-scale economics: book-scale envelope)
RISK_MAX_NET_EXPOSURE=1200 # portfolio net exposure cap (quote) (1000000→1200, v2 decision contract 2026-07-18, Design § Live-scale economics: book-scale envelope)
RISK_MAX_DAILY_LOSS=5000 # daily loss kill threshold (quote)
RISK_MAX_DRAWDOWN_PCT=0.2 # peak-to-trough drawdown kill threshold (fraction)
RISK_MAX_BAND_BPS=100 # max limit-price deviation from ref price (bps)
RISK_MAX_PASSIVE_EXIT_BAND_BPS=1200 # passive reduce-only exits only; TP prices legitimately sit far above ref
RISK_STALE_MAX_AGE_MS=5000 # ref-price staleness veto threshold (ms)

# ── Perp/swap paper adapter (B1; PaperPerpAdapter is not wired into app.module.ts yet) ──
PERP_VENUE_ENABLED=false # keep off — scaffolding only this pass
PERP_LEVERAGE_CAP=1 # isolated-margin leverage cap
PERP_MMR_FALLBACK=0.005 # conservative fallback maintenance-margin-rate (1-2x BTC/ETH bracket)
PERP_LIQ_BUFFER_PCT=0.20 # B2: required liq-price buffer a perp entry must clear (fraction)

# ── Persistence (optional; paper/demo run fine with no DB) ──
DATABASE_URL=postgres://cryptobot:cryptobot@postgres:5432/cryptobot

# Grafana admin password for docker-compose (defaults to 'grafana' if unset)
