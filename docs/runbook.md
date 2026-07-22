# crypto-bot Operations Runbook (v3)

Operational procedures for the named incident classes: **halt**, **reconciliation mismatch**,
**re-arm**, and **paper-honesty**, plus deploy / backup / promotion for the post-cutover stack.
Procedures reflect the implemented one-book behavior (2026-07-21 v3 cutover). Items marked
_(out-of-session)_ are verified only against a live/testnet venue and have not been exercised as a
running process in CI.

> Cardinal invariant: **paper is the default and live is gated by four independent gates.** Nothing
> in CI can reach live (see §Paper-honesty). When in doubt, the safe state is HALTED in paper mode.

**v3 topology.** One Nest process runs both venues (`binance` spot + `binanceusdm` USDM) against one
Postgres and one Prometheus. Deploy knobs live in committed `.env.app`; secrets in gitignored
`.env`. Promotion evidence is counted since `PROMOTION_EVIDENCE_EPOCH` (stamped at cutover in
`.env.app`). The former compose `perp` profile / `app-perp` / `postgres-perp` / `prometheus-perp`
topology was deleted at cutover — do not bring it back.

## Deploy / stack

Exactly four containers (`docker-compose.yml`): `app`, `postgres`, `prometheus`, `grafana`. No
compose profiles.

| Service      | Host port | Notes                                      |
| ------------ | --------- | ------------------------------------------ |
| `app`        | 3100      | `/health/live`, `/health/ready`, `/metrics` |
| `postgres`   | 5432      | DB `cryptobot`; volume `postgres_data_v3`  |
| `prometheus` | 9090      | TSDB volume `prometheus_data_v3`           |
| `grafana`    | 3101      | dashboards + alerts UI                     |

- Compose `env_file: [.env.app, .env]` — later file wins (secrets override knobs). The only inline
  `environment:` on `app` is `NODE_OPTIONS=--max-old-space-size=1024` (heap cap, not a zod knob).
- App hard ceiling: `mem_limit: 1536m` (alert `AppMemoryHigh` pages before OOM).
- Greenfield volumes: `postgres_data_v3` / `prometheus_data_v3` — do not reattach v2 volume names.
- Deploy after a code/knob change:

```sh
docker compose build app && docker compose up -d app
```

- Host `pnpm start`: `AppConfigModule` loads `envFilePath: ['.env', '.env.app']` — first path wins
  (same effective precedence as compose). Test/CI: `ignoreEnvFile: true`.
- Standing sync rule: deploy knob changes go to `.env.app`, the zod schema in
  `environment.config.ts`, and docs — not inline compose `environment:` blocks. Secrets template
  stays in `.env.example` only. `VAR=` means UNSET; never put an inline comment after an empty
  assignment.

## Kill-switch state machine

`RUNNING → HALTING → HALTED`, with `(HALTING → FLATTENING → HALTED)` when flatten is requested, plus
`HALTED_DEGRADED`. Engage sources: equity monitors (daily-loss / `MAX_DRAWDOWN`), reconciliation
mismatch, OMS anomalies (unknown-resolver), rate runaway, ModeControl downgrades (8h arm-TTL expiry,
key-probe failure), fill conflicts.

- **HALTING**: cancel-all issued once; all non-flatten intents refused. Cancels confirmed ⇒ HALTED
  (or FLATTENING if flatten was requested). Cancels unconfirmed within 10s ⇒ **HALTED_DEGRADED + page**
  (orders may still be live; reconciliation keeps polling).
- **FLATTENING** (per-reason: default **true for `MAX_DRAWDOWN`, false for `RECONCILE_MISMATCH`**):
  reduce-only marketable limits at the band edge, sliced through the normal Risk pipeline, one slice
  per non-busy position (stacking guard). `ALL_FLAT` when every `|position| < exchange minQty` ⇒
  HALTED.
- **Fills are facts, not requests**: the OMS ingests fills in EVERY state including HALTED. Risk gates
  submissions, never fill ingestion.
- **Disengage** is driven by `RecoveryCoordinatorService` when auto-resume is enabled (see
  Recovery / disengage below). There is no HTTP `/resume` admin API. Live arming state is **not**
  restored by a resume — re-arm is required.

Ops signals: Prometheus gauge `kill_switch_state{state=...}` (active state = 1), structured event
`killswitch.transition`, and the append-only audit trail. Alert name `KillSwitchEngaged` pages on
any non-RUNNING state.

