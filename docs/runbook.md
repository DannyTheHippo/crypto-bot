# crypto-bot Operations Runbook (Phase 10)

Operational procedures for the four named incident classes: **halt**, **reconciliation mismatch**,
**re-arm**, and **paper-honesty**. Procedures reflect the implemented behavior (Phases 0–8 + the
Phase-7 adapter); items marked _(out-of-session)_ are verified only against a live/testnet venue and
have not been exercised as a running process in CI.

> Cardinal invariant: **paper is the default and live is gated by four independent gates.** Nothing
> in CI can reach live (see §Paper-honesty). When in doubt, the safe state is HALTED in paper mode.

## Kill-switch state machine (§5)

`RUNNING → HALTING → HALTED`, with `(HALTING → FLATTENING → HALTED)` when flatten is requested, plus
`HALTED_DEGRADED`. Engage sources: monitors (daily-loss / drawdown), reconciliation mismatch, OMS
anomalies, rate runaway, ModeControl downgrades (8h arm-TTL expiry, key-probe failure), admin API.

- **HALTING**: cancel-all issued once; all non-flatten intents refused. Cancels confirmed ⇒ HALTED
  (or FLATTENING if flatten was requested). Cancels unconfirmed within 10s ⇒ **HALTED_DEGRADED + page**
  (orders may still be live; reconciliation keeps polling).
- **FLATTENING** (per-reason: default **true for DRAWDOWN, false for RECONCILE_MISMATCH**): reduce-only
  marketable limits at the band edge, sliced through the normal Risk pipeline, one slice per non-busy
  position (stacking guard). `ALL_FLAT` when every `|position| < exchange minQty` ⇒ HALTED.
- **Fills are facts, not requests**: the OMS ingests fills in EVERY state including HALTED. Risk gates
  submissions, never fill ingestion.
- **Disengage is operator-only** (admin RESUME), gated on: reconciliation clean, market data fresh,
  mode preconditions re-evaluated. Live arming state is **not** restored — re-arm is required.

### Halt response

1. Identify the engage reason from the structured log / `killswitch.engaged` metric + audit trail.
2. If `HALTED_DEGRADED`: assume orders may be live at the venue. Do NOT resume. Drive reconciliation
   (§Reconciliation mismatch) until the venue/local order sets agree, then manually cancel any
   residual venue orders out-of-band before considering RESUME.
3. If `FLATTENING` stalls (a position cannot be reduced — e.g. a v1 short, sub-minNotional dust, or no
   venue filter): it is treated as residual dust and counts toward `ALL_FLAT` so the episode converges;
   surface the residue via reconciliation balance drift and clear it manually.
4. RESUME only after the precondition checklist is green AND a human has confirmed the root cause is
   resolved. RESUME clears the kill switch to RUNNING but does NOT re-arm live (you arm last).

## Reconciliation mismatch (§6.4)

Reconciliation **HALTs and NEVER auto-flattens** — local truth is suspect on a mismatch, and blind
flattening on wrong state can double the damage. Mismatch taxonomy and response:

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
the documented recovery path, then RESUME.

## Re-arm (live arming interlock, §10b) — _(out-of-session)_

Live trading requires arming AFTER boot (you arm last). Two-step, bootId-bound, in-memory only:

1. `POST /mode/arm/request` → a crypto-random challenge bound to the current `bootId`, TTL 60s, single-use.
2. `POST /mode/arm/confirm` with `HMAC-SHA256(challengeId + ':' + bootId, ARMING_SECRET)` (constant-time).

Preconditions (all must hold; arm last): kill switch RUNNING, reconciliation clean, **no
`*_UNKNOWN` / `RECONCILE_REQUIRED` orders**, and the other three gates already true (env flag requesting
live, keys valid with withdrawals disabled, risk limits complete). Armed-session TTL is **8h ⇒
auto-disarm + kill-switch engage** (so the operator notices). Auto-disarm also on: kill-switch engage
from any source, key-probe failure (re-probed every 60s), reconcile mismatch, manual disarm.

