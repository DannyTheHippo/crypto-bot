# v3 single knob file (docker compose `app` service). Lane files (.env.app-perp) die per the v3
# consolidation program (plans/2026-07-v3-consolidation-spec.md §3/§9) — this is the ONE deploy-knob
# file for the single unified process (both venues, 40-symbol combined basket). Secrets live in
# gitignored .env only — compose loads env_file: [.env.app, .env].
# NOTE (workstream #7 output): the PreToolUse Edit/Write gate on *.env.* paths (and the Read tool's
# own binary-file heuristic on the .env.app path) blocked writing this file directly — see the
# implementer report for the exact tool error. This is the complete intended v3 .env.app content;
# the orchestrator places it at .env.app in the same commit that lands workstream #11's compose
# collapse (single postgres/prometheus/grafana, .env.app-perp deletion) per §10's integration order.

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
# v3 (§1/§3.2): ONE process runs BOTH venues now — spot (binance) and perp (binanceusdm), each its
# own credentialed order client + exchange adapter behind the VenueRuntime composition graph.
# VENUES is REQUIRED outside test/ci and its id set must exactly cover the venues implied by
# TRADING_SYMBOLS below (every :USDT-settle symbol needs a binanceusdm entry and vice versa) —
# environment.config.ts refuses boot on a mismatch. Both venues demo-probe-verified to authenticate
# with the SAME BINANCE_DEMO_* keys (env_file below covers both).
VENUES=[{"id":"binance","environment":"demo"},{"id":"binanceusdm","environment":"demo"}]

# v3 §3.1/§6: fixed wallet split of the one $1k book across the two venues — a demo wallet can never
# be asked for an unfundable order (demo wallets cannot transfer). Keys must exactly equal VENUES'
# ids; every share positive; Σ shares ≤ SIZER_EQUITY_CAP below — environment.config.ts refuses boot
# otherwise. Even split: the model reasons about ONE book (sizeFraction of book equity) while this
# clamps mechanically per venue (§6.2's venueHeadroom clamp).
VENUE_CAPITAL_SPLIT={"binance":"500","binanceusdm":"500"}

# Demo Trading keys (used when SANDBOX_ENV=demo). Withdrawals must be disabled.

# Spot Testnet keys (used when SANDBOX_ENV=testnet)

# Live keys — read ONLY when TRADING_MODE=live (stripped under NODE_ENV=test/ci). Leave blank for paper/demo.
# Promoting to live is a deliberate human action behind the four-gate interlock.