<a id="halt-response"></a>

### Halt response

1. Identify the engage reason from the structured log / `killswitch.transition` + audit trail, and
   confirm via `kill_switch_state{state!=RUNNING}`.
2. If `HALTED_DEGRADED`: assume orders may be live at the venue. Do NOT treat the episode as settled.
   Drive reconciliation (§Reconciliation mismatch) until the venue/local order sets agree, then
   manually cancel any residual venue orders out-of-band before expecting a clean auto-resume (or a
   process restart on live).
3. If `FLATTENING` stalls (a position cannot be reduced — e.g. a v1 short, sub-minNotional dust, or no
   venue filter): it is treated as residual dust and counts toward `ALL_FLAT` so the episode converges;
   surface the residue via reconciliation balance drift and clear it manually.
4. After RUNNING is restored (auto-resume or restart), confirm the root cause is resolved before
   considering live re-arm. Resume clears the kill switch to RUNNING but does NOT re-arm live (you
   arm last).

### Recovery / disengage

`RecoveryCoordinatorService` is the sole caller of `KillSwitchPort.resume()`. Schema default
`RECOVERY_AUTO_RESUME_ENABLED=true` (unset in `.env.app` ⇒ default on). Set
`RECOVERY_AUTO_RESUME_ENABLED=false` to reproduce manual-only behavior (stay halted until process
restart).

While `HALTED` / `HALTED_DEGRADED`, every 1s tick re-evaluates fail-closed preconditions
unconditionally (not keyed off the current reason string alone):

- no unresolved `*_UNKNOWN` / `RECONCILE_REQUIRED` orders (`CrashRecoveryService.hasUnresolvedOrders`)
- a reconciliation pass that is both fresh (`cleanWithin`) **and** post-halt (`cleanAfter`)
- equity monitor reports both `MAX_DRAWDOWN` and `DAILY_LOSS` causes cleared
- debounce: consecutive clean evaluations required before resume
- unrecognized halt causes never auto-resume

On resume: warn log, `recovery_auto_resume_total{reason}`, and ops event `recovery.auto_resume`.
Resume returns an already-authorized mode's kill switch to RUNNING — it never touches the four live
gates, the bootId-bound arming ceremony, or `PromotionReadinessService`.

**Live operational reality.** Authorization scope includes live, but the scheduled reconcile cadence
runs only for `paper` / `testnet` today. With no live reconcile passes, `cleanWithin` / `cleanAfter`
stay false, so auto-resume is fail-closed-inert on live. A live HALT is cleared by **process
restart** until a live reconcile scheduler lands.

<a id="reconciliation-mismatch-64"></a>

## Reconciliation mismatch (§6.4)

Reconciliation **HALTs and NEVER auto-flattens** — local truth is suspect on a mismatch, and blind
flattening on wrong state can double the damage. Passes are **per-venue**
(`reconciliation_runs_total{venue,result}`). Mismatch taxonomy and response:

- **UNKNOWN_OURS open order** (our clientOrderId prefix, unknown locally) ⇒ HALT, no auto-cancel.
  Investigate: was it placed by a prior boot? Query by clientOrderId, reconcile intent history, cancel
  manually if confirmed orphaned.
- **FILL_FOR_UNKNOWN_ORDER** (a trade for an our-prefix order unknown locally) ⇒ HALT. A fill happened
  the OMS never recorded — reconcile the position before any further trading.
- **BALANCE_DRIFT beyond ε** (abs+rel tolerance) ⇒ HALT. **BALANCE_LEAK** (within-ε drift growing
  monotonically across 3 passes) ⇒ HALT — a systematic leak.
- **FOREIGN open order / trade** (not our prefix) ⇒ WARN, ignore (another account/bot on the same key).
- **Missed fill for a known order** ⇒ backfilled via the FillIngestor (WARN).
- A venue `rejected` for an order we believe ACKED ⇒ WARN inconsistency (never an illegal terminal adopt).

Response: a reconciliation HALT is an incident. Reconcile the discrepancy manually (venue UI/API +
the append-only `order_events` / `audit_log` / `reconciliations` rows), correct local state only via
the documented recovery path, then wait for auto-resume (paper/testnet) or restart (live) once
preconditions are green.