Re-arm after a restart: a **new process has a new bootId**, so a captured token cannot arm it — the
operator must run a fresh request→confirm against the new bootId. The HMAC binds to the process's own
`cfg.bootId`; obtain it from `/health` / boot logs. ARMING endpoints are localhost-bound + token-authed
_(transport hardening is out-of-session runtime glue)_.

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
(withdrawals-disabled mandatory) — the probe's self-reported verdict is never trusted.

Paper-honesty check: confirm `mode.boot_resolution` audit shows `effective: paper` with the expected
`downgrades`, and that `/metrics` + logs carry `mode`, `bootId`, `run_id` on every record.

## Venue capabilities (Binance spot)

At the `ExchangePort` abstraction Binance spot supports a caller-supplied client order id,
`fetchOrder` lookup by that id, a user-data stream, and a testnet/sandbox. The venue-specific
details — the client-order-id field name (`newClientOrderId`), rate-limit shapes, exact
`apiRestrictions` payload — are unified by ccxt _below_ the port, which is why a single
`CcxtExchangeAdapter` serves the venue (selected by config:
`VENUES=[{"id":"binance","environment":"testnet"}]`). Confirm the `apiRestrictions` response
shape and any symbol-filter quirks at the out-of-session RUN.

## Running against a sandbox (testnet / demo) — `SANDBOX_ENV`

`TRADING_MODE=testnet` runs the real `CcxtExchangeAdapter` against a Binance **sandbox** (no live gates,
no capability token — a sandbox is not live). `SANDBOX_ENV` picks which sandbox:

| `SANDBOX_ENV`    | ccxt mechanism            | Base URL (ccxt 4.5.58)   | Keys                                  | Character                                                                           |
| ---------------- | ------------------------- | ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `demo` (default) | `enableDemoTrading(true)` | `demo-api.binance.com`   | `BINANCE_DEMO_API_KEY` / `_SECRET`    | live-mirroring data; real-account keys (demo.binance.com); pre-live dress rehearsal |
| `testnet`        | `setSandboxMode(true)`    | `testnet.binance.vision` | `BINANCE_TESTNET_API_KEY` / `_SECRET` | purpose-built integration sandbox; thin synthetic books; ~monthly resets            |

The two key pairs are **non-interchangeable** (a testnet key on demo or vice versa is refused by the
venue). URLs are pinned and asserted by the sandbox-URL regression test
(`test/unit/market-data/sandbox-url.spec.ts`) — a ccxt bump that repoints either flavor fails CI loudly.
Withdrawals MUST be disabled on the key (the `apiRestrictions` probe refuses outright). Integration
scenario 1 confirms the **sandbox** probe returns withdrawals-disabled on both flavors' keys; the
**live** gate-(c) chain (`BINANCE_LIVE_*` + `requireRestrictions: true` + ModeControl's independent
`keysValid` recompute from the restriction snapshot) is logic-tested but remains un-RUN (out-of-session).

Operational run:

1. Put the chosen flavor's keys in `.env` and set `TRADING_MODE=testnet` for the bot. `SANDBOX_ENV`
   defaults to `demo`; set `SANDBOX_ENV=testnet` to use the testnet sandbox instead. (The integration
   suite is independent of `SANDBOX_ENV` — it selects demo automatically when `BINANCE_DEMO_*` is
   present, else testnet.)
2. `pnpm test:testnet` (env-gated; all-skipped + green without keys) RUNs the §9 order-lifecycle
   scenarios against the configured sandbox: credential + withdrawals-disabled probe, exact-string
   balances/trades, and a far-from-market passive-limit place → fetch-by-clientOrderId → cancel.
3. Far-from-market limits must stay inside Binance's `PERCENT_PRICE_BY_SIDE` band (a price too far from
   the mark is rejected `TERMINAL_REJECT`); the suite derives its passive bid from the live price.

## Open / deferred (verified at the out-of-session RUN, not in CI)

The sandbox order-lifecycle scenarios (`pnpm test:testnet`) are **RUN-verified against both Binance
Spot Testnet and Binance Demo Trading**. Still out-of-session: the **live** venue connection and order
RUN, the WS user-stream socket, the 60s key-probe and periodic tick firing, the first real `main.ts`
boot-integration, and the 72h soak. Treat the first live/testnet boot as an untested integration step:
bring it up in a sandbox first, watch the boot-resolution audit, and verify reconciliation is clean
before arming.