# ── Strategy (agentic LLM lane — the only lane; live access is EARNED, not assumed) ──
# Non-deterministic/step-D-uncertifiable: boot interlock refuses TRADING_MODE=live unless
# PromotionReadinessService returns permitted (see PROMOTION.md). No ANTHROPIC_API_KEY = inert stub.
ACTIVE_STRATEGY=agentic
# v3 (§3.4): TRADING_SYMBOL (the legacy single-symbol fallback) is DELETED — TRADING_SYMBOLS is
# required. Multi-symbol (P7): CSV, one agentic strategy instance per entry (agentic-1, agentic-2, …
# in CSV order — APPEND new symbols, never reorder: positions/journals key off the instance id).
# Every entry must have a DEFAULT_FILTERS row (domain/risk/default-filters.ts) — asserted loud at
# boot. v3 §3.2 basket = the 24 spot symbols carried from the pre-v3 .env.app (I2 2026-07-18
# expansion, all live-probe-verified against api.binance.com exchangeInfo) + the 16 perps from spec
# §5.4 (8 stage-1 live-verified + 3 stage-2 reserve + 5 provisional next-by-recipe — §5.4's binding
# procedure re-runs the ranking + keyed-probes all 16 on demo-fapi at cutover implementation time;
# the procedure, not the provisional names, is authoritative).
TRADING_SYMBOLS=BTC/USDT,ETH/USDT,SOL/USDT,XRP/USDT,LINK/USDT,ZEC/USDT,AAVE/USDT,NEAR/USDT,BNB/USDT,DOGE/USDT,ADA/USDT,AVAX/USDT,DOT/USDT,LTC/USDT,SUI/USDT,PEPE/USDT,WIF/USDT,TRX/USDT,SHIB/USDT,UNI/USDT,APT/USDT,ARB/USDT,OP/USDT,FIL/USDT,BTC/USDT:USDT,ETH/USDT:USDT,SOL/USDT:USDT,ZEC/USDT:USDT,AAVE/USDT:USDT,NEAR/USDT:USDT,HYPE/USDT:USDT,KAITO/USDT:USDT,TRUMP/USDT:USDT,UNI/USDT:USDT,BCH/USDT:USDT,XRP/USDT:USDT,LINK/USDT:USDT,AVAX/USDT:USDT,SUI/USDT:USDT,LTC/USDT:USDT
# Universe (U1/v3 §5.2): top-N active-menu size the deterministic scanner selects daily from the
# COMBINED 40-symbol basket above (volume × ATR% ranking, rank-12 hysteresis, positioned symbols
# pinned, venue floor ≥2-per-venue — §5.3). v3 collapses the two lane-split menu sizes (12 spot / 4
# perp) into one combined menu; schema default is now 8 (§5.2's starvation-check arithmetic clears
# the ≥2.14 closed-trips/day promotion pace with headroom while staying inside the $3/day breaker).
AGENTIC_ACTIVE_MENU_SIZE=8
STRATEGY_INTERVAL=15m # candle interval the agent decides on (schema default 5m; this stack pins 15m)
# Anthropic Messages API key for the agent client (secret — never commit a real key). Setting it
# activates the LIVE agentic lane (it starts proposing decisions on each closed candle); leaving it
# blank binds the inert stub, so the demo boots healthy but never trades until a key is supplied.
AGENTIC_MODEL=claude-sonnet-5 # Anthropic model id (schema default; matches the AGENTIC_TOKEN_PRICE_* defaults below)
# The in-process reflection loop was DELETED 2026-07-30 (research/studies/
# entry-rate-rederivation-2026-07-30.md), so no call path runs this model anymore. The knob stays
# set on purpose: it is what keeps environment.config.ts's superRefine demanding a claude-opus-5
# entry in AGENTIC_TOKEN_PRICES_JSON below, and PromotionReadinessService re-prices the historical
# Opus llm_usage rows (all 69 of them) through that map every time the earned-live gate runs.
# Unsetting it would let the map's Opus entry be dropped later and silently under-count that spend.
AGENTIC_REFLECTION_MODEL=claude-opus-5
AGENTIC_TIMEOUT_MS=90000 # per-call DECIDE request timeout. v3 soak defect #3 (2026-07-21): 30s was
# calibrated for v2's single-symbol decide; the v3 menu-8 batched submit_portfolio call measures
# 20-35s (avg 24.1s, decide-latency histogram) and the 30s abort killed 15 of the first 16 consult
# attempts as transport-RETRYABLE. 90s = ~3x the measured shape, still <=10% of a 15m bar so a
# wedged call cannot eat the retry window — the fail-fast intent survives at batched scale.
AGENTIC_MAX_TOKENS=4096 # max output tokens per LLM call (schema default; v2 rich decision contract — directives, thesis, portfolio scheduling — needs headroom)
AGENTIC_MIN_DECISION_INTERVAL_MS=0 # floor between agent decisions; 0 = every closed candle
AGENTIC_WARMUP_BARS=340 # closed candles retained; ≥336 keeps h4 (and h1) HTF indicators non-null at 15m
# v3 §3.3: the two lane-split budgets (spot 1100/1.50/2M + perp 1100/1.50/2M) merge into ONE
# book-wide budget — schema defaults now match this deployed shape directly.
AGENTIC_MAX_CALLS_PER_DAY=2000 # DailyLlmBudget cap on LLM calls per UTC day (schema default; two lane caps merged)
AGENTIC_MAX_TOKENS_PER_DAY=4000000 # DailyLlmBudget cap on input+output tokens per UTC day (schema default; two lane caps merged)
AGENTIC_DAILY_COST_STOP_USD=3 # USD cost circuit breaker per UTC day (schema default; ONE unified book budget — v3 §5.2's cost arithmetic: menu-8 × 16 wakes ≈ $2.40/day ≤ $3); 0 disables
AGENTIC_MAX_ENTRIES_PER_DAY=40 # runaway sanity cap on ENTER decisions per UTC day — a safety ceiling, not a target (entry cadence is model-owned via sizing/scale-in/scheduling)
AGENTIC_ENTRY_TTL_BARS=2 # stale-entry sweep: resting entries older than N observed decide cycles get a CANCEL_OPEN (risk-reducing); 0 disables
# v3 §3.1/§3.3: AGENTIC_MAX_POSITION_FRACTION is renamed to the two per-venue-class knobs below — the
# two lane-split values (spot 0.15 / perp 0.35) survive AS-IS, now both live in one process and are
# enforced per-symbol via the payload's capabilities.maxSizeFraction (§4.2) instead of per-lane.
AGENTIC_MAX_POSITION_FRACTION_SPOT=0.15
AGENTIC_MAX_POSITION_FRACTION_PERP=0.35 # X2 2026-07-20: multi-position perp book (0.50 was single-symbol); RISK gross/net 1200 is the binding portfolio cap
# v2 consult scheduler (B2, replaces the deleted prescreen gate): floor re-consult cadence even if
# the model's own nextConsultBars requested a longer gap or the schedule stalls.
AGENTIC_FALLBACK_CONSULT_BARS=8 # XA1 2026-07-20: 16 (4h) starved evidence pace — 2h floor (schema default)
# v2 consult scheduler (B2): wake-on-move — a bar close whose move vs lastConsultPrice clears this
# fraction forces an immediate re-consult regardless of schedule.
AGENTIC_WAKE_MOVE_PCT=0.008 # XA1 2026-07-20: 1.5% never fires in the dominant sub-0.5% chop regime (schema default)
AGENTIC_PLAN_EXIT_TTL_BARS=2 # TTL (bars) on plan-executor exit signals; 1-bar TTL races its own age (a max_hold exit expired live 2026-07-07 at 902.2s vs 900s)
AGENTIC_DRAIN_COOLDOWN_BASE_MS=30000 # first AUTO-drain cooldown backoff
AGENTIC_DRAIN_COOLDOWN_MAX_MS=900000 # ceiling on AUTO-drain cooldown backoff
# AGENTIC_REFLECTION_EVERY_N_TRADES / _COOLDOWN_MS DELETED 2026-07-30 along with reflection.service.ts
# itself (research/studies/entry-rate-rederivation-2026-07-30.md: claude-opus-5 at $5.01 of $16.79
# total LLM spend bought 4 mints from 18 attempts across 69 calls, off ONE strategy's newest 200
# journal rows). `pnpm playbook:candidate` — which reads the whole DB for free — is the ONLY minting
# path now. Both knobs still carry zod defaults, but nothing reads them.
# AGENTIC_AUTO_PROMOTE_MIN_TRADES DELETED (§3.4): the legacy count-only auto-promotion path is gone —
# AppConfig.agentic.autoPromoteMinTrades is now a hardcoded-0 transitional field, not an env knob.
AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES=10 # attributed auto-promotion: candidate promotes only after ≥N of ITS OWN A/B-attributed closed trips AND mean net/trip > champion's (SYMMETRIC: champion needs ≥N in-window trips too); 0 disables
AGENTIC_PROMOTE_MIN_POS=0.70 # probability-of-superiority floor (Mann–Whitney over candidate-vs-champion trip pairs, ties half): promotion also needs PoS ≥ this
# AGENTIC_CANDIDATE_LAPSE_HOURS (unresolved-candidate lapse — no schema entry, read off raw
# process.env by scripts/playbook-candidate.mjs, which `pnpm playbook:candidate` loads this file
# into via --env-file-if-exists): spot lane's 336h carried forward as the single book's value
# (owner session 2026-07-17: doubled from 168h so a live, evidence-participating
# candidate resolves on evidence, not age). The perp lane ran 168h separately pre-cutover; both
# lanes converge on one candidate lineage now (§1.3's AgenticBridgeModule, one playbook lineage), so
# only one lapse clock exists post-cutover.
AGENTIC_CANDIDATE_LAPSE_HOURS=336
# AGENTIC_MINT_FLOOR_ROWS / _MIN_ROWS / _MIN_ENTRIES and AGENTIC_MINT_BACKTEST_ROWS / _MARGIN_BPS /
# _MIN_TRIPS DELETED 2026-07-30: both mint-time gates were reflection-only (measureEntryRate and
# runCandidateBacktest each had exactly one caller, reflection.service.ts) and went with it.
AGENTIC_ABSTAIN_LAPSE_DECIDES=15 # STILL LIVE — read by scripts/playbook-candidate.mjs: an unresolved candidate with ≥ this many attributed real decides and ZERO entries lapses immediately; 0 disables
# v3 §3.2 default: true — the only deployed shape (schema default flips false→true). Plan-based
# trading (submit_plan + deterministic executor) is required for shorts and the venue-resting
# TP/stop rails below — environment.config.ts refuses AGENTIC_PLAN_MODE=false whenever any perp
# symbol is configured in TRADING_SYMBOLS (§3.5), which this basket always has.
AGENTIC_PLAN_MODE=true
# AGENTIC_SHORTS_ENABLED DELETED (§3.4): shorts is now a per-symbol capability derived from venue
# presence (VENUES containing binanceusdm), not a boot flag — every perp symbol above gets
# capabilities.shorts=true (§4.2) automatically; spot symbols stay shorts=false.
# AGENTIC_MIN_EDGE_MULTIPLE / AGENTIC_MIN_RR retired 2026-07-18 (v2 cutover): only the fee floor (TP >= round-trip fees) survives.
# AGENTIC_PLAN_MAX_QUIET_BARS retired 2026-07-18 (v2 cutover): superseded by consult schedule + fallback + wake-on-move.
AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS=4 # snapshot the decide payload every Nth plan-managed bar so the offline replay harness accrues rows; 0 disables
# v3 §3.2 default: true — the only deployed shape (schema default flips false→true). The v2
# "both TP+STOP only if all venues perp" refusal is RETIRED (§3.5) — mixed-venue boots are the v3
# norm; a per-symbol rule (perp rests both legs, spot rests TP-only) lives in the strategy lane now.
AGENTIC_VENUE_TP=true # venue-resting take-profit for plan-mode longs
AGENTIC_VENUE_TP_REPLACE_DRIFT_BPS=10 # re-place threshold: a resting TP SELL priced >N bps from the plan's current TP price is cancelled for next-bar re-placement
AGENTIC_VENUE_STOP=true # venue-resting protective stop (spot: STOP_LOSS_LIMIT; perp: STOP_MARKET algo rail) — schema default flips false→true in v3
AGENTIC_VENUE_STOP_REPLACE_DRIFT_BPS=10 # re-place threshold, mirrors AGENTIC_VENUE_TP_REPLACE_DRIFT_BPS above
# v3 unification note: spot ran AB_PCT=40 (2026-07-17 owner session), perp ran AB_PCT=25 separately.
# One playbook lineage now (§1.3) — carrying the spot lane's more-recently-tuned value forward as
# the single book's routing share (loop-domain tuning decision, decide+apply+record per the
# crypto-bot autonomy policy; not safety-critical — re-tune from evidence post-cutover if warranted).
AGENTIC_PLAYBOOK_AB_PCT=40 # W4.1 champion/candidate A/B: % of decides routed to the newest INACTIVE reflection candidate for per-version attribution; 0 disables
# AGENTIC_EXPECTANCY_LADDER retired 2026-07-18 (v2 cutover): ladder deleted; TRACK_RECORD_* internals remain (no env knob).
# AGENTIC_PRESCREEN_* retired 2026-07-18 (v2 cutover): replaced by consult schedule + AGENTIC_FALLBACK_CONSULT_BARS + AGENTIC_WAKE_MOVE_PCT.
# Optional playbook_version id to pin; leave unset for latest ACTIVE. (No inline comment after an
# empty assignment — compose env_file would deliver the comment text as the value.)
AGENTIC_PLAYBOOK_PIN=
AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK=3 # default-model (claude-sonnet-5) list price: USD per 1M input tokens
AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK=15 # default-model (claude-sonnet-5) list price: USD per 1M output tokens
AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK=0.3 # sonnet-5 cache reads (~0.1x input)
AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK=6 # sonnet-5 1h-TTL cache writes (~2x input)
# Per-model override map so the Opus reflection path bills at Opus rates (fail-closed: unknown
# models in cost rows price at the most expensive configured rates).
AGENTIC_TOKEN_PRICES_JSON={"claude-sonnet-5":{"inputPerMtok":"3","outputPerMtok":"15","cacheReadPerMtok":"0.3","cacheWritePerMtok":"6"},"claude-opus-5":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}
# v3 §3.2/§3.3: ONE evidence epoch (the two v2 lane-split epochs — spot 2026-07-20T09:36:00Z, perp
# 2026-07-20T10:42:00Z — collapsed at the v3 cutover). Stamped 2026-07-21T11:21:00Z at the
# log-verified flat instant: fresh greenfield DB, both venues reconciling CLEAN
# (reconciliation_runs_total{venue,result} all clean), zero positions/open orders, kill switch
# RUNNING (state.md cutover record 2026-07-21). The promotion scoreboard walks only post-stamp
# evidence over the ONE unified book.
PROMOTION_EVIDENCE_EPOCH=2026-07-21T11:21:00Z # v3 cutover epoch — stamped at the verified-flat instant, see comment above
PROMOTION_DUST_NOTIONAL=5 # residual-position notional (quote ccy) below which a round-trip cycle counts as CLOSED
SIGNAL_TTL_MS=120000 # signal validity window
BASE_NOTIONAL=100 # quote (USDT) per order; keep below the account balance, above minNotional
# v3 §3.3: the two lane-split values (spot 0.04 / perp 0.05) collapse to ONE — spot's more
# conservative value wins (spec's explicit call: sizeFraction is the active conviction channel
# anyway, so this legacy equity-fraction path staying conservative costs nothing).
SIZER_EQUITY_FRACTION=0.04 # 4% of equity per entry (compounding sizing; overrides BASE_NOTIONAL on entries when > 0; schema default 0 disables)
# $1k effective book (v2 decision contract, Design § Live-scale economics): sizing equity =
# min(actualEquity, this cap) on every sizing path — production capital max ~$1k. v3 §3.2: now the
# schema DEFAULT (was optional/uncapped); explicit '0' still disables the cap.
SIZER_EQUITY_CAP=1000
# Profitability Edge Program: aggregate planned-stop entry risk cap — max same-side cost notional =
# cappedEquity × fraction / Signal.stopLossPct (held |qty|×avgEntry + reserved + proposed). Schema
# default 0 disables; byte-identical when Signal.stopLossPct is also absent.
SIZER_MAX_PLANNED_STOP_RISK_FRACTION=0.01
PROTECT_STOP_LOSS_PCT=0.06 # bot-side backstop: force-exits via the normal risk path if price falls 6% below entry (must sit strictly above the model's own stop-loss upper bound 0.05); schema default 0 disables
PROTECT_TRAILING_PCT=0 # bot-side trailing backstop DISABLED (the model owns trailing via revisable stop directives now); schema default 0 disables
PLAN_STOP_WATCH_ENABLED=false # plan-aware 1s stop watcher — OFF per the pre-registered stop-slippage study verdict (NOT JUSTIFIED at N=3, mean leak +3.2bps — reports/loop/stop-slippage-2026-07-13.md)
PLAN_STOP_FORCE_BPS=30 # watcher deep-breach failsafe (bps beyond the plan stop); inert while the watcher flag is off
EXIT_CROSS_BUFFER_BPS=25 # reduce-only IOC exit crossing buffer (bps); must stay below RISK_MAX_BAND_BPS
ENTRY_ORDER_TYPE=LIMIT_MAKER # post-only entries (guaranteed maker or venue-rejected); sizer falls back to plain LIMIT per-intent if the plan-derived price would cross the book
STARTING_CASH=5000 # in-memory quote balance the bot tracks (set near the demo account's USDT)