**Demo-flavor semantics.** The open-orders axis sweeps PER SYMBOL (the configured trading universe ∪
symbols with live local state) — the old symbol-less `fetchOpenOrders()` threw on ccxt's binance and
the whole pass died silently (`reconciliation_runs_total` empty, `reconTs=0`). On `SANDBOX_ENV=demo`
the **balances axis is disabled** (`ReconConfig.balanceAxis`): the demo account is a shared
multi-asset wallet, so a BALANCE_DRIFT HALT there would fire on holdings the bot never touched; paper
and the dedicated Spot Testnet keep it. A pass that still throws lands in
`reconciliation_runs_total{venue,result="error"}` + a `PASS_ERROR:` reconciliations row AND a
`reconcile pass failed:` warn log — a reconciler that logs nothing and counts nothing is broken, not
healthy. Watch `reconciliation_last_success_timestamp_seconds` age in Grafana (per venue).

## Protective exits (bot-side stop-loss / trailing stop)

`ProtectiveExitService` (features/trading/risk) ticks every 1s and force-exits a LONG or SHORT through
the FULL Strategy→Risk→Execution path (marketable IOC via the sizer — never a direct venue call) when
price moves `PROTECT_STOP_LOSS_PCT` against entry or `PROTECT_TRAILING_PCT` against the post-entry
high-/low-water mark. Ops notes:

- `0` disables each knob independently; both-zero = service inert.
- Deployed knobs (`.env.app`): `PROTECT_STOP_LOSS_PCT=0.06`; `PROTECT_TRAILING_PCT=0` (trailing
  backstop off — the model owns trailing via revisable stop directives).
- The HWM/LWM is in-memory: after a restart trailing re-arms from `max/min(avgEntry, current)`, not the
  pre-restart extreme (documented boot amnesia).
- Fires are visible as `protective_exits_total{reason="STOP_LOSS"|"TRAILING_STOP"}` (Grafana Risk &
  safety row) and as `EXIT_LONG` / `EXIT_SHORT` signals with reason `STOP_LOSS`/`TRAILING_STOP` in the
  signals table.
- Guards: kill-switch must be RUNNING (HaltCoordinator owns halted states), dust positions skipped,
  never stacks on an open order/in-flight intent, 30s per-symbol re-fire cooldown.
- The agent's system prompt discloses the backstop so it plans exits itself rather than leaning on it.

## Multi-symbol / multi-venue book (`TRADING_SYMBOLS`)

One agentic instance per CSV entry (`agentic-1`, `agentic-2`, … in CSV order). Spot and USDM symbols
share the same book and the same process. Rules:

- **APPEND new symbols, never reorder** — positions/journals key off the instance id; reordering
  re-attributes state.
- Every entry needs a `DEFAULT_FILTERS` row (domain/risk/default-filters.ts) — boot fails loud otherwise.
- One shared **book-wide** LLM budget (`AGENTIC_MAX_CALLS_PER_DAY` / daily cost stop, etc.); entry caps
  apply per instance. Deployed decide interval is `STRATEGY_INTERVAL=15m` (~96 bars/day per symbol) —
  budget with `AGENTIC_ACTIVE_MENU_SIZE` and portfolio consult in mind.
- Reflection triggers per instance (`AGENTIC_REFLECTION_EVERY_N_TRADES`, deployed `2`) against its own
  journal window; the playbook stays book-global, and realized round-trip evidence spans all symbols.
- The earned-live promotion verdict counts round trips across ALL instances (per (strategyId, symbol)
  walk over demo fills).

<a id="re-arm-live-arming-interlock-10b--out-of-session"></a>

## Re-arm (live arming interlock, §10b) — _(out-of-session)_

Live trading requires arming AFTER boot (you arm last). Two-step, bootId-bound, in-memory only.
**One ceremony arms the whole book** (both venues); there is no per-venue arm.

1. `POST /api/v1/mode/arm/request` → a crypto-random challenge bound to the current `bootId`, TTL 60s, single-use.
2. `POST /api/v1/mode/arm/confirm` with `HMAC-SHA256(challengeId + ':' + bootId, ARMING_SECRET)` (constant-time).

Preconditions (all must hold; arm last, checked by the real `ARM_PRECONDITIONS` provider at
arm/confirm time): **kill switch RUNNING**, **no `*_UNKNOWN` / `RECONCILE_REQUIRED` orders**
(`CrashRecoveryService.hasUnresolvedOrders()`), and the other three gates already true (env flag
requesting live, keys valid with withdrawals disabled, risk limits complete).

**Dual-venue key validity.** `keysValid` is the AND of every configured venue: spot requires
`spotEnabled`, USDM requires `futuresEnabled`, and both require withdrawals disabled + margin
forbidden + URL cross-check OK. ModeControl recomputes this aggregate from the restriction snapshot
— never trust either probe entry's own `keysValid`. Any venue key-probe failure while armed ⇒
auto-disarm + kill-switch engage.

Reconciliation has no cheap synchronous health read of its own — a mismatch already engages the SAME
kill switch (reconciliation is async/network-bound and never auto-flattens), so the kill-switch check
above covers a bad reconciliation pass. Any precondition source that cannot be read fails CLOSED —
refused, never assumed healthy. Armed-session TTL is **8h ⇒ auto-disarm + kill-switch engage**.
Auto-disarm also on: kill-switch engage from any source, key-probe failure (re-probed every 60s),
reconcile mismatch, manual disarm.

Re-arm after a restart: a **new process has a new bootId**, so a captured token cannot arm it — the
operator must run a fresh request→confirm against the new bootId. The HMAC binds to the process's own
`cfg.bootId`; obtain it from `/metrics` (`boot_info{boot_id="..."}` — `/health` does not expose it) /
boot logs.

**Transport-layer second factor (`ArmingTransportGuard`):** `arm/request` and `arm/confirm` (never
`disarm` — an emergency disarm must never be blocked) additionally require a header
`x-arming-token` equal to env `ARMING_TRANSPORT_TOKEN`, compared constant-time. When
`ARMING_TRANSPORT_TOKEN` is unset the guard refuses outright in `TRADING_MODE=live` (fail-closed
where it matters) and passes through with no extra friction in paper/testnet. Localhost-bind
remains deferred out-of-session runtime glue.

### One-command arming — `pnpm arm`

`scripts/arm-ceremony.mjs` automates the operator's client-side steps above (request → compute the
HMAC proof → confirm, within the 60s TTL) into a single command. It changes nothing server-side —
every gate above (challenge TTL, bootId binding to the process's own `cfg.bootId`, constant-time
HMAC verify, ARM preconditions, the transport-layer token, the four live gates, dual-venue key AND)
is enforced exactly as before.

```sh
ARMING_SECRET=<secret> ARMING_TRANSPORT_TOKEN=<token> pnpm arm
```

bootId is auto-discovered from `GET /metrics` (the `boot_info{boot_id="..."}` gauge); override with
`pnpm arm -- --boot-id <id>` if `/metrics` is unreachable. Other flags: `pnpm arm -- --base-url
<url>` (default `http://localhost:3100`), `pnpm arm -- --disarm` (calls `POST
/api/v1/mode/disarm`, no header/proof required). `ARMING_SECRET` and `ARMING_TRANSPORT_TOKEN` are
read from the environment only — never a flag, never logged; `ARMING_TRANSPORT_TOKEN` is optional
(sent as `x-arming-token` on arm/request + arm/confirm only when set). Exits 0 only when the confirm
response reports armed; any refusal (missing secret, non-2xx, `ok: false`) exits 1 with the failure
reason printed (never the secret, the token, or the full proof).

### Manual fallback (the two calls above, by hand)

If the CLI is unavailable, run the two steps directly:

1. Obtain the current `bootId` from `/metrics` (`boot_info{boot_id="..."}`) or boot logs.
2. `POST /api/v1/mode/arm/request` with `{ "bootId": "<bootId>" }` (plus header
   `x-arming-token: <ARMING_TRANSPORT_TOKEN>` if that env is configured on the server) → note the
   returned `challengeId`.
3. Compute `HMAC-SHA256(challengeId + ':' + bootId, ARMING_SECRET)` as hex.
4. `POST /api/v1/mode/arm/confirm` with
   `{ "challengeId": "<challengeId>", "hmacHex": "<hmac>", "bootId": "<bootId>" }` (same
   `x-arming-token` header) within 60s of step 2.

## Before arming at live capital

The shipped `.env.app` `RISK_MAX_*` defaults are already sized for a ~$1k effective book
(`SIZER_EQUITY_CAP=1000`, `SIZER_EQUITY_FRACTION=0.04`, e.g. `RISK_MAX_ORDER_NOTIONAL=400`,
gross/net `1200`, daily loss `50`). Before arming with real funds at a **different** equity `E`:

1. Set every `RISK_MAX_*` value (and `RISK_STALE_MAX_AGE_MS`) for the account's **actual** equity
   `E`, and re-check `SIZER_EQUITY_CAP` / `SIZER_EQUITY_FRACTION` — every limit is a multiple of
   `equity × fraction` when the fraction is > 0; a changed fraction invalidates cached numbers.
2. `RISK_MAX_POSITION_PER_SYMBOL` is a **base-qty** cap, not notional (`domain/risk/limits.ts`) —
   recompute it against the live mark price of the cheapest symbol currently in `TRADING_SYMBOLS`
   at arming time. A stale or placeholder price under- or over-constrains it, and because it is one
   flat value across all symbols it is necessarily decorative for the highest-priced symbols
   (BTC/ETH) — their real per-symbol ceiling is `RISK_MAX_ORDER_NOTIONAL` /
   `RISK_MAX_GROSS_EXPOSURE` / `RISK_MAX_NET_EXPOSURE`, not this cap.
3. Confirm limits are **COMPLETE** per gate (d): every `RISK_MAX_*` / `RISK_STALE_MAX_AGE_MS` is
   present and strictly positive so `validateLimits` resolves non-null — `limitsComplete` is derived
   from this same `RISK_LIMITS` set at boot (see Paper-honesty below).
4. Leave `RISK_MAX_BAND_BPS` unchanged unless you also re-verify `EXIT_CROSS_BUFFER_BPS` (`.env.app`)
   stays strictly below it.
5. Confirm `VENUE_CAPITAL_SPLIT` matches how capital is actually funded across spot vs USDM.
6. Only then proceed to the arming ceremony above, against the account's actual funded equity.

## Promotion gate (earned live)

The agentic lane is async/non-deterministic (out-of-process LLM) and remains step-D-uncertifiable —
live access is **earned**, not assumed. `assertAgenticLaneNotLive` refuses any live boot unless
`PromotionReadinessService` returns a permitted verdict:

- ≥30 closed demo round trips, and
- positive net-of-cost PnL (`realized − fees − LLM spend`) over ≥14 days,

counted since `PROMOTION_EVIDENCE_EPOCH` across the unified book. A permitted boot still faces the
unchanged four live gates and the bootId-bound arming ceremony — the promotion gate narrows who may
attempt arming; it does not replace it. Rules 1–3 and 5–6 in `CLAUDE.md` still bind: the lane only
proposes a Signal; Risk still sizes/vetoes it.

## Paper-honesty (§10) — the CI-cannot-reach-live guarantee

The mandatory live-gate matrix (`test/livegate/`, sacred suite) proves effective mode is `live` ONLY
when all four gates hold; every other combination is paper. Defense in depth, four independent layers:

1. **Resolution** (`resolveMode`): the 2⁴ truth table — live requires env-flag ∧ armed ∧ keys-valid ∧
   limits-complete.
2. **Per-submission** (`assertCanTrade`): a live-stamped intent on a non-live-authority process THROWS;
   a mid-run downgrade returns `MODE_MISMATCH`. No live order reaches a venue unless effective=live.
3. **Config strip**: under `NODE_ENV ∈ {test,ci}` or `CI`, live secrets are stripped from env AND
   absent from the validated `AppConfig` (in-code backstop, independent of the env strip).
4. **Adapter guard**: the live adapter's constructor throws unconditionally under test/ci and requires
   the `LIVE_ADAPTER_CAP` token; in paper mode it is **absent from the object graph**, not merely disabled.

`limitsComplete` (gate d) is derived at boot from the same `RISK_LIMITS` the engine enforces — it is
not a hardcoded constant. Key validity is recomputed by ModeControl from the restriction snapshot
(withdrawals-disabled mandatory, both venues AND-gated) — the probe's self-reported verdict is never
trusted.

Paper-honesty check: confirm `mode.boot_resolution` audit shows `effective: paper` with the expected
`downgrades`, and that `/metrics` + logs carry `mode`, `bootId`, `run_id` on every record.

## Venue capabilities (spot + USDM)