# C1: read-only public derivatives-data feed (funding rate, open interest, mark/index basis)
# polled from the USDT-margined perp market, surfaced to the agentic prompt when fresh.
DERIVATIVES_FEED_ENABLED=true
DERIVATIVES_FEED_POLL_MS=60000 # REST poll interval (ms); schema default 60000

# P5b: perp funding-payment settlement ingestion (funding-ingest.service.ts), hourly REST poll
# against binanceusdm fetchFundingHistory, persisted to funding_payments — feeds promotion's
# fundingNet and the agent payload's accrual line. Now the PRIMARY (not secondary) lane for this
# feed since the perp venue is wired directly into this one process (v3 §1).
FUNDING_INGEST_ENABLED=true
FUNDING_INGEST_POLL_MS=3600000 # hourly; funding settles at most 3x/day on Binance USDM
# AGENTIC_DERIVATIVES_AB_PCT DELETED (§3.4, XA3 2026-07-20 decision record): the information-context
# control arm is retired at 0 for good — treatment drove 8.4% vs 1.9% proposes; every consult gets
# the full info bundle now. AppConfig.agentic.derivativesAbPct is a hardcoded-0 transitional field.
# AGENTIC_THINKING_AB_PCT retired 2026-07-18 (v2 cutover): thinking always on (adaptive) for decide.
# Cross-symbol relative-strength context (2026-07-12): each instance sees where its symbol ranks by
# trailing 20-bar return within the combined basket.
AGENTIC_CROSS_SYMBOL_ENABLED=true
AGENTIC_CROSS_SYMBOL_LOOKBACK_BARS=20