At the `ExchangePort` abstraction both Binance spot and USDM support a caller-supplied client order
id, `fetchOrder` lookup by that id, a user-data stream, and a sandbox/demo. The venue-specific
details — client-order-id field name, rate-limit shapes, exact `apiRestrictions` payload — are
unified by ccxt _below_ the port. Composition builds **per-venue** `CcxtExchangeAdapter` instances
from `VENUES` (deployed example:
`VENUES=[{"id":"binance","environment":"demo"},{"id":"binanceusdm","environment":"demo"}]`).
Capital split across venues is configured by `VENUE_CAPITAL_SPLIT` (deployed `500`/`500` USDT).
Confirm the `apiRestrictions` response shape and any symbol-filter quirks at the out-of-session RUN.
Shorts are a venue-derived capability (USDM), not a separate compose lane.

## Running against a sandbox (testnet / demo) — `SANDBOX_ENV`

`TRADING_MODE=testnet` runs the real `CcxtExchangeAdapter`(s) against Binance **sandbox**(es) (no live
gates, no capability token — a sandbox is not live). `SANDBOX_ENV` picks which sandbox flavor the
adapters use for sandbox-mode construction:

| `SANDBOX_ENV`    | ccxt mechanism            | Base URL (ccxt 4.5.58)   | Keys                                  | Character                                                                           |
| ---------------- | ------------------------- | ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `demo` (default) | `enableDemoTrading(true)` | `demo-api.binance.com`   | `BINANCE_DEMO_API_KEY` / `_SECRET`    | live-mirroring data; real-account keys (demo.binance.com); pre-live dress rehearsal |
| `testnet`        | `setSandboxMode(true)`    | `testnet.binance.vision` | `BINANCE_TESTNET_API_KEY` / `_SECRET` | purpose-built integration sandbox; thin synthetic books; ~monthly resets            |

Both venues in one process may share the demo flavor (current deploy). The two key pairs are
**non-interchangeable** (a testnet key on demo or vice versa is refused by the venue). URLs are
pinned and asserted by the sandbox-URL regression test (`test/unit/market-data/sandbox-url.spec.ts`)
— a ccxt bump that repoints either flavor fails CI loudly. Withdrawals MUST be disabled on each key
(the `apiRestrictions` probe refuses outright). Integration scenario 1 confirms the **sandbox** probe
returns withdrawals-disabled on both flavors' keys; the **live** gate-(c) chain (`BINANCE_LIVE_*` +
`requireRestrictions: true` + ModeControl's independent `keysValid` recompute from the restriction
snapshot) is logic-tested but remains un-RUN (out-of-session).

Operational run:

1. Put the chosen flavor's keys in `.env` and set `TRADING_MODE=testnet` for the bot. `SANDBOX_ENV`
   defaults to `demo`; set `SANDBOX_ENV=testnet` to use the testnet sandbox instead. (The integration
   suite is independent of `SANDBOX_ENV` — it selects demo automatically when `BINANCE_DEMO_*` is
   present, else testnet.)
2. `pnpm test:testnet` (env-gated; all-skipped + green without keys) RUNs the order-lifecycle
   scenarios against the configured sandbox: credential + withdrawals-disabled probe, exact-string
   balances/trades, and a far-from-market passive-limit place → fetch-by-clientOrderId → cancel.
3. Far-from-market limits must stay inside Binance's `PERCENT_PRICE_BY_SIDE` band (a price too far from
   the mark is rejected `TERMINAL_REJECT`); the suite derives its passive bid from the live price.

## Backup

`scripts/db-backup.sh` dumps the single `postgres` service into `backups/cryptobot-<STAMP>.sql.gz`
with a 14-dump retention policy. Run manually or as a loop duty:

```sh
sh scripts/db-backup.sh
```

There is no separate perp DB — one book, one dump.

## Open / deferred (verified at the out-of-session RUN, not in CI)

The sandbox order-lifecycle scenarios (`pnpm test:testnet`) are **RUN-verified against both Binance
Spot Testnet and Binance Demo Trading**. The v3 single-app dual-venue demo boot is in production use
(local cutover 2026-07-21). Still out-of-session:

- the **live** venue connection and order RUN
- a **live reconcile cadence** (today auto-resume is inert on live for this reason)
- the WS user-stream socket under sustained load
- the 72h soak

Treat the first live boot as an untested integration step: bring it up in a sandbox first, watch the
boot-resolution audit, verify reconciliation is clean on both venues, confirm promotion readiness,
then arm.