# Portfolio-consult batching (Push II Phase 5, DESIGN Task 2): coalesces concurrent single-symbol
# propose() calls (one per active-menu instance, same bar close) into ONE Anthropic call via
# submit_portfolio. Rollback = flip to 'false' (byte-identical legacy chain by construction).
AGENTIC_PORTFOLIO_CONSULT=true
AGENTIC_PORTFOLIO_WINDOW_MS=15000 # XA1 2026-07-20: 3s fragmented the menu wave into multiple API calls; 15s + menu-sized early-flush coalesces

# C4: read-only free news/sentiment feed (headlines only, no numeric scores) polled from
# CryptoPanic, surfaced to the agentic prompt when fresh. Stays OFF — no live CryptoPanic
# auth_token is held (SENTIMENT_FEED_API_KEY in .env.example is an unfilled placeholder).
SENTIMENT_FEED_ENABLED=false
FEAR_GREED_FEED_ENABLED=true # X3 2026-07-20: lane-wide alternative.me index, keyless, fail-open (6h poll default); modulator-not-veto per XA3
SENTIMENT_FEED_POLL_MS=300000 # REST poll interval (ms); schema default 300000
# CryptoPanic auth_token (secret — never commit a real key; free tier).

# Trade-flow/CVD context (2026-07-13): taker aggressor imbalance + rolling CVD, read off a raw
# (unparsed) klines REST poll.
AGENTIC_TRADEFLOW_ENABLED=true
AGENTIC_TRADEFLOW_POLL_MS=60000 # REST poll interval (ms); schema default 60000

# Positioning context (2026-07-13): market-wide futures long/short account ratio.
AGENTIC_POSITIONING_ENABLED=true
AGENTIC_POSITIONING_POLL_MS=300000 # REST poll interval (ms); schema default 300000

# #43 (Push 3 P6 Unit 2): public liquidation-order flow (rolling notional + long/short side-skew)
# via ccxt PRO's watchLiquidationsForSymbols WS stream on binanceusdm.
AGENTIC_LIQUIDATIONS_ENABLED=true
# Book-structure block (Push 3 P6 Unit 3): microprice offset, depth-weighted imbalance, ±25bps
# depth notional — computed from the already-streaming order book, no new feed/cost.
AGENTIC_BOOK_STRUCTURE_ENABLED=true
# Track-record block (Push 3 P6 Unit 4): this strategy's own realized tripCount/winRate/
# meanNetBpsPerTrip/trailingWindowTrips, also net-vs-BTC-hold and net-vs-basket alpha.
AGENTIC_TRACK_RECORD_ENABLED=true
# Owner override 2026-07-24: deploy residual20-volbeta EdgePolicy in demo
AGENTIC_EDGE_POLICY_ENABLED=true
AGENTIC_EDGE_POLICY_FAMILY=residual20-volbeta
# Plan-authoritative exits (2026-07-30): once a plan is declared at entry its declared
# stopLossPct/takeProfitPct/maxHoldBars own the exit, and a later mid-trade 'close' from the model
# is dropped. Reproduces the exit-attribution study's Arm 2 (+29.7 bps/trip over the discretionary
# Arm 1's -108.1 bps across 23 recorded round trips) — changes NO geometry, and does not reopen the
# settled exit-rule sweep. SHIPPED FLAG-OFF: the enable is a separate config-only step with its own
# WATCH line (research/loop/verdicts.md, 2026-07-30 entry).
AGENTIC_PLAN_AUTHORITATIVE_EXITS=true

# ── Risk limits (v3 §3.2: re-defaulted to the $1k-book scale — the deployed v2-contract values were
# pre-$1k-book drift; schema defaults now match this deployed shape directly) ──
RISK_MAX_ORDER_NOTIONAL=400 # quote-notional cap per order (schema default; book-scale envelope for the ~$1k effective book)
RISK_MAX_POSITION_PER_SYMBOL=350 # base-qty cap per symbol position (schema default)
RISK_MAX_GROSS_EXPOSURE=1200 # portfolio gross exposure cap (quote) (schema default; book-scale envelope)
RISK_MAX_NET_EXPOSURE=1200 # portfolio net exposure cap (quote) (schema default; book-scale envelope)
RISK_MAX_DAILY_LOSS=50 # daily loss kill threshold (quote) (schema default; book-scale envelope)
RISK_MAX_DRAWDOWN_PCT=0.2 # peak-to-trough drawdown kill threshold (fraction)
RISK_MAX_BAND_BPS=100 # max limit-price deviation from ref price (bps)
RISK_MAX_PASSIVE_EXIT_BAND_BPS=1200 # passive reduce-only exits only; TP prices legitimately sit far above ref
RISK_STALE_MAX_AGE_MS=5000 # ref-price staleness veto threshold (ms)

# ── Perp/swap mechanics (bind to perp-venue symbols only — VENUES/TRADING_SYMBOLS above) ──
# PERP_VENUE_ENABLED DELETED (§3.4): venue presence in VENUES is the signal now.
PERP_LEVERAGE_CAP=5 # isolated-margin leverage cap. Owner decision 2026-07-27 supersedes round 6's 2x.
# Re-derived 2026-07-27 from live venue truth: fetchMarketLeverageTiers over all 16 configured perp
# symbols gives a worst-case lowest-bracket MMR of 0.02 (TRUMP/USDT:USDT and SUI/USDT:USDT). The old
# 0.005 was a 1-2x BTC/ETH-bracket figure and understated the deployed basket by 4x — tolerable at the
# 2x cap (slack 0.495), not at 5x (slack 0.18). Flat worst-case, not per-symbol: real per-symbol tiers
# stay deferred tech debt.
PERP_MMR_FALLBACK=0.02 # measured worst-case maintenance-margin-rate across the live perp basket
# Owner decision 2026-07-27: 0.20 -> 0.15, a deliberate reduction in the minimum acceptable
# liquidation cushion, taken to admit the 5x cap. Check: 1/5 - 0.02 = 0.18 >= 0.15, 3pp of headroom.
# environment.config.ts now REFUSES BOOT on any leverage/MMR/buffer triple that zeroes
# liqSafeNotionalCap, so this class of silent zero-size-entry misconfiguration cannot recur.
PERP_LIQ_BUFFER_PCT=0.15 # B2: required liq-price buffer a perp entry must clear (fraction)

# ── Persistence (v3 §9: single postgres service — the lane-split postgres/postgres-perp pair
# collapses into one, matching the single unified process above) ──
DATABASE_URL=postgres://cryptobot:cryptobot@postgres:5432/cryptobot

# Grafana admin password for docker-compose (defaults to 'grafana' if unset)
